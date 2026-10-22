// Durable storage in PostgreSQL. Most tests run on an in-process
// PGlite (createTestDb); the ones that need two sessions or a real process
// kill run against a real PostgreSQL when FIELD_DB_TEST_DATABASE_URL (CI) or
// FIELD_DB_TEST_DOCKER=1 is set, and are skipped otherwise.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { sql } from "drizzle-orm";

import { FIELD_SEARCH_PATH, createTestDb, queryRows, resolveDbConfig } from "../db-runtime/index.js";
import { startTestPostgres } from "../db-runtime/test-postgres.js";
import * as fs from "./fs.js";
import * as fsp from "./fs-promises.js";
import { setDataRoot, setWriteRecorder, isRecordingWrites } from "./write-recorder.js";
import {
  flushDurableStorage,
  flushDurableStorageQuietly,
  getActiveDurableStore,
  installDurableStore,
} from "./durable-hooks.js";
import {
  BLOB_BATCH_ROWS,
  DurableStore,
  PUBLISHED_LOCK_TIMEOUT_MS,
  resolveLockTimeoutMs,
  StorageLockLostError,
  StorageUnavailableError,
  describeStorageError,
  isExcludedPath,
  openStorageSession,
  releaseStorageLock,
  resolveStorageMode,
  restoreDataDir,
  scanTree,
  startDurableStorage,
  treeHash,
  writeChanges,
} from "./durable-store.js";

const quiet = { warn() {}, error() {}, info() {}, log() {} };
const dirs = [];
function tempDir(prefix = "field-durable-") {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) nodeFs.rmSync(dir, { recursive: true, force: true });
});

function write(root, rel, content, mode) {
  const path = join(root, ...rel.split("/"));
  nodeFs.mkdirSync(join(path, ".."), { recursive: true });
  nodeFs.writeFileSync(path, content);
  if (mode !== undefined) nodeFs.chmodSync(path, mode);
  return path;
}

// A store on its own fresh PGlite, started (lock + rebuild + recording).
async function openStore(t, { dataDir = tempDir(), testDb = null, start = true, ...options } = {}) {
  const db = testDb ?? (await createTestDb());
  setDataRoot(dataDir);
  const store = new DurableStore({ dataDir, db: db.db, logger: quiet, reconcileIntervalMs: 0, ...options });
  if (start) await store.start();
  t.after(async () => {
    await store.close({ flush: false }).catch(() => {});
    setWriteRecorder(null);
    setDataRoot(null);
    if (!testDb) await db.close();
  });
  return { store, db, dataDir };
}

async function storedPaths(db) {
  const rows = await queryRows(sql`select path from field_files order by path`, db);
  return rows.map((row) => row.path);
}

async function rebuildHash(db) {
  const dir = tempDir("field-durable-rebuild-");
  await restoreDataDir({ db, dataDir: dir, logger: quiet });
  return treeHash(scanTree(dir));
}

test("exclusions: what is never mirrored", () => {
  for (const rel of [
    ".openclaw/agent.json",
    "2026-01-15/job/.sessions/x.json",
    ".sessions/a",
    "users.json.123.tmp",
    ".scheduled-emails/abc.json.lock",
    "2026-01-15/job/.field-generation-lock/owner.json",
    "2026-01-15/.field-generation-stage-job-abc/quote.json",
    ".quarantine-2026-01-15T00-00-00-000Z/users.json",
    "price-catalog/.runtime-lease/owner.json",
    "price-catalog/.maintenance-lease/owner.json",
    "price-catalog/.lease-acquisition-lock/owner.json",
    "price-catalog/_uploads/3f2a",
    "price-catalog/_uploads",
    "pglite/base/1/123",
    "pglite.lock",
    "field.db",
    "field.db-wal",
    "field.db-shm",
    "price-catalog/catalog.db",
    "price-catalog/catalog.db-journal",
    ".catalog-backups/price-catalog-2026.db",
  ]) assert.equal(isExcludedPath(rel), true, rel);
  for (const rel of [
    "users.json",
    "mcp/as-state.json",
    "gmail-oauth-users.json",
    "2026-01-15/job/meta.json",
    "2026-01-15/job/.field-generations/g-000001/quote.pdf",
    "2026-01-15/job/.field-generation-pointer.json",
    "price-catalog/attachments/ITEM/evidence.pdf",
    "price-catalog/uploads-not-raw.json",
    "jobs/pglite/notes.json",
    ".scheduled-emails/abc.json",
    "dbnotes.txt",
  ]) assert.equal(isExcludedPath(rel), false, rel);
});

test("FIELD_STORAGE: unset is a no-op, postgres needs a PostgreSQL URL, anything else is refused", async () => {
  assert.deepEqual(resolveStorageMode({}), { enabled: false });
  assert.deepEqual(resolveStorageMode({ FIELD_STORAGE: "" }), { enabled: false });
  assert.deepEqual(resolveStorageMode({ FIELD_STORAGE: "local" }), { enabled: false });
  assert.deepEqual(resolveStorageMode({ FIELD_STORAGE: " Postgres " }), { enabled: true });
  assert.throws(() => resolveStorageMode({ FIELD_STORAGE: "s3" }), /FIELD_STORAGE must be "postgres" or unset/);

  const dataDir = tempDir();
  assert.equal(await startDurableStorage({ dataDir, env: {} }), null);
  assert.equal(getActiveDurableStore(), null);
  assert.equal(isRecordingWrites(), false);
  // The hooks are no-ops without a store.
  assert.equal(await flushDurableStorage({ reason: "test" }), null);
  assert.equal(await flushDurableStorageQuietly({ reason: "test" }), null);

  for (const env of [
    { FIELD_STORAGE: "postgres" },
    { FIELD_STORAGE: "postgres", FIELD_PGLITE: "1", FIELD_DATA: dataDir },
    { FIELD_STORAGE: "postgres", FIELD_PGLITE_DIR: "memory://" },
  ]) {
    await assert.rejects(startDurableStorage({ dataDir, env }), /FIELD_STORAGE=postgres needs a PostgreSQL database: set DATABASE_URL or FIELD_DB_URL/);
  }
});

test("an empty database is seeded from disk, and a rebuild into an empty directory is byte-identical", async (t) => {
  const dataDir = tempDir();
  write(dataDir, "users.json", '{"users":[]}', 0o600);
  write(dataDir, "2026-01-15/job-a/meta.json", '{"id":"a"}');
  write(dataDir, "2026-01-15/job-a/photo.jpg", Buffer.from([0, 1, 2, 255, 254]));
  write(dataDir, "2026-01-15/job-b/photo.jpg", Buffer.from([0, 1, 2, 255, 254])); // same content
  write(dataDir, "2026-01-15/job-a/.field-generations/g-000001/quote.pdf", "%PDF-1.7 fake", 0o640);
  write(dataDir, "empty.txt", "");
  write(dataDir, ".sessions/s.json", "{}");
  write(dataDir, "users.json.1.tmp", "{}");
  const original = treeHash(scanTree(dataDir));
  const { store, db } = await openStore(t, { dataDir });
  assert.equal(store.bootStats.seeded, true);
  assert.equal(store.bootStats.files, 6);
  const [blobs] = await queryRows(sql`select count(*)::int as n from field_blobs`, db.db);
  assert.equal(Number(blobs.n), 5, "identical contents are stored once");
  assert.equal(await rebuildHash(db.db), original);
});

test("files beyond the read budget are re-read when stored, and still rebuild byte-identically", async (t) => {
  const dataDir = tempDir();
  for (let index = 0; index < 5; index += 1) write(dataDir, `big/${index}.bin`, Buffer.alloc(1000 + index, index));
  const original = treeHash(scanTree(dataDir));
  const { store, db } = await openStore(t, { dataDir, keepReadBytes: 1500 });
  assert.equal(store.bootStats.files, 5);
  assert.equal(await rebuildHash(db.db), original);
});

test("a request's writes are stored when it flushes; renames, copies and recursive removes are followed", async (t) => {
  const { store, db, dataDir } = await openStore(t);
  const context = store.createContext("POST /x");
  await store.runInContext(context, async () => {
    await fsp.mkdir(join(dataDir, "2026-01-15", "job-a"), { recursive: true });
    await fsp.writeFile(join(dataDir, "2026-01-15", "job-a", "meta.json"), "{}");
    fs.writeFileSync(join(dataDir, "2026-01-15", "job-a", "notes.json"), "[]");
    fs.mkdirSync(join(dataDir, "stage", "deep"), { recursive: true });
    fs.writeFileSync(join(dataDir, "stage", "deep", "a.txt"), "A");
    fs.renameSync(join(dataDir, "stage"), join(dataDir, "published"));
    await fsp.cp(join(dataDir, "published"), join(dataDir, "copy"), { recursive: true });
  });
  assert.deepEqual(await storedPaths(db.db), [], "nothing is stored before the flush");
  await store.flushContext(context);
  assert.deepEqual(await storedPaths(db.db), [
    "2026-01-15/job-a/meta.json",
    "2026-01-15/job-a/notes.json",
    "copy/deep/a.txt",
    "published/deep/a.txt",
  ]);
  const second = store.createContext("POST /y");
  await store.runInContext(second, async () => {
    await fsp.rm(join(dataDir, "published"), { recursive: true });
    fs.unlinkSync(join(dataDir, "2026-01-15", "job-a", "notes.json"));
  });
  await store.flushContext(second);
  assert.deepEqual(await storedPaths(db.db), ["2026-01-15/job-a/meta.json", "copy/deep/a.txt"]);
  assert.equal(await rebuildHash(db.db), treeHash(scanTree(dataDir)));
});

test("excluded paths are never mirrored, even when written in a request or found by the reconciler", async (t) => {
  const { store, db, dataDir } = await openStore(t);
  const context = store.createContext("POST /x");
  await store.runInContext(context, async () => {
    for (const rel of [
      ".openclaw/a.json", ".sessions/b.json", "x.tmp", "x.lock", "price-catalog/_uploads/u1",
      "2026-01-15/job/.field-generation-lock/owner.json", "2026-01-15/.field-generation-stage-job-1/q.json",
      "price-catalog/.runtime-lease/owner.json", "pglite/PG_VERSION", "field.db", "field.db-wal",
    ]) {
      fs.mkdirSync(join(dataDir, ...rel.split("/").slice(0, -1)), { recursive: true });
      fs.writeFileSync(join(dataDir, ...rel.split("/")), "x");
    }
    fs.writeFileSync(join(dataDir, "kept.json"), "{}");
  });
  await store.flushContext(context);
  await store.reconcile();
  assert.deepEqual(await storedPaths(db.db), ["kept.json"]);
});

test("killing a request before its flush rolls the stored state back to the last flush", async (t) => {
  const testDb = await createTestDb();
  t.after(() => testDb.close());
  const first = await openStore(t, { testDb });
  const { store, dataDir } = first;
  const a = store.createContext("POST /first");
  await store.runInContext(a, async () => {
    fs.mkdirSync(join(dataDir, "job"), { recursive: true });
    fs.writeFileSync(join(dataDir, "job", "meta.json"), '{"status":"draft"}');
    fs.writeFileSync(join(dataDir, "job", "quote.json"), '{"total":1}');
  });
  store.closeContext(a);
  await store.flushContext(a);
  const lastFlush = treeHash(scanTree(dataDir));
  const b = store.createContext("POST /second");
  await store.runInContext(b, async () => {
    fs.writeFileSync(join(dataDir, "job", "meta.json"), '{"status":"sent"}');
    fs.rmSync(join(dataDir, "job", "quote.json"));
    fs.writeFileSync(join(dataDir, "job", "invoice.json"), "{}");
  });
  // The process "dies": nothing more is flushed, and its session ends.
  await store.close({ flush: false });
  const second = await openStore(t, { testDb });
  assert.equal(second.store.bootStats.seeded, false);
  assert.equal(treeHash(scanTree(second.dataDir)), lastFlush);
  assert.equal(nodeFs.readFileSync(join(second.dataDir, "job", "meta.json"), "utf8"), '{"status":"draft"}');
});

test("boot rebuild restores mode and mtime, moves unknown local files aside and leaves excluded paths alone", async (t) => {
  const testDb = await createTestDb();
  t.after(() => testDb.close());
  const source = tempDir();
  write(source, "a/b.json", "{}", 0o600);
  const mtime = new Date("2025-03-04T05:06:07.890Z");
  nodeFs.utimesSync(join(source, "a", "b.json"), mtime, mtime);
  const seeded = await openStore(t, { testDb, dataDir: source });
  await seeded.store.close({ flush: false });

  const target = tempDir();
  write(target, "a/b.json", "stale local copy");
  write(target, "stray/unknown.txt", "not in PostgreSQL");
  write(target, ".sessions/keep.json", "excluded");
  write(target, "pglite/PG_VERSION", "17");
  const { store } = await openStore(t, { testDb, dataDir: target });
  assert.equal(store.bootStats.quarantined, 1);
  // A local copy that differs from PostgreSQL (a change never stored) is kept.
  assert.equal(store.bootStats.keptLocal, 1);
  assert.equal(nodeFs.readFileSync(join(target, store.bootStats.quarantineDir, "a", "b.json"), "utf8"), "stale local copy");
  const stat = nodeFs.statSync(join(target, "a", "b.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(Math.floor(stat.mtimeMs), mtime.getTime());
  assert.equal(nodeFs.readFileSync(join(target, "a", "b.json"), "utf8"), "{}");
  assert.equal(nodeFs.existsSync(join(target, "stray", "unknown.txt")), false);
  assert.equal(nodeFs.readFileSync(join(target, store.bootStats.quarantineDir, "stray", "unknown.txt"), "utf8"), "not in PostgreSQL");
  assert.equal(nodeFs.readFileSync(join(target, ".sessions", "keep.json"), "utf8"), "excluded");
  assert.equal(nodeFs.readFileSync(join(target, "pglite", "PG_VERSION"), "utf8"), "17");
});

test("SQLite databases are stored as images when they change, restored at boot, and only the last N are kept", async (t) => {
  const testDb = await createTestDb();
  t.after(() => testDb.close());
  const { store, dataDir } = await openStore(t, { testDb, keepImages: 3 });
  const sqlite = new Database(join(dataDir, "field.db"));
  t.after(() => sqlite.close());
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec("create table notes (text text)");
  store.registerSqliteImage("field.db", () => sqlite);
  await store.flushGlobal();
  const versions = async () => (await queryRows(sql`select version from field_sqlite_images where name = 'field.db' order by version`, testDb.db)).map((row) => Number(row.version));
  assert.deepEqual(await versions(), [1]);
  await store.flushGlobal();
  assert.deepEqual(await versions(), [1], "an unchanged database is not stored again");
  for (let index = 0; index < 4; index += 1) {
    sqlite.prepare("insert into notes values (?)").run(`note ${index}`);
    await store.flushGlobal();
  }
  assert.deepEqual(await versions(), [3, 4, 5]);
  await store.close({ flush: false });

  const restored = await openStore(t, { testDb });
  const copy = new Database(join(restored.dataDir, "field.db"), { readonly: true });
  try {
    assert.deepEqual(copy.prepare("select text from notes").all().map((row) => row.text), ["note 0", "note 1", "note 2", "note 3"]);
    assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    copy.close();
  }
  await restored.store.close({ flush: false });

  // Restarting on the same directory: an unchanged database is not set aside...
  const same = await openStore(t, { testDb, dataDir });
  assert.equal(same.store.bootStats.keptLocal, 0);
  assert.equal(same.store.bootStats.quarantineDir, null);
  await same.store.close({ flush: false });
  // ...but rows that never reached PostgreSQL are kept in the quarantine dir.
  const local = new Database(join(dataDir, "field.db"));
  local.prepare("insert into notes values (?)").run("never stored");
  local.close();
  const changed = await openStore(t, { testDb, dataDir });
  assert.equal(changed.store.bootStats.keptLocal, 1);
  const kept = new Database(join(dataDir, changed.store.bootStats.quarantineDir, "field.db"), { readonly: true });
  try {
    assert.ok(kept.prepare("select text from notes").all().some((row) => row.text === "never stored"));
  } finally {
    kept.close();
  }
  const current = new Database(join(dataDir, "field.db"), { readonly: true });
  try {
    assert.equal(current.prepare("select count(*) as n from notes where text = 'never stored'").get().n, 0);
  } finally {
    current.close();
  }
});

test("the reconciler stores writes the shim cannot see, removes deleted files and drops unreferenced blobs", async (t) => {
  const { store, db, dataDir } = await openStore(t);
  nodeFs.writeFileSync(join(dataDir, "direct.json"), "written without the shim");
  const context = store.createContext("POST /x");
  await store.runInContext(context, async () => fs.writeFileSync(join(dataDir, "gone.json"), "soon deleted"));
  await store.flushContext(context);
  nodeFs.unlinkSync(join(dataDir, "gone.json"));
  // An in-flight request's paths are left to that request.
  const busy = store.createContext("POST /busy");
  await store.runInContext(busy, async () => fs.writeFileSync(join(dataDir, "busy.json"), "half done"));
  const result = await store.reconcile();
  assert.equal(result.blobsRemoved, 1);
  assert.deepEqual(await storedPaths(db.db), ["direct.json"]);
});

test("a flush on a session that lost the lock is refused and reported", async (t) => {
  let lost = null;
  const { store, db, dataDir } = await openStore(t, { onLockLost: (error) => { lost = error; } });
  await releaseStorageLock(db.db);
  const context = store.createContext("POST /x");
  await store.runInContext(context, async () => fs.writeFileSync(join(dataDir, "a.json"), "{}"));
  await assert.rejects(store.flushContext(context), StorageLockLostError);
  assert.ok(lost instanceof StorageLockLostError);
  assert.deepEqual(await storedPaths(db.db), []);
  assert.equal(store.status().lockHeld, false);
});

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("middleware: a non-GET response is held until its writes are stored; a storage failure answers 503", async (t) => {
  const { store, db, dataDir } = await openStore(t);
  installDurableStore(store);
  t.after(() => installDurableStore(null));
  const app = express();
  app.use(store.middleware());
  app.post("/save/:name", async (req, res) => {
    await fsp.writeFile(join(dataDir, `${req.params.name}.json`), "{}");
    res.json({ ok: true });
  });
  app.post("/commit-point", async (_req, res) => {
    await fsp.writeFile(join(dataDir, "early.json"), "{}");
    await flushDurableStorage({ reason: "test commit point" });
    const stored = await storedPaths(db.db);
    await fsp.writeFile(join(dataDir, "late.json"), "{}");
    res.json({ stored });
  });
  app.get("/read", async (_req, res) => {
    await fsp.writeFile(join(dataDir, "repaired-on-read.json"), "{}");
    res.json({ ok: true });
  });
  const server = await listen(app);
  t.after(() => server.close());

  const saved = await fetch(`${server.url}/save/one`, { method: "POST" });
  assert.equal(saved.status, 200);
  assert.deepEqual(await storedPaths(db.db), ["one.json"], "stored before the response arrived");

  const commit = await (await fetch(`${server.url}/commit-point`, { method: "POST" })).json();
  assert.deepEqual(commit.stored, ["early.json", "one.json"]);
  assert.deepEqual(await storedPaths(db.db), ["early.json", "late.json", "one.json"]);

  assert.equal((await fetch(`${server.url}/read`)).status, 200);
  await store.queue;
  assert.ok((await storedPaths(db.db)).includes("repaired-on-read.json"));

  // PostgreSQL refuses the write: the client is told, and the change stays pending.
  const transaction = store.db.transaction.bind(store.db);
  store.db.transaction = async () => { throw new Error("connection refused"); };
  t.after(() => { store.db.transaction = transaction; });
  const failed = await fetch(`${server.url}/save/two`, { method: "POST" });
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.equal(body.code, "FIELD_STORAGE_UNAVAILABLE");
  assert.match(body.error, /could not store this change durably/);
  assert.equal(store.pendingCount(), 1);
  store.db.transaction = transaction;
  await store.flushGlobal();
  assert.ok((await storedPaths(db.db)).includes("two.json"));
});

test("describeStorageError: never returns query parameters, file contents or connection strings", () => {
  const marker = "refresh_token_MARKER_7f3a9c";
  const driver = Object.assign(new Error("new row violates check constraint \"field_blobs_check\""), { code: "23514" });
  const drizzleError = new Error(`Failed query: insert into "field_blobs" ("sha256", "bytes") values ($1, $2)\nparams: abc,{"refresh_token":"${marker}"}`, { cause: driver });
  assert.equal(describeStorageError(drizzleError), 'new row violates check constraint "field_blobs_check" [23514]');
  const noCause = new Error(`Failed query: insert ...\nparams: ${marker}`);
  assert.equal(describeStorageError(noCause), "database query failed");
  // The fake credential is assembled at runtime so secret scanners do not flag the fixture.
  const url = new Error(["connect ECONNREFUSED for postgres", "://field:", "hunter2", "@db.example.test:5432/field"].join(""));
  assert.doesNotMatch(describeStorageError(url), /hunter2/);
  const quoted = new Error(`invalid input syntax for type json: "${marker}${"x".repeat(60)}"`);
  assert.doesNotMatch(describeStorageError(quoted), new RegExp(marker));
  assert.ok(describeStorageError(new Error("y".repeat(2000))).length <= 301);
  const own = new StorageUnavailableError("could not store changes in PostgreSQL: disk full", { cause: drizzleError });
  assert.equal(describeStorageError(own), "could not store changes in PostgreSQL: disk full");
});

test("a failing blob insert never puts file contents into status(), /health or the 503 body", async (t) => {
  const { store, db, dataDir } = await openStore(t);
  installDurableStore(store);
  t.after(() => installDurableStore(null));
  await queryRows(sql`create function field_test_refuse_blob() returns trigger language plpgsql as $$
    begin raise exception 'blob refused for test'; end $$`, db.db);
  await queryRows(sql`create trigger field_test_refuse_blob before insert on field_blobs for each row execute function field_test_refuse_blob()`, db.db);

  const marker = "1//refresh_token_MARKER_4b1e2d";
  const app = express();
  app.use(store.middleware());
  app.get("/health", (_req, res) => res.json({ ok: true, storage: store.publicStatus() }));
  app.post("/oauth", async (_req, res) => {
    await fsp.writeFile(join(dataDir, "gmail-oauth.json"), JSON.stringify({ refresh_token: marker }));
    res.json({ ok: true });
  });
  const server = await listen(app);
  t.after(() => server.close());

  const failed = await fetch(`${server.url}/oauth`, { method: "POST" });
  assert.equal(failed.status, 503);
  const body = await failed.text();
  assert.doesNotMatch(body, /MARKER/);

  // The raw driver error does carry the bytes: that is what must not escape.
  const raw = await store.db.transaction((tx) => writeChanges(tx, {
    upserts: [{ path: "x.json", sha256: "0".repeat(64), size: marker.length, mode: 0o600, mtimeMs: Date.now(), bytes: Buffer.from(marker) }],
  })).catch((error) => error);
  assert.match(String(raw.message), /MARKER/, "the unsanitised error would have leaked the file");

  const status = store.status();
  assert.match(status.lastError, /blob refused for test/);
  assert.doesNotMatch(JSON.stringify(status), /MARKER/);
  const health = await (await fetch(`${server.url}/health`)).json();
  assert.doesNotMatch(JSON.stringify(health), /MARKER/);
  assert.deepEqual(Object.keys(health.storage).sort(), ["enabled", "lockHeld", "pending", "state"]);
  assert.equal(health.storage.state, "degraded");
});

test("blob inserts are batched by row count too, so many tiny files stay under the parameter limit", async (t) => {
  const testDb = await createTestDb();
  t.after(() => testDb.close());
  const count = 33_000; // 66,000 parameters in one INSERT would be refused
  assert.ok(count > BLOB_BATCH_ROWS);
  const upserts = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = Buffer.from(String(index));
    upserts.push({ path: `tiny/${index}`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mode: 0o644, mtimeMs: 1_700_000_000_000, bytes });
  }
  const result = await testDb.db.transaction((tx) => writeChanges(tx, { upserts }));
  assert.equal(result.blobsWritten, count);
  const [row] = await queryRows(sql`select count(*)::int as n from field_blobs`, testDb.db);
  assert.equal(Number(row.n), count);
});

test("lock timeout: 60 s, 10 minutes on a published Replit app, else the setting", () => {
  assert.equal(resolveLockTimeoutMs({}), 60_000);
  assert.equal(resolveLockTimeoutMs({ REPL_ID: "x" }), 60_000);
  assert.equal(resolveLockTimeoutMs({ REPLIT_DEPLOYMENT: "1" }), PUBLISHED_LOCK_TIMEOUT_MS);
  assert.equal(resolveLockTimeoutMs({ REPLIT_DEPLOYMENT: "1", FIELD_STORAGE_LOCK_TIMEOUT_MS: "5000" }), 5000);
});

// --- Real PostgreSQL ---------------------------------------------------------

const pg = await startTestPostgres();
after(() => pg?.stop());
const needsPostgres = pg ? {} : { skip: "set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1" };

async function migrated(url) {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const { migratePostgresDatabase } = await import("../db-runtime/index.js");
  const client = postgres(url, { max: 1, onnotice: () => {}, connection: { search_path: FIELD_SEARCH_PATH } });
  try {
    await migratePostgresDatabase(drizzle(client));
  } finally {
    await client.end();
  }
}

// Wired like startDurableStorage: the session closing marks the lock lost.
function pgStore(url, dataDir, options = {}) {
  let store = null;
  const session = openStorageSession(resolveDbConfig({ env: { FIELD_DB_URL: url } }), { onClose: () => store?.markLockLost() });
  store = new DurableStore({ dataDir, db: session.db, close: session.close, logger: quiet, reconcileIntervalMs: 0, ...options });
  return store;
}

test("PostgreSQL: the advisory lock admits one writer at a time", needsPostgres, async () => {
  await migrated(pg.url);
  const first = pgStore(pg.url, tempDir());
  setDataRoot(first.dataDir);
  await first.start();
  let waits = 0;
  const second = pgStore(pg.url, tempDir(), { lockTimeoutMs: 600, onLockWait: () => { waits += 1; } });
  try {
    await assert.rejects(second.acquireLock(), /another Field process holds the storage lock/);
    assert.equal(waits, 1, "onLockWait is called once, when the lock is busy");
    await first.close();
    setDataRoot(second.dataDir);
    await second.start();
    assert.equal(second.status().lockHeld, true);
  } finally {
    await first.close({ flush: false }).catch(() => {});
    await second.close({ flush: false }).catch(() => {});
    setDataRoot(null);
  }
});

test("PostgreSQL: SIGKILL mid-request; the next boot rebuilds the last flushed state on an empty disk", needsPostgres, async () => {
  await migrated(pg.url);
  // Earlier tests on this database leave files; start from nothing.
  const cleaner = openStorageSession(resolveDbConfig({ env: { FIELD_DB_URL: pg.url } }));
  await queryRows(sql`delete from field_files`, cleaner.db);
  await queryRows(sql`delete from field_sqlite_images`, cleaner.db);
  await cleaner.close();

  const dataDir = tempDir();
  const child = spawn(process.execPath, [join(import.meta.dirname, "durable-store.kill-fixture.mjs"), dataDir, pg.url], { stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.split("\n")[0]);
    });
    child.once("exit", (code) => reject(new Error(`fixture exited early (${code})`)));
  });
  const hashes = JSON.parse(line);
  assert.notEqual(hashes.stored, hashes.dirty);
  const exited = new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  child.kill("SIGKILL");
  assert.equal(await exited, "SIGKILL");

  const fresh = tempDir();
  const store = pgStore(pg.url, fresh, { lockTimeoutMs: 10_000 });
  setDataRoot(fresh);
  try {
    await store.start(); // the dead process's lock went with its session
    assert.equal(treeHash(scanTree(fresh)), hashes.stored);
    assert.equal(nodeFs.readFileSync(join(fresh, "2026-01-15", "job-a", "meta.json"), "utf8"), '{"status":"draft"}');
    assert.equal(nodeFs.existsSync(join(fresh, "2026-01-15", "job-a", "invoice.json")), false);
  } finally {
    await store.close({ flush: false });
    setDataRoot(null);
  }
});

test("PostgreSQL: losing the session drops the lock, and the store stops writing", needsPostgres, async () => {
  await migrated(pg.url);
  const dataDir = tempDir();
  let lost = null;
  const store = pgStore(pg.url, dataDir, { onLockLost: (error) => { lost = error; } });
  setDataRoot(dataDir);
  try {
    await store.start();
    const [{ pid }] = await queryRows(sql`select pg_backend_pid() as pid`, store.db);
    const admin = openStorageSession(resolveDbConfig({ env: { FIELD_DB_URL: pg.url } }));
    await queryRows(sql`select pg_terminate_backend(${pid})`, admin.db);
    await admin.close();
    const context = store.createContext("POST /x");
    await store.runInContext(context, async () => fs.writeFileSync(join(dataDir, "after-loss.json"), "{}"));
    await assert.rejects(store.flushContext(context), /lock|terminat|connection/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(lost, "onLockLost was called");
  } finally {
    await store.close({ flush: false }).catch(() => {});
    setDataRoot(null);
  }
});

// --- The server -------------------------------------------------------------

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function bootServer(env) {
  const clean = { ...process.env };
  for (const name of ["FIELD_DB_URL", "DATABASE_URL", "FIELD_PGLITE", "FIELD_PGLITE_DIR", "FIELD_RUNTIME", "REPLIT_DEPLOYMENT", "FIELD_STORAGE", "FIELD_CONFIG", "FIELD_CONFIG_JSON"]) delete clean[name];
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "index.js")], {
    env: { ...clean, FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1", FIELD_TOKEN: "durable-storage-test-token", FIELD_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited, output: () => output };
}

async function waitForLog(server, pattern, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  let done = false;
  server.exited.then(() => (done = true));
  while (!pattern.test(server.output())) {
    assert.ok(!done && performance.now() < deadline, `expected ${pattern}:\n${server.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return server.output().match(pattern);
}

test("server: FIELD_STORAGE=postgres without a PostgreSQL URL refuses to start", async () => {
  for (const [env, pattern] of [
    [{ FIELD_STORAGE: "postgres" }, /\[storage\] durable storage failed to start: FIELD_STORAGE=postgres needs a PostgreSQL database/],
    [{ FIELD_STORAGE: "postgres", FIELD_PGLITE_DIR: "memory://" }, /\[storage\] durable storage failed to start: FIELD_STORAGE=postgres needs a PostgreSQL database/],
    [{ FIELD_STORAGE: "s3" }, /\[storage\] durable storage failed to start: FIELD_STORAGE must be "postgres" or unset/],
  ]) {
    const server = bootServer({ ...env, FIELD_DATA: tempDir() });
    assert.equal(await server.exited, 1, server.output());
    assert.match(server.output(), pattern);
    assert.doesNotMatch(server.output(), /listening on/);
  }
});

test("server (PostgreSQL): stores its data directory and rebuilds it on an empty disk", needsPostgres, async () => {
  const pgDb = await startTestPostgres();
  try {
    const first = tempDir();
    const port = await freePort();
    const boot = (dataDir) => bootServer({ FIELD_STORAGE: "postgres", FIELD_DB_URL: pgDb.url, FIELD_DATA: dataDir, FIELD_PORT: String(port) });
    const one = boot(first);
    await waitForLog(one, /listening on/);
    assert.match(one.output(), /\[storage\] postgres: seeded/);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepEqual(health.storage, { enabled: true, state: "ok", lockHeld: true, pending: 0, documentReplica: { state: "off" } });
    // Counts, timestamps and errors are for admins only.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/storage/status`)).status, 401);
    one.child.kill("SIGTERM");
    assert.equal(await one.exited, 0, one.output());
    const users = nodeFs.readFileSync(join(first, "users.json"));

    const second = tempDir();
    const two = boot(second);
    await waitForLog(two, /\[storage\] postgres: rebuilt .*: \d+ file\(s\), \d+ written, 0 unchanged, 1 SQLite image\(s\)/);
    await waitForLog(two, /listening on/);
    two.child.kill("SIGTERM");
    assert.equal(await two.exited, 0, two.output());
    assert.deepEqual(nodeFs.readFileSync(join(second, "users.json")), users);
    const restored = new Database(join(second, "field.db"), { readonly: true });
    try {
      assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
      assert.ok(restored.prepare("select count(*) as n from sqlite_master where name = 'jobs'").get().n === 1);
    } finally {
      restored.close();
    }
  } finally {
    await pgDb.stop();
  }
});
