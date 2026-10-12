// Dual-write of quote rows (#6), the way the issued-document recorder
// (server/documents/recorder.js) works: the job files stay the source of truth,
// and everything here runs after today's code has committed its own change and
// never changes it. A failure is logged, counted and shown in GET
// /api/storage/status (`quoteRows`), and never thrown back to the caller.
// Without a database the recorder skips with one log line.
//
// When it runs: after every committed job generation (server/job-generation.js
// calls the listener the server installs), which covers every way today's
// code writes a quote version: build, save, lock, fork, promote, delete and
// send. After a quote email is recorded as an issued document, the send path
// syncs again so the sent version links that document.
//
// Per version: a version whose rows reproduce what Field shows is written; one
// that does not is counted under `mismatches`, with both numbers in
// `lastMismatch`, and its draft rows are removed, so the rows never disagree
// with Field. A sent version's rows are never rewritten.
import { syncJobQuoteRows } from "./sync.js";

const NOOP = Object.freeze({
  enabled: false,
  async syncJob() { return null; },
  status() { return { enabled: false, reason: "not installed" }; },
});

let installed = null;

export function installQuoteRowRecorder(recorder) {
  installed = recorder || null;
  return installed;
}

export function quoteRowRecorder() {
  return installed || NOOP;
}

/** The recorder for a server with a database. */
export function createQuoteRowRecorder({ service, issuedDocuments = null, logger = console, sync = syncJobQuoteRows }) {
  const state = {
    enabled: true,
    jobsSynced: 0,
    created: 0,
    replaced: 0,
    statusUpdated: 0,
    unchanged: 0,
    removed: 0,
    mismatches: 0,
    conflicts: 0,
    failures: 0,
    lastMismatch: null,
    lastError: null,
    lastSyncedAt: null,
  };
  const reported = new Set();
  // One sync per job at a time in this process: a commit and the send path's
  // follow-up sync must not both create the same version's rows.
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
      const result = await sync({
        jobDir,
        service,
        issuedDocuments,
        skipUnchanged: true,
        actor: "dual-write",
      });
      if (!result) return null;
      state.jobsSynced += 1;
      state.lastSyncedAt = new Date().toISOString();
      state.removed += result.removed.length;
      for (const version of result.versions) {
        if (version.action === "created") state.created += 1;
        else if (version.action === "replaced") state.replaced += 1;
        else if (version.action === "status-updated") state.statusUpdated += 1;
        else if (version.action === "unchanged") state.unchanged += 1;
        else if (version.action === "conflict") state.conflicts += 1;
        if (version.action === "removed-stale-draft") state.removed += 1;
        if (!version.ok) {
          // Every commit re-checks every version: count and log each distinct
          // failure once, not once per commit.
          const key = `${result.jobId}:${version.version}:${JSON.stringify(version.failures)}`;
          if (reported.has(key)) continue;
          reported.add(key);
          if (version.action !== "conflict") state.mismatches += 1;
          state.lastMismatch = {
            at: new Date().toISOString(),
            jobId: result.jobId,
            version: version.version,
            number: version.number || null,
            failures: version.failures.slice(0, 10),
          };
          logger.warn(`[quote-rows] job ${result.jobId} v${version.version}: rows not written (${version.failures.map((failure) => failure.kind === "totals"
            ? `${failure.field} rows ${failure.rows} vs ${failure.against} ${failure.shown}`
            : failure.reason || failure.kind).join("; ")}); the job files still hold it`);
        }
      }
      return result;
    } catch (error) {
      state.failures += 1;
      state.lastError = { at: new Date().toISOString(), message: String(error?.message || error), code: error?.code || null, jobDir: String(jobDir), reason };
      logger.error(`[quote-rows] quote rows not recorded for ${jobDir}${reason ? ` (${reason})` : ""}: ${error?.message || error}; the job files still hold them`);
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
export function createUnavailableQuoteRowRecorder(reason, { logger = console } = {}) {
  let skipped = 0;
  return {
    enabled: false,
    async syncJob() {
      skipped += 1;
      if (skipped === 1) logger.warn(`[quote-rows] ${reason}: quote rows are not recorded in PostgreSQL (the job files still hold them)`);
      return null;
    },
    status() { return { enabled: false, reason, skipped }; },
  };
}
