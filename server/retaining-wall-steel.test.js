import assert from "node:assert/strict";
import test from "node:test";
import { buildTestRateCard } from "./test-pricing-fixtures.js";
import { selectSteelStockForLength } from "./retaining-wall-steel.js";

test("selectSteelStockForLength rounds exact post lengths up to the next stocked steel size", () => {
  const rateCard = buildTestRateCard();
  const cases = [
    { requiredLengthM: 0.6, expectedLengthMm: 1000 },
    { requiredLengthM: 1.0, expectedLengthMm: 1000 },
    { requiredLengthM: 1.4, expectedLengthMm: 1400 },
    { requiredLengthM: 1.8, expectedLengthMm: 1800 },
    { requiredLengthM: 2.2, expectedLengthMm: 2200 },
  ];

  for (const entry of cases) {
    const selected = selectSteelStockForLength({
      material: "ibeam",
      requiredLengthM: entry.requiredLengthM,
      rateCard,
    });
    assert.equal(selected.selectedLengthMm, entry.expectedLengthMm);
    assert.equal(selected.itemCode, `STEEL-IBEAM-125-GALV-${entry.expectedLengthMm}`);
  }
});
