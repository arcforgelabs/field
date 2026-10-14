# Rate limits

Field limits how fast anyone can call it, on every route, so a runaway agent
or a leaked key cannot overload an installation or run up Gmail and Xero
calls. The policy is in `server/rate-limits.js`, in one place.

## How a request is counted

- **Per address.** Every request counts against its client address, before
  anything else runs. The address is `req.ip`, so it honours `trust proxy`
  (`FIELD_TRUST_PROXY`, `server/auth/trust-proxy.js`): one hop on Replit,
  off elsewhere. IPv6 addresses in one /56 share a budget. `/health` is not
  counted, so uptime checks always get an answer.
- **Per caller.** Once a request is signed in, it also counts against that
  caller: a person, a service key, the break-glass key, or one MCP
  installation. A token is checked first. A wrong or forged token is refused
  before it is counted, so it never spends someone else's budget.
- **Per class.** Expensive or sensitive routes have a smaller budget of their
  own, matched by method and path (`ROUTE_CLASSES`). A new route that fits a
  class is limited without code of its own. A route without a Field sign-in
  counts per address. Any other route counts per caller.

## Budgets

| Budget | Default | What it covers |
| --- | --- | --- |
| `address` | 1200 a minute | Every request from one address. An office with several staff, and the browser loading its files, stays far below it. |
| `caller` | 600 a minute | Every signed-in request of one person, key or MCP installation. |
| `sign-in` | 20 in 15 minutes | Failed password sign-ins and MCP approvals, per address. A successful sign-in is not counted. Break-glass keeps its own limit (`docs/CLERK_SIGN_IN.md`). |
| `token` | 30 an hour | Making a command-line token and changing a password, per caller, and opening the demo, per address. Revoking a token is not held back: it is how a leak is stopped. |
| `oauth` | 60 in 15 minutes | MCP registration, authorization, approval, token and revoke, and the Gmail and Xero connect steps and callbacks. An MCP client refreshes about every 10 minutes. |
| `email-send` | 30 in 5 minutes | Sending, test-sending and scheduling quote, invoice, receipt and job email, per caller. |
| `pdf-render` | 60 in 5 minutes | Rendering a quote, invoice or receipt PDF, a PDF preview, or a wall drawing, per caller. A stored document (`/api/documents/:uid/pdf`) is served, not rendered, and is not in this budget. |
| `integration` | 60 in 5 minutes | Xero settings and calls, the integration secrets key, Google Contacts, and Moasure files sent to Drive, per caller. |

A request counts against every budget that matches it. For example, Xero
Connect counts as `oauth` and as `integration`.

## When a budget is spent

Field answers `429 Too Many Requests` with:

- `Retry-After`: the seconds until the budget refills.
- `RateLimit` and `RateLimit-Policy` (IETF draft 8), on every limited
  response, named by budget.
- A JSON body: `{ "error": "Too many requests. Try again in 45 seconds.",
  "code": "rate_limited", "retryAfter": 45, "budget": "caller" }`.

The browser shows `error` and keeps you signed in. The `field` CLI prints how
long to wait, and does not retry by itself. The server log notes the first
request over a budget in each window, with the address or caller id, never a
token.

## Changing a budget

Put `rateLimits` in config (`config.json.example`). Name a budget, and give
`limit` (requests) and `windowSeconds`, or either one:

```json
{ "rateLimits": { "pdf-render": { "limit": 120, "windowSeconds": 300 } } }
```

An unknown budget name, an unknown field, or a value that is not a positive
whole number stops Field at boot with a message naming the key. There is no
setting that turns limiting off.

Counts are kept in the server's memory. Each installation runs one server
process, so its counts are the installation's. A restart starts every count
again.
