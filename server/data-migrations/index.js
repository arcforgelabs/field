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
// `npm run data:migrate -- --dry-run` runs plan and verify only and prints
// exactly what would change (scripts/data-migrations-cli.js).
import { sql } from "drizzle-orm";
import { withOrg } from "../db-runtime/tenancy.js";
import { DataMigrationError } from "./errors.js";
import { priceBookCleanup } from "./price-book-cleanup.js";
import { quoteRowsByUid } from "./quote-rows-by-uid.js";

export { DataMigrationError };

/** In the order they run. */
export const DATA_MIGRATIONS = Object.freeze([quoteRowsByUid, priceBookCleanup]);

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
 * "nothing-to-do" | "already-applied" | "held" | "deferred", summary, changes }.
 * A failed verification or write throws; the caller (boot) exits, so Field
 * never serves half a migration.
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
} = {}) {
  if (!["apply", "dry-run", "rehearse"].includes(mode)) throw new Error(`mode must be apply, dry-run or rehearse, not ${mode}`);
  const ledger = await readDataMigrationLedger(db, orgUid);
  const held = new Set(hold);
  const report = [];
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
    const context = { db, orgUid, dataDir, getState, catalogStore, now, logger, mode };
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
    const done = mode === "rehearse" ? "rehearsed" : "applied";
    report.push({ ...entry, summary: migration.summarize(plan), status: summary.changed ? done : "nothing-to-do", ...(result?.report ? { applied: result.report } : {}) });
    logger.log?.(`[data-migrations] ${migration.id}: ${summary.changed ? `${done} (${migration.describe(summary)})` : "nothing to change"}; recorded`);
  }
  return report;
}

/** FIELD_DATA_MIGRATIONS_HOLD=<id>[,<id>] or "all": an emergency stop, logged at boot. */
export function heldDataMigrations(env = process.env) {
  return String(env.FIELD_DATA_MIGRATIONS_HOLD || "").split(",").map((value) => value.trim()).filter(Boolean);
}
