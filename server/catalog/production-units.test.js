// Units against a catalogue shaped like production: the quote
// rules and recipes declare the unit they measure in, and where the
// catalogue sells an item in a unit that cannot convert, the line fails
// closed naming the item and the health page reports it. Nothing is
// relabelled, so a quantity never silently changes unit.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateEvidenceQuote } from "../generate-evidence-quote.js";
import { buildPriceCatalogSnapshot } from "../price-catalog/catalog-snapshot.js";
import { compileQuoteCommercialBreakdown } from "../quote-commercial-compiler.js";
import { normalizeQuoteCatalogRule, refreshQuoteCatalogAuthority } from "../quote-catalogs.js";
import { createTestPriceCatalog } from "../test-price-catalog.js";
import { importLegacyCatalog } from "./index.js";
import { GOLDEN_CASES } from "./fixtures/assembly-golden.cases.mjs";
import { writeLegacyCatalog } from "./fixtures/legacy-catalog.js";

async function productionShapedCatalog(t) {
  const dir = mkdtempSync(join(tmpdir(), "field-production-units-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacyPath = writeLegacyCatalog(join(dir, "catalog.db"), { productionShaped: true });
  const catalog = await createTestPriceCatalog({ priceMaps: null, items: [], track: false });
  t.after(() => catalog.close());
  const report = await importLegacyCatalog(catalog.db, legacyPath, {});
  assert.equal(report.verification.ok, true, JSON.stringify(report.verification.failures));
  return catalog;
}

function quoteWith(candidates) {
  return generateEvidenceQuote({
    meta: { id: "rec_units", quoteCatalogId: "default" },
    transcript: null,
    quoteInputs: {
      recordingIntent: "job-scope",
      summary: "Unit checks",
      assumptions: [],
      jobScope: {},
      missingInputs: [],
      lineItemCandidates: candidates.map((candidate) => ({
        confidence: 0.9, rationale: "measured", section: "Front", evidence: [], ...candidate,
      })),
    },
  });
}

async function withAuthority(t, catalog) {
  await refreshQuoteCatalogAuthority({ priceCatalog: catalog.store, required: false });
  t.after(() => refreshQuoteCatalogAuthority({ priceCatalog: null, required: false }));
}

test("on a production-shaped catalogue the health page names every rule and recipe unit problem, and only those", async (t) => {
  const catalog = await productionShapedCatalog(t);
  const health = await catalog.store.health({ catalogId: "default" });

  const recipe = health.issues.filter((issue) => issue.key === "recipe_unit_mismatch");
  // The one known recipe problem: drainage allows disposal per metre of
  // trench, but clean-fill-disposal is sold per tonne.
  assert.deepEqual(recipe.map((issue) => `${issue.recipe}/${issue.component}/${issue.code}`), ["drainage-bundle/disposal/clean-fill-disposal"]);

  const rules = health.issues.filter((issue) => issue.key === "rule_unit_mismatch");
  assert.deepEqual(
    rules.map((issue) => `${issue.rule}: ${issue.ruleUnit} vs ${issue.unit}`),
    ["concrete-removal: m3 vs m2", "retaining-wall: m vs bay", "rock-wall: m2 vs m"],
  );
  assert.equal(health.summary.ruleUnitMismatchCount, 3);
  const check = health.checks.find((entry) => entry.key === "rule_unit_mismatch");
  assert.equal(check.severity, "critical");
  assert.equal(check.ok, false);
  assert.match(rules.find((issue) => issue.rule === "rock-wall").message, /rock-wall \(fixture\) \(rock-wall\) is sold per m.*no conversion/);
});

test("on a production-shaped catalogue every lawn and irrigation option prices, with the admin fee and controllers sold each", async (t) => {
  const catalog = await productionShapedCatalog(t);
  const snapshot = buildPriceCatalogSnapshot(await catalog.store.getState(), { quoteCatalogId: "default" });
  const options = GOLDEN_CASES.filter((testCase) => /^(lawn|irrigation) option|^irrigation (battery|mains)/.test(testCase.name));
  assert.equal(options.length, 7);
  for (const testCase of options) {
    const breakdown = compileQuoteCommercialBreakdown({
      quote: { lineItems: [testCase.lineItem] },
      quoteCatalog: snapshot.quoteCatalog,
      recipePricing: snapshot.recipePricing,
    }).lineItemBreakdowns[0];
    assert.deepEqual(breakdown.pricingIssues, [], testCase.name);
    assert.ok(breakdown.commercialLines.length >= 5, testCase.name);
    assert.ok(breakdown.totals.charge > 0, testCase.name);
    const admin = breakdown.commercialLines.find((line) => line.itemCode === "ADMIN-FEE");
    assert.equal(admin?.unit, "each", testCase.name);
  }

  // The archived loam is a material order, not a priced component: the lawn
  // option prices and the order carries no rate (the health page reports
  // the archived item in use).
  const lawn = GOLDEN_CASES.find((testCase) => testCase.name === "lawn option 23 m2");
  const lawnBreakdown = compileQuoteCommercialBreakdown({
    quote: { lineItems: [lawn.lineItem] },
    quoteCatalog: snapshot.quoteCatalog,
    recipePricing: snapshot.recipePricing,
  }).lineItemBreakdowns[0];
  const loam = lawnBreakdown.materialOrders.find((order) => order.itemCode === "SANDY-LOAM-M3");
  assert.equal(loam.quantity, 2.76);
  assert.equal(loam.unitPrice ?? null, null);
  const health = await catalog.store.health({ catalogId: "default" });
  assert.ok(health.issues.some((issue) => issue.key === "archived_item_in_use" && issue.code === "SANDY-LOAM-M3"));
});

test("a per-m item behind an area rule fails closed naming the item; it is never relabelled to the item's unit", async (t) => {
  const catalog = await productionShapedCatalog(t);
  await withAuthority(t, catalog);
  const quote = quoteWith([
    { quoteCatalogItemCode: "rock-wall", label: "Rock wall", quantity: 12, unit: "m2" },
    { quoteCatalogItemCode: "concrete-removal", label: "Concrete removal", quantity: 3, unit: "m3" },
  ]);
  assert.deepEqual(quote.lineItems.filter((line) => ["rock-wall", "concrete-removal"].includes(line.quoteCatalogItemCode)), []);
  const issues = Object.fromEntries((quote.pricing.issues || []).map((issue) => [issue.code, issue.reason]));
  assert.match(issues["rock-wall"], /rock-wall \(fixture\) \(rock-wall\) is sold per m, but this rule measures its quantity in m2 and the catalogue has no conversion between them/);
  assert.match(issues["concrete-removal"], /sold per m2, but this rule measures its quantity in m3/);
  assert.equal(quote.pricing.ready, false);
});

test("a rule keeps its own unit and quantity when the catalogue sells the item in that unit", async (t) => {
  const catalog = await createTestPriceCatalog({
    items: [
      { code: "rock-wall", name: "Rock wall", unit: "m2", buy_price: 250, sell_price: 300 },
      { code: "site-establishment", name: "Site establishment", unit: "job", buy_price: 150, sell_price: 185 },
      { code: "cleanup", name: "Cleanup", unit: "job", buy_price: 150, sell_price: 180 },
    ],
    track: false,
  });
  t.after(() => catalog.close());
  await withAuthority(t, catalog);
  const quote = quoteWith([{ quoteCatalogItemCode: "rock-wall", label: "Rock wall", quantity: 12, unit: "m2" }]);
  const line = quote.lineItems.find((entry) => entry.quoteCatalogItemCode === "rock-wall");
  assert.equal(line.quantity, 12);
  assert.equal(line.unit, "m2");
  assert.equal(line.unitPrice, 300);
  assert.equal(line.totalPrice, 3600);
  assert.equal(line.usedDefaultQuantity, false);
});

test("a convertible unit is converted through the catalogue: price to the rule's unit, candidate quantities into it", async (t) => {
  // Labour sold per minute behind the per-hour labourer rule.
  const catalog = await createTestPriceCatalog({
    items: [
      { code: "LABOURER-HOUR", name: "Labourer", unit: "min", buy_price: 1, sell_price: 1.5 },
      { code: "site-establishment", name: "Site establishment", unit: "job", buy_price: 150, sell_price: 185 },
      { code: "cleanup", name: "Cleanup", unit: "job", buy_price: 150, sell_price: 180 },
    ],
    track: false,
  });
  t.after(() => catalog.close());
  await withAuthority(t, catalog);
  const quote = quoteWith([{ quoteCatalogItemCode: "labourer-hour", label: "Labour", quantity: 90, unit: "min" }]);
  const line = quote.lineItems.find((entry) => entry.quoteCatalogItemCode === "labourer-hour");
  assert.equal(line.unit, "hour");
  assert.equal(line.quantity, 1.5);
  assert.equal(line.unitPrice, 90);
  assert.equal(line.totalPrice, 135);
  assert.equal(line.usedDefaultQuantity, false);
});

test("quote rules must declare the unit they measure in, matching their quantity source", () => {
  assert.equal(normalizeQuoteCatalogRule({ code: "x", label: "X", quantityUnit: "m2", quantitySource: "area" }).unit, "m2");
  assert.equal(normalizeQuoteCatalogRule({ code: "x", label: "X", quantityUnit: "trees", quantitySource: "count" }).quantityUnit, "each");
  assert.throws(() => normalizeQuoteCatalogRule({ code: "x", label: "X" }), /missing required field: quantityUnit/);
  assert.throws(() => normalizeQuoteCatalogRule({ code: "x", label: "X", quantityUnit: "furlong" }), /not a known unit/);
  assert.throws(() => normalizeQuoteCatalogRule({ code: "x", label: "X", quantityUnit: "m", quantitySource: "area" }), /measures area but its quantityUnit "m" is a length unit/);
  assert.throws(() => normalizeQuoteCatalogRule({ code: "x", label: "X", quantityUnit: "m2", unit: "m2" }), /carries "unit"/);
});
