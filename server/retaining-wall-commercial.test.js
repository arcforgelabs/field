import assert from "node:assert/strict";
import test from "node:test";
import { buildTestRateCard } from "./test-pricing-fixtures.js";
import { buildBayResourceLines, buildQuoteFromWallModel } from "./retaining-wall-commercial.js";
import { buildBayModel } from "./retaining-wall-engine.js";

test("buildBayResourceLines emits stocked steel item codes instead of LM lines when post stock lengths are known", () => {
  const lines = buildBayResourceLines({
    bay: {
      bay_id: 4,
      tierCount: 1,
      totalSleepers: 5,
      totalHoles: 3,
      totalConcreteBags: 24,
      posts: [
        {
          material: "cchannel",
          post_length_m: 2.2,
          stock_item_code: "STEEL-CCHANNEL-125-GALV-2200",
          stock_label: "C-Channel 125 Galv 2200mm",
          stock_unit: "each",
        },
        {
          material: "ibeam",
          post_length_m: 2.2,
          stock_item_code: "STEEL-IBEAM-125-GALV-2200",
          stock_label: "I-Beam 125 Galv 2200mm",
          stock_unit: "each",
        },
        {
          material: "cchannel",
          is_double_cchannel: true,
          post_length_m: 1.8,
          stock_item_code: "STEEL-CCHANNEL-125-GALV-1800",
          stock_label: "C-Channel 125 Galv 1800mm",
          stock_unit: "each",
        },
      ],
    },
    design: {
      construction_rules: {
        pad_concrete_bags_per_2_bays: 0.5,
        sleeper_install_minutes_per_sleeper: 2,
        weld_time_minutes: 2,
      },
      process_times: {
        cutback_minutes: { "1T": 15 },
        drill_hours_per_hole: 1,
        concrete_minutes_per_post: 30,
        pad_height_minutes_per_post: 5,
        drainage_minutes_per_bay: 15,
        backfill_minutes: { "1T": 5 },
      },
    },
    rateCard: {
      materials: {
        gravel_20mm: { tonnes_per_bay: 0.125 },
      },
    },
  });

  const steelLines = lines.filter((line) => String(line.itemCode).startsWith("STEEL-"));
  assert.deepEqual(
    steelLines.map((line) => [line.itemCode, line.quantity, line.unit]),
    [
      ["STEEL-CCHANNEL-125-GALV-2200", 1, "each"],
      ["STEEL-IBEAM-125-GALV-2200", 1, "each"],
      ["STEEL-CCHANNEL-125-GALV-1800", 2, "each"],
    ]
  );
  assert.equal(steelLines.some((line) => line.itemCode === "STEEL-IBEAM-125-GALV" || line.itemCode === "STEEL-CCHANNEL-125-GALV"), false);
});

test("buildQuoteFromWallModel exposes exact internal commercial and budget lines", () => {
  const quote = buildQuoteFromWallModel({
    model: {
      total_active_bays: 1,
      total_sleepers: 5,
      total_holes: 2,
      total_welds: 0,
      bays: [
        {
          is_active: true,
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
            {
              source: "retaining_wall_engine",
              scope: "wall",
              itemCode: "EXCAVATOR-HOUR",
              label: "Excavator Hour",
              description: "Excavator work for bay 1.",
              category: "machines",
              quantity: 2.5,
              unit: "hour",
            },
          ],
        },
      ],
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
    },
    design: {
      quote_number: "EQ-TEST-01",
    },
    rateCard: {
      markup: { materials: 0.2, default: 0.2 },
      materials: {
        kensington_sleeper: { cost_ex_gst: 38.18, charge_ex_gst: 45.82 },
      },
      machines: {
        excavator: { cost_hr: 180, charge_hr: 300 },
      },
      labour: {},
      vehicle: {},
      site: {
        admin_cost: 200,
        admin_charge: 300,
      },
      delivery: {
        gravel_bays_per_trip: 8,
        apc_free_threshold_sleepers: 40,
        apc_minimum_charge_inc_gst: 170,
      },
    },
    meta: {
      id: "job-test",
      jobNumber: "JOB-TEST-01",
      title: "Test retaining wall",
    },
  });

  assert.equal(quote.quoteNumber, "EQ-TEST-01");
  assert.equal(quote.commercialLines.length, 3);
  assert.equal(quote.budgetLines.length, 3);
  assert.deepEqual(
    quote.commercialLines.map((line) => line.itemCode),
    ["SLEEPER-KENSINGTON", "EXCAVATOR-HOUR", "ADMIN-FEE"]
  );
  assert.equal(quote.lineItems.length, 2);
  assert.equal(quote.lineItems[0].label, "Concrete Sleeper Wall — Supply & Install");
  assert.equal(quote.lineItems[1].label, "Stairs, Earthworks, Delivery & Admin");
  assert.deepEqual(
    quote.materialOrders.map((order) => order.itemCode),
    ["SLEEPER-KENSINGTON"]
  );
  assert.equal(quote.internalPricing.lineItemBreakdowns[0].materialOrders[0].itemCode, "SLEEPER-KENSINGTON");
  assert.equal(quote.totals.subtotal, 1279.1);
  assert.ok(quote.internalPricing.lineItemBreakdowns[0].commercialLines[0].trace);
  assert.ok(quote.internalPricing.lineItemBreakdowns[0].commercialLines[0].trace.references.some((entry) => entry.path === "wall-design.json"));
  assert.ok(quote.internalPricing.lineItemBreakdowns[0].commercialLines[1].trace.formulas.some((entry) => /Aggregated|Excavator hours/i.test(entry.expression)));
});

test("buildQuoteFromWallModel sorts wall commercial lines into stable system groups", () => {
  const quote = buildQuoteFromWallModel({
    model: {
      total_active_bays: 1,
      total_sleepers: 5,
      total_holes: 2,
      total_welds: 1,
      bays: [
        {
          is_active: true,
          resource_lines: [
            {
              source: "retaining_wall_engine",
              scope: "wall",
              itemCode: "WELDER-HOUR",
              label: "Welder Hour",
              description: "Double c-channel welds for bay 5.",
              category: "labour",
              quantity: 0.2,
              unit: "hour",
            },
            {
              source: "retaining_wall_engine",
              scope: "wall",
              itemCode: "STEEL-IBEAM-125-GALV-1000",
              label: "I-Beam 125 Galv 1000mm",
              description: "I-beam posts for bay 15.",
              category: "materials",
              quantity: 6,
              unit: "each",
            },
            {
              source: "retaining_wall_engine",
              scope: "wall",
              itemCode: "CONCRETE-20KG-BAG",
              label: "Concrete 20kg Bag",
              description: "Post and pad concrete for bay 1.",
              category: "materials",
              quantity: 25,
              unit: "bag",
            },
            {
              source: "retaining_wall_engine",
              scope: "wall",
              itemCode: "STEEL-CCHANNEL-125-GALV-2200",
              label: "C-Channel 125 Galv 2200mm",
              description: "C-channel posts for bay 1.",
              category: "materials",
              quantity: 14,
              unit: "each",
            },
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
        },
      ],
      ancillary_lines: [],
    },
    design: {
      quote_number: "EQ-TEST-SORT-01",
    },
    rateCard: {
      markup: { materials: 0.2, default: 0.2 },
      materials: {
        kensington_sleeper: { cost_ex_gst: 38.18, charge_ex_gst: 45.82 },
        ibeam_125_galv: {
          cost_ex_gst: 50,
          charge_ex_gst: 62,
          stock_lengths: [
            { itemCode: "STEEL-IBEAM-125-GALV-1000", itemName: "I-Beam 125 Galv 1000mm", label: "I-Beam 125 Galv 1000mm", unit: "each", lengthMm: 1000, lengthM: 1, cost_ex_gst: 36.36, charge_ex_gst: 43.64 },
          ],
        },
        cchannel_125_galv: {
          cost_ex_gst: 50,
          charge_ex_gst: 62,
          stock_lengths: [
            { itemCode: "STEEL-CCHANNEL-125-GALV-2200", itemName: "C-Channel 125 Galv 2200mm", label: "C-Channel 125 Galv 2200mm", unit: "each", lengthMm: 2200, lengthM: 2.2, cost_ex_gst: 116, charge_ex_gst: 136 },
          ],
        },
        concrete_20kg_bag: { cost: 8.48, charge: 10.36 },
      },
      machines: {},
      labour: {
        welder: { cost_hr: 75, charge_hr: 99.95 },
      },
      vehicle: {},
      site: {},
      delivery: {
        gravel_bays_per_trip: 8,
        apc_free_threshold_sleepers: 40,
        apc_minimum_charge_inc_gst: 170,
      },
    },
    meta: {
      id: "job-test-sort",
      jobNumber: "JOB-TEST-SORT-01",
      title: "Test retaining wall sort order",
    },
  });

  assert.deepEqual(
    quote.internalPricing.lineItemBreakdowns[0].commercialLines.map((line) => line.itemCode),
    [
      "SLEEPER-KENSINGTON",
      "STEEL-CCHANNEL-125-GALV-2200",
      "STEEL-IBEAM-125-GALV-1000",
      "CONCRETE-20KG-BAG",
      "WELDER-HOUR",
    ]
  );
});

test("buildQuoteFromWallModel adds a mixed rock wall alternative without syncing it to price catalog", () => {
  const quote = buildQuoteFromWallModel({
    model: {
      total_active_bays: 1,
      total_sleepers: 5,
      total_holes: 2,
      total_welds: 0,
      perimeter_m: 64.267,
      bays: [
        {
          bay_id: 1,
          is_active: true,
          max_height_m: 1.5,
          geometry: {
            x_start: 0,
            y_start: 0,
            x_end: 2.01,
            y_end: 0,
          },
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
        },
      ],
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
    },
    design: {
      quote_number: "EQ-TEST-02",
      options: {
        rock_wall: {
          enabled: true,
          section_label: "Option 2: Mixed Rock Wall",
          schedule_label: "Mixed Rock Wall — Supply & Install",
          geometry: {
            additional_run_length_m: 30,
            additional_run_average_height_m: 1.1,
            quantity_contingency_factor: 1.15,
          },
          materials: {
            rock_item_code: "BLUESTONE-LARGE",
            rock_label: "Mixed Wall Rock",
            tonnes_per_m2_wall_face: 1,
            include_rabbit_proofing: true,
            rabbit_proofing_manual_rates: {
              costRate: 300,
              chargeRate: 450,
            },
            exclude_standard_ag_drain: true,
            exclude_standard_plastic: true,
          },
          production: {
            labour_hours_per_m2: 0.45,
            excavator_hours_per_m2: 0.35,
            kanga_hours_per_m2: 0.1,
            cut_in_excavator_hours: 12,
            sorting_labour_hours: 10,
            rabbit_proofing_labour_hours: 8,
            first_order_tonnes: 100,
          },
        },
      },
    },
    rateCard: {
      markup: { materials: 0.2, default: 0.2 },
      materials: {
        kensington_sleeper: { cost_ex_gst: 38.18, charge_ex_gst: 45.82 },
        bluestone_large: { cost_ex_gst_per_tonne: 132, charge_ex_gst_per_tonne: 158.4 },
      },
      machines: {
        excavator: { cost_hr: 180, charge_hr: 300 },
        kanga: { cost_hr: 90, charge_hr: 150 },
      },
      labour: {
        general_labourer: { cost_hr: 50, charge_hr: 80 },
      },
      vehicle: {},
      site: {
        admin_cost: 200,
        admin_charge: 300,
      },
      delivery: {
        gravel_bays_per_trip: 8,
        apc_free_threshold_sleepers: 40,
        apc_minimum_charge_inc_gst: 170,
      },
    },
    meta: {
      id: "job-test",
      jobNumber: "JOB-TEST-02",
      title: "Test retaining wall",
      siteAddress: "9 Example Cr, Exampleton 5000",
    },
  });

  assert.equal(quote.lineItems.length, 3);
  assert.equal(quote.lineItems[1].label, "Mixed Rock Wall — Supply & Install");
  assert.match(quote.summary, /mixed rock wall/i);
  assert.equal(quote.commercialLines.every((line) => line.syncToCommercialAuthority !== false), true);
  assert.equal(quote.internalPricing.lineItemBreakdowns.length, 3);

  const rockBreakdown = quote.internalPricing.lineItemBreakdowns.find((item) => item.recipe === "rock_wall_estimate");
  assert.ok(rockBreakdown);
  assert.ok(rockBreakdown.totals.charge > 0);
  assert.equal(rockBreakdown.commercialLines.every((line) => line.syncToCommercialAuthority === false), true);
  assert.ok(rockBreakdown.commercialLines.some((line) => line.itemCode === "KANGA-HOUR"));
  assert.ok(rockBreakdown.materialOrders.some((order) => order.itemCode === "BLUESTONE-LARGE"));
  assert.ok(quote.assumptions.some((item) => /rabbit proofing/i.test(item)));
  assert.ok(rockBreakdown.commercialLines[0].trace.references.some((entry) => entry.path === "wall-design.json"));
  assert.ok(rockBreakdown.commercialLines[0].trace.components.length > 0);
});

test("retaining wall sleeper traces expose bay-level quantity provenance and evidence", () => {
  const design = {
    quote_number: "EQ-CASEY-TRACE",
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
      cap_single_tier_bays: [],
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
      estimated_site_days: 17,
    },
  };
  const rateCard = buildTestRateCard();
  const model = buildBayModel({
    bayHeights: [
      { bay_id: 1, height_m: 0.45, source: "probe" },
      { bay_id: 2, height_m: 0.95, source: "probe" },
      { bay_id: 3, height_m: 2.6, source: "probe" },
    ],
    bayGeometry: [
      { bay_id: 1, x_start: 0, y_start: 0, z_start: 0, x_end: 2.01, y_end: 0, z_end: 0 },
      { bay_id: 2, x_start: 2.01, y_start: 0, z_start: 0, x_end: 4.02, y_end: 0, z_end: 0 },
      { bay_id: 3, x_start: 4.02, y_start: 0, z_start: 0, x_end: 6.03, y_end: 0, z_end: 0 },
    ],
    bendAngles: [],
    design,
    rateCard,
  });
  const quote = buildQuoteFromWallModel({
    model,
    design,
    rateCard,
    meta: {
      id: "job-casey-trace",
      jobNumber: "JOB-CASEY-TRACE",
      title: "Casey-style retaining wall",
    },
  });

  const sleeperLine = quote.internalPricing.lineItemBreakdowns[0].commercialLines.find((line) => line.itemCode === "SLEEPER-KENSINGTON");
  assert.ok(sleeperLine?.trace);
  assert.ok(sleeperLine.trace.quantityDerivation.some((entry) => /source artifacts/i.test(entry.label)));
  assert.ok(sleeperLine.trace.quantityDerivation.some((entry) => /standardized 1-tier bays/i.test(entry.label)));
  assert.ok(sleeperLine.trace.quantityDerivation.some((entry) => /5 \+ 5 \+ 3 = 1 × 13 = 13 sleepers/i.test(entry.expression)));
  assert.ok(sleeperLine.trace.quantityDerivation.some((entry) => /10 \+ 13 = 23 each/i.test(entry.expression)));
  assert.ok(sleeperLine.trace.components.length >= 3);

  const firstBayComponent = sleeperLine.trace.components.find((component) => /bay 1/i.test(component.title));
  assert.ok(firstBayComponent);
  assert.ok(firstBayComponent.quantityDerivation.some((entry) => /Moasure \/ wall-line inputs resolved bay 1/i.test(entry.expression)));
  assert.ok(firstBayComponent.quantityDerivation.some((entry) => /tier 1 = 5 sleepers \(1 m wall height\)/i.test(entry.expression)));
  assert.ok(firstBayComponent.quantityDerivation.some((entry) => /Single-tier override standardized bay 1/i.test(entry.expression)));
  assert.ok(firstBayComponent.references.some((entry) => entry.path === "wall-design.json"));
  assert.ok(firstBayComponent.references.some((entry) => entry.path === "bay-heights.json"));
  assert.ok(firstBayComponent.references.some((entry) => entry.path === "bay-model.json"));
  assert.ok(firstBayComponent.references.some((entry) => entry.path === "moasure/parsed/latest.json"));
});
