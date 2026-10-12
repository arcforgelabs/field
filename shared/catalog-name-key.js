/**
 * Catalogue item name matching key.
 *
 * Two catalogue item names are considered the same name for the purposes of
 * the "no two ACTIVE items may share a name" rule when they produce the same
 * key: NFC-normalized, trimmed, internal whitespace runs (including tabs and
 * NBSP) collapsed to a single space, then case-folded.
 *
 * Deliberately narrow: no accent stripping, no punctuation stripping, no
 * plural handling, no fuzzy matching. See `shared/catalog-search.js:28-32`
 * for the closely related search normalizer this key extends with NFC.
 */
export function nameKey(name) {
  return String(name ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
