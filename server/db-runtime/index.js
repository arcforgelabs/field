// Field's one PostgreSQL runtime.
//
// Every server module that needs the database goes through here:
//
//   getDb()          the shared Drizzle instance (created on first call)
//   runMigrations()  apply server/db/drizzle before the server listens
//   closeDb()        close the connection (shutdown, tests)
//   createTestDb()   a fresh, isolated in-process Postgres with migrations applied
//
// Which database:
//   FIELD_DB_URL or DATABASE_URL set (FIELD_DB_URL wins) -> that PostgreSQL
//     server through postgres.js. On Replit, DATABASE_URL is the secret Replit
//     provides for its PostgreSQL database.
//   Otherwise PGlite (PostgreSQL compiled to WebAssembly, in-process), but only
//     when asked for: it needs hundreds of MB, which memory-capped runtimes
//     (the 256 MiB verification container) do not have. FIELD_PGLITE=1 keeps
//     it under <data dir>/pglite (`npm run dev` sets this), FIELD_PGLITE_DIR
//     names another directory, FIELD_PGLITE_DIR=memory:// keeps it in memory.
//     It is refused on Replit (FIELD_RUNTIME=replit or REPLIT_DEPLOYMENT set):
//     a published app loses runtime files, so the database would be lost.
//   Neither -> no database. runMigrations() opens nothing and says so, and
//     getDb() throws NoDatabaseError, so code that needs a table fails closed.
//
// The connection string is a secret: nothing here prints, logs or returns it.
// Status and errors name the variable it came from, never its value.
//
// The Drizzle schema is server/db/src/schema.ts, compiled by `npm run db:build`
// to server/db/dist, which is what this module imports.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, types as pgliteTypes } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import Database from "better-sqlite3";
import postgres from "postgres";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "../storage/fs.js";
import { getDataRoot } from "../storage/write-recorder.js";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../db/drizzle/", import.meta.url));
const SCHEMA_ENTRY = new URL("../db/dist/schema.js", import.meta.url);

// Session-level advisory lock held while migrations run, so two processes
// sharing one PostgreSQL never apply the same migration twice. Other locks
// (e.g. the single-writer storage lock) must use different keys.
export const MIGRATION_LOCK_KEY = 7_139_000_001n;

let schema;
try {
  schema = await import(SCHEMA_ENTRY.href);
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" && !existsSync(fileURLToPath(SCHEMA_ENTRY))) {
    throw new Error("Field's data layer is not built (server/db/dist is missing): run `npm run db:build`");
  }
  throw error;
}
export { schema };

// PGlite parses int8 (bigint) and numeric into JS numbers; postgres.js, which
// production uses, returns both as strings. Make PGlite match so code tested on
// PGlite behaves the same against the real server. (bytea still differs:
// postgres.js returns a Buffer, PGlite a Uint8Array; Buffer is a Uint8Array.)
const PGLITE_PARSERS = {
  [pgliteTypes.INT8]: (value) => value,
  [pgliteTypes.NUMERIC]: (value) => value,
};
// Sessions run in UTC on both drivers. PGlite otherwise guesses a zone from the
// host's current offset (e.g. Etc/GMT-9 in Adelaide), which changes how
// timestamptz values render as text. A 16MB buffer cache (PostgreSQL's default
// is 128MB) is ample for Field's data. PGlite is still memory-hungry; see
// server/db/README.md for measured figures.
const PGLITE_OPTIONS = {
  parsers: PGLITE_PARSERS,
  postgresqlconf: ["timezone = 'UTC'", "shared_buffers = '16MB'"],
};

// PGlite starts Postgres with `-c search_path=public`, which beats postgresql.conf
// and a database-level setting. Point that flag at field before any client opens.
// A missing `field` schema is skipped, so migrations 0000-0024 still create tables
// in public; 0025 creates `field` and moves them.
export const FIELD_SEARCH_PATH = "field, public";

// PGlite's startup flag is the string "search_path=public". Replace that one
// entry. A rename in a future PGlite (the map matching nothing) used to leave
// every session on public with no error; refuse to start instead.
export function pinPgliteSearchPath(params) {
  if (!Array.isArray(params)) {
    throw new Error("PGlite.defaultStartParams is missing; Field cannot point its search_path at schema field");
  }
  let replaced = false;
  const next = params.map((param) => {
    if (param === "search_path=public") {
      replaced = true;
      return "search_path=field,public";
    }
    return param;
  });
  if (!replaced) {
    throw new Error("PGlite.defaultStartParams has no search_path=public entry; Field cannot point its search_path at schema field");
  }
  return next;
}

PGlite.defaultStartParams = pinPgliteSearchPath(PGlite.defaultStartParams);

// A pooler closes server sessions out from under a query (migration 0025
// does this on purpose, so those sessions come back with the new
// search_path). postgres.js rejects the query and does not run it again.
const CLOSED_CONNECTION_CODES = new Set([
  "57P01", // admin_shutdown: pg_terminate_backend
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08P01", // protocol_violation: a pooler reporting a dead server connection
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "ECONNRESET",
  "EPIPE",
]);

export function isClosedConnectionError(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (CLOSED_CONNECTION_CODES.has(current.code)) return true;
    if (typeof current.message === "string" && /connection terminated|terminating connection due to administrator command|administrator shutdown|server conn crashed|server closed the connection|CONNECTION_CLOSED|CONNECTION_DESTROYED/i.test(current.message)) {
      return true;
    }
  }
  return false;
}

// One retry, on a new query (postgres.js sends it on another connection).
// The transaction client begin() hands in is left alone: retrying one
// statement of a dead transaction would run it outside that transaction.
// begin() is retried only when its callback has not started. An idle session
// closed by migration 0025 fails on BEGIN, before the callback. Once the
// callback has run, a retry would repeat it, including an external call such
// as a token refresh.
const QUERY_MODIFIERS = ["values", "raw", "simple", "execute", "describe"];

function retryingQuery(create) {
  const chain = [];
  let pending = null;
  const proxy = {};
  for (const name of QUERY_MODIFIERS) {
    proxy[name] = (...args) => {
      chain.push([name, args]);
      return proxy;
    };
  }
  function build() {
    let query = create();
    for (const [name, args] of chain) query = query[name](...args);
    return query;
  }
  function run() {
    if (!pending) {
      pending = (async () => {
        try {
          return await build();
        } catch (error) {
          if (!isClosedConnectionError(error)) throw error;
          return build();
        }
      })();
    }
    return pending;
  }
  proxy.then = (onFulfilled, onRejected) => run().then(onFulfilled, onRejected);
  proxy.catch = (onRejected) => run().catch(onRejected);
  proxy.finally = (onFinally) => run().finally(onFinally);
  return proxy;
}

export function retryClosedConnections(sql) {
  function wrapped(strings, ...args) {
    return retryingQuery(() => sql(strings, ...args));
  }
  return new Proxy(wrapped, {
    get(_target, prop) {
      if (prop === "unsafe") return (...args) => retryingQuery(() => sql.unsafe(...args));
      if (prop === "begin") {
        return async (options, fn) => {
          const userFn = typeof options === "function" ? options : fn;
          const invoke = () => {
            let started = false;
            const wrappedFn = (...args) => {
              started = true;
              return userFn(...args);
            };
            try {
              const pending = typeof options === "function" ? sql.begin(wrappedFn) : sql.begin(options, wrappedFn);
              return Promise.resolve(pending).then(
                (value) => ({ ok: true, value }),
                (error) => ({ ok: false, error, started }),
              );
            } catch (error) {
              return { ok: false, error, started };
            }
          };
          const first = await invoke();
          if (first.ok) return first.value;
          if (first.started || !isClosedConnectionError(first.error)) throw first.error;
          const second = await invoke();
          if (second.ok) return second.value;
          throw second.error;
        };
      }
      const value = sql[prop];
      return typeof value === "function" ? value.bind(sql) : value;
    },
  });
}


const NO_DATABASE_HINT =
  "set DATABASE_URL or FIELD_DB_URL (for local development only: FIELD_PGLITE=1 or FIELD_PGLITE_DIR)";

let state = null;
let exitHookInstalled = false;

function readEnv(env, name) {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function isReplit(env) {
  return readEnv(env, "FIELD_RUNTIME").toLowerCase() === "replit" || readEnv(env, "REPLIT_DEPLOYMENT") !== "";
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(value);
}

// Transaction-mode poolers (PgBouncer, Neon's "-pooler" hosts) do not keep
// prepared statements or session advisory locks across transactions. Only the
// host name is inspected.
const POOLER_HOST = /-pooler(?=\.|$)/i;

function isPooledUrl(url) {
  try {
    return POOLER_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Neon names a pooled endpoint by adding "-pooler" to the endpoint id
// (ep-x-pooler.region.aws.neon.tech); the same host without it is the direct
// endpoint. Migrations hold a session advisory lock, which needs a direct
// session, so they connect there. The result is a secret like its input.
function directUrl(url) {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(POOLER_HOST, "");
  return parsed.toString();
}

// Work out which database to use, without connecting. Exported for tests and
// for status reporting; `url` is present only for the postgres driver and must
// never be logged. `driver` is "postgres", "pglite" or "none".
export function resolveDbConfig({ env = process.env, dataDir } = {}) {
  for (const source of ["FIELD_DB_URL", "DATABASE_URL"]) {
    const url = readEnv(env, source);
    if (!url) continue;
    if (!/^postgres(?:ql)?:\/\//i.test(url)) {
      throw new Error(`${source} must be a postgres:// or postgresql:// connection string`);
    }
    const pooled = isPooledUrl(url);
    // `migrationUrl` is where runMigrations() connects: the direct endpoint
    // when `url` is pooled. Both are secrets.
    const migrationUrl = pooled ? directUrl(url) : url;
    return {
      driver: "postgres",
      url,
      migrationUrl,
      source,
      pooled,
      target: `postgres (${source}${pooled ? ", pooled; migrations use the direct host" : ""})`,
    };
  }
  const override = readEnv(env, "FIELD_PGLITE_DIR");
  const requested = override !== "" || isTruthy(readEnv(env, "FIELD_PGLITE"));
  if (isReplit(env)) {
    if (requested) {
      throw new Error(
        "PGlite is refused on Replit: a published app loses its runtime files, and the database with them. Set DATABASE_URL (add Replit's PostgreSQL database) and unset FIELD_PGLITE/FIELD_PGLITE_DIR",
      );
    }
    return { driver: "none", source: null, target: "no database (DATABASE_URL is not set)" };
  }
  if (!requested) return { driver: "none", source: null, target: "no database configured" };
  if (override === "memory://") {
    return { driver: "pglite", dir: null, source: "FIELD_PGLITE_DIR", target: "pglite (in memory)" };
  }
  if (override) {
    const dir = resolve(override);
    return { driver: "pglite", dir, source: "FIELD_PGLITE_DIR", target: `pglite (${dir})` };
  }
  const root = dataDir ?? getDataRoot() ?? (readEnv(env, "FIELD_DATA") ? resolve(readEnv(env, "FIELD_DATA")) : null);
  if (!root) {
    throw new Error("FIELD_PGLITE=1 needs a data directory (FIELD_DATA) to keep PGlite in; or set FIELD_PGLITE_DIR");
  }
  const dir = join(resolve(root), "pglite");
  return { driver: "pglite", dir, source: "FIELD_PGLITE", target: `pglite (${dir})` };
}

// Thrown by getDb() when no database is configured, so a feature that needs a
// table fails closed with a message saying what to set.
export class NoDatabaseError extends Error {
  constructor(target = "no database configured") {
    super(`No database configured (${target}): ${NO_DATABASE_HINT}`);
    this.name = "NoDatabaseError";
    this.code = "FIELD_NO_DATABASE";
  }
}

// PGlite has no cross-process locking: two processes opening one directory
// corrupt it. The runtime holds a kernel lock on <dir>.lock for as long as it
// has the directory open: a SQLite write lock (BEGIN IMMEDIATE) through
// better-sqlite3, i.e. an fcntl byte-range lock on POSIX. The kernel admits
// exactly one holder and drops the lock when the holder exits or crashes, so
// there is no stale lock to take over and no check-then-act window: a lock
// file left behind by a dead process is simply locked again.
//
// <dir>.lock is never deleted. Unlinking it while another process has it open
// would let a third process create a new file and lock that one, giving two
// holders. It stays an empty file and holds no data.
//
// POSIX caveat: closing ANY descriptor this process has on <dir>.lock drops
// the lock, so nothing but this module may open that file. (Both names end in
// .lock, which the data mirror excludes.)
//
// <dir>.holder.lock records the holder's process id for the "in use" message.
// It is informational only (written after the lock is taken, replaced
// atomically, removed on release) and is never used to decide who holds the lock.
function lockPaths(dir) {
  return { lockPath: `${dir}.lock`, holderPath: `${dir}.holder.lock` };
}

function readLockHolder(holderPath) {
  try {
    const pid = Number.parseInt(readFileSync(holderPath, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function lockInUseError(dir, holder) {
  const who = holder ? `process ${holder}` : "another process";
  const error = new Error(
    `PGlite database ${dir} is in use by ${who}; stop it, or set FIELD_DB_URL to share a PostgreSQL server`,
  );
  error.code = "FIELD_PGLITE_LOCKED";
  return error;
}

function acquirePgliteLock(dir) {
  const { lockPath, holderPath } = lockPaths(dir);
  mkdirSync(dirname(dir), { recursive: true });
  // timeout 0: never wait; a busy lock means a live holder.
  const lockDb = new Database(lockPath, { timeout: 0 });
  try {
    // Keep the rollback journal in memory: nothing is ever written, and a
    // journal file would be one more name beside the lock (and a "hot journal"
    // to recover after a crash). better-sqlite3 refuses journal_mode = OFF.
    lockDb.pragma("journal_mode = MEMORY");
    // A write transaction takes SQLite's RESERVED lock, which only one
    // connection can hold; it is never committed, so it is held until close.
    lockDb.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lockDb.close();
    if (error.code === "SQLITE_BUSY") throw lockInUseError(dir, readLockHolder(holderPath));
    if (error.code === "SQLITE_NOTADB") {
      throw new Error(
        `${lockPath} is not a Field lock file (left by an older build?); if no Field process is using ${dir}, delete it`,
      );
    }
    throw error;
  }
  try {
    // Only the lock holder writes here, so the pid is a unique enough name. A
    // random suffix would also draw from the seeded source the verification
    // preload installs, shifting every id and token after boot in PGlite mode
    // only, so the quote/invoice proof could not compare PGlite with
    // FIELD_STORAGE=postgres.
    const staging = `${holderPath}.${process.pid}.tmp`;
    writeFileSync(staging, `${process.pid}\n`, { mode: 0o600 });
    renameSync(staging, holderPath);
  } catch (error) {
    lockDb.close();
    throw error;
  }
  return { lockDb, holderPath };
}

function releasePgliteLock(lock) {
  if (!lock || !lock.lockDb.open) return;
  // Remove our holder record first, while we still hold the lock, so it can
  // never delete a record a later holder wrote.
  try {
    if (readLockHolder(lock.holderPath) === process.pid) unlinkSync(lock.holderPath);
  } catch {
    // Already gone.
  }
  lock.lockDb.close();
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // The kernel drops the lock itself on exit; this only tidies the holder record.
  process.once("exit", () => releasePgliteLock(state?.lock));
}

function openPostgres(config, { max } = {}) {
  const configured = Number.parseInt(process.env.FIELD_DB_POOL_MAX || "", 10);
  const sql = postgres(config.url, {
    max: max ?? (Number.isInteger(configured) && configured > 0 ? configured : 5),
    idle_timeout: 60,
    connect_timeout: 15,
    // A transaction-mode pooler cannot keep a prepared statement between
    // transactions (see isPooledUrl).
    prepare: !config.pooled,
    onnotice: () => {},
    connection: { application_name: "field", TimeZone: "UTC", search_path: FIELD_SEARCH_PATH },
  });
  // 0025 closes this role's other idle sessions. A query riding one of them
  // fails once with 57P01; run it again on a connection the pool opens.
  return retryClosedConnections(sql);
}

function open(config) {
  if (config.driver === "postgres") {
    const client = openPostgres(config);
    return { client, db: drizzlePostgres(client, { schema }), lock: null };
  }
  const lock = config.dir ? acquirePgliteLock(config.dir) : null;
  try {
    const client = new PGlite({ ...PGLITE_OPTIONS, dataDir: config.dir ?? "memory://" });
    return { client, db: drizzlePglite(client, { schema }), lock };
  } catch (error) {
    releasePgliteLock(lock);
    throw error;
  }
}

// The shared Drizzle instance. The first call opens the connection; options
// ({ env, dataDir }) are read only then. postgres.js connects lazily and PGlite
// starts in the background, so this returns at once; the first query waits.
// Throws NoDatabaseError when no database is configured.
export function getDb(options = {}) {
  if (state) return state.db;
  const config = resolveDbConfig(options);
  if (config.driver === "none") throw new NoDatabaseError(config.target);
  state = { config, ...open(config) };
  if (state.lock) installExitHook();
  return state.db;
}

// { driver, target } for whatever getDb() uses (opening nothing new), or null
// before the first getDb(). `target` is safe to log.
export function getDbInfo() {
  if (!state) return null;
  return { driver: state.config.driver, target: state.config.target };
}

export async function closeDb() {
  if (!state) return;
  const { config, client, lock } = state;
  state = null;
  try {
    if (config.driver === "postgres") await client.end({ timeout: 5 });
    else if (!client.closed) await client.close();
  } finally {
    releasePgliteLock(lock);
  }
}

// Drizzle wraps driver errors as "Failed query: <sql>"; the useful part is the
// innermost cause (e.g. "connect ECONNREFUSED 127.0.0.1:5432"). Any connection
// string that slipped into a message is masked.
function describeDbError(error) {
  let inner = error;
  while (inner?.cause instanceof Error) inner = inner.cause;
  const message = inner?.message || inner?.code || String(inner);
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]");
}

async function withDbErrors(target, work) {
  try {
    return await work();
  } catch (error) {
    throw new Error(`${target}: ${describeDbError(error)}`, { cause: error });
  }
}

// Rows of a raw SQL query as a plain array on either driver (postgres.js
// returns an array, PGlite a { rows } result). Only Drizzle sql`` fragments
// are accepted, so values always travel as parameters; a plain string would
// invite interpolating input into SQL.
export async function queryRows(query, db = getDb()) {
  if (typeof query === "string") {
    throw new TypeError("queryRows takes a Drizzle sql`` fragment, not a string");
  }
  const result = await db.execute(query);
  return Array.isArray(result) ? Array.from(result) : result.rows;
}

function migrationJournal(migrationsFolder = MIGRATIONS_FOLDER) {
  return JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")).entries;
}

async function appliedMigrationCount(db) {
  const [exists] = await queryRows(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`, db);
  if (!exists?.present) return 0;
  const [row] = await queryRows(sql`select count(*)::int as applied from drizzle.__drizzle_migrations`, db);
  return Number(row.applied);
}

// Migration counts without changing anything: { total, applied, pending }.
// `migrationsFolder` names another set of migrations to count against (the
// Replit workspace follows the release production runs:
// scripts/replit-workspace-db.js).
export async function getMigrationStatus(db = getDb(), { migrationsFolder = MIGRATIONS_FOLDER } = {}) {
  const total = migrationJournal(migrationsFolder).length;
  const applied = await appliedMigrationCount(db);
  return { total, applied, pending: Math.max(total - applied, 0) };
}

// Apply every pending migration in server/db/drizzle to getDb()'s database.
// Returns { driver, target, total, applied } where `applied` counts the ones
// this call ran. Throws (without the connection string) if the database is
// unreachable or a migration fails; boot treats that as fatal.
//
// With no database configured it opens nothing (no PGlite, no connection) and
// returns { driver: "none", target, total, applied: 0, skipped: true }.
//
// `migrationsFolder` applies another folder of migrations instead, under the
// same lock. The server always uses its own; scripts/replit-workspace-db.js
// passes the folder of the release production runs.
export async function runMigrations({ migrationsFolder = MIGRATIONS_FOLDER, ...options } = {}) {
  if (!state) {
    const config = resolveDbConfig(options);
    if (config.driver === "none") {
      return { driver: "none", target: config.target, total: migrationJournal(migrationsFolder).length, applied: 0, skipped: true };
    }
  }
  const db = getDb(options);
  const { config } = state;
  return withDbErrors(config.target, () => migrateDb(db, config, migrationsFolder));
}

const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;

function migrationLockTimeoutMs() {
  const value = Number.parseInt(process.env.FIELD_DB_MIGRATION_LOCK_TIMEOUT_MS || "", 10);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
}

// Wait for MIGRATION_LOCK_KEY without blocking forever behind a hung holder:
// pg_try_advisory_lock in a bounded loop, so boot fails with a clear message
// instead of hanging until the platform's health check gives up.
async function takeMigrationLock(client) {
  const timeoutMs = migrationLockTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await client`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint) as locked`;
    if (row.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `another process held the migration lock (advisory lock ${MIGRATION_LOCK_KEY}) for over ${timeoutMs} ms; is a migration hung? (FIELD_DB_MIGRATION_LOCK_TIMEOUT_MS)`,
      );
    }
    await new Promise((wake) => setTimeout(wake, 250));
  }
}

// Roles are cluster-wide, but MIGRATION_LOCK_KEY is an advisory lock, which
// only serialises migrations within one database. Two databases on one server
// migrating at once (test databases, or two installations sharing a cluster)
// can both create, alter or grant field_app (0005) and collide. Drizzle runs
// pending migrations in one transaction, so a run that hit this was rolled
// back and is safe to repeat. Every migration after 0005 lengthens that one
// transaction, and so the window two runs can collide in: retry more, and
// back off further, than a single migration would need.
const ROLE_CONFLICT_RETRIES = 10;

function isClusterRoleConflict(error) {
  for (let current = error; current; current = current.cause) {
    const code = current.code;
    if (code === "XX000" && /tuple concurrently updated/i.test(current.message || "")) return true;
    if (code === "23505" && /^pg_auth(id|_members)_/.test(current.constraint_name || current.constraint || "")) return true;
    if (code === "42710" && /\brole\b/i.test(current.message || "")) return true;
  }
  return false;
}

// Apply the migrations to one PostgreSQL drizzle instance, repeating a run a
// cluster-wide role conflict rolled back. runMigrations uses it under the
// migration lock; tests that migrate databases of their own call it directly,
// so databases migrating side by side on one server never collide.
export async function migratePostgresDatabase(db, { migrationsFolder = MIGRATIONS_FOLDER } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await migratePostgres(db, { migrationsFolder });
    } catch (error) {
      if (attempt > ROLE_CONFLICT_RETRIES || !isClusterRoleConflict(error)) throw error;
      await new Promise((wake) => setTimeout(wake, 100 * attempt + Math.floor(Math.random() * 250)));
    }
  }
}

async function migrateDb(db, config, migrationsFolder) {
  let before;
  if (config.driver === "pglite") {
    before = await appliedMigrationCount(db);
    await migratePglite(db, { migrationsFolder });
  } else {
    // A pool of exactly one connection, so the session advisory lock and the
    // migration are guaranteed to share a backend. That needs a direct
    // session: for a pooled URL this connects to its direct host instead.
    const client = openPostgres({ url: config.migrationUrl, pooled: false }, { max: 1 });
    try {
      await takeMigrationLock(client);
      const lockedDb = drizzlePostgres(client, { schema });
      before = await appliedMigrationCount(lockedDb);
      await migratePostgresDatabase(lockedDb, { migrationsFolder });
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY.toString()}::bigint)`;
    } finally {
      await client.end({ timeout: 5 });
    }
  }
  const status = await getMigrationStatus(db, { migrationsFolder });
  return { driver: config.driver, target: config.target, total: status.total, applied: status.applied - before };
}

// Connectivity check that changes nothing (no migrations):
// { ok, driver, target, ms, migrations: { total, applied, pending } }.
// Throws NoDatabaseError when no database is configured.
export async function checkDb(options = {}) {
  const started = performance.now();
  const db = getDb(options);
  const info = getDbInfo();
  return withDbErrors(info.target, async () => {
    await queryRows(sql`select 1 as ok`, db);
    const migrations = await getMigrationStatus(db);
    return { ok: true, ...info, ms: Math.round(performance.now() - started), migrations };
  });
}

// ---------------------------------------------------------------------------
// Tests

let testTemplate = null;

async function buildTestTemplate() {
  const client = new PGlite(PGLITE_OPTIONS);
  try {
    await migratePglite(drizzlePglite(client, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    return await client.dumpDataDir("none");
  } finally {
    await client.close();
  }
}

// A fresh in-memory PGlite with every migration applied, isolated from every
// other one. The migrated image is built once per process and copied, so each
// call costs ~0.2 s rather than a full initdb.
//
//   const t = await createTestDb();          // { db, client, driver, close }
//   ... t.db.select()...; await t.close();
//
// With { install: true } it also becomes what getDb() returns until close(),
// for code that calls getDb() itself. Only one can be installed at a time.
export async function createTestDb({ install = false } = {}) {
  testTemplate ??= buildTestTemplate().catch((error) => {
    testTemplate = null;
    throw error;
  });
  const client = new PGlite({ ...PGLITE_OPTIONS, loadDataDir: await testTemplate });
  await client.waitReady;
  const db = drizzlePglite(client, { schema });
  const handle = {
    db,
    client,
    driver: "pglite",
    close: async () => {
      if (state?.client === client) await closeDb();
      else if (!client.closed) await client.close();
    },
  };
  if (install) {
    if (state) {
      await client.close();
      throw new Error("createTestDb({ install: true }): a database is already open; closeDb() first");
    }
    state = {
      config: { driver: "pglite", dir: null, source: "createTestDb", target: "pglite (test)" },
      client,
      db,
      lock: null,
    };
  }
  return handle;
}

// The PGlite directory lock on its own, for the lock tests (racing many
// processes through getDb() would start a PGlite in each winner).
export { acquirePgliteLock as acquirePgliteLockForTests, releasePgliteLock as releasePgliteLockForTests };
