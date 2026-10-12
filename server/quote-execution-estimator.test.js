import assert from "node:assert/strict";
import test from "node:test";

import { applyExecutionEstimateToLineItems } from "./quote-execution-estimator.js";

function buildQuoteCatalog(rules) {
  return { id: "test-catalog", rules };
}

// A derived hourly line item (labourer-hour /
// excavator-hour) whose rule has no positive rate is correctly omitted
// (fail-closed), but the omission itself must surface as a
// pricing issue rather than disappear from the quote with no signal —
// otherwise a future rate removal would silently under-bill a job with no
// trace anywhere in the quote.
test("applyExecutionEstimateToLineItems omits an unpriced hourly line and records a pricing issue instead of silently dropping it", () => {
  const quoteCatalog = buildQuoteCatalog([
    { code: "labourer-hour", label: "Labourer", unit: "hour", priceCatalog: null, defaultQuantity: 1 },
    { code: "excavator-hour", label: "Excavator", unit: "hour", priceCatalog: { sellPrice: 95 }, defaultQuantity: 1 },
  ]);
  const execution = {
    workingDayHours: 8,
    totals: { labourHours: 4, machineHours: 2 },
  };

  const result = applyExecutionEstimateToLineItems({
    lineItems: [],
    quoteCatalog,
    execution,
  });

  assert.equal(result.lineItems.find((item) => item.code === "labourer-hour"), undefined, "unpriced labourer-hour line must not be injected");
  const machineItem = result.lineItems.find((item) => item.code === "excavator-hour");
  assert.ok(machineItem, "priced excavator-hour line should still be injected normally");
  assert.equal(machineItem.unitPrice, 95);

  assert.equal(result.pricingIssues.length, 1);
  assert.equal(result.pricingIssues[0].code, "labourer-hour");
  assert.match(result.pricingIssues[0].reason, /no sell price/i);
});

test("applyExecutionEstimateToLineItems reports no pricing issues when every hourly rule is priced", () => {
  const quoteCatalog = buildQuoteCatalog([
    { code: "labourer-hour", label: "Labourer", unit: "hour", priceCatalog: { sellPrice: 65 }, defaultQuantity: 1 },
    { code: "excavator-hour", label: "Excavator", unit: "hour", priceCatalog: { sellPrice: 95 }, defaultQuantity: 1 },
  ]);
  const execution = {
    workingDayHours: 8,
    totals: { labourHours: 4, machineHours: 2 },
  };

  const result = applyExecutionEstimateToLineItems({
    lineItems: [],
    quoteCatalog,
    execution,
  });

  assert.equal(result.pricingIssues.length, 0);
  assert.ok(result.lineItems.find((item) => item.code === "labourer-hour"));
  assert.ok(result.lineItems.find((item) => item.code === "excavator-hour"));
});
