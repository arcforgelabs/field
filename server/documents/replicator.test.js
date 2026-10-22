// The R2 replicator's state machine (#12) on PGlite with an in-memory
// object store: replicate after commit, no-op when the same bytes are there,
// alarm (never overwrite) when other bytes are, back off and retry after an
// outage, backfill on the first tick, and the read fallback's hash check.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, before, after, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_FOLDER, createTestDb, queryRows, schema } from "../db-runtime/index.js";
import { withTablesInField } from "../test-support/move-tables.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { DocumentBytesError, createPostgresBlobStore, createReplicaFallbackBlobStore, sha256Hex } from "./blob-store.js";
import { createIssuedDocumentService } from "./issued-documents.js";
import { R2Error, objectKeyFor } from "./r2-client.js";
import { MISMATCH, backoffDelayMs, createDisabledReplicator, createDocumentReplicator } from "./replicator.js";

const ORG_A = DEFAULT_ORG_UID;
const ORG_B = "org_01TESTSECONDORGANISATION0";
const T0 = Date.parse("2026-10-12T01:00:00.000Z");

function pdf(text) {
  return Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);
}

// An S3 bucket in memory that, like a locked bucket, never replaces an object.
function memoryStore() {
  const objects = new Map();
  const calls = [];
  let down = null;
  const guard = (op) => {
    calls.push(op);
    if (down) throw new R2Error(`R2 ${op}: unreachable`, { code: down });
  };
  return {
    bucket: "memory-bucket",
    objects,
    calls,
    setDown(code) { down = code; },
    async head(key) {
      guard(`HEAD ${key}`);
      const object = objects.get(key);
      return object ? { size: object.bytes.length, sha256: object.meta ?? null, contentType: object.contentType } : null;
    },
    async get(key) {
      guard(`GET ${key}`);
      return objects.get(key)?.bytes ?? null;
    },
    async putIfAbsent(key, bytes, { contentType, sha256 }) {
      guard(`PUT ${key}`);
      if (objects.has(key)) return { created: false };
      objects.set(key, { bytes: Buffer.from(bytes), meta: sha256, contentType });
      return { created: true };
    },
    async checkBucket() {
      guard("LIST");
      return { ok: true };
    },
  };
}

function rejects(promise, pattern) {
  return assert.rejects(promise, (error) => {
    let message = "";
    for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
    assert.match(message, pattern);
    return true;
  });
}

function quiet() {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, error: log("error"), warn: log("warn"), log: log("log") };
}

describe("document replicator", () => {
  let t;
  let clock;
  let store;
  let logger;
  let replicator;
  let service;

  const now = () => new Date(clock);
  const issue = (number, text, svc = service) => svc.recordIssuedDocument({
    jobId: "job-r2",
    documentType: "invoice",
    number,
    revision: 1,
    pdfBytes: pdf(text),
    issuedAt: "2026-10-12T00:00:00.000Z",
    source: "live",
  });
  const rowsFor = (sha256, orgUid = ORG_A) => withOrg(t.db, orgUid, (tx) => queryRows(sql`select * from document_blob_replicas where sha256 = ${sha256}`, tx));

  before(async () => {
    t = await createTestDb();
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
  });
  after(() => t.close());

  beforeEach(async () => {
    // Each test starts with every earlier blob already replicated.
    clock = T0;
    store = memoryStore();
    logger = quiet();
    const sweeper = createDocumentReplicator({ db: t.db, orgUid: ORG_A, store, now, logger, batchSize: 1000, paceMs: 0 });
    await sweeper.tick();
    store = memoryStore();
    replicator = createDocumentReplicator({ db: t.db, orgUid: ORG_A, store, now, logger, paceMs: 0 });
    service = createIssuedDocumentService({ db: t.db, orgUid: ORG_A, now, blobs: createPostgresBlobStore({ now }), onBlobsStored: (shas) => replicator.notifyStored(shas) });
  });

  test("backoff: 1, 2, 4 ... minutes, at most an hour", () => {
    assert.deepEqual([1, 2, 3, 4, 7, 8, 50].map((n) => backoffDelayMs(n) / 60_000), [1, 2, 4, 8, 60, 60, 60]);
  });

  test("an issued document is copied after its transaction commits, at <org_uid>/<sha256>, and recorded", async () => {
    const { document } = await issue("EI-R2-1", "one");
    await replicator.idle();
    const key = objectKeyFor(ORG_A, document.pdfSha256);
    assert.deepEqual(store.objects.get(key).bytes, pdf("one"));
    assert.equal(store.objects.get(key).meta, document.pdfSha256);
    assert.equal(store.objects.get(key).contentType, "application/pdf");
    assert.deepEqual(store.calls, [`HEAD ${key}`, `PUT ${key}`]);
    const [row] = await rowsFor(document.pdfSha256);
    assert.equal(new Date(row.r2_replicated_at).getTime(), T0);
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, null);
    assert.deepEqual(replicator.publicStatus(), { state: "ok", pending: 0, oldestPendingAgeSeconds: 0, lastErrorCode: null });
  });

  test("again with the same bytes is a no-op: no second PUT, the record stands", async () => {
    const { document } = await issue("EI-R2-2", "two");
    await replicator.idle();
    store.calls.length = 0;
    assert.equal((await replicator.replicateBlob(document.pdfSha256)).outcome, "replicated-before");
    // The same number and bytes recorded again (a retried send) is a no-op too.
    await issue("EI-R2-2", "two");
    await replicator.idle();
    assert.deepEqual(store.calls, []);
    assert.equal((await rowsFor(document.pdfSha256))[0].attempts, 1);
  });

  test("an object already holding the same bytes counts as replicated without a PUT; without its hash it is read back", async () => {
    const plain = createIssuedDocumentService({ db: t.db, orgUid: ORG_A, now, blobs: createPostgresBlobStore({ now }) });
    const withMeta = await issue("EI-R2-3a", "three a", plain);
    const noMeta = await issue("EI-R2-3b", "three b", plain);
    const keyA = objectKeyFor(ORG_A, withMeta.document.pdfSha256);
    const keyB = objectKeyFor(ORG_A, noMeta.document.pdfSha256);
    store.objects.set(keyA, { bytes: pdf("three a"), meta: withMeta.document.pdfSha256 });
    store.objects.set(keyB, { bytes: pdf("three b"), meta: null });
    const results = await replicator.tick();
    assert.deepEqual(results.map((result) => result.outcome), ["already-present", "already-present"]);
    assert.deepEqual([...store.calls].sort(), [`HEAD ${keyA}`, `HEAD ${keyB}`, `GET ${keyB}`].sort());
    assert.ok((await rowsFor(noMeta.document.pdfSha256))[0].r2_replicated_at);
  });

  test("other bytes under the key raise the alarm and are never overwritten", async () => {
    const plain = createIssuedDocumentService({ db: t.db, orgUid: ORG_A, now, blobs: createPostgresBlobStore({ now }) });
    const { document } = await issue("EI-R2-4", "four", plain);
    const key = objectKeyFor(ORG_A, document.pdfSha256);
    const impostor = { bytes: pdf("not four"), meta: document.pdfSha256 };
    store.objects.set(key, impostor);
    const [result] = await replicator.tick();
    assert.equal(result.outcome, "mismatch");
    assert.equal(store.objects.get(key), impostor, "the object is left exactly as it was");
    assert.ok(!store.calls.some((call) => call.startsWith("PUT")), "no PUT is attempted");
    assert.ok(logger.lines.some((line) => line.startsWith("error") && line.includes("INTEGRITY ALARM") && line.includes(key)));
    const [row] = await rowsFor(document.pdfSha256);
    assert.equal(row.r2_replicated_at, null);
    assert.equal(row.last_error, MISMATCH);
    assert.equal(new Date(row.next_attempt_at).getTime() - T0, 60 * 60_000, "re-checked at most hourly");
    assert.deepEqual(replicator.publicStatus(), { state: "degraded", pending: 1, oldestPendingAgeSeconds: replicator.publicStatus().oldestPendingAgeSeconds, lastErrorCode: MISMATCH });
    assert.equal(replicator.status().mismatches, 1);
    // Still refused an hour later; the alarm stays until someone looks.
    clock += 60 * 60_000;
    assert.equal((await replicator.tick())[0].outcome, "mismatch");
    assert.equal((await rowsFor(document.pdfSha256))[0].attempts, 2);
    // Settle it so later tests start clean: the impostor goes, the right bytes land.
    store.objects.delete(key);
    clock += 60 * 60_000;
    assert.equal((await replicator.tick())[0].outcome, "replicated");
  });

  test("an outage: issuing still works, the replica is degraded, retries back off, then it catches up", async () => {
    store.setDown("R2_UNREACHABLE");
    const first = await issue("EI-R2-5a", "five a");
    const second = await issue("EI-R2-5b", "five b");
    await replicator.idle();
    assert.ok(first.created && second.created, "issuing does not wait on R2");
    assert.equal(replicator.publicStatus().state, "degraded");
    assert.equal(replicator.publicStatus().lastErrorCode, "R2_UNREACHABLE");
    assert.equal(replicator.publicStatus().pending, 2);
    const [row] = await rowsFor(first.document.pdfSha256);
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, "R2_UNREACHABLE");
    assert.equal(new Date(row.next_attempt_at).getTime() - T0, 60_000);

    // Not due yet: the tick asks R2 nothing.
    store.calls.length = 0;
    assert.deepEqual(await replicator.tick(), []);
    assert.deepEqual(store.calls, []);

    // Due and still down: one request, then the pass stops; the next delay doubles.
    clock += 60_000;
    const failed = await replicator.tick();
    assert.equal(failed.length, 1);
    assert.equal(store.calls.length, 1);
    const [again] = await rowsFor(failed[0].sha256);
    assert.equal(again.attempts, 2);
    assert.equal(new Date(again.next_attempt_at).getTime() - clock, 2 * 60_000);

    // R2 is back.
    store.setDown(null);
    clock += 2 * 60_000;
    const done = await replicator.tick();
    assert.deepEqual(done.map((result) => result.outcome), ["replicated", "replicated"]);
    assert.deepEqual(replicator.publicStatus(), { state: "ok", pending: 0, oldestPendingAgeSeconds: 0, lastErrorCode: null });
    assert.equal((await rowsFor(first.document.pdfSha256))[0].last_error, null);
  });

  test("the first tick backfills blobs stored before replication was on, oldest first, in batches", async () => {
    const plain = createIssuedDocumentService({ db: t.db, orgUid: ORG_A, now, blobs: createPostgresBlobStore({ now }) });
    const earlier = [];
    for (let i = 0; i < 3; i += 1) earlier.push((await issue(`EI-R2-6-${i}`, `six ${i}`, plain)).document.pdfSha256);
    const small = createDocumentReplicator({ db: t.db, orgUid: ORG_A, store, now, logger, batchSize: 2, paceMs: 0 });
    await small.refreshStatus();
    assert.equal(small.publicStatus().pending, 3);
    assert.equal((await small.tick()).length, 2);
    assert.equal(small.publicStatus().pending, 1);
    assert.equal((await small.tick()).length, 1);
    assert.equal(small.publicStatus().pending, 0);
    for (const sha of earlier) assert.ok(store.objects.has(objectKeyFor(ORG_A, sha)));
  });

  test("pending too long without an error is degraded too", async () => {
    const plain = createIssuedDocumentService({ db: t.db, orgUid: ORG_A, now, blobs: createPostgresBlobStore({ now }) });
    await issue("EI-R2-7", "seven", plain);
    await replicator.refreshStatus();
    assert.equal(replicator.publicStatus().state, "ok");
    clock += 61 * 60_000;
    assert.equal(replicator.publicStatus().state, "degraded");
    assert.ok(replicator.publicStatus().oldestPendingAgeSeconds > 3600);
    await replicator.tick();
    assert.equal(replicator.publicStatus().state, "ok");
  });

  test("one organisation's replicator never sees another's blobs; keys carry the organisation", async () => {
    const other = createIssuedDocumentService({ db: t.db, orgUid: ORG_B, now, blobs: createPostgresBlobStore({ now }) });
    const { document } = await issue("EI-R2-8", "eight", other);
    assert.deepEqual(await replicator.tick(), []);
    const theirs = createDocumentReplicator({ db: t.db, orgUid: ORG_B, store, now, logger, paceMs: 0 });
    const [theirResult] = await theirs.tick();
    assert.equal(theirResult?.outcome, "replicated", logger.lines.join("\n"));
    assert.ok(store.objects.has(`${ORG_B}/${document.pdfSha256}`));
    assert.deepEqual(await rowsFor(document.pdfSha256, ORG_A), []);
  });

  test("a replicated record is never changed or removed; nothing is ever deleted", async () => {
    const { document } = await issue("EI-R2-9", "nine");
    await replicator.idle();
    const sha = document.pdfSha256;
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update document_blob_replicas set r2_replicated_at = null where sha256 = ${sha}`)), /already replicated/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`delete from document_blob_replicas where sha256 = ${sha}`)), /delete refused|permission denied/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`truncate document_blob_replicas`)), /truncate refused|permission denied/);
    // Only stored blobs have a replica record, and the last error is a code, never a message.
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into document_blob_replicas (sha256, created_at, updated_at) values (${"f".repeat(64)}, now(), now())`)), /document_blob_replicas_blob_fk/);
    const plain = createIssuedDocumentService({ db: t.db, orgUid: ORG_A, now, blobs: createPostgresBlobStore({ now }) });
    const pending = await issue("EI-R2-9b", "nine b", plain);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into document_blob_replicas (sha256, last_error, created_at, updated_at) values (${pending.document.pdfSha256}, 'secret=abc 123', now(), now())`)), /document_blob_replicas_last_error_check/);
    await replicator.tick();
  });

  test("a failed issue transaction stores nothing and copies nothing", async () => {
    await issue("EI-R2-10", "ten");
    await replicator.idle();
    store.calls.length = 0;
    await assert.rejects(issue("EI-R2-10", "ten, changed"), { code: "ISSUED_DOCUMENT_CONFLICT" });
    await replicator.idle();
    assert.deepEqual(store.calls, []);
  });

  test("the boot check lists the bucket and records the outcome as a code", async () => {
    assert.deepEqual(await replicator.checkBucket(), { ok: true, at: new Date(T0).toISOString() });
    store.setDown("R2_ACCESS_DENIED");
    const failed = await replicator.checkBucket();
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "R2_ACCESS_DENIED");
    assert.equal(replicator.publicStatus().state, "degraded");
    assert.equal(replicator.status().bootCheck.code, "R2_ACCESS_DENIED");
    store.setDown(null);
    await replicator.checkBucket();
    assert.equal(replicator.publicStatus().state, "ok");
  });

  test("replication off is a no-op reporting state off", async () => {
    const off = createDisabledReplicator();
    assert.deepEqual(off.publicStatus(), { state: "off" });
    assert.deepEqual(await off.notifyStored(["a".repeat(64)]), []);
    assert.deepEqual(createDisabledReplicator({ state: "degraded", code: "NO_DATABASE" }).publicStatus(), { state: "degraded", lastErrorCode: "NO_DATABASE" });
  });
});

describe("read fallback to the R2 copy", () => {
  let t;
  before(async () => { t = await createTestDb(); });
  after(() => t.close());

  function primaryWith(behaviour) {
    const real = createPostgresBlobStore();
    return {
      kind: "postgres",
      put: real.put,
      async get(sha256, options) {
        if (behaviour === "missing") return null;
        if (behaviour === "corrupt") throw new DocumentBytesError(`stored bytes for ${sha256} do not match their hash`);
        return real.get(sha256, options);
      },
    };
  }

  test("PostgreSQL first; R2 only when PostgreSQL cannot give the bytes, and only bytes that match pdf_sha256", async () => {
    const store = memoryStore();
    const logger = quiet();
    const writer = createIssuedDocumentService({ db: t.db, orgUid: ORG_A });
    const { document } = await writer.recordIssuedDocument({
      jobId: "job-fb", documentType: "quote", number: "EQ-FB v1", quoteVersion: 1, pdfBytes: pdf("fallback"),
      issuedAt: "2026-10-12T00:00:00.000Z", source: "live",
    });
    const key = objectKeyFor(ORG_A, document.pdfSha256);
    const reader = (behaviour) => createIssuedDocumentService({
      db: t.db, orgUid: ORG_A, blobs: createReplicaFallbackBlobStore({ primary: primaryWith(behaviour), replica: store, logger }),
    });

    // PostgreSQL has them: R2 is not asked.
    assert.deepEqual((await reader("ok").readIssuedDocument(document.uid)).bytes, pdf("fallback"));
    assert.deepEqual(store.calls, []);

    // Missing in PostgreSQL and in R2: refused as missing (410 at the route).
    await assert.rejects(reader("missing").readIssuedDocument(document.uid), { code: "DOCUMENT_BYTES_MISSING" });

    // Missing in PostgreSQL, right bytes in R2: served from R2, logged.
    store.objects.set(key, { bytes: pdf("fallback"), meta: document.pdfSha256 });
    assert.deepEqual((await reader("missing").readIssuedDocument(document.uid)).bytes, pdf("fallback"));
    assert.deepEqual((await reader("corrupt").readIssuedDocument(document.uid)).bytes, pdf("fallback"));
    assert.ok(logger.lines.some((line) => line.includes("served") && line.includes("from R2")));

    // Wrong bytes in R2: never served.
    store.objects.set(key, { bytes: pdf("tampered"), meta: document.pdfSha256 });
    await assert.rejects(reader("missing").readIssuedDocument(document.uid), (error) => error instanceof DocumentBytesError && error.code === "DOCUMENT_BYTES_MISMATCH");
    assert.ok(logger.lines.some((line) => line.includes("INTEGRITY ALARM")));

    // R2 unreachable: the PostgreSQL error stands.
    store.setDown("R2_UNREACHABLE");
    await assert.rejects(reader("corrupt").readIssuedDocument(document.uid), { code: "DOCUMENT_BYTES_MISMATCH" });
    await assert.rejects(reader("missing").readIssuedDocument(document.uid), { code: "DOCUMENT_BYTES_MISSING" });
    assert.equal(sha256Hex(pdf("fallback")), document.pdfSha256);
  });
});

describe("migration 0012 rollback", () => {
  const TAG = "0012_document_replicas";

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

  // The migrations before 0012, or up to and including it.
  function migrationsUpTo(includeTag, prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const at = journal.entries.findIndex((entry) => entry.tag === TAG);
    const keep = journal.entries.slice(0, includeTag ? at + 1 : at);
    for (const entry of journal.entries.filter((e) => !keep.includes(e))) rmSync(join(dir, `${entry.tag}.sql`));
    journal.entries = keep;
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  test("the rollback script returns the schema to before 0012, and 0012 applies again", async () => {
    const before0012 = migrationsUpTo(false, "field-before-0012-");
    const upTo0012 = migrationsUpTo(true, "field-upto-0012-");
    const client = new PGlite();
    const reference = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: upTo0012 });
      const service = createIssuedDocumentService({ db, orgUid: ORG_A });
      const store = memoryStore();
      // 0012 leaves the tables in public. Today's service and replicator write field.<table>.
      const { document } = await withTablesInField(client, async () => {
        const recorded = await service.recordIssuedDocument({
          jobId: "job-rb", documentType: "quote", number: "EQ-RB v1", quoteVersion: 1, pdfBytes: pdf("rollback"),
          issuedAt: "2026-10-12T00:00:00.000Z", source: "live",
        });
        await createDocumentReplicator({ db, orgUid: ORG_A, store, logger: quiet(), paceMs: 0 }).tick();
        return recorded;
      });
      await client.exec(`begin; ${readFileSync(join(MIGRATIONS_FOLDER, "..", "rollback", `${TAG}.down.sql`), "utf8")}; commit;`);
      await migrate(drizzle(reference, { schema }), { migrationsFolder: before0012 });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference, { schema })));
      // Applied again: the object is found in R2 and recorded, with no write.
      await migrate(db, { migrationsFolder: upTo0012 });
      store.calls.length = 0;
      const [result] = await withTablesInField(client, () => createDocumentReplicator({ db, orgUid: ORG_A, store, logger: quiet(), paceMs: 0 }).tick());
      assert.equal(result.outcome, "already-present");
      assert.equal(result.sha256, document.pdfSha256);
      assert.ok(!store.calls.some((call) => call.startsWith("PUT")));
    } finally {
      await client.close();
      await reference.close();
      rmSync(before0012, { recursive: true, force: true });
      rmSync(upTo0012, { recursive: true, force: true });
    }
  });
});
