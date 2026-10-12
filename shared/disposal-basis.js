// The price-catalogue item behind a disposal rule is the single source of
// truth for converting measured volume into that item's own billing unit.
// This is the one place that conversion arithmetic lives —
// server/quote-quantity-rules.js (the live quote engine) and
// server/catalog/rollup.js and legacy-import.js (the catalogue's own price
// build-up) both delegate
// here instead of re-deriving the rule. Do not copy this arithmetic
// elsewhere; that recreates the two-owner defect this module exists to
// remove.

/**
 * Disposal-item quantity per 1 m3 of measured volume, in the item's own
 * costing-basis unit:
 *  - per_m3 bills the volume directly (identity factor of 1).
 *  - per_tonne needs a density (t/m3) — the factor itself.
 *  - per_load needs the inverse of a load capacity (m3/load) — loads per m3.
 *
 * Returns null when the basis is missing or unrecognized, or when a basis
 * that requires a factor (per_tonne, per_load) doesn't have one — callers
 * must fail closed (not-quoteable / unresolved), never guess a number.
 */
export function resolveDisposalQuantityPerVolume(pricingBasis, pricingBasisFactor) {
  if (pricingBasis === "per_m3") return 1;
  const factor = Number(pricingBasisFactor);
  const hasFactor = Number.isFinite(factor) && factor > 0;
  if (pricingBasis === "per_tonne") return hasFactor ? factor : null;
  if (pricingBasis === "per_load") return hasFactor ? 1 / factor : null;
  return null;
}

/**
 * The quantity actually billed against a disposal item for one specific
 * measured volume (a real job's disposal line). per_load rounds up to whole
 * loads — a job either takes a load or it doesn't — whereas
 * resolveDisposalQuantityPerVolume() above returns a continuous per-m3 rate
 * used for catalogue price build-up, where fractional loads are the correct
 * average-cost representation.
 */
export function resolveDisposalBilledQuantity({ pricingBasis, pricingBasisFactor, volumeM3 }) {
  const numericVolume = Number(volumeM3);
  if (!(numericVolume > 0)) return null;
  const perVolume = resolveDisposalQuantityPerVolume(pricingBasis, pricingBasisFactor);
  if (perVolume == null) return null;
  const raw = numericVolume * perVolume;
  if (pricingBasis === "per_load") return Math.ceil(roundQuantity(raw));
  return roundQuantity(raw);
}

function roundQuantity(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}
