// The catalogue against a real PostgreSQL server (postgres.js, the driver
// production uses), not PGlite. Opt in like the other database tests:
// FIELD_DB_TEST_DATABASE_URL (CI) or FIELD_DB_TEST_DOCKER=1.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import express from "express";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";

import { closeDb, getDb, runMigrations } from "../db-runtime/index.js";
import { startTestPostgres, testPostgresMode } from "../db-runtime/test-postgres.js";
import { exportCatalog, importLegacyCatalog, openCatalogStore } from "./index.js";
import { createPriceCatalogRouter } from "../price-catalog/catalog-api.js";

const skip = testPostgresMode().kind === "none" ? "set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1" : false;

test("real PostgreSQL: catalogue writes, concurrency, import and export", { skip }, async (t) => {
  const pg = await startTestPostgres();
  t.after(async () => {
    await closeDb();
    await pg.stop();
  });
  const env = { FIELD_DB_URL: pg.url };
  await runMigrations({ env });
  const db = getDb({ env });
  const store = await openCatalogStore({ db });

  // Values round-trip with the same types as on PGlite.
  await store.createItem({ code: "labour", name: "Labour", unit: "hour", buy_price: 50.125, sell_price: 80.5 });
  await store.createItem({ code: "kit", name: "Kit", unit: "m", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.addChild({ parentCode: "kit", childCode: "labour", quantity: 0.083333, entryQuantity: 5, entryUnit: "min" });
  const kit = await store.getItem("kit");
  assert.equal(kit.effective_sell_price, 80.5 * 0.083333);
  assert.equal(kit.children[0].entry_quantity, 5);
  assert.match(kit.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  const price = await store.getCurrentPrice("labour");
  assert.equal(typeof price.priceId, "number");

  // Two writers from the same version: one wins, the other is refused.
  const { version } = await store.getItem("labour");
  const other = await openCatalogStore({ db });
  const results = await Promise.allSettled([
    store.updateItem("labour", { sell_price: 81 }, { expectedVersion: version }),
    other.updateItem("labour", { sell_price: 82 }, { expectedVersion: version }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "VERSION_CONFLICT");
  assert.equal((await store.getItem("labour")).version, version + 1);

  // A write's response is read after its commit, even when a load that began
  // before it (on another postgres.js connection) finishes after it.
  const gate = { hold: null, readDone: null };
  const gated = new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") {
        return async (fn, options) => {
          const result = await target.transaction(fn, options);
          // Hold the whole-catalogue load (repeatable read), not the version check.
          if (options?.isolationLevel === "repeatable read" && gate.hold) {
            gate.readDone?.();
            await gate.hold.promise;
          } else if (!options?.accessMode && gate.hold) {
            const { resolve } = gate.hold;
            gate.hold = null;
            resolve();
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const gatedStore = await openCatalogStore({ db: gated });
  await gatedStore.getItem("labour");
  await other.updateItem("labour", { name: "Labour (renamed)" });
  let release;
  gate.hold = { promise: new Promise((resolve) => { release = resolve; }), resolve: () => release() };
  const readDone = new Promise((resolve) => { gate.readDone = resolve; });
  const inflight = gatedStore.getItem("labour");
  await readDone;
  const updated = await gatedStore.updateItem("labour", { sell_price: 95 });
  const [row] = await db.execute(sql`select version from items where code = 'labour'`);
  assert.equal(updated.sell_price, 95, "the response carries the write");
  assert.equal(updated.version, Number(row.version), "the response version is the stored version");
  await inflight;

  // Future-dated prices are refused on the real server too.
  await assert.rejects(
    store.updateItem("labour", { sell_price: 1 }, { effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() }),
    { code: "FUTURE_PRICE_UNSUPPORTED" },
  );

  // GET /items/:code never answers 304 over a stale kit roll-up when only a
  // child's price moved, even when the write came through another store (as
  // another process would). Raw node:http, as a browser revalidates: Node's
  // fetch adds Cache-Control: no-cache, which hides a wrong 304.
  const uploads = mkdtempSync(join(tmpdir(), "field-catalog-pg-api-"));
  t.after(() => rmSync(uploads, { recursive: true, force: true }));
  const app = express();
  app.use("/c", createPriceCatalogRouter({ store, dataDir: uploads }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const rawGet = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${server.address().port}/c${path}`, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, etag: res.headers.etag, body: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    req.end();
  });
  const before = await rawGet("/items/kit");
  assert.equal((await rawGet("/items/kit", { "If-None-Match": before.etag })).status, 304);
  await other.updateItem("labour", { sell_price: 90 });
  const after = await rawGet("/items/kit", { "If-None-Match": before.etag });
  assert.equal(after.status, 200, "a child price change must not revalidate the kit as fresh");
  assert.equal(after.body.version, before.body.version);
  assert.notEqual(after.body.effective_sell_price, before.body.effective_sell_price);

  // A legacy catalogue replaces this one and verifies on the real server.
  const dir = mkdtempSync(join(tmpdir(), "field-legacy-pg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacyPath = join(dir, "catalog.db");
  const legacy = new Database(legacyPath);
  legacy.exec(readFileSync(new URL("./fixtures/legacy-catalog-v21.sql", import.meta.url), "utf8"));
  legacy.prepare(`INSERT INTO items (uid, code, name, unit, buy_price, sell_price, catalog_type, status, created_at, updated_at)
    VALUES ('cat_a', 'A-1', 'Item A', 'm', 12.34, 15.5, 'goods_service', 'active', '2026-04-02 23:32:00', '2026-04-03 01:00:00'),
           ('cat_b', 'B-1', 'Item B', 'each', 1, 2, 'component', 'active', '2026-04-02 23:32:00', '2026-04-02 23:32:00')`).run();
  legacy.prepare("INSERT INTO component_children (parent_code, child_code, quantity) VALUES ('A-1', 'B-1', 3)").run();
  legacy.close();
  const report = await importLegacyCatalog(db, legacyPath, { replace: true });
  assert.equal(report.verification.ok, true, JSON.stringify(report.verification.failures));
  assert.equal((await store.getItem("A-1")).sell_price, 15.5);

  const exported = await exportCatalog(db);
  assert.equal(exported.counts.items, 2);
  assert.equal(exported.tables.item_prices[0].source, "migration");
});
