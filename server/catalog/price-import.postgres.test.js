// Supplier imports and bulk edits racing on a real PostgreSQL server
// (postgres.js, separate pooled connections), not PGlite's single session.
// Opt in like the other database tests: FIELD_DB_TEST_DATABASE_URL (CI) or
// FIELD_DB_TEST_DOCKER=1.
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { closeDb, getDb, runMigrations } from "../db-runtime/index.js";
import { startTestPostgres, testPostgresMode } from "../db-runtime/test-postgres.js";
import { openCatalogStore } from "./index.js";
import { applyBulk, createSupplier, upsertItemSupplier } from "./price-book.js";
import { applyImport, discardImport, stageImport } from "./price-import.js";

const skip = testPostgresMode().kind === "none" ? "set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1" : false;

test("real PostgreSQL: concurrent applies, discards and edits never apply a batch twice or lose an edit", { skip }, async (t) => {
  const pg = await startTestPostgres();
  t.after(async () => {
    await closeDb();
    await pg.stop();
  });
  const env = { FIELD_DB_URL: pg.url };
  await runMigrations({ env });
  const db = getDb({ env });
  const store = await openCatalogStore({ db });
  const other = await openCatalogStore({ db });

  await store.createItem({ code: "gravel", name: "Gravel", unit: "m3", buy_price: 50, sell_price: 80 });
  await store.createItem({ code: "pipe", name: "Pipe", unit: "m", buy_price: 10, sell_price: 15 });
  const supplier = await createSupplier(store, { name: "Quarry Co" });
  await upsertItemSupplier(store, "gravel", { supplier_uid: supplier.uid, supplier_code: "G20" });
  await upsertItemSupplier(store, "pipe", { supplier_uid: supplier.uid, supplier_code: "P100" });
  const csv = Buffer.from("SKU,Price\nG20,55\nP100,11\n");
  const map = { supplier_code: "SKU", cost: "Price" };

  // Three callers on two stores race one staged batch: exactly one wins.
  for (let round = 0; round < 3; round += 1) {
    const staged = await stageImport(store, { supplierUid: supplier.uid, bytes: csv, columnMap: map });
    if (!staged.rows.some((row) => row.match === "changed")) break;
    const results = await Promise.allSettled([
      applyImport(store, staged.uid),
      applyImport(other, staged.uid),
      discardImport(other, staged.uid),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, `round ${round}: one winner`);
    for (const result of results.filter((entry) => entry.status === "rejected")) assert.equal(result.reason.code, "IMPORT_NOT_STAGED");
    const [rows] = await db.execute(sql`select count(*)::int as n from item_prices where source_ref = ${staged.uid}`);
    assert.ok([0, 2].includes(Number(rows.n)), `round ${round}: the batch applied whole or not at all (${rows.n} rows)`);
  }

  // An apply racing a manual edit of one of its items: either the edit came
  // first and the apply is refused, or the apply came first and the edit
  // lands on top. Never a silently overwritten edit.
  await store.updateItem("gravel", { buy_price: 50 });
  await store.updateItem("pipe", { buy_price: 10 });
  const staged = await stageImport(store, { supplierUid: supplier.uid, bytes: csv, columnMap: map });
  const [applied, edited] = await Promise.allSettled([
    applyImport(store, staged.uid),
    other.updateItem("gravel", { buy_price: 52 }, { author: "Someone else" }),
  ]);
  assert.equal(edited.status, "fulfilled");
  const gravel = await store.getItem("gravel");
  if (applied.status === "rejected") {
    assert.equal(applied.reason.code, "VERSION_CONFLICT");
    assert.equal(gravel.buy_price, 52);
    assert.equal((await store.getItem("pipe")).buy_price, 10, "nothing from the refused batch");
  } else {
    assert.equal(gravel.buy_price, 52, "the later manual edit is current");
    assert.equal((await store.getItem("pipe")).buy_price, 11);
  }

  // Two bulk edits previewed from the same versions: one wins, one is refused.
  const item = await store.getItem("pipe");
  const expectedVersions = { [item.uid]: item.version };
  const bulk = await Promise.allSettled([
    applyBulk(store, { uids: [item.uid], op: { adjustSellPct: 10 }, expectedVersions }),
    applyBulk(other, { uids: [item.uid], op: { adjustSellPct: 20 }, expectedVersions }),
  ]);
  assert.deepEqual(bulk.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(bulk.find((result) => result.status === "rejected").reason.code, "VERSION_CONFLICT");
  assert.ok([16.5, 18].includes((await store.getItem("pipe")).sell_price));
});
