// Test fixture: a synthetic legacy (SQLite, schema v21) catalog.db for the
// importer's tests (server/catalog/legacy-import.test.js and the data import's
// scripts/migrate-data-to-postgres.test.js). No real customer or supplier data.
import { readFileSync } from "../../storage/fs.js";
import Database from "better-sqlite3";

const LEGACY_SCHEMA = readFileSync(new URL("./legacy-catalog-v21.sql", import.meta.url), "utf8");

// The items the default quote rules and recipes name, with the units
// and statuses the production catalogue sells them in (names and prices are
// synthetic). Shapes that matter: ADMIN-FEE and the irrigation controllers
// are sold "each", not "job"; rock-wall is per m, concrete-removal per m2 and
// retaining-wall per bay, none of which converts to the rule's measure;
// clean-fill-disposal is per tonne; SANDY-LOAM-M3 and
// lawn-supply-prep-install are archived; the drainage materials and
// concrete-demolition do not exist.
export const PRODUCTION_SHAPED_ITEMS = Object.freeze([
  ["site-establishment", "job"], ["cleanup", "job"], ["misc-site-works", "job"],
  ["EXCAVATOR-HOUR", "hour"], ["VEHICLE-HOUR", "hour"], ["VEHICLE-KM", "km"], ["KANGA-HOUR", "hour"], ["JACKHAMMER-HOUR", "hour"],
  ["concrete-surface-demolition", "m2"], ["concrete-structure-demolition", "m2"], ["concrete-removal", "m2"],
  ["soil-removal", "m3"], ["site-levelling", "m3"], ["imported-fill", "m3"], ["tip-truck", "load"],
  ["clean-fill-disposal", "tonne", { basis: "per_tonne", factor: 1.6 }],
  ["unclean-fill-disposal", "tonne", { basis: "per_tonne", factor: 1.6 }],
  ["concrete-waste-disposal", "tonne", { basis: "per_tonne", factor: 2.4 }],
  ["green-waste-disposal", "tonne", { basis: "per_tonne", factor: 0.5 }],
  ["retaining-wall", "bay"], ["drainage", "m"], ["irrigation-system-install", "job"],
  ["lawn-supply-prep-install", "m2", { status: "archived" }],
  ["large-tree-supply-install", "each"], ["tree-supply-install", "each"], ["plant-supply-install", "each"],
  ["block-edging-supply-install", "m"], ["rock-wall", "m"],
  ["ADMIN-FEE", "each"], ["IRRIGATION-CONTROLLER-BATTERY", "each"], ["IRRIGATION-CONTROLLER-MAINS", "each"],
  ["IRRIGATION-PIPE-FIXINGS-M2", "m2"], ["TURF-SUPPLY-M2", "m2"], ["SANDY-LOAM-M3", "m3", { status: "archived" }],
].map(([code, unit, extra = {}]) => Object.freeze({ code, unit, ...extra })));

// A synthetic v21 catalog.db shaped like a real one: SQLite datetime text and
// ISO timestamps, a nested computed kit, an alias unit, a costing basis, an
// archived item, history (one row for a code that no longer exists).
// `productionShaped` adds PRODUCTION_SHAPED_ITEMS.
export function writeLegacyCatalog(path, { quirk = false, productionShaped = false } = {}) {
  const db = new Database(path);
  db.exec(LEGACY_SCHEMA);
  db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (21, '2026-04-02 23:32:00')").run();
  const insert = db.prepare(`INSERT INTO items (uid, code, name, unit, buy_price, sell_price, buy_price_mode, sell_price_mode,
      price_reference, catalog_type, category, status, pricing_basis, pricing_basis_factor, created_at, updated_at)
    VALUES (@uid, @code, @name, @unit, @buy, @sell, @buyMode, @sellMode, @ref, @type, @category, @status, @basis, @factor, @created, @updated)`);
  const base = { ref: null, type: "component", category: "Materials", status: "active", basis: null, factor: null, buyMode: "manual", sellMode: "manual", created: "2026-04-02 23:32:00", updated: "2026-04-28 05:31:00" };
  const items = [
    { uid: "cat_labour", code: "LABOURER-HOUR", name: "Labourer", unit: "hour", buy: 50, sell: 80.5 },
    { uid: "cat_gravel", code: "GRAVEL-20MM", name: "Gravel 20mm", unit: "tonne", buy: 41.3, sell: 56.708, basis: "per_tonne", factor: 1.6 },
    { uid: "cat_plant", code: "plant-supply", name: "Plant supply", unit: "plant", buy: 12, sell: 18, type: "goods_service", category: null, updated: "2026-09-01T23:46:29.500Z" },
    { uid: "cat_bay", code: "wall-bay", name: "Wall bay", unit: "bay", buy: 999, sell: 999, buyMode: "computed", sellMode: "computed", type: "goods_service", category: "Walls", ref: "Recipe notes:\nper bay" },
    { uid: "cat_wall", code: "cat-wall-copy", name: "Wall per metre", unit: "m", buy: 1, sell: 1, buyMode: "computed", sellMode: "computed", type: "goods_service", category: "Walls" },
    { uid: "cat_old", code: "OLD-ITEM", name: "Old item", unit: "each", buy: 3, sell: 4, status: "archived" },
    { uid: "cat_manual_kit", code: "manual-kit", name: "Manual kit", unit: "each", buy: 100, sell: 200 },
  ];
  for (const item of items) insert.run({ ...base, ...item });
  if (productionShaped) {
    for (const [index, item] of PRODUCTION_SHAPED_ITEMS.entries()) {
      insert.run({
        ...base,
        uid: `cat_prod_${index}`,
        code: item.code,
        name: `${item.code} (fixture)`,
        unit: item.unit,
        buy: 10 + index,
        sell: 15 + index,
        type: "goods_service",
        status: item.status || "active",
        basis: item.basis || null,
        factor: item.factor ?? null,
      });
    }
  }
  const child = db.prepare(`INSERT INTO component_children (parent_code, child_code, quantity, entry_quantity, entry_unit, application_mode, pricing_contribution, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-04-02 23:32:00')`);
  child.run("wall-bay", "LABOURER-HOUR", 2.5, 150, "min", "proportional", "included", 0);
  child.run("wall-bay", "GRAVEL-20MM", 0.35, null, null, "fixed", "included", 1);
  child.run("wall-bay", "plant-supply", 1, null, null, "proportional", "listed_only", 2);
  child.run("cat-wall-copy", "wall-bay", 0.4166, null, null, "proportional", "included", 0);
  child.run("manual-kit", "LABOURER-HOUR", 1, null, null, "proportional", "included", 0);
  if (quirk) {
    // A computed kit containing a MANUAL kit: the SQLite quote maps rolled
    // the manual kit up from its own children anyway; the one roll-up uses
    // its manual price. The importer must catch the difference, not hide it.
    insert.run({ ...base, uid: "cat_outer", code: "outer", name: "Outer", unit: "each", buy: 0, sell: 0, buyMode: "computed", sellMode: "computed" });
    child.run("outer", "manual-kit", 1, null, null, "proportional", "included", 0);
  }
  db.prepare("INSERT INTO categories (name, sort_order, created_at, updated_at) VALUES ('Materials', 0, '2026-04-28 05:31:00', '2026-04-28 05:31:00'), ('Walls', 1, '2026-04-28 05:31:00', '2026-04-28 05:31:00')").run();
  const hist = db.prepare("INSERT INTO history (item_code, field, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)");
  hist.run("LABOURER-HOUR", "sell_price", "75", "80.5", "Estimator", "2026-05-01 01:02:03");
  hist.run("wall-bay", "children.LABOURER-HOUR.quantity", "2", "2.5", "Estimator", "2026-09-02T00:01:31.903Z");
  hist.run("GONE-CODE", "*", null, "created", "system", "2026-04-02 23:32:00");
  db.prepare("INSERT INTO evidence (item_code, side, kind, note, supplier, created_by, created_at) VALUES ('GRAVEL-20MM', 'buy', 'note', 'Quarry price list', 'Synthetic Quarry', 'Estimator', '2026-05-01 00:00:00')").run();
  db.close();
  return path;
}
