import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAssemblyDefinition } from "../catalog/assemblies.js";
import { createTestPriceCatalog } from "../test-price-catalog.js";
import { priceAssemblyComponent, resolveRecipePricing } from "./recipe-pricing.js";

const component = (key, itemCode, unit) => ({ key, itemCode, label: key, unit });

test("a recipe component is priced from its catalogue item, converted to the component's unit", async (t) => {
  const catalog = await createTestPriceCatalog({
    items: [
      { code: "LABOURER-HOUR", name: "Labourer", unit: "hour", buy_price: 60, sell_price: 90 },
      { code: "EDGING-MM", name: "Edging by the millimetre", unit: "mm", buy_price: 0.02, sell_price: 0.03 },
    ],
  });
  t.after(() => catalog.close());
  const state = await catalog.store.getState();

  const hourly = priceAssemblyComponent(state, component("labour", "labourer-hour", "hour"));
  assert.equal(hourly.itemCode, "LABOURER-HOUR");
  assert.equal(hourly.cost, 60);
  assert.equal(hourly.sell, 90);
  assert.equal(hourly.problem, null);
  assert.ok(Number.isInteger(hourly.priceId));

  // Minutes of a per-hour item: the catalogue knows 1 min = 1/60 hour.
  const perMinute = priceAssemblyComponent(state, component("labour", "LABOURER-HOUR", "min"));
  assert.equal(perMinute.cost, 1);
  assert.equal(perMinute.sell, 1.5);

  const perMetre = priceAssemblyComponent(state, component("edging", "EDGING-MM", "m"));
  assert.equal(perMetre.cost, 20);
  assert.equal(perMetre.sell, 30);
});

test("missing, archived, unpriced and unit-mismatched items are problems naming the item, never prices", async (t) => {
  const catalog = await createTestPriceCatalog({
    items: [
      { code: "GRAVEL", name: "Gravel", unit: "tonne", buy_price: 80, sell_price: 110 },
      { code: "OLD-PIT", name: "Old pit", unit: "each", buy_price: 90, sell_price: 140 },
      { code: "NO-SELL", name: "No sell yet", unit: "m", buy_price: 5 },
    ],
  });
  t.after(() => catalog.close());
  await catalog.store.archiveItem("OLD-PIT", { author: "test" });
  const state = await catalog.store.getState();

  const cases = [
    [component("x", "NOPE", "m"), "missing_item", /uses NOPE, which is not in the price catalogue/],
    [component("pit", "OLD-PIT", "each"), "inactive_item", /OLD-PIT \(Old pit\), which is archived/],
    [component("n", "NO-SELL", "m"), "unpriced_item", /NO-SELL \(No sell yet\), which has no sell price/],
    [component("gravel", "GRAVEL", "m"), "unit_mismatch", /GRAVEL \(Gravel\) per m, but it is priced per tonne and the catalogue has no conversion/],
    [component("gravel", "GRAVEL", "furlong"), "unknown_unit", /"furlong", which is not a known unit/],
  ];
  for (const [entry, kind, message] of cases) {
    const priced = priceAssemblyComponent(state, entry, { assemblyCode: "test-recipe" });
    assert.equal(priced.problem?.kind, kind, entry.itemCode);
    assert.match(priced.problem.message, message);
    assert.match(priced.problem.message, /the test-recipe recipe/);
    assert.equal(priced.cost, null);
    assert.equal(priced.sell, null);
  }
});

test("recipe pricing covers every assembly of a quote catalog and lists their problems", async (t) => {
  const catalog = await createTestPriceCatalog({
    items: [{ code: "TURF", name: "Turf", unit: "m2", buy_price: 18, sell_price: 22.5 }],
  });
  t.after(() => catalog.close());
  const assembly = normalizeAssemblyDefinition({
    code: "mini-lawn",
    params: [{ name: "area_m2", required: true }],
    components: [
      { key: "turf", itemCode: "TURF", unit: "m2", qty: "area_m2" },
      { key: "loam", itemCode: "LOAM", unit: "m3", qty: "area_m2 * 0.1" },
    ],
  });
  const pricing = resolveRecipePricing(await catalog.store.getState(), { assemblies: [assembly] });
  const entry = pricing.assemblies["mini-lawn"];
  assert.equal(entry.version, assembly.version);
  assert.equal(entry.components.turf.sell, 22.5);
  assert.deepEqual(entry.problems.map((problem) => [problem.key, problem.kind]), [["loam", "missing_item"]]);
  assert.deepEqual(pricing.items.turf, { code: "TURF", name: "Turf", category: null, unit: "m2" });
});
