// The dry run's throwaway copy (rehearsal.js): a catalogue copied from a
// database on an older schema, migrated to this release, prices intact.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PGlite, types } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { MIGRATIONS_FOLDER, queryRows, schema } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createCatalogStore } from "../catalog/store.js";
import { price } from "../catalog/price.js";
import { copyCatalogueForRehearsal, sourceMigrationLevel } from "./rehearsal.js";

function migrationsUpTo(idx) {
  const dir = mkdtempSync(join(tmpdir(), "field-rehearsal-test-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  for (const entry of journal.entries.filter((e) => e.idx > idx)) rmSync(join(dir, `${entry.tag}.sql`));
  journal.entries = journal.entries.filter((entry) => entry.idx <= idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

test("a catalogue on schema 0005 is copied, migrated to this release and prices the same", async (t) => {
  const dir = migrationsUpTo(5);
  const client = new PGlite({ parsers: { [types.NUMERIC]: (v) => v, [types.INT8]: (v) => v } });
  t.after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = drizzle(client, { schema });
  await migrate(source, { migrationsFolder: dir });
  await source.execute(sql`insert into units (code, label, dimension, to_base) values ('each', 'each', 'count', '1'), ('hour', 'hour', 'time', '60') on conflict do nothing`);
  await withOrg(source, DEFAULT_ORG_UID, async (tx) => {
    await tx.execute(sql`insert into tax_codes (code, label, rate) values ('GST', 'GST 10%', '0.1')`);
    await tx.execute(sql`insert into catalog_meta (id, version, updated_at) values (1, 7, now())`);
    await tx.execute(sql`insert into categories (id, name, parent_id, created_at, updated_at) values (2, 'Walls', null, now(), now()), (3, 'Posts', 2, now(), now())`);
    await tx.execute(sql`insert into items (uid, code, name, unit_code, cost_mode, sell_mode, category, created_at, updated_at) values
      ('cat_post', 'POST', 'Post', 'each', 'manual', 'fixed', 'Posts', now(), now()),
      ('cat_hour', 'EXCAVATOR-HOUR', 'Excavator', 'hour', 'manual', 'fixed', null, now(), now()),
      ('cat_wall', 'cat_wall', 'Wall', 'each', 'rollup', 'rollup', 'Walls', now(), now())`);
    await tx.execute(sql`update items set variant_of_uid = 'cat_post' where uid = 'cat_hour'`);
    await tx.execute(sql`insert into item_prices (item_uid, cost_per_unit, sell_price, effective_from, source, changed_by, created_at) values
      ('cat_post', '40', '50.4567', '2026-01-01', 'migration', 'x', now()), ('cat_hour', '180', '300', '2026-01-01', 'migration', 'x', now())`);
    await tx.execute(sql`insert into item_components (parent_uid, child_uid, quantity, created_at) values ('cat_wall', 'cat_post', '2', now()), ('cat_wall', 'cat_hour', '0.25', now())`);
  });
  assert.equal(await sourceMigrationLevel(source), 5);

  const rehearsal = await copyCatalogueForRehearsal(source, DEFAULT_ORG_UID);
  t.after(() => rehearsal.close());
  assert.equal(rehearsal.sourceLevel, 5);
  assert.equal(rehearsal.copied.items, 3);
  assert.equal(rehearsal.copied.item_components, 2);
  const store = createCatalogStore({ db: rehearsal.db });
  const state = await store.getState();
  assert.equal(state.version, 7);
  assert.equal(price(state, "cat_wall").unit_sell, 2 * 50.4567 + 0.25 * 300);
  assert.equal(price(state, "excavator-hour").item_uid, "cat_hour", "aliases were backfilled by 0006 on the copy");
  assert.equal(state.items.get("cat_wall").type, "kit", "0007 ran on the copy");
  assert.equal(state.items.get("cat_hour").variantOfUid, "cat_post");
  assert.deepEqual(state.categories.map((c) => [c.id, c.parent_id]).sort(), [[2, null], [3, 2]]);
  // New rows continue after the copied ids.
  const created = await store.createItem({ name: "New", unit: "each", buy_price: 1, sell_price: 2 });
  assert.ok(created.price_id > 2);
  // The source is untouched.
  const [row] = await withOrg(source, DEFAULT_ORG_UID, (tx) => queryRows(sql`select count(*)::int as n from items`, tx));
  assert.equal(row.n, 3);
});
