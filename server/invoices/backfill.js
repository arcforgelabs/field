// Backfill of invoice rows from today's job files, with verification (#27;
// docs/PRICING_ENGINE.md "Moving today's data").
//
// For every job with milestone state: its schedule, every issued invoice
// revision (superseded ones too), its drafts, payments and receipts become
// rows (sync.js). Each job is checked first: every issued invoice's totals
// equal its stored revision snapshot and the totals its PDF printed, the
// payments add up to the amount paid, and the current invoices add up to the
// quote. A job with any failure is reported with both numbers and nothing is
// written for it. A second run writes nothing new. It never writes to a job
// directory. With `dryRun` it writes nothing anywhere and reports what a run
// would do.
import { listJobDirs } from "../documents/backfill.js";
import { syncJobInvoiceRows } from "./sync.js";

export function emptyInvoiceBackfillReport(dryRun = false) {
  return {
    dryRun,
    jobs: 0,
    jobsWithMilestones: 0,
    jobsRefused: 0,
    invoices: 0,
    byStatus: {},
    actions: {},
    written: { milestones: {}, invoices: {}, creditNotes: {}, payments: {}, allocations: {}, receipts: {} },
    mismatches: [],
    conflicts: [],
    warnings: [],
    errors: [],
    entries: [],
  };
}

function bump(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

/** Add one job's sync result to the report. */
export function addJobToReport(report, result) {
  report.jobs += 1;
  if (result.action === "none") return;
  report.jobsWithMilestones += 1;
  if (!result.ok) report.jobsRefused += 1;
  bump(report.actions, result.action || "checked");
  for (const invoice of result.invoices) {
    report.invoices += 1;
    bump(report.byStatus, invoice.status);
  }
  if (result.summary) {
    for (const table of ["milestones", "invoices", "creditNotes", "payments", "allocations", "receipts"]) {
      for (const [action, count] of Object.entries(result.summary[table] || {})) if (count) bump(report.written[table], action, count);
    }
  }
  for (const failure of result.failures) {
    if (failure.kind === "conflict") report.conflicts.push({ jobId: result.jobId, ...failure });
    else report.mismatches.push({ jobId: result.jobId, ...failure });
  }
  for (const warning of result.warnings) report.warnings.push({ jobId: result.jobId, ...warning });
  report.entries.push({
    jobId: result.jobId,
    ok: result.ok,
    action: result.action,
    quoteTotal: result.quoteTotal,
    milestones: result.milestones,
    payments: result.payments,
    receipts: result.receipts,
    invoices: result.invoices,
  });
}

/**
 * Backfill every job under `dataDir`. `service` is the invoice row service for
 * the organisation the data directory belongs to (null: check only),
 * `quoteRows` the quote row service (to link quote versions), and
 * `issuedDocuments` the issue service (to link and read issued PDFs).
 */
export async function backfillInvoiceRows({ dataDir, service = null, quoteRows = null, issuedDocuments = null, dryRun = false, onJob = null }) {
  const report = emptyInvoiceBackfillReport(dryRun);
  for (const jobDir of await listJobDirs(dataDir)) {
    try {
      const result = await syncJobInvoiceRows({
        jobDir,
        service,
        quoteRows,
        issuedDocuments,
        verifyIssued: true,
        dryRun,
        actor: "backfill",
      });
      if (result) addJobToReport(report, result);
    } catch (error) {
      report.errors.push({ jobDir, reason: error.message });
    }
    onJob?.(jobDir, report);
  }
  return report;
}
