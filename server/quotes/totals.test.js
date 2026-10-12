// quoteTotals (#6): the one totals function for quote rows. A line's total
// is round(qty x unit sell, 2), or the amount a document already printed;
// GST is worked out once on the subtotal per rate (decided 2026-10-12);
// amounts ex GST, exact decimals rounded half away from zero.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  centsToText,
  isCountedLine,
  isHalfCentTax,
  lineTotalCents,
  newLineUnitSell,
  quoteTotals,
  roundMoney,
  taxCents,
  toScaled,
  unitSellForTotal,
} from "./totals.js";

const line = (quantity, unitSell, overrides = {}) => ({ lineType: "custom", quantity, unitSell, taxRate: "10", ...overrides });

describe("money arithmetic", () => {
  test("decimals parse exactly, whatever JavaScript's float would say", () => {
    assert.deepEqual(toScaled("1.005", 2), { scaled: 101n, exact: false });
    assert.deepEqual(toScaled(1.005, 2), { scaled: 101n, exact: false }, "1.005 is 1.00499… as a float; parsed as written it rounds up");
    assert.deepEqual(toScaled("12.5", 4), { scaled: 125000n, exact: true });
    assert.deepEqual(toScaled("-2.345", 2), { scaled: -235n, exact: false }, "half away from zero");
    assert.deepEqual(toScaled(1e-7, 4), { scaled: 0n, exact: false });
    assert.equal(toScaled(0.1 + 0.2, 2).scaled, 30n);
    assert.throws(() => toScaled("1,000", 2), /not a decimal/);
    assert.throws(() => toScaled(Number.NaN, 2), /finite/);
  });

  test("line total is round(qty x unit sell, 2), with four-decimal rates, half away from zero", () => {
    assert.equal(centsToText(lineTotalCents("3", "33.33")), "99.99");
    assert.equal(centsToText(lineTotalCents("3", "33.335")), "100.01", "100.005 rounds up");
    assert.equal(centsToText(lineTotalCents("2.5", "10.01")), "25.03", "25.025 rounds up");
    assert.equal(centsToText(lineTotalCents("0.125", "0.20")), "0.03", "0.025 rounds up");
    assert.equal(centsToText(lineTotalCents("1.3333", "3.00")), "4.00", "3.9999 rounds to 4.00");
    assert.equal(centsToText(lineTotalCents("12", "1.2345")), "14.81");
    assert.equal(centsToText(lineTotalCents("1", "-12.50")), "-12.50");
    assert.equal(centsToText(lineTotalCents("0.5", "-0.01")), "-0.01", "-0.005 rounds away from zero, as PostgreSQL does");
    assert.equal(centsToText(lineTotalCents("0", "99.99")), "0.00");
  });

  test("tax on an amount, and the half-cent case", () => {
    assert.equal(centsToText(taxCents("30.15", "10")), "3.02", "3.015 rounds up");
    assert.equal(centsToText(taxCents("21.15", "10")), "2.12");
    assert.equal(centsToText(taxCents("33.33", "12.5")), "4.17");
    assert.equal(centsToText(taxCents("-10.05", "10")), "-1.01");
    assert.equal(isHalfCentTax("21.15", "10"), true);
    assert.equal(isHalfCentTax("21.10", "10"), false);
    assert.equal(isHalfCentTax("0.04", "12.5"), true, "0.005");
  });

  test("roundMoney, new lines' rates, and the rate a fixed total works out to", () => {
    assert.equal(roundMoney(33.335), "33.34");
    assert.equal(roundMoney("2"), "2.00");
    assert.equal(newLineUnitSell("12.345"), "12.3500", "a line added from now on takes the rate rounded to cents");
    assert.equal(newLineUnitSell(85.5), "85.5000");
    assert.equal(unitSellForTotal("4", "120.00"), "30.00");
    assert.equal(unitSellForTotal("1", "480.00"), "480.00");
    assert.equal(unitSellForTotal("3", "100.00"), null, "no whole-cent rate makes 3 units cost $100");
    assert.equal(unitSellForTotal("0", "10.00"), null);
  });
});

describe("quoteTotals", () => {
  test("GST is worked out once on the subtotal, not per line", () => {
    const totals = quoteTotals([line("1", "10.05"), line("1", "10.05"), line("1", "10.05")]);
    assert.equal(totals.subtotal, "30.15");
    assert.equal(totals.taxTotal, "3.02", "round(30.15 x 10 %) = 3.02, not 3 x round(1.005) = 3.03");
    assert.equal(totals.total, "33.17");
    assert.deepEqual(totals.taxGroups, [{ taxRate: "10.000", base: "30.15", tax: "3.02" }]);
    assert.equal("lineTax" in totals.lines[0], false, "no per-line tax drives anything");
  });

  test("one tax per rate: each rate's base is taxed once", () => {
    const totals = quoteTotals([line("1", "100.00"), line("1", "55.55", { taxRate: "0" }), line("1", "0.05"), line("1", "0.05")]);
    assert.deepEqual([totals.subtotal, totals.taxTotal, totals.total], ["155.65", "10.01", "165.66"]);
    assert.deepEqual(totals.taxGroups, [
      { taxRate: "0.000", base: "55.55", tax: "0.00" },
      { taxRate: "10.000", base: "100.10", tax: "10.01" },
    ]);
  });

  test("a printed line total counts as stored; a computed one must be qty x rate", () => {
    const totals = quoteTotals([
      line("3", "1.005", { lineTotal: "3.01", lineTotalSource: "printed", lineTotalReason: "as printed" }),
      line("3", "33.335", { lineTotal: "100.01" }),
      line("2", "10.00", { lineTotal: "25.00" }),
    ]);
    assert.deepEqual(totals.lines.map((entry) => entry.lineTotal), ["3.01", "100.01", "20.00"]);
    assert.deepEqual(totals.inconsistent, [2], "a computed line whose stored total is not qty x rate");
    assert.equal(totals.subtotal, "123.02");
    assert.throws(() => quoteTotals([line("1", "1", { lineTotalSource: "printed" })]), /needs its total/);
  });

  test("components, notes and unselected options never count; unpriced lines are listed, not zero", () => {
    const lines = [
      line("2", "50.00", { lineType: "item" }),
      line("3", "10.00", { lineType: "component" }),
      line("1", "20.00", { lineType: "component" }),
      { lineType: "note", quantity: "1", unitSell: null, taxRate: "10" },
      line("3", "30.00", { isOptional: true, isSelected: false }),
      line("1", null),
      line("12", "85.50", { lineType: "item" }),
    ];
    const totals = quoteTotals(lines);
    assert.equal(totals.subtotal, "1126.00");
    assert.equal(totals.taxTotal, "112.60");
    assert.equal(totals.total, "1238.60");
    assert.deepEqual(totals.unpriced, [5]);
    assert.deepEqual(totals.lines.map((entry) => entry.counted), [true, false, false, false, false, false, true]);
    assert.equal(totals.lines[1].lineTotal, "30.00", "a component still has its own total for display");
    assert.equal(totals.lines[3].lineTotal, "0.00");
    assert.equal(totals.lines[5].lineTotal, null);
    assert.equal(isCountedLine(lines[4]), false);
  });

  test("an empty quote is zero, and the input must be a list", () => {
    assert.deepEqual(quoteTotals([]), { subtotal: "0.00", taxTotal: "0.00", total: "0.00", taxGroups: [], lines: [], unpriced: [], inconsistent: [] });
    assert.throws(() => quoteTotals(null), /array/);
  });

  test("quantities with four decimals and many lines stay exact", () => {
    const lines = Array.from({ length: 1000 }, () => line("0.3333", "0.03"));
    const totals = quoteTotals(lines);
    assert.equal(totals.subtotal, "10.00", "1000 x round(0.009999) = 1000 x 0.01");
    assert.equal(totals.taxTotal, "1.00", "tax once on the subtotal");
  });
});
