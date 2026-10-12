import {
  getQuoteCatalogsForAuthoritySnapshot,
} from "../quote-catalogs.js";
import { buildPriceCatalogAuthoritySnapshot } from "./catalog-pricing.js";
import { DEFAULT_QUOTE_CATALOG_ID, resolveQuoteCatalogId } from "../quote-catalog-ids.js";
import { resolveMapRate } from "../local-pricing.js";
import { RATE_CARD_REQUIRED_PRICE_CODES } from "../retaining-wall-rate-card.js";
import { resolveRecipePricing } from "./recipe-pricing.js";

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validMoney(value) {
  return value != null && Number.isFinite(Number(value));
}

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Return the complete monetary dependency closure for a served catalog.
 * Quantity rules may name another quote rule (for example soil-dump-plan
 * creates vehicle-hour and vehicle-km lines), and recipes can name further
 * rules or concrete authority item codes. Follow those references all the
 * way to the commercial authority so no JSON5/default rate can leak into a
 * price-catalog build.
 */
export function resolveQuoteCatalogPricingDependencies(quoteCatalog, {
  includeRateCard = true,
  includeCatalogRules = includeRateCard,
} = {}) {
  const rules = Array.isArray(quoteCatalog?.rules) ? quoteCatalog.rules : [];
  const quantityRules = Array.isArray(quoteCatalog?.quantityRules) ? quoteCatalog.quantityRules : [];
  const assemblies = Array.isArray(quoteCatalog?.assemblies) ? quoteCatalog.assemblies : [];
  const byCode = new Map();
  for (const rule of rules) {
    for (const key of [rule?.code, rule?.authorityItemCode]) {
      const id = normalized(key);
      if (id) byCode.set(id, rule);
    }
  }

  const dependencies = new Set(includeRateCard ? RATE_CARD_REQUIRED_PRICE_CODES : []);
  const visitedRules = new Set();
  const addRule = (ruleOrCode) => {
    const rule = typeof ruleOrCode === "object" ? ruleOrCode : byCode.get(normalized(ruleOrCode));
    if (!rule) {
      const code = String(ruleOrCode || "").trim();
      if (code) dependencies.add(code);
      return;
    }
    const ruleKey = normalized(rule.code || rule.authorityItemCode);
    if (ruleKey && visitedRules.has(ruleKey)) return;
    if (ruleKey) visitedRules.add(ruleKey);
    const authorityCode = String(rule.authorityItemCode || rule.code || "").trim();
    if (authorityCode) dependencies.add(authorityCode);
    for (const code of rule.pricingDependencies || []) addRule(code);
    for (const component of rule.components || []) {
      addRule(component?.itemCode || component?.ruleCode);
    }
  };

  if (includeCatalogRules) {
    for (const rule of rules) addRule(rule);
  }
  const quantityReferenceFields = [
    "appliesToRuleCodes", "sourceRuleCode", "outputRuleCode", "surfaceRuleCode",
    "structureRuleCode", "soilRuleCode", "haulageRuleCode", "loaderRuleCode",
    "disposalRuleCode", "vehicleHourRuleCode", "vehicleKmRuleCode", "cutRuleCode",
    "fillRuleCode", "componentRuleCodes", "pricingDependencies", "outputItemCode",
  ];
  // An assembly's components are catalogue items by code (never rules).
  if (includeCatalogRules) {
    for (const assembly of assemblies) {
      for (const component of assembly.components || []) {
        if (component?.itemCode) dependencies.add(String(component.itemCode).trim());
      }
    }
  }
  if (includeCatalogRules) for (const quantityRule of quantityRules) {
    for (const field of quantityReferenceFields) {
      const values = Array.isArray(quantityRule?.[field])
        ? quantityRule[field]
        : [quantityRule?.[field]];
      for (const value of values) {
        if (value) addRule(value);
      }
    }
  }
  return [...dependencies].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve one immutable view of the commercial catalogue for a command, from
 * one catalogue snapshot (`state`, server/catalog/state.js; a store's
 * getState()). The result carries the exact maps, projected landscape rates,
 * catalog metadata, provenance, and completeness details used by that
 * command.
 */
export function buildPriceCatalogSnapshot(
  state,
  { quoteCatalogId = null, quoteCatalog = null, requiredCodes = [], includeRateCard = false } = {},
) {
  if (!state) throw new Error("price catalog database is unavailable");

  const baseCatalogs = getQuoteCatalogsForAuthoritySnapshot();
  const selectedCatalogId = resolveQuoteCatalogId(quoteCatalogId || DEFAULT_QUOTE_CATALOG_ID);
  if (quoteCatalog) {
    baseCatalogs[quoteCatalog.id] = clone(quoteCatalog);
  }
  const authority = buildPriceCatalogAuthoritySnapshot(state, {
    quoteCatalogs: baseCatalogs,
  });
  const rows = authority.items;
  const buyMap = clone(authority.buyMap) || {};
  const sellMap = clone(authority.sellMap) || {};
  const missingPriceCodes = rows
    .filter((row) => !validMoney(resolveMapRate(buyMap, row.code)) || !validMoney(resolveMapRate(sellMap, row.code)))
    .map((row) => row.code);
  const activeCodes = new Set(rows.map((row) => String(row.code || "").trim().toLowerCase()));
  const missingChildCodes = [...new Set((authority.children || [])
    .filter((child) => child?.pricing_contribution !== "listed_only" && Number(child?.quantity) > 0)
    .filter((child) => activeCodes.has(String(child.parent_code || "").trim().toLowerCase()))
    .filter((child) => (
      !validMoney(resolveMapRate(buyMap, child.child_code))
      || !validMoney(resolveMapRate(sellMap, child.child_code))
    ))
    .map((child) => String(child.child_code || "").trim())
    .filter(Boolean))];
  const resolvedCatalog = clone(authority.quoteCatalogs?.[quoteCatalog?.id || selectedCatalogId] || null);
  // The selected catalog's assemblies (recipes), each component priced from
  // this same snapshot in its own unit.
  const recipePricing = resolveRecipePricing(state, resolvedCatalog);
  const catalogDependencies = resolveQuoteCatalogPricingDependencies(resolvedCatalog, { includeRateCard });
  const missingDependencyCodes = catalogDependencies.filter((code) =>
    !validMoney(resolveMapRate(buyMap, code)) || !validMoney(resolveMapRate(sellMap, code))
  );
  const authorityMissingCodes = includeRateCard && Array.isArray(resolvedCatalog?.commercialAuthority?.missingCodes)
    ? resolvedCatalog.commercialAuthority.missingCodes
    : [];
  const missingAuthorityCodes = [...new Set([
    ...missingPriceCodes,
    ...missingChildCodes,
    ...authorityMissingCodes,
    ...missingDependencyCodes,
  ])];
  const normalizedRequiredCodes = [...new Set([
    ...catalogDependencies,
    ...(requiredCodes || []),
  ]
    .map((code) => String(code || "").trim())
    .filter(Boolean))];
  const missingRequiredCodes = normalizedRequiredCodes.filter((code) =>
    !validMoney(resolveMapRate(buyMap, code)) || !validMoney(resolveMapRate(sellMap, code))
  );
  if (resolvedCatalog?.commercialAuthority) {
    resolvedCatalog.commercialAuthority = {
      ...resolvedCatalog.commercialAuthority,
      catalogRevision: authority.catalogRevision,
      snapshotDigest: authority.snapshotDigest,
    };
  }

  return deepFreeze({
    source: "price_catalog",
    provider: "price_catalog",
    authorityStatus: {
      ...(authority.status || {}),
      catalogRevision: authority.catalogRevision,
      snapshotDigest: authority.snapshotDigest,
    },
    fetchedAt: authority.fetchedAt,
    catalogRevision: authority.catalogRevision,
    snapshotDigest: authority.snapshotDigest,
    provenance: {
      provider: "price_catalog",
      source: "price_catalog",
      fetchedAt: authority.fetchedAt,
      catalogRevision: authority.catalogRevision,
      snapshotDigest: authority.snapshotDigest,
    },
    buyMap,
    sellMap,
    recipePricing,
    quoteCatalog: clone(resolvedCatalog),
    completeness: {
      activeItemCount: rows.length,
      pricedItemCount: rows.length - missingPriceCodes.length,
      missingPriceCodes: missingAuthorityCodes,
      missingChildCodes,
      requiredCodes: normalizedRequiredCodes,
      missingRequiredCodes,
      dependencyCodes: catalogDependencies,
      missingDependencyCodes,
      // A catalogue with active items can price; an item that is missing,
      // archived or unpriced fails closed only for the commands that need it
      // (requiredCodes -> missingRequiredCodes, naming the items), and is
      // listed here and on the health page. One bad item must not block
      // every quote.
      baselineUsable: rows.length > 0,
      allPriced: missingAuthorityCodes.length === 0,
      complete: missingRequiredCodes.length === 0,
    },
  });
}

/**
 * Why a required code cannot price: named for the operator, e.g.
 * `DRAIN-PIT (Stormwater pit) has no sell price` or `TURF-SUPPLY-M2 is not
 * an active item in the price catalogue`.
 */
export function describeMissingPriceCode(snapshot, code) {
  const item = snapshot?.recipePricing?.items?.[normalized(code)] || null;
  if (!item) return `${code} is not an active item in the price catalogue`;
  const sides = [
    validMoney(resolveMapRate(snapshot.buyMap, code)) ? null : "buy",
    validMoney(resolveMapRate(snapshot.sellMap, code)) ? null : "sell",
  ].filter(Boolean);
  return `${item.code} (${item.name}) has no ${sides.join(" or ")} price`;
}

export function assertPriceCatalogSnapshotComplete(snapshot, { requiredCodes = null } = {}) {
  if (!snapshot || snapshot.source !== "price_catalog") {
    throw new Error("price catalog snapshot is unavailable");
  }
  const missing = requiredCodes
    ? [...new Set(requiredCodes.filter((code) =>
      !validMoney(resolveMapRate(snapshot.buyMap, code)) || !validMoney(resolveMapRate(snapshot.sellMap, code))
    ))]
    : snapshot.completeness?.missingRequiredCodes || [];
  if (missing.length) {
    const error = new Error(
      `price catalog is incomplete for required item(s): ${missing.map((code) => describeMissingPriceCode(snapshot, code)).join("; ")}`,
    );
    error.missingCodes = missing;
    throw error;
  }
  return snapshot;
}

export function isPriceCatalogSnapshotUsable(snapshot) {
  return Boolean(snapshot?.source === "price_catalog" && snapshot.completeness?.baselineUsable);
}
