// Golden fixtures: the lawn, irrigation and drainage recipes, now assemblies
// priced from a real catalogue, reproduce exactly the quantities (and, at the
// same catalogue rates, the prices) the hardcoded recipes produced at
// 52fc3e9. See fixtures/assembly-golden.capture.mjs for how the golden file
// was captured from that checkout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildPriceCatalogSnapshot } from "../price-catalog/catalog-snapshot.js";
import { compileQuoteCommercialBreakdown } from "../quote-commercial-compiler.js";
import { createTestPriceCatalog } from "../test-price-catalog.js";
import { GOLDEN_CASES, GOLDEN_PRICES, GOLDEN_UNITS, projectBreakdown } from "./fixtures/assembly-golden.cases.mjs";

const CAPTURED = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/assembly-golden.json"), "utf8"));

// The one deliberate difference from the captured 52fc3e9 output: the
// hardcoded recipes labelled the admin fee and irrigation controllers "job"
// whatever unit the catalogue sold them in. The production catalogue sells
// all three "each" (job and each do not convert), so the assemblies declare
// "each". Quantities and prices are unchanged; only this label moves.
const UNIT_RELABELS = Object.freeze({
  "ADMIN-FEE": { from: "job", to: "each" },
  "IRRIGATION-CONTROLLER-BATTERY": { from: "job", to: "each" },
  "IRRIGATION-CONTROLLER-MAINS": { from: "job", to: "each" },
});
const relabel = (line) => {
  const change = UNIT_RELABELS[line.itemCode];
  return change && line.unit === change.from ? { ...line, unit: change.to } : line;
};
const GOLDEN = {
  ...CAPTURED,
  cases: CAPTURED.cases.map((entry) => ({
    ...entry,
    lines: entry.lines.map(relabel),
    materialOrders: entry.materialOrders.map(relabel),
  })),
};

// The quote rules' own items, so lines the recipes leave as direct
// pass-through (a plain lawn line) price too.
const RULE_ITEMS = [
  { code: "lawn-supply-prep-install", name: "Lawn (golden)", unit: "m2", buy_price: 44.58, sell_price: 60 },
  { code: "irrigation-system-install", name: "Irrigation (golden)", unit: "m2", buy_price: 50, sell_price: 70 },
  { code: "drainage", name: "Drainage (golden)", unit: "m", buy_price: 100, sell_price: 150 },
];

function goldenItems({ units = GOLDEN_UNITS, omit = [] } = {}) {
  return [
    ...Object.entries(GOLDEN_PRICES)
      .filter(([code]) => !omit.includes(code))
      .map(([code, [buy, sell]]) => ({ code, name: `${code} (golden)`, unit: units[code], buy_price: buy, sell_price: sell })),
    ...RULE_ITEMS,
  ];
}

async function compileWith(catalog, testCase) {
  const snapshot = buildPriceCatalogSnapshot(await catalog.store.getState(), { quoteCatalogId: "embark-default" });
  const result = compileQuoteCommercialBreakdown({
    quote: { lineItems: [testCase.lineItem], summary: testCase.summary || null },
    quoteCatalog: snapshot.quoteCatalog,
    recipePricing: snapshot.recipePricing,
  });
  return result.lineItemBreakdowns[0];
}

test("assembly recipes reproduce the hardcoded recipes' quantities and prices exactly", async (t) => {
  const catalog = await createTestPriceCatalog({ items: goldenItems() });
  t.after(() => catalog.close());
  assert.equal(GOLDEN.cases.length, GOLDEN_CASES.length);
  for (const [index, testCase] of GOLDEN_CASES.entries()) {
    const expected = GOLDEN.cases[index];
    assert.equal(expected.name, testCase.name);
    const breakdown = await compileWith(catalog, testCase);
    assert.deepEqual(projectBreakdown(breakdown), { recipe: expected.recipe, lines: expected.lines, materialOrders: expected.materialOrders }, testCase.name);
    assert.deepEqual(breakdown.pricingIssues, [], testCase.name);
  }
});

test("a recipe component sold per tonne cannot price a per-metre component: the drainage line fails closed naming the item", async (t) => {
  const catalog = await createTestPriceCatalog({ items: goldenItems({ units: { ...GOLDEN_UNITS, "clean-fill-disposal": "tonne" } }) });
  t.after(() => catalog.close());
  const drainage = GOLDEN_CASES.find((testCase) => testCase.name === "drainage 10 m trench");
  const breakdown = await compileWith(catalog, drainage);
  assert.equal(breakdown.recipe, "drainage_bundle");
  assert.deepEqual(breakdown.commercialLines, []);
  assert.equal(breakdown.totals.charge, null);
  assert.equal(breakdown.pricingIssues.length, 1);
  assert.match(breakdown.pricingIssues[0].message, /clean-fill-disposal \(clean-fill-disposal \(golden\)\) per m, but it is priced per tonne/);
  assert.match(breakdown.pricingIssues[0].message, /no conversion/);
});

test("a missing or archived recipe item fails the recipe closed with the item named, never a zero", async (t) => {
  const missing = await createTestPriceCatalog({ items: goldenItems({ omit: ["DRAIN-PIT"] }) });
  t.after(() => missing.close());
  const drainage = GOLDEN_CASES.find((testCase) => testCase.name === "drainage 25.5 m trench");
  const missingBreakdown = await compileWith(missing, drainage);
  assert.deepEqual(missingBreakdown.commercialLines, []);
  assert.match(missingBreakdown.pricingIssues[0].message, /uses DRAIN-PIT, which is not in the price catalogue/);

  const archived = await createTestPriceCatalog({ items: goldenItems() });
  t.after(() => archived.close());
  await archived.store.archiveItem("TURF-SUPPLY-M2", { author: "test" });
  const lawn = GOLDEN_CASES.find((testCase) => testCase.name === "lawn option 23 m2");
  const archivedBreakdown = await compileWith(archived, lawn);
  assert.deepEqual(archivedBreakdown.commercialLines, []);
  assert.match(archivedBreakdown.pricingIssues[0].message, /TURF-SUPPLY-M2 \(TURF-SUPPLY-M2 \(golden\)\), which is archived/);
});

test("a recipe the line does not use is not blocked by another component's problem", async (t) => {
  // The battery option never uses the mains controller.
  const catalog = await createTestPriceCatalog({ items: goldenItems({ omit: ["IRRIGATION-CONTROLLER-MAINS"] }) });
  t.after(() => catalog.close());
  const battery = GOLDEN_CASES.find((testCase) => testCase.name === "irrigation battery 10 m2");
  const breakdown = await compileWith(catalog, battery);
  assert.deepEqual(breakdown.pricingIssues, []);
  const expected = GOLDEN.cases.find((entry) => entry.name === battery.name);
  assert.deepEqual(projectBreakdown(breakdown).lines, expected.lines);
});
