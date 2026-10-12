// The price catalogue's data access, on PostgreSQL through Drizzle.
//
// Reads go through getState(): one immutable snapshot of the catalogue,
// reloaded only when catalog_meta.version moves or a future-dated price
// becomes current. Writes run in one transaction each: lock the version row
// (catalogue writes are serialised), validate against a snapshot read inside
// that transaction, write, record field-level history, bump the item's
// version and the catalogue version. Prices are append-only item_prices rows.
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, orgScope } from "../db-runtime/tenancy.js";
import { nameKey } from "../../shared/catalog-name-key.js";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "../storage/fs.js";
import { loadRecipeChildrenByParent } from "../price-catalog/catalog-recipes.js";
import { catalogAssemblies, catalogPricingReferences, catalogRuleUnits } from "../price-catalog/catalog-references.js";
import { DEFAULT_QUOTE_CATALOG_ID } from "../quote-catalog-ids.js";
import { CatalogError, CatalogNameConflictError, notFound } from "./errors.js";
import { buildCatalogHealthReport } from "./health.js";
import { bumpCatalogVersion, ensureCatalogReferenceData, lockCatalogForWrite } from "./reference-data.js";
import { componentsOf, currentPrice, kitSnapshot } from "./rollup.js";
import { findItem, loadCatalogState, normalizeCode, selectRows, toIso } from "./state.js";
import { canConvert, PRICING_BASIS_CONVERSIONS, pricingBasisFactor, requireUnitCode } from "./units.js";
import {
  childRow,
  displayUnit,
  itemDetail,
  itemRow,
  listChildRows,
  listItemRows,
  priceMaps,
  visibilityOfCatalogType,
} from "./views.js";

const PRICING_BASIS_VALUES = ["per_tonne", "per_load", "per_m3"];
const KINDS = ["material", "labour", "plant", "subcontract", "fee", "assembly"];
// What an item is (docs/PRICING_ENGINE.md "items"). `kind` above is the
// unused legacy field, kept for older clients.
export const ITEM_TYPES = ["material", "labour", "equipment", "subcontract", "fee", "kit"];

function normalizeType(value) {
  if (value == null || value === "") return null;
  const type = String(value).trim().toLowerCase();
  if (!ITEM_TYPES.includes(type)) throw new CatalogError("INVALID", `type must be one of: ${ITEM_TYPES.join(", ")}`, { path: "type" });
  return type;
}
const STATUSES = ["active", "draft", "archived"];

export function generateCatalogUid() {
  return `cat_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function optionalNumber(value, field, { min = 0 } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new CatalogError("INVALID", `${field} must be numeric`, { path: field });
  if (min != null && n < min) throw new CatalogError("INVALID", `${field} must be ${min} or greater`, { path: field });
  return n;
}

function numericText(value) {
  return value == null ? null : String(value);
}

/**
 * The effective_from a manual price write may carry: now, or a moment in the
 * past. A future date is refused (FUTURE_PRICE_UNSUPPORTED): a scheduled row
 * copies every price field as it stands when it is written, so any edit made
 * before its date would be silently undone on that date. Scheduled prices
 * come from a future-dated supplier import (price-import.js), which defines
 * what a pending row carries.
 */
function manualEffectiveFrom(raw, now) {
  if (raw === null || raw === undefined || raw === "") return now;
  const at = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(at.getTime())) throw new CatalogError("INVALID", "effective_from must be a date", { path: "effective_from" });
  if (at.getTime() > now.getTime()) {
    throw new CatalogError("FUTURE_PRICE_UNSUPPORTED", "effective_from cannot be in the future: scheduled price changes are not supported yet; set the price when it takes effect", { path: "effective_from" });
  }
  return at;
}

function storageValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) || (typeof value === "object" && !(value instanceof Date))) return JSON.stringify(value);
  return String(value);
}

/**
 * A disposal item's costing basis and the factor it needs: per_tonne
 * needs a density (t/m3), per_load a load capacity (m3/load), per_m3 none.
 */
export function validatePricingBasis({ pricing_basis, pricing_basis_factor }) {
  if (pricing_basis == null) {
    if (pricing_basis_factor != null) {
      throw new CatalogError("PRICING_BASIS", "pricing_basis_factor requires a pricing_basis of per_tonne, per_load, or per_m3", { path: "pricing_basis_factor" });
    }
    return;
  }
  if (!PRICING_BASIS_VALUES.includes(pricing_basis)) {
    throw new CatalogError("PRICING_BASIS", `pricing_basis must be one of: ${PRICING_BASIS_VALUES.join(", ")}`, { path: "pricing_basis" });
  }
  if (pricing_basis === "per_tonne" || pricing_basis === "per_load") {
    const factor = Number(pricing_basis_factor);
    if (!Number.isFinite(factor) || factor <= 0) {
      const label = pricing_basis === "per_tonne" ? "a density in tonnes per m3" : "a load capacity in m3 per load";
      throw new CatalogError("PRICING_BASIS", `pricing_basis "${pricing_basis}" requires pricing_basis_factor to be ${label} greater than zero`, { path: "pricing_basis_factor" });
    }
    return;
  }
  if (pricing_basis === "per_m3" && pricing_basis_factor != null) {
    throw new CatalogError("PRICING_BASIS", `pricing_basis "per_m3" bills the measured volume directly and does not take a pricing_basis_factor`, { path: "pricing_basis_factor" });
  }
}

function findActiveNameCollision(state, name, { excludeUid = null } = {}) {
  const key = nameKey(name);
  if (!key) return null;
  for (const item of state.items.values()) {
    if (item.status !== "active" || item.uid === excludeUid) continue;
    if (nameKey(item.name) === key) return item;
  }
  return null;
}

function assertNoActiveNameCollision(state, { name, status, excludeUid = null }) {
  if (status !== "active") return;
  const collision = findActiveNameCollision(state, name, { excludeUid });
  if (collision) {
    throw new CatalogNameConflictError(
      `An active catalog item named "${collision.name}" already exists.`,
      { code: collision.code, uid: collision.uid, name: collision.name },
    );
  }
}

function ensureUniqueActiveName(state, baseName, extraNames = new Set()) {
  let candidate = baseName;
  let index = 2;
  while (findActiveNameCollision(state, candidate) || extraNames.has(nameKey(candidate))) {
    candidate = `${baseName} (${index})`;
    index += 1;
  }
  return candidate;
}

function wouldCycle(state, parentUid, childUid) {
  // Adding child under parent cycles when parent is reachable from child.
  const stack = [childUid];
  const seen = new Set();
  while (stack.length) {
    const uid = stack.pop();
    if (uid === parentUid) return true;
    if (seen.has(uid)) continue;
    seen.add(uid);
    for (const component of state.components.get(uid) || []) stack.push(component.childUid);
  }
  return false;
}

function variantCycles(state, uid, variantOfUid) {
  let cursor = variantOfUid;
  const seen = new Set();
  while (cursor) {
    if (cursor === uid) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = state.items.get(cursor)?.variantOfUid || null;
  }
  return false;
}

function normalizeTags(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean))];
}

function normalizeApplicationMode(value) {
  return String(value || "").trim().toLowerCase() === "fixed" ? "fixed" : "proportional";
}

function normalizePricingContribution(value) {
  return String(value || "").trim().toLowerCase() === "listed_only" ? "listed_only" : "included";
}

function normalizeOptionalQuantity(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireQuantity(value, fallback = 1) {
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new CatalogError("INVALID_QUANTITY", "quantity must be a number, zero or greater", { path: "quantity" });
  }
  return n;
}

function childHistoryField(childCode, field = null) {
  const code = String(childCode || "").trim() || "unknown";
  return field ? `children.${code}.${field}` : `children.${code}`;
}

export async function recordHistory(tx, { item, changes, author, reason = null, now }) {
  const rows = changes
    .filter((change) => storageValue(change.oldValue) !== storageValue(change.newValue))
    .map((change) => ({
      itemUid: item.uid,
      itemCode: change.itemCode || item.code,
      field: change.field,
      oldValue: storageValue(change.oldValue),
      newValue: storageValue(change.newValue),
      changedBy: author || "system",
      reason,
      changedAt: now,
    }));
  if (rows.length) await tx.insert(schema.catalogHistory).values(rows);
  return rows.length;
}

async function touchItem(tx, uid, now) {
  await tx.update(schema.items)
    .set({ version: sql`${schema.items.version} + 1`, updatedAt: now })
    .where(eq(schema.items.uid, uid));
}

async function writePricingBasis(tx, uid, basis, factor) {
  const pairs = Object.values(PRICING_BASIS_CONVERSIONS);
  for (const pair of pairs) {
    await tx.delete(schema.itemUnitConversions).where(and(
      eq(schema.itemUnitConversions.itemUid, uid),
      eq(schema.itemUnitConversions.fromUnit, pair.fromUnit),
      eq(schema.itemUnitConversions.toUnit, pair.toUnit),
    ));
  }
  const spec = PRICING_BASIS_CONVERSIONS[basis];
  if (spec && factor != null) {
    await tx.insert(schema.itemUnitConversions).values({ itemUid: uid, fromUnit: spec.fromUnit, toUnit: spec.toUnit, factor: String(factor) });
  }
}

/** Resolve the modes a legacy (buy/sell_price_mode) or new (cost/sell_mode) body asks for. */
function resolveModes(input, current = null) {
  let costMode = current?.costMode || "manual";
  let sellMode = current?.sellMode || "fixed";
  if (has(input, "cost_mode") && input.cost_mode != null) costMode = input.cost_mode;
  else if (has(input, "buy_price_mode") && input.buy_price_mode != null) costMode = input.buy_price_mode === "computed" ? "rollup" : "manual";
  if (has(input, "sell_mode") && input.sell_mode != null) sellMode = input.sell_mode;
  else if (has(input, "sell_price_mode") && input.sell_price_mode != null) {
    if (input.sell_price_mode === "computed") sellMode = "rollup";
    // "manual" keeps a markup item on markup unless a sell price is set.
    else if (sellMode === "rollup" || has(input, "sell_price") || !current) sellMode = "fixed";
  } else if (!current && input.markup_pct != null && input.sell_price == null) {
    sellMode = "markup";
  }
  if (!["manual", "rollup"].includes(costMode)) throw new CatalogError("INVALID", "cost_mode must be manual or rollup", { path: "cost_mode" });
  if (!["fixed", "markup", "rollup"].includes(sellMode)) throw new CatalogError("INVALID", "sell_mode must be fixed, markup or rollup", { path: "sell_mode" });
  return { costMode, sellMode };
}

function resolveVariant(state, value, uid) {
  if (value === null || value === undefined || value === "") return null;
  // A uid, a legacy code, or (as the price book offers it) the name of an
  // active item; active names are unique.
  const target = findItem(state, value) || findActiveNameCollision(state, String(value));
  if (!target) throw new CatalogError("UNKNOWN_REF", `variant_of "${value}" is not a catalogue item`, { path: "variant_of_uid" });
  if (target.uid === uid || variantCycles(state, uid, target.uid)) {
    throw new CatalogError("CYCLE", "an item cannot be a variant of itself or of its own variant", { path: "variant_of_uid" });
  }
  return target.uid;
}

function resolveUnit(state, raw) {
  const text = String(raw ?? "").trim();
  const unitCode = requireUnitCode(state, text || "job");
  return { unitCode, unitLabel: text && text !== unitCode ? text : null };
}

/**
 * The catalogue of one organisation (`orgUid`, default: the default organisation).
 * Every read and write runs in that organisation's transaction; `store.db` is
 * its org scope (server/db-runtime/tenancy.js), never the raw database.
 */
export function createCatalogStore({ db: database, orgUid = DEFAULT_ORG_UID, clock = () => new Date(), dataDir = null, catalogId = DEFAULT_QUOTE_CATALOG_ID } = {}) {
  if (!database) throw new Error("createCatalogStore requires a database (server/db-runtime getDb())");
  const db = orgScope(database, orgUid);
  let cached = null;
  let loading = null;
  // Bumped after every committed write. A load that began under an older
  // generation may have read the catalogue before that write committed, so it
  // is neither shared with later callers nor cached: a write's response is
  // always built from a snapshot taken after its own commit.
  let generation = 0;
  let loadingGeneration = -1;

  async function getState({ fresh = false } = {}) {
    const now = clock();
    if (cached && !fresh) {
      // A write may clear `cached` while the version is read: check the
      // snapshot this call started from, and return it only if still cached.
      const snapshot = cached;
      const [meta] = await selectRows(db, sql`select version from catalog_meta where id = 1`);
      const stillCurrent = meta
        && Number(meta.version) === snapshot.version
        && (!snapshot.nextChangeAt || Date.parse(snapshot.nextChangeAt) > now.getTime());
      if (stillCurrent && cached === snapshot) return snapshot;
    }
    if (!loading || loadingGeneration !== generation) {
      const startedAt = generation;
      const pending = loadCatalogState(db, { now }).then((state) => {
        if (startedAt === generation) cached = state;
        return state;
      }).finally(() => { if (loading === pending) loading = null; });
      loading = pending;
      loadingGeneration = startedAt;
    }
    return loading;
  }

  // One write transaction. `fn(tx, state, now)` returns { result, changed };
  // the catalogue version moves only when something changed. With
  // expectedCatalogVersion the write is refused (VERSION_CONFLICT) when any
  // other catalogue write committed since the caller read that version.
  async function write(fn, { expectedCatalogVersion = null } = {}) {
    const now = clock();
    const outcome = await db.transaction(async (tx) => {
      await lockCatalogForWrite(tx);
      const state = await loadCatalogState(tx, { now, inTransaction: true });
      if (expectedCatalogVersion != null && Number(expectedCatalogVersion) !== state.version) {
        throw new CatalogError("VERSION_CONFLICT", `The catalogue is at version ${state.version}, not ${expectedCatalogVersion}; reload it and try again`, { path: "expectedCatalogVersion", details: { currentVersion: state.version } });
      }
      const out = await fn(tx, state, now);
      if (out?.changed !== false) await bumpCatalogVersion(tx, { now });
      return out;
    });
    if (outcome?.changed !== false) {
      generation += 1;
      cached = null;
    }
    return outcome?.result;
  }

  async function requireItem(identity) {
    const state = await getState();
    const item = findItem(state, identity);
    return { state, item };
  }

  // ── Reads ──

  async function listItems(filters = {}) {
    return listItemRows(await getState(), filters);
  }

  async function getItem(identity) {
    const { state, item } = await requireItem(identity);
    return item ? itemDetail(state, item) : null;
  }

  async function resolveIdentity(identity) {
    const { item } = await requireItem(identity);
    return item?.uid || null;
  }

  async function getItemsByUids(uids = []) {
    const state = await getState();
    return [...new Set(uids)].map((uid) => {
      const item = state.items.get(uid);
      return item ? itemDetail(state, item) : null;
    }).filter(Boolean);
  }

  async function getCurrentPrice(identity) {
    const { state, item } = await requireItem(identity);
    return item ? currentPrice(state, item.uid) : null;
  }

  async function getCurrentPrices(uids = []) {
    const state = await getState();
    return Object.fromEntries([...new Set(uids)].map((uid) => [uid, state.items.has(uid) ? currentPrice(state, uid) : null]));
  }

  async function getKitSnapshot(identity) {
    const { state, item } = await requireItem(identity);
    return item ? kitSnapshot(state, item.uid) : null;
  }

  async function listChildren(identity) {
    const { state, item } = await requireItem(identity);
    return item ? listChildRows(state, item.uid) : [];
  }

  async function getPriceMaps() {
    return priceMaps(await getState(), { fetchedAt: clock().toISOString() });
  }

  async function catalogVersion() {
    const state = await getState();
    return { version: state.version, etag: state.etag, priceEpoch: state.priceEpoch };
  }

  async function listCategories() {
    const state = await getState();
    return state.categories.map(({ id, name, sort_order, created_at, updated_at, parent_id }) => ({
      id, name, sort_order, created_at, updated_at, parent_id,
    }));
  }

  async function health({ catalogId: requested = catalogId } = {}) {
    const state = await getState();
    return buildCatalogHealthReport(state, {
      catalogId: requested,
      references: catalogPricingReferences(requested),
      assemblies: catalogAssemblies(requested),
      rules: catalogRuleUnits(requested),
      generatedAt: clock().toISOString(),
    });
  }

  async function getItemHistory(identity, { limit = 100, offset = 0 } = {}) {
    const { item } = await requireItem(identity);
    if (!item) return [];
    const rows = await selectRows(db, sql`
      select id, item_uid, item_code, field, old_value, new_value, changed_by, reason, changed_at
      from catalog_history where item_uid = ${item.uid}
      order by changed_at desc, id desc
      limit ${Number(limit) || 100} offset ${Number(offset) || 0}`);
    return rows.map((row) => ({ ...row, id: Number(row.id), changed_at: toIso(row.changed_at) }));
  }

  async function getPriceHistory(identity) {
    const { state, item } = await requireItem(identity);
    if (!item) return null;
    const rows = await selectRows(db, sql`
      select * from item_prices where item_uid = ${item.uid}
      order by effective_from desc, id desc`);
    const current = state.prices.get(item.uid)?.id ?? null;
    return rows.map((row) => ({
      price_id: Number(row.id),
      item_uid: row.item_uid,
      cost_per_unit: row.cost_per_unit == null ? null : Number(row.cost_per_unit),
      markup_pct: row.markup_pct == null ? null : Number(row.markup_pct),
      sell_price: row.sell_price == null ? null : Number(row.sell_price),
      effective_from: toIso(row.effective_from),
      source: row.source,
      source_ref: row.source_ref,
      changed_by: row.changed_by,
      reason: row.reason,
      created_at: toIso(row.created_at),
      current: Number(row.id) === current,
    }));
  }

  /**
   * The catalogue as it stood at `isoTimestamp`: current rows with every
   * later history change undone (the SQLite catalogue's point-in-time view).
   */
  async function getCatalogAtPointInTime(isoTimestamp) {
    const state = await getState();
    const at = toIso(isoTimestamp);
    if (!at) throw new CatalogError("INVALID", "at must be an ISO timestamp", { path: "at" });
    const history = await selectRows(db, sql`
      select item_uid, field, old_value from catalog_history
      where changed_at > ${at}::timestamptz
      order by changed_at desc, id desc`);
    const byUid = new Map();
    for (const row of history) {
      if (!byUid.has(row.item_uid)) byUid.set(row.item_uid, []);
      byUid.get(row.item_uid).push(row);
    }
    const fields = new Set(["name", "unit", "buy_price", "sell_price", "buy_price_mode", "sell_price_mode", "price_reference", "catalog_type", "category", "status", "code"]);
    return [...state.items.values()].map((item) => {
      const row = itemRow(state, item);
      for (const change of byUid.get(item.uid) || []) {
        if (!fields.has(change.field)) continue;
        row[change.field] = change.field === "buy_price" || change.field === "sell_price"
          ? (change.old_value == null ? null : Number(change.old_value))
          : change.old_value;
      }
      return row;
    });
  }

  async function listEvidence(identity, { side } = {}) {
    const { item } = await requireItem(identity);
    if (!item) return [];
    const rows = await selectRows(db, side
      ? sql`select * from catalog_evidence where item_uid = ${item.uid} and side = ${side} order by created_at desc, id desc`
      : sql`select * from catalog_evidence where item_uid = ${item.uid} order by created_at desc, id desc`);
    return rows.map((row) => ({ ...row, id: Number(row.id), item_code: item.code, created_at: toIso(row.created_at) }));
  }

  // ── Writes ──

  function prepareNewItem(state, input, { now }) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new CatalogError("INVALID", "name is required", { path: "name" });
    const uid = String(input.uid || "").trim() || generateCatalogUid();
    if (state.items.has(uid)) throw new CatalogError("CODE_CONFLICT", `Item uid '${uid}' already exists`, { path: "uid" });
    const code = String(input.code || "").trim() || uid;
    if (state.byCode.has(normalizeCode(code))) throw new CatalogError("CODE_CONFLICT", `Item code '${code}' already exists`, { path: "code" });
    const status = input.status == null ? "active" : String(input.status).trim().toLowerCase();
    if (!STATUSES.includes(status)) throw new CatalogError("INVALID", `status must be one of: ${STATUSES.join(", ")}`, { path: "status" });
    const pricingBasis = input.pricing_basis ?? null;
    const pricingBasisFactorValue = optionalNumber(input.pricing_basis_factor, "pricing_basis_factor");
    validatePricingBasis({ pricing_basis: pricingBasis, pricing_basis_factor: pricingBasisFactorValue });
    assertNoActiveNameCollision(state, { name, status });
    const kind = input.kind == null || input.kind === "" ? null : String(input.kind).trim().toLowerCase();
    if (kind && !KINDS.includes(kind)) throw new CatalogError("INVALID", `kind must be one of: ${KINDS.join(", ")}`, { path: "kind" });
    const type = normalizeType(input.type);
    const taxCode = input.tax_code ? String(input.tax_code).trim() : "GST";
    if (!state.taxCodes.has(taxCode)) throw new CatalogError("UNKNOWN_REF", `tax_code "${taxCode}" is not a known tax code`, { path: "tax_code" });
    const { costMode, sellMode } = resolveModes(input);
    const { unitCode, unitLabel } = resolveUnit(state, input.unit);
    const visibility = input.visibility
      ? (input.visibility === "sellable" ? "sellable" : "internal")
      : visibilityOfCatalogType(input.catalog_type);
    const cost = optionalNumber(input.buy_price ?? input.cost_per_unit, "buy_price");
    const sell = optionalNumber(input.sell_price, "sell_price");
    const markupPct = optionalNumber(input.markup_pct, "markup_pct", { min: null });
    return {
      row: {
        uid,
        code,
        name,
        description: input.description ? String(input.description) : null,
        notes: input.notes ? String(input.notes) : null,
        priceReference: input.price_reference ?? null,
        kind,
        type,
        visibility,
        unitCode,
        unitLabel,
        category: input.category ? String(input.category).trim() || null : null,
        tags: normalizeTags(input.tags),
        taxCode,
        costMode,
        sellMode,
        pricingBasis,
        status,
        version: 1,
        variantOfUid: resolveVariant(state, input.variant_of_uid ?? input.variant_of, uid),
        createdAt: now,
        updatedAt: now,
      },
      pricingBasisFactor: pricingBasisFactorValue,
      price: (cost != null || sell != null || markupPct != null)
        ? { cost, sell, markupPct, effectiveFrom: manualEffectiveFrom(input.effective_from, now) }
        : null,
    };
  }

  async function insertNewItem(tx, prepared, { author, reason, now, source = "manual", sourceRef = null }) {
    await tx.insert(schema.items).values(prepared.row);
    if (prepared.row.pricingBasis) await writePricingBasis(tx, prepared.row.uid, prepared.row.pricingBasis, prepared.pricingBasisFactor);
    if (prepared.price) {
      await tx.insert(schema.itemPrices).values({
        itemUid: prepared.row.uid,
        costPerUnit: numericText(prepared.price.cost),
        markupPct: numericText(prepared.price.markupPct),
        sellPrice: numericText(prepared.price.sell),
        effectiveFrom: prepared.price.effectiveFrom,
        source,
        sourceRef,
        changedBy: author,
        reason,
        createdAt: now,
      });
    }
    await recordHistory(tx, {
      item: prepared.row,
      changes: [{ field: "*", oldValue: null, newValue: "created" }],
      author,
      reason,
      now,
    });
  }

  async function createItem(input = {}, { author = "system", reason = null } = {}) {
    const uid = await write(async (tx, state, now) => {
      const prepared = prepareNewItem(state, input, { now });
      await insertNewItem(tx, prepared, { author, reason, now });
      return { result: prepared.row.uid };
    });
    return itemDetail(await getState(), (await getState()).items.get(uid));
  }

  async function updateItem(identity, patch = {}, { author = "system", reason = null, expectedVersion = null, effectiveFrom = null } = {}) {
    const uid = await write(async (tx, state, now) => {
      const current = findItem(state, identity);
      if (!current) return { result: null, changed: false };
      if (expectedVersion != null && Number(expectedVersion) !== current.version) {
        throw new CatalogError("VERSION_CONFLICT", `Item ${current.code} is at version ${current.version}, not ${expectedVersion}; reload it and try again`, { path: "expectedVersion", details: { currentVersion: current.version } });
      }
      const set = {};
      const changes = [];
      const note = (field, oldValue, newValue) => changes.push({ field, oldValue, newValue });

      if (has(patch, "name")) {
        const name = String(patch.name ?? "").trim();
        if (!name) throw new CatalogError("INVALID", "name cannot be empty", { path: "name" });
        if (name !== current.name) { set.name = name; note("name", current.name, name); }
      }
      // A code is a legacy alias (item_code_aliases, code retirement step 2): it never
      // changes, so nothing that names the item by it can be repointed. A
      // patch that repeats the current code (older clients send the whole
      // row) is accepted and changes nothing.
      if (has(patch, "code") && patch.code != null && String(patch.code).trim() !== current.code) {
        throw new CatalogError("CODE_READ_ONLY", `Item codes no longer change: ${current.name} keeps its code. Rename the item instead.`, { path: "code" });
      }
      if (has(patch, "unit")) {
        const { unitCode, unitLabel } = resolveUnit(state, patch.unit);
        if (unitCode !== current.unitCode || unitLabel !== current.unitLabel) {
          set.unitCode = unitCode;
          set.unitLabel = unitLabel;
          note("unit", displayUnit(current), unitLabel || unitCode);
        }
      }
      for (const [field, column, history] of [
        ["price_reference", "priceReference", "price_reference"],
        ["description", "description", "description"],
        ["notes", "notes", "notes"],
      ]) {
        if (!has(patch, field)) continue;
        const value = patch[field] == null || patch[field] === "" ? null : String(patch[field]);
        if (value !== current[column]) { set[column] = value; note(history, current[column], value); }
      }
      if (has(patch, "category")) {
        const value = patch.category == null ? null : (String(patch.category).trim() || null);
        if (value !== current.category) { set.category = value; note("category", current.category, value); }
      }
      if (has(patch, "catalog_type") || has(patch, "visibility")) {
        const visibility = has(patch, "visibility")
          ? (patch.visibility === "sellable" ? "sellable" : "internal")
          : visibilityOfCatalogType(patch.catalog_type);
        if (visibility !== current.visibility) {
          set.visibility = visibility;
          note("catalog_type", current.visibility === "sellable" ? "goods_service" : "component", visibility === "sellable" ? "goods_service" : "component");
        }
      }
      if (has(patch, "status")) {
        const status = String(patch.status ?? "").trim().toLowerCase();
        if (!STATUSES.includes(status)) throw new CatalogError("INVALID", `status must be one of: ${STATUSES.join(", ")}`, { path: "status" });
        if (status !== current.status) { set.status = status; note("status", current.status, status); }
      }
      if (has(patch, "kind")) {
        const kind = patch.kind == null || patch.kind === "" ? null : String(patch.kind).trim().toLowerCase();
        if (kind && !KINDS.includes(kind)) throw new CatalogError("INVALID", `kind must be one of: ${KINDS.join(", ")}`, { path: "kind" });
        if (kind !== current.kind) { set.kind = kind; note("kind", current.kind, kind); }
      }
      if (has(patch, "type")) {
        const type = normalizeType(patch.type);
        if (type !== current.type) { set.type = type; note("type", current.type, type); }
      }
      if (has(patch, "tags")) {
        const tags = normalizeTags(patch.tags);
        if (JSON.stringify(tags) !== JSON.stringify(current.tags)) { set.tags = tags; note("tags", current.tags, tags); }
      }
      if (has(patch, "tax_code")) {
        const taxCode = String(patch.tax_code || "GST").trim();
        if (!state.taxCodes.has(taxCode)) throw new CatalogError("UNKNOWN_REF", `tax_code "${taxCode}" is not a known tax code`, { path: "tax_code" });
        if (taxCode !== current.taxCode) { set.taxCode = taxCode; note("tax_code", current.taxCode, taxCode); }
      }
      if (has(patch, "variant_of_uid") || has(patch, "variant_of")) {
        const variant = resolveVariant(state, has(patch, "variant_of_uid") ? patch.variant_of_uid : patch.variant_of, current.uid);
        if (variant !== current.variantOfUid) { set.variantOfUid = variant; note("variant_of_uid", current.variantOfUid, variant); }
      }

      // Name guard: only when the name key changes or the item becomes active.
      const effectiveName = set.name ?? current.name;
      const effectiveStatus = set.status ?? current.status;
      const nameKeyChanging = set.name != null && nameKey(set.name) !== nameKey(current.name);
      const reactivating = set.status === "active" && current.status !== "active";
      if (nameKeyChanging || reactivating) {
        assertNoActiveNameCollision(state, { name: effectiveName, status: effectiveStatus, excludeUid: current.uid });
      }

      // Costing basis (stored as an item conversion).
      let basisChanged = false;
      if (has(patch, "pricing_basis") || has(patch, "pricing_basis_factor")) {
        const nextBasis = has(patch, "pricing_basis") ? (patch.pricing_basis ?? null) : current.pricingBasis;
        const currentFactor = pricingBasisFactor(state, current);
        const nextFactor = has(patch, "pricing_basis_factor")
          ? optionalNumber(patch.pricing_basis_factor, "pricing_basis_factor")
          : currentFactor;
        validatePricingBasis({ pricing_basis: nextBasis, pricing_basis_factor: nextFactor });
        if (nextBasis !== current.pricingBasis) { set.pricingBasis = nextBasis; note("pricing_basis", current.pricingBasis, nextBasis); }
        if (nextFactor !== currentFactor || nextBasis !== current.pricingBasis) {
          basisChanged = true;
          note("pricing_basis_factor", currentFactor, nextFactor);
        }
        if (basisChanged) await writePricingBasis(tx, current.uid, nextBasis, nextFactor);
      }

      // Price modes.
      const modes = resolveModes(patch, current);
      if (modes.costMode !== current.costMode) {
        set.costMode = modes.costMode;
        note("buy_price_mode", current.costMode === "rollup" ? "computed" : "manual", modes.costMode === "rollup" ? "computed" : "manual");
      }
      if (modes.sellMode !== current.sellMode) {
        set.sellMode = modes.sellMode;
        if ((modes.sellMode === "rollup") !== (current.sellMode === "rollup")) {
          note("sell_price_mode", current.sellMode === "rollup" ? "computed" : "manual", modes.sellMode === "rollup" ? "computed" : "manual");
        }
        note("sell_mode", current.sellMode, modes.sellMode);
      }

      // A scheduled (future-dated) price row was written for the item's unit,
      // basis and price modes as they stand now; changing them would make that
      // row price a different thing on its date. Refuse, as for a price edit.
      const basisEdit = set.unitCode !== undefined || basisChanged || set.costMode !== undefined || set.sellMode !== undefined;
      if (basisEdit) {
        const [pending] = await selectRows(tx, sql`
          select id, effective_from from item_prices
          where item_uid = ${current.uid} and effective_from > ${now.toISOString()}::timestamptz
          order by effective_from limit 1`);
        if (pending) {
          throw new CatalogError("PENDING_PRICE_CHANGE", `Item ${current.code} has a price scheduled for ${toIso(pending.effective_from)} (price ${pending.id}) that was set for its current unit and pricing; change the unit, pricing basis or price mode after that date, or resolve the scheduled price first`, { path: set.unitCode !== undefined ? "unit" : "pricing_basis", details: { pendingPriceId: Number(pending.id), effectiveFrom: toIso(pending.effective_from) } });
        }
      }

      // Prices: append a row when the price changes.
      const row = state.prices.get(current.uid) || null;
      const nextCost = has(patch, "buy_price") ? optionalNumber(patch.buy_price, "buy_price") : (row?.cost ?? null);
      const nextSell = has(patch, "sell_price") ? optionalNumber(patch.sell_price, "sell_price") : (row?.sell ?? null);
      const nextMarkup = has(patch, "markup_pct") ? optionalNumber(patch.markup_pct, "markup_pct", { min: null }) : (row?.markupPct ?? null);
      const priceChanged = nextCost !== (row?.cost ?? null) || nextSell !== (row?.sell ?? null) || nextMarkup !== (row?.markupPct ?? null);
      if (priceChanged) {
        // Only a price change is dated; a name-only edit ignores effective_from.
        const priceEffectiveFrom = manualEffectiveFrom(effectiveFrom, now);
        // A new row is built from the current one, so it must become current.
        if (row?.effectiveFrom && priceEffectiveFrom.getTime() < Date.parse(row.effectiveFrom)) {
          throw new CatalogError("INVALID", `effective_from cannot be earlier than the current price (effective ${row.effectiveFrom}); the change would never take effect`, { path: "effective_from" });
        }
        // A row already scheduled for later (written outside this API) would
        // replace this edit on its date; refuse rather than lose it silently.
        const [pending] = await selectRows(tx, sql`
          select id, effective_from from item_prices
          where item_uid = ${current.uid} and effective_from > ${now.toISOString()}::timestamptz
          order by effective_from limit 1`);
        if (pending) {
          throw new CatalogError("PENDING_PRICE_CHANGE", `Item ${current.code} has a price scheduled for ${toIso(pending.effective_from)} (price ${pending.id}); that row would undo this change on its date, so resolve it first`, { path: "effective_from", details: { pendingPriceId: Number(pending.id), effectiveFrom: toIso(pending.effective_from) } });
        }
        await tx.insert(schema.itemPrices).values({
          itemUid: current.uid,
          costPerUnit: numericText(nextCost),
          markupPct: numericText(nextMarkup),
          sellPrice: numericText(nextSell),
          effectiveFrom: priceEffectiveFrom,
          source: "manual",
          changedBy: author,
          reason,
          createdAt: now,
        });
        note("buy_price", row?.cost ?? null, nextCost);
        note("sell_price", row?.sell ?? null, nextSell);
        note("markup_pct", row?.markupPct ?? null, nextMarkup);
      }

      if (!Object.keys(set).length && !priceChanged && !basisChanged) return { result: current.uid, changed: false };
      await tx.update(schema.items)
        .set({ ...set, version: sql`${schema.items.version} + 1`, updatedAt: now })
        .where(eq(schema.items.uid, current.uid));
      await recordHistory(tx, { item: { uid: current.uid, code: current.code }, changes, author, reason, now });
      return { result: current.uid };
    });
    if (!uid) return null;
    const state = await getState();
    return itemDetail(state, state.items.get(uid));
  }

  async function archiveItem(identity, options = {}) {
    return updateItem(identity, { status: "archived" }, options);
  }

  /**
   * Permanently delete an item. Kit links that use it go too (the parents
   * become unpriced if they roll up from it); its history stays.
   */
  async function deleteItem(identity, { author = "system", reason = null } = {}) {
    let before = null;
    await write(async (tx, state, now) => {
      const item = findItem(state, identity);
      if (!item) return { result: null, changed: false };
      before = itemDetail(state, item);
      const parents = [...new Set(state.parentsOf.get(item.uid) || [])];
      await tx.delete(schema.itemComponents).where(eq(schema.itemComponents.childUid, item.uid));
      await tx.delete(schema.items).where(eq(schema.items.uid, item.uid));
      for (const parentUid of parents) {
        const parent = state.items.get(parentUid);
        await touchItem(tx, parentUid, now);
        await recordHistory(tx, { item: parent, changes: [{ field: childHistoryField(item.code), oldValue: "linked", newValue: null }], author, reason, now });
      }
      await recordHistory(tx, { item, changes: [{ field: "*", oldValue: "existed", newValue: "deleted" }], author, reason, now });
      return { result: item.uid };
    });
    return before;
  }

  async function duplicateItem(identity, { code = null, name = null, status = "active" } = {}, { author = "system", reason = null } = {}) {
    const uid = await write(async (tx, state, now) => {
      const source = findItem(state, identity);
      if (!source) return { result: null, changed: false };
      const rootCode = String(code || "").trim();
      if (rootCode && state.byCode.has(normalizeCode(rootCode))) {
        throw new CatalogError("CODE_CONFLICT", `Item code '${rootCode}' already exists`, { path: "code" });
      }
      // A copy is a new item with its own identity: its code is its uid, the
      // same as any item created without one, never a "-copy" of the source.
      const duplicateUid = generateCatalogUid();
      const resolvedName = String(name || "").trim()
        || (status === "active" ? ensureUniqueActiveName(state, `Copy of ${source.name}`) : `Copy of ${source.name}`);
      const sourcePrice = state.prices.get(source.uid) || null;
      const prepared = prepareNewItem(state, {
        uid: duplicateUid,
        code: rootCode || duplicateUid,
        name: resolvedName,
        unit: source.unitLabel || source.unitCode,
        buy_price: sourcePrice?.cost ?? null,
        sell_price: sourcePrice?.sell ?? null,
        markup_pct: sourcePrice?.markupPct ?? null,
        cost_mode: source.costMode,
        sell_mode: source.sellMode,
        price_reference: source.priceReference,
        description: source.description,
        notes: source.notes,
        visibility: source.visibility,
        kind: source.kind,
        type: source.type,
        tags: source.tags,
        tax_code: source.taxCode,
        category: source.category,
        status,
        pricing_basis: source.pricingBasis,
        pricing_basis_factor: pricingBasisFactor(state, source),
      }, { now });
      await insertNewItem(tx, prepared, { author, reason: reason || `duplicated from ${source.code}`, now });

      const links = componentsOf(state, source, loadRecipeChildrenByParent());
      let linked = 0;
      const createdNames = new Set();
      for (let index = 0; index < links.length; index += 1) {
        const link = links[index];
        let childUid = link.childUid;
        if (!childUid && link.balance) {
          // A recipe balance row becomes a real component item of its own.
          const balanceCode = String(link.childCode || "").trim();
          if (!balanceCode) continue;
          const existing = state.byCode.get(normalizeCode(balanceCode));
          if (existing) childUid = existing;
          else {
            const balanceName = ensureUniqueActiveName(state, String(link.recipeChild?.name || balanceCode).trim() || balanceCode, createdNames);
            createdNames.add(nameKey(balanceName));
            const balance = prepareNewItem(state, {
              code: balanceCode,
              name: balanceName,
              unit: link.recipeChild?.unit && link.recipeChild.unit !== "unit" ? link.recipeChild.unit : (source.unitLabel || source.unitCode),
              buy_price: sourcePrice?.cost ?? null,
              sell_price: sourcePrice?.sell ?? null,
              price_reference: `Recipe balance item linked from ${source.code}.`,
              catalog_type: "component",
              category: source.category,
              status: "active",
            }, { now });
            await insertNewItem(tx, balance, { author, reason, now });
            childUid = balance.row.uid;
          }
        }
        if (!childUid) continue;
        await tx.insert(schema.itemComponents).values({
          parentUid: prepared.row.uid,
          childUid,
          quantity: String(Number(link.quantity || 1)),
          entryQuantity: numericText(link.entryQuantity),
          entryUnit: link.entryUnit,
          applicationMode: link.applicationMode,
          pricingContribution: link.pricingContribution,
          sortOrder: typeof link.sortOrder === "number" ? link.sortOrder : index,
          createdAt: now,
        }).onConflictDoNothing();
        linked += 1;
      }
      const changes = [{ field: "*", oldValue: source.code, newValue: "duplicated" }];
      if (linked) changes.unshift({ field: "children", oldValue: null, newValue: `linked ${linked} existing component items from ${source.code}` });
      await recordHistory(tx, { item: prepared.row, changes, author, reason, now });
      return { result: prepared.row.uid };
    });
    if (!uid) return null;
    const state = await getState();
    return itemDetail(state, state.items.get(uid));
  }

  // ── Kit components ──

  function resolveEntry(state, child, entryQuantity, entryUnit) {
    const quantity = normalizeOptionalQuantity(entryQuantity);
    if (quantity == null) return { entryQuantity: null, entryUnit: null };
    if (entryUnit == null || String(entryUnit).trim() === "") return { entryQuantity: quantity, entryUnit: null };
    const unit = requireUnitCode(state, entryUnit, "entry_unit");
    if (!canConvert(state, unit, child.unitCode, { itemUid: child.uid })) {
      throw new CatalogError(
        "UNIT_MISMATCH",
        `${child.name} (${child.code}) is priced per ${displayUnit(child)}; a quantity in ${unit} cannot be converted to it`,
        { path: "entry_unit" },
      );
    }
    return { entryQuantity: quantity, entryUnit: unit };
  }

  async function addChild({ parentCode, childCode, quantity = 1, entryQuantity = null, entryUnit = null, applicationMode = "proportional", pricingContribution = "included", sortOrder = 0 } = {}, { author = "system", reason = null, expectedCatalogVersion = null } = {}) {
    const link = await write(async (tx, state, now) => {
      const parent = findItem(state, parentCode);
      if (!parent) throw new CatalogError("NOT_FOUND", `Parent item '${parentCode}' not found`, { status: 400 });
      const child = findItem(state, childCode);
      if (!child) throw new CatalogError("NOT_FOUND", `Child item '${childCode}' not found`, { status: 400 });
      if (parent.uid === child.uid) throw new CatalogError("CYCLE", `Cannot add item '${parent.code}' as a child of itself`, { status: 400 });
      if (wouldCycle(state, parent.uid, child.uid)) {
        throw new CatalogError("CYCLE", `Adding '${child.code}' under '${parent.code}' would create a cycle`);
      }
      if ((state.components.get(parent.uid) || []).some((c) => c.childUid === child.uid)) {
        throw new CatalogError("INVALID", `'${child.code}' is already a component of '${parent.code}'`, { path: "child_code" });
      }
      const qty = requireQuantity(quantity);
      const entry = resolveEntry(state, child, entryQuantity, entryUnit);
      await tx.insert(schema.itemComponents).values({
        parentUid: parent.uid,
        childUid: child.uid,
        quantity: String(qty),
        entryQuantity: numericText(entry.entryQuantity),
        entryUnit: entry.entryUnit,
        applicationMode: normalizeApplicationMode(applicationMode),
        pricingContribution: normalizePricingContribution(pricingContribution),
        sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
        createdAt: now,
      });
      await touchItem(tx, parent.uid, now);
      const changes = [{ field: childHistoryField(child.code), oldValue: null, newValue: `added x${qty}` }];
      // An item with components is a kit.
      if (parent.type !== "kit") {
        await tx.update(schema.items).set({ type: "kit" }).where(eq(schema.items.uid, parent.uid));
        changes.push({ field: "type", oldValue: parent.type, newValue: "kit" });
      }
      await recordHistory(tx, { item: parent, changes, author, reason, now });
      return { result: { parentUid: parent.uid, childUid: child.uid } };
    }, { expectedCatalogVersion });
    const state = await getState();
    const component = (state.components.get(link.parentUid) || []).find((c) => c.childUid === link.childUid);
    return childRow(state, component);
  }

  async function updateChild({ parentCode, childCode, quantity, entryQuantity, entryUnit, applicationMode, pricingContribution, sortOrder } = {}, { author = "system", reason = null, expectedCatalogVersion = null } = {}) {
    const link = await write(async (tx, state, now) => {
      const parent = findItem(state, parentCode);
      if (!parent) throw new CatalogError("NOT_FOUND", `Parent item '${parentCode}' not found`, { status: 400 });
      const child = findItem(state, childCode);
      const existing = child && (state.components.get(parent.uid) || []).find((c) => c.childUid === child.uid);
      if (!existing) return { result: null, changed: false };
      const nextQuantity = quantity === undefined || quantity === null ? existing.quantity : requireQuantity(quantity);
      let nextEntryQuantity = existing.entryQuantity;
      let nextEntryUnit = existing.entryUnit;
      if (entryQuantity !== undefined || entryUnit !== undefined) {
        const entry = resolveEntry(
          state,
          child,
          entryQuantity === undefined ? existing.entryQuantity : entryQuantity,
          entryUnit === undefined ? existing.entryUnit : entryUnit,
        );
        nextEntryQuantity = entry.entryQuantity;
        nextEntryUnit = entry.entryUnit;
      }
      const nextApplicationMode = applicationMode === undefined ? existing.applicationMode : normalizeApplicationMode(applicationMode);
      const nextContribution = pricingContribution === undefined ? existing.pricingContribution : normalizePricingContribution(pricingContribution);
      const nextSortOrder = sortOrder === undefined || sortOrder === null ? existing.sortOrder : Number(sortOrder);
      const changes = [
        { field: childHistoryField(child.code, "quantity"), oldValue: existing.quantity, newValue: nextQuantity },
        { field: childHistoryField(child.code, "entry_quantity"), oldValue: existing.entryQuantity, newValue: nextEntryQuantity },
        { field: childHistoryField(child.code, "entry_unit"), oldValue: existing.entryUnit, newValue: nextEntryUnit },
        { field: childHistoryField(child.code, "application_mode"), oldValue: existing.applicationMode, newValue: nextApplicationMode },
        { field: childHistoryField(child.code, "pricing_contribution"), oldValue: existing.pricingContribution, newValue: nextContribution },
        { field: childHistoryField(child.code, "sort_order"), oldValue: existing.sortOrder, newValue: nextSortOrder },
      ];
      const changed = changes.some((c) => storageValue(c.oldValue) !== storageValue(c.newValue));
      if (!changed) return { result: { parentUid: parent.uid, childUid: child.uid }, changed: false };
      await tx.update(schema.itemComponents).set({
        quantity: String(nextQuantity),
        entryQuantity: numericText(nextEntryQuantity),
        entryUnit: nextEntryUnit,
        applicationMode: nextApplicationMode,
        pricingContribution: nextContribution,
        sortOrder: nextSortOrder,
      }).where(eq(schema.itemComponents.id, existing.id));
      await touchItem(tx, parent.uid, now);
      await recordHistory(tx, { item: parent, changes, author, reason, now });
      return { result: { parentUid: parent.uid, childUid: child.uid } };
    }, { expectedCatalogVersion });
    if (!link) return null;
    const state = await getState();
    const component = (state.components.get(link.parentUid) || []).find((c) => c.childUid === link.childUid);
    return childRow(state, component);
  }

  async function removeChild({ parentCode, childCode } = {}, { author = "system", reason = null, expectedCatalogVersion = null } = {}) {
    return write(async (tx, state, now) => {
      const parent = findItem(state, parentCode);
      const child = findItem(state, childCode);
      const existing = parent && child && (state.components.get(parent.uid) || []).find((c) => c.childUid === child.uid);
      if (!existing) return { result: null, changed: false };
      await tx.delete(schema.itemComponents).where(eq(schema.itemComponents.id, existing.id));
      await touchItem(tx, parent.uid, now);
      await recordHistory(tx, { item: parent, changes: [{ field: childHistoryField(child.code), oldValue: `x${existing.quantity}`, newValue: null }], author, reason, now });
      return { result: true };
    }, { expectedCatalogVersion });
  }

  // ── Categories ──

  async function createCategory({ name } = {}, { expectedCatalogVersion = null } = {}) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new CatalogError("INVALID", "name is required", { path: "name" });
    const id = await write(async (tx, state, now) => {
      if (state.categories.some((category) => category.name.toLowerCase() === trimmed.toLowerCase())) {
        throw new CatalogError("CATEGORY_CONFLICT", `Category '${trimmed}' already exists`, { path: "name" });
      }
      const sortOrder = state.categories.reduce((max, category) => Math.max(max, category.sort_order + 1), 0);
      const [row] = await tx.insert(schema.categories).values({ name: trimmed, sortOrder, createdAt: now, updatedAt: now }).returning({ id: schema.categories.id });
      return { result: row.id };
    }, { expectedCatalogVersion });
    return (await listCategories()).find((category) => category.id === Number(id));
  }

  async function updateCategory(id, { name } = {}, { expectedCatalogVersion = null } = {}) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) throw new CatalogError("INVALID", "invalid id", { path: "id" });
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new CatalogError("INVALID", "name cannot be empty", { path: "name" });
    await write(async (tx, state, now) => {
      if (!state.categories.some((category) => category.id === numId)) throw new CatalogError("NOT_FOUND", "not found");
      if (state.categories.some((category) => category.id !== numId && category.name.toLowerCase() === trimmed.toLowerCase())) {
        throw new CatalogError("CATEGORY_CONFLICT", `Category '${trimmed}' already exists`, { path: "name" });
      }
      await tx.update(schema.categories).set({ name: trimmed, updatedAt: now }).where(eq(schema.categories.id, numId));
      return { result: numId };
    }, { expectedCatalogVersion });
    return (await listCategories()).find((category) => category.id === numId);
  }

  /** Set the category order: `ids` first, in that order, then any not named, as they were. */
  async function reorderCategories(ids = [], { expectedCatalogVersion = null } = {}) {
    if (!Array.isArray(ids)) throw new CatalogError("INVALID", "ids must be a list of category ids", { path: "ids" });
    const wanted = ids.map(Number);
    if (wanted.some((id) => !Number.isFinite(id))) throw new CatalogError("INVALID", "ids must be category ids", { path: "ids" });
    await write(async (tx, state, now) => {
      const known = new Set(state.categories.map((category) => category.id));
      const missing = wanted.find((id) => !known.has(id));
      if (missing !== undefined) throw new CatalogError("NOT_FOUND", `Category ${missing} not found`, { path: "ids" });
      const order = [...new Set(wanted), ...state.categories.map((category) => category.id).filter((id) => !wanted.includes(id))];
      let changed = false;
      for (const [index, id] of order.entries()) {
        if (state.categories.find((category) => category.id === id)?.sort_order === index) continue;
        changed = true;
        await tx.update(schema.categories).set({ sortOrder: index, updatedAt: now }).where(eq(schema.categories.id, id));
      }
      return { result: true, changed };
    }, { expectedCatalogVersion });
    return listCategories();
  }

  async function deleteCategory(id, { expectedCatalogVersion = null } = {}) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) throw new CatalogError("INVALID", "invalid id", { path: "id" });
    await write(async (tx, state) => {
      if (!state.categories.some((category) => category.id === numId)) throw new CatalogError("NOT_FOUND", "not found");
      await tx.delete(schema.categories).where(eq(schema.categories.id, numId));
      return { result: true };
    }, { expectedCatalogVersion });
    return { ok: true };
  }

  // ── Evidence (supplier quotes, links, notes) ──

  async function attachEvidence({ itemCode, side = "general", kind, filePath = null, url = null, note = null, supplier = null, originalFilename = null, mimeType = null } = {}, { author = "system", dataDir: evidenceDataDir = dataDir } = {}) {
    const { item } = await requireItem(itemCode);
    if (!item) throw new CatalogError("NOT_FOUND", `Item '${itemCode}' not found`, { status: 400 });
    if (!["buy", "sell", "general"].includes(side)) throw new CatalogError("INVALID", "side must be buy, sell or general", { path: "side" });
    let storedFilePath = null;
    if (kind === "file") {
      if (!filePath) throw new CatalogError("INVALID", "filePath is required for file evidence");
      if (!evidenceDataDir) throw new CatalogError("INVALID", "dataDir is required for file evidence");
      const ext = originalFilename ? extname(originalFilename) : extname(filePath);
      const dir = join(evidenceDataDir, "price-catalog", "attachments", item.uid);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const filename = `${randomUUID()}${ext}`;
      copyFileSync(filePath, join(dir, filename));
      storedFilePath = join("price-catalog", "attachments", item.uid, filename);
    }
    if (kind === "link" && !url) throw new CatalogError("INVALID", "url is required for link evidence");
    const [row] = await db.transaction((tx) => tx.insert(schema.catalogEvidence).values({
      itemUid: item.uid,
      side,
      kind,
      filePath: storedFilePath,
      url: kind === "link" ? url : null,
      note,
      supplier,
      mimeType: kind === "file" ? mimeType : null,
      originalFilename: kind === "file" ? originalFilename : null,
      createdBy: author,
      createdAt: clock(),
    }).returning());
    return {
      id: row.id,
      item_uid: row.itemUid,
      item_code: item.code,
      side: row.side,
      kind: row.kind,
      file_path: row.filePath,
      url: row.url,
      note: row.note,
      supplier: row.supplier,
      mime_type: row.mimeType,
      original_filename: row.originalFilename,
      created_by: row.createdBy,
      created_at: toIso(row.createdAt),
    };
  }

  async function removeEvidence(evidenceId, { dataDir: evidenceDataDir = dataDir } = {}) {
    const [record] = await db.transaction((tx) => tx.select().from(schema.catalogEvidence).where(eq(schema.catalogEvidence.id, Number(evidenceId))));
    if (!record) return null;
    if (record.kind === "file" && record.filePath && evidenceDataDir) {
      const absPath = join(evidenceDataDir, record.filePath);
      if (existsSync(absPath)) unlinkSync(absPath);
    }
    await db.transaction((tx) => tx.delete(schema.catalogEvidence).where(eq(schema.catalogEvidence.id, Number(evidenceId))));
    return record;
  }

  return {
    db,
    orgUid,
    getState,
    invalidate: () => { cached = null; },
    // reads
    listItems,
    getItem,
    getItemWithPricing: getItem,
    resolveIdentity,
    getItemsByUids,
    getCurrentPrice,
    getCurrentPrices,
    getKitSnapshot,
    listChildren,
    getPriceMaps,
    catalogVersion,
    listCategories,
    health,
    getItemHistory,
    getPriceHistory,
    getCatalogAtPointInTime,
    listEvidence,
    // writes
    createItem,
    updateItem,
    archiveItem,
    deleteItem,
    duplicateItem,
    addChild,
    updateChild,
    removeChild,
    createCategory,
    updateCategory,
    reorderCategories,
    deleteCategory,
    attachEvidence,
    removeEvidence,
    // For catalogue modules that write in the same serialised, versioned
    // transaction as the store (price-book bulk edits, supplier imports):
    // write(fn) runs fn(tx, state, now) under the catalogue write lock.
    write,
    prepareNewItem,
    insertNewItem,
  };
}

/** Units, tax codes and the version row; safe to run on every boot. */
export { ensureCatalogReferenceData };

export async function countCatalogItems(db) {
  const [row] = await selectRows(db, sql`select count(*)::int as count from items`);
  return Number(row?.count || 0);
}

