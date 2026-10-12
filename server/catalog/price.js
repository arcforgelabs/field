// One price function (docs/PRICING_ENGINE.md "Pricing"): price(state, item)
// -> { unit_cost, unit_sell, markup_pct, margin_pct, price_uid, problems }.
//
// It reads the catalogue's one roll-up (rollup.js effectivePrices), so it is
// the same number the price book, the quote line, the PDF and the API show.
// What it adds is the shape the design names and a whole-catalogue snapshot
// with a comparison, which is the phase 1 price-equality gate: a structural
// change to the catalogue (a rename, a kit flattened, a duplicate merged) is
// kept only if every item still prices the same to the cent.
//
// unit_sell is the catalogue's effective sell exactly as it stands. Rounding
// sells to cents (84 production price rows carry more than 2 decimals) would
// change prices, so it is not done here.
import { effectivePrices, priceKey } from "./rollup.js";
import { findItem, loadCatalogState } from "./state.js";

/** How an item's sell is set: `fixed`, `markup`, or `rollup` (a kit summing its components). */
export function pricingMethodOf(item, effective = null) {
  if (item.sellMode === "rollup") return effective && !effective.hasComponents ? "fixed" : "rollup";
  if (item.sellMode === "markup") return "markup";
  return "fixed";
}

function round(value, places) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** (sell - cost) / cost and (sell - cost) / sell, as percentages (3 decimals); null when undefined. */
export function markupAndMargin(cost, sell) {
  if (cost == null || sell == null) return { markup_pct: null, margin_pct: null };
  return {
    markup_pct: cost > 0 ? round(((sell - cost) / cost) * 100, 3) : null,
    margin_pct: sell > 0 ? round(((sell - cost) / sell) * 100, 3) : null,
  };
}

/**
 * The price of one item (uid, or a legacy code alias) in `state`, as of the
 * moment the snapshot was read (`state.now`). Null when there is no such item.
 * An archived or unpriced item, or a kit with a missing, archived or unpriced
 * component, has a null cost or sell and says why in `problems`; it never
 * prices as zero.
 */
export function price(state, identity, { prices = effectivePrices(state) } = {}) {
  const item = typeof identity === "object" && identity?.uid ? identity : findItem(state, identity);
  if (!item) return null;
  const effective = prices.get(item.uid) || { cost: null, sell: null, problems: [] };
  const problems = [...(effective.problems || [])];
  if (item.status !== "active") problems.unshift({ kind: "inactive_item", status: item.status });
  const row = state.prices.get(item.uid) || null;
  const rolledUp = effective.costSource === "rollup" || effective.sellSource === "rollup";
  return {
    item_uid: item.uid,
    name: item.name,
    unit: item.unitLabel || item.unitCode,
    at: state.now,
    pricing_method: pricingMethodOf(item, effective),
    unit_cost: effective.cost ?? null,
    unit_sell: effective.sell ?? null,
    ...markupAndMargin(effective.cost ?? null, effective.sell ?? null),
    // The price row the number came from; null for a kit priced by roll-up,
    // which no single row holds (price_key then moves when anything behind it does).
    price_uid: rolledUp ? null : (row?.id ?? null),
    price_key: priceKey(state, item.uid),
    problems,
  };
}

/** The price of the item at a past moment: its components' prices at that moment. */
export async function priceAt(db, identity, at) {
  const state = await loadCatalogState(db, { now: at instanceof Date ? at : new Date(at) });
  return price(state, identity);
}

/**
 * Every item's price in one snapshot: { catalogVersion, at, items: { uid: { name, unit,
 * status, unit_cost, unit_sell, problems } } }. JSON-safe, so it can be kept
 * in a file and compared after a change (comparePrices).
 */
export function capturePrices(state) {
  const prices = effectivePrices(state);
  const items = {};
  for (const item of [...state.items.values()].sort((a, b) => a.uid.localeCompare(b.uid))) {
    const p = price(state, item, { prices });
    items[item.uid] = {
      name: item.name,
      unit: p.unit,
      status: item.status,
      unit_cost: p.unit_cost,
      unit_sell: p.unit_sell,
      problems: p.problems.map((problem) => problem.kind),
    };
  }
  return { catalogVersion: state.version, at: state.now, items };
}

// Two prices are the same when equal to a millionth (sums of the same terms in
// another order can differ in the last float bits) and equal to the cent.
function samePrice(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 1e-6 && Math.round(a * 100) === Math.round(b * 100);
}

/**
 * The price-equality gate. Compares two capturePrices snapshots and lists
 * every item whose cost or sell moved, or that became unpriced. Items in
 * `before` only (deleted) are listed too. An item may change name, unit
 * label, category or status; with `allowArchived` set to the uids that
 * are deliberately archived, those are not counted as a status change.
 * `ok` is true only when nothing moved.
 */
export function comparePrices(before, after, { allowArchived = [] } = {}) {
  const archivedOk = new Set(allowArchived);
  const changed = [];
  const unpricedArchived = [];
  for (const [uid, was] of Object.entries(before.items || {})) {
    const now = after.items?.[uid];
    if (!now) { changed.push({ uid, name: was.name, change: "missing" }); continue; }
    if (!samePrice(was.unit_cost, now.unit_cost) || !samePrice(was.unit_sell, now.unit_sell)) {
      // A kit archived on purpose together with its parts no longer rolls up
      // (an archived component never prices): that is retiring it, listed
      // apart, not a price change. A different number is always a change.
      const retired = archivedOk.has(uid) && now.status !== "active" && now.unit_cost == null && now.unit_sell == null;
      if (retired) { unpricedArchived.push({ uid, name: was.name }); continue; }
      changed.push({ uid, name: was.name, change: "price", before: { cost: was.unit_cost, sell: was.unit_sell }, after: { cost: now.unit_cost, sell: now.unit_sell } });
      continue;
    }
    if (was.status === "active" && now.status !== "active" && !archivedOk.has(uid)) {
      changed.push({ uid, name: was.name, change: "status", before: was.status, after: now.status });
    }
  }
  const compared = Object.keys(before.items || {}).length;
  return { ok: changed.length === 0, compared, changed, unpricedArchived };
}
