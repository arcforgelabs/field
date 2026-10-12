// A manual backup of the whole catalogue as one JSON document: every
// catalogue table, read in one repeatable-read transaction. Restores come
// from PostgreSQL itself (Replit's point-in-time restore); this is the copy
// an operator can keep, diff or hand to someone.
import { sql } from "drizzle-orm";
import { selectRows, toIso } from "./state.js";

export const CATALOG_EXPORT_TABLES = Object.freeze([
  "catalog_meta",
  "units",
  "unit_aliases",
  "tax_codes",
  "categories",
  "suppliers",
  "items",
  "item_code_aliases",
  "item_unit_conversions",
  "item_suppliers",
  "item_prices",
  "kit_components",
  "price_imports",
  "price_import_rows",
  "catalog_evidence",
  "catalog_history",
]);

function plain(value) {
  if (value instanceof Date) return toIso(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

export async function exportCatalog(db, { now = new Date() } = {}) {
  const read = async (tx) => {
    const tables = {};
    for (const table of CATALOG_EXPORT_TABLES) {
      const rows = await selectRows(tx, sql`select * from ${sql.identifier(table)} order by 1`);
      tables[table] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plain(value)])));
    }
    return tables;
  };
  const tables = await db.transaction(read, { isolationLevel: "repeatable read", accessMode: "read only" });
  const version = Number(tables.catalog_meta?.[0]?.version ?? 0);
  return {
    format: "field-price-catalogue-export",
    formatVersion: 1,
    exportedAt: toIso(now),
    catalogVersion: version,
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    tables,
  };
}
