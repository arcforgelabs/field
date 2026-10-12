// The invoice row tables and service (#27): a job's schedule, invoices,
// payments and receipts written in one transaction and idempotently; the
// database refusing any change to an issued invoice, a payment or a receipt;
// row-level security between organisations; and the 0013 rollback.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createTestDb, MIGRATIONS_FOLDER, queryRows, schema } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createInvoiceRowService } from "./invoice-rows.js";
import { collectJobInvoices } from "./sync.js";
import { scenarios } from "./test-fixtures.js";

const ORG_A = DEFAULT_ORG_UID;
const ORG_B = "org_01TESTSECONDORGANISATION0";
const ROLLBACK_0013 = fileURLToPath(new URL("../db/rollback/0013_invoice_rows.down.sql", import.meta.url));
const ROLLBACK_0014 = fileURLToPath(new URL("../db/rollback/0014_invoice_issue.down.sql", import.meta.url));
const ROLLBACK_0015 = fileURLToPath(new URL("../db/rollback/0015_credit_notes.down.sql", import.meta.url));

function rejects(promise, pattern) {
  return assert.rejects(promise, (error) => {
    let message = "";
    for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
    assert.match(message, pattern);
    return true;
  });
}

const asOrg = (db, orgUid, query) => withOrg(db, orgUid, (tx) => queryRows(query, tx));

describe("invoice rows", () => {
  let t;
  let a;
  let b;
  let dataDir;
  const jobs = {};

  before(async () => {
    t = await createTestDb();
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    a = createInvoiceRowService({ db: t.db, orgUid: ORG_A });
    b = createInvoiceRowService({ db: t.db, orgUid: ORG_B });
    dataDir = mkdtempSync(join(tmpdir(), "field-invoice-rows-"));
    for (const name of ["paid", "revised", "revisedPaid", "voidedPayment"]) jobs[name] = await collectJobInvoices(await scenarios[name](dataDir));
  });
  after(async () => {
    await t.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a job is written in one go, and a second write changes nothing", async () => {
    const { jobId, mapped } = jobs.paid;
    const first = await a.writeJob({ jobId, mapped, actor: "test" });
    assert.deepEqual([first.milestones.created, first.invoices.created, first.payments.created, first.receipts.created], [2, 2, 1, 1]);
    assert.deepEqual(first.conflicts, []);
    const rows = await a.readJob(jobId);
    assert.ok(rows.invoices.every((invoice) => /^inv_[0-9A-HJKMNP-TV-Z]{26}$/.test(invoice.uid)));
    assert.ok(rows.milestones.every((milestone) => /^pms_/.test(milestone.uid)));
    assert.deepEqual(rows.invoices.map((invoice) => [invoice.number, invoice.kind, invoice.status, invoice.subtotal, invoice.taxTotal, invoice.total, invoice.amountPaid]), [
      ["EI-2605-03-M1", "deposit", "paid", "400.00", "40.00", "440.00", "440.00"],
      ["EI-2605-03-M2", "final", "draft", "400.00", "40.00", "440.00", "0.00"],
    ]);
    const [deposit] = rows.invoices;
    assert.equal(deposit.milestoneUid, rows.milestones[0].uid);
    assert.equal(deposit.reference, "JOB-2605-03");
    assert.deepEqual(deposit.lines.map((line) => [line.lineType, line.name, line.quantity, line.unitSell, line.lineTotal, line.taxRate]), [
      ["claim", "Deposit, 50 % of EQ-2605-03 v1", "1.0000", "400.0000", "400.00", "10.000"],
    ]);
    assert.deepEqual(rows.payments.map((payment) => [payment.amount, payment.paidOn, payment.invoiceUid === deposit.uid, payment.voidedAt]), [["440.00", "2026-05-10", true, null]]);
    assert.deepEqual(rows.receipts.map((receipt) => [receipt.number, receipt.amount, receipt.status, receipt.paymentUid === rows.payments[0].uid]), [["ER-2605-03-M1", "440.00", "issued", true]]);

    const second = await a.writeJob({ jobId, mapped, actor: "test" });
    assert.deepEqual([second.milestones.unchanged, second.invoices.unchanged, second.payments.unchanged, second.receipts.unchanged], [2, 2, 1, 1]);
    assert.deepEqual(await a.readJob(jobId), rows, "nothing moved, not even a version");
  });

  test("a dry run says what it would write and writes nothing", async () => {
    const { jobId, mapped } = jobs.revised;
    const dry = await a.writeJob({ jobId, mapped, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.invoices.created, 3);
    assert.deepEqual((await a.readJob(jobId)).invoices, []);
  });

  test("a revision superseded in place is its own credited row, linked from its successor", async () => {
    const { jobId, mapped } = jobs.revised;
    await a.writeJob({ jobId, mapped });
    const { invoices } = await a.readJob(jobId);
    const byNumber = Object.fromEntries(invoices.map((invoice) => [invoice.number, invoice]));
    assert.deepEqual(Object.keys(byNumber).sort(), ["EI-2605-04-M1", "EI-2605-04-M1-R2", "EI-2605-04-M2"]);
    assert.deepEqual([byNumber["EI-2605-04-M1"].status, byNumber["EI-2605-04-M1"].total, byNumber["EI-2605-04-M1"].revision], ["credited", "110.00", 1]);
    assert.match(byNumber["EI-2605-04-M1"].note, /credited by CN-EI-2605-04-M1 .*replaced by EI-2605-04-M1-R2/);
    assert.ok(byNumber["EI-2605-04-M1"].supersededAt);
    const r2 = byNumber["EI-2605-04-M1-R2"];
    assert.deepEqual([r2.status, r2.total, r2.revision, r2.supersedesInvoiceUid, r2.revisionReason], ["issued", "165.00", 2, byNumber["EI-2605-04-M1"].uid, "Approved variation"]);
    // The credit note recorded for it: in full, issued, naming the replacement.
    const { creditNotes } = await a.readJob(jobId);
    assert.deepEqual(creditNotes.map((note) => [note.number, note.status, note.origin, note.invoiceUid, note.replacementInvoiceUid, note.total, note.reason, note.issuedDocumentUid]), [
      ["CN-EI-2605-04-M1", "issued", "revision-migration", byNumber["EI-2605-04-M1"].uid, r2.uid, "110.00", "Approved variation", null],
    ]);
    assert.equal(creditNotes[0].lines[0].invoiceLineUid, byNumber["EI-2605-04-M1"].lines[0].uid);
    const again = await a.writeJob({ jobId, mapped });
    assert.deepEqual(again.creditNotes, { created: 0, unchanged: 1 });
    // An issued credit note never changes, and is never deleted.
    await rejects(asOrg(t.db, ORG_A, sql`update credit_notes set total = 0, subtotal = 0, tax_total = 0`), /was issued: change refused/);
    await rejects(asOrg(t.db, ORG_A, sql`delete from credit_notes`), /was issued: delete refused/);
  });

  test("a payment on a credited invoice moves to its replacement, as an allocation", async () => {
    const { jobId, mapped } = jobs.revisedPaid;
    const first = await a.writeJob({ jobId, mapped });
    assert.equal(first.allocations.created, 1);
    const { invoices, payments, allocations, creditNotes } = await a.readJob(jobId);
    const byNumber = Object.fromEntries(invoices.map((invoice) => [invoice.number, invoice]));
    const credited = byNumber["EI-2605-07-M1"];
    const replacement = byNumber["EI-2605-07-M1-R2"];
    assert.equal(payments[0].invoiceUid, credited.uid, "the payment keeps the invoice it was recorded against");
    assert.deepEqual(allocations.map((allocation) => [allocation.paymentUid, allocation.fromInvoiceUid, allocation.toInvoiceUid, allocation.creditNoteUid, allocation.amount]), [
      [payments[0].uid, credited.uid, replacement.uid, creditNotes[0].uid, payments[0].amount],
    ]);
    assert.deepEqual([credited.amountPaid, replacement.amountPaid], ["0.00", payments[0].amount]);
    const again = await a.writeJob({ jobId, mapped });
    assert.equal(again.allocations.created, 0, "a payment moves once");
    await rejects(asOrg(t.db, ORG_A, sql`delete from payment_allocations`), /append-only: delete refused|permission denied for table payment_allocations/);
    await rejects(asOrg(t.db, ORG_A, sql`update payment_allocations set amount = 1`), /append-only: update refused|permission denied for table payment_allocations/);
  });

  test("a voided payment keeps its row with voided_at; a payment the files drop is voided, never deleted", async () => {
    const { jobId, mapped } = jobs.voidedPayment;
    await a.writeJob({ jobId, mapped });
    let { payments, invoices } = await a.readJob(jobId);
    assert.equal(payments.length, 1);
    assert.ok(payments[0].voidedAt);
    assert.equal(payments[0].voidReason, "Entered twice");
    assert.equal(invoices[0].amountPaid, "0.00", "a voided payment pays nothing");

    // The files lose a payment (a "mark unpaid" clears them): its row is voided.
    const active = { ...mapped.payments[0], key: "0:extra", voidedAt: null, voidReason: null, voidedBy: null };
    await a.writeJob({ jobId, mapped: { ...mapped, payments: [...mapped.payments, active] } });
    ({ payments, invoices } = await a.readJob(jobId));
    assert.equal(invoices[0].amountPaid, "100.00");
    const summary = await a.writeJob({ jobId, mapped, actor: "dual-write" });
    assert.equal(summary.payments.voided, 1);
    ({ payments, invoices } = await a.readJob(jobId));
    const dropped = payments.find((payment) => payment.sourcePaymentId === "0:extra");
    assert.ok(dropped.voidedAt);
    assert.match(dropped.voidReason, /marked unpaid/);
    assert.equal(invoices[0].amountPaid, "0.00");
  });

  test("an issued invoice whose files now say otherwise is kept as issued and reported", async () => {
    const { jobId, mapped } = jobs.paid;
    const changed = structuredClone(mapped);
    const deposit = changed.invoices[0];
    deposit.lines[0].unitSell = "390.0000";
    deposit.lines[0].lineTotal = "390.00";
    deposit.taxTotal = "39.00";
    deposit.total = "429.00";
    const summary = await a.writeJob({ jobId, mapped: changed });
    assert.equal(summary.conflicts.length, 1);
    assert.equal(summary.conflicts[0].number, "EI-2605-03-M1");
    assert.deepEqual(summary.conflicts[0].differences.map((difference) => difference.field), ["subtotal", "taxTotal", "total", "lines"]);
    const rows = await a.readJob(jobId);
    assert.equal(rows.invoices[0].total, "440.00");
  });

  test("the database refuses changing an issued invoice, its lines, a payment or a receipt, for the owner too", async () => {
    const { jobId } = jobs.paid;
    const [invoice] = await asOrg(t.db, ORG_A, sql`select uid from invoices where job_id = ${jobId} and number = 'EI-2605-03-M1'`);
    const tx = (query) => withOrg(t.db, ORG_A, (inner) => inner.execute(query));
    await rejects(tx(sql`update invoices set subtotal = 1, tax_total = 0, total = 1 where uid = ${invoice.uid}`), /was issued: change refused/);
    await rejects(tx(sql`update invoices set number = 'EI-OTHER' where uid = ${invoice.uid}`), /was issued: change refused/);
    await rejects(tx(sql`update invoices set status = 'draft', issued_at = null where uid = ${invoice.uid}`), /was issued: change refused/);
    await rejects(tx(sql`delete from invoices where uid = ${invoice.uid}`), /was issued: delete refused/);
    await rejects(tx(sql`update invoice_lines set line_total = 1, unit_sell = 1 where invoice_uid = ${invoice.uid}`), /was issued: update of its lines refused/);
    await rejects(tx(sql`insert into invoice_lines (uid, invoice_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, created_at)
      values ('iln_01JVVVVVVVVVVVVVVVVVVVVVVV', ${invoice.uid}, 9, 'custom', 'Extra', 1, 'lot', 5, 'GST', 10, 5, now())`), /was issued: insert of its lines refused/);
    await rejects(tx(sql`delete from payments`), /void it instead/);
    await rejects(tx(sql`update payments set amount = 1`), /only voiding, once, is allowed/);
    await rejects(tx(sql`update receipts set amount = 1`), /was issued: change refused/);
    await rejects(tx(sql`delete from receipts`), /delete refused/);
    for (const table of ["invoices", "invoice_lines", "payments", "receipts", "credit_notes", "credit_note_lines"]) {
      await rejects(t.db.execute(sql.raw(`truncate ${table} cascade`)), /cannot be truncated/);
    }
    // What may still move on: status, amount paid, due date.
    await tx(sql`update invoices set status = 'issued', due_on = '2026-06-30' where uid = ${invoice.uid}`);
    await tx(sql`update invoices set status = 'paid', due_on = null where uid = ${invoice.uid}`);
    // A receipt may be voided once, never un-voided.
    await tx(sql`update receipts set status = 'void' where job_id = ${jobId}`);
    await rejects(tx(sql`update receipts set status = 'issued' where job_id = ${jobId}`), /was issued: change refused/);
  });

  test("the table checks hold: totals add up, enums, issue time, uids", async () => {
    const insert = (values) => withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into invoices (uid, job_id, number, kind, status, issued_at, subtotal, tax_total, total, created_at, updated_at) values ${values}`));
    await rejects(insert(sql`('inv_01JWWWWWWWWWWWWWWWWWWWWWWW', 'job-c', 'EI-C', 'deposit', 'draft', null, 10, 1, 12, now(), now())`), /invoices_total_check/);
    await rejects(insert(sql`('inv_01JWWWWWWWWWWWWWWWWWWWWWWW', 'job-c', 'EI-C', 'deposit', 'sent', now(), 10, 1, 11, now(), now())`), /invoices_status_check/);
    await rejects(insert(sql`('inv_01JWWWWWWWWWWWWWWWWWWWWWWW', 'job-c', 'EI-C', 'deposit', 'issued', null, 10, 1, 11, now(), now())`), /invoices_issued_check/);
    await rejects(insert(sql`('inv_01JWWWWWWWWWWWWWWWWWWWWWWW', 'job-c', 'EI-C', 'bonus', 'draft', null, 10, 1, 11, now(), now())`), /invoices_kind_check/);
    await rejects(insert(sql`('invoice-1', 'job-c', 'EI-C', 'deposit', 'draft', null, 10, 1, 11, now(), now())`), /invoices_uid_check/);
  });

  test("another organisation sees none of it and cannot write into it", async () => {
    const { jobId, mapped } = jobs.paid;
    assert.deepEqual(await b.readJob(jobId), { milestones: [], invoices: [], creditNotes: [], payments: [], allocations: [], receipts: [] });
    const [seen] = await asOrg(t.db, ORG_B, sql`select (select count(*) from invoices)::int as i, (select count(*) from payments)::int as p, (select count(*) from receipts)::int as r, (select count(*) from payment_milestones)::int as m`);
    assert.deepEqual(seen, { i: 0, p: 0, r: 0, m: 0 });
    // Organisation B writing the same job id gets its own rows, never A's.
    await b.writeJob({ jobId, mapped });
    const [mine] = await asOrg(t.db, ORG_B, sql`select count(*)::int as n from invoices`);
    assert.equal(mine.n, 2);
    const [aInvoice] = await asOrg(t.db, ORG_A, sql`select uid from invoices where job_id = ${jobId} limit 1`);
    // B cannot point a payment at A's invoice: the composite key refuses it.
    await rejects(withOrg(t.db, ORG_B, (tx) => tx.execute(sql`insert into payments (uid, job_id, invoice_uid, amount, paid_on, recorded_at, created_at, updated_at)
      values ('pay_01JWWWWWWWWWWWWWWWWWWWWWWW', ${jobId}, ${aInvoice.uid}, 5, '2026-05-01', now(), now(), now())`)), /payments_invoice_fk/);
    // And cannot write a row as A.
    await rejects(withOrg(t.db, ORG_B, (tx) => tx.execute(sql`insert into payment_milestones (uid, org_uid, job_id, label, percent, sort_order, created_at, updated_at)
      values ('pms_01JWWWWWWWWWWWWWWWWWWWWWWW', ${ORG_A}, 'job-x', 'Deposit', 10, 0, now(), now())`)), /row-level security/);
  });
});

function migrationsUpTo(idx) {
  const dir = mkdtempSync(join(tmpdir(), "field-invoice-rows-"));
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
    queryRows(sql`select relname || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r'`, db),
    queryRows(sql`select 'policy ' || tablename || '.' || policyname as x from pg_policies where schemaname = 'public'`, db),
    queryRows(sql`select 'function ' || p.proname as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`, db),
    queryRows(sql`select 'trigger ' || tgname as x from pg_trigger where not tgisinternal`, db),
  ]);
  return rows.flat().map((row) => row.x).sort();
}

describe("migration 0013 rolls back", () => {
  test("the rollback returns the 0012 shape, and 0013 applies again empty", async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    const idx = journal.entries.find((entry) => entry.tag === "0013_invoice_rows").idx;
    const before = migrationsUpTo(idx - 1);
    const upTo = migrationsUpTo(idx);
    const client = new PGlite();
    const reference = new PGlite();
    const dataDir = mkdtempSync(join(tmpdir(), "field-invoice-rollback-"));
    try {
      const db = drizzle(client, { schema });
      // Written by today's service, on today's schema; the later migrations
      // are rolled back first, newest first, as the rollback files say.
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const { jobId, mapped } = await collectJobInvoices(await scenarios.paid(dataDir));
      await createInvoiceRowService({ db, orgUid: ORG_A }).writeJob({ jobId, mapped });
      await client.exec(`begin; ${readFileSync(ROLLBACK_0015, "utf8")}; commit;`);
      await client.exec(`begin; ${readFileSync(ROLLBACK_0014, "utf8")}; commit;`);
      await client.exec(`begin; ${readFileSync(ROLLBACK_0013, "utf8")}; commit;`);
      await migrate(drizzle(reference, { schema }), { migrationsFolder: before });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference, { schema })));
      await migrate(db, { migrationsFolder: upTo });
      const [count] = await asOrg(db, ORG_A, sql`select count(*)::int as n from invoices`);
      assert.equal(count.n, 0, "0013 re-applies empty; the backfill fills it again");
    } finally {
      await client.close();
      await reference.close();
      rmSync(before, { recursive: true, force: true });
      rmSync(upTo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("migration 0015 rolls back", () => {
  test("the rollback returns the 0014 shape with recorded credit notes dropped, and refuses once a credit note was issued", async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    const idx = journal.entries.find((entry) => entry.tag === "0015_credit_notes").idx;
    const before = migrationsUpTo(idx - 1);
    const upTo = migrationsUpTo(idx);
    const client = new PGlite();
    const reference = new PGlite();
    const refusing = new PGlite();
    const dataDir = mkdtempSync(join(tmpdir(), "field-invoice-rollback-0015-"));
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: upTo });
      const { jobId, mapped } = await collectJobInvoices(await scenarios.revisedPaid(dataDir));
      await createInvoiceRowService({ db, orgUid: ORG_A }).writeJob({ jobId, mapped });
      await client.exec(`begin; ${readFileSync(ROLLBACK_0015, "utf8")}; commit;`);
      await migrate(drizzle(reference, { schema }), { migrationsFolder: before });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference, { schema })));
      const [left] = await asOrg(db, ORG_A, sql`select (select count(*) from credit_notes)::int as notes, (select count(*) from invoices)::int as invoices`);
      assert.deepEqual(left, { notes: 0, invoices: 3 }, "the recorded credit notes go; the invoices stay");

      const issued = drizzle(refusing, { schema });
      await migrate(issued, { migrationsFolder: upTo });
      await withOrg(issued, ORG_A, async (tx) => {
        await tx.execute(sql`insert into invoices (uid, job_id, number, kind, status, subtotal, tax_total, total, issued_at, created_at, updated_at)
          values ('inv_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'job-x', 'EI-X-M1', 'deposit', 'issued', 1, 0, 1, now(), now(), now())`);
        await tx.execute(sql`insert into credit_notes (uid, job_id, number, invoice_uid, status, reason, subtotal, tax_total, total, issued_at, issue_key, created_at, updated_at)
          values ('crn_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'job-x', 'CN-2026-10-1', 'inv_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'issued', 'Wrong amount', 1, 0, 1, now(), 'k', now(), now())`);
      });
      await rejects(refusing.exec(`begin; ${readFileSync(ROLLBACK_0015, "utf8")}; commit;`), /credit notes were issued; 0015 cannot be rolled back/);
    } finally {
      await client.close();
      await reference.close();
      await refusing.close();
      rmSync(before, { recursive: true, force: true });
      rmSync(upTo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("migration 0014 rolls back", () => {
  test("the rollback returns the 0013 shape, and refuses once an invoice was issued from the sequence", async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    const idx = journal.entries.find((entry) => entry.tag === "0014_invoice_issue").idx;
    const before = migrationsUpTo(idx - 1);
    const upTo = migrationsUpTo(idx);
    const client = new PGlite();
    const reference = new PGlite();
    const refusing = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: upTo });
      await client.exec(`begin; ${readFileSync(ROLLBACK_0014, "utf8")}; commit;`);
      await migrate(drizzle(reference, { schema }), { migrationsFolder: before });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference, { schema })));

      const issued = drizzle(refusing, { schema });
      await migrate(issued, { migrationsFolder: upTo });
      await withOrg(issued, ORG_A, (tx) => tx.execute(sql`insert into invoices (uid, job_id, number, kind, status, subtotal, tax_total, total, issued_at, issue_key, reference, created_at, updated_at)
        values ('inv_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'job-x', 'INV-2026-10-1', 'deposit', 'issued', 1, 0, 1, now(), 'k', '2610-01', now(), now())`));
      await rejects(refusing.exec(`begin; ${readFileSync(ROLLBACK_0014, "utf8")}; commit;`), /issued with INV numbers; 0014 cannot be rolled back/);
    } finally {
      await client.close();
      await reference.close();
      await refusing.close();
      rmSync(before, { recursive: true, force: true });
      rmSync(upTo, { recursive: true, force: true });
    }
  });
});
