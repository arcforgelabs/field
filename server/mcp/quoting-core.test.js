import test from "node:test";
import assert from "node:assert/strict";
import {
  executeGuardedMutation,
  FieldPluginError,
  priceFromMargin,
  priceFromMarkup,
  pricingMetrics,
  requireApply,
  validateQuote,
  versionOf,
} from "./quoting-core.js";

test("markup and margin math use distinct correct formulae", () => {
  assert.equal(priceFromMarkup(100, 25), 125);
  assert.equal(priceFromMargin(100, 20), 125);
  assert.deepEqual(pricingMetrics({ cost: 100, price: 125 }), {
    cost: 100, price: 125, profit: 25, markupPercent: 25, marginPercent: 20,
  });
});

test("pricing validation rejects invalid numbers and impossible margins", () => {
  assert.throws(() => priceFromMarkup(-1, 20), (error) => error instanceof FieldPluginError && error.code === "validation_error");
  assert.throws(() => priceFromMargin(10, 100), /below|exclusive/);
  assert.throws(() => pricingMetrics({ cost: 10 }), /cost and price are required/);
});

test("version hashing is stable across object key order and changes on values", () => {
  assert.equal(versionOf({ b: 2, a: 1 }), versionOf({ a: 1, b: 2 }));
  assert.notEqual(versionOf({ a: 1 }), versionOf({ a: 2 }));
});

test("mutation defaults to dry-run and returns the version to confirm", () => {
  const preview = requireApply({ operation: "update", currentVersion: "v1", before: { price: 10 }, request: { price: 12 } });
  assert.equal(preview.applied, false);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.expectedVersion, "v1");
});

test("mutation apply requires exact confirmation and expected version", () => {
  assert.throws(
    () => requireApply({ apply: true, confirmation: "yes", expectedVersion: "v1", currentVersion: "v1", operation: "update" }),
    (error) => error.code === "confirmation_required",
  );
  assert.throws(
    () => requireApply({ apply: true, confirmation: "APPLY", currentVersion: "v1", operation: "update" }),
    (error) => error.code === "expected_version_required",
  );
  assert.equal(requireApply({ apply: true, confirmation: "APPLY", expectedVersion: "v1", currentVersion: "v1", operation: "update" }), null);
});

test("stale expected version fails closed with both versions", () => {
  assert.throws(
    () => requireApply({ apply: true, confirmation: "APPLY", expectedVersion: "old", currentVersion: "new", operation: "update" }),
    (error) => error.code === "stale_version" && error.details.expectedVersion === "old" && error.details.currentVersion === "new",
  );
});

test("guarded mutation dry-run performs no write", async () => {
  let writes = 0;
  const before = { price: 10 };
  const client = { settings: { actor: "test" }, request: async () => { writes += 1; } };
  const result = await executeGuardedMutation({
    params: {}, client, operation: "update", before, endpoint: "/item", method: "PATCH", body: { price: 12 },
    loadCurrent: async () => before,
  });
  assert.equal(result.dryRun, true);
  assert.equal(writes, 0);
});

test("guarded mutation applies once and returns before/after audit", async () => {
  const before = { price: 10 };
  const after = { price: 12 };
  let writes = 0;
  let reads = 0;
  const client = { settings: { actor: "test" }, request: async () => { writes += 1; } };
  const result = await executeGuardedMutation({
    params: { apply: true, confirmation: "APPLY", expectedVersion: versionOf(before) },
    client, operation: "update", before, endpoint: "/item", method: "PATCH", body: after,
    loadCurrent: async () => (++reads === 1 ? before : after),
  });
  assert.equal(writes, 1);
  assert.equal(result.applied, true);
  assert.deepEqual(result.audit.before, before);
  assert.deepEqual(result.audit.after, after);
});

test("guarded mutation re-check blocks a race before writing", async () => {
  let writes = 0;
  const before = { price: 10 };
  const client = { settings: { actor: "test" }, request: async () => { writes += 1; } };
  await assert.rejects(executeGuardedMutation({
    params: { apply: true, confirmation: "APPLY", expectedVersion: versionOf(before) },
    client, operation: "update", before, endpoint: "/item", method: "PATCH", body: { price: 12 },
    loadCurrent: async () => ({ price: 11 }),
  }), (error) => error.code === "stale_version");
  assert.equal(writes, 0);
});

test("quote validation reports invalid prices and missing costs without mutation", () => {
  const result = validateQuote({ quote: { lineItems: [{ unitPrice: -1, unitCost: 2 }, { unitPrice: 4 }] }, quoteInputs: { missingInputs: [{}] } });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "invalid_price");
  assert.equal(result.warnings.some((entry) => entry.code === "cost_missing"), true);
  assert.equal(result.warnings.some((entry) => entry.code === "missing_inputs"), true);
});
