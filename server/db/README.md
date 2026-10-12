# Field DB Lane

Additive DB-first scaffold for `apps/field`. This lane does not change the live runtime contract, live API routes, or the current shipped Field UX baseline work.

## DEL-75 Drizzle toolchain

The typed Drizzle source lives in `src/` and targets PostgreSQL. The generated
ESM output is written to `dist/` (ignored in source control and copied into
the runtime image by the Docker build). `src/schema.ts` holds the
test-scoped `drizzle_toolchain_probe` table (it proves the toolchain) and the
price catalogue's tables (`server/catalog/README.md`, migration
`0001_price_catalogue`).

The generated migration set is `drizzle/`. It is intentionally separate from
the older hand-written `migrations/0001_initial.sql` backfill lane above;
Drizzle does not replay or replace that legacy migration.

From the repository root:

```bash
npm run db:typecheck       # fail on a data-layer TypeScript error
npm run db:build           # clean stale output, then compile ESM for the plain-JS server boundary
npm run db:generate        # generate schema-as-code migrations
npm run db:check           # verify generated migration history is consistent
npm run db:check:ci        # regenerate, check, and fail on uncommitted drift
```

Applying or opening Studio requires an explicitly supplied `DATABASE_URL`.
Keep it in the approved local environment/secret store; it is never needed by
normal Field boot:

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
(`server/storage/durable-store.js`, #139): `field_blobs(sha256, bytes)` holds
file contents once per distinct content, `field_files(path, sha256, size,
mode, mtime)` one row per mirrored file of the data directory, and
`field_sqlite_images(name, version, sha256, bytes, created_at)` whole-database
images (newest 20 versions each): the server images `field.db`; the data
import (`scripts/migrate-data-to-postgres.js`) also stores the legacy
`price-catalog/catalog.db` it imported from, as an archive.
Only the process holding advisory lock `STORAGE_LOCK_KEY` (7139000002) writes
them; every storage transaction checks it still holds the lock.

### Tenancy and row-level security

`0005_tenancy` (#178 phase 0b; design in `docs/PRICING_ENGINE.md` "Tenancy")
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

`0006_item_code_aliases` (#178 step 2) records every item code as an alias
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

`0007_catalogue_schema_v2` (#178 phase 1) is hand-written, because
drizzle-kit would drop and re-create a renamed table: it renames
`item_components` to `kit_components` (`kit_uid`, `component_uid`, with
every index, constraint, sequence and policy renamed to match; rows, grants
and row-level security carry over), drops the five never-written
`assembly_*` tables (refusing if one holds rows), and adds `items.type` with
its check, set to `kit` on every item with components. Its snapshot was taken
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
boot by `server/index.js` and rehearsed by `npm run data:migrate --
--dry-run`; procedure in `docs/REPLIT.md` "Data migrations"). A recorded
migration never runs again. `field_app` may read and insert, never update or
delete. `rollback/0008_data_migrations.down.sql` drops it (roll back 0008
before 0007).

### Issued documents

`0009_issued_documents` (#223; design in `docs/PRICING_ENGINE.md`
"`document_events` and `issued_documents`") adds four tenant tables:
`document_blobs` (PDF bytes once per organisation by SHA-256, hash checked by
a `CHECK`), `issued_documents` (one immutable row per issued document,
`doc_…`), `document_events` (append-only, `dev_…`) and
`document_number_counters` (not used yet). Triggers refuse `UPDATE`,
`DELETE` and `TRUNCATE` on blobs and events and on every `issued_documents`
column except `details`, for the owner as well as `field_app`, which is
granted only `SELECT, INSERT` (and `UPDATE (details)`). Only
`server/documents/` reads or writes them.

It does not depend on 0006 to 0008, but it comes after them: Drizzle
applies a migration only when its journal timestamp is later than the last
one applied.
`rollback/0009_issued_documents.down.sql` reverses it; run it before 0008's.

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
- Quote-catalog metadata remains file-authoritative under `apps/field/quote-catalogs/`.
- Google Drive is modeled only as async backup/export through `backup_jobs`.

## Files

- `migrations/0001_initial.sql`
  Initial additive schema for jobs, captures, quotes, timeline, gaps, chat, measurements, storage objects, backup outbox, and audit events.
- `recording-backfill.js`
  Shared mapper that reads the current recording-folder structure and produces deterministic rows/SQL.
- `ARTIFACT-MAP.md`
  Current file/folder artifact to target-table mapping.

## Storage Key

`storage_objects.relative_path` is the physical path under the scanned root.
`storage_objects.storage_key` is the logical unique key used for import/upsert, so one physical file can still be represented in more than one logical role when needed during backfill.

## Apply Schema

```bash
psql "$DATABASE_URL" -f apps/field/server/db/migrations/0001_initial.sql
```

## Backfill CLI

```bash
node apps/field/scripts/backfill-db.js --source-root /opt/apps/field/data --emit-sql /tmp/field-backfill.sql
node apps/field/scripts/backfill-db.js --source-root /opt/apps/field/data --include-schema --apply
node apps/field/scripts/backfill-db.js --source-root /opt/apps/field/data --seed-backup-jobs --emit-sql -
```

## Backup Model

`backup_jobs` is an outbox. A future worker should:

1. select `pending` rows ordered by priority and schedule
2. upload the referenced `storage_object` to Drive
3. write remote ids/status back into `backup_jobs.payload` and/or `storage_objects.storage_metadata`
4. never make the app read canonical state from Drive

That keeps Drive as backup/export only, not live storage.
