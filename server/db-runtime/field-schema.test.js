// Field's tables live in schema `field`, never in `public`. Replit's publish
// check compares only `public`, so a table left there can be offered as a
// drop or a create against a live database.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createTestDb, MIGRATIONS_FOLDER, queryRows, schema } from "./index.js";
import { DEFAULT_ORG_UID, inspectRowSecurity, withOrg } from "./tenancy.js";

const SCHEMA_SOURCE = new URL("../db/src/schema.ts", import.meta.url);
const ORG_A = DEFAULT_ORG_UID;
const ORG_B = "org_01TESTSECONDORGANISATION0";
const UID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UID_B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const QUOTE_DRAFT = `qte_${UID}`;
const QUOTE_SENT = `qte_${UID_B}`;
const ITEM_A = `itm_${UID}`;
const ITEM_A2 = `itm_${UID_B}`;
const ITEM_B = "itm_01ARZ3NDEKTSV4RRFFQ69G5FC1";

const FIELD_FUNCTIONS = [
  "field_item_code_alias",
  "field_org_uid",
  "field_quote_is_frozen",
  "field_refuse_access_audit_change",
  "field_refuse_document_change",
  "field_refuse_integration_audit_change",
  "field_refuse_issued_credit_note_change",
  "field_refuse_issued_credit_note_line_change",
  "field_refuse_issued_invoice_change",
  "field_refuse_issued_invoice_line_change",
  "field_refuse_payment_allocation_change",
  "field_refuse_payment_change",
  "field_refuse_receipt_change",
  "field_refuse_replica_change",
  "field_refuse_sent_quote_change",
  "field_refuse_sent_quote_content_change",
  "field_refuse_xero_invoice_link_change",
];

function migrationsUpTo(idx) {
  const dir = mkdtempSync(join(tmpdir(), "field-schema-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  for (const entry of journal.entries.filter((entry) => entry.idx > idx)) rmSync(join(dir, `${entry.tag}.sql`));
  journal.entries = journal.entries.filter((entry) => entry.idx <= idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

function rejects(promise, pattern) {
  return assert.rejects(promise, (error) => {
    let message = "";
    for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
    assert.match(message, pattern);
    return true;
  });
}

async function step(db, label, query) {
  try {
    await db.execute(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`, { cause: error });
  }
}

// Tables, views, sequences and functions in public that are not part of an
// extension. A future migration that creates one of these fails the guard.
async function publicObjects(db) {
  return queryRows(sql`
    select kind, name from (
      select c.relkind as kind, c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
        and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
      union all
      select 'f', p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    ) objects
    order by 1, 2
  `, db);
}

async function tableCounts(db, schemaName) {
  const tables = await queryRows(sql`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schemaName} and c.relkind = 'r'
    order by 1
  `, db);
  const counts = {};
  for (const table of tables) {
    const [row] = await queryRows(
      sql`select count(*)::int as n from ${sql.identifier(schemaName)}.${sql.identifier(table.name)}`,
      db,
    );
    counts[table.name] = row.n;
  }
  return counts;
}

async function seedAt0024(db) {
  await step(db, "units", sql`insert into units (code, label, dimension, to_base) values ('each', 'each', 'count', '1'), ('m', 'metre', 'length', '1')`);
  await step(db, "unit alias", sql`insert into unit_aliases (alias, unit_code) values ('ea', 'each')`);
  await step(db, "blobs", sql`insert into field_blobs (sha256, bytes) values ('abc', convert_to('blob', 'utf8'))`);
  await step(db, "files", sql`insert into field_files (path, sha256, size, mode, mtime) values ('note.txt', 'abc', 4, 420, now())`);
  await step(db, "sqlite image", sql`insert into field_sqlite_images (name, version, sha256, bytes) values ('field.db', 1, 'abc', convert_to('db', 'utf8'))`);
  await step(db, "probe", sql`insert into drizzle_toolchain_probe (probe_key) values ('schema-move')`);
  await step(db, "user", sql`insert into users (id, email, name) values ('user_1', 'owner@example.test', 'Owner')`);
  await step(db, "second org", sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);

  await withOrg(db, ORG_A, async (tx) => {
    await step(tx, "tax", sql`insert into tax_codes (code, label, rate) values ('GST', 'GST 10%', '0.1')`);
    await step(tx, "category", sql`insert into categories (name, created_at, updated_at) values ('Materials', now(), now())`);
    await step(tx, "supplier", sql`insert into suppliers (uid, name, created_at, updated_at) values ('sup_1', 'Quarry', now(), now())`);
    await step(tx, "items", sql`
      insert into items (uid, code, name, unit_code, created_at, updated_at) values
        (${ITEM_A}, 'GRAVEL', 'Gravel', 'each', now(), now()),
        (${ITEM_A2}, 'SAND', 'Sand', 'each', now(), now())`);
    await step(tx, "conversion", sql`
      insert into item_unit_conversions (item_uid, from_unit, to_unit, factor)
      values (${ITEM_A}, 'm', 'each', '1')`);
    await step(tx, "item supplier", sql`
      insert into item_suppliers (item_uid, supplier_id)
      select ${ITEM_A}, id from suppliers where uid = 'sup_1'`);
    await step(tx, "price", sql`
      insert into item_prices (item_uid, cost_per_unit, sell_price, effective_from, source, changed_by, created_at)
      values (${ITEM_A}, '10', '15', now(), 'manual', 'test', now())`);
    await step(tx, "price import", sql`insert into price_imports (uid, created_by, created_at) values ('pim_1', 'test', now())`);
    await step(tx, "price import row", sql`
      insert into price_import_rows (import_id, row_no, match)
      select id, 1, 'new' from price_imports where uid = 'pim_1'`);
    await step(tx, "kit", sql`
      insert into kit_components (kit_uid, component_uid, quantity, created_at)
      values (${ITEM_A2}, ${ITEM_A}, '2', now())`);
    await step(tx, "history", sql`
      insert into catalog_history (item_uid, field, changed_by, changed_at)
      values (${ITEM_A}, 'name', 'test', now())`);
    await step(tx, "evidence", sql`
      insert into catalog_evidence (item_uid, side, kind, created_at)
      values (${ITEM_A}, 'buy', 'note', now())`);
    await step(tx, "catalog meta", sql`insert into catalog_meta (id, version, updated_at) values (1, 1, now())`);
    await step(tx, "data migration", sql`insert into data_migrations (id, applied_at) values ('probe', now())`);
    await step(tx, "snapshot", sql`
      insert into quote_snapshots (attempt_id, job_id, document_type, status, lines, pricing, recipients, prepared_at)
      values ('att_1', 'job-1', 'quote', 'prepared', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`);
    await step(tx, "document blob", sql`
      insert into document_blobs (sha256, byte_length, content_type, bytes, created_at)
      select encode(sha256(b.bytes), 'hex'), octet_length(b.bytes), 'application/pdf', b.bytes, now()
      from (select convert_to('field-schema-probe', 'utf8') as bytes) b`);
    await step(tx, "issued document", sql`
      insert into issued_documents (uid, job_id, document_type, number, issued_at, pdf_sha256, source, created_at)
      select ${`doc_${UID}`}, 'job-1', 'quote', 'EQ-1', now(), sha256, 'live', now() from document_blobs`);
    await step(tx, "document event", sql`
      insert into document_events (uid, issued_document_uid, job_id, document_type, event, at, created_at)
      values (${`dev_${UID}`}, ${`doc_${UID}`}, 'job-1', 'quote', 'created', now(), now())`);
    await step(tx, "number counter", sql`
      insert into document_number_counters (document_type, period, created_at, updated_at)
      values ('invoice', '2026-10', now(), now())`);
    await step(tx, "quotes", sql`
      insert into quotes (uid, job_id, number, version, status, subtotal, tax_total, total, created_at, updated_at) values
        (${QUOTE_DRAFT}, 'job-1', 'EQ-1', 1, 'draft', 10, 1, 11, now(), now()),
        (${QUOTE_SENT}, 'job-1', 'EQ-2', 2, 'draft', 10, 1, 11, now(), now())`);
    await step(tx, "section", sql`
      insert into quote_sections (uid, quote_uid, title, sort_order, created_at)
      values (${`qsc_${UID}`}, ${QUOTE_DRAFT}, 'Work', 0, now())`);
    await step(tx, "line", sql`
      insert into quote_lines (uid, quote_uid, section_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, created_at)
      values (${`qln_${UID}`}, ${QUOTE_DRAFT}, ${`qsc_${UID}`}, 0, 'custom', 'Gravel', 1, 'each', 10, 'GST', 10, 10, now())`);
    await step(tx, "send quote", sql`update quotes set status = 'sent', sent_at = now() where uid = ${QUOTE_SENT}`);
    await step(tx, "replica", sql`
      insert into document_blob_replicas (sha256, created_at, updated_at)
      select sha256, now(), now() from document_blobs`);
    await step(tx, "milestone", sql`
      insert into payment_milestones (uid, job_id, quote_uid, label, percent, sort_order, created_at, updated_at)
      values (${`pms_${UID}`}, 'job-1', ${QUOTE_DRAFT}, 'Deposit', 50, 0, now(), now())`);
    await step(tx, "invoices", sql`
      insert into invoices (uid, job_id, number, kind, subtotal, tax_total, total, quote_uid, milestone_uid, created_at, updated_at) values
        (${`inv_${UID}`}, 'job-1', 'EI-1', 'deposit', 10, 1, 11, ${QUOTE_DRAFT}, ${`pms_${UID}`}, now(), now()),
        (${`inv_${UID_B}`}, 'job-1', 'EI-2', 'final', 10, 1, 11, null, null, now(), now())`);
    await step(tx, "invoice line", sql`
      insert into invoice_lines (uid, invoice_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, created_at)
      values (${`iln_${UID}`}, ${`inv_${UID}`}, 0, 'custom', 'Deposit', 1, 'each', 10, 'GST', 10, 10, now())`);
    await step(tx, "credit note", sql`
      insert into credit_notes (uid, job_id, number, invoice_uid, reason, subtotal, tax_total, total, created_at, updated_at)
      values (${`crn_${UID}`}, 'job-1', 'CN-1', ${`inv_${UID}`}, 'Wrong amount', 10, 1, 11, now(), now())`);
    await step(tx, "credit line", sql`
      insert into credit_note_lines (uid, credit_note_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, created_at)
      values (${`cnl_${UID}`}, ${`crn_${UID}`}, 0, 'custom', 'Deposit', 1, 'each', 10, 'GST', 10, 10, now())`);
    await step(tx, "payment", sql`
      insert into payments (uid, job_id, invoice_uid, amount, paid_on, recorded_at, created_at, updated_at)
      values (${`pay_${UID}`}, 'job-1', ${`inv_${UID}`}, 11, current_date, now(), now(), now())`);
    await step(tx, "receipt", sql`
      insert into receipts (uid, job_id, number, payment_uid, invoice_uid, amount, issued_at, issued_on, created_at, updated_at)
      values (${`rct_${UID}`}, 'job-1', 'ER-1', ${`pay_${UID}`}, ${`inv_${UID}`}, 11, now(), current_date, now(), now())`);
    await step(tx, "allocation", sql`
      insert into payment_allocations (uid, job_id, payment_uid, from_invoice_uid, to_invoice_uid, credit_note_uid, amount, allocated_at, created_at)
      values (${`pal_${UID}`}, 'job-1', ${`pay_${UID}`}, ${`inv_${UID}`}, ${`inv_${UID_B}`}, ${`crn_${UID}`}, 11, now(), now())`);
    await step(tx, "settings", sql`insert into business_settings (created_at, updated_at) values (now(), now())`);
    await step(tx, "milestone rule", sql`
      insert into milestone_rules (uid, name, sort_order, created_at, updated_at)
      values (${`mrl_${UID}`}, 'Default', 0, now(), now())`);
    await step(tx, "rule milestone", sql`
      insert into milestone_rule_milestones (uid, rule_uid, sort_order, label, percent)
      values (${`mrm_${UID}`}, ${`mrl_${UID}`}, 0, 'Deposit', 50)`);
    await step(tx, "rule cap", sql`
      insert into milestone_rule_caps (uid, rule_uid, kind, max_percent, mode)
      values (${`mrc_${UID}`}, ${`mrl_${UID}`}, 'deposit', 50, 'hard')`);
    await step(tx, "xero connection", sql`insert into xero_connections (created_at, updated_at) values (now(), now())`);
    await step(tx, "xero sync", sql`
      insert into xero_invoice_syncs (invoice_uid, tenant_id, mode, queued_by, queued_at, created_at, updated_at)
      values (${`inv_${UID}`}, 'tenant', 'draft', 'auto', now(), now(), now())`);
    await step(tx, "xero link", sql`
      insert into xero_invoice_links (invoice_uid, tenant_id, xero_invoice_id, linked_at)
      values (${`inv_${UID}`}, 'tenant', 'xero-1', now())`);
    await step(tx, "credential", sql`
      insert into integration_credentials (integration, field, value_enc, key_id, set_at)
      values ('xero', 'client_id', 'fs1.key.nonce.cipher.tag', 'key', now())`);
    await step(tx, "integration audit", sql`
      insert into integration_audit_events (uid, integration, action, at)
      values ('iae_1', 'xero', 'connected', now())`);
    await step(tx, "access audit", sql`
      insert into access_audit_events (uid, action, target_id, at)
      values ('aae_1', 'token_revoked', 'tok_1', now())`);
    await step(tx, "setup", sql`insert into integration_setup (integration, step, updated_at) values ('xero', 'app', now())`);
    await step(tx, "membership", sql`insert into org_memberships (user_uid, role, status) values ('user_1', 'owner', 'active')`);
  });

  await withOrg(db, ORG_B, async (tx) => {
    await step(tx, "tax B", sql`insert into tax_codes (code, label, rate) values ('GST', 'GST 10%', '0.1')`);
    await step(tx, "item B", sql`
      insert into items (uid, code, name, unit_code, created_at, updated_at)
      values (${ITEM_B}, 'STONE', 'Stone', 'each', now(), now())`);
  });
}

describe("schema field", () => {
  test("schema.ts defines tables on fieldSchema and does not import pgTable", () => {
    const source = readFileSync(SCHEMA_SOURCE, "utf8");
    assert.match(source, /export const fieldSchema = pgSchema\("field"\)/);
    assert.match(source, /fieldSchema\.table\(/);
    assert.doesNotMatch(source, /\bpgTable\b/);
  });

  test("migrations through 0024 still create tables in public when search_path prefers field", async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    const idx = journal.entries.find((entry) => entry.tag.startsWith("0024_")).idx;
    const dir = migrationsUpTo(idx);
    const client = new PGlite();
    try {
      const [path] = await queryRows(sql`show search_path`, drizzle(client, { schema }));
      assert.match(String(path.search_path), /field/);
      await migrate(drizzle(client, { schema }), { migrationsFolder: dir });
      const [fieldSchema] = await queryRows(sql`select count(*)::int as n from pg_namespace where nspname = 'field'`, drizzle(client, { schema }));
      assert.equal(fieldSchema.n, 0);
      const [tables] = await queryRows(sql`
        select count(*)::int as n from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`, drizzle(client, { schema }));
      assert.equal(tables.n, 52);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fully migrated database leaves public empty of Field objects", async () => {
    const t = await createTestDb();
    try {
      assert.deepEqual(await publicObjects(t.db), []);
      const [tables] = await queryRows(sql`
        select count(*)::int as n from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'field' and c.relkind = 'r'`, t.db);
      assert.equal(tables.n, 52);
      const functions = await queryRows(sql`
        select p.proname as name, p.proconfig as config
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'field' and p.proname like 'field\\_%'
        order by 1`, t.db);
      assert.deepEqual(functions.map((fn) => fn.name), FIELD_FUNCTIONS);
      for (const fn of functions) {
        const config = Array.isArray(fn.config) ? fn.config.join(",") : String(fn.config ?? "");
        assert.match(config, /search_path=field, pg_catalog/, fn.name);
      }
      const [journal] = await queryRows(sql`select to_regclass('drizzle.__drizzle_migrations') as rel`, t.db);
      assert.equal(journal.rel, "drizzle.__drizzle_migrations");

      await t.db.execute(sql`create table public.not_field (id integer)`);
      assert.deepEqual(await publicObjects(t.db), [{ kind: "r", name: "not_field" }]);
    } finally {
      await t.close();
    }
  });

  test("an install at 0024 keeps every row, and a sent quote stays frozen", async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    const idx = journal.entries.find((entry) => entry.tag.startsWith("0024_")).idx;
    const dir = migrationsUpTo(idx);
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: dir });
      await seedAt0024(db);
      const before = await tableCounts(db, "public");
      const tenant = await queryRows(sql`
        select c.relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_uid' and not a.attisdropped
        where n.nspname = 'public' and c.relkind = 'r'
        order by 1`, db);
      const empty = tenant.filter((table) => before[table.name] < 1).map((table) => table.name);
      assert.deepEqual(empty, [], "every tenant table needs a row before the move");
      const [gravel] = await queryRows(sql`select name from items where uid = ${ITEM_A}`, db);
      assert.equal(gravel.name, "Gravel");

      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      assert.deepEqual(await publicObjects(db), []);
      assert.deepEqual(await tableCounts(db, "field"), before);
      const [moved] = await queryRows(sql`select name from items where uid = ${ITEM_A}`, db);
      assert.equal(moved.name, "Gravel");
      const [sent] = await queryRows(sql`select status from quotes where uid = ${QUOTE_SENT}`, db);
      assert.equal(sent.status, "sent");

      const mode = await inspectRowSecurity(db);
      assert.equal(mode.via, "set-role");
      assert.equal(mode.enforced, true);
      assert.deepEqual(mode.unprotectedTables, []);
      const own = await withOrg(db, ORG_A, (tx) => queryRows(sql`select code from items order by code`, tx));
      assert.deepEqual(own.map((row) => row.code), ["GRAVEL", "SAND"]);
      const other = await withOrg(db, ORG_B, (tx) => queryRows(sql`select code from items order by code`, tx));
      assert.deepEqual(other.map((row) => row.code), ["STONE"]);

      await db.execute(sql`create role owner_sim nologin nobypassrls`);
      await db.execute(sql`grant usage on schema field to owner_sim`);
      await db.execute(sql`alter table items owner to owner_sim`);
      const forced = await db.transaction(async (tx) => {
        await tx.execute(sql`set local role owner_sim`);
        const force = await inspectRowSecurity(tx);
        assert.equal(force.via, "force");
        assert.equal(force.enforced, true);
        await tx.execute(sql`select set_config('field.org_uid', ${ORG_B}, true)`);
        return queryRows(sql`select code from items`, tx);
      });
      assert.deepEqual(forced.map((row) => row.code), ["STONE"]);

      // The function's own search_path finds `quotes`. The session's does not.
      await rejects(db.transaction(async (tx) => {
        await tx.execute(sql`set local search_path to public`);
        await tx.execute(sql`update field.quotes set subtotal = subtotal + 1, total = total + 1 where uid = ${QUOTE_SENT}`);
      }), /was sent/);
      await rejects(db.transaction(async (tx) => {
        await tx.execute(sql`set local search_path to public`);
        await tx.execute(sql`
          insert into field.quote_lines (org_uid, uid, quote_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, created_at)
          values (${ORG_A}, ${`qln_${UID_B}`}, ${QUOTE_SENT}, 0, 'custom', 'Extra', 1, 'each', 10, 'GST', 10, 10, now())`);
      }), /was sent/);
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local search_path to public`);
        await tx.execute(sql`update field.quotes set subtotal = 20, tax_total = 2, total = 22 where uid = ${QUOTE_DRAFT}`);
      });
      const [draft] = await queryRows(sql`select subtotal from quotes where uid = ${QUOTE_DRAFT}`, db);
      assert.equal(Number(draft.subtotal), 20);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
