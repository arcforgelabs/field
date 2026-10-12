// The quote-row and invoice-row backfills (#6, #27) as boot data migrations
// (#36). Production backfills itself at boot, after durable storage has
// restored the data directory, so nobody runs a backfill against production
// from somewhere else.
//
// These are per-job migrations: { id, title, perJob: true, requires, run,
// describe }. `run(context, { dryRun })` calls the backfill module over the
// live data directory. The backfill checks every job before it writes it (a
// quote version's rows against what Field shows and what its sent PDF
// printed; an invoice against its issued revision and its PDF, payments
// against the amount paid) and writes only database rows, never job files.
// With `dryRun` it writes nothing (the invoice side works in a transaction
// that is rolled back).
//
// The recording rule (index.js):
//   - no job refused: recorded as applied, with the summary (written, already
//     present, warnings), and never run again;
//   - some jobs refused: every job that verifies is written; each refused job
//     is logged with its id and both numbers; the migration is not recorded,
//     so the next boot tries again. A retry is one pass over the jobs: a job
//     already written is checked and left as it is (idempotent), and only
//     what changed is written.
//
// The invoice backfill also waits for the quote backfill: until that one is
// recorded, it runs and writes but is not recorded, so a later boot fills the
// links from invoices to the quote versions written in between.
//
// Nothing here logs or returns a customer name, an address or a line label:
// refused jobs are reported by job id, document number, version, field and
// amounts only.
import { relative } from "node:path";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { backfillInvoiceRows } from "../invoices/backfill.js";
import { createInvoiceRowService } from "../invoices/invoice-rows.js";
import { backfillQuoteRows } from "../quotes/backfill.js";
import { createQuoteRowService } from "../quotes/quote-rows.js";

export const QUOTE_ROWS_BACKFILL_ID = "2026-10-13-quote-rows-backfill";
export const INVOICE_ROWS_BACKFILL_ID = "2026-10-13-invoice-rows-backfill";

// What a version or job did, by the backfill's action names.
const PRESENT = new Set(["unchanged"]);
const WRITTEN = new Set(["created", "replaced", "status-updated", "removed-stale-draft", "would-create", "would-replace", "would-update-status"]);

function services(context) {
  return {
    issuedDocuments: createIssuedDocumentService({ db: context.db, orgUid: context.orgUid }),
    quoteRows: createQuoteRowService({ db: context.db, orgUid: context.orgUid }),
  };
}

/** Stops a run between jobs once its caller has given up (the dry-run route's time limit). */
function stopWhenAborted(signal) {
  return () => {
    if (signal?.aborted) throw Object.assign(new Error("the data-migration run was stopped (time limit)"), { code: "DATA_MIGRATION_ABORTED" });
  };
}

// Only numbers and identifiers: a mismatch's reason or a line's name can hold
// customer text.
function numbersOnly(entry) {
  const out = {};
  for (const key of ["kind", "against", "number", "version", "milestone", "field", "rows", "shown", "computed", "printed", "conflict"]) {
    if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== "object") out[key] = entry[key];
  }
  return out;
}

// An error message without anything quoted from a file (JSON.parse quotes
// the text it could not read).
function safeReason(reason) {
  return String(reason || "").replace(/"[^"]*"/g, "\"…\"").replace(/'[^']*'/g, "'…'").slice(0, 200);
}

function jobOf(dataDir, jobDir) {
  return dataDir ? relative(dataDir, jobDir) : jobDir;
}

/** Refused jobs, one entry each: { jobId | job, mismatches: [numbers only] }. */
function refusedJobs(report, dataDir, { dryRunConflicts = [] } = {}) {
  const byJob = new Map();
  const add = (jobId, entry) => {
    if (!byJob.has(jobId)) byJob.set(jobId, { jobId, mismatches: [] });
    if (entry) byJob.get(jobId).mismatches.push(entry);
  };
  for (const entry of report.mismatches) add(entry.jobId, numbersOnly(entry));
  for (const entry of report.conflicts) add(entry.jobId, numbersOnly({ ...entry, kind: entry.kind === "conflict" ? "conflict" : "sent-rows-differ" }));
  for (const entry of dryRunConflicts) add(entry.jobId, numbersOnly(entry));
  const refused = [...byJob.values()];
  for (const error of report.errors) refused.push({ job: jobOf(dataDir, error.jobDir), error: safeReason(error.reason), mismatches: [] });
  return refused;
}

function countActions(actions, names) {
  return Object.entries(actions).filter(([action]) => names.has(action)).reduce((sum, [, count]) => sum + count, 0);
}

async function runQuoteRows(context, { dryRun }) {
  const { issuedDocuments, quoteRows } = services(context);
  const report = await backfillQuoteRows({ dataDir: context.dataDir, service: quoteRows, issuedDocuments, dryRun, onJob: stopWhenAborted(context.signal) });
  // A dry run reports a sent version whose stored rows differ as an action,
  // not a failure; a real run refuses it.
  const dryRunConflicts = dryRun
    ? report.entries.filter((entry) => entry.action === "conflict").map((entry) => ({ jobId: entry.jobId, kind: "sent-rows-differ", number: entry.number, version: entry.version }))
    : [];
  const refused = refusedJobs(report, context.dataDir, { dryRunConflicts });
  const alreadyPresent = countActions(report.actions, PRESENT);
  const written = countActions(report.actions, WRITTEN);
  return {
    summary: {
      changed: written,
      jobs: report.jobs,
      versions: report.versions,
      written,
      alreadyPresent,
      refusedJobs: refused.length,
      warnings: report.warnings.length,
      actions: report.actions,
      numberCollisions: report.numberCollisions.length,
    },
    refused,
  };
}

async function runInvoiceRows(context, { dryRun }) {
  const { issuedDocuments, quoteRows } = services(context);
  const service = createInvoiceRowService({ db: context.db, orgUid: context.orgUid });
  const report = await backfillInvoiceRows({ dataDir: context.dataDir, service, quoteRows, issuedDocuments, dryRun, onJob: stopWhenAborted(context.signal) });
  const refused = refusedJobs(report, context.dataDir);
  const written = (report.actions.written || 0) + (report.actions["would-write"] || 0);
  return {
    summary: {
      changed: written,
      jobs: report.jobs,
      jobsWithMilestones: report.jobsWithMilestones,
      invoices: report.invoices,
      written,
      alreadyPresent: report.actions.unchanged || 0,
      refusedJobs: refused.length,
      warnings: report.warnings.length,
      rows: report.written,
    },
    refused,
  };
}

function describeQuoteRows(summary) {
  return `${summary.jobs} job(s), ${summary.versions} quote version(s): ${summary.written} written, ${summary.alreadyPresent} already present, ${summary.refusedJobs} job(s) refused; ${summary.warnings} warning(s)`;
}

function describeInvoiceRows(summary) {
  return `${summary.jobsWithMilestones} job(s) with milestones, ${summary.invoices} invoice(s): ${summary.written} job(s) written, ${summary.alreadyPresent} already present, ${summary.refusedJobs} job(s) refused; ${summary.warnings} warning(s)`;
}

/** One log line for a refused job: its id and both numbers of each mismatch. */
export function describeRefusedJob(entry) {
  if (entry.error !== undefined) return `job ${entry.job}: could not be checked (${entry.error})`;
  const parts = entry.mismatches.map((mismatch) => {
    const where = [mismatch.number, mismatch.version != null ? `v${mismatch.version}` : null, mismatch.milestone != null ? `milestone ${mismatch.milestone + 1}` : null].filter(Boolean).join(" ");
    const numbers = mismatch.rows !== undefined ? `: ${mismatch.field || mismatch.kind} rows ${mismatch.rows} vs ${mismatch.against || mismatch.kind} ${mismatch.shown}` : "";
    return `${where ? `${where} ` : ""}${mismatch.conflict || mismatch.kind}${numbers}`;
  });
  return `job ${entry.jobId}: ${parts.join("; ") || "refused"}`;
}

export const quoteRowsBackfill = Object.freeze({
  id: QUOTE_ROWS_BACKFILL_ID,
  title: "Quote rows backfill (#6): every job's quote versions as rows, verified to the cent",
  perJob: true,
  requires: [],
  run: runQuoteRows,
  describe: describeQuoteRows,
});

export const invoiceRowsBackfill = Object.freeze({
  id: INVOICE_ROWS_BACKFILL_ID,
  title: "Invoice rows backfill (#27): milestones, invoices, payments and receipts as rows, verified against what was issued",
  perJob: true,
  requires: [QUOTE_ROWS_BACKFILL_ID],
  run: runInvoiceRows,
  describe: describeInvoiceRows,
});
