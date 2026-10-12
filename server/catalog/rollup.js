// The catalogue's one kit roll-up: there is exactly one roll-up function.
// Every price Field reads goes through effectivePrices(): the quote pricing
// snapshot and price maps, the rate card, item detail, health, the current
// price exposed to quote lines and the kit snapshot.
//
// Rules:
// - An item's components are its kit_components rows (in insertion order).
//   An item with none falls back to a quote-catalog recipe for its code, if
//   one exists (server/price-catalog/catalog-recipes.js).
// - cost_mode/sell_mode `rollup` with components: the sum of each included
//   component's own effective price times its quantity. `listed_only`
//   components are shown but not summed.
// - A component that is missing, archived, unpriced, or whose quantity cannot
//   be resolved makes the kit unpriced (null), never zero.
// - `manual`/`fixed`: the item's current price row. `markup`: effective cost
//   times (1 + markup_pct / 100). A `rollup` item with no components falls
//   back to its own price row (health reports it as computed-without-children).
import { createHash } from "node:crypto";
import { resolveDisposalQuantityPerVolume } from "../../shared/disposal-basis.js";
import { loadRecipeChildrenByParent, recipeUidKey } from "../price-catalog/catalog-recipes.js";
import { normalizeCode } from "./state.js";
import { pricingBasisFactor } from "./units.js";

function findByCode(state, code) {
  const uid = state.byCode.get(normalizeCode(code));
  return uid ? state.items.get(uid) : null;
}

/**
 * A recipe child's quantity per unit of its parent. A disposal child's
 * quantity comes from the disposal item's own costing basis; null when that
 * cannot be resolved (callers fail closed).
 */
export function resolveRecipeChildQuantity(state, child) {
  if (child.quantity != null) return child.quantity;
  if (child.quantityBasis === "disposal_per_volume") {
    const item = findByCode(state, child.childCode);
    if (!item) return null;
    return resolveDisposalQuantityPerVolume(item.pricingBasis, pricingBasisFactor(state, item));
  }
  return null;
}

/** The components an item rolls up from: its own rows, else its recipe. */
export function componentsOf(state, item, recipeChildrenByParent = loadRecipeChildrenByParent()) {
  const rows = state.components.get(item.uid);
  if (rows && rows.length) {
    return rows.map((row) => ({
      source: "db",
      componentId: row.id,
      childUid: row.childUid,
      childCode: state.items.get(row.childUid)?.code || null,
      quantity: row.quantity,
      entryQuantity: row.entryQuantity,
      entryUnit: row.entryUnit,
      applicationMode: row.applicationMode,
      pricingContribution: row.pricingContribution === "listed_only" ? "listed_only" : "included",
      sortOrder: row.sortOrder,
      balance: false,
    }));
  }
  // A recipe names its kit and components by uid where it can, the legacy
  // code otherwise (code retirement step 4).
  const recipe = recipeChildrenByParent?.get(recipeUidKey(item.uid)) || recipeChildrenByParent?.get(normalizeCode(item.code));
  if (!recipe || !recipe.length) return [];
  return recipe.map((child, index) => {
    const childItem = (child.childUid && state.items.get(child.childUid)) || findByCode(state, child.childCode);
    return {
      source: child.source || "recipe",
      componentId: null,
      childUid: childItem?.uid || null,
      childCode: childItem?.code || child.childCode,
      quantity: resolveRecipeChildQuantity(state, child),
      entryQuantity: null,
      entryUnit: null,
      applicationMode: "proportional",
      pricingContribution: "included",
      sortOrder: index,
      balance: Boolean(child.balance),
      recipeCode: child.recipeCode || null,
      recipeChild: child,
    };
  });
}

function computeAll(state, recipeChildrenByParent) {
  const results = new Map();
  const visiting = new Set();

  const resolve = (uid) => {
    if (results.has(uid)) return results.get(uid);
    const item = state.items.get(uid);
    if (!item) return { cost: null, sell: null };
    if (visiting.has(uid)) return { cost: null, sell: null, cycle: true };
    visiting.add(uid);

    const price = state.prices.get(uid) || null;
    const components = componentsOf(state, item, recipeChildrenByParent);
    let rolledCost = null;
    let rolledSell = null;
    const problems = [];
    if (components.length) {
      let costSum = 0;
      let sellSum = 0;
      let costValid = true;
      let sellValid = true;
      for (const component of components) {
        if (component.balance || component.pricingContribution === "listed_only") continue;
        if (component.quantity == null) {
          costValid = false;
          sellValid = false;
          problems.push({ kind: "unresolved_quantity", childCode: component.childCode });
          continue;
        }
        const child = component.childUid ? state.items.get(component.childUid) : null;
        if (!child || child.status !== "active") {
          costValid = false;
          sellValid = false;
          problems.push({ kind: child ? "inactive_child" : "missing_child", childCode: component.childCode, status: child?.status || "missing" });
          continue;
        }
        const childPrice = resolve(child.uid);
        if (childPrice.cost != null) costSum += childPrice.cost * component.quantity;
        else { costValid = false; problems.push({ kind: "unpriced_child", side: "cost", childCode: child.code }); }
        if (childPrice.sell != null) sellSum += childPrice.sell * component.quantity;
        else { sellValid = false; problems.push({ kind: "unpriced_child", side: "sell", childCode: child.code }); }
      }
      for (const component of components) {
        if (!component.balance) continue;
        if (price?.cost != null && costValid) costSum += Math.max(0, price.cost - costSum) * component.quantity;
        else costValid = false;
        if (price?.sell != null && sellValid) sellSum += Math.max(0, price.sell - sellSum) * component.quantity;
        else sellValid = false;
      }
      rolledCost = costValid ? costSum : null;
      rolledSell = sellValid ? sellSum : null;
    }

    const hasComponents = components.length > 0;
    const costFromRollup = item.costMode === "rollup" && hasComponents;
    const cost = costFromRollup ? rolledCost : (price?.cost ?? null);
    let sell;
    let sellSource;
    if (item.sellMode === "rollup" && hasComponents) {
      sell = rolledSell;
      sellSource = "rollup";
    } else if (item.sellMode === "markup") {
      sell = cost != null && price?.markupPct != null ? cost * (1 + price.markupPct / 100) : null;
      sellSource = "markup";
    } else {
      sell = price?.sell ?? null;
      sellSource = "price";
    }
    const result = Object.freeze({
      cost,
      sell,
      costSource: costFromRollup ? "rollup" : "price",
      sellSource,
      rolledCost,
      rolledSell,
      hasComponents,
      priceId: price?.id ?? null,
      problems: Object.freeze(problems),
    });
    visiting.delete(uid);
    results.set(uid, result);
    return result;
  };

  for (const uid of state.items.keys()) resolve(uid);
  return results;
}

/** Effective cost and sell of every item, keyed by uid. Cached per state. */
export function effectivePrices(state, { recipeChildrenByParent = loadRecipeChildrenByParent() } = {}) {
  const key = recipeChildrenByParent || EMPTY_RECIPES;
  let entry = state.cache.get(key);
  if (!entry) {
    entry = { prices: computeAll(state, recipeChildrenByParent || EMPTY_RECIPES) };
    state.cache.set(key, entry);
  }
  return entry.prices;
}
const EMPTY_RECIPES = new Map();

export function effectivePrice(state, uid, options) {
  return effectivePrices(state, options).get(uid) || { cost: null, sell: null, problems: [] };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

/**
 * A short key that changes whenever anything behind an item's current price
 * changes: its own price row, its modes, and (for a kit) every component's
 * quantity, contribution and key. Leaf items' key moves with their priceId.
 */
export function priceKey(state, uid, options = {}, seen = new Set()) {
  const item = state.items.get(uid);
  if (!item) return null;
  if (seen.has(uid)) return "cycle";
  seen.add(uid);
  const components = componentsOf(state, item, options.recipeChildrenByParent ?? loadRecipeChildrenByParent());
  const payload = {
    uid,
    status: item.status,
    priceId: state.prices.get(uid)?.id ?? null,
    costMode: item.costMode,
    sellMode: item.sellMode,
    components: components.map((component) => ({
      child: component.childUid || component.childCode,
      quantity: component.quantity,
      contribution: component.pricingContribution,
      balance: component.balance,
      key: component.childUid ? priceKey(state, component.childUid, options, new Set(seen)) : null,
    })),
  };
  return `pk_${createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex").slice(0, 24)}`;
}

function displayUnit(item) {
  return item.unitLabel || item.unitCode;
}

/**
 * The current price of one item, for quote lines: what it costs and sells
 * for now, which price row that came from (priceId; null for a kit priced by
 * roll-up), and priceKey, which also moves when a kit's contents change.
 */
export function currentPrice(state, uid, options = {}) {
  const item = state.items.get(uid);
  if (!item) return null;
  const effective = effectivePrice(state, uid, options);
  const row = state.prices.get(uid) || null;
  const rolledUp = effective.costSource === "rollup" || effective.sellSource === "rollup";
  return {
    itemUid: item.uid,
    code: item.code,
    name: item.name,
    unit: displayUnit(item),
    unitCode: item.unitCode,
    status: item.status,
    costMode: item.costMode,
    sellMode: item.sellMode,
    cost: effective.cost,
    sell: effective.sell,
    markupPct: row?.markupPct ?? null,
    priceId: rolledUp ? null : (row?.id ?? null),
    priceRowId: row?.id ?? null,
    effectiveFrom: row?.effectiveFrom ?? null,
    priceKey: priceKey(state, uid, options),
    rolledUp,
    priced: effective.cost != null && effective.sell != null,
    problems: effective.problems,
    catalogVersion: state.version,
    etag: state.etag,
  };
}

/**
 * The resolved tree under a kit, as a quote line freezes it: each component
 * with its quantity per unit of the parent, its own current price and key,
 * and its own components.
 */
export function kitSnapshot(state, uid, options = {}, seen = new Set()) {
  const item = state.items.get(uid);
  if (!item) return null;
  const price = currentPrice(state, uid, options);
  if (seen.has(uid)) return { ...price, cycle: true, components: [] };
  seen.add(uid);
  const components = componentsOf(state, item, options.recipeChildrenByParent ?? loadRecipeChildrenByParent())
    .map((component) => ({
      componentId: component.componentId,
      source: component.source,
      quantity: component.quantity,
      entryQuantity: component.entryQuantity,
      entryUnit: component.entryUnit,
      applicationMode: component.applicationMode,
      pricingContribution: component.pricingContribution,
      balance: component.balance,
      recipeCode: component.recipeCode || null,
      item: component.childUid
        ? kitSnapshot(state, component.childUid, options, new Set(seen))
        : { itemUid: null, code: component.childCode, missing: !component.balance, synthetic: component.balance },
    }));
  return { ...price, components };
}
