#!/usr/bin/env node
// Dry run of the data migrations Field applies at boot (server/data-migrations/):
// what each would change, and whether it verifies. Nothing real is
// ever written.
//
//   npm run data:migrate -- --dry-run [--data <dir>] [--only <id>] [--json <file>]
//
// The deployment's database (DATABASE_URL / FIELD_DB_URL; organisation
// FIELD_ORG, else the default one) is read through a session that cannot write
// (default_transaction_read_only). Its catalogue is copied into a throwaway
// in-memory PostgreSQL at the same schema version and migrated to this
// release (rehearsing the schema migrations on real data too). Job files come
// from what durable storage holds in that database (field_files), restored
// into a temporary directory, or from a copy of --data <dir>. Every pending
// data migration is then planned, verified and applied to those copies, and
// the copies are deleted. The row backfills (per-job migrations) are skipped:
// the copy holds no quote, invoice or document rows to check them against.
//
// It reads the database DATABASE_URL names. In a Replit workspace that is the
// workspace's own database, not production's (docs/REPLIT.md "Data
// migrations"); there, use GET /api/admin/data-migrations/dry-run in the
// published app instead.
//
// Exit 0: every migration verifies and rehearses cleanly (or has already
// run); 1: a verification failed; 2: the dry run could not run.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadFieldConfig } from "../server/runtime-config.js";
import { setDataRoot } from "../server/storage/write-recorder.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
if (!args.includes("--dry-run")) {
  console.error("usage: data-migrations-cli.js --dry-run [--data <dir>] [--only <id>] [--json <file>]\n(Field applies data migrations itself at boot; this only rehearses them on copies)");
  process.exit(2);
}
const dataArg = flag("--data");
const only = flag("--only") ? flag("--only").split(",") : null;
const jsonPath = flag("--json");

const workDir = mkdtempSync(join(tmpdir(), "field-data-migrations-"));
const dataDir = join(workDir, "data");
const repoRoot = join(import.meta.dirname, "..");
const { config } = loadFieldConfig({ defaultPath: join(repoRoot, "config.json") });
setDataRoot(dataDir);
const { resolveDbConfig } = await import("../server/db-runtime/index.js");
const { resolveDeploymentOrg } = await import("../server/db-runtime/tenancy.js");
const { createCatalogStore } = await import("../server/catalog/store.js");
const { runDataMigrations } = await import("../server/data-migrations/index.js");
const { copyCatalogueForRehearsal, openReadOnlySource } = await import("../server/data-migrations/rehearsal.js");

let exitCode = 0;
let source = null;
let rehearsal = null;
try {
  const dbConfig = resolveDbConfig({ dataDir: config.dataDir });
  source = openReadOnlySource(dbConfig);
  const org = await resolveDeploymentOrg(source.db);
  rehearsal = await copyCatalogueForRehearsal(source.db, org.uid);
  console.error(`[dry-run] catalogue of ${org.slug} copied read-only (schema ${rehearsal.sourceLevel} -> ${rehearsal.latestLevel} rehearsed): ${JSON.stringify(rehearsal.copied)}`);
  if (dataArg) {
    cpSync(resolve(dataArg), dataDir, { recursive: true });
    console.error(`[dry-run] job files: a copy of ${resolve(dataArg)}`);
  } else {
    const { restoreDataDir } = await import("../server/storage/durable-store.js");
    const restored = await restoreDataDir({ db: source.db, dataDir, logger: { warn: () => {} } });
    console.error(`[dry-run] job files: ${restored.stats.files} file(s) restored read-only from durable storage`);
  }
  const store = createCatalogStore({ db: rehearsal.db, orgUid: org.uid, dataDir });
  const report = await runDataMigrations({
    db: rehearsal.db,
    orgUid: org.uid,
    dataDir,
    getState: () => store.getState({ fresh: true }),
    catalogStore: store,
    mode: "rehearse",
    only,
    logger: { log: () => {}, warn: (line) => console.error(line) },
  });
  for (const entry of report) {
    console.log(`\n${entry.id}: ${entry.title}`);
    console.log(`  status: ${entry.status}${entry.appliedAt ? ` (${entry.appliedAt})` : ""}`);
    if (entry.reason) console.log(`  ${entry.reason}`);
    if (entry.summary) console.log(`  summary: ${JSON.stringify(entry.summary)}`);
    for (const change of (entry.changes || []).slice(0, 400)) console.log(`  ${JSON.stringify(change)}`);
    if ((entry.changes || []).length > 400) console.log(`  ... ${entry.changes.length - 400} more (see --json)`);
  }
  if (jsonPath) {
    writeFileSync(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.error(`[dry-run] full report written to ${resolve(jsonPath)}`);
  }
  const skipped = report.filter((entry) => entry.status === "skipped").map((entry) => entry.id);
  console.error(`\n[dry-run] every migration verified and rehearsed on copies; nothing real was written${skipped.length ? ` (not rehearsed here: ${skipped.join(", ")})` : ""}`);
} catch (error) {
  console.error(`[dry-run] ${error.code === "DATA_MIGRATION_FAILED" ? "VERIFICATION FAILED" : "could not run"}: ${error.message}`);
  if (error.details?.failures) for (const failure of error.details.failures) console.error(`  - ${failure}`);
  exitCode = error.code === "DATA_MIGRATION_FAILED" ? 1 : 2;
} finally {
  await rehearsal?.close().catch(() => {});
  await source?.close().catch(() => {});
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
