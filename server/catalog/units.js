// Typed units for the catalogue. A quantity moves between two units only
// when the catalogue says how: the same unit, two units of one dimension that
// both have a base factor (min <-> hour, mm <-> m), or an item's own
// conversion (1 m3 of this gravel = 1.6 tonne). Anything else is a
// UNIT_MISMATCH, so a per-tonne rate cannot price a per-metre line.
import { CatalogError } from "./errors.js";

export function resolveUnitCode(state, value) {
  const key = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  if (state.units.has(key)) return key;
  return state.aliases.get(key) || null;
}

export function requireUnitCode(state, value, field = "unit") {
  const code = resolveUnitCode(state, value);
  if (!code) {
    throw new CatalogError(
      "UNKNOWN_UNIT",
      `${field} "${String(value ?? "").trim()}" is not a known unit (known: ${[...state.units.keys()].join(", ")})`,
      { path: field },
    );
  }
  return code;
}

function itemConversionFactor(state, itemUid, from, to) {
  for (const conversion of state.conversions.get(itemUid) || []) {
    if (conversion.fromUnit === from && conversion.toUnit === to) return conversion.factor;
    if (conversion.fromUnit === to && conversion.toUnit === from && conversion.factor) return 1 / conversion.factor;
  }
  return null;
}

/** How to turn 1 `from` into `to` units, or null when the catalogue has no way. */
export function conversionFactor(state, fromUnit, toUnit, { itemUid = null } = {}) {
  const from = resolveUnitCode(state, fromUnit);
  const to = resolveUnitCode(state, toUnit);
  if (!from || !to) return null;
  if (from === to) return 1;
  const a = state.units.get(from);
  const b = state.units.get(to);
  if (a?.dimension === b?.dimension && a.toBase != null && b.toBase != null) return a.toBase / b.toBase;
  if (itemUid) return itemConversionFactor(state, itemUid, from, to);
  return null;
}

export function canConvert(state, fromUnit, toUnit, options = {}) {
  return conversionFactor(state, fromUnit, toUnit, options) != null;
}

export function convertQuantity(state, quantity, fromUnit, toUnit, { itemUid = null } = {}) {
  const value = Number(quantity);
  if (!Number.isFinite(value)) {
    throw new CatalogError("INVALID_QUANTITY", "quantity must be a number", { path: "quantity" });
  }
  const factor = conversionFactor(state, fromUnit, toUnit, { itemUid });
  if (factor == null) {
    const item = itemUid ? state.items.get(itemUid) : null;
    throw new CatalogError(
      "UNIT_MISMATCH",
      `Cannot convert ${String(fromUnit)} to ${String(toUnit)}${item ? ` for ${item.name} (${item.code})` : ""}: the catalogue has no conversion between them`,
      { path: "unit" },
    );
  }
  return value * factor;
}

// pricing_basis is stored as an item conversion: per_tonne is
// 1 m3 = <density> tonne, per_load is 1 load = <capacity> m3, per_m3 needs none.
export const PRICING_BASIS_CONVERSIONS = Object.freeze({
  per_tonne: Object.freeze({ fromUnit: "m3", toUnit: "tonne" }),
  per_load: Object.freeze({ fromUnit: "load", toUnit: "m3" }),
});

export function pricingBasisFactor(state, item) {
  const spec = PRICING_BASIS_CONVERSIONS[item?.pricingBasis];
  if (!spec) return null;
  const row = (state.conversions.get(item.uid) || [])
    .find((conversion) => conversion.fromUnit === spec.fromUnit && conversion.toUnit === spec.toUnit);
  return row ? row.factor : null;
}
