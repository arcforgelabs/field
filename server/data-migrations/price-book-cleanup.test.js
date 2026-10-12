// Code retirement step 5: the price book clean-up as a boot data
// migration, behind the price-equality gate, in one transaction.
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { openCatalogStore } from "../catalog/index.js";
import { capturePrices } from "../catalog/price.js";
import { runDataMigrations } from "./index.js";
import { loadCleanupPlan, priceBookCleanup } from "./price-book-cleanup.js";

async function seed(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db });
  const make = (input) => store.createItem(input);
  const labour = await make({ code: "LABOURER-HOUR", name: "General Labour Hour", unit: "hour", buy_price: 50, sell_price: 80, category: "Labour" });
  const exc = await make({ code: "EXCAVATOR-HOUR", name: "Excavator Hour", unit: "hour", buy_price: 180, sell_price: 300, category: "Machinery" });
  const dig = await make({ name: "Retaining Wall Excavation", unit: "bay", buy_price_mode: "computed", sell_price_mode: "computed", category: "Earthworks" });
  await store.addChild({ parentCode: dig.uid, childCode: exc.uid, quantity: 0.25 });
  const construct = await make({ name: "Wall Construction", unit: "bay", buy_price_mode: "computed", sell_price_mode: "computed", category: "Walls" });
  await store.addChild({ parentCode: construct.uid, childCode: dig.uid, quantity: 1 });
  await store.addChild({ parentCode: construct.uid, childCode: labour.uid, quantity: 2 });
  const wall = await make({ name: "Retaining Wall Installation", unit: "bay", buy_price_mode: "computed", sell_price_mode: "computed", catalog_type: "goods_service", category: "Walls" });
  await store.addChild({ parentCode: wall.uid, childCode: construct.uid, quantity: 1 });
  const old = await make({ name: "Old Repair Counter", unit: "each", buy_price: 5, sell_price: 9, category: "Walls" });
  const renamed = await make({ name: "Edited Since", unit: "each", buy_price: 1, sell_price: 2, category: "Walls" });
  const items = { labour, exc, dig, construct, wall, old, renamed };
  const plan = {
    id: "test",
    categories: [
      { name: "Landscape structures", parent: null, sort_order: 0 },
      { name: "Retaining walls", parent: "Landscape structures", sort_order: 10 },
      { name: "Resources", parent: null, sort_order: 20 },
      { name: "Labour", parent: "Resources", sort_order: 30 },
      { name: "Plant & equipment", parent: "Resources", sort_order: 40 },
    ],
    items: {
      [labour.uid]: { before: { name: "General Labour Hour", category: "Labour" }, after: { name: "Labourer", type: "labour", category: "Labour" } },
      [exc.uid]: { before: { name: "Excavator Hour", category: "Machinery" }, after: { name: "Excavator, wet hire (incl. operator)", type: "equipment", category: "Plant & equipment" }, notes: "Size not recorded." },
      [dig.uid]: { before: { name: "Retaining Wall Excavation", category: "Earthworks" }, after: { name: "Retaining wall excavation, per bay", type: "kit", category: "Retaining walls" } },
      [construct.uid]: { before: { name: "Wall Construction", category: "Walls" }, after: { name: "Retaining wall construction, per bay", type: "kit", category: "Retaining walls" } },
      [wall.uid]: { before: { name: "Retaining Wall Installation", category: "Walls" }, after: { name: "Retaining wall, concrete sleeper, 1000 mm high, per 2.0 m bay", type: "kit", category: "Retaining walls" } },
      [old.uid]: { before: { name: "Old Repair Counter", category: "Walls" }, after: { name: "Retaining wall end set, repair (unused)", type: "kit", category: "Retaining walls" }, archive: "Not used by any kit." },
      [renamed.uid]: { before: { name: "Something Else", category: "Walls" }, after: { name: "Should not apply", type: "material", category: "Retaining walls" } },
    },
    merges: [],
    flatten: [{ kit_uid: construct.uid, wrapper_uid: dig.uid, wrapper_quantity: 1, adds: [{ component_uid: exc.uid, quantity: 0.25, entry_quantity: null, entry_unit: null, pricing_contribution: "included" }] }],
    newItems: [{ uid: "cat_perm000000000000000000", name: "Retaining wall, concrete sleeper, 1000 mm high, per m", type: "kit", category: "Retaining walls", unit: "m", sold: true, components: [{ component_uid: wall.uid, quantity: 0.5 }], notes: "Half a 2.0 m bay." }],
  };
  return { handle, store, items, plan };
}

const quiet = { log() {}, warn() {} };

test("the clean-up renames, types, re-categorises, folds a wrapper, adds a per-metre rate and archives, all pricing as before", async (t) => {
  const { handle, store, items, plan } = await seed(t);
  // The wrapper must be archived once nothing uses it: the plan says so.
  plan.items[items.dig.uid].archive = "Folded into the kits that used it.";
  const before = capturePrices(await store.getState({ fresh: true }));
  const context = { db: handle.db, orgUid: DEFAULT_ORG_UID, dataDir: null, getState: () => store.getState({ fresh: true }), catalogStore: store, logger: quiet, migrations: [{ ...priceBookCleanup, plan: (ctx) => priceBookCleanup.plan({ ...ctx, cleanupPlan: plan }), verify: (ctx, p) => priceBookCleanup.verify({ ...ctx, cleanupPlan: plan }, p), apply: (ctx, p, o) => priceBookCleanup.apply({ ...ctx, cleanupPlan: plan }, p, o) }] };

  const dry = await runDataMigrations({ ...context, mode: "dry-run" });
  assert.equal(dry[0].status, "would-apply");
  assert.equal(dry[0].summary.renames, 6);
  assert.equal(dry[0].summary.skipped, 1, "the item renamed since the review keeps its name (its category and type are still as reviewed, so they apply)");
  assert.equal((await store.getItem(items.wall.uid)).name, "Retaining Wall Installation", "verification wrote nothing");

  const applied = await runDataMigrations(context);
  assert.equal(applied[0].status, "applied");
  const state = await store.getState({ fresh: true });
  assert.equal(state.items.get(items.wall.uid).name, "Retaining wall, concrete sleeper, 1000 mm high, per 2.0 m bay");
  assert.equal(state.items.get(items.exc.uid).type, "equipment");
  assert.equal(state.items.get(items.exc.uid).category, "Plant & equipment");
  assert.equal(state.items.get(items.exc.uid).notes, "Size not recorded.");
  assert.equal(state.items.get(items.renamed.uid).name, "Edited Since");
  assert.equal(state.items.get(items.old.uid).status, "archived");
  assert.equal(state.items.get(items.dig.uid).status, "archived");
  assert.deepEqual((state.components.get(items.construct.uid) || []).map((c) => [state.items.get(c.childUid).name, c.quantity]).sort(), [
    ["Excavator, wet hire (incl. operator)", 0.25], ["Labourer", 2],
  ]);
  const after = capturePrices(state);
  for (const uid of [items.wall.uid, items.construct.uid, items.exc.uid, items.labour.uid]) {
    assert.equal(after.items[uid].unit_sell, before.items[uid].unit_sell);
    assert.equal(after.items[uid].unit_cost, before.items[uid].unit_cost);
  }
  assert.equal(after.items.cat_perm000000000000000000.unit_sell, before.items[items.wall.uid].unit_sell * 0.5);
  const tree = state.categories.map((c) => [c.name, c.parent_id ? state.categories.find((p) => p.id === c.parent_id).name : null]);
  assert.ok(tree.some(([name, parent]) => name === "Retaining walls" && parent === "Landscape structures"));
  assert.ok(!tree.some(([name]) => name === "Machinery"), "a category nothing uses any more is removed");
  const [ledger] = await withOrg(handle.db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select id from data_migrations`, tx));
  assert.equal(ledger.id, priceBookCleanup.id);
  const history = await withOrg(handle.db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select field, changed_by from catalog_history where item_uid = ${items.wall.uid} and field = 'name'`, tx));
  assert.deepEqual(history, [{ field: "name", changed_by: "price-book-clean-up (#178)" }]);
  assert.equal((await runDataMigrations(context))[0].status, "already-applied");
});

test("a change that would move a price is refused and nothing is written", async (t) => {
  const { handle, store, items, plan } = await seed(t);
  // Folding a wrapper with the wrong quantity changes the construction price.
  plan.flatten[0].adds[0].quantity = 0.25;
  plan.flatten[0].wrapper_quantity = 1;
  const exc = items.exc.uid;
  await store.updateChild({ parentCode: items.dig.uid, childCode: exc, quantity: 0.3 });
  const context = { db: handle.db, orgUid: DEFAULT_ORG_UID, getState: () => store.getState({ fresh: true }), catalogStore: store, logger: quiet };
  const planned = await priceBookCleanup.plan({ ...context, cleanupPlan: plan });
  assert.ok(planned.skipped.some((row) => row.what === "flatten"), "the fold is skipped when the kit rows changed");
  // Force the bad fold past the plan's check to prove the gate itself holds.
  planned.flatten.push(plan.flatten[0]);
  const rows = planned.rows.get(items.construct.uid);
  rows.splice(rows.findIndex((c) => c.childUid === items.dig.uid), 1);
  rows.push({ childUid: exc, quantity: 0.25, entryQuantity: null, entryUnit: null, applicationMode: "proportional", pricingContribution: "included", sortOrder: 0 });
  planned.changes.push({ kind: "flatten" });
  await assert.rejects(priceBookCleanup.verify({ ...context, cleanupPlan: plan }, planned), /verification failed, nothing written: .*price/);
  const state = await store.getState({ fresh: true });
  assert.equal(state.items.get(items.wall.uid).name, "Retaining Wall Installation");
  assert.ok((state.components.get(items.construct.uid) || []).some((c) => c.childUid === items.dig.uid));
});

test("a catalogue the plan was not built for has nothing to do", async (t) => {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db });
  await store.createItem({ name: "Something", unit: "each", buy_price: 1, sell_price: 2 });
  // A plan built for another catalogue: none of its items are here.
  const otherPlan = { id: "other", categories: [], merges: [], flatten: [], newItems: [], items: { cat_not_here: { before: { name: "X" }, after: { name: "Y", type: "material", category: "Z" } } } };
  const migrations = [{ ...priceBookCleanup, plan: (ctx) => priceBookCleanup.plan({ ...ctx, cleanupPlan: otherPlan }) }];
  const report = await runDataMigrations({ db: handle.db, orgUid: DEFAULT_ORG_UID, getState: () => store.getState(), catalogStore: store, logger: quiet, migrations });
  assert.equal(report[0].status, "nothing-to-do");
  assert.equal(report[0].summary.applicable, false);
});

test("with no plan file the clean-up is deferred and not recorded", async (t) => {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db });
  await store.createItem({ name: "Something", unit: "each", buy_price: 1, sell_price: 2 });
  const empty = loadCleanupPlan(new URL("./no-such-plan.json", import.meta.url));
  assert.deepEqual(Object.keys(empty.items), []);
  assert.equal(loadCleanupPlan(), empty, "no installation's price book is committed");
  const run = () => runDataMigrations({ db: handle.db, orgUid: DEFAULT_ORG_UID, getState: () => store.getState(), catalogStore: store, logger: quiet, only: [priceBookCleanup.id] });
  const report = await run();
  assert.equal(report[0].status, "deferred");
  const again = await run();
  assert.equal(again[0].status, "deferred", "not recorded, so a later plan can still apply");
});
