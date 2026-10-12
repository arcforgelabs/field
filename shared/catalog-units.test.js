import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuoteUnitOptions,
  canConvertCatalogQuantity,
  convertCatalogQuantity,
  formatCatalogUnit,
  formatCatalogUnitText,
  getCatalogEntryUnitOptions,
  getDefaultCatalogEntryUnit,
  normalizeCatalogUnit,
} from "./catalog-units.js";

test("normalizeCatalogUnit collapses common unit aliases", () => {
  assert.equal(normalizeCatalogUnit("m"), "m");
  assert.equal(normalizeCatalogUnit("lm"), "m");
  assert.equal(normalizeCatalogUnit("metres"), "m");
  assert.equal(normalizeCatalogUnit("Meters"), "m");
  assert.equal(normalizeCatalogUnit("linear metre"), "m");
  assert.equal(normalizeCatalogUnit("Linear Metres"), "m");
  assert.equal(normalizeCatalogUnit("millimetres"), "mm");
  assert.equal(normalizeCatalogUnit("Millimeters"), "mm");
  assert.equal(normalizeCatalogUnit("tonnes"), "tonne");
  assert.equal(normalizeCatalogUnit("nos"), "each");
  assert.equal(normalizeCatalogUnit("minutes"), "min");
  assert.equal(normalizeCatalogUnit("plant"), "each");
  assert.equal(normalizeCatalogUnit("trees"), "each");
  assert.equal(normalizeCatalogUnit("square metres"), "m2");
  assert.equal(normalizeCatalogUnit("cubic meters"), "m3");
});

test("buildQuoteUnitOptions dedupes aliases and preserves canonical ordering", () => {
  const options = buildQuoteUnitOptions("linear metre", ["tonnes", "nos", "lm", "m", "millimetres", "plant"]);

  assert.equal(options.filter((unit) => unit === "m").length, 1);
  assert.equal(options.filter((unit) => unit === "mm").length, 1);
  assert.equal(options.filter((unit) => unit === "tonne").length, 1);
  assert.equal(options.includes("lm"), false);
  assert.equal(options.includes("linear metre"), false);
  assert.equal(options.includes("tonnes"), false);
  assert.equal(options.includes("nos"), false);
  assert.equal(options.includes("millimetres"), false);
  assert.equal(options.includes("plant"), false);
  assert.deepEqual(options.slice(0, 5), ["job", "lot", "each", "hour", "min"]);
});

test("formatCatalogUnit renders square and cubic metre exponents", () => {
  assert.equal(formatCatalogUnit("m2"), "m²");
  assert.equal(formatCatalogUnit("m3"), "m³");
  assert.equal(formatCatalogUnit("square metres"), "m²");
  assert.equal(formatCatalogUnit("cubic meters"), "m³");
  assert.equal(formatCatalogUnit("m2/hr"), "m²/hr");
  assert.equal(formatCatalogUnitText("2 m3 at 1.5 t/m3"), "2 m³ at 1.5 t/m³");
});

test("catalog quantity conversions keep canonical maths separate from entry units", () => {
  assert.equal(convertCatalogQuantity(5, "min", "hour"), 5 / 60);
  assert.equal(convertCatalogQuantity(0.5, "hour", "min"), 30);
  assert.equal(convertCatalogQuantity(250, "mm", "m"), 0.25);
  assert.equal(canConvertCatalogQuantity("min", "hour"), true);
  assert.equal(canConvertCatalogQuantity("min", "m"), false);
  assert.deepEqual(getCatalogEntryUnitOptions("hour").map((option) => option.value), ["hour", "min"]);
  assert.equal(getDefaultCatalogEntryUnit("hour"), "min");
});
