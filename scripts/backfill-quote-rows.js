#!/usr/bin/env node
// Copy every job's quote versions into quote rows (#6,
// server/quotes/backfill.js), verifying each version first: its rows' totals
// equal what Field shows, to the cent, and a sent version's equal the totals
// on the PDF the customer was sent. A job with any mismatch is reported with
// both numbers and nothing is written for it. Idempotent: a second run writes
// nothing new. Never writes to the data directory.
//
//   node scripts/backfill-quote-rows.js [--dry-run] [--json] [--data-dir <dir>]
//
// Uses the server's database selection (FIELD_DB_URL or DATABASE_URL; PGlite
// with FIELD_PGLITE=1 or FIELD_PGLITE_DIR) and its data directory (FIELD_DATA,
// then config.json `dataDir`, then ./data). Refuses to run while migrations
// are pending: boot the server once to apply them. The organisation is the
// deployment's (FIELD_ORG, default organisation). --dry-run writes nothing; without
// a database it only checks the files. The connection string is never
// printed.
//
// Exit codes: 0 done, everything verified; 1 refused or failed; 2 done, with
// mismatches, conflicts or errors (those jobs were not written).
import { join, resolve } from "node:path";
import { loadFieldConfig } from "../server/runtime-config.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
if (flag("--help") || flag("-h")) {
  console.log("usage: node scripts/backfill-quote-rows.js [--dry-run] [--json] [--data-dir <dir>]");
  process.exit(0);
}
const dryRun = flag("--dry-run");
const asJson = flag("--json");

const repoRoot = join(import.meta.dirname, "..");
const { closeDb, getDb, getDbInfo, getMigrationStatus, resolveDbConfig } = await import("../server/db-runtime/index.js");
const { orgScope, resolveDeploymentOrg } = await import("../server/db-runtime/tenancy.js");
const { createIssuedDocumentService } = await import("../server/documents/issued-documents.js");
const { createQuoteRowService } = await import("../server/quotes/quote-rows.js");
const { backfillQuoteRows } = await import("../server/quotes/backfill.js");

function money(totals) {
  return totals ? `${totals.subtotal} + ${totals.taxTotal} = ${totals.total}` : "-";
}

function summarise(report) {
  const lines = [];
  lines.push(`${report.jobs} job(s), ${report.versions} quote version(s); ${report.jobsRefused} job(s) refused`);
  lines.push(`  by status: ${JSON.stringify(report.byStatus)}`);
  lines.push(`  ${report.dryRun ? "would do" : "done"}: ${JSON.stringify(report.actions)}`);
  const list = (label, entries, format = (entry) => JSON.stringify(entry)) => {
    lines.push(`${label}: ${entries.length}`);
    for (const entry of entries.slice(0, 50)) lines.push(`  ${format(entry)}`);
    if (entries.length > 50) lines.push(`  … ${entries.length - 50} more (use --json)`);
  };
  list("mismatches (job not written)", report.mismatches, (entry) => (entry.kind === "totals"
    ? `job ${entry.jobId} ${entry.number || ""} v${entry.version} (${entry.status}): ${entry.field} rows ${entry.rows} vs ${entry.against}${entry.reference ? ` ${entry.reference}` : ""} ${entry.shown}`
    : `job ${entry.jobId} ${entry.number || ""} v${entry.version} (${entry.status}): ${entry.name || ""} ${entry.quantity ?? ""} x ${entry.unitSell ?? ""} = ${entry.computed ?? ""}, printed ${entry.printed ?? ""} (${entry.reason})`));
  list("conflicts with rows already written", report.conflicts);
  list("warnings", report.warnings);
  list("quote numbers used by more than one job", report.numberCollisions);
  list("errors", report.errors);
  lines.push("versions:");
  for (const entry of report.entries.slice(0, 200)) {
    const issued = entry.issued.filter((copy) => copy.totals).map((copy) => `${copy.source} ${money(copy.totals)}`).join("; ");
    lines.push(`  ${entry.ok ? "ok " : "BAD"} job ${entry.jobId} ${entry.number || ""} v${entry.version} ${entry.status}: rows ${money(entry.rows)}, shown ${money(entry.shown)}${issued ? `, sent ${issued}` : ""} -> ${entry.action || "checked"}`);
  }
  if (report.entries.length > 200) lines.push(`  … ${report.entries.length - 200} more (use --json)`);
  return lines.join("\n");
}

let exitCode = 0;
try {
  const { config: fieldConfig } = loadFieldConfig({ defaultPath: join(repoRoot, "config.json") });
  const dataDir = resolve(option("--data-dir") || process.env.FIELD_DATA || fieldConfig.dataDir || join(repoRoot, "data"));
  const dbConfig = resolveDbConfig({ dataDir });
  let service = null;
  let issuedDocuments = null;
  if (dbConfig.driver === "none") {
    if (!dryRun) throw new Error("no database configured: set FIELD_DB_URL or DATABASE_URL (or run with --dry-run to only check the files)");
  } else {
    const db = getDb({ dataDir });
    const migrations = await getMigrationStatus(db);
    if (migrations.pending > 0) throw new Error(`${migrations.pending} migration(s) pending on ${getDbInfo().target}: boot the server once to apply them`);
    const org = await resolveDeploymentOrg(db);
    const scope = orgScope(db, org.uid);
    service = createQuoteRowService({ db: scope });
    issuedDocuments = createIssuedDocumentService({ db: scope });
    if (!asJson) console.log(`[backfill] ${getDbInfo().target}, organisation ${org.slug}; data ${dataDir}${dryRun ? " (dry run)" : ""}`);
  }
  const report = await backfillQuoteRows({ dataDir, service, issuedDocuments, dryRun });
  console.log(asJson ? JSON.stringify(report, null, 2) : summarise(report));
  if (report.mismatches.length || report.conflicts.length || report.errors.length) exitCode = 2;
} catch (error) {
  console.error(`[backfill] ${error.message}`);
  exitCode = 1;
} finally {
  await closeDb().catch(() => {});
}
process.exit(exitCode);
