# EasyData MCP server

Gives an agent the [EasyData](https://easydata.win) LinkedIn enrichment API as
tools. No integration code: point an MCP client at it and the operations are
available.

## Install

Claude Code:

```bash
claude mcp add easydata --env EASYDATA_API_KEY=pk_live_... -- npx -y @easydata.win/mcp
```

Anything else that speaks MCP, in its config file:

```json
{
  "mcpServers": {
    "easydata": {
      "command": "npx",
      "args": ["-y", "@easydata.win/mcp"],
      "env": {
        "EASYDATA_API_KEY": "pk_live_...",
        "EASYDATA_MAX_CREDITS": "500"
      }
    }
  }
}
```

Mint the key in the console at [easydata.win](https://easydata.win). There is no
self-serve signup: volume and limits are agreed first.

## Tools

| Tool | Does | Costs |
| --- | --- | --- |
| `profile_lookup` | One person's full profile. Answers in the call. | 2 credits, 10 with emails |
| `company_lookup` | One company's page. | 2 credits |
| `post_lookup` | One post: text, author, engagement. | 2 credits |
| `profile_activity` | One person's recent posts, comments or reactions. | 2 credits |
| `search_people` | A Sales Navigator people search, one page. | 1 per row |
| `search_companies` | A Sales Navigator company search, one page. | 1 per row |
| `submit_batch` | 1 to 50,000 targets. Returns a `batch_id`. | Half the above |
| `batch_results` | Read a batch, page by page, while it runs. | Free |
| `batch_status` | A batch's counters and spend. | Free |
| `account_usage` | Allowance left, ceilings, spend by day. | Free |

Every description states its own price, because an agent choosing between a
lookup and a search cannot weigh them otherwise.

## The two things that make it agent-safe

**A session spend cap.** `EASYDATA_MAX_CREDITS` bounds what this process may
spend, and it is checked *before* the call rather than after, so a refusal costs
nothing. An agent in a loop is the failure mode a cap exists for, and the
organization's monthly ceiling is far too coarse to catch it - by the time that
trips, the month is gone. Leave it unset for no cap.

Every tool result carries the running total:

```json
{
  "result": { "status": "succeeded", "data": { "full_name": "Satya Nadella" } },
  "usage": { "credits_used": 2, "session_credits_spent": 12, "session_credits_remaining": 488 }
}
```

**Bulk is submit-then-read, not a tool that blocks.** `submit_batch` returns a
`batch_id` immediately and `batch_results` reads pages - including while the
batch is still running, so the first records are available long before the last.
A tool call that waited for a 50,000-row batch would simply time out.

## Costs, in one paragraph

One credit is one request to LinkedIn. A search row is 0.5 because a row is a
stub and a page of 100 is one request. **A failed lookup costs nothing.** The
`*_lookup` tools answer inside the call and cost double for it; `submit_batch`
is the same work at half the price, so anything past a handful of targets
belongs there. `find_emails` adds a flat 4 per person we reach a verdict about,
including an honest "this domain has no mailbox for them".

## Environment

| Variable | |
| --- | --- |
| `EASYDATA_API_KEY` | Required. |
| `EASYDATA_MAX_CREDITS` | Session spend cap. Unset means no cap. |
| `EASYDATA_BASE_URL` | Defaults to `https://api.easydata.win/v1`. |

## Reference

- [API reference](https://easydata.win/docs/api)
- [What a credit is](https://easydata.win/docs/credits)
- Built on [`@easydata.win/sdk`](https://www.npmjs.com/package/@easydata.win/sdk)
