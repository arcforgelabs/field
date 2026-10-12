// Code retirement step 4: pricing configuration names items by uid,
// with the legacy code as the fallback; health reports what resolved how.
import assert from "node:assert/strict";
import test from "node:test";

import { createTestDb } from "../db-runtime/index.js";
import { assemblyVersion, normalizeAssemblyDefinition } from "./assemblies.js";
import { buildCatalogHealthReport } from "./health.js";
import { openCatalogStore } from "./index.js";
import { resolveItemRef, withoutItemUids } from "./refs.js";
import { componentsOf } from "./rollup.js";
import { buildPriceCatalogAuthoritySnapshot, overlayQuoteCatalogsFromPriceCatalog } from "../price-catalog/catalog-pricing.js";
import { catalogPricingReferences } from "../price-catalog/catalog-references.js";
import { recipeUidKey } from "../price-catalog/catalog-recipes.js";
import { WALL_RATE_CARD_ITEMS, WALL_RATE_CARD_ITEM_UIDS } from "../retaining-wall-items.js";

const EXCAVATOR_UID = WALL_RATE_CARD_ITEM_UIDS.excavator;

async function store(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  return openCatalogStore({ db: handle.db });
}

function quoteCatalog(rule) {
  return { verify: { id: "verify", rules: [{ code: "excavator-hour", label: "Excavator", quantityUnit: "hour", ...rule }] } };
}

test("a reference resolves by uid first, then by legacy code, and flags a uid and code that disagree", async (t) => {
  const s = await store(t);
  const byUid = await s.createItem({ uid: EXCAVATOR_UID, code: "EXC-RENAMED", name: "Excavator, wet hire", unit: "hour", buy_price: 180, sell_price: 300 });
  const other = await s.createItem({ code: "EXCAVATOR-HOUR", name: "Another item", unit: "hour", buy_price: 1, sell_price: 2 });
  const state = await s.getState();
  assert.deepEqual(resolveItemRef(state, { uid: EXCAVATOR_UID, code: "EXCAVATOR-HOUR" }), { item: state.items.get(byUid.uid), by: "uid", conflict: true });
  assert.equal(resolveItemRef(state, { uid: "cat_missing", code: "excavator-hour" }).item.uid, other.uid);
  assert.equal(resolveItemRef(state, { uid: "cat_missing", code: "excavator-hour" }).by, "code");
  assert.deepEqual(resolveItemRef(state, { uid: "cat_missing", code: "nope" }), { item: null, by: null, conflict: false });

  // A rule prices from the item its uid names, not the one that has its old code.
  const { quoteCatalogs } = overlayQuoteCatalogsFromPriceCatalog(quoteCatalog({ authorityItemCode: "EXCAVATOR-HOUR", authorityItemUid: EXCAVATOR_UID }), state);
  assert.equal(quoteCatalogs.verify.rules[0].priceCatalog.sellPrice, 300);
  // Without a uid it falls back to the code.
  const { quoteCatalogs: fallback } = overlayQuoteCatalogsFromPriceCatalog(quoteCatalog({ authorityItemCode: "EXCAVATOR-HOUR" }), state);
  assert.equal(fallback.verify.rules[0].priceCatalog.sellPrice, 2);
});

test("health counts items named only by code and uid/code conflicts", async (t) => {
  const s = await store(t);
  await s.createItem({ uid: EXCAVATOR_UID, code: "EXCAVATOR-HOUR", name: "Excavator", unit: "hour", buy_price: 180, sell_price: 300 });
  await s.createItem({ code: "LABOURER-HOUR", name: "Labourer", unit: "hour", buy_price: 50, sell_price: 80 });
  const state = await s.getState();
  const report = buildCatalogHealthReport(state, {
    references: [
      { uid: EXCAVATOR_UID, code: "EXCAVATOR-HOUR", source: "rate card" },
      { uid: null, code: "excavator-hour", source: "quote rules" },
      { uid: null, code: "LABOURER-HOUR", source: "rate card" },
    ],
  });
  assert.equal(report.summary.referenceByCodeCount, 1, "the excavator is also named by uid; the labourer only by code");
  assert.equal(report.issues.find((issue) => issue.key === "reference_by_code").name, "Labourer");
  assert.equal(report.summary.referenceUidCodeConflictCount, 0);
  assert.equal(report.summary.missingReferencedItemCount, 0);
});

test("embark-default and the wall engine declare a uid for every item production has", () => {
  const references = catalogPricingReferences("embark-default");
  const withoutUid = [...new Set(references.filter((ref) => !ref.uid).map((ref) => ref.code))].sort();
  // These have no production item (health already lists them as missing).
  assert.deepEqual(withoutUid, ["APC-DELIVERY-MINIMUM", "DRAIN-GRAVEL-M", "DRAIN-PIPE-M", "DRAIN-PIT", "concrete-demolition"]);
  assert.equal(Object.keys(WALL_RATE_CARD_ITEM_UIDS).length, Object.keys(WALL_RATE_CARD_ITEMS).length - 1);
});

test("declaring uids changes neither the authority digest nor a recipe's version", async (t) => {
  const s = await store(t);
  await s.createItem({ code: "EXCAVATOR-HOUR", name: "Excavator", unit: "hour", buy_price: 180, sell_price: 300 });
  const state = await s.getState();
  const plain = buildPriceCatalogAuthoritySnapshot(state, { quoteCatalogs: quoteCatalog({ authorityItemCode: "EXCAVATOR-HOUR" }) });
  const declared = buildPriceCatalogAuthoritySnapshot(state, { quoteCatalogs: quoteCatalog({ authorityItemCode: "EXCAVATOR-HOUR", authorityItemUid: "cat_not_here" }) });
  assert.equal(declared.snapshotDigest, plain.snapshotDigest);
  assert.deepEqual(withoutItemUids({ a: [{ itemUid: "x", itemCode: "y" }], outputItemUid: "z" }), { a: [{ itemCode: "y" }] });

  const raw = { code: "lawn", mode: "lawn_bundle", params: [{ name: "area_m2", type: "number", default: 1 }], components: [{ key: "turf", itemCode: "TURF", unit: "m2", qty: "area_m2" }] };
  const withUid = { ...raw, components: [{ ...raw.components[0], itemUid: "cat_turf" }] };
  assert.equal(assemblyVersion(normalizeAssemblyDefinition(withUid, "test")), assemblyVersion(normalizeAssemblyDefinition(raw, "test")));
  assert.equal(normalizeAssemblyDefinition(withUid, "test").components[0].itemUid, "cat_turf");
});

test("a kit's recipe is found by the kit's uid and its components by theirs", async (t) => {
  const s = await store(t);
  const kit = await s.createItem({ code: "KIT-RENAMED", name: "Kit", unit: "each", buy_price_mode: "computed", sell_price_mode: "computed" });
  const part = await s.createItem({ code: "PART-RENAMED", name: "Part", unit: "each", buy_price: 4, sell_price: 6 });
  const state = await s.getState();
  const recipes = new Map([[recipeUidKey(kit.uid), [{ childCode: "OLD-PART-CODE", childUid: part.uid, quantity: 3, source: "recipe" }]]]);
  const components = componentsOf(state, state.items.get(kit.uid), recipes);
  assert.equal(components.length, 1);
  assert.equal(components[0].childUid, part.uid);
});
