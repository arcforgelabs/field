import { buildMaterialOrdersFromLines } from "./quote-quantity-rules.js";
import { taxOnSubtotal } from "../shared/money.js";
import {
  buildCommercialItemReference,
  buildStructuredTrace,
  buildTraceEntry,
  buildTraceInput,
  normalizeTraceReferences,
} from "./quote-trace.js";
import {
  resolveSteelStockRateEntry,
  selectSteelStockForLength,
} from "./retaining-wall-steel.js";
import { requireRate } from "./local-pricing.js";
import { DEFAULT_QUOTE_CATALOG_ID } from "./quote-catalog-ids.js";
import { applyBusinessProfileOverride, businessDisplayName } from "./business-profile.js";
import { WALL_RATE_CARD_ITEMS } from "./retaining-wall-items.js";
import { formatCatalogUnit, formatCatalogUnitText } from "../shared/catalog-units.js";

export const FALLBACK_ADJUSTMENT_ITEM_CODE = "FIELD-ADJUSTMENT";

const RETAINING_WALL_REFERENCE_LIBRARY = Object.freeze({
  wallDesign: { type: "job_file", label: "Wall design JSON", path: "wall-design.json", title: "Retaining wall design spec" },
  bayHeights: { type: "job_file", label: "Bay heights JSON", path: "bay-heights.json", title: "Extracted bay heights" },
  bayModel: { type: "job_file", label: "Bay model JSON", path: "bay-model.json", title: "Computed retaining wall bay model" },
  moasureJson: { type: "job_file", label: "Moasure summary JSON", path: "moasure/parsed/latest.json", title: "Latest parsed Moasure summary" },
  moasureMd: { type: "job_file", label: "Moasure summary Markdown", path: "moasure/parsed/latest.md", title: "Latest parsed Moasure markdown summary" },
  quoteInputs: { type: "job_file", label: "Quote inputs JSON", path: "quote-inputs.json", title: "Structured quote inputs" },
});

export function buildBayResourceLines({ bay, design, rateCard }) {
  const rules = design?.construction_rules || {};
  const processTimes = design?.process_times || {};
  const lines = [];

  const addLine = (line) => {
    const quantity = Number(line?.quantity || 0);
    if (!(quantity > 0)) return;
    lines.push({
      source: "retaining_wall_engine",
      scope: "wall",
      bayId: bay?.bay_id || null,
      tierCount: bay?.tierCount || bay?.tier_count || 0,
      ...line,
    });
  };

  let ibeamLm = 0;
  let cchannelLm = 0;
  const stockedSteelLines = new Map();
  for (const post of bay?.posts || []) {
    const multiplier = post.is_double_cchannel ? 2 : 1;
    const stockSelection = normalizeSteelPostStock(post, rateCard);
    if (stockSelection?.itemCode) {
      const key = stockSelection.itemCode;
      const existing = stockedSteelLines.get(key);
      if (existing) {
        existing.quantity = roundQuantity(existing.quantity + multiplier);
        if (existing.trace?.components) {
          existing.trace.components.push({
            title: `Bay ${bay?.bay_id || "?"} stocked post`,
            formulas: [
              buildRetainingWallFormula(
                "Stock quantity",
                `${post.is_double_cchannel ? "Double C-channel" : "Single post"} uses ${multiplier} × ${stockSelection.itemCode}.`
              ),
            ],
            inputs: [
              buildRetainingWallInput("Required length", post.post_length_m || post.exact_post_length_m || 0, "m"),
              buildRetainingWallInput("Selected stock", stockSelection.itemCode),
              buildRetainingWallInput("Post multiplier", multiplier, "each"),
            ].filter(Boolean),
            notes: [],
            references: defaultRetainingWallReferences(),
          });
        }
      } else {
        stockedSteelLines.set(key, {
          code: buildStockSteelCode(stockSelection.itemCode),
          itemCode: stockSelection.itemCode,
          label: stockSelection.label,
          description: describeBayLine(
            bay,
            `${stockSelection.label} posts${stockSelection.extraEmbedmentM > 0 ? ` (${roundQuantity(stockSelection.extraEmbedmentM)}m extra embedment)` : ""}`
          ),
          category: "materials",
          quantity: roundQuantity(multiplier),
          unit: stockSelection.unit || "each",
          trace: buildRetainingWallTrace({
            title: describeBayLine(bay, `${stockSelection.label} posts`),
            recipe: "retaining_wall_exact",
            formulas: [
              buildRetainingWallFormula(
                "Stock quantity",
                `${post.is_double_cchannel ? "Double C-channel" : "Single post"} uses ${multiplier} × ${stockSelection.itemCode}${stockSelection.extraEmbedmentM > 0 ? ` with ${roundQuantity(stockSelection.extraEmbedmentM)}m extra embedment` : ""}.`
              ),
            ],
            inputs: [
              buildRetainingWallInput("Bay", bay?.bay_id || null),
              buildRetainingWallInput("Tier count", bay?.tierCount || bay?.tier_count || 0),
              buildRetainingWallInput("Required post length", post.post_length_m || post.exact_post_length_m || 0, "m"),
              buildRetainingWallInput("Selected stock", stockSelection.itemCode),
              buildRetainingWallInput("Stock quantity", multiplier, stockSelection.unit || "each"),
            ],
            components: [{
              title: `Bay ${bay?.bay_id || "?"} stocked post`,
              formulas: [
                buildRetainingWallFormula(
                  "Stock quantity",
                  `${post.is_double_cchannel ? "Double C-channel" : "Single post"} uses ${multiplier} × ${stockSelection.itemCode}.`
                ),
              ],
              inputs: [
                buildRetainingWallInput("Required length", post.post_length_m || post.exact_post_length_m || 0, "m"),
                buildRetainingWallInput("Selected stock", stockSelection.itemCode),
              ].filter(Boolean),
              notes: [],
              references: defaultRetainingWallReferences(),
            }],
          }),
        });
      }
      continue;
    }

    if (post.material === "ibeam") {
      ibeamLm += Number(post.post_length_m || 0) * multiplier;
    } else {
      cchannelLm += Number(post.post_length_m || 0) * multiplier;
    }
  }

  const gravelTonnesPerBay = Number(rateCard?.materials?.gravel_20mm?.tonnes_per_bay || 0);
  const padConcreteBags = Number(rules.pad_concrete_bags_per_2_bays || 0.5) / 2;

  addLine({
    code: "sleepers",
    itemCode: WALL_RATE_CARD_ITEMS.sleeper,
    label: "Kensington Sleeper",
    description: describeBayLine(bay, "Concrete sleepers"),
    category: "materials",
    quantity: Number(bay?.totalSleepers || 0),
    unit: "each",
    trace: buildSleeperBayTrace({ bay, rules }),
  });
  for (const line of stockedSteelLines.values()) {
    addLine(line);
  }
  addLine({
    code: "ibeam",
    itemCode: WALL_RATE_CARD_ITEMS.ibeam,
    label: "I-Beam 125 Galv",
    description: describeBayLine(bay, "I-beam posts"),
    category: "materials",
    quantity: roundQuantity(ibeamLm),
    unit: "m",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "I-beam posts"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("I-beam length", `Fallback metre pricing uses ${roundQuantity(ibeamLm)} m total I-beam length across bay posts.`),
      ],
      inputs: [
        buildRetainingWallInput("Bay", bay?.bay_id || null),
        buildRetainingWallInput("Total I-beam length", ibeamLm, "m"),
      ],
    }),
  });
  addLine({
    code: "cchannel",
    itemCode: WALL_RATE_CARD_ITEMS.cchannel,
    label: "C-Channel 125 Galv",
    description: describeBayLine(bay, "C-channel posts"),
    category: "materials",
    quantity: roundQuantity(cchannelLm),
    unit: "m",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "C-channel posts"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("C-channel length", `Fallback metre pricing uses ${roundQuantity(cchannelLm)} m total C-channel length across bay posts.`),
      ],
      inputs: [
        buildRetainingWallInput("Bay", bay?.bay_id || null),
        buildRetainingWallInput("Total C-channel length", cchannelLm, "m"),
      ],
    }),
  });
  addLine({
    code: "concrete",
    itemCode: WALL_RATE_CARD_ITEMS.concreteBag,
    label: "Concrete 20kg Bag",
    description: describeBayLine(bay, "Post and pad concrete"),
    category: "materials",
    quantity: roundQuantity(Number(bay?.totalConcreteBags || 0) + padConcreteBags),
    unit: "bag",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "Post and pad concrete"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("Concrete bags", `${Number(bay?.totalConcreteBags || 0)} post bags + ${roundQuantity(padConcreteBags)} pad bags = ${roundQuantity(Number(bay?.totalConcreteBags || 0) + padConcreteBags)} bags.`),
      ],
      inputs: [
        buildRetainingWallInput("Bay", bay?.bay_id || null),
        buildRetainingWallInput("Post concrete bags", Number(bay?.totalConcreteBags || 0), "bag"),
        buildRetainingWallInput("Pad concrete bags", padConcreteBags, "bag"),
      ],
    }),
  });
  addLine({
    code: "agpipe",
    itemCode: WALL_RATE_CARD_ITEMS.agpipe,
    label: "Ag Pipe",
    description: describeBayLine(bay, "Drainage ag pipe"),
    category: "materials",
    quantity: 1,
    unit: "bay",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "Drainage ag pipe"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("Ag pipe allowance", "Standard drainage allowance is 1 ag pipe bay pack per active bay."),
      ],
      inputs: [
        buildRetainingWallInput("Bay", bay?.bay_id || null),
        buildRetainingWallInput("Quantity", 1, "bay"),
      ],
    }),
  });
  addLine({
    code: "fortacon",
    itemCode: WALL_RATE_CARD_ITEMS.fortacon,
    label: "Fortacon Plastic",
    description: describeBayLine(bay, "Drainage backing plastic"),
    category: "materials",
    quantity: 1,
    unit: "bay",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "Drainage backing plastic"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("Fortacon allowance", "Standard drainage allowance is 1 Fortacon plastic bay pack per active bay."),
      ],
      inputs: [
        buildRetainingWallInput("Bay", bay?.bay_id || null),
        buildRetainingWallInput("Quantity", 1, "bay"),
      ],
    }),
  });
  addLine({
    code: "gravel",
    itemCode: WALL_RATE_CARD_ITEMS.gravel,
    label: "20mm Gravel",
    description: describeBayLine(bay, "Drainage gravel"),
    category: "materials",
    quantity: roundQuantity(gravelTonnesPerBay),
    unit: "tonne",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "Drainage gravel"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("Gravel tonnes", `Rate card drainage gravel allowance = ${roundQuantity(gravelTonnesPerBay)} tonne per bay.`),
      ],
      inputs: [
        buildRetainingWallInput("Bay", bay?.bay_id || null),
        buildRetainingWallInput("Rate card allowance", gravelTonnesPerBay, "tonne/bay"),
      ],
    }),
  });

  const tierCount = Number(bay?.tierCount || bay?.tier_count || 0);
  const cutMinutes = Number(processTimes?.cutback_minutes?.[`${tierCount}T`] || 15);
  const cutHours = cutMinutes / 60;
  const drillHours = Number(bay?.totalHoles || 0) * Number(processTimes.drill_hours_per_hole || 0);
  const concreteHours = Number(bay?.totalHoles || 0) * Number(processTimes.concrete_minutes_per_post || 0) / 60;
  const padHours = Number(bay?.totalHoles || 0) * Number(processTimes.pad_height_minutes_per_post || 0) / 60;
  const sleeperHours = Number(bay?.totalSleepers || 0) * Number(rules.sleeper_install_minutes_per_sleeper || 0) / 60;
  const drainHours = Number(processTimes.drainage_minutes_per_bay || 0) / 60;
  const backfillMinutes = Number(processTimes?.backfill_minutes?.[`${tierCount}T`] || 5);
  const backfillHours = backfillMinutes / 60;
  const excavatorHours = cutHours + drillHours + sleeperHours + backfillHours;
  const labourHours = cutHours * 2 + drillHours + concreteHours * 2 + padHours +
    sleeperHours * 2 + drainHours * 2 + backfillHours * 2;
  const weldCount = (bay?.posts || []).filter((post) => post.is_double_cchannel).length;
  const weldHours = weldCount * Number(rules.weld_time_minutes || 0) / 60;

  addLine({
    code: "excavator",
    itemCode: WALL_RATE_CARD_ITEMS.excavator,
    label: "Excavator Hour",
    description: describeBayLine(bay, "Excavator work"),
    category: "machines",
    quantity: roundQuantity(excavatorHours),
    unit: "hour",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "Excavator work"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("Excavator hours", `${roundQuantity(cutHours)} cutback + ${roundQuantity(drillHours)} drilling + ${roundQuantity(sleeperHours)} sleeper install support + ${roundQuantity(backfillHours)} backfill = ${roundQuantity(excavatorHours)} hours.`),
      ],
      inputs: [
        buildRetainingWallInput("Cutback time", cutHours, "hr"),
        buildRetainingWallInput("Drilling time", drillHours, "hr"),
        buildRetainingWallInput("Sleeper install support", sleeperHours, "hr"),
        buildRetainingWallInput("Backfill time", backfillHours, "hr"),
      ],
    }),
  });
  addLine({
    code: "labour",
    itemCode: WALL_RATE_CARD_ITEMS.labourer,
    label: "General Labourer Hour",
    description: describeBayLine(bay, "General labour"),
    category: "labour",
    quantity: roundQuantity(labourHours),
    unit: "hour",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "General labour"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("Labour hours", `${roundQuantity(cutHours * 2)} cutback team + ${roundQuantity(drillHours)} drilling + ${roundQuantity(concreteHours * 2)} concrete team + ${roundQuantity(padHours)} pad work + ${roundQuantity(sleeperHours * 2)} sleeper install team + ${roundQuantity(drainHours * 2)} drainage team + ${roundQuantity(backfillHours * 2)} backfill team = ${roundQuantity(labourHours)} hours.`),
      ],
      inputs: [
        buildRetainingWallInput("Cutback hours", cutHours, "hr"),
        buildRetainingWallInput("Drill hours", drillHours, "hr"),
        buildRetainingWallInput("Concrete hours", concreteHours, "hr"),
        buildRetainingWallInput("Pad hours", padHours, "hr"),
        buildRetainingWallInput("Sleeper hours", sleeperHours, "hr"),
        buildRetainingWallInput("Drainage hours", drainHours, "hr"),
        buildRetainingWallInput("Backfill hours", backfillHours, "hr"),
      ],
    }),
  });
  addLine({
    code: "weld",
    itemCode: WALL_RATE_CARD_ITEMS.welder,
    label: "Welder Hour",
    description: describeBayLine(bay, "Double c-channel welds"),
    category: "labour",
    quantity: roundQuantity(weldHours),
    unit: "hour",
    trace: buildRetainingWallTrace({
      title: describeBayLine(bay, "Double c-channel welds"),
      recipe: "retaining_wall_exact",
      formulas: [
        buildRetainingWallFormula("Welder hours", `${weldCount} welds × ${Number(rules.weld_time_minutes || 0)} min ÷ 60 = ${roundQuantity(weldHours)} hours.`),
      ],
      inputs: [
        buildRetainingWallInput("Weld count", weldCount, "weld"),
        buildRetainingWallInput("Minutes / weld", Number(rules.weld_time_minutes || 0), "min"),
      ],
    }),
  });

  return lines;
}

export function buildAncillaryResourceLines({ model, design, rateCard }) {
  const lines = [];
  const site = design?.site || {};
  const vehicle = rateCard?.vehicle || {};
  const delivery = rateCard?.delivery || {};
  const activeBays = Number(model?.total_active_bays || 0);
  const totalSleepers = Number(model?.total_sleepers || 0);
  const stairs = Array.isArray(design?.design_overrides?.stairs) ? design.design_overrides.stairs : [];
  const distanceKmOneWay = Number(site.distance_km_one_way || 0);
  const machineFloatFuelKm = 4 * distanceKmOneWay;
  const gravelTrips = Math.ceil(activeBays / Math.max(Number(delivery.gravel_bays_per_trip || 1), 1));
  const gravelDeliveryFuelKm = gravelTrips * 20;
  const siteAllowancePersonDays = Number(site.estimated_site_days || 17) * Number(site.crew_size || 0);

  const addLine = (line) => {
    const quantity = Number(line?.quantity || 0);
    if (!(quantity > 0)) return;
    lines.push({
      source: "retaining_wall_engine",
      scope: "ancillary",
      ...line,
    });
  };

  addLine({
    code: "earthworks-excavator",
    itemCode: WALL_RATE_CARD_ITEMS.excavator,
    label: "Excavator Hour",
    description: "Site preparation and ancillary earthworks",
    category: "machines",
    quantity: 1,
    unit: "hour",
    trace: buildRetainingWallTrace({
      title: "Site preparation and ancillary earthworks",
      recipe: "retaining_wall_ancillary",
      formulas: [
        buildRetainingWallFormula("Ancillary earthworks", "Fixed 1 excavator hour allowance for ancillary prep and tidy-up."),
      ],
    }),
  });
  addLine({
    code: "machine-float-vehicle",
    itemCode: WALL_RATE_CARD_ITEMS.vehicleHour,
    label: "Vehicle Hour",
    description: "Machine float driving and loading time",
    category: "overhead",
    quantity: 1,
    unit: "hour",
    trace: buildRetainingWallTrace({
      title: "Machine float driving and loading time",
      recipe: "retaining_wall_ancillary",
      formulas: [
        buildRetainingWallFormula("Machine float vehicle hours", "Fixed 1 vehicle hour allowance for float loading and travel handling."),
      ],
    }),
  });
  addLine({
    code: "machine-float-fuel",
    itemCode: WALL_RATE_CARD_ITEMS.vehicleKm,
    label: "Machine Float Fuel Surcharge",
    description: `Fuel surcharge for machine float (${roundQuantity(machineFloatFuelKm)} km).`,
    category: "overhead",
    quantity: roundQuantity(machineFloatFuelKm),
    unit: "km",
    trace: buildRetainingWallTrace({
      title: "Machine float fuel surcharge",
      recipe: "retaining_wall_ancillary",
      formulas: [
        buildRetainingWallFormula("Fuel surcharge", `${roundQuantity(machineFloatFuelKm)} km × ${formatMoney(vehicle.charge_km)} / km = ${formatMoney(requireRate(vehicle.charge_km) == null ? null : machineFloatFuelKm * requireRate(vehicle.charge_km))}.`),
      ],
      inputs: [
        buildRetainingWallInput("Travel distance", machineFloatFuelKm, "km"),
        buildRetainingWallInput("Vehicle / km", vehicle.charge_km, "km", "money"),
      ],
    }),
  });
  addLine({
    code: "gravel-delivery-vehicle",
    itemCode: WALL_RATE_CARD_ITEMS.vehicleHour,
    label: "Vehicle Hour",
    description: `Gravel delivery drive time (${gravelTrips} trip${gravelTrips === 1 ? "" : "s"}).`,
    category: "overhead",
    quantity: gravelTrips,
    unit: "hour",
    trace: buildRetainingWallTrace({
      title: "Gravel delivery drive time",
      recipe: "retaining_wall_ancillary",
      formulas: [
        buildRetainingWallFormula("Gravel delivery trips", `${activeBays} active bays ÷ ${Math.max(Number(delivery.gravel_bays_per_trip || 1), 1)} bays/trip = ${gravelTrips} trip hours.`),
      ],
      inputs: [
        buildRetainingWallInput("Active bays", activeBays, "bay"),
        buildRetainingWallInput("Bays / trip", Math.max(Number(delivery.gravel_bays_per_trip || 1), 1), "bay/trip"),
      ],
    }),
  });
  addLine({
    code: "gravel-delivery-fuel",
    itemCode: WALL_RATE_CARD_ITEMS.vehicleKm,
    label: "Gravel Delivery Fuel Surcharge",
    description: `Fuel surcharge for gravel delivery (${roundQuantity(gravelDeliveryFuelKm)} km).`,
    category: "overhead",
    quantity: roundQuantity(gravelDeliveryFuelKm),
    unit: "km",
    trace: buildRetainingWallTrace({
      title: "Gravel delivery fuel surcharge",
      recipe: "retaining_wall_ancillary",
      formulas: [
        buildRetainingWallFormula("Fuel surcharge", `${roundQuantity(gravelDeliveryFuelKm)} km × ${formatMoney(vehicle.charge_km)} / km = ${formatMoney(requireRate(vehicle.charge_km) == null ? null : gravelDeliveryFuelKm * requireRate(vehicle.charge_km))}.`),
      ],
    }),
  });

  for (const stair of stairs) {
    const material = stair.material === "bluestone_large" ? WALL_RATE_CARD_ITEMS.bluestoneLarge : WALL_RATE_CARD_ITEMS.bluestoneSmall;
    const materialLabel = material === WALL_RATE_CARD_ITEMS.bluestoneLarge ? "Bluestone Large" : "Bluestone Small";
    addLine({
      code: `stairs-${material.toLowerCase()}`,
      itemCode: material,
      label: materialLabel,
      description: `Stair material for bay ${stair.bay}`,
      category: "materials",
      quantity: roundQuantity(Number(stair.tonnes || 0.5)),
      unit: "tonne",
      trace: buildRetainingWallTrace({
        title: `Stair material for bay ${stair.bay}`,
        recipe: "retaining_wall_ancillary",
        formulas: [
          buildRetainingWallFormula("Stair rock tonnes", `Configured stair allowance = ${roundQuantity(Number(stair.tonnes || 0.5))} tonne for bay ${stair.bay}.`),
        ],
      }),
    });
    addLine({
      code: "stairs-excavator",
      itemCode: WALL_RATE_CARD_ITEMS.excavator,
      label: "Excavator Hour",
      description: `Stair excavation for bay ${stair.bay}`,
      category: "machines",
      quantity: 2,
      unit: "hour",
      trace: buildRetainingWallTrace({
        title: `Stair excavation for bay ${stair.bay}`,
        recipe: "retaining_wall_ancillary",
        formulas: [
          buildRetainingWallFormula("Stair excavator hours", `Fixed 2 excavator hours for stair excavation at bay ${stair.bay}.`),
        ],
      }),
    });
    addLine({
      code: "stairs-labour",
      itemCode: WALL_RATE_CARD_ITEMS.labourer,
      label: "General Labourer Hour",
      description: `Stair installation labour for bay ${stair.bay}`,
      category: "labour",
      quantity: 2,
      unit: "hour",
      trace: buildRetainingWallTrace({
        title: `Stair installation labour for bay ${stair.bay}`,
        recipe: "retaining_wall_ancillary",
        formulas: [
          buildRetainingWallFormula("Stair labour hours", `Fixed 2 labour hours for stair installation at bay ${stair.bay}.`),
        ],
      }),
    });
  }

  addLine({
    code: "site-allowance",
    itemCode: WALL_RATE_CARD_ITEMS.siteAllowance,
    label: "Site Allowance Day",
    description: "Crew site allowance",
    category: "overhead",
    quantity: roundQuantity(siteAllowancePersonDays),
    unit: "day",
    trace: buildRetainingWallTrace({
      title: "Crew site allowance",
      recipe: "retaining_wall_ancillary",
      formulas: [
        buildRetainingWallFormula("Site allowance person-days", `${Number(site.estimated_site_days || 17)} site days × ${Number(site.crew_size || 0)} crew = ${roundQuantity(siteAllowancePersonDays)} person-days.`),
      ],
      inputs: [
        buildRetainingWallInput("Estimated site days", Number(site.estimated_site_days || 17), "day"),
        buildRetainingWallInput("Crew size", Number(site.crew_size || 0), "people"),
      ],
    }),
  });
  addLine({
    code: "admin-fee",
    itemCode: WALL_RATE_CARD_ITEMS.adminFee,
    label: "Admin Fee",
    description: "Quote administration and coordination",
    category: "overhead",
    quantity: 1,
    unit: "job",
    trace: buildRetainingWallTrace({
      title: "Quote administration and coordination",
      recipe: "retaining_wall_ancillary",
      formulas: [
        buildRetainingWallFormula("Admin fee", "Fixed admin fee per quote."),
      ],
    }),
  });

  if (totalSleepers < Number(delivery.apc_free_threshold_sleepers || 0)) {
    const apcMinimumIncGst = requireRate(delivery.apc_minimum_charge_inc_gst, "APC delivery minimum");
    const apcCost = apcMinimumIncGst == null ? null : apcMinimumIncGst / 1.1;
    const materialMarkup = requireRate(rateCard?.markup?.materials ?? rateCard?.markup?.default, "material markup");
    addLine({
      code: "apc-delivery-minimum",
      itemCode: FALLBACK_ADJUSTMENT_ITEM_CODE,
      label: "APC Delivery Minimum",
      description: "Supplier delivery minimum under free-delivery threshold",
      category: "overhead",
      quantity: 1,
      unit: "job",
      manualRates: {
        costRate: apcCost == null ? null : roundMoney(apcCost),
        chargeRate: apcCost == null || materialMarkup == null
          ? null
          : roundMoney(apcCost * (1 + materialMarkup)),
      },
      trace: buildRetainingWallTrace({
        title: "Supplier delivery minimum",
        recipe: "retaining_wall_ancillary",
        formulas: [
          buildRetainingWallFormula("APC minimum", `${totalSleepers} sleepers is below free-delivery threshold ${Number(delivery.apc_free_threshold_sleepers || 0)}, so APC minimum ${formatMoney(apcCost)} ex GST applies.`),
        ],
      }),
    });
  }

  return lines;
}

export function priceRetainingWallResourceLines(lines, rateCard) {
  return (lines || [])
    .map((line) => priceRetainingWallResourceLine(line, rateCard))
    .filter(Boolean);
}

export function priceRetainingWallResourceLine(line, rateCard) {
  if (!line) return null;
  const quantity = Number(line.quantity || 0);
  if (!(quantity > 0)) return null;

  const rates = resolveLineRates(line, rateCard);
  const costRate = requireRate(rates.costRate, `${line.itemCode} cost rate`);
  const chargeRate = requireRate(rates.chargeRate, `${line.itemCode} charge rate`);
  const pricingIssues = [];
  if (costRate == null) pricingIssues.push({ code: line.itemCode, field: "cost", reason: "Missing buying rate." });
  if (chargeRate == null) pricingIssues.push({ code: line.itemCode, field: "charge", reason: "Missing selling rate." });
  const totalCost = costRate == null ? null : roundMoney(quantity * costRate);
  const totalPrice = chargeRate == null ? null : roundMoney(quantity * chargeRate);
  return {
    ...line,
    quantity: roundQuantity(quantity),
    unitCost: costRate == null ? null : roundMoney(costRate),
    unitRate: chargeRate == null ? null : roundMoney(chargeRate),
    totalCost,
    totalPrice,
    pricingSource: rates.source,
    ...(pricingIssues.length ? { pricingIssues } : {}),
    trace: attachRetainingWallPriceTrace({
      trace: line.trace || null,
      quantity,
      unit: line.unit,
      unitCost: costRate,
      unitRate: chargeRate,
      totalCost,
      totalPrice,
      pricingSource: rates.source,
      itemCode: line.itemCode,
    }),
  };
}

export function summarizePricedRetainingWallLines(lines) {
  const invalid = (lines || []).some((line) => line.totalCost == null || line.totalPrice == null);
  return {
    costTotal: invalid ? null : roundMoney(sum(lines.map((line) => line.totalCost))),
    chargeTotal: invalid ? null : roundMoney(sum(lines.map((line) => line.totalPrice))),
    pricingIssues: (lines || []).flatMap((line) => line.pricingIssues || []),
  };
}

export function aggregatePricedRetainingWallLines(lines) {
  const grouped = new Map();

  for (const line of lines || []) {
    const key = [
      line.scope || "",
      line.itemCode || "",
      line.unit || "",
      line.category || "",
      String(line.unitCost ?? ""),
      String(line.unitRate ?? ""),
      line.itemCode === FALLBACK_ADJUSTMENT_ITEM_CODE ? line.description || line.label || line.code || "" : "",
    ].join("::");

    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...line,
        quantity: roundQuantity(Number(line.quantity || 0)),
        totalCost: line.totalCost == null ? null : roundMoney(line.totalCost),
        totalPrice: line.totalPrice == null ? null : roundMoney(line.totalPrice),
        traceComponents: extractRetainingWallTraceComponents(line),
      });
      continue;
    }

    existing.quantity = roundQuantity(existing.quantity + Number(line.quantity || 0));
    existing.totalCost = existing.totalCost == null || line.totalCost == null
      ? null
      : roundMoney(existing.totalCost + line.totalCost);
    existing.totalPrice = existing.totalPrice == null || line.totalPrice == null
      ? null
      : roundMoney(existing.totalPrice + line.totalPrice);
    existing.traceComponents.push(...extractRetainingWallTraceComponents(line));
  }

  return [...grouped.values()]
    .map((line) => ({
      ...line,
      unitCost: line.unitCost == null ? null : roundMoney(line.unitCost),
      unitRate: line.unitRate == null ? null : roundMoney(line.unitRate),
      totalCost: line.totalCost == null ? null : roundMoney(line.totalCost),
      totalPrice: line.totalPrice == null ? null : roundMoney(line.totalPrice),
      trace: buildAggregatedRetainingWallTrace(line),
    }))
    .sort(compareRetainingWallCommercialLines);
}

export function buildRetainingWallCommercialBreakdown({ model, design, rateCard }) {
  const rawWallLines = (model?.bays || [])
    .filter((bay) => bay?.is_active)
    .flatMap((bay) => Array.isArray(bay.resource_lines) && bay.resource_lines.length
      ? bay.resource_lines
      : buildBayResourceLines({
          bay: {
            bay_id: bay.bay_id,
            section: bay.section,
            tierCount: bay.tier_count,
            totalSleepers: bay.total_sleepers,
            totalHoles: bay.total_holes,
            totalConcreteBags: bay.total_concrete_bags,
            posts: bay.posts || [],
            walls: bay.walls || [],
            measuredHeightM: bay.measured_height_m,
            maxHeightM: bay.max_height_m,
            isStandardizedSingleTier: bay.is_standardized_single_tier === true,
            isCapped: bay.is_capped === true,
            note: bay.note || null,
            geometry: bay.geometry || null,
          },
          design,
          rateCard,
        }));
  const rawAncillaryLines = Array.isArray(model?.ancillary_lines) && model.ancillary_lines.length
    ? model.ancillary_lines
    : buildAncillaryResourceLines({ model, design, rateCard });
  const pricedLines = priceRetainingWallResourceLines([...rawWallLines, ...rawAncillaryLines], rateCard);
  const aggregatedLines = aggregatePricedRetainingWallLines(pricedLines);
  const wallMaterialOrders = buildMaterialOrdersFromLines({
    lines: aggregatedLines.filter((line) => line.scope === "wall"),
    source: "retaining_wall_engine",
    sourceLineItemCode: "cs-wall",
    section: "Option 1: Concrete Sleeper Retaining Wall",
  });
  const ancillaryMaterialOrders = buildMaterialOrdersFromLines({
    lines: aggregatedLines.filter((line) => line.scope === "ancillary"),
    source: "retaining_wall_engine",
    sourceLineItemCode: "ancillaries",
    section: "Included in Both Options",
  });

  const totalsByScope = {
    wall: summarizePricedRetainingWallLines(pricedLines.filter((line) => line.scope === "wall")),
    ancillary: summarizePricedRetainingWallLines(pricedLines.filter((line) => line.scope === "ancillary")),
  };

  const { commercialLines, budgetLines } = buildCommercialArtifacts(aggregatedLines);
  const pricingIssues = pricedLines.flatMap((line) => line.pricingIssues || []);
  const totalsInvalid = pricedLines.some((line) => line.totalCost == null || line.totalPrice == null);

  return {
    rawLines: [...rawWallLines, ...rawAncillaryLines],
    pricedLines,
    commercialLines,
    budgetLines,
    materialOrders: [
      ...wallMaterialOrders,
      ...ancillaryMaterialOrders,
    ],
    totals: {
      cost: totalsInvalid ? null : roundMoney(sum(pricedLines.map((line) => line.totalCost))),
      charge: totalsInvalid ? null : roundMoney(sum(pricedLines.map((line) => line.totalPrice))),
      byScope: totalsByScope,
    },
    ready: !pricingIssues.length && !totalsInvalid,
    pricingIssues,
  };
}

function buildRockWallAlternative({ model, design, rateCard }) {
  const option = resolveRockWallOption(design);
  if (!option?.enabled) return null;

  const activeBays = (model?.bays || []).filter((bay) => bay?.is_active);
  if (!activeBays.length) return null;

  const measuredLength = roundQuantity(Number(model?.perimeter_m || sum(activeBays.map((bay) => geometryLength(bay?.geometry)))));
  const measuredArea = roundQuantity(sum(activeBays.map((bay) => Number(bay?.max_height_m || 0) * geometryLength(bay?.geometry))));
  const extraLength = Number(option?.geometry?.additional_run_length_m || option?.additional_run_length_m || 0);
  const extraAvgHeight = Number(option?.geometry?.additional_run_average_height_m || option?.additional_run_average_height_m || 1);
  const contingency = Number(option?.geometry?.quantity_contingency_factor || option?.quantity_contingency_factor || 1);
  const quotedLength = roundQuantity(measuredLength + extraLength);
  const estimatedArea = roundQuantity((measuredArea + extraLength * extraAvgHeight) * contingency);
  const tonnesPerM2 = Number(option?.materials?.tonnes_per_m2_wall_face || option?.tonnes_per_m2_wall_face || 1);
  const totalTonnes = roundQuantity(estimatedArea * tonnesPerM2);
  const excavatorHours = roundQuantity(
    estimatedArea * Number(option?.production?.excavator_hours_per_m2 || 0.35)
    + Number(option?.production?.cut_in_excavator_hours || 0)
  );
  const kangaHours = roundQuantity(estimatedArea * Number(option?.production?.kanga_hours_per_m2 || 0));
  const labourHours = roundQuantity(
    estimatedArea * Number(option?.production?.labour_hours_per_m2 || 0.45)
    + Number(option?.production?.sorting_labour_hours || 0)
    + Number(option?.production?.rabbit_proofing_labour_hours || 0)
  );
  const rabbitRates = option?.materials?.rabbit_proofing_manual_rates || null;
  const rabbitDescription = option?.materials?.rabbit_proofing_description
    || "Rabbit proofing allowance under/behind selected sections.";
  const rockItemCode = String(option?.materials?.rock_item_code || WALL_RATE_CARD_ITEMS.bluestoneLarge);
  const rockLabel = option?.materials?.rock_label || "Mixed Wall Rock";
  const sectionLabel = option?.section_label || "Option 2: Mixed Rock Wall";
  const scheduleLabel = option?.schedule_label || "Mixed Rock Wall — Supply & Install";
  const firstOrderTonnes = Number(option?.production?.first_order_tonnes || 0);

  const rawLines = [
    {
      source: "retaining_wall_engine",
      scope: "rock_option",
      code: "rock-supply",
      itemCode: rockItemCode,
      label: rockLabel,
      description: `Mixed wall rock supply based on ${totalTonnes}t total wall estimate.`,
      category: "materials",
      quantity: totalTonnes,
      unit: "tonne",
      trace: buildRetainingWallTrace({
        title: "Mixed wall rock supply",
        recipe: "rock_wall_estimate",
        formulas: [
          buildRetainingWallFormula("Rock wall area", `(${roundQuantity(measuredArea)} m2 measured + ${roundQuantity(extraLength)} m × ${roundQuantity(extraAvgHeight)} m extra run) × ${roundQuantity(contingency)} contingency = ${roundQuantity(estimatedArea)} m2.`),
          buildRetainingWallFormula("Rock tonnes", `${roundQuantity(estimatedArea)} m2 × ${roundQuantity(tonnesPerM2)} t/m2 = ${roundQuantity(totalTonnes)} tonnes.`),
        ],
        inputs: [
          buildRetainingWallInput("Measured length", measuredLength, "m"),
          buildRetainingWallInput("Quoted length", quotedLength, "m"),
          buildRetainingWallInput("Estimated wall area", estimatedArea, "m2"),
          buildRetainingWallInput("Tonnes / m2", tonnesPerM2, "t/m2"),
        ],
      }),
    },
    {
      source: "retaining_wall_engine",
      scope: "rock_option",
      code: "rock-excavator",
      itemCode: WALL_RATE_CARD_ITEMS.excavator,
      label: "Excavator Hour",
      description: "Contour cut-in, rock placement, and shaping for the mixed rock wall.",
      category: "machines",
      quantity: excavatorHours,
      unit: "hour",
      trace: buildRetainingWallTrace({
        title: "Rock wall excavator hours",
        recipe: "rock_wall_estimate",
        formulas: [
          buildRetainingWallFormula("Excavator hours", `${roundQuantity(estimatedArea)} m2 × ${roundQuantity(Number(option?.production?.excavator_hours_per_m2 || 0.35))} hr/m2 + ${roundQuantity(Number(option?.production?.cut_in_excavator_hours || 0))} cut-in hours = ${roundQuantity(excavatorHours)} hours.`),
        ],
      }),
    },
    {
      source: "retaining_wall_engine",
      scope: "rock_option",
      code: "rock-kanga",
      itemCode: WALL_RATE_CARD_ITEMS.kanga,
      label: "Kanga / Mini Loader Hour",
      description: "Rock sorting and short-range handling along the wall run.",
      category: "machines",
      quantity: kangaHours,
      unit: "hour",
      trace: buildRetainingWallTrace({
        title: "Rock wall Kanga hours",
        recipe: "rock_wall_estimate",
        formulas: [
          buildRetainingWallFormula("Kanga hours", `${roundQuantity(estimatedArea)} m2 × ${roundQuantity(Number(option?.production?.kanga_hours_per_m2 || 0))} hr/m2 = ${roundQuantity(kangaHours)} hours.`),
        ],
      }),
    },
    {
      source: "retaining_wall_engine",
      scope: "rock_option",
      code: "rock-labour",
      itemCode: WALL_RATE_CARD_ITEMS.labourer,
      label: "General Labourer Hour",
      description: "Rock sorting, matching, and rabbit-proofing support labour.",
      category: "labour",
      quantity: labourHours,
      unit: "hour",
      trace: buildRetainingWallTrace({
        title: "Rock wall labour hours",
        recipe: "rock_wall_estimate",
        formulas: [
          buildRetainingWallFormula("Labour hours", `${roundQuantity(estimatedArea)} m2 × ${roundQuantity(Number(option?.production?.labour_hours_per_m2 || 0.45))} hr/m2 + ${roundQuantity(Number(option?.production?.sorting_labour_hours || 0))} sorting + ${roundQuantity(Number(option?.production?.rabbit_proofing_labour_hours || 0))} rabbit-proofing = ${roundQuantity(labourHours)} hours.`),
        ],
      }),
    },
  ];

  if (rabbitRates) {
    rawLines.push({
      source: "retaining_wall_engine",
      scope: "rock_option",
      code: "rock-rabbit-proofing",
      itemCode: FALLBACK_ADJUSTMENT_ITEM_CODE,
      label: "Rabbit Proofing Allowance",
      description: rabbitDescription,
      category: "materials",
      quantity: 1,
      unit: "job",
      manualRates: {
        costRate: requireRate(rabbitRates.costRate, "rabbit proofing cost rate"),
        chargeRate: requireRate(rabbitRates.chargeRate ?? rabbitRates.costRate, "rabbit proofing charge rate"),
      },
      trace: buildRetainingWallTrace({
        title: "Rabbit proofing allowance",
        recipe: "rock_wall_estimate",
        formulas: [
          buildRetainingWallFormula("Rabbit proofing allowance", `Manual allowance = ${formatMoney(rabbitRates.chargeRate ?? rabbitRates.costRate)} charge (${formatMoney(rabbitRates.costRate)} cost).`),
        ],
      }),
    });
  }

  const pricedLines = priceRetainingWallResourceLines(rawLines, rateCard);
  const aggregatedLines = aggregatePricedRetainingWallLines(pricedLines);
  const { commercialLines, budgetLines } = buildCommercialArtifacts(aggregatedLines, {
    syncToCommercialAuthority: false,
  });
  const materialOrders = buildMaterialOrdersFromLines({
    lines: aggregatedLines,
    source: "retaining_wall_engine",
    sourceLineItemCode: option?.code || "rock-wall",
    section: sectionLabel,
  });
  const totals = summarizePricedRetainingWallLines(pricedLines);
  const rockCharge = totals.chargeTotal == null ? null : roundMoney(totals.chargeTotal);
  const rockCost = totals.costTotal == null ? null : roundMoney(totals.costTotal);
  const contingencyPct = Math.max(0, Math.round((contingency - 1) * 100));
  const rationale = formatCatalogUnitText([
    `${quotedLength}m wall allowance (${measuredLength}m measured run + ${extraLength}m secondary section).`,
    `${estimatedArea}m2 face area / ${totalTonnes}t rock basis with ${contingencyPct}% curvature-height contingency.`,
    "Includes cut-in, staged rock handling, and rabbit proofing.",
  ].join(" "));

  const assumptions = [
    `Rock wall priced on ${measuredLength}m measured driveway run plus ${extraLength}m secondary-run allowance, then uplifted ${contingencyPct}% for curvature and height variation (${estimatedArea}m2 / ${totalTonnes}t basis).`,
    "Mixed rock wall assumes a 2-tier contour-following layout with a level top line and a terrain-responsive lower wall; the visual start should be read from the reversed perimeter start noted on 26 March 2026.",
    option?.materials?.include_rabbit_proofing
      ? "Rabbit proofing allowance is included in the rock wall option as standard; exact extents can be confirmed during construction."
      : null,
    option?.materials?.exclude_standard_ag_drain || option?.materials?.exclude_standard_plastic
      ? "Sleeper-style AG pipe and backing plastic are excluded from the rock wall option unless a later site decision proves they are still needed."
      : null,
    firstOrderTonnes > 0
      ? `Quoted rock quantity is not the same as the first purchase order. Start with about ${firstOrderTonnes}t, then top up once the final wall shape and usage rate are visible on site.`
      : null,
  ].filter(Boolean).map((line) => formatCatalogUnitText(line));

  return {
    lineItem: {
      section: sectionLabel,
      code: option?.code || "rock-wall",
      label: scheduleLabel,
      quantity: 1,
      unit: "lot",
      unitPrice: rockCharge,
      totalPrice: rockCharge,
      rationale,
      customerVisible: true,
    },
    commercialLines,
    budgetLines,
    materialOrders,
    assumptions,
    totals: {
      charge: rockCharge,
      cost: rockCost,
    },
    ready: !totals.pricingIssues?.length && rockCharge != null && rockCost != null,
    pricingIssues: totals.pricingIssues || [],
    geometry: {
      measuredLength,
      quotedLength,
      measuredArea,
      estimatedArea,
      totalTonnes,
      firstOrderTonnes,
    },
  };
}

export function buildQuoteFromWallModel({ model, design, rateCard, meta, version = 1 }) {
  const commercial = buildRetainingWallCommercialBreakdown({ model, design, rateCard });
  const rockAlternative = buildRockWallAlternative({ model, design, rateCard });
  const materialOrders = [
    ...(commercial.materialOrders || []),
    ...(rockAlternative?.materialOrders || []),
  ];
  const wallCharge = commercial.totals.byScope.wall.chargeTotal == null
    ? null
    : roundMoney(commercial.totals.byScope.wall.chargeTotal);
  const ancillaryCharge = commercial.totals.byScope.ancillary.chargeTotal == null
    ? null
    : roundMoney(commercial.totals.byScope.ancillary.chargeTotal);
  const subtotal = wallCharge == null || ancillaryCharge == null
    ? null
    : roundMoney(wallCharge + ancillaryCharge);
  const gst = subtotal == null ? null : taxOnSubtotal(subtotal, 0.1);
  const rockOptionTotalIncGst = rockAlternative
    && rockAlternative.totals.charge != null
    && ancillaryCharge != null
    ? roundMoney((rockAlternative.totals.charge + ancillaryCharge) * 1.1)
    : null;
  const pricingIssues = [
    ...(commercial.pricingIssues || []),
    ...(rockAlternative?.pricingIssues || []),
  ];
  const pricingReady = commercial.ready !== false
    && (!rockAlternative || rockAlternative.ready !== false)
    && subtotal != null;
  const lineItems = [
    {
      section: "Option 1: Concrete Sleeper Retaining Wall",
      code: "cs-wall",
      label: "Concrete Sleeper Wall — Supply & Install",
      quantity: 1,
      unit: "lot",
      unitPrice: wallCharge,
      totalPrice: wallCharge,
      rationale: `${model.total_active_bays} bays with exact bay-by-bay resource decomposition from field measurements.`,
      customerVisible: true,
    },
    ...(rockAlternative ? [rockAlternative.lineItem] : []),
    {
      section: "Included in Both Options",
      code: "ancillaries",
      label: "Stairs, Earthworks, Delivery & Admin",
      quantity: 1,
      unit: "lot",
      unitPrice: ancillaryCharge,
      totalPrice: ancillaryCharge,
      rationale: "Ancillary commercial lines are decomposed separately from the wall bays and kept internal.",
      customerVisible: true,
    },
  ];
  const lineItemBreakdowns = [
    {
      sourceLineItemCode: "cs-wall",
      sourceLineItemLabel: "Concrete Sleeper Wall — Supply & Install",
      section: "Option 1: Concrete Sleeper Retaining Wall",
      sourceTotalPrice: wallCharge,
      sourceQuantity: 1,
      sourceUnit: "lot",
      recipe: "retaining_wall_exact",
      commercialLines: commercial.commercialLines.filter((cl) => cl.scope === "wall"),
      budgetLines: commercial.budgetLines.filter((bl) => bl.scope === "wall"),
      materialOrders: materialOrders.filter((order) => order.sourceLineItemCode === "cs-wall"),
      totals: {
        charge: commercial.totals.byScope.wall.chargeTotal,
        cost: commercial.totals.byScope.wall.costTotal,
      },
    },
    ...(rockAlternative ? [{
      sourceLineItemCode: rockAlternative.lineItem.code,
      sourceLineItemLabel: rockAlternative.lineItem.label,
      section: rockAlternative.lineItem.section,
      sourceTotalPrice: rockAlternative.lineItem.totalPrice,
      sourceQuantity: 1,
      sourceUnit: "lot",
      recipe: "rock_wall_estimate",
      commercialLines: rockAlternative.commercialLines,
      budgetLines: rockAlternative.budgetLines,
      materialOrders: rockAlternative.materialOrders,
      totals: rockAlternative.totals,
    }] : []),
    {
      sourceLineItemCode: "ancillaries",
      sourceLineItemLabel: "Stairs, Earthworks, Delivery & Admin",
      section: "Included in Both Options",
      sourceTotalPrice: ancillaryCharge,
      sourceQuantity: 1,
      sourceUnit: "lot",
      recipe: "retaining_wall_ancillary",
      commercialLines: commercial.commercialLines.filter((cl) => cl.scope === "ancillary"),
      budgetLines: commercial.budgetLines.filter((bl) => bl.scope === "ancillary"),
      materialOrders: materialOrders.filter((order) => order.sourceLineItemCode === "ancillaries"),
      totals: {
        charge: commercial.totals.byScope.ancillary.chargeTotal,
        cost: commercial.totals.byScope.ancillary.costTotal,
      },
    },
  ];

  // The sample business profile, under the installation's configured one.
  const wallBusinessProfile = applyBusinessProfileOverride({
    legalName: "Your Business Pty Ltd",
    abn: "",
    address: "Your business address",
    phone: "",
    email: "quotes@example.com",
    paymentMethods: {
      bankTransfer: {
        accountName: "",
        bsb: "000-000",
        accountNumber: "0000 0000 0",
        bank: "Your bank",
      },
    },
  });

  return {
    kind: "quote",
    version: Number(version || 1),
    status: "draft",
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobId: meta?.id || "",
    jobNumber: meta?.jobNumber || "",
    quoteNumber: design?.quote_number || meta?.quoteNumber || "PENDING",
    title: meta?.title || meta?.label || "Retaining Wall",
    recordingIntent: "job-scope",
    delivery: {
      status: "draft",
      label: "Quote Draft",
    },
    quoteCatalog: {
      id: DEFAULT_QUOTE_CATALOG_ID,
      name: "Sample Catalogue",
      currency: "AUD",
      gstRate: 0.1,
      businessProfile: wallBusinessProfile,
      deliveryDefaults: {
        issuerName: businessDisplayName(wallBusinessProfile),
        validityDays: 30,
        paymentTerms: "10% deposit due upon acceptance of this quote to secure booking. 30% progress payment due upon commencement of works. Remaining balance due within 7 days of project completion.",
        footerNote: "This quote is based on the listed scope, rate card, and assumptions current at issue time.",
      },
    },
    summary: buildWallQuoteSummary({ meta, model, rockAlternative }),
    lineItems,
    commercialLines: commercial.commercialLines,
    budgetLines: commercial.budgetLines,
    materialOrders,
    internalPricing: {
      mode: "flat_quote",
      commercialLines: commercial.commercialLines,
      budgetLines: commercial.budgetLines,
      materialOrders,
      totals: commercial.totals,
      ready: pricingReady,
      pricingIssues,
      coverage: {
        sourceLineItemCount: lineItems.length,
        exactRecipeCount: 2,
        estimatedRecipeCount: rockAlternative ? 1 : 0,
        directPassThroughCount: 0,
      },
      lineItemBreakdowns,
    },
    assumptionInputs: [],
    missingInputs: [],
    assumptions: rockAlternative?.assumptions || [],
    review: {
      status: "manual_review",
      reasons: [],
    },
    totals: {
      subtotal,
      gst,
      total: subtotal == null || gst == null ? null : roundMoney(subtotal + gst),
      currency: "AUD",
      ...(rockOptionTotalIncGst != null
        ? { _note: `Alternative mixed rock wall option: ${formatMoney(rockOptionTotalIncGst)} inc GST including shared ancillaries.` }
        : {}),
    },
  };
}

function resolveLineRates(line, rateCard) {
  const rateCardPricingSource = resolveRateCardPricingSource(rateCard);
  if (line.manualRates) {
    return {
      costRate: requireRate(line.manualRates.costRate, `${line.itemCode} manual cost rate`),
      chargeRate: requireRate(
        line.manualRates.chargeRate ?? line.manualRates.costRate,
        `${line.itemCode} manual charge rate`,
      ),
      source: "field_override",
    };
  }

  const materials = rateCard?.materials || {};
  const machines = rateCard?.machines || {};
  const labour = rateCard?.labour || {};
  const vehicle = rateCard?.vehicle || {};
  const site = rateCard?.site || {};
  const stockedSteel = resolveSteelStockRateEntry(rateCard, line.itemCode);

  if (stockedSteel) {
    return materialRates({
      costRate: stockedSteel.cost_ex_gst,
      chargeRate: stockedSteel.charge_ex_gst,
      source: rateCardPricingSource,
    });
  }

  switch (line.itemCode) {
    case WALL_RATE_CARD_ITEMS.sleeper:
      return materialRates({
        costRate: materials.kensington_sleeper?.cost_ex_gst,
        chargeRate: materials.kensington_sleeper?.charge_ex_gst,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.ibeam:
      return materialRates({
        costRate: materials.ibeam_125_galv?.cost_ex_gst,
        chargeRate: materials.ibeam_125_galv?.charge_ex_gst,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.cchannel:
      return materialRates({
        costRate: materials.cchannel_125_galv?.cost_ex_gst,
        chargeRate: materials.cchannel_125_galv?.charge_ex_gst,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.concreteBag:
      return materialRates({
        costRate: materials.concrete_20kg_bag?.cost,
        chargeRate: materials.concrete_20kg_bag?.charge,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.agpipe:
      return materialRates({
        costRate: materials.agpipe?.cost,
        chargeRate: materials.agpipe?.charge,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.fortacon:
      return materialRates({
        costRate: materials.fortacon_plastic?.cost,
        chargeRate: materials.fortacon_plastic?.charge,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.gravel:
      return materialRates({
        costRate: materials.gravel_20mm?.cost_per_tonne,
        chargeRate: materials.gravel_20mm?.charge_per_tonne,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.bluestoneLarge:
      return materialRates({
        costRate: materials.bluestone_large?.cost_ex_gst_per_tonne,
        chargeRate: materials.bluestone_large?.charge_ex_gst_per_tonne,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.bluestoneSmall:
      return materialRates({
        costRate: materials.bluestone_small?.cost_ex_gst_per_tonne,
        chargeRate: materials.bluestone_small?.charge_ex_gst_per_tonne,
        source: rateCardPricingSource,
      });
    case WALL_RATE_CARD_ITEMS.kanga:
      return hourlyRates(machines.kanga, rateCardPricingSource);
    case WALL_RATE_CARD_ITEMS.excavator:
      return hourlyRates(machines.excavator, rateCardPricingSource);
    case WALL_RATE_CARD_ITEMS.labourer:
      return hourlyRates(labour.general_labourer, rateCardPricingSource);
    case WALL_RATE_CARD_ITEMS.welder:
      return hourlyRates(labour.welder, rateCardPricingSource);
    case WALL_RATE_CARD_ITEMS.vehicleHour:
      return hourlyRates(vehicle, rateCardPricingSource);
    case WALL_RATE_CARD_ITEMS.vehicleKm:
      return {
        costRate: requireRate(vehicle.cost_km, "VEHICLE-KM cost rate"),
        chargeRate: requireRate(vehicle.charge_km, "VEHICLE-KM charge rate"),
        source: rateCardPricingSource,
      };
    case WALL_RATE_CARD_ITEMS.siteAllowance:
      return {
        costRate: requireRate(site.allowance_per_person_per_day),
        chargeRate: requireRate(site.allowance_charge_per_person_per_day),
        source: rateCardPricingSource,
      };
    case WALL_RATE_CARD_ITEMS.adminFee:
      return {
        costRate: requireRate(site.admin_cost),
        chargeRate: requireRate(site.admin_charge),
        source: rateCardPricingSource,
      };
    default:
      return {
        costRate: null,
        chargeRate: null,
        source: "unknown",
      };
  }
}

// Both sides come from the catalogue (the rate card); a missing sell is
// missing, never derived from the cost.
function materialRates({ costRate, chargeRate, source }) {
  return {
    costRate: requireRate(costRate),
    chargeRate: requireRate(chargeRate),
    source,
  };
}

function buildCommercialArtifacts(aggregatedLines, { syncToCommercialAuthority = true } = {}) {
  return {
    commercialLines: aggregatedLines.map((line, index) => ({
      code: buildCommercialLineCode(line, index),
      itemCode: line.itemCode,
      label: line.label,
      description: line.description || line.label,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitRate,
      totalPrice: line.totalPrice,
      unitCost: line.unitCost,
      totalCost: line.totalCost,
      category: line.category,
      scope: line.scope,
      pricingSource: line.pricingSource,
      customerVisible: false,
      syncToCommercialAuthority,
      trace: line.trace || null,
    })),
    budgetLines: aggregatedLines.map((line, index) => ({
      code: `${buildCommercialLineCode(line, index)}-cost`,
      itemCode: line.itemCode,
      label: line.label,
      description: line.description || line.label,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitCost,
      totalPrice: line.totalCost,
      category: line.category,
      scope: line.scope,
      pricingSource: line.pricingSource,
      customerVisible: false,
      trace: line.trace || null,
    })),
  };
}

function hourlyRates(entry = {}, source) {
  return {
    costRate: requireRate(entry?.cost_hr),
    chargeRate: requireRate(entry?.charge_hr),
    source,
  };
}

function resolveRateCardPricingSource(rateCard) {
  const source = String(rateCard?._source || "").trim().toLowerCase();
  if (source === "price_catalog") return "price_catalog_rate_card";
  return "unverified_rate_card";
}

function buildWallQuoteSummary({ meta, model, rockAlternative }) {
  const siteAddress = meta?.siteAddress || meta?.title || "the site";
  if (!rockAlternative) {
    return `Retaining wall — ${model.total_active_bays} active bays, ${model.total_sleepers} sleepers, ${model.total_holes} holes, and ${model.total_welds} welds. Includes stairs, drainage, earthworks, delivery, and administration.`;
  }
  return [
    `Retaining wall along the driveway at ${siteAddress} — from the sewage outlet side through to the back area.`,
    `Option 1 is the measured concrete sleeper design: ${model.total_active_bays} active bays, ${model.total_sleepers} sleepers, ${model.total_holes} holes, and ${model.total_welds} welds. Option 2 is a contour-following mixed rock wall with a level top line, a terrain-responsive lower wall, and curved alignment through the driveway edge.`,
    "The standard rock wall finish is natural and irregular rather than perfectly uniform. Rabbit proofing is included as a buried allowance, and sleeper-style AG pipe / plastic allowances are excluded from the rock wall option unless a later site decision proves they are still needed.",
    "All prices include supply, delivery, installation, stairs, site preparation, and shared preliminaries. Please select one option.",
  ].join("\n\n");
}

function resolveRockWallOption(design) {
  const rockWall = design?.options?.rock_wall;
  if (rockWall && rockWall.enabled !== false) return rockWall;
  const legacyBluestone = design?.options?.bluestone;
  return legacyBluestone?.enabled ? legacyBluestone : null;
}

function geometryLength(geometry = {}) {
  const dx = Number(geometry?.x_end || 0) - Number(geometry?.x_start || 0);
  const dy = Number(geometry?.y_end || 0) - Number(geometry?.y_start || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function buildCommercialLineCode(line, index) {
  const stable = [
    line.scope || "wall",
    line.itemCode || line.code || "line",
    line.itemCode === FALLBACK_ADJUSTMENT_ITEM_CODE
      ? slugify(line.description || line.label || String(index))
      : null,
  ].filter(Boolean).join("-");
  return `${slugify(stable)}-${String(index + 1).padStart(2, "0")}`;
}

function describeBayLine(bay, label) {
  const bayId = bay?.bay_id || bay?.bayId || "?";
  const tierCount = bay?.tierCount || bay?.tier_count || 0;
  return `${label} for bay ${bayId} (${tierCount}T).`;
}

function normalizeSteelPostStock(post, rateCard) {
  const material = post?.material === "ibeam" ? "ibeam" : "cchannel";
  const selected = post?.stock_item_code
    ? {
        itemCode: post.stock_item_code,
        label: post.stock_label || post.stock_item_name || post.stock_item_code,
        unit: post.stock_unit || "each",
        extraEmbedmentM: Number(post.extra_embedment_m || 0),
      }
    : selectSteelStockForLength({
        material,
        requiredLengthM: Number(post?.post_length_m || post?.exact_post_length_m || 0),
        rateCard,
      });
  if (!selected?.itemCode) return null;
  return {
    itemCode: selected.itemCode,
    label: selected.label || selected.itemName || selected.itemCode,
    unit: selected.unit || "each",
    extraEmbedmentM: Number(selected.extraEmbedmentM || 0),
  };
}

function buildStockSteelCode(itemCode) {
  return slugify(itemCode).replace(/^steel-/, "");
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "line";
}

function sum(values) {
  const numbers = values || [];
  if (numbers.some((value) => value == null || !Number.isFinite(Number(value)))) return null;
  return numbers.reduce((total, value) => total + Number(value), 0);
}

function roundMoney(value) {
  const numeric = requireRate(value);
  return numeric == null ? null : Math.round(numeric * 100) / 100;
}

function roundQuantity(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function formatMoney(value) {
  const rounded = roundMoney(value);
  if (rounded == null) return "unavailable";
  return `$${rounded.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function retainingWallReference(key, overrides = {}) {
  const base = RETAINING_WALL_REFERENCE_LIBRARY[key];
  if (!base) return null;
  return { ...base, ...overrides };
}

function retainingWallReferences(keys = []) {
  return keys
    .map((key) => retainingWallReference(key))
    .filter(Boolean);
}

function buildAuthorityItemReference(itemCode, pricingSource = null) {
  const provider = String(pricingSource || "").startsWith("price_catalog")
    ? "price_catalog"
    : String(pricingSource || "").startsWith("price_catalog")
      ? "price_catalog"
      : "catalog";
  return buildCommercialItemReference({
    itemCode,
    provider,
  });
}

function buildRetainingWallTrace({
  title = null,
  recipe = null,
  quantityDerivation = [],
  pricingDerivation = [],
  formulas = [],
  inputs = [],
  notes = [],
  references = [],
  components = [],
  context = null,
}) {
  return buildStructuredTrace({
    ...(title ? { title } : {}),
    ...(context && typeof context === "object" ? { context } : {}),
    engine: {
      id: "retaining_wall_engine",
      label: "Retaining Wall Engine",
      module: "apps/field/server/retaining-wall-commercial.js",
      recipe: recipe || null,
    },
    quantityDerivation: (quantityDerivation.length ? quantityDerivation : formulas).filter(Boolean),
    pricingDerivation: pricingDerivation.filter(Boolean),
    inputs: inputs.filter(Boolean),
    notes: notes.filter(Boolean),
    references: dedupeBy([
      ...defaultRetainingWallReferences(),
      ...normalizeTraceReferences(references),
    ], (entry) => `${entry.type || ""}::${entry.path || ""}::${entry.itemCode || ""}::${entry.start ?? ""}::${entry.end ?? ""}`),
    components,
  });
}

function buildRetainingWallFormula(label, expression, options = {}) {
  return buildTraceEntry(label, formatCatalogUnitText(expression), options);
}

function buildRetainingWallInput(label, value, unit = null, format = null, references = []) {
  return buildTraceInput(label, value, unit ? formatCatalogUnit(unit) : unit, format, references);
}

function defaultRetainingWallReferences() {
  return retainingWallReferences([
    "wallDesign",
    "bayHeights",
    "bayModel",
    "moasureJson",
    "moasureMd",
  ]);
}

function attachRetainingWallPriceTrace({
  trace,
  quantity,
  unit,
  unitCost,
  unitRate,
  totalCost,
  totalPrice,
  pricingSource,
  itemCode,
}) {
  const base = buildStructuredTrace(trace && typeof trace === "object" ? trace : {});
  const authorityReference = buildAuthorityItemReference(itemCode, pricingSource);
  return buildStructuredTrace({
    title: base.title || null,
    context: base.context || null,
    engine: {
      ...(base.engine || {}),
      id: base.engine?.id || "retaining_wall_engine",
      label: base.engine?.label || "Retaining Wall Engine",
      module: base.engine?.module || "apps/field/server/retaining-wall-commercial.js",
      recipe: base.engine?.recipe || null,
      pricingSource,
      itemCode,
    },
    quantityDerivation: Array.isArray(base.quantityDerivation) ? base.quantityDerivation : [],
    pricingDerivation: [
      ...(Array.isArray(base.pricingDerivation) ? base.pricingDerivation : []),
      buildRetainingWallFormula(
        "Charge total",
        `${roundQuantity(quantity)} ${unit || ""} × ${formatMoney(unitRate)} / ${unit || "unit"} = ${formatMoney(totalPrice)}`,
        { references: authorityReference ? [authorityReference] : [] },
      ),
      buildRetainingWallFormula(
        "Cost total",
        `${roundQuantity(quantity)} ${unit || ""} × ${formatMoney(unitCost)} / ${unit || "unit"} = ${formatMoney(totalCost)}`,
        { references: authorityReference ? [authorityReference] : [] },
      ),
    ],
    inputs: [
      ...(Array.isArray(base.inputs) ? base.inputs : []),
      buildRetainingWallInput("Pricing source", pricingSource),
      buildRetainingWallInput("Authority item", itemCode, null, null, authorityReference ? [authorityReference] : []),
      buildRetainingWallInput("Quantity", quantity, unit),
      buildRetainingWallInput("Charge / unit", unitRate, null, "money", authorityReference ? [authorityReference] : []),
      buildRetainingWallInput("Cost / unit", unitCost, null, "money", authorityReference ? [authorityReference] : []),
    ],
    notes: Array.isArray(base.notes) ? base.notes : [],
    references: dedupeBy([
      ...normalizeTraceReferences(base.references),
      ...(authorityReference ? [authorityReference] : []),
    ], (entry) => `${entry.type || ""}::${entry.path || ""}::${entry.itemCode || ""}`),
    components: Array.isArray(base.components) ? base.components : [],
  });
}

function extractRetainingWallTraceComponents(line) {
  if (Array.isArray(line?.trace?.components) && line.trace.components.length) {
    return line.trace.components.map((component) => {
      const normalized = buildStructuredTrace(component);
      return {
        ...(normalized.title ? { title: normalized.title } : {}),
        ...(normalized.context && typeof normalized.context === "object" ? { context: normalized.context } : {}),
        quantityDerivation: normalized.quantityDerivation,
        pricingDerivation: normalized.pricingDerivation,
        formulas: normalized.formulas,
        inputs: normalized.inputs,
        notes: normalized.notes,
        references: normalized.references,
      };
    });
  }
  if (line?.trace) {
    const normalized = buildStructuredTrace(line.trace);
    return [{
      title: normalized.title || line.description || line.label || line.itemCode || "Line contribution",
      ...(normalized.context && typeof normalized.context === "object" ? { context: normalized.context } : {}),
      quantityDerivation: normalized.quantityDerivation,
      pricingDerivation: normalized.pricingDerivation,
      formulas: normalized.formulas,
      inputs: normalized.inputs,
      notes: normalized.notes,
      references: normalized.references,
    }];
  }
  return [];
}

function buildAggregatedRetainingWallTrace(line) {
  const components = Array.isArray(line?.traceComponents) ? line.traceComponents : [];
  const references = dedupeBy(
    components.flatMap((component) => Array.isArray(component.references) ? component.references : []),
    (entry) => `${entry.type || ""}::${entry.path || ""}::${entry.itemCode || ""}`
  );
  const authorityReference = buildAuthorityItemReference(line.itemCode, line.pricingSource);
  const quantityDerivation = line.itemCode === WALL_RATE_CARD_ITEMS.sleeper
    ? buildAggregatedSleeperQuantityDerivation({ line, components })
    : [
        buildRetainingWallFormula(
          "Aggregated quantity",
          `${components.length} contributing calculation${components.length === 1 ? "" : "s"} aggregated to ${roundQuantity(line.quantity)} ${line.unit || ""}.`,
          { references },
        ),
      ];
  return buildRetainingWallTrace({
    title: line.description || line.label || line.itemCode || "Retaining wall line",
    recipe: line.scope === "rock_option"
      ? "rock_wall_estimate"
      : line.scope === "ancillary"
        ? "retaining_wall_ancillary"
        : "retaining_wall_exact",
    quantityDerivation,
    pricingDerivation: [
      buildRetainingWallFormula(
        "Aggregated charge",
        `${roundQuantity(line.quantity)} ${line.unit || ""} × ${formatMoney(line.unitRate)} / ${line.unit || "unit"} = ${formatMoney(line.totalPrice)}`,
        { references: authorityReference ? [authorityReference] : [] },
      ),
      buildRetainingWallFormula(
        "Aggregated cost",
        `${roundQuantity(line.quantity)} ${line.unit || ""} × ${formatMoney(line.unitCost)} / ${line.unit || "unit"} = ${formatMoney(line.totalCost)}`,
        { references: authorityReference ? [authorityReference] : [] },
      ),
    ],
    inputs: [
      buildRetainingWallInput("Scope", line.scope || null),
      buildRetainingWallInput("Category", line.category || null),
      buildRetainingWallInput("Authority item", line.itemCode || null, null, null, authorityReference ? [authorityReference] : []),
      buildRetainingWallInput("Quantity", line.quantity, line.unit),
    ],
    notes: [
      components.length > 1 ? `This line is aggregated from ${components.length} matching retaining-wall calculations.` : null,
    ],
    references,
    components,
  });
}

function compareRetainingWallCommercialLines(left, right) {
  const leftMeta = retainingWallCommercialSortMeta(left);
  const rightMeta = retainingWallCommercialSortMeta(right);
  return (
    leftMeta.scopeOrder - rightMeta.scopeOrder
    || leftMeta.groupOrder - rightMeta.groupOrder
    || rightMeta.stockLengthMm - leftMeta.stockLengthMm
    || String(left.itemCode || "").localeCompare(String(right.itemCode || ""))
    || String(left.label || "").localeCompare(String(right.label || ""))
  );
}

function retainingWallCommercialSortMeta(line) {
  const itemCode = String(line?.itemCode || "");
  const description = String(line?.description || line?.label || "");
  const scope = String(line?.scope || "wall");
  let groupOrder = 90;

  if (itemCode === WALL_RATE_CARD_ITEMS.sleeper) groupOrder = 10;
  else if (/^STEEL-(?:IBEAM|CCHANNEL)-/.test(itemCode) || /^STEEL-(?:IBEAM|CCHANNEL)$/.test(itemCode)) groupOrder = 20;
  else if (itemCode === WALL_RATE_CARD_ITEMS.concreteBag) groupOrder = 30;
  else if ([WALL_RATE_CARD_ITEMS.agpipe, WALL_RATE_CARD_ITEMS.fortacon, WALL_RATE_CARD_ITEMS.gravel].includes(itemCode)) groupOrder = 40;
  else if (itemCode === WALL_RATE_CARD_ITEMS.bluestoneLarge || itemCode === WALL_RATE_CARD_ITEMS.bluestoneSmall) groupOrder = 45;
  else if (itemCode === WALL_RATE_CARD_ITEMS.excavator) groupOrder = 50;
  else if (itemCode === WALL_RATE_CARD_ITEMS.kanga) groupOrder = 55;
  else if (itemCode === WALL_RATE_CARD_ITEMS.labourer) groupOrder = 60;
  else if (itemCode === WALL_RATE_CARD_ITEMS.welder) groupOrder = 70;
  else if (itemCode === WALL_RATE_CARD_ITEMS.vehicleHour) groupOrder = 80;
  else if (itemCode === WALL_RATE_CARD_ITEMS.siteAllowance) groupOrder = 85;
  else if (itemCode === WALL_RATE_CARD_ITEMS.adminFee) groupOrder = 90;
  else if (itemCode === FALLBACK_ADJUSTMENT_ITEM_CODE) {
    groupOrder = /fuel|delivery/i.test(description)
      ? 82
      : /rabbit/i.test(description)
        ? 65
        : 95;
  }

  return {
    scopeOrder: scope === "wall" ? 0 : scope === "rock_option" ? 1 : scope === "ancillary" ? 2 : 3,
    groupOrder,
    stockLengthMm: extractSteelStockLengthMm(itemCode),
  };
}

function extractSteelStockLengthMm(itemCode) {
  const match = String(itemCode || "").match(/-(\d{4})$/);
  return match ? Number(match[1]) : 0;
}

function buildSleeperBayTrace({ bay, rules }) {
  const bayId = Number(bay?.bay_id || 0);
  const tierCount = Number(bay?.tierCount || bay?.tier_count || 0);
  const totalSleepers = Number(bay?.totalSleepers || bay?.total_sleepers || 0);
  const measuredHeightM = Number(
    bay?.measuredHeightM
    ?? bay?.measured_height_m
    ?? bay?.rawHeightM
    ?? bay?.height_m
    ?? bay?.maxHeightM
    ?? bay?.max_height_m
    ?? 0
  );
  const effectiveHeightM = Number((bay?.maxHeightM ?? bay?.max_height_m ?? measuredHeightM) || 0);
  const walls = Array.isArray(bay?.walls) ? bay.walls : [];
  const rawTierCount = classifyRetainingWallTier(measuredHeightM, rules);
  const sleeperHeightM = Number(rules?.sleeper_height_mm || 0) / 1000;
  const tierReferences = retainingWallReferences(["wallDesign", "bayHeights", "bayModel"]);
  const geometryReferences = retainingWallReferences(["bayHeights", "moasureJson", "moasureMd"]);
  const quantityReferences = retainingWallReferences(["wallDesign", "bayModel"]);
  const overrideSummary = buildBayOverrideSummary({
    bayId,
    measuredHeightM,
    effectiveHeightM,
    rawTierCount,
    tierCount,
    isStandardizedSingleTier: bay?.isStandardizedSingleTier === true || bay?.is_standardized_single_tier === true,
    isCapped: bay?.isCapped === true || bay?.is_capped === true,
  });

  return buildRetainingWallTrace({
    title: describeBayLine(bay, "Concrete sleepers"),
    recipe: "retaining_wall_exact",
    context: {
      bayId,
      quantity: totalSleepers,
      unit: "each",
      tierCount,
      rawTierCount,
      measuredHeightM: roundQuantity(measuredHeightM),
      effectiveHeightM: roundQuantity(effectiveHeightM),
      isStandardizedSingleTier: bay?.isStandardizedSingleTier === true || bay?.is_standardized_single_tier === true,
      isCapped: bay?.isCapped === true || bay?.is_capped === true,
      walls: walls.map((wall) => ({
        level: Number(wall?.level || 0),
        sleepers: Number(wall?.sleepers || 0),
        wallHeightM: roundQuantity(Number(wall?.wall_height_m || 0)),
      })),
    },
    quantityDerivation: [
      buildRetainingWallFormula(
        "Measured wall geometry",
        `Moasure / wall-line inputs resolved bay ${bayId} at ${roundQuantity(measuredHeightM)} m measured retaining height.`,
        { references: geometryReferences },
      ),
      buildRetainingWallFormula(
        "Tier classification",
        buildTierClassificationExpression({ measuredHeightM, rawTierCount, tierCount, rules }),
        { references: tierReferences },
      ),
      overrideSummary
        ? buildRetainingWallFormula("Tier override logic", overrideSummary, { references: quantityReferences })
        : null,
      buildRetainingWallFormula(
        "Per-tier sleeper counts",
        buildSleeperWallExpression({ walls, totalSleepers }),
        { references: quantityReferences },
      ),
    ],
    inputs: [
      buildRetainingWallInput("Bay", bayId, null, null, [retainingWallReference("bayModel")]),
      buildRetainingWallInput("Measured height", measuredHeightM, "m", null, geometryReferences),
      buildRetainingWallInput("Effective system height", effectiveHeightM, "m", null, quantityReferences),
      buildRetainingWallInput("Tier count", tierCount, "tier", null, [retainingWallReference("bayModel")]),
      buildRetainingWallInput("Sleeper height", sleeperHeightM, "m", null, [retainingWallReference("wallDesign")]),
      ...walls.map((wall) => buildRetainingWallInput(
        `Tier ${wall.level} wall`,
        `${Number(wall.sleepers || 0)} sleepers = ${roundQuantity(Number(wall.wall_height_m || 0))} m`,
        null,
        null,
        [retainingWallReference("bayModel")],
      )),
      buildRetainingWallInput("Total sleepers", totalSleepers, "each", null, [retainingWallReference("bayModel")]),
    ],
    notes: [
      bay?.note || null,
    ],
  });
}

function buildAggregatedSleeperQuantityDerivation({ line, components }) {
  const validComponents = components.filter((component) => Number(component?.context?.quantity || 0) > 0);
  if (!validComponents.length) {
    return [
      buildRetainingWallFormula(
        "Aggregated quantity",
        `${components.length} contributing calculation${components.length === 1 ? "" : "s"} aggregated to ${roundQuantity(line.quantity)} ${line.unit || ""}.`,
        { references: retainingWallReferences(["wallDesign", "bayModel"]) },
      ),
    ];
  }

  const groupedPatterns = new Map();
  for (const component of validComponents) {
    const walls = Array.isArray(component?.context?.walls) ? component.context.walls : [];
    const pattern = walls.map((wall) => Number(wall?.sleepers || 0)).join("+") || String(Number(component?.context?.quantity || 0));
    const existing = groupedPatterns.get(pattern);
    if (existing) {
      existing.count += 1;
      existing.total += Number(component.context.quantity || 0);
      existing.bays.push(component.context.bayId);
      continue;
    }
    groupedPatterns.set(pattern, {
      pattern,
      count: 1,
      total: Number(component.context.quantity || 0),
      perBayQuantity: Number(component.context.quantity || 0),
      tierCount: Number(component.context.tierCount || 0),
      effectiveHeightM: Number(component.context.effectiveHeightM || 0),
      bays: [component.context.bayId],
      isStandardizedSingleTier: component.context.isStandardizedSingleTier === true,
      isCapped: component.context.isCapped === true,
    });
  }

  const patternEntries = [...groupedPatterns.values()]
    .sort((left, right) => left.tierCount - right.tierCount || left.pattern.localeCompare(right.pattern))
    .map((group) => {
      const label = buildSleeperGroupLabel(group);
      return buildRetainingWallFormula(
        label,
        `${group.count} bay${group.count === 1 ? "" : "s"} (${group.bays.join(", ")}) use sleeper pattern ${group.pattern.replace(/\+/g, " + ")} = ${group.count} × ${group.perBayQuantity} = ${group.total} sleepers.`,
        { references: retainingWallReferences(["wallDesign", "bayModel"]) },
      );
    });

  const overrideCount = validComponents.filter((component) => component?.context?.isStandardizedSingleTier || component?.context?.isCapped).length;
  const expressions = [...groupedPatterns.values()].map((group) => group.total).join(" + ");

  return [
    buildRetainingWallFormula(
      "Source artifacts",
      `Moasure geometry, wall-design rules, bay-heights output, and the computed bay-model produced ${validComponents.length} active sleeper bay calculation${validComponents.length === 1 ? "" : "s"}.`,
      { references: retainingWallReferences(["moasureJson", "moasureMd", "wallDesign", "bayHeights", "bayModel"]) },
    ),
    overrideCount > 0
      ? buildRetainingWallFormula(
          "Tier override logic",
          `${overrideCount} bay${overrideCount === 1 ? "" : "s"} had tier-system overrides applied before sleeper totals were summed.`,
          { references: retainingWallReferences(["wallDesign", "bayModel"]) },
        )
      : null,
    ...patternEntries,
    buildRetainingWallFormula(
      "Aggregated total",
      `${expressions} = ${roundQuantity(line.quantity)} ${line.unit || ""}.`,
      { references: retainingWallReferences(["bayModel"]) },
    ),
  ].filter(Boolean);
}

function classifyRetainingWallTier(heightM, rules) {
  if (!(Number(heightM || 0) > 0)) return 0;
  if (heightM <= Number(rules?.tier2_trigger_m || 0)) return 1;
  if (heightM <= Number(rules?.tier3_trigger_m || 0)) return 2;
  return 3;
}

function buildTierClassificationExpression({ measuredHeightM, rawTierCount, tierCount, rules }) {
  const tier2 = Number(rules?.tier2_trigger_m || 0);
  const tier3 = Number(rules?.tier3_trigger_m || 0);
  const base = rawTierCount <= 1
    ? `${roundQuantity(measuredHeightM)} m is at or below the tier-2 trigger ${roundQuantity(tier2)} m, so the measured bay starts as 1 tier.`
    : rawTierCount === 2
      ? `${roundQuantity(measuredHeightM)} m is above ${roundQuantity(tier2)} m and at or below the tier-3 trigger ${roundQuantity(tier3)} m, so the measured bay starts as 2 tiers.`
      : `${roundQuantity(measuredHeightM)} m is above the tier-3 trigger ${roundQuantity(tier3)} m, so the measured bay starts as 3 tiers.`;
  if (rawTierCount === tierCount) return base;
  return `${base} The emitted bay model records ${tierCount} tier${tierCount === 1 ? "" : "s"} after override rules are applied.`;
}

function buildBayOverrideSummary({
  bayId,
  measuredHeightM,
  effectiveHeightM,
  rawTierCount,
  tierCount,
  isStandardizedSingleTier,
  isCapped,
}) {
  if (isStandardizedSingleTier) {
    return `Single-tier override standardized bay ${bayId} from ${roundQuantity(measuredHeightM)} m measured height to the ${roundQuantity(effectiveHeightM)} m system height before sleeper counts were computed.`;
  }
  if (isCapped && rawTierCount !== tierCount) {
    return `Cap override forced bay ${bayId} from ${rawTierCount} tiers down to ${tierCount} tier so the sleeper count follows the capped system height ${roundQuantity(effectiveHeightM)} m.`;
  }
  if (isCapped) {
    return `Cap override holds bay ${bayId} at ${tierCount} tier with ${roundQuantity(effectiveHeightM)} m effective wall height.`;
  }
  return null;
}

function buildSleeperWallExpression({ walls, totalSleepers }) {
  if (!walls.length) {
    return `${totalSleepers} sleepers recorded in the emitted bay model.`;
  }
  const parts = walls.map((wall) => {
    const sleepers = Number(wall?.sleepers || 0);
    const height = roundQuantity(Number(wall?.wall_height_m || 0));
    return `tier ${Number(wall?.level || 0)} = ${sleepers} sleepers (${height} m wall height)`;
  });
  return `${parts.join(" + ")} = ${totalSleepers} sleepers.`;
}

function buildSleeperGroupLabel(group) {
  if (group.isStandardizedSingleTier && group.tierCount === 1) {
    return `${roundQuantity(group.effectiveHeightM)}m standardized 1-tier bays`;
  }
  if (group.isCapped) {
    return `Capped ${group.tierCount}-tier bays`;
  }
  return `${group.tierCount}-tier bays`;
}

function dedupeBy(values, toKey) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const key = toKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}
