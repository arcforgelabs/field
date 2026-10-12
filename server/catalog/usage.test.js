// "Used on N quotes" (#178): which jobs' quotes price a row from each item.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";

import { createTestDb } from "../db-runtime/index.js";
import { createPriceCatalogRouter } from "../price-catalog/catalog-api.js";
import { openCatalogStore } from "./index.js";
import { createQuoteUsage } from "./usage.js";

function writeQuote(dir, document) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "quote.json"), JSON.stringify(document, null, 2));
}

function quote({ number, version, sent = false, nodes, lineItems = [] }) {
  return {
    version,
    quoteNumber: number,
    ...(sent ? { quoteSentAt: "2026-01-10T00:00:00.000Z" } : {}),
    lineItems,
    presentation: { organizer: { root: Object.keys(nodes), nodes } },
  };
}

async function setup(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db });
  const wall = await store.createItem({ code: "retaining-wall", name: "Retaining wall", unit: "m", buy_price: 375, sell_price: 450 });
  const sleeper = await store.createItem({ code: "SLEEPER-KENSINGTON", name: "Sleeper", unit: "each", buy_price: 20, sell_price: 35 });
  const unused = await store.createItem({ name: "Unused", unit: "each", buy_price: 1, sell_price: 2 });
  const dataDir = mkdtempSync(join(tmpdir(), "field-usage-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const a = join(dataDir, "2026-01-12", "job-a");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "meta.json"), JSON.stringify({ id: "job-a", title: "Wall, Unley", updatedAt: "2026-01-12T00:00:00.000Z" }));
  writeQuote(a, quote({
    number: "EQ-2601-01",
    version: 1,
    nodes: {
      "source:wall__s": { kind: "source", origin: "engine", sourceCode: "wall__s" },
      "manual:sleeper": { kind: "source", origin: "manual", sourceCode: "manual-sleeper", catalogItemUid: sleeper.uid, catalogItemCode: "SLEEPER-KENSINGTON" },
      "manual:typed": { kind: "source", origin: "manual", sourceCode: "manual-typed", labelOverride: "Typed" },
    },
    lineItems: [{ code: "wall__s", quoteCatalogEntry: { authorityItemCode: "retaining-wall" } }],
  }));

  const b = join(dataDir, "2026-01-14", "job-b");
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "meta.json"), JSON.stringify({ id: "job-b", title: "Sleepers, Exampleton", updatedAt: "2026-01-14T00:00:00.000Z", lastSentQuoteVersion: 1 }));
  writeQuote(join(b, "quote-versions", "v001"), quote({
    number: "EQ-2601-02",
    version: 1,
    sent: true,
    nodes: { "manual:sleeper": { kind: "source", origin: "manual", sourceCode: "manual-sleeper", catalogItemCode: "sleeper-kensington" } },
  }));
  writeQuote(b, quote({
    number: "EQ-2601-02",
    version: 2,
    nodes: { "manual:sleeper": { kind: "source", origin: "manual", sourceCode: "manual-sleeper", sourceUid: sleeper.uid } },
  }));
  return { handle, store, dataDir, wall, sleeper, unused };
}

test("usage counts jobs by uid, legacy code and engine line, newest first", async (t) => {
  const { store, dataDir, wall, sleeper, unused } = await setup(t);
  const usage = createQuoteUsage({ dataDir, getState: () => store.getState() });

  const sleeperUsage = await usage.forItem(sleeper.uid);
  assert.equal(sleeperUsage.quote_count, 2);
  assert.equal(sleeperUsage.version_count, 3);
  assert.deepEqual(sleeperUsage.jobs.map((job) => [job.job_id, job.quote_number, job.versions, job.sent, job.on_current_quote]), [
    ["job-b", "EQ-2601-02", [1, 2], true, true],
    ["job-a", "EQ-2601-01", [1], false, true],
  ]);
  assert.equal((await usage.forItem(sleeper.uid, { limit: 1 })).jobs.length, 1);
  assert.equal((await usage.forItem(wall.uid)).quote_count, 1, "an engine row counts for its line's item");
  assert.deepEqual(await usage.forItem(unused.uid).then((u) => [u.quote_count, u.jobs]), [0, []]);
  const counts = await usage.counts();
  assert.deepEqual(counts.items[sleeper.uid], { quote_count: 2, version_count: 3 });
  assert.equal(counts.items[unused.uid], undefined);
});

test("GET /items/:code/usage and /usage over HTTP", async (t) => {
  const { store, dataDir, sleeper } = await setup(t);
  const app = express();
  app.use(express.json());
  app.use("/api/price-catalog", createPriceCatalogRouter({ store, dataDir }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/price-catalog`;
  const byUid = await (await fetch(`${base}/items/${sleeper.uid}/usage?limit=10`)).json();
  assert.equal(byUid.quote_count, 2);
  const byCode = await (await fetch(`${base}/items/SLEEPER-KENSINGTON/usage`)).json();
  assert.equal(byCode.item_uid, sleeper.uid, "a legacy code still finds the item");
  assert.equal((await fetch(`${base}/items/missing/usage`)).status, 404);
  const counts = await (await fetch(`${base}/usage`)).json();
  assert.equal(counts.items[sleeper.uid].quote_count, 2);
});
