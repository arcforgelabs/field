// scripts/migrate-data-to-postgres.js: importing a Field data directory into
// PostgreSQL durable storage, on an in-process PGlite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";

import { FIELD_SEARCH_PATH, createTestDb, queryRows } from "../server/db-runtime/index.js";
import { startTestPostgres } from "../server/db-runtime/test-postgres.js";
import { DurableStore, scanTree, treeHash } from "../server/storage/durable-store.js";
import { setDataRoot, setWriteRecorder } from "../server/storage/write-recorder.js";
import { importLegacyCatalog, openCatalogStore } from "../server/catalog/index.js";
import { writeLegacyCatalog } from "../server/catalog/fixtures/legacy-catalog.js";
import { applyDataImport, formatFatalError, planDataImport, resolveCatalogImporter, verifyDataImport } from "./migrate-data-to-postgres.js";

const quiet = { warn() {}, error() {}, info() {}, log() {} };
const dirs = [];
function tempDir() {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), "field-migrate-data-"));
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

async function storedPaths(db) {
  const rows = await queryRows(sql`select path from field_files order by path`, db);
  return rows.map((row) => row.path);
}

// A server-side store booted on the imported database, into an empty directory.
async function openStore(t, { testDb }) {
  const dataDir = tempDir();
  setDataRoot(dataDir);
  const store = new DurableStore({ dataDir, db: testDb.db, logger: quiet, reconcileIntervalMs: 0 });
  await store.start();
  t.after(() => {
    setWriteRecorder(null);
    setDataRoot(null);
  });
  return { store, dataDir };
}

test("migration script: imports a data directory in one transaction and verifies it, and verification catches tampering", async (t) => {
  const source = tempDir();
  write(source, "users.json", "{}", 0o600);
  write(source, "2026-01-15/job/meta.json", '{"id":"job"}');
  write(source, "2026-01-15/job/photo.jpg", Buffer.alloc(70_000, 7));
  write(source, ".sessions/s.json", "{}");
  write(source, "x.lock", "");
  const field = new Database(join(source, "field.db"));
  field.exec("create table jobs (id text); insert into jobs values ('job')");
  field.close();
  const plan = await planDataImport(source);
  assert.equal(plan.summary.files, 3);
  assert.deepEqual(plan.summary.sqliteImages.map((image) => image.name), ["field.db"]);

  const testDb = await createTestDb();
  t.after(() => testDb.close());
  const result = await applyDataImport({ db: testDb.db, plan, catalogImporter: { found: false, reason: "none" }, logger: quiet });
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.problems));
  assert.equal(result.verification.sha256Checked, 3);
  assert.equal(result.verification.rebuiltTreeHash, plan.summary.treeHash);
  await assert.rejects(applyDataImport({ db: testDb.db, plan, logger: quiet }), /pass --replace/);

  // A server booted on the imported database sees the same tree.
  const booted = await openStore(t, { testDb });
  assert.equal(treeHash(scanTree(booted.dataDir)), plan.summary.treeHash);
  await booted.store.close({ flush: false });

  await queryRows(sql`update field_blobs set bytes = '\\x00'::bytea where sha256 = ${plan.manifest[0].sha256}`, testDb.db);
  const tampered = await verifyDataImport({ db: testDb.db, plan, logger: quiet });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.problems.some((problem) => /SHA-256 mismatch|size mismatch|total bytes/.test(problem)));
});

test("migration script: a catalogue importer, when present, runs inside the import transaction", async (t) => {
  const source = tempDir();
  write(source, "users.json", "{}");
  nodeFs.mkdirSync(join(source, "price-catalog"), { recursive: true });
  const legacy = new Database(join(source, "price-catalog", "catalog.db"));
  legacy.exec("create table items (code text); insert into items values ('ITEM-1')");
  legacy.close();
  const plan = await planDataImport(source);
  const testDb = await createTestDb();
  t.after(() => testDb.close());
  let seen = null;
  const importer = {
    found: true,
    path: "test-importer",
    importLegacyCatalog: async ({ db, catalogDbPath, dryRun }) => {
      const copy = new Database(catalogDbPath, { readonly: true });
      try {
        seen = { codes: copy.prepare("select code from items").all().map((row) => row.code), dryRun, inTransaction: typeof db.rollback === "function" };
      } finally {
        copy.close();
      }
      return { items: seen.codes.length };
    },
  };
  const result = await applyDataImport({ db: testDb.db, plan, catalogImporter: importer, logger: quiet });
  assert.deepEqual(seen, { codes: ["ITEM-1"], dryRun: false, inTransaction: true });
  assert.deepEqual(result.catalog, { ran: true, path: "test-importer", summary: { items: 1 } });
  assert.equal(result.verification.ok, true);

  // An importer that fails rolls the whole import back.
  const other = await createTestDb();
  t.after(() => other.close());
  await assert.rejects(
    applyDataImport({ db: other.db, plan, catalogImporter: { found: true, path: "x", importLegacyCatalog: async () => { throw new Error("bad catalogue"); } }, logger: quiet }),
    /bad catalogue/,
  );
  assert.deepEqual(await storedPaths(other.db), []);
});

test("migration script: the real catalogue importer runs inside the import transaction; its dry run connects to nothing", async (t) => {
  const source = tempDir();
  write(source, "users.json", "{}");
  nodeFs.mkdirSync(join(source, "price-catalog"), { recursive: true });
  const legacyPath = writeLegacyCatalog(join(source, "price-catalog", "catalog.db"));

  const importer = await resolveCatalogImporter();
  assert.equal(importer.found, true);
  assert.match(importer.path, /server\/catalog\/legacy-import\.js$/);

  // Dry run: no database is handed in; rehearsed on a throwaway PGlite.
  const rehearsal = await importer.importLegacyCatalog({ db: null, catalogDbPath: legacyPath, dryRun: true });
  assert.equal(rehearsal.dryRun, true);
  assert.equal(rehearsal.verification.ok, true);
  assert.equal(rehearsal.imported.items, 7);

  const plan = await planDataImport(source);
  const testDb = await createTestDb();
  t.after(() => testDb.close());
  const result = await applyDataImport({ db: testDb.db, plan, catalogImporter: importer, logger: quiet });
  assert.equal(result.catalog.ran, true);
  assert.equal(result.catalog.summary.verification.ok, true);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.problems));
  const store = await openCatalogStore({ db: testDb.db });
  assert.equal((await store.getItem("LABOURER-HOUR")).sell_price, 80.5);

  // A database whose catalogue already holds items: the catalogue import
  // refuses, and the whole data import rolls back with it.
  const other = await createTestDb();
  t.after(() => other.close());
  await importLegacyCatalog(other.db, legacyPath);
  await assert.rejects(applyDataImport({ db: other.db, plan, catalogImporter: importer, logger: quiet }), /already holds 7 item/);
  assert.deepEqual(await storedPaths(other.db), []);
});

const REFUSE_BLOBS = [
  sql`create function field_test_refuse_blob() returns trigger language plpgsql as $$
    begin raise exception 'blob refused for test'; end $$`,
  sql`create trigger field_test_refuse_blob before insert on field_blobs for each row execute function field_test_refuse_blob()`,
];
const MARKER = "refresh_token_MARKER_9d2c71";

function sourceWithSecret() {
  const source = tempDir();
  write(source, "gmail-oauth.json", JSON.stringify({ refresh_token: MARKER }), 0o600);
  write(source, "users.json", "{}");
  return source;
}

test("migration script: a failed import never prints file contents", async (t) => {
  const plan = await planDataImport(sourceWithSecret());
  const testDb = await createTestDb();
  t.after(() => testDb.close());
  for (const statement of REFUSE_BLOBS) await queryRows(statement, testDb.db);
  const error = await applyDataImport({ db: testDb.db, plan, catalogImporter: { found: false, reason: "none" }, logger: quiet }).then(
    () => assert.fail("the import should have failed"),
    (failure) => failure,
  );
  assert.match(String(error.message), new RegExp(MARKER), "the raw error carries the file bytes");
  const printed = await formatFatalError(error);
  assert.doesNotMatch(printed, new RegExp(MARKER));
  assert.match(printed, /^\[migrate\] blob refused for test/);
});

const pg = await startTestPostgres();
after(() => pg?.stop());

test("migration script (PostgreSQL CLI): a forced insert failure prints no planted file contents", pg ? {} : { skip: "set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1" }, async () => {
  const postgres = (await import("postgres")).default;
  const script = fileURLToPath(new URL("./migrate-data-to-postgres.js", import.meta.url));
  const source = sourceWithSecret();
  const env = { ...process.env, FIELD_DB_URL: pg.url, DATABASE_URL: "", FIELD_STORAGE: "" };
  // Create the tables first (the script migrates, then imports), then refuse blob inserts.
  const dry = spawnSync(process.execPath, [script, "--source", source, "--apply", "--skip-catalog"], { env, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  const client = postgres(pg.url, { max: 1, onnotice: () => {}, connection: { search_path: FIELD_SEARCH_PATH } });
  try {
    await client.unsafe("delete from field_files; delete from field_blobs; delete from field_sqlite_images");
    await client.unsafe(`create function field_test_refuse_blob() returns trigger language plpgsql as $$ begin raise exception 'blob refused for test'; end $$`);
    await client.unsafe("create trigger field_test_refuse_blob before insert on field_blobs for each row execute function field_test_refuse_blob()");
  } finally {
    await client.end();
  }
  const run = spawnSync(process.execPath, [script, "--source", source, "--apply", "--skip-catalog"], { env, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr + run.stdout, new RegExp(MARKER));
  assert.match(run.stderr, /\[migrate\] blob refused for test/);
});
