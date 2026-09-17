/**
 * The client against a scripted fetch.
 *
 * `fetch` is injected rather than monkey-patched, which is why the constructor
 * takes it: the thing worth testing here IS the request the client makes, and a
 * test that stubs the global has to undo that stub correctly or poison the next
 * one.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { EasyData } from './client.js';
import { EasyDataError } from './errors.js';
import { VerificationError, verify, verifyEd25519 } from './webhooks.js';

interface IReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface ISeen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function scripted(replies: IReply[]) {
  const seen: ISeen[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    seen.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    const reply = replies.shift() ?? { status: 200, body: { data: {}, meta: {} } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;

  const client = new EasyData({
    apiKey: 'pk_test_key',
    baseUrl: 'https://api.test/v1',
    fetch: fetchImpl,
    maxRetries: 3,
  });
  return { client, seen };
}

const batchBody = (over: Record<string, unknown> = {}) => ({
  data: {
    batch_id: 'b-1',
    operation: 'profiles.enrich',
    status: 'queued',
    total: 1,
    succeeded: 0,
    failed: 0,
    pending: 1,
    results_available: 0,
    credits_used: 0,
    recommended_poll_ms: 1,
    ...over,
  },
  meta: { requestId: 'req_1' },
});

const entry = (i: number, over: Record<string, unknown> = {}) => ({
  item_index: i,
  input: `https://linkedin.com/in/p${i}`,
  status: 'succeeded',
  credits_used: 1,
  data: { full_name: `Person ${i}` },
  created_at: '2026-09-01T10:00:00Z',
  ...over,
});

const resultsBody = (
  entries: unknown[],
  over: { status?: string; cursor?: string; hasMore?: boolean } = {},
) => ({
  data: { batch_id: 'b-1', status: over.status ?? 'completed', entries },
  meta: {
    requestId: 'req_1',
    nextCursor: over.cursor ?? '',
    hasMore: over.hasMore ?? false,
    recommendedPollMs: 1,
  },
});

test('a submission carries an Idempotency-Key', async () => {
  const { client, seen } = scripted([{ status: 202, body: batchBody() }]);
  await client.profiles.enrich(['https://linkedin.com/in/x']);

  assert.ok(seen[0]!.headers['Idempotency-Key'], 'a submission must carry an Idempotency-Key');
});

test('a retried submit reuses the same key', async () => {
  // The whole reason the key is minted by the client: without it, our own retry
  // of a submission that actually succeeded creates a second batch and bills it.
  const { client, seen } = scripted([
    { status: 500, body: { error: { type: 'internal_error', message: 'boom' } } },
    { status: 202, body: batchBody() },
  ]);
  await client.profiles.enrich(['https://linkedin.com/in/x']);

  assert.equal(seen.length, 2, 'the 500 should have been retried');
  assert.equal(
    seen[0]!.headers['Idempotency-Key'],
    seen[1]!.headers['Idempotency-Key'],
    'a retry sent a different key and would double-bill',
  );
});

test('sync sends target, not targets', async () => {
  const { client, seen } = scripted([
    {
      status: 200,
      body: { data: { batch_id: 'b-1', complete: true, result: entry(0) }, meta: {} },
    },
  ]);
  const out = await client.profiles.enrich.sync<{ full_name: string }>('https://linkedin.com/in/x');

  const body = seen[0]!.body as Record<string, unknown>;
  assert.ok('target' in body);
  assert.ok(!('targets' in body));
  assert.equal(out.complete, true);
  assert.equal(out.result?.data?.full_name, 'Person 0');
});

test('an empty batch never reaches the wire', async () => {
  const { client, seen } = scripted([]);
  await assert.rejects(() => client.profiles.enrich([]), /targets is empty/);
  assert.equal(seen.length, 0);
});

test('false is sent and undefined is not', async () => {
  // `enrich: false` is the caller saying so; dropping it as falsy would send a
  // different request than the one they wrote.
  const { client, seen } = scripted([{ status: 202, body: batchBody() }]);
  await client.profiles.enrich(['x'], { enrich: false, externalId: 'run-7' });

  const body = seen[0]!.body as Record<string, unknown>;
  assert.equal(body.enrich, false);
  assert.equal(body.external_id, 'run-7');
  assert.ok(!('find_emails' in body));
});

test('a 4xx is not retried and carries its field', async () => {
  const { client, seen } = scripted([
    {
      status: 400,
      body: { error: { type: 'invalid_request', message: 'bad', field: 'targets', requestId: 'req_9' } },
    },
  ]);

  await assert.rejects(
    () => client.profiles.enrich(['x']),
    (e: unknown) => {
      assert.ok(e instanceof EasyDataError);
      assert.equal(e.type, 'invalid_request');
      assert.equal(e.field, 'targets');
      assert.equal(e.requestId, 'req_9');
      assert.equal(e.isRetryable, false);
      return true;
    },
  );
  assert.equal(seen.length, 1, 'a refusal repeating cannot fix was retried');
});

test('429 is retried and honours Retry-After', async () => {
  const { client, seen } = scripted([
    { status: 429, body: { error: { type: 'rate_limited' } }, headers: { 'Retry-After': '0' } },
    { status: 202, body: batchBody() },
  ]);
  await client.profiles.enrich(['x']);
  assert.equal(seen.length, 2);
});

test('retries are finite', async () => {
  const replies = Array.from({ length: 8 }, () => ({
    status: 429,
    body: { error: { type: 'rate_limited' } },
    headers: { 'Retry-After': '0' },
  }));
  const { client, seen } = scripted(replies);
  (client as unknown as { maxRetries: number }).maxRetries = 2;

  await assert.rejects(() => client.profiles.enrich(['x']));
  assert.equal(seen.length, 3, 'one attempt plus two retries');
});

test('rate limits are read off every response, and absent means undefined', async () => {
  const { client } = scripted([
    {
      status: 202,
      body: batchBody(),
      headers: { 'X-RateLimit-Limit': '600', 'X-RateLimit-Remaining': '599' },
    },
  ]);
  await client.profiles.enrich(['x']);

  assert.equal(client.rateLimits.limit, 600);
  assert.equal(client.rateLimits.remaining, 599);
  // "No limit" on the wire is an ABSENT header, never 0: reading a missing one
  // as zero would make an unlimited account look completely blocked.
  assert.equal(client.rateLimits.syncLimit, undefined);
});

test('the results cursor pages until hasMore is false', async () => {
  const { client, seen } = scripted([
    { status: 200, body: resultsBody([entry(0)], { status: 'processing', cursor: 'c1', hasMore: true }) },
    { status: 200, body: resultsBody([entry(1)], { status: 'completed', cursor: 'c2' }) },
  ]);

  const got: number[] = [];
  for await (const e of client.results('b-1')) got.push(e.item_index);

  assert.deepEqual(got, [0, 1]);
  assert.ok(seen[1]!.url.includes('cursor=c1'));
});

test('the cursor keeps waiting while the batch is live', async () => {
  // Results stream: an empty read of a processing batch is not the end.
  const { client } = scripted([
    { status: 200, body: resultsBody([], { status: 'processing' }) },
    { status: 200, body: resultsBody([entry(0)], { status: 'processing' }) },
    { status: 200, body: resultsBody([entry(1)], { status: 'completed' }) },
  ]);

  const got: number[] = [];
  for await (const e of client.results('b-1')) got.push(e.item_index);
  assert.deepEqual(got, [0, 1]);
});

test('wait:false stops at what is readable now', async () => {
  const { client, seen } = scripted([
    { status: 200, body: resultsBody([entry(0)], { status: 'processing' }) },
  ]);

  const got: number[] = [];
  for await (const e of client.results('b-1', { wait: false })) got.push(e.item_index);

  assert.deepEqual(got, [0]);
  assert.equal(seen.length, 1, 'wait:false polled again');
});

test('a failed entry is yielded with its error and costs nothing', async () => {
  const { client } = scripted([
    {
      status: 200,
      body: resultsBody([
        entry(0, {
          status: 'failed',
          credits_used: 0,
          data: undefined,
          error: { type: 'unprocessable_target', message: 'no such profile' },
        }),
      ]),
    },
  ]);

  const got = [];
  for await (const e of client.results('b-1')) got.push(e);

  assert.equal(got[0]!.status, 'failed');
  assert.equal(got[0]!.credits_used, 0, 'a failure costs nothing');
  assert.equal(got[0]!.error?.type, 'unprocessable_target');
});

test('the batch listing reads the array straight out of data', async () => {
  const { client } = scripted([
    { status: 200, body: { data: [batchBody().data, batchBody().data], meta: { total: 2 } } },
  ]);
  const rows = await client.batches({ status: 'completed' });
  assert.equal(rows.length, 2);
});

// ------------------------------------------------------------------ webhooks

const SECRET = 'whsec_test';

function sign(body: string, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  return { 'X-EasyData-Signature': `t=${ts},v1=${mac}` };
}

test('a good signature unpacks the delivery', () => {
  const body = JSON.stringify({
    id: 'd-1',
    event: 'batch.completed',
    createdAt: '2026-09-01T10:00:00Z',
    data: { batch_id: 'b-1', succeeded: 494 },
  });

  const d = verify<{ succeeded: number }>(SECRET, sign(body), body);

  assert.equal(d.id, 'd-1');
  assert.equal(d.event, 'batch.completed');
  // The fields are in `data`, one level down.
  assert.equal(d.data.succeeded, 494);
});

test('a tampered body fails', () => {
  const body = '{"id":"d-1","event":"batch.completed","data":{}}';
  assert.throws(() => verify(SECRET, sign(body), `${body} `), VerificationError);
});

test('a stale timestamp fails', () => {
  const body = '{"id":"d-1","event":"batch.completed","data":{}}';
  const headers = sign(body, Math.floor(Date.now() / 1000) - 4000);
  assert.throws(() => verify(SECRET, headers, body), VerificationError);
});

test('headers are case-insensitive and accept an array value', () => {
  const body = '{"id":"d-1","event":"batch.result","data":{"result":{"status":"succeeded"}}}';
  const signed = sign(body);
  const headers = { 'x-easydata-signature': [signed['X-EasyData-Signature']] };

  const d = verify<{ result: { status: string } }>(SECRET, headers, body);
  assert.equal(d.data.result.status, 'succeeded');
});

test("the Go signer's own output verifies", () => {
  // A vector produced by backend/internal/webhooks.Sign itself. Every other
  // test here signs with this file's own HMAC, which would keep passing if both
  // sides were wrong in the same way. Regenerate with
  // Sign("whsec_cross_check", time.Unix(1789000000, 0), body).
  const body =
    '{"id":"d-1","event":"batch.result","createdAt":"2026-09-01T10:00:00Z","data":{"batch_id":"b-1"}}';
  const sig = 't=1789000000,v1=f58f4775db8b4ddd9a99b8a8ed28fc2ea6a58cc888a433526f244c5140e8022b';

  // tolerance 0 switches the freshness check off: the vector is fixed in time
  // and the thing under test is the digest.
  const d = verify<{ batch_id: string }>(
    'whsec_cross_check',
    { 'X-EasyData-Signature': sig },
    body,
    { tolerance: 0 },
  );

  assert.equal(d.event, 'batch.result');
  assert.equal(d.data.batch_id, 'b-1');
});

test('ed25519 refuses a delivery addressed to another endpoint', () => {
  // One key signs for every customer, so wid is the whole check.
  const headers = {
    'X-EasyData-Signature-Ed25519': `t=${Math.floor(Date.now() / 1000)},kid=k1,wid=other,v1b=AAAA`,
  };
  assert.throws(
    () => verifyEd25519('AAAA', headers, '{}', { webhookId: 'mine' }),
    /addressed to endpoint other/,
  );
});
