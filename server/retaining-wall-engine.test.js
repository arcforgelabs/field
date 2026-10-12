import assert from "node:assert/strict";
import test from "node:test";
import { buildTestRateCard } from "./test-pricing-fixtures.js";
import { buildBayModel } from "./retaining-wall-engine.js";

test("buildBayModel standardizes active single-tier bays to 1m systems and uses stocked steel lengths", () => {
  const model = buildBayModel({
    bayHeights: [
      { bay_id: 1, height_m: 0.45, source: "probe" },
      { bay_id: 2, height_m: 0.95, source: "probe" },
      { bay_id: 3, height_m: 1.35, source: "probe" },
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
        cap_single_tier_bays: [3],
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
        estimated_site_days: 17,
      },
    },
    rateCard: buildTestRateCard(),
  });

  assert.deepEqual(model.tier_counts, { 1: 3 });

  const [bay1, bay2, bay3] = model.bays;
  assert.equal(bay1.max_height_m, 1.0);
  assert.equal(bay2.max_height_m, 1.0);
  assert.equal(bay3.max_height_m, 1.0);
  assert.equal(bay1.walls[0].sleepers, 5);
  assert.equal(bay3.is_capped, true);
  assert.equal(bay3.is_standardized_single_tier, true);
  assert.match(bay1.note, /standardized to 1m 1t system/i);
  assert.match(bay3.note, /capped at 1t/i);
  assert.ok(bay1.posts.every((post) => post.stock_item_code === "STEEL-CCHANNEL-125-GALV-2200" || post.stock_item_code === "STEEL-IBEAM-125-GALV-2200"));
  assert.ok(bay2.posts.every((post) => post.stock_length_mm === 2200));
  assert.equal(bay1.total_steel_lm, 4.4);
});
