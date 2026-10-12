// Supplier price-list import (#148 section 5.4): upload a CSV, map its
// columns (saved per supplier), stage it as price_import_rows classified
// against the catalogue (changed / unchanged / new / missing / ambiguous /
// invalid, with old → new cost and delta %), then apply the chosen rows in
// one catalogue transaction from an effective date, or discard the batch.
//
// Nothing is ever deleted: an item a supplier file no longer lists is staged
// as "missing" and kept unless someone chooses to archive it. Staging writes
// only the import tables; the catalogue changes on apply.
//
// price_import_rows.raw holds the row's evidence as JSON:
//   { cells, parsed, matchedBy, item, candidates, basePriceId, basis, issues, flags }
// cells are the file's values by header; parsed the mapped values; item the
// matched item at staging; basePriceId the item's current price row then, so
// apply refuses rows whose item was re-priced in between; basis how the
// file's price became a cost per item unit (item unit, pack, price unit,
// conversion factor, price modes), so apply refuses rows whose item unit,
// pack or conversion changed in between (a unit edit adds no price row).
//
// An import staged with no effective date takes effect when it is applied
// (effective_from stays null until then).
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { nameKey } from "../../shared/catalog-name-key.js";
import { schema } from "../db-runtime/index.js";
import { decodePriceListBytes, guessColumnMap, parseCsv, parseMoney, validateColumnMap } from "./csv.js";
import { CatalogError } from "./errors.js";
import { LARGE_CHANGE_PCT, getSupplier, loadPendingPrices, marginPct, marginWarnings, roundMoney, roundRate, saveSupplierImportProfile } from "./price-book.js";
import { effectivePrices } from "./rollup.js";
import { normalizeCode, selectRows, toIso, toNumber } from "./state.js";
import { recordHistory } from "./store.js";
import { conversionFactor, resolveUnitCode } from "./units.js";
import { displayUnit } from "./views.js";

export const IMPORT_MATCHES = Object.freeze(["changed", "unchanged", "new", "missing", "ambiguous", "invalid"]);

/**
 * The decisions each match allows; the first is the staged default, except
 * that a changed row matched only by name, or whose cost moves more than
 * LARGE_CHANGE_PCT, is staged as skip so it is applied only when chosen.
 */
export const IMPORT_DECISIONS = Object.freeze({
  changed: Object.freeze(["apply", "skip"]),
  unchanged: Object.freeze(["skip"]),
  new: Object.freeze(["skip", "create"]),
  missing: Object.freeze(["skip", "archive"]),
  ambiguous: Object.freeze(["skip"]),
  invalid: Object.freeze(["skip"]),
});

const EPSILON = 0.00005;

function importError(code, message, extra = {}) {
  return new CatalogError(code, message, { status: code === "IMPORT_NOT_STAGED" ? 409 : undefined, ...extra });
}

function linkKey(supplierId, code) {
  return `${supplierId}\u0000${normalizeCode(code)}`;
}

async function loadLinksForSupplier(db, supplierId) {
  const rows = await selectRows(db, sql`
    select id, item_uid, supplier_code, pack_qty, pack_unit, is_default
    from item_suppliers where supplier_id = ${Number(supplierId)} order by id`);
  return rows.map((row) => ({
    id: Number(row.id),
    itemUid: row.item_uid,
    supplierCode: row.supplier_code ?? null,
    packQty: toNumber(row.pack_qty) ?? 1,
    packUnit: row.pack_unit ?? null,
    isDefault: Boolean(row.is_default),
  }));
}

/**
 * How a file price becomes a cost per the item's unit: the pack it is sold
 * in, the unit it is priced per and the conversion between that and the
 * item's unit. factor is null when there is no conversion. Staging records
 * it; apply recomputes it and refuses the row when it differs.
 */
function costBasis(state, item, link, parsed) {
  const fileUnit = parsed?.unit ? resolveUnitCode(state, parsed.unit) : null;
  const packQty = link?.packQty || 1;
  const priceUnit = fileUnit || link?.packUnit || item.unitCode;
  return {
    unitCode: item.unitCode,
    costMode: item.costMode,
    sellMode: item.sellMode,
    linkId: link?.id ?? null,
    packQty,
    packUnit: link?.packUnit ?? null,
    priceUnit,
    factor: conversionFactor(state, item.unitCode, priceUnit, { itemUid: item.uid }),
  };
}

const BASIS_FIELDS = Object.freeze(["unitCode", "costMode", "sellMode", "linkId", "packQty", "packUnit", "priceUnit"]);

function basisDiffers(staged, current) {
  if (!staged || !current || current.factor == null || staged.factor == null) return true;
  if (BASIS_FIELDS.some((field) => (staged[field] ?? null) !== (current[field] ?? null))) return true;
  return Math.abs(Number(staged.factor) - Number(current.factor)) > 1e-9;
}

function itemRef(item) {
  return item ? { uid: item.uid, code: item.code, name: item.name, unit: displayUnit(item), status: item.status } : null;
}

/** Read a file's headers, the first rows and a guessed (or the supplier's saved) column map. */
export async function inspectPriceList(store, { bytes, supplierUid = null } = {}) {
  const parsed = parseCsv(decodePriceListBytes(bytes));
  const supplier = supplierUid ? await getSupplier(store.db, supplierUid) : null;
  const saved = supplier?.import_profile?.columnMap || null;
  const savedFits = saved && Object.values(saved).every((header) => !header || parsed.headers.includes(header));
  return {
    delimiter: parsed.delimiter,
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    sampleRows: parsed.rows.slice(0, 5),
    columnMap: savedFits ? saved : guessColumnMap(parsed.headers),
    columnMapSource: savedFits ? "supplier" : "guess",
  };
}

/**
 * Classify parsed rows against a catalogue snapshot. Pure: takes the
 * snapshot, the supplier's links and pending (future-dated) prices.
 */
export function classifyPriceList(state, { headers, rows, columnMap, supplierId, links, pending = new Map(), delimiter = "," }) {
  // A ;-separated file usually comes from a decimal-comma locale.
  const money = (text) => parseMoney(text, { decimalComma: delimiter === ";" });
  const prices = effectivePrices(state);
  const col = Object.fromEntries(Object.entries(columnMap).map(([field, header]) => [field, headers.indexOf(header)]));
  const cell = (row, field) => (col[field] == null || col[field] < 0 ? "" : String(row[col[field]] ?? "").trim());
  const linksByCode = new Map();
  for (const link of links) {
    if (!link.supplierCode) continue;
    const key = linkKey(supplierId, link.supplierCode);
    if (!linksByCode.has(key)) linksByCode.set(key, []);
    linksByCode.get(key).push(link);
  }
  const activeByName = new Map();
  for (const item of state.items.values()) {
    if (item.status !== "active") continue;
    const key = nameKey(item.name);
    if (!key) continue;
    if (!activeByName.has(key)) activeByName.set(key, []);
    activeByName.get(key).push(item);
  }
  const fileCodeCounts = new Map();
  for (const row of rows) {
    const code = cell(row, "supplier_code");
    if (code) fileCodeCounts.set(normalizeCode(code), (fileCodeCounts.get(normalizeCode(code)) || 0) + 1);
  }

  const out = [];
  const matchedUids = new Set();
  rows.forEach((row, index) => {
    const cells = Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ""]));
    const parsed = {
      supplierCode: cell(row, "supplier_code") || null,
      itemCode: cell(row, "item_code") || null,
      name: cell(row, "name") || null,
      unit: cell(row, "unit") || null,
      cost: money(cell(row, "cost")),
      sell: columnMap.sell ? money(cell(row, "sell")) : null,
    };
    const issues = [];
    const flags = [];
    const record = { rowNo: index + 1, supplierCode: parsed.supplierCode, match: "invalid", itemUid: null, oldCost: null, newCost: null, oldSell: null, newSell: null, deltaPct: null };
    const raw = { cells, parsed: { ...parsed, cost: Number.isNaN(parsed.cost) ? null : parsed.cost, sell: Number.isNaN(parsed.sell) ? null : parsed.sell }, matchedBy: null, item: null, candidates: [], basePriceId: null, issues, flags };
    const finish = (match, decision = IMPORT_DECISIONS[match][0]) => {
      out.push({ ...record, match, decision, raw });
    };
    const notNumber = (field) => {
      const text = cell(row, field);
      return delimiter === ";" && text.includes(",")
        ? `${field === "cost" ? "Cost" : "Sell"} "${text}" is ambiguous in a ;-separated file: read it as a decimal comma (12,75) or write it without thousands separators`
        : `${field === "cost" ? "Cost" : "Sell"} "${text}" is not a number`;
    };

    if (parsed.cost == null) issues.push({ code: "missing_cost", message: "No cost in this row" });
    else if (Number.isNaN(parsed.cost)) issues.push({ code: "bad_cost", message: notNumber("cost") });
    else if (parsed.cost < 0) issues.push({ code: "negative_cost", message: "Cost is negative" });
    if (Number.isNaN(parsed.sell)) issues.push({ code: "bad_sell", message: notNumber("sell") });
    else if (parsed.sell != null && parsed.sell < 0) issues.push({ code: "negative_sell", message: "Sell is negative" });
    const fileUnit = parsed.unit ? resolveUnitCode(state, parsed.unit) : null;
    if (parsed.unit && !fileUnit) issues.push({ code: "unknown_unit", message: `Unit "${parsed.unit}" is not one of Field's units` });
    if (!parsed.supplierCode && !parsed.itemCode && !parsed.name) issues.push({ code: "no_identity", message: "No supplier code, item code or name to match on" });
    if (issues.length) return finish("invalid");

    // Find the item: the supplier's own code first, then Field's code, then an exact active name.
    if (parsed.supplierCode && (fileCodeCounts.get(normalizeCode(parsed.supplierCode)) || 0) > 1) {
      issues.push({ code: "duplicate_in_file", message: `Supplier code ${parsed.supplierCode} appears ${fileCodeCounts.get(normalizeCode(parsed.supplierCode))} times in the file` });
      return finish("ambiguous");
    }
    const bySupplier = parsed.supplierCode ? (linksByCode.get(linkKey(supplierId, parsed.supplierCode)) || []) : [];
    const bySupplierUids = [...new Set(bySupplier.map((link) => link.itemUid))];
    const byCodeUid = parsed.itemCode ? state.byCode.get(normalizeCode(parsed.itemCode)) || null : null;
    let item = null;
    let link = null;
    if (bySupplierUids.length > 1) {
      raw.candidates = bySupplierUids.map((uid) => itemRef(state.items.get(uid)));
      issues.push({ code: "several_items", message: `Supplier code ${parsed.supplierCode} is linked to ${bySupplierUids.length} items` });
      return finish("ambiguous");
    }
    if (bySupplierUids.length === 1) {
      if (byCodeUid && byCodeUid !== bySupplierUids[0]) {
        raw.candidates = [itemRef(state.items.get(bySupplierUids[0])), itemRef(state.items.get(byCodeUid))];
        issues.push({ code: "codes_disagree", message: `Supplier code ${parsed.supplierCode} and item code ${parsed.itemCode} point at different items` });
        return finish("ambiguous");
      }
      item = state.items.get(bySupplierUids[0]);
      link = bySupplier[0];
      raw.matchedBy = "supplier_code";
    } else if (byCodeUid) {
      item = state.items.get(byCodeUid);
      raw.matchedBy = "item_code";
    } else if (parsed.name && !parsed.itemCode) {
      const sameName = activeByName.get(nameKey(parsed.name)) || [];
      if (sameName.length > 1) {
        raw.candidates = sameName.map(itemRef);
        issues.push({ code: "several_names", message: `${sameName.length} active items are named "${parsed.name}"` });
        return finish("ambiguous");
      }
      if (sameName.length === 1) {
        item = sameName[0];
        raw.matchedBy = "name";
        flags.push({ code: "name_match", message: "Matched by name only; check it is the same item before applying" });
      }
    }
    if (!item) {
      record.newCost = parsed.cost;
      record.newSell = parsed.sell;
      if (!parsed.name) flags.push({ code: "needs_name", message: "Add a name column to create this item" });
      if (!fileUnit) flags.push({ code: "needs_unit", message: "Add a unit column to create this item" });
      return finish("new");
    }
    if (matchedUids.has(item.uid)) {
      issues.push({ code: "item_twice", message: `${item.name} (${item.code}) is matched by more than one row` });
      raw.item = itemRef(item);
      return finish("ambiguous");
    }
    matchedUids.add(item.uid);
    raw.item = itemRef(item);
    record.itemUid = item.uid;
    if (item.costMode === "rollup") {
      issues.push({ code: "rollup_cost", message: `${item.name} (${item.code}) is priced from its components; import its components instead` });
      return finish("invalid");
    }
    if (pending.has(item.uid)) {
      issues.push({ code: "pending_price", message: `${item.name} (${item.code}) already has a price change scheduled for ${pending.get(item.uid).effective_from}` });
      return finish("invalid");
    }

    // Cost per item unit: the file's price per pack, per its unit.
    const basis = costBasis(state, item, link, parsed);
    const { packQty, priceUnit, factor } = basis;
    raw.basis = basis;
    if (factor == null) {
      issues.push({ code: "unit_mismatch", message: `The file prices per ${priceUnit}, ${item.name} (${item.code}) is per ${displayUnit(item)}, and there is no conversion between them` });
      return finish("invalid");
    }
    const newCost = roundRate((parsed.cost / packQty) * factor);
    if (packQty !== 1) flags.push({ code: "pack", message: `Pack of ${packQty}: cost divided by ${packQty}` });
    if (priceUnit !== item.unitCode) flags.push({ code: "converted", message: `Converted from per ${priceUnit} to per ${displayUnit(item)}` });

    const price = state.prices.get(item.uid) || null;
    const effective = prices.get(item.uid) || { cost: null, sell: null };
    raw.basePriceId = price?.id ?? null;
    record.oldCost = price?.cost ?? null;
    record.oldSell = effective.sell;
    record.newCost = newCost;
    let newSell = effective.sell;
    if (item.sellMode === "markup") newSell = price?.markupPct != null ? roundMoney(newCost * (1 + price.markupPct / 100)) : null;
    else if (item.sellMode === "fixed" && parsed.sell != null) newSell = roundMoney((parsed.sell / packQty) * factor);
    else if (item.sellMode === "rollup") newSell = effective.sell;
    record.newSell = newSell;
    if (record.oldCost != null && record.oldCost !== 0) record.deltaPct = Math.round(((newCost - record.oldCost) / record.oldCost) * 10000) / 100;
    if (item.status !== "active") flags.push({ code: "not_active", message: `${item.name} is ${item.status}` });
    if (parsed.sell != null && item.sellMode !== "fixed") flags.push({ code: "sell_ignored", message: `Sell column ignored: ${item.name}'s sell ${item.sellMode === "markup" ? "follows its markup" : "rolls up from its components"}` });
    if (record.deltaPct != null && Math.abs(record.deltaPct) > LARGE_CHANGE_PCT) flags.push({ code: "large_change", message: `Cost moves ${record.deltaPct > 0 ? "+" : ""}${record.deltaPct}%` });
    for (const warning of marginWarnings(newCost, newSell)) flags.push(warning);
    const costSame = record.oldCost != null && Math.abs(record.oldCost - newCost) < EPSILON;
    const sellSame = item.sellMode !== "fixed" || parsed.sell == null || (record.oldSell != null && Math.abs(record.oldSell - newSell) < EPSILON);
    if (costSame && sellSame) return finish("unchanged");
    const cautious = raw.matchedBy === "name" || flags.some((flag) => flag.code === "large_change");
    finish("changed", cautious ? "skip" : "apply");
  });

  // Items this supplier is linked to that the file did not list: kept, never deleted.
  let rowNo = rows.length;
  const listedCodes = new Set(rows.map((row) => normalizeCode(cell(row, "supplier_code"))).filter(Boolean));
  for (const link of links) {
    if (matchedUids.has(link.itemUid)) continue;
    if (link.supplierCode && listedCodes.has(normalizeCode(link.supplierCode))) continue;
    const item = state.items.get(link.itemUid);
    if (!item || item.status === "archived") continue;
    matchedUids.add(item.uid);
    rowNo += 1;
    const price = state.prices.get(item.uid) || null;
    out.push({
      rowNo,
      supplierCode: link.supplierCode,
      match: "missing",
      itemUid: item.uid,
      oldCost: price?.cost ?? null,
      newCost: null,
      oldSell: (prices.get(item.uid) || {}).sell ?? null,
      newSell: null,
      deltaPct: null,
      decision: "skip",
      raw: { cells: null, parsed: null, matchedBy: "supplier_link", item: itemRef(item), candidates: [], basePriceId: price?.id ?? null, issues: [], flags: [{ code: "not_in_file", message: "Not in this price list; kept unless you archive it" }] },
    });
  }
  return out;
}

function summarize(rows) {
  const counts = Object.fromEntries(IMPORT_MATCHES.map((match) => [match, 0]));
  for (const row of rows) counts[row.match] += 1;
  return counts;
}

/** null means "when applied": the apply transaction's time. */
function parseEffectiveFrom(value) {
  if (value === null || value === undefined || value === "") return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) throw new CatalogError("INVALID", "effective_from must be a date", { path: "effective_from" });
  return at;
}

/**
 * Stage a supplier price list. Returns the staged import (see getImport).
 * The column map is saved on the supplier for its next file.
 */
export async function stageImport(store, { supplierUid, bytes, fileName = null, columnMap, effectiveFrom = null, author = "system", clock = () => new Date() } = {}) {
  const supplier = supplierUid ? await getSupplier(store.db, supplierUid) : null;
  if (!supplier) throw new CatalogError("UNKNOWN_REF", "Choose a supplier for this price list", { path: "supplier_uid" });
  if (supplier.status !== "active") throw new CatalogError("INVALID", `${supplier.name} is archived`, { path: "supplier_uid" });
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  const parsed = parseCsv(decodePriceListBytes(buffer));
  const map = validateColumnMap(columnMap, parsed.headers);
  const now = clock();
  const at = parseEffectiveFrom(effectiveFrom);
  const state = await store.getState();
  const [links, pending] = await Promise.all([loadLinksForSupplier(store.db, supplier.id), loadPendingPrices(store.db, state.now)]);
  const rows = classifyPriceList(state, { headers: parsed.headers, rows: parsed.rows, columnMap: map, supplierId: supplier.id, links, pending, delimiter: parsed.delimiter });
  const uid = `imp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const counts = summarize(rows);
  await store.db.transaction(async (tx) => {
    const [record] = await tx.insert(schema.priceImports).values({
      uid,
      supplierId: supplier.id,
      fileName: fileName ? String(fileName).slice(0, 255) : null,
      fileSha256: createHash("sha256").update(buffer).digest("hex"),
      columnMap: map,
      effectiveFrom: at,
      status: "staged",
      summary: { counts, rowCount: parsed.rows.length, catalogVersion: state.version, delimiter: parsed.delimiter, headers: parsed.headers },
      createdBy: author,
      createdAt: now,
    }).returning({ id: schema.priceImports.id });
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(schema.priceImportRows).values(rows.slice(i, i + 500).map((row) => ({
        importId: Number(record.id),
        rowNo: row.rowNo,
        supplierCode: row.supplierCode,
        raw: row.raw,
        match: row.match,
        itemUid: row.itemUid,
        oldCost: row.oldCost == null ? null : String(row.oldCost),
        newCost: row.newCost == null ? null : String(row.newCost),
        oldSell: row.oldSell == null ? null : String(row.oldSell),
        newSell: row.newSell == null ? null : String(row.newSell),
        deltaPct: row.deltaPct == null ? null : String(row.deltaPct),
        decision: row.decision,
      })));
    }
  });
  await saveSupplierImportProfile(store.db, supplier.id, { columnMap: map, delimiter: parsed.delimiter, savedAt: now.toISOString() }, now);
  return getImport(store, uid);
}

function importRow(row) {
  const raw = typeof row.raw === "string" ? JSON.parse(row.raw) : (row.raw || {});
  return {
    row_no: Number(row.row_no),
    supplier_code: row.supplier_code ?? null,
    match: row.match,
    decision: row.decision ?? null,
    allowed_decisions: [...(IMPORT_DECISIONS[row.match] || ["skip"])],
    item_uid: row.item_uid ?? null,
    item: raw.item ?? null,
    name: raw.parsed?.name ?? raw.item?.name ?? null,
    unit: raw.parsed?.unit ?? raw.item?.unit ?? null,
    matched_by: raw.matchedBy ?? null,
    old_cost: toNumber(row.old_cost),
    new_cost: toNumber(row.new_cost),
    old_sell: toNumber(row.old_sell),
    new_sell: toNumber(row.new_sell),
    delta_pct: toNumber(row.delta_pct),
    old_margin_pct: marginPct(toNumber(row.old_cost), toNumber(row.old_sell)),
    new_margin_pct: marginPct(toNumber(row.new_cost), toNumber(row.new_sell)),
    issues: raw.issues || [],
    flags: raw.flags || [],
    candidates: raw.candidates || [],
    cells: raw.cells ?? null,
  };
}

function importHeader(row) {
  return {
    uid: row.uid,
    supplier_uid: row.supplier_uid ?? null,
    supplier_name: row.supplier_name ?? null,
    file_name: row.file_name ?? null,
    file_sha256: row.file_sha256 ?? null,
    column_map: row.column_map ?? null,
    effective_from: toIso(row.effective_from),
    status: row.status,
    summary: row.summary ?? null,
    created_by: row.created_by,
    created_at: toIso(row.created_at),
    applied_at: toIso(row.applied_at),
  };
}

const IMPORT_STATUSES = Object.freeze(["staged", "applied", "discarded"]);

export async function listImports(store, { status = null, limit = 50 } = {}) {
  if (status != null && (typeof status !== "string" || !IMPORT_STATUSES.includes(status))) {
    throw new CatalogError("INVALID", `status must be one of: ${IMPORT_STATUSES.join(", ")}`, { path: "status" });
  }
  const rows = await selectRows(store.db, status
    ? sql`select i.*, s.uid as supplier_uid, s.name as supplier_name from price_imports i left join suppliers s on s.id = i.supplier_id where i.status = ${status} order by i.created_at desc, i.id desc limit ${Number(limit) || 50}`
    : sql`select i.*, s.uid as supplier_uid, s.name as supplier_name from price_imports i left join suppliers s on s.id = i.supplier_id order by i.created_at desc, i.id desc limit ${Number(limit) || 50}`);
  return rows.map(importHeader);
}

export async function getImport(store, uid, { match = null } = {}) {
  const [header] = await selectRows(store.db, sql`
    select i.*, s.uid as supplier_uid, s.name as supplier_name
    from price_imports i left join suppliers s on s.id = i.supplier_id where i.uid = ${String(uid || "")}`);
  if (!header) return null;
  const rows = await selectRows(store.db, match
    ? sql`select * from price_import_rows where import_id = ${Number(header.id)} and match = ${match} order by row_no`
    : sql`select * from price_import_rows where import_id = ${Number(header.id)} order by row_no`);
  return { ...importHeader(header), rows: rows.map(importRow) };
}

async function lockStagedImport(tx, uid) {
  const [header] = await selectRows(tx, sql`select * from price_imports where uid = ${String(uid || "")} for update`);
  if (!header) throw new CatalogError("NOT_FOUND", `Import ${uid} does not exist`);
  if (header.status !== "staged") {
    throw importError("IMPORT_NOT_STAGED", `Import ${uid} was already ${header.status}`, { path: "uid", details: { status: header.status } });
  }
  return header;
}

export async function discardImport(store, uid, { author = "system", clock = () => new Date() } = {}) {
  await store.db.transaction(async (tx) => {
    const header = await lockStagedImport(tx, uid);
    const summary = { ...(header.summary || {}), discardedBy: author, discardedAt: clock().toISOString() };
    await tx.update(schema.priceImports).set({ status: "discarded", summary }).where(eq(schema.priceImports.id, Number(header.id)));
  });
  return getImport(store, uid);
}

function resolveDecisions(rows, overrides) {
  const input = overrides && typeof overrides === "object" ? overrides : {};
  const byRow = new Map(Object.entries(input).map(([rowNo, decision]) => [Number(rowNo), String(decision)]));
  for (const rowNo of byRow.keys()) {
    if (!rows.some((row) => Number(row.row_no) === rowNo)) throw new CatalogError("INVALID", `Row ${rowNo} is not in this import`, { path: `decisions.${rowNo}` });
  }
  return rows.map((row) => {
    const allowed = IMPORT_DECISIONS[row.match] || ["skip"];
    const decision = byRow.has(Number(row.row_no)) ? byRow.get(Number(row.row_no)) : (row.decision || allowed[0]);
    if (!allowed.includes(decision)) {
      throw new CatalogError("INVALID", `Row ${row.row_no} is ${row.match}; it can be ${allowed.join(" or ")}, not ${decision}`, { path: `decisions.${row.row_no}` });
    }
    return { ...row, stagedDecision: row.decision, decision };
  });
}

/**
 * Apply a staged import in one catalogue transaction. `decisions` overrides
 * the staged default per row number. Refused (and nothing changes) when the
 * import is no longer staged, when a row's item was re-priced since staging
 * (VERSION_CONFLICT: stage the file again), when an item has a scheduled
 * price, or when the effective date is before an item's current price.
 */
export async function applyImport(store, uid, { decisions = null, author = "system" } = {}) {
  let importId = null;
  const summary = await store.write(async (tx, state, now) => {
    const header = await lockStagedImport(tx, uid);
    importId = Number(header.id);
    const [supplier] = await selectRows(tx, sql`select id, name, default_markup_pct from suppliers where id = ${header.supplier_id}`);
    const rows = resolveDecisions(await selectRows(tx, sql`select * from price_import_rows where import_id = ${importId} order by row_no`), decisions);
    // Staged without a date: effective now, as it is applied (not backdated to staging).
    const effectiveFrom = header.effective_from == null
      ? now
      : (header.effective_from instanceof Date ? header.effective_from : new Date(header.effective_from));
    const pending = await loadPendingPrices(tx, now);
    const label = `Supplier import ${header.file_name || uid}${supplier ? ` (${supplier.name})` : ""}`;
    const createdCodes = new Set();
    const counts = { applied: 0, created: 0, archived: 0, skipped: 0 };

    const linkIfMissing = async (itemUid, supplierCode, isDefault) => {
      if (!supplier || !supplierCode) return;
      const existing = await selectRows(tx, sql`
        select item_uid from item_suppliers where supplier_id = ${Number(supplier.id)} and lower(supplier_code) = lower(${supplierCode})`);
      if (existing.length) return;
      await tx.insert(schema.itemSuppliers).values({ itemUid, supplierId: Number(supplier.id), supplierCode, isDefault });
    };

    for (const row of rows) {
      const raw = typeof row.raw === "string" ? JSON.parse(row.raw) : (row.raw || {});
      if (row.decision === "skip") { counts.skipped += 1; continue; }
      if (row.decision === "apply") {
        const item = state.items.get(row.item_uid);
        if (!item) throw new CatalogError("UNKNOWN_REF", `Row ${row.row_no}: the item it matched no longer exists; stage the file again`, { path: `rows.${row.row_no}` });
        const current = state.prices.get(item.uid) || null;
        if ((current?.id ?? null) !== (raw.basePriceId ?? null)) {
          throw new CatalogError("VERSION_CONFLICT", `${item.name} (${item.code}) was re-priced after this file was staged; stage the file again`, { path: `rows.${row.row_no}`, details: { uid: item.uid } });
        }
        // The staged cost was converted from the file's unit and pack; a unit,
        // pack or conversion edit since staging adds no price row, so check
        // the conversion itself rather than trusting the staged number.
        let link = null;
        if (raw.basis?.linkId != null) {
          const [current] = await selectRows(tx, sql`
            select id, pack_qty, pack_unit from item_suppliers where id = ${Number(raw.basis.linkId)} and item_uid = ${item.uid}`);
          if (current) link = { id: Number(current.id), packQty: toNumber(current.pack_qty) ?? 1, packUnit: current.pack_unit ?? null };
        }
        const basis = costBasis(state, item, link, raw.parsed);
        if (basisDiffers(raw.basis, basis)) {
          throw new CatalogError("VERSION_CONFLICT", `${item.name} (${item.code})'s unit, pack size or pricing changed after this file was staged (staged per ${raw.basis?.priceUnit ?? "?"} for a per ${raw.basis?.unitCode ?? "?"} item; now per ${displayUnit(item)}); stage the file again`, { path: `rows.${row.row_no}`, details: { uid: item.uid, staged: raw.basis ?? null, current: basis } });
        }
        if (pending.has(item.uid)) {
          throw new CatalogError("PENDING_PRICE_CHANGE", `${item.name} (${item.code}) has a price change scheduled for ${pending.get(item.uid).effective_from}`, { path: `rows.${row.row_no}` });
        }
        if (current?.effectiveFrom && effectiveFrom.getTime() < Date.parse(current.effectiveFrom)) {
          throw new CatalogError("INVALID", `The import's effective date is before ${item.name} (${item.code})'s current price (${current.effectiveFrom}); it would never take effect`, { path: "effective_from" });
        }
        const newCost = toNumber(row.new_cost);
        // Fixed: the file's sell when it has one. Markup: the sell the markup
        // gives on the new cost (recorded for history; pricing derives it).
        const sell = (item.sellMode === "fixed" && raw.parsed?.sell != null) || item.sellMode === "markup"
          ? toNumber(row.new_sell)
          : (current?.sell ?? null);
        await tx.insert(schema.itemPrices).values({
          itemUid: item.uid,
          supplierId: supplier ? Number(supplier.id) : null,
          costPerUnit: newCost == null ? null : String(newCost),
          markupPct: current?.markupPct == null ? null : String(current.markupPct),
          sellPrice: sell == null ? null : String(sell),
          effectiveFrom,
          source: "import",
          sourceRef: uid,
          changedBy: author,
          reason: label,
          createdAt: now,
        });
        if (raw.matchedBy !== "supplier_code") {
          const links = await selectRows(tx, sql`select id from item_suppliers where item_uid = ${item.uid}`);
          await linkIfMissing(item.uid, raw.parsed?.supplierCode, links.length === 0);
        }
        await tx.update(schema.items).set({ version: sql`${schema.items.version} + 1`, updatedAt: now }).where(eq(schema.items.uid, item.uid));
        await recordHistory(tx, {
          item,
          changes: [
            { field: "buy_price", oldValue: current?.cost ?? null, newValue: newCost },
            { field: "sell_price", oldValue: current?.sell ?? null, newValue: sell },
          ],
          author,
          reason: effectiveFrom.getTime() > now.getTime() ? `${label}, effective ${effectiveFrom.toISOString()}` : label,
          now,
        });
        counts.applied += 1;
        continue;
      }
      if (row.decision === "create") {
        const parsed = raw.parsed || {};
        if (!parsed.name) throw new CatalogError("INVALID", `Row ${row.row_no}: a new item needs a name (map a name column)`, { path: `rows.${row.row_no}` });
        if (!parsed.unit || !resolveUnitCode(state, parsed.unit)) throw new CatalogError("INVALID", `Row ${row.row_no}: a new item needs a known unit (map a unit column)`, { path: `rows.${row.row_no}` });
        const code = parsed.itemCode || null;
        if (code && (state.byCode.has(normalizeCode(code)) || createdCodes.has(normalizeCode(code)))) {
          throw new CatalogError("CODE_CONFLICT", `Row ${row.row_no}: item code ${code} already exists`, { path: `rows.${row.row_no}` });
        }
        const markup = toNumber(supplier?.default_markup_pct);
        const prepared = store.prepareNewItem(state, { code, name: parsed.name, unit: parsed.unit, status: "draft", sell_mode: markup != null ? "markup" : "fixed" }, { now });
        createdCodes.add(normalizeCode(prepared.row.code));
        await store.insertNewItem(tx, prepared, { author, reason: label, now });
        await tx.insert(schema.itemPrices).values({
          itemUid: prepared.row.uid,
          supplierId: supplier ? Number(supplier.id) : null,
          costPerUnit: parsed.cost == null ? null : String(parsed.cost),
          markupPct: markup == null ? null : String(markup),
          sellPrice: markup == null && parsed.sell != null ? String(parsed.sell) : null,
          effectiveFrom,
          source: "import",
          sourceRef: uid,
          changedBy: author,
          reason: label,
          createdAt: now,
        });
        await linkIfMissing(prepared.row.uid, parsed.supplierCode, true);
        await tx.update(schema.priceImportRows).set({ itemUid: prepared.row.uid })
          .where(sql`${schema.priceImportRows.importId} = ${importId} and ${schema.priceImportRows.rowNo} = ${Number(row.row_no)}`);
        counts.created += 1;
        continue;
      }
      if (row.decision === "archive") {
        const item = state.items.get(row.item_uid);
        if (!item) { counts.skipped += 1; continue; }
        if (item.status !== "archived") {
          await tx.update(schema.items).set({ status: "archived", version: sql`${schema.items.version} + 1`, updatedAt: now }).where(eq(schema.items.uid, item.uid));
          await recordHistory(tx, { item, changes: [{ field: "status", oldValue: item.status, newValue: "archived" }], author, reason: `${label}: not in the supplier's price list`, now });
        }
        counts.archived += 1;
      }
    }

    for (const row of rows) {
      if (row.decision === row.stagedDecision) continue;
      await tx.update(schema.priceImportRows).set({ decision: row.decision })
        .where(sql`${schema.priceImportRows.importId} = ${importId} and ${schema.priceImportRows.rowNo} = ${Number(row.row_no)}`);
    }
    const result = { ...(header.summary || {}), result: counts, appliedBy: author };
    await tx.update(schema.priceImports).set({ status: "applied", appliedAt: now, effectiveFrom, summary: result }).where(eq(schema.priceImports.id, importId));
    return { result: counts, changed: counts.applied + counts.created + counts.archived > 0 };
  });
  const record = await getImport(store, uid);
  return { ...record, result: summary };
}
