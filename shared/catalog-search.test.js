import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalogQuickSearchModel,
  clampCatalogSearchSelection,
  filterCatalogItems,
  getCatalogSearchResultId,
  getSelectedCatalogSearchItem,
  moveCatalogSearchSelection,
  searchCatalogItems,
} from "./catalog-search.js";

function catalogItem(overrides = {}) {
  return {
    uid: "cat-default",
    code: "default-item",
    name: "Default item",
    unit: "each",
    category: null,
    catalog_type: "component",
    status: "active",
    ...overrides,
  };
}

test("quick-search production model keeps every eligible match beyond the display window", () => {
  const items = Array.from({ length: 12 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return catalogItem({
      uid: `cat-drain-${number}`,
      code: `drain-${number}`,
      name: `Drain ${number}`,
    });
  }).reverse();

  const results = buildCatalogQuickSearchModel(items, "drain").results;

  assert.equal(results.length, 12);
  assert.deepEqual(results.map((item) => item.code), [
    "drain-01",
    "drain-02",
    "drain-03",
    "drain-04",
    "drain-05",
    "drain-06",
    "drain-07",
    "drain-08",
    "drain-09",
    "drain-10",
    "drain-11",
    "drain-12",
  ]);
});

test("identical catalogue queries return the same ordered result set", () => {
  const items = [
    catalogItem({ uid: "cat-3", code: "pump-b", name: "Drain pump" }),
    catalogItem({ uid: "cat-1", code: "pump-a", name: "Drain pump" }),
    catalogItem({ uid: "cat-2", code: "pump-c", name: "Drain pump installation" }),
  ];

  const first = searchCatalogItems(items, "  DRAIN   PUMP ").map((item) => item.code);
  const second = searchCatalogItems(items, "  DRAIN   PUMP ").map((item) => item.code);

  assert.deepEqual(first, ["pump-a", "pump-b", "pump-c"]);
  assert.deepEqual(second, first);
  assert.deepEqual(items.map((item) => item.code), ["pump-b", "pump-a", "pump-c"]);
});

test("full exact matches rank ahead of partial matches", () => {
  const results = searchCatalogItems([
    catalogItem({ code: "drainage-install", name: "Drainage installation" }),
    catalogItem({ code: "drain-cleaning", name: "Drain cleaning" }),
    catalogItem({ code: "drain", name: "Stormwater work" }),
    catalogItem({ code: "french-drain", name: "French drain" }),
  ], "drain");

  assert.deepEqual(results.map((item) => item.code), [
    "drain",
    "drain-cleaning",
    "drainage-install",
    "french-drain",
  ]);
});

test("multi-term matching searches all eligible fields and requires every term", () => {
  const results = searchCatalogItems([
    catalogItem({ code: "drain-pump", name: "High capacity", category: "Stormwater" }),
    catalogItem({ code: "drain-pump-direct", name: "Drain pump" }),
    catalogItem({ code: "drain-only", name: "Drainage", category: "Stormwater" }),
    catalogItem({ code: "other", name: "Pump", category: "Stormwater" }),
  ], "drain pump");

  assert.deepEqual(results.map((item) => item.code), ["drain-pump-direct", "drain-pump"]);
});

test("code, UID, unit, category, and kind label are eligible search fields", () => {
  const items = [
    catalogItem({ code: "code-match", name: "Other" }),
    catalogItem({ uid: "uid-match", code: "other-uid", name: "Other" }),
    catalogItem({ code: "other-name", name: "Name match" }),
    catalogItem({ code: "other-unit", name: "Other", unit: "hour" }),
    catalogItem({ code: "other-category", name: "Other", category: "Category match" }),
    catalogItem({ code: "other-kind", name: "Other", catalog_type: "goods_service" }),
  ];

  for (const [query, code] of [
    ["code-match", "code-match"],
    ["uid-match", "other-uid"],
    ["name match", "other-name"],
    ["hour", "other-unit"],
    ["category match", "other-category"],
    ["goods service", "other-kind"],
  ]) {
    assert.deepEqual(searchCatalogItems(items, query).map((item) => item.code), [code]);
  }
});

test("equal names use code and UID tie breakers", () => {
  const results = searchCatalogItems([
    catalogItem({ uid: "cat-z", code: "same-z", name: "Same name" }),
    catalogItem({ uid: "cat-a", code: "same-a", name: "Same name" }),
    catalogItem({ uid: "cat-b", code: "same-b", name: "Same name" }),
  ], "same name");

  assert.deepEqual(results.map((item) => item.code), ["same-a", "same-b", "same-z"]);
});

test("flat price-catalog list keeps an eligible nested child row available", () => {
  // The list endpoint returns one row per persisted item. The detail endpoint
  // adds children, but the search boundary receives this flat list.
  const flatListResponse = [
    catalogItem({
      uid: "cat-parent",
      code: "drain-package",
      name: "Drain package",
      category: "Drainage",
      child_count: 1,
    }),
    catalogItem({
      uid: "cat-nested-child",
      code: "nested-drain-child",
      name: "Nested drain valve",
      category: "Drainage",
    }),
    catalogItem({
      uid: "cat-archived",
      code: "nested-drain-archived",
      name: "Nested drain archived",
      category: "Drainage",
      status: "archived",
    }),
  ];

  const results = filterCatalogItems(
    flatListResponse,
    { status: "active", category: "Drainage", search: "nested drain" },
  );

  assert.deepEqual(results.map((item) => item.code), ["nested-drain-child"]);
});

test("workspace and client API boundaries share filtering and blank-query policy", () => {
  const items = [
    catalogItem({ uid: "cat-child", code: "drain-child", name: "Drain valve", category: "Drainage" }),
    catalogItem({ uid: "cat-parent", code: "drain-package", name: "Drain package", category: "Drainage" }),
    catalogItem({ uid: "cat-other", code: "drain-other", name: "Drain other", category: "Other" }),
    catalogItem({ uid: "cat-archived", code: "drain-archived", name: "Drain archived", category: "Drainage", status: "archived" }),
  ];
  const workspaceInput = items.filter((item) => item.status === "active" && item.category === "Drainage");
  const workspaceResults = searchCatalogItems(workspaceInput, "drain");
  const apiResults = filterCatalogItems(items, { status: "active", category: "Drainage", search: "drain" });
  const quickBlankResults = buildCatalogQuickSearchModel(workspaceInput, "").results;
  const apiBlankResults = filterCatalogItems(items, { status: "active", category: "Drainage" });

  assert.deepEqual(workspaceResults.map((item) => item.code), apiResults.map((item) => item.code));
  assert.deepEqual(quickBlankResults.map((item) => item.code), apiBlankResults.map((item) => item.code));
  assert.equal(quickBlankResults.length, 2);
});

test("quick-search selection clamps, moves through complete results, and targets Enter's item", () => {
  const items = Array.from({ length: 12 }, (_, index) => catalogItem({
    uid: "cat-selection-" + index,
    code: "selection-" + String(index + 1).padStart(2, "0"),
    name: "Selection " + String(index + 1).padStart(2, "0"),
  }));
  const results = buildCatalogQuickSearchModel(items, "selection").results;

  assert.equal(results.length, 12);
  assert.equal(clampCatalogSearchSelection(-4, results.length), 0);
  assert.equal(clampCatalogSearchSelection(99, results.length), 11);

  let selectedIndex = 0;
  for (let step = 0; step < 20; step += 1) {
    selectedIndex = moveCatalogSearchSelection(selectedIndex, results.length, "next");
  }
  assert.equal(selectedIndex, 11);
  selectedIndex = moveCatalogSearchSelection(selectedIndex, results.length, "previous");
  assert.equal(selectedIndex, 10);
  assert.equal(getSelectedCatalogSearchItem(results, selectedIndex)?.code, "selection-11");
  assert.equal(getSelectedCatalogSearchItem(results, 99)?.code, "selection-12");
  assert.equal(getSelectedCatalogSearchItem([], 0), null);
});

test("quick-search result identities prefer UID and preserve exact code fallback", () => {
  const uidItems = [
    catalogItem({ code: "drain.valve", uid: "cat-drain-dot" }),
    catalogItem({ code: "drain-valve", uid: "cat-drain-dash" }),
    catalogItem({ code: "DRAIN VALVE", uid: "cat-drain-spaced" }),
  ];
  const uidIds = uidItems.map((item) => getCatalogSearchResultId(item));

  assert.deepEqual(uidIds, [
    "catalog-search-result-uid-cat-drain-dot",
    "catalog-search-result-uid-cat-drain-dash",
    "catalog-search-result-uid-cat-drain-spaced",
  ]);

  const codeOnlyItems = [
    catalogItem({ code: "drain.valve", uid: null }),
    catalogItem({ code: "drain-valve", uid: undefined }),
    catalogItem({ code: "DRAIN VALVE", uid: "" }),
  ];
  const codeOnlyIds = codeOnlyItems.map((item) => getCatalogSearchResultId(item));

  assert.deepEqual(codeOnlyIds, [
    "catalog-search-result-code-drain.valve",
    "catalog-search-result-code-drain-valve",
    "catalog-search-result-code-DRAIN%20VALVE",
  ]);
  assert.equal(new Set(codeOnlyIds).size, 3);
  assert.equal(getCatalogSearchResultId(uidItems[0]), getCatalogSearchResultId({ ...uidItems[0] }));
});
