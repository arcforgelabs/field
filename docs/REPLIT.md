# Field on Replit

Field can run as a published Replit app. This is the runbook for an
installation on Replit, for people and agents alike. Replit's Agent reads
`replit.md`, which links to `AGENTS.md` like the other harness files.

## What runs here

Field is a quoting and invoicing app: catalogue, quote builder, quote and
invoice PDFs, and sending them by email. It does no AI work of its own.

- Run and deploy with `scripts/replit-start.sh` (build: `scripts/replit-build.sh`).
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

Every value in `FIELD_CONFIG_JSON` is treated as secret, so keep it a Secret,
never a plain env var or a file in the repo. Field never writes config back:
Gmail OAuth refresh tokens granted through the app are stored in
`FIELD_DATA/gmail-oauth-users.json` (mode 0600) and take precedence over any in
`googleOAuth.users`.

`scripts/replit-start.sh` serves on `PORT` and sets `FIELD_RUNTIME=replit`
(also set in `.replit`), which makes Field refuse a local PGlite database: on
Replit the database is always `DATABASE_URL`.

## Database

Field's PostgreSQL connection comes from `DATABASE_URL`, the secret Replit
creates when the workspace's PostgreSQL database is added (`FIELD_DB_URL`
overrides it if both are set). It is a credential: keep it a Secret and never
print, log or paste it; Field's logs and `npm run db:smoke` name the variable,
not its value.

- On every start, before it serves anything, Field applies any pending
  migrations from `server/db/drizzle` (log line `[db] postgres (DATABASE_URL):
  ...`). If the database is unreachable or a migration fails, Field exits
  instead of starting.
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
  that already has items unless given `--replace`. Data problems it carries
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

## Data migrations

Some releases change existing records, not just the schema: re-keying quote
rows by uid, for example. These are data migrations
(`server/data-migrations/`). Field runs each one once, at boot, after the
schema migrations and before it serves anything:

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

**Before publishing a release that adds one, run the dry run in the
workspace shell.** It reads the production database (the workspace shares
`DATABASE_URL`) but never writes to it: it restores the stored job files into
a temporary directory and runs the same plan and verification there.

```bash
git fetch origin && git switch -C <release-branch> origin/<release-branch>   # or main once merged
npm ci && npm run db:build
npm run db:smoke                          # applied and pending schema migrations
npm run data:migrate -- --dry-run --json /tmp/data-migrations.json
```

- Exit 0 and `verification passed; nothing was written`: safe to publish.
  The summary per migration says how many files, rows and PDFs it checked,
  and `unresolved` counts rows whose code is not in the catalogue (those are
  left as they were and listed in the JSON).
- Exit 1 and `VERIFICATION FAILED`: do not publish. The failures are listed.
- Exit 2: the dry run itself could not run (database unreachable, a schema
  migration still pending: the dry run reads tables the new release adds, so
  run it from the release's code against a database already migrated by
  `npm run db:apply` only if you mean to migrate; otherwise publish first
  with `FIELD_DATA_MIGRATIONS_HOLD=all`, then dry-run, then remove the hold
  and restart).
- Delete `/tmp/data-migrations.json` afterwards: it names customer jobs.

The data migrations so far, in the order they run:

| Id | What it changes | Verified by |
| --- | --- | --- |
| `2026-10-12-quote-rows-by-uid` | Adds `catalogItemUid` / `sourceUid` beside codes on every job's quote rows | Files differ only by the added keys; PDFs byte-identical; pricing digest unchanged |
| `2026-10-12-price-book-cleanup` | A price book clean-up driven by `server/data-migrations/price-book-cleanup.plan.json`: names, types, categories, kits flattened, per-metre walls, unused items archived | One catalogue transaction: every item prices exactly as before or it rolls back; an item edited in the app since the plan was made is left alone; an item on a draft quote is not archived |

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
covers the database; the changes are additive (uids beside codes), so an
older release reads re-keyed files unchanged.

## Invoice rows backfill

The release with migration `0013_invoice_rows` (#27) writes invoice rows for
every milestone change from then on. Jobs invoiced before it need the
backfill once. Publish first, so boot applies 0013. Then, in the workspace
shell (it shares `DATABASE_URL` with the published app):

```bash
git fetch origin && git switch -C main origin/main
npm ci && npm run db:build
npm run db:smoke                    # no pending schema migrations
node scripts/backfill-invoice-rows.js --from-storage --dry-run --json > /tmp/invoice-rows-dry-run.json; echo "exit $?"
node scripts/backfill-invoice-rows.js --from-storage
rm /tmp/invoice-rows-dry-run.json
```

- `--from-storage` restores the stored job files, through a read-only
  session, into a new directory under `/tmp`, and deletes that directory
  when the run ends. The dry run writes nothing anywhere.
- Exit 0: every job verified. Exit 2: some jobs were refused; each is listed
  with both numbers (for example an invoice whose stored money differs from
  the totals its PDF printed), and nothing is written for those jobs. The
  real run still writes every job that verifies. Exit 1: it could not run
  (no database, or a migration still pending).
- Warnings do not refuse a job: `tax-total-printed` (a milestone's GST kept
  as issued), `reconcile-stale` (drafts built against an earlier quote),
  `issued-unverified` (no readable copy of the PDF) and
  `payment-on-superseded` (a payment on a revision that was later revised).
- A second run writes nothing new. Invoices link the quote versions they
  bill when the quote rows exist; run it again after the quote-row backfill
  to fill those links (each is filled once).
- Delete the JSON afterwards: it names customer jobs and amounts.

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

Set `FIELD_STORAGE=postgres` for the **published app only**, never in this
workspace's `[env]` or Secrets shared with it: the workspace and the published
app would otherwise compete for the same lock (the second to start waits 60 s,
then exits). If the workspace needs it, give it its own database through
`FIELD_DB_URL`.

Moving existing data in (once, before the first publish with durable storage,
with no Field process using the database):

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

| Name | Kind | Value |
| --- | --- | --- |
| `FIELD_DOCUMENT_REPLICA` | Configuration | `r2`. Unset: no replica, Field behaves as before |
| `FIELD_R2_ENDPOINT` | Configuration | `https://<account-id>.r2.cloudflarestorage.com` (the account ID is in the R2 overview) |
| `FIELD_R2_BUCKET` | Configuration | Your bucket's name, for example `<your-bucket>` |
| `FIELD_R2_ACCESS_KEY_ID` | Secret | The token's S3 Access Key ID |
| `FIELD_R2_SECRET_ACCESS_KEY` | Secret | The token's S3 Secret Access Key |

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
3. In a shell that has the deployment's secrets, once `pending` is 0:

   ```bash
   npm run documents:verify-r2
   ```

   It reads every stored document back from R2 and checks its hash. It
   writes nothing. Exit 0 means every one is there with the right bytes; 2
   lists what is missing, different or unreadable; 1 means it could not run.
   It needs the database and the four `FIELD_R2_*` settings.

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
4. Verify: `/api/storage/status` shows `bootCheck.ok: true`, `/health` shows
   `state: ok`, and `npm run documents:verify-r2` exits 0.
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

## Publishing

Publish as a Reserved VM (Field sends scheduled emails in-process, so it must
stay up), with sharing set to Public (Field does its own sign-in).

To deploy a change merged on GitHub:

1. In the workspace shell, bring it to `main`. Every publish leaves an
   empty "Published your App" commit on the workspace's `main`; never push
   those commits.
   - `git fetch origin && git status --short` must list nothing.
   - `git cherry -v origin/main HEAD` lists each commit only the workspace
     has. `-` means its change is already on GitHub. `+` needs a look unless
     it is a "Published your App" commit; stop and open a PR for anything
     else.
   - Keep the current state, then move `main`:
     `git branch replit-pre-deploy-$(date +%Y%m%d-%H%M) HEAD && git switch -C main origin/main`.
     `switch -C` refuses rather than overwrite uncommitted files, and the
     backup branch keeps the old commits; delete it once the publish is
     verified.
2. `bash scripts/replit-build.sh` must exit 0.
3. Publishing > Republish. When Replit says it is done, Field still needs about
   a minute to rebuild its data directory from PostgreSQL; until then requests
   get "Internal Server Error". `GET /health` answers once it is up.
   - **If the publish stops at "Development database changes detected", press
     Cancel.** Never pick an option there. The workspace and the published app
     have separate databases, and Replit offers to make production's tables
     match the workspace's; when the workspace is behind, every option drops
     or renames production tables. Field migrates production itself at boot.
4. Once `/health` answers, bring the workspace database to the same level:
   `npm run db:apply`, then `npm run db:smoke` must report `"pending":0`. Do
   this after each publish, not before: the workspace database has to match
   production at the next publish, and production only gains a release's
   migrations when that release boots. If a publish was cancelled at the
   prompt above, apply only production's migrations instead, from a checkout
   of the release production runs.

Production secrets (Publishing > Adjust settings) are separate from the
workspace's: `FIELD_STORAGE=postgres`, `FIELD_CONFIG_JSON`, the Clerk keys,
and the R2 replica's settings ("Issued documents in R2").
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
([embarkearthworks/field](https://github.com/embarkearthworks/field) for the
upstream project; your fork otherwise).

- Nothing commits to `main` directly, here or on GitHub. Work on a branch,
  open a PR, merge on GitHub, then pull.
- `scripts/github-sync.sh status`: remote, ahead/behind, and whether
  `GITHUB_TOKEN` works.
- `scripts/github-sync.sh pull`: fast-forward `main` from GitHub.
- `scripts/github-sync.sh open-pr "<title>" [body-file]`: push the current
  branch and open a PR.
- `scripts/github-sync.sh handoff`: what to click in the Git pane when no
  token is set.

`GITHUB_TOKEN` (Replit Secret) is a fine-grained token whose resource owner is
the repository's owner, scoped to this repo only, with Contents and Pull requests
read/write. The Agent's instructions are in `.agents/skills/github-sync/SKILL.md`.
