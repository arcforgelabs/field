import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { createTestDb } from "../db-runtime/index.js";
import { openCatalogStore } from "./index.js";
import { createSupplier, upsertItemSupplier } from "./price-book.js";
import { applyImport, discardImport, getImport, inspectPriceList, stageImport } from "./price-import.js";
import { selectRows } from "./state.js";

async function freshStore(t, options = {}) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db, ...options });
  return { store, db: handle.db };
}

// A small synthetic catalogue: a fixed-sell item and a pack item linked by
// supplier code, a markup item matched by Field's code, a kit priced by
// roll-up, and a linked item the supplier's file no longer lists.
async function seed(store) {
  await store.createItem({ code: "gravel", name: "Gravel 20mm", unit: "m3", buy_price: 50, sell_price: 80, category: "Materials" });
  await store.createItem({ code: "sand", name: "Washed sand", unit: "tonne", buy_price: 30, markup_pct: 50, sell_mode: "markup" });
  await store.createItem({ code: "pipe", name: "Pipe 100mm", unit: "m", buy_price: 10, sell_price: 15 });
  await store.createItem({ code: "mesh", name: "Mesh", unit: "each", buy_price: 8, sell_price: 12 });
  await store.createItem({ code: "kit", name: "Drain kit", unit: "m", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.addChild({ parentCode: "kit", childCode: "pipe", quantity: 1 });
  await store.createItem({ code: "old-item", name: "Old item", unit: "each", buy_price: 5, sell_price: 9 });
  const supplier = await createSupplier(store, { name: "Quarry Co", default_markup_pct: 25 });
  await upsertItemSupplier(store, "gravel", { supplier_uid: supplier.uid, supplier_code: "G20" });
  await upsertItemSupplier(store, "pipe", { supplier_uid: supplier.uid, supplier_code: "P100", pack_qty: 6 });
  await upsertItemSupplier(store, "mesh", { supplier_uid: supplier.uid, supplier_code: "M1" });
  await upsertItemSupplier(store, "kit", { supplier_uid: supplier.uid, supplier_code: "KIT1" });
  await upsertItemSupplier(store, "old-item", { supplier_uid: supplier.uid, supplier_code: "OLD9" });
  return supplier;
}

const CSV = [
  "Supplier Code,Field Code,Description,UOM,Price",
  "G20,,Gravel 20mm,m3,55",
  ",sand,Washed sand,t,30",
  "P100,,Pipe 100mm (6m),m,66",
  "KIT1,,Drain kit,m,100",
  "NEW1,,Geofabric,m2,4.5",
  "DUP,,Thing A,each,1",
  "DUP,,Thing B,each,2",
  "M1,sand,Mesh,each,9",
  "BAD,,Bad price,each,call us",
].join("\n");

const MAP = { supplier_code: "Supplier Code", item_code: "Field Code", name: "Description", unit: "UOM", cost: "Price" };

function byCode(record, supplierCode) {
  return record.rows.filter((row) => row.supplier_code === supplierCode);
}

async function stage(store, supplier, overrides = {}) {
  return stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from(overrides.csv || CSV), fileName: "quarry.csv", columnMap: MAP, author: "Estimator", ...overrides });
}

test("staging classifies every row with old → new cost and delta, and changes no prices", async (t) => {
  const { store, db } = await freshStore(t);
  const supplier = await seed(store);
  const before = await store.catalogVersion();
  const staged = await stage(store, supplier);
  assert.equal(staged.status, "staged");
  assert.deepEqual(staged.summary.counts, { changed: 2, unchanged: 1, new: 1, missing: 1, ambiguous: 3, invalid: 2 });

  const [gravel] = byCode(staged, "G20");
  assert.equal(gravel.match, "changed");
  assert.equal(gravel.decision, "apply");
  assert.equal(gravel.matched_by, "supplier_code");
  assert.deepEqual([gravel.old_cost, gravel.new_cost, gravel.delta_pct], [50, 55, 10]);
  assert.equal(gravel.new_sell, 80, "a fixed sell price stays put");

  const sand = staged.rows.find((row) => row.item?.code === "sand" && row.matched_by === "item_code");
  assert.equal(sand.match, "unchanged");
  assert.equal(sand.decision, "skip");

  const [pipe] = byCode(staged, "P100");
  assert.equal(pipe.new_cost, 11, "pack of 6 divides the cost");
  assert.ok(pipe.flags.some((flag) => flag.code === "pack"));

  assert.equal(byCode(staged, "KIT1")[0].match, "invalid");
  assert.match(byCode(staged, "KIT1")[0].issues[0].message, /priced from its components/);
  assert.equal(byCode(staged, "NEW1")[0].match, "new");
  assert.deepEqual(byCode(staged, "DUP").map((row) => row.match), ["ambiguous", "ambiguous"]);
  assert.equal(byCode(staged, "M1")[0].match, "ambiguous");
  assert.match(byCode(staged, "M1")[0].issues[0].message, /different items/);
  assert.equal(byCode(staged, "BAD")[0].match, "invalid");
  const [missing] = byCode(staged, "OLD9");
  assert.equal(missing.match, "missing");
  assert.equal(missing.decision, "skip", "a missing item is kept by default");

  assert.equal((await store.catalogVersion()).version, before.version, "staging is not a catalogue write");
  assert.equal((await store.getItem("gravel")).buy_price, 50);
  const [count] = await selectRows(db, sql`select count(*)::int as n from item_prices where source = 'import'`);
  assert.equal(count.n, 0);

  // The column map is saved for the supplier's next file.
  const inspected = await inspectPriceList(store, { bytes: Buffer.from(CSV), supplierUid: supplier.uid });
  assert.equal(inspected.columnMapSource, "supplier");
  assert.deepEqual(inspected.columnMap, MAP);
});

test("apply writes import prices, creates and archives only what was chosen, in one transaction", async (t) => {
  const { store, db } = await freshStore(t);
  const supplier = await seed(store);
  const staged = await stage(store, supplier);
  const newRow = byCode(staged, "NEW1")[0];
  const missingRow = byCode(staged, "OLD9")[0];
  const before = await store.catalogVersion();
  const applied = await applyImport(store, staged.uid, { decisions: { [newRow.row_no]: "create", [missingRow.row_no]: "archive" }, author: "Estimator" });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.result, { applied: 2, created: 1, archived: 1, skipped: 6 });
  assert.equal((await store.catalogVersion()).version, before.version + 1, "one catalogue write");

  const gravel = await store.getItem("gravel");
  assert.equal(gravel.buy_price, 55);
  assert.equal(gravel.sell_price, 80);
  const history = await store.getPriceHistory("gravel");
  assert.equal(history[0].source, "import");
  assert.equal(history[0].source_ref, staged.uid);
  assert.equal(history[0].current, true);
  assert.equal((await store.getItem("pipe")).buy_price, 11);

  const created = (await store.listItems({ status: "draft" })).find((item) => item.name === "Geofabric");
  assert.ok(created, "the new row became a draft item");
  assert.equal(created.buy_price, 4.5);
  assert.equal(created.sell_mode, "markup");
  assert.equal(created.markup_pct, 25, "the supplier's default markup");

  const old = await store.getItem("old-item");
  assert.equal(old.status, "archived", "archived, not deleted");
  const [links] = await selectRows(db, sql`select count(*)::int as n from item_suppliers where supplier_code = 'NEW1'`);
  assert.equal(links.n, 1, "a created item is linked to the supplier code");

  await assert.rejects(applyImport(store, staged.uid), { code: "IMPORT_NOT_STAGED", statusCode: 409 });
  await assert.rejects(discardImport(store, staged.uid), { code: "IMPORT_NOT_STAGED" });
});

test("refused decisions: a row can only take the decisions its match allows", async (t) => {
  const { store } = await freshStore(t);
  const supplier = await seed(store);
  const staged = await stage(store, supplier);
  const ambiguous = byCode(staged, "DUP")[0];
  await assert.rejects(applyImport(store, staged.uid, { decisions: { [ambiguous.row_no]: "apply" } }), /can be skip, not apply/);
  assert.equal((await getImport(store, staged.uid)).status, "staged");
});

test("discard leaves the catalogue untouched and the batch can no longer be applied", async (t) => {
  const { store, db } = await freshStore(t);
  const supplier = await seed(store);
  const staged = await stage(store, supplier);
  const before = await store.catalogVersion();
  const discarded = await discardImport(store, staged.uid, { author: "Estimator" });
  assert.equal(discarded.status, "discarded");
  assert.equal((await store.catalogVersion()).version, before.version);
  assert.equal((await store.getItem("gravel")).buy_price, 50);
  await assert.rejects(applyImport(store, staged.uid), { code: "IMPORT_NOT_STAGED" });
  const [count] = await selectRows(db, sql`select count(*)::int as n from item_prices where source = 'import'`);
  assert.equal(count.n, 0);
});

test("concurrency: an item re-priced after staging refuses the whole apply", async (t) => {
  const { store } = await freshStore(t);
  const supplier = await seed(store);
  const staged = await stage(store, supplier);
  await store.updateItem("gravel", { buy_price: 52 }, { author: "Someone else" });
  await assert.rejects(applyImport(store, staged.uid), { code: "VERSION_CONFLICT", message: /Gravel 20mm \(gravel\) was re-priced/ });
  assert.equal((await store.getItem("pipe")).buy_price, 10, "nothing from the batch was applied");
  assert.equal((await getImport(store, staged.uid)).status, "staged");
});

test("concurrency: two applies of one batch apply it once", async (t) => {
  const { store, db } = await freshStore(t);
  const supplier = await seed(store);
  const staged = await stage(store, supplier);
  const results = await Promise.allSettled([applyImport(store, staged.uid), applyImport(store, staged.uid), discardImport(store, staged.uid)]);
  const winners = results.map((result, index) => (result.status === "fulfilled" ? index : null)).filter((index) => index != null);
  assert.equal(winners.length, 1);
  for (const result of results.filter((entry) => entry.status === "rejected")) assert.equal(result.reason.code, "IMPORT_NOT_STAGED");
  const [count] = await selectRows(db, sql`select count(*)::int as n from item_prices where source = 'import' and item_uid = (select uid from items where code = 'gravel')`);
  assert.equal(count.n, winners[0] === 2 ? 0 : 1, "applied exactly once, or not at all when the discard won");
});

test("a future effective date schedules the prices; they become current on the date", async (t) => {
  let now = new Date();
  const { store, db } = await freshStore(t, { clock: () => now });
  const supplier = await seed(store);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const staged = await stage(store, supplier, { effectiveFrom: tomorrow.toISOString() });
  await applyImport(store, staged.uid);
  assert.equal((await store.getItem("gravel")).buy_price, 50, "not yet");
  await assert.rejects(store.updateItem("gravel", { buy_price: 51 }), { code: "PENDING_PRICE_CHANGE" });
  const again = await stage(store, supplier);
  assert.equal(byCode(again, "G20")[0].match, "invalid");
  assert.match(byCode(again, "G20")[0].issues[0].message, /scheduled/);

  now = new Date(tomorrow.getTime() + 60 * 1000);
  assert.equal((await store.getItem("gravel")).buy_price, 55, "current from its date");
  const [rows] = await selectRows(db, sql`select count(*)::int as n from item_prices where source = 'import'`);
  assert.equal(rows.n, 2);
});

test("units: a per-tonne price list prices a per-m3 item through its density; no conversion is invalid", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "fill", name: "Clean fill", unit: "m3", buy_price: 70, sell_price: 100, pricing_basis: "per_tonne", pricing_basis_factor: 1.6 });
  await store.createItem({ code: "post", name: "Post", unit: "each", buy_price: 20, sell_price: 30 });
  const supplier = await createSupplier(store, { name: "Tip" });
  const csv = "Code,Unit,Price\nfill,tonne,50\npost,m,5\n";
  const staged = await stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from(csv), columnMap: { item_code: "Code", unit: "Unit", cost: "Price" } });
  const [fill, post] = staged.rows;
  assert.equal(fill.match, "changed");
  assert.equal(fill.new_cost, 80, "50 per tonne × 1.6 t per m3");
  assert.equal(post.match, "invalid");
  assert.match(post.issues[0].message, /no conversion/);
});

test("staging refuses an unknown supplier, a column map without cost, and an empty file", async (t) => {
  const { store } = await freshStore(t);
  const supplier = await createSupplier(store, { name: "Quarry Co" });
  await assert.rejects(stageImport(store, { supplierUid: "sup_nope", bytes: Buffer.from(CSV), columnMap: MAP }), { code: "UNKNOWN_REF" });
  await assert.rejects(stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from(CSV), columnMap: { name: "Description" } }), /cost/);
  await assert.rejects(stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from(""), columnMap: MAP }), /empty/);
});

// ── Review fixes: what staging assumed must still hold at apply ──

async function importRows(db) {
  const [row] = await selectRows(db, sql`select count(*)::int as n from item_prices where source = 'import'`);
  return row.n;
}

test("units: a unit change between staging and apply refuses the apply; nothing is written", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "rock", name: "Rock", unit: "tonne", buy_price: 40, sell_price: 60 });
  const supplier = await createSupplier(store, { name: "Quarry Co" });
  const staged = await stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from("code,price,unit\nrock,45,t\n"), columnMap: { item_code: "code", cost: "price", unit: "unit" } });
  assert.equal(staged.rows[0].match, "changed");
  assert.deepEqual([staged.rows[0].old_cost, staged.rows[0].new_cost], [40, 45]);

  // A unit edit adds no price row, so the re-price guard alone would let this through.
  await store.updateItem("rock", { unit: "m3" });
  await assert.rejects(applyImport(store, staged.uid), (err) => {
    assert.equal(err.code, "VERSION_CONFLICT");
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /Rock \(rock\)'s unit, pack size or pricing changed after this file was staged.*stage the file again/);
    return true;
  });
  assert.equal(await importRows(db), 0, "no item_prices row");
  assert.equal((await store.getItem("rock")).buy_price, 40);
  assert.equal((await getImport(store, staged.uid)).status, "staged");

  // Restaging classifies the same file against the new unit: no t ↔ m3 conversion.
  const again = await stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from("code,price,unit\nrock,45,t\n"), columnMap: { item_code: "code", cost: "price", unit: "unit" } });
  assert.equal(again.rows[0].match, "invalid");
  assert.match(again.rows[0].issues[0].message, /no conversion/);
});

test("units: a pack size or conversion change between staging and apply refuses the apply", async (t) => {
  const { store, db } = await freshStore(t);
  const supplier = await seed(store);
  const staged = await stage(store, supplier);
  assert.equal(byCode(staged, "P100")[0].new_cost, 11, "staged as a pack of 6");
  await upsertItemSupplier(store, "pipe", { supplier_uid: supplier.uid, supplier_code: "P100", pack_qty: 3 });
  await assert.rejects(applyImport(store, staged.uid), { code: "VERSION_CONFLICT", message: /Pipe 100mm \(pipe\)'s unit, pack size or pricing changed/ });
  assert.equal(await importRows(db), 0);

  // A per-tonne file for a per-m3 item: changing the density changes the cost.
  await store.createItem({ code: "fill", name: "Clean fill", unit: "m3", buy_price: 70, sell_price: 100, pricing_basis: "per_tonne", pricing_basis_factor: 1.6 });
  const tip = await createSupplier(store, { name: "Tip" });
  const fill = await stageImport(store, { supplierUid: tip.uid, bytes: Buffer.from("Code,Unit,Price\nfill,tonne,50\n"), columnMap: { item_code: "Code", unit: "Unit", cost: "Price" } });
  assert.equal(fill.rows[0].new_cost, 80);
  await store.updateItem("fill", { pricing_basis_factor: 1.8 });
  await assert.rejects(applyImport(store, fill.uid), { code: "VERSION_CONFLICT" });
  assert.equal(await importRows(db), 0);

  // Unrelated edits (a rename) do not block the apply.
  const ok = await stageImport(store, { supplierUid: tip.uid, bytes: Buffer.from("Code,Unit,Price\nfill,tonne,50\n"), columnMap: { item_code: "Code", unit: "Unit", cost: "Price" } });
  await store.updateItem("fill", { name: "Clean fill (VENM)" });
  const applied = await applyImport(store, ok.uid, { decisions: { 1: "apply" } });
  assert.equal(applied.result.applied, 1);
  assert.equal((await store.getItem("fill")).buy_price, 90, "50 per tonne × 1.8 t per m3");
});

test("a scheduled import price blocks unit, pricing-basis and price-mode changes until its date", async (t) => {
  const now = new Date();
  const { store } = await freshStore(t, { clock: () => now });
  const supplier = await seed(store);
  const staged = await stage(store, supplier, { effectiveFrom: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() });
  await applyImport(store, staged.uid);
  await assert.rejects(store.updateItem("gravel", { unit: "tonne" }), { code: "PENDING_PRICE_CHANGE", path: "unit" });
  await assert.rejects(store.updateItem("gravel", { sell_mode: "markup", markup_pct: 30 }), { code: "PENDING_PRICE_CHANGE" });
  await assert.rejects(store.updateItem("gravel", { pricing_basis: "per_tonne", pricing_basis_factor: 1.5 }), { code: "PENDING_PRICE_CHANGE" });
  assert.equal((await store.getItem("gravel")).unit, "m3");
  const renamed = await store.updateItem("gravel", { name: "Gravel 20mm blue" });
  assert.equal(renamed.name, "Gravel 20mm blue", "edits that do not change what the price means still work");
});

test("decimal-comma files: a ;-separated 12,75 is 12.75, and an ambiguous 1,275 is invalid", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "rock", name: "Rock", unit: "tonne", buy_price: 12.5, sell_price: 20 });
  await store.createItem({ code: "sand", name: "Sand", unit: "tonne", buy_price: 10, sell_price: 20 });
  const supplier = await createSupplier(store, { name: "Steinbruch" });
  const staged = await stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from("code;price\nrock;12,75\nsand;1,275\n"), columnMap: { item_code: "code", cost: "price" } });
  const [rock, sand] = staged.rows;
  assert.equal(rock.match, "changed");
  assert.deepEqual([rock.old_cost, rock.new_cost, rock.delta_pct], [12.5, 12.75, 2]);
  assert.equal(rock.decision, "apply");
  assert.equal(sand.match, "invalid");
  assert.match(sand.issues[0].message, /ambiguous in a ;-separated file/);
});

test("cautious defaults: a large change or a name-only match is staged as skip and flagged", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "rock", name: "Rock", unit: "tonne", buy_price: 40, sell_price: 60 });
  await store.createItem({ code: "sand", name: "Washed sand", unit: "tonne", buy_price: 30, sell_price: 45 });
  const supplier = await createSupplier(store, { name: "Quarry Co" });
  const staged = await stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from("code,name,price\nrock,,80\n,Washed sand,31\n"), columnMap: { item_code: "code", name: "name", cost: "price" } });
  const [rock, sand] = staged.rows;
  assert.equal(rock.match, "changed");
  assert.equal(rock.decision, "skip", "+100% is not applied unless chosen");
  assert.ok(rock.flags.some((flag) => flag.code === "large_change"));
  assert.equal(sand.match, "changed");
  assert.equal(sand.matched_by, "name");
  assert.equal(sand.decision, "skip", "a name match is not applied unless chosen");
  assert.ok(sand.flags.some((flag) => flag.code === "name_match"));

  const applied = await applyImport(store, staged.uid);
  assert.deepEqual(applied.result, { applied: 0, created: 0, archived: 0, skipped: 2 });
  const chosen = await stageImport(store, { supplierUid: supplier.uid, bytes: Buffer.from("code,name,price\nrock,,80\n,Washed sand,31\n"), columnMap: { item_code: "code", name: "name", cost: "price" } });
  const result = await applyImport(store, chosen.uid, { decisions: { 1: "apply", 2: "apply" } });
  assert.equal(result.result.applied, 2);
  assert.equal((await store.getItem("rock")).buy_price, 80);
});

test("no effective date: the price takes effect when applied, not when staged", async (t) => {
  let now = new Date("2026-10-01T00:00:00.000Z");
  const { store } = await freshStore(t, { clock: () => now });
  const supplier = await seed(store);
  const staged = await stage(store, supplier, { clock: () => now });
  assert.equal(staged.effective_from, null, "stored as 'on apply'");
  now = new Date("2026-10-04T09:30:00.000Z");
  const applied = await applyImport(store, staged.uid);
  assert.equal(applied.effective_from, now.toISOString(), "the import records the date it took effect");
  const [latest] = await store.getPriceHistory("gravel");
  assert.equal(latest.source, "import");
  assert.equal(latest.effective_from, now.toISOString(), "not backdated to staging");
});
