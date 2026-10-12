// Dual-write of invoice rows (#27), the way the quote-row recorder
// (server/quotes/recorder.js) works: the job files stay the source of truth,
// and everything here runs after today's code has committed its own change and
// never changes it. A failure is logged, counted and shown in GET
// /api/storage/status (`invoiceRows`), and never thrown back to the caller.
// Without a database the recorder skips with one log line.
//
// When it runs: after every committed job generation (server/job-generation.js
// calls the listener the server installs), which covers every milestone
// action: generate, update, send, revise, payment, void payment, mark unsent
// and mark unpaid. After an invoice or receipt email is recorded as an issued
// document, the send path syncs again so the rows link that document.
//
// Per job: a job whose rows would not equal what was issued and what Field
// shows is not written (its rows keep what they had) and is counted under
// `mismatches`, with both numbers in `lastMismatch`.
import { syncJobInvoiceRows } from "./sync.js";

const NOOP = Object.freeze({
  enabled: false,
  async syncJob() { return null; },
  status() { return { enabled: false, reason: "not installed" }; },
});

let installed = null;

export function installInvoiceRowRecorder(recorder) {
  installed = recorder || null;
  return installed;
}

export function invoiceRowRecorder() {
  return installed || NOOP;
}

/** The recorder for a server with a database. */
export function createInvoiceRowRecorder({ service, quoteRows = null, issuedDocuments = null, logger = console, sync = syncJobInvoiceRows }) {
  const state = {
    enabled: true,
    jobsSynced: 0,
    written: 0,
    unchanged: 0,
    mismatches: 0,
    conflicts: 0,
    failures: 0,
    lastMismatch: null,
    lastError: null,
    lastSyncedAt: null,
  };
  const reported = new Set();
  // One sync per job at a time in this process.
  const running = new Map();

  function syncJob(jobDir, options = {}) {
    const key = String(jobDir);
    const previous = running.get(key) || Promise.resolve();
    const next = previous.then(() => syncJobNow(jobDir, options));
    running.set(key, next);
    return next.finally(() => {
      if (running.get(key) === next) running.delete(key);
    });
  }

  async function syncJobNow(jobDir, { reason = null } = {}) {
    try {
      const result = await sync({ jobDir, service, quoteRows, issuedDocuments, actor: "dual-write" });
      if (!result || result.action === "none") return result;
      state.jobsSynced += 1;
      state.lastSyncedAt = new Date().toISOString();
      if (result.action === "written") state.written += 1;
      else if (result.action === "unchanged") state.unchanged += 1;
      if (!result.ok) {
        const conflicts = result.failures.filter((failure) => failure.kind === "conflict");
        const key = `${result.jobId}:${JSON.stringify(result.failures)}`;
        if (!reported.has(key)) {
          reported.add(key);
          if (conflicts.length) state.conflicts += 1;
          if (conflicts.length !== result.failures.length) state.mismatches += 1;
          state.lastMismatch = { at: new Date().toISOString(), jobId: result.jobId, failures: result.failures.slice(0, 10) };
          logger.warn(`[invoice-rows] job ${result.jobId}: ${result.action === "refused" ? "rows not written" : "rows kept as issued"} (${result.failures.slice(0, 5).map((failure) => (failure.rows !== undefined
            ? `${failure.number ? `${failure.number} ` : ""}${failure.field} rows ${failure.rows} vs ${failure.against || failure.kind} ${failure.shown}`
            : failure.reason || failure.kind)).join("; ")}); the job files still hold them`);
        }
      }
      return result;
    } catch (error) {
      state.failures += 1;
      state.lastError = { at: new Date().toISOString(), message: String(error?.message || error), code: error?.code || null, jobDir: String(jobDir), reason };
      logger.error(`[invoice-rows] invoice rows not recorded for ${jobDir}${reason ? ` (${reason})` : ""}: ${error?.message || error}; the job files still hold them`);
      return null;
    }
  }

  return {
    enabled: true,
    service,
    syncJob,
    status() {
      return { ...state, lastMismatch: state.lastMismatch ? { ...state.lastMismatch } : null, lastError: state.lastError ? { ...state.lastError } : null };
    },
  };
}

/** A server with no database: every call is skipped, with one log line. */
export function createUnavailableInvoiceRowRecorder(reason, { logger = console } = {}) {
  let skipped = 0;
  return {
    enabled: false,
    async syncJob() {
      skipped += 1;
      if (skipped === 1) logger.warn(`[invoice-rows] ${reason}: invoice rows are not recorded in PostgreSQL (the job files still hold them)`);
      return null;
    },
    status() { return { enabled: false, reason, skipped }; },
  };
}
