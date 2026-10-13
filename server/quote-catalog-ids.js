export const DEFAULT_QUOTE_CATALOG_ID = "default";

// Ids a quote catalogue had before, mapped to its id now. Stored quotes, jobs
// and links keep the id they were written with (a sent document never
// changes), so an old id must still resolve to the same catalogue.
const LEGACY_QUOTE_CATALOG_IDS = Object.freeze({
  // The sample catalogue's id until 2026-10 (#122).
  "embark-default": DEFAULT_QUOTE_CATALOG_ID,
});

export function resolveQuoteCatalogId(value = DEFAULT_QUOTE_CATALOG_ID) {
  const normalized = String(value || "").trim();
  return LEGACY_QUOTE_CATALOG_IDS[normalized] || normalized || DEFAULT_QUOTE_CATALOG_ID;
}

export function resolveQuoteCatalogIdFromMeta(meta = {}, fallback = DEFAULT_QUOTE_CATALOG_ID) {
  return resolveQuoteCatalogId(
    meta?.quoteCatalogId
    || fallback
  );
}
