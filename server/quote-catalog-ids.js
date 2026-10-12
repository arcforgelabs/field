export const DEFAULT_QUOTE_CATALOG_ID = "embark-default";

export function resolveQuoteCatalogId(value = DEFAULT_QUOTE_CATALOG_ID) {
  const normalized = String(value || "").trim();
  return normalized || DEFAULT_QUOTE_CATALOG_ID;
}

export function resolveQuoteCatalogIdFromMeta(meta = {}, fallback = DEFAULT_QUOTE_CATALOG_ID) {
  return resolveQuoteCatalogId(
    meta?.quoteCatalogId
    || fallback
  );
}
