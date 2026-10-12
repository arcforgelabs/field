import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";

import { createTestDb } from "../db-runtime/index.js";
import { openCatalogStore } from "../catalog/index.js";
import { createPriceCatalogRouter } from "./catalog-api.js";

async function startTestServer(t, { revision = null } = {}) {
  const handle = await createTestDb();
  const store = await openCatalogStore({ db: handle.db });
  const dataDir = await mkdtemp(join(tmpdir(), "field-catalog-api-"));
  const app = express();
  app.use(express.json());
  app.use("/api/price-catalog", createPriceCatalogRouter({ store, dataDir, revision }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await handle.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/price-catalog`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  // A browser's own revalidation: If-None-Match without the Cache-Control:
  // no-cache that Node's fetch adds (which disables Express's freshness check).
  const rawGet = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}${path}`, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    req.end();
  });
  return { store, call, rawGet };
}

test("POST, PATCH and duplicate return 409 with a structured conflict body on an active name collision", async (t) => {
  const { store, call } = await startTestServer(t);
  await store.createItem({ code: "widget-a", name: "Widget Pro" });
  await store.createItem({ code: "widget-b", name: "Widget Basic" });

  const created = await call("POST", "/items", { name: "Widget Pro", unit: "each" });
  assert.equal(created.status, 409);
  assert.equal(created.body.code, "name_conflict");
  assert.equal(created.body.conflict.code, "widget-a");

  const renamed = await call("PATCH", "/items/widget-b", { name: "widget pro" });
  assert.equal(renamed.status, 409);
  assert.equal(renamed.body.conflict.code, "widget-a");

  const duplicated = await call("POST", "/items/widget-b/duplicate", { name: "Widget Pro" });
  assert.equal(duplicated.status, 409);
  assert.equal(duplicated.body.code, "name_conflict");
});

test("draft status is unreachable through the API", async (t) => {
  const { store, call } = await startTestServer(t);
  assert.equal((await call("POST", "/items", { name: "Draft item", unit: "each", status: "draft" })).status, 400);
  await store.createItem({ code: "existing", name: "Existing item" });
  assert.equal((await call("PATCH", "/items/existing", { status: "draft" })).status, 400);
  assert.equal((await store.getItem("existing")).status, "active");
});

test("items: create, read by code or uid, codes never change, refuse a stale version, see price history", async (t) => {
  const { call } = await startTestServer(t);
  const created = await call("POST", "/items", { code: "rate-copy", name: "Rate", unit: "hours", buy_price: 10, sell_price: 20, tags: ["machine"] });
  assert.equal(created.status, 201);
  assert.equal(created.body.unit, "hour");
  assert.deepEqual(created.body.tags, ["machine"]);
  const { uid, version } = created.body;

  assert.equal((await call("GET", `/items/${uid}`)).body.code, "rate-copy");
  const recoded = await call("PATCH", `/items/${uid}`, { code: "RATE", expectedVersion: version });
  assert.equal(recoded.status, 400);
  assert.equal(recoded.body.code, "CODE_READ_ONLY");
  const renamed = await call("PATCH", `/items/${uid}`, { name: "Rate, per hour", sell_price: 22, expectedVersion: version, reason: "tidy" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.code, "rate-copy");
  assert.equal(renamed.body.name, "Rate, per hour");
  assert.equal(renamed.body.version, version + 1);

  const stale = await call("PATCH", "/items/RATE-COPY", { sell_price: 30 }, { "If-Match": String(version) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "VERSION_CONFLICT");

  const prices = await call("GET", "/items/rate-copy/prices");
  assert.deepEqual(prices.body.map((row) => [row.sell_price, row.current]), [[22, true], [20, false]]);
  assert.equal(prices.body[0].reason, "tidy");

  const current = await call("GET", `/items/${uid}/current-price`);
  assert.equal(current.body.priceId, prices.body[0].price_id);
  assert.equal((await call("GET", "/items/missing")).status, 404);
});

test("items take internal notes and a type over HTTP; an unknown type is refused", async (t) => {
  const { call } = await startTestServer(t);
  const created = await call("POST", "/items", { name: "Post", unit: "each", type: "material", notes: "Order in 6 m lengths", description: "Galvanised post" });
  assert.equal(created.status, 201);
  assert.equal(created.body.type, "material");
  assert.equal(created.body.notes, "Order in 6 m lengths");
  assert.equal(created.body.is_sold, false);
  assert.equal(created.body.pricing_method, "fixed");
  const patched = await call("PATCH", `/items/${created.body.uid}`, { notes: "Trade price only", type: "kit" });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.body.notes, patched.body.type, patched.body.description], ["Trade price only", "kit", "Galvanised post"]);
  const bad = await call("PATCH", `/items/${created.body.uid}`, { type: "plant" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.path, "type");
});

test("effective_from in the future is refused on create and update (FUTURE_PRICE_UNSUPPORTED)", async (t) => {
  const { store, call } = await startTestServer(t);
  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const created = await call("POST", "/items", { code: "gravel", name: "Gravel", unit: "tonne", buy_price: 40, sell_price: 60, effective_from: future });
  assert.equal(created.status, 400);
  assert.equal(created.body.code, "FUTURE_PRICE_UNSUPPORTED");
  assert.equal(created.body.path, "effective_from");
  assert.equal(await store.getItem("gravel"), null);

  await call("POST", "/items", { code: "gravel", name: "Gravel", unit: "tonne", buy_price: 40, sell_price: 60 });
  const scheduled = await call("PATCH", "/items/gravel", { sell_price: 70, effective_from: future });
  assert.equal(scheduled.status, 400);
  assert.equal(scheduled.body.code, "FUTURE_PRICE_UNSUPPORTED");
  const prices = await call("GET", "/items/gravel/prices");
  assert.deepEqual(prices.body.map((row) => row.sell_price), [60], "no row was written");
  const renamed = await call("PATCH", "/items/gravel", { name: "Gravel 20mm", effective_from: future });
  assert.equal(renamed.status, 200, "effective_from only dates a price change; a name-only edit ignores it");
  assert.equal(renamed.body.name, "Gravel 20mm");
});

test("items carry a per-item ETag that If-Match takes back; the catalogue ETag is refused clearly", async (t) => {
  const { call } = await startTestServer(t);
  const created = await call("POST", "/items", { code: "rate", name: "Rate", buy_price: 10, sell_price: 20 });
  const createdTag = created.headers.get("etag");
  assert.match(createdTag, new RegExp(`^W/"item-${created.body.uid}-v1@catalog-\\d+-\\d+"$`));
  assert.equal(created.headers.get("x-field-item-version"), "1");
  const read = await call("GET", "/items/rate");
  assert.match(read.headers.get("etag"), new RegExp(`^W/"item-${created.body.uid}-v1@`));

  const updated = await call("PATCH", "/items/rate", { sell_price: 22 }, { "If-Match": read.headers.get("etag") });
  assert.equal(updated.status, 200);
  assert.match(updated.headers.get("etag"), new RegExp(`^W/"item-${created.body.uid}-v2@`));
  assert.equal((await call("PATCH", "/items/rate", { name: "Rate" }, { "If-Match": `W/"item-${created.body.uid}-v2"` })).status, 200, "the bare item tag is still accepted");
  const stale = await call("PATCH", "/items/rate", { sell_price: 23 }, { "If-Match": createdTag });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "VERSION_CONFLICT");

  const other = await call("POST", "/items", { code: "other", name: "Other", buy_price: 1, sell_price: 2 });
  const wrongItem = await call("PATCH", "/items/rate", { sell_price: 23 }, { "If-Match": other.headers.get("etag").replace("-v1@", "-v3@") });
  assert.equal(wrongItem.status, 400);

  const listTag = (await call("GET", "/items")).headers.get("etag");
  const catalogueTag = await call("PATCH", "/items/rate", { sell_price: 23 }, { "If-Match": listTag });
  assert.equal(catalogueTag.status, 400);
  assert.match(catalogueTag.body.error, /item's ETag/);
  assert.equal((await call("GET", "/items/rate")).body.sell_price, 22);
});

test("the catalogue ETag folds in the build revision, so a deploy never answers 304 to old rows", async (t) => {
  const { call } = await startTestServer(t, { revision: "abc123" });
  await call("POST", "/items", { code: "a", name: "A", buy_price: 1, sell_price: 2 });
  const first = await call("GET", "/items");
  const etag = first.headers.get("etag");
  assert.match(etag, /^W\/"catalog-\d+-\d+-abc123"$/);
  assert.equal((await call("GET", "/items", null, { "If-None-Match": etag })).status, 304);
  assert.equal((await call("GET", "/items", null, { "If-None-Match": etag.replace("-abc123", "-old") })).status, 200);
  assert.equal((await call("GET", "/version")).body.etag, etag);
});

test("an item's ETag never answers 304 over a stale roll-up after a kit child's price changes", async (t) => {
  const { store, call, rawGet } = await startTestServer(t);
  await call("POST", "/items", { code: "kit", name: "Kit", unit: "m", buy_price_mode: "computed", sell_price_mode: "computed" });
  await call("POST", "/items", { code: "gravel", name: "Gravel", unit: "tonne", buy_price: 50, sell_price: 70 });
  await call("POST", "/items/kit/children", { child_code: "gravel", quantity: 0.3 });

  const first = await rawGet("/items/kit");
  assert.equal(first.status, 200);
  assert.equal(first.body.sell_price, 21);
  assert.equal(first.headers["cache-control"], "no-cache");
  const etag = first.headers.etag;
  assert.equal((await rawGet("/items/kit", { "If-None-Match": etag })).status, 304, "unchanged catalogue still revalidates cheaply");

  // Only the child moves: the kit's own version does not.
  await store.updateItem("gravel", { buy_price: 80, sell_price: 100 });
  const revalidated = await rawGet("/items/kit", { "If-None-Match": etag });
  assert.equal(revalidated.status, 200);
  assert.equal(revalidated.body.sell_price, 30);
  assert.equal(revalidated.body.version, first.body.version, "the kit version did not move, yet the body did");
  assert.notEqual(revalidated.headers.etag, etag);
  assert.equal(revalidated.headers["x-field-item-version"], String(first.body.version));

  // The new tag still works as If-Match for an edit to the kit.
  const renamed = await call("PATCH", "/items/kit", { name: "Kit A" }, { "If-Match": revalidated.headers.etag });
  assert.equal(renamed.status, 200);
});

test("an item's ETag folds in the build revision, so a deploy never answers 304 to rows built from old recipes", async (t) => {
  const { call, rawGet } = await startTestServer(t, { revision: "abc123" });
  await call("POST", "/items", { code: "a", name: "A", buy_price: 1, sell_price: 2 });
  const read = await rawGet("/items/a");
  assert.match(read.headers.etag, /^W\/"item-.+-v1@catalog-\d+-\d+-abc123"$/);
  assert.equal((await rawGet("/items/a", { "If-None-Match": read.headers.etag })).status, 304);
  assert.equal((await rawGet("/items/a", { "If-None-Match": read.headers.etag.replace("-abc123", "-old") })).status, 200);
});

test("kit children: unit mismatches and cycles are typed errors", async (t) => {
  const { call } = await startTestServer(t);
  await call("POST", "/items", { code: "kit", name: "Kit", unit: "m", buy_price_mode: "computed", sell_price_mode: "computed" });
  await call("POST", "/items", { code: "gravel", name: "Gravel", unit: "tonne", buy_price: 50, sell_price: 70 });
  const mismatch = await call("POST", "/items/kit/children", { child_code: "gravel", quantity: 1, entry_quantity: 1, entry_unit: "m" });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, "UNIT_MISMATCH");
  const added = await call("POST", "/items/kit/children", { child_code: "gravel", quantity: 0.3 });
  assert.equal(added.status, 201);
  assert.equal(added.body.code, "gravel");
  const cycle = await call("POST", "/items/gravel/children", { child_code: "kit", quantity: 1 });
  assert.equal(cycle.status, 409);
  const kit = await call("GET", "/items/kit/kit");
  assert.equal(kit.body.sell, 21);
  assert.equal(kit.body.components[0].item.code, "gravel");
});

test("the item list carries the catalogue ETag and answers 304 when it has not changed", async (t) => {
  const { call } = await startTestServer(t);
  await call("POST", "/items", { code: "a", name: "A", buy_price: 1, sell_price: 2 });
  const first = await call("GET", "/items");
  const etag = first.headers.get("etag");
  assert.match(etag, /^W\/"catalog-\d+-\d+"$/);
  assert.equal((await call("GET", "/items", null, { "If-None-Match": etag })).status, 304);
  await call("PATCH", "/items/a", { sell_price: 3 });
  const changed = await call("GET", "/items", null, { "If-None-Match": etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  const version = await call("GET", "/version");
  assert.equal(version.body.etag, changed.headers.get("etag"));
});

test("health, export, price maps and categories", async (t) => {
  const { call } = await startTestServer(t);
  await call("POST", "/items", { code: "a", name: "A", buy_price: 1, sell_price: 2, category: "Goods" });
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.summary.totalItems, 1);
  const exported = await call("GET", "/export");
  assert.equal(exported.body.format, "field-price-catalogue-export");
  assert.equal(exported.body.counts.items, 1);
  assert.equal(exported.body.tables.items[0].code, "a");
  assert.deepEqual((await call("GET", "/price-maps")).body.sellMap, { a: 2 });
  assert.equal((await call("POST", "/categories", { name: "Goods" })).status, 201);
  assert.equal((await call("POST", "/categories", { name: "goods" })).status, 409);
  const other = await call("POST", "/categories", { name: "Labour" });
  const reordered = await call("POST", "/categories/reorder", { ids: [other.body.id] });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.body.map((category) => category.name), ["Labour", "Goods"]);
  assert.equal((await call("POST", "/categories/reorder", { ids: [12345] })).status, 404);
});
