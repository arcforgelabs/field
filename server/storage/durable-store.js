// Durable file storage in PostgreSQL.
//
// Field keeps its state as files under the data directory (FIELD_DATA). A
// published Replit app loses runtime files on every publish, so with
// FIELD_STORAGE=postgres the data directory becomes a working copy of what is
// stored in PostgreSQL:
//
//   field_blobs(sha256, bytes)                 file contents, deduplicated
//   field_files(path, sha256, size, mode, mtime)  one row per mirrored file
//   field_sqlite_images(name, version, sha256, bytes, created_at)
//                                              whole-database SQLite images
//
// Boot (before the server listens): take the storage advisory lock (one
// writer per database), then rebuild the data directory from PostgreSQL:
// every stored file is written back with its mode and mtime, the newest image
// of each SQLite database replaces the local file, and local files PostgreSQL
// does not know are moved aside to .quarantine-<time>/ (never deleted). An
// empty database is seeded from the local directory instead.
//
// While running, the storage shim (./fs.js) reports every write under the data
// directory. Writes made while handling a request are collected per request
// (AsyncLocalStorage); everything else (schedulers, boot) goes to one global
// set. A flush reads the changed paths from disk and commits them, plus any
// SQLite database that changed, in ONE transaction. Flushes happen:
//   - when a non-GET response is about to end: the middleware holds res.end
//     until that request's writes are stored (503 if they cannot be);
//   - at explicit commit points (flushDurableStorage in ./durable-hooks.js):
//     a published job generation, users / OAuth / Gmail token saves, and
//     scheduled-email claims;
//   - on scheduler ticks, every 5 minutes (a full reconcile that also catches
//     writes the shim cannot see), and on SIGTERM.
// So if the process dies mid-request, the next boot rebuilds the state as of
// the last flush: the half-done request is rolled back.
//
// Never mirrored (see isExcludedPath): agent/session state (.openclaw/,
// .sessions/), temporary and lock files (*.tmp, *.lock), job-generation locks,
// stages and quarantine folders, catalogue leases and raw uploads, PGlite's
// directory, and SQLite files (*.db, -wal, -shm, -journal). SQLite databases
// the server registers (field.db, the price catalogue) are stored as images
// (db.serialize()) whenever their data_version/total_changes moves; the last
// 20 versions of each are kept.
//
// FIELD_STORAGE unset: nothing here runs and Field is unchanged.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import Database from "better-sqlite3";
import postgres from "postgres";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "./fs.js";
import { getDataRoot, setWriteRecorder } from "./write-recorder.js";
import { installDurableStore } from "./durable-hooks.js";
import { queryRows, resolveDbConfig, schema } from "../db-runtime/index.js";
import { replitPlacement } from "../runtime-config.js";

const { fieldBlobs, fieldFiles, fieldSqliteImages } = schema;

// Session advisory lock held by the one process allowed to write storage.
// Distinct from the migration lock (7_139_000_001).
export const STORAGE_LOCK_KEY = 7_139_000_002n;
export const DEFAULT_KEEP_IMAGES = 20;
export const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
// A published Replit app: a republish starts the new copy while the old one
// still serves and holds the lock, and stops the old copy only after the new
// one answers its health check (server/standby-server.js). The new copy waits
// for that hand-over.
export const PUBLISHED_LOCK_TIMEOUT_MS = 10 * 60_000;
const QUERY_CHUNK = 500;
const BLOB_BATCH_BYTES = 16 * 1024 * 1024;
// One INSERT binds 2 parameters per blob; PostgreSQL's protocol allows at most
// 65,535 per statement, so many small blobs are also sent in row batches.
export const BLOB_BATCH_ROWS = 5000;
// A flush keeps the bytes it hashed up to this much; beyond it (e.g. seeding a
// large data directory) files are read again when they are stored.
const KEEP_READ_BYTES = 32 * 1024 * 1024;
const RESTORE_SUFFIX = ".durable-restore.tmp";

// ---------------------------------------------------------------------------
// What is mirrored

const EXCLUDED_SEGMENTS = new Set([
  ".openclaw",
  ".sessions",
  ".field-generation-lock",
  ".runtime-lease",
  ".maintenance-lease",
  ".lease-acquisition-lock",
]);
const EXCLUDED_SEGMENT_PREFIXES = [".field-generation-stage-", ".quarantine-"];
const EXCLUDED_TOP_LEVEL = new Set(["pglite"]);
const EXCLUDED_PATH_PREFIXES = ["price-catalog/_uploads"];
const EXCLUDED_SUFFIXES = [".tmp", ".lock", ".db", "-wal", "-shm", "-journal"];

// `rel` is a path relative to the data directory with "/" separators.
export function isExcludedPath(rel) {
  if (!rel) return false;
  const segments = rel.split("/");
  if (EXCLUDED_TOP_LEVEL.has(segments[0])) return true;
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
  }
  for (const segment of segments) {
    if (EXCLUDED_SEGMENTS.has(segment)) return true;
    if (EXCLUDED_SEGMENT_PREFIXES.some((prefix) => segment.startsWith(prefix))) return true;
  }
  const last = segments[segments.length - 1];
  return EXCLUDED_SUFFIXES.some((suffix) => last.endsWith(suffix));
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toRel(root, absPath) {
  const rel = relative(root, absPath);
  if (rel === "") return "";
  if (rel.startsWith("..") || resolve(root, rel) !== resolve(absPath)) return null;
  return rel.split(sep).join("/");
}

function absOf(root, rel) {
  return rel ? join(root, ...rel.split("/")) : root;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function statEntry(stat) {
  return { size: stat.size, mode: stat.mode & 0o7777, mtimeMs: Math.floor(stat.mtimeMs) };
}

// Every mirrorable regular file under `root` (relative paths, sorted).
// Symbolic links and other special files are not mirrored; they are counted.
export function listMirroredFiles(root, { relDir = "", skipped = [] } = {}) {
  const files = [];
  const walk = (dirRel) => {
    let entries;
    try {
      entries = readdirSync(absOf(root, dirRel), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (isExcludedPath(rel)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push(rel);
      else skipped.push(rel);
    }
  };
  walk(relDir);
  return files.sort();
}

// { path, size, mode, mtimeMs, sha256 } for every mirrorable file under `root`.
export function scanTree(root, { skipped = [] } = {}) {
  return listMirroredFiles(root, { skipped }).map((path) => {
    const abs = absOf(root, path);
    const stat = lstatSync(abs);
    return { path, ...statEntry(stat), sha256: sha256Hex(readFileSync(abs)) };
  });
}

// One hash for a whole tree: paths, modes, sizes, contents and mtimes (ms).
export function treeHash(manifest) {
  const hash = createHash("sha256");
  for (const entry of [...manifest].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${entry.path}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.sha256}\0${entry.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Database helpers (shared with scripts/migrate-data-to-postgres.js)

function chunks(list, size = QUERY_CHUNK) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

function lockParts(key) {
  return { classid: String(key >> 32n), objid: String(key & 0xffffffffn) };
}

export async function tryStorageLock(db, key = STORAGE_LOCK_KEY) {
  const [row] = await queryRows(sql`select pg_try_advisory_lock(${key.toString()}::bigint) as locked`, db);
  return row.locked === true;
}

export async function releaseStorageLock(db, key = STORAGE_LOCK_KEY) {
  await queryRows(sql`select pg_advisory_unlock(${key.toString()}::bigint) as unlocked`, db);
}

// True when this session (the connection `db` runs on) holds the lock.
export async function holdsStorageLock(db, key = STORAGE_LOCK_KEY) {
  const { classid, objid } = lockParts(key);
  const [row] = await queryRows(
    sql`select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and pid = pg_backend_pid() and granted
        and classid = ${classid}::bigint::oid and objid = ${objid}::bigint::oid and objsubid = 1
    ) as held`,
    db,
  );
  return row.held === true;
}

// Write `upserts` ({ path, sha256, size, mode, mtimeMs, bytes? | load? }),
// remove `deletions` (paths) and add SQLite `images` ({ name, sha256, bytes })
// inside the caller's transaction `tx`. Blob bytes are only sent for contents
// PostgreSQL does not have yet; `load()` is called just for those. If a
// reloaded file changed since it was hashed, `strict` fails the write;
// otherwise the entry is updated to the newer content (the latest disk state).
export async function writeChanges(tx, { upserts = [], deletions = [], images = [], keepImages = DEFAULT_KEEP_IMAGES, strict = false }) {
  const shas = [...new Set(upserts.map((entry) => entry.sha256))];
  const existing = new Set();
  for (const chunk of chunks(shas)) {
    const rows = await tx.select({ sha256: fieldBlobs.sha256 }).from(fieldBlobs).where(inArray(fieldBlobs.sha256, chunk));
    for (const row of rows) existing.add(row.sha256);
  }
  let batch = [];
  let batchBytes = 0;
  const sendBatch = async () => {
    if (!batch.length) return;
    await tx.insert(fieldBlobs).values(batch).onConflictDoNothing();
    batch = [];
    batchBytes = 0;
  };
  let blobsWritten = 0;
  let blobBytesWritten = 0;
  for (const entry of upserts) {
    if (existing.has(entry.sha256)) continue;
    const bytes = entry.bytes ?? entry.load();
    if (entry.bytes === undefined) {
      const sha256 = sha256Hex(bytes);
      if (sha256 !== entry.sha256) {
        if (strict) throw new Error(`${entry.path} changed while it was being stored; run again`);
        Object.assign(entry, { sha256, size: bytes.length });
        if (existing.has(sha256)) continue;
      }
    }
    existing.add(entry.sha256);
    if (batch.length >= BLOB_BATCH_ROWS || batchBytes + bytes.length > BLOB_BATCH_BYTES) await sendBatch();
    batch.push({ sha256: entry.sha256, bytes });
    batchBytes += bytes.length;
    blobsWritten += 1;
    blobBytesWritten += bytes.length;
  }
  await sendBatch();

  for (const chunk of chunks(upserts)) {
    await tx
      .insert(fieldFiles)
      .values(chunk.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
        mode: entry.mode,
        mtime: new Date(entry.mtimeMs),
      })))
      .onConflictDoUpdate({
        target: fieldFiles.path,
        set: {
          sha256: sql`excluded.sha256`,
          size: sql`excluded.size`,
          mode: sql`excluded.mode`,
          mtime: sql`excluded.mtime`,
        },
      });
  }
  for (const chunk of chunks([...new Set(deletions)])) {
    await tx.delete(fieldFiles).where(inArray(fieldFiles.path, chunk));
  }
  const imageVersions = {};
  for (const image of images) {
    const [row] = await queryRows(
      sql`select coalesce(max(version), 0)::int as latest from field_sqlite_images where name = ${image.name}`,
      tx,
    );
    const version = Number(row.latest) + 1;
    await tx.insert(fieldSqliteImages).values({ name: image.name, version, sha256: image.sha256, bytes: image.bytes });
    await tx
      .delete(fieldSqliteImages)
      .where(and(eq(fieldSqliteImages.name, image.name), lte(fieldSqliteImages.version, version - keepImages)));
    imageVersions[image.name] = version;
  }
  return { blobsWritten, blobBytesWritten, imageVersions };
}

// Delete blobs no file refers to (after files were removed or replaced).
export async function collectGarbageBlobs(db) {
  const rows = await queryRows(
    sql`delete from field_blobs b where not exists (select 1 from field_files f where f.sha256 = b.sha256) returning 1 as gone`,
    db,
  );
  return rows.length;
}

export async function loadStoredFiles(db) {
  const rows = await db
    .select({ path: fieldFiles.path, sha256: fieldFiles.sha256, size: fieldFiles.size, mode: fieldFiles.mode, mtime: fieldFiles.mtime })
    .from(fieldFiles);
  return rows.map((row) => ({
    path: row.path,
    sha256: row.sha256,
    size: Number(row.size),
    mode: Number(row.mode),
    mtimeMs: row.mtime.getTime(),
  }));
}

// The newest image of every stored SQLite database: [{ name, version, sha256 }].
export async function loadLatestImages(db) {
  const rows = await queryRows(
    sql`select distinct on (name) name, version, sha256 from field_sqlite_images order by name, version desc`,
    db,
  );
  return rows.map((row) => ({ name: row.name, version: Number(row.version), sha256: row.sha256 }));
}

function quarantineStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// utimes() takes seconds as a float; aim at the middle of the millisecond so
// the restored mtime reads back as exactly `mtimeMs` after flooring.
function setMtime(abs, mtimeMs) {
  const seconds = (mtimeMs + 0.5) / 1000;
  utimesSync(abs, seconds, seconds);
}

function writeRestoredFile(abs, bytes, mode, mtimeMs) {
  mkdirSync(dirname(abs), { recursive: true });
  const temporary = `${abs}${RESTORE_SUFFIX}`;
  writeFileSync(temporary, bytes);
  chmodSync(temporary, mode);
  renameSync(temporary, abs);
  setMtime(abs, mtimeMs);
}

function sameLocalFile(abs, stored) {
  const stat = lstatOrNull(abs);
  if (!stat || !stat.isFile() || stat.size !== stored.size) return false;
  if (sha256Hex(readFileSync(abs)) !== stored.sha256) return false;
  const entry = statEntry(stat);
  if (entry.mode !== stored.mode) chmodSync(abs, stored.mode);
  if (entry.mtimeMs !== stored.mtimeMs) setMtime(abs, stored.mtimeMs);
  return true;
}

// The content of a local SQLite database (its WAL included) as one image, or
// null if it cannot be opened.
function localSqliteImage(abs) {
  let handle = null;
  try {
    handle = new Database(abs, { readonly: true, fileMustExist: true });
    return handle.serialize();
  } catch {
    return null;
  } finally {
    handle?.close();
  }
}

// Make `dataDir` match what PostgreSQL holds: write every stored file (with
// its mode and mtime), replace each stored SQLite database with its newest
// image, and move local files PostgreSQL does not know into
// .quarantine-<time>/. Local files and SQLite databases whose content differs
// from what is stored (changes that never reached PostgreSQL, e.g. after a
// crash or a 503) are copied there too before being overwritten, so nothing
// is thrown away silently. Excluded paths are left alone. Returns statistics
// and the stored file list.
export async function restoreDataDir({ db, dataDir, logger = console }) {
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true });
  const stored = await loadStoredFiles(db);
  const images = await loadLatestImages(db);
  if (stored.length === 0 && images.length === 0) {
    // Nothing stored yet: leave the directory alone (the caller seeds from it).
    return { stored, images, stats: { empty: true, files: 0, bytes: 0, written: 0, bytesWritten: 0, unchanged: 0, quarantined: 0, keptLocal: 0, quarantineDir: null, images: 0 } };
  }
  const storedPaths = new Set(stored.map((entry) => entry.path));
  const skipped = [];
  const local = listMirroredFiles(root, { skipped });

  // Unknown local files (and anything sitting where a stored file must go).
  const stamp = quarantineStamp();
  const quarantineRoot = `.quarantine-${stamp}`;
  let quarantined = 0;
  const quarantine = (rel) => {
    const target = absOf(root, `${quarantineRoot}/${rel}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(absOf(root, rel), target);
    quarantined += 1;
  };
  for (const rel of local) {
    if (!storedPaths.has(rel)) quarantine(rel);
  }
  for (const rel of skipped) {
    if (storedPaths.has(rel)) quarantine(rel);
  }
  // A stored path whose parent exists locally as a file, or which is itself a
  // local directory, cannot be written until that is moved aside.
  for (const entry of stored) {
    const segments = entry.path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join("/");
      const stat = lstatOrNull(absOf(root, parent));
      if (stat && !stat.isDirectory()) quarantine(parent);
    }
    const stat = lstatOrNull(absOf(root, entry.path));
    if (stat && stat.isDirectory()) quarantine(entry.path);
  }

  const toWrite = stored.filter((entry) => !sameLocalFile(absOf(root, entry.path), entry));
  // Local copies that differ from PostgreSQL: keep them aside, then overwrite.
  let keptLocal = 0;
  const keepAside = (rel, bytes = null) => {
    const target = absOf(root, `${quarantineRoot}/${rel}`);
    mkdirSync(dirname(target), { recursive: true });
    if (bytes) writeFileSync(target, bytes, { mode: 0o600 });
    else copyFileSync(absOf(root, rel), target);
    keptLocal += 1;
  };
  for (const entry of toWrite) {
    if (lstatOrNull(absOf(root, entry.path))?.isFile()) keepAside(entry.path);
  }
  for (const image of images) {
    const abs = absOf(root, image.name);
    if (!lstatOrNull(abs)?.isFile()) continue;
    const local = localSqliteImage(abs);
    if (local && sha256Hex(local) === image.sha256) continue;
    if (local) keepAside(image.name, local);
    else {
      keepAside(image.name);
      for (const suffix of ["-wal", "-journal"]) {
        if (lstatOrNull(`${abs}${suffix}`)?.isFile()) keepAside(`${image.name}${suffix}`);
      }
    }
  }
  let written = 0;
  let bytesWritten = 0;
  let batch = [];
  let batchBytes = 0;
  const flushBatch = async () => {
    if (!batch.length) return;
    const shas = [...new Set(batch.map((entry) => entry.sha256))];
    const rows = await db.select({ sha256: fieldBlobs.sha256, bytes: fieldBlobs.bytes }).from(fieldBlobs).where(inArray(fieldBlobs.sha256, shas));
    const bytesBySha = new Map(rows.map((row) => [row.sha256, row.bytes]));
    for (const entry of batch) {
      const bytes = bytesBySha.get(entry.sha256);
      if (!bytes) throw new Error(`stored file ${entry.path} refers to missing content ${entry.sha256}`);
      if (sha256Hex(bytes) !== entry.sha256) throw new Error(`stored content for ${entry.path} does not match its SHA-256`);
      writeRestoredFile(absOf(root, entry.path), bytes, entry.mode, entry.mtimeMs);
      written += 1;
      bytesWritten += bytes.length;
    }
    batch = [];
    batchBytes = 0;
  };
  for (const entry of toWrite) {
    if (batch.length && (batchBytes + entry.size > BLOB_BATCH_BYTES || batch.length >= 200)) await flushBatch();
    batch.push(entry);
    batchBytes += entry.size;
  }
  await flushBatch();

  for (const image of images) {
    const [row] = await db
      .select({ bytes: fieldSqliteImages.bytes })
      .from(fieldSqliteImages)
      .where(and(eq(fieldSqliteImages.name, image.name), eq(fieldSqliteImages.version, image.version)));
    if (sha256Hex(row.bytes) !== image.sha256) throw new Error(`stored image of ${image.name} does not match its SHA-256`);
    const abs = absOf(root, image.name);
    for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${abs}${suffix}`, { force: true });
    mkdirSync(dirname(abs), { recursive: true });
    const temporary = `${abs}${RESTORE_SUFFIX}`;
    writeFileSync(temporary, row.bytes, { mode: 0o600 });
    renameSync(temporary, abs);
  }
  if (quarantined) {
    logger.warn?.(`[storage] moved ${quarantined} local file(s) PostgreSQL does not hold to ${quarantineRoot}/`);
  }
  if (keptLocal) {
    logger.warn?.(`[storage] ${keptLocal} local file(s) differed from PostgreSQL (changes never stored); copies kept in ${quarantineRoot}/ before restoring`);
  }
  return {
    stored,
    images,
    stats: {
      empty: false,
      files: stored.length,
      bytes: stored.reduce((sum, entry) => sum + entry.size, 0),
      written,
      bytesWritten,
      unchanged: stored.length - written,
      quarantined,
      keptLocal,
      quarantineDir: quarantined || keptLocal ? quarantineRoot : null,
      images: images.length,
    },
  };
}

// ---------------------------------------------------------------------------
// The running store

export class StorageUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "StorageUnavailableError";
    this.code = "FIELD_STORAGE_UNAVAILABLE";
    this.statusCode = 503;
  }
}

export class StorageLockLostError extends StorageUnavailableError {
  constructor() {
    super("this process no longer holds the storage lock (its PostgreSQL session ended); another process may be writing");
    this.name = "StorageLockLostError";
    this.code = "FIELD_STORAGE_LOCK_LOST";
  }
}

const NON_CHANGING_KINDS = new Set(["mkdir", "mkdtemp"]);
const HOLD_EXEMPT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class DurableStore {
  // db: a Drizzle instance whose queries all run on ONE session (the lock is
  // per session). close: optional async function to end that session.
  constructor({
    dataDir,
    db,
    close = null,
    logger = console,
    keepImages = DEFAULT_KEEP_IMAGES,
    reconcileIntervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    lockKey = STORAGE_LOCK_KEY,
    onLockLost = null,
    onLockWait = null,
    target = "postgres",
    keepReadBytes = KEEP_READ_BYTES,
  }) {
    this.dataDir = resolve(dataDir);
    this.db = db;
    this.closeSession = close;
    this.logger = logger;
    this.keepImages = keepImages;
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockKey = lockKey;
    this.onLockLost = onLockLost;
    this.onLockWait = onLockWait;
    this.target = target;
    this.keepReadBytes = keepReadBytes;
    this.index = new Map();
    this.globalDirty = new Set();
    this.openContexts = new Set();
    this.images = new Map();
    this.storedImageShas = new Map();
    this.als = new AsyncLocalStorage();
    this.queue = Promise.resolve();
    this.lockHeld = false;
    this.lockLost = false;
    this.closing = false;
    this.active = false;
    this.timer = null;
    this.lastFlushAt = null;
    this.lastReconcileAt = null;
    this.lastError = null;
    this.bootStats = null;
  }

  // Take the lock, rebuild the data directory, start recording. Returns the
  // rebuild statistics.
  async start() {
    await this.acquireLock();
    try {
      this.bootStats = await this.rebuild();
      this.activate();
    } catch (error) {
      await this.releaseLock().catch(() => {});
      throw error;
    }
    return this.bootStats;
  }

  async acquireLock() {
    const deadline = performance.now() + this.lockTimeoutMs;
    let waiting = false;
    for (;;) {
      if (await tryStorageLock(this.db, this.lockKey)) {
        this.lockHeld = true;
        return;
      }
      if (!waiting) {
        // Once, when another process holds the lock.
        waiting = true;
        this.onLockWait?.();
      }
      if (performance.now() >= deadline) {
        throw new StorageUnavailableError(
          `another Field process holds the storage lock (advisory lock ${this.lockKey}) on this database; only one may write it. Stop the other process, or wait for it to exit (waited ${this.lockTimeoutMs} ms, FIELD_STORAGE_LOCK_TIMEOUT_MS)`,
        );
      }
      await new Promise((wake) => setTimeout(wake, 250));
    }
  }

  async releaseLock() {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    if (!this.lockLost) await releaseStorageLock(this.db, this.lockKey);
  }

  // Called when the session holding the lock went away.
  markLockLost(error = new StorageLockLostError()) {
    if (this.lockLost || this.closing || !this.lockHeld) return;
    this.lockLost = true;
    this.lastError = describeStorageError(error);
    this.logger.error?.(`[storage] ${this.lastError}`);
    this.onLockLost?.(error);
  }

  async rebuild() {
    const { stored, images, stats } = await restoreDataDir({ db: this.db, dataDir: this.dataDir, logger: this.logger });
    this.index = new Map(stored.map((entry) => [entry.path, { sha256: entry.sha256, size: entry.size, mode: entry.mode, mtimeMs: entry.mtimeMs }]));
    for (const image of images) this.storedImageShas.set(image.name, image.sha256);
    if (stored.length === 0 && images.length === 0) {
      // Empty database: what is on disk now becomes the first stored state.
      const seeded = await this.enqueue(() => this.flushPaths(new Set([""]), null, "seed"));
      return { ...stats, seeded: true, files: seeded.upserts, bytes: seeded.bytes };
    }
    return { ...stats, seeded: false };
  }

  activate() {
    const root = getDataRoot();
    if (root !== this.dataDir) {
      throw new Error(`durable storage: the storage shim's data root (${root}) is not ${this.dataDir}; call setDataRoot first`);
    }
    setWriteRecorder((absPath, kind) => this.record(absPath, kind));
    this.active = true;
    if (this.reconcileIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.reconcile().catch((error) => this.logger.error?.(`[storage] reconcile failed: ${describeStorageError(error)}`));
      }, this.reconcileIntervalMs);
      this.timer.unref?.();
    }
  }

  registerSqliteImage(name, getHandle) {
    this.images.set(name, { getHandle, lastHandle: null, lastKey: null });
  }

  // --- recording -----------------------------------------------------------

  record(absPath, kind) {
    if (NON_CHANGING_KINDS.has(kind)) return;
    const rel = toRel(this.dataDir, absPath);
    if (rel === null || isExcludedPath(rel)) return;
    const context = this.als.getStore();
    (context && !context.closed ? context.paths : this.globalDirty).add(rel);
  }

  createContext(label) {
    const context = { label, paths: new Set(), closed: false };
    this.openContexts.add(context);
    return context;
  }

  closeContext(context) {
    context.closed = true;
    this.openContexts.delete(context);
  }

  runInContext(context, fn) {
    return this.als.run(context, fn);
  }

  pendingCount() {
    let count = this.globalDirty.size;
    for (const context of this.openContexts) count += context.paths.size;
    return count;
  }

  // --- flushing ------------------------------------------------------------

  enqueue(work) {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  // Flush the current request's writes, or (outside a request) the global set.
  flushCurrent({ reason = "flush" } = {}) {
    const context = this.als.getStore();
    if (context && !context.closed) return this.flushContext(context, reason);
    return this.flushGlobal(reason);
  }

  flushContext(context, reason = "request") {
    return this.enqueue(() => {
      const paths = context.paths;
      context.paths = new Set();
      return this.flushPaths(paths, context, reason);
    });
  }

  flushGlobal(reason = "global") {
    return this.enqueue(() => {
      const paths = this.globalDirty;
      this.globalDirty = new Set();
      return this.flushPaths(paths, null, reason);
    });
  }

  // Everything pending anywhere (shutdown).
  flushAll(reason = "shutdown") {
    return this.enqueue(() => {
      const paths = this.globalDirty;
      this.globalDirty = new Set();
      for (const context of this.openContexts) {
        for (const path of context.paths) paths.add(path);
        context.paths = new Set();
      }
      return this.flushPaths(paths, null, reason);
    });
  }

  // Put paths back after a failed flush so the next one retries them.
  requeue(paths, context) {
    const target = context && !context.closed ? context.paths : this.globalDirty;
    for (const path of paths) target.add(path);
  }

  // Read `paths` from disk and work out what to store. Directories (a renamed,
  // copied or removed tree, or "" for the whole data directory) are compared
  // against the index: unchanged files are not re-read.
  collectChanges(paths, { skip = () => false } = {}) {
    const upserts = new Map();
    const deletions = new Set();
    let keptBytes = 0;
    const consider = (rel, { explicit }) => {
      if (skip(rel)) return;
      const abs = absOf(this.dataDir, rel);
      const stat = lstatOrNull(abs);
      if (rel === "" && !stat?.isDirectory()) {
        throw new Error(`the data directory ${this.dataDir} is missing`);
      }
      if (!stat || (!stat.isFile() && !stat.isDirectory())) {
        if (rel !== "" && this.index.has(rel)) deletions.add(rel);
        const prefix = rel === "" ? "" : `${rel}/`;
        for (const known of this.index.keys()) {
          if (known.startsWith(prefix) && !skip(known)) deletions.add(known);
        }
        return;
      }
      if (stat.isFile()) {
        const entry = statEntry(stat);
        const known = this.index.get(rel);
        if (!explicit && known && known.size === entry.size && known.mode === entry.mode && known.mtimeMs === entry.mtimeMs) return;
        let bytes;
        try {
          bytes = readFileSync(abs);
        } catch (error) {
          if (error.code === "ENOENT") {
            if (this.index.has(rel)) deletions.add(rel);
            return;
          }
          throw error;
        }
        const sha256 = sha256Hex(bytes);
        const size = bytes.length;
        if (known && known.sha256 === sha256 && known.size === size && known.mode === entry.mode && known.mtimeMs === entry.mtimeMs) return;
        const change = { path: rel, sha256, size, mode: entry.mode, mtimeMs: entry.mtimeMs };
        if (keptBytes + size <= this.keepReadBytes) {
          change.bytes = bytes;
          keptBytes += size;
        } else {
          change.load = () => readFileSync(abs);
        }
        upserts.set(rel, change);
        deletions.delete(rel);
        return;
      }
      // A directory: every mirrorable file below it, and index entries gone from it.
      const present = new Set(listMirroredFiles(this.dataDir, { relDir: rel }));
      for (const child of present) consider(child, { explicit: false });
      const prefix = rel === "" ? "" : `${rel}/`;
      for (const known of this.index.keys()) {
        if (known.startsWith(prefix) && !present.has(known) && !skip(known)) deletions.add(known);
      }
      if (rel !== "" && this.index.has(rel)) deletions.add(rel);
    };
    for (const rel of [...paths].sort()) consider(rel, { explicit: true });
    for (const rel of upserts.keys()) deletions.delete(rel);
    return { upserts: [...upserts.values()], deletions: [...deletions] };
  }

  // SQLite databases whose content moved since they were last stored.
  collectImages({ force = false } = {}) {
    const images = [];
    const keys = [];
    for (const [name, image] of this.images) {
      let handle;
      try {
        handle = image.getHandle();
      } catch {
        handle = null;
      }
      if (!handle || !handle.open) continue;
      const key = `${handle.pragma("data_version", { simple: true })}:${handle.prepare("select total_changes() as n").get().n}`;
      if (!force && handle === image.lastHandle && key === image.lastKey) continue;
      const bytes = handle.serialize();
      const sha256 = sha256Hex(bytes);
      keys.push({ image, handle, key });
      if (this.storedImageShas.get(name) === sha256) continue;
      images.push({ name, sha256, bytes });
    }
    return { images, keys };
  }

  async flushPaths(paths, context, reason, { skip } = {}) {
    if (this.lockLost) {
      this.requeue(paths, context);
      throw new StorageLockLostError();
    }
    let changes;
    let imageState;
    try {
      changes = this.collectChanges(paths, { skip });
      imageState = this.collectImages();
    } catch (error) {
      this.requeue(paths, context);
      this.lastError = `could not read changed files for storage: ${describeStorageError(error)}`;
      throw new StorageUnavailableError(this.lastError, { cause: error });
    }
    const { upserts, deletions } = changes;
    const { images, keys } = imageState;
    const summary = { reason, upserts: upserts.length, deletions: deletions.length, images: images.length, bytes: upserts.reduce((sum, entry) => sum + entry.size, 0) };
    if (!upserts.length && !deletions.length && !images.length) {
      for (const { image, handle, key } of keys) Object.assign(image, { lastHandle: handle, lastKey: key });
      return summary;
    }
    try {
      await this.db.transaction(async (tx) => {
        if (!(await holdsStorageLock(tx, this.lockKey))) throw new StorageLockLostError();
        await writeChanges(tx, { upserts, deletions, images, keepImages: this.keepImages });
      });
    } catch (error) {
      this.requeue(paths, context);
      if (error instanceof StorageLockLostError) {
        this.markLockLost(error);
        throw error;
      }
      // A dropped connection is replaced transparently by a new session,
      // which does not hold the lock: check, so a lost lock is never missed.
      if (!(await holdsStorageLock(this.db, this.lockKey).catch(() => true))) {
        const lost = new StorageLockLostError();
        this.markLockLost(lost);
        throw lost;
      }
      this.lastError = `could not store changes in PostgreSQL: ${describeStorageError(error)}`;
      throw new StorageUnavailableError(this.lastError, { cause: error });
    }
    for (const entry of upserts) {
      this.index.set(entry.path, { sha256: entry.sha256, size: entry.size, mode: entry.mode, mtimeMs: entry.mtimeMs });
    }
    for (const path of deletions) this.index.delete(path);
    for (const image of images) this.storedImageShas.set(image.name, image.sha256);
    for (const { image, handle, key } of keys) Object.assign(image, { lastHandle: handle, lastKey: key });
    this.lastFlushAt = new Date().toISOString();
    this.lastError = null;
    return summary;
  }

  // Compare the whole data directory with what is stored and fix any drift
  // (writes the shim cannot see, retries). Paths an in-flight request has
  // written are left to that request's own flush. Then drop unreferenced blobs.
  reconcile() {
    return this.enqueue(async () => {
      const busy = [];
      for (const context of this.openContexts) for (const path of context.paths) busy.push(path);
      const skip = (rel) => busy.some((path) => path === "" || rel === path || rel.startsWith(`${path}/`));
      const paths = this.globalDirty;
      this.globalDirty = new Set();
      paths.add("");
      const summary = await this.flushPaths(paths, null, "reconcile", { skip });
      let removed;
      try {
        removed = await this.db.transaction(async (tx) => {
          if (!(await holdsStorageLock(tx, this.lockKey))) throw new StorageLockLostError();
          return collectGarbageBlobs(tx);
        });
      } catch (error) {
        if (error instanceof StorageLockLostError) {
          this.markLockLost(error);
          throw error;
        }
        throw new StorageUnavailableError(`could not remove unused content from PostgreSQL: ${describeStorageError(error)}`, { cause: error });
      }
      this.lastReconcileAt = new Date().toISOString();
      return { ...summary, blobsRemoved: removed };
    });
  }

  // Public summary for the unauthenticated GET /health: state only, no
  // counts, timestamps or error text.
  publicStatus() {
    const lockHeld = this.lockHeld && !this.lockLost;
    return {
      enabled: true,
      state: !lockHeld ? "lock-lost" : this.lastError ? "degraded" : "ok",
      lockHeld,
      pending: this.pendingCount(),
    };
  }

  // Full status for admins (GET /api/storage/status). lastError is always a
  // describeStorageError() message, never raw driver text.
  status() {
    return {
      enabled: true,
      target: this.target,
      lockHeld: this.lockHeld && !this.lockLost,
      files: this.index.size,
      pending: this.pendingCount(),
      lastFlushAt: this.lastFlushAt,
      lastReconcileAt: this.lastReconcileAt,
      lastError: this.lastError,
    };
  }

  // Express middleware: run each request in its own write context; hold the
  // end of every non-GET response until its writes are stored.
  middleware() {
    return (req, res, next) => {
      const context = this.createContext(`${req.method} ${req.originalUrl || req.url}`);
      if (HOLD_EXEMPT_METHODS.has(req.method)) {
        const done = () => {
          if (context.closed) return;
          this.closeContext(context);
          if (context.paths.size) {
            this.flushContext(context, "request").catch((error) => this.logger.error?.(`[storage] ${context.label}: ${describeStorageError(error)}`));
          }
        };
        res.once("finish", done);
        res.once("close", done);
        return this.runInContext(context, next);
      }
      const end = res.end;
      let held = false;
      res.end = (...args) => {
        if (held) return res;
        held = true;
        this.closeContext(context);
        this.flushContext(context, "request").then(
          () => end.apply(res, args),
          (error) => {
            const reason = describeStorageError(error);
            this.logger.error?.(`[storage] ${context.label}: ${reason}`);
            if (res.headersSent) return end.apply(res, args);
            const body = JSON.stringify({
              error: `Field could not store this change durably (${reason}). It is kept on this server and will be retried, but could be lost if the server restarts before then.`,
              code: error.code || "FIELD_STORAGE_UNAVAILABLE",
            });
            res.statusCode = 503;
            for (const name of ["Content-Length", "ETag", "Content-Type", "Content-Disposition", "Content-Encoding"]) res.removeHeader(name);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Content-Length", Buffer.byteLength(body));
            return end.call(res, body);
          },
        );
        return res;
      };
      res.once("close", () => {
        // Aborted before end(): its writes stay pending for the next flush.
        if (!held) {
          this.closeContext(context);
          this.requeue(context.paths, null);
          context.paths = new Set();
        }
      });
      return this.runInContext(context, next);
    };
  }

  // Flush everything, stop recording, release the lock and end the session.
  async close({ flush = true } = {}) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let flushError = null;
    if (flush && this.active && !this.lockLost) {
      try {
        await this.flushAll("shutdown");
      } catch (error) {
        flushError = error;
      }
    }
    await this.queue;
    this.closing = true;
    if (this.active) {
      setWriteRecorder(null);
      this.active = false;
    }
    installDurableStore(null);
    try {
      await this.releaseLock();
    } catch {
      // The session may already be gone; the server drops the lock with it.
    }
    if (this.closeSession) await this.closeSession();
    if (flushError) throw flushError;
  }
}

// A message about a storage failure that is safe to log, return in a response
// or show on /health. It never contains file contents, query parameters or a
// connection string: Drizzle's query errors ("Failed query: ... params: ...")
// carry every bound parameter, i.e. the bytes of the files being stored, so
// only the innermost cause (the PostgreSQL or driver error) is described, with
// its code, URLs redacted, long quoted values elided and a length cap.
const SAFE_ERROR_MAX_LENGTH = 300;
export function describeStorageError(error) {
  // Our own errors are built from safe parts only.
  if (error instanceof StorageUnavailableError) return error.message;
  let inner = error;
  while (inner?.cause instanceof Error) inner = inner.cause;
  let message = inner instanceof Error ? String(inner.message || inner.name || "error") : String(inner ?? "error");
  if (/^Failed query:/i.test(message) || /\bparams:/i.test(message)) message = "database query failed";
  message = message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]")
    .replace(/"[^"]{40,}"/g, '"[…]"')
    .replace(/'[^']{40,}'/g, "'[…]'")
    .replace(/\s+/g, " ")
    .trim();
  if (message.length > SAFE_ERROR_MAX_LENGTH) message = `${message.slice(0, SAFE_ERROR_MAX_LENGTH)}…`;
  const code = typeof inner?.code === "string" && /^[A-Z0-9_]{1,64}$/i.test(inner.code) ? inner.code : null;
  return code && !message.includes(code) ? `${message} [${code}]` : message;
}
const describeError = describeStorageError;

// ---------------------------------------------------------------------------
// Boot

// FIELD_STORAGE: unset (or "local") keeps Field's files on local disk only;
// "postgres" makes PostgreSQL the durable copy. Anything else is refused.
export function resolveStorageMode(env = process.env) {
  const value = String(env.FIELD_STORAGE ?? "").trim().toLowerCase();
  if (value === "" || value === "local") return { enabled: false };
  if (value === "postgres") return { enabled: true };
  throw new Error(`FIELD_STORAGE must be "postgres" or unset, not "${value}"`);
}

function envMs(env, name, fallback) {
  const value = Number.parseInt(env[name] || "", 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// FIELD_STORAGE_LOCK_TIMEOUT_MS, else 10 minutes on a published Replit app
// (the hand-over at a republish), else 60 s.
export function resolveLockTimeoutMs(env = process.env) {
  return envMs(env, "FIELD_STORAGE_LOCK_TIMEOUT_MS", replitPlacement(env) === "published" ? PUBLISHED_LOCK_TIMEOUT_MS : DEFAULT_LOCK_TIMEOUT_MS);
}

// A dedicated one-connection session for the lock and every storage write:
// never idle-closed or recycled, since closing it drops the lock. Uses the
// direct endpoint when the URL is a pooler (session advisory locks need one).
export function openStorageSession(config, { onClose } = {}) {
  const client = postgres(config.migrationUrl, {
    max: 1,
    idle_timeout: null,
    max_lifetime: null,
    connect_timeout: 15,
    onnotice: () => {},
    onclose: () => onClose?.(),
    connection: { application_name: "field-storage", TimeZone: "UTC" },
  });
  return { client, db: drizzlePostgres(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

// Called by server/index.js after migrations and before anything reads the
// data directory. Returns null when FIELD_STORAGE is unset. With
// FIELD_STORAGE=postgres it requires a PostgreSQL URL (PGlite or no database
// is refused: the data directory would not survive a publish), takes the
// lock, rebuilds `dataDir`, starts recording and installs the store for
// ./durable-hooks.js. Throws (boot must exit) on any failure.
export async function startDurableStorage({ dataDir, env = process.env, logger = console, onLockLost = null, onLockWait = null } = {}) {
  if (!resolveStorageMode(env).enabled) return null;
  const config = resolveDbConfig({ env, dataDir });
  if (config.driver !== "postgres") {
    throw new Error(
      "FIELD_STORAGE=postgres needs a PostgreSQL database: set DATABASE_URL or FIELD_DB_URL. PGlite and running without a database are refused, because the data directory would not survive a publish",
    );
  }
  let store = null;
  const session = openStorageSession(config, { onClose: () => store?.markLockLost() });
  store = new DurableStore({
    dataDir,
    db: session.db,
    close: session.close,
    logger,
    onLockLost,
    onLockWait,
    target: config.target,
    lockTimeoutMs: resolveLockTimeoutMs(env),
    reconcileIntervalMs: envMs(env, "FIELD_STORAGE_RECONCILE_MS", DEFAULT_RECONCILE_INTERVAL_MS),
  });
  try {
    await store.start();
  } catch (error) {
    await session.close().catch(() => {});
    throw new Error(`${config.target}: ${describeError(error)}`, { cause: error });
  }
  installDurableStore(store);
  return store;
}
