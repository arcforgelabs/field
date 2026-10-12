#!/usr/bin/env node
// Import a legacy SQLite price catalogue (catalog.db) into Field's PostgreSQL
// catalogue, verified, in one transaction (server/catalog/legacy-import.js).
//
//   npm run catalog:import-legacy -- <catalog.db> [--dry-run] [--replace] [--json]
//
// The database is the server's (FIELD_DB_URL or DATABASE_URL; PGlite only for
// local development). Migrations are applied first. The catalog.db file is
// opened read-only. --dry-run imports, verifies, reports and rolls back.
// --replace deletes the catalogue's current items first (same transaction),
// and with them every PostgreSQL-era price row (item_prices cascades) and the
// whole catalog_history audit trail; only a database point-in-time restore
// brings those back. Without it the catalogue must be empty. Exit 0 imported (or dry run passed),
// 1 refused or failed, 2 verification failed (nothing imported).
import { join, resolve } from "node:path";
import { loadFieldConfig } from "../server/runtime-config.js";
import { setDataRoot } from "../server/storage/write-recorder.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const [legacyPath] = args.filter((arg) => !arg.startsWith("--"));
if (!legacyPath || flags.has("--help")) {
  console.log("usage: npm run catalog:import-legacy -- <catalog.db> [--dry-run] [--replace] [--json]");
  console.log("  --dry-run  import, verify and report, then roll back");
  console.log("  --replace  DESTRUCTIVE: deletes every current item, its price history and the catalogue's");
  console.log("             audit history before importing; only a database point-in-time restore undoes it");
  process.exit(legacyPath ? 0 : 1);
}

const repoRoot = join(import.meta.dirname, "..");
const { config } = loadFieldConfig({ defaultPath: join(repoRoot, "config.json") });
setDataRoot(resolve(process.env.FIELD_DATA || config.dataDir || join(repoRoot, "data")));
const { closeDb, getDb, getDbInfo, runMigrations } = await import("../server/db-runtime/index.js");
const { resolveDeploymentOrg } = await import("../server/db-runtime/tenancy.js");
const { importLegacyCatalog } = await import("../server/catalog/index.js");

let exitCode = 0;
try {
  await runMigrations();
  const org = await resolveDeploymentOrg(getDb());
  const report = await importLegacyCatalog(getDb(), resolve(legacyPath), {
    orgUid: org.uid,
    dryRun: flags.has("--dry-run"),
    replace: flags.has("--replace"),
    author: process.env.FIELD_ACTOR || "migration",
  });
  if (flags.has("--json")) {
    console.log(JSON.stringify({ target: getDbInfo().target, ...report }, null, 2));
  } else {
    console.log(`${report.dryRun ? "DRY RUN (rolled back)" : "Imported"} into ${getDbInfo().target}`);
    console.log(`source: ${report.source.path} (schema v${report.source.schemaVersion})`);
    console.log(`counts: ${JSON.stringify(report.imported)}`);
    for (const check of report.verification.checks) {
      const detail = check.legacy !== undefined ? ` legacy=${check.legacy} imported=${check.imported}` : (check.compared !== undefined ? ` compared=${check.compared}` : "");
      console.log(`  ${check.ok ? "ok  " : "FAIL"} ${check.check}${detail}`);
    }
    for (const spot of report.verification.spotChecks) {
      console.log(`  spot ${spot.code}: legacy ${spot.legacy.buy}/${spot.legacy.sell} -> ${spot.imported.buy}/${spot.imported.sell} (priceId ${spot.imported.priceId})`);
    }
    for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  }
} catch (error) {
  if (error.code === "CATALOG_IMPORT_VERIFICATION_FAILED") {
    console.error(error.message);
    console.error(JSON.stringify(error.report.verification.failures, null, 2));
    exitCode = 2;
  } else {
    console.error(`catalogue import failed: ${error.message}`);
    exitCode = 1;
  }
} finally {
  await closeDb().catch(() => {});
}
process.exit(exitCode);
