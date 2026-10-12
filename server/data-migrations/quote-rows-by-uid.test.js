// Code retirement step 3: quote rows keyed by uid, as a boot data
// migration with a dry run, verified before writing and recorded once.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";

import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { openCatalogStore } from "../catalog/index.js";
import { resolveActiveJobGeneration } from "../job-generation.js";
import { DataMigrationError, runDataMigrations } from "./index.js";
import { quoteRowsByUid, rekeyQuoteDocument } from "./quote-rows-by-uid.js";

async function catalogue(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db });
  const wall = await store.createItem({ code: "retaining-wall", name: "Retaining wall", unit: "m", buy_price: 375, sell_price: 450 });
  const sleeper = await store.createItem({ code: "SLEEPER-KENSINGTON", name: "Sleeper", unit: "each", buy_price: 20, sell_price: 35 });
  const fill = await store.createItem({ code: "imported-fill", name: "Imported fill", unit: "m3", buy_price: 70, sell_price: 85 });
  return { db: handle.db, store, wall, sleeper, fill };
}

function quoteDocument({ version = 1, sleeperUid = null } = {}) {
  return {
    version,
    quoteNumber: "EQ-2601-01",
    summary: "Retaining wall",
    lineItems: [
      { code: "retaining-wall__section-wall", label: "Retaining wall", quantity: 10, unit: "m", unitPrice: 450, totalPrice: 4500, unitCost: 375, totalCost: 3750, quoteCatalogItemCode: "retaining-wall", quoteCatalogEntry: { code: "retaining-wall", authorityItemCode: "retaining-wall" } },
      { code: "wall-zone-1", label: "Wall zone", quantity: 1, unit: "job", unitPrice: 100, totalPrice: 100, unitCost: 50, totalCost: 50 },
    ],
    presentation: {
      organizer: {
        root: ["source:retaining-wall__section-wall", "source:wall-zone-1", "manual:sleeper", "manual:fill", "manual:typed", "manual:gone", "group:a"],
        nodes: {
          "source:retaining-wall__section-wall": { kind: "source", origin: "engine", sourceKind: "customer_schedule_item", sourceCode: "retaining-wall__section-wall" },
          "source:wall-zone-1": { kind: "source", origin: "engine", sourceKind: "customer_schedule_item", sourceCode: "wall-zone-1" },
          "manual:sleeper": { kind: "source", origin: "manual", sourceCode: "manual-sleeper", labelOverride: "Sleeper", quantity: 12, unit: "each", sellRate: 35, buyRate: 20, rateMode: "catalog-linked", catalogItemCode: "sleeper-kensington", ...(sleeperUid ? { catalogItemUid: sleeperUid } : {}) },
          "manual:fill": { kind: "source", origin: "manual", sourceCode: "manual-fill", labelOverride: "Fill", quantity: 3, unit: "m3", sellRate: 85, buyRate: 70, rateMode: "catalog-linked", catalogItemCode: "imported-fill" },
          "manual:typed": { kind: "source", origin: "manual", sourceCode: "manual-typed", labelOverride: "Hand-typed line", quantity: 1, unit: "job", sellRate: 50, buyRate: 0 },
          "manual:gone": { kind: "source", origin: "manual", sourceCode: "manual-gone", labelOverride: "Gone", quantity: 1, unit: "each", sellRate: 9, buyRate: 5, rateMode: "catalog-linked", catalogItemCode: "NO-SUCH-ITEM" },
          "group:a": { kind: "group", title: "Walls", children: [] },
        },
      },
    },
  };
}

test("rekeyQuoteDocument adds uids next to codes and changes nothing else", async (t) => {
  const { store, wall, sleeper, fill } = await catalogue(t);
  const state = await store.getState();
  const before = quoteDocument({ sleeperUid: sleeper.uid });
  const { document, changes, unresolved } = rekeyQuoteDocument(state, before);
  const nodes = document.presentation.organizer.nodes;
  assert.equal(nodes["source:retaining-wall__section-wall"].sourceUid, wall.uid, "an engine row gets its line's item");
  assert.equal(nodes["manual:sleeper"].sourceUid, sleeper.uid, "a linked row's uid is its source");
  assert.equal(nodes["manual:fill"].catalogItemUid, fill.uid, "a code-only row is linked by uid");
  assert.equal(nodes["manual:fill"].catalogItemCode, "imported-fill", "the code stays as history");
  assert.equal(nodes["manual:fill"].sourceUid, fill.uid);
  assert.equal("sourceUid" in nodes["manual:typed"], false, "a typed row has no item");
  assert.equal("sourceUid" in nodes["source:wall-zone-1"], false, "an engine line with no catalogue item stays as it is");
  assert.equal("catalogItemUid" in nodes["manual:gone"], false);
  assert.deepEqual(unresolved.map((row) => [row.nodeId, row.code]), [["manual:gone", "NO-SUCH-ITEM"]]);
  assert.deepEqual(changes.map((change) => `${change.nodeId}.${change.field}`).sort(), [
    "manual:fill.catalogItemUid", "manual:fill.sourceUid", "manual:sleeper.sourceUid", "source:retaining-wall__section-wall.sourceUid",
  ]);
  assert.deepEqual(before, quoteDocument({ sleeperUid: sleeper.uid }), "the input is not mutated");
  assert.equal(rekeyQuoteDocument(state, document).changes.length, 0, "a second pass changes nothing");
});

function writeJob(dataDir, { withVersion = true } = {}) {
  const jobDir = join(dataDir, "2026-01-15", "job-one");
  mkdirSync(join(jobDir, "issued-documents"), { recursive: true });
  writeFileSync(join(jobDir, "meta.json"), JSON.stringify({ id: "job-one", title: "Retaining wall, Unley" }, null, 2));
  writeFileSync(join(jobDir, "quote.json"), JSON.stringify(quoteDocument({ version: 2 }), null, 2));
  writeFileSync(join(jobDir, "quote-overrides.json"), JSON.stringify({ presentation: { organizer: quoteDocument().presentation.organizer } }, null, 2));
  writeFileSync(join(jobDir, "issued-documents", "EQ-2601-01-v1.pdf"), "%PDF-1.3 issued bytes");
  if (withVersion) {
    mkdirSync(join(jobDir, "quote-versions", "v001"), { recursive: true });
    writeFileSync(join(jobDir, "quote-versions", "v001", "quote.json"), JSON.stringify(quoteDocument({ version: 1 }), null, 2));
  }
  return jobDir;
}

test("dry run reports every change and writes nothing; apply writes a new generation once, verified, and is recorded", async (t) => {
  const { db, store, fill } = await catalogue(t);
  const dataDir = mkdtempSync(join(tmpdir(), "field-rekey-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const jobDir = writeJob(dataDir);
  const original = readFileSync(join(jobDir, "quote.json"), "utf8");
  const context = { db, orgUid: DEFAULT_ORG_UID, dataDir, getState: () => store.getState({ fresh: true }), catalogStore: store, logger: { log() {}, warn() {} }, migrations: [quoteRowsByUid] };

  const dry = await runDataMigrations({ ...context, mode: "dry-run" });
  assert.equal(dry[0].status, "would-apply");
  assert.equal(dry[0].summary.jobs, 1);
  assert.equal(dry[0].summary.files, 3, "current quote, its overrides and the saved version");
  assert.equal(dry[0].summary.catalogItemUid, 6, "sleeper and fill rows, linked by code only, in each file");
  assert.equal(dry[0].summary.unresolved, 3, "the missing code, once per file");
  assert.equal(dry[0].summary.pdfsCompared, 2, "both quote.json files render byte-identical PDFs");
  assert.ok(dry[0].changes.every((change) => change.job === "2026-01-15/job-one"));
  assert.equal(readFileSync(join(jobDir, "quote.json"), "utf8"), original, "the dry run wrote nothing");
  assert.equal(existsSync(join(jobDir, ".field-generations")), false);
  assert.deepEqual(await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select id from data_migrations`, tx)), []);

  let flushed = 0;
  const applied = await runDataMigrations({ ...context, flush: async () => { flushed += 1; } });
  assert.equal(applied[0].status, "applied");
  assert.equal(flushed, 1, "durable storage is flushed once, after every job");
  const activeDir = await resolveActiveJobGeneration(jobDir);
  assert.notEqual(activeDir, jobDir, "written as a commercial generation");
  const current = JSON.parse(readFileSync(join(activeDir, "quote.json"), "utf8"));
  assert.equal(current.presentation.organizer.nodes["manual:fill"].catalogItemUid, fill.uid);
  const version = JSON.parse(readFileSync(join(activeDir, "quote-versions", "v001", "quote.json"), "utf8"));
  assert.equal(version.presentation.organizer.nodes["manual:fill"].catalogItemUid, fill.uid);
  assert.equal(readFileSync(join(activeDir, "issued-documents", "EQ-2601-01-v1.pdf"), "utf8"), "%PDF-1.3 issued bytes");
  const [ledger] = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select id, summary from data_migrations`, tx));
  assert.equal(ledger.id, quoteRowsByUid.id);
  assert.equal((typeof ledger.summary === "string" ? JSON.parse(ledger.summary) : ledger.summary).catalogItemUid, 6);

  const again = await runDataMigrations({ ...context });
  assert.equal(again[0].status, "already-applied", "recorded migrations never run again");
});

test("nothing is written when verification fails", async (t) => {
  const { db, store } = await catalogue(t);
  const dataDir = mkdtempSync(join(tmpdir(), "field-rekey-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const jobDir = writeJob(dataDir, { withVersion: false });
  const context = { db, orgUid: DEFAULT_ORG_UID, dataDir, getState: () => store.getState({ fresh: true }), logger: { log() {}, warn() {} } };
  // A plan that would also change a price must be refused.
  const tampering = {
    ...quoteRowsByUid,
    plan: async (ctx) => {
      const planned = await quoteRowsByUid.plan(ctx);
      planned.jobs[0].files[0].after.presentation.organizer.nodes["manual:fill"].sellRate = 99;
      return planned;
    },
  };
  await assert.rejects(runDataMigrations({ ...context, migrations: [tampering] }), (error) => (
    error instanceof DataMigrationError && /something other than the added uids/.test(error.message)
  ));
  assert.equal(existsSync(join(jobDir, ".field-generations")), false);
  assert.deepEqual(await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select id from data_migrations`, tx)), []);
});

test("a held migration is skipped and not recorded", async (t) => {
  const { db, store } = await catalogue(t);
  const dataDir = mkdtempSync(join(tmpdir(), "field-rekey-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeJob(dataDir);
  const report = await runDataMigrations({ db, orgUid: DEFAULT_ORG_UID, dataDir, getState: () => store.getState(), hold: [quoteRowsByUid.id], logger: { log() {}, warn() {} }, migrations: [quoteRowsByUid] });
  assert.equal(report[0].status, "held");
  assert.deepEqual(await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select id from data_migrations`, tx)), []);
});
