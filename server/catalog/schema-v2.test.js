// Catalogue schema v2, part one (pricing engine phase 1): migration 0007 (kit_components,
// items.type, the assembly tables dropped) and its rollback, the one price()
// function and the price-equality gate.
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
import { capturePrices, comparePrices, price } from "./price.js";

const ROLLBACK_0007 = fileURLToPath(new URL("../db/rollback/0007_catalogue_schema_v2.down.sql", import.meta.url));

function migrationsUpTo(idx) {
  const dir = mkdtempSync(join(tmpdir(), "field-schema-v2-"));
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
    queryRows(sql`select table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' default=' || coalesce(column_default, '') as x from information_schema.columns where table_schema = 'public'`, db),
    queryRows(sql`select c.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) as x from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`, db),
    queryRows(sql`select indexname || ' ' || indexdef as x from pg_indexes where schemaname = 'public'`, db),
    queryRows(sql`select relname || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind in ('r', 'S')`, db),
    queryRows(sql`select 'policy ' || tablename || '.' || policyname as x from pg_policies where schemaname = 'public'`, db),
    queryRows(sql`select 'trigger ' || tgname as x from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal`, db),
  ]);
  return rows.flat().map((row) => row.x).sort();
}

const asDefaultOrg = (db, query) => withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(query, tx));

async function seedAt0006(db) {
  await db.execute(sql`insert into units (code, label, dimension, to_base) values ('each', 'each', 'count', '1') on conflict do nothing`);
  await withOrg(db, DEFAULT_ORG_UID, async (tx) => {
    await tx.execute(sql`insert into tax_codes (code, label, rate) values ('GST', 'GST 10%', '0.1')`);
    await tx.execute(sql`insert into items (uid, code, name, unit_code, cost_mode, sell_mode, created_at, updated_at) values
      ('cat_post', 'POST', 'Post', 'each', 'manual', 'fixed', now(), now()),
      ('cat_wall', 'WALL', 'Wall', 'each', 'rollup', 'rollup', now(), now())`);
    await tx.execute(sql`insert into item_components (parent_uid, child_uid, quantity, created_at) values ('cat_wall', 'cat_post', '2', now())`);
  });
}

describe("migration 0007 on a populated catalogue", () => {
  let dir0006;
  let dir0007;
  let client;
  let db;

  before(async () => {
    dir0006 = migrationsUpTo(6);
    dir0007 = migrationsUpTo(7);
    client = new PGlite({ parsers: { [types.NUMERIC]: (v) => v, [types.INT8]: (v) => v } });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: dir0006 });
    await seedAt0006(db);
  });
  after(async () => {
    await client?.close();
    rmSync(dir0006, { recursive: true, force: true });
    rmSync(dir0007, { recursive: true, force: true });
  });

  test("renames the components table with its rows, types kits, drops the assembly tables", async () => {
    // Up to 0007 only: later migrations have their own rollbacks, run first.
    await migrate(db, { migrationsFolder: dir0007 });
    assert.deepEqual(await asDefaultOrg(db, sql`select kit_uid, component_uid, quantity from kit_components`), [
      { kit_uid: "cat_wall", component_uid: "cat_post", quantity: "2" },
    ]);
    assert.deepEqual(await asDefaultOrg(db, sql`select uid, type from items order by uid`), [
      { uid: "cat_post", type: null },
      { uid: "cat_wall", type: "kit" },
    ]);
    const tables = await queryRows(sql`select table_name from information_schema.tables where table_schema = 'public' and (table_name like 'assembly%' or table_name like '%_components') order by 1`, db);
    assert.deepEqual(tables.map((row) => row.table_name), ["kit_components"]);
    await assert.rejects(
      withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update items set type = 'plant' where uid = 'cat_post'`)),
      (error) => /items_type_check/.test(`${error.message} ${error.cause?.message}`),
    );
  });

  test("the rollback script returns the database to its 0006 shape with its kits", async () => {
    // Continues from the test above: `client` is at 0007.
    await client.exec(readFileSync(ROLLBACK_0007, "utf8"));
    const reference = new PGlite();
    try {
      await migrate(drizzle(reference, { schema }), { migrationsFolder: dir0006 });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference, { schema })));
    } finally {
      await reference.close();
    }
    assert.deepEqual(await asDefaultOrg(db, sql`select parent_uid, child_uid, quantity from item_components`), [
      { parent_uid: "cat_wall", child_uid: "cat_post", quantity: "2" },
    ]);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    assert.deepEqual(await asDefaultOrg(db, sql`select count(*)::int as n from kit_components`), [{ n: 1 }]);
  });
});

test("migration 0007 refuses to drop an assembly table that holds rows", async (t) => {
  const dir = migrationsUpTo(6);
  const client = new PGlite();
  t.after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: dir });
  await seedAt0006(db);
  await withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`insert into assembly_vars (assembly_uid, name, expr) values ('cat_wall', 'x', '1')`));
  await assert.rejects(migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }), (error) => /assembly_vars holds 1 row/.test(`${error.message} ${error.cause?.message}`));
  // Nothing of 0007 applied.
  const [row] = await queryRows(sql`select count(*)::int as n from information_schema.tables where table_name = 'item_components'`, db);
  assert.equal(row.n, 1);
});

async function freshStore(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  return openCatalogStore({ db: handle.db });
}

describe("price(): the one price function", () => {
  test("fixed, markup and roll-up items, with markup and margin; unknown and archived items", async (t) => {
    const store = await freshStore(t);
    await store.createItem({ code: "post", name: "Post", unit: "each", buy_price: 40, sell_price: 50, type: "material" });
    await store.createItem({ code: "labour", name: "Labourer", unit: "hour", buy_price: 50, markup_pct: 60, type: "labour" });
    const kit = await store.createItem({ code: "wall", name: "Wall", unit: "each", buy_price_mode: "computed", sell_price_mode: "computed" });
    await store.addChild({ parentCode: "wall", childCode: "post", quantity: 2 });
    await store.addChild({ parentCode: "wall", childCode: "labour", quantity: 1.5 });
    const state = await store.getState();

    assert.deepEqual(
      (({ unit_cost, unit_sell, markup_pct, margin_pct, pricing_method }) => ({ unit_cost, unit_sell, markup_pct, margin_pct, pricing_method }))(price(state, "post")),
      { unit_cost: 40, unit_sell: 50, markup_pct: 25, margin_pct: 20, pricing_method: "fixed" },
    );
    assert.equal(price(state, "labour").unit_sell, 80);
    assert.equal(price(state, "labour").pricing_method, "markup");
    const wall = price(state, kit.uid);
    assert.equal(wall.unit_cost, 2 * 40 + 1.5 * 50);
    assert.equal(wall.unit_sell, 2 * 50 + 1.5 * 80);
    assert.equal(wall.pricing_method, "rollup");
    assert.equal(wall.price_uid, null, "no single row holds a rolled-up price");
    assert.match(wall.price_key, /^pk_/);
    assert.equal(price(state, "missing"), null);

    await store.archiveItem("post");
    const later = await store.getState();
    assert.deepEqual(price(later, "post").problems.map((p) => p.kind), ["inactive_item"]);
    assert.equal(price(later, kit.uid).unit_sell, null, "a kit with an archived component is unpriced, never zero");
  });

  test("an item with components is a kit; type is validated and shown with is_sold and pricing_method", async (t) => {
    const store = await freshStore(t);
    const post = await store.createItem({ code: "post", name: "Post", unit: "each", buy_price: 40, sell_price: 50, type: "Material", catalog_type: "goods_service" });
    assert.equal(post.type, "material");
    assert.equal(post.is_sold, true);
    assert.equal(post.pricing_method, "fixed");
    await assert.rejects(store.createItem({ name: "Bad", type: "plant" }), { code: "INVALID", path: "type" });
    const wall = await store.createItem({ name: "Wall", unit: "each", buy_price_mode: "computed", sell_price_mode: "computed" });
    assert.equal(wall.type, null);
    await store.addChild({ parentCode: wall.uid, childCode: "post", quantity: 2 });
    const kit = await store.getItem(wall.uid);
    assert.equal(kit.type, "kit");
    assert.equal(kit.is_sold, false);
    assert.equal(kit.pricing_method, "rollup");
    const retyped = await store.updateItem("post", { type: "equipment" });
    assert.equal(retyped.type, "equipment");
  });

  test("internal notes are their own field, never the customer-facing description", async (t) => {
    const store = await freshStore(t);
    const item = await store.createItem({ name: "Post", unit: "each", description: "Galvanised steel post", notes: "Supplier rounds up to the nearest 6 m" });
    assert.equal(item.notes, "Supplier rounds up to the nearest 6 m");
    assert.equal(item.description, "Galvanised steel post");
    const edited = await store.updateItem(item.uid, { notes: "Ask for the trade price" });
    assert.equal(edited.notes, "Ask for the trade price");
    assert.equal(edited.description, "Galvanised steel post");
    const cleared = await store.updateItem(item.uid, { notes: "" });
    assert.equal(cleared.notes, null);
    const copy = await store.duplicateItem(item.uid);
    assert.equal(copy.description, "Galvanised steel post");
  });
});

describe("the price-equality gate", () => {
  test("a rename passes, a price change fails, and flattening a one-resource wrapper passes", async (t) => {
    const store = await freshStore(t);
    await store.createItem({ code: "exc", name: "Excavator hour", unit: "hour", buy_price: 180, sell_price: 300.4567 });
    await store.createItem({ code: "dig", name: "Excavation", unit: "each", buy_price_mode: "computed", sell_price_mode: "computed" });
    await store.addChild({ parentCode: "dig", childCode: "exc", quantity: 0.25 });
    const wall = await store.createItem({ code: "wall", name: "Wall", unit: "each", buy_price_mode: "computed", sell_price_mode: "computed" });
    await store.addChild({ parentCode: "wall", childCode: "dig", quantity: 3 });
    const before = capturePrices(await store.getState());

    await store.updateItem("wall", { name: "Retaining wall, per bay" });
    // Flatten: the wall takes 3 x 0.25 excavator hours directly, the wrapper goes.
    await store.removeChild({ parentCode: "wall", childCode: "dig" });
    await store.addChild({ parentCode: "wall", childCode: "exc", quantity: 0.75 });
    await store.archiveItem("dig");
    const flattened = capturePrices(await store.getState());
    assert.deepEqual(comparePrices(before, flattened, { allowArchived: [(await store.getItem("dig")).uid] }), { ok: true, compared: 3, changed: [], unpricedArchived: [] });
    assert.equal(comparePrices(before, flattened).ok, false, "archiving is listed unless it was meant");

    await store.updateItem("exc", { sell_price: 301 });
    const repriced = comparePrices(before, capturePrices(await store.getState()), { allowArchived: [(await store.getItem("dig")).uid] });
    assert.equal(repriced.ok, false);
    assert.deepEqual(repriced.changed.map((row) => [row.name, row.change]).sort(), [["Excavation", "price"], ["Excavator hour", "price"], ["Wall", "price"]]);
    assert.equal(repriced.changed.find((row) => row.uid === wall.uid).after.sell, 301 * 0.75);
  });
});
