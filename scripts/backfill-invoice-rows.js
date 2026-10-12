#!/usr/bin/env node
// Copy every job's milestone invoices, payments and receipts into invoice rows
// (#27, server/invoices/backfill.js), verifying each job first: every issued
// invoice's subtotal, GST and total equal its stored issued revision and the
// totals printed on its PDF, the payments add up to the amount paid, and the
// invoices add up to the quote. A job with any mismatch is reported with both
// numbers and nothing is written for it. Idempotent: a second run writes
// nothing new. Never writes to the data directory.
//
//   node scripts/backfill-invoice-rows.js [--dry-run] [--json] [--data-dir <dir> | --from-storage]
//
// Uses the server's database selection (FIELD_DB_URL or DATABASE_URL; PGlite
// with FIELD_PGLITE=1 or FIELD_PGLITE_DIR) and its data directory (FIELD_DATA,
// then config.json `dataDir`, then ./data). With --from-storage the job files
// come from what durable storage holds in that database instead: they are
// restored, through a read-only session, into a new directory under the
// system temporary directory, and that directory is deleted when the run
// ends. Production does not run this script: the published app runs the same
// backfill at boot as a data migration (docs/REPLIT.md "The row backfills"),
// and a Replit workspace's DATABASE_URL is the workspace's own database, not
// production's. Refuses to run while migrations
// are pending: boot the server once to apply them. The organisation is the
// deployment's (FIELD_ORG, default organisation). Run the quote-row backfill
// first, so invoices link the quote versions they bill. --dry-run writes
// nothing; without a database it only checks the files. The connection
// string is never printed.
//
// Exit codes: 0 done, everything verified; 1 refused or failed; 2 done, with
// mismatches, conflicts or errors (those jobs were not written).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadFieldConfig } from "../server/runtime-config.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
if (flag("--help") || flag("-h")) {
  console.log("usage: node scripts/backfill-invoice-rows.js [--dry-run] [--json] [--data-dir <dir> | --from-storage]");
  process.exit(0);
}
const dryRun = flag("--dry-run");
const asJson = flag("--json");
const fromStorage = flag("--from-storage");
if (fromStorage && option("--data-dir")) {
  console.error("[backfill] --from-storage and --data-dir cannot be used together");
  process.exit(1);
}

const repoRoot = join(import.meta.dirname, "..");
const { closeDb, getDb, getDbInfo, getMigrationStatus, resolveDbConfig } = await import("../server/db-runtime/index.js");
const { orgScope, resolveDeploymentOrg } = await import("../server/db-runtime/tenancy.js");
const { createIssuedDocumentService } = await import("../server/documents/issued-documents.js");
const { createQuoteRowService } = await import("../server/quotes/quote-rows.js");
const { createInvoiceRowService } = await import("../server/invoices/invoice-rows.js");
const { backfillInvoiceRows } = await import("../server/invoices/backfill.js");

function money(totals) {
  return totals ? `${totals.subtotal} + ${totals.taxTotal} = ${totals.total}` : "-";
}

function summarise(report) {
  const lines = [];
  lines.push(`${report.jobs} job(s), ${report.jobsWithMilestones} with milestones, ${report.invoices} invoice(s); ${report.jobsRefused} job(s) refused`);
  lines.push(`  invoices by status: ${JSON.stringify(report.byStatus)}`);
  lines.push(`  jobs: ${JSON.stringify(report.actions)}`);
  lines.push(`  ${report.dryRun ? "would write" : "written"}: ${JSON.stringify(report.written)}`);
  const list = (label, entries, format = (entry) => JSON.stringify(entry)) => {
    lines.push(`${label}: ${entries.length}`);
    for (const entry of entries.slice(0, 50)) lines.push(`  ${format(entry)}`);
    if (entries.length > 50) lines.push(`  … ${entries.length - 50} more (use --json)`);
  };
  list("mismatches (job not written)", report.mismatches, (entry) => (entry.rows !== undefined
    ? `job ${entry.jobId}${entry.number ? ` ${entry.number}` : ""}${entry.milestone !== undefined ? ` milestone ${entry.milestone + 1}` : ""}: ${entry.field} rows ${entry.rows} vs ${entry.against || entry.kind}${entry.reference ? ` ${entry.reference}` : ""} ${entry.shown}`
    : `job ${entry.jobId}${entry.number ? ` ${entry.number}` : ""}: ${entry.reason || entry.kind}`));
  list("conflicts with rows already written", report.conflicts);
  list("warnings", report.warnings, (entry) => `job ${entry.jobId}${entry.number ? ` ${entry.number}` : ""}: ${entry.kind}: ${entry.reason}`);
  list("errors", report.errors);
  lines.push("invoices:");
  for (const entry of report.entries.slice(0, 200)) {
    for (const invoice of entry.invoices) {
      const issued = invoice.issued.filter((copy) => copy.totals).map((copy) => `${copy.source} ${money(copy.totals)}`).join("; ");
      lines.push(`  ${entry.ok ? "ok " : "BAD"} job ${entry.jobId} ${invoice.number} ${invoice.status}: rows ${money(invoice.rows)}${issued ? `, printed ${issued}` : ""} -> ${entry.action}`);
    }
  }
  if (report.entries.length > 200) lines.push(`  … more jobs (use --json)`);
  return lines.join("\n");
}

let exitCode = 0;
let workDir = null;
try {
  const { config: fieldConfig } = loadFieldConfig({ defaultPath: join(repoRoot, "config.json") });
  const configuredDataDir = resolve(option("--data-dir") || process.env.FIELD_DATA || fieldConfig.dataDir || join(repoRoot, "data"));
  const dbConfig = resolveDbConfig({ dataDir: configuredDataDir });
  let dataDir = configuredDataDir;
  if (fromStorage) {
    if (dbConfig.driver !== "postgres") throw new Error("--from-storage needs the PostgreSQL that durable storage uses (DATABASE_URL or FIELD_DB_URL)");
    workDir = mkdtempSync(join(tmpdir(), "field-invoice-backfill-"));
    dataDir = join(workDir, "data");
    const { openReadOnlySource } = await import("../server/data-migrations/rehearsal.js");
    const { restoreDataDir } = await import("../server/storage/durable-store.js");
    const source = openReadOnlySource(dbConfig);
    try {
      const restored = await restoreDataDir({ db: source.db, dataDir, logger: { warn: () => {} } });
      console.error(`[backfill] ${restored.stats.files} stored file(s) restored read-only into ${dataDir}; deleted when the run ends`);
    } finally {
      await source.close().catch(() => {});
    }
  }
  let service = null;
  let quoteRows = null;
  let issuedDocuments = null;
  if (dbConfig.driver === "none") {
    if (!dryRun) throw new Error("no database configured: set FIELD_DB_URL or DATABASE_URL (or run with --dry-run to only check the files)");
  } else {
    const db = getDb({ dataDir: configuredDataDir });
    const migrations = await getMigrationStatus(db);
    if (migrations.pending > 0) throw new Error(`${migrations.pending} migration(s) pending on ${getDbInfo().target}: boot the server once to apply them`);
    const org = await resolveDeploymentOrg(db);
    const scope = orgScope(db, org.uid);
    service = createInvoiceRowService({ db: scope });
    quoteRows = createQuoteRowService({ db: scope });
    issuedDocuments = createIssuedDocumentService({ db: scope });
    if (!asJson) console.log(`[backfill] ${getDbInfo().target}, organisation ${org.slug}; data ${dataDir}${dryRun ? " (dry run)" : ""}`);
  }
  const report = await backfillInvoiceRows({ dataDir, service, quoteRows, issuedDocuments, dryRun });
  console.log(asJson ? JSON.stringify(report, null, 2) : summarise(report));
  if (report.mismatches.length || report.conflicts.length || report.errors.length) exitCode = 2;
} catch (error) {
  console.error(`[backfill] ${error.message}`);
  exitCode = 1;
} finally {
  await closeDb().catch(() => {});
  if (workDir) rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
