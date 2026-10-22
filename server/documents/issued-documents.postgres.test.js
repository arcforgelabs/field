// Issued documents on a real PostgreSQL server, migrated the way Replit runs
// it: by a login role that owns the tables, is not a superuser and cannot
// create roles, so row-level security holds through FORCE alone. Off unless
// FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1 is set
// (server/db-runtime/test-postgres.js).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { FIELD_SEARCH_PATH, migratePostgresDatabase, queryRows, schema } from "../db-runtime/index.js";
import { startTestPostgres, testPostgresMode } from "../db-runtime/test-postgres.js";
import { DEFAULT_ORG_UID, inspectRowSecurity, withOrg } from "../db-runtime/tenancy.js";
import { createIssuedDocumentService } from "./issued-documents.js";
import { createDocumentReplicator } from "./replicator.js";

// An object store in memory that never replaces an object (like a locked bucket).
function memoryStore() {
  const objects = new Map();
  return {
    bucket: "memory",
    objects,
    async head(key) { const o = objects.get(key); return o ? { size: o.bytes.length, sha256: o.sha256 } : null; },
    async get(key) { return objects.get(key)?.bytes ?? null; },
    async putIfAbsent(key, bytes, { sha256 }) { if (objects.has(key)) return { created: false }; objects.set(key, { bytes, sha256 }); return { created: true }; },
    async checkBucket() { return { ok: true }; },
  };
}
const quietLogger = { error() {}, warn() {}, log() {} };

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
  const client = postgres(url, { max: 3, onnotice: () => {}, connection: { TimeZone: "UTC", search_path: FIELD_SEARCH_PATH } });
  clients.push(client);
  return { client, db: drizzle(client, { schema }) };
}

test("as a table owner without CREATEROLE: isolation, immutability and bytes round-trip", { skip: !enabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL" }, async () => {
  const admin = connect(server.url).client;
  const suffix = randomBytes(4).toString("hex");
  const role = `owner_${suffix}`;
  const database = `field_docs_${suffix}`;
  await admin.unsafe(`create role ${role} login nosuperuser nobypassrls nocreaterole`);
  await admin.unsafe(`create database ${database} owner ${role}`);
  try {
    const url = new URL(server.url);
    url.username = role;
    url.pathname = `/${database}`;
    const { db } = connect(url.toString());
    await migratePostgresDatabase(db);
    const mode = await inspectRowSecurity(db);
    assert.equal(mode.enforced, true);
    await db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);

    const bytes = Buffer.from("%PDF-1.4\nreal postgres\n%%EOF\n");
    const a = createIssuedDocumentService({ db, orgUid: DEFAULT_ORG_UID });
    const b = createIssuedDocumentService({ db, orgUid: ORG_B });
    const { document } = await a.recordIssuedDocument({
      jobId: "job-pg", documentType: "invoice", number: "EI-PG-M1", revision: 1, pdfBytes: bytes,
      issuedAt: "2026-10-12T00:00:00.000Z", source: "live",
    });
    assert.deepEqual((await a.readIssuedDocument(document.uid)).bytes, bytes, "bytea round-trips as a Buffer");
    assert.equal(await b.readIssuedDocument(document.uid), null);
    const [seen] = await withOrg(db, ORG_B, (tx) => queryRows(sql`select count(*)::int as n from document_blobs`, tx));
    assert.equal(seen.n, 0);
    // The owner itself is filtered (FORCE) and cannot change what was issued (trigger).
    await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update issued_documents set number = 'X' where uid = ${document.uid}`)), /append-only/);
    await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`delete from document_events`)), /append-only/);
    await rejects(db.execute(sql`select count(*) from issued_documents`), /field\.org_uid is not set/);

    // The R2 replica's record (#12, migration 0012) holds the same way.
    const store = memoryStore();
    const replicator = createDocumentReplicator({ db, orgUid: DEFAULT_ORG_UID, store, logger: quietLogger, paceMs: 0 });
    assert.deepEqual((await replicator.tick()).map((result) => result.outcome), ["replicated"]);
    assert.ok(store.objects.has(`${DEFAULT_ORG_UID}/${document.pdfSha256}`));
    const [rowB] = await withOrg(db, ORG_B, (tx) => queryRows(sql`select count(*)::int as n from document_blob_replicas`, tx));
    assert.equal(rowB.n, 0);
    await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update document_blob_replicas set attempts = 9`)), /already replicated/);
    await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`delete from document_blob_replicas`)), /delete refused/);
  } finally {
    await admin.unsafe(`drop database if exists ${database} with (force)`);
    await admin.unsafe(`drop role if exists ${role}`);
  }
});

test("through SET ROLE field_app: the replica record is readable, insertable and updatable while pending, never deletable", { skip: !enabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL" }, async () => {
  const { db } = connect(server.url);
  await migratePostgresDatabase(db);
  const mode = await inspectRowSecurity(db);
  assert.equal(mode.via, "set-role");
  const service = createIssuedDocumentService({ db, orgUid: DEFAULT_ORG_UID });
  const { document } = await service.recordIssuedDocument({
    jobId: "job-pg-role", documentType: "quote", number: "EQ-PG-ROLE v1", quoteVersion: 1, pdfBytes: Buffer.from("%PDF-1.4\nfield_app\n%%EOF\n"),
    issuedAt: "2026-10-12T00:00:00.000Z", source: "live",
  });
  const store = memoryStore();
  let down = true;
  const flaky = { ...store, async head(key) { if (down) throw Object.assign(new Error("down"), { code: "R2_UNREACHABLE" }); return store.head(key); } };
  let clock = Date.parse("2026-10-12T01:00:00.000Z");
  const replicator = createDocumentReplicator({ db, orgUid: DEFAULT_ORG_UID, store: flaky, now: () => new Date(clock), logger: quietLogger, paceMs: 0 });
  assert.equal((await replicator.tick())[0].outcome, "failed", "pending: inserted with its error");
  down = false;
  clock += 60_000;
  assert.equal((await replicator.tick())[0].outcome, "replicated", "pending: updated to replicated");
  const [row] = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select attempts, last_error, r2_replicated_at from document_blob_replicas where sha256 = ${document.pdfSha256}`, tx));
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, null);
  await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`delete from document_blob_replicas`)), /permission denied|delete refused/);
});
