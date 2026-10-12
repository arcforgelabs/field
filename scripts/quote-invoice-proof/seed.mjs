// Seed the synthetic verification price catalogue for a proof run.
//
// A checkout with the PostgreSQL catalogue (server/catalog) gets it seeded
// into the database run.mjs names (FIELD_DB_URL in durable storage mode, else
// the PGlite directory FIELD_PGLITE_DIR), through the
// catalogue store's createItem (the path the API uses). An older checkout
// (SQLite data/price-catalog/catalog.db) is seeded the way it always was, so
// one harness can prove a before/after pair across the move.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, dataDir] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(repoRoot, rel)).href);
const { VERIFICATION_CATALOG_ITEMS } = await load("scripts/verification/fixtures.js");

if (existsSync(join(repoRoot, "server/catalog/index.js"))) {
  if (!process.env.FIELD_PGLITE_DIR && !process.env.FIELD_DB_URL) throw new Error("seed.mjs: FIELD_DB_URL or FIELD_PGLITE_DIR must name the proof database");
  const { runMigrations, closeDb } = await load("server/db-runtime/index.js");
  const { openCatalogStore } = await load("server/catalog/index.js");
  await runMigrations();
  const store = await openCatalogStore();
  for (const item of VERIFICATION_CATALOG_ITEMS) await store.createItem(item, { author: "quote-invoice-proof" });
  await closeDb();
} else {
  const { getCatalogDb, closeCatalogDb } = await load("server/price-catalog/catalog-db.js");
  const { createItem } = await load("server/price-catalog/catalog-items.js");
  const db = getCatalogDb(dataDir);
  for (const item of VERIFICATION_CATALOG_ITEMS) createItem(db, item, { author: "quote-invoice-proof" });
  closeCatalogDb();
}
console.log(`seeded ${VERIFICATION_CATALOG_ITEMS.length} catalog items`);
