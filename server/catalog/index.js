// Field's price catalogue on PostgreSQL. See server/catalog/README.md.
import { getDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { bumpCatalogVersion, deleteCatalogContents, ensureCatalogReferenceData, lockCatalogForWrite } from "./reference-data.js";
import { createCatalogStore } from "./store.js";

export { createCatalogStore, generateCatalogUid, validatePricingBasis } from "./store.js";
export { CatalogError, CatalogNameConflictError } from "./errors.js";
export { bumpCatalogVersion, deleteCatalogContents, ensureCatalogReferenceData, lockCatalogForWrite } from "./reference-data.js";
export { loadCatalogState, findItem } from "./state.js";
export {
  componentsOf,
  currentPrice,
  effectivePrice,
  effectivePrices,
  kitSnapshot,
  priceKey,
  resolveRecipeChildQuantity,
} from "./rollup.js";
export { canConvert, conversionFactor, convertQuantity, resolveUnitCode } from "./units.js";
export { buildCatalogHealthReport } from "./health.js";
export { exportCatalog } from "./export.js";
export { importLegacyCatalog, legacyEffectivePrices, readLegacyCatalog } from "./legacy-import.js";

/**
 * The server's catalogue store for organisation `orgUid` on the runtime
 * database (getDb()). Throws
 * NoDatabaseError when no database is configured. Reference rows (units,
 * tax codes, the version row) are ensured first; they are idempotent.
 */
export async function openCatalogStore({ db = getDb(), orgUid = DEFAULT_ORG_UID, dataDir = null, catalogId, clock } = {}) {
  await ensureCatalogReferenceData(db, { orgUid, now: clock ? clock() : new Date() });
  return createCatalogStore({ db, orgUid, dataDir, catalogId, ...(clock ? { clock } : {}) });
}

/**
 * Replace the whole catalogue with `items` (createItem inputs) in one go:
 * for the synthetic verification reset and fixtures, never for real data.
 */
export async function replaceCatalogItems(store, items, { author = "system" } = {}) {
  await store.db.transaction(async (tx) => {
    await lockCatalogForWrite(tx);
    await deleteCatalogContents(tx);
    await bumpCatalogVersion(tx);
  });
  store.invalidate();
  for (const item of items) await store.createItem(item, { author });
  return store;
}
