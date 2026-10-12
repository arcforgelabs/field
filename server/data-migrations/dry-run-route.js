// GET /api/admin/data-migrations/dry-run (#36): the data-migration dry run
// inside the published app, so a release can be checked against production's
// data and database without anyone holding production's credentials.
//
// It runs every data migration not yet recorded, held ones included, in
// "dry-run" mode (index.js): each one's plan and verification against the
// live data directory and database, writing nothing. Checks that need a
// write work in a transaction that is rolled back (the price-book clean-up's
// gate, the invoice backfill's comparison). Already-applied migrations are
// listed with their recorded summary.
//
//   200  { ok, wroteNothing: true, durationMs, migrations: [...] }; ok is
//        false when a migration would refuse jobs or fails verification
//   409  another dry run is still running (one at a time)
//   503  no catalogue or organisation (degraded boot)
//   504  it ran out of time; it stops at the next job, and a new one can
//        start once it has
//
// The answer holds ids, statuses and numbers only: never a customer name,
// an address, a line label, or the files a migration would change.
import { DataMigrationError } from "./errors.js";

export const DRY_RUN_PATH = "/api/admin/data-migrations/dry-run";
export const DRY_RUN_TIMEOUT_MS = 120_000;

const TIMED_OUT = Symbol("timed out");

// A migration's own summary is numbers, versions and counts. Anything nested
// that is not (a per-job migration's action counts) stays as it is only when
// every value in it is a number.
function numericSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(summary)) {
    if (value === null || ["number", "boolean"].includes(typeof value)) out[key] = value;
    else if (typeof value === "string" && /^[\d.:TZ-]+$/.test(value)) out[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = numericSummary(value);
      if (nested && Object.keys(nested).length === Object.keys(value).length) out[key] = nested;
    }
  }
  return out;
}

/** The public shape of one report entry: ids, statuses and numbers. */
export function publicMigrationEntry(entry) {
  return {
    id: entry.id,
    status: entry.status,
    ...(entry.appliedAt ? { appliedAt: entry.appliedAt instanceof Date ? entry.appliedAt.toISOString() : String(entry.appliedAt) } : {}),
    summary: numericSummary(typeof entry.summary === "string" ? JSON.parse(entry.summary) : entry.summary),
    ...(entry.changes ? { changes: entry.changes.length } : {}),
    ...(entry.refused ? { refused: entry.refused } : {}),
    ...(entry.waitingFor ? { waitingFor: entry.waitingFor } : {}),
  };
}

function verificationFailure(error) {
  const failures = Array.isArray(error.details?.failures) ? error.details.failures : [];
  return {
    // The message starts with the migration's id.
    migration: String(error.message).split(":")[0],
    failures: failures.length,
  };
}

/**
 * The route handler. `run({ signal })` runs the migrations in dry-run mode
 * and resolves to the runner's report, or null when this server cannot run
 * them (no catalogue or organisation).
 */
export function createDataMigrationDryRunHandler({ run, timeoutMs = DRY_RUN_TIMEOUT_MS, logger = console }) {
  let running = null;
  return async function dataMigrationDryRun(_req, res) {
    if (running) {
      return res.status(409).json({ error: "A data-migration dry run is already running. Try again when it has finished.", code: "DATA_MIGRATION_DRY_RUN_RUNNING" });
    }
    const controller = new AbortController();
    const started = Date.now();
    const work = Promise.resolve().then(() => run({ signal: controller.signal })).then(
      (report) => ({ report }),
      (error) => ({ error }),
    );
    running = work.finally(() => { running = null; });
    let timer = null;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
    try {
      const outcome = await Promise.race([work, deadline]);
      const durationMs = Date.now() - started;
      if (outcome === TIMED_OUT) {
        controller.abort();
        logger.warn?.(`[data-migrations] dry run stopped after ${timeoutMs} ms (time limit)`);
        return res.status(504).json({ error: `The dry run did not finish within ${Math.round(timeoutMs / 1000)} s. It stops at the next job; try again after that.`, code: "DATA_MIGRATION_DRY_RUN_TIMEOUT", wroteNothing: true });
      }
      if (outcome.error instanceof DataMigrationError) {
        logger.warn?.(`[data-migrations] dry run: ${outcome.error.message}`);
        return res.json({ ok: false, wroteNothing: true, durationMs, verificationFailed: verificationFailure(outcome.error), migrations: [] });
      }
      if (outcome.error) {
        logger.error?.(`[data-migrations] dry run could not run: ${outcome.error.message}`);
        return res.status(500).json({ error: "The dry run could not run. The server log has the reason.", code: "DATA_MIGRATION_DRY_RUN_FAILED", wroteNothing: true });
      }
      if (!outcome.report) {
        return res.status(503).json({ error: "This server has no price catalogue or organisation, so it runs no data migrations.", code: "DATA_MIGRATIONS_UNAVAILABLE" });
      }
      const migrations = outcome.report.map(publicMigrationEntry);
      const ok = migrations.every((entry) => entry.status !== "would-refuse");
      logger.log?.(`[data-migrations] dry run: ${migrations.map((entry) => `${entry.id} ${entry.status}`).join(", ") || "no migrations"} (${durationMs} ms)`);
      return res.json({ ok, wroteNothing: true, durationMs, migrations });
    } finally {
      clearTimeout(timer);
    }
  };
}
