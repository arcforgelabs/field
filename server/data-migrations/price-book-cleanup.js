// Code retirement step 5 (#178): the price book clean-up, applied once at
// boot in ONE catalogue transaction behind the price-equality gate.
//
// The plan (price-book-cleanup.plan.json, next to this file) is built from an
// installation's own catalogue export and review. It holds no prices.
// It sets each item's name, type and category; creates the category tree;
// merges a duplicate into its original; flattens kits (a kit made of one
// resource, or a kit below a sold kit's second level, is folded into the kits
// that use it, its quantities multiplied through); adds per-metre wall rates;
// and archives items no kit and no pricing rule uses. Every change is made
// only where the item is still exactly as reviewed: an item renamed or
// re-categorised in the app since, or a kit row whose quantity has changed, is
// left alone and listed.
//
// Inside the transaction, after every change: every item must price exactly
// as before (comparePrices: a cent, or a millionth, is a failure), active
// names stay unique, and each new per-metre wall prices half its 2.0 m bay.
// Any failure rolls everything back and stops boot. Verification runs the
// whole thing in a transaction that is always rolled back; apply runs it
// again and commits, with its ledger row in the same transaction.
//
// A catalogue the plan was not built for (fewer than 90% of the planned items
// present: tests, the synthetic verification catalogue) has nothing to do.
// With no plan file at all the migration is deferred: it changes nothing and
// is NOT recorded, so an installation that later supplies its plan (or that
// already applied it) is unaffected.
import { existsSync, readFileSync } from "../storage/fs.js";
import { eq, sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { nameKey } from "../../shared/catalog-name-key.js";
import { buildQuoteUsageIndex } from "../catalog/usage.js";
import { capturePrices, comparePrices } from "../catalog/price.js";
import { loadCatalogState } from "../catalog/state.js";
import { recordHistory } from "../catalog/store.js";
import { DataMigrationError } from "./errors.js";

const ID = "2026-10-12-price-book-cleanup";
const AUTHOR = "price-book-clean-up (#178)";
const PLAN_PATH = new URL("./price-book-cleanup.plan.json", import.meta.url);
const PRESENT_THRESHOLD = 0.9;

const EMPTY_PLAN = Object.freeze({ id: ID, categories: [], items: {}, merges: [], flatten: [], newItems: [] });

let cachedPlan = null;
/** The committed plan, or an empty one when this installation ships none. */
export function loadCleanupPlan(path = PLAN_PATH) {
  if (path !== PLAN_PATH) return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : EMPTY_PLAN;
  cachedPlan ??= existsSync(PLAN_PATH) ? JSON.parse(readFileSync(PLAN_PATH, "utf8")) : EMPTY_PLAN;
  return cachedPlan;
}

function sameNumber(a, b) {
  return a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9;
}

function text(value) {
  return value == null ? null : String(value);
}

/**
 * Works out every change against the catalogue as it is now. Pure over the
 * state (and, for archiving, the job files: an item on a draft quote is not
 * archived).
 */
async function plan(context) {
  const source = context.cleanupPlan || loadCleanupPlan();
  if (source === EMPTY_PLAN) {
    return { deferred: true, deferredReason: "no price-book-cleanup.plan.json in this installation", applicable: false, changes: [] };
  }
  const state = await context.getState();
  const plannedUids = Object.keys(source.items);
  const present = plannedUids.filter((uid) => state.items.has(uid));
  const result = {
    catalogVersion: state.version,
    applicable: plannedUids.length > 0 && present.length >= Math.ceil(plannedUids.length * PRESENT_THRESHOLD),
    present: present.length,
    planned: plannedUids.length,
    renames: [], categoryChanges: [], typeChanges: [], notes: [], archives: [],
    merges: [], flatten: [], newItems: [], categories: [], skipped: [], changes: [],
    verification: null,
  };
  if (!result.applicable) return result;

  let usage = new Map();
  if (context.dataDir) usage = await buildQuoteUsageIndex({ dataDir: context.dataDir, state });

  for (const [uid, entry] of Object.entries(source.items)) {
    const item = state.items.get(uid);
    if (!item) { result.skipped.push({ uid, what: "item", why: "not in this catalogue" }); continue; }
    const { before, after } = entry;
    if (after.name !== item.name) {
      if (item.name === before.name) result.renames.push({ uid, from: item.name, to: after.name });
      else result.skipped.push({ uid, what: "name", why: `renamed since the review ("${before.name}" -> "${item.name}"); left as it is` });
    }
    if (after.category !== item.category) {
      if ((item.category ?? null) === (before.category ?? null)) result.categoryChanges.push({ uid, name: after.name, from: item.category, to: after.category });
      else result.skipped.push({ uid, what: "category", why: `category changed since the review ("${before.category}" -> "${item.category}"); left as it is` });
    }
    if (after.type !== item.type) {
      if (item.type == null || item.type === "kit" || item.type === after.type) result.typeChanges.push({ uid, name: after.name, from: item.type, to: after.type });
      else result.skipped.push({ uid, what: "type", why: `typed "${item.type}" since the review; left as it is` });
    }
    if (entry.notes && !item.notes) result.notes.push({ uid, name: after.name, notes: entry.notes });
    if (entry.archive && item.status === "active") {
      const drafts = [...(usage.get(uid)?.values() || [])].filter((job) => job.current && !job.sent);
      if (drafts.length) {
        result.skipped.push({ uid, what: "archive", why: `on ${drafts.length} draft quote(s) (${drafts.map((job) => job.quoteNumber || job.jobId).join(", ")}); not archived` });
      } else {
        result.archives.push({ uid, name: after.name, reason: entry.archive });
      }
    }
  }
  const components = (kitUid) => state.components.get(kitUid) || [];
  for (const merge of source.merges || []) {
    const row = components(merge.kit_uid).find((c) => c.childUid === merge.from_uid);
    if (!row || !sameNumber(row.quantity, merge.quantity)) { result.skipped.push({ uid: merge.kit_uid, what: "merge", why: "kit row changed since the review" }); continue; }
    result.merges.push(merge);
  }
  // Flatten operations are replayed in order on a working copy of the rows.
  const rows = new Map();
  for (const [kitUid, list] of state.components) rows.set(kitUid, list.map((c) => ({ ...c })));
  for (const merge of result.merges) {
    const list = rows.get(merge.kit_uid) || [];
    const from = list.find((c) => c.childUid === merge.from_uid);
    const into = list.find((c) => c.childUid === merge.to_uid);
    if (into) { into.quantity = Number(into.quantity) + Number(from.quantity); list.splice(list.indexOf(from), 1); } else from.childUid = merge.to_uid;
  }
  for (const op of source.flatten || []) {
    const list = rows.get(op.kit_uid) || [];
    const link = list.find((c) => c.childUid === op.wrapper_uid);
    const wrapperRows = rows.get(op.wrapper_uid) || [];
    const okLink = link && sameNumber(link.quantity, op.wrapper_quantity) && link.applicationMode === "proportional" && link.pricingContribution === "included";
    const okAdds = op.adds.every((add) => {
      const child = wrapperRows.find((c) => c.childUid === add.component_uid);
      if (!child || !sameNumber(Number(child.quantity) * op.wrapper_quantity, add.quantity)) return false;
      const existing = list.find((c) => c.childUid === add.component_uid);
      return add.combine ? Boolean(existing) : !existing;
    });
    if (!okLink || !okAdds) { result.skipped.push({ uid: op.kit_uid, what: "flatten", why: `kit rows changed since the review; ${state.items.get(op.wrapper_uid)?.name || op.wrapper_uid} was not folded in` }); continue; }
    list.splice(list.indexOf(link), 1);
    for (const add of op.adds) {
      const existing = list.find((c) => c.childUid === add.component_uid);
      if (existing) {
        existing.quantity = Number(existing.quantity) + add.quantity;
        if (existing.entryQuantity != null && add.entry_quantity != null) existing.entryQuantity = Number(existing.entryQuantity) + add.entry_quantity;
      } else {
        list.push({ childUid: add.component_uid, quantity: add.quantity, entryQuantity: add.entry_quantity, entryUnit: add.entry_unit, applicationMode: "proportional", pricingContribution: add.pricing_contribution, sortOrder: link.sortOrder, isNew: true });
      }
    }
    result.flatten.push(op);
  }
  // An archived item must not be left as a component of an active kit.
  const archiving = new Set(result.archives.map((a) => a.uid));
  for (const archived of [...result.archives]) {
    const users = [...rows.entries()].filter(([kitUid, list]) => list.some((c) => c.childUid === archived.uid) && !archiving.has(kitUid) && state.items.get(kitUid)?.status === "active");
    if (users.length) {
      archiving.delete(archived.uid);
      result.archives.splice(result.archives.indexOf(archived), 1);
      result.skipped.push({ uid: archived.uid, what: "archive", why: `still a component of ${users.map(([k]) => state.items.get(k)?.name).join(", ")}; not archived` });
    }
  }
  result.rows = rows;
  for (const item of source.newItems || []) {
    if (state.items.has(item.uid)) { result.skipped.push({ uid: item.uid, what: "new item", why: "already exists" }); continue; }
    if (!item.components.every((c) => state.items.has(c.component_uid))) { result.skipped.push({ uid: item.uid, what: "new item", why: "a component is missing" }); continue; }
    result.newItems.push(item);
  }
  const existingCategories = new Map(state.categories.map((c) => [c.name.toLowerCase(), c]));
  for (const category of source.categories || []) {
    const current = existingCategories.get(category.name.toLowerCase());
    const parentName = category.parent || null;
    const currentParent = current?.parent_id != null ? state.categories.find((c) => c.id === current.parent_id)?.name || null : null;
    if (!current || currentParent !== parentName || current.sort_order !== category.sort_order) result.categories.push(category);
  }
  result.changes = [
    ...result.renames.map((r) => ({ kind: "rename", uid: r.uid, from: r.from, to: r.to })),
    ...result.categoryChanges.map((r) => ({ kind: "category", uid: r.uid, name: r.name, from: r.from, to: r.to })),
    ...result.typeChanges.map((r) => ({ kind: "type", uid: r.uid, name: r.name, from: r.from, to: r.to })),
    ...result.archives.map((r) => ({ kind: "archive", uid: r.uid, name: r.name, reason: r.reason })),
    ...result.merges.map((r) => ({ kind: "merge", kit: r.kit_uid, from: r.from_uid, to: r.to_uid })),
    ...result.flatten.map((r) => ({ kind: "flatten", kit: r.kit_uid, wrapper: r.wrapper_uid, adds: r.adds.length })),
    ...result.newItems.map((r) => ({ kind: "new", uid: r.uid, name: r.name })),
    ...result.categories.map((r) => ({ kind: "category-tree", name: r.name, parent: r.parent })),
  ];
  return result;
}

/** Writes every planned change inside `tx`; returns the uids archived. */
async function execute(tx, state, planned, now) {
  const history = new Map();
  const note = (uid, field, oldValue, newValue) => {
    if (!history.has(uid)) history.set(uid, []);
    history.get(uid).push({ field, oldValue, newValue });
  };
  // Categories: the tree, parents first (the plan lists them in that order).
  const categoryId = new Map(state.categories.map((c) => [c.name.toLowerCase(), c.id]));
  for (const category of planned.categories) {
    const parentId = category.parent ? categoryId.get(category.parent.toLowerCase()) ?? null : null;
    const id = categoryId.get(category.name.toLowerCase());
    if (id != null) {
      await tx.update(schema.categories).set({ parentId, sortOrder: category.sort_order, updatedAt: now }).where(eq(schema.categories.id, id));
    } else {
      const [row] = await tx.insert(schema.categories).values({ name: category.name, parentId, sortOrder: category.sort_order, createdAt: now, updatedAt: now }).returning({ id: schema.categories.id });
      categoryId.set(category.name.toLowerCase(), row.id);
    }
  }
  const set = new Map();
  const patch = (uid, column, value) => { if (!set.has(uid)) set.set(uid, {}); set.get(uid)[column] = value; };
  for (const r of planned.renames) { patch(r.uid, "name", r.to); note(r.uid, "name", r.from, r.to); }
  for (const r of planned.categoryChanges) { patch(r.uid, "category", r.to); note(r.uid, "category", r.from, r.to); }
  for (const r of planned.typeChanges) { patch(r.uid, "type", r.to); note(r.uid, "type", r.from, r.to); }
  for (const r of planned.notes) { patch(r.uid, "notes", r.notes); note(r.uid, "notes", null, r.notes); }
  for (const r of planned.archives) { patch(r.uid, "status", "archived"); note(r.uid, "status", "active", "archived"); }
  for (const [uid, values] of set) {
    await tx.update(schema.items).set({ ...values, version: sql`${schema.items.version} + 1`, updatedAt: now }).where(eq(schema.items.uid, uid));
  }
  // Kit rows: rewrite each changed kit's rows from the replayed working copy.
  const touchedKits = new Set([...planned.merges.map((m) => m.kit_uid), ...planned.flatten.map((f) => f.kit_uid)]);
  for (const kitUid of touchedKits) {
    const before = state.components.get(kitUid) || [];
    const after = planned.rows.get(kitUid) || [];
    const beforeLabel = before.map((c) => `${Number(c.quantity)} x ${state.items.get(c.childUid)?.name}`).join("; ");
    await tx.delete(schema.itemComponents).where(eq(schema.itemComponents.parentUid, kitUid));
    for (const row of after) {
      await tx.insert(schema.itemComponents).values({
        parentUid: kitUid,
        childUid: row.childUid,
        quantity: String(Number(row.quantity)),
        entryQuantity: row.entryQuantity == null ? null : String(Number(row.entryQuantity)),
        entryUnit: row.entryUnit ?? null,
        applicationMode: row.applicationMode,
        pricingContribution: row.pricingContribution,
        sortOrder: row.sortOrder ?? 0,
        createdAt: row.createdAt ? new Date(row.createdAt) : now,
      });
    }
    const afterLabel = after.map((c) => `${Number(c.quantity)} x ${state.items.get(c.childUid)?.name}`).join("; ");
    note(kitUid, "children", beforeLabel, afterLabel);
    if (!set.has(kitUid)) await tx.update(schema.items).set({ version: sql`${schema.items.version} + 1`, updatedAt: now }).where(eq(schema.items.uid, kitUid));
  }
  for (const item of planned.newItems) {
    await tx.insert(schema.items).values({
      uid: item.uid, code: item.uid, name: item.name, notes: item.notes || null, type: item.type,
      visibility: item.sold ? "sellable" : "internal", unitCode: item.unit, category: item.category,
      costMode: "rollup", sellMode: "rollup", status: "active", version: 1, createdAt: now, updatedAt: now,
    });
    for (const [index, component] of item.components.entries()) {
      await tx.insert(schema.itemComponents).values({ parentUid: item.uid, childUid: component.component_uid, quantity: String(component.quantity), applicationMode: "proportional", pricingContribution: "included", sortOrder: index, createdAt: now });
    }
    note(item.uid, "*", null, "created");
  }
  for (const [uid, changes] of history) {
    const item = state.items.get(uid) || { uid, code: uid };
    await recordHistory(tx, { item, changes, author: AUTHOR, reason: "Price book clean-up (#178 step 5)", now });
  }
  // Categories nobody uses any more and the tree does not name go.
  const tree = new Set((planned.allCategories || []).map((name) => name.toLowerCase()));
  const used = await tx.execute(sql`select distinct lower(category) as name from items where category is not null`);
  const usedNames = new Set((Array.isArray(used) ? used : used.rows).map((row) => row.name));
  const removable = state.categories.filter((c) => !tree.has(c.name.toLowerCase()) && !usedNames.has(c.name.toLowerCase()));
  for (const category of removable) await tx.delete(schema.categories).where(eq(schema.categories.id, category.id));
  return { archived: planned.archives.map((a) => a.uid), removedCategories: removable.map((c) => c.name) };
}

/** Runs the plan in `tx` and checks the result; throws DataMigrationError (rolling back) on any failure. */
async function executeAndCheck(tx, state, planned, now) {
  const before = capturePrices(state);
  const done = await execute(tx, state, planned, now);
  const after = await loadCatalogState(tx, { now: new Date(state.now), inTransaction: true });
  const gate = comparePrices(before, capturePrices(after), { allowArchived: done.archived });
  const failures = gate.changed.map((row) => `${row.name}: ${row.change}${row.change === "price" ? ` ${JSON.stringify(row.before)} -> ${JSON.stringify(row.after)}` : ""}`);
  const names = new Map();
  for (const item of after.items.values()) {
    if (item.status !== "active") continue;
    const key = nameKey(item.name);
    if (names.has(key)) failures.push(`two active items would be named "${item.name}"`);
    names.set(key, item.uid);
  }
  const { price } = await import("../catalog/price.js");
  for (const item of planned.newItems) {
    const mine = price(after, item.uid);
    const component = item.components[0];
    const bay = price(after, component.component_uid);
    // Unpriced when its bay is (a missing price never becomes zero), else exactly its share.
    const consistent = bay?.unit_sell == null
      ? mine?.unit_sell == null
      : mine?.unit_sell != null && Math.abs(mine.unit_sell - bay.unit_sell * component.quantity) <= 1e-6;
    if (!consistent) {
      failures.push(`${item.name} does not price ${component.quantity} of its bay`);
    }
  }
  return { gate, failures, done };
}

async function verify(context, planned) {
  if (!planned.applicable || !planned.changes.length) {
    planned.verification = { ok: true, gate: null, rehearsedInTransaction: false };
    return planned.verification;
  }
  const source = context.cleanupPlan || loadCleanupPlan();
  planned.allCategories = source.categories.map((c) => c.name);
  const sentinel = new Error("rolled back on purpose");
  let outcome = null;
  try {
    await context.catalogStore.write(async (tx, state, now) => {
      outcome = await executeAndCheck(tx, state, planned, now);
      throw sentinel;
    });
  } catch (error) {
    if (error !== sentinel) throw error;
  }
  planned.verification = { ok: outcome.failures.length === 0, compared: outcome.gate.compared, failures: outcome.failures, retiredUnpriced: outcome.gate.unpricedArchived.map((row) => row.name), removedCategories: outcome.done.removedCategories };
  if (outcome.failures.length) {
    throw new DataMigrationError(`${ID}: verification failed, nothing written: ${outcome.failures.slice(0, 5).join("; ")}${outcome.failures.length > 5 ? ` (+${outcome.failures.length - 5} more)` : ""}`, { details: { failures: outcome.failures } });
  }
  return planned.verification;
}

async function apply(context, planned, { appliedAt, summary }) {
  const { recordDataMigration } = await import("./index.js");
  let report = null;
  await context.catalogStore.write(async (tx, state, now) => {
    // The catalogue may have moved between verify and apply: plan again.
    const fresh = await plan({ ...context, getState: async () => state });
    fresh.allCategories = planned.allCategories;
    if (JSON.stringify(fresh.changes) !== JSON.stringify(planned.changes)) {
      throw new DataMigrationError(`${ID}: the catalogue changed after verification; nothing written`);
    }
    const outcome = await executeAndCheck(tx, state, fresh, now);
    if (outcome.failures.length) {
      throw new DataMigrationError(`${ID}: the price gate failed while applying; rolled back: ${outcome.failures.slice(0, 5).join("; ")}`, { details: { failures: outcome.failures } });
    }
    await recordDataMigration(tx, { id: ID, summary: { ...summary, gateCompared: outcome.gate.compared }, appliedAt });
    report = { gateCompared: outcome.gate.compared, removedCategories: outcome.done.removedCategories };
    return { result: null };
  });
  return { recorded: true, report };
}

function summarize(planned) {
  return {
    changed: planned.applicable ? planned.changes.length : 0,
    applicable: planned.applicable,
    present: planned.present,
    planned: planned.planned,
    renames: planned.renames.length,
    categoryChanges: planned.categoryChanges.length,
    typeChanges: planned.typeChanges.length,
    notes: planned.notes.length,
    archives: planned.archives.length,
    merges: planned.merges.length,
    flatten: planned.flatten.length,
    newItems: planned.newItems.length,
    categoryTree: planned.categories.length,
    skipped: planned.skipped.length,
    gateCompared: planned.verification?.compared ?? null,
    catalogVersion: planned.catalogVersion,
  };
}

function describe(summary) {
  return `${summary.renames} renamed, ${summary.typeChanges} typed, ${summary.categoryChanges} re-categorised, ${summary.flatten} kit folds, ${summary.merges} merged rows, ${summary.newItems} new per-metre walls, ${summary.archives} archived; every one of ${summary.gateCompared} items prices as before; ${summary.skipped} change(s) skipped`;
}

export const priceBookCleanup = Object.freeze({
  id: ID,
  title: "Price book clean-up (code retirement step 5)",
  plan,
  verify,
  apply,
  summarize,
  describe,
});

export { plan as planPriceBookCleanup };
