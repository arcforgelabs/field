// Reference rows the catalogue needs before any item can exist: units and
// their aliases (from shared/catalog-units.js, the one list the client also
// uses), and each organisation's tax codes and catalogue version row. Idempotent: existing rows
// are left alone, so an operator's edits to a label or rate survive.
import { sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { CATALOG_UNIT_ALIASES, CATALOG_UNIT_DEFINITIONS } from "../../shared/catalog-units.js";

export const DEFAULT_TAX_CODE = "GST";

export const CATALOG_TAX_CODES = Object.freeze([
  Object.freeze({ code: "GST", label: "GST 10%", rate: "0.1" }),
  Object.freeze({ code: "GST_FREE", label: "GST free", rate: "0" }),
  Object.freeze({ code: "INPUT_TAXED", label: "Input taxed", rate: "0" }),
]);

/**
 * Units and their aliases (shared by every organisation), then the
 * organisation's tax codes and catalogue version row. `db` is a Drizzle
 * instance or an organisation scope; `orgUid` (default: the default organisation)
 * applies to a plain instance.
 */
export async function ensureCatalogReferenceData(db, { now = new Date(), orgUid = DEFAULT_ORG_UID } = {}) {
  const shared = db?.isOrgScope ? db.db : db;
  const org = db?.isOrgScope ? db.orgUid : orgUid;
  // Shared reference data is written by the login role: field_app may only read it.
  await shared
    .insert(schema.units)
    .values(CATALOG_UNIT_DEFINITIONS.map((unit, index) => ({
      code: unit.code,
      label: unit.label,
      dimension: unit.dimension,
      toBase: unit.toBase,
      sortOrder: index,
    })))
    .onConflictDoNothing();
  const known = new Set(CATALOG_UNIT_DEFINITIONS.map((unit) => unit.code));
  const aliases = Object.entries(CATALOG_UNIT_ALIASES)
    .filter(([alias, code]) => alias !== code && known.has(code))
    .map(([alias, unitCode]) => ({ alias, unitCode }));
  if (aliases.length) await shared.insert(schema.unitAliases).values(aliases).onConflictDoNothing();
  await withOrg(shared, org, async (tx) => {
    await tx.insert(schema.taxCodes).values([...CATALOG_TAX_CODES]).onConflictDoNothing();
    await tx.insert(schema.catalogMeta).values({ id: 1, version: 0, updatedAt: now }).onConflictDoNothing();
  });
}

// The catalogue's version row, locked for the rest of the transaction. Every
// write takes it first, so catalogue writes are serialised (they are rare and
// small) and the version increases by exactly one per committed write.
export async function lockCatalogForWrite(tx) {
  const rows = await tx.execute(sql`select version from catalog_meta where id = 1 for update`);
  const list = Array.isArray(rows) ? rows : rows?.rows || [];
  if (!list.length) {
    throw new Error("catalogue reference data is missing (catalog_meta); run the catalogue setup first");
  }
  return Number(list[0].version);
}

export async function bumpCatalogVersion(tx, { now = new Date() } = {}) {
  const rows = await tx.execute(
    sql`update catalog_meta set version = version + 1, updated_at = ${now.toISOString()}::timestamptz where id = 1 returning version`,
  );
  const list = Array.isArray(rows) ? rows : rows?.rows || [];
  return Number(list[0]?.version);
}

/**
 * Delete every catalogue item and everything hanging off it (prices, kit
 * components, conversions, suppliers' item links, evidence, history) and the
 * categories, inside the caller's transaction. Reference data and the version
 * row stay. Only for an explicit replace (legacy import --replace, the
 * synthetic verification reset), never at runtime.
 */
export async function deleteCatalogContents(tx) {
  await tx.execute(sql`delete from kit_components`);
  await tx.execute(sql`delete from catalog_evidence`);
  await tx.execute(sql`delete from catalog_history`);
  await tx.execute(sql`delete from price_import_rows`);
  await tx.execute(sql`update items set variant_of_uid = null`);
  await tx.execute(sql`delete from items`);
  await tx.execute(sql`delete from categories`);
}
