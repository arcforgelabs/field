import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWallZoneRenderPayloadForJob,
  buildRetainingWallQuoteContextForJob,
  findWallZonesForBreakdown,
  readWallZones,
} from "./wall-zones.js";
import { buildTestRateCard } from "./test-pricing-fixtures.js";
import { renderRetainingWallStandaloneHtml } from "../shared/retaining-wall-render.js";

function createMinimalBayModel() {
  return {
    total_active_bays: 1,
    total_sleepers: 5,
    total_holes: 2,
    wall_charge: 934.56,
    ancillaries_charge: 300,
    ancillaries_cost: 200,
    total_charge: 1234.56,
    total_cost: 676.54,
    perimeter_m: 2.01,
    tier_counts: { 1: 1 },
    ancillary_lines: [
      {
        source: "retaining_wall_engine",
        scope: "ancillary",
        itemCode: "ADMIN-FEE",
        label: "Admin Fee",
        description: "Quote administration and coordination",
        category: "overhead",
        quantity: 1,
        unit: "job",
      },
    ],
    bays: [
      {
        bay_id: 1,
        is_active: true,
        tier_count: 1,
        max_height_m: 1.0,
        resource_lines: [
          {
            source: "retaining_wall_engine",
            scope: "wall",
            itemCode: "SLEEPER-KENSINGTON",
            label: "Kensington Sleeper",
            description: "Concrete sleepers for bay 1.",
            category: "materials",
            quantity: 5,
            unit: "each",
          },
        ],
        geometry: {
          x_start: 0,
          y_start: 0,
          z_start: 0,
          x_end: 2.01,
          y_end: 0,
          z_end: 0,
        },
        walls: [
          {
            wall_height_m: 1.0,
          },
        ],
      },
    ],
  };
}

test("readWallZones falls back to a primary wall zone for legacy single-wall jobs", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await writeFile(join(jobDir, "bay-model.json"), JSON.stringify(createMinimalBayModel(), null, 2));
  await writeFile(join(jobDir, "wall-design.json"), JSON.stringify({
    _description: "Legacy retaining wall",
    _address: "9 Example Crescent",
  }, null, 2));

  const wallZones = await readWallZones(jobDir);
  assert.equal(wallZones?.zones?.length, 1);
  assert.equal(wallZones.zones[0].id, "primary-wall");
  assert.deepEqual(wallZones.zones[0].lineItemCodes, ["cs-wall", "rock-wall"]);
  assert.equal(wallZones.zones[0].sourceMode, "probe");
});

test("buildWallZoneRenderPayloadForJob reads summary artifacts and preserves fallback source mode", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await mkdir(join(jobDir, "generated"), { recursive: true });
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    zones: [
      {
        id: "rear-boundary",
        title: "Rear boundary retaining wall",
        subtitle: "Rear fence line retaining run",
        lineItemCodes: ["retaining-wall__rear-boundary"],
        bayModelPath: "generated/rear-boundary-bay-model.json",
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "generated/rear-boundary-bay-model.json"), JSON.stringify({
    zone: {
      notes: ["Profile fallback was used for this zone."],
    },
    measurement: {
      sourceMode: "path1_profile_from_origin",
    },
    model: createMinimalBayModel(),
  }, null, 2));

  const payload = await buildWallZoneRenderPayloadForJob({
    jobDir,
    rateCard: buildTestRateCard(),
    zoneId: "rear-boundary",
  });

  assert.equal(payload?.zoneId, "rear-boundary");
  assert.equal(payload?.sourceMode, "profile_fallback");
  assert.equal(payload?.sourceModeDetail, "path1_profile_from_origin");
  assert.equal(payload?.metrics?.totalActiveBays, 1);
  assert.equal(payload?.notes?.[0], "Profile fallback was used for this zone.");
  assert.ok(Array.isArray(payload?.plot?.data));
  assert.ok(payload?.plot?.data.length >= 2);
  assert.equal(payload?.pricing?.source, "model_estimate");
  assert.equal(payload?.pricing?.charge, 934.56);
  assert.equal(payload?.pricing?.cost, 476.54);
});

test("findWallZonesForBreakdown matches by line item code and falls back when only one zone exists", () => {
  const matched = findWallZonesForBreakdown({
    breakdown: {
      recipe: "retaining_wall_exact",
      sourceLineItemCode: "retaining-wall__rear-boundary",
    },
    wallZones: {
      zones: [
        {
          id: "rear-boundary",
          title: "Rear boundary",
          lineItemCodes: ["retaining-wall__rear-boundary"],
        },
        {
          id: "back-left",
          title: "Back left",
          lineItemCodes: ["retaining-wall__back-left"],
        },
      ],
    },
  });
  assert.deepEqual(matched.map((zone) => zone.id), ["rear-boundary"]);

  const fallback = findWallZonesForBreakdown({
    breakdown: {
      recipe: "retaining_wall_exact",
      sourceLineItemCode: "cs-wall",
    },
    wallZones: {
      zones: [
        {
          id: "primary-wall",
          title: "Primary wall",
          lineItemCodes: ["different-code"],
        },
      ],
    },
  });
  assert.deepEqual(fallback.map((zone) => zone.id), ["primary-wall"]);

  const ancillary = findWallZonesForBreakdown({
    breakdown: {
      recipe: "retaining_wall_ancillary",
      sourceLineItemCode: "ancillaries",
    },
    wallZones: {
      zones: [
        {
          id: "primary-wall",
          title: "Primary wall",
          lineItemCodes: ["different-code"],
        },
      ],
    },
  });
  assert.deepEqual(ancillary, []);
});

test("findWallZonesForBreakdown matches direct pass-through retaining wall sections", () => {
  const matched = findWallZonesForBreakdown({
    breakdown: {
      recipe: "direct_pass_through",
      sourceLineItemCode: "retaining-wall__section-retaining-wall-rear-fence-line",
      section: "Retaining Wall — Rear Fence Line",
      sourceLineItemLabel: "Retaining wall construction",
    },
    wallZones: {
      zones: [
        {
          id: "rear-boundary",
          title: "Rear boundary",
          lineItemCodes: ["retaining-wall__section-retaining-wall-rear-fence-line"],
          sections: ["Retaining Wall — Rear Fence Line"],
        },
      ],
    },
  });

  assert.deepEqual(matched.map((zone) => zone.id), ["rear-boundary"]);
});

test("findWallZonesForBreakdown matches relabelled retaining wall sections by semantic tokens and length", () => {
  const matched = findWallZonesForBreakdown({
    breakdown: {
      recipe: "direct_pass_through",
      sourceLineItemCode: "retaining-wall__section-retaining-wall-zone-2-to-zone-3",
      section: "Retaining wall - Zone 2 to Zone 3",
      sourceLineItemLabel: "Retaining wall construction",
      sourceQuantity: 7,
    },
    wallZones: {
      zones: [
        {
          id: "zone-2-to-zone-3",
          title: "Zone 2 to Zone 3 retaining wall",
          lineItemCodes: ["retaining-wall__section-retaining-wall-tier-2-to-lowest"],
          sections: ["Retaining Wall — Tier 2 to Lowest"],
          expectedLengthM: 7.03,
        },
        {
          id: "zone-1-to-zone-2",
          title: "Zone 1 to Zone 2 retaining wall",
          lineItemCodes: ["retaining-wall__section-retaining-wall-tier-1-to-tier-2"],
          sections: ["Retaining Wall — Tier 1 to Tier 2"],
          expectedLengthM: 6.36,
        },
      ],
    },
  });

  assert.deepEqual(matched.map((zone) => zone.id), ["zone-2-to-zone-3"]);
});

test("buildWallZoneRenderPayloadForJob prefers matched quote pricing over model estimate", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await mkdir(join(jobDir, "generated"), { recursive: true });
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    zones: [
      {
        id: "rear-boundary",
        title: "Rear boundary retaining wall",
        sections: ["Retaining Wall — Rear Fence Line"],
        lineItemCodes: ["retaining-wall__section-retaining-wall-rear-fence-line"],
        bayModelPath: "generated/rear-boundary-bay-model.json",
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "generated/rear-boundary-bay-model.json"), JSON.stringify({
    measurement: {
      sourceMode: "path1_profile_from_origin",
    },
    model: {
      ...createMinimalBayModel(),
      total_charge: 9999,
      total_cost: 7777,
    },
  }, null, 2));

  const payload = await buildWallZoneRenderPayloadForJob({
    jobDir,
    rateCard: buildTestRateCard(),
    zoneId: "rear-boundary",
    quote: {
      lineItems: [
        {
          code: "retaining-wall__section-retaining-wall-rear-fence-line",
          section: "Retaining Wall — Rear Fence Line",
          totalPrice: 5460,
          totalCost: 5460,
        },
      ],
      internalPricing: {
        lineItemBreakdowns: [
          {
            sourceLineItemCode: "retaining-wall__section-retaining-wall-rear-fence-line",
            section: "Retaining Wall — Rear Fence Line",
            totals: {
              charge: 5460,
              cost: 5460,
            },
          },
        ],
      },
    },
  });

  assert.equal(payload?.pricing?.source, "quote_breakdown");
  assert.equal(payload?.pricing?.charge, 5460);
  assert.equal(payload?.pricing?.cost, 5460);
  assert.equal(payload?.pricing?.customerPrice, 5460);
  assert.equal(payload?.metrics?.totalCharge, 5460);
  assert.equal(payload?.metrics?.totalCost, 5460);
  assert.match(payload?.notes?.[0] || "", /Model estimate differs from the live quote/);
});

test("buildWallZoneRenderPayloadForJob matches relabelled quote sections back to the wall zone", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await mkdir(join(jobDir, "generated"), { recursive: true });
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    zones: [
      {
        id: "zone-2-to-zone-3",
        title: "Zone 2 to Zone 3 retaining wall",
        sections: ["Retaining Wall — Tier 2 to Lowest"],
        lineItemCodes: ["retaining-wall__section-retaining-wall-tier-2-to-lowest"],
        expectedLengthM: 7.03,
        bayModelPath: "generated/zone-2-to-zone-3-bay-model.json",
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "generated/zone-2-to-zone-3-bay-model.json"), JSON.stringify({
    measurement: {
      sourceMode: "path1_profile_from_origin",
      perimeterM: 7.03,
    },
    model: {
      ...createMinimalBayModel(),
      perimeter_m: 7.03,
      total_charge: 9999,
      total_cost: 7777,
    },
  }, null, 2));

  const payload = await buildWallZoneRenderPayloadForJob({
    jobDir,
    rateCard: buildTestRateCard(),
    zoneId: "zone-2-to-zone-3",
    quote: {
      lineItems: [
        {
          code: "retaining-wall__section-retaining-wall-zone-2-to-zone-3",
          section: "Retaining wall - Zone 2 to Zone 3",
          label: "Retaining wall construction",
          quantity: 7,
          totalPrice: 4420.58,
          totalCost: 2967.63,
        },
      ],
      internalPricing: {
        lineItemBreakdowns: [
          {
            sourceLineItemCode: "retaining-wall__section-retaining-wall-zone-2-to-zone-3",
            section: "Retaining wall - Zone 2 to Zone 3",
            sourceLineItemLabel: "Retaining wall construction",
            sourceQuantity: 7,
            totals: {
              charge: 4420.58,
              cost: 2967.63,
            },
          },
        ],
      },
    },
  });

  assert.equal(payload?.pricing?.source, "quote_breakdown");
  assert.equal(payload?.pricing?.charge, 4420.58);
  assert.equal(payload?.pricing?.cost, 2967.63);
});

test("buildWallZoneRenderPayloadForJob ignores non-wall sections that share zone tokens", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await mkdir(join(jobDir, "generated"), { recursive: true });
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    zones: [
      {
        id: "zone-1-to-zone-2",
        title: "Zone 1 to Zone 2 retaining wall",
        sections: ["Retaining wall - Zone 1 to Zone 2"],
        lineItemCodes: ["retaining-wall__section-retaining-wall-zone-1-to-zone-2"],
        expectedLengthM: 6.36,
        bayModelPath: "generated/zone-1-to-zone-2-bay-model.json",
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "generated/zone-1-to-zone-2-bay-model.json"), JSON.stringify({
    measurement: {
      sourceMode: "path1_profile_from_origin",
      perimeterM: 6.36,
    },
    model: {
      ...createMinimalBayModel(),
      perimeter_m: 6.36,
      total_charge: 9999,
      total_cost: 7777,
    },
  }, null, 2));

  const payload = await buildWallZoneRenderPayloadForJob({
    jobDir,
    rateCard: buildTestRateCard(),
    zoneId: "zone-1-to-zone-2",
    quote: {
      lineItems: [
        {
          code: "site-levelling__section-zone-1-terrace-1-levelling",
          quoteCatalogItemCode: "site-levelling",
          section: "Zone 1 - Terrace 1 levelling",
          label: "Zone 1 - Terrace 1 levelling and ramp tie-in",
          quantity: 2.85,
          totalPrice: 3419.98,
          totalCost: 2288.45,
        },
        {
          code: "retaining-wall__section-retaining-wall-zone-1-to-zone-2",
          quoteCatalogItemCode: "retaining-wall",
          section: "Retaining wall - Zone 1 to Zone 2",
          label: "Retaining wall construction",
          quantity: 6,
          totalPrice: 5460,
          totalCost: 4000,
        },
      ],
      internalPricing: {
        lineItemBreakdowns: [
          {
            sourceLineItemCode: "site-levelling__section-zone-1-terrace-1-levelling",
            sourceSection: "Zone 1 - Terrace 1 levelling",
            sourceLineItemLabel: "Zone 1 - Terrace 1 levelling and ramp tie-in",
            sourceQuantity: 2.85,
            totals: {
              charge: 3419.98,
              cost: 2288.45,
            },
          },
          {
            sourceLineItemCode: "retaining-wall__section-retaining-wall-zone-1-to-zone-2",
            sourceSection: "Retaining wall - Zone 1 to Zone 2",
            sourceLineItemLabel: "Retaining wall construction",
            sourceQuantity: 6,
            totals: {
              charge: 5460,
              cost: 4000,
            },
          },
        ],
      },
    },
  });

  assert.equal(payload?.pricing?.source, "quote_breakdown");
  assert.equal(payload?.pricing?.charge, 5460);
  assert.equal(payload?.pricing?.cost, 4000);
  assert.equal(payload?.metrics?.totalCharge, 5460);
  assert.equal(payload?.metrics?.totalCost, 4000);
});

test("buildRetainingWallQuoteContextForJob exposes exact wall-only breakdowns for sectioned jobs", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await mkdir(join(jobDir, "generated"), { recursive: true });
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    zones: [
      {
        id: "rear-boundary",
        title: "Rear boundary retaining wall",
        sections: ["Retaining Wall — Rear Fence Line"],
        lineItemCodes: ["retaining-wall__section-retaining-wall-rear-fence-line"],
        bayModelPath: "generated/rear-boundary-bay-model.json",
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "generated/rear-boundary-bay-model.json"), JSON.stringify({
    measurement: {
      sourceMode: "path1_profile_from_origin",
    },
    model: createMinimalBayModel(),
  }, null, 2));

  const context = await buildRetainingWallQuoteContextForJob({
    jobDir,
    rateCard: buildTestRateCard(),
  });

  assert.equal(context?.zones?.length, 1);
  assert.equal(context.zones[0].exactWallBreakdown.recipe, "retaining_wall_exact");
  assert.equal(context.zones[0].exactWallBreakdown.commercialLines.some((line) => line.itemCode === "SLEEPER-KENSINGTON"), true);
  assert.equal(context.zones[0].exactWallBreakdown.materialOrders.some((order) => order.itemCode === "SLEEPER-KENSINGTON"), true);
  assert.ok(context.zones[0].exactWallBreakdown.totals.charge > 0);
  assert.ok(context.zones[0].exactWallBreakdown.totals.cost > 0);
});

test("buildWallZoneRenderPayloadForJob regenerates a clipped fallback model from source csv", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    baseDesign: {
      construction_rules: {
        bay_pitch_mm: 2010,
        min_remainder_for_extra_bay_mm: 500,
        max_sleepers_per_wall: 5,
        sleeper_height_mm: 200,
        tier2_trigger_m: 1.2,
        tier3_trigger_m: 2.4,
        protrusion_mm: 100,
        horizontal_step_mm: 600,
        post_below_ground_rule: "above_ground + 200mm",
        angle_threshold_degrees: 5,
        weld_time_minutes: 2,
        bags_per_hole: 8,
        pad_concrete_bags_per_2_bays: 0.5,
        cure_days: 2,
        sleeper_install_minutes_per_sleeper: 2,
      },
      design_overrides: {
        mower_gap_bays: [],
        cap_single_tier_bays: [],
        stairs: [],
      },
      process_times: {
        cutback_minutes: { "1T": 15, "2T": 25, "3T": 35 },
        drill_hours_per_hole: 1,
        concrete_minutes_per_post: 30,
        pad_height_minutes_per_post: 5,
        drainage_minutes_per_bay: 15,
        backfill_minutes: { "1T": 5, "2T": 10, "3T": 15 },
      },
      site: {
        distance_km_one_way: 18,
        crew_size: 3,
        estimated_site_days: 5,
      },
    },
    zones: [
      {
        id: "zone-2-to-zone-3",
        title: "Zone 2 to Zone 3 retaining wall",
        sourceCsvPath: "zone.csv",
        expectedLengthM: 7.03,
        profileSegment: {
          path: 1,
          fromPoint: 1,
          toPoint: 2,
        },
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "zone.csv"), [
    "\"Layer\",\"Path\",\"Point\",\"X:m\",\"Y:m\",\"Z:m\",\"Layer-Name\",\"Path-Type\",\"Point-Name\",\"Point-Type\",\"Area:m²\",",
    "\"1\",\"1\",\"1\",\"0.000\",\"0.000\",\"0.000\",\"Base Layer\",\"Dot2Dot\",\"\",\"Default\",\"\"",
    "\"1\",\"1\",\"2\",\"7.029\",\"-0.000\",\"-0.402\",\"Base Layer\",\"Dot2Dot\",\"\",\"Default\",\"\"",
    "\"1\",\"1\",\"3\",\"6.950\",\"7.766\",\"0.135\",\"Base Layer\",\"Dot2Dot\",\"\",\"Default\",\"\"",
  ].join("\n"));

  const payload = await buildWallZoneRenderPayloadForJob({
    jobDir,
    rateCard: buildTestRateCard(),
    zoneId: "zone-2-to-zone-3",
  });

  assert.equal(payload?.sourceMode, "profile_fallback");
  assert.equal(payload?.metrics?.perimeterM, 7.029);
  assert.equal(payload?.metrics?.totalActiveBays, 4);
});

test("buildWallZoneRenderPayloadForJob emits standalone wall traces plus Moasure overlays", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    baseDesign: {
      construction_rules: {
        bay_pitch_mm: 2010,
        min_remainder_for_extra_bay_mm: 500,
        max_sleepers_per_wall: 5,
        sleeper_height_mm: 200,
        tier2_trigger_m: 1.2,
        tier3_trigger_m: 2.4,
        protrusion_mm: 100,
        horizontal_step_mm: 600,
        post_below_ground_rule: "above_ground + 200mm",
        angle_threshold_degrees: 5,
        weld_time_minutes: 2,
        bags_per_hole: 8,
        pad_concrete_bags_per_2_bays: 0.5,
        cure_days: 2,
        sleeper_install_minutes_per_sleeper: 2,
      },
      design_overrides: {
        mower_gap_bays: [],
        cap_single_tier_bays: [],
        stairs: [],
      },
      process_times: {
        cutback_minutes: { "1T": 15, "2T": 25, "3T": 35 },
        drill_hours_per_hole: 1,
        concrete_minutes_per_post: 30,
        pad_height_minutes_per_post: 5,
        drainage_minutes_per_bay: 15,
        backfill_minutes: { "1T": 5, "2T": 10, "3T": 15 },
      },
      site: {
        distance_km_one_way: 18,
        crew_size: 3,
        estimated_site_days: 5,
      },
    },
    zones: [
      {
        id: "rear-boundary",
        title: "Rear boundary retaining wall",
        sourceCsvPath: "rear-boundary.csv",
        expectedLengthM: 4.02,
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "rear-boundary.csv"), [
    "\"Layer\",\"Path\",\"Point\",\"X:m\",\"Y:m\",\"Z:m\",\"Layer-Name\",\"Path-Type\",\"Point-Name\",\"Point-Type\",\"Area:m²\",",
    "\"1\",\"1\",\"1\",\"0.000\",\"0.000\",\"0.000\",\"Base Layer\",\"Dot2Dot\",\"\",\"Default\",\"\"",
    "\"1\",\"1\",\"2\",\"2.010\",\"0.000\",\"0.100\",\"Base Layer\",\"Dot2Dot\",\"\",\"Default\",\"\"",
    "\"1\",\"1\",\"3\",\"4.020\",\"0.000\",\"0.200\",\"Base Layer\",\"Dot2Dot\",\"\",\"Default\",\"\"",
    "\"1\",\"2\",\"1\",\"0.100\",\"0.300\",\"-0.650\",\"Base Layer\",\"Points\",\"\",\"Default\",\"\"",
    "\"1\",\"2\",\"2\",\"2.050\",\"0.350\",\"-0.950\",\"Base Layer\",\"Points\",\"\",\"Default\",\"\"",
    "\"1\",\"2\",\"3\",\"4.000\",\"0.250\",\"-1.200\",\"Base Layer\",\"Points\",\"\",\"Default\",\"\"",
  ].join("\n"));

  const payload = await buildWallZoneRenderPayloadForJob({
    jobDir,
    rateCard: buildTestRateCard(),
    zoneId: "rear-boundary",
  });

  assert.ok(payload?.measurementOverlay);
  assert.equal(payload?.measurementOverlay?.path1?.length, 3);
  assert.equal(payload?.measurementOverlay?.path2?.length, 3);
  assert.equal(payload?.measurementOverlay?.path2?.[0]?.nearestBayId, 1);

  const traceNames = (payload?.plot?.data || []).map((trace) => trace.name);
  assert.deepEqual(
    traceNames.slice(0, 3),
    ["Engine perimeter profile", "Moasure boundary (path 1)", "Moasure probes (path 2)"],
  );

  const html = renderRetainingWallStandaloneHtml({ payload });
  assert.match(html, /Moasure boundary \(path 1\)/);
  assert.match(html, /Moasure probes \(path 2\)/);
});

test("buildRetainingWallQuoteContextForJob blocks stale profile fallback artifacts that drift from the scoped wall length", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-zones-"));
  await mkdir(join(jobDir, "generated"), { recursive: true });
  await writeFile(join(jobDir, "wall-zones.json"), JSON.stringify({
    kind: "wall-zones",
    version: 1,
    zones: [
      {
        id: "zone-2-to-zone-3",
        title: "Zone 2 to Zone 3 retaining wall",
        expectedLengthM: 7.03,
        bayModelPath: "generated/zone-2-to-zone-3-bay-model.json",
      },
    ],
  }, null, 2));
  await writeFile(join(jobDir, "generated/zone-2-to-zone-3-bay-model.json"), JSON.stringify({
    measurement: {
      sourceMode: "path1_profile_from_origin",
      perimeterM: 14.795,
    },
    model: {
      ...createMinimalBayModel(),
      perimeter_m: 14.795,
    },
  }, null, 2));

  const context = await buildRetainingWallQuoteContextForJob({
    jobDir,
    rateCard: buildTestRateCard(),
  });

  assert.equal(context, null);
});
