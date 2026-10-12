// Pricing projections over one catalogue snapshot (server/catalog/state.js):
// the buy/sell price maps, the quote-catalog rule overlay, and the authority
// snapshot quote builds attest to. All prices come from the catalogue's one
// roll-up (server/catalog/rollup.js); recipe (assembly) prices come from
// ./recipe-pricing.js over the same snapshot.
import { createHash } from "node:crypto";
import { normalizeCatalogUnit } from "../../shared/catalog-units.js";
import { effectivePrices } from "../catalog/rollup.js";
import { conversionFactor, pricingBasisFactor } from "../catalog/units.js";
import { refItem, withoutItemUids } from "../catalog/refs.js";
import { displayUnit, inactiveComponentsByParent, priceMaps, revisionRows } from "../catalog/views.js";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function stripVolatileAuthorityFields(value) {
  if (Array.isArray(value)) return value.map(stripVolatileAuthorityFields);
  if (!value || typeof value !== "object") return value;
  const volatileKeys = new Set(["attestedAt", "fetchedAt", "refreshedAt", "syncedAt", "_fetchedAt"]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatileKeys.has(key))
      .map(([key, entry]) => [key, stripVolatileAuthorityFields(entry)]),
  );
}

function requireState(state) {
  if (!state || !(state.items instanceof Map)) throw new Error("price catalog is unavailable");
  return state;
}

/**
 * Buy and sell maps keyed by item code over active items, with effective
 * (rolled-up) prices for kits.
 */
export function fetchPriceMapsFromCatalog(state, { fetchedAt = new Date().toISOString() } = {}) {
  return priceMaps(requireState(state), { fetchedAt });
}

/**
 * Project the catalogue onto quote-catalog rules: each rule's
 * authorityItemCode (or code) is looked up case-insensitively and its price
 * written to `rule.priceCatalog` and the older `rule.authorityPricing`
 * compatibility field. A missing or archived item, an unpriced item, one
 * with an inactive component, or one sold in a unit the rule's quantity
 * cannot convert to is listed in `missingCodes`.
 *
 * Units: a rule measures its quantity in its own `quantityUnit` (quote
 * catalog structure, e.g. m2 for an area rule) and lines keep that unit. The
 * item's price is per the item's unit, so it is converted to the rule's
 * unit through the catalogue's conversions (server/catalog/units.js). When
 * the catalogue has no conversion (an item sold per m behind an area rule)
 * the rule has no rate and fails closed naming the item; it is never
 * relabelled into the item's unit, which would silently change quantities.
 */
export function overlayQuoteCatalogsFromPriceCatalog(quoteCatalogs, state, { syncedAt = new Date().toISOString() } = {}) {
  requireState(state);
  const prices = effectivePrices(state);
  const inactiveByParent = inactiveComponentsByParent(state);
  const missingCodes = [];
  let overlaidRuleCount = 0;

  for (const quoteCatalog of Object.values(quoteCatalogs)) {
    const catalogMissingCodes = [];
    for (const rule of quoteCatalog.rules) {
      const lookupCode = String(rule.authorityItemCode || rule.code || "").trim();
      const item = (rule.authorityItemUid || lookupCode) ? refItem(state, { uid: rule.authorityItemUid, code: lookupCode }) : null;
      const quantityUnit = rule.quantityUnit ? normalizeCatalogUnit(rule.quantityUnit) : null;

      if (!item || item.status === "archived") {
        // No catalogue item: the rule keeps its own quantity unit, no rate.
        rule.unit = quantityUnit;
        rule.unitConversions = quantityUnit ? { [quantityUnit]: 1 } : {};
        rule.priceCatalog = null;
        rule.authorityPricing = {
          itemCode: lookupCode || null,
          itemName: null,
          itemGroup: null,
          stockUom: null,
          isStockItem: false,
          sellingPriceList: "Price Catalog",
          sellingRate: null,
          buyingPriceList: "Price Catalog",
          buyingRate: null,
          bundleItems: [],
          missingItem: true,
        };
        if (lookupCode) {
          missingCodes.push(lookupCode);
          catalogMissingCodes.push(lookupCode);
        }
        continue;
      }

      const effective = prices.get(item.uid) || { cost: null, sell: null };
      const inactiveComponents = inactiveByParent.get(item.uid) || [];
      const pricingBasis = item.pricingBasis || null;
      const pricingBasisFactor = pricingBasisFactorOf(state, item);
      const unit = displayUnit(item);
      const itemUnit = normalizeCatalogUnit(unit, item.unitCode);
      // A hand-built quote catalog (tests) may not declare a quantity unit:
      // it then measures in the item's unit. Every json5 rule declares one
      // (server/quote-catalogs.js refuses a rule without it).
      const ruleUnit = quantityUnit || itemUnit;
      const conversion = resolveRuleUnitConversion(state, item, ruleUnit, itemUnit);
      const unitMismatch = conversion.factor == null ? conversion.mismatch : null;
      const factor = conversion.factor;
      const scale = (value) => {
        if (value == null || factor == null) return null;
        return factor === 1 ? value : roundRate(Number(value) * factor);
      };
      const buyPrice = scale(effective.cost);
      const sellPrice = scale(effective.sell);
      rule.unit = ruleUnit;
      rule.unitConversions = unitMismatch ? { [ruleUnit]: 1 } : ruleUnitConversions(state, item, ruleUnit);

      rule.priceCatalog = {
        code: item.code,
        name: item.name,
        buyPrice,
        sellPrice,
        unit,
        quantityUnit: ruleUnit,
        unitFactor: factor,
        unitMismatch,
        status: item.status,
        pricingBasis,
        pricingBasisFactor,
        inactiveComponentCount: inactiveComponents.length,
        inactiveComponents: inactiveComponents.map(({ code, name, status }) => ({ code, name, status })),
      };

      rule.authorityPricing = {
        itemCode: item.code,
        itemName: item.name,
        itemGroup: item.category || null,
        stockUom: factor === 1 ? unit : ruleUnit,
        isStockItem: false,
        sellingPriceList: "Price Catalog",
        sellingRate: sellPrice != null ? Number(sellPrice) : null,
        buyingPriceList: "Price Catalog",
        buyingRate: buyPrice != null ? Number(buyPrice) : null,
        bundleItems: [],
        missingItem: inactiveComponents.length > 0,
        unitMismatch,
        pricingBasis,
        pricingBasisFactor,
      };

      if (buyPrice == null || sellPrice == null || inactiveComponents.length > 0) {
        missingCodes.push(item.code);
        catalogMissingCodes.push(item.code);
      }

      overlaidRuleCount++;
    }

    quoteCatalog.commercialAuthority = {
      provider: "price_catalog",
      mode: "active",
      syncedAt,
      overlaidRuleCount,
      missingCodes: [...new Set(catalogMissingCodes.filter(Boolean))],
    };
  }

  return {
    quoteCatalogs,
    status: {
      provider: "price_catalog",
      mode: "active",
      refreshedAt: syncedAt,
      overlaidRuleCount,
      missingCodes: [...new Set(missingCodes.filter(Boolean))],
    },
  };
}

function roundRate(value) {
  // Rates keep sub-cent precision (a per-min rate times 60), as the
  // catalogue's own roll-up does; money is rounded where lines are totalled.
  return Math.round(value * 1e6) / 1e6;
}

/**
 * How many of the item's units one of the rule's quantity units is, or a
 * mismatch to report. A disposal item (pricing_basis) is billed in its
 * basis unit by the disposal recipe, which applies the basis itself, so its
 * rule must measure in the item's own unit; converting its price here as
 * well would apply the density twice.
 */
export function resolveRuleUnitConversion(state, item, ruleUnit, itemUnit = normalizeCatalogUnit(displayUnit(item), item.unitCode)) {
  if (ruleUnit === itemUnit) return { factor: 1, mismatch: null };
  const raw = conversionFactor(state, ruleUnit, item.unitCode, { itemUid: item.uid });
  const factor = raw == null ? null : Number(raw);
  if (factor != null && Number.isFinite(factor) && factor > 0 && (factor === 1 || !item.pricingBasis)) {
    return { factor, mismatch: null };
  }
  const reason = factor != null && item.pricingBasis
    ? `it is a disposal item billed per ${itemUnit} (${item.pricingBasis}), so the rule must measure in ${itemUnit}`
    : "the catalogue has no conversion between them";
  return {
    factor: null,
    mismatch: {
      quantityUnit: ruleUnit,
      itemUnit,
      itemCode: item.code,
      itemName: item.name,
      reason,
      message: `${item.name} (${item.code}) is sold per ${itemUnit}, but this rule measures its quantity in ${ruleUnit} and ${reason}.`,
    },
  };
}

// Every unit a quantity for this rule may arrive in, with the factor that
// turns it into the rule's unit (item conversions included), so a candidate
// stated in a convertible unit is converted rather than dropped.
function ruleUnitConversions(state, item, ruleUnit) {
  const conversions = { [ruleUnit]: 1 };
  for (const code of state.units.keys()) {
    if (code === ruleUnit) continue;
    const factor = conversionFactor(state, code, ruleUnit, { itemUid: item.uid });
    if (factor != null && Number.isFinite(Number(factor)) && Number(factor) > 0) conversions[code] = Number(factor);
  }
  return conversions;
}

function pricingBasisFactorOf(state, item) {
  const factor = pricingBasisFactor(state, item);
  return factor != null ? Number(factor) : null;
}

/**
 * One immutable authority result for a command: price maps, projected
 * landscape rates, the quote-catalog overlay, and the revision and digest the
 * quote attests to, all from the same catalogue snapshot.
 */
export function buildPriceCatalogAuthoritySnapshot(state, { quoteCatalogs = null } = {}) {
  requireState(state);
  const fetchedAt = new Date().toISOString();
  const maps = fetchPriceMapsFromCatalog(state, { fetchedAt });
  const { items, children } = revisionRows(state);
  const projected = quoteCatalogs
    ? overlayQuoteCatalogsFromPriceCatalog(quoteCatalogs, state, { syncedAt: fetchedAt })
    : null;
  const catalogRevision = digest({ items, children });
  const snapshotDigest = digest({
    catalogRevision,
    buyMap: maps.buyMap,
    sellMap: maps.sellMap,
    quoteCatalogs: withoutItemUids(stripVolatileAuthorityFields(projected?.quoteCatalogs || null)),
  });

  return {
    buyMap: maps.buyMap,
    sellMap: maps.sellMap,
    fetchedAt: maps._fetchedAt,
    source: "price_catalog",
    provider: "price_catalog",
    catalogRevision,
    catalogVersion: state.version,
    catalogEtag: state.etag,
    snapshotDigest,
    quoteCatalogs: projected?.quoteCatalogs || null,
    status: projected?.status || {
      provider: "price_catalog",
      mode: items.length ? "active" : "empty",
      refreshedAt: maps._fetchedAt,
      catalogRevision,
      snapshotDigest,
    },
    items,
    children,
  };
}
