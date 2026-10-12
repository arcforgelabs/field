// One consistent, immutable view of the whole catalogue, read from PostgreSQL
// in a single repeatable-read transaction. Pricing (roll-ups, quote snapshots,
// the rate card, health) is pure code over this view, so a quote build never
// sees half of a concurrent catalogue edit. The catalogue is small (hundreds
// of items), so loading it whole is cheaper than querying per line.
import { sql } from "drizzle-orm";

export function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

// `db` is a transaction, a Drizzle instance, or an organisation scope
// (server/db-runtime/tenancy.js orgScope), for which the query runs in its own
// organisation transaction (read only: writes go through a transaction).
export async function selectRows(db, query) {
  if (db?.isOrgScope) return db.transaction(async (tx) => rowsOf(await tx.execute(query)), { accessMode: "read only" });
  return rowsOf(await db.execute(query));
}

export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeCode(value) {
  return String(value ?? "").trim().toLowerCase();
}

function mapItem(row) {
  return Object.freeze({
    uid: row.uid,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    notes: row.notes ?? null,
    priceReference: row.price_reference ?? null,
    kind: row.kind ?? null,
    type: row.type ?? null,
    visibility: row.visibility,
    unitCode: row.unit_code,
    unitLabel: row.unit_label ?? null,
    category: row.category ?? null,
    tags: Object.freeze(Array.isArray(row.tags) ? [...row.tags] : (typeof row.tags === "string" ? JSON.parse(row.tags) : [])),
    taxCode: row.tax_code,
    costMode: row.cost_mode,
    sellMode: row.sell_mode,
    pricingBasis: row.pricing_basis ?? null,
    status: row.status,
    version: Number(row.version),
    variantOfUid: row.variant_of_uid ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function mapPrice(row) {
  return Object.freeze({
    id: Number(row.id),
    itemUid: row.item_uid,
    supplierId: row.supplier_id == null ? null : Number(row.supplier_id),
    cost: toNumber(row.cost_per_unit),
    markupPct: toNumber(row.markup_pct),
    sell: toNumber(row.sell_price),
    effectiveFrom: toIso(row.effective_from),
    source: row.source,
    sourceRef: row.source_ref ?? null,
    changedBy: row.changed_by,
    reason: row.reason ?? null,
    createdAt: toIso(row.created_at),
  });
}

function mapComponent(row) {
  return Object.freeze({
    id: Number(row.id),
    parentUid: row.kit_uid,
    childUid: row.component_uid,
    quantity: toNumber(row.quantity),
    entryQuantity: toNumber(row.entry_quantity),
    entryUnit: row.entry_unit ?? null,
    applicationMode: row.application_mode,
    pricingContribution: row.pricing_contribution,
    sortOrder: Number(row.sort_order),
    createdAt: toIso(row.created_at),
  });
}

/**
 * Read the catalogue as of `now`: every item, each item's current price row
 * (latest effective_from <= now, ties to the highest id), kit components,
 * unit and conversion data, categories, and the catalogue version.
 */
export async function loadCatalogState(db, { now = new Date(), inTransaction = false } = {}) {
  const at = toIso(now);
  const read = async (tx) => {
    const [meta] = await selectRows(tx, sql`select version from catalog_meta where id = 1`);
    const unitRows = await selectRows(tx, sql`select code, label, dimension, to_base, sort_order from units order by sort_order, code`);
    const aliasRows = await selectRows(tx, sql`select alias, unit_code from unit_aliases`);
    const taxRows = await selectRows(tx, sql`select code, label, rate from tax_codes order by code`);
    const itemRows = await selectRows(tx, sql`select * from items`);
    const codeAliasRows = await selectRows(tx, sql`select code, item_uid from item_code_aliases order by item_uid, created_at, code`);
    const priceRows = await selectRows(tx, sql`
      select distinct on (item_uid) *
      from item_prices
      where effective_from <= ${at}::timestamptz
      order by item_uid, effective_from desc, id desc`);
    const [epoch] = await selectRows(tx, sql`
      select max(effective_from) as current_epoch,
             (select min(effective_from) from item_prices where effective_from > ${at}::timestamptz) as next_change
      from item_prices where effective_from <= ${at}::timestamptz`);
    const componentRows = await selectRows(tx, sql`select * from kit_components order by id`);
    const conversionRows = await selectRows(tx, sql`select item_uid, from_unit, to_unit, factor from item_unit_conversions order by item_uid, from_unit, to_unit`);
    const categoryRows = await selectRows(tx, sql`select id, name, parent_id, sort_order, created_at, updated_at from categories order by sort_order, name`);
    return { meta, unitRows, aliasRows, taxRows, itemRows, codeAliasRows, priceRows, epoch, componentRows, conversionRows, categoryRows };
  };
  const raw = !inTransaction && typeof db.transaction === "function"
    ? await db.transaction(read, { isolationLevel: "repeatable read", accessMode: "read only" })
    : await read(db);
  return buildCatalogState(raw, { now: at });
}

export function buildCatalogState(raw, { now }) {
  if (!raw.meta) {
    throw new Error("catalogue reference data is missing (catalog_meta); run the catalogue setup first");
  }
  const units = new Map(raw.unitRows.map((row) => [row.code, Object.freeze({
    code: row.code,
    label: row.label,
    dimension: row.dimension,
    toBase: toNumber(row.to_base),
  })]));
  const aliases = new Map(raw.aliasRows.map((row) => [String(row.alias).toLowerCase(), row.unit_code]));
  const taxCodes = new Map(raw.taxRows.map((row) => [row.code, Object.freeze({ code: row.code, label: row.label, rate: toNumber(row.rate) })]));
  const items = new Map();
  // Legacy code (lower case) -> item uid. Every code an item has had is an
  // alias row (item_code_aliases, code retirement step 2); an item's own code is always
  // one of them. A code is a lookup key only: the item is its uid.
  const byCode = new Map();
  const codesByUid = new Map();
  for (const row of raw.itemRows) {
    const item = mapItem(row);
    items.set(item.uid, item);
  }
  for (const row of raw.codeAliasRows || []) {
    if (!items.has(row.item_uid)) continue;
    byCode.set(normalizeCode(row.code), row.item_uid);
    if (!codesByUid.has(row.item_uid)) codesByUid.set(row.item_uid, []);
    codesByUid.get(row.item_uid).push(row.code);
  }
  for (const item of items.values()) {
    const key = normalizeCode(item.code);
    if (!byCode.has(key)) byCode.set(key, item.uid);
  }
  for (const [uid, codes] of codesByUid) codesByUid.set(uid, Object.freeze(codes));
  const prices = new Map(raw.priceRows.map((row) => [row.item_uid, mapPrice(row)]));
  const components = new Map();
  const parentsOf = new Map();
  for (const row of raw.componentRows) {
    const component = mapComponent(row);
    if (!components.has(component.parentUid)) components.set(component.parentUid, []);
    components.get(component.parentUid).push(component);
    if (!parentsOf.has(component.childUid)) parentsOf.set(component.childUid, []);
    parentsOf.get(component.childUid).push(component.parentUid);
  }
  const conversions = new Map();
  for (const row of raw.conversionRows) {
    if (!conversions.has(row.item_uid)) conversions.set(row.item_uid, []);
    conversions.get(row.item_uid).push(Object.freeze({
      fromUnit: row.from_unit,
      toUnit: row.to_unit,
      factor: toNumber(row.factor),
    }));
  }
  const categories = raw.categoryRows.map((row) => Object.freeze({
    id: Number(row.id),
    name: row.name,
    parent_id: row.parent_id == null ? null : Number(row.parent_id),
    sort_order: Number(row.sort_order),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }));
  const version = Number(raw.meta.version);
  const priceEpoch = toIso(raw.epoch?.current_epoch) || null;
  const state = {
    version,
    priceEpoch,
    etag: `W/"catalog-${version}-${priceEpoch ? Date.parse(priceEpoch) : 0}"`,
    now,
    nextChangeAt: toIso(raw.epoch?.next_change) || null,
    units,
    aliases,
    taxCodes,
    items,
    byCode,
    codesByUid,
    prices,
    components,
    parentsOf,
    conversions,
    categories,
    // Lazily computed, keyed by recipe map (see rollup.js).
    cache: new WeakMap(),
  };
  return state;
}

/**
 * The item an identity names: its uid first, then any legacy code it has
 * had (item_code_aliases), case-insensitively. Old quote rows, json5 recipes
 * and scripts name items by code; they resolve to the same item forever.
 */
export function findItem(state, identity) {
  const text = String(identity ?? "").trim();
  if (!text) return null;
  if (state.items.has(text)) return state.items.get(text);
  const byCode = state.byCode.get(normalizeCode(text));
  if (byCode) return state.items.get(byCode);
  // uids are case-sensitive by construction but were matched without case
  // before (COLLATE NOCASE); keep that.
  const lowered = text.toLowerCase();
  for (const item of state.items.values()) {
    if (item.uid.toLowerCase() === lowered) return item;
  }
  return null;
}

/** SQLite's COLLATE NOCASE order (ASCII case folding, then code units). */
export function compareNoCase(a, b) {
  const fold = (value) => String(value ?? "").replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  const x = fold(a);
  const y = fold(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}
