// The R2 replica (#240) against a real S3 server with a LOCKED bucket: a
// local MinIO container with object locking and a default COMPLIANCE
// retention (server/documents/test-minio.js), standing in for the production
// R2 bucket and its bucket lock. Off unless FIELD_R2_TEST_DOCKER=1.
// Never points at R2.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { AwsClient } from "aws4fetch";
import { sql } from "drizzle-orm";
import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { DocumentBytesError, createPostgresBlobStore, createReplicaFallbackBlobStore, sha256Hex } from "./blob-store.js";
import { createIssuedDocumentService } from "./issued-documents.js";
import { createR2ObjectStore, objectKeyFor } from "./r2-client.js";
import { MISMATCH, createDocumentReplicator } from "./replicator.js";
import { startTestMinio, testMinioEnabled } from "./test-minio.js";
import { verifyR2 } from "./verify-r2.js";

const ORG = DEFAULT_ORG_UID;
const skip = !testMinioEnabled() && "set FIELD_R2_TEST_DOCKER=1 (starts a local MinIO container)";

function pdf(text) {
  return Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);
}

function quiet() {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, error: log("error"), warn: log("warn"), log: log("log") };
}

async function deadPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("R2 replica against a locked MinIO bucket", { skip }, () => {
  let minio;
  let t;
  let raw;
  let store;
  let clock = Date.parse("2026-10-12T01:00:00.000Z");
  const now = () => new Date(clock);
  let number = 0;

  // Raw S3 calls the replicator never makes: list versions, plant an object,
  // try a delete (to show the lock is real).
  const url = (path) => `${minio.endpoint}/${minio.bucket}${path}`;
  async function versionsOf(key) {
    const res = await raw.fetch(url(`?versions&prefix=${encodeURIComponent(key)}`));
    const text = await res.text();
    return [...text.matchAll(/<VersionId>([^<]+)<\/VersionId>/g)].map((match) => match[1]);
  }

  async function issue(text, { replicate = false, replicator = null } = {}) {
    number += 1;
    const service = createIssuedDocumentService({
      db: t.db,
      orgUid: ORG,
      now,
      blobs: createPostgresBlobStore({ now }),
      ...(replicate ? { onBlobsStored: (shas) => replicator.notifyStored(shas) } : {}),
    });
    return service.recordIssuedDocument({
      jobId: "job-minio",
      documentType: "invoice",
      number: `EI-MINIO-${number}`,
      revision: 1,
      pdfBytes: pdf(text),
      issuedAt: "2026-10-12T00:00:00.000Z",
      source: "live",
    });
  }

  function replicatorWith(objectStore, logger = quiet()) {
    return { logger, replicator: createDocumentReplicator({ db: t.db, orgUid: ORG, store: objectStore, now, logger, paceMs: 0, batchSize: 100 }) };
  }

  before(async () => {
    minio = await startTestMinio();
    t = await createTestDb();
    raw = new AwsClient({ accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey, service: "s3", region: "auto", retries: 0 });
    store = createR2ObjectStore(minio);
  });
  after(async () => {
    await t?.close();
    await minio?.stop();
  });

  test("the bucket check passes; wrong credentials fail with a code and no credential in the message", async () => {
    assert.deepEqual(await store.checkBucket(), { ok: true });
    const wrong = createR2ObjectStore({ ...minio, secretAccessKey: "wrong-secret-value-0000" });
    await assert.rejects(wrong.checkBucket(), (error) => {
      assert.match(error.code, /^R2_(SIGNATURE_DOES_NOT_MATCH|ACCESS_DENIED)$/);
      assert.ok(!error.message.includes("wrong-secret-value") && !error.message.includes(minio.secretAccessKey) && !error.message.includes(minio.accessKeyId));
      return true;
    });
  });

  test("put once, at <org_uid>/<sha256> with its hash recorded; putting the same bytes again is a no-op", async () => {
    const { replicator } = replicatorWith(store);
    const { document } = await issue("put once", { replicate: true, replicator });
    await replicator.idle();
    const key = objectKeyFor(ORG, document.pdfSha256);
    assert.deepEqual(await store.get(key), pdf("put once"));
    assert.deepEqual(await store.head(key), { size: pdf("put once").length, sha256: document.pdfSha256, contentType: "application/pdf" });
    const versions = await versionsOf(key);
    assert.equal(versions.length, 1);

    // Again, from a replicator that has no record of it: HEAD finds it, no write.
    const fresh = createR2ObjectStore(minio);
    assert.deepEqual(await fresh.putIfAbsent(key, pdf("put once"), { sha256: document.pdfSha256 }), { created: false });
    const { replicator: second } = replicatorWith(fresh);
    assert.equal((await second.replicateBlob(document.pdfSha256)).outcome, "replicated-before");
    assert.deepEqual(await versionsOf(key), versions, "no new object version was written");
  });

  test("other bytes under the key: integrity alarm, never overwritten; the lock refuses a delete too", async () => {
    // A document stored but not yet replicated, and an impostor already at its key.
    const { document } = await issue("the real bytes");
    const key = objectKeyFor(ORG, document.pdfSha256);
    const impostor = pdf("an impostor");
    const planted = await raw.fetch(url(`/${key}`), {
      method: "PUT",
      body: impostor,
      headers: { "Content-MD5": (await import("node:crypto")).createHash("md5").update(impostor).digest("base64"), "x-amz-meta-sha256": document.pdfSha256 },
    });
    assert.equal(planted.status, 200);
    const versions = await versionsOf(key);

    const { replicator, logger } = replicatorWith(store);
    const results = await replicator.tick();
    assert.equal(results.find((result) => result.sha256 === document.pdfSha256).outcome, "mismatch");
    assert.deepEqual(await store.get(key), impostor, "the object is untouched");
    assert.deepEqual(await versionsOf(key), versions, "no new version: nothing was written");
    assert.ok(logger.lines.some((line) => line.includes("INTEGRITY ALARM") && line.includes(key)));
    assert.equal(replicator.publicStatus().state, "degraded");
    assert.equal(replicator.publicStatus().lastErrorCode, MISMATCH);
    const [row] = await withOrg(t.db, ORG, (tx) => queryRows(sql`select r2_replicated_at, last_error from document_blob_replicas where sha256 = ${document.pdfSha256}`, tx));
    assert.equal(row.r2_replicated_at, null);
    assert.equal(row.last_error, MISMATCH);

    // The bucket really is locked (COMPLIANCE retention): even its owner cannot delete the version.
    const deleted = await raw.fetch(url(`/${key}?versionId=${encodeURIComponent(versions[0])}`), { method: "DELETE" });
    assert.notEqual(deleted.status, 204);
    assert.deepEqual(await versionsOf(key), versions);
  });

  test("read fallback: bytes from the bucket are served only when they hash to pdf_sha256", async () => {
    const { replicator } = replicatorWith(store);
    const { document } = await issue("fallback bytes", { replicate: true, replicator });
    await replicator.idle();
    const missingInPostgres = { kind: "postgres", put: createPostgresBlobStore().put, get: async () => null };
    const logger = quiet();
    const reader = createIssuedDocumentService({ db: t.db, orgUid: ORG, blobs: createReplicaFallbackBlobStore({ primary: missingInPostgres, replica: store, logger }) });
    const read = await reader.readIssuedDocument(document.uid);
    assert.deepEqual(read.bytes, pdf("fallback bytes"));
    assert.equal(sha256Hex(read.bytes), document.pdfSha256);

    // The impostor from the alarm test is in the bucket under the real hash: never served.
    const [impostorRow] = await withOrg(t.db, ORG, (tx) => queryRows(sql`select d.uid from issued_documents d join document_blob_replicas r on r.sha256 = d.pdf_sha256 where r.last_error = ${MISMATCH}`, tx));
    await assert.rejects(reader.readIssuedDocument(impostorRow.uid), (error) => error instanceof DocumentBytesError && error.code === "DOCUMENT_BYTES_MISMATCH");
    assert.ok(logger.lines.some((line) => line.includes("INTEGRITY ALARM")));
  });

  test("the scheduler retries after an outage, with backoff, then catches up", async () => {
    const down = createR2ObjectStore({ ...minio, endpoint: `http://127.0.0.1:${await deadPort()}`, timeoutMs: 2_000 });
    let target = down;
    const switching = {
      bucket: minio.bucket,
      head: (key) => target.head(key),
      get: (key) => target.get(key),
      putIfAbsent: (key, bytes, options) => target.putIfAbsent(key, bytes, options),
      checkBucket: () => target.checkBucket(),
    };
    const { replicator } = replicatorWith(switching);
    const boot = await replicator.checkBucket();
    assert.equal(boot.ok, false);
    assert.equal(boot.code, "R2_UNREACHABLE");

    const { document, created } = await issue("during the outage", { replicate: true, replicator });
    await replicator.idle();
    assert.equal(created, true, "issuing does not wait on R2");
    assert.equal(replicator.publicStatus().state, "degraded");
    assert.equal(replicator.publicStatus().lastErrorCode, "R2_UNREACHABLE");
    const [row] = await withOrg(t.db, ORG, (tx) => queryRows(sql`select attempts, last_error, next_attempt_at from document_blob_replicas where sha256 = ${document.pdfSha256}`, tx));
    assert.equal(row.attempts, 1);
    assert.equal(new Date(row.next_attempt_at).getTime() - clock, 60_000);

    // R2 comes back; nothing is retried before the backoff is due.
    target = store;
    assert.ok(!(await replicator.tick()).some((result) => result.sha256 === document.pdfSha256));
    clock += 60_000;
    const retried = await replicator.tick();
    assert.equal(retried.find((result) => result.sha256 === document.pdfSha256)?.outcome, "replicated");
    assert.deepEqual(await store.get(objectKeyFor(ORG, document.pdfSha256)), pdf("during the outage"));
    const [after] = await withOrg(t.db, ORG, (tx) => queryRows(sql`select attempts, last_error, r2_replicated_at from document_blob_replicas where sha256 = ${document.pdfSha256}`, tx));
    assert.equal(after.attempts, 2);
    assert.equal(after.last_error, null);
    assert.ok(after.r2_replicated_at);
  });

  test("a clock far from the server's is corrected from its Date header (the proof's frozen clock)", async () => {
    const frozen = createR2ObjectStore({ ...minio, now: () => Date.parse("2026-01-15T12:00:00.000Z") });
    assert.deepEqual(await frozen.checkBucket(), { ok: true });
  });

  test("verify-r2 reports missing and mismatched objects, and nothing else", async () => {
    // Settle everything first: only the alarm's impostor stays wrong.
    const { replicator } = replicatorWith(store);
    clock += 2 * 60 * 60_000;
    await replicator.tick();
    const missing = await issue("never replicated");
    const before = await verifyR2({ db: t.db, orgUid: ORG, store });
    assert.equal(before.ok, false);
    assert.deepEqual(before.missing.map((entry) => entry.sha256), [missing.document.pdfSha256]);
    assert.equal(before.missing[0].documents[0].number, missing.document.number);
    assert.equal(before.missing[0].recordedReplicated, false);
    assert.equal(before.mismatched.length, 1);
    assert.equal(before.mismatched[0].objectSha256, sha256Hex(pdf("an impostor")));
    assert.deepEqual(before.errors, []);
    assert.equal(before.present, before.blobs - 2);
    // Read-only: verifying wrote nothing.
    assert.equal(await store.head(objectKeyFor(ORG, missing.document.pdfSha256)), null);
    await replicator.tick();
    const afterReplication = await verifyR2({ db: t.db, orgUid: ORG, store });
    assert.deepEqual(afterReplication.missing, []);
    assert.equal(afterReplication.mismatched.length, 1);
  });
});
