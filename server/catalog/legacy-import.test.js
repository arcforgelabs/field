import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { createTestDb, queryRows } from "../db-runtime/index.js";
import { importLegacyCatalog, openCatalogStore } from "./index.js";
import { parseLegacyTimestamp } from "./legacy-import.js";
import { writeLegacyCatalog } from "./fixtures/legacy-catalog.js";

// Builds a synthetic v21 catalog.db (fixtures/legacy-catalog.js) in a temp dir.
function buildLegacyCatalog(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "field-legacy-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return writeLegacyCatalog(join(dir, "catalog.db"), options);
}

async function freshDb(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  return handle.db;
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("legacy timestamps: SQLite datetime text is UTC, ISO text keeps its zone", () => {
  assert.equal(parseLegacyTimestamp("2026-04-02 23:32:00").toISOString(), "2026-04-02T23:32:00.000Z");
  assert.equal(parseLegacyTimestamp("2026-09-01T23:46:29.500Z").toISOString(), "2026-09-01T23:46:29.500Z");
  assert.equal(parseLegacyTimestamp(null), null);
});

test("a legacy catalogue imports as-is and verifies itself", async (t) => {
  const legacyPath = buildLegacyCatalog(t);
  const before = fileDigest(legacyPath);
  const db = await freshDb(t);
  const report = await importLegacyCatalog(db, legacyPath, { now: new Date("2026-10-11T00:00:00.000Z") });

  assert.equal(report.verification.ok, true, JSON.stringify(report.verification.failures));
  assert.deepEqual(report.source.counts, { items: 7, activeItems: 6, components: 5, categories: 2, history: 3, evidence: 1, quoteSnapshots: 0 });
  assert.deepEqual(report.imported, { items: 7, prices: 7, components: 5, categories: 2, history: 3, evidence: 1 });
  assert.equal(fileDigest(legacyPath), before, "the legacy file is never written");
  assert.ok(report.warnings.some((warning) => /GONE-CODE|no longer exists/.test(warning)));

  const store = await openCatalogStore({ db });
  const labour = await store.getItem("cat_labour");
  assert.equal(labour.code, "LABOURER-HOUR");
  assert.equal(labour.sell_price, 80.5);
  const [price] = await store.getPriceHistory("cat_labour");
  assert.equal(price.source, "migration");
  assert.equal(price.effective_from, "2026-04-28T05:31:00.000Z", "effective from the item's last update");
  assert.equal(price.changed_by, "migration");

  const plant = await store.getItem("plant-supply");
  assert.equal(plant.unit, "plant");
  assert.equal(plant.unit_code, "each");
  assert.equal(plant.updated_at, "2026-09-01T23:46:29.500Z");
  assert.equal(plant.catalog_type, "goods_service");

  const gravel = await store.getItem("GRAVEL-20MM");
  assert.equal(gravel.pricing_basis, "per_tonne");
  assert.equal(gravel.pricing_basis_factor, 1.6);

  const bay = await store.getItem("wall-bay");
  assert.equal(bay.price_reference, "Recipe notes:\nper bay");
  assert.equal(bay.effective_buy_price, 50 * 2.5 + 41.3 * 0.35);
  assert.equal(bay.effective_sell_price, 80.5 * 2.5 + 56.708 * 0.35, "listed-only components stay out of the sum");
  assert.deepEqual(bay.children.map((child) => [child.code, child.quantity, child.entry_quantity, child.entry_unit, child.application_mode, child.pricing_contribution]), [
    ["LABOURER-HOUR", 2.5, 150, "min", "proportional", "included"],
    ["GRAVEL-20MM", 0.35, null, null, "fixed", "included"],
    ["plant-supply", 1, null, null, "proportional", "listed_only"],
  ]);
  const wall = await store.getItem("cat-wall-copy");
  assert.equal(wall.effective_sell_price, bay.effective_sell_price * 0.4166);

  const history = await store.getItemHistory("LABOURER-HOUR");
  assert.deepEqual(history.map((row) => [row.field, row.old_value, row.new_value, row.changed_by, row.changed_at]), [
    ["sell_price", "75", "80.5", "Estimator", "2026-05-01T01:02:03.000Z"],
  ]);
  assert.deepEqual((await store.listEvidence("GRAVEL-20MM")).map((row) => [row.side, row.note, row.supplier]), [["buy", "Quarry price list", "Synthetic Quarry"]]);
  assert.deepEqual((await store.listCategories()).map((category) => category.name), ["Materials", "Walls"]);
  const created = await store.createCategory({ name: "Drainage" });
  assert.ok(created.id > 2, "the category id sequence continues after the imported ids");
  assert.equal((await store.getItem("OLD-ITEM")).status, "archived");
  assert.equal((await store.catalogVersion()).version >= 1, true);
});

test("a dry run verifies and reports, then leaves the catalogue empty", async (t) => {
  const legacyPath = buildLegacyCatalog(t);
  const db = await freshDb(t);
  const report = await importLegacyCatalog(db, legacyPath, { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.verification.ok, true);
  const store = await openCatalogStore({ db });
  assert.equal((await store.listItems({ status: "all" })).length, 0);
});

test("an import refuses a catalogue that already has items unless told to replace it", async (t) => {
  const legacyPath = buildLegacyCatalog(t);
  const db = await freshDb(t);
  const store = await openCatalogStore({ db });
  await store.createItem({ code: "existing", name: "Existing", buy_price: 1, sell_price: 2 });
  await assert.rejects(importLegacyCatalog(db, legacyPath), /already holds 1 item/);
  const report = await importLegacyCatalog(db, legacyPath, { replace: true });
  assert.equal(report.verification.ok, true);
  assert.ok(report.warnings.some((warning) => /replaced 1 existing item/.test(warning)));
  store.invalidate();
  assert.equal(await store.getItem("existing"), null);
  assert.equal((await store.listItems({ status: "all" })).length, 7);
});

test("an import into an itemless catalogue with leftover history says so, and replace clears it", async (t) => {
  const legacyPath = buildLegacyCatalog(t);
  const db = await freshDb(t);
  const store = await openCatalogStore({ db });
  await store.createItem({ code: "temp", name: "Temp", buy_price: 1, sell_price: 2 });
  await store.deleteItem("temp");
  assert.equal((await store.listItems({ status: "all" })).length, 0);
  await assert.rejects(importLegacyCatalog(db, legacyPath), /holds no items but still has \d+ history row/);
  const report = await importLegacyCatalog(db, legacyPath, { replace: true });
  assert.equal(report.verification.ok, true);
  assert.ok(report.warnings.some((warning) => /cleared leftover/.test(warning)));
});

test("a price the one roll-up would change fails verification and imports nothing", async (t) => {
  const legacyPath = buildLegacyCatalog(t, { quirk: true });
  const db = await freshDb(t);
  await assert.rejects(importLegacyCatalog(db, legacyPath), (error) => {
    assert.equal(error.code, "CATALOG_IMPORT_VERIFICATION_FAILED");
    const failure = error.report.verification.failures.find((entry) => entry.check.startsWith("effective buy/sell"));
    assert.deepEqual(failure.mismatches, [{ code: "outer", legacy: { buy: 50, sell: 80.5 }, imported: { buy: 100, sell: 200 } }]);
    return true;
  });
  const store = await openCatalogStore({ db });
  assert.equal((await store.listItems({ status: "all" })).length, 0);
});

test("an unknown unit is added as shared reference data; a dry run leaves nothing behind", async (t) => {
  // Units are shared by every organisation and only the login role may add
  // them, so the import adds them outside the organisation's transaction but
  // in the same outer transaction as the catalogue.
  const legacyPath = buildLegacyCatalog(t);
  const legacy = new Database(legacyPath);
  legacy.prepare("update items set unit = 'Bananas' where uid = 'cat_old'").run();
  legacy.close();
  const db = await freshDb(t);
  const unitRows = () => queryRows(sql`select code, dimension from units where code = 'bananas'`, db);

  const dry = await importLegacyCatalog(db, legacyPath, { dryRun: true });
  assert.equal(dry.verification.ok, true, JSON.stringify(dry.verification.failures));
  assert.deepEqual(await unitRows(), [], "a dry run rolls the unit back with the catalogue");

  const report = await importLegacyCatalog(db, legacyPath, { now: new Date("2026-10-11T00:00:00.000Z") });
  assert.equal(report.verification.ok, true, JSON.stringify(report.verification.failures));
  assert.ok(report.warnings.some((warning) => /unit "Bananas" is not one of Field's units/.test(warning)));
  assert.deepEqual(await unitRows(), [{ code: "bananas", dimension: "other" }]);
  const store = await openCatalogStore({ db });
  assert.equal((await store.getItem("cat_old")).unit, "Bananas");
  // Legacy category ids were kept; the shared sequence moved past them.
  const created = await store.createCategory({ name: "Brand new category" });
  assert.ok(created.id > 2, `new category id ${created.id} follows the imported ones`);
});
