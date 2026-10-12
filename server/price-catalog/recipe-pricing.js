// Price a quote catalog's assemblies (server/catalog/assemblies.js) from one
// catalogue snapshot. This replaces the hardcoded recipe rates and the
// "landscape rates" projection: every component's cost and sell is its
// catalogue item's effective price (the one roll-up), in the unit the
// assembly uses it in, converted only where the catalogue says how
// (server/catalog/units.js). A component whose item is missing, archived,
// unpriced or sold in a unit that cannot convert has no price and carries a
// problem naming the item, so the recipe fails closed instead of guessing.
import { effectivePrices } from "../catalog/rollup.js";
import { refItem } from "../catalog/refs.js";
import { normalizeCode } from "../catalog/state.js";
import { conversionFactor, resolveUnitCode } from "../catalog/units.js";
import { displayUnit } from "../catalog/views.js";


function describeItem(code, item) {
  return item ? `${item.code} (${item.name})` : code;
}

/** Price one assembly component from the catalogue, or say why it cannot be. */
export function priceAssemblyComponent(state, component, { prices = effectivePrices(state), assemblyCode = null } = {}) {
  const item = refItem(state, { uid: component.itemUid, code: component.itemCode });
  const where = assemblyCode ? `the ${assemblyCode} recipe (${component.key})` : `component ${component.key}`;
  const base = {
    key: component.key,
    itemCode: item?.code || component.itemCode,
    label: component.label,
    unit: component.unit,
    item: item
      ? { uid: item.uid, code: item.code, name: item.name, category: item.category || null, unit: displayUnit(item), status: item.status }
      : null,
    priceId: null,
    cost: null,
    sell: null,
    unitFactor: null,
    problem: null,
  };
  if (!item) {
    return { ...base, problem: { kind: "missing_item", message: `${where} uses ${component.itemCode}, which is not in the price catalogue` } };
  }
  if (item.status !== "active") {
    return { ...base, problem: { kind: "inactive_item", status: item.status, message: `${where} uses ${describeItem(component.itemCode, item)}, which is ${item.status}` } };
  }
  if (!resolveUnitCode(state, component.unit)) {
    return { ...base, problem: { kind: "unknown_unit", message: `${where} is in "${component.unit}", which is not a known unit` } };
  }
  const factor = conversionFactor(state, component.unit, item.unitCode, { itemUid: item.uid });
  if (factor == null) {
    return {
      ...base,
      problem: {
        kind: "unit_mismatch",
        componentUnit: component.unit,
        itemUnit: item.unitCode,
        message: `${where} uses ${describeItem(component.itemCode, item)} per ${component.unit}, but it is priced per ${displayUnit(item)} and the catalogue has no conversion between them`,
      },
    };
  }
  const effective = prices.get(item.uid) || { cost: null, sell: null };
  const missingSides = [effective.cost == null ? "cost" : null, effective.sell == null ? "sell" : null].filter(Boolean);
  if (missingSides.length) {
    return {
      ...base,
      unitFactor: factor,
      problem: { kind: "unpriced_item", sides: missingSides, message: `${where} uses ${describeItem(component.itemCode, item)}, which has no ${missingSides.join(" or ")} price` },
    };
  }
  return {
    ...base,
    priceId: effective.priceId ?? null,
    unitFactor: factor,
    cost: factor === 1 ? effective.cost : effective.cost * factor,
    sell: factor === 1 ? effective.sell : effective.sell * factor,
  };
}

/**
 * Every assembly of `quoteCatalog`, priced. Returns
 * { _source, assemblies: { [code]: { code, mode, version, definition,
 * components: { [key]: pricedComponent }, problems } }, items }, where
 * `items` is name/category/unit by lower-case code for every active item
 * (internal line metadata comes from here, not from a table in code).
 */
export function resolveRecipePricing(state, quoteCatalog, { prices = effectivePrices(state) } = {}) {
  const assemblies = {};
  for (const definition of quoteCatalog?.assemblies || []) {
    const components = {};
    const problems = [];
    for (const component of definition.components) {
      const priced = priceAssemblyComponent(state, component, { prices, assemblyCode: definition.code });
      components[component.key] = priced;
      if (priced.problem) problems.push({ key: component.key, itemCode: component.itemCode, ...priced.problem });
    }
    assemblies[definition.code] = {
      code: definition.code,
      mode: definition.mode,
      version: definition.version,
      definition,
      components,
      problems,
    };
  }
  const items = {};
  for (const item of state.items.values()) {
    if (item.status !== "active") continue;
    items[normalizeCode(item.code)] = { code: item.code, name: item.name, category: item.category || null, unit: displayUnit(item) };
  }
  return { _source: "price_catalog", assemblies, items };
}
