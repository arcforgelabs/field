// Invoice rows on a real PostgreSQL server (#27), migrated the way Replit
// runs it: by a login role that owns the tables, is not a superuser and
// cannot create roles, so row-level security holds through FORCE alone. Off
// unless FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1 is set
// (server/db-runtime/test-postgres.js).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migratePostgresDatabase, queryRows, schema } from "../db-runtime/index.js";
import { startTestPostgres, testPostgresMode } from "../db-runtime/test-postgres.js";
import { DEFAULT_ORG_UID, inspectRowSecurity, withOrg } from "../db-runtime/tenancy.js";
import { createInvoiceRowService } from "./invoice-rows.js";
import { collectJobInvoices } from "./sync.js";
import { scenarios } from "./test-fixtures.js";

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

function rejects(promise, pattern) {
  return assert.rejects(promise, (error) => {
    let message = "";
    for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
    assert.match(message, pattern);
    return true;
  });
}

function connect(url) {
  const client = postgres(url, { max: 3, onnotice: () => {}, connection: { TimeZone: "UTC" } });
  clients.push(client);
  return { client, db: drizzle(client, { schema }) };
}

test("as a table owner without CREATEROLE: rows round-trip, other organisations see nothing, issued rows never change", { skip: !enabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL" }, async () => {
  const admin = connect(server.url).client;
  const suffix = randomBytes(4).toString("hex");
  const role = `owner_${suffix}`;
  const database = `field_invoices_${suffix}`;
  const dataDir = mkdtempSync(join(tmpdir(), "field-invoice-rows-pg-"));
  await admin.unsafe(`create role ${role} login nosuperuser nobypassrls nocreaterole`);
  await admin.unsafe(`create database ${database} owner ${role}`);
  try {
    const url = new URL(server.url);
    url.username = role;
    url.pathname = `/${database}`;
    const { db } = connect(url.toString());
    await migratePostgresDatabase(db);
    assert.equal((await inspectRowSecurity(db)).enforced, true);
    await db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);

    const a = createInvoiceRowService({ db, orgUid: DEFAULT_ORG_UID });
    const b = createInvoiceRowService({ db, orgUid: ORG_B });
    const paid = await collectJobInvoices(await scenarios.paid(dataDir));
    const revised = await collectJobInvoices(await scenarios.revised(dataDir));
    await a.writeJob({ jobId: paid.jobId, mapped: paid.mapped });
    await a.writeJob({ jobId: revised.jobId, mapped: revised.mapped });
    const read = await a.readJob(paid.jobId);
    assert.deepEqual(read.invoices.map((invoice) => [invoice.number, invoice.status, invoice.subtotal, invoice.taxTotal, invoice.total, invoice.amountPaid]), [
      ["EI-2605-03-M1", "paid", "400.00", "40.00", "440.00", "440.00"],
      ["EI-2605-03-M2", "draft", "400.00", "40.00", "440.00", "0.00"],
    ], "numeric(12,2) comes back as the same strings");
    assert.deepEqual(read.invoices[0].lines.map((line) => [line.quantity, line.unitSell, line.taxRate]), [["1.0000", "400.0000", "10.000"]]);
    assert.equal(read.payments[0].paidOn, "2026-05-10");
    const second = await a.writeJob({ jobId: paid.jobId, mapped: paid.mapped });
    assert.equal(second.invoices.unchanged, 2);
    assert.deepEqual((await a.readJob(revised.jobId)).invoices.map((invoice) => [invoice.number, invoice.status]), [
      ["EI-2605-04-M1", "credited"], ["EI-2605-04-M1-R2", "issued"], ["EI-2605-04-M2", "draft"],
    ]);

    assert.deepEqual(await b.readJob(paid.jobId), { milestones: [], invoices: [], payments: [], receipts: [] });
    const [seen] = await withOrg(db, ORG_B, (tx) => queryRows(sql`select (select count(*) from invoices)::int as i, (select count(*) from invoice_lines)::int as l, (select count(*) from payments)::int as p, (select count(*) from receipts)::int as r`, tx));
    assert.deepEqual(seen, { i: 0, l: 0, p: 0, r: 0 });
    // The owner itself is filtered (FORCE) and cannot change what was issued (triggers).
    const asA = (query) => withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(query));
    await rejects(asA(sql`update invoices set subtotal = 0, tax_total = 0, total = 0 where status <> 'draft'`), /was issued: change refused/);
    await rejects(asA(sql`update invoice_lines set unit_sell = 1, line_total = 1 where invoice_uid in (select uid from invoices where status <> 'draft')`), /was issued: update of its lines refused/);
    await rejects(asA(sql`delete from invoices where status = 'credited'`), /was issued: delete refused/);
    await rejects(asA(sql`delete from payments`), /void it instead/);
    await rejects(asA(sql`update receipts set number = 'ER-OTHER'`), /was issued: change refused/);
    await rejects(db.execute(sql`truncate receipts`), /cannot be truncated/);
    await rejects(db.execute(sql`select count(*) from invoices`), /field\.org_uid is not set/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    await admin.unsafe(`drop database if exists ${database} with (force)`);
    await admin.unsafe(`drop role if exists ${role}`);
  }
});
