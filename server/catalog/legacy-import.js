// Import a legacy SQLite catalogue (data/price-catalog/catalog.db, schema up
// to v21) into the PostgreSQL catalogue, as-is: uids, codes, names, units,
// statuses, categories, kit components, costing bases, history and evidence
// are carried over unchanged, and each item's stored buy and sell prices
// become one item_prices row (source 'migration', effective from the item's
// last update). No value is corrected, merged or added.
//
// The import runs in one transaction and verifies itself before committing:
// row counts per table, every uid preserved, every component link preserved,
// every stored price carried over, and every item's effective buy and sell
// price (the legacy roll-up over the SQLite rows versus the new roll-up over
// the imported rows) equal. Any failure rolls the import back. A dry run
// does everything, reports, then rolls back.
//
// The legacy file is opened read-only and never written.
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { resolveDisposalQuantityPerVolume } from "../../shared/disposal-basis.js";
import { loadRecipeChildrenByParent } from "../price-catalog/catalog-recipes.js";
import { existsSync } from "../storage/fs.js";
import { bumpCatalogVersion, deleteCatalogContents, ensureCatalogReferenceData, lockCatalogForWrite } from "./reference-data.js";
import { effectivePrices } from "./rollup.js";
import { loadCatalogState, normalizeCode, selectRows } from "./state.js";
import { generateCatalogUid } from "./store.js";
import { pricingBasisFactor, PRICING_BASIS_CONVERSIONS, resolveUnitCode } from "./units.js";

class DryRunRollback extends Error {
  constructor(report) {
    super("dry run: rolled back");
    this.report = report;
  }
}

class VerificationFailed extends Error {
  constructor(report) {
    super(`legacy catalogue import failed verification: ${report.verification.failures.map((f) => f.check).join(", ")}; nothing was imported`);
    this.code = "CATALOG_IMPORT_VERIFICATION_FAILED";
    this.report = report;
  }
}

/** SQLite `datetime('now')` text is UTC without a zone; ISO text has one. */
export function parseLegacyTimestamp(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function columnsOf(sqlite, table) {
  try {
    return new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function tableExists(sqlite, table) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function readLegacyCatalog(path) {
  if (!existsSync(path)) throw new Error(`legacy catalogue not found: ${path}`);
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const itemColumns = columnsOf(sqlite, "items");
    if (!itemColumns.has("code")) throw new Error(`${path} is not a Field price catalogue (no items table)`);
    const pick = (column, fallback = "NULL") => (itemColumns.has(column) ? column : `${fallback} AS ${column}`);
    const items = sqlite.prepare(`SELECT id, ${pick("uid")}, code, name, ${pick("unit", "'job'")}, buy_price, sell_price,
        ${pick("buy_price_mode", "'manual'")}, ${pick("sell_price_mode", "'manual'")}, ${pick("price_reference")},
        ${pick("catalog_type")}, ${pick("category")}, ${pick("status", "'active'")}, ${pick("pricing_basis")},
        ${pick("pricing_basis_factor")}, ${pick("created_at")}, ${pick("updated_at")}
      FROM items ORDER BY id`).all();
    const children = tableExists(sqlite, "component_children")
      ? sqlite.prepare(`SELECT * FROM component_children ORDER BY id`).all()
      : [];
    const categories = tableExists(sqlite, "categories")
      ? sqlite.prepare(`SELECT * FROM categories ORDER BY id`).all()
      : [];
    const history = tableExists(sqlite, "history")
      ? sqlite.prepare(`SELECT * FROM history ORDER BY id`).all()
      : [];
    const evidence = tableExists(sqlite, "evidence")
      ? sqlite.prepare(`SELECT * FROM evidence ORDER BY id`).all()
      : [];
    const quoteSnapshotCount = tableExists(sqlite, "quote_snapshots")
      ? sqlite.prepare(`SELECT COUNT(*) AS c FROM quote_snapshots`).get().c
      : 0;
    const schemaVersion = tableExists(sqlite, "schema_version")
      ? sqlite.prepare(`SELECT MAX(version) AS v FROM schema_version`).get().v
      : null;
    return { path, schemaVersion, items, children, categories, history, evidence, quoteSnapshotCount };
  } finally {
    sqlite.close();
  }
}

/**
 * The SQLite catalogue's effective prices (keyed by legacy row id), computed the way it computed them
 * (server/price-catalog/catalog-pricing.js computeComponentPrices before the
 * move): DB children first, else the quote-catalog recipe; components summed
 * leaf-first; manual items keep their stored price. Kept here, frozen, only
 * to verify an import.
 */
export function legacyEffectivePrices(legacy, recipeChildrenByParent = loadRecipeChildrenByParent()) {
  const active = legacy.items.filter((item) => item.status === "active");
  const priceMap = new Map(active.map((item) => [normalizeCode(item.code), { buy: item.buy_price, sell: item.sell_price }]));
  const byCode = new Map(legacy.items.map((item) => [normalizeCode(item.code), item]));
  const childrenByParent = new Map();
  for (const row of legacy.children) {
    const key = normalizeCode(row.parent_code);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push({
      childCode: normalizeCode(row.child_code),
      quantity: row.quantity,
      pricingContribution: row.pricing_contribution === "listed_only" ? "listed_only" : "included",
    });
  }
  for (const [parentCode, kids] of recipeChildrenByParent || new Map()) {
    if (String(parentCode).startsWith("uid:")) continue; // the same recipe, keyed by uid
    const key = normalizeCode(parentCode);
    if (childrenByParent.has(key)) continue;
    childrenByParent.set(key, kids.map((child) => {
      let quantity = child.quantity;
      if (quantity == null && child.quantityBasis === "disposal_per_volume") {
        const item = byCode.get(normalizeCode(child.childCode));
        quantity = item ? resolveDisposalQuantityPerVolume(item.pricing_basis, item.pricing_basis_factor) : null;
      }
      return { childCode: normalizeCode(child.childCode), quantity, balance: Boolean(child.balance) };
    }));
  }
  const computed = new Map();
  const visiting = new Set();
  const resolve = (key) => {
    if (computed.has(key)) return computed.get(key);
    if (visiting.has(key)) return { buyPrice: priceMap.get(key)?.buy ?? null, sellPrice: priceMap.get(key)?.sell ?? null };
    visiting.add(key);
    const kids = childrenByParent.get(key);
    if (!kids || !kids.length) {
      const prices = priceMap.get(key) || { buy: null, sell: null };
      const result = { buyPrice: prices.buy ?? null, sellPrice: prices.sell ?? null };
      computed.set(key, result);
      visiting.delete(key);
      return result;
    }
    let buySum = 0;
    let sellSum = 0;
    let buyValid = true;
    let sellValid = true;
    for (const kid of kids) {
      if (kid.balance || kid.pricingContribution === "listed_only") continue;
      if (kid.quantity == null) { buyValid = false; sellValid = false; continue; }
      const child = resolve(kid.childCode);
      if (child.buyPrice != null) buySum += child.buyPrice * kid.quantity; else buyValid = false;
      if (child.sellPrice != null) sellSum += child.sellPrice * kid.quantity; else sellValid = false;
    }
    for (const kid of kids) {
      if (!kid.balance) continue;
      const own = priceMap.get(key) || { buy: null, sell: null };
      if (own.buy != null && buyValid) buySum += Math.max(0, own.buy - buySum) * kid.quantity; else buyValid = false;
      if (own.sell != null && sellValid) sellSum += Math.max(0, own.sell - sellSum) * kid.quantity; else sellValid = false;
    }
    const result = { buyPrice: buyValid ? buySum : null, sellPrice: sellValid ? sellSum : null };
    computed.set(key, result);
    visiting.delete(key);
    return result;
  };
  const out = new Map();
  for (const item of legacy.items) {
    const key = normalizeCode(item.code);
    const hasKids = childrenByParent.has(key);
    const resolved = hasKids ? resolve(key) : null;
    out.set(item.id, {
      buy: hasKids && item.buy_price_mode === "computed" ? resolved.buyPrice : item.buy_price,
      sell: hasKids && item.sell_price_mode === "computed" ? resolved.sellPrice : item.sell_price,
      active: item.status === "active",
    });
  }
  return out;
}

function numericText(value) {
  return value == null ? null : String(value);
}

function same(a, b) {
  if (a == null && b == null) return true;
  return a === b;
}

/**
 * Import `legacyCatalogDbPath` into the catalogue `db` (a Drizzle instance)
 * of organisation `orgUid` (default: the default organisation, the only organisation
 * that ever had a legacy catalogue). Options: orgUid, dryRun (verify, report, roll back), replace (delete the current
 * catalogue rows first, in the same transaction; otherwise the target must
 * hold no items), author, now, spotCheckCount.
 */
export async function importLegacyCatalog(db, legacyCatalogDbPath, options = {}) {
  // The data import's hook form (scripts/migrate-data-to-postgres.js):
  // importLegacyCatalog({ db, catalogDbPath, dryRun, logger }).
  if (legacyCatalogDbPath === undefined && db && typeof db === "object" && "catalogDbPath" in db) {
    return importLegacyCatalogForDataImport(db);
  }
  return importLegacyCatalogInto(db, legacyCatalogDbPath, options);
}

/**
 * The hook scripts/migrate-data-to-postgres.js calls. `db` is the data
 * import's transaction (the catalogue import runs inside it, so either both
 * commit or neither does), or null for its dry run, which connects to
 * nothing: the import is then rehearsed and verified on a throwaway
 * in-process PostgreSQL and rolled back. A catalogue that already holds items
 * is refused here; replacing one is `npm run catalog:import-legacy -- --replace`.
 */
async function importLegacyCatalogForDataImport({ db = null, catalogDbPath, dryRun = false, author = "migration" }) {
  if (!catalogDbPath) throw new Error("importLegacyCatalog: catalogDbPath is required");
  if (db) return importLegacyCatalogInto(db, catalogDbPath, { dryRun, author });
  if (!dryRun) throw new Error("importLegacyCatalog: a database is required unless dryRun is set");
  const { createTestDb } = await import("../db-runtime/index.js");
  const scratch = await createTestDb();
  try {
    return { ...(await importLegacyCatalogInto(scratch.db, catalogDbPath, { dryRun: true, author })), rehearsedOn: "in-process PostgreSQL (PGlite)" };
  } finally {
    await scratch.close();
  }
}

async function importLegacyCatalogInto(db, legacyCatalogDbPath, {
  orgUid = DEFAULT_ORG_UID,
  dryRun = false,
  replace = false,
  author = "migration",
  now = new Date(),
  spotCheckCount = 5,
} = {}) {
  const legacy = readLegacyCatalog(legacyCatalogDbPath);
  const warnings = [];
  const source = {
    path: legacyCatalogDbPath,
    schemaVersion: legacy.schemaVersion,
    counts: {
      items: legacy.items.length,
      activeItems: legacy.items.filter((item) => item.status === "active").length,
      components: legacy.children.length,
      categories: legacy.categories.length,
      history: legacy.history.length,
      evidence: legacy.evidence.length,
      quoteSnapshots: legacy.quoteSnapshotCount,
    },
  };
  if (legacy.quoteSnapshotCount > 0) {
    warnings.push(`${legacy.quoteSnapshotCount} quote_snapshots row(s) were not imported (quote snapshots are not catalogue data)`);
  }

  await ensureCatalogReferenceData(db, { now, orgUid });
  let newUnits = new Set();

  const run = async (tx) => {
    await lockCatalogForWrite(tx);
    const [{ count: existing }] = await selectRows(tx, sql`select count(*)::int as count from items`);
    if (Number(existing) > 0) {
      if (!replace) {
        throw new Error(`the catalogue already holds ${existing} item(s); import into an empty catalogue, or pass replace to delete them first`);
      }
      warnings.push(`replaced ${existing} existing item(s) and deleted their price history, components, evidence and the catalogue audit history`);
      await deleteCatalogContents(tx);
    } else {
      // No items, but rows left behind by items created and deleted after a
      // cutover would make the row-count verification fail confusingly.
      const [leftover] = await selectRows(tx, sql`
        select (select count(*)::int from catalog_history) as history,
               (select count(*)::int from catalog_evidence) as evidence,
               (select count(*)::int from categories) as categories`);
      const parts = Object.entries(leftover).filter(([, value]) => Number(value) > 0).map(([name, value]) => `${value} ${name} row(s)`);
      if (parts.length) {
        if (!replace) {
          throw new Error(`the catalogue holds no items but still has ${parts.join(", ")} from earlier use; pass replace to clear them before importing`);
        }
        warnings.push(`cleared leftover ${parts.join(", ")} from a catalogue with no items`);
        await deleteCatalogContents(tx);
      }
    }
    let state = await loadCatalogState(tx, { now, inTransaction: true });

    const unitFor = new Map();
    for (const item of legacy.items) {
      const raw = legacyUnitText(item);
      const code = resolveUnitCode(state, raw) || (newUnits.has(raw.toLowerCase()) ? raw.toLowerCase() : null);
      if (!code) throw new Error(`unit "${raw}" of item ${item.code} was not added to units`);
      unitFor.set(item.id, { unitCode: code, unitLabel: raw !== code ? raw : null });
    }

    // Uids are preserved; an item without one (very old catalogues) gets a
    // generated one, reported.
    const uidOf = new Map();
    const usedUids = new Set(legacy.items.map((item) => item.uid).filter(Boolean));
    for (const item of legacy.items) {
      let uid = String(item.uid || "").trim();
      if (!uid) {
        do { uid = generateCatalogUid(); } while (usedUids.has(uid));
        usedUids.add(uid);
        warnings.push(`item ${item.code} had no uid; assigned ${uid}`);
      }
      uidOf.set(item.id, uid);
    }
    const uidByCode = new Map(legacy.items.map((item) => [normalizeCode(item.code), uidOf.get(item.id)]));

    for (const category of legacy.categories) {
      await tx.insert(schema.categories).values({
        id: Number(category.id),
        name: category.name,
        sortOrder: Number(category.sort_order || 0),
        createdAt: parseLegacyTimestamp(category.created_at) || now,
        updatedAt: parseLegacyTimestamp(category.updated_at) || now,
      });
    }

    for (const item of legacy.items) {
      const uid = uidOf.get(item.id);
      const createdAt = parseLegacyTimestamp(item.created_at) || now;
      const updatedAt = parseLegacyTimestamp(item.updated_at) || createdAt;
      const unit = unitFor.get(item.id);
      const catalogType = String(item.catalog_type || "").trim().toLowerCase();
      await tx.insert(schema.items).values({
        uid,
        code: item.code,
        name: item.name,
        priceReference: item.price_reference ?? null,
        visibility: ["goods_service", "product", "service"].includes(catalogType) ? "sellable" : "internal",
        unitCode: unit.unitCode,
        unitLabel: unit.unitLabel,
        category: item.category ?? null,
        costMode: item.buy_price_mode === "computed" ? "rollup" : "manual",
        sellMode: item.sell_price_mode === "computed" ? "rollup" : "fixed",
        pricingBasis: item.pricing_basis ?? null,
        status: item.status || "active",
        version: 1,
        createdAt,
        updatedAt,
      });
      const spec = PRICING_BASIS_CONVERSIONS[item.pricing_basis];
      if (spec && item.pricing_basis_factor != null && Number(item.pricing_basis_factor) > 0) {
        await tx.insert(schema.itemUnitConversions).values({ itemUid: uid, fromUnit: spec.fromUnit, toUnit: spec.toUnit, factor: String(item.pricing_basis_factor) });
      } else if (spec) {
        warnings.push(`item ${item.code} has pricing_basis ${item.pricing_basis} without a factor; imported as-is — health reports it`);
      }
      await tx.insert(schema.itemPrices).values({
        itemUid: uid,
        costPerUnit: numericText(item.buy_price),
        sellPrice: numericText(item.sell_price),
        markupPct: null,
        effectiveFrom: updatedAt,
        source: "migration",
        sourceRef: `catalog.db v${legacy.schemaVersion ?? "?"} item ${item.id}`,
        changedBy: author,
        reason: "Imported from the SQLite catalogue",
        createdAt: now,
      });
    }

    for (const child of legacy.children) {
      const parentUid = uidByCode.get(normalizeCode(child.parent_code));
      const childUid = uidByCode.get(normalizeCode(child.child_code));
      if (!parentUid || !childUid) {
        throw new Error(`component link ${child.parent_code} -> ${child.child_code} references a missing item`);
      }
      const entryUnitRaw = child.entry_unit == null || child.entry_unit === "" ? null : String(child.entry_unit);
      const entryUnit = entryUnitRaw ? resolveUnitCode(state, entryUnitRaw) : null;
      if (entryUnitRaw && !entryUnit) throw new Error(`component link ${child.parent_code} -> ${child.child_code} uses unknown entry unit "${entryUnitRaw}"`);
      await tx.insert(schema.itemComponents).values({
        parentUid,
        childUid,
        quantity: String(child.quantity ?? 1),
        entryQuantity: numericText(child.entry_quantity),
        entryUnit,
        applicationMode: child.application_mode === "fixed" ? "fixed" : "proportional",
        pricingContribution: child.pricing_contribution === "listed_only" ? "listed_only" : "included",
        sortOrder: Number(child.sort_order || 0),
        createdAt: parseLegacyTimestamp(child.created_at) || now,
      });
    }
    // An item with components is a kit (items.type, migration 0007).
    await tx.execute(sql`update items set type = 'kit' where uid in (select kit_uid from kit_components)`);

    let unmatchedHistory = 0;
    const historyRows = legacy.history.map((row) => {
      const itemUid = uidByCode.get(normalizeCode(row.item_code)) || null;
      if (!itemUid) unmatchedHistory += 1;
      return {
        itemUid,
        itemCode: row.item_code,
        field: row.field,
        oldValue: row.old_value == null ? null : String(row.old_value),
        newValue: row.new_value == null ? null : String(row.new_value),
        changedBy: row.changed_by || "system",
        reason: null,
        changedAt: parseLegacyTimestamp(row.changed_at) || now,
      };
    });
    for (let index = 0; index < historyRows.length; index += 500) {
      await tx.insert(schema.catalogHistory).values(historyRows.slice(index, index + 500));
    }
    if (unmatchedHistory) warnings.push(`${unmatchedHistory} history row(s) name an item code that no longer exists; kept with no item uid`);

    for (const row of legacy.evidence) {
      const itemUid = uidByCode.get(normalizeCode(row.item_code));
      if (!itemUid) throw new Error(`evidence ${row.id} references missing item ${row.item_code}`);
      await tx.insert(schema.catalogEvidence).values({
        itemUid,
        side: row.side,
        kind: row.kind,
        filePath: row.file_path ?? null,
        url: row.url ?? null,
        note: row.note ?? null,
        supplier: row.supplier ?? null,
        mimeType: row.mime_type ?? null,
        originalFilename: row.original_filename ?? null,
        createdBy: row.created_by ?? null,
        createdAt: parseLegacyTimestamp(row.created_at) || now,
      });
    }

    const catalogVersion = await bumpCatalogVersion(tx, { now });
    state = await loadCatalogState(tx, { now, inTransaction: true });
    const verification = await verifyImport(tx, { legacy, state, uidOf, spotCheckCount });
    const report = {
      dryRun,
      source,
      imported: {
        items: state.items.size,
        prices: state.prices.size,
        components: [...state.components.values()].reduce((sum, list) => sum + list.length, 0),
        categories: state.categories.length,
        history: historyRows.length,
        evidence: legacy.evidence.length,
      },
      catalogVersion,
      verification,
      warnings,
    };
    if (!verification.ok) throw new VerificationFailed(report);
    if (dryRun) throw new DryRunRollback(report);
    return report;
  };

  // Units the catalogue does not know yet are added as they are (dimension
  // "other", not convertible) and reported, never rewritten. Units are shared
  // reference data that only the login role may write, so they go in an
  // outer transaction and the organisation's import runs nested inside it:
  // both commit or neither does, a dry run included.
  const shared = db?.isOrgScope ? db.db : db;
  try {
    return await shared.transaction(async (outer) => {
      newUnits = await addUnknownUnits(outer, legacy.items, warnings);
      const report = await withOrg(outer, orgUid, run);
      if (legacy.categories.length) {
        // Categories kept their legacy ids. The sequence is shared by every
        // organisation (only the login role may set it): move it past them,
        // never back.
        const maxId = Math.max(...legacy.categories.map((category) => Number(category.id)));
        await outer.execute(sql`select setval(pg_get_serial_sequence('categories', 'id'), greatest(${maxId}::bigint, (select last_value from categories_id_seq)))`);
      }
      return report;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}

function legacyUnitText(item) {
  return String(item.unit ?? "").trim() || "job";
}

// Adds the legacy catalogue's unknown units to the shared `units` table as
// the login role; returns the codes it added (or found added concurrently).
async function addUnknownUnits(shared, legacyItems, warnings) {
  const units = new Map((await selectRows(shared, sql`select code from units`)).map((row) => [row.code, true]));
  const aliases = new Map((await selectRows(shared, sql`select alias, unit_code from unit_aliases`)).map((row) => [String(row.alias).toLowerCase(), row.unit_code]));
  const known = { units, aliases };
  const added = new Set();
  for (const item of legacyItems) {
    const raw = legacyUnitText(item);
    if (resolveUnitCode(known, raw)) continue;
    const code = raw.toLowerCase();
    if (added.has(code)) continue;
    await shared.insert(schema.units).values({ code, label: raw, dimension: "other", toBase: null, sortOrder: 1000 }).onConflictDoNothing();
    added.add(code);
    warnings.push(`unit "${raw}" is not one of Field's units; added as-is (not convertible) — health reports it`);
  }
  return added;
}

async function verifyImport(tx, { legacy, state, uidOf, spotCheckCount }) {
  const checks = [];
  const failures = [];
  const check = (name, ok, detail) => {
    const entry = { check: name, ok: Boolean(ok), ...detail };
    checks.push(entry);
    if (!ok) failures.push(entry);
  };
  const count = async (table) => Number((await selectRows(tx, sql`select count(*)::int as c from ${sql.identifier(table)}`))[0].c);

  check("items row count", (await count("items")) === legacy.items.length, { legacy: legacy.items.length, imported: await count("items") });
  check("component row count", (await count("kit_components")) === legacy.children.length, { legacy: legacy.children.length, imported: await count("kit_components") });
  check("category row count", (await count("categories")) === legacy.categories.length, { legacy: legacy.categories.length, imported: await count("categories") });
  check("history row count", (await count("catalog_history")) === legacy.history.length, { legacy: legacy.history.length, imported: await count("catalog_history") });
  check("evidence row count", (await count("catalog_evidence")) === legacy.evidence.length, { legacy: legacy.evidence.length, imported: await count("catalog_evidence") });
  check("price rows (one per item)", (await count("item_prices")) === legacy.items.length, { legacy: legacy.items.length, imported: await count("item_prices") });

  const legacyUids = new Set(legacy.items.map((item) => item.uid).filter(Boolean));
  const missingUids = [...legacyUids].filter((uid) => !state.items.has(uid));
  check("uids preserved", missingUids.length === 0, { legacy: legacyUids.size, imported: legacyUids.size - missingUids.length, missing: missingUids.slice(0, 20) });

  const fieldMismatches = [];
  const storedPriceMismatches = [];
  for (const item of legacy.items) {
    const uid = uidOf.get(item.id);
    const imported = state.items.get(uid);
    const row = state.prices.get(uid);
    const expectations = [
      ["code", item.code, imported?.code],
      ["name", item.name, imported?.name],
      ["status", item.status || "active", imported?.status],
      ["category", item.category ?? null, imported?.category ?? null],
      ["unit", String(item.unit ?? "").trim() || "job", imported ? (imported.unitLabel || imported.unitCode) : null],
      ["price_reference", item.price_reference ?? null, imported?.priceReference ?? null],
      ["pricing_basis", item.pricing_basis ?? null, imported?.pricingBasis ?? null],
      ["pricing_basis_factor", item.pricing_basis_factor ?? null, imported ? pricingBasisFactor(state, imported) : null],
    ];
    for (const [field, expected, actual] of expectations) {
      if (!same(expected, actual)) fieldMismatches.push({ code: item.code, field, legacy: expected, imported: actual });
    }
    if (!same(item.buy_price ?? null, row?.cost ?? null) || !same(item.sell_price ?? null, row?.sell ?? null)) {
      storedPriceMismatches.push({ code: item.code, legacy: [item.buy_price, item.sell_price], imported: [row?.cost, row?.sell] });
    }
  }
  check("item fields preserved", fieldMismatches.length === 0, { mismatches: fieldMismatches.slice(0, 50) });
  check("stored prices carried over", storedPriceMismatches.length === 0, { mismatches: storedPriceMismatches.slice(0, 50) });

  const linkKey = (parent, child, quantity, entryQuantity, entryUnit, mode, contribution, sortOrder) =>
    JSON.stringify([parent, child, Number(quantity), entryQuantity == null ? null : Number(entryQuantity), entryUnit || null, mode, contribution, Number(sortOrder || 0)]);
  const uidByCode = new Map(legacy.items.map((item) => [normalizeCode(item.code), uidOf.get(item.id)]));
  const legacyLinks = legacy.children.map((child) => linkKey(
    uidByCode.get(normalizeCode(child.parent_code)),
    uidByCode.get(normalizeCode(child.child_code)),
    child.quantity ?? 1,
    child.entry_quantity,
    child.entry_unit ? resolveUnitCode(state, child.entry_unit) : null,
    child.application_mode === "fixed" ? "fixed" : "proportional",
    child.pricing_contribution === "listed_only" ? "listed_only" : "included",
    child.sort_order,
  )).sort();
  const importedLinks = [...state.components.values()].flat().map((component) => linkKey(
    component.parentUid,
    component.childUid,
    component.quantity,
    component.entryQuantity,
    component.entryUnit,
    component.applicationMode,
    component.pricingContribution,
    component.sortOrder,
  )).sort();
  const missingLinks = legacyLinks.filter((key, index) => importedLinks[index] !== key);
  check("component links preserved", legacyLinks.length === importedLinks.length && missingLinks.length === 0, { legacy: legacyLinks.length, imported: importedLinks.length, mismatches: missingLinks.slice(0, 20) });

  const legacyPrices = legacyEffectivePrices(legacy);
  const newPrices = effectivePrices(state);
  const effectiveMismatches = [];
  for (const item of legacy.items) {
    const uid = uidOf.get(item.id);
    const before = legacyPrices.get(item.id);
    const after = newPrices.get(uid);
    if (!before || item.status !== "active") continue;
    if (!same(before.buy ?? null, after?.cost ?? null) || !same(before.sell ?? null, after?.sell ?? null)) {
      effectiveMismatches.push({ code: item.code, legacy: { buy: before.buy, sell: before.sell }, imported: { buy: after?.cost ?? null, sell: after?.sell ?? null } });
    }
  }
  check("effective buy/sell equal for every active item", effectiveMismatches.length === 0, {
    compared: legacy.items.filter((item) => item.status === "active").length,
    mismatches: effectiveMismatches.slice(0, 50),
  });

  const spot = [...legacy.items]
    .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .filter((_, index, list) => index % Math.max(1, Math.floor(list.length / Math.max(1, spotCheckCount))) === 0)
    .slice(0, spotCheckCount)
    .map((item) => {
      const uid = uidOf.get(item.id);
      const imported = state.items.get(uid);
      const before = legacyPrices.get(item.id);
      const after = newPrices.get(uid);
      return {
        code: item.code,
        uid,
        name: imported?.name,
        status: imported?.status,
        components: (state.components.get(uid) || []).length,
        legacy: { buy: before?.buy ?? null, sell: before?.sell ?? null },
        imported: { buy: after?.cost ?? null, sell: after?.sell ?? null, priceId: state.prices.get(uid)?.id ?? null },
      };
    });

  return { ok: failures.length === 0, checks, failures, spotChecks: spot };
}
