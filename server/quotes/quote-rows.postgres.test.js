// Quote rows on a real PostgreSQL server (#6), migrated the way Replit runs
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
import { mapQuoteArtifact } from "./from-artifact.js";
import { createQuoteRowService } from "./quote-rows.js";
import { FIXTURE_META, HALF_CENT_PRINTED, floatRoundedLineQuote, halfCentGstQuote, sectionedQuote } from "./test-fixtures.js";

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

test("as a table owner without CREATEROLE: rows round-trip, other organisations see nothing, sent quotes never change", { skip: !enabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL" }, async () => {
  const admin = connect(server.url).client;
  const suffix = randomBytes(4).toString("hex");
  const role = `owner_${suffix}`;
  const database = `field_quotes_${suffix}`;
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

    const a = createQuoteRowService({ db, orgUid: DEFAULT_ORG_UID });
    const b = createQuoteRowService({ db, orgUid: ORG_B });
    const mapped = mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META });
    const { quote } = await a.writeVersion({ jobId: "job-pg", version: 1, mapped, status: "sent", sentAt: "2026-10-12T00:00:00.000Z", sourceDigest: "pg" });
    assert.deepEqual([quote.status, quote.subtotal, quote.taxTotal, quote.total], ["sent", "1851.00", "185.10", "2036.10"]);
    const read = await a.getQuoteVersion("job-pg", 1);
    assert.equal(read.lines.length, mapped.lines.length);
    assert.deepEqual(read.lines.map((line) => line.lineTotal), mapped.lines.map((line) => line.lineTotal), "numeric(12,2) comes back as the same strings");
    assert.deepEqual(read.lines.map((line) => line.quantity), mapped.lines.map((line) => line.quantity));

    // Four-decimal rates, a line total kept as printed, GST as printed.
    const float = await a.writeVersion({ jobId: "job-pg", version: 2, mapped: mapQuoteArtifact({ quote: floatRoundedLineQuote(), meta: FIXTURE_META }) });
    assert.deepEqual([float.quote.subtotal, float.quote.taxTotal], ["3.01", "0.30"]);
    const [floatLine] = (await a.getQuoteVersion("job-pg", 2)).lines;
    assert.deepEqual([floatLine.unitSell, floatLine.lineTotal, floatLine.lineTotalSource], ["1.0050", "3.01", "printed"]);
    const half = await a.writeVersion({ jobId: "job-pg", version: 3, mapped: mapQuoteArtifact({ quote: halfCentGstQuote(), meta: FIXTURE_META, printed: HALF_CENT_PRINTED }) });
    assert.deepEqual([half.quote.taxTotal, half.quote.taxTotalSource], ["2.11", "printed"]);
    const [{ uid: v2 }] = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select uid from quotes where job_id = 'job-pg' and version = 2`, tx));
    await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`insert into quote_lines (uid, quote_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, created_at)
      values ('qln_01JVVVVVVVVVVVVVVVVVVVVVVV', ${v2}, 5, 'custom', 'Wrong', 3, 'm', 1.005, 'GST', 10, 3.01, now())`)), /quote_lines_line_total_check/);

    assert.deepEqual(await b.listJobQuotes("job-pg"), []);
    const [seen] = await withOrg(db, ORG_B, (tx) => queryRows(sql`select (select count(*) from quotes)::int as q, (select count(*) from quote_lines)::int as l`, tx));
    assert.deepEqual(seen, { q: 0, l: 0 });
    // The owner itself is filtered (FORCE) and cannot change a sent quote (trigger).
    await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update quote_lines set unit_sell = 1`)), /was sent/);
    await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update quotes set total = 0, subtotal = 0, tax_total = 0`)), /was sent/);
    await rejects(withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`delete from quotes`)), /was sent/);
    await rejects(db.execute(sql`truncate quote_lines`), /cannot be truncated/);
    await rejects(db.execute(sql`select count(*) from quotes`), /field\.org_uid is not set/);
  } finally {
    await admin.unsafe(`drop database if exists ${database} with (force)`);
    await admin.unsafe(`drop role if exists ${role}`);
  }
});
