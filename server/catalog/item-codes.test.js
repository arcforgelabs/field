// Item codes leave Field's outputs (code retirement step 6).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";

import { createTestDb } from "../db-runtime/index.js";
import { createPriceCatalogRouter } from "../price-catalog/catalog-api.js";
import { openCatalogStore } from "./index.js";
import { omitItemCodes } from "./item-codes.js";

test("omitItemCodes drops item codes, keeps other codes, and keeps a reference for what has no uid", () => {
  assert.deepEqual(omitItemCodes({
    uid: "u1", code: "A", tax_code: "GST", unit_code: "each", supplier_code: "S-1",
    children: [{ uid: "u2", code: "B", child_code: "B" }],
    issues: [{ key: "missing_referenced_item", code: "DRAIN-PIT", uid: null }, { key: "x", code: "A", uid: "u1", relatedCodes: ["C"] }],
  }), {
    uid: "u1", tax_code: "GST", unit_code: "each", supplier_code: "S-1",
    children: [{ uid: "u2" }],
    issues: [{ key: "missing_referenced_item", reference: "DRAIN-PIT", uid: null }, { key: "x", uid: "u1" }],
  });
});

test("the catalogue API omits codes on request, keeps them (deprecated) by default, and accepts legacy codes on input", async (t) => {
  const handle = await createTestDb();
  const store = await openCatalogStore({ db: handle.db });
  const dataDir = mkdtempSync(join(tmpdir(), "field-item-codes-"));
  const app = express();
  app.use(express.json());
  app.use("/api/price-catalog", createPriceCatalogRouter({ store, dataDir }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => { await new Promise((r) => server.close(r)); await handle.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/price-catalog`;
  const omit = { Prefer: "field-item-codes=omit", "Content-Type": "application/json" };

  const kit = await store.createItem({ code: "KIT-OLD", name: "Kit", unit: "each", buy_price_mode: "computed", sell_price_mode: "computed" });
  const part = await store.createItem({ code: "PART-OLD", name: "Part", unit: "each", buy_price: 4, sell_price: 6 });
  // A legacy code still names the child on input.
  const added = await fetch(`${base}/items/${kit.uid}/children`, { method: "POST", headers: omit, body: JSON.stringify({ child_code: "part-old", quantity: 2 }) });
  assert.equal(added.status, 201);

  const lean = await fetch(`${base}/items/KIT-OLD`, { headers: omit });
  assert.equal(lean.headers.get("preference-applied"), "field-item-codes=omit");
  const leanBody = await lean.json();
  assert.equal(leanBody.uid, kit.uid);
  assert.equal("code" in leanBody, false);
  assert.deepEqual(leanBody.children.map((c) => [c.uid, "code" in c]), [[part.uid, false]]);
  const list = await (await fetch(`${base}/items`, { headers: omit })).json();
  assert.ok(list.every((row) => !("code" in row)));
  const grid = await (await fetch(`${base}/grid?status=all`, { headers: omit })).json();
  assert.ok(grid.rows.every((row) => !("code" in row)));

  const legacy = await fetch(`${base}/items/${kit.uid}`);
  assert.match(legacy.headers.get("field-item-codes"), /deprecated/);
  assert.equal((await legacy.json()).code, "KIT-OLD", "older clients still get the code until they ask otherwise");
});
