// Data migrations (code retirement): changes to existing records, run
// once at boot after the schema migrations, each verified before anything is
// written and recorded in `data_migrations` so it never runs again.
//
// A migration is { id, title, plan(ctx), verify(ctx, plan), apply(ctx, plan),
// summarize(plan) }:
//   plan     reads and works out every change, writing nothing;
//   verify   proves the planned change is safe (throws DataMigrationError if
//            not), still writing nothing;
//   apply    writes it. A migration that writes the database records its own
//            ledger row in the same transaction (returns { recorded: true });
//            otherwise the runner records it after `flush` (durable storage).
//   A plan with `deferred: true` (for example a plan-driven migration whose
//   plan file this installation does not ship) is reported as "deferred" and
//   NOT recorded, so it can still run later once its plan is supplied.
//
// A per-job migration (row-backfills.js) is instead { id, title, perJob:
// true, requires, run(ctx, { dryRun }), describe(summary) }: `run` checks
// every job and writes each one that verifies, and returns { summary,
// refused }. A refused job never stops boot. With nothing refused it is
// recorded; with refusals, or while a migration it `requires` is not yet
// recorded, it is reported "incomplete" and NOT recorded, so the next boot
// runs it again. Each refused job is logged by job uid, issued-document uid
// and mismatch kind; the numbers and amounts are in the dry run only. It
// writes database rows only, which the rehearsal's catalogue-only copy does
// not hold, so a rehearsal reports it "skipped".
//
// `npm run data:migrate -- --dry-run` runs plan and verify only and prints
// exactly what would change (scripts/data-migrations-cli.js). In the
// published app, GET /api/admin/data-migrations/dry-run does the same
// against the live data and database, writing nothing (dry-run-route.js).
import { sql } from "drizzle-orm";
import { withOrg } from "../db-runtime/tenancy.js";
import { DataMigrationError } from "./errors.js";
import { priceBookCleanup } from "./price-book-cleanup.js";
import { quoteRowsByUid } from "./quote-rows-by-uid.js";
import { describeRefusedJob, invoiceRowsBackfill, quoteRowsBackfill } from "./row-backfills.js";

export { DataMigrationError };

/**
 * In the order they run. The backfills come after the uid re-key, so they
 * read the files as it left them, and the invoice rows after the quote rows,
 * so invoices link the quote versions they bill.
 */
export const DATA_MIGRATIONS = Object.freeze([quoteRowsByUid, priceBookCleanup, quoteRowsBackfill, invoiceRowsBackfill]);

function rowsOf(result) {
  return Array.isArray(result) ? result : result?.rows || [];
}

export async function readDataMigrationLedger(db, orgUid) {
  const rows = await withOrg(db, orgUid, async (tx) => rowsOf(await tx.execute(
    sql`select id, applied_at, summary from data_migrations order by applied_at, id`,
  )), { accessMode: "read only" });
  return new Map(rows.map((row) => [row.id, row]));
}

/** Records a migration as applied, inside the caller's organisation transaction. */
export async function recordDataMigration(tx, { id, summary, appliedAt }) {
  await tx.execute(sql`
    insert into data_migrations (id, applied_at, summary)
    values (${id}, ${appliedAt.toISOString()}::timestamptz, ${JSON.stringify(summary || {})}::jsonb)`);
}

/**
 * Runs every data migration not yet recorded, in order. `mode` is "apply"
 * (boot), "dry-run" (plan and verify only) or "rehearse" (all of it, against
 * throwaway copies: rehearsal.js). Returns one report entry per migration:
 * { id, title, status: "applied" | "rehearsed" | "would-apply" |
 * "nothing-to-do" | "already-applied" | "held" | "deferred" | "incomplete" |
 * "would-refuse" | "skipped", summary, changes }.
 * A failed verification or write throws; the caller (boot) exits, so Field
 * never serves half a migration. A per-job migration's refused jobs do not
 * throw: they leave it "incomplete" (in a dry run, "would-refuse").
 * `signal` (an AbortSignal) stops a per-job migration between jobs.
 */
export async function runDataMigrations({
  db,
  orgUid,
  dataDir,
  getState,
  catalogStore = null,
  mode = "apply",
  migrations = DATA_MIGRATIONS,
  only = null,
  hold = [],
  flush = async () => {},
  now = () => new Date(),
  logger = console,
  signal = null,
} = {}) {
  if (!["apply", "dry-run", "rehearse"].includes(mode)) throw new Error(`mode must be apply, dry-run or rehearse, not ${mode}`);
  const ledger = await readDataMigrationLedger(db, orgUid);
  const held = new Set(hold);
  const report = [];
  const recorded = new Set(ledger.keys());
  for (const migration of migrations) {
    if (only && !only.includes(migration.id)) continue;
    if (ledger.has(migration.id)) {
      report.push({ id: migration.id, title: migration.title, status: "already-applied", appliedAt: ledger.get(migration.id).applied_at, summary: ledger.get(migration.id).summary });
      continue;
    }
    if (held.has(migration.id) || held.has("all")) {
      report.push({ id: migration.id, title: migration.title, status: "held" });
      logger.warn?.(`[data-migrations] ${migration.id} held by FIELD_DATA_MIGRATIONS_HOLD; not run`);
      continue;
    }
    const context = { db, orgUid, dataDir, getState, catalogStore, now, logger, mode, signal };
    if (migration.perJob) {
      const outcome = await runPerJobMigration(migration, context, recorded);
      if (outcome.recorded) recorded.add(migration.id);
      report.push(outcome.report);
      continue;
    }
    const plan = await migration.plan(context);
    if (plan?.deferred) {
      report.push({ id: migration.id, title: migration.title, status: "deferred", reason: plan.deferredReason || null });
      logger.log?.(`[data-migrations] ${migration.id}: deferred (${plan.deferredReason || "not applicable yet"}); not recorded`);
      continue;
    }
    await migration.verify(context, plan);
    const summary = migration.summarize(plan);
    const entry = { id: migration.id, title: migration.title, summary, changes: plan.changes || [] };
    if (mode === "dry-run") {
      report.push({ ...entry, status: summary.changed ? "would-apply" : "nothing-to-do" });
      continue;
    }
    const appliedAt = now();
    const result = summary.changed ? await migration.apply(context, plan, { appliedAt, summary }) : null;
    if (!result?.recorded) {
      await flush({ reason: `data migration ${migration.id}` });
      await withOrg(db, orgUid, (tx) => recordDataMigration(tx, { id: migration.id, summary, appliedAt }));
    }
    recorded.add(migration.id);
    const done = mode === "rehearse" ? "rehearsed" : "applied";
    report.push({ ...entry, summary: migration.summarize(plan), status: summary.changed ? done : "nothing-to-do", ...(result?.report ? { applied: result.report } : {}) });
    logger.log?.(`[data-migrations] ${migration.id}: ${summary.changed ? `${done} (${migration.describe(summary)})` : "nothing to change"}; recorded`);
  }
  return report;
}

/**
 * One per-job migration (see the top of this file). Returns { report,
 * recorded }. Logs one line with the counts, and one line per refused job.
 */
async function runPerJobMigration(migration, context, recorded) {
  const { id, title } = migration;
  const { mode, logger } = context;
  if (mode === "rehearse") {
    return {
      report: { id, title, status: "skipped", reason: "it writes database rows only, which the rehearsal copy does not hold; check it in the published app with GET /api/admin/data-migrations/dry-run" },
      recorded: false,
    };
  }
  const dryRun = mode === "dry-run";
  const { summary, refused } = await migration.run(context, { dryRun });
  const waitingFor = (migration.requires || []).filter((required) => !recorded.has(required));
  const entry = { id, title, summary, refused, ...(waitingFor.length ? { waitingFor } : {}) };
  if (dryRun) {
    return { report: { ...entry, status: refused.length ? "would-refuse" : summary.changed ? "would-apply" : "nothing-to-do" }, recorded: false };
  }
  const counts = migration.describe(summary);
  if (refused.length || waitingFor.length) {
    const why = [refused.length ? `${refused.length} job(s) refused` : null, waitingFor.length ? `waits for ${waitingFor.join(", ")}` : null].filter(Boolean).join("; ");
    logger.warn?.(`[data-migrations] ${id}: incomplete (${counts}); not recorded (${why}), runs again at next boot`);
    for (const job of refused) logger.warn?.(`[data-migrations] ${id}: refused ${describeRefusedJob(job)}`);
    return { report: { ...entry, status: "incomplete" }, recorded: false };
  }
  await withOrg(context.db, context.orgUid, (tx) => recordDataMigration(tx, { id, summary, appliedAt: context.now() }));
  logger.log?.(`[data-migrations] ${id}: ${summary.changed ? "applied" : "nothing to change"} (${counts}); recorded`);
  return { report: { ...entry, status: summary.changed ? "applied" : "nothing-to-do" }, recorded: true };
}

/** FIELD_DATA_MIGRATIONS_HOLD=<id>[,<id>] or "all": an emergency stop, logged at boot. */
export function heldDataMigrations(env = process.env) {
  return String(env.FIELD_DATA_MIGRATIONS_HOLD || "").split(",").map((value) => value.trim()).filter(Boolean);
}
