// The one kit roll-up over recipe and DB components, and the pricing
// projections built on it (price maps, quote-catalog overlay).
import assert from "node:assert/strict";
import test from "node:test";

import { createTestDb } from "../db-runtime/index.js";
import { fetchPriceMapsFromCatalog, overlayQuoteCatalogsFromPriceCatalog } from "../price-catalog/catalog-pricing.js";
import { resetRecipeChildrenCache, setRecipeChildrenByParentForTests } from "../price-catalog/catalog-recipes.js";
import { openCatalogStore } from "./index.js";

test.afterEach(() => {
  resetRecipeChildrenCache();
});

async function freshStore(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  return openCatalogStore({ db: handle.db });
}

async function item(store, { code, name = code, unit = "hour", buyPrice = null, sellPrice = null, mode = "manual", ...rest }) {
  return store.createItem({
    code,
    name,
    unit,
    buy_price: buyPrice,
    sell_price: sellPrice,
    buy_price_mode: mode,
    sell_price_mode: mode,
    ...rest,
  });
}

async function siteLevellingWorld(store, { mode = "manual" } = {}) {
  await item(store, { code: "excavator-hour", buyPrice: 180, sellPrice: 300 });
  await item(store, { code: "mini-loader-hour", buyPrice: 90, sellPrice: 150 });
  await item(store, { code: "site-levelling", unit: "m3", buyPrice: 78.75, sellPrice: 131.25, mode });
}

function injectSiteLevellingRecipe() {
  setRecipeChildrenByParentForTests(new Map([["site-levelling", [
    { childCode: "excavator-hour", quantity: 0.375, source: "recipe", recipeCode: "site-levelling-recipe" },
    { childCode: "mini-loader-hour", quantity: 0.125, source: "recipe", recipeCode: "site-levelling-recipe" },
  ]]]));
}

test("recipe children drive computed sell/buy for items with no DB children", async (t) => {
  const store = await freshStore(t);
  await siteLevellingWorld(store, { mode: "computed" });
  injectSiteLevellingRecipe();
  const { buyMap, sellMap } = fetchPriceMapsFromCatalog(await store.getState());
  assert.equal(sellMap["site-levelling"], 131.25);
  assert.equal(buyMap["site-levelling"], 78.75);
});

test("updating a child rate flows through the recipe on next read", async (t) => {
  const store = await freshStore(t);
  await siteLevellingWorld(store, { mode: "computed" });
  injectSiteLevellingRecipe();
  await store.updateItem("excavator-hour", { sell_price: 320 });
  const { sellMap } = fetchPriceMapsFromCatalog(await store.getState());
  assert.equal(sellMap["site-levelling"], 138.75);
});

test("manual mode ignores the recipe (operator override wins)", async (t) => {
  const store = await freshStore(t);
  await siteLevellingWorld(store, { mode: "manual" });
  injectSiteLevellingRecipe();
  await store.updateItem("site-levelling", { sell_price: 99 });
  assert.equal(fetchPriceMapsFromCatalog(await store.getState()).sellMap["site-levelling"], 99);
});

test("DB children take precedence over recipe children", async (t) => {
  const store = await freshStore(t);
  await siteLevellingWorld(store, { mode: "computed" });
  await store.addChild({ parentCode: "site-levelling", childCode: "excavator-hour", quantity: 1 });
  injectSiteLevellingRecipe();
  assert.equal(fetchPriceMapsFromCatalog(await store.getState()).sellMap["site-levelling"], 300);
});

test("recipe codes match catalogue codes case-insensitively, and a missing child fails the recipe closed", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "EXCAVATOR-HOUR", buyPrice: 180, sellPrice: 300 });
  await item(store, { code: "KANGA-HOUR", buyPrice: 90, sellPrice: 150 });
  await item(store, { code: "SITE-LEVELLING", unit: "m3", mode: "computed" });
  await item(store, { code: "other-levelling", unit: "m3", mode: "computed" });
  setRecipeChildrenByParentForTests(new Map([
    ["site-levelling", [
      { childCode: "EXCAVATOR-HOUR", quantity: 0.375, source: "recipe", recipeCode: "r" },
      { childCode: "kanga-hour", quantity: 0.125, source: "recipe", recipeCode: "r" },
    ]],
    ["other-levelling", [
      { childCode: "excavator-hour", quantity: 1, source: "recipe", recipeCode: "r" },
      { childCode: "not-in-catalogue", quantity: 1, source: "recipe", recipeCode: "r" },
    ]],
  ]));
  const { sellMap, buyMap } = fetchPriceMapsFromCatalog(await store.getState());
  assert.equal(sellMap["SITE-LEVELLING"], 131.25);
  assert.equal(buyMap["SITE-LEVELLING"], 78.75);
  assert.equal(sellMap["other-levelling"] ?? null, null);
  const detail = await store.getItem("SITE-LEVELLING");
  assert.deepEqual(detail.children.map((child) => [child.code, child.quantity, child.source]), [
    ["EXCAVATOR-HOUR", 0.375, "recipe"],
    ["KANGA-HOUR", 0.125, "recipe"],
  ]);
  assert.equal(detail.effective_sell_price, 131.25);
});

test("recipe balance line reconciles displayed buildup to the parent sell price", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "LABOURER-HOUR", buyPrice: 50, sellPrice: 80 });
  await item(store, { code: "EXCAVATOR-HOUR", buyPrice: 180, sellPrice: 300 });
  await item(store, { code: "retaining-wall", unit: "m", sellPrice: 420 });
  setRecipeChildrenByParentForTests(new Map([["retaining-wall", [
    { childCode: "LABOURER-HOUR", quantity: 0.8, source: "recipe", recipeCode: "rw" },
    { childCode: "EXCAVATOR-HOUR", quantity: 0.2, source: "recipe", recipeCode: "rw" },
    { childCode: "retaining-wall__materials-design-allowance", quantity: 1, source: "recipe", recipeCode: "rw", balance: true, synthetic: true, name: "Retaining wall materials/design allowance", unit: "m" },
  ]]]));
  const detail = await store.getItem("retaining-wall");
  assert.deepEqual(detail.children.map((child) => [child.code, child.quantity, child.sell_price, Boolean(child.balance)]), [
    ["LABOURER-HOUR", 0.8, 80, false],
    ["EXCAVATOR-HOUR", 0.2, 300, false],
    ["retaining-wall__materials-design-allowance", 1, 296, true],
  ]);
  assert.equal(detail.children.reduce((sum, child) => sum + child.quantity * child.sell_price, 0), 420);
});

test("a disposal child's quantity comes live from the disposal item's costing basis; none fails closed", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "KANGA-HOUR", buyPrice: 90, sellPrice: 150 });
  await item(store, { code: "disposal", unit: "tonne", buyPrice: 30, sellPrice: 36 });
  await item(store, { code: "soil-removal-test", unit: "m3", mode: "computed" });
  setRecipeChildrenByParentForTests(new Map([["soil-removal-test", [
    { childCode: "KANGA-HOUR", quantity: 0.2, source: "recipe", recipeCode: "s" },
    { childCode: "disposal", quantity: null, source: "recipe", recipeCode: "s", quantityBasis: "disposal_per_volume" },
  ]]]));
  assert.equal(fetchPriceMapsFromCatalog(await store.getState()).sellMap["soil-removal-test"] ?? null, null);

  await store.updateItem("disposal", { pricing_basis: "per_tonne", pricing_basis_factor: 1.6 });
  const first = fetchPriceMapsFromCatalog(await store.getState());
  assert.equal(first.buyMap["soil-removal-test"], 0.2 * 90 + 1.6 * 30);
  assert.equal(first.sellMap["soil-removal-test"], 0.2 * 150 + 1.6 * 36);
  await store.updateItem("disposal", { pricing_basis_factor: 2 });
  assert.equal(fetchPriceMapsFromCatalog(await store.getState()).sellMap["soil-removal-test"], 0.2 * 150 + 2 * 36);
});

test("the quote-catalog overlay carries roll-up prices and flags inactive components", async (t) => {
  const store = await freshStore(t);
  await siteLevellingWorld(store, { mode: "computed" });
  injectSiteLevellingRecipe();
  await item(store, { code: "leaf", name: "Leaf", buyPrice: 5, sellPrice: 8 });
  await item(store, { code: "parent", name: "Parent", mode: "computed" });
  await store.addChild({ parentCode: "parent", childCode: "leaf", quantity: 1 });
  await store.archiveItem("leaf");
  const quoteCatalogs = {
    "embark-default": {
      rules: [
        { code: "site-levelling", authorityItemCode: "site-levelling" },
        { code: "parent", authorityItemCode: "parent" },
        { code: "missing-rule" },
      ],
    },
  };
  const { status } = overlayQuoteCatalogsFromPriceCatalog(quoteCatalogs, await store.getState());
  const [siteLevelling, parent, missing] = quoteCatalogs["embark-default"].rules;
  assert.equal(siteLevelling.priceCatalog.sellPrice, 131.25);
  assert.equal(siteLevelling.authorityPricing.buyingRate, 78.75);
  assert.equal(parent.priceCatalog.inactiveComponentCount, 1);
  assert.deepEqual(parent.priceCatalog.inactiveComponents, [{ code: "leaf", name: "Leaf", status: "archived" }]);
  assert.equal(parent.priceCatalog.sellPrice, null);
  assert.equal(parent.authorityPricing.missingItem, true);
  assert.equal(missing.priceCatalog, null);
  assert.deepEqual(status.missingCodes.sort(), ["missing-rule", "parent"]);
});
