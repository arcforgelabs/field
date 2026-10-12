#!/usr/bin/env node
// Copy every document Field's job files say a customer was issued into the
// issued-document tables (server/documents/backfill.js): the issuance
// ledger, issued invoice revisions (superseded ones too) and quotes sent
// before the ledger, with their original bytes. Idempotent: a second run
// records nothing new. Never writes to the data directory.
//
//   node scripts/backfill-issued-documents.js [--dry-run] [--json] [--data-dir <dir>]
//
// Uses the server's database selection (FIELD_DB_URL or DATABASE_URL; PGlite
// with FIELD_PGLITE=1 or FIELD_PGLITE_DIR) and its data directory (FIELD_DATA,
// then config.json `dataDir`, then ./data). Refuses to run while migrations
// are pending: boot the server once to apply them. The organisation is the
// deployment's (FIELD_ORG, default embark). --dry-run writes nothing and
// reports what a run would record. The connection string is never printed.
//
// Exit codes: 0 done; 1 refused or failed; 2 done, with hash mismatches,
// conflicts or errors to look at.
import { join, resolve } from "node:path";
import { loadFieldConfig } from "../server/runtime-config.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
if (flag("--help") || flag("-h")) {
  console.log("usage: node scripts/backfill-issued-documents.js [--dry-run] [--json] [--data-dir <dir>]");
  process.exit(0);
}
const dryRun = flag("--dry-run");
const asJson = flag("--json");

const repoRoot = join(import.meta.dirname, "..");
const { closeDb, getDb, getDbInfo, getMigrationStatus, resolveDbConfig } = await import("../server/db-runtime/index.js");
const { orgScope, resolveDeploymentOrg } = await import("../server/db-runtime/tenancy.js");
const { createIssuedDocumentService } = await import("../server/documents/issued-documents.js");
const { backfillIssuedDocuments } = await import("../server/documents/backfill.js");

function summarise(report) {
  const lines = [];
  const verb = report.dryRun ? "would record" : "recorded";
  lines.push(`${report.jobs} job(s), ${report.jobsWithDocuments} with issued documents`);
  for (const [key, count] of Object.entries(report.found).sort()) {
    lines.push(`  found ${key}: ${count} (${verb} ${report.recorded[key] || 0})`);
  }
  lines.push(`already recorded: ${report.alreadyRecorded}; emailed events ${report.dryRun ? "(not counted in a dry run)" : `added: ${report.emailedEvents}`}`);
  const list = (label, entries) => {
    lines.push(`${label}: ${entries.length}`);
    for (const entry of entries.slice(0, 50)) lines.push(`  ${JSON.stringify(entry)}`);
    if (entries.length > 50) lines.push(`  … ${entries.length - 50} more (use --json)`);
  };
  list("hash mismatches (skipped, bytes left as they are)", report.mismatches);
  list("missing files", report.missing);
  list("ambiguous (skipped)", report.ambiguous);
  list("conflicts with an already issued document", report.conflicts);
  list("errors", report.errors);
  return lines.join("\n");
}

let exitCode = 0;
try {
  const { config: fieldConfig } = loadFieldConfig({ defaultPath: join(repoRoot, "config.json") });
  const dataDir = resolve(option("--data-dir") || process.env.FIELD_DATA || fieldConfig.dataDir || join(repoRoot, "data"));
  const dbConfig = resolveDbConfig({ dataDir });
  let service = null;
  if (dbConfig.driver === "none") {
    if (!dryRun) throw new Error("no database configured: set FIELD_DB_URL or DATABASE_URL (or run with --dry-run to only read the files)");
  } else {
    const db = getDb({ dataDir });
    const migrations = await getMigrationStatus(db);
    if (migrations.pending > 0) throw new Error(`${migrations.pending} migration(s) pending on ${getDbInfo().target}: boot the server once to apply them`);
    const org = await resolveDeploymentOrg(db);
    service = createIssuedDocumentService({ db: orgScope(db, org.uid) });
    if (!asJson) console.log(`[backfill] ${getDbInfo().target}, organisation ${org.slug}; data ${dataDir}${dryRun ? " (dry run)" : ""}`);
  }
  const report = await backfillIssuedDocuments({ dataDir, service, dryRun });
  console.log(asJson ? JSON.stringify(report, null, 2) : summarise(report));
  if (report.mismatches.length || report.conflicts.length || report.errors.length) exitCode = 2;
} catch (error) {
  console.error(`[backfill] ${error.message}`);
  exitCode = 1;
} finally {
  await closeDb().catch(() => {});
}
process.exit(exitCode);
