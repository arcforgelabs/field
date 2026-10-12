// Read-only shapes the catalogue API, MCP tools and pricing code return.
// They keep the field names the SQLite catalogue's rows had (buy_price,
// sell_price, *_price_mode, catalog_type, pricing_basis_factor, ...) so the
// HTTP and MCP contracts are unchanged, and add the Postgres-native fields
// (uid identity, version, price_id, sell_mode, markup_pct, variant_of_uid,
// tags, tax_code, kind, description).
import { nameKey } from "../../shared/catalog-name-key.js";
import { filterCatalogItems } from "../../shared/catalog-search.js";
import { loadRecipeChildrenByParent } from "../price-catalog/catalog-recipes.js";
import { componentsOf, effectivePrice, effectivePrices, priceKey } from "./rollup.js";
import { pricingMethodOf } from "./price.js";
import { compareNoCase, normalizeCode } from "./state.js";
import { pricingBasisFactor } from "./units.js";

export function catalogTypeOf(item) {
  return item.visibility === "sellable" ? "goods_service" : "component";
}

export function visibilityOfCatalogType(value) {
  const normalized = String(value || "component").trim().toLowerCase();
  return ["goods_service", "product", "service"].includes(normalized) ? "sellable" : "internal";
}

export function displayUnit(item) {
  return item.unitLabel || item.unitCode;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/** One item as the API returns it. Prices are the item's effective prices. */
export function itemRow(state, item, { effective = null } = {}) {
  const price = state.prices.get(item.uid) || null;
  const resolved = effective || effectivePrice(state, item.uid);
  return {
    uid: item.uid,
    code: item.code,
    name: item.name,
    name_key: nameKey(item.name),
    unit: displayUnit(item),
    unit_code: item.unitCode,
    buy_price: resolved.cost,
    sell_price: resolved.sell,
    buy_price_mode: item.costMode === "rollup" ? "computed" : "manual",
    sell_price_mode: item.sellMode === "rollup" ? "computed" : "manual",
    cost_mode: item.costMode,
    sell_mode: item.sellMode,
    markup_pct: price?.markupPct ?? null,
    price_reference: item.priceReference,
    description: item.description,
    // Internal only; never printed (description is what quotes may show).
    notes: item.notes,
    catalog_type: catalogTypeOf(item),
    visibility: item.visibility,
    // docs/PRICING_ENGINE.md names (#178 phase 1): what the item is, whether
    // the quote picker offers it, and how its sell is set. catalog_type,
    // visibility and the *_mode fields stay for older clients.
    type: item.type,
    is_sold: item.visibility === "sellable",
    pricing_method: pricingMethodOf(item, resolved),
    kind: item.kind,
    category: item.category,
    tags: [...item.tags],
    tax_code: item.taxCode,
    status: item.status,
    pricing_basis: item.pricingBasis,
    pricing_basis_factor: pricingBasisFactor(state, item),
    variant_of_uid: item.variantOfUid,
    version: item.version,
    price_id: price?.id ?? null,
    price_effective_from: price?.effectiveFrom ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

/**
 * Every non-active item reachable below each root through kit components,
 * as { parentUid, parentCode, parentName, childUid, childCode, childName,
 * childStatus } rows ordered by parent then child name.
 */
export function inactiveComponentDependencies(state, rootUids = null) {
  const roots = rootUids ? [...new Set(rootUids)] : [...state.components.keys()];
  const rows = [];
  for (const rootUid of roots) {
    const root = state.items.get(rootUid);
    if (!root) continue;
    const seen = new Set([rootUid]);
    const found = new Map();
    const stack = [...(state.components.get(rootUid) || [])].map((c) => c.childUid);
    while (stack.length) {
      const uid = stack.pop();
      if (seen.has(uid)) continue;
      seen.add(uid);
      const child = state.items.get(uid);
      if (!child) continue;
      if (child.status !== "active") found.set(uid, child);
      for (const component of state.components.get(uid) || []) stack.push(component.childUid);
    }
    for (const child of found.values()) {
      rows.push({
        parentUid: root.uid,
        parentCode: root.code,
        parentName: root.name,
        childUid: child.uid,
        childCode: child.code,
        childName: child.name,
        childStatus: child.status,
      });
    }
  }
  return rows.sort((a, b) => (
    String(a.parentName).localeCompare(String(b.parentName)) || String(a.childName).localeCompare(String(b.childName))
  ));
}

export function inactiveComponentsByParent(state, rootUids = null) {
  const summary = new Map();
  for (const row of inactiveComponentDependencies(state, rootUids)) {
    if (!summary.has(row.parentUid)) summary.set(row.parentUid, []);
    summary.get(row.parentUid).push({ code: row.childCode, name: row.childName, status: row.childStatus, uid: row.childUid });
  }
  return summary;
}

function withInactiveHealth(state, rows) {
  const summary = inactiveComponentsByParent(state, rows.map((row) => row.uid));
  return rows.map((row) => {
    const inactive = summary.get(row.uid) || [];
    return {
      ...row,
      inactive_component_count: inactive.length,
      inactive_components: inactive.map(({ code, name, status }) => ({ code, name, status })),
    };
  });
}

/** The legacy `kind` filter (component = has components) still works. */
export function listItemRows(state, { status, category, kind, search } = {}) {
  const prices = effectivePrices(state);
  let items = [...state.items.values()];
  if (kind === "component") items = items.filter((item) => (state.components.get(item.uid) || []).length > 0);
  else if (kind === "item") items = items.filter((item) => !(state.components.get(item.uid) || []).length);
  const rows = items.map((item) => ({
    ...itemRow(state, item, { effective: prices.get(item.uid) }),
    child_count: (state.components.get(item.uid) || []).length,
  }));
  return withInactiveHealth(state, filterCatalogItems(rows, { status, category, search }));
}

/** A kit component as the API returns it (a child row). */
export function childRow(state, component) {
  const child = state.items.get(component.childUid);
  const effective = effectivePrice(state, component.childUid);
  return {
    code: child?.code ?? null,
    uid: child?.uid ?? component.childUid,
    name: child?.name ?? null,
    quantity: component.quantity,
    entry_quantity: component.entryQuantity,
    entry_unit: component.entryUnit,
    sort_order: component.sortOrder,
    application_mode: component.applicationMode,
    pricing_contribution: component.pricingContribution,
    buy_price: effective.cost,
    sell_price: effective.sell,
    unit: child ? displayUnit(child) : null,
    catalog_type: child ? catalogTypeOf(child) : null,
    status: child?.status ?? "missing",
    price_id: state.prices.get(component.childUid)?.id ?? null,
  };
}

export function listChildRows(state, parentUid) {
  return (state.components.get(parentUid) || [])
    .map((component) => childRow(state, component))
    .sort((a, b) => (a.sort_order - b.sort_order) || String(a.name).localeCompare(String(b.name)));
}

function recipeChildRows(state, item) {
  const components = componentsOf(state, item, loadRecipeChildrenByParent());
  if (!components.length || components[0].source === "db") return [];
  const own = state.prices.get(item.uid) || null;
  const out = [];
  let buySum = 0;
  let sellSum = 0;
  let buyComplete = true;
  let sellComplete = true;
  components.forEach((component, index) => {
    if (component.balance) return;
    const child = component.childUid ? state.items.get(component.childUid) : null;
    const quantity = component.quantity;
    if (!child) {
      out.push({
        code: component.childCode,
        name: component.recipeChild?.name || component.childCode,
        quantity,
        sort_order: index,
        buy_price: component.recipeChild?.buyPrice ?? null,
        sell_price: component.recipeChild?.sellPrice ?? null,
        unit: component.recipeChild?.unit || null,
        status: "missing",
        source: "recipe",
        recipe_code: component.recipeCode,
        missing: true,
      });
      buyComplete = false;
      sellComplete = false;
      return;
    }
    const effective = effectivePrice(state, child.uid);
    if (quantity == null) {
      buyComplete = false;
      sellComplete = false;
    } else {
      if (effective.cost != null) buySum += effective.cost * quantity;
      else buyComplete = false;
      if (effective.sell != null) sellSum += effective.sell * quantity;
      else sellComplete = false;
    }
    out.push({
      code: child.code,
      uid: child.uid,
      name: child.name,
      quantity,
      sort_order: index,
      buy_price: effective.cost,
      sell_price: effective.sell,
      effective_buy_price: effective.cost,
      effective_sell_price: effective.sell,
      unit: displayUnit(child),
      catalog_type: catalogTypeOf(child),
      status: child.status,
      source: "recipe",
      recipe_code: component.recipeCode,
    });
  });
  components.forEach((component, index) => {
    if (!component.balance) return;
    out.push({
      code: component.childCode,
      name: component.recipeChild?.name || component.childCode,
      quantity: component.recipeChild?.quantity || 1,
      sort_order: index,
      buy_price: own?.cost != null && buyComplete ? roundMoney(Math.max(0, own.cost - buySum)) : null,
      sell_price: own?.sell != null && sellComplete ? roundMoney(Math.max(0, own.sell - sellSum)) : null,
      unit: component.recipeChild?.unit || displayUnit(item),
      catalog_type: "component",
      status: "synthetic",
      source: "recipe",
      recipe_code: component.recipeCode,
      synthetic: true,
      balance: true,
    });
  });
  return out;
}

/** The kits that list this item as a component, by name. */
export function usedInRows(state, uid) {
  const rows = [];
  for (const parentUid of new Set(state.parentsOf.get(uid) || [])) {
    const parent = state.items.get(parentUid);
    if (!parent) continue;
    const component = (state.components.get(parentUid) || []).find((c) => c.childUid === uid);
    rows.push({
      uid: parent.uid,
      code: parent.code,
      name: parent.name,
      status: parent.status,
      unit: displayUnit(parent),
      quantity: component?.quantity ?? null,
    });
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** One item with its components and effective prices (the item drawer). */
export function itemDetail(state, item) {
  const effective = effectivePrice(state, item.uid);
  const row = {
    ...itemRow(state, item, { effective }),
    child_count: (state.components.get(item.uid) || []).length,
    effective_buy_price: effective.cost,
    effective_sell_price: effective.sell,
    price_key: priceKey(state, item.uid),
    pricing_problems: effective.problems,
  };
  const dbChildren = listChildRows(state, item.uid).map((child) => {
    const childEffective = effectivePrice(state, child.uid);
    return {
      ...child,
      source: "db",
      effective_buy_price: childEffective.cost,
      effective_sell_price: childEffective.sell,
    };
  });
  row.children = dbChildren.length ? dbChildren : recipeChildRows(state, item);
  row.used_in = usedInRows(state, item.uid);
  return withInactiveHealth(state, [row])[0];
}

/**
 * Buy and sell maps keyed by code over ACTIVE items, from the one roll-up.
 * Items without an effective price are left out (callers treat a missing
 * key as unpriced).
 */
export function priceMaps(state, { fetchedAt = state.now } = {}) {
  const prices = effectivePrices(state);
  const buyMap = {};
  const sellMap = {};
  const active = [...state.items.values()]
    .filter((item) => item.status === "active")
    .sort((a, b) => compareNoCase(a.code, b.code));
  for (const item of active) {
    const effective = prices.get(item.uid);
    if (effective?.cost != null) buyMap[item.code] = effective.cost;
    if (effective?.sell != null) sellMap[item.code] = effective.sell;
  }
  return { buyMap, sellMap, _fetchedAt: fetchedAt, _source: "price_catalog" };
}

/**
 * The rows the catalogue revision digest has always been computed from:
 * active items and every kit link, in the SQLite catalogue's order and
 * shape, so an unchanged catalogue keeps its revision across the move.
 */
export function revisionRows(state) {
  const prices = effectivePrices(state);
  const items = [...state.items.values()]
    .filter((item) => item.status === "active")
    .sort((a, b) => compareNoCase(a.code, b.code))
    .map((item) => {
      const effective = prices.get(item.uid);
      return {
        code: item.code,
        name: item.name,
        unit: displayUnit(item),
        buy_price: effective?.cost ?? null,
        sell_price: effective?.sell ?? null,
        buy_price_mode: item.costMode === "rollup" ? "computed" : "manual",
        sell_price_mode: item.sellMode === "rollup" ? "computed" : "manual",
        category: item.category,
        status: item.status,
        pricing_basis: item.pricingBasis,
        pricing_basis_factor: pricingBasisFactor(state, item),
      };
    });
  const children = [];
  for (const [parentUid, components] of state.components) {
    const parent = state.items.get(parentUid);
    for (const component of components) {
      children.push({
        parent_code: parent?.code ?? null,
        child_code: state.items.get(component.childUid)?.code ?? null,
        quantity: component.quantity,
        pricing_contribution: component.pricingContribution,
      });
    }
  }
  children.sort((a, b) => (
    compareNoCase(a.parent_code, b.parent_code)
    || compareNoCase(a.child_code, b.child_code)
    || (a.quantity - b.quantity)
  ));
  return { items, children };
}

export function findByCode(state, code) {
  const uid = state.byCode.get(normalizeCode(code));
  return uid ? state.items.get(uid) : null;
}

/** "Name (CODE), Name (CODE)" for a list of inactive components. */
export function formatInactiveComponentDependencyList(components) {
  return (components || [])
    .map((component) => {
      const label = component.name || component.code || "unknown item";
      const code = component.code && component.code !== label ? ` (${component.code})` : "";
      return `${label}${code}`;
    })
    .join(", ");
}
