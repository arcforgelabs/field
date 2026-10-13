import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPriceCatalogSnapshotComplete,
  buildPriceCatalogSnapshot,
  isPriceCatalogSnapshotUsable,
  resolveQuoteCatalogPricingDependencies,
} from "./catalog-snapshot.js";
import { buildRateCardFromPriceMaps, RATE_CARD_REQUIRED_PRICE_CODES } from "../retaining-wall-rate-card.js";
import { createTestPriceCatalog } from "../test-price-catalog.js";

test("price catalog snapshot is immutable and records completeness/provenance", async (t) => {
  const catalog = await createTestPriceCatalog({ items: [{ code: "LABOURER-HOUR", name: "Labourer", unit: "hour", buy_price: 50, sell_price: 80 }] });
  t.after(() => catalog.close());
  const state = await catalog.store.getState();
  const snapshot = buildPriceCatalogSnapshot(state, {
    requiredCodes: ["LABOURER-HOUR", "DRAIN-PIPE-M"],
  });
  const repeat = buildPriceCatalogSnapshot(state, {
    requiredCodes: ["LABOURER-HOUR", "DRAIN-PIPE-M"],
  });

  assert.equal(snapshot.source, "price_catalog");
  assert.equal(snapshot.provenance.provider, "price_catalog");
  assert.equal(snapshot.snapshotDigest, repeat.snapshotDigest);
  assert.equal(snapshot.catalogRevision, repeat.catalogRevision);
  assert.deepEqual(snapshot.completeness.missingRequiredCodes, ["DRAIN-PIPE-M"]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.buyMap), true);
  assert.equal(isPriceCatalogSnapshotUsable(snapshot), true);
  assert.throws(() => {
    snapshot.buyMap["LABOURER-HOUR"] = 1;
  }, TypeError);
});

test("catalog dependency closure includes candidate-stage indirect money and blocks missing components", async () => {
  const quoteCatalog = {
    rules: [
      { code: "soil-removal", authorityItemCode: "SOIL-REMOVAL", pricingDependencies: ["SOIL-COMPONENT"] },
      { code: "soil-component", authorityItemCode: "SOIL-COMPONENT", pricingDependencies: ["SOIL-LEAF"] },
      { code: "soil-leaf", authorityItemCode: "SOIL-LEAF", pricingDependencies: [] },
      { code: "tip-truck", authorityItemCode: "TIP-TRUCK", pricingDependencies: [] },
      { code: "mini-loader-hour", authorityItemCode: "KANGA-HOUR", pricingDependencies: [] },
    ],
    quantityRules: [{
      mode: "soil_dump_plan",
      soilRuleCode: "soil-removal",
      haulageRuleCode: "tip-truck",
      loaderRuleCode: "mini-loader-hour",
      disposalRuleCode: "unclean-fill-disposal",
      vehicleHourRuleCode: "vehicle-hour",
      vehicleKmRuleCode: "vehicle-km",
    }],
  };
  const dependencies = resolveQuoteCatalogPricingDependencies(quoteCatalog, {
    includeRateCard: false,
    includeCatalogRules: true,
  });
  assert.deepEqual(dependencies, ["KANGA-HOUR", "SOIL-COMPONENT", "SOIL-LEAF", "SOIL-REMOVAL", "TIP-TRUCK", "unclean-fill-disposal", "vehicle-hour", "vehicle-km"]);

  const catalog = await createTestPriceCatalog();
  try {
    await catalog.store.deleteItem("drain-pipe-m");
    const snapshot = buildPriceCatalogSnapshot(await catalog.store.getState(), { quoteCatalogId: "default" });
    assert.throws(
      () => assertPriceCatalogSnapshotComplete(snapshot, { requiredCodes: ["DRAIN-PIPE-M"] }),
      /DRAIN-PIPE-M/,
    );
    // One missing item blocks the commands that need it, not every command.
    assert.equal(isPriceCatalogSnapshotUsable(snapshot), true);
    assert.equal(snapshot.completeness.allPriced, true);
  } finally {
    await catalog.close();
  }
});

test("price-catalog rate cards never substitute JSON5/default money for missing authority rates", () => {
  const buyMap = Object.fromEntries(RATE_CARD_REQUIRED_PRICE_CODES.map((code) => [code, 1]));
  const sellMap = Object.fromEntries(RATE_CARD_REQUIRED_PRICE_CODES.map((code) => [code, 2]));
  const completeCard = buildRateCardFromPriceMaps({ buyMap, sellMap, _source: "price_catalog" });
  assert.equal(completeCard.vehicle.cost_km, 1);
  assert.equal(completeCard.vehicle.charge_km, 2);
  assert.equal(completeCard.site.admin_charge, 2);
  assert.equal(completeCard.materials.kensington_sleeper.charge_ex_gst, 2);

  delete buyMap["VEHICLE-KM"];
  delete sellMap["VEHICLE-KM"];
  const card = buildRateCardFromPriceMaps({ buyMap, sellMap, _source: "price_catalog" });
  assert.equal(card.vehicle.cost_km, null);
  assert.equal(card.vehicle.charge_km, null);
  assert.equal(card.materials.concrete_20kg_bag.cost, 1);
});
