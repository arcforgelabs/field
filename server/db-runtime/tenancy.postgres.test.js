// Tenancy on a real PostgreSQL server, migrated the way Replit runs it: by a
// login role that is not a superuser, owns the tables and has no BYPASSRLS.
// Once with CREATEROLE (Neon's neondb_owner: field_app is created and used)
// and once without (RLS holds through FORCE ROW LEVEL SECURITY alone).
// Off unless FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1 is set
// (server/db-runtime/test-postgres.js).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { FIELD_SEARCH_PATH, MIGRATIONS_FOLDER, migratePostgresDatabase, queryRows, schema } from "./index.js";
import { startTestPostgres, testPostgresMode } from "./test-postgres.js";
import { DEFAULT_ORG_UID, assertRowSecurity, inspectRowSecurity, withOrg } from "./tenancy.js";

const ORG_B = "org_01TESTSECONDORGANISATION0";
const enabled = testPostgresMode().kind !== "none";

let server = null;
const clients = [];

before(async () => {
  if (enabled) server = await startTestPostgres();
});
after(async () => {
  for (const client of clients) await client.end({ timeout: 5 });
  await server?.stop();
});

function connect(url) {
  const client = postgres(url, { max: 3, onnotice: () => {}, connection: { TimeZone: "UTC", search_path: FIELD_SEARCH_PATH } });
  clients.push(client);
  return { client, db: drizzle(client, { schema }) };
}

// A database owned by a fresh non-superuser login role, as on Replit.
async function ownerDatabase({ createRole }) {
  const admin = connect(server.url).client;
  const suffix = randomBytes(4).toString("hex");
  const role = `owner_${suffix}`;
  const database = `field_rls_${suffix}`;
  await admin.unsafe(`create role ${role} login nosuperuser nobypassrls ${createRole ? "createrole" : "nocreaterole"}`);
  await admin.unsafe(`create database ${database} owner ${role}`);
  const url = new URL(server.url);
  url.username = role;
  url.pathname = `/${database}`;
  const handle = connect(url.toString());
  return { ...handle, role, drop: async () => { await admin.unsafe(`drop database if exists ${database} with (force)`); } };
}

async function seed(db) {
  await db.execute(sql`insert into units (code, label, dimension, to_base) values ('each', 'each', 'count', '1')`);
  await db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
  const uids = {};
  for (const org of [DEFAULT_ORG_UID, ORG_B]) {
    uids[org] = `itm_${org.slice(4, 12)}`;
    await withOrg(db, org, async (tx) => {
      await tx.execute(sql`insert into tax_codes (code, label, rate) values ('GST', 'GST 10%', '0.1')`);
      await tx.execute(sql`insert into items (uid, code, name, unit_code, created_at, updated_at) values (${uids[org]}, 'MAT-GRAVEL-20MM', 'Gravel', 'each', now(), now())`);
    });
  }
  return uids;
}

async function provesIsolation(db, uids) {
  for (const org of [DEFAULT_ORG_UID, ORG_B]) {
    const rows = await withOrg(db, org, (tx) => queryRows(sql`select uid from items`, tx));
    assert.deepEqual(rows.map((row) => row.uid), [uids[org]]);
  }
  await assert.rejects(
    withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`insert into items (org_uid, uid, code, name, unit_code, created_at, updated_at) values (${ORG_B}, 'itm_x', 'MAT-X', 'x', 'each', now(), now())`)),
    (error) => /row-level security/.test(String(error.cause?.message ?? error.message)),
  );
  await assert.rejects(
    withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`insert into item_prices (item_uid, cost_per_unit, effective_from, source, changed_by, created_at) values (${uids[ORG_B]}, '1', now(), 'manual', 't', now())`)),
    (error) => /foreign key/.test(String(error.cause?.message ?? error.message)),
  );
  // The login role itself (the owner, no organisation set) gets an error, not rows.
  await assert.rejects(queryRows(sql`select count(*) from items`, db), (error) => /field\.org_uid is not set/.test(String(error.cause?.message ?? error.message)));
}

test("owner without CREATEROLE: the migration applies and FORCE ROW LEVEL SECURITY isolates organisations", { skip: !enabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL" }, async () => {
  const owner = await ownerDatabase({ createRole: false });
  try {
    await migratePostgresDatabase(owner.db);
    const mode = await assertRowSecurity(owner.db);
    assert.equal(mode.superuser, false);
    assert.equal(mode.bypassRls, false);
    assert.equal(mode.via, "force");
    await provesIsolation(owner.db, await seed(owner.db));
  } finally {
    await owner.drop();
  }
});

test("owner with CREATEROLE (Neon's neondb_owner): field_app is created and every organisation transaction runs as it", { skip: !enabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL" }, async () => {
  const owner = await ownerDatabase({ createRole: true });
  try {
    await migratePostgresDatabase(owner.db);
    const mode = await inspectRowSecurity(owner.db);
    // field_app may predate this database on a shared server; then the owner
    // may not be able to join it and FORCE carries isolation instead.
    assert.equal(mode.enforced, true);
    // A fresh container has no earlier field_app: this migration made it.
    if (testPostgresMode().kind === "docker") assert.equal(mode.via, "set-role");
    const uids = await seed(owner.db);
    await provesIsolation(owner.db, uids);
    if (mode.via === "set-role") {
      const [who] = await withOrg(owner.db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select current_user as "user"`, tx));
      assert.equal(who.user, "field_app");
      await assert.rejects(withOrg(owner.db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`alter table items disable row level security`)));
      const [back] = await queryRows(sql`select current_user as "user"`, owner.db);
      assert.equal(back.user, owner.role);
    }

    // The emergency rollback runs as the same owner, in one transaction, and
    // 0005 applies again afterwards.
    await withOrg(owner.db, ORG_B, (tx) => tx.execute(sql`delete from items`));
    await withOrg(owner.db, ORG_B, (tx) => tx.execute(sql`delete from tax_codes`));
    await owner.client`delete from organizations where uid = ${ORG_B}`;
    // Later migrations' rollbacks run first, newest first, as the runbook says.
    const rollbackDir = join(MIGRATIONS_FOLDER, "..", "rollback");
    const later = readdirSync(rollbackDir).filter((name) => /^\d{4}_.+\.down\.sql$/.test(name) && name > "0005_tenancy.down.sql").sort().reverse();
    for (const name of later) await owner.client.begin((tx) => tx.unsafe(readFileSync(join(rollbackDir, name), "utf8")));
    const down = readFileSync(join(rollbackDir, "0005_tenancy.down.sql"), "utf8");
    await owner.client.begin((tx) => tx.unsafe(down));
    const [after] = await owner.client`select (select count(*) from items)::int as items, (select count(*) from pg_roles where rolname = 'field_app')::int as app_role`;
    assert.equal(after.items, 1);
    if (testPostgresMode().kind === "docker") assert.equal(after.app_role, 0, "the owner that created field_app drops it");
    await migratePostgresDatabase(owner.db);
    assert.equal((await inspectRowSecurity(owner.db)).enforced, true);
  } finally {
    await owner.drop();
  }
});
