# Field DB Lane

Field's PostgreSQL schema and migrations. The Drizzle migrations in
`drizzle/` are live: the server applies them at boot (see "Runtime" below).
The older `migrations/0001_initial.sql` lane (from "Scope" on) is an additive
scaffold that the running server does not use.

## Drizzle toolchain

The typed Drizzle source lives in `src/` and targets PostgreSQL. The generated
ESM output is written to `dist/` (ignored in source control and copied into
the runtime image by the Docker build). `src/schema.ts` holds the
test-scoped `drizzle_toolchain_probe` table (it proves the toolchain) and
every table the server uses: durable storage, users and tenancy, the price
catalogue (`server/catalog/README.md`, migration `0003_price_catalogue`),
data migrations, issued documents, quote rows and invoice rows.

The generated migration set is `drizzle/`. It is intentionally separate from
the older hand-written `migrations/0001_initial.sql` backfill lane below;
Drizzle does not replay or replace that legacy migration.

From the repository root:

```bash
npm run db:typecheck       # fail on a data-layer TypeScript error
npm run db:build           # clean stale output, then compile ESM for the plain-JS server boundary
npm run db:generate        # generate schema-as-code migrations
npm run db:check           # verify generated migration history is consistent
npm run db:check:ci        # regenerate, check, and fail on uncommitted drift
```

Applying or opening Studio from the command line requires an explicitly
supplied `DATABASE_URL` (these commands do not read `FIELD_DB_URL`). Keep it
in the approved local environment/secret store. Normal Field boot does not
need these commands: it applies the same migrations itself
(`runMigrations`, below):

```bash
export DATABASE_URL=<development-postgres-url>
npm run db:apply
npm run db:studio
```

The focused test always checks the compiled import and generated artifacts.
With only `FIELD_DB_TEST_DATABASE_URL` supplied, it runs the PostgreSQL
migration/query test against that URL and writes/deletes a probe row; use only
a dedicated disposable development/test database, never a production database.
With `FIELD_DB_TEST_DOCKER=1` supplied, it starts an opt-in disposable
`postgres:16-alpine` container with no volume, applies the generated migration,
queries the probe, and removes the container. Supplying both variables is a
fail-closed configuration error before either mode connects. Supplying neither
keeps the database integration skipped. Docker cleanup failures fail the test;
the proof does not touch normal runtime storage or infrastructure.

## Runtime: `server/db-runtime/`

The server reaches PostgreSQL only through `server/db-runtime/index.js`:

| Export | What it does |
| --- | --- |
| `getDb(options?)` | The shared Drizzle instance (with `schema`), created on first call. Synchronous; the first query waits for the connection. `options` (`{ env, dataDir }`) apply only to the first call. Throws `NoDatabaseError` (`code: "FIELD_NO_DATABASE"`) when no database is configured, so a feature that needs a table fails closed. |
| `runMigrations(options?)` | Applies pending `server/db/drizzle` migrations to `getDb()`'s database and returns `{ driver, target, total, applied }`. `server/index.js` awaits it before anything else uses the database and exits if it throws. With no database configured it opens nothing and returns `{ driver: "none", ..., skipped: true }`; boot logs that and carries on to the price catalogue, which then refuses to start without a database (unless its emergency override allows a degraded boot). |
| `closeDb()` | Closes the connection (and releases the PGlite lock). Called on SIGTERM/SIGINT. |
| `checkDb()` / `getMigrationStatus(db?)` | Read-only: `select 1` plus `{ total, applied, pending }`. `npm run db:smoke` prints this. |
| `queryRows(sql, db?)` | Raw SQL as a Drizzle `` sql`...` `` fragment (values become parameters; plain strings are refused) returning a plain row array on either driver. |
| `getDbInfo()` | `{ driver, target }`; `target` names where the URL came from, never the URL. |
| `createTestDb({ install }?)` | Tests: a fresh in-memory PGlite with every migration applied, isolated from all others (`{ db, client, driver, close }`). The migrated image is built once per process, so each one costs ~0.2 s. `install: true` also makes it what `getDb()` returns until `close()`. |
| `schema`, `MIGRATIONS_FOLDER`, `MIGRATION_LOCK_KEY`, `NoDatabaseError` | The compiled schema module, the migrations path, the advisory-lock key migrations hold, and the no-database error class. |

Which database, decided once per process:

1. `FIELD_DB_URL`, else `DATABASE_URL` (on Replit, the Replit-provided
   secret): PostgreSQL through postgres.js (pool size `FIELD_DB_POOL_MAX`,
   default 5). Migrations run on a separate one-connection pool holding the
   session advisory lock `MIGRATION_LOCK_KEY`, so two processes booting at once
   do not race. The lock is taken with `pg_try_advisory_lock` in a loop bounded
   by `FIELD_DB_MIGRATION_LOCK_TIMEOUT_MS` (default 60000): a hung holder makes
   boot fail with a clear error instead of hanging. Other advisory locks must
   use different keys.
2. Otherwise PGlite (PostgreSQL in WebAssembly, in-process), **only when asked
   for**: `FIELD_PGLITE=1` keeps it in `<data dir>/pglite` (`npm run dev` sets
   this), `FIELD_PGLITE_DIR=<dir>` elsewhere, `FIELD_PGLITE_DIR=memory://` in
   memory. On Replit (`FIELD_RUNTIME=replit` or `REPLIT_DEPLOYMENT` set) it is
   refused and boot exits: a published app loses runtime files, so the
   database would silently go with them.
   PGlite has no cross-process locking, so the runtime holds a kernel lock on
   `<dir>.lock` while the directory is open: a never-committed SQLite write
   transaction (an `fcntl` lock on POSIX) through better-sqlite3. The kernel
   admits one holder and drops the lock when that process exits or is killed,
   so there is no stale lock to take over; a second process gets "in use by
   process N" (N read from `<dir>.holder.lock`, which is informational only).
   `<dir>.lock` is an empty file that is never deleted (deleting it under a
   waiting process would allow two holders). Nothing else may open it: on
   POSIX, closing any descriptor a process has on the file drops its lock.
3. Neither: no database. Nothing is opened, boot logs
   `[db] no database configured: migrations skipped ...`, and `getDb()` throws
   `NoDatabaseError`. Since the price catalogue moved here, Field itself does
   not start this way (the catalogue needs a database), except under the
   catalogue's incident override `FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE=1`.

PGlite is opt-in because of its memory, measured on this host
(`shared_buffers` 16MB; process VmHWM / VmRSS after `runMigrations()`):

| | Node 24.11 | Node 20.20 |
| --- | --- | --- |
| no database (driver `none`) | 156 / 118 MiB | 57 / 57 MiB |
| PGlite, first open (initdb + migrate) | 1148 / 741 MiB | 783 / 702 MiB |
| PGlite, reopen of an existing directory | 322 / 322 MiB | 206 / 206 MiB |

The first open takes roughly 1 s, a reopen 0.1-0.2 s. Do not enable PGlite in
a memory-capped runtime; give it a PostgreSQL URL instead.

Through a transaction-mode pooler (PgBouncer, a Neon `-pooler` host) session
advisory locks and prepared statements do not survive between transactions.
A Neon `-pooler` host name is detected: the target reads `postgres
(DATABASE_URL, pooled; migrations use the direct host)`, the server's pool
turns prepared statements off, and migrations (which hold a session advisory
lock) connect to the same host without `-pooler`, Neon's direct endpoint.
Other poolers (a PgBouncer on its own host name) are not detected: point
`FIELD_DB_URL` at a direct endpoint for those. Which endpoint Replit's
`DATABASE_URL` uses has not been checked yet.

Both drivers run sessions in UTC and return `int8` and `numeric` as strings,
so raw query results match between PGlite and the real server (the tests
check this). `bytea` differs: a `Buffer` from postgres.js, a `Uint8Array` from
PGlite.

The connection string is a secret. The runtime never logs or returns it, and
errors give the variable name and the driver's cause (for example
`postgres (DATABASE_URL): connect ECONNREFUSED ...`).

### Durable storage tables

`0001_durable_storage` adds the tables behind `FIELD_STORAGE=postgres`
(`server/storage/durable-store.js`): `field_blobs(sha256, bytes)` holds
file contents once per distinct content, `field_files(path, sha256, size,
mode, mtime)` one row per mirrored file of the data directory, and
`field_sqlite_images(name, version, sha256, bytes, created_at)` whole-database
images (newest 20 versions each): the server images `field.db`; the data
import (`scripts/migrate-data-to-postgres.js`) also stores the legacy
`price-catalog/catalog.db` it imported from, as an archive.
Only the process holding advisory lock `STORAGE_LOCK_KEY` (7139000002) writes
them; every storage transaction checks it still holds the lock.

### Tenancy and row-level security

`0005_tenancy` (pricing engine phase 0b; design in `docs/PRICING_ENGINE.md` "Tenancy")
makes the database multi-organisation. `organizations` is the directory
(the default organisation, slug `embark`, is `schema.DEFAULT_ORG_UID`, and every
earlier row was backfilled into it). `users` is the person; their role and
status in an organisation are `org_memberships`. Every other table except
`units`, `unit_aliases`, durable storage and `organizations` is a tenant
table:

- It has `org_uid`, defaulting to `field_org_uid()`, and the policy
  `<table>_tenant_isolation`: rows are visible and writable only when
  `org_uid` equals the transaction's `field.org_uid` setting. `ENABLE` and
  `FORCE ROW LEVEL SECURITY` are both on, so the table owner is filtered too.
- `field_org_uid()` raises when `field.org_uid` is unset, so a tenant query
  outside an organisation transaction fails loudly instead of seeing nothing,
  for any role RLS applies to. A login role that bypasses RLS itself
  (superuser, BYPASSRLS) is only filtered inside organisation transactions;
  boot logs a warning when that is the case.
- Children point at parents through `(org_uid, key)` composite foreign keys,
  so a link to another organisation's row is refused even though foreign-key
  checks ignore RLS. Codes and category names are unique per organisation.

`server/db-runtime/tenancy.js` opens organisation transactions:

| Export | What it does |
| --- | --- |
| `withOrg(db, orgUid, fn, config?)` | One transaction: `SET LOCAL ROLE field_app` (when the login role may), `set_config('field.org_uid', orgUid, true)`, then `fn(tx)`. Nested in a caller's transaction it restores the role and setting afterwards. |
| `orgScope(db, orgUid)` | A handle with only `transaction()` (= `withOrg`) and `orgUid`. Stores take it as their `db`; a stray `scope.select()` is a TypeError, not an empty read. |
| `withRequestOrg(db, req, fn)` / `requestOrgUid(req)` | `withOrg` for `req.fieldOrg.uid`, which `requireAuth` sets from the signed-in person's membership (machine tokens and break-glass belong to the deployment's organisation). No organisation is a 403. |
| `resolveDeploymentOrg(db)` | The organisation this deployment serves: `FIELD_ORG` (slug), default `embark`. |
| `assertRowSecurity(db)` / `inspectRowSecurity(db)` | Boot refuses a login role on which RLS would not hold, a `field_app` that could bypass RLS itself, and any table with `org_uid` that lacks ENABLE, FORCE or its policy. |

How RLS holds, whatever the login role is:

1. **`SET LOCAL ROLE field_app`** (preferred). The migration creates
   `field_app` (NOLOGIN, NOBYPASSRLS) and grants it to the migrating role,
   when that role has CREATEROLE. Its privileges are explicit: row access to
   the tenant tables, read-only `units`, `unit_aliases` and `organizations`,
   `users` without changing an email or id, `USAGE` on sequences (no
   `setval`), and nothing on durable storage. There are no default
   privileges, so a new table is unreachable from a request until its
   migration grants it. Each organisation transaction switches to it, so RLS holds
   even for a superuser (PGlite) or a BYPASSRLS login.
2. **FORCE ROW LEVEL SECURITY.** If `field_app` could not be created, a login
   role without BYPASSRLS (the table owner, on Replit) is still filtered.
3. Neither: boot exits with `row-level security cannot hold for database
   role ...`.

Migrations run as the login role (the owner). A later migration that reads
or writes tenant rows must `set_config('field.org_uid', ...)` for each
organisation it touches; with FORCE on, the owner sees nothing otherwise.

**Rolling back.** 0005 cannot be undone by redeploying an older release:
older code reads `users.role` and the catalogue without an organisation.
`rollback/0005_tenancy.down.sql` reverses it, as the owner in one
transaction with the app stopped (the command is in its header). It refuses
when a second organisation exists. `tenancy.test.js` proves that the result
matches a database migrated only to 0004, data included, and that 0005
re-applies afterwards.

### Item code aliases

`0006_item_code_aliases` (code retirement step 2) records every item code as an alias
of its item (`item_code_aliases`: org, code, item uid; unique per
organisation on `lower(code)`), backfilled one organisation at a time.
Two triggers on `items` keep it complete: `items_code_alias_insert` records a
new item's code, and `items_code_immutable` refuses any change to
`items.code`. Aliases go only with their item (the foreign key cascades).
`rollback/0006_item_code_aliases.down.sql` reverses it the same way as 0005's
(owner, one transaction, app stopped); it refuses when an alias is not some
item's current code, and `server/catalog/code-aliases.test.js` proves the
result matches a database migrated only to 0005. Roll 0006 back before 0005.

### Catalogue schema v2 (part one)

`0007_catalogue_schema_v2` (pricing engine phase 1) is hand-written, because
drizzle-kit would drop and re-create a renamed table: it renames
`item_components` to `kit_components` (`kit_uid`, `component_uid`, with
every index, constraint, sequence and policy renamed to match; rows, grants
and row-level security carry over), drops the five never-written
`assembly_*` tables (refusing if one holds rows), and adds `items.type` with
its check, set to `kit` on every item with components, and `items.notes`
(internal notes, never printed). Its snapshot was taken
from a fresh `drizzle-kit generate` of the schema, and the schema the
migration chain builds was compared with the one a fresh generate builds:
they differ only in 0005's hand-written `ON DELETE SET NULL (column)`.
`rollback/0007_catalogue_schema_v2.down.sql` reverses it (owner, one
transaction, app stopped; types set since are lost), and
`server/catalog/schema-v2.test.js` proves the result matches a database
migrated only to 0006. Roll back 0007 before 0006.

### Data migration ledger

`0008_data_migrations` adds `data_migrations` (org, id, applied_at, summary),
the record of data migrations that ran (`server/data-migrations/`, run at
boot by `server/index.js`, rehearsed by `npm run data:migrate --
--dry-run` and checked in a running installation with `GET
/api/admin/data-migrations/dry-run`; procedure in `docs/REPLIT.md` "Data
migrations"). A recorded
migration never runs again. `field_app` may read and insert, never update or
delete. `rollback/0008_data_migrations.down.sql` drops it (roll back 0008
before 0007).

### Issued documents

`0009_issued_documents` (design in `docs/PRICING_ENGINE.md`
"`document_events` and `issued_documents`") adds four tenant tables:
`document_blobs` (PDF bytes once per organisation by SHA-256, hash checked by
a `CHECK`), `issued_documents` (one immutable row per issued document,
`doc_…`), `document_events` (append-only, `dev_…`) and
`document_number_counters` (the invoice number sequence, used since 0014). Triggers refuse `UPDATE`,
`DELETE` and `TRUNCATE` on blobs and events and on every `issued_documents`
column except `details`, for the owner as well as `field_app`, which is
granted only `SELECT, INSERT` (and `UPDATE (details)`). Only
`server/documents/` reads or writes them.

It does not depend on 0006 to 0008, but it comes after them: Drizzle
applies a migration only when its journal timestamp is later than the last
one applied.
`rollback/0009_issued_documents.down.sql` reverses it; run it before 0008's.

### Quote rows

`0010_quote_rows` (#6; design in `docs/PRICING_ENGINE.md` "Quotes and
invoices") adds three tenant tables: `quotes` (one row per quote version,
`qte_…`, unique per job and version, linked to the issued document it was
sent as), `quote_sections` (`qsc_…`) and `quote_lines` (`qln_…`). Totals
are `numeric(12,2)`; unit sell, unit cost and quantity `numeric(12,4)`,
`numeric(12,4)` and `numeric(14,4)`. A `computed` line total must equal
round(quantity × unit sell, 2) (a `CHECK`); a `printed` one needs its
reason. Once a quote is sent, accepted or declined, or has a send
time, triggers refuse any change to its sections and lines, its money,
customer and wording, setting it back to draft and deleting it, for the
owner as well as `field_app`; `TRUNCATE` is always refused. `field_app` may
read and write the rows otherwise. Only `server/quotes/` reads or writes
them. Since 0011 (#10) the quote PDF, the quote email's totals, the job's
totals and the job detail's customer pricing read them, through
`server/quotes/read-model.js` (`FIELD_QUOTE_READS=files` sends those reads
back to the job files).
`rollback/0010_quote_rows.down.sql` reverses it (the backfill rebuilds the
rows after 0010 is applied again, since the job files still hold every
quote); run it before 0009's.

`0011_quote_row_display` (#10) adds what the documents print besides money
to `quote_lines` and `quote_sections`: excluded from the price, amount hidden
or blank, collapsed, row style and notes, and on lines `row_kind`,
`display_unit_sell` and `line_cost`. Every column has a default or is
nullable, and 0010's triggers cover them. `rollback/0011_quote_row_display.down.sql`
drops them (the rows and their money stay); run it before 0010's.

### The R2 replica record

`0012_document_replicas` (#12; `docs/REPLIT.md` "Issued documents in R2")
adds `document_blob_replicas`, one row per `document_blobs` blob the R2
replicator has tried: `r2_replicated_at`, `attempts`, `last_attempt_at`,
`next_attempt_at` (backoff) and `last_error`, a short code (a `CHECK` allows
only `A-Z`, digits and `_`, so no message or credential can be stored). A
trigger refuses `DELETE`, `TRUNCATE` and any `UPDATE` of a row already
replicated. `field_app` may select, insert and update. Only
`server/documents/replicator.js` writes it.

It does not depend on the quote-row migrations (0010, 0011); it follows them
because Drizzle applies only migrations whose journal timestamp is later than
the last one applied. `rollback/0012_document_replicas.down.sql` drops the
table; the bytes stay in `document_blobs` and in R2. Run it before 0011's.

### Invoice rows

`0013_invoice_rows` (#27; design in `docs/PRICING_ENGINE.md` "Invoices and
payments") adds seven tenant tables: `payment_milestones` (`pms_…`, a
job's schedule), `invoices` (`inv_…`, one row per invoice as issued, number
as printed, unique per job), `invoice_lines` (`iln_…`), `credit_notes` and
`credit_note_lines` (`crn_…`, `cnl_…`; written by the issue service since 0015),
`payments` (`pay_…`) and `receipts` (`rct_…`, one per payment). Money is
`numeric(12,2)`; line rates, quantities and tax rates follow `quote_lines`,
with the same `computed` / `printed` line-total check. Once an invoice or
credit note has an issue time, triggers refuse any change to its number,
money, lines or issue time, setting it back to draft, and deleting it, for
the owner as well as `field_app`; its status, amount paid, due date, kind
and note may change, and links missing when it was written are filled once.
A payment is never deleted and may only be voided, once; a receipt may only
be voided. `TRUNCATE` is always refused. `field_app` may read and write the
rows otherwise. Only `server/invoices/` reads or writes them.
`rollback/0013_invoice_rows.down.sql` drops them (the backfill rebuilds them
from the job files after 0013 is applied again); run it before 0012's.

### Invoice issue

`0014_invoice_issue` (#28; design in `docs/PRICING_ENGINE.md` "Invoices and
payments") adds `invoices.issue_key`, the idempotency key of the invoice
issue service (`server/invoices/issue.js`). An invoice with a key was issued
from the sequence: its number is `INV-YYYY-M-N`, unique in the organisation,
and it carries the job reference. Invoices issued before 0014 keep their
`EI-…` numbers and a null key. `rollback/0014_invoice_issue.down.sql` refuses
once any invoice has been issued with an `INV` number; run it before 0013's.

### Credit notes and business settings

`0015_credit_notes` (#28) corrects an issued invoice with a credit note,
never in place. `credit_notes` gains the replacement invoice and the issue
service's idempotency key, and the new append-only `payment_allocations`
moves the payments a credited invoice held to its replacement. Invoices
revised in place before 0015 get no credit note.
`rollback/0015_credit_notes.down.sql` refuses once a credit note has been
issued; run it before 0014's.

`0016_business_settings` (#28) adds `business_settings`, one row per
organisation (none means every default). Its first setting says whether an
invoice returned to draft and issued again with different content is
credited first: `when-emailed` (the default), `always` or `never`. Run
`rollback/0016_business_settings.down.sql` before 0015's.

### Xero

`0017_xero_connection` (#93) adds `xero_connections`, one row per
organisation: the Xero organisation Field writes to, the OAuth tokens
encrypted with AES-256-GCM (`server/xero/token-crypto.js`), the sign-in in
progress (its state only as a hash) and the owner's Xero settings. The Xero
app's client id and secret stay deployment secrets. `field_app` may read,
insert and update. Run `rollback/0017_xero_connection.down.sql` before
0016's. Operating it: `docs/XERO.md`.

`0018_xero_invoice_sync` (#93) adds `xero_invoice_syncs`, one row per issued
invoice on its way to one Xero organisation (its state, attempts, next try,
the worker's lease, last error code and reason, and the Xero invoice it
became); `invoices.xero_invoice_id`, `xero_tenant_id` and `xero_status`; and
`xero_invoice_links`, append-only, every Xero invoice an invoice has had by
organisation (`field_app` may read and insert). It replaces 0013's
issued-invoice trigger function so that those three columns may change on an
issued invoice: an id is replaced only when the earlier one is in
`xero_invoice_links` and either belongs to another organisation or is
recorded as voided or deleted in Xero. It also adds
`xero_connections.codes_checked_at` and `codes_problem`, the saved codes
checked against the connected organisation.
Nothing else about an issued invoice may change. Run
`rollback/0018_xero_invoice_sync.down.sql` before 0017's: it restores 0013's
function before it drops the columns.

### Adding tables

A tenant table gets `orgUid: orgUid()` and `tenantIsolation("<table>")` in
`src/schema.ts`, and `(org_uid, key)` foreign keys to its parents. Its
migration adds what drizzle-kit does not emit: `FORCE ROW LEVEL SECURITY`
and `GRANT ... TO field_app` (guarded by `IF EXISTS (SELECT 1 FROM pg_roles
WHERE rolname = 'field_app')`). Boot and `server/db-runtime/tenancy.test.js`
both fail for a table with `org_uid` that lacks RLS, FORCE or its policy.

1. Edit `src/schema.ts` and run `npm run db:build`.
2. Generate the migration: `npx drizzle-kit generate --dialect=postgresql
   --schema=server/db/src/schema.ts --out=server/db/drizzle --prefix=index
   --name=<what_it_adds>` (`npm run db:generate` uses the fixed name
   `toolchain_probe`, so pass a real name). Commit the SQL and `meta/`;
   `npm run db:check:ci` fails on uncommitted drift.
3. Boot applies it. In tests, `createTestDb()` has it.

`server/db-runtime/test-postgres.js` gives tests a disposable database on a
real server when `FIELD_DB_TEST_DATABASE_URL` (CI) or `FIELD_DB_TEST_DOCKER=1`
is set: `startTestPostgres()` returns `{ url, stop }` or `null`.

## Scope

- Postgres becomes the future canonical store for structured state.
- Raw and binary artifacts stay referenced through `storage_objects`.
- Quote-catalog metadata remains file-authoritative under `quote-catalogs/`.
- Google Drive is modeled only as async backup/export through `backup_jobs`.

## Files

- `migrations/0001_initial.sql`
  Initial additive schema for jobs, captures, quotes, timeline, gaps, chat, measurements, storage objects, backup outbox, and audit events.
- `job-backfill.js`
  Shared mapper that reads the job folders under the data directory and produces deterministic rows/SQL for `0001_initial.sql`. `scripts/backfill-db.js` is its command line.
- `ARTIFACT-MAP.md`
  Current file/folder artifact to target-table mapping.

## Storage Key

`storage_objects.relative_path` is the physical path under the scanned root.
`storage_objects.storage_key` is the logical unique key used for import/upsert, so one physical file can still be represented in more than one logical role when needed during backfill.

## Apply Schema

Into a dedicated, empty database only, never `$DATABASE_URL` (see Backfill CLI):

```bash
psql "$LEGACY_DATABASE_URL" -f server/db/migrations/0001_initial.sql
```

## Backfill CLI

From the repository root:

```bash
node scripts/backfill-db.js --source-root /path/to/field/data
node scripts/backfill-db.js --source-root /path/to/field/data --emit-sql /tmp/field-backfill.sql
node scripts/backfill-db.js --source-root /path/to/field/data --include-schema --apply --database-url "$LEGACY_DATABASE_URL"
node scripts/backfill-db.js --source-root /path/to/field/data --seed-backup-jobs --emit-sql -
```

With no output option it prints a count of rows per table and writes nothing.
`--emit-sql` writes the SQL; `--apply` pipes it to `psql`. Every row is an
upsert on a stable key, so a second import changes no row counts.
`scripts/backfill-db.test.js` proves this on synthetic job folders and an
in-memory PGlite.

This lane writes the `0001_initial.sql` tables, not the Drizzle tables that
`server/db-runtime/` migrates, and the server never reads them. Both schemas
have a `quotes` table with different columns, so never apply it to Field's
own database. Use a dedicated, empty database. Two guards hold this:

- `--apply` needs `--database-url`. It never reads `DATABASE_URL` or
  `FIELD_DATABASE_URL`, because on Replit they are Field's own database.
- The SQL starts with a check that raises an error, before anything is
  written, when the target has `drizzle.__drizzle_migrations` (the table
  `server/db-runtime/` records its migrations in). This also covers SQL from
  `--emit-sql` that someone pipes to `psql` by hand.

## Backup Model

`backup_jobs` is an outbox. A future worker should:

1. select `pending` rows ordered by priority and schedule
2. upload the referenced `storage_object` to Drive
3. write remote ids/status back into `backup_jobs.payload` and/or `storage_objects.storage_metadata`
4. never make the app read canonical state from Drive

That keeps Drive as backup/export only, not live storage.
