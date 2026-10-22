// Issued documents: the tables' tenancy and immutability, and the issue
// service's idempotency, transactionality and hash checks.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, before, after } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createTestDb, MIGRATIONS_FOLDER, queryRows, schema } from "../db-runtime/index.js";
import { withTablesInField } from "../db-runtime/move-tables.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createPostgresBlobStore, sha256Hex } from "./blob-store.js";
import { IssuedDocumentConflictError, createIssuedDocumentService } from "./issued-documents.js";
import { isDocumentUid, newDocumentEventUid, newDocumentUid } from "./uid.js";

const ORG_A = DEFAULT_ORG_UID;
const ORG_B = "org_01TESTSECONDORGANISATION0";
const ISSUED_AT = "2026-10-12T01:02:03.000Z";

function pdf(text) {
  return Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);
}

function rejects(promise, pattern) {
  return assert.rejects(promise, (error) => {
    let message = "";
    for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
    assert.match(message, pattern);
    return true;
  });
}

function quoteInput(overrides = {}) {
  return {
    jobId: "job-1",
    documentType: "quote",
    number: "EQ-2610-01 v1",
    quoteVersion: 1,
    pdfBytes: pdf("quote v1"),
    issuedAt: ISSUED_AT,
    issuedBy: "user-1",
    source: "live",
    details: { total: 110 },
    ...overrides,
  };
}

describe("issued documents", () => {
  let t;
  let a;
  let b;

  before(async () => {
    t = await createTestDb();
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    a = createIssuedDocumentService({ db: t.db, orgUid: ORG_A });
    b = createIssuedDocumentService({ db: t.db, orgUid: ORG_B });
  });
  after(() => t.close());

  test("uids are prefixed ULIDs", () => {
    const uid = newDocumentUid();
    assert.ok(isDocumentUid(uid), uid);
    assert.match(newDocumentEventUid(), /^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(newDocumentUid(), newDocumentUid());
    assert.ok(newDocumentUid(1000) < newDocumentUid(2000), "ULIDs sort by time");
  });

  test("recording writes the bytes, the row and an issued event; the bytes read back hash-checked", async () => {
    const result = await a.recordIssuedDocument(quoteInput({
      events: [{ event: "emailed", at: ISSUED_AT, by: "user-1", data: { messageId: "m-1", to: ["c@example.invalid"] }, idempotencyKey: "emailed:m-1" }],
    }));
    assert.equal(result.created, true);
    assert.ok(isDocumentUid(result.document.uid));
    assert.equal(result.document.pdfSha256, sha256Hex(pdf("quote v1")));
    assert.deepEqual(result.events.map((entry) => [entry.event.event, entry.created]), [["issued", true], ["emailed", true]]);

    const read = await a.readIssuedDocument(result.document.uid);
    assert.deepEqual(read.bytes, pdf("quote v1"));
    assert.equal(read.document.number, "EQ-2610-01 v1");
    assert.equal(read.document.issuedAt, ISSUED_AT);

    const listed = await a.listJobDocuments("job-1");
    assert.equal(listed.documents.length, 1);
    assert.deepEqual(listed.documents[0].events.map((event) => event.event), ["issued", "emailed"]);
  });

  test("the same number with the same bytes is a no-op; with different bytes it is refused", async () => {
    const again = await a.recordIssuedDocument(quoteInput({
      events: [{ event: "emailed", at: ISSUED_AT, data: { messageId: "m-1" }, idempotencyKey: "emailed:m-1" }],
    }));
    assert.equal(again.created, false);
    assert.deepEqual(again.events.map((entry) => entry.created), [false, false]);
    const [counts] = await withOrg(t.db, ORG_A, (tx) => queryRows(sql`
      select (select count(*) from issued_documents)::int as docs,
             (select count(*) from document_events)::int as events,
             (select count(*) from document_blobs)::int as blobs`, tx));
    assert.deepEqual(counts, { docs: 1, events: 2, blobs: 1 });

    await assert.rejects(a.recordIssuedDocument(quoteInput({ pdfBytes: pdf("quote v1, rendered again") })), (error) => {
      assert.ok(error instanceof IssuedDocumentConflictError);
      assert.equal(error.code, "ISSUED_DOCUMENT_CONFLICT");
      assert.equal(error.existing.number, "EQ-2610-01 v1");
      return true;
    });
    // One transaction: the refused bytes were not kept either.
    const [afterConflict] = await withOrg(t.db, ORG_A, (tx) => queryRows(sql`select count(*)::int as blobs from document_blobs`, tx));
    assert.equal(afterConflict.blobs, 1);
  });

  test("a failure part-way leaves nothing behind", async () => {
    await rejects(a.recordIssuedDocument(quoteInput({
      number: "EQ-2610-02 v1",
      pdfBytes: pdf("never kept"),
      events: [{ event: "not-an-event", at: ISSUED_AT }],
    })), /unknown document event/);
    const [counts] = await withOrg(t.db, ORG_A, (tx) => queryRows(sql`
      select (select count(*) from issued_documents where number = 'EQ-2610-02 v1')::int as docs,
             (select count(*) from document_blobs where sha256 = ${sha256Hex(pdf("never kept"))})::int as blobs`, tx));
    assert.deepEqual(counts, { docs: 0, blobs: 0 });
  });

  test("a redelivery keeps the issued document and stores the bytes sent with its event", async () => {
    const issued = await a.findIssuedDocument({ documentType: "quote", number: "EQ-2610-01 v1" });
    const redelivery = await a.recordRedelivery({
      issuedDocumentUid: issued.uid,
      pdfBytes: pdf("quote v1, resent"),
      event: { event: "emailed", at: "2026-10-13T00:00:00.000Z", data: { messageId: "m-2" }, idempotencyKey: "emailed:m-2" },
    });
    assert.equal(redelivery.created, true);
    assert.equal(redelivery.event.data.bytesMatchIssued, false);
    assert.equal(redelivery.event.data.pdfSha256, sha256Hex(pdf("quote v1, resent")));
    const read = await a.readIssuedDocument(issued.uid);
    assert.deepEqual(read.bytes, pdf("quote v1"), "the issued bytes never change");
  });

  test("another organisation can neither see nor reuse a document, its bytes or its events", async () => {
    const issued = await a.findIssuedDocument({ documentType: "quote", number: "EQ-2610-01 v1" });
    assert.equal(await b.readIssuedDocument(issued.uid), null);
    assert.equal(await b.getIssuedDocument(issued.uid), null);
    assert.deepEqual((await b.listJobDocuments("job-1")).documents, []);
    const rows = await withOrg(t.db, ORG_B, (tx) => queryRows(sql`
      select (select count(*) from issued_documents)::int as docs,
             (select count(*) from document_events)::int as events,
             (select count(*) from document_blobs)::int as blobs`, tx));
    assert.deepEqual(rows, [{ docs: 0, events: 0, blobs: 0 }]);

    // The same number in another organisation is a different document.
    const own = await b.recordIssuedDocument(quoteInput());
    assert.equal(own.created, true);
    assert.notEqual(own.document.uid, issued.uid);

    // Writing into another organisation is refused by the policy.
    await rejects(withOrg(t.db, ORG_B, (tx) => tx.execute(sql`
      insert into document_events (uid, org_uid, job_id, document_type, event, at, created_at)
      values (${newDocumentEventUid()}, ${ORG_A}, 'job-1', 'quote', 'emailed', now(), now())`)), /row-level security/);
    // An event cannot point at another organisation's document.
    await rejects(b.recordEvent({ issuedDocumentUid: issued.uid, jobId: "job-1", documentType: "quote", event: "emailed", at: ISSUED_AT }), /no issued document/);
    await rejects(withOrg(t.db, ORG_B, (tx) => tx.execute(sql`
      insert into document_events (uid, issued_document_uid, job_id, document_type, event, at, created_at)
      values (${newDocumentEventUid()}, ${issued.uid}, 'job-1', 'quote', 'emailed', now(), now())`)), /foreign key/);
    // Nor at another organisation's bytes.
    await rejects(withOrg(t.db, ORG_B, (tx) => tx.execute(sql`
      insert into issued_documents (uid, job_id, document_type, number, issued_at, pdf_sha256, source, created_at)
      values (${newDocumentUid()}, 'job-x', 'quote', 'EQ-X v1', now(), ${sha256Hex(pdf("quote v1, resent"))}, 'live', now())`)), /foreign key/);
    // Outside an organisation transaction the tables refuse to answer.
    await rejects(t.db.transaction(async (tx) => {
      await tx.execute(sql`set local role field_app`);
      await tx.execute(sql`select count(*) from issued_documents`);
    }), /field\.org_uid is not set/);
  });

  test("issued documents, events and blobs refuse to change or disappear, even for the owner", async () => {
    const issued = await a.findIssuedDocument({ documentType: "quote", number: "EQ-2610-01 v1" });
    // As the request role (field_app): no privilege at all.
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update issued_documents set number = 'EQ-HACK v1' where uid = ${issued.uid}`)), /permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`delete from document_blobs`)), /permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update document_events set at = now()`)), /permission denied/);
    // As the owner, organisation set (the trigger, not the grant).
    const asOwner = (statement) => t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('field.org_uid', ${ORG_A}, true)`);
      await tx.execute(statement);
    });
    await rejects(asOwner(sql`update issued_documents set pdf_sha256 = pdf_sha256, number = 'EQ-HACK v1' where uid = ${issued.uid}`), /append-only: update refused/);
    await rejects(asOwner(sql`update issued_documents set issued_at = now() where uid = ${issued.uid}`), /append-only/);
    await rejects(asOwner(sql`delete from issued_documents where uid = ${issued.uid}`), /append-only: delete refused/);
    await rejects(asOwner(sql`update document_blobs set content_type = 'text/plain'`), /append-only/);
    await rejects(asOwner(sql`delete from document_blobs`), /append-only/);
    await rejects(asOwner(sql`update document_events set by = 'someone'`), /append-only/);
    await rejects(asOwner(sql`delete from document_events`), /append-only/);
    await rejects(asOwner(sql`truncate document_events`), /append-only/);
    // Only `details` may change, through the request role too.
    await withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update issued_documents set details = details || '{"note":"more context"}'::jsonb where uid = ${issued.uid}`));
    assert.equal((await a.getIssuedDocument(issued.uid)).details.note, "more context");
  });

  test("the database refuses bytes that do not match their hash", async () => {
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`
      insert into document_blobs (sha256, byte_length, content_type, bytes, created_at)
      values (${"0".repeat(64)}, 3, 'application/pdf', '\\x616263'::bytea, now())`)), /document_blobs_sha256_check/);
  });

  test("bytes that are missing or corrupt are an error, never served", async () => {
    // A store whose get() returns other bytes: the service checks the row's hash itself.
    const real = createPostgresBlobStore();
    const lying = { ...real, get: async () => pdf("something else") };
    const service = createIssuedDocumentService({ db: t.db, orgUid: ORG_A, blobs: lying });
    const issued = await a.findIssuedDocument({ documentType: "quote", number: "EQ-2610-01 v1" });
    await assert.rejects(service.readIssuedDocument(issued.uid), (error) => error.name === "DocumentBytesError" && error.code === "DOCUMENT_BYTES_MISMATCH");
    const empty = createIssuedDocumentService({ db: t.db, orgUid: ORG_A, blobs: { ...real, get: async () => null } });
    await assert.rejects(empty.readIssuedDocument(issued.uid), (error) => error.code === "DOCUMENT_BYTES_MISSING");
    assert.equal(await a.readIssuedDocument("doc_not-a-uid"), null);
  });

  test("events without a document (a failed email) are listed apart, and their keys are idempotent", async () => {
    const event = { jobId: "job-1", documentType: "quote", event: "email_failed", at: ISSUED_AT, data: { outcome: "failed" }, idempotencyKey: "email_failed:att-1:failed" };
    assert.equal((await a.recordEvent(event)).created, true);
    assert.equal((await a.recordEvent(event)).created, false);
    const listed = await a.listJobDocuments("job-1");
    assert.deepEqual(listed.unattachedEvents.map((entry) => entry.event), ["email_failed"]);
  });

  test("every new table is a protected tenant table", async () => {
    const rows = await queryRows(sql`
      select c.relname as "table", c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             exists (select 1 from pg_policies p where p.tablename = c.relname and p.policyname = c.relname || '_tenant_isolation') as policy
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'field' and c.relname in ('document_blobs', 'issued_documents', 'document_events', 'document_number_counters')
      order by 1`, t.db);
    assert.deepEqual(rows.map((row) => [row.table, row.rls, row.forced, row.policy]), [
      ["document_blobs", true, true, true],
      ["document_events", true, true, true],
      ["document_number_counters", true, true, true],
      ["issued_documents", true, true, true],
    ]);
  });

  test("document_number_counters exists, per organisation, and is not used yet", async () => {
    await withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into document_number_counters (document_type, period, last_value, created_at, updated_at) values ('quote', '2610', 3, now(), now())`));
    await withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update document_number_counters set last_value = last_value + 1, updated_at = now() where document_type = 'quote' and period = '2610'`));
    const [row] = await withOrg(t.db, ORG_A, (tx) => queryRows(sql`select last_value from document_number_counters`, tx));
    assert.equal(row.last_value, 4);
    const other = await withOrg(t.db, ORG_B, (tx) => queryRows(sql`select * from document_number_counters`, tx));
    assert.deepEqual(other, []);
  });
});

describe("migration 0009 rollback", () => {
  const TAG = "0009_issued_documents";
  let before0009;
  let upTo0009;

  // Everything about the public schema a migration can change, as sorted text.
  async function schemaShape(db) {
    const parts = await Promise.all([
      queryRows(sql`select table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' default=' || coalesce(column_default, '') as x from information_schema.columns where table_schema = 'public'`, db),
      queryRows(sql`select c.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) as x from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`, db),
      queryRows(sql`select indexname || ' ' || indexdef as x from pg_indexes where schemaname = 'public'`, db),
      queryRows(sql`select relname || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r'`, db),
      queryRows(sql`select 'policy ' || tablename || '.' || policyname as x from pg_policies where schemaname = 'public'`, db),
      queryRows(sql`select 'function ' || p.proname as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`, db),
      queryRows(sql`select 'trigger ' || tgname as x from pg_trigger where not tgisinternal`, db),
    ]);
    return parts.flat().map((row) => row.x).sort();
  }

  // The migrations up to and including `last`: later ones (0010 onwards) have
  // their own rollbacks, which run before 0009's.
  function migrationsThrough(last, prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    for (const entry of journal.entries.filter((e) => e.idx > last)) rmSync(join(dir, `${entry.tag}.sql`));
    journal.entries = journal.entries.filter((entry) => entry.idx <= last);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  before(() => {
    // The database as it was before 0009, and as 0009 left it.
    before0009 = migrationsThrough(8, "field-before-0009-");
    upTo0009 = migrationsThrough(9, "field-upto-0009-");
  });
  after(() => {
    rmSync(before0009, { recursive: true, force: true });
    rmSync(upTo0009, { recursive: true, force: true });
  });

  test("the rollback script returns the schema to before 0009, and 0009 applies again", async () => {
    const client = new PGlite();
    const reference = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: upTo0009 });
      // 0009 leaves the tables in public. The service writes field.<table>.
      await withTablesInField(client, () => createIssuedDocumentService({ db, orgUid: ORG_A }).recordIssuedDocument(quoteInput()));
      await client.exec(`begin; ${readFileSync(join(MIGRATIONS_FOLDER, "..", "rollback", `${TAG}.down.sql`), "utf8")}; commit;`);
      await migrate(drizzle(reference, { schema }), { migrationsFolder: before0009 });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference, { schema })));
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const again = await createIssuedDocumentService({ db, orgUid: ORG_A }).recordIssuedDocument(quoteInput());
      assert.equal(again.created, true);
    } finally {
      await client.close();
      await reference.close();
    }
  });
});
