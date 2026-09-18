# EasyData for Python

The official client for the [EasyData](https://easydata.win) LinkedIn
enrichment API.

```bash
pip install easydata-api
```

Zero dependencies. The client is `urllib` and the webhook HMAC is
`hmac`/`hashlib`, both standard library - an enrichment script should not drag a
dependency tree in behind it. Only the asymmetric webhook scheme needs an extra
(`pip install easydata-api[ed25519]`), and most receivers never use it.

## One record

```python
from easydata_api import EasyData

ed = EasyData()  # reads EASYDATA_API_KEY

r = ed.profiles_enrich.sync("https://linkedin.com/in/satyanadella")
print(r.result.data["full_name"])
```

`.sync()` takes **one** target and answers with **one** record, in the response.
It costs double, it accepts no webhooks and no `enrich`, and for a paged
operation it returns one upstream page. Those bounds are refusals, not quiet
downgrades.

If the deadline expires first you get `complete=False` and a real `batch_id`,
never a 504 - so you keep the handle to results you may already have been
charged for.

## A batch

Everything is a batch, including a batch of one. There is no ceiling to discover
between one target and fifty thousand.

```python
batch = ed.profiles_enrich(urls, external_id="crm-sync", find_emails=True)

for entry in ed.results(batch.batch_id):
    if entry.ok:
        save(entry.data)
    else:
        log(entry.input, entry.error["type"])   # and credits_used is 0
```

`results()` is a generator over the cursor. Results **stream**: it yields rows
while the batch is still processing, so a long batch starts producing
immediately rather than after it finishes. It holds the cursor open until the
batch reaches a terminal state, sleeping for the server's own poll interval
between empty reads.

```python
list(ed.results(batch_id, wait=False))       # what is readable right now
ed.results_page(batch_id, cursor=c)          # one page, and the next cursor
ed.wait(batch_id, timeout=600)               # the counters, not the rows
ed.profiles_enrich.collect(urls)             # submit and drain, in one call
```

## Streaming instead of polling

```python
for entry in ed.stream(batch.batch_id):
    if entry.ok:
        save(entry.data)
```

Same cursor, same entries, same order - the server pushes over a held
connection, so a long batch costs one request instead of hundreds against your
rate limit. Reconnects are handled and are exact: the event id IS the cursor, so
a dropped connection resumes with no duplicates and no gaps.

Use webhooks instead if you run a server with a public URL. This is for a client
with nowhere to deliver to: an agent on a laptop, a CLI, an edge function.

## Retries and double-billing

Retries are on by default and cover exactly what is safe to repeat: `429`, `5xx`
and a transport failure. A `4xx` is raised immediately, because repeating a
refusal only spends the rate budget on a certain no.

Every submission carries an `Idempotency-Key` that the client mints, so the
retry is free: a retried submit resolves to the batch the first attempt created
rather than creating a second one and charging for it. Pass your own
`idempotency_key=` if your caller's retry needs the same guarantee.

```python
ed = EasyData(max_retries=5, timeout=180)
ed.rate_limits.remaining     # read off the last response, including a 429
```

`rate_limits` fields are `None` when the deployment publishes no ceiling. That
is what "no limit" looks like on the wire: an absent header, never a zero.

## Errors

```python
from easydata_api import QuotaExhausted, RateLimited, InvalidRequest, EasyDataError

try:
    ed.profiles_enrich(urls)
except InvalidRequest as e:
    print(e.field, e.request_id)   # quote request_id at support
except QuotaExhausted:
    ...                            # waiting for the month is the fix
except EasyDataError as e:
    print(e.type, e.status)
```

One class per `error.type`, all under `EasyDataError`. An `error.type` this
version has never heard of becomes a plain `EasyDataError` carrying that string
rather than a crash.

`EmailUnverified` is a `403` and is **not** a spent allowance: the default
allowance is gated on somebody having confirmed their email address, and
clicking the link fixes it.

## Webhooks

```python
from easydata_api import verify, VerificationError

@app.post("/webhooks/easydata")
def hook():
    try:
        d = verify(SECRET, request.headers, request.get_data())
    except VerificationError:
        return "", 400

    if seen(d.id):          # stable across every retry of the same delivery
        return "", 200

    if d.event == "batch.result":
        handle(d.data["result"])
    elif d.event == "batch.completed":
        finish(d.data["batch_id"])
    return "", 200
```

Four events: `batch.started`, `batch.result` (one per row), `batch.completed`
and `batch.failed`. The fields are in `d.data`, one level down.

Two things that are silent when you get them wrong:

- **Verify against the raw body.** Re-serialising parsed JSON changes key order
  and whitespace, and the signature will not match a body you rebuilt.
- **Never verify against `X-EasyData-Timestamp`.** It sits outside both signed
  messages, so a replayed delivery can set it to anything. The `t` inside the
  signature header is the only copy that cannot be edited.

For the asymmetric scheme, `webhook_id` is required - one key signs for every
customer, so checking `wid` is what stops another customer's genuine delivery
verifying against your receiver.

```python
from easydata_api import verify_ed25519
d = verify_ed25519(PUBLIC_KEY, request.headers, body, webhook_id=MY_ENDPOINT_ID)
```

## Everything else

```python
ed.batch(batch_id)                                  # one batch's state
ed.batches(status="completed", external_id="crm")   # your batches
ed.cancel(batch_id)                                 # delivered rows stay charged
ed.account()                                        # allowance, ceilings, secret
ed.usage(from_="2026-09-01", to="2026-09-30")       # spend by day and operation
```

Operations are attributes: `profiles_enrich`, `profiles_activity`,
`profiles_posts`, `profiles_comments`, `profiles_reactions`, `companies_enrich`,
`posts_enrich`, `sales_search_people`, `sales_search_employees`,
`sales_search_companies`.

## Reference

- [API reference](https://easydata.win/docs/api)
- [The batch model](https://easydata.win/docs/batches) - what a credit is, and why
- [OpenAPI 3.1](https://easydata.win/openapi.yaml)
