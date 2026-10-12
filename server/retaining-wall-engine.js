/**
 * Retaining Wall Construction Engine
 * ====================================
 * Pure business logic: takes bay heights + design spec + rate card
 * and produces a complete bay model with all computed values.
 *
 * No measurement parsing. No file I/O. Just math.
 */

import {
  buildAncillaryResourceLines,
  buildBayResourceLines,
  priceRetainingWallResourceLines,
  summarizePricedRetainingWallLines,
} from "./retaining-wall-commercial.js";
import { selectSteelStockForLength } from "./retaining-wall-steel.js";

/**
 * Build the complete bay model.
 *
 * @param {Object} opts
 * @param {Array<{bay_id:number, height_m:number, source:string}>} opts.bayHeights
 * @param {Array<{bay_id:number, x_start:number, y_start:number, z_start:number, x_end:number, y_end:number, z_end:number}>} opts.bayGeometry
 * @param {Array<{boundary:number, angle:number}>} opts.bendAngles
 * @param {Object} opts.design - design.json content
 * @param {Object} opts.rateCard - the wall rate card from the price catalogue (server/retaining-wall-rate-card.js)
 * @returns {Object} Complete bay model
 */
export function buildBayModel({ bayHeights, bayGeometry, bendAngles, design, rateCard }) {
  const rules = design.construction_rules;
  const overrides = design.design_overrides || {};

  const gapBays = new Set(overrides.mower_gap_bays || []);
  const capBays = new Set(overrides.cap_single_tier_bays || []);
  const stairMap = Object.fromEntries(
    (overrides.stairs || []).map((s) => [s.bay, s])
  );
  const standardizedSingleTierHeightM = resolveStandardizedSingleTierHeight(design);

  // Bend angle lookup
  const angleMap = {};
  for (const ba of bendAngles || []) {
    angleMap[ba.boundary] = ba.angle;
  }

  const maxWallH = rules.max_sleepers_per_wall * rules.sleeper_height_mm / 1000;
  const sleeperH = rules.sleeper_height_mm / 1000;

  const bays = [];
  let prevTiers = 0;
  let section = 0;
  let prevSection = -1;

  for (const bh of bayHeights) {
    const bayId = bh.bay_id;
    const idx = bayId - 1;
    const h = bh.height_m;
    const geom = (bayGeometry || []).find((g) => g.bay_id === bayId) || {};

    // Section tracking
    if (gapBays.has(bayId)) {
      section++;
    } else if (gapBays.has(bayId - 1)) {
      section++;
    }
    const firstInSection = section !== prevSection;
    if (firstInSection) prevTiers = 0;
    prevSection = section;

    // Gap bay
    if (gapBays.has(bayId)) {
      bays.push({
        bay_id: bayId, section, tier_count: 0, max_height_m: 0,
        measured_height_m: round2(h),
        is_active: false, is_starter: false, is_capped: false,
        is_standardized_single_tier: false,
        note: "Mower access gap", walls: [], posts: [],
        total_sleepers: 0, total_holes: 0, total_steel_lm: 0,
        total_concrete_bags: 0, bend_angle: 0, has_stair: bayId in stairMap,
        stair_spec: stairMap[bayId] || null, geometry: geom,
        cost_materials: 0, charge_materials: 0, cost_labour: 0,
        charge_labour: 0, cost_total: 0, charge_total: 0,
      });
      prevTiers = 0;
      continue;
    }

    // Tier classification
    let tierCount = classifyTier(h, rules);
    let isCapped = false;
    let effectiveH = h;
    let isStandardizedSingleTier = false;
    if (capBays.has(bayId) && tierCount > 1) {
      tierCount = 1;
      effectiveH = Math.min(h, maxWallH);
      isCapped = true;
    }
    if (tierCount === 1 && shouldStandardizeSingleTierBay({ bayId, overrides })) {
      effectiveH = standardizedSingleTierHeightM;
      isStandardizedSingleTier = true;
    }

    if (tierCount === 0) {
      bays.push({
        bay_id: bayId, section, tier_count: 0, max_height_m: h,
        measured_height_m: round2(h),
        is_active: false, is_starter: false, is_capped: false,
        is_standardized_single_tier: false,
        note: "No wall needed", walls: [], posts: [],
        total_sleepers: 0, total_holes: 0, total_steel_lm: 0,
        total_concrete_bags: 0, bend_angle: 0, has_stair: bayId in stairMap,
        stair_spec: stairMap[bayId] || null, geometry: geom,
        cost_materials: 0, charge_materials: 0, cost_labour: 0,
        charge_labour: 0, cost_total: 0, charge_total: 0,
      });
      prevTiers = 0;
      continue;
    }

    // Compute wall tiers
    const walls = computeWalls(effectiveH, tierCount, rules);
    const totalSleepers = walls.reduce((s, w) => s + w.sleepers, 0);

    // Angle at shared boundary
    const angle = angleMap[idx] || 0;
    const needsDouble = angle > rules.angle_threshold_degrees;

    // Compute posts
    const posts = [];
    for (let j = 0; j < walls.length; j++) {
      const tierLevel = j + 1;
      let pl = walls[j].post_length_m;

      // Max-adjacent: use taller of this bay's wall vs previous bay's wall at same tier
      if (bays.length > 0) {
        const prev = bays[bays.length - 1];
        if (prev.is_active && j < prev.walls.length) {
          pl = Math.max(pl, prev.walls[j].post_length_m);
        }
      }

      if (tierLevel <= prevTiers) {
        // Shared post
        posts.push(buildPostSpec({
          tierLevel,
          isShared: true,
          isDoubleCchannel: needsDouble,
          postLengthM: pl,
          material: needsDouble ? "cchannel" : "ibeam",
          rateCard,
        }));
      } else {
        // New tier — 2 posts
        posts.push(buildPostSpec({
          tierLevel,
          isShared: false,
          isDoubleCchannel: false,
          postLengthM: pl,
          material: "cchannel",
          rateCard,
        }));
        posts.push(buildPostSpec({
          tierLevel,
          isShared: false,
          isDoubleCchannel: false,
          postLengthM: pl,
          material: "ibeam",
          rateCard,
        }));
      }
    }

    const isStarter = posts.some((p) => !p.is_shared);
    const totalHoles = posts.length;
    const totalSteelLm = posts.reduce((s, p) => {
      const mult = p.is_double_cchannel ? 2 : 1;
      return s + Number(p.stock_length_m || p.post_length_m || 0) * mult;
    }, 0);
    const totalConcreteBags = totalHoles * rules.bags_per_hole;

    // Pricing
    const resourceLines = buildBayResourceLines({
      bay: {
        bay_id: bayId,
        section,
        tierCount,
        totalSleepers,
        totalHoles,
        totalConcreteBags,
        posts,
        walls,
        measuredHeightM: round2(h),
        maxHeightM: round2(effectiveH),
        isStandardizedSingleTier,
        isCapped,
        note: buildBayNote({ isCapped, isStandardizedSingleTier, standardizedSingleTierHeightM }),
        geometry: geom,
      },
      design,
      rateCard,
    });
    const pricing = computeBayPricing({
      bay: { tierCount, totalSleepers, totalHoles, totalConcreteBags, posts, walls },
      design, rateCard,
      resourceLines,
    });

    bays.push({
      bay_id: bayId, section, tier_count: tierCount,
      max_height_m: round2(effectiveH),
      measured_height_m: round2(h),
      is_active: true, is_starter: isStarter, is_capped: isCapped,
      is_standardized_single_tier: isStandardizedSingleTier,
      note: buildBayNote({ isCapped, isStandardizedSingleTier, standardizedSingleTierHeightM }),
      walls, posts,
      total_sleepers: totalSleepers, total_holes: totalHoles,
      total_steel_lm: round2(totalSteelLm),
      total_concrete_bags: totalConcreteBags,
      bend_angle: round1(angle),
      has_stair: stairMap[bayId] != null,
      stair_spec: stairMap[bayId] || null,
      geometry: geom,
      resource_lines: resourceLines,
      ...pricing,
    });

    prevTiers = tierCount;
  }

  // Aggregate
  const activeBays = bays.filter((b) => b.is_active);
  const tierCounts = {};
  for (const b of activeBays) {
    tierCounts[b.tier_count] = (tierCounts[b.tier_count] || 0) + 1;
  }

  const wallCharge = activeBays.some((bay) => bay.charge_total == null)
    ? null
    : activeBays.reduce((s, b) => s + b.charge_total, 0);
  const wallCost = activeBays.some((bay) => bay.cost_total == null)
    ? null
    : activeBays.reduce((s, b) => s + b.cost_total, 0);
  const ancillaryLines = buildAncillaryResourceLines({
    model: {
      total_active_bays: activeBays.length,
      total_sleepers: activeBays.reduce((s, b) => s + b.total_sleepers, 0),
    },
    design,
    rateCard,
  });
  const ancillaryPricing = summarizePricedRetainingWallLines(
    priceRetainingWallResourceLines(ancillaryLines, rateCard)
  );

  return {
    total_active_bays: activeBays.length,
    total_sleepers: activeBays.reduce((s, b) => s + b.total_sleepers, 0),
    total_holes: activeBays.reduce((s, b) => s + b.total_holes, 0),
    total_welds: activeBays.reduce((s, b) => s + b.posts.filter((p) => p.is_double_cchannel).length, 0),
    perimeter_m: bayGeometry?.length ? null : null,  // filled by caller
    tier_counts: tierCounts,
    wall_charge: wallCharge == null ? null : round2(wallCharge),
    ancillaries_charge: ancillaryPricing.chargeTotal == null ? null : round2(ancillaryPricing.chargeTotal),
    ancillaries_cost: ancillaryPricing.costTotal == null ? null : round2(ancillaryPricing.costTotal),
    total_charge: wallCharge == null || ancillaryPricing.chargeTotal == null ? null : round2(wallCharge + ancillaryPricing.chargeTotal),
    total_cost: wallCost == null || ancillaryPricing.costTotal == null ? null : round2(wallCost + ancillaryPricing.costTotal),
    pricingIssues: [
      ...activeBays.flatMap((bay) => bay.pricingIssues || []),
      ...(ancillaryPricing.pricingIssues || []),
    ],
    pricingReady: activeBays.every((bay) => bay.pricingReady !== false)
      && !ancillaryPricing.pricingIssues?.length
      && wallCharge != null
      && wallCost != null
      && ancillaryPricing.chargeTotal != null
      && ancillaryPricing.costTotal != null,
    ancillary_lines: ancillaryLines,
    bays,
  };
}

// ── Tier logic ───────────────────────────────────────────────────────
function classifyTier(h, rules) {
  if (h <= 0) return 0;
  if (h <= rules.tier2_trigger_m) return 1;
  if (h <= rules.tier3_trigger_m) return 2;
  return 3;
}

function postLength(wallH) {
  return wallH + wallH + 0.2;
}

function computeWalls(h, tierCount, rules) {
  const maxH = rules.max_sleepers_per_wall * rules.sleeper_height_mm / 1000;
  const sh = rules.sleeper_height_mm / 1000;
  const walls = [];

  if (tierCount === 1) {
    const wh = Math.min(h, maxH);
    const sl = Math.min(rules.max_sleepers_per_wall, Math.max(1, Math.round(wh / sh)));
    const actual = sl * sh;
    walls.push({ level: 1, sleepers: sl, wall_height_m: actual, post_length_m: postLength(actual) });
  } else if (tierCount === 2) {
    walls.push({ level: 1, sleepers: 5, wall_height_m: maxH, post_length_m: postLength(maxH) });
    const uh = Math.min(h - maxH, maxH);
    const sl = Math.min(rules.max_sleepers_per_wall, Math.max(1, Math.round(uh / sh)));
    walls.push({ level: 2, sleepers: sl, wall_height_m: sl * sh, post_length_m: postLength(sl * sh) });
  } else if (tierCount === 3) {
    walls.push({ level: 1, sleepers: 5, wall_height_m: maxH, post_length_m: postLength(maxH) });
    walls.push({ level: 2, sleepers: 5, wall_height_m: maxH, post_length_m: postLength(maxH) });
    const uh = Math.min(h - 2 * maxH, maxH);
    const sl = Math.min(rules.max_sleepers_per_wall, Math.max(1, Math.round(uh / sh)));
    walls.push({ level: 3, sleepers: sl, wall_height_m: sl * sh, post_length_m: postLength(sl * sh) });
  }

  return walls;
}

// ── Pricing ──────────────────────────────────────────────────────────
function computeBayPricing({ resourceLines, rateCard }) {
  const pricedLines = priceRetainingWallResourceLines(resourceLines, rateCard);
  const materials = pricedLines.filter((line) => line.category === "materials");
  const nonMaterials = pricedLines.filter((line) => line.category !== "materials");
  const materialSummary = summarizePricedRetainingWallLines(materials);
  const labourSummary = summarizePricedRetainingWallLines(nonMaterials);
  const pricingIssues = [
    ...(materialSummary.pricingIssues || []),
    ...(labourSummary.pricingIssues || []),
  ];
  const costTotal = materialSummary.costTotal == null || labourSummary.costTotal == null
    ? null
    : round2(materialSummary.costTotal + labourSummary.costTotal);
  const chargeTotal = materialSummary.chargeTotal == null || labourSummary.chargeTotal == null
    ? null
    : round2(materialSummary.chargeTotal + labourSummary.chargeTotal);

  return {
    cost_materials: materialSummary.costTotal == null ? null : round2(materialSummary.costTotal),
    charge_materials: materialSummary.chargeTotal == null ? null : round2(materialSummary.chargeTotal),
    cost_labour: labourSummary.costTotal == null ? null : round2(labourSummary.costTotal),
    charge_labour: labourSummary.chargeTotal == null ? null : round2(labourSummary.chargeTotal),
    cost_total: costTotal,
    charge_total: chargeTotal,
    pricingIssues,
    pricingReady: !pricingIssues.length && costTotal != null && chargeTotal != null,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
function round1(v) { return Math.round(v * 10) / 10; }

function resolveStandardizedSingleTierHeight(design) {
  const configured = Number(design?.design_overrides?.single_tier_system_height_m || 1.0);
  if (!Number.isFinite(configured) || configured <= 0) return 1.0;
  return round2(configured);
}

function shouldStandardizeSingleTierBay({ bayId, overrides }) {
  const mode = overrides?.full_height_single_tier_bays;
  if (mode === "all_active") return true;
  if (Array.isArray(mode)) return mode.map(Number).includes(Number(bayId));
  return false;
}

function buildBayNote({ isCapped, isStandardizedSingleTier, standardizedSingleTierHeightM }) {
  const notes = [];
  if (isCapped) notes.push("Capped at 1T");
  if (isStandardizedSingleTier) {
    notes.push(`Standardized to ${round2(standardizedSingleTierHeightM)}m 1T system`);
  }
  return notes.join("; ");
}

function buildPostSpec({
  tierLevel,
  isShared,
  isDoubleCchannel,
  postLengthM,
  material,
  rateCard,
}) {
  const normalizedLengthM = round2(postLengthM);
  const stock = selectSteelStockForLength({
    material,
    requiredLengthM: normalizedLengthM,
    rateCard,
  });

  return {
    tier_level: tierLevel,
    is_shared: isShared,
    is_double_cchannel: isDoubleCchannel,
    post_length_m: normalizedLengthM,
    exact_post_length_m: normalizedLengthM,
    exact_post_length_mm: Math.round(normalizedLengthM * 1000),
    material,
    stock_item_code: stock?.itemCode || null,
    stock_item_name: stock?.itemName || null,
    stock_label: stock?.label || null,
    stock_unit: stock?.unit || "each",
    stock_length_m: stock?.selectedLengthM != null ? round2(stock.selectedLengthM) : normalizedLengthM,
    stock_length_mm: stock?.selectedLengthMm || Math.round(normalizedLengthM * 1000),
    extra_embedment_m: stock?.extraEmbedmentM != null ? round2(stock.extraEmbedmentM) : 0,
  };
}
