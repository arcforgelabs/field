#!/usr/bin/env node
// Import a Field data directory (e.g. an untarred copy of production's
// /opt/apps/field/data) into PostgreSQL durable storage, then prove the
// import: file count, total bytes, every file's SHA-256 recomputed by
// PostgreSQL from the stored bytes, and a rebuild into a temporary directory
// whose tree hash must equal the source's.
//
//   node scripts/migrate-data-to-postgres.js --source <dir> --dry-run
//   node scripts/migrate-data-to-postgres.js --source <dir> --apply [--replace]
//
// Options:
//   --dry-run            scan and report only; connects to nothing
//   --apply              import into FIELD_DB_URL / DATABASE_URL, then verify
//   --replace            allow --apply when storage already holds files (they
//                        are replaced by the source; otherwise it refuses)
//   --catalog-importer <module>   the legacy catalogue importer to run (see below)
//   --skip-catalog       do not run any catalogue importer
//
// What is imported, in ONE transaction: every file durable storage mirrors
// (the same exclusions as the server: .openclaw/, .sessions/, *.tmp, *.lock,
// generation locks/stages, leases, price-catalog/_uploads/, pglite/, SQLite
// files), and SQLite images of field.db and price-catalog/catalog.db (read
// from a private copy, so the source is never opened for writing). Other *.db
// files (e.g. catalogue backups) are listed, not imported.
//
// Catalogue importer hook: when the native PostgreSQL catalogue exists, its
// module exports
//   importLegacyCatalog({ db, catalogDbPath, dryRun, logger }) -> summary
// where `db` is the Drizzle transaction of this import (or, for --dry-run,
// null) and `catalogDbPath` a read-only copy of the legacy catalog.db. It is
// looked for at the paths in CATALOG_IMPORTER_CANDIDATES (or --catalog-importer)
// and skipped, with a message, when none exists.
//
// The source directory is only read. Nothing is printed from file contents,
// and the connection string is never printed: errors are reported through
// describeStorageError(), never as raw driver text (a failed query's message
// carries every bound parameter, i.e. the bytes of the files being imported).
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";

const REPO_ROOT = resolve(import.meta.dirname, "..");
export const SQLITE_IMAGE_NAMES = ["field.db", "price-catalog/catalog.db"];
export const CATALOG_IMPORTER_CANDIDATES = [
  "server/catalog/legacy-import.js",
  "server/catalogue/legacy-import.js",
  "server/price-catalog/legacy-import.js",
  "scripts/import-legacy-catalog.js",
];

async function storageModule() {
  return import("../server/storage/durable-store.js");
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Everything under `root` the mirror leaves out, for the report.
function scanExcluded(root, isExcludedPath) {
  const excluded = { files: 0, bytes: 0, sqlite: [], samples: [] };
  const walk = (dirRel, insideExcluded) => {
    for (const entry of readdirSync(dirRel ? join(root, dirRel) : root, { withFileTypes: true })) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const out = insideExcluded || isExcludedPath(rel);
      if (entry.isDirectory()) {
        if (out && !insideExcluded && excluded.samples.length < 25) excluded.samples.push(`${rel}/`);
        walk(rel, out);
      } else if (out) {
        excluded.files += 1;
        excluded.bytes += lstatSync(join(root, rel)).size;
        if (/\.db$/.test(entry.name)) excluded.sqlite.push(rel);
        else if (!insideExcluded && excluded.samples.length < 25) excluded.samples.push(rel);
      }
    }
  };
  walk("", false);
  return excluded;
}

// A consistent image of a SQLite database without touching the source: copy
// it (with its -wal/-shm) somewhere private, open the copy, check it, and
// serialize it.
export function readSqliteImage(sourceDir, name) {
  const path = join(sourceDir, ...name.split("/"));
  if (!existsSync(path)) return null;
  const work = mkdtempSync(join(tmpdir(), "field-sqlite-image-"));
  try {
    const copy = join(work, "image.db");
    copyFileSync(path, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
    }
    const db = new Database(copy);
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(`${name} failed SQLite integrity_check: ${integrity}`);
      const bytes = db.serialize();
      return { name, sha256: sha256Hex(bytes), bytes, size: bytes.length };
    } finally {
      db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// The importer reads a private copy of exactly the bytes that were imaged,
// never the source file.
async function withCatalogCopy(image, work) {
  const dir = mkdtempSync(join(tmpdir(), "field-legacy-catalog-"));
  try {
    const path = join(dir, "catalog.db");
    writeFileSync(path, image.bytes, { mode: 0o600 });
    return await work(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function resolveCatalogImporter({ explicit = null, skip = false, repoRoot = REPO_ROOT } = {}) {
  if (skip) return { found: false, reason: "skipped (--skip-catalog)" };
  const candidates = explicit ? [resolve(explicit)] : CATALOG_IMPORTER_CANDIDATES.map((rel) => join(repoRoot, rel));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const module = await import(pathToFileURL(path).href);
    if (typeof module.importLegacyCatalog !== "function") {
      throw new Error(`${path} does not export importLegacyCatalog`);
    }
    return { found: true, path, importLegacyCatalog: module.importLegacyCatalog };
  }
  if (explicit) throw new Error(`catalogue importer not found: ${explicit}`);
  return {
    found: false,
    reason: `no catalogue importer module (looked for ${CATALOG_IMPORTER_CANDIDATES.join(", ")}); the legacy catalogue is still carried as the SQLite image price-catalog/catalog.db`,
  };
}

// Scan `sourceDir` and describe what an import would store.
export async function planDataImport(sourceDir) {
  const { scanTree, treeHash, isExcludedPath } = await storageModule();
  const root = resolve(sourceDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`--source ${sourceDir} is not a directory`);
  const skipped = [];
  const manifest = scanTree(root, { skipped });
  const images = SQLITE_IMAGE_NAMES.map((name) => readSqliteImage(root, name)).filter(Boolean);
  const excluded = scanExcluded(root, isExcludedPath);
  return {
    root,
    manifest,
    images,
    skipped,
    excluded,
    summary: {
      files: manifest.length,
      bytes: manifest.reduce((sum, entry) => sum + entry.size, 0),
      distinctContents: new Set(manifest.map((entry) => entry.sha256)).size,
      treeHash: treeHash(manifest),
      sqliteImages: images.map(({ name, sha256, size }) => ({ name, sha256, size })),
      notImportedSqlite: excluded.sqlite.filter((path) => !SQLITE_IMAGE_NAMES.includes(path)),
      excludedFiles: excluded.files,
      excludedBytes: excluded.bytes,
      excludedSamples: excluded.samples,
      skippedSpecialFiles: skipped,
    },
  };
}

async function storageCounts(db) {
  const { queryRows } = await import("../server/db-runtime/index.js");
  const [row] = await queryRows(
    sql`select (select count(*) from field_files)::int as files, (select count(*) from field_sqlite_images)::int as images`,
    db,
  );
  return { files: Number(row.files), images: Number(row.images) };
}

// Prove what is stored equals the plan: counts, bytes, every SHA-256
// recomputed by PostgreSQL, and a rebuild into a fresh directory.
export async function verifyDataImport({ db, plan, logger = console }) {
  const { queryRows } = await import("../server/db-runtime/index.js");
  const { restoreDataDir, scanTree, treeHash } = await storageModule();
  const problems = [];
  const [totals] = await queryRows(sql`select count(*)::int as files, coalesce(sum(size), 0)::text as bytes from field_files`, db);
  const expectedBytes = plan.manifest.reduce((sum, entry) => sum + entry.size, 0);
  if (Number(totals.files) !== plan.manifest.length) problems.push(`file count ${totals.files} != source ${plan.manifest.length}`);
  if (Number(totals.bytes) !== expectedBytes) problems.push(`total bytes ${totals.bytes} != source ${expectedBytes}`);

  const expected = new Map(plan.manifest.map((entry) => [entry.path, entry]));
  const rows = await queryRows(
    sql`select f.path, f.sha256, f.size::text as size, encode(sha256(b.bytes), 'hex') as actual, length(b.bytes) as length
        from field_files f join field_blobs b on b.sha256 = f.sha256`,
    db,
  );
  let checked = 0;
  for (const row of rows) {
    const source = expected.get(row.path);
    if (!source) problems.push(`stored file not in source: ${row.path}`);
    else if (row.actual !== source.sha256 || row.sha256 !== source.sha256) problems.push(`SHA-256 mismatch: ${row.path}`);
    else if (Number(row.length) !== source.size || Number(row.size) !== source.size) problems.push(`size mismatch: ${row.path}`);
    else checked += 1;
  }
  if (rows.length !== plan.manifest.length) problems.push(`${plan.manifest.length - rows.length} source file(s) missing from storage`);

  const imageRows = await queryRows(
    sql`select distinct on (name) name, sha256, encode(sha256(bytes), 'hex') as actual from field_sqlite_images order by name, version desc`,
    db,
  );
  for (const image of plan.images) {
    const row = imageRows.find((candidate) => candidate.name === image.name);
    if (!row) problems.push(`SQLite image missing: ${image.name}`);
    else if (row.sha256 !== image.sha256 || row.actual !== image.sha256) problems.push(`SQLite image SHA-256 mismatch: ${image.name}`);
  }

  const rebuildDir = mkdtempSync(join(tmpdir(), "field-storage-verify-"));
  let rebuiltHash = null;
  try {
    try {
      await restoreDataDir({ db, dataDir: rebuildDir, logger: { warn: () => {} } });
    } catch (error) {
      const { describeStorageError } = await storageModule();
      problems.push(`rebuild from PostgreSQL failed: ${describeStorageError(error)}`);
      return finish();
    }
    rebuiltHash = treeHash(scanTree(rebuildDir));
    if (rebuiltHash !== plan.summary.treeHash) problems.push(`rebuilt tree hash ${rebuiltHash} != source ${plan.summary.treeHash}`);
    for (const image of plan.images) {
      const path = join(rebuildDir, ...image.name.split("/"));
      if (!existsSync(path) || sha256Hex(readFileSync(path)) !== image.sha256) {
        problems.push(`rebuilt SQLite file differs: ${image.name}`);
        continue;
      }
      const restored = new Database(path, { readonly: true });
      try {
        const integrity = restored.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") problems.push(`rebuilt ${image.name} failed integrity_check: ${integrity}`);
      } finally {
        restored.close();
      }
    }
  } finally {
    rmSync(rebuildDir, { recursive: true, force: true });
  }
  return finish();

  function finish() {
    const result = {
      ok: problems.length === 0,
      files: Number(totals.files),
      bytes: Number(totals.bytes),
      sha256Checked: checked,
      images: imageRows.length,
      sourceTreeHash: plan.summary.treeHash,
      rebuiltTreeHash: rebuiltHash,
      problems,
    };
    if (!result.ok) logger.error?.(`[migrate] verification failed: ${problems.slice(0, 10).join("; ")}`);
    return result;
  }
}

// Import `plan` into storage on `db` (one session; it takes the storage lock,
// so no Field server may be running against this database), then verify.
export async function applyDataImport({ db, plan, replace = false, catalogImporter = null, logger = console }) {
  const { STORAGE_LOCK_KEY, collectGarbageBlobs, releaseStorageLock, tryStorageLock, writeChanges } = await storageModule();
  if (!(await tryStorageLock(db, STORAGE_LOCK_KEY))) {
    throw new Error("a Field server (or another import) holds the storage lock on this database: stop it before importing");
  }
  try {
    const before = await storageCounts(db);
    if ((before.files || before.images) && !replace) {
      throw new Error(`storage already holds ${before.files} file(s) and ${before.images} SQLite image(s); pass --replace to replace them with the source`);
    }
    let catalog = { ran: false, reason: catalogImporter?.reason ?? "no importer" };
    const written = await db.transaction(async (tx) => {
      if (replace) {
        await tx.execute(sql`delete from field_files`);
        await tx.execute(sql`delete from field_sqlite_images`);
      }
      const upserts = plan.manifest.map((entry) => ({
        ...entry,
        load: () => readFileSync(join(plan.root, ...entry.path.split("/"))),
      }));
      const result = await writeChanges(tx, { upserts, images: plan.images, strict: true });
      if (catalogImporter?.found) {
        const image = plan.images.find((candidate) => candidate.name === "price-catalog/catalog.db");
        if (!image) throw new Error("a catalogue importer exists but the source has no price-catalog/catalog.db");
        const summary = await withCatalogCopy(image, (catalogDbPath) =>
          catalogImporter.importLegacyCatalog({ db: tx, catalogDbPath, dryRun: false, logger }));
        catalog = { ran: true, path: catalogImporter.path, summary };
      }
      return result;
    });
    const blobsRemoved = replace ? await collectGarbageBlobs(db) : 0;
    const verification = await verifyDataImport({ db, plan, logger });
    return { before, written: { ...written, blobsRemoved }, catalog, verification };
  } finally {
    await releaseStorageLock(db, STORAGE_LOCK_KEY).catch(() => {});
  }
}

function parseArgs(argv) {
  const options = { source: null, dryRun: false, apply: false, replace: false, catalogImporter: null, skipCatalog: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--catalog-importer") options.catalogImporter = argv[++index];
    else if (arg === "--skip-catalog") options.skipCatalog = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.source) throw new Error("--source <dir> is required");
  if (options.dryRun === options.apply) throw new Error("pass exactly one of --dry-run or --apply");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = await planDataImport(options.source);
  const importer = await resolveCatalogImporter({ explicit: options.catalogImporter, skip: options.skipCatalog });
  const catalog = importer.found ? { importer: importer.path } : { importer: null, reason: importer.reason };
  if (options.dryRun) {
    if (importer.found) {
      const image = plan.images.find((candidate) => candidate.name === "price-catalog/catalog.db");
      catalog.dryRun = image ? await dryRunCatalog(importer, image) : { skipped: "no price-catalog/catalog.db in the source" };
    }
    console.log(JSON.stringify({ mode: "dry-run", source: plan.root, ...plan.summary, catalog }, null, 2));
    return 0;
  }
  const { resolveDbConfig, runMigrations, closeDb } = await import("../server/db-runtime/index.js");
  const config = resolveDbConfig({ env: process.env });
  if (config.driver !== "postgres") throw new Error("--apply needs FIELD_DB_URL or DATABASE_URL (a PostgreSQL server)");
  const migrations = await runMigrations();
  await closeDb();
  const { openStorageSession } = await storageModule();
  const session = openStorageSession(config);
  try {
    const result = await applyDataImport({ db: session.db, plan, replace: options.replace, catalogImporter: importer });
    console.log(JSON.stringify({ mode: "apply", target: config.target, migrationsApplied: migrations.applied, source: plan.root, ...plan.summary, ...result }, null, 2));
    return result.verification.ok ? 0 : 1;
  } finally {
    await session.close();
  }
}

async function dryRunCatalog(importer, image) {
  return withCatalogCopy(image, (catalogDbPath) =>
    importer.importLegacyCatalog({ db: null, catalogDbPath, dryRun: true, logger: console }));
}

// What main() prints for a fatal error: the innermost cause only, without
// query parameters, file contents or connection strings.
export async function formatFatalError(error) {
  const { describeStorageError } = await storageModule();
  return `[migrate] ${describeStorageError(error)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    async (error) => {
      console.error(await formatFatalError(error));
      process.exit(1);
    },
  );
}
