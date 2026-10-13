# Field

Field is a quote-building and invoicing app for trade operators: a price
catalogue, a quote builder, quote and invoice PDFs, and sending them by email.
Every price comes from the operator's own catalogue and deliberate
corrections, and every document a customer was sent can be found again exactly
as it was sent. It also exposes a typed API, CLI and OAuth MCP surface so
external systems, AI agents included, can build and revise quotes. See
`VISION.md`.

Field was built for Embark Landscaping & Earthworks, which maintains it at
[arcforgelabs/field](https://github.com/arcforgelabs/field).

Licence: MIT (`LICENSE`).

## Documentation

Work lives in this repository's GitHub issues and pull requests. Start with
`VISION.md`; this index says what every other maintained document is for.

| Document | What it is for |
| --- | --- |
| `VISION.md` | What Field is for, who it serves, and what it will not do |
| `AGENTS.md` | Agent entry point (`CLAUDE.md`, `GEMINI.md` and Replit's `replit.md` link to it) |
| `CONTRIBUTING.md` | How to file issues and PRs, and this repo's working rules |
| `SECURITY.md` | How to report a security problem, the trust model, and the rules held hard |
| `LICENSE` | MIT licence |
| `ARCHITECTURE.md` | How Field is built: system boundary, storage, generations, quote engine, deployment |
| `DESIGN.md` | The design system: tokens, components, light and dark mode |
| `docs/REPLIT.md` | Running, publishing, storing data and monitoring errors for an installation on Replit |
| `docs/PRICING_ENGINE.md` | Target data model for the price book, quotes and invoices |
| `docs/CLERK_SIGN_IN.md` | Clerk sign-in runbook and cutover |
| `docs/GMAIL_SENDING.md` | How quote and invoice email is sent, and how to restore sending |
| `docs/XERO.md` | Connecting your own Xero app, and how Field creates its invoices in Xero |
| `docs/INTEGRATIONS.md` | Integration credentials entered in Settings, the `FIELD_SECRETS_KEY` key and its rotation, and who may change what |
| `docs/CATALOG_BACKUP_RESTORE.md` | Backing up and restoring the price catalogue |
| `docs/REMOTE_MCP.md` | The OAuth MCP surface AI agents and other systems connect through |
| `docs/concepts/surveyor.md` | Surveyor, Field's before/after proof lane |
| `docs/lessons-learned.md` | Persistent production bugs and the fixes that resolved them |
| `docs/CI.md` | CI's test lanes, which checks are required, and how to run each lane locally |
| `docs/review/` | Before and after renders of customer documents a change alters, from synthetic data, for the owner's review |
| `server/catalog/README.md` | The PostgreSQL price catalogue |
| `server/db/README.md` | The database runtime, migrations and tenancy |
| `skills/using-field/SKILL.md` | Operator and agent runbook for the API, CLI and quote lifecycle |

## Getting started

Requirements: Node 24 and npm. PostgreSQL in production; local development
can use PGlite (an in-process PostgreSQL) instead.

```bash
npm ci
npm --prefix client ci
npm run db:build                                 # compile the data layer (server/db/dist)
cp config.local.example.json config.local.json   # then set authToken and bootstrapUsers
```

Field refuses to start until its price catalogue has at least one active
item, and nothing in this repository is a real price book. To try it locally,
seed the synthetic verification items into a local PGlite database, then
start the server and the client:

```bash
FIELD_PGLITE_DIR=data/pglite node scripts/quote-invoice-proof/seed.mjs . data
FIELD_CONFIG=config.local.json npm run dev      # API on http://localhost:19200
npm run dev:client                              # Vite dev server for the UI
```

`./dev.sh` starts the same server in the background on port 19200, with the
same local PGlite database. It builds the data layer and the client bundle
first if they are missing, and serves the UI itself (`./dev.sh stop` stops
it). It does not seed the catalogue.

For a real installation:

1. Fill in your business profile, payment details and quote rules.
   `quote-catalogs/embark-default.json5` is a **sample** catalogue for a landscaping
   and earthworks business: its business profile is a placeholder ("Your
   Business", blank ABN, a dummy bank account) and its productivity factors
   are illustrative. Its rules and assemblies name price-catalogue items by
   uid (`cat_...`); until your catalogue has those items, the health page
   (`/pricing/health`) lists them and quotes that need them are refused.
2. Create your price catalogue: import a legacy SQLite catalogue with
   `npm run catalog:import-legacy -- <catalog.db>`, or create items through
   the price book once Field is running.
3. Set your business profile in config (below), not in the catalogue file.
4. Name your first owner: list them in `bootstrapUsers` (below).
5. Configure sign-in (`docs/CLERK_SIGN_IN.md`), email sending
   (`docs/GMAIL_SENDING.md`) and, if agents will drive Field, MCP
   (`docs/REMOTE_MCP.md`). `config.json.example` shows every config key.

### Business profile

Your legal name, trading name (optional), ABN, address, phone, email and bank
account go in config as `businessProfile`, in the same shape as the quote catalogue's
(see `config.json.example`). On Replit or Docker, put it in the
`FIELD_CONFIG_JSON` secret so real details never enter the repository:

```json
{
  "businessProfile": {
    "legalName": "Your Business Pty Ltd",
    "abn": "00 000 000 000",
    "address": "1 Example Street, Exampleton SA 5000",
    "phone": "08 0000 0000",
    "email": "accounts@example.com",
    "paymentMethods": {
      "bankTransfer": { "accountName": "Your Business Pty Ltd", "bsb": "000-000", "accountNumber": "00000000", "bank": "Your bank" }
    }
  }
}
```

Add `"tradingName": "..."` only if you trade under a name other than your
legal name. Documents and email use the trading name where one is set, and
the legal name otherwise. It is merged over the catalogue's profile: a field
left out keeps the catalogue's value, and an empty string clears it (an empty
`tradingName` falls back to the legal name). Field applies it to the
quote catalogue (so every new quote records it), to quote, invoice and receipt
PDFs, to issued-document records, and to email: the plain-text body, the
sender-name fallback and the stock signatures sign with that name, which is
also the issuer printed at the top of each document. A document
already sent is a stored file and never changes. An unknown field or a
non-string value stops Field at boot with a message naming the field (never
its value). The boot log says `[field] business profile: configured in ...`
when one is set.

### First owner

There is no built-in account. List your first owner in `bootstrapUsers`:

```json
{ "bootstrapUsers": [{ "email": "owner@example.com", "name": "Owner", "role": "admin" }] }
```

- With password sign-in (`FIELD_AUTH` unset) that person signs in with the
  `authToken` as their password (or the `password` you give them), then
  manages the rest in Settings > People.
- With Clerk sign-in (`FIELD_AUTH=clerk`) the first boot copies them into
  PostgreSQL as an `owner`, and they link on their first verified Clerk sign-in.
  This import happens only while the organisation has no members; an
  installation that already has people (any upgrade) keeps its PostgreSQL
  record and never re-imports.
- With nobody listed, everyone who signs in waits as `pending` until an owner
  approves them. Approve the first owner with the break-glass key
  (`docs/CLERK_SIGN_IN.md`, "First owner").

## Development

```bash
npm test                    # server, scripts and shared tests
npm --prefix client test    # client tests
npm run build               # data layer and client bundle
```

`npm test` runs 8 test files at a time and the client suite uses 4 workers,
because one workstation often runs several suites at once. Set
`FIELD_TEST_CONCURRENCY` to change both, for example
`FIELD_TEST_CONCURRENCY=4 npm test`.

Database tests that need a real PostgreSQL skip unless
`FIELD_DB_TEST_DATABASE_URL` is set (CI runs them against a PostgreSQL
service) or `FIELD_DB_TEST_DOCKER=1` lets them start one in Docker.

To prove a change leaves quote and invoice output untouched, run the offline
end-to-end proof against both checkouts and compare (PDFs and sent email must
be byte-identical; JSON responses must be equal once wall-clock times and the
random part of each `doc_`/`dev_` uid are masked; two runs of one checkout
match in full):

```bash
npm run qa:quote-invoice-proof -- <before-checkout> /tmp/proof-before
npm run qa:quote-invoice-proof -- . /tmp/proof-after
node scripts/quote-invoice-proof/compare.mjs /tmp/proof-before /tmp/proof-after
```

`docs/CI.md` lists CI's lanes and how to run each one locally, including
the Playwright smoke of a built image.

Client development lives in `client/`.

## Deploying

- **Replit:** `.replit` and `scripts/replit-deploy.sh` run Field as a
  published app on a Reserved VM, built from a commit fetched from GitHub
  (`main`, or a pinned ref), not from the workspace's files;
  `scripts/replit-build.sh` and `scripts/replit-start.sh` build and start a
  tree. `docs/REPLIT.md` is the runbook (secrets, PostgreSQL, durable storage,
  Clerk, publishing, rollback). `scripts/github-sync.sh` keeps a Replit
  workspace in step with GitHub.
- **Docker:** `docker build .` produces a self-contained image that listens on
  19200 as an unprivileged user. Give it `DATABASE_URL`, a config
  (`FIELD_CONFIG_JSON`, or a mounted `config.json` named by `FIELD_CONFIG`),
  `FIELD_STORAGE=postgres` for durable job storage, and a writable data
  volume at `/app/data`.

## Sign-in

With `FIELD_AUTH=clerk` people sign in with Clerk and their roles live in
PostgreSQL; unset, Field keeps email and password sign-in. See
`docs/CLERK_SIGN_IN.md` for setup, the cutover checklist and owner break-glass
access.

## Pricing

The price catalogue is PostgreSQL (`server/catalog/README.md`). The target
model for the catalogue, quotes and invoices, and the plan to get there, is
`docs/PRICING_ENGINE.md`.

## Operator CLI

`npm run install:cli` installs the repo-local `field` command. The operator,
not an agent, authenticates it:

```bash
field auth login --url https://<your-field-host>
field auth status
field email-templates list
```

Paste the service key only into the hidden terminal prompt. Do not put it in
chat, shell history, source control, or a task tracker.
