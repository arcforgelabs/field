import assert from "node:assert/strict";
import test from "node:test";

import { NoDatabaseError } from "../db-runtime/index.js";
import { refreshQuoteCatalogAuthority } from "../quote-catalogs.js";
import { createTestPriceCatalog } from "../test-price-catalog.js";

import {
  PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV,
  buildPriceCatalogRuntimeStatus,
  initializePriceCatalogRuntime,
  resolvePriceCatalogFailure,
  resolvePriceCatalogStartupPolicy,
} from "./catalog-runtime.js";

function capture() {
  const logs = [];
  return {
    logs,
    logger: {
      error: (message) => logs.push(["error", message]),
      log: (message) => logs.push(["log", message]),
      warn: (message) => logs.push(["warn", message]),
    },
  };
}

const NO_OVERRIDE = resolvePriceCatalogStartupPolicy({ env: {}, isVerificationRuntime: false });
const OVERRIDE = resolvePriceCatalogStartupPolicy({ env: { [PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV]: "1" }, isVerificationRuntime: false });

test.afterEach(async () => {
  await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
});

test("missing catalogue aborts startup when the emergency override is unset", () => {
  const policy = resolvePriceCatalogStartupPolicy({ env: {}, isVerificationRuntime: false });
  const result = resolvePriceCatalogFailure({
    policy,
    cause: new Error("catalog.db: no such file or directory"),
  });

  assert.equal(result.action, "abort");
  assert.match(result.error.message, /no such file or directory/i);
  assert.match(result.error.message, new RegExp(PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV));
  assert.match(result.error.message, /refuses to boot/i);
});

test("corrupt catalogue boots only in an explicit emergency degraded override", () => {
  const policy = resolvePriceCatalogStartupPolicy({
    env: { [PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV]: "1" },
    isVerificationRuntime: false,
  });
  const result = resolvePriceCatalogFailure({
    policy,
    cause: new Error("file is not a database"),
  });

  assert.equal(result.action, "degraded");
  assert.equal(result.incidentOverride, true);
  assert.match(result.error.message, /file is not a database/i);
  assert.match(result.error.message, /emergency degraded boot/i);
  assert.equal(
    buildPriceCatalogRuntimeStatus({ available: false, policy, error: result.error }).state,
    "degraded",
  );
});

test("verification runtime never inherits the unavailable-catalogue override", () => {
  const policy = resolvePriceCatalogStartupPolicy({
    env: { [PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV]: "1" },
    isVerificationRuntime: true,
  });
  const result = resolvePriceCatalogFailure({
    policy,
    cause: new Error("catalogue checksum mismatch"),
  });

  assert.equal(policy.overrideRequested, true);
  assert.equal(policy.overrideAllowed, false);
  assert.equal(result.action, "abort");
  assert.match(result.error.message, /does not permit this override/i);
});

test("no database aborts boot when the emergency override is unset", async () => {
  const { logger } = capture();
  await assert.rejects(
    initializePriceCatalogRuntime({
      policy: NO_OVERRIDE,
      openCatalogStore: async () => { throw new NoDatabaseError(); },
      refreshQuoteCatalogAuthority,
      logger,
    }),
    (error) => {
      assert.equal(error.code, "FIELD_PRICE_CATALOG_UNAVAILABLE");
      assert.match(error.message, /No database configured/);
      assert.match(error.message, /refuses to boot/i);
      return true;
    },
  );
});

test("an unreachable database boots only in the explicit, loud degraded override", async () => {
  const { logs, logger } = capture();
  const result = await initializePriceCatalogRuntime({
    policy: OVERRIDE,
    openCatalogStore: async () => { throw new Error("connect ECONNREFUSED"); },
    refreshQuoteCatalogAuthority,
    logger,
  });
  assert.equal(result.priceCatalog, null);
  assert.equal(result.catalogStore, null);
  assert.match(result.priceCatalogFailure.message, /ECONNREFUSED/);
  assert.match(logs.find(([level]) => level === "error")?.[1] || "", /DEGRADED BOOT/);
});

test("the override is refused in field-verification", async () => {
  await assert.rejects(
    initializePriceCatalogRuntime({
      policy: resolvePriceCatalogStartupPolicy({ env: { [PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV]: "1" }, isVerificationRuntime: true }),
      isVerificationRuntime: true,
      openCatalogStore: async () => { throw new Error("connect ECONNREFUSED"); },
      refreshQuoteCatalogAuthority,
      logger: capture().logger,
    }),
    /does not permit this override/i,
  );
});

test("boot never provisions an empty catalogue: it aborts, or degrades with the store kept for editing", async (t) => {
  const catalog = await createTestPriceCatalog({ priceMaps: null });
  t.after(() => catalog.close());
  await assert.rejects(
    initializePriceCatalogRuntime({ policy: NO_OVERRIDE, openCatalogStore: async () => catalog.store, refreshQuoteCatalogAuthority, logger: capture().logger }),
    /no active items/,
  );
  assert.equal((await catalog.store.listItems({ status: "all" })).length, 0);
  const degraded = await initializePriceCatalogRuntime({ policy: OVERRIDE, openCatalogStore: async () => catalog.store, refreshQuoteCatalogAuthority, logger: capture().logger });
  assert.equal(degraded.priceCatalog, null, "pricing stays blocked");
  assert.equal(degraded.catalogStore, catalog.store, "the catalogue can still be edited to fix it");
});

test("data problems in a usable catalogue are logged and reported, not a reason to refuse boot", async (t) => {
  const catalog = await createTestPriceCatalog({ priceMaps: null, items: [
    { code: "LABOURER-HOUR", name: "Labourer", unit: "hour", buy_price: 50, sell_price: 80 },
    { code: "UNPRICED", name: "Unpriced" },
  ] });
  t.after(() => catalog.close());
  const { logs, logger } = capture();
  const config = { quoteCatalogId: "default" };
  const result = await initializePriceCatalogRuntime({ config, policy: NO_OVERRIDE, openCatalogStore: async () => catalog.store, refreshQuoteCatalogAuthority, logger });
  assert.equal(result.priceCatalog, catalog.store);
  assert.equal(result.priceCatalogFailure, null);
  assert.equal(config.priceCatalog, catalog.store);
  const warning = logs.find(([level]) => level === "warn")?.[1] || "";
  assert.match(warning, /1 active item\(s\) without both buy and sell prices \(UNPRICED\)/);
  assert.match(warning, /DRAIN-PIPE-M/, "missing items pricing references are named");
  assert.equal(config.priceCatalogStartupSnapshot.completeness.baselineUsable, true);
  assert.equal(config.priceCatalogStartupSnapshot.completeness.allPriced, false);
});
