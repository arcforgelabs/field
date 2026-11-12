import assert from "node:assert/strict";
import test from "node:test";

import { comparePrices } from "./price.js";

function item(overrides = {}) {
  return { name: "Sample resource", status: "active", unit_cost: 10, unit_sell: 15, ...overrides };
}

function snapshot(row) {
  return { items: { sample: row } };
}

test("the price gate allows float noise but rejects sub-cent changes and cent crossings", () => {
  for (const field of ["unit_cost", "unit_sell"]) {
    for (const [before, after, ok] of [
      [12, 12.0000001, true],
      [12, 12.00001, false],
      [1.0049999, 1.0050001, false],
    ]) {
      const was = item({ [field]: before });
      const now = item({ [field]: after });
      const result = comparePrices(snapshot(was), snapshot(now));
      assert.equal(result.ok, ok, `${field}: ${before} -> ${after}`);
      assert.deepEqual(result.changed, ok ? [] : [{
        uid: "sample",
        name: "Sample resource",
        change: "price",
        before: { cost: was.unit_cost, sell: was.unit_sell },
        after: { cost: now.unit_cost, sell: now.unit_sell },
      }]);
    }
  }
});

test("the price gate distinguishes an unpriced item from a zero price", () => {
  for (const field of ["unit_cost", "unit_sell"]) {
    for (const [before, after, ok] of [[null, null, true], [null, 0, false], [0, null, false]]) {
      const result = comparePrices(snapshot(item({ [field]: before })), snapshot(item({ [field]: after })));
      assert.equal(result.ok, ok, `${field}: ${before} -> ${after}`);
      assert.deepEqual(result.changed.map((row) => row.change), ok ? [] : ["price"]);
    }
  }
});

test("the price gate reports a deleted item even when archiving was allowed", () => {
  const result = comparePrices(snapshot(item()), { items: {} }, { allowArchived: ["sample"] });
  assert.deepEqual(result, {
    ok: false,
    compared: 1,
    changed: [{ uid: "sample", name: "Sample resource", change: "missing" }],
    unpricedArchived: [],
  });
});

test("an archive exception permits lost prices only for the named inactive item", () => {
  const before = snapshot(item());
  const cases = [
    { status: "archived", unit_cost: null, unit_sell: null, allowed: ["sample"], retired: true },
    { status: "archived", unit_cost: null, unit_sell: null, allowed: ["other"], retired: false },
    { status: "active", unit_cost: null, unit_sell: null, allowed: ["sample"], retired: false },
    { status: "archived", unit_cost: 10, unit_sell: null, allowed: ["sample"], retired: false },
    { status: "archived", unit_cost: null, unit_sell: 15, allowed: ["sample"], retired: false },
    { status: "archived", unit_cost: 11, unit_sell: 16, allowed: ["sample"], retired: false },
  ];
  for (const { allowed, retired, ...prices } of cases) {
    const result = comparePrices(before, snapshot(item(prices)), { allowArchived: allowed });
    assert.equal(result.ok, retired, JSON.stringify({ allowed, ...prices }));
    assert.deepEqual(result.unpricedArchived, retired ? [{ uid: "sample", name: "Sample resource" }] : []);
    assert.deepEqual(result.changed.map((row) => row.change), retired ? [] : ["price"]);
  }
});
