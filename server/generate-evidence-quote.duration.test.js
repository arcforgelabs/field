import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEvidenceQuote } from "./generate-evidence-quote.js";
import { buildQuoteBreakdownSource } from "./quote-breakdown-source.js";
import { refreshQuoteCatalogAuthority } from "./quote-catalogs.js";
import { closeTestPriceCatalogs, createTestPriceCatalog, seedCatalogFromPriceMaps } from "./test-price-catalog.js";

// Disposal rates and their costing basis are owned exclusively by the price
// catalogue (DEL-46) — quote-catalogs/*.json5 no longer carries a disposal
// unitPrice. Tests that price a disposal line therefore need a real price-
// catalog authority behind them, matching how the server always runs in
// production (server/index.js refreshes the catalog authority at startup).
// This seeds only the codes these specific tests price, at the exact values
// the removed json5/dumping.js constants used to hardcode, so the assertions
// keep proving the same numbers via the new single source of truth.
async function withDisposalPriceCatalogAuthority(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "field-disposal-basis-"));
  try {
    const db = (await createTestPriceCatalog({ priceMaps: null })).store;
    await seedCatalogFromPriceMaps(db, {
      // tip-truck is seeded too (matching embark-default.json5's unitPrice
      // 240 exactly) because erpAuthorityActive flips true for every rule
      // once the price catalog has any active item — an explicit tip-truck
      // candidate would otherwise also become not-quoteable once this helper
      // activates price-catalog authority for the disposal fix (DEL-46).
      // site-levelling and soil-removal exist so their rules have a unit:
      // units come only from the catalogue item, never the quote catalog.
      buyMap: {
        "KANGA-HOUR": 125,
        "EXCAVATOR-HOUR": 180,
        "unclean-fill-disposal": 30,
        "tip-truck": 200,
        "VEHICLE-HOUR": 45,
        "VEHICLE-KM": 0.8,
        "site-levelling": 70,
        "soil-removal": 76.58,
      },
      sellMap: {
        "KANGA-HOUR": 150,
        "EXCAVATOR-HOUR": 300,
        "unclean-fill-disposal": 36,
        "tip-truck": 240,
        "VEHICLE-HOUR": 75,
        "VEHICLE-KM": 0.8,
        "site-levelling": 88.13,
        "soil-removal": 91.89,
      },
      author: "test",
    });
    await db.updateItem("unclean-fill-disposal", { pricing_basis: "per_tonne", pricing_basis_factor: 1.6 }, { author: "test" });
    await refreshQuoteCatalogAuthority({ priceCatalog: db, required: false });
    await run();
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await closeTestPriceCatalogs();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// The quote rules (labourer-hour, excavator-hour, ...) are priced only by the
// price catalogue: overlay the quote catalog from the fixture catalogue.
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
  id: "rec_wall_001",
  createdAt: "2026-03-12T00:00:00.000Z",
  title: "Retaining wall quote",
  quoteCatalogId: "embark-default",
};

const defaultSoilDump = {
  id: "woodside",
  name: "Adelaide Hills Recycling",
  drive: 20,
  dist: 15.2,
};

function buildQuoteInputs(overrides = {}) {
  return {
    recordingIntent: "job-scope",
    reviewStatus: "ready",
    summary: "Build a retaining wall, remove spoil, and finish the site.",
    jobScope: {
      customerGoal: "Create a level retained area",
      workSummary: "Retaining wall with spoil removal",
      siteContext: "Rear yard",
    },
    lineItemCandidates: [
      {
        label: "Retaining wall construction",
        description: "12 lineal metres of retaining wall",
        quoteCatalogItemCode: "retaining-wall",
        quantity: 12,
        unit: "lm",
        confidence: 0.94,
        rationale: "Twelve metre wall run extracted from the site recording.",
        evidence: [{
          segmentId: "S001",
          start: 0,
          end: 8,
          speaker: "Alex",
          snippet: "It is about a twelve metre retaining wall.",
        }],
        evidenceSummary: ["[00:00] Alex: It is about a twelve metre retaining wall."],
      },
      {
        label: "Soil removal and disposal",
        description: "Remove spoil from excavation",
        quoteCatalogItemCode: "soil-removal",
        quantity: 8,
        unit: "m3",
        confidence: 0.92,
        rationale: "Eight cubic metres of spoil need to come out.",
        evidence: [{
          segmentId: "S002",
          start: 8,
          end: 14,
          speaker: "Alex",
          snippet: "There is around eight cube to cart away.",
        }],
        evidenceSummary: ["[00:08] Alex: There is around eight cube to cart away."],
      },
    ],
    processReferences: [],
    siteConstraints: [{
      label: "Access",
      detail: "Limited access with the truck parked on the road.",
      evidence: [],
      evidenceSummary: ["Truck parked on the road for loading."],
    }],
    measurements: [],
    missingInputs: [
      { field: "estimated labour hours", reason: "No labour duration was stated explicitly." },
      { field: "estimated machine hours", reason: "No machine duration was stated explicitly." },
    ],
    assumptions: [],
    ...overrides,
  };
}

function buildSoilRemovalCandidate(overrides = {}) {
  return {
    label: "Soil removal and disposal",
    description: "Remove spoil from excavation",
    quoteCatalogItemCode: "soil-removal",
    quantity: 30,
    unit: "m3",
    confidence: 0.92,
    rationale: "Thirty cubic metres of spoil need to come out.",
    evidence: [],
    evidenceSummary: [],
    ...overrides,
  };
}

function findLineItemBreakdown(quote, lineItemCode) {
  return quote.internalPricing?.lineItemBreakdowns?.find((item) => item.sourceLineItemCode === lineItemCode);
}

function findCommercialLine(breakdown, itemCode) {
  return breakdown?.commercialLines?.find((line) => line.itemCode === itemCode);
}

test("generateEvidenceQuote derives labour, machine, and duration from scoped work", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: buildQuoteInputs(),
    details: {
      soilDump: {
        id: "woodside",
        name: "Adelaide Hills Recycling",
        drive: 20,
      },
    },
  });

  const labourItem = quote.lineItems.find((item) => item.code === "labourer-hour");
  const machineItem = quote.lineItems.find((item) => item.code === "excavator-hour");
  const labourAssumption = quote.assumptionInputs.find((item) => item.field === "estimated labour hours");
  const machineAssumption = quote.assumptionInputs.find((item) => item.field === "estimated machine hours");

  assert.ok(quote.execution, "execution summary should be present");
  assert.equal(quote.execution.workingDayHours, 8);
  assert.equal(quote.execution.accessProfile?.code, "limited");
  assert.ok(quote.execution.stages.some((stage) => stage.code === "structure"));
  assert.ok(quote.execution.stages.some((stage) => stage.code === "haulage"));
  assert.ok(quote.execution.totals.durationHours > quote.execution.totals.labourHours);

  assert.ok(labourItem, "labourer-hour line should be inserted from execution estimate");
  assert.ok(machineItem, "machine line should be inserted from execution estimate");
  assert.equal(labourItem.usedDefaultQuantity, false);
  assert.equal(machineItem.usedDefaultQuantity, false);
  assert.ok(labourItem.quantity > 0);
  assert.ok(machineItem.quantity > 0);

  assert.equal(labourAssumption?.source, "derived");
  assert.equal(machineAssumption?.source, "derived");
  assert.ok(!quote.missingInputs.includes("estimated labour hours"));
  assert.ok(!quote.missingInputs.includes("estimated machine hours"));
}));

test("explicit labour quantities are preserved over the execution model", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: buildQuoteInputs({
      lineItemCandidates: [
        ...buildQuoteInputs().lineItemCandidates,
        {
          label: "Ground labour",
          description: "Operator explicitly called out six labour hours.",
          quoteCatalogItemCode: "labourer-hour",
          quantity: 6,
          unit: "hour",
          confidence: 0.9,
          rationale: "Six hours stated directly in the recording.",
          evidence: [{
            segmentId: "S003",
            start: 14,
            end: 18,
            speaker: "Alex",
            snippet: "Allow six hours of labour on this one.",
          }],
          evidenceSummary: ["[00:14] Alex: Allow six hours of labour on this one."],
        },
      ],
    }),
  });

  const labourItem = quote.lineItems.find((item) => item.code === "labourer-hour");

  assert.ok(labourItem);
  assert.equal(labourItem.quantity, 6);
  assert.equal(labourItem.usedDefaultQuantity, false);
}));

test("execution overrides replace derived pricing inputs and keep duration overhead honest", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: buildQuoteInputs(),
    details: {
      soilDump: {
        id: "woodside",
        name: "Adelaide Hills Recycling",
        drive: 20,
      },
    },
    overrides: {
      execution: {
        accessProfile: "restricted",
        labourHours: 12,
        machineHours: 6,
        travelHoursPerDay: 1.5,
        dumpDriveMinutes: 35,
        note: "Rear lane handoff and wheelbarrow run through side gate.",
      },
    },
  });

  const labourItem = quote.lineItems.find((item) => item.code === "labourer-hour");
  const machineItem = quote.lineItems.find((item) => item.code === "excavator-hour");
  const labourAssumption = quote.assumptionInputs.find((item) => item.field === "estimated labour hours");
  const machineAssumption = quote.assumptionInputs.find((item) => item.field === "estimated machine hours");

  assert.ok(quote.execution, "execution summary should be present");
  assert.deepEqual(
    [...(quote.execution.overriddenFields || [])].sort(),
    ["accessProfile", "dumpDriveMinutes", "labourHours", "machineHours", "travelHoursPerDay"],
  );
  assert.equal(quote.execution.accessProfile?.code, "restricted");
  assert.equal(quote.execution.parameters?.travelHoursPerDay, 1.5);
  assert.equal(quote.execution.parameters?.dumpDriveMinutes, 35);
  assert.equal(quote.execution.totals.labourHours, 12);
  assert.equal(quote.execution.totals.machineHours, 6);
  assert.ok(quote.execution.totals.siteDays >= 2);
  assert.ok(quote.execution.totals.durationHours > 12);
  assert.ok(quote.assumptions.some((item) => item.includes("Rear lane handoff and wheelbarrow run through side gate.")));

  assert.ok(labourItem);
  assert.ok(machineItem);
  assert.equal(labourItem.quantity, 12);
  assert.equal(machineItem.quantity, 6);
  assert.equal(labourAssumption?.source, "user");
  assert.equal(machineAssumption?.source, "user");
  assert.ok(
    !(quote.review?.reasons || []).some((item) => item.includes("Derived pricing assumption used for estimated labour hours")),
  );
}));

test("soil dump plan keeps disposal volume equal to gross cut when fill is not supplied", async () => {
  await withDisposalPriceCatalogAuthority(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [buildSoilRemovalCandidate()],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    const truckItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "tip-truck");
    const soilBreakdown = findLineItemBreakdown(quote, soilItem?.code);

    assert.ok(soilItem, "soil removal line should exist");
    assert.ok(truckItem, "truck haulage line should exist");
    assert.equal(soilItem.quantity, 30);
    assert.equal(truckItem.quantity, 14);
    const disposalLine = findCommercialLine(soilBreakdown, "unclean-fill-disposal");
    // 30 m3 x 1.6 t/m3 = 48 t, at the same $36/t sell / $30/t buy rate the
    // removed dumping.js/json5 constants used to hardcode — proves a
    // per_tonne disposal line prices identically once the catalogue item is
    // the sole source of both the rate and the costing basis (DEL-46).
    assert.equal(disposalLine?.quantity, 48);
    assert.equal(disposalLine?.unit, "tonne");
    assert.equal(disposalLine?.unitPrice, 36);
    assert.equal(disposalLine?.unitCost, 30);
  });
});

test("soil dump plan prices haulage and disposal from net export volume when fill stays on-site", async () => {
  await withDisposalPriceCatalogAuthority(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [buildSoilRemovalCandidate({
          fillVolumeM3: 12,
          rationale: "30 m3 cut and 12 m3 reused on-site as fill.",
        })],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    const truckItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "tip-truck");
    const soilBreakdown = findLineItemBreakdown(quote, soilItem?.code);

    assert.ok(soilItem, "soil removal line should exist");
    assert.ok(truckItem, "truck haulage line should exist");
    assert.equal(soilItem.quantity, 30);
    assert.equal(truckItem.quantity, 9);
    assert.equal(findCommercialLine(soilBreakdown, "KANGA-HOUR")?.quantity, 6.8571);
    assert.equal(findCommercialLine(soilBreakdown, "unclean-fill-disposal")?.quantity, 28.8);
    assert.match(soilItem.rationale || "", /12 m3 used as fill on-site/i);
    assert.match(truckItem.rationale || "", /18 m3 disposal volume/i);
  });
});

test("soil dump plan omits haulage when cut and fill balance to zero disposal", async () => {
  // Loader-hours logistics now share the same single density owner as
  // disposal billing (DEL-46 round 2) — no json5 fallback — so this needs
  // the same price-catalog authority as the other soil-dump-plan tests.
  await withDisposalPriceCatalogAuthority(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [buildSoilRemovalCandidate({
          fillVolumeM3: 30,
          rationale: "30 m3 cut and 30 m3 reused on-site as fill.",
        })],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    const truckItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "tip-truck");
    const soilBreakdown = findLineItemBreakdown(quote, soilItem?.code);

    assert.ok(soilItem, "soil removal line should exist");
    assert.equal(truckItem, undefined);
    assert.equal(findCommercialLine(soilBreakdown, "KANGA-HOUR")?.quantity, 6.8571);
    assert.equal(findCommercialLine(soilBreakdown, "unclean-fill-disposal"), undefined);
  });
});

test("soil dump plan floors disposal at zero when fill exceeds cut and flags future import need", async () => {
  await withDisposalPriceCatalogAuthority(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [buildSoilRemovalCandidate({
          fillVolumeM3: 40,
          rationale: "30 m3 cut and 40 m3 fill demand on-site.",
        })],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    const truckItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "tip-truck");
    const soilBreakdown = findLineItemBreakdown(quote, soilItem?.code);

    assert.ok(soilItem, "soil removal line should exist");
    assert.equal(truckItem, undefined);
    assert.equal(findCommercialLine(soilBreakdown, "KANGA-HOUR")?.quantity, 6.8571);
    assert.equal(findCommercialLine(soilBreakdown, "unclean-fill-disposal"), undefined);
    assert.match(soilItem.rationale || "", /additional imported fill may be required/i);
  });
});

test("manual soil sections are preserved while haulage is derived from the combined spoil volume", async () => {
  // DEL-46 (P0, round 4): an unresolved disposal basis now correctly makes
  // the soil-removal line not-quoteable instead of silently mispricing it,
  // so this needs the same price-catalog authority the round-2 fixtures use.
  await withDisposalPriceCatalogAuthority(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [
          {
            label: "Shed area levelling — soil removal and disposal",
            description: "Measured spoil from the shed area.",
            quoteCatalogItemCode: "soil-removal",
            quantity: 25.86,
            unit: "m3",
            section: "Shed area levelling",
            confidence: 0.97,
            rationale: "Measured from Moasure output for the shed area.",
            evidence: [],
            evidenceSummary: ["Moasure PDF: Shed area levelling contour view shows 25.86 m3."],
          },
          {
            label: "Retaining wall cut-back — soil removal and disposal",
            description: "Measured spoil from behind the retaining wall.",
            quoteCatalogItemCode: "soil-removal",
            quantity: 1.97,
            unit: "m3",
            section: "Retaining wall cut-back",
            confidence: 0.97,
            rationale: "Measured from Moasure output for the retaining wall cut-back.",
            evidence: [],
            evidenceSummary: ["Moasure PDF: Soil out contour view shows 1.97 m3."],
          },
        ],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItems = quote.lineItems.filter((item) => item.quoteCatalogItemCode === "soil-removal");
    const truckItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "tip-truck");
    const levellingItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "site-levelling");

    assert.equal(soilItems.length, 2);
    assert.deepEqual(
      soilItems.map((item) => ({ section: item.section, quantity: item.quantity })),
      [
        { section: "Shed area levelling", quantity: 25.86 },
        { section: "Retaining wall cut-back", quantity: 1.97 },
      ],
    );
    assert.ok(truckItem, "truck haulage line should exist");
    assert.equal(truckItem.quantity, 13);
    assert.equal(truckItem.section, "Soil haulage");
    assert.ok(levellingItem, "shed levelling cut line should be derived from the levelling section");
    assert.equal(levellingItem.quantity, 25.86);
    assert.equal(levellingItem.section, "Shed area levelling");
    // The catalogue recipe prices both excavator and mini-loader work.  The
    // old JSON5-only assertion (88.13) covered only the KANGA component and
    // would hide a partial recipe under strict catalogue authority.
    assert.equal(levellingItem.unitPrice, 131.25);
  });
});

test("explicit soil and haulage quantities are preserved when Moasure contour imports are present", async () => {
  await withDisposalPriceCatalogAuthority(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        summary: "Landscape quote with explicit spoil and haulage quantities from manual cut/fill review.",
        lineItemCandidates: [
          {
            label: "Site levelling — cut/fill redistribution and excess soil removal",
            description: "Manual cut/fill review determined the excess spoil to remove.",
            quoteCatalogItemCode: "soil-removal",
            quantity: 10,
            unit: "m3",
            section: "Earthworks — Site Levelling",
            confidence: 0.85,
            rationale: "Manual Moasure review found about 10 m3 net excess after cut/fill balancing.",
            evidence: [],
            evidenceSummary: [],
          },
          {
            label: "Tip truck and driver — excess soil haulage",
            description: "Two truck loads cover the excess spoil and wall rubble.",
            quoteCatalogItemCode: "tip-truck",
            quantity: 2,
            unit: "load",
            section: "Earthworks — Soil Haulage",
            confidence: 0.85,
            rationale: "Two tip-truck loads cover the excess spoil and wall rubble.",
            evidence: [],
            evidenceSummary: [],
          },
        ],
      }),
      moasureSummary: {
        status: "parsed",
        batchCount: 2,
        latestBatchId: "2026-03-30T09-35-15-000Z",
        imports: [
          { label: "Yard to be level", batchId: "A", area: 79.618, elevationRange: 1.181, perimeter: 36 },
          { label: "Yard to be level", batchId: "B", area: 79.618, elevationRange: 1.181, perimeter: 36 },
          { label: "Area 2 leveled around tree", batchId: "A", area: 47.879, elevationRange: 0.881, perimeter: 20 },
          { label: "Back left garden wall section", batchId: "A", area: 3.947, elevationRange: 0.485, perimeter: 9 },
          { label: "Rear yard retaining along fence line", batchId: "A", area: 0.013, elevationRange: 0.826, perimeter: 7 },
          { label: "level-1-lawn-ramp", batchId: "A", area: 28.185, elevationRange: 0.578, perimeter: 16 },
          { label: "retaining-level-2", batchId: "A", area: 27.294, elevationRange: 0.537, perimeter: 18 },
        ],
      },
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    const truckItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "tip-truck");
    const levellingItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "site-levelling");

    assert.ok(soilItem, "soil removal line should exist");
    assert.ok(truckItem, "truck haulage line should exist");
    assert.ok(levellingItem, "site levelling line should still be derived from the levelling section");
    assert.equal(soilItem.quantity, 10);
    assert.equal(truckItem.quantity, 2);
    assert.equal(levellingItem.quantity, 10);
    assert.ok(quote.totals.total < 40000, "quote total should stay in the expected landscape range");
  });
});

test("breakdown source carries parsed cut fill into bulk removal inputs without overriding explicit quote quantity", async () => {
  await withDisposalPriceCatalogAuthority(() => {
    const quoteInputs = buildQuoteInputs({
      summary: "Landscape quote with explicit export volume and parsed Moasure cut/fill evidence.",
      lineItemCandidates: [
        {
          label: "Site levelling — cut/fill redistribution and excess soil removal",
          description: "Manual cut/fill review determined the excess spoil to remove.",
          quoteCatalogItemCode: "soil-removal",
          quantity: 10,
          unit: "m3",
          section: "Earthworks — Site Levelling",
          confidence: 0.85,
          rationale: "Manual Moasure review found about 10 m3 net excess after cut/fill balancing.",
          evidence: [],
          evidenceSummary: [],
        },
        {
          label: "Tip truck and driver — excess soil haulage",
          description: "Two truck loads cover the excess spoil and wall rubble.",
          quoteCatalogItemCode: "tip-truck",
          quantity: 2,
          unit: "load",
          section: "Earthworks — Soil Haulage",
          confidence: 0.85,
          rationale: "Two tip-truck loads cover the excess spoil and wall rubble.",
          evidence: [],
          evidenceSummary: [],
        },
      ],
    });
    const moasureSummary = {
      status: "parsed",
      batchCount: 1,
      latestBatchId: "2026-03-30T09-35-15-000Z",
      imports: [
        {
          label: "Yard to be level",
          batchId: "A",
          area: 78.81,
          cutFillSummary: {
            title: "CUT/FILL VIEW",
            surfaceAreaM2: 78.81,
            cutVolumeM3: 23.38,
            fillVolumeM3: 1.6,
            netVolumeM3: -21.78,
            selectedLevelMm: 23,
          },
        },
      ],
    };
    const breakdownSource = buildQuoteBreakdownSource({
      meta: baseMeta,
      evidencePack: {
        evidence: {
          segmentCount: 0,
          hasTimestampedSegments: false,
        },
      },
      quoteInputs,
      moasureSummary,
      details: {
        soilDump: defaultSoilDump,
      },
    });
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs,
      moasureSummary,
      breakdownSource,
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    const levellingItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "site-levelling");

    assert.ok(soilItem, "soil removal line should exist");
    assert.ok(levellingItem, "site levelling line should exist");
    assert.equal(soilItem.quantity, 10);
    assert.equal(soilItem.bulkRemovalInputs?.grossCutVolumeM3, 23.38);
    assert.equal(soilItem.bulkRemovalInputs?.fillVolumeM3, 1.6);
    assert.equal(soilItem.bulkRemovalInputs?.disposalVolumeM3, 21.78);
    assert.equal(soilItem.breakdownSourcePlan?.chosen?.soilRemovalQuantityM3, 10);
    assert.equal(soilItem.breakdownSourcePlan?.measurements?.grossCutVolumeM3, 23.38);
    assert.equal(levellingItem.breakdownSourcePlan?.measurements?.netExportVolumeM3, 21.78);
  });
});

test("explicit bulk removal inputs stay authoritative over contour fallback when deriving haulage", async () => {
  await withDisposalPriceCatalogAuthority(() => {
    const quoteInputs = buildQuoteInputs({
      summary: "Landscape quote with explicit cut/fill export plan across multiple terrace zones.",
      lineItemCandidates: [
        {
          label: "Balanced site spoil export after terrace redistribution",
          description: "Load out and dispose of the surplus spoil remaining after terrace redistribution.",
          quoteCatalogItemCode: "soil-removal",
          quantity: 24.7,
          unit: "m3",
          section: "Earthworks - balanced soil export",
          confidence: 0.96,
          rationale: "Combined measured cut/fill plan gives 24.70 m3 gross cut, 17.87 m3 retained on site, and 6.83 m3 export.",
          bulkRemovalInputs: {
            grossCutVolumeM3: 24.7,
            fillVolumeM3: 17.87,
            disposalVolumeM3: 6.83,
          },
          evidence: [],
          evidenceSummary: [],
        },
      ],
      measurements: [],
      missingInputs: [],
      assumptions: [],
    });
    const moasureSummary = {
      status: "parsed",
      batchCount: 1,
      latestBatchId: "2026-03-30T09-35-15-000Z",
      imports: [
        { label: "Yard to be level", area: 78.81, elevationRange: 1.181 },
        { label: "Area 2 leveled around tree", area: 47.879, elevationRange: 0.881 },
        { label: "Back left garden wall section", area: 3.947, elevationRange: 0.485 },
        { label: "level-1-lawn-ramp", area: 28.185, elevationRange: 0.578 },
        { label: "retaining-level-2", area: 27.294, elevationRange: 0.537 },
        { label: "Rear yard retaining along fence line", area: 0.013, elevationRange: 0.826 },
      ],
    };
    const breakdownSource = buildQuoteBreakdownSource({
      meta: baseMeta,
      evidencePack: {
        evidence: {
          segmentCount: 0,
          hasTimestampedSegments: false,
        },
      },
      quoteInputs,
      moasureSummary,
      details: {
        soilDump: defaultSoilDump,
      },
    });
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs,
      moasureSummary,
      breakdownSource,
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    const truckItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "tip-truck");

    assert.ok(soilItem, "soil removal line should exist");
    assert.ok(truckItem, "truck haulage line should exist");
    assert.equal(soilItem.quantity, 24.7);
    assert.equal(soilItem.bulkRemovalInputs?.grossCutVolumeM3, 24.7);
    assert.equal(soilItem.bulkRemovalInputs?.fillVolumeM3, 17.87);
    assert.equal(soilItem.bulkRemovalInputs?.disposalVolumeM3, 6.83);
    assert.equal(truckItem.quantity, 4, "haulage loads should price from the explicit export volume, not contour fallback");
    assert.match(truckItem.rationale || "", /6\.83 m3 disposal volume/);
    assert.doesNotMatch(truckItem.rationale || "", /168\.13 m3 disposal volume/);
  });
});

test("shallow soil depth flag fires when area is large but volume implies < 15cm avg depth", async () => {
  await withDisposalPriceCatalogAuthority(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [
          {
            label: "Retaining wall cut-back — soil removal and disposal",
            description: "Measured spoil from behind the retaining wall.",
            quoteCatalogItemCode: "soil-removal",
            quantity: 1.97,
            unit: "m3",
            section: "Retaining wall cut-back",
            confidence: 0.97,
            rationale: "Measured from Moasure output.",
            evidence: [],
            evidenceSummary: [],
          },
        ],
      }),
      moasureSummary: {
        status: "parsed",
        batchCount: 1,
        latestBatchId: "2026-03-12T10-15-00-000Z",
        imports: [
          {
            label: "Retaining wall cut-back",
            batchId: "2026-03-12T10-15-00-000Z",
            area: 20.61,
            volume: 1.97,
            perimeter: 18,
          },
        ],
      },
      details: {
        soilDump: defaultSoilDump,
      },
    });

    assert.equal(quote.review.status, "manual_review", "review status should be manual_review");
    const shallowFlag = quote.review.reasons.find((r) => r.includes("Shallow soil depth flag"));
    assert.ok(shallowFlag, "should have a shallow soil depth review reason");
    assert.match(shallowFlag, /retaining.wall/i, "flag should reference the section name");
    assert.match(shallowFlag, /implies excavation/i, "flag should note excavation-implying name");
    const assumption = quote.assumptions.find((a) => a.includes("surface contour only"));
    assert.ok(assumption, "should add an assumption about possible surface contour");
    assert.match(assumption, /20\.61/, "assumption should include the area");
    assert.match(assumption, /1\.97/, "assumption should include the volume");
  });
});

test("shallow soil depth flag does NOT fire for normal depth soil sections", () => {
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: buildQuoteInputs({
      lineItemCandidates: [
        {
          label: "Shed area levelling — soil removal and disposal",
          description: "Measured spoil from the shed area.",
          quoteCatalogItemCode: "soil-removal",
          quantity: 25.86,
          unit: "m3",
          section: "Shed area levelling",
          confidence: 0.97,
          rationale: "Measured from Moasure output.",
          evidence: [],
          evidenceSummary: [],
        },
      ],
    }),
    moasureSummary: {
      status: "parsed",
      batchCount: 1,
      latestBatchId: "2026-03-12T10-15-00-000Z",
      imports: [
        {
          label: "Shed area levelling",
          batchId: "2026-03-12T10-15-00-000Z",
          area: 20,
          volume: 25.86,
          perimeter: 18,
        },
      ],
    },
    details: {
      soilDump: defaultSoilDump,
    },
  });

  const shallowFlag = (quote.review.reasons || []).find((r) => r.includes("Shallow soil depth flag"));
  assert.ok(!shallowFlag, "should NOT flag a soil section with reasonable depth (1.29m avg)");
});

// DEL-46 (P0, round 4): an unresolvable disposal basis must fail the
// disposal line closed (not-quoteable, with a recorded reason) rather than
// let the quote silently price from the loader component alone — a real,
// cheaper-than-correct customer quote with no pricing issue recorded.

async function withDisposalPriceCatalogAuthorityMissingBasis(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "field-disposal-basis-missing-"));
  try {
    const db = (await createTestPriceCatalog({ priceMaps: null })).store;
    await seedCatalogFromPriceMaps(db, {
      // soil-removal, KANGA-HOUR (loader), and tip-truck price normally —
      // isolating this test to the disposal item specifically, rather than
      // soil-removal's own catalog item also being absent, so the pricing
      // issue recorded is unambiguously about the disposal basis.
      // unclean-fill-disposal exists (so it is not simply "missing item")
      // but has no pricing_basis set — modelling an operator clearing the
      // basis via updateItem(), or a legacy item that predates this
      // episode's schema addition.
      buyMap: { "soil-removal": 68.57, "KANGA-HOUR": 125, "unclean-fill-disposal": 30, "tip-truck": 200 },
      sellMap: { "soil-removal": 91.89, "KANGA-HOUR": 150, "unclean-fill-disposal": 36, "tip-truck": 240 },
      author: "test",
    });
    await refreshQuoteCatalogAuthority({ priceCatalog: db, required: false });
    await run();
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await closeTestPriceCatalogs();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("disposal basis missing ⇒ the soil-removal line is not-quoteable with a recorded pricing issue, never a cheaper price", async () => {
  await withDisposalPriceCatalogAuthorityMissingBasis(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [buildSoilRemovalCandidate()],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    // Before this fix, the line survived at a wrong, cheaper price (priced
    // from the loader component alone, e.g. ~$34/m3 instead of ~$92/m3) with
    // no pricing issue recorded anywhere. It must now be absent entirely —
    // "not-quoteable" — rather than present at any price.
    assert.equal(soilItem, undefined, "soil removal line must not be quoted at any price when the disposal basis is unresolvable");
    assert.equal(quote.review.status, "manual_review");
    assert.ok(
      (quote.review.reasons || []).some((reason) => /unclean-fill-disposal/.test(reason) && /basis/i.test(reason)),
      "review reasons should explain the unresolved disposal basis",
    );
  });
});

test("disposal rule quoted directly in catalog-only mode ⇒ pricing issue, never a $0 line", () => {
  // No refreshQuoteCatalogAuthority call in this test — the quote engine
  // stays in its default "catalog" (no commercial authority) mode, which is
  // exactly the state server/quote-workflow.js proceeds through when the
  // price catalog is unavailable (required: false).
  const quote = generateEvidenceQuote({
    meta: baseMeta,
    transcript: null,
    quoteInputs: buildQuoteInputs({
      lineItemCandidates: [
        {
          label: "Unclean fill disposal",
          description: "Direct disposal line, not derived from a bulk-removal recipe.",
          quoteCatalogItemCode: "unclean-fill-disposal",
          quantity: 12,
          unit: "tonne",
          confidence: 0.9,
          rationale: "Operator added a standalone disposal line.",
          evidence: [],
          evidenceSummary: [],
        },
      ],
    }),
    details: {
      soilDump: defaultSoilDump,
    },
  });

  const disposalItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "unclean-fill-disposal");
  // Before this fix: disposal rules carry no json5 unitPrice (criterion 4),
  // so in catalog-only mode authorityUnitPrice was undefined, the missing-
  // rate guard was skipped because it was gated behind erpAuthorityActive,
  // and totalPrice: roundMoney(quantity * Number(unitPrice || 0)) coerced
  // that straight to a real $0 line with no pricing issue recorded.
  assert.equal(disposalItem, undefined, "a disposal rule with no authority rate and no json5 rate must not quote at $0");
  assert.ok(
    (quote.review.reasons || []).some((reason) => /unclean-fill-disposal/.test(reason)),
    "review reasons should record the missing rate for the disposal rule",
  );
});

// DEL-46 (P2, round 5): mass (tonnes) is only meaningful for a per_tonne
// disposal basis. resolveBulkRemovalMetrics already returned tonnes: null
// for per_load/per_m3 items, but the description/rationale builders still
// ran formatQty(null) through a hardcoded "(x t)" clause, rendering the
// literal false fact "(0 t)" on customer-visible quote text.
async function withDisposalPriceCatalogAuthorityBasis(pricingBasis, pricingBasisFactor, run) {
  const dataDir = await mkdtemp(join(tmpdir(), "field-disposal-basis-alt-"));
  try {
    const db = (await createTestPriceCatalog({ priceMaps: null })).store;
    await seedCatalogFromPriceMaps(db, {
      buyMap: { "KANGA-HOUR": 125, "unclean-fill-disposal": 30, "tip-truck": 200 },
      sellMap: { "KANGA-HOUR": 150, "unclean-fill-disposal": 36, "tip-truck": 240 },
      author: "test",
    });
    await db.updateItem("unclean-fill-disposal", { pricing_basis: pricingBasis, pricing_basis_factor: pricingBasisFactor }, { author: "test" });
    await refreshQuoteCatalogAuthority({ priceCatalog: db, required: false });
    await run();
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await closeTestPriceCatalogs();
    await rm(dataDir, { recursive: true, force: true });
  }
}

for (const [pricingBasis, pricingBasisFactor] of [["per_load", 2], ["per_m3", null]]) {
  test(`${pricingBasis} disposal basis never renders a false "0 t" mass in customer-visible soil-removal text (DEL-46 round 5)`, async () => {
    await withDisposalPriceCatalogAuthorityBasis(pricingBasis, pricingBasisFactor, () => {
      const quote = generateEvidenceQuote({
        meta: baseMeta,
        transcript: null,
        quoteInputs: buildQuoteInputs({
          lineItemCandidates: [buildSoilRemovalCandidate()],
        }),
        details: {
          soilDump: defaultSoilDump,
        },
      });

      const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
      const truckItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "tip-truck");
      const soilBreakdown = findLineItemBreakdown(quote, soilItem?.code);
      const loaderLine = findCommercialLine(soilBreakdown, "KANGA-HOUR");
      const disposalLine = findCommercialLine(soilBreakdown, "unclean-fill-disposal");

      assert.ok(soilItem, `soil removal line should exist for basis ${pricingBasis}`);
      assert.ok(disposalLine, `disposal commercial line should exist for basis ${pricingBasis}`);
      assert.doesNotMatch(soilItem.description || "", /\(0 t\)/, `soil item description leaked a false "(0 t)" for basis ${pricingBasis}`);
      assert.doesNotMatch(soilItem.rationale || "", /0 t\b/, `soil item rationale leaked a false "0 t" for basis ${pricingBasis}`);
      assert.doesNotMatch(loaderLine?.description || "", /\(0 t\)/, `loader line description leaked a false "(0 t)" for basis ${pricingBasis}`);
      if (truckItem) {
        assert.doesNotMatch(truckItem.rationale || "", /0 t\b/, `haulage rationale leaked a false "0 t" for basis ${pricingBasis}`);
      }
    });
  });
}

// DEL-46 (P1, round 6): a disposal item with a VALID basis/factor but no
// sell price used to silently produce a real $0 disposal line and a cheap
// parent quote, with no pricing issue recorded — root-caused to
// quote-catalogs.js's normalizeRule() coercing an absent json5 unitPrice to
// 0 (Number(rule.unitPrice || 0)), which every consumer of rule.unitPrice
// downstream (resolveRuleSellRate, isRuleQuoteable, resolveRuleRates) then
// treated as a real, finite $0 rate via Number.isFinite(Number(x)) checks
// that don't distinguish an authored 0 from a coerced one.
async function withDisposalPriceCatalogAuthorityNoSellPrice(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "field-disposal-basis-no-sell-"));
  try {
    const db = (await createTestPriceCatalog({ priceMaps: null })).store;
    await seedCatalogFromPriceMaps(db, {
      // unclean-fill-disposal is intentionally in buyMap only, never
      // sellMap, so seedCatalogFromPriceMaps creates it with sell_price: null —
      // a valid basis/factor but a genuinely absent sell rate, exactly the
      // reviewer-reproduced scenario (the editor and createItem() both
      // permit this combination; validatePricingBasis never requires a
      // price).
      buyMap: { "soil-removal": 68.57, "KANGA-HOUR": 125, "unclean-fill-disposal": 30, "tip-truck": 200 },
      sellMap: { "soil-removal": 91.89, "KANGA-HOUR": 150, "tip-truck": 240 },
      author: "test",
    });
    await db.updateItem("unclean-fill-disposal", { pricing_basis: "per_tonne", pricing_basis_factor: 1.6 }, { author: "test" });
    await refreshQuoteCatalogAuthority({ priceCatalog: db, required: false });
    await run();
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await closeTestPriceCatalogs();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("disposal basis present but sell price null ⇒ not-quoteable with a recorded pricing issue, never a $0 line or a cheap parent (DEL-46 round 6)", async () => {
  await withDisposalPriceCatalogAuthorityNoSellPrice(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [buildSoilRemovalCandidate()],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    // Before this fix: rates.unitPrice resolved to a real 0 (not null), so
    // buildBulkDisposalLine's `rates.unitPrice == null` guard passed and
    // built a real $0 disposal line, which made the parent soil-removal
    // line quote cheap (loader cost only) with no pricing issue recorded
    // anywhere — the exact "30 m3 at $34.29/m3 instead of ~$92/m3" case the
    // reviewer reproduced. It must now be absent entirely.
    assert.equal(soilItem, undefined, "soil removal line must not be quoted at any price when the disposal item has no sell price");
    assert.equal(quote.review.status, "manual_review");
    assert.ok(
      (quote.review.reasons || []).some((reason) => /unclean-fill-disposal/.test(reason)),
      "review reasons should explain the unresolved disposal pricing",
    );
  });
});

// DEL-46 (P2-B, round 7): an AUTHORED sell_price of exactly 0 (which the
// price-catalog API permits — "zero or greater") is a different case from a
// null sell_price, and used to still quote a real $0 line on the direct
// (non-recipe) route. generate-evidence-quote.js's authorityUnitPrice
// computation has two branches: the non-erp branch already applied a `> 0`
// threshold (round 6), but the erp branch only checked `!= null`, so
// authoritySellRate === 0 passed straight through. The recipe route
// (buildBulkDisposalLine) already rejected an authored zero via the same
// `> 0` threshold, so the two routes disagreed about what a $0 rate means.
async function withDisposalPriceCatalogAuthorityZeroSellPrice(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "field-disposal-basis-zero-sell-"));
  try {
    const db = (await createTestPriceCatalog({ priceMaps: null })).store;
    await seedCatalogFromPriceMaps(db, {
      buyMap: { "soil-removal": 68.57, "KANGA-HOUR": 125, "unclean-fill-disposal": 30, "tip-truck": 200 },
      // unclean-fill-disposal is authored at sell_price: 0 explicitly — not
      // absent, a real zero the operator (or a bad import) actually set.
      sellMap: { "soil-removal": 91.89, "KANGA-HOUR": 150, "tip-truck": 240, "unclean-fill-disposal": 0 },
      author: "test",
    });
    await db.updateItem("unclean-fill-disposal", { pricing_basis: "per_tonne", pricing_basis_factor: 1.6 }, { author: "test" });
    await refreshQuoteCatalogAuthority({ priceCatalog: db, required: false });
    await run();
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await closeTestPriceCatalogs();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("disposal basis present with an authored $0 sell price ⇒ not-quoteable on the recipe route, never a $0 line (DEL-46 round 7)", async () => {
  await withDisposalPriceCatalogAuthorityZeroSellPrice(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [buildSoilRemovalCandidate()],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const soilItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "soil-removal");
    assert.equal(soilItem, undefined, "soil removal line must not be quoted at any price when the disposal item is authored at $0");
    assert.equal(quote.review.status, "manual_review");
    assert.ok(
      (quote.review.reasons || []).some((reason) => /unclean-fill-disposal/.test(reason)),
      "review reasons should explain the unresolved disposal pricing",
    );
  });
});

test("disposal rule quoted directly with an authored $0 sell price under price-catalog authority ⇒ not-quoteable, never a $0 line (DEL-46 round 7)", async () => {
  await withDisposalPriceCatalogAuthorityZeroSellPrice(() => {
    const quote = generateEvidenceQuote({
      meta: baseMeta,
      transcript: null,
      quoteInputs: buildQuoteInputs({
        lineItemCandidates: [{
          label: "Unclean fill disposal",
          description: "Direct disposal line, not derived from a bulk-removal recipe.",
          quoteCatalogItemCode: "unclean-fill-disposal",
          quantity: 12,
          unit: "tonne",
          confidence: 0.9,
          rationale: "Operator added a standalone disposal line.",
          evidence: [],
          evidenceSummary: [],
        }],
      }),
      details: {
        soilDump: defaultSoilDump,
      },
    });

    const disposalItem = quote.lineItems.find((item) => item.quoteCatalogItemCode === "unclean-fill-disposal");
    // Before this fix: authoritySellRate resolved to a real 0, authorityUnitPrice
    // was `authoritySellRate != null ? roundMoney(authoritySellRate) : null`
    // = 0 (not null), so the missing-rate guard at generate-evidence-quote.js
    // passed and the line quoted at a real $0 with no pricing issue.
    assert.equal(disposalItem, undefined, "a disposal rule authored at $0 must not quote at $0 either — it must fail closed");
    assert.ok(
      (quote.review.reasons || []).some((reason) => /unclean-fill-disposal/.test(reason)),
      "review reasons should record the unresolved rate for the disposal rule",
    );
  });
});
