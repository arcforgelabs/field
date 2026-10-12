import { readdirSync, readFileSync } from "../storage/fs.js";
import { join } from "node:path";
import JSON5 from "json5";

const QUOTE_CATALOG_ROOT = join(import.meta.dirname, "../../quote-catalogs");

let cachedRecipeChildren = null;
let cachedDisposalItemCodesByCatalog = null; // Map<catalogId, Set<code>>

/**
 * Recipe-derived component children for catalog price buildup.
 *
 * Returns a Map keyed by target catalog item code -> array of
 * { childCode, quantity, source: 'recipe', recipeCode }.
 *
 * Only recipes whose per-unit buildup is static enough to represent one
 * catalog unit participate. Job-context modes such as haulage trips still
 * stay out because their quantities depend on destination, distance, or
 * other job inputs.
 */
export function loadRecipeChildrenByParent() {
  if (cachedRecipeChildren) return cachedRecipeChildren;
  const disposalItemCodesByCatalog = new Map();
  cachedRecipeChildren = buildRecipeChildrenFromCatalogRoot(QUOTE_CATALOG_ROOT, disposalItemCodesByCatalog);
  if (!cachedDisposalItemCodesByCatalog) cachedDisposalItemCodesByCatalog = disposalItemCodesByCatalog;
  return cachedRecipeChildren;
}

/**
 * DB item codes referenced by a quote-catalog's own quantityRule
 * disposalRuleCode fields (currently only the bulk_loading_disposal mode
 * uses it), resolved through that catalog's own rule-code -> DB-code
 * aliasing. Used by server/catalog/health.js to flag a disposal item that has no
 * pricing_basis at all — the recipe and quote engines already fail closed
 * for it, but nothing else surfaces why (DEL-46).
 *
 * Scoped to a single catalogId (e.g. "embark-default" or
 * "field-verification") — quote-catalogs/ can hold multiple catalogs, and a
 * production installation only ever serves one of them. Aggregating across
 * all of them (the pre-round-4 behaviour) made every installation's health
 * report permanently show critical issues for another installation's
 * fictional/production codes. Pass no catalogId to get the union across
 * every catalog (only for callers that genuinely want that, e.g. tests).
 *
 * Deliberately independent of loadRecipeChildrenByParent()'s cache: a test
 * that overrides recipe children via setRecipeChildrenByParentForTests()
 * must not also silently redirect this to fake data, and this must not
 * clobber that override either.
 */
export function listKnownDisposalItemCodes(catalogId) {
  if (!cachedDisposalItemCodesByCatalog) {
    const disposalItemCodesByCatalog = new Map();
    const recipeChildren = buildRecipeChildrenFromCatalogRoot(QUOTE_CATALOG_ROOT, disposalItemCodesByCatalog);
    if (!cachedRecipeChildren) cachedRecipeChildren = recipeChildren;
    cachedDisposalItemCodesByCatalog = disposalItemCodesByCatalog;
  }
  if (!catalogId) {
    const union = new Set();
    for (const codes of cachedDisposalItemCodesByCatalog.values()) {
      for (const code of codes) union.add(code);
    }
    return union;
  }
  return cachedDisposalItemCodesByCatalog.get(catalogId) || new Set();
}

export function setRecipeChildrenByParentForTests(map) {
  cachedRecipeChildren = map instanceof Map ? map : null;
}

export function setKnownDisposalItemCodesForTests(codes, catalogId) {
  if (!(codes instanceof Set)) {
    cachedDisposalItemCodesByCatalog = null;
    return;
  }
  cachedDisposalItemCodesByCatalog = new Map([[catalogId ?? DEFAULT_TEST_CATALOG_ID, codes]]);
}

export function resetRecipeChildrenCache() {
  cachedRecipeChildren = null;
  cachedDisposalItemCodesByCatalog = null;
}

const DEFAULT_TEST_CATALOG_ID = "embark-default";

export function buildRecipeChildrenFromCatalogRoot(root, disposalItemCodesByCatalog = new Map()) {
  const map = new Map();
  let entries;
  try {
    entries = readdirSync(root).filter((file) => file.endsWith(".json5"));
  } catch (err) {
    console.error(`[catalog-recipes] Unable to read ${root}: ${err.message}`);
    return map;
  }

  for (const file of entries) {
    let raw;
    try {
      raw = JSON5.parse(readFileSync(join(root, file), "utf8"));
    } catch (err) {
      console.error(`[catalog-recipes] Failed to parse ${file}: ${err.message}`);
      continue;
    }
    const catalogId = String(raw.id || "").trim() || file.replace(/\.json5$/, "");
    if (!disposalItemCodesByCatalog.has(catalogId)) disposalItemCodesByCatalog.set(catalogId, new Set());
    const disposalItemCodes = disposalItemCodesByCatalog.get(catalogId);
    // Build a rule-code -> DB code map for this catalog. Rules reference each
    // other by symbolic `code`, while catalog items may live under a distinct
    // authority item code in the price-catalog DB.
    const ruleCodeToDbCode = new Map();
    const ruleByCode = new Map();
    const dbCodeToUid = new Map();
    for (const rule of raw.rules || []) {
      const ruleCode = String(rule.code || "").trim();
      if (!ruleCode) continue;
      const dbCode = String(rule.authorityItemCode || ruleCode).trim();
      ruleCodeToDbCode.set(normalizeCode(ruleCode), dbCode);
      ruleByCode.set(normalizeCode(ruleCode), rule);
      const uid = typeof rule.authorityItemUid === "string" ? rule.authorityItemUid.trim() : "";
      if (uid) dbCodeToUid.set(normalizeCode(dbCode), uid);
    }

    const resolveDbCode = (ruleCode) => {
      if (!ruleCode) return null;
      return ruleCodeToDbCode.get(normalizeCode(ruleCode)) || String(ruleCode);
    };

    for (const rule of raw.quantityRules || []) {
      if (rule.disposalRuleCode) {
        disposalItemCodes.add(resolveDbCode(rule.disposalRuleCode));
      }
      for (const targetRuleCode of rule.appliesToRuleCodes || []) {
        const targetDbCode = resolveDbCode(targetRuleCode);
        const children = extractRecipeChildren(rule, resolveDbCode, {
          targetRuleCode,
          targetDbCode,
          targetRule: ruleByCode.get(normalizeCode(targetRuleCode)) || null,
          resolveRule: (code) => ruleByCode.get(normalizeCode(code)) || null,
        });
        if (!children || children.length === 0) continue;
        // First recipe wins if multiple catalogs target the same item.
        // Map keys are normalized (lowercased) so the catalogue roll-up
        // can look them up regardless of DB case.
        const key = normalizeCode(targetDbCode);
        if (!map.has(key)) map.set(key, children);
        // Also keyed by the target item's uid when the rule declares it
        // (#178 step 4): the roll-up looks a kit's recipe up by uid first.
        const uid = dbCodeToUid.get(key);
        if (uid && !map.has(recipeUidKey(uid))) map.set(recipeUidKey(uid), children);
      }
    }
  }
  return map;
}

/** The recipe map key for a kit item's uid (codes are keyed lowercased, as they are). */
export function recipeUidKey(uid) {
  return `uid:${uid}`;
}

function normalizeCode(code) {
  return String(code || "").trim().toLowerCase();
}

export { normalizeCode };

function extractRecipeChildren(rule, resolveDbCode, context = {}) {
  if (rule?.stage !== "line_item") return null;
  switch (rule.mode) {
    case "per_unit_components":
      return perUnitComponentChildren(rule, resolveDbCode, context);
    case "volume_excavation":
      return volumeExcavationChildren(rule, resolveDbCode);
    case "bulk_loading_disposal":
      return bulkLoadingDisposalChildren(rule, resolveDbCode);
    case "concrete_surface_demolition":
    case "concrete_structure_demolition":
      return concreteDemolitionChildren(rule, resolveDbCode);
    case "supply_install_bundle":
      return supplyInstallBundleChildren(rule, resolveDbCode, context);
    default:
      return null;
  }
}

function perUnitComponentChildren(rule, resolveDbCode, context) {
  const components = Array.isArray(rule.components) ? rule.components : [];
  const out = components
    .map((component) => {
      const quantity = positiveNumber(component.quantity);
      if (quantity == null) return null;
      const childCode = component.itemCode
        ? String(component.itemCode).trim()
        : resolveDbCode(component.ruleCode || component.code);
      const childUid = typeof component.itemUid === "string" ? component.itemUid.trim() : "";
      return recipeChild(rule, childCode, quantity, childUid ? { childUid } : {});
    })
    .filter(Boolean);
  const balance = balanceRecipeChild(rule, context);
  if (balance) out.push(balance);
  return out;
}

function volumeExcavationChildren(rule, resolveDbCode) {
  const out = [];
  const cutHoursPerUnit = positiveRatio(rule.cutRatio, rule.cutVolumePerHour);
  if (cutHoursPerUnit != null && rule.cutRuleCode) {
    out.push(recipeChild(rule, resolveDbCode(rule.cutRuleCode), cutHoursPerUnit));
  }
  const fillHoursPerUnit = positiveRatio(rule.fillRatio, rule.fillVolumePerHour);
  if (fillHoursPerUnit != null && rule.fillRuleCode) {
    out.push(recipeChild(rule, resolveDbCode(rule.fillRuleCode), fillHoursPerUnit));
  }
  return out;
}

function bulkLoadingDisposalChildren(rule, resolveDbCode) {
  const out = [];
  // Loader-hours-per-m3 is a property of the truck's own capacity — a
  // logistics fact declared directly in json5 as truckVolumeCapacityM3.
  // (Round 4: a mass-to-volume fallback used to live here, converting
  // truckMassCapacityTonnes via a json5 densityTonnesPerM3 field. No
  // quantityRule ever needed it — every one declares truckVolumeCapacityM3
  // directly — and leaving it editable made json5 look like a second owner
  // of a density this episode moved to the catalogue item. Removed along
  // with the json5 keys; if a quantityRule ever needs mass-only capacity
  // again, it must resolve density from the disposal item's own
  // pricing_basis_factor via a DB handle, the same as
  // resolveDisposalDensityTonnesPerM3 in server/quote-quantity-rules.js.)
  const loadingHoursPerLoad = positiveNumber(rule.loadingHoursPerLoad);
  const truckVolumeCapacityM3 = positiveNumber(rule.truckVolumeCapacityM3);

  if (rule.loaderRuleCode && loadingHoursPerLoad != null && truckVolumeCapacityM3 != null) {
    out.push(recipeChild(
      rule,
      resolveDbCode(rule.loaderRuleCode),
      roundQuantity(loadingHoursPerLoad / truckVolumeCapacityM3),
    ));
  }
  // The disposal child's quantity is NOT pre-multiplied by a json5 density.
  // It is the disposal item's own costing basis (per_tonne needs a density,
  // per_load needs an inverse load capacity, per_m3 is the identity), and
  // that basis lives solely on the catalogue item now — not here. This
  // module has no DB handle (see loadRecipeChildrenByParent()), so the
  // quantity is deferred and resolved lazily by resolveRecipeChildQuantity()
  // once a caller has a catalogue snapshot (server/catalog/rollup.js
  // resolveRecipeChildQuantity, DEL-46).
  if (rule.disposalRuleCode) {
    out.push(recipeChild(rule, resolveDbCode(rule.disposalRuleCode), null, {
      quantityBasis: "disposal_per_volume",
    }));
  }
  return out;
}

function concreteDemolitionChildren(rule, resolveDbCode) {
  const areaPerHour = positiveNumber(rule.areaPerHour);
  if (areaPerHour == null) return [];
  // The machine rules are named by the quantity rule (no default codes).
  const componentRuleCodes = Array.isArray(rule.componentRuleCodes) ? rule.componentRuleCodes : [];
  const hoursPerUnit = roundQuantity(1 / areaPerHour);
  return componentRuleCodes
    .map((componentRuleCode) => recipeChild(rule, resolveDbCode(componentRuleCode), hoursPerUnit))
    .filter(Boolean);
}

function supplyInstallBundleChildren(rule, resolveDbCode, context) {
  const out = [];
  const execution = context.targetRule?.execution || {};
  const labourHoursPerUnit = positiveNumber(execution.labourHoursPerUnit);
  if (labourHoursPerUnit != null && rule.labourRuleCode) {
    out.push(recipeChild(rule, resolveDbCode(rule.labourRuleCode), labourHoursPerUnit));
  }
  const machineHoursPerUnit = positiveNumber(execution.machineHoursPerUnit);
  if (machineHoursPerUnit != null && rule.machineRuleCode) {
    out.push(recipeChild(rule, resolveDbCode(rule.machineRuleCode), machineHoursPerUnit));
  }
  const balance = balanceRecipeChild(rule, context, {
    code: `${context.targetDbCode || context.targetRuleCode}__stock-materials`,
    name: `${context.targetRule?.label || context.targetRuleCode || "Catalog item"} materials allowance`,
  });
  if (balance) out.unshift(balance);
  return out;
}

function balanceRecipeChild(rule, context, defaults = {}) {
  const configured = rule.balanceComponent;
  if (!configured && !defaults.code) return null;
  if (configured === false) return null;
  const config = configured && typeof configured === "object" ? configured : {};
  const targetDbCode = context.targetDbCode || context.targetRuleCode || "item";
  const childCode = String(config.itemCode || config.code || defaults.code || `${targetDbCode}__recipe-balance`).trim();
  const name = String(
    config.name
      || config.label
      || defaults.name
      || `${context.targetRule?.label || targetDbCode} recipe balance`
  ).trim();
  return recipeChild(rule, childCode, positiveNumber(config.quantity) || 1, {
    synthetic: true,
    balance: true,
    name,
    unit: config.unit || defaults.unit || context.targetRule?.unit || "unit",
  });
}

function recipeChild(rule, childCode, quantity, extra = {}) {
  const normalizedChildCode = String(childCode || "").trim();
  if (!normalizedChildCode) return null;
  if (extra.quantityBasis) {
    // Deferred: this child's quantity depends on catalogue item state (a
    // disposal item's pricing_basis / pricing_basis_factor) that isn't
    // available while parsing json5 at module load. See
    // resolveRecipeChildQuantity() below.
    return {
      childCode: normalizedChildCode,
      quantity: null,
      source: "recipe",
      recipeCode: rule.code || null,
      ...extra,
    };
  }
  const normalizedQuantity = positiveNumber(quantity);
  if (normalizedQuantity == null) return null;
  return {
    childCode: normalizedChildCode,
    quantity: roundQuantity(normalizedQuantity),
    source: "recipe",
    recipeCode: rule.code || null,
    ...extra,
  };
}

function positiveRatio(ratio, perHour) {
  const r = Number(ratio);
  const h = Number(perHour);
  if (!Number.isFinite(r) || r <= 0) return null;
  if (!Number.isFinite(h) || h <= 0) return null;
  return roundQuantity(r / h);
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function roundQuantity(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}
