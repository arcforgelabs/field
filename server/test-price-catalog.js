// Test fixture: a price catalogue in its own in-memory PostgreSQL (PGlite),
// priced from fixture rates for the default quote rules plus the
// internal rates the drainage recipe needs (server/test-pricing-fixtures.js;
// the quote catalog itself carries no prices). Close it when done.
import { createTestDb } from "./db-runtime/index.js";
import { openCatalogStore } from "./catalog/index.js";
import { serializeQuoteCatalog } from "./quote-catalogs.js";
import { TEST_ITEM_PRICES, TEST_ITEM_UNITS, TEST_QUOTE_RULE_SELL_RATES } from "./test-pricing-fixtures.js";

export function defaultTestPriceMaps() {
  const catalog = serializeQuoteCatalog("default");
  const buyMap = Object.fromEntries(
    (catalog?.lineItems || []).map((item) => [item.code, 1]),
  );
  const sellMap = Object.fromEntries(
    (catalog?.lineItems || []).map((item) => [item.code, TEST_QUOTE_RULE_SELL_RATES[item.code] ?? 1]),
  );
  // The drainage quantity recipe is deliberately backed by internal
  // material/machine rates too; a partial fixture must not become a verified
  // quote merely because its top-level drainage item has a rate.
  for (const code of ["DRAIN-PIPE-M", "DRAIN-PIT", "DRAIN-GRAVEL-M", "clean-fill-disposal", "EXCAVATOR-HOUR", "LABOURER-HOUR", "VEHICLE-HOUR", "ADMIN-FEE"]) {
    const [buy, sell] = TEST_ITEM_PRICES[code];
    buyMap[code] = buy;
    sellMap[code] = sell;
  }
  return { buyMap, sellMap, units: TEST_ITEM_UNITS };
}

/**
 * Create (or reprice) one item per code in the maps: code doubles as name,
 * unit from `units` (default: the fixture units, else "job"), an internal
 * component. Codes match case-insensitively.
 */
export async function seedCatalogFromPriceMaps(store, { buyMap = {}, sellMap = {}, units = TEST_ITEM_UNITS, author = "test-fixture" } = {}) {
  const codes = [...new Set([...Object.keys(buyMap), ...Object.keys(sellMap)])];
  for (const code of codes) {
    const buy = buyMap[code] ?? null;
    const sell = sellMap[code] ?? null;
    const existing = await store.getItem(code);
    if (existing) {
      const patch = {};
      if (buy !== null) patch.buy_price = buy;
      if (sell !== null) patch.sell_price = sell;
      await store.updateItem(existing.uid, patch, { author });
    } else {
      await store.createItem({ code, name: code, unit: units[code] || "job", buy_price: buy, sell_price: sell, catalog_type: "component" }, { author });
    }
  }
}

const OPEN = new Set();

/** Close every catalogue this process created (test.after). */
export async function closeTestPriceCatalogs() {
  const handles = [...OPEN];
  OPEN.clear();
  await Promise.all(handles.map((handle) => handle.close()));
}

/**
 * `track: false` keeps it out of closeTestPriceCatalogs() (a file-wide
 * catalogue the file closes itself in test.after).
 */
export async function createTestPriceCatalog({ priceMaps = defaultTestPriceMaps(), items = null, dataDir = null, track = true } = {}) {
  const handle = await createTestDb();
  if (track) OPEN.add(handle);
  const store = await openCatalogStore({ db: handle.db, dataDir });
  if (items) {
    for (const item of items) await store.createItem(item, { author: "test-fixture" });
  } else if (priceMaps) {
    await seedCatalogFromPriceMaps(store, priceMaps);
  }
  return {
    store,
    db: handle.db,
    close: () => {
      OPEN.delete(handle);
      return handle.close();
    },
  };
}
