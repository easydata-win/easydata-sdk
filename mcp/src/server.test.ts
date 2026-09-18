/**
 * The MCP server, end to end.
 *
 * A real child process speaking JSON-RPC over stdio against a real HTTP server
 * standing in for the API. Nothing is mocked, because everything worth testing
 * here is a seam between two processes: that stdout carries only protocol, that
 * a tool call reaches the right path, that the budget actually refuses.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, 'index.js');

interface IRequestSeen {
  method: string;
  path: string;
  body: unknown;
}

/** A stand-in API that answers every enrichment with one person. */
function fakeApi(): Promise<{ url: string; seen: IRequestSeen[]; close: () => void }> {
  const seen: IRequestSeen[] = [];

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
      });

      const body = req.url?.includes('/sync')
        ? {
            data: {
              batch_id: 'b-1',
              operation: 'profiles.enrich',
              status: 'completed',
              complete: true,
              credits_used: 2,
              result: {
                item_index: 0,
                input: 'https://linkedin.com/in/satyanadella',
                status: 'succeeded',
                credits_used: 2,
                data: { full_name: 'Satya Nadella', headline: 'CEO at Microsoft' },
                created_at: '2026-09-01T10:00:00Z',
              },
            },
            meta: { requestId: 'req_1' },
          }
        : {
            data: {
              batch_id: 'b-1',
              operation: 'profiles.enrich',
              status: 'queued',
              total: 3,
              succeeded: 0,
              failed: 0,
              pending: 3,
              results_available: 0,
              credits_used: 0,
              created_at: '2026-09-01T10:00:00Z',
            },
            meta: { requestId: 'req_1' },
          };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => server.close(),
      });
    });
  });
}

/** An MCP client: spawn, initialize, call, read. */
class Harness {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (v: unknown) => void>();
  stderr = '';

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [entrypoint], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;

        // Anything on stdout that is not JSON-RPC corrupts the stream, so this
        // throws rather than skipping: a stray console.log in the server is
        // exactly the bug worth failing on.
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
      }
    });

    this.child.stderr.on('data', (c) => (this.stderr += c));
  }

  send(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async start(): Promise<void> {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    this.notify('notifications/initialized');
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    return this.send('tools/call', { name, arguments: args });
  }

  kill(): void {
    this.child.kill();
  }
}

const started: Harness[] = [];
const closers: (() => void)[] = [];

after(() => {
  for (const h of started) h.kill();
  for (const c of closers) c();
});

async function boot(env: Record<string, string> = {}) {
  const api = await fakeApi();
  closers.push(api.close);

  const h = new Harness({
    EASYDATA_API_KEY: 'pk_test_fake',
    EASYDATA_BASE_URL: `${api.url}/v1`,
    ...env,
  });
  started.push(h);
  await h.start();
  return { h, api };
}

function payload(result: any): any {
  assert.ok(result?.result?.content?.[0]?.text, `no content in ${JSON.stringify(result)}`);
  return JSON.parse(result.result.content[0].text);
}

test('every tool is listed with a description that names its price', async () => {
  const { h } = await boot();
  const res = await h.send('tools/list');
  const tools: { name: string; description: string }[] = res.result.tools;

  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'account_usage',
    'batch_results',
    'batch_status',
    'company_lookup',
    'post_lookup',
    'profile_activity',
    'profile_lookup',
    'search_companies',
    'search_employees',
    'search_people',
    'submit_batch',
  ]);

  // An agent choosing between a lookup and a search cannot weigh them without
  // the price, and the description is the only place it will read one.
  for (const t of tools) {
    assert.match(
      t.description,
      /credits?|Free|free/,
      `${t.name} does not say what it costs`,
    );
  }
});

test('a lookup calls the sync path and returns the record', async () => {
  const { h, api } = await boot();

  const out = payload(
    await h.call('profile_lookup', { target: 'https://linkedin.com/in/satyanadella' }),
  );

  const call = api.seen.find((r) => r.method === 'POST');
  assert.ok(call, 'no request reached the API');
  assert.equal(call.path, '/v1/profiles/enrich/sync');
  // /sync takes ONE entity in `target`, never a `targets` array of one.
  assert.deepEqual(call.body, { target: 'https://linkedin.com/in/satyanadella' });

  assert.equal(out.result.status, 'succeeded');
  assert.equal(out.result.data.full_name, 'Satya Nadella');
  assert.equal(out.usage.credits_used, 2, 'a sync lookup costs double');
});

test('the running total comes back on every call', async () => {
  // An agent that cannot see what it has spent cannot budget.
  const { h } = await boot({ EASYDATA_MAX_CREDITS: '100' });

  const first = payload(await h.call('profile_lookup', { target: 'a' }));
  assert.equal(first.usage.session_credits_spent, 2);
  assert.equal(first.usage.session_credits_remaining, 98);

  const second = payload(await h.call('profile_lookup', { target: 'b' }));
  assert.equal(second.usage.session_credits_spent, 4);
  assert.equal(second.usage.session_credits_remaining, 96);
});

test('the session budget refuses before spending, not after', async () => {
  const { h, api } = await boot({ EASYDATA_MAX_CREDITS: '3' });

  await h.call('profile_lookup', { target: 'a' }); // 2 of 3
  const posts = api.seen.filter((r) => r.method === 'POST').length;

  const refused = await h.call('profile_lookup', { target: 'b' }); // would be 4
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /budget is spent/);
  assert.match(refused.result.content[0].text, /Nothing was charged/);

  assert.equal(
    api.seen.filter((r) => r.method === 'POST').length,
    posts,
    'the refused call still reached the API and was charged',
  );
});

test('submit_batch posts the batch path with every target', async () => {
  const { h, api } = await boot();

  const out = payload(
    await h.call('submit_batch', {
      operation: 'profiles.enrich',
      targets: ['a', 'b', 'c'],
      external_id: 'run-1',
    }),
  );

  const call = api.seen.find((r) => r.method === 'POST');
  assert.equal(call?.path, '/v1/profiles/enrich');
  assert.deepEqual((call?.body as any).targets, ['a', 'b', 'c']);
  assert.equal((call?.body as any).external_id, 'run-1');

  assert.equal(out.result.batch_id, 'b-1');
  // Nothing is charged at submit: billing follows each record as it resolves.
  assert.equal(out.usage.session_credits_spent, 0);
});

test('the operation name maps straight onto the path', async () => {
  const { h, api } = await boot();

  await h.call('search_people', { search_url: 'https://linkedin.com/sales/search/people?x=1' });

  const call = api.seen.find((r) => r.method === 'POST');
  assert.equal(call?.path, '/v1/sales/search/people/sync');
});

test('an API refusal comes back as a tool error naming the type', async () => {
  const api = await fakeApi();
  closers.push(api.close);

  // A second server that refuses, so the error path is the real one rather
  // than an exception thrown before any request.
  const refusing = createServer((_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { type: 'quota_exhausted', message: 'monthly allowance spent', requestId: 'req_7' },
      }),
    );
  });
  await new Promise<void>((r) => refusing.listen(0, '127.0.0.1', r));
  closers.push(() => refusing.close());
  const port = (refusing.address() as { port: number }).port;

  const h = new Harness({
    EASYDATA_API_KEY: 'pk_test_fake',
    EASYDATA_BASE_URL: `http://127.0.0.1:${port}/v1`,
  });
  started.push(h);
  await h.start();

  const res = await h.call('profile_lookup', { target: 'a' });

  assert.equal(res.result.isError, true);
  const text = res.result.content[0].text;
  assert.match(text, /quota_exhausted/);
  assert.match(text, /req_7/);
  // The agent needs to know this one will not succeed on a retry.
  assert.match(text, /will not succeed until it resets/);
});

test('nothing but JSON-RPC is written to stdout', async () => {
  // The harness throws on a non-JSON line, so reaching here having exchanged
  // real messages is the assertion. A stray console.log in the server would
  // corrupt the very first response.
  const { h } = await boot();
  const res = await h.send('tools/list');
  assert.ok(res.result.tools.length > 0);
});
