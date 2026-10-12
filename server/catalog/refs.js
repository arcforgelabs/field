// How pricing configuration names a catalogue item (code retirement
// step 4): by uid, with the item's legacy code beside it as a fallback.
// Quote-catalog rules (`authorityItemUid`), recipe components (`itemUid`),
// quantity-rule outputs (`outputItemUid`) and the wall rate card
// (retaining-wall-items.js) declare the uid of the production item; an
// installation whose catalogue does not hold that uid (the synthetic
// verification catalogue) finds the item by the code, through the aliases
// (item_code_aliases, which never change). Health reports any reference that
// only resolved by code, or whose uid and code name different items.
import { normalizeCode } from "./state.js";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** { item, by: "uid" | "code" | null, conflict } for a { uid, code } reference. */
export function resolveItemRef(state, { uid = null, code = null } = {}) {
  const wantedUid = text(uid);
  const wantedCode = text(code);
  const byCode = wantedCode ? state.items.get(state.byCode.get(normalizeCode(wantedCode))) || null : null;
  if (wantedUid && state.items.has(wantedUid)) {
    const item = state.items.get(wantedUid);
    // A uid and a code that name two different items is a broken reference.
    return { item, by: "uid", conflict: Boolean(byCode && byCode.uid !== item.uid) };
  }
  if (byCode) return { item: byCode, by: "code", conflict: false };
  return { item: null, by: null, conflict: false };
}

export function refItem(state, ref) {
  return resolveItemRef(state, ref).item;
}

// The keys that hold an item uid beside a code in a quote catalog.
export const ITEM_UID_KEYS = Object.freeze(["authorityItemUid", "itemUid", "outputItemUid"]);

/**
 * A copy of a quote catalog without the uid keys. The authority snapshot's
 * digest covers what priced (the resolved items and their codes, which never
 * change); declaring an item by uid as well does not make it a different
 * catalog, so the digest of an unchanged catalog stays the same.
 */
export function withoutItemUids(value) {
  if (Array.isArray(value)) return value.map(withoutItemUids);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (ITEM_UID_KEYS.includes(key)) continue;
    out[key] = withoutItemUids(entry);
  }
  return out;
}
