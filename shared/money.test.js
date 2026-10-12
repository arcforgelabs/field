import assert from "node:assert/strict";
import test from "node:test";
import { taxOnSubtotal } from "./money.js";

test("GST on exactly half a cent rounds up, where floating point rounded down (#2)", () => {
  assert.equal(Math.round(21.15 * 0.1 * 100) / 100, 2.11, "the old arithmetic, kept here as the regression");
  assert.equal(taxOnSubtotal(21.15, 0.1), 2.12);
  assert.equal(taxOnSubtotal(1.05, 0.1), 0.11);
  assert.equal(taxOnSubtotal(0.05, 0.1), 0.01);
});

test("every subtotal from $0.00 to $19,999.99 gets GST rounded half-up to the cent", () => {
  let wrongBefore = 0;
  for (let cents = 0; cents < 2_000_000; cents += 1) {
    const subtotal = cents / 100;
    // Exact: cents × 10 % = cents / 10 cents; half-up on the tenth.
    const expected = Math.floor((cents + 5) / 10) / 100;
    assert.equal(taxOnSubtotal(subtotal, 0.1), expected, `subtotal ${subtotal}`);
    if (Math.round(subtotal * 0.1 * 100) / 100 !== expected) wrongBefore += 1;
  }
  assert.ok(wrongBefore > 0, "the old arithmetic was wrong for some subtotals");
});

test("other rates, negative amounts (credits) and missing values", () => {
  assert.equal(taxOnSubtotal(100, 0.15), 15);
  assert.equal(taxOnSubtotal(10.03, 0.125), 1.25);
  assert.equal(taxOnSubtotal(-21.15, 0.1), -2.12);
  assert.equal(taxOnSubtotal(123.45, 0), 0);
  assert.equal(taxOnSubtotal(null, 0.1), null);
  assert.equal(taxOnSubtotal(10, null), null);
  assert.equal(taxOnSubtotal("abc", 0.1), null);
});
