// Backfill of quote rows from today's job files, with verification (#6;
// docs/PRICING_ENGINE.md "Moving today's data").
//
// For every job: its current quote and every archived quote-versions/vNNN
// becomes quote rows (sync.js). Each version is checked first: its rows'
// totals must equal what Field shows to the cent, every priced line must
// print round(qty x rate, 2), and a sent version's totals must equal the
// totals on the PDF the customer was sent. A job with any failure is reported
// with both numbers and nothing is written for it. A second run writes nothing
// new. It never writes to a job directory. With `dryRun` it writes nothing
// anywhere and reports what a run would do.
import { listJobDirs } from "../documents/backfill.js";
import { syncJobQuoteRows } from "./sync.js";

export function emptyQuoteBackfillReport(dryRun = false) {
  return {
    dryRun,
    jobs: 0,
    jobsRefused: 0,
    versions: 0,
    byStatus: {},
    actions: {},
    mismatches: [],
    warnings: [],
    conflicts: [],
    numberCollisions: [],
    errors: [],
    entries: [],
  };
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/** Add one job's sync result to the report. */
export function addJobToReport(report, result) {
  report.jobs += 1;
  if (!result.ok) report.jobsRefused += 1;
  for (const version of result.versions) {
    report.versions += 1;
    bump(report.byStatus, version.status || "unknown");
    if (version.action) bump(report.actions, version.action);
    const where = { jobId: result.jobId, version: version.version, number: version.number || null, status: version.status };
    for (const failure of version.failures || []) {
      if (failure.kind === "sent-rows-differ") report.conflicts.push({ ...where, ...failure });
      else report.mismatches.push({ ...where, ...failure });
    }
    for (const warning of version.warnings || []) report.warnings.push({ ...where, ...warning });
    report.entries.push({
      ...where,
      documentNumber: version.documentNumber || null,
      sentAt: version.sentAt || null,
      issuedDocumentUid: version.issuedDocumentUid || null,
      rows: version.rows || null,
      shown: version.shown || null,
      issued: version.issued || [],
      lines: version.lines ?? null,
      sections: version.sections ?? null,
      ok: version.ok,
      action: version.action,
    });
  }
}

/** Quote numbers that more than one job uses for the same version. */
function findNumberCollisions(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    if (!entry.number) continue;
    const key = `${entry.number} v${entry.version}`;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(entry.jobId);
  }
  return [...byKey].filter(([, jobs]) => jobs.size > 1).map(([number, jobs]) => ({ number, jobs: [...jobs] }));
}

/**
 * Backfill every job under `dataDir`. `service` is the quote service for the
 * organisation the data directory belongs to (null: check only),
 * `issuedDocuments` the issue service (null: check sent versions against
 * the files only).
 */
export async function backfillQuoteRows({ dataDir, service = null, issuedDocuments = null, dryRun = false, onJob = null }) {
  const report = emptyQuoteBackfillReport(dryRun);
  for (const jobDir of await listJobDirs(dataDir)) {
    try {
      const result = await syncJobQuoteRows({
        jobDir,
        service,
        issuedDocuments,
        verifyIssued: true,
        atomic: true,
        dryRun,
        actor: "backfill",
      });
      if (result) addJobToReport(report, result);
    } catch (error) {
      report.errors.push({ jobDir, reason: error.message });
    }
    onJob?.(jobDir, report);
  }
  report.numberCollisions = findNumberCollisions(report.entries);
  return report;
}
