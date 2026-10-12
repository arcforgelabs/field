import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";

import { createTestDb } from "../db-runtime/index.js";
import { createPriceCatalogRouter } from "../price-catalog/catalog-api.js";
import { openCatalogStore } from "./index.js";
import {
  applyBulk,
  createSupplier,
  listItemSuppliers,
  listPriceBook,
  listSuppliers,
  previewBulk,
  removeItemSupplier,
  updateSupplier,
  upsertItemSupplier,
} from "./price-book.js";
import { priceBookHealth } from "./price-book-health.js";

async function freshStore(t, options = {}) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db, ...options });
  return { store, db: handle.db };
}

async function seed(store) {
  await store.createItem({ code: "gravel", name: "Gravel 20mm", unit: "m3", buy_price: 50, sell_price: 80, category: "Materials", tags: ["aggregate"] });
  await store.createItem({ code: "sand", name: "Washed sand", unit: "tonne", buy_price: 30, markup_pct: 50, sell_mode: "markup", category: "Materials", tags: ["aggregate", "bulk"] });
  await store.createItem({ code: "labour", name: "Labourer", unit: "hour", buy_price: 45, sell_price: 48, category: "Labour" });
  await store.createItem({ code: "kit", name: "Path kit", unit: "m", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.addChild({ parentCode: "kit", childCode: "gravel", quantity: 0.1 });
  await store.createItem({ code: "retired", name: "Retired thing", unit: "each", buy_price: 1, sell_price: 2, status: "archived" });
}

test("grid: search covers code, name, tags and supplier codes; filters, facets and paging", async (t) => {
  const { store } = await freshStore(t);
  await seed(store);
  const supplier = await createSupplier(store, { name: "Quarry Co" });
  await upsertItemSupplier(store, "gravel", { supplier_uid: supplier.uid, supplier_code: "QC-G20" });

  const all = await listPriceBook(store, {});
  assert.equal(all.total, 4, "active items by default");
  assert.deepEqual(all.rows.map((row) => row.code), ["gravel", "labour", "kit", "sand"], "sorted by name");
  const gravel = all.rows.find((row) => row.code === "gravel");
  assert.equal(gravel.margin_pct, 37.5);
  assert.equal(gravel.supplier_name, "Quarry Co");
  assert.equal(gravel.supplier_code, "QC-G20");
  assert.ok(gravel.price_id);
  assert.equal(all.rows.find((row) => row.code === "labour").warnings[0], "low_margin");
  assert.equal(all.rows.find((row) => row.code === "kit").sell, 8, "the kit rolls up");
  assert.deepEqual(all.facets.categories, [{ name: "Labour", count: 1 }, { name: "Materials", count: 2 }, { name: "", count: 1 }]);
  assert.deepEqual(all.facets.tags, [{ name: "aggregate", count: 2 }, { name: "bulk", count: 1 }]);

  assert.deepEqual((await listPriceBook(store, { q: "qc-g20" })).rows.map((row) => row.code), ["gravel"]);
  assert.deepEqual((await listPriceBook(store, { q: "bulk" })).rows.map((row) => row.code), ["sand"]);
  assert.deepEqual((await listPriceBook(store, { category: "Materials", sort: "cost", dir: "desc" })).rows.map((row) => row.code), ["gravel", "sand"]);
  assert.deepEqual((await listPriceBook(store, { category: "" })).rows.map((row) => row.code), ["kit"]);
  assert.deepEqual((await listPriceBook(store, { tag: "aggregate", sort: "code" })).rows.map((row) => row.code), ["gravel", "sand"]);
  assert.deepEqual((await listPriceBook(store, { supplier: supplier.uid })).rows.map((row) => row.code), ["gravel"]);
  assert.deepEqual((await listPriceBook(store, { status: "archived" })).rows.map((row) => row.code), ["retired"]);
  const page = await listPriceBook(store, { sort: "code", limit: 2, offset: 2 });
  assert.deepEqual([page.total, page.rows.map((row) => row.code)], [4, ["labour", "sand"]]);
});

test("bulk preview shows before and after with margin warnings and skips what it cannot change", async (t) => {
  const { store } = await freshStore(t);
  await seed(store);
  const uids = (await listPriceBook(store, {})).rows.map((row) => row.uid);
  const versionBefore = (await store.catalogVersion()).version;
  const preview = await previewBulk(store, { uids, op: { setMarkupPct: 40 } });
  assert.equal((await store.catalogVersion()).version, versionBefore, "a preview writes nothing");
  const byCode = Object.fromEntries(preview.rows.map((row) => [row.code, row]));
  assert.equal(byCode.gravel.action, "update");
  assert.equal(byCode.gravel.after.sell, 70);
  assert.equal(byCode.gravel.after.sell_mode, "markup");
  assert.ok(byCode.gravel.warnings.some((warning) => warning.code === "mode_change"));
  assert.equal(byCode.sand.after.sell, 42);
  assert.equal(byCode.kit.action, "skip");
  assert.match(byCode.kit.reason, /rolls up/);
  assert.deepEqual(preview.summary, { selected: 4, updated: 3, skipped: 1, warnings: 2 });

  const cost = await previewBulk(store, { uids, op: { adjustCostPct: 100 } });
  const labour = cost.rows.find((row) => row.code === "labour");
  assert.equal(labour.after.cost, 90);
  assert.ok(labour.warnings.some((warning) => warning.code === "negative_margin"));
  assert.equal(cost.rows.find((row) => row.code === "sand").after.sell, 90, "a markup item's sell follows its cost");

  const sell = await previewBulk(store, { uids, op: { adjustSellPct: 10 } });
  assert.equal(sell.rows.find((row) => row.code === "gravel").after.sell, 88);
  assert.match(sell.rows.find((row) => row.code === "sand").reason, /follows its markup/);

  await assert.rejects(previewBulk(store, { uids, op: { setMarkupPct: 1, adjustCostPct: 2 } }), /exactly one/);
  await assert.rejects(previewBulk(store, { uids: [], op: { setMarkupPct: 1 } }), /at least one/);
});

test("bulk apply is one transaction with bulk price rows, history, and stale previews refused", async (t) => {
  const { store } = await freshStore(t);
  await seed(store);
  const rows = (await listPriceBook(store, { category: "Materials" })).rows;
  const uids = rows.map((row) => row.uid);
  const expectedVersions = Object.fromEntries(rows.map((row) => [row.uid, row.version]));
  await store.updateItem("gravel", { name: "Gravel 20 mm" });
  await assert.rejects(applyBulk(store, { uids, op: { adjustCostPct: 10 }, expectedVersions }), { code: "VERSION_CONFLICT", message: /changed since the preview/ });
  assert.equal((await store.getItem("sand")).buy_price, 30, "nothing applied");

  const fresh = Object.fromEntries((await listPriceBook(store, { category: "Materials" })).rows.map((row) => [row.uid, row.version]));
  const before = (await store.catalogVersion()).version;
  const applied = await applyBulk(store, { uids, op: { adjustCostPct: 10 }, expectedVersions: fresh, author: "Estimator" });
  assert.equal(applied.summary.updated, 2);
  assert.equal((await store.catalogVersion()).version, before + 1);
  assert.equal((await store.getItem("gravel")).buy_price, 55);
  assert.equal((await store.getItem("sand")).sell_price, 49.5);
  assert.equal((await store.getPriceHistory("sand"))[0].sell_price, 49.5, "a markup item's row records the sell its markup gives");
  const [latest] = await store.getPriceHistory("gravel");
  assert.equal(latest.source, "bulk");
  assert.equal(latest.source_ref, applied.bulkId);
  const history = await store.getItemHistory("gravel");
  assert.ok(history.some((row) => row.field === "buy_price" && row.new_value === "55" && row.changed_by === "Estimator"));
});

test("bulk archive warns about items still in use and never deletes", async (t) => {
  const { store } = await freshStore(t);
  await seed(store);
  const gravel = await store.getItem("gravel");
  const preview = await previewBulk(store, { uids: [gravel.uid], op: { archive: true } });
  assert.match(preview.rows[0].warnings[0].message, /kit kit/);
  await applyBulk(store, { uids: [gravel.uid], op: { archive: true } });
  assert.equal((await store.getItem("gravel")).status, "archived");
  assert.equal((await store.getItem("kit")).effective_sell_price, null, "the kit is unpriced, not zero");
  const category = await applyBulk(store, { uids: [(await store.getItem("labour")).uid], op: { setCategory: "Crew" } });
  assert.equal(category.summary.updated, 1);
  assert.equal((await store.getItem("labour")).category, "Crew");
});

test("suppliers: create, rename, archive, link items with unique supplier codes", async (t) => {
  const { store } = await freshStore(t);
  await seed(store);
  const quarry = await createSupplier(store, { name: "Quarry Co", account_number: "A-1", default_markup_pct: "20" });
  assert.equal(quarry.default_markup_pct, 20);
  await assert.rejects(createSupplier(store, { name: "quarry co" }), { code: "CODE_CONFLICT" });
  await assert.rejects(createSupplier(store, { name: " " }), /name is required/);
  const other = await createSupplier(store, { name: "Other" });

  let links = await upsertItemSupplier(store, "gravel", { supplier_uid: quarry.uid, supplier_code: "G20", pack_qty: 2 }, { author: "Estimator" });
  assert.equal(links.length, 1);
  assert.equal(links[0].is_default, true, "the first link is the default");
  assert.equal(links[0].pack_qty, 2);
  links = await upsertItemSupplier(store, "gravel", { supplier_uid: other.uid, supplier_code: "X", is_default: true });
  assert.deepEqual(links.map((link) => [link.supplier_name, link.is_default]), [["Other", true], ["Quarry Co", false]]);
  await assert.rejects(upsertItemSupplier(store, "sand", { supplier_uid: quarry.uid, supplier_code: "g20" }), { code: "CODE_CONFLICT", message: /already linked to Gravel 20mm/ });
  links = await removeItemSupplier(store, "gravel", links[0].id);
  assert.equal(links.length, 1);
  assert.deepEqual((await listItemSuppliers(store, "gravel")).map((link) => link.supplier_code), ["G20"]);
  assert.ok((await store.getItemHistory("gravel")).some((row) => row.field === "suppliers.Quarry Co"));

  const renamed = await updateSupplier(store, other.uid, { name: "Other Pty", status: "archived" });
  assert.equal(renamed.name, "Other Pty");
  assert.deepEqual((await listSuppliers(store)).map((supplier) => [supplier.name, supplier.item_count]), [["Quarry Co", 1]]);
  assert.equal((await listSuppliers(store, { includeArchived: true })).length, 2);
  assert.equal(await updateSupplier(store, "sup_missing", { name: "x" }), null);
});

test("health: stale prices, scheduled changes and staged imports are reported, nothing is changed", async (t) => {
  let now = new Date("2026-01-01T00:00:00Z");
  const { store } = await freshStore(t, { clock: () => now });
  await seed(store);
  now = new Date("2027-06-01T00:00:00Z");
  const report = await priceBookHealth(store.db, await store.getState(), { now });
  const stale = report.checks.find((check) => check.key === "stale_price");
  assert.equal(stale.count, 3, "active manually priced items untouched for a year (the kit rolls up)");
  assert.equal(report.issues.filter((issue) => issue.key === "stale_price").length, 3);
  assert.equal(report.checks.find((check) => check.key === "staged_import").count, 0);
});

// ── HTTP ──

async function startServer(t) {
  const handle = await createTestDb();
  const store = await openCatalogStore({ db: handle.db });
  const dataDir = await mkdtemp(join(tmpdir(), "field-price-book-"));
  const app = express();
  app.use(express.json());
  app.use("/api/price-catalog", createPriceCatalogRouter({ store, dataDir }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await handle.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/price-catalog`;
  const call = async (path, { method = "GET", body, form } = {}) => {
    const init = { method, headers: { "X-Actor-Name": "Estimator" } };
    if (form) init.body = form;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() };
  };
  return { store, call };
}

test("HTTP: grid, inline edit with expectedVersion, bulk, suppliers and a multipart import round trip", async (t) => {
  const { store, call } = await startServer(t);
  await seed(store);

  const grid = await call("/grid?q=gravel");
  assert.equal(grid.status, 200);
  assert.equal(grid.body.rows[0].code, "gravel");
  const row = grid.body.rows[0];

  const edited = await call(`/items/${row.uid}`, { method: "PATCH", body: { name: "Gravel, 20mm", expectedVersion: row.version } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.name, "Gravel, 20mm");
  assert.equal(edited.body.code, "gravel", "a rename never changes the item's code");
  const stale = await call(`/items/${row.uid}`, { method: "PATCH", body: { name: "Stale", expectedVersion: row.version } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "VERSION_CONFLICT");
  const recoded = await call(`/items/${row.uid}`, { method: "PATCH", body: { code: "sand" } });
  assert.equal(recoded.status, 400);
  assert.equal(recoded.body.code, "CODE_READ_ONLY");

  const preview = await call("/bulk/preview", { method: "POST", body: { uids: [row.uid], op: { adjustSellPct: 10 } } });
  assert.equal(preview.body.rows[0].after.sell, 88);
  const bad = await call("/bulk/apply", { method: "POST", body: { uids: [row.uid], op: { adjustSellPct: 10 }, expectedVersions: { [row.uid]: row.version } } });
  assert.equal(bad.status, 409);
  const unversioned = await call("/bulk/apply", { method: "POST", body: { uids: [row.uid], op: { adjustSellPct: 10 } } });
  assert.equal(unversioned.status, 400, "the route requires the preview's versions");
  assert.equal(unversioned.body.code, "INVALID");

  const supplier = await call("/suppliers", { method: "POST", body: { name: "Quarry Co" } });
  assert.equal(supplier.status, 201);
  const linked = await call("/items/gravel/suppliers", { method: "POST", body: { supplier_uid: supplier.body.uid, supplier_code: "G20" } });
  assert.equal(linked.body[0].supplier_code, "G20");

  const csv = "SKU,Description,Price\nG20,Gravel,60\nNEW,Geofabric,3\n";
  const inspectForm = new FormData();
  inspectForm.append("file", new Blob([csv], { type: "text/csv" }), "quarry.csv");
  inspectForm.append("supplier_uid", supplier.body.uid);
  const inspected = await call("/imports/inspect", { method: "POST", form: inspectForm });
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.columnMap, { supplier_code: "SKU", name: "Description", cost: "Price" });

  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "quarry.csv");
  form.append("supplier_uid", supplier.body.uid);
  form.append("column_map", JSON.stringify(inspected.body.columnMap));
  const staged = await call("/imports", { method: "POST", form });
  assert.equal(staged.status, 201);
  assert.deepEqual(staged.body.rows.map((r) => r.match), ["changed", "new"]);
  assert.equal(staged.body.rows[0].decision, "skip", "+20% is a large change: skipped unless chosen");
  assert.equal(staged.body.file_name, "quarry.csv");

  const health = await call("/health");
  assert.equal(health.body.checks.find((check) => check.key === "staged_import").count, 1);

  const applied = await call(`/imports/${staged.body.uid}/apply`, { method: "POST", body: { decisions: { 1: "apply" } } });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.result.applied, 1);
  assert.equal((await call("/items/gravel")).body.buy_price, 60);
  const again = await call(`/imports/${staged.body.uid}/apply`, { method: "POST", body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "IMPORT_NOT_STAGED");

  const json = await call("/imports", { method: "POST", body: { supplier_uid: supplier.body.uid, csv, column_map: { supplier_code: "SKU", cost: "Price" } } });
  assert.equal(json.status, 201);
  const discarded = await call(`/imports/${json.body.uid}/discard`, { method: "POST", body: {} });
  assert.equal(discarded.body.status, "discarded");
  assert.deepEqual((await call("/imports")).body.map((record) => record.status), ["discarded", "applied"]);
  assert.deepEqual((await call("/imports?status=applied")).body.map((record) => record.status), ["applied"]);
  const twoStatuses = await call("/imports?status=staged&status=applied");
  assert.equal(twoStatuses.status, 400, "a repeated status is a bad request, not a 500");
  assert.equal((await call("/imports?status=nope")).status, 400);

  const missingFile = await call("/imports", { method: "POST", body: { supplier_uid: supplier.body.uid } });
  assert.equal(missingFile.status, 400);
});

test("bulk cost edits keep sub-cent precision, skip no-op rows and require every changed item's version", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "screw", name: "Screw", unit: "each", buy_price: 0.0375, sell_price: 0.1 });
  const screw = await store.getItem("screw");
  const zero = await previewBulk(store, { uids: [screw.uid], op: { adjustCostPct: 0 } });
  assert.equal(zero.rows[0].action, "skip", "0% changes nothing, so no price row");
  assert.equal(zero.rows[0].reason, "No change at that percentage");
  const doubled = await previewBulk(store, { uids: [screw.uid], op: { adjustCostPct: 100 } });
  assert.equal(doubled.rows[0].after.cost, 0.075, "not rounded to 0.08");
  await assert.rejects(applyBulk(store, { uids: [screw.uid], op: { adjustCostPct: 100 }, expectedVersions: {} }), { code: "VERSION_CONFLICT", message: /not in the preview/ });
  const applied = await applyBulk(store, { uids: [screw.uid], op: { adjustCostPct: 100 }, expectedVersions: { [screw.uid]: doubled.rows[0].version } });
  assert.equal(applied.summary.updated, 1);
  assert.equal((await store.getItem("screw")).buy_price, 0.075);
  const sellZero = await previewBulk(store, { uids: [screw.uid], op: { adjustSellPct: 0 } });
  assert.equal(sellZero.rows[0].action, "skip");
});
