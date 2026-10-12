// The price book (#148 section 5, item 6 of the Replit move): one searchable,
// editable grid over the catalogue, suppliers and their item links, and bulk
// price edits with a preview. Reads are pure code over the store's snapshot
// plus the supplier tables; every write runs in the store's serialised,
// versioned write transaction (store.write), appends item_prices rows and
// records field-level history, like the store's own writes.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { catalogPricingReferences } from "../price-catalog/catalog-references.js";
import { CatalogError } from "./errors.js";
import { effectivePrices } from "./rollup.js";
import { compareNoCase, findItem, normalizeCode, selectRows, toIso, toNumber } from "./state.js";
import { recordHistory } from "./store.js";
import { requireUnitCode } from "./units.js";
import { catalogTypeOf, displayUnit } from "./views.js";

/** Sell below this margin (percent of sell) is flagged in previews and the grid. */
export const LOW_MARGIN_PCT = 10;
/** A supplier import row whose cost moves more than this (either way) is flagged. */
export const LARGE_CHANGE_PCT = 15;
export const GRID_MAX_LIMIT = 500;

export function roundMoney(value) {
  return value == null ? null : Math.round(Number(value) * 100) / 100;
}

export function roundRate(value) {
  return value == null ? null : Math.round(Number(value) * 10000) / 10000;
}

export function marginPct(cost, sell) {
  if (cost == null || sell == null || !(Number(sell) > 0)) return null;
  return Math.round(((Number(sell) - Number(cost)) / Number(sell)) * 10000) / 100;
}

export function marginWarnings(cost, sell) {
  const warnings = [];
  if (cost == null || sell == null) return warnings;
  if (Number(sell) < Number(cost)) warnings.push({ code: "negative_margin", message: "Sell is below cost" });
  else {
    const margin = marginPct(cost, sell);
    if (margin != null && margin < LOW_MARGIN_PCT) warnings.push({ code: "low_margin", message: `Margin ${margin}% is below ${LOW_MARGIN_PCT}%` });
  }
  return warnings;
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out || null;
}

// ── Suppliers ──

function supplierRow(row) {
  return {
    id: Number(row.id),
    uid: row.uid,
    name: row.name,
    account_number: row.account_number ?? null,
    email_inbox: row.email_inbox ?? null,
    default_markup_pct: toNumber(row.default_markup_pct),
    import_profile: row.import_profile ?? null,
    status: row.status,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/**
 * Suppliers and every item ↔ supplier link, as maps:
 * { suppliers: Map<id, supplier>, byUid: Map<uid, supplier>, byItem: Map<itemUid, link[]> }.
 */
export async function loadSupplierData(db) {
  const supplierRows = await selectRows(db, sql`select * from suppliers order by lower(name), id`);
  const linkRows = await selectRows(db, sql`select * from item_suppliers order by item_uid, is_default desc, id`);
  const suppliers = new Map();
  const byUid = new Map();
  for (const row of supplierRows) {
    const supplier = supplierRow(row);
    suppliers.set(supplier.id, supplier);
    byUid.set(supplier.uid, supplier);
  }
  const byItem = new Map();
  for (const row of linkRows) {
    const supplier = suppliers.get(Number(row.supplier_id));
    const link = {
      id: Number(row.id),
      item_uid: row.item_uid,
      supplier_id: Number(row.supplier_id),
      supplier_uid: supplier?.uid ?? null,
      supplier_name: supplier?.name ?? null,
      supplier_code: row.supplier_code ?? null,
      supplier_description: row.supplier_description ?? null,
      pack_qty: toNumber(row.pack_qty) ?? 1,
      pack_unit: row.pack_unit ?? null,
      is_default: Boolean(row.is_default),
    };
    if (!byItem.has(link.item_uid)) byItem.set(link.item_uid, []);
    byItem.get(link.item_uid).push(link);
  }
  return { suppliers, byUid, byItem };
}

export async function listSuppliers(store, { includeArchived = false } = {}) {
  const { suppliers, byItem } = await loadSupplierData(store.db);
  const counts = new Map();
  for (const links of byItem.values()) {
    for (const link of links) counts.set(link.supplier_id, (counts.get(link.supplier_id) || 0) + 1);
  }
  return [...suppliers.values()]
    .filter((supplier) => includeArchived || supplier.status === "active")
    .map((supplier) => ({ ...supplier, item_count: counts.get(supplier.id) || 0 }));
}

export async function getSupplier(db, uid) {
  const [row] = await selectRows(db, sql`select * from suppliers where uid = ${String(uid || "")}`);
  return row ? supplierRow(row) : null;
}

function supplierFields(input, { partial }) {
  const out = {};
  if (!partial || has(input, "name")) {
    const name = text(input.name);
    if (!name) throw new CatalogError("INVALID", "Supplier name is required", { path: "name" });
    out.name = name;
  }
  if (has(input, "account_number")) out.accountNumber = text(input.account_number);
  if (has(input, "email_inbox")) out.emailInbox = text(input.email_inbox);
  if (has(input, "default_markup_pct")) {
    const raw = input.default_markup_pct;
    if (raw === null || raw === undefined || raw === "") out.defaultMarkupPct = null;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new CatalogError("INVALID", "default_markup_pct must be a number", { path: "default_markup_pct" });
      out.defaultMarkupPct = String(n);
    }
  }
  if (has(input, "status")) {
    const status = String(input.status || "").trim().toLowerCase();
    if (!["active", "archived"].includes(status)) throw new CatalogError("INVALID", "status must be active or archived", { path: "status" });
    out.status = status;
  }
  return out;
}

async function assertSupplierNameFree(tx, name, exceptId = null) {
  const rows = await selectRows(tx, sql`select id from suppliers where lower(name) = lower(${name})`);
  if (rows.some((row) => Number(row.id) !== exceptId)) {
    throw new CatalogError("CODE_CONFLICT", `A supplier named "${name}" already exists`, { path: "name" });
  }
}

export async function createSupplier(store, input = {}) {
  const fields = supplierFields(input, { partial: false });
  const uid = await store.write(async (tx, _state, now) => {
    await assertSupplierNameFree(tx, fields.name);
    const supplierUid = `sup_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await tx.insert(schema.suppliers).values({ uid: supplierUid, ...fields, status: fields.status || "active", createdAt: now, updatedAt: now });
    return { result: supplierUid };
  });
  return getSupplier(store.db, uid);
}

export async function updateSupplier(store, uid, input = {}) {
  const fields = supplierFields(input, { partial: true });
  const found = await store.write(async (tx, _state, now) => {
    const [row] = await selectRows(tx, sql`select id from suppliers where uid = ${String(uid || "")} for update`);
    if (!row) return { result: false, changed: false };
    if (fields.name) await assertSupplierNameFree(tx, fields.name, Number(row.id));
    if (!Object.keys(fields).length) return { result: true, changed: false };
    await tx.update(schema.suppliers).set({ ...fields, updatedAt: now }).where(eq(schema.suppliers.id, Number(row.id)));
    return { result: true };
  });
  return found ? getSupplier(store.db, uid) : null;
}

/** Save the column map (and delimiter) a supplier's price lists use; not a catalogue change. */
export async function saveSupplierImportProfile(db, supplierId, profile, now = new Date()) {
  if (db?.isOrgScope) return db.transaction((tx) => saveSupplierImportProfile(tx, supplierId, profile, now));
  await db.update(schema.suppliers).set({ importProfile: profile, updatedAt: now }).where(eq(schema.suppliers.id, Number(supplierId)));
}

// ── Item ↔ supplier links ──

export async function listItemSuppliers(store, identity) {
  const state = await store.getState();
  const item = findItem(state, identity);
  if (!item) return null;
  const { byItem } = await loadSupplierData(store.db);
  return byItem.get(item.uid) || [];
}

function linkLabel(supplierName, supplierCode) {
  return supplierCode ? `${supplierName} ${supplierCode}` : supplierName;
}

/**
 * Link an item to a supplier (or update the link with the same supplier and
 * supplier code). A default link is the one supplier imports and the grid
 * show first; making one default clears the item's other defaults.
 */
export async function upsertItemSupplier(store, identity, input = {}, { author = "system", reason = null } = {}) {
  const supplierUid = text(input.supplier_uid ?? input.supplierUid);
  if (!supplierUid) throw new CatalogError("INVALID", "supplier_uid is required", { path: "supplier_uid" });
  const supplierCode = text(input.supplier_code ?? input.supplierCode);
  const packQty = input.pack_qty ?? input.packQty;
  const pack = packQty === undefined || packQty === null || packQty === "" ? 1 : Number(packQty);
  if (!Number.isFinite(pack) || pack <= 0) throw new CatalogError("INVALID", "pack_qty must be greater than zero", { path: "pack_qty" });
  const result = await store.write(async (tx, state, now) => {
    const item = findItem(state, identity);
    if (!item) return { result: null, changed: false };
    const [supplier] = await selectRows(tx, sql`select id, name, status from suppliers where uid = ${supplierUid}`);
    if (!supplier) throw new CatalogError("UNKNOWN_REF", `Supplier ${supplierUid} does not exist`, { path: "supplier_uid" });
    const packUnitRaw = text(input.pack_unit ?? input.packUnit);
    const packUnit = packUnitRaw ? requireUnitCode(state, packUnitRaw, "pack_unit") : null;
    if (supplierCode) {
      const taken = await selectRows(tx, sql`
        select item_uid from item_suppliers
        where supplier_id = ${Number(supplier.id)} and lower(supplier_code) = lower(${supplierCode}) and item_uid <> ${item.uid}`);
      if (taken.length) {
        const other = state.items.get(taken[0].item_uid);
        throw new CatalogError("CODE_CONFLICT", `${supplier.name} code ${supplierCode} is already linked to ${other ? `${other.name} (${other.code})` : taken[0].item_uid}`, { path: "supplier_code" });
      }
    }
    const existing = await selectRows(tx, sql`
      select id, supplier_code, is_default from item_suppliers
      where item_uid = ${item.uid} and supplier_id = ${Number(supplier.id)}
      order by id`);
    const others = await selectRows(tx, sql`select id from item_suppliers where item_uid = ${item.uid} and supplier_id <> ${Number(supplier.id)}`);
    const isDefault = input.is_default ?? input.isDefault ?? (others.length === 0 && existing.length === 0);
    const match = existing.find((row) => normalizeCode(row.supplier_code) === normalizeCode(supplierCode)) || existing[0] || null;
    if (isDefault) await tx.update(schema.itemSuppliers).set({ isDefault: false }).where(eq(schema.itemSuppliers.itemUid, item.uid));
    let id;
    if (match) {
      await tx.update(schema.itemSuppliers).set({
        supplierCode,
        supplierDescription: has(input, "supplier_description") ? text(input.supplier_description) : undefined,
        packQty: String(pack),
        packUnit,
        isDefault: Boolean(isDefault),
      }).where(eq(schema.itemSuppliers.id, Number(match.id)));
      id = Number(match.id);
    } else {
      const [row] = await tx.insert(schema.itemSuppliers).values({
        itemUid: item.uid,
        supplierId: Number(supplier.id),
        supplierCode,
        supplierDescription: text(input.supplier_description),
        packQty: String(pack),
        packUnit,
        isDefault: Boolean(isDefault),
      }).returning({ id: schema.itemSuppliers.id });
      id = Number(row.id);
    }
    await tx.update(schema.items).set({ version: sql`${schema.items.version} + 1`, updatedAt: now }).where(eq(schema.items.uid, item.uid));
    await recordHistory(tx, {
      item,
      changes: [{ field: `suppliers.${supplier.name}`, oldValue: match ? linkLabel(supplier.name, match.supplier_code) : null, newValue: linkLabel(supplier.name, supplierCode) }],
      author,
      reason,
      now,
    });
    return { result: { itemUid: item.uid, id } };
  });
  if (!result) return null;
  return listItemSuppliers(store, result.itemUid);
}

export async function removeItemSupplier(store, identity, linkId, { author = "system", reason = null } = {}) {
  const result = await store.write(async (tx, state, now) => {
    const item = findItem(state, identity);
    if (!item) return { result: null, changed: false };
    const [link] = await selectRows(tx, sql`
      select l.id, l.supplier_code, s.name from item_suppliers l join suppliers s on s.id = l.supplier_id
      where l.id = ${Number(linkId)} and l.item_uid = ${item.uid}`);
    if (!link) return { result: null, changed: false };
    await tx.delete(schema.itemSuppliers).where(and(eq(schema.itemSuppliers.id, Number(linkId)), eq(schema.itemSuppliers.itemUid, item.uid)));
    await tx.update(schema.items).set({ version: sql`${schema.items.version} + 1`, updatedAt: now }).where(eq(schema.items.uid, item.uid));
    await recordHistory(tx, { item, changes: [{ field: `suppliers.${link.name}`, oldValue: linkLabel(link.name, link.supplier_code), newValue: null }], author, reason, now });
    return { result: item.uid };
  });
  return result ? listItemSuppliers(store, result) : null;
}

// ── Pending (future-dated) prices ──

export async function loadPendingPrices(db, now) {
  const rows = await selectRows(db, sql`
    select distinct on (item_uid) id, item_uid, effective_from, cost_per_unit, sell_price, markup_pct, source, source_ref
    from item_prices where effective_from > ${toIso(now)}::timestamptz
    order by item_uid, effective_from, id`);
  return new Map(rows.map((row) => [row.item_uid, {
    price_id: Number(row.id),
    effective_from: toIso(row.effective_from),
    cost: toNumber(row.cost_per_unit),
    sell: toNumber(row.sell_price),
    markup_pct: toNumber(row.markup_pct),
    source: row.source,
    source_ref: row.source_ref ?? null,
  }]));
}

// ── The grid ──

const SORTS = {
  code: (a, b) => compareNoCase(a.code, b.code),
  name: (a, b) => compareNoCase(a.name, b.name) || compareNoCase(a.code, b.code),
  category: (a, b) => compareNoCase(a.category || "￿", b.category || "￿") || compareNoCase(a.name, b.name),
  cost: (a, b) => numberCompare(a.cost, b.cost) || compareNoCase(a.name, b.name),
  sell: (a, b) => numberCompare(a.sell, b.sell) || compareNoCase(a.name, b.name),
  margin: (a, b) => numberCompare(a.margin_pct, b.margin_pct) || compareNoCase(a.name, b.name),
  updated: (a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")) || compareNoCase(a.code, b.code),
};

function numberCompare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function gridRow(state, item, effective, links, pending) {
  const price = state.prices.get(item.uid) || null;
  const variant = item.variantOfUid ? state.items.get(item.variantOfUid) : null;
  const defaultLink = links.find((link) => link.is_default) || links[0] || null;
  const cost = effective?.cost ?? null;
  const sell = effective?.sell ?? null;
  return {
    uid: item.uid,
    code: item.code,
    name: item.name,
    description: item.description,
    category: item.category,
    tags: [...item.tags],
    unit: displayUnit(item),
    unit_code: item.unitCode,
    kind: item.kind,
    catalog_type: catalogTypeOf(item),
    status: item.status,
    version: item.version,
    tax_code: item.taxCode,
    cost_mode: item.costMode,
    sell_mode: item.sellMode,
    cost,
    sell,
    markup_pct: price?.markupPct ?? null,
    margin_pct: marginPct(cost, sell),
    warnings: marginWarnings(cost, sell).map((warning) => warning.code),
    price_id: price?.id ?? null,
    price_effective_from: price?.effectiveFrom ?? null,
    price_source: price?.source ?? null,
    pending_price: pending || null,
    variant_of_uid: item.variantOfUid,
    variant_of_code: variant?.code ?? null,
    variant_of_name: variant?.name ?? null,
    child_count: (state.components.get(item.uid) || []).length,
    problems: effective?.problems ? [...effective.problems] : [],
    suppliers: links.map((link) => ({ id: link.id, supplier_uid: link.supplier_uid, supplier_name: link.supplier_name, supplier_code: link.supplier_code, pack_qty: link.pack_qty, is_default: link.is_default })),
    supplier_name: defaultLink?.supplier_name ?? null,
    supplier_code: defaultLink?.supplier_code ?? null,
    updated_at: item.updatedAt,
  };
}

function searchText(row) {
  return [row.code, row.name, row.category, row.unit, ...row.tags, ...row.suppliers.flatMap((link) => [link.supplier_code, link.supplier_name])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * One page of the grid. Filters: q (every term must appear in code, name,
 * category, unit, tags, supplier name or supplier code), status (default
 * active; "all"), category ("" for none), tag, supplier (uid). Facets count
 * categories and tags over the rows matching q, status and supplier, so the
 * chips say what a click would show.
 */
export async function listPriceBook(store, query = {}) {
  const state = await store.getState();
  const [{ byItem, byUid }, pending] = await Promise.all([loadSupplierData(store.db), loadPendingPrices(store.db, state.now)]);
  const prices = effectivePrices(state);
  const status = text(query.status) || "active";
  const terms = String(query.q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const supplier = text(query.supplier);
  const supplierId = supplier ? byUid.get(supplier)?.id ?? -1 : null;
  const hasCategory = has(query, "category") && query.category !== undefined && query.category !== null;
  const category = hasCategory ? String(query.category) : null;
  const tag = text(query.tag);
  const sortKey = SORTS[query.sort] ? query.sort : "name";
  const direction = String(query.dir || "asc").toLowerCase() === "desc" ? -1 : 1;
  const limit = Math.min(GRID_MAX_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || 100));
  const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);

  const base = [];
  for (const item of state.items.values()) {
    if (status !== "all" && item.status !== status) continue;
    const links = byItem.get(item.uid) || [];
    if (supplierId != null && !links.some((link) => link.supplier_id === supplierId)) continue;
    const row = gridRow(state, item, prices.get(item.uid), links, pending.get(item.uid));
    if (terms.length) {
      const haystack = searchText(row);
      if (!terms.every((term) => haystack.includes(term))) continue;
    }
    base.push(row);
  }
  const categoryCounts = new Map();
  const tagCounts = new Map();
  for (const row of base) {
    const key = row.category || "";
    categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
    for (const value of row.tags) tagCounts.set(value, (tagCounts.get(value) || 0) + 1);
  }
  const filtered = base.filter((row) => (
    (!hasCategory || (row.category || "") === category)
    && (!tag || row.tags.includes(tag))
  ));
  const sorter = SORTS[sortKey];
  filtered.sort((a, b) => direction * sorter(a, b));
  return {
    rows: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
    sort: sortKey,
    dir: direction === 1 ? "asc" : "desc",
    catalogVersion: state.version,
    etag: state.etag,
    facets: {
      categories: [...categoryCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => compareNoCase(a.name || "￿", b.name || "￿")),
      tags: [...tagCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => compareNoCase(a.name, b.name)),
    },
  };
}

// ── Bulk edits ──

const BULK_OPS = ["setMarkupPct", "adjustCostPct", "adjustSellPct", "setCategory", "archive"];

export function normalizeBulkOp(op) {
  const input = op && typeof op === "object" ? op : {};
  const keys = Object.keys(input).filter((key) => BULK_OPS.includes(key));
  if (keys.length !== 1) throw new CatalogError("INVALID", `op must have exactly one of: ${BULK_OPS.join(", ")}`, { path: "op" });
  const [key] = keys;
  if (key === "archive") {
    if (input.archive !== true) throw new CatalogError("INVALID", "op.archive must be true", { path: "op.archive" });
    return { archive: true };
  }
  if (key === "setCategory") {
    const value = input.setCategory == null ? null : (String(input.setCategory).trim() || null);
    return { setCategory: value };
  }
  const n = Number(input[key]);
  if (!Number.isFinite(n)) throw new CatalogError("INVALID", `op.${key} must be a number`, { path: `op.${key}` });
  if (key !== "setMarkupPct" && n <= -100) throw new CatalogError("INVALID", `op.${key} must be greater than -100`, { path: `op.${key}` });
  return { [key]: n };
}

function normalizeUids(uids) {
  if (!Array.isArray(uids) || !uids.length) throw new CatalogError("INVALID", "Select at least one item", { path: "uids" });
  if (uids.length > 2000) throw new CatalogError("INVALID", "At most 2000 items per bulk edit", { path: "uids" });
  return [...new Set(uids.map(String))];
}

function usedBy(state, item, references) {
  const out = [];
  for (const parentUid of new Set(state.parentsOf.get(item.uid) || [])) {
    const parent = state.items.get(parentUid);
    if (parent && parent.status === "active") out.push(`kit ${parent.code}`);
  }
  for (const reference of references) {
    if (normalizeCode(reference.code) === normalizeCode(item.code)) out.push(reference.source);
  }
  return [...new Set(out)];
}

/**
 * What a bulk op would do to each selected item: { uid, code, name, action
 * ("update" | "skip"), reason, before, after, warnings }. Pure over a snapshot.
 */
export function planBulk(state, uids, op, { pending = new Map(), references = [] } = {}) {
  const prices = effectivePrices(state);
  return uids.map((uid) => {
    const item = state.items.get(uid);
    if (!item) return { uid, code: null, name: null, action: "skip", reason: "Not in the catalogue", before: null, after: null, warnings: [] };
    const row = state.prices.get(uid) || null;
    const effective = prices.get(uid) || { cost: null, sell: null };
    const before = {
      cost: effective.cost,
      sell: effective.sell,
      markup_pct: row?.markupPct ?? null,
      sell_mode: item.sellMode,
      category: item.category,
      status: item.status,
      margin_pct: marginPct(effective.cost, effective.sell),
    };
    const base = { uid, code: item.code, name: item.name, version: item.version, before };
    const skip = (reason) => ({ ...base, action: "skip", reason, after: null, warnings: [] });
    const done = (after, extraWarnings = [], change = {}) => ({
      ...base,
      action: "update",
      reason: null,
      after: { ...before, ...after, margin_pct: marginPct(after.cost ?? before.cost, after.sell ?? before.sell) },
      warnings: [...extraWarnings, ...marginWarnings(after.cost ?? before.cost, after.sell ?? before.sell)],
      change,
    });
    const isPriceOp = op.setMarkupPct != null || op.adjustCostPct != null || op.adjustSellPct != null;
    if (isPriceOp && pending.has(uid)) return skip(`A price change is scheduled for ${pending.get(uid).effective_from}`);

    if (op.archive) {
      if (item.status === "archived") return skip("Already archived");
      const users = usedBy(state, item, references);
      const warnings = users.length ? [{ code: "in_use", message: `Still used by ${users.join(", ")}; it becomes unpriced there` }] : [];
      return done({ status: "archived" }, warnings, { status: "archived" });
    }
    if (has(op, "setCategory")) {
      if ((item.category || null) === op.setCategory) return skip("Already in that category");
      return done({ category: op.setCategory }, [], { category: op.setCategory });
    }
    if (op.setMarkupPct != null) {
      if (item.sellMode === "rollup") return skip("Sell rolls up from its components");
      if (effective.cost == null) return skip("No cost to mark up");
      if (item.sellMode === "markup" && row?.markupPct === op.setMarkupPct) return skip("Already at that markup");
      const sell = roundMoney(effective.cost * (1 + op.setMarkupPct / 100));
      const warnings = item.sellMode === "fixed" ? [{ code: "mode_change", message: "Switches from a fixed sell price to markup" }] : [];
      return done({ markup_pct: op.setMarkupPct, sell_mode: "markup", sell }, warnings, { sellMode: "markup", markupPct: op.setMarkupPct });
    }
    if (op.adjustCostPct != null) {
      if (item.costMode === "rollup") return skip("Cost rolls up from its components");
      if (row?.cost == null) return skip("No cost to adjust");
      // Costs keep sub-cent precision (as imports do); sells are money.
      const cost = roundRate(row.cost * (1 + op.adjustCostPct / 100));
      if (Math.abs(cost - row.cost) < 1e-9) return skip("No change at that percentage");
      const sell = item.sellMode === "markup" && row.markupPct != null ? roundMoney(cost * (1 + row.markupPct / 100)) : effective.sell;
      return done({ cost, sell }, [], { cost });
    }
    if (op.adjustSellPct != null) {
      if (item.sellMode === "rollup") return skip("Sell rolls up from its components");
      if (item.sellMode === "markup") return skip("Sell follows its markup; use Set markup instead");
      if (row?.sell == null) return skip("No sell price to adjust");
      const sell = roundMoney(row.sell * (1 + op.adjustSellPct / 100));
      if (Math.abs(sell - row.sell) < 1e-9) return skip("No change at that percentage");
      return done({ sell }, [], { sell });
    }
    return skip("Nothing to do");
  });
}

function bulkSummary(rows) {
  return {
    selected: rows.length,
    updated: rows.filter((row) => row.action === "update").length,
    skipped: rows.filter((row) => row.action === "skip").length,
    warnings: rows.filter((row) => row.warnings.length).length,
  };
}

export async function previewBulk(store, { uids, op, catalogId } = {}) {
  const selected = normalizeUids(uids);
  const normalizedOp = normalizeBulkOp(op);
  const state = await store.getState();
  const pending = await loadPendingPrices(store.db, state.now);
  const references = normalizedOp.archive ? catalogPricingReferences(catalogId) : [];
  const rows = planBulk(state, selected, normalizedOp, { pending, references });
  return { op: normalizedOp, catalogVersion: state.version, summary: bulkSummary(rows), rows: rows.map(({ change, ...row }) => row) };
}

/**
 * Apply a bulk op in one transaction. expectedVersions ({ uid: version },
 * from the preview; the HTTP route requires them) refuse the whole batch
 * when any item changed since, or when an item it would change is missing;
 * price changes append item_prices rows (source "bulk", source_ref the batch id).
 */
export async function applyBulk(store, { uids, op, expectedVersions = null, catalogId, author = "system", reason = null } = {}) {
  const selected = normalizeUids(uids);
  const normalizedOp = normalizeBulkOp(op);
  const bulkId = `bulk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const references = normalizedOp.archive ? catalogPricingReferences(catalogId) : [];
  const rows = await store.write(async (tx, state, now) => {
    const pending = await loadPendingPrices(tx, now);
    const plan = planBulk(state, selected, normalizedOp, { pending, references });
    if (expectedVersions && typeof expectedVersions === "object") {
      for (const row of plan) {
        const expected = expectedVersions[row.uid];
        // Every item the batch would change must carry the version its preview saw.
        if (expected == null && row.action === "update") {
          throw new CatalogError("VERSION_CONFLICT", `${row.name} (${row.code}) was not in the preview; preview again`, { path: "expectedVersions", details: { uid: row.uid, currentVersion: row.version } });
        }
        if (expected != null && row.version != null && Number(expected) !== row.version) {
          throw new CatalogError("VERSION_CONFLICT", `${row.name} (${row.code}) changed since the preview (version ${row.version}, not ${expected}); preview again`, { path: "expectedVersions", details: { uid: row.uid, currentVersion: row.version } });
        }
      }
    }
    const updates = plan.filter((row) => row.action === "update");
    const note = reason || `Bulk edit ${bulkId}`;
    for (const row of updates) {
      const item = state.items.get(row.uid);
      const price = state.prices.get(row.uid) || null;
      const set = {};
      const changes = [];
      if (row.change.status) { set.status = row.change.status; changes.push({ field: "status", oldValue: item.status, newValue: row.change.status }); }
      if (has(row.change, "category")) { set.category = row.change.category; changes.push({ field: "category", oldValue: item.category, newValue: row.change.category }); }
      if (row.change.sellMode && row.change.sellMode !== item.sellMode) {
        set.sellMode = row.change.sellMode;
        changes.push({ field: "sell_mode", oldValue: item.sellMode, newValue: row.change.sellMode });
      }
      const priceChange = row.change.cost != null || row.change.sell != null || row.change.markupPct != null;
      if (priceChange) {
        const cost = row.change.cost ?? price?.cost ?? null;
        // A markup item's row keeps the sell its markup gives, so the history
        // reads truthfully; the roll-up still prices it from cost and markup.
        const markupMode = (row.change.sellMode || item.sellMode) === "markup";
        const sell = markupMode ? (row.after?.sell ?? null) : (row.change.sell ?? price?.sell ?? null);
        const markupPct = row.change.markupPct ?? price?.markupPct ?? null;
        await tx.insert(schema.itemPrices).values({
          itemUid: item.uid,
          supplierId: price?.supplierId ?? null,
          costPerUnit: cost == null ? null : String(cost),
          markupPct: markupPct == null ? null : String(markupPct),
          sellPrice: sell == null ? null : String(sell),
          effectiveFrom: now,
          source: "bulk",
          sourceRef: bulkId,
          changedBy: author,
          reason: note,
          createdAt: now,
        });
        changes.push({ field: "buy_price", oldValue: price?.cost ?? null, newValue: cost });
        changes.push({ field: "sell_price", oldValue: price?.sell ?? null, newValue: sell });
        changes.push({ field: "markup_pct", oldValue: price?.markupPct ?? null, newValue: markupPct });
      }
      await tx.update(schema.items)
        .set({ ...set, version: sql`${schema.items.version} + 1`, updatedAt: now })
        .where(eq(schema.items.uid, item.uid));
      await recordHistory(tx, { item, changes, author, reason: note, now });
    }
    return { result: plan, changed: updates.length > 0 };
  });
  return { bulkId, op: normalizedOp, summary: bulkSummary(rows), rows: rows.map(({ change, ...row }) => row) };
}
