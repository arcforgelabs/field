import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEvidenceQuote, ensureCommercialSupportLineItems } from "./generate-evidence-quote.js";
import { getCustomerPresentationFinancials, getCustomerScheduleItems } from "./quote-presentation.js";
import { refreshQuoteCatalogAuthority } from "./quote-catalogs.js";
import { buildTestRateCard, buildTestRecipePricing } from "./test-pricing-fixtures.js";
import { buildBayModel } from "./retaining-wall-engine.js";
import { buildRetainingWallQuoteContextForJob } from "./wall-zones.js";
import { closeTestPriceCatalogs, createTestPriceCatalog, seedCatalogFromPriceMaps } from "./test-price-catalog.js";

// Quote rules are priced only by the price catalogue: tests that build quotes
// overlay the quote catalog from a fixture catalogue (server/test-price-catalog.js).
async function withFixturePricing(run) {
  const { store } = await createTestPriceCatalog();
  await refreshQuoteCatalogAuthority({ priceCatalog: store, required: false });
  try {
    return await run();
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await closeTestPriceCatalogs();
  }
}

const baseMeta = {
  id: "rec_quote_review",
  quoteCatalogId: "default",
};

async function createRetainingWallZoneContext() {
  const jobDir = await mkdtemp(join(tmpdir(), "field-retaining-wall-zone-"));
  const rateCard = buildTestRateCard();
  const model = buildBayModel({
    bayHeights: [
      { bay_id: 1, height_m: 0.45, source: "probe" },
      { bay_id: 2, height_m: 0.55, source: "probe" },
      { bay_id: 3, height_m: 0.65, source: "probe" },
    ],
    bayGeometry: [
      { bay_id: 1, x_start: 0, y_start: 0, z_start: 0, x_end: 2.01, y_end: 0, z_end: 0 },
      { bay_id: 2, x_start: 2.01, y_start: 0, z_start: 0, x_end: 4.02, y_end: 0, z_end: 0 },
      { bay_id: 3, x_start: 4.02, y_start: 0, z_start: 0, x_end: 6.03, y_end: 0, z_end: 0 },
    ],
    bendAngles: [],
    design: {
      construction_rules: {
        max_sleepers_per_wall: 5,
        sleeper_height_mm: 200,
        bay_pitch_mm: 2010,
        ibeam_web_mm: 4,
        tolerance_mm: 6,
        tier2_trigger_m: 1.2,
        tier3_trigger_m: 2.4,
        protrusion_mm: 100,
        horizontal_step_mm: 600,
        post_below_ground_rule: "above_ground + 200mm",
        angle_threshold_degrees: 5.0,
        weld_time_minutes: 2,
        bags_per_hole: 8,
        pad_concrete_bags_per_2_bays: 0.5,
        min_remainder_for_extra_bay_mm: 500,
        cure_days: 2,
        sleeper_install_minutes_per_sleeper: 2,
      },
      design_overrides: {
        full_height_single_tier_bays: "all_active",
        single_tier_system_height_m: 1.0,
        mower_gap_bays: [],
        stairs: [],
      },
      process_times: {
        cutback_minutes: { "1T": 15, "2T": 25, "3T": 35 },
        drill_hours_per_hole: 1.0,
        concrete_minutes_per_post: 30,
        pad_height_minutes_per_post: 5,
        drainage_minutes_per_bay: 15,
        backfill_minutes: { "1T": 5, "2T": 10, "3T": 15 },
      },
      site: {
        distance_km_one_way: 5,
        crew_size: 3,
        estimated_site_days: 3,
      },
    },
    rateCard,
  });
  model.perimeter_m = 6.03;

  await mkdir(join(jobDir, "generated"), { recursive: true });
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    zones: [
      {
        id: "rear-boundary",
        title: "Rear boundary retaining wall",
        sections: ["Retaining wall - Rear Fence Line"],
        lineItemCodes: ["retaining-wall__section-retaining-wall-rear-fence-line"],
        bayModelPath: "generated/rear-boundary-bay-model.json",
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "generated/rear-boundary-bay-model.json"), JSON.stringify({
    measurement: {
      sourceMode: "probe_path",
    },
    model,
  }, null, 2));

  const retainingWallContext = await buildRetainingWallQuoteContextForJob({
    jobDir,
    rateCard,
  });

  return {
    jobDir,
    model,
    retainingWallContext,
  };
}

test("excluded assumption removes linked line items from the regenerated quote", () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Retaining wall works",
      assumptions: [],
      jobScope: {},
      lineItemCandidates: [{
        quoteCatalogItemCode: "retaining-wall",
        label: "Retaining wall construction",
        confidence: 0.92,
        rationale: "Retaining wall requested on site.",
        evidence: [],
      }],
      missingInputs: [{
        field: "wall length",
        reason: "Length not measured yet.",
        evidence: [],
        evidenceSummary: ["Wall length was not confirmed on site."],
      }],
    },
    overrides: {
      assumptions: {
        "wall length": {
          value: "6 lm",
          reviewState: {
            excluded: true,
            reason: "Retaining wall removed from this quote.",
            originCategory: "assumed",
            relatedLineItems: ["retaining-wall"],
          },
        },
      },
    },
  });

  assert.equal(quote.lineItems.some((item) => item.code === "retaining-wall"), false);
  assert.equal(quote.assumptionInputs.some((item) => item.field === "wall length"), false);
  assert.equal(quote.missingInputs.includes("wall length"), false);
});

test("legacy priceListItemCode candidates rebuild against current catalog aliases", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Excavation and labour works",
      assumptions: [],
      jobScope: {},
      missingInputs: [],
      lineItemCandidates: [
        {
          priceListItemCode: "excavator-operator",
          label: "Excavator and operator",
          quantity: 4,
          unit: "hour",
          confidence: 0.93,
          rationale: "Legacy draft quote input from the earlier extraction pipeline.",
          section: "Back Yard",
          evidence: [],
        },
        {
          priceListItemCode: "ground-labour",
          label: "Ground labour",
          quantity: 6,
          unit: "hour",
          confidence: 0.91,
          rationale: "Legacy draft quote input from the earlier extraction pipeline.",
          section: "Back Yard",
          evidence: [],
        },
      ],
    },
  });

  const excavator = quote.lineItems.find((item) => item.quoteCatalogItemCode === "excavator-hour");
  const labour = quote.lineItems.find((item) => item.quoteCatalogItemCode === "labourer-hour");

  assert.ok(excavator);
  assert.ok(labour);
  assert.equal(excavator.quantity, 4);
  // The rate is the catalogue's EXCAVATOR-HOUR item (the rule's authority
  // item), not the 185 the quote catalog used to carry.
  assert.equal(excavator.unitPrice, 300);
  assert.equal(labour.quantity, 6);
  assert.equal(labour.unitPrice, 80);
  assert.equal(quote.totals.total > 0, true);
}));

test("explicit line-item exclusion removes the confirmed item from the regenerated quote", () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage works",
      assumptions: [],
      jobScope: {},
      missingInputs: [],
      lineItemCandidates: [{
        quoteCatalogItemCode: "drainage",
        label: "Drainage installation",
        quantity: 12,
        unit: "lm",
        confidence: 0.95,
        rationale: "Drainage run scoped on site.",
        evidence: [],
      }],
    },
    overrides: {
      lineItems: {
        drainage: {
          reviewState: {
            excluded: true,
            reason: "Drainage removed from the current quote.",
            originCategory: "confirmed",
          },
        },
      },
    },
  });

  assert.equal(quote.lineItems.some((item) => item.code === "drainage"), false);
});

test("presentation scope overrides replace the generated customer-facing scope text", () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Default scope text",
      assumptions: [],
      jobScope: {},
      missingInputs: [],
      lineItemCandidates: [{
        quoteCatalogItemCode: "drainage",
        label: "Drainage installation",
        quantity: 12,
        unit: "lm",
        confidence: 0.95,
        rationale: "Drainage run scoped on site.",
        evidence: [],
      }],
    },
    overrides: {
      presentation: {
        scopeText: "Custom scope text",
      },
    },
  });

  assert.equal(quote.summary, "Custom scope text");
  assert.equal(quote.presentation?.scopeText, "Custom scope text");
});

test("landscaping scope builds a zone-first customer schedule from sectioned sellable products", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: {
      ...baseMeta,
      title: "Test Customer — 12 Sample Street, Exampleton",
    },
    recipePricing: buildTestRecipePricing(),
    transcript: null,
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Landscape the front and back yard with irrigation, lawn, trees, plants, and edging.",
      assumptions: [],
      jobScope: {
        workSummary: "Front and back yard landscaping for a new build.",
      },
      missingInputs: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "irrigation-system-install",
          label: "Irrigation system",
          quantity: 1,
          unit: "job",
          confidence: 0.95,
          rationale: "Shared irrigation system for the front and back yard.",
          section: "Irrigation",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "lawn-supply-prep-install",
          label: "Front lawn",
          quantity: 77,
          unit: "m2",
          confidence: 0.94,
          rationale: "Front lawn with prep and turf.",
          section: "Front Yard",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "large-tree-supply-install",
          label: "Feature trees",
          quantity: 2,
          unit: "tree",
          confidence: 0.9,
          rationale: "Two feature trees in the front yard.",
          section: "Front Yard",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "plant-supply-install",
          label: "Front garden plants",
          quantity: 12,
          unit: "plant",
          confidence: 0.9,
          rationale: "Plants supplied and installed in two front garden beds.",
          section: "Front Yard",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "lawn-supply-prep-install",
          label: "Back lawn",
          quantity: 220,
          unit: "m2",
          confidence: 0.94,
          rationale: "Back lawn with prep and turf.",
          section: "Back Yard",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "tree-supply-install",
          label: "Back trees",
          quantity: 17,
          unit: "tree",
          confidence: 0.9,
          rationale: "Trees supplied and installed through the back yard.",
          section: "Back Yard",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "block-edging-supply-install",
          label: "Block edging",
          quantity: 45,
          unit: "lm",
          confidence: 0.92,
          rationale: "Block edging along the back yard lawn perimeter.",
          section: "Back Yard",
          evidence: [],
        },
      ],
    },
  });

  const customerItems = getCustomerScheduleItems(quote);
  const visibleCustomerItems = customerItems.filter((item) => item.amountVisible !== false);
  const hiddenCustomerItems = customerItems.filter((item) => item.amountVisible === false);

  assert.equal(quote.presentation?.template, "zone_first");
  assert.equal(customerItems.every((item) => item.unit === "lot" && item.quantity === 1), true);
  assert.deepEqual(
    visibleCustomerItems.map((item) => item.section),
    ["Irrigation", "Front Yard", "Front Yard", "Front Yard", "Back Yard", "Back Yard", "Back Yard"]
  );
  assert.deepEqual(
    hiddenCustomerItems.map((item) => item.label),
    ["Site establishment and set-out", "Final trim and cleanup"]
  );
  assert.equal(customerItems.some((item) => item.label === "Trees — Supply & Install (17x)"), true);
  assert.equal(customerItems.some((item) => item.label === "Plants — Supply & Install (12 plants)"), true);
  assert.equal(quote.lineItems.some((item) => item.code === "site-establishment"), true);
  assert.equal(quote.lineItems.some((item) => item.code === "cleanup"), true);
  assert.equal(quote.internalPricing?.mode, "flat_quote");
  assert.equal(quote.totals.subtotal, quote.internalPricing?.totals?.charge);
  assert.equal(Array.isArray(quote.commercialLines), true);
  assert.equal(quote.commercialLines.some((line) => line.itemCode === "lawn-supply-prep-install"), true);
  assert.equal(quote.materialOrders.some((order) => order.itemCode === "SANDY-LOAM-M3"), true);
  assert.equal(quote.materialOrders.some((order) => order.itemCode === "TURF-SUPPLY-M2"), true);
  assert.match(quote.summary || "", /Front Yard — Lawn — supply, preparation, and install/);
  assert.match(quote.summary || "", /Back Yard — 17x trees supplied and installed/);
}));

test("support line items inherit buying costs from the refreshed catalog authority", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-support-costs-"));

  try {
    const db = (await createTestPriceCatalog({ priceMaps: null })).store;
    await seedCatalogFromPriceMaps(db, {
      buyMap: {
        drainage: 120,
        "site-establishment": 155,
        cleanup: 150,
      },
      sellMap: {
        drainage: 210,
        "site-establishment": 185,
        cleanup: 180,
      },
      author: "test",
    });
    await refreshQuoteCatalogAuthority({
      priceCatalog: db,
      required: false,
    });

    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: {
        recordingIntent: "job-scope",
        reviewStatus: "ready",
        summary: "Drainage installation.",
        assumptions: [],
        jobScope: {
          workSummary: "Install drainage on one site.",
        },
        missingInputs: [],
        lineItemCandidates: [
          {
            quoteCatalogItemCode: "drainage",
            label: "Drainage installation",
            quantity: 12,
            unit: "lm",
            confidence: 0.95,
            rationale: "Drainage run scoped on site.",
            evidence: [],
          },
        ],
      },
    });

    assert.equal(quote.lineItems.find((item) => item.code === "site-establishment")?.unitCost, 155);
    assert.equal(quote.lineItems.find((item) => item.code === "site-establishment")?.totalCost, 155);
    assert.equal(quote.lineItems.find((item) => item.code === "cleanup")?.unitCost, 150);
    assert.equal(quote.lineItems.find((item) => item.code === "cleanup")?.totalCost, 150);
  } finally {
    await refreshQuoteCatalogAuthority({ required: false });
    await closeTestPriceCatalogs();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// An unpriced support rule (site-establishment/
// cleanup) is correctly omitted (fail-closed), but the omission
// must surface as a pricing issue rather than disappear silently — the
// reviewer confirmed this is currently unreachable via the public
// generateEvidenceQuote() surface because both catalogues price every
// support rule, so this exercises ensureCommercialSupportLineItems()
// directly against a synthetic quoteCatalog to prove the signal exists for
// when a rate is removed in the future.
test("ensureCommercialSupportLineItems omits an unpriced support line and records a pricing issue instead of silently dropping it", () => {
  const quoteCatalog = {
    id: "test-catalog",
    supportRuleCodes: ["site-establishment", "cleanup"],
    rules: [
      { code: "site-establishment", label: "Site establishment", unit: "job", priceCatalog: null, defaultQuantity: 1 },
      { code: "cleanup", label: "Site cleanup", unit: "job", priceCatalog: { code: "cleanup", sellPrice: 180, buyPrice: 150 }, defaultQuantity: 1 },
    ],
  };
  const seededLineItems = [
    { code: "drainage-1", quoteCatalogItemCode: "drainage", confidence: 0.95, label: "Drainage installation" },
  ];

  const result = ensureCommercialSupportLineItems({
    lineItems: seededLineItems,
    quoteCatalog,
    quoteCatalogReferenceUrl: "/api/quote-catalogs/test-catalog/reference",
    lineItemOverrides: {},
  });

  assert.equal(result.lineItems.find((item) => item.code === "site-establishment"), undefined, "unpriced site-establishment line must not be injected");
  const cleanupItem = result.lineItems.find((item) => item.code === "cleanup");
  assert.ok(cleanupItem, "priced cleanup line should still be injected normally");
  assert.equal(cleanupItem.unitPrice, 180);

  assert.equal(result.pricingIssues.length, 1);
  assert.equal(result.pricingIssues[0].code, "site-establishment");
  assert.match(result.pricingIssues[0].reason, /no sell price/i);
});

test("customer-facing schedule keeps hidden support rows in totals while hiding their amounts", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Retaining wall, drainage, and spoil removal.",
      assumptions: [],
      jobScope: {
        workSummary: "Retaining wall, drainage, and spoil removal on one site.",
      },
      missingInputs: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "retaining-wall",
          label: "Retaining wall construction",
          confidence: 0.95,
          rationale: "Retaining wall required.",
          section: "Retaining Wall",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          confidence: 0.94,
          rationale: "Drainage run required.",
          section: "Drainage",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "soil-removal",
          label: "Soil removal and disposal",
          confidence: 0.92,
          rationale: "Spoil must be removed from site.",
          section: "Spoil Removal",
          evidence: [],
        },
        {
          quoteCatalogItemCode: "tip-truck",
          label: "Tip truck haulage",
          confidence: 0.9,
          rationale: "Spoil haulage is required.",
          section: "Spoil Removal",
          evidence: [],
        },
      ],
    },
  });

  const customerItems = getCustomerScheduleItems(quote);
  const financials = getCustomerPresentationFinancials(quote);
  const customerSubtotal = Math.round(
    customerItems.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0) * 100
  ) / 100;
  const hiddenCustomerItems = customerItems.filter((item) => item.amountVisible === false);

  assert.equal(quote.lineItems.some((item) => item.code === "site-establishment"), true);
  assert.equal(quote.lineItems.some((item) => item.code === "cleanup"), true);
  assert.equal(quote.lineItems.some((item) => item.code === "labourer-hour"), true);
  assert.equal(quote.lineItems.some((item) => item.code === "excavator-hour"), true);
  assert.equal(customerSubtotal, quote.totals.subtotal);
  assert.equal(quote.totals.subtotal, quote.internalPricing?.totals?.charge);
  assert.equal(financials.charge, quote.internalPricing?.totals?.charge);
  assert.equal(financials.cost, quote.internalPricing?.totals?.cost);
  assert.equal(customerItems.every((item) => item.totalPrice > 0), true);
  assert.equal(quote.lineItems.every((item) => Number.isFinite(Number(item.totalCost))), true);
  assert.deepEqual(
    hiddenCustomerItems.map((item) => item.label),
    [
      "General labourer",
      "Excavator hour (incl. operator)",
      "Site establishment and set-out",
      "Final trim and cleanup",
    ]
  );
  assert.equal(Array.isArray(customerItems[0]?.components), true);
  assert.equal(customerItems[0].components.some((component) => component.code === "retaining-wall__section-retaining-wall"), true);
  assert.equal(customerItems[0].components[0].supportEntries.some((entry) => entry.ref === "C1"), true);
  assert.equal(customerItems[0].components[0].supportEntries.some((entry) => entry.ref === "H1"), true);
  assert.equal(
    customerItems[0].components[0].supportEntries.find((entry) => entry.ref === "C1")?.reference?.url,
    null
  );
  assert.match(
    customerItems[0].components[0].supportEntries.find((entry) => entry.ref === "C1")?.reference?.appPath || "",
    /^\/pricing\?quoteCatalogId=default&itemCode=/
  );
}));

test("retaining wall sections compile from wall-zone exact pricing instead of direct pass through", async () => withFixturePricing(async () => {
  const { jobDir, model, retainingWallContext } = await createRetainingWallZoneContext();

  try {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: {
        recordingIntent: "job-scope",
        reviewStatus: "ready",
        summary: "Rear boundary retaining wall.",
        assumptions: [],
        jobScope: {
          workSummary: "Rear retaining wall replacement.",
        },
        missingInputs: [],
        lineItemCandidates: [
          {
            quoteCatalogItemCode: "retaining-wall",
            label: "Rear boundary retaining wall",
            quantity: 6.03,
            unit: "lm",
            confidence: 0.97,
            rationale: "Measured rear boundary retaining run.",
            section: "Retaining wall - Rear Fence Line",
            evidence: [],
          },
        ],
      },
      retainingWallContext,
    });

    const retainingBreakdown = quote.internalPricing?.lineItemBreakdowns?.find((item) => item.sourceLineItemCode === "retaining-wall__section-retaining-wall-rear-fence-line");
    const retainingLineItem = quote.lineItems.find((item) => item.code === "retaining-wall__section-retaining-wall-rear-fence-line");

    assert.ok(retainingBreakdown);
    assert.equal(retainingBreakdown.recipe, "retaining_wall_exact");
    assert.equal(retainingBreakdown.commercialLines.some((line) => line.itemCode === "SLEEPER-KENSINGTON"), true);
    assert.equal(retainingBreakdown.commercialLines.some((line) => String(line.itemCode || "").startsWith("STEEL-")), true);
    assert.ok(retainingBreakdown.totals.charge > 0);
    assert.ok(retainingBreakdown.totals.cost > 0);
    assert.equal(retainingBreakdown.totals.charge, Math.round(Number(model.wall_charge || 0) * 100) / 100);
    assert.equal(retainingBreakdown.totals.cost, Math.round((Number(model.total_cost || 0) - Number(model.ancillaries_cost || 0)) * 100) / 100);
    assert.equal(retainingLineItem?.totalPrice, retainingBreakdown.totals.charge);
    assert.equal(retainingLineItem?.totalCost, retainingBreakdown.totals.cost);
    assert.ok(Number(quote.internalPricing?.coverage?.exactRecipeCount || 0) >= 1);
    assert.ok(
      Number(quote.internalPricing?.coverage?.directPassThroughCount || 0)
      < Number(quote.internalPricing?.coverage?.sourceLineItemCount || 0)
    );
    assert.equal(quote.totals.subtotal, quote.internalPricing?.totals?.charge);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}));

test("non-wall sections do not compile from wall-zone exact pricing just because the zone tokens overlap", async () => withFixturePricing(async () => {
  const { jobDir, retainingWallContext } = await createRetainingWallZoneContext();

  try {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: {
        recordingIntent: "job-scope",
        reviewStatus: "ready",
        summary: "Zone 1 terracing plus the adjoining retaining wall.",
        assumptions: [],
        jobScope: {
          workSummary: "Terracing and retaining wall replacement.",
        },
        missingInputs: [],
        lineItemCandidates: [
          {
            quoteCatalogItemCode: "site-levelling",
            label: "Zone 1 - Terrace 1 levelling and ramp tie-in",
            quantity: 2.85,
            unit: "m3",
            confidence: 0.96,
            rationale: "Levelling zone beside the retaining wall.",
            section: "Zone 1 - Terrace 1 levelling",
            earthworkInputs: {
              cutVolumeM3: 0.81,
              fillVolumeM3: 2.04,
            },
            evidence: [],
          },
          {
            quoteCatalogItemCode: "retaining-wall",
            label: "Rear boundary retaining wall",
            quantity: 6.03,
            unit: "lm",
            confidence: 0.97,
            rationale: "Measured rear boundary retaining run.",
            section: "Retaining wall - Rear Fence Line",
            evidence: [],
          },
        ],
      },
      retainingWallContext,
    });

    const levellingBreakdown = quote.internalPricing?.lineItemBreakdowns?.find((item) => item.sourceLineItemCode === "site-levelling__section-zone-1-terrace-1-levelling");
    const retainingBreakdown = quote.internalPricing?.lineItemBreakdowns?.find((item) => item.sourceLineItemCode === "retaining-wall__section-retaining-wall-rear-fence-line");

    assert.ok(levellingBreakdown);
    assert.ok(retainingBreakdown);
    assert.notEqual(levellingBreakdown.recipe, "retaining_wall_exact");
    assert.equal(retainingBreakdown.recipe, "retaining_wall_exact");
    assert.equal(levellingBreakdown.commercialLines.some((line) => line.itemCode === "SLEEPER-KENSINGTON"), false);
    assert.equal(retainingBreakdown.commercialLines.some((line) => line.itemCode === "SLEEPER-KENSINGTON"), true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}));

test("option families produce scenario summaries while using the default scenario for totals", async () => {
  // The "soil-removal" option now correctly needs a
  // resolvable disposal basis to price at all (see
  // generate-evidence-quote.duration.test.js's withDisposalPriceCatalogAuthority
  // for the same pattern) — without it the option silently disappeared from
  // the scenario family instead of being not-quoteable with a reason.
  const dataDir = await mkdtemp(join(tmpdir(), "field-option-families-disposal-"));
  try {
    const db = (await createTestPriceCatalog({ priceMaps: null })).store;
    await seedCatalogFromPriceMaps(db, {
      // Every rule this scenario touches needs a matching item once the
      // price catalog has any active item, since erpAuthorityActive then
      // gates ALL rules' pricing on it (drainage and soil-removal are each
      // priced directly here, not only through the disposal recipe).
      buyMap: { "KANGA-HOUR": 125, "unclean-fill-disposal": 30, "tip-truck": 200, "drainage": 120.83, "soil-removal": 76.58 },
      sellMap: { "KANGA-HOUR": 150, "unclean-fill-disposal": 36, "tip-truck": 240, "drainage": 145, "soil-removal": 91.89 },
      author: "test",
    });
    await db.updateItem("unclean-fill-disposal", { pricing_basis: "per_tonne", pricing_basis_factor: 1.6 }, { author: "test" });
    await refreshQuoteCatalogAuthority({ priceCatalog: db, required: false });

    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: {
        recordingIntent: "job-scope",
        reviewStatus: "ready",
        summary: "Choose one drainage approach and include spoil removal.",
        assumptions: [],
        jobScope: {
          workSummary: "Drainage quote with one required option family.",
        },
        missingInputs: [],
        lineItemCandidates: [
          {
            quoteCatalogItemCode: "drainage",
            label: "Standard strip drain",
            quantity: 12,
            unit: "lm",
            confidence: 0.94,
            rationale: "Base drainage run.",
            section: "Drainage Method — Select One",
            evidence: [],
          },
          {
            quoteCatalogItemCode: "soil-removal",
            label: "Rock trench and spoil removal",
            quantity: 8,
            unit: "m3",
            confidence: 0.91,
            rationale: "Heavier trenching alternative.",
            section: "Drainage Method — Select One",
            evidence: [],
          },
          {
            quoteCatalogItemCode: "tip-truck",
            label: "Tip truck haulage",
            quantity: 1,
            unit: "load",
            confidence: 0.9,
            rationale: "Support haulage requirement.",
            section: "Spoil Removal",
            evidence: [],
          },
        ],
      },
    });

    assert.equal(quote.selectionState?.hasOptionFamilies, true);
  assert.equal(quote.selectionState?.handoffReady, false);
    assert.equal(quote.selectionState?.scenarioSummaries?.length, 2);
    assert.equal(quote.selectionState?.defaultScenarioId, quote.selectionState?.activeScenarioId);
    assert.match(quote.totals?._note || "", /default selections/i);
    assert.equal(
      quote.selectionState.scenarioSummaries.every((scenario) => Number.isFinite(scenario.total)),
      true
    );
    assert.equal(
      quote.selectionState.scenarioSummaries.every((scenario) => scenario.durationHours == null || Number.isFinite(scenario.durationHours)),
      true
    );
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await closeTestPriceCatalogs();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("schedule item components expose audio evidence as anchored support entries", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Irrigation quote",
      assumptions: [],
      jobScope: {
        workSummary: "Shared irrigation system across the front and back yard.",
      },
      missingInputs: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "irrigation-system-install",
          label: "Irrigation system",
          quantity: 1,
          unit: "job",
          confidence: 0.95,
          rationale: "One irrigation controller spans the front and back yard.",
          section: "Irrigation",
          evidence: [
            {
              segmentId: "S014",
              start: 102,
              end: 126,
              speaker: "Customer",
              snippet: "We want irrigation front and back, but it would all be off the same controller anyway.",
              text: "The customer described one irrigation controller spanning the front and back yard.",
            },
          ],
        },
      ],
    },
  });

  const scheduleItem = getCustomerScheduleItems(quote)[0];
  const component = scheduleItem.components[0];
  const audioSupport = component.supportEntries.find((entry) => entry.ref === "A1");

  assert.match(component.code, /^irrigation-system-install/);
  assert.equal(audioSupport?.kind, "audio");
  assert.equal(audioSupport?.audio?.speaker, "Customer");
  assert.match(audioSupport?.summary || "", /irrigation controller/);
  assert.equal(component.supportEntries.some((entry) => entry.kind === "activity"), false);
}));
