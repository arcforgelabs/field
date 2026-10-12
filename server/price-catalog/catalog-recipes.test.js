import assert from "node:assert/strict";
import test from "node:test";

import { loadRecipeChildrenByParent, resetRecipeChildrenCache } from "./catalog-recipes.js";

test.afterEach(() => {
  resetRecipeChildrenCache();
});

test("quote catalog loader maps retaining and rock wall recipes to price-list items", () => {
  resetRecipeChildrenCache();
  const recipeChildren = loadRecipeChildrenByParent();

  assert.deepEqual(
    recipeChildren.get("retaining-wall").map((c) => ({
      childCode: c.childCode,
      quantity: c.quantity,
      recipeCode: c.recipeCode,
      balance: Boolean(c.balance),
    })),
    [
      { childCode: "LABOURER-HOUR", quantity: 0.8, recipeCode: "retaining-wall-execution-recipe", balance: false },
      { childCode: "EXCAVATOR-HOUR", quantity: 0.2, recipeCode: "retaining-wall-execution-recipe", balance: false },
      { childCode: "retaining-wall__materials-design-allowance", quantity: 1, recipeCode: "retaining-wall-execution-recipe", balance: true },
    ],
  );

  assert.deepEqual(
    recipeChildren.get("rock-wall").map((c) => ({
      childCode: c.childCode,
      quantity: c.quantity,
      recipeCode: c.recipeCode,
    })),
    [
      { childCode: "BLUESTONE-LARGE", quantity: 1, recipeCode: "rock-wall-estimate-recipe" },
      { childCode: "EXCAVATOR-HOUR", quantity: 0.35, recipeCode: "rock-wall-estimate-recipe" },
      { childCode: "LABOURER-HOUR", quantity: 0.45, recipeCode: "rock-wall-estimate-recipe" },
    ],
  );
});

test("quote catalog loader extracts static bulk and concrete recipe modes", () => {
  resetRecipeChildrenCache();
  const recipeChildren = loadRecipeChildrenByParent();

  // The disposal child's quantity is deferred, not a pre-baked json5
  // density — it is resolved live from the disposal item's own
  // pricing_basis / pricing_basis_factor by resolveRecipeChildQuantity()
  // once a caller has a db handle (DEL-46). See the "disposal child
  // quantity" tests below for that resolution.
  assert.deepEqual(
    recipeChildren.get("soil-removal").map((c) => ({
      childCode: c.childCode,
      quantity: c.quantity,
      quantityBasis: c.quantityBasis,
      recipeCode: c.recipeCode,
    })),
    [
      { childCode: "KANGA-HOUR", quantity: 0.2286, quantityBasis: undefined, recipeCode: "soil-removal-recipe" },
      { childCode: "unclean-fill-disposal", quantity: null, quantityBasis: "disposal_per_volume", recipeCode: "soil-removal-recipe" },
    ],
  );

  assert.deepEqual(
    recipeChildren.get("concrete-surface-demolition").map((c) => ({
      childCode: c.childCode,
      quantity: c.quantity,
      recipeCode: c.recipeCode,
    })),
    [
      { childCode: "EXCAVATOR-HOUR", quantity: 0.0667, recipeCode: "concrete-surface-demolition-recipe" },
      { childCode: "JACKHAMMER-HOUR", quantity: 0.0667, recipeCode: "concrete-surface-demolition-recipe" },
    ],
  );

  assert.deepEqual(
    recipeChildren.get("concrete-removal").map((c) => ({
      childCode: c.childCode,
      quantity: c.quantity,
      quantityBasis: c.quantityBasis,
      recipeCode: c.recipeCode,
    })),
    [
      { childCode: "KANGA-HOUR", quantity: 0.8696, quantityBasis: undefined, recipeCode: "concrete-removal-recipe" },
      { childCode: "concrete-waste-disposal", quantity: null, quantityBasis: "disposal_per_volume", recipeCode: "concrete-removal-recipe" },
    ],
  );

  assert.deepEqual(
    recipeChildren.get("tree-supply-install").map((c) => ({
      childCode: c.childCode,
      quantity: c.quantity,
      recipeCode: c.recipeCode,
      balance: Boolean(c.balance),
    })),
    [
      { childCode: "tree-supply-install__stock-materials", quantity: 1, recipeCode: "tree-supply-install-recipe", balance: true },
      { childCode: "LABOURER-HOUR", quantity: 0.35, recipeCode: "tree-supply-install-recipe", balance: false },
      { childCode: "VEHICLE-HOUR", quantity: 0.08, recipeCode: "tree-supply-install-recipe", balance: false },
    ],
  );
});

// DEL-46: the disposal child in a bulk_loading_disposal recipe defers its
// quantity to the disposal item's own pricing_basis / pricing_basis_factor
// instead of a json5 density baked in at recipe-parse time. These tests
// prove the catalogue's own price build-up (not just the quote path) reads
// that single owner live, and fails closed when it can't be resolved.
