// Legacy item codes as aliases (code retirement step 2): migration 0006
// backfills every code, keeps new items' codes recorded and stops codes
// changing; the catalogue resolves an item by uid, then by any alias.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite, types } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { createTestDb, MIGRATIONS_FOLDER, queryRows, schema } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { openCatalogStore } from "./index.js";
import { findItem } from "./state.js";

const ROLLBACK_0006 = fileURLToPath(new URL("../db/rollback/0006_item_code_aliases.down.sql", import.meta.url));

function migrationsUpTo(idx) {
  const dir = mkdtempSync(join(tmpdir(), "field-aliases-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  for (const entry of journal.entries.filter((e) => e.idx > idx)) rmSync(join(dir, `${entry.tag}.sql`));
  journal.entries = journal.entries.filter((entry) => entry.idx <= idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function schemaShape(db) {
  const rows = await Promise.all([
    queryRows(sql`select table_name || '.' || column_name || ' ' || data_type as x from information_schema.columns where table_schema = 'public'`, db),
    queryRows(sql`select 'index ' || indexname as x from pg_indexes where schemaname = 'public'`, db),
    queryRows(sql`select 'trigger ' || tgname as x from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal`, db),
    queryRows(sql`select 'function ' || p.proname as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`, db),
    queryRows(sql`select 'policy ' || policyname as x from pg_policies where schemaname = 'public'`, db),
  ]);
  return rows.flat().map((row) => row.x).sort();
}

// Drizzle wraps the database error; the message that matters is its cause's.
const causeMatches = (pattern) => (error) => pattern.test(`${error.message} ${error.cause?.message || ""}`);

const asDefaultOrg = (db, query) => withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(query, tx));

describe("migration 0006 on a populated catalogue", () => {
  let dir0005;
  let dir0006;
  let client;
  let db;

  before(async () => {
    dir0005 = migrationsUpTo(5);
    dir0006 = migrationsUpTo(6);
    client = new PGlite({ parsers: { [types.NUMERIC]: (v) => v, [types.INT8]: (v) => v } });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: dir0005 });
    await db.execute(sql`insert into units (code, label, dimension, to_base) values ('each', 'each', 'count', '1') on conflict do nothing`);
    await withOrg(db, DEFAULT_ORG_UID, async (tx) => {
      await tx.execute(sql`insert into tax_codes (code, label, rate) values ('GST', 'GST 10%', '0.1')`);
      await tx.execute(sql`insert into items (uid, code, name, unit_code, created_at, updated_at) values
        ('cat_1', 'EXCAVATOR-HOUR', 'Excavator', 'each', now(), now()),
        ('cat_2', 'retaining-wall__materials-design-allowance', 'Wall materials', 'each', now(), now()),
        ('cat_3', 'cat_3', 'Generated', 'each', now(), now())`);
    });
  });
  after(async () => {
    await client?.close();
    rmSync(dir0005, { recursive: true, force: true });
    rmSync(dir0006, { recursive: true, force: true });
  });

  test("backfills one alias per item code and keeps codes from changing", async () => {
    // Up to 0006 only: later migrations have their own rollbacks, run first.
    await migrate(db, { migrationsFolder: dir0006 });
    const aliases = await asDefaultOrg(db, sql`select code, item_uid from item_code_aliases order by item_uid`);
    assert.deepEqual(aliases, [
      { code: "EXCAVATOR-HOUR", item_uid: "cat_1" },
      { code: "retaining-wall__materials-design-allowance", item_uid: "cat_2" },
      { code: "cat_3", item_uid: "cat_3" },
    ]);
    await assert.rejects(
      withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update items set code = 'EXC' where uid = 'cat_1'`)),
      causeMatches(/legacy aliases and cannot change/),
    );
    // A rename leaves the code (and its alias) alone.
    await withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update items set name = 'Excavator, wet hire' where uid = 'cat_1'`));
    // A new item's code is recorded; a code that is another item's alias is refused.
    await withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`insert into items (uid, code, name, unit_code, created_at, updated_at) values ('cat_4', 'cat_4', 'New', 'each', now(), now())`));
    const [added] = await asDefaultOrg(db, sql`select item_uid from item_code_aliases where code = 'cat_4'`);
    assert.equal(added.item_uid, "cat_4");
    await assert.rejects(
      withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`insert into items (uid, code, name, unit_code, created_at, updated_at) values ('cat_5', 'excavator-hour', 'Other', 'each', now(), now())`)),
      causeMatches(/duplicate key|already an alias/),
    );
    // Deleting an item removes its aliases with it.
    await withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`delete from items where uid = 'cat_4'`));
    assert.deepEqual(await asDefaultOrg(db, sql`select code from item_code_aliases where item_uid = 'cat_4'`), []);
  });

  test("the rollback script returns the database to its 0005 shape with its items", async () => {
    // Continues from the test above: `client` is at 0006.
    await client.exec(readFileSync(ROLLBACK_0006, "utf8"));
    const reference = new PGlite();
    try {
      await migrate(drizzle(reference, { schema }), { migrationsFolder: dir0005 });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference, { schema })));
    } finally {
      await reference.close();
    }
    const items = await asDefaultOrg(db, sql`select uid, code from items order by uid`);
    assert.deepEqual(items.map((row) => row.code), ["EXCAVATOR-HOUR", "retaining-wall__materials-design-allowance", "cat_3"]);
    // Forward again: 0006 re-applies and backfills.
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const [count] = await asDefaultOrg(db, sql`select count(*)::int as n from item_code_aliases`);
    assert.equal(count.n, 3);
  });
});

describe("the catalogue resolves items by uid, then by legacy code", () => {
  test("every code resolves to its item both ways, and health counts no code without an alias", async (t) => {
    const handle = await createTestDb();
    t.after(() => handle.close());
    const store = await openCatalogStore({ db: handle.db });
    const coded = await store.createItem({ code: "LABOURER-HOUR", name: "Labourer", unit: "hour", buy_price: 50, sell_price: 80 });
    const plain = await store.createItem({ name: "Crushed rock, 20mm", unit: "tonne", buy_price: 40, sell_price: 60 });
    assert.equal(plain.code, plain.uid, "an item made without a code is keyed by its uid");

    const state = await store.getState();
    assert.equal(state.byCode.size, state.items.size, "one alias per item, no more");
    for (const item of state.items.values()) {
      for (const code of state.codesByUid.get(item.uid)) {
        assert.equal(findItem(state, code).uid, item.uid, `${code} -> ${item.uid}`);
        assert.equal(findItem(state, code.toLowerCase()).uid, item.uid);
      }
      assert.equal(findItem(state, item.uid).uid, item.uid);
    }
    assert.equal((await store.getItem("labourer-hour")).uid, coded.uid);

    const report = await store.health();
    assert.equal(report.summary.codeAliasMissingCount, 0);
    assert.equal(report.checks.find((check) => check.key === "code_alias_missing").ok, true);

    // An alias row removed behind the store's back is reported, not hidden.
    await withOrg(handle.db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`delete from item_code_aliases where item_uid = ${coded.uid}`));
    store.invalidate();
    const broken = await store.health();
    assert.equal(broken.summary.codeAliasMissingCount, 1);
    assert.equal(broken.issues.find((issue) => issue.key === "code_alias_missing").uid, coded.uid);
    assert.equal((await store.getItem("LABOURER-HOUR")).uid, coded.uid, "the item's own code still resolves");
  });

  test("a new item cannot take a code another item answers to", async (t) => {
    const handle = await createTestDb();
    t.after(() => handle.close());
    const store = await openCatalogStore({ db: handle.db });
    await store.createItem({ code: "EXCAVATOR-HOUR", name: "Excavator", unit: "hour", buy_price: 100, sell_price: 150 });
    await assert.rejects(store.createItem({ code: "excavator-hour", name: "Other" }), { code: "CODE_CONFLICT" });
  });
});
