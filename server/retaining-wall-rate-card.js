// The retaining-wall engine's rate card: the catalogue prices of the items
// the wall engine (server/retaining-wall-*.js) prices its resource lines
// with, read from one price-catalogue snapshot's buy/sell maps.
//
// The wall engine stays code, not assembly data: it walks a bay model
// (per-bay heights, tiers, posts and welds), picks stocked steel lengths per
// post and derives delivery trips, none of which the assembly expression
// language (numbers, params, vars, arithmetic, ceil/floor/round/min/max)
// can express, so there is no assembly form whose golden fixtures could
// match it. What moved out of code is every price: there are no fallback
// rates here. A rate the catalogue does not have is null, and the wall
// pricing path fails closed on it, naming the item
// (server/price-catalog/wall-rate-card.js).
import { requireRate, resolveMapRate } from "./local-pricing.js";
import { WALL_RATE_CARD_ITEMS } from "./retaining-wall-items.js";
import { buildSteelStockCatalog, DEFAULT_STOCKED_STEEL_LENGTHS_MM } from "./retaining-wall-steel.js";

export { WALL_RATE_CARD_ITEMS };


/** Every item the rate card reads: GET /api/rate-card needs all of them. */
export const RATE_CARD_REQUIRED_PRICE_CODES = Object.freeze([...new Set(Object.values(WALL_RATE_CARD_ITEMS))]);

/**
 * The items an ordinary sleeper wall always prices. Conditional lines (rock
 * material, the APC delivery minimum, vehicle kilometres) are added per wall
 * from the generated model (resolveWallRequiredPriceCodes).
 */
export const RETAINING_WALL_REQUIRED_PRICE_CODES = Object.freeze([
  WALL_RATE_CARD_ITEMS.adminFee,
  WALL_RATE_CARD_ITEMS.agpipe,
  WALL_RATE_CARD_ITEMS.concreteBag,
  WALL_RATE_CARD_ITEMS.excavator,
  WALL_RATE_CARD_ITEMS.fortacon,
  WALL_RATE_CARD_ITEMS.gravel,
  WALL_RATE_CARD_ITEMS.kanga,
  WALL_RATE_CARD_ITEMS.labourer,
  WALL_RATE_CARD_ITEMS.siteAllowance,
  WALL_RATE_CARD_ITEMS.sleeper,
  WALL_RATE_CARD_ITEMS.cchannel,
  WALL_RATE_CARD_ITEMS.ibeam,
  WALL_RATE_CARD_ITEMS.vehicleHour,
  WALL_RATE_CARD_ITEMS.welder,
]);

/**
 * Build the wall rate card from catalogue price maps. Every money field is
 * the catalogue's rate or null; nothing is defaulted. The non-money fields
 * (gravel tonnes per bay, bays per delivery trip, the APC free-delivery
 * threshold, working-day hours) are the wall engine's quantity rules.
 */
export function buildRateCardFromPriceMaps({ buyMap = {}, sellMap = {}, _fetchedAt, _source }) {
  const items = WALL_RATE_CARD_ITEMS;
  const money = (map, code) => requireRate(resolveMapRate(map, code));
  const buy = (slot) => money(buyMap, items[slot]);
  const sell = (slot) => money(sellMap, items[slot]);
  const ibeamCostRate = buy("ibeam");
  const ibeamChargeRate = sell("ibeam");
  const cchannelCostRate = buy("cchannel");
  const cchannelChargeRate = sell("cchannel");
  const sleeperCost = buy("sleeper");
  const sleeperCharge = sell("sleeper");

  return {
    _source: String(_source || "price_catalog").trim().toLowerCase() || "price_catalog",
    _fetched_at: _fetchedAt || new Date().toISOString(),
    labour: {
      general_labourer: { cost_hr: buy("labourer"), charge_hr: sell("labourer") },
      welder: { cost_hr: buy("welder"), charge_hr: sell("welder") },
    },
    machines: {
      excavator: { cost_hr: buy("excavator"), charge_hr: sell("excavator"), includes_operator: true },
      kanga: { cost_hr: buy("kanga"), charge_hr: sell("kanga"), includes_operator: true },
      jackhammer: { cost_hr: buy("jackhammer"), charge_hr: sell("jackhammer"), includes_operator: false },
    },
    vehicle: {
      cost_hr: buy("vehicleHour"),
      charge_hr: sell("vehicleHour"),
      cost_km: buy("vehicleKm"),
      charge_km: sell("vehicleKm"),
    },
    materials: {
      kensington_sleeper: {
        cost_ex_gst: sleeperCost,
        charge_ex_gst: sleeperCharge,
        unit: "each",
      },
      ibeam_125_galv: {
        cost_ex_gst: ibeamCostRate,
        charge_ex_gst: ibeamChargeRate,
        unit: "m",
        stock_lengths: buildSteelStockCatalog({ material: "ibeam", buyMap, sellMap, fallbackCostRate: ibeamCostRate, fallbackChargeRate: ibeamChargeRate, lengthsMm: DEFAULT_STOCKED_STEEL_LENGTHS_MM }),
      },
      cchannel_125_galv: {
        cost_ex_gst: cchannelCostRate,
        charge_ex_gst: cchannelChargeRate,
        unit: "m",
        stock_lengths: buildSteelStockCatalog({ material: "cchannel", buyMap, sellMap, fallbackCostRate: cchannelCostRate, fallbackChargeRate: cchannelChargeRate, lengthsMm: DEFAULT_STOCKED_STEEL_LENGTHS_MM }),
      },
      concrete_20kg_bag: { cost: buy("concreteBag"), charge: sell("concreteBag"), unit: "bag" },
      agpipe: { cost: buy("agpipe"), charge: sell("agpipe"), unit: "bay" },
      fortacon_plastic: { cost: buy("fortacon"), charge: sell("fortacon"), unit: "bay" },
      gravel_20mm: { cost_per_tonne: buy("gravel"), charge_per_tonne: sell("gravel"), tonnes_per_bay: 0.125 },
      bluestone_large: { cost_ex_gst_per_tonne: buy("bluestoneLarge"), charge_ex_gst_per_tonne: sell("bluestoneLarge") },
      bluestone_small: { cost_ex_gst_per_tonne: buy("bluestoneSmall"), charge_ex_gst_per_tonne: sell("bluestoneSmall") },
    },
    markup: {
      // The sleeper's own catalogue margin, applied to the supplier delivery
      // minimum; null (fail closed) when the sleeper is unpriced.
      materials: sleeperCost && sleeperCharge
        ? Math.round((sleeperCharge / sleeperCost - 1) * 100) / 100
        : null,
      default: null,
    },
    delivery: {
      apc_free_threshold_sleepers: 40,
      apc_minimum_charge_inc_gst: sell("apcDeliveryMinimum"),
      apc_minimum_charge_item_code: items.apcDeliveryMinimum,
      gravel_bays_per_trip: 8,
    },
    site: {
      allowance_per_person_per_day: buy("siteAllowance"),
      allowance_charge_per_person_per_day: sell("siteAllowance"),
      admin_cost: buy("adminFee"),
      admin_charge: sell("adminFee"),
    },
    working_day: { effective_hours: 7, billable_hours: 8 },
  };
}
