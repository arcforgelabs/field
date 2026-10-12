// Two organisations in one database: row-level security must keep each one's
// rows out of the other's reads and writes (#178 phase 0b).
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { PGlite, types } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createTestDb, MIGRATIONS_FOLDER, queryRows, schema } from "./index.js";
import {
  APP_ROLE,
  DEFAULT_ORG_UID,
  assertRowSecurity,
  inspectRowSecurity,
  orgScope,
  requestOrgUid,
  resolveDeploymentOrg,
  withOrg,
  withRequestOrg,
} from "./tenancy.js";

const ROLLBACK_0005 = join(MIGRATIONS_FOLDER, "..", "rollback", "0005_tenancy.down.sql");

// Everything about the public schema a migration can change, as sorted text.
async function schemaShape(db) {
  const parts = await Promise.all([
    queryRows(sql`select table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' default=' || coalesce(column_default, '') as x from information_schema.columns where table_schema = 'public'`, db),
    queryRows(sql`select c.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) as x from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`, db),
    queryRows(sql`select indexname || ' ' || indexdef as x from pg_indexes where schemaname = 'public'`, db),
    queryRows(sql`select relname || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r'`, db),
    queryRows(sql`select 'policy ' || tablename || '.' || policyname as x from pg_policies where schemaname = 'public'`, db),
    queryRows(sql`select 'function ' || p.proname as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`, db),
  ]);
  return parts.flat().map((row) => row.x).sort();
}

const ORG_A = DEFAULT_ORG_UID;
const ORG_B = "org_01TESTSECONDORGANISATION0";
const NOW = "2026-10-11T00:00:00.000Z";

async function seedOrg(db, orgUid, { code = "MAT-GRAVEL-20MM" } = {}) {
  return withOrg(db, orgUid, async (tx) => {
    await tx.execute(sql`insert into tax_codes (code, label, rate) values ('GST', 'GST 10%', '0.1')`);
    await tx.execute(sql`insert into catalog_meta (id, version, updated_at) values (1, 0, ${NOW}::timestamptz)`);
    const uid = `itm_${orgUid.slice(4, 12)}`;
    await tx.execute(sql`
      insert into items (uid, code, name, unit_code, created_at, updated_at)
      values (${uid}, ${code}, ${`Gravel for ${orgUid}`}, 'each', ${NOW}::timestamptz, ${NOW}::timestamptz)`);
    await tx.execute(sql`
      insert into item_prices (item_uid, cost_per_unit, sell_price, effective_from, source, changed_by, created_at)
      values (${uid}, '10', '15', ${NOW}::timestamptz, 'manual', 'test', ${NOW}::timestamptz)`);
    return uid;
  });
}

function rejects(promise, pattern) {
  return assert.rejects(promise, (error) => {
    let message = "";
    for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
    assert.match(message, pattern);
    return true;
  });
}

describe("two organisations, one database", () => {
  let t;
  let itemA;
  let itemB;

  before(async () => {
    t = await createTestDb();
    await t.db.execute(sql`insert into units (code, label, dimension, to_base) values ('each', 'each', 'count', '1')`);
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    itemA = await seedOrg(t.db, ORG_A);
    // The same code in another organisation is a different item.
    itemB = await seedOrg(t.db, ORG_B);
  });
  after(() => t?.close());

  test("each organisation reads only its own rows", async () => {
    for (const [org, own] of [[ORG_A, itemA], [ORG_B, itemB]]) {
      const rows = await withOrg(t.db, org, (tx) => queryRows(sql`select uid, org_uid from items`, tx));
      assert.deepEqual(rows, [{ uid: own, org_uid: org }]);
      const prices = await withOrg(t.db, org, (tx) => queryRows(sql`select item_uid from item_prices`, tx));
      assert.deepEqual(prices.map((row) => row.item_uid), [own]);
      const tax = await withOrg(t.db, org, (tx) => queryRows(sql`select count(*)::int as n from tax_codes`, tx));
      assert.equal(tax[0].n, 1);
    }
  });

  test("another organisation's row cannot be read by its uid", async () => {
    const rows = await withOrg(t.db, ORG_A, (tx) => queryRows(sql`select uid from items where uid = ${itemB}`, tx));
    assert.deepEqual(rows, []);
  });

  test("an insert into another organisation is refused", async () => {
    await rejects(
      withOrg(t.db, ORG_A, (tx) => tx.execute(sql`
        insert into items (org_uid, uid, code, name, unit_code, created_at, updated_at)
        values (${ORG_B}, 'itm_smuggled', 'MAT-SMUGGLED', 'x', 'each', now(), now())`)),
      /row-level security/,
    );
  });

  test("updates and deletes never reach another organisation's rows", async () => {
    await withOrg(t.db, ORG_A, async (tx) => {
      await tx.execute(sql`update items set name = 'hijacked' where uid = ${itemB}`);
      await tx.execute(sql`delete from item_prices where item_uid = ${itemB}`);
      await tx.execute(sql`delete from items where uid = ${itemB}`);
    });
    const rows = await withOrg(t.db, ORG_B, (tx) => queryRows(sql`select i.name, count(p.id)::int as prices from items i left join item_prices p on p.item_uid = i.uid group by i.name`, tx));
    assert.deepEqual(rows, [{ name: `Gravel for ${ORG_B}`, prices: 1 }]);
  });

  test("moving a row into another organisation is refused", async () => {
    await rejects(
      withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update items set org_uid = ${ORG_B} where uid = ${itemA}`)),
      /row-level security|violates foreign key/,
    );
  });

  test("a link to another organisation's item is refused, even by uid", async () => {
    // Foreign-key checks ignore RLS; the (org_uid, item_uid) key does not.
    await rejects(
      withOrg(t.db, ORG_A, (tx) => tx.execute(sql`
        insert into item_prices (item_uid, cost_per_unit, effective_from, source, changed_by, created_at)
        values (${itemB}, '1', now(), 'manual', 'test', now())`)),
      /foreign key/,
    );
    await rejects(
      withOrg(t.db, ORG_A, (tx) => tx.execute(sql`
        insert into kit_components (kit_uid, component_uid, quantity, created_at)
        values (${itemA}, ${itemB}, '1', now())`)),
      /foreign key/,
    );
  });

  test("codes are unique within an organisation, not across them", async () => {
    await rejects(
      withOrg(t.db, ORG_A, (tx) => tx.execute(sql`
        insert into items (uid, code, name, unit_code, created_at, updated_at)
        values ('itm_dup', 'mat-gravel-20mm', 'dup', 'each', now(), now())`)),
      /items_org_code_lower_key/,
    );
  });

  test("a tenant table outside an organisation transaction raises", async () => {
    await rejects(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`set local role field_app`);
        await tx.execute(sql`select * from items`);
      }),
      /field\.org_uid is not set/,
    );
    await rejects(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`set local role field_app`);
        await tx.execute(sql`insert into tax_codes (code, label, rate) values ('X', 'x', '0')`);
      }),
      /field\.org_uid is not set/,
    );
  });

  test("the setting and the role end with the transaction", async () => {
    await withOrg(t.db, ORG_A, (tx) => queryRows(sql`select 1`, tx));
    const [row] = await queryRows(sql`select current_user as "user", current_setting('field.org_uid', true) as org`, t.db);
    assert.notEqual(row.user, APP_ROLE);
    assert.ok(!row.org);
  });

  test("withOrg nested in an organisation transaction puts the outer role and organisation back", async () => {
    await withOrg(t.db, ORG_A, async (outer) => {
      await withOrg(outer, ORG_B, (inner) => queryRows(sql`select 1`, inner));
      const [after] = await queryRows(sql`select current_user as "user", current_setting('field.org_uid', true) as org`, outer);
      assert.deepEqual(after, { user: APP_ROLE, org: ORG_A });
      const rows = await queryRows(sql`select uid from items`, outer);
      assert.deepEqual(rows.map((row) => row.uid), [itemA]);
    });
    // Nested in a plain (login role) transaction: back to the login role, no organisation.
    await t.db.transaction(async (outer) => {
      await withOrg(outer, ORG_A, (inner) => queryRows(sql`select 1`, inner));
      const [after] = await queryRows(sql`select current_user as "user", current_setting('field.org_uid', true) as org`, outer);
      assert.notEqual(after.user, APP_ROLE);
      assert.ok(!after.org);
    });
  });

  test("users: field_app may rename and link a person, never change their email or id", async () => {
    await t.db.execute(sql`insert into users (id, email, name) values ('u_fixed', 'fixed@example.test', 'Fixed')`);
    await withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update users set name = 'Renamed', clerk_user_id = 'user_x' where id = 'u_fixed'`));
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update users set email = 'other@example.test' where id = 'u_fixed'`)), /permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update users set id = 'u_other' where id = 'u_fixed'`)), /permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`select setval('categories_id_seq', 1)`)), /permission denied/);
  });

  test("field_app can change rows but not the schema or durable storage", async () => {
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`drop table items`)), /must be owner|permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`alter table items disable row level security`)), /must be owner|permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`select count(*) from field_blobs`)), /permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into units (code, label, dimension) values ('zz', 'zz', 'count')`)), /permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update organizations set name = 'mine'`)), /permission denied/);
  });

  test("orgScope opens organisation transactions and has no query methods", async () => {
    const scope = orgScope(t.db, ORG_B);
    const rows = await scope.transaction((tx) => queryRows(sql`select uid from items`, tx));
    assert.deepEqual(rows.map((row) => row.uid), [itemB]);
    assert.equal(typeof scope.select, "undefined");
    assert.equal(orgScope(scope, ORG_B), scope);
    assert.throws(() => orgScope(scope, ORG_A), /re-scoped/);
  });

  test("withRequestOrg uses the request's organisation and refuses a request without one", async () => {
    const rows = await withRequestOrg(t.db, { fieldOrg: { uid: ORG_B } }, (tx) => queryRows(sql`select uid from items`, tx));
    assert.deepEqual(rows.map((row) => row.uid), [itemB]);
    assert.throws(() => requestOrgUid({}), (error) => error.status === 403);
    await assert.rejects(withOrg(t.db, "not-an-org", async () => {}), /not an organisation uid/);
    await assert.rejects(withOrg(t.db, "org_x'; drop table items; --", async () => {}), /not an organisation uid/);
  });

  test("the deployment organisation resolves by slug", async () => {
    assert.deepEqual(await resolveDeploymentOrg(t.db, { env: {} }), { uid: ORG_A, name: "Embark Earthworks", slug: "embark" });
    assert.equal((await resolveDeploymentOrg(t.db, { env: { FIELD_ORG: "second" } })).uid, ORG_B);
    await assert.rejects(resolveDeploymentOrg(t.db, { env: { FIELD_ORG: "nobody" } }), /does not exist/);
  });

  test("PGlite's superuser is switched to field_app, so RLS holds in tests too", async () => {
    const mode = await assertRowSecurity(t.db);
    assert.equal(mode.superuser, true);
    assert.equal(mode.via, "set-role");
  });

  test("every table with org_uid has RLS, FORCE and the isolation policy", async () => {
    const rows = await queryRows(sql`
      select c.relname as table,
             c.relrowsecurity as rls,
             c.relforcerowsecurity as forced,
             exists (select 1 from pg_policies p where p.tablename = c.relname and p.policyname = c.relname || '_tenant_isolation') as policy,
             pg_get_expr(d.adbin, d.adrelid) as org_default
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attname = 'org_uid' and not a.attisdropped
      order by c.relname`, t.db);
    // 20 tables in 0005, +item_code_aliases (0006), -5 assembly tables (0007).
    assert.ok(rows.length >= 16, `expected the tenant tables, got ${rows.length}`);
    for (const row of rows) {
      assert.deepEqual(
        { table: row.table, rls: row.rls, forced: row.forced, policy: row.policy, orgDefault: row.org_default },
        { table: row.table, rls: true, forced: true, policy: true, orgDefault: "field_org_uid()" },
      );
    }
  });
});

describe("FORCE ROW LEVEL SECURITY without field_app", () => {
  test("a login role without BYPASSRLS that owns the tables is still filtered", async () => {
    // Replit's owner role (no BYPASSRLS) when it cannot switch to field_app:
    // simulated with a role that owns the tables and is not a superuser.
    const t = await createTestDb();
    try {
      await t.db.execute(sql`insert into units (code, label, dimension, to_base) values ('each', 'each', 'count', '1')`);
      await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
      await seedOrg(t.db, ORG_A);
      const itemB = await seedOrg(t.db, ORG_B);
      await t.db.execute(sql`create role owner_sim nologin nobypassrls`);
      await t.db.execute(sql`alter table items owner to owner_sim`);
      const rows = await t.db.transaction(async (tx) => {
        await tx.execute(sql`set local role owner_sim`);
        assert.deepEqual(
          { via: (await inspectRowSecurity(tx)).via },
          { via: "force" },
        );
        await tx.execute(sql`select set_config('field.org_uid', ${ORG_B}, true)`);
        return queryRows(sql`select uid from items`, tx);
      });
      assert.deepEqual(rows.map((row) => row.uid), [itemB]);
    } finally {
      await t.close();
    }
  });

  test("a field_app that could bypass RLS is not trusted, and a tenant table without RLS refuses boot", async () => {
    const t = await createTestDb();
    try {
      assert.equal((await inspectRowSecurity(t.db)).via, "set-role");
      await t.db.execute(sql`alter role field_app bypassrls`);
      const bypassing = await inspectRowSecurity(t.db);
      assert.equal(bypassing.canSetRole, false);
      assert.equal(bypassing.via, null, "PGlite's superuser cannot rely on FORCE either");
      await t.db.execute(sql`alter role field_app nobypassrls`);
      await t.db.execute(sql`alter table items no force row level security`);
      await assert.rejects(assertRowSecurity(t.db), /incomplete on items/);
    } finally {
      await t.db.execute(sql`alter role field_app nobypassrls`).catch(() => {});
      await t.close();
    }
  });

  test("a login role that bypasses RLS and cannot switch is refused", async () => {
    const t = await createTestDb();
    try {
      await t.db.execute(sql`create role bypass_sim nologin bypassrls`);
      const mode = await t.db.transaction(async (tx) => {
        await tx.execute(sql`set local role bypass_sim`);
        return inspectRowSecurity(tx);
      });
      assert.deepEqual({ enforced: mode.enforced, via: mode.via }, { enforced: false, via: null });
    } finally {
      await t.close();
    }
  });
});

describe("migration 0005 on a populated database", () => {
  let dir;
  let dir5;
  let client;

  before(() => {
    // Migrations 0000-0004 only: the database as production has it today.
    dir = mkdtempSync(join(tmpdir(), "field-tenancy-"));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry) => entry.idx < 5);
    writeFileSync(journalPath, JSON.stringify(journal));
    rmSync(join(dir, "0005_tenancy.sql"));
    // Up to 0005 and no further: later migrations have their own rollback
    // scripts, which run before this one.
    dir5 = mkdtempSync(join(tmpdir(), "field-tenancy-0005-"));
    cpSync(MIGRATIONS_FOLDER, dir5, { recursive: true });
    const journal5Path = join(dir5, "meta", "_journal.json");
    const journal5 = JSON.parse(readFileSync(journal5Path, "utf8"));
    for (const entry of journal5.entries.filter((e) => e.idx > 5)) rmSync(join(dir5, `${entry.tag}.sql`));
    journal5.entries = journal5.entries.filter((entry) => entry.idx <= 5);
    writeFileSync(journal5Path, JSON.stringify(journal5));
  });
  after(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir5, { recursive: true, force: true });
  });

  test("backfills every existing row into the default organisation and keeps the users' access", async () => {
    client = new PGlite({ parsers: { [types.NUMERIC]: (v) => v, [types.INT8]: (v) => v } });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: dir });
    await db.execute(sql`insert into units (code, label, dimension, to_base) values ('each', 'each', 'count', '1')`);
    await db.execute(sql`insert into tax_codes (code, label, rate) values ('GST', 'GST 10%', '0.1')`);
    await db.execute(sql`insert into catalog_meta (id, version, updated_at) values (1, 41, now())`);
    await db.execute(sql`insert into categories (name, created_at, updated_at) values ('Walls', now(), now())`);
    await db.execute(sql`insert into suppliers (uid, name, created_at, updated_at) values ('sup_1', 'Quarry', now(), now())`);
    await db.execute(sql`insert into items (uid, code, name, unit_code, created_at, updated_at) values ('cat_1', 'GRAVEL', 'Gravel', 'each', now(), now()), ('cat_2', 'SAND', 'Sand', 'each', now(), now())`);
    await db.execute(sql`update items set variant_of_uid = 'cat_1' where uid = 'cat_2'`);
    await db.execute(sql`insert into item_prices (item_uid, supplier_id, cost_per_unit, sell_price, effective_from, source, changed_by, created_at) select 'cat_1', id, '10', '15.5632', now(), 'manual', 'x', now() from suppliers`);
    await db.execute(sql`insert into item_components (parent_uid, child_uid, quantity, created_at) values ('cat_2', 'cat_1', '2', now())`);
    await db.execute(sql`insert into users (id, email, name, role, status) values ('u1', 'owner@example.test', 'Owner', 'owner', 'active'), ('u2', 'new@example.test', 'New', 'staff', 'pending')`);
    await db.execute(sql`insert into quote_snapshots (attempt_id, job_id, document_type, status, lines, pricing, recipients, prepared_at) values ('att_1', 'job_1', 'quote', 'sent', '[]', '{}', '{}', now())`);

    await migrate(db, { migrationsFolder: dir5 });

    const counts = await queryRows(sql`
      select (select count(*) from items where org_uid = ${DEFAULT_ORG_UID})::int as items,
             (select count(*) from item_prices where org_uid = ${DEFAULT_ORG_UID})::int as prices,
             (select sell_price from item_prices) as sell,
             (select count(*) from item_components where org_uid = ${DEFAULT_ORG_UID})::int as components,
             (select count(*) from quote_snapshots where org_uid = ${DEFAULT_ORG_UID})::int as snapshots,
             (select version from catalog_meta where org_uid = ${DEFAULT_ORG_UID}) as version,
             (select variant_of_uid from items where uid = 'cat_2') as variant`, db);
    assert.deepEqual(counts, [{ items: 2, prices: 1, sell: "15.5632", components: 1, snapshots: 1, version: "41", variant: "cat_1" }]);
    const members = await queryRows(sql`select user_uid, role, status from org_memberships where org_uid = ${DEFAULT_ORG_UID} order by user_uid`, db);
    assert.deepEqual(members, [
      { user_uid: "u1", role: "owner", status: "active" },
      { user_uid: "u2", role: "staff", status: "pending" },
    ]);
    // Through RLS, as the app sees it.
    const seen = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select code from items order by code`, tx));
    assert.deepEqual(seen.map((row) => row.code), ["GRAVEL", "SAND"]);
    // Deleting a supplier clears only the supplier link, never org_uid.
    await withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`delete from suppliers`));
    const [price] = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select org_uid, supplier_id from item_prices`, tx));
    assert.deepEqual(price, { org_uid: DEFAULT_ORG_UID, supplier_id: null });
  });

  test("the rollback script returns the database to its 0004 shape with its data", async () => {
    // Continues from the backfill test above: `client` is at 0005.
    const db = drizzle(client, { schema });
    await client.exec(readFileSync(ROLLBACK_0005, "utf8"));
    const reference = new PGlite();
    try {
      await migrate(drizzle(reference, { schema }), { migrationsFolder: dir });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference, { schema })));
    } finally {
      await reference.close();
    }
    // The data is back in its pre-tenancy form, readable without an organisation.
    const users = await queryRows(sql`select id, role, status from users order by id`, db);
    assert.deepEqual(users, [{ id: "u1", role: "owner", status: "active" }, { id: "u2", role: "staff", status: "pending" }]);
    const [counts] = await queryRows(sql`select (select count(*) from items)::int as items, (select count(*) from item_prices)::int as prices, (select version from catalog_meta) as version`, db);
    assert.deepEqual(counts, { items: 2, prices: 1, version: "41" });
    const [journal] = await queryRows(sql`select count(*)::int as n from drizzle.__drizzle_migrations`, db);
    assert.equal(journal.n, 5, "0005 is no longer recorded, so a later boot applies it again");
    // And forward again: 0005 (and everything after it) re-applies cleanly.
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const seen = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select code from items order by code`, tx));
    assert.deepEqual(seen.map((row) => row.code), ["GRAVEL", "SAND"]);
  });

  test("the rollback script refuses when a second organisation exists", async () => {
    const db = drizzle(client, { schema });
    await db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    await assert.rejects(client.exec(`begin; ${readFileSync(ROLLBACK_0005, "utf8")}; commit;`), /more than one organisation/);
    await client.exec("rollback").catch(() => {});
  });

});

describe("people and memberships across organisations", () => {
  test("each organisation sees and manages only its own members; a shared person survives removal from one", async () => {
    const store = await import("../auth/field-users-store.js");
    const t = await createTestDb();
    try {
      await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
      const a = orgScope(t.db, ORG_A);
      const b = orgScope(t.db, ORG_B);
      const ownerA = await store.createInvitedUser(a, { email: "owner-a@example.test", role: "owner" });
      const ownerB = await store.createInvitedUser(b, { email: "owner-b@example.test", role: "owner" });
      // One person in both organisations: the same identity, separate roles.
      const sharedA = await store.createInvitedUser(a, { email: "it@example.test", role: "staff" });
      const sharedB = await store.createInvitedUser(b, { email: "it@example.test", role: "owner" });
      assert.equal(sharedA.id, sharedB.id);
      assert.deepEqual([sharedA.role, sharedB.role, sharedA.orgUid, sharedB.orgUid], ["staff", "owner", ORG_A, ORG_B]);

      assert.deepEqual((await store.listFieldUsers(a)).map((row) => row.email).sort(), ["it@example.test", "owner-a@example.test"]);
      assert.equal(await store.findFieldUserById(a, ownerB.id), null);
      assert.equal(await store.findFieldUserByEmail(a, "owner-b@example.test"), null);
      // Another organisation's member cannot be edited or removed from here.
      assert.equal(await store.updateFieldUser(a, ownerB.id, { status: "disabled" }), null);
      assert.equal(await store.deleteFieldUser(a, ownerB.id), null);
      assert.equal((await store.findFieldUserById(b, ownerB.id)).status, "active");
      // Each organisation keeps its own last owner.
      await assert.rejects(store.deleteFieldUser(a, ownerA.id), /at least one active owner/);

      // Removed from A, still in B: the person row stays for B.
      assert.equal((await store.deleteFieldUser(a, sharedA.id)).id, sharedA.id);
      assert.equal(await store.findFieldUserById(a, sharedA.id), null);
      assert.equal((await store.findFieldUserById(b, sharedA.id)).role, "owner");
      // Removed from B too: nobody holds them, so the person row goes.
      await store.deleteFieldUser(b, sharedA.id);
      const left = await queryRows(sql`select count(*)::int as n from users where id = ${sharedA.id}`, t.db);
      assert.equal(left[0].n, 0);
    } finally {
      await t.close();
    }
  });
});
