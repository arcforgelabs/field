import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";

// Rows written straight to a tenant table go in as the default organisation, the store's organisation.
const asDefaultOrg = (db) => ({ execute: (query) => withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(query)) });
import { resetRecipeChildrenCache, setKnownDisposalItemCodesForTests } from "../price-catalog/catalog-recipes.js";
import { openCatalogStore } from "./index.js";
import { buildCatalogHealthReport } from "./health.js";
import { selectRows } from "./state.js";

test.afterEach(() => {
  resetRecipeChildrenCache();
});

async function freshStore(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db });
  return { store, db: handle.db };
}

// Rows the guards would refuse, written as an import or a direct edit could
// leave them, so the report has something to find.
async function insertRaw(store, db, { code, name, unit = "each", status = "active", uid = `cat_${code}`, cost = null, sell = null }) {
  await asDefaultOrg(db).execute(sql`insert into items (uid, code, name, unit_code, status, visibility, created_at, updated_at)
    values (${uid}, ${code}, ${name}, ${unit}, ${status}, 'internal', now(), now())`);
  if (cost != null || sell != null) {
    await asDefaultOrg(db).execute(sql`insert into item_prices (item_uid, cost_per_unit, sell_price, effective_from, source, changed_by, created_at)
      values (${uid}, ${cost == null ? null : String(cost)}, ${sell == null ? null : String(sell)}, now() - interval '1 day', 'migration', 'test', now())`);
  }
  store.invalidate();
}

const report = async (store, options = {}) => buildCatalogHealthReport(await store.getState(), options);

test("health surfaces catalog admin cleanup issues", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "parent", name: "Duplicate", unit: "each", buy_price: 20, sell_price: 18, category: "Goods" });
  await insertRaw(store, db, { code: "second", name: "Duplicate", cost: 4, sell: 8 });
  await store.createItem({ code: "child", name: "Child", unit: "each", buy_price: 3, sell_price: 6, category: "Materials" });
  await store.addChild({ parentCode: "parent", childCode: "child", quantity: 1 });
  await store.updateItem("child", { status: "archived" });

  const health = await report(store, { references: [] });
  assert.equal(health.summary.totalItems, 3);
  assert.equal(health.summary.missingUidCount, 0);
  assert.equal(health.summary.duplicateActiveNameCount, 1);
  assert.equal(health.summary.duplicateNamePriceMismatchCount, 1, "the two 'Duplicate' items are priced differently");
  assert.equal(health.summary.inactiveComponentDependencyCount, 1);
  assert.equal(health.summary.archivedItemInUseCount, 1);
  assert.equal(health.summary.costAboveSellCount, 1);
  assert.equal(health.checks.find((check) => check.key === "cost_above_sell")?.ok, false);
  assert.ok(health.issues.some((issue) => issue.key === "inactive_component_dependency" && issue.childCode === "child"));
  assert.ok(health.issues.some((issue) => issue.key === "archived_item_in_use" && issue.code === "child" && issue.usedBy.includes("kit parent")));
});

test("duplicate detection catches whitespace, case and NFC variants; the census lists every item", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "widget-a", name: "Café Blend" });
  await insertRaw(store, db, { code: "widget-b", name: "  CAFÉ   blend " });
  await store.createItem({ code: "gadget-a", name: "Gadget Pro" });
  await insertRaw(store, db, { code: "gadget-b", name: "Gadget Pro" });
  await store.createItem({ code: "solo", name: "Solo item", status: "archived" });
  const health = await report(store);
  assert.equal(health.duplicateCensus.groupCount, 2);
  assert.equal(health.duplicateCensus.itemCount, 4);
  assert.equal(health.duplicateCensus.safeToEnforce, false);
  assert.deepEqual(health.duplicateCensus.groups.find((group) => group.name === "Café Blend").items.map((item) => item.code).sort(), ["widget-a", "widget-b"]);
  assert.equal(health.summary.duplicateNamePriceMismatchCount, 0, "unpriced duplicates are priced the same");
});

test("missing and archived items that pricing references by code are reported, not fixed", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "SANDY-LOAM-M3", name: "Sandy loam", unit: "m3", buy_price: 50, sell_price: 70, status: "archived" });
  await store.createItem({ code: "EXCAVATOR-HOUR", name: "Excavator", unit: "hour", buy_price: 100, sell_price: 150 });
  const health = await report(store, {
    references: [
      { code: "DRAIN-PIPE-M", source: "rate card" },
      { code: "drain-pipe-m", source: "quote rule drainage" },
      { code: "SANDY-LOAM-M3", source: "quote rule lawn" },
      { code: "excavator-hour", source: "retaining wall engine" },
    ],
  });
  assert.deepEqual(health.issues.filter((issue) => issue.key === "missing_referenced_item").map((issue) => [issue.code, issue.usedBy]), [
    ["DRAIN-PIPE-M", ["quote rule drainage", "rate card"]],
  ]);
  assert.match(health.issues.find((issue) => issue.key === "missing_referenced_item").message, /does not exist/);
  assert.deepEqual(health.issues.filter((issue) => issue.key === "archived_item_in_use").map((issue) => issue.code), ["SANDY-LOAM-M3"]);
  assert.equal(health.checks.find((check) => check.key === "missing_referenced_item").severity, "critical");
  const state = await store.getState();
  assert.equal(state.items.size, 2, "the report changes nothing");
});

test("the store's health report checks the installation's real pricing references", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "only", name: "Only", buy_price: 1, sell_price: 2 });
  const health = await store.health({ catalogId: "field-verification" });
  const missing = health.issues.filter((issue) => issue.key === "missing_referenced_item").map((issue) => issue.code);
  assert.ok(missing.includes("SLEEPER-KENSINGTON"), "the wall engine's codes are checked");
  assert.ok(missing.includes("tip-truck"), "the configured quote catalog's rule codes are checked");
});

test("copy codes and component unit mismatches are reported", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "gravel", name: "Gravel", unit: "tonne", buy_price: 1, sell_price: 2 });
  await store.createItem({ code: "gravel-copy-2", name: "Gravel 2", unit: "tonne", buy_price: 1, sell_price: 2 });
  await store.createItem({ code: "kit", name: "Kit", unit: "m", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.addChild({ parentCode: "kit", childCode: "gravel", quantity: 0.2 });
  await asDefaultOrg(db).execute(sql`update kit_components set entry_quantity = 1, entry_unit = 'm'`);
  store.invalidate();
  const health = await report(store);
  assert.deepEqual(health.issues.filter((issue) => issue.key === "copy_code").map((issue) => issue.code), ["gravel-copy-2"]);
  assert.deepEqual(health.issues.filter((issue) => issue.key === "component_unit_mismatch").map((issue) => [issue.code, issue.childCode]), [["kit", "gravel"]]);
});

test("disposal costing-basis checks (DEL-46)", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "clean-fill-disposal", name: "Clean fill disposal", unit: "tonne", buy_price: 1, sell_price: 2 });
  await asDefaultOrg(db).execute(sql`update items set pricing_basis = 'per_tonne' where code = 'clean-fill-disposal'`);
  await store.createItem({ code: "volume-fill-disposal", name: "Volume fill disposal", unit: "m3", pricing_basis: "per_m3", buy_price: 1, sell_price: 2 });
  await store.createItem({ code: "unclean-fill-disposal", name: "Unclean fill disposal", unit: "tonne", buy_price: 30, pricing_basis: "per_tonne", pricing_basis_factor: 1.6 });
  await store.createItem({ code: "zero-disposal", name: "Zero disposal", unit: "tonne", buy_price: 30, sell_price: 0, pricing_basis: "per_tonne", pricing_basis_factor: 1.6 });
  await store.createItem({ code: "concrete-waste-disposal", name: "Concrete waste disposal", unit: "tonne", buy_price: 25, sell_price: 30 });
  setKnownDisposalItemCodesForTests(new Set(["unclean-fill-disposal", "concrete-waste-disposal", "green-waste-disposal"]));
  store.invalidate();

  const health = await report(store, { catalogId: "embark-default" });
  assert.deepEqual(health.issues.filter((issue) => issue.key === "incomplete_pricing_basis").map((issue) => issue.code), ["clean-fill-disposal"]);
  const noSell = health.issues.filter((issue) => issue.key === "disposal_item_missing_sell_price");
  assert.deepEqual(noSell.map((issue) => issue.code).sort(), ["unclean-fill-disposal", "zero-disposal"]);
  assert.match(noSell.find((issue) => issue.code === "zero-disposal").message, /\$0/);
  const noBasis = health.issues.filter((issue) => issue.key === "disposal_item_missing_basis");
  assert.deepEqual(noBasis.map((issue) => [issue.code, issue.missingItem]).sort(), [["concrete-waste-disposal", false], ["green-waste-disposal", true]]);
});

test("disposal checks are scoped to the installation's own quote catalog", async (t) => {
  const { store } = await freshStore(t);
  const sample = (await report(store, { catalogId: "embark-default" })).issues
    .filter((issue) => issue.key === "disposal_item_missing_basis").map((issue) => issue.code);
  assert.ok(sample.includes("unclean-fill-disposal"));
  assert.ok(!sample.some((code) => code.startsWith("verification-")));
  const verification = (await report(store, { catalogId: "field-verification" })).issues
    .filter((issue) => issue.key === "disposal_item_missing_basis").map((issue) => issue.code);
  assert.ok(verification.some((code) => code.startsWith("verification-")));
  assert.ok(!verification.includes("unclean-fill-disposal"));
});

test("the health report is strictly read-only", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "widget-a", name: "Widget Pro" });
  await insertRaw(store, db, { code: "widget-b", name: "Widget Pro" });
  const before = await selectRows(db, sql`select code, version, updated_at from items order by code`);
  const versionBefore = await store.catalogVersion();
  await store.health();
  await store.health();
  assert.deepEqual(await selectRows(db, sql`select code, version, updated_at from items order by code`), before);
  assert.deepEqual(await store.catalogVersion(), versionBefore);
});

test("the embark-default recipes' items are checked: missing items and per-tonne items used per metre are reported", async (t) => {
  const { store } = await freshStore(t);
  // Drainage's spoil allowance is per metre of trench; this disposal item is
  // sold per tonne, with no conversion, so the recipe refuses to price it.
  await store.createItem({ code: "clean-fill-disposal", name: "Clean fill disposal", unit: "tonne", buy_price: 9, sell_price: 14 });
  await store.createItem({ code: "DRAIN-PIPE-M", name: "Drainage pipe", unit: "m", buy_price: 14, sell_price: 22 });
  const health = await store.health({ catalogId: "embark-default" });

  const missing = health.issues.filter((issue) => issue.key === "missing_referenced_item");
  const pit = missing.find((issue) => issue.code === "DRAIN-PIT");
  assert.ok(pit, "a recipe component missing from the catalogue is reported");
  assert.ok(pit.usedBy.includes("recipe drainage-bundle"));
  assert.ok(missing.some((issue) => issue.code === "TURF-SUPPLY-M2" && issue.usedBy.includes("recipe lawn-bundle")));

  const mismatch = health.issues.filter((issue) => issue.key === "recipe_unit_mismatch");
  assert.deepEqual(mismatch.map((issue) => [issue.code, issue.recipe, issue.component, issue.recipeUnit, issue.unit]), [
    ["clean-fill-disposal", "drainage-bundle", "disposal", "m", "tonne"],
  ]);
  assert.match(mismatch[0].message, /per m, but it is priced per tonne/);
  assert.equal(health.summary.recipeUnitMismatchCount, 1);
  assert.equal(health.checks.find((check) => check.key === "recipe_unit_mismatch").severity, "critical");
  assert.equal((await store.getState()).items.size, 2, "the report changes nothing");
});
