# EasyData clients

Official clients for the [EasyData](https://easydata.win) LinkedIn enrichment
API. Send identifiers, get records back.

| | Install | |
| --- | --- | --- |
| **Python** | `pip install easydata-api` | [readme](python/README.md) |
| **TypeScript** | `npm install @easydata.win/sdk` | [readme](node/README.md) |
| **Go** | `go get github.com/easydata-win/easydata-go` | [separate repo](https://github.com/easydata-win/easydata-go) |
| **MCP** | `npx -y @easydata.win/mcp` | [readme](mcp/README.md) |

All zero-dependency.

## What they do that a hand-rolled client usually does not

- **A submission carries an `Idempotency-Key` the client mints.** Without it, a
  retry of a submission that actually succeeded creates a second batch and bills
  for it. This is the most valuable line in any of them.
- **Retries cover only what is safe to repeat**: `429`, `5xx` and a transport
  failure. A `4xx` is raised immediately, because repeating a refusal only spends
  your rate budget on a certain no. Backoff honours `Retry-After` when the server
  sends one and is jittered otherwise.
- **The results cursor is an iterator that keeps up with the batch.** Results
  stream, so it yields rows while the batch is still processing. Each client also
  exposes the single page underneath, for a caller that owns its own paging, and
  a `stream`/`Stream` that holds one connection open instead of polling - with
  reconnects handled exactly, because the SSE event id is the cursor.
- **An absent rate-limit header reads as "no ceiling", not zero.** "No limit" on
  the wire is an absent header; reading it as `0` makes an unlimited account look
  completely blocked.
- **Absent and `false` stay different.** `enrich=False` is you saying so, and
  dropping it because it is falsy would send a different request.
- **Webhook verification**, both signature schemes, with the two traps written
  down where you will read them: verify against the raw body, and never against
  `X-EasyData-Timestamp`.

## Documentation

- [API reference](https://easydata.win/docs/api)
- [SDKs and tools](https://easydata.win/docs/sdks)
- [The batch model](https://easydata.win/docs/batches) - what a credit is, and why
- [OpenAPI 3.1](https://easydata.win/openapi.yaml)

## Contributing

These files are generated from an internal monorepo, so that a change to the API
surface lands in every client in one commit. Pull requests here are overwritten
by the next release - please open an issue instead, or mail dev@easydata.win.

MIT licensed.
