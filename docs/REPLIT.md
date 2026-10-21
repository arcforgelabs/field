# Field on Replit

Field can run as a published Replit app. This is the runbook for an
installation on Replit, for people and agents alike. Replit's Agent reads
`replit.md`, a link to `AGENTS.md`, which lists the tasks of an installation
and the sections here that cover them.

## What runs here

Field is a quoting and invoicing app: catalogue, quote builder, quote and
invoice PDFs, and sending them by email. It does no AI work of its own.

- Run with `scripts/replit-start.sh` (build: `scripts/replit-build.sh`). The
  published app is built and started by `scripts/replit-deploy.sh` from a
  commit fetched from GitHub ("Publishing").
- Runtime: Node 24 (`.replit` module `nodejs-24`), matching CI and the Dockerfile.
- Field keeps its state under its data directory (`FIELD_DATA`, default
  `data/`). A published Replit app does not keep files between publishes, so
  the published app must run with durable storage on (`FIELD_STORAGE=postgres`,
  see "Durable storage" below); without it every publish starts from an empty
  data directory.
- Checks: `npm test`.

## Configuration

There is no `config.json` on Replit. Field reads its config from Replit
Secrets, which reach the app as environment variables:

| Secret | What it holds |
| --- | --- |
| `FIELD_CONFIG_JSON` | The whole config object as one JSON value, shaped like `config.json.example`: `authToken`, `publicUrl`, `mail` (sender and `deliveryPolicy`), `googleOAuth` (`clientId`, `clientSecret`), `googleDriveFolderId`, `bootstrapUsers`, `mcp`, and `businessProfile` (your trading name, ABN, address, contact details and bank account; README "Business profile"). Leave out `port` and `dataDir`. When it is set, `FIELD_CONFIG` and `config.json` are ignored, and invalid JSON stops Field at boot. |
| `FIELD_TOKEN` | Optional. Overrides `authToken`. |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Optional. The service account key JSON itself (paste the whole file). A file path still works elsewhere, and `googleServiceAccountKey` in config can hold either. |
| `FIELD_SECRETS_KEY` | The key that encrypts integration credentials and tokens (Xero). Make it in Field: Settings, Integrations, the Xero card opens the Connect wizard, and its step 3 generates it in your browser and shows it once. Add it as a deployment secret (Publishing, Adjust settings, Production app secrets, Add deployment secret, name `FIELD_SECRETS_KEY`), paste the key, then Republish; the wizard goes on by itself. Fallbacks: a random password of at least 40 characters from Bitwarden's generator, or 32 random bytes in base64 (`docs/INTEGRATIONS.md`). Without it, integrations stay off. `FIELD_SECRETS_KEY_PREVIOUS` holds the earlier key while rotating. |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Optional override. The Xero app's credentials are entered in Settings, Integrations, Xero; when both of these are set they win, and the screen says so (`docs/XERO.md`). |

Every value in `FIELD_CONFIG_JSON` is treated as secret, so keep it a Secret,
never a plain env var or a file in the repo. Field never writes config back:
Gmail OAuth refresh tokens granted through the app are stored in
`FIELD_DATA/gmail-oauth-users.json` (mode 0600) and take precedence over any in
`googleOAuth.users`.

`scripts/replit-start.sh` serves on `PORT` and sets `FIELD_RUNTIME=replit`
(also set in `.replit`), which makes Field refuse a local PGlite database: on
Replit the database is always `DATABASE_URL`.

### Security headers

Every response carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
and a Content-Security-Policy (`server/security-headers.js`). The
configuration value `FIELD_CSP` sets how the policy applies:

| `FIELD_CSP` | Effect |
| --- | --- |
| Unset or `report-only` | The policy is sent as `Content-Security-Policy-Report-Only`. The browser console names each script, frame or request the policy would block, and nothing is blocked. |
| `enforce` | The policy is sent as `Content-Security-Policy`, and the browser blocks what it does not allow. |
| `off` | No policy is sent. The other headers stay. |

The page's inline scripts run under a nonce made for each response, so the
policy has no `'unsafe-inline'` for scripts. Before you set `enforce`, open
the published app with the browser console open, in report-only. Sign in
with Google, open a quote PDF and send a problem report. Then look for
`[Report Only]` messages. A wrong value stops Field at boot.

## Database

Field's PostgreSQL connection comes from `DATABASE_URL`, the secret Replit
creates when the workspace's PostgreSQL database is added (`FIELD_DB_URL`
overrides it if both are set). It is a credential: keep it a Secret and never
print, log or paste it; Field's logs and `npm run db:smoke` name the variable,
not its value.

The workspace and the published app have separate databases, each with its
own `DATABASE_URL`. The workspace's database is a copy: it follows
production's migrations by itself ("The workspace database" below), but its
data is not production's. A command run in the workspace shell reads and writes the
workspace's database, never production's. Never copy production's database
credentials into the workspace. Field checks and changes production's data
from inside the published app instead: data migrations and backfills run at
boot, and an owner checks them with the dry-run route ("Data migrations").

- On every start, before it serves anything, Field applies any pending
  migrations from `server/db/drizzle` (log line `[db] postgres (DATABASE_URL):
  ...`). If the database is unreachable or a migration fails, Field exits
  instead of starting.
- The next log line, `[db] organisation <slug> (<uid>)`, names the
  organisation the installation serves. Leave `FIELD_ORG` unset: Field then
  serves the default organisation, `default` on a new database. An
  installation from before #122 keeps its slug and needs no change
  (`server/db/README.md`, "Default organisation").
- `npm run db:smoke` connects, runs `select 1` and reports applied and pending
  migrations without changing anything (exit 2 when migrations are pending).
- Without `DATABASE_URL` Field does not start: the price catalogue needs it
  (`[db] no database (DATABASE_URL is not set)`, then the catalogue refuses).
  `FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE=1` is an incident override that
  starts it with pricing blocked. It never falls back to a local
  database on Replit: PGlite (an in-process PostgreSQL for local development,
  `FIELD_PGLITE=1`) is refused here and Field exits, because a published app
  loses it on the next publish.
- The price catalogue lives in this database (`server/catalog/README.md`).
  Field refuses to start until the catalogue has active items, so import it
  before the first start: copy your legacy `catalog.db` into the workspace,
  then `npm run catalog:import-legacy -- <catalog.db> --dry-run` (verifies
  and rolls back) and the same without `--dry-run`. The import is one
  verified transaction, carries the data over as-is, and refuses a catalogue
  that already has items unless given `--replace`. It imports into the
  database `DATABASE_URL` names: in the workspace shell, that is the
  workspace's database, not production's. Data problems it carries
  over (missing items the quote rules name, archived items still used,
  `-copy` codes) are listed by the catalogue's "need attention" filter (`/pricing/health`); they do not stop Field.
- Cutover order: import first, then publish. A build with the PostgreSQL
  catalogue does not boot without `DATABASE_URL` and an imported catalogue, so
  do not deploy it to a host that has neither. `--replace` deletes the PostgreSQL-era price history and the
  catalogue audit trail; only point-in-time restore undoes it.
- Catalogue backups are the database's point-in-time restore;
  `npm run catalog:export -- --out <file>` writes a JSON copy.
- If `DATABASE_URL` is a Neon pooled endpoint (host name containing
  `-pooler`), Field runs migrations against the same host without `-pooler`
  (the direct endpoint), because they hold a session advisory lock that a
  transaction pooler does not keep. Any other pooler: set `FIELD_DB_URL` to a
  direct endpoint.

See `server/db/README.md` for the runtime module and how to add tables.

### The workspace database

Before each publish, Replit compares the workspace's tables with
production's. If they differ, it stops at "Development database changes
detected" and offers to make production match the workspace. That breaks
Field: Field migrates production itself when it starts, and a table made
ahead of time stops that migration. The tables differ when the workspace
database has fewer migrations than production (production gained a
release's migrations when that release started) or more (the workspace
applied migrations production does not run yet).

So the workspace database follows production by itself. Set it up once:

1. Tools > Secrets in the workspace: add `FIELD_PRODUCTION_URL` with the
   published app's address, for example `https://field.example.com`. It is
   not a credential. Put it in the workspace's Secrets, not in the
   deployment's.
2. Pull the workspace once (`scripts/github-sync.sh pull`), so it has
   `scripts/replit-workspace-db.js` and the `.replit` that runs it.
3. Check it in the Shell: `npm run db:follow-production`. The last line is
   JSON. `"state":"level"` means the workspace database has exactly
   production's migrations.

Then `scripts/replit-workspace-db.js sync` runs each time the workspace
boots (`.replit` `onBoot`) and each time the workspace's Run button starts
Field (`scripts/replit-start.sh`). It:

1. Reads `GET <FIELD_PRODUCTION_URL>/health` (no credentials) for
   `build.revision`, the commit production runs, and `build.release`.
2. Fetches that commit's `server/db/drizzle/` from GitHub, without a token,
   into `.field-workspace-db/` (gitignored). It checks that the fetched
   commit is `build.revision`. `FIELD_DEPLOY_REPO` names a fork's
   repository, as for the publish.
3. Compares those migrations with the rows in the workspace database's
   `drizzle.__drizzle_migrations` (each migration file's hash and its
   journal time), and acts on the result:

| `state` | What it means | What it does |
| --- | --- | --- |
| `level` | The workspace database has exactly production's migrations | Nothing |
| `behind` | It lacks some of production's migrations | Applies them, from production's commit, under the same migration lock the server holds (`appliedNow` counts them) |
| `ahead` | It has migrations production does not run (`extra` names them) | Nothing. Exit code 3 |
| `diverged` | It has different migrations from production | Nothing. Exit code 3 |

It only touches the workspace's database (`DATABASE_URL` or `FIELD_DB_URL`,
as `npm run db:smoke` chooses), never production's: production is only asked
for its public `/health`. It refuses to run in the published app
(`REPLIT_DEPLOYMENT` set), which migrates itself as before. It never prints
the connection string. Without `FIELD_PRODUCTION_URL` it says how to set it
and does nothing. At boot and at Run, a failure prints a warning and Field
starts anyway.

`ahead` corrects itself: when production publishes the release that has
those migrations, the workspace is `level` again. Until then, the next
publish stops at the prompt; press Cancel. To be `level` sooner, replace the
workspace's database (delete it in the Database tool and add it again) and
run `npm run db:follow-production`. The workspace database holds no
production data, but this deletes everything in it.

The workspace's Run button starts the workspace checkout's code, and Field
applies that checkout's own migrations when it starts. If the checkout has
migrations production does not run (usually the workspace was pulled to
`main` while production follows `stable`), starting it puts the workspace
database ahead again. The sync warns about this:
`WARNING: this workspace's checkout has migrations production does not run`,
and its JSON shows `"checkout":{"state":"ahead",...}`. Then do not press
Run until production runs a release with those migrations, or press Cancel
at the prompt.

`npm run db:follow-production:status` compares without changing anything
(exit code 2 when the workspace is behind). Do not use `npm run db:apply` in
an installation's workspace: it applies the checkout's migrations, not
production's.

If Replit still shows "Development database changes detected", press Cancel.
Never pick an option there.

## Data migrations

Some releases change existing records, not just the schema: re-keying quote
rows by uid, for example, or filling the quote and invoice rows from the job
files. These are data migrations (`server/data-migrations/`). The published
app runs each one at boot, after the schema migrations and after durable
storage has restored the data directory, and before it serves anything. They
read production's own data directory and database, so nobody needs
production's credentials to run them.

- It works out every change and verifies it before writing anything. For
  the quote-row re-key that means: removing the added uids gives back each
  file exactly; each uid is the item the row's code resolves to; and each
  changed quote renders to the same PDF bytes, with the same pricing digest
  and commercial checks. If verification fails, Field logs
  `[data-migrations] ...` and exits; nothing has been written.
- Each job is written as a new job generation, so the previous generation
  keeps every file as it was, and the new one is read back and checked
  (changed files hold what was planned; every other file, issued PDFs
  included, is byte-identical). With durable storage every job's change is
  stored in one flush: all of it reaches PostgreSQL, or none of it, and a
  failed boot rebuilds the old files from PostgreSQL next time.
- It is recorded in the `data_migrations` table and never runs again, so a
  later edit in the app is not undone by a restart. The log line is
  `[data-migrations] <id>: applied (...); recorded`.

### The row backfills

The quote rows backfill and the invoice rows backfill fill the quote and
invoice tables from every job's files. They write database rows only, never
job files. They check each job before they write it:

- quote rows: each version's totals equal what Field shows, to the cent, and
  a sent version's equal the totals on the PDF the customer was sent;
- invoice rows: each issued invoice equals its stored revision and the
  totals its PDF printed, the payments add up to the amount paid, and the
  invoices do not claim more than the quote.

A job that fails a check is refused. A refused job never stops boot. The
recording rule:

- No job refused: the backfill is recorded, with its summary (written,
  already present, warnings), and never runs again.
- Some jobs refused: every job that verifies is written. Each refused job is
  logged by job uid, issued-document uid and mismatch kind, never a number,
  an amount or a customer name; the dry run shows the numbers. The
  backfill is not recorded, so the next boot runs it again. A retry is one
  pass over the jobs: a job already written is checked and left as it is,
  so a retry writes only what changed. To clear a refusal, correct the job
  in the app; the next boot then writes it and records the backfill.
- The invoice rows backfill runs after the quote rows backfill, so invoices
  link the quote versions they bill. Until the quote rows backfill is
  recorded, the invoice rows backfill writes what verifies but is not
  recorded either, so a later boot fills in the links.

The boot log has one line per backfill:

```text
[data-migrations] 2026-10-13-quote-rows-backfill: applied (12 job(s), 15 quote version(s): 15 written, 0 already present, 0 job(s) refused; 1 warning(s)); recorded
[data-migrations] 2026-10-13-invoice-rows-backfill: incomplete (10 job(s) with milestones, 14 invoice(s): 9 job(s) written, 0 already present, 1 job(s) refused; 2 warning(s)); not recorded (1 job(s) refused), runs again at next boot
[data-migrations] 2026-10-13-invoice-rows-backfill: refused job <job id>: <invoice number> totals: total rows 990.00 vs revision-pdf 1018.05
```

"nothing to change" in place of "applied" means every job was already
present. The numbers above are an example.

A milestone the invoice rows backfill cannot map is refused with the kind
`unmappable` and a code. The dry run shows the code with the invoice number
and milestone; the log line shows the code only, for example
`document (no uid) milestone 1 unmappable (no-issue-time)`. The codes:

| Code | Meaning |
| --- | --- |
| `no-issue-time` | An issued invoice with no issue time, and no other record gives one (below) |
| `no-invoice-number` | An issued milestone with no invoice number |
| `duplicate-number` | Two invoices on the job have the same number |
| `draft-no-number` | A draft milestone with no invoice number |
| `no-amount` | A milestone with no percentage and no fixed amount |
| `successor-not-issued` | A replaced invoice whose replacement is not issued on the job |
| `credited-no-time` | A credited invoice with no credit time recorded |
| `payment-no-invoice` | A payment with no invoice to record it against |
| `payment-no-date` | A payment with no date |
| `no-receipt-number` | A paid milestone with no receipt number |

### Invoices with no issue time

From 2026-04-10 to 2026-08-05 Field set a milestone's status from its
amounts. A $0 milestone became "paid". When the quote was priced later, the
next rebuild changed that "paid" to "authorised". No issue event ran, so
Field recorded no issue time, and sending such an invoice did not record
one either.

The invoice rows backfill takes the issue time from the first of these
records that names the invoice. It refuses the job (`no-issue-time`) only
when none does:

1. The job's `invoiceSentAt`, when the job has one milestone (the send time
   of a job's single invoice from before milestone invoices).
2. The issued document for the invoice number on this job, then the first
   issuance ledger delivery whose PDF names it.
3. The first archived email (`sent-emails.jsonl`) that names it.
4. The first `invoice.sent` event in the job's activity log that names it.
5. The date the stored PDF prints ("Issued: 14 April 2026"). This is a date
   only: Field uses midnight on that date in the business time zone (the
   `TZ` secret, Australia/Adelaide), and that date as the issue date.

The invoice row's note names the source. The backfill counts the sources in
its summary (`issueTimesFromEvidence`) and in its log line, for example
`issue times from evidence: stored-pdf-date 3`. The totals are still checked
against the stored PDF.

### Legacy invoices whose record and PDF disagree

Milestone invoices issued before 2026-08-05 can hold amounts from one quote
version while their stored PDF prints another (#60). Before that date, every
milestone action re-allocated every milestone's amounts, including issued
milestones, from the quote that was current. It redrew the PDF only of the
milestone that it acted on.

The invoice rows backfill uses what was emailed:

- **Field holds a hash-verified copy of the emailed PDF.** This is an issued
  document with an `emailed` event, or an issuance ledger record. The rows
  take the amounts that were emailed, and the job is written. Later syncs
  keep those amounts. The job page and the amount due still bill the
  milestone record until you settle the invoice with `sent-copy`.
- **Field holds no such copy.** The job is refused. Invoices emailed before
  the issuance ledger have no such copy.

To see and settle every affected invoice, sign in as an owner and open
Invoices › Choose amounts (`/#/invoices/amounts`). The Invoices page shows
the notice while an invoice is not settled. The screen uses the two
routes below; you can also call them directly.

The report route:

```text
GET /api/admin/invoices/amount-disagreements
```

The route is read-only. For each invoice, it lists the job id and the
invoice number. It shows the amounts in the milestone record, in the stored
PDF and in the emailed copy (when Field has one). It shows the quote version
that each was drawn from. It also lists the archived emails of the invoice,
with the quote version that each was built against.

Each entry has a note that says what Field bills now. Use the archived
email to decide which set the customer received, and the payments to
support it. When Field holds the emailed copy, `sent-copy` is the only
choice. Then record your choice on the screen, or with the settle route:

```text
POST /api/admin/invoices/amount-disagreements/settle
{ "jobId": "<id>", "invoiceNumber": "<number>", "choose": "milestone-record" | "stored-pdf" | "sent-copy",
  "total": "<the total of that set>", "reason": "<why>" }
```

- Field records the choice on the invoice, with who made it and why.
- What is owed and the invoice rows follow the choice. The PDF and the
  payments do not change.
- Field refuses a choice below the amount already paid. Void or move the
  payment first.
- Field refuses a choice that would make the job's issued invoices claim
  more than the quote. A settlement is made once.
- The next boot writes the job.

### Checking a release in production

The workspace shell cannot check production: its database is the
workspace's own ("Database"). Production checks itself, through an admin
route in the published app:

```text
GET /api/admin/data-migrations/dry-run
```

- Only an owner can call it: with Clerk sign-in, a verified owner sign-in or
  the break-glass key; with password sign-in, an `admin`. Others get 401 or
  403.
- It runs every data migration not yet recorded, held ones included, against
  production's live data directory and database, and writes nothing. Checks
  that need a write run in a transaction that is rolled back.
- It answers with JSON: per migration its id, status (`would-apply`,
  `nothing-to-do`, `would-refuse`, `already-applied`, `deferred`), its summary
  (counts only) and, for a backfill, each refused job with its id and both
  numbers. It holds no customer names. `ok` is false when a backfill would
  refuse a job or a migration fails its verification.
- One runs at a time (another call gets 409). It stops after 2 minutes
  (504); a new one can start once the old one has stopped at its next job.

To check a release before its data migrations run:

1. Before you publish, set the deployment secret
   `FIELD_DATA_MIGRATIONS_HOLD=all` (Publishing > Adjust settings). Publish.
   Boot logs each data migration as held.
2. Sign in to the published app as an owner. With Clerk sign-in, open
   `/api/admin/data-migrations/dry-run` in the same browser: the session
   cookie authorizes a read. With password sign-in, send an admin's token
   in the `Authorization: Bearer` header.
3. `ok: true`: remove the hold and republish. Boot runs the migrations.
   `ok: false`: keep the hold and look at the refused jobs or the failed
   verification in the answer and the server log.

The row backfills need no hold: a refused job leaves its backfill
unrecorded, and boot carries on. Use the route after a publish to see what
is still refused.

The data migrations so far, in the order they run:

| Id | What it changes | Verified by |
| --- | --- | --- |
| `2026-10-12-quote-rows-by-uid` | Adds `catalogItemUid` / `sourceUid` beside codes on every job's quote rows | Files differ only by the added keys; PDFs byte-identical; pricing digest unchanged |
| `2026-10-12-price-book-cleanup` | A price book clean-up driven by `server/data-migrations/price-book-cleanup.plan.json`: names, types, categories, kits flattened, per-metre walls, unused items archived | One catalogue transaction: every item prices exactly as before or it rolls back; an item edited in the app since the plan was made is left alone; an item on a draft quote is not archived |
| `2026-10-13-quote-rows-backfill` | Writes every job's quote versions as quote rows (#6); no job files | Per job: rows equal what Field shows, to the cent; a sent version equals its sent PDF. Refused jobs are logged and the backfill retries at the next boot |
| `2026-10-13-invoice-rows-backfill` | Writes every job's milestones, invoices, payments and receipts as rows (#27), linked to the quote rows; no job files | Per job: each issued invoice equals its revision and its PDF; payments add up. Refused jobs are logged and the backfill retries at the next boot |

The repository ships no clean-up plan. Without
`server/data-migrations/price-book-cleanup.plan.json` the clean-up is reported
as `deferred` and is **not** recorded, so it can still run once a plan is
supplied (and an installation that already applied it is unaffected). With a
plan, on a catalogue it was not built for (fewer than 90% of the planned items
present), it has nothing to do and is recorded as such.

Emergency stop: the deployment secret `FIELD_DATA_MIGRATIONS_HOLD=all` (or a
comma-separated list of migration ids) makes boot skip them, logged as held.
Remove it and restart to run them. Rolling back after one ran: the previous
job generation still holds every file as it was, and point-in-time restore
covers the database; the changes are additive (uids beside codes, rows beside
files), so an older release reads them unchanged.

`npm run data:migrate -- --dry-run` rehearses the data migrations on copies
of the database `DATABASE_URL` names. In the workspace shell that is the
workspace's database, so it does not check production; use the route above.
It skips the row backfills. It suits an installation whose database you can
reach directly, for example a Docker one.

## Following the row backfills

The quote rows and invoice rows from before #6 and #27 are filled at boot by
the `2026-10-13-quote-rows-backfill` and `2026-10-13-invoice-rows-backfill`
data migrations ("The row backfills"). There is nothing to run in the
workspace shell: there, `scripts/backfill-quote-rows.js` and
`scripts/backfill-invoice-rows.js` reach only the workspace's own database.

After the release that adds them is published:

1. In the server log, find the two `[data-migrations]` lines for the
   backfills. `recorded` means done.
2. `incomplete` means jobs were refused. The next lines name each refused job
   by uid, with its issued-document uid and the kind of mismatch. Every other
   job is written.
3. `GET /api/admin/data-migrations/dry-run` shows the same refusals at any
   time, with the counts.

Warnings do not refuse a job: `tax-total-printed` (a milestone's GST kept as
issued), `reconcile-stale` (drafts built against an earlier quote),
`issued-unverified` (no readable copy of the PDF) and `payment-on-superseded`
(a payment on a revision that was replaced without being credited). A
revision made in place before credit notes stays as issued: it gets no credit
note and its payments stay where they were recorded.

## Durable storage

With `FIELD_STORAGE=postgres` the data directory is a working copy of what
PostgreSQL holds (`server/storage/durable-store.js`):

- On start, before serving, Field takes a PostgreSQL advisory lock (only one
  Field process may write a database) and rebuilds the data directory from
  PostgreSQL: files with their modes and modification times, and the newest
  image of `field.db` (plus the legacy `price-catalog/catalog.db` the data
  import archived; nothing reads it, the catalogue is PostgreSQL tables).
  Local files PostgreSQL
  does not hold are moved to `FIELD_DATA/.quarantine-<time>/`, never deleted;
  local files or databases whose content differs from PostgreSQL (changes
  that were never stored, e.g. after a crash) are copied there before being
  replaced.
  On an empty database it stores what is on disk instead (log `[storage]
  postgres: seeded ...`).
- Every change is stored in one transaction before a request that made it is
  answered (a request whose change cannot be stored gets a 503 saying so), at
  commit points (a published quote generation, user, OAuth and Gmail token
  saves, and before a quote, invoice or scheduled email is sent, so a restart
  can never send it twice; if that cannot be stored, nothing is sent), on scheduler ticks, every 5 minutes (a full check), and on shutdown.
  If Field dies mid-request, the next start comes back as of the last stored
  change.
- Not stored: `.openclaw/`, `.sessions/`, temporary and lock files, quote
  generation locks and stages, leases, raw uploads
  (`price-catalog/_uploads/`), `pglite/` and SQLite files other than the
  databases above (old catalogue backups among them; PostgreSQL keeps the last
  20 versions of each image instead).
- It needs `DATABASE_URL` (or `FIELD_DB_URL`); with PGlite or no database,
  Field refuses to start. `GET /health` (public) reports only `storage.state`
  (`ok`, `degraded` or `lock-lost`), whether the lock is held and the number
  of pending changes; file counts, last store/reconcile times and the last
  error are at `GET /api/storage/status` (admin login). Errors never include
  file contents or connection strings.

Set `FIELD_STORAGE=postgres` for the **published app only** (Publishing >
Adjust settings), never in the workspace's `[env]` or Secrets. The workspace
has its own database ("Database"), so durable storage there would only store
the workspace's data directory in the workspace's database. Two Field
processes on one database compete for the lock: the second to start waits
60 s (10 minutes in the published app; `FIELD_STORAGE_LOCK_TIMEOUT_MS` sets
it), then exits.

A republish is such a hand-over. Replit starts the new copy while the old copy
still serves and holds the lock, and stops the old copy only after the new
copy answers its health check (`GET /`). So while the new copy waits for the
lock, it answers on the app's port in standby (`server/standby-server.js`):
`GET /` is 200, `GET /health` is 503 with `storage.state: "waiting-for-lock"`,
and every other request is 503 with `Retry-After: 5`. When Replit stops the old
copy, it stores its last changes and releases the lock; the new copy takes the
lock, rebuilds the data directory and serves. Users can see "Field is
starting" for a few seconds. The log line `[storage] another Field process
holds the storage lock; waiting for it to stop` marks the standby.

Moving existing data in (once, before the first publish with durable storage,
with no Field process using the database). The script writes to the database
`DATABASE_URL` names: in the workspace shell, that is the workspace's
database, not production's ("Database").

```bash
node scripts/migrate-data-to-postgres.js --source <untarred data dir> --dry-run
node scripts/migrate-data-to-postgres.js --source <untarred data dir> --apply
```

`--apply` imports every stored file and both SQLite databases in one
transaction, then verifies file count, total bytes, every file's SHA-256
recomputed by PostgreSQL, and a rebuild into a temporary directory whose tree
hash must equal the source's (exit 1 if anything differs). It refuses a
database that already holds files unless `--replace` is given. In the same
transaction it imports the source's `price-catalog/catalog.db` into the
PostgreSQL catalogue (`server/catalog/legacy-import.js`, verified the same way
as `npm run catalog:import-legacy`); it refuses a catalogue that already holds
items, so use one route or the other, not both. `--dry-run` rehearses that
catalogue import on a throwaway in-process PostgreSQL and connects to nothing.

To re-run the cutover after a first `--apply` (for example from a fresher
tarball), the files and the catalogue are replaced separately:

```bash
node scripts/migrate-data-to-postgres.js --source <dir> --apply --replace --skip-catalog
npm run catalog:import-legacy -- <dir>/price-catalog/catalog.db --dry-run --replace
npm run catalog:import-legacy -- <dir>/price-catalog/catalog.db --replace
```

## Issued documents in R2

Every issued quote, invoice and receipt PDF is stored in PostgreSQL
(`document_blobs`). With `FIELD_DOCUMENT_REPLICA=r2` the published app
also copies each one to a Cloudflare R2 bucket in your Cloudflare account.
Give that bucket a bucket lock (#12) so the copies are write-once.

- PostgreSQL stays the store of record. A document is issued in one
  PostgreSQL transaction, as before, so issuing never waits on Cloudflare.
- After that transaction commits, the bytes are copied to R2 at
  `<org_uid>/<sha256>`, with their content type and SHA-256. A scheduler tick
  every minute retries anything not yet copied, with backoff per document
  (1, 2, 4 ... minutes, at most an hour).
- A copy never overwrites. Field asks R2 first: an object with the same size
  and hash counts as done; an object with different bytes is an integrity
  alarm (log line `[documents-replica] INTEGRITY ALARM`, error code
  `R2_OBJECT_MISMATCH`), and it is left alone. Field never deletes anything
  in R2.
- Reads come from PostgreSQL. R2 is used only if PostgreSQL cannot give a
  document's bytes, and only bytes that match the document's recorded hash
  are served.
- If R2 is down or refuses the credentials, the replica shows as degraded.
  Field keeps serving and issuing; pending copies catch up when R2 is back.
- Progress is in the `document_blob_replicas` table, so a restart carries on
  where it stopped.

### What the bucket lock means

Create the bucket with a lock rule that covers the whole bucket for your
retention period, for example 7 years (2,557 days); Australian businesses
must keep records for at least 5. Until an object's retention ends, nobody
can overwrite or delete it: not Field, not the token, not an account admin.
That is the point, and it is why nothing but the published app may write
there. Tests use a local MinIO server with a locked bucket
(`FIELD_R2_TEST_DOCKER=1`), never a real bucket.

### Settings

Set these as your deployment's secrets on the **published app only**:
Publishing > Adjust settings.

| Name | Value |
| --- | --- |
| `FIELD_DOCUMENT_REPLICA` | `r2`. Unset: no replica, Field behaves as before |
| `FIELD_R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` (the account ID is in the R2 overview) |
| `FIELD_R2_BUCKET` | Your bucket's name, for example `<your-bucket>` |
| `FIELD_R2_ACCESS_KEY_ID` | The token's S3 Access Key ID |
| `FIELD_R2_SECRET_ACCESS_KEY` | The token's S3 Secret Access Key |

Set all five as **Secrets**, including the three that are not secret. Replit
writes a deployment **Configuration** into `.replit` under `[userenv.shared]`
on the next publish. That commits your account ID and bucket name to git,
gives them to the workspace, and loses them when the workspace is reset to
GitHub's `main`, which switches the replica off at the following publish.

Create an account API token with Object Read & Write on this bucket only.
Field never prints either credential.

The workspace must not get them. Do not put them in the workspace's Secrets
or in `.replit` (`[userenv.shared]` reaches the workspace too). If
`FIELD_DOCUMENT_REPLICA=r2` does reach the workspace, Field still starts
there: it logs one warning (`[documents-replica] FIELD_DOCUMENT_REPLICA=r2 is
ignored in the Replit workspace ...`), keeps the replica off and never
writes to R2. Field tells the two apart by `REPLIT_DEPLOYMENT`, which Replit
sets only in the published app. `FIELD_R2_ALLOW_WORKSPACE=1` overrides this;
do not set it.

On the published app, with `FIELD_DOCUMENT_REPLICA=r2` and any of the other
four missing or malformed, Field refuses to start and the log names the
variable, never its value, for example `[documents-replica]
FIELD_R2_BUCKET is not set`. Fix the setting and republish.

### The first publish with the replica on

- At boot Field checks, read-only, that it can list the bucket (at most one
  key) with the credentials. The log says `bucket <your-bucket> reachable,
  credentials accepted`, or names an error code. A failure marks the replica
  degraded; it does not stop Field.
- 30 seconds after boot the scheduler starts copying the documents issued
  before the replica was on: 5 per minute, one second apart, oldest first.
  It resumes after a restart. New documents are copied straight away.

### Checking it after publishing

1. `GET /health` (public): `storage.documentReplica` has `state` (`ok`,
   `degraded` or `off`), `pending` (documents not yet in R2),
   `oldestPendingAgeSeconds` and `lastErrorCode`. During the first backfill
   `pending` falls by about 5 a minute; it should reach 0 with `state: ok`.
2. `GET /api/storage/status` (admin sign-in): `documentReplica` adds the boot
   check (`bootCheck.ok`), the last success and last error (time and code),
   mismatches, and counts.
3. Once `pending` is 0, in a shell that has the deployment's database and
   R2 settings:

   ```bash
   npm run documents:verify-r2
   ```

   It reads every stored document back from R2 and checks its hash. It
   writes nothing. Exit 0 means every one is there with the right bytes; 2
   lists what is missing, different or unreadable; 1 means it could not run.
   It needs the database and the four `FIELD_R2_*` settings. On Replit no
   shell has them: the workspace has its own database and must not get the
   R2 settings. There, steps 1 and 2 are the check.

What an error code means:

| Code | Meaning | What to do |
| --- | --- | --- |
| `R2_UNREACHABLE`, `R2_TIMEOUT`, `R2_HTTP_5xx` | R2 did not answer | Nothing; copies retry. Check Cloudflare's status if it lasts |
| `R2_ACCESS_DENIED`, `R2_SIGNATURE_DOES_NOT_MATCH`, `R2_INVALID_ACCESS_KEY_ID` | The token is wrong, revoked or lacks the bucket | Check the two secrets and the token's permissions, then republish |
| `R2_NO_SUCH_BUCKET` | `FIELD_R2_BUCKET` or `FIELD_R2_ENDPOINT` points at the wrong place | Fix the setting and republish |
| `R2_OBJECT_MISMATCH` | An object in the bucket has the right name but the wrong bytes | Stop and investigate. PostgreSQL still holds the right bytes. Nothing can remove the object until its retention ends |

### Rotating the token

1. In Cloudflare, create a new account API token like the old one (Object
   Read & Write, this bucket only).
2. Put its Access Key ID and Secret Access Key in the published app's
   `FIELD_R2_ACCESS_KEY_ID` and `FIELD_R2_SECRET_ACCESS_KEY`.
3. Republish.
4. Verify: `/api/storage/status` shows `bootCheck.ok: true` and `/health`
   shows `state: ok`. Where a shell has the deployment's settings (not on
   Replit), `npm run documents:verify-r2` exits 0.
5. Only then delete the old token in Cloudflare.

### Turning it off

Remove `FIELD_DOCUMENT_REPLICA` and republish. Nothing is lost: the
documents are in PostgreSQL, and the objects stay in R2 under the lock. Turned
on again, Field finds the objects already there and records them without
writing.

## Sign-in (Clerk)

Field signs people in with Clerk through Replit's managed integration once
`FIELD_AUTH=clerk` is set; unset, it keeps email-and-password sign-in. Turn it
on in **Tools > Users & Auth** (add Clerk), which creates the app's Clerk
instances and stores their keys as Secrets, then set `FIELD_AUTH=clerk` and
restart.

| Secret | What it holds |
| --- | --- |
| `FIELD_AUTH` | `clerk` to sign people in with Clerk. Unset: password sign-in. Any other value stops Field at boot. |
| `CLERK_SECRET_KEY` | Set by the Clerk integration. Server only; never printed. |
| `CLERK_PUBLISHABLE_KEY` | Set by the Clerk integration (`VITE_CLERK_PUBLISHABLE_KEY` also works). Field hands it to the browser at runtime from `GET /api/auth/config`, so the build needs no Clerk key. |

Replit's Agent provisions the Clerk tenant. Tell it to provision only and
not to rewrite Field's auth code (which already reads the two keys above); if
it insists on a change, it opens a pull request.

In the Auth pane's **Configure** tab, enable **Google** only and disable
email/password. Replit's managed Clerk has no MFA, so owners' second factor is
Google Workspace's 2-Step Verification (enforced in Google Admin, an owner
action). Set these as **configuration** values, not secrets:

| Configuration | Value |
| --- | --- |
| `FIELD_AUTH` | `clerk` |
| `FIELD_OWNER_GOOGLE_DOMAINS` | Your Google Workspace domain, e.g. `example.com`: owners signed in with a verified Google account on this domain, with no password, may do owner-only actions. No default; unset turns that path off |
| `FIELD_OWNER_MFA_MAX_AGE` | Unset (12h): how long a Clerk second factor counts, if one ever exists |
| `FIELD_PUBLIC_ORIGIN` | Published app only: its `https://` origin. Clerk then accepts only sessions minted for it |
| `FIELD_TRUST_PROXY` | Unset: Field trusts one proxy hop on Replit so break-glass rate limiting is per client |

Clerk sign-in needs `DATABASE_URL`: Field users and their roles (owner,
staff) live in PostgreSQL, and the first boot imports today's `users.json`
people. New people wait for an owner's approval; CLI tokens and MCP
connections stay Field-issued. `FIELD_TOKEN` becomes the owner's break-glass
key. The cutover checklist, roles, the owner gate and break-glass are in
`docs/CLERK_SIGN_IN.md`.

## Error monitoring (Sentry)

With `SENTRY_DSN` set, Field reports to a Sentry project: errors, a replay
of what the operator saw, traces, server logs, a few counters, and problem
reports the operator sends from the app. One setting covers the server and
the browser. Without `SENTRY_DSN` nothing is loaded and nothing is sent, so
an installation that does not set it sends nothing anywhere. Use a Sentry
account that belongs to the business that runs the installation; the free
Developer plan is enough.

What is reported:

- Server errors: every 5xx answer (most routes catch their own errors and
  answer `{ error }`; these are grouped by method, route and status), errors
  that reach Express's error handler, uncaught exceptions and unhandled
  rejections, and failed scheduled emails (tag `field.area:
  scheduled-email`).
- Browser errors: uncaught errors and errors the app's error boundary
  catches, except the stale-chunk errors an open tab hits after a publish (it
  reloads instead).
- Session replay: a masked recording of the screen (below). Sentry raises
  rage clicks (several fast clicks on something that does not respond) and
  dead clicks (no response within 7 seconds) as issues from it.
- Traces: page loads and navigations with Web Vitals, including INP (how long
  the screen takes to respond to a click), and Express routes on the server.
  Trace headers go only to Field's own origin. `/health` and static files are
  not traced.
- Logs: the server's console output, scrubbed like errors.
- Counters: `field.document.issued`, `field.document.delivery_failed` and
  `field.pdf.generation_failed`, by document type.
- Problem reports: a small button in the corner opens "Report a problem".
  It asks for no name; a screenshot is optional, and the operator can crop or
  black out parts of it before sending. The email field is optional and starts
  empty. A person who types an address asks to hear back: the report gets the
  tag `notify=yes`, else `notify=no`, and the Sentry-to-ClickUp relay tags the
  support task `notify`. The address stays in Sentry.

What never leaves (`shared/sentry-scrub.js`, used by both halves, on errors,
transactions, breadcrumbs and logs): request bodies, cookies, headers other
than User-Agent, query strings (sign-in tokens can travel in one), the user,
console breadcrumbs, local variables, and any value under a key that names a
customer, contact, address, title, note, bank or credential. Free text
(error messages, log lines, URLs, file paths) is rewritten: email addresses,
document numbers (`EQ-…`, `EI-…`, `ER-…`, `INV-…`, `RCT-…`, `CN-…`), money
amounts (with a currency sign, or a number with two decimals), Australian
phone numbers, BSBs and query strings become placeholders, and job folder or
route segments that are not UUIDs (older job folders were named after the
site address) become `[job]`. A whole amount without a currency sign looks
like a count, and a name or street typed into free text cannot be recognised
reliably, so log lines name jobs and documents by uid: a refused data
migration or row check logs the job uid, the issued document's uid and the
kind of mismatch, and the numbers and amounts stay inside Field (the
data-migrations dry run). Replays mask all text and inputs, mask `title`, `aria-label`, `alt`
and similar attributes, block images, frames, canvases, contact links, job
links and links with a query string, and record no network detail. A problem
report's message and screenshot are sent as the operator wrote and took them.

Free-plan limits: the Developer plan stores about 5,000 errors, 50 replays,
5 million spans and 5 GB of logs a month. Field sends the same error at most
once an hour and at most 20 errors an hour in all (per server, and per open
browser tab), so one repeating failure cannot use up the month. The default
sample rates below fit a handful of users.

### Settings

Set these as the deployment's **Secrets** on the **published app only**
(Publishing > Adjust settings), for the same reason as the R2 settings: a
deployment Configuration is written into `.replit` and committed.

| Name | Value |
| --- | --- |
| `SENTRY_DSN` | The Sentry project's DSN (Project settings > Client Keys). A DSN only lets a client send events; Field hands it to the browser in the page |
| `SENTRY_CLIENT` | Optional. A short name for the business this installation serves (letters, digits, `-` and `_`, at most 32 characters, for example `embark`). Every server and browser event is tagged `client:<name>` and `product:field`, so one Sentry organisation can route events from many installations. Unset: `product:field` only |
| `SENTRY_ENVIRONMENT` | Unset on Replit: the published app reports `production` and the workspace `replit-workspace`. Set it only to override both |
| `SENTRY_RELEASE` | Unset. Each build records its git commit (below), which becomes the release |
| `SENTRY_TRACES_SAMPLE_RATE` | Unset: `0.2` (about one page load or request in five). From 0 to 1 |
| `SENTRY_REPLAYS_SESSION_SAMPLE_RATE` | Unset: `0.05` (one session in twenty is recorded). From 0 to 1 |
| `SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE` | Unset: `1` (every session that hits an error keeps its replay). From 0 to 1 |
| `SENTRY_LOGS` | Unset: on. `0` stops sending server logs |
| `SENTRY_METRICS` | Unset: on. `0` stops the counters |
| `SENTRY_FEEDBACK` | Unset: on. `0` hides the "Report a problem" button |
| `SENTRY_VERIFY` | `1` for one publish only: boot sends `Field Sentry verification (server)`. Remove it at the next publish, or every restart sends another |

Which DSN wins, when you move to another Sentry project:

- Server: `SENTRY_DSN`, then `SENTRY_DSN_CMD` (a command that prints a DSN).
  `SENTRY_DSN_CMD` runs only when `SENTRY_DSN` is unset, so delete it, or
  point it at the new project too: if `SENTRY_DSN` is ever removed, the
  command's DSN is used.
- Browser: `VITE_SENTRY_DSN`, then the server's DSN from the page.
  `VITE_SENTRY_DSN` is read at build time and is written into the bundle, so
  if it is set, browser events go to its project whatever `SENTRY_DSN` says.
  Leave it unset on Replit. If it was set, delete it and publish again (the
  build reads it).

The defaults are sized for the free plan from the start, including during a
Sentry trial, so nothing needs changing when a trial ends. Raise the rates
only on a paid plan.

If the workspace also gets `SENTRY_DSN` (Replit's Secrets page feeds both),
its events are tagged `replit-workspace`, never `production`, as long as
`SENTRY_ENVIRONMENT` is unset. Limit the Sentry alert rule to the
`production` environment so workspace errors do not send email.

Start-up: `scripts/replit-start.sh` and `npm start` run
`node --import ./server/observability/instrument.js server/index.js`, so
Sentry starts before Express loads and can name traces by route. Started
without it (the Docker image), Sentry starts during boot: errors, logs and
request traces still arrive, without route names. Profiling
(`@sentry/profiling-node`) is not included: it needs a native binary in every
build, and tracing already shows which routes are slow.

Releases: the deployment build (`scripts/replit-deploy.sh`) writes the
commit it fetched from GitHub to `.field-revision`, and its start exports it
as `FIELD_REVISION`. (`scripts/replit-build.sh` run in the workspace writes
the last commit that changed files, so Replit's empty "Published your App"
commits are skipped.) Server and browser events carry it as their
release. The client bundle ships public source maps, so Sentry reads browser
stack traces against the real source with no upload token.

### Checking it after publishing

1. `GET /health` shows `sentry.enabled: true`, the `environment` and the
   `release` (a commit on `main`). `release: null` means the build could not
   read its commit; events still arrive, without a release.
2. With `SENTRY_VERIFY=1`, the server's verification error is in Sentry
   within a minute of `/health` answering.
3. Browser: open the app, open the browser's developer console and run
   `setTimeout(() => { throw new Error("Field Sentry verification (browser)") })`.
   It arrives with the same environment and release, and a replay.
   Both errors carry the `product` tag (and `client`, with `SENTRY_CLIENT`),
   and both arrive in the same Sentry project. If the browser error goes to
   another project, `VITE_SENTRY_DSN` is set (above).
4. Resolve both verification issues in Sentry, then remove `SENTRY_VERIFY`
   at the next publish.

Alert rules (who hears about a new issue or a spike) live in the Sentry
project, not in this repository. Nothing is posted to this repository's
issues automatically; see issue #46 for how maintainers triage Sentry issues.

## Publishing

Publish as a Reserved VM (Field sends scheduled emails in-process, so it must
stay up), with sharing set to Public (Field does its own sign-in).

A publish deploys GitHub, not the workspace's files. Replit publishes a
snapshot of the workspace, so the deployment's build command
(`scripts/replit-deploy.sh build`, `.replit` `[deployment]`) fetches the
deploy ref from the public repository into `.field-deploy/`, builds it there
and records its commit. The run command (`scripts/replit-deploy.sh start`)
starts Field from `.field-deploy/`. The default ref is the tip of `main`.

- The fetch needs no token. If it fails, the build fails and the publish
  stops; it never deploys the workspace copy instead.
- Only a commit that passed GitHub CI is built. After the fetch, the build
  asks GitHub's API, without a token, for the commit's check runs
  (`scripts/deploy-checks.js`). `test`, `client-build`, `docker-build` (CI)
  and `gitleaks` (Secret Scan) must each have completed with success, as
  reported by GitHub Actions. Otherwise the build fails and the publish
  stops. A pinned `FIELD_DEPLOY_REF` is checked the same way.
- It only writes `.field-deploy/` (gitignored). It never resets or deletes
  the workspace's own files, wherever it runs.
- `.field-deploy/` holds no `data/`, so the published app rebuilds its data
  directory from PostgreSQL alone. The workspace's own `data/` is still in
  Replit's snapshot, but nothing reads it, so boot quarantines nothing from it
  (#87).
- The build log names what it deployed and its CI result:
  `[deploy] fetched main at <commit>`, `[deploy] checks: passed (test,
  client-build, docker-build, gitleaks) at <commit>`, then
  `[deploy] built github main at <commit> into .field-deploy/ (checks: passed)`.
  The start log repeats it, and `GET /health` shows it as `build.checks`.

The check refuses the build, and names the reason in the log, when:

| Build log | What it means | What to do |
| --- | --- | --- |
| `checks: NOT passed`, then `<check>: still in progress` (or `queued`) | `main`'s CI is still running on the merged commit. A merge to `main` runs CI again on the new commit, which takes a few minutes | Wait for the commit's checks on GitHub, then publish again |
| `checks: NOT passed`, then `<check>: failure` (or another result) | The commit failed CI | Fix it on `main`, or pin a commit that passed |
| `<check>: no run on this commit` | The check never ran on that commit (for example a pinned commit from a branch whose CI was not run) | Pin a commit on `main` |
| `checks: could not be read: GitHub's API rate limit ... is used up. It resets at <time>` | Without a token, GitHub allows 60 API requests an hour from one address, and Replit's build machines may share one | Publish again after that time |
| `checks: could not be read: GitHub did not answer` (or `HTTP 5xx`) | The network or GitHub failed, after three tries | Publish again; check [githubstatus.com](https://www.githubstatus.com) |

It never treats an unreadable answer as a pass.

To deploy what is merged on `main`:

1. Publishing > Republish. Nothing needs pulling first.
   - **If the publish stops at "Development database changes detected", press
     Cancel.** Never pick an option there. The workspace and the published app
     have separate databases, and Replit offers to make production's tables
     match the workspace's; when the workspace is behind, every option drops
     or renames production tables. Field migrates production itself at boot.
2. When Replit says it is done, Field still needs about a minute to rebuild
   its data directory from PostgreSQL; until then requests get "Internal
   Server Error". `GET /health` answers once it is up. Its `build` shows what
   is live: `revision` (the commit), `ref` (`main`, the pinned ref, or the
   channel `stable` or `beta`), `release` (the release tag, when the build is
   one), `source` (`github`, or `workspace` for an emergency build) and
   `checks` (`passed`, or `unchecked` when an emergency override built it). Check that
   `revision` is the commit you meant to deploy (the tip of `main` on
   GitHub) and that `checks` is `passed`.
3. Nothing to do for the workspace's database: it follows production by
   itself the next time the workspace boots or Field starts in it ("The
   workspace database"; needs the `FIELD_PRODUCTION_URL` Secret). To do it
   now, run `npm run db:follow-production` in the Shell: it must report
   `"state":"level"`. Run it after the publish, not before: production only
   gains a release's migrations when that release boots. It follows a
   pinned ref or a channel the same way, because it asks production which
   commit it runs.

`.replit`, `scripts/replit-deploy.sh`, `scripts/deploy-checks.js`,
`scripts/deploy-release.js` and `server/release-channel.js` are the only files
a publish takes from the workspace. Before the first publish with them, pull the workspace
once so its `.replit` has the deploy commands. When a commit changes them, the build log says
`note: ... differs from main`; pull the workspace before the next publish so
the new ones take effect.

### Following stable releases

Production should run published releases (`docs/RELEASING.md`), not every
merge to `main`. Set the deployment secret `FIELD_DEPLOY_REF` to `stable`
(Publishing > Adjust settings > Secrets), then publish. Each publish then
deploys the release the stable channel points at:

1. The build asks GitHub, without a token, for its latest release
   (`scripts/deploy-release.js`, `server/release-channel.js`). That is the
   newest stable release, or an earlier one if Field Release Promote rolled
   `latest` back. If GitHub cannot answer, it asks npm for
   `@arcforgelabs/field`'s `latest` dist-tag instead.
2. It downloads that release's `release-manifest.json` and checks it against
   its `.sha256`.
3. It fetches the release's tag and requires the commit to be the one the
   manifest names.
4. The CI check above applies as before.

If any step fails, the build fails and nothing is deployed; it never falls
back to `main`. The build log names the release:
`[deploy] release: stable is v2026.10.15 at <commit> (from github;
release-manifest.json sha256 <hash> verified)`, then
`[deploy] built github stable (v2026.10.15) at <commit>`. `GET /health` shows
it as `build.ref` `stable` and `build.release` `v2026.10.15`.

`FIELD_DEPLOY_REF=beta` follows the beta channel the same way: the newest
release of all, betas and stable releases alike, so it is never behind
stable.

A publish deploys whatever the channel points at when it runs; a new release
does not publish itself. An owner can see that one is out from
`GET /api/updates` (`docs/SELF_HOSTING.md`, "Update notice").

The default is still `main`.

### Updating to a new release

With `FIELD_DEPLOY_REF=stable`, after a release is published:

1. Read the release's notes on GitHub. If it changes one of the deploy files
   ("When to pull the workspace"), run `scripts/github-sync.sh pull` in the
   Shell first.
2. Publishing > Republish. If Replit stops at "Development database changes
   detected", press Cancel.
3. Open `GET /health`. `build.release` must be the new tag, `build.checks`
   `passed`, and `storage.state` `ok`.
4. The workspace's database follows by itself ("The workspace database").
   To check it now: `npm run db:follow-production` in the Shell must report
   `"state":"level"`. If the prompt ever appears, press Cancel.

### Publishing from an agent

An agent with Replit's connector can publish after a release, so a fix
reaches an installation without a person pressing Republish. The connector
signs in to one Replit workspace per connection: connect it to the
installation's workspace, and name the connection after the app, not the
customer (Field's own agents use **Replit for Field**, so the tools are
`mcp__Replit_for_Field__publish_app` and
`mcp__Replit_for_Field__get_publish_status`, the names allowed in
`.claude/settings.json`). Its `publish_app` republishes with the
deployment's own settings (a Reserved VM stays one), and
`get_publish_status` says `success`, `failed`, `suspended` or still running.

`scripts/publish-guard.js` decides, before and after:

```sh
node scripts/publish-guard.js before https://<app> stable           # 0 publish, 3 nothing to do, 1 stop
node scripts/publish-guard.js after https://<app> <tag> --wait 300  # 0 live, 1 stop
```

In a Claude Code cloud session, put `NODE_USE_ENV_PROXY=1
NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` before `node`, so Node uses the
session's proxy.

`before` passes only when GitHub's latest release and npm's `latest` name the
same tag, its `release-manifest.json` matches its `.sha256`, its commit passed
`test`, `client-build`, `docker-build` and `gitleaks`, and the live `/health`
is ok, follows `stable` from `github` and runs an older release. `after` asks
`/health` for up to `--wait` seconds until `build.release` is the tag with
`checks: passed`. Durable storage that is not ok is a warning. Set `GH_TOKEN`
where many machines share one address, so GitHub's anonymous limit (60
requests an hour) is not used up; the guard sends it to `api.github.com`
only.

The agent's steps:

1. Run `before`. On 3 stop quietly. On 1 stop and report the problems.
2. Call `get_publish_status`. Go on only if the last publish says `success`.
3. Call `publish_app` once.
4. Call `get_publish_status` every 30 seconds, for at most 15 minutes.
5. On `success`, run `after`. On anything else, stop.
6. Report the result. Never publish again in the same run, and never retry a
   publish that failed: the build refused it for a reason, and the old build
   stays live.

The workspace database follows production ("The workspace database"), so a
publish proposes no database changes. If a publish stops at "Development
database changes detected", a person presses **Cancel**; an agent never
answers it.

Claude Code's auto mode still asks before `publish_app`, because it deploys
production. The person who owns the installation approves by typing
`publish` in the same conversation as the agent. A message relayed from
another conversation is not that approval.

### When to pull the workspace

A publish takes these files from the workspace, not from the release:
`.replit`, `scripts/replit-deploy.sh`, `scripts/deploy-checks.js`,
`scripts/deploy-release.js` and `server/release-channel.js`. They stay as
they were when the workspace was last pulled. Pull (`scripts/github-sync.sh
pull`) when:

| When | Why |
| --- | --- |
| A release changes one of those files | Its fix takes effect only from the workspace. The build log says `note: <file> in the workspace differs from <ref>` |
| Before the first release of a month numbered above 31 (`2026.10.32`), if the workspace was last pulled before v2026.10.21 | An older `server/release-channel.js` reads the last number as a day, so it cannot read the tag and the build stops. Nothing is deployed and the live app keeps running |
| After you change `FIELD_DEPLOY_REF` or the deploy settings in `.replit` | So the workspace and the publish agree |

If `git pull` cannot fast-forward (the workspace has commits of its own),
take the deploy files from the newest stable release instead:

```bash
git fetch --tags origin
T=$(git tag -l 'v20*' --sort=-v:refname | grep -v beta | head -1)
git checkout "$T" -- .replit .gitignore scripts/replit-deploy.sh \
  scripts/deploy-checks.js scripts/deploy-release.js server/release-channel.js
```

`--sort=-v:refname` sorts each number as a number, so `2026.10.32` comes
after `2026.10.9`.

### Pinning a release and rolling back

Set the deployment secret `FIELD_DEPLOY_REF` (Publishing > Adjust settings)
to a release tag such as `v2026.10.15`, a branch or a full 40-character
commit hash, then publish. A release tag is reported as `build.release` too. To roll
back, set it to the older commit or tag and publish; to follow `main` again,
remove it and publish. Use a secret, not a deployment Configuration value: a
Configuration value is written into `.replit`.

Field's database migrations only move forward. An older release runs against
the newer schema, which works while the migrations are additive (so far they
are); check what the skipped commits migrated before you roll back.

Replit's documentation does not say whether deployment secrets reach the build
command. The start log checks it: `WARNING: FIELD_DEPLOY_REF is '<ref>' now,
but this build fetched 'main'` means the build did not see the secret. Then
put the ref in the build command itself, in `.replit`:
`build = ["env", "FIELD_DEPLOY_REF=<ref>", "bash", "scripts/replit-deploy.sh", "build"]`.

A fork sets `FIELD_DEPLOY_REPO` to its own repository's `https://` URL; the
fetch is anonymous, so the repository must be public.

### Emergency: build a commit whose CI has not passed

`FIELD_DEPLOY_ALLOW_UNCHECKED=1` (deployment secret, or in the build command as
above) builds the fetched commit even when its CI did not pass or GitHub
could not say. The build still asks, and logs the answer, then
`WARNING: FIELD_DEPLOY_ALLOW_UNCHECKED=1: building <ref> at <commit> although
CI did not pass or could not be read`. `/health` then shows
`checks: "unchecked"` (a commit that did pass still shows `passed`). Use it
only when production must change and CI cannot pass in time, for example
during a GitHub Actions outage, and remove it at the next publish.

### Emergency: publish the workspace files

`FIELD_DEPLOY_FROM_WORKSPACE=1`, together with `FIELD_DEPLOY_ALLOW_UNCHECKED=1`
(no CI ran on these files), builds the workspace's files as they are,
uncommitted edits included, with no fetch. Without
`FIELD_DEPLOY_ALLOW_UNCHECKED=1` the build refuses. Files `.gitignore`
excludes (`data/`, `node_modules/`, config) are left out. `/health` then
shows `source: "workspace"` and `checks: "unchecked"`. Use it only when
GitHub cannot be reached or a fix cannot wait for a merge, and remove both at
the next publish.

Production secrets (Publishing > Adjust settings) are separate from the
workspace's: `FIELD_STORAGE=postgres`, `FIELD_CONFIG_JSON`, the Clerk keys,
the R2 replica's settings ("Issued documents in R2") and Sentry's ("Error
monitoring (Sentry)").
Replit's managed Clerk also sets `CLERK_PROXY_URL` (`/api/__clerk`); Field
serves Clerk's Frontend API on that path (`server/auth/clerk-proxy.js`), so
sign-in loads from the app's own origin.

Custom domain: an A record plus a `replit-verify` TXT record (Replit gives
both), and Clerk's `clerk.`, `accounts.`, `clkmail.` and DKIM CNAMEs under the
same name. If your DNS provider proxies traffic, set these records to DNS only.

Data moved in from another host keeps job folder paths in `field.db`; Field
repoints them at its data directory on boot (log `[field-db] Pointed N of M
jobs at ...`).

## GitHub

The workspace tracks `main` on the GitHub repository
([arcforgelabs/field](https://github.com/arcforgelabs/field) for the
upstream project; your fork otherwise).

- Nothing commits to `main` directly, here or on GitHub; the ruleset on
  `main` refuses a direct push (`CONTRIBUTING.md`, "Merging to main"). Work
  on a branch, open a PR, merge on GitHub, then pull. Publishing does not need the pull
  ("Publishing"); the workspace's database and its `.replit` do.
- `scripts/github-sync.sh status`: remote, ahead/behind, and whether
  `GITHUB_TOKEN` works.
- `scripts/github-sync.sh pull`: fast-forward `main` from GitHub. It needs no
  token for a public repository. It drops Replit's "Published your App"
  commits when together they change no files, and stops if a local commit
  changes files.
- `scripts/github-sync.sh open-pr "<title>" [body-file]`: push the current
  branch and open a PR.
- `scripts/github-sync.sh handoff`: what to click in the Git pane when no
  token is set.

`GITHUB_TOKEN` (Replit Secret) is needed only to push or open pull requests
from the workspace. When used, it is a fine-grained token whose resource owner
is the repository's owner, scoped to this repo only, with Contents and Pull
requests read/write. Without it, the workspace only pulls, and changes reach
GitHub through pull requests opened elsewhere. The Agent's instructions are in `.agents/skills/github-sync/SKILL.md`.

### A production installation: fetch only

A workspace that runs a production installation should only follow
releases. It reads from GitHub and never writes to it. Development happens
elsewhere and reaches the installation as a release.

To make the workspace fetch-only:

1. Delete the `GITHUB_TOKEN` secret (Secrets), if there is one. Revoke the
   token on GitHub too (Settings > Developer settings > Personal access
   tokens).
2. In the Shell:

   ```sh
   git remote set-url --push origin no-push--this-workspace-is-fetch-only
   git config --unset credential.helper
   printf '#!/bin/sh\ncase "$2" in *github.com*|no-push*) echo "push refused: this install is fetch-only" >&2; exit 1;; esac\n' > .git/hooks/pre-push
   chmod +x .git/hooks/pre-push
   ```

   Use the name of the GitHub remote from `git remote -v` in place of
   `origin` if it differs. `git remote -v` then shows the GitHub URL for
   fetch and `no-push--this-workspace-is-fetch-only` for push. A push from
   the Shell or the Git pane fails. The hook refuses only GitHub, so
   Replit's own backup remote keeps working.
3. Do not press Push or Sync Changes in the Git pane. Pull is safe.

Publishing is not affected: the build fetches from GitHub without a token.
Replit's "Published your App" commits stay local, and
`scripts/github-sync.sh pull` drops them when together they change no files.

### Where an installation's settings go

Nothing specific to one installation goes in git. The repository is shared
by every installation.

| Setting | Where |
| --- | --- |
| Secrets: keys, tokens, client secrets (`FIELD_CONFIG_JSON`, `FIELD_SECRETS_KEY`, Clerk, Sentry, R2) | Replit Secrets (workspace) and Publishing > Adjust settings > Secrets (published app) |
| Start-up settings: `FIELD_STORAGE`, `FIELD_DEPLOY_REF`, `FIELD_DOCUMENT_REPLICA` | Publishing > Adjust settings > Secrets, for the published app only ("Durable storage", "Issued documents in R2"). A deployment Configuration value is written into `.replit`, so use a secret |
| Business data and in-app settings: people and roles, business profile, prices, integration connections | Field's database (PostgreSQL), changed in Field's own screens |
| Code, migrations, defaults for every installation | This repository, through a pull request |

When an installation needs a setting that does not exist, add it to Field as
a generic option (an environment variable or an in-app setting) by a pull
request, and set its value in the installation.
