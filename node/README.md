# EasyData for TypeScript

The official client for the [EasyData](https://easydata.win) LinkedIn
enrichment API.

```bash
npm install @easydata.win/sdk
```

Zero runtime dependencies. It is `fetch` and `node:crypto`, so it runs on Node
18+, Bun, Deno and any worker runtime with a global `fetch`.

## One record

```ts
import { EasyData } from '@easydata.win/sdk';

const ed = new EasyData(); // reads EASYDATA_API_KEY

const r = await ed.profiles.enrich.sync<{ full_name: string }>(
  'https://linkedin.com/in/satyanadella',
);
console.log(r.result?.data?.full_name);
```

`.sync()` takes **one** target and answers with **one** record, in the response.
It costs double, it accepts no webhooks and no `enrich`, and for a paged
operation it returns one upstream page. Those bounds are refusals, not quiet
downgrades.

If the deadline expires first you get `complete: false` and a real `batch_id`,
never a 504 - so you keep the handle to results you may already have been
charged for.

## A batch

Everything is a batch, including a batch of one. There is no ceiling to discover
between one target and fifty thousand.

```ts
const batch = await ed.profiles.enrich(urls, {
  externalId: 'crm-sync',
  findEmails: true,
});

for await (const entry of ed.results<Person>(batch.batch_id)) {
  if (entry.status === 'succeeded') save(entry.data);
  else log(entry.input, entry.error?.type); // and credits_used is 0
}
```

`results()` is an async generator over the cursor. Results **stream**: it yields
rows while the batch is still processing, so a long batch starts producing
immediately rather than after it finishes. It holds the cursor open until the
batch reaches a terminal state, sleeping for the server's own poll interval
between empty reads.

```ts
ed.results(batchId, { wait: false });    // what is readable right now
await ed.resultsPage(batchId, { cursor });        // one page, and the next cursor
await ed.wait(batchId, { timeoutMs: 600_000 });   // counters, not rows
await ed.profiles.enrich.collect(urls);  // submit and drain, in one call
```

## Streaming instead of polling

```ts
for await (const entry of ed.stream<Person>(batch.batch_id)) {
  if (entry.status === 'succeeded') save(entry.data);
}
```

Same cursor, same entries, same order - the server pushes over a held
connection, so a long batch costs one request instead of hundreds against your
rate limit. Reconnects are handled and are exact: the event id IS the cursor, so
a dropped connection resumes with no duplicates and no gaps.

Use webhooks instead if you run a server with a public URL. This is for a client
with nowhere to deliver to: an agent on a laptop, a CLI, an edge function.

## Retries and double-billing

Retries are on by default and cover exactly what is safe to repeat: `429`, `5xx`
and a transport failure. A `4xx` throws immediately, because repeating a refusal
only spends the rate budget on a certain no.

Every submission carries an `Idempotency-Key` that the client mints, so the
retry is free: a retried submit resolves to the batch the first attempt created
rather than creating a second and charging for it. Pass your own
`idempotencyKey` if your caller's retry needs the same guarantee.

```ts
const ed = new EasyData({ maxRetries: 5, timeoutMs: 180_000 });
ed.rateLimits.remaining; // read off the last response, including a 429
```

`rateLimits` fields are `undefined` when the deployment publishes no ceiling.
That is what "no limit" looks like on the wire: an absent header, never a zero.

## Errors

```ts
import { EasyDataError, isEasyDataError } from '@easydata.win/sdk';

try {
  await ed.profiles.enrich(urls);
} catch (e) {
  if (!isEasyDataError(e)) throw e;

  switch (e.type) {
    case 'invalid_request':
      console.error(e.field, e.requestId); // quote requestId at support
      break;
    case 'quota_exhausted':
      break; // waiting for the month is the fix
    case 'email_unverified':
      break; // a 403, but clicking the link fixes it
    default:
      if (e.isTransport) retryLater();
  }
}
```

One class with a `type` you switch on, which is what TypeScript narrows on -
a subclass hierarchy would only add `instanceof` checks doing the same job.
`isRetryable` and `isTransport` cover the two questions worth asking about an
error whose type you do not handle.

## Webhooks

```ts
import express from 'express';
import { verify, VerificationError } from '@easydata.win/sdk';

// RAW, not express.json(): the signature is over the bytes that arrived.
app.post('/webhooks/easydata', express.raw({ type: 'application/json' }), (req, res) => {
  let d;
  try {
    d = verify(SECRET, req.headers, req.body);
  } catch (e) {
    return res.sendStatus(400);
  }

  if (seen(d.id)) return res.sendStatus(200); // stable across retries

  if (d.event === 'batch.result') handle(d.data);
  res.sendStatus(200);
});
```

Four events: `batch.started`, `batch.result` (one per row), `batch.completed`
and `batch.failed`. The fields are in `d.data`, one level down.

Two things that are silent when you get them wrong:

- **Verify against the raw body.** Re-serialising parsed JSON changes key order
  and whitespace, and the signature will not match a body you rebuilt.
- **Never verify against `X-EasyData-Timestamp`.** It sits outside both signed
  messages, so a replayed delivery can set it to anything. The `t` inside the
  signature header is the only copy that cannot be edited.

For the asymmetric scheme `webhookId` is required - one key signs for every
customer, so checking `wid` is what stops another customer's genuine delivery
verifying against your receiver.

```ts
import { verifyEd25519 } from '@easydata.win/sdk';
const d = verifyEd25519(PUBLIC_KEY, req.headers, req.body, { webhookId: MY_ENDPOINT_ID });
```

## Everything else

```ts
await ed.batch(batchId);
await ed.batches({ status: 'completed', externalId: 'crm' });
await ed.cancel(batchId); // delivered rows stay delivered and charged
await ed.account();
await ed.usage({ from: '2026-09-01', to: '2026-09-30' });
```

Operations: `ed.profiles.{enrich,activity,posts,comments,reactions}`,
`ed.companies.enrich`, `ed.posts.enrich`,
`ed.sales.{searchPeople,searchCompanies}`.

## Reference

- [API reference](https://easydata.win/docs/api)
- [The batch model](https://easydata.win/docs/batches) - what a credit is, and why
- [OpenAPI 3.1](https://easydata.win/openapi.yaml)
