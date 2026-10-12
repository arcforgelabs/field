// Every catalogue item Field's pricing names, and from where: quote rules and
// the quantity rules that reference them, the quote catalog's assemblies
// (recipes), the retaining-wall rate card and the wall engine. Each reference
// is { uid, code, source }: the uid where the configuration declares one
// (#178 code retirement step 4), the legacy code beside it as the fallback.
// The health report checks each one resolves to an active item, by uid.
import { getQuoteCatalogsForAuthoritySnapshot } from "../quote-catalogs.js";
import { resolveQuoteCatalogId } from "../quote-catalog-ids.js";
import { RATE_CARD_REQUIRED_PRICE_CODES, RETAINING_WALL_REQUIRED_PRICE_CODES } from "../retaining-wall-rate-card.js";
import { wallItemUidForCode } from "../retaining-wall-items.js";
import { resolveQuoteCatalogPricingDependencies } from "./catalog-snapshot.js";

function quoteCatalogFor(catalogId) {
  return getQuoteCatalogsForAuthoritySnapshot()[resolveQuoteCatalogId(catalogId)] || null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function catalogPricingReferences(catalogId) {
  const references = [];
  const quoteCatalog = quoteCatalogFor(catalogId);
  // A dependency hint names an item by code; borrow the uid a rule, recipe
  // or the wall declares for the same code.
  const uidByCode = new Map();
  const remember = (code, uid) => { if (code && uid && !uidByCode.has(code.toLowerCase())) uidByCode.set(code.toLowerCase(), uid); };
  if (quoteCatalog) {
    for (const rule of quoteCatalog.rules || []) {
      const code = text(rule.authorityItemCode) || text(rule.code);
      const uid = text(rule.authorityItemUid) || null;
      remember(code, uid);
      if (code || uid) references.push({ uid, code: code || null, source: `quote rule ${rule.code}` });
    }
    for (const assembly of quoteCatalog.assemblies || []) {
      for (const component of assembly.components || []) {
        const uid = text(component.itemUid) || null;
        remember(text(component.itemCode), uid);
        references.push({ uid, code: component.itemCode, source: `recipe ${assembly.code}` });
      }
    }
    for (const rule of quoteCatalog.quantityRules || []) {
      remember(text(rule.outputItemCode), text(rule.outputItemUid) || null);
      for (const component of rule.components || []) remember(text(component.itemCode), text(component.itemUid) || null);
    }
    for (const code of resolveQuoteCatalogPricingDependencies(quoteCatalog, { includeRateCard: false })) {
      references.push({ uid: uidByCode.get(code.toLowerCase()) || wallItemUidForCode(code), code, source: "quote rules" });
    }
  }
  for (const code of RATE_CARD_REQUIRED_PRICE_CODES) references.push({ uid: wallItemUidForCode(code), code, source: "rate card" });
  for (const code of RETAINING_WALL_REQUIRED_PRICE_CODES) references.push({ uid: wallItemUidForCode(code), code, source: "retaining wall engine" });
  return references;
}

/** The quote catalog's assemblies (recipes), for the health report's unit checks. */
export function catalogAssemblies(catalogId) {
  return quoteCatalogFor(catalogId)?.assemblies || [];
}

/**
 * Each quote rule's item and the unit the rule measures its quantity in, for
 * the health report's rule unit check (an item sold per m behind an area
 * rule cannot price it).
 */
export function catalogRuleUnits(catalogId) {
  return (quoteCatalogFor(catalogId)?.rules || [])
    .map((rule) => ({
      code: rule.code,
      itemCode: String(rule.authorityItemCode || rule.code || "").trim(),
      itemUid: text(rule.authorityItemUid) || null,
      quantityUnit: rule.quantityUnit || null,
    }))
    .filter((rule) => (rule.itemCode || rule.itemUid) && rule.quantityUnit);
}
