// Test fixtures: synthetic catalogue prices for unit tests that exercise the
// pricing engines without a database. Field's code has no prices of its own
// (the price catalogue is the only authority), so tests bring theirs. The
// values are the ones the engines used to fall back to, so long-standing
// expectations keep their meaning.
import { getQuoteCatalog } from "./quote-catalogs.js";
import { buildRateCardFromPriceMaps } from "./retaining-wall-rate-card.js";

/** [buy, sell] per item code, per the item's own unit. */
export const TEST_ITEM_PRICES = Object.freeze({
  "LABOURER-HOUR": [50, 80],
  "WELDER-HOUR": [75, 100],
  "EXCAVATOR-HOUR": [180, 300],
  "KANGA-HOUR": [90, 150],
  "JACKHAMMER-HOUR": [150, 250],
  "VEHICLE-HOUR": [45, 75],
  "VEHICLE-KM": [0.8, 0.8],
  "ADMIN-FEE": [200, 300],
  "SITE-ALLOWANCE-DAY": [50, 50],
  "APC-DELIVERY-MINIMUM": [140, 170],
  // Wall materials at cost + 20%.
  "SLEEPER-KENSINGTON": [38.18, 45.816],
  "STEEL-IBEAM-125-GALV": [36.36, 43.632],
  "STEEL-CCHANNEL-125-GALV": [40.91, 49.092],
  "CONCRETE-20KG-BAG": [8.6, 10.32],
  "AGPIPE-BAY": [8, 9.6],
  "FORTACON-BAY": [8, 9.6],
  "GRAVEL-20MM": [83, 99.6],
  "BLUESTONE-LARGE": [132, 158.4],
  "BLUESTONE-SMALL": [162, 194.4],
  // Recipe (assembly) components.
  "TURF-SUPPLY-M2": [18, 22.5],
  "SANDY-LOAM-M3": [66.75, 90],
  "IRRIGATION-CONTROLLER-BATTERY": [500, 600],
  "IRRIGATION-CONTROLLER-MAINS": [600, 720],
  "IRRIGATION-PIPE-FIXINGS-M2": [8.5, 10],
  "DRAIN-PIPE-M": [14, 22],
  "DRAIN-PIT": [95, 145],
  "DRAIN-GRAVEL-M": [11, 18],
  "clean-fill-disposal": [9, 14],
});

/** Sell rates for the embark-default quote rules (buy is 1 in fixtures). */
export const TEST_QUOTE_RULE_SELL_RATES = Object.freeze({
  "site-establishment": 185,
  "excavator-hour": 185,
  "vehicle-hour": 75,
  "vehicle-km": 0.8,
  "mini-loader-hour": 150,
  "labourer-hour": 80,
  "concrete-demolition": 650,
  "concrete-surface-demolition": 36.67,
  "concrete-structure-demolition": 78.57,
  "concrete-removal": 217.79,
  "jackhammer-hour": 250,
  "soil-removal": 91.89,
  "tip-truck": 240,
  "site-levelling": 88.13,
  "imported-fill": 120,
  "retaining-wall": 420,
  "drainage": 145,
  "irrigation-system-install": 6820,
  "lawn-supply-prep-install": 53.5,
  "large-tree-supply-install": 755,
  "tree-supply-install": 437.5,
  "plant-supply-install": 72.25,
  "block-edging-supply-install": 147.5,
  "rock-wall": 310,
  "cleanup": 180,
  "misc-site-works": 650,
});

/** The unit each fixture item is sold in (the quote catalog carries none). */
export const TEST_ITEM_UNITS = Object.freeze({
  "site-establishment": "job",
  "excavator-hour": "hour",
  "vehicle-hour": "hour",
  "vehicle-km": "km",
  "mini-loader-hour": "hour",
  "labourer-hour": "hour",
  "concrete-demolition": "job",
  "concrete-surface-demolition": "m2",
  "concrete-structure-demolition": "m2",
  "concrete-removal": "m3",
  "jackhammer-hour": "hour",
  "soil-removal": "m3",
  "clean-fill-disposal": "tonne",
  "unclean-fill-disposal": "tonne",
  "concrete-waste-disposal": "tonne",
  "green-waste-disposal": "tonne",
  "tip-truck": "load",
  "site-levelling": "m3",
  "imported-fill": "m3",
  "retaining-wall": "m",
  "drainage": "m",
  "irrigation-system-install": "job",
  "lawn-supply-prep-install": "m2",
  "large-tree-supply-install": "tree",
  "tree-supply-install": "tree",
  "plant-supply-install": "plant",
  "block-edging-supply-install": "m",
  "rock-wall": "m2",
  "cleanup": "job",
  "misc-site-works": "job",
  "LABOURER-HOUR": "hour",
  "WELDER-HOUR": "hour",
  "EXCAVATOR-HOUR": "hour",
  "KANGA-HOUR": "hour",
  "JACKHAMMER-HOUR": "hour",
  "VEHICLE-HOUR": "hour",
  "VEHICLE-KM": "km",
  "ADMIN-FEE": "each",
  "TURF-SUPPLY-M2": "m2",
  "SANDY-LOAM-M3": "m3",
  "IRRIGATION-CONTROLLER-BATTERY": "each",
  "IRRIGATION-CONTROLLER-MAINS": "each",
  "IRRIGATION-PIPE-FIXINGS-M2": "m2",
  "DRAIN-PIPE-M": "m",
  "DRAIN-PIT": "each",
  "DRAIN-GRAVEL-M": "m",
});

export function testPriceMaps(prices = TEST_ITEM_PRICES) {
  return {
    buyMap: Object.fromEntries(Object.entries(prices).map(([code, [buy]]) => [code, buy])),
    sellMap: Object.fromEntries(Object.entries(prices).map(([code, [, sell]]) => [code, sell])),
  };
}

/** The wall rate card over the fixture prices. */
export function buildTestRateCard(prices = TEST_ITEM_PRICES) {
  return buildRateCardFromPriceMaps({ ...testPriceMaps(prices), _source: "price_catalog" });
}

/**
 * Recipe pricing for a quote catalog's assemblies over fixture prices, in
 * the shape server/price-catalog/recipe-pricing.js produces from a real
 * catalogue (every component in its item's unit). A code without a price is
 * a missing item.
 */
export function buildTestRecipePricing({ quoteCatalog = getQuoteCatalog("embark-default"), prices = TEST_ITEM_PRICES } = {}) {
  const lookup = new Map(Object.entries(prices).map(([code, value]) => [code.toLowerCase(), [code, value]]));
  const assemblies = {};
  for (const definition of quoteCatalog?.assemblies || []) {
    const components = {};
    const problems = [];
    for (const component of definition.components) {
      const entry = lookup.get(component.itemCode.toLowerCase()) || null;
      const problem = entry ? null : { kind: "missing_item", message: `the ${definition.code} recipe (${component.key}) uses ${component.itemCode}, which is not in the price catalogue` };
      components[component.key] = {
        key: component.key,
        itemCode: entry ? entry[0] : component.itemCode,
        label: component.label,
        unit: component.unit,
        item: entry ? { code: entry[0], name: entry[0], unit: component.unit, status: "active" } : null,
        priceId: null,
        cost: entry ? entry[1][0] : null,
        sell: entry ? entry[1][1] : null,
        unitFactor: entry ? 1 : null,
        problem,
      };
      if (problem) problems.push({ key: component.key, itemCode: component.itemCode, ...problem });
    }
    assemblies[definition.code] = { code: definition.code, mode: definition.mode, version: definition.version, definition, components, problems };
  }
  return { _source: "price_catalog", assemblies, items: {} };
}
