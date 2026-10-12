// Money helpers shared by the pricing paths. Field holds no prices of its
// own: every rate comes from the price catalogue (server/catalog). The wall
// engine's rate card is server/retaining-wall-rate-card.js; recipe
// (assembly) prices are server/price-catalog/recipe-pricing.js.

/**
 * Resolve a money rate without ever turning null/undefined into zero.
 * Missing rates remain null so the owning pricing path can report an
 * explicit dependency issue instead of producing an apparently valid line.
 */
export function requireRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

/** A code's entry in a code-keyed price map, matching codes case-insensitively. */
export function resolveMapRate(map, code) {
  if (!map || !code) return null;
  if (Object.prototype.hasOwnProperty.call(map, code)) return map[code];
  const target = String(code).trim().toLowerCase();
  const entry = Object.entries(map).find(([key]) => String(key).trim().toLowerCase() === target);
  return entry ? entry[1] : null;
}
