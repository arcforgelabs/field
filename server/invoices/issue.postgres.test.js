// The invoice issue service (#28) on a real PostgreSQL server, migrated the
// way Replit runs it: by a login role that owns the tables, is not a
// superuser and cannot create roles, so row-level security holds through
// FORCE alone. Issues racing on separate connections take the organisation's
// issue lock in turn: numbers are 1..n with no gap and no repeat, a failed
// issue in the middle leaves no gap, and another organisation has its own
// sequence. Off unless FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1 is
// set (server/db-runtime/test-postgres.js).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migratePostgresDatabase, queryRows, schema } from "../db-runtime/index.js";
import { startTestPostgres, testPostgresMode } from "../db-runtime/test-postgres.js";
import { DEFAULT_ORG_UID, inspectRowSecurity, withOrg } from "../db-runtime/tenancy.js";
import { claimLineName, claimMoney } from "./from-milestones.js";
import { createInvoiceIssueService, invoicePeriod } from "./issue.js";

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

function connect(url, max = 3) {
  const client = postgres(url, { max, onnotice: () => {}, connection: { TimeZone: "UTC" } });
  clients.push(client);
  return { client, db: drizzle(client, { schema }) };
}

function invoice() {
  const money = claimMoney({ subtotal: "100.00", gst: "10.00", total: "110.00", taxRate: "10.000", milestoneKey: "0", name: claimLineName({ label: "Deposit", percent: "10.000", quoteReference: "EQ-2610-09 v1" }), description: "Milestone 1 of 2" });
  return { milestoneKey: "0", kind: "deposit", revision: 1, currency: "AUD", quoteVersion: 1, ...money.totals, taxTotalSource: money.taxTotalSource, taxTotalReason: money.taxTotalReason, lines: money.lines };
}

test("through SET ROLE field_app: the issue allocates, stores and writes with the grants requests have", { skip: !enabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL" }, async () => {
  const { db } = connect(server.url);
  await migratePostgresDatabase(db);
  assert.equal((await inspectRowSecurity(db)).via, "set-role");
  const service = createInvoiceIssueService({ db, orgUid: DEFAULT_ORG_UID });
  const first = await service.issueInvoice({ jobId: "job-app", idempotencyKey: "app-1", reference: "2610-10", issuedAt: "2026-10-12T02:00:00.000Z", invoice: invoice(), render: async (number) => Buffer.from(`%PDF-1.4\n${number}\n%%EOF\n`) });
  assert.match(first.number, /^INV-\d{4}-\d{2}-1$/);
  const replay = await service.issueInvoice({ jobId: "job-app", idempotencyKey: "app-1", reference: "2610-10", issuedAt: "2026-10-12T02:00:00.000Z", invoice: invoice(), render: async () => { throw new Error("not rendered again"); } });
  assert.equal(replay.number, first.number);
});

test("as a table owner without CREATEROLE: concurrent issues are numbered 1..n, a failed one leaves no gap, organisations do not share a sequence", { skip: !enabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL" }, async () => {
  const admin = connect(server.url).client;
  const suffix = randomBytes(4).toString("hex");
  const role = `owner_${suffix}`;
  const database = `field_issue_${suffix}`;
  await admin.unsafe(`create role ${role} login nosuperuser nobypassrls nocreaterole`);
  await admin.unsafe(`create database ${database} owner ${role}`);
  try {
    const url = new URL(server.url);
    url.username = role;
    url.pathname = `/${database}`;
    const { db } = connect(url.toString(), 6);
    await migratePostgresDatabase(db);
    assert.equal((await inspectRowSecurity(db)).enforced, true);
    await db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    const a = createInvoiceIssueService({ db, orgUid: DEFAULT_ORG_UID });
    const b = createInvoiceIssueService({ db, orgUid: ORG_B });
    const issuedAt = "2026-10-12T02:00:00.000Z";
    const period = invoicePeriod(issuedAt);
    const issue = (service, index, render = async (number) => Buffer.from(`%PDF-1.4\n${number}\n%%EOF\n`)) => service.issueInvoice({
      jobId: `job-${index}`,
      idempotencyKey: `race-${index}`,
      reference: "2610-09",
      issuedAt,
      invoice: invoice(),
      // Slow enough that the issues overlap on their connections.
      render: async (number) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return render(number);
      },
    });

    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => (index === 4
      ? issue(a, index, async () => { throw new Error("renderer crashed"); })
      : issue(a, index))));
    const numbers = results.filter((result) => result.status === "fulfilled").map((result) => result.value.number);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.deepEqual(numbers.map((number) => Number(number.split("-").at(-1))).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(numbers.every((number) => number.startsWith(`INV-${period}-`)));
    assert.equal((await issue(b, 99)).number, `INV-${period}-1`);

    // The same key again, on another connection, returns the first answer.
    const again = await issue(a, 0);
    assert.equal(again.replayed, true);
    assert.equal(again.number, results[0].value.number);

    const [counts] = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select (select count(*) from invoices where issue_key is not null)::int as invoices, (select last_value from document_number_counters where document_type = 'invoice' and period = ${period}) as last`, tx));
    assert.deepEqual(counts, { invoices: 9, last: 9 });
    const [other] = await withOrg(db, ORG_B, (tx) => queryRows(sql`select count(*)::int as n from invoices`, tx));
    assert.equal(other.n, 1, "organisation B sees only its own invoice");
  } finally {
    await admin.unsafe(`drop database if exists ${database} with (force)`);
    await admin.unsafe(`drop role if exists ${role}`);
  }
});
