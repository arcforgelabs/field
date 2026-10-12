// The invoice issue service (#28, step 4b): INV-YYYY-MM-N numbers from
// document_number_counters, allocated in the issue transaction with no gaps
// and never reused; the PDF rendered once and stored with its issued
// document and `issued` event; the invoice row frozen with its job
// reference; and a retried issue returning the same invoice.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { claimLineName, claimMoney } from "./from-milestones.js";
import { createInvoiceRowService } from "./invoice-rows.js";
import {
  createInvoiceIssueService,
  createUnavailableInvoiceIssuer,
  invoiceIssueKey,
  invoiceIssuer,
  invoicePeriod,
  isSequenceInvoiceNumber,
} from "./issue.js";

const ORG_A = DEFAULT_ORG_UID;
const ORG_B = "org_01TESTSECONDORGANISATION0";

function rejects(promise, pattern) {
  return assert.rejects(promise, (error) => {
    let message = "";
    for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
    assert.match(message, pattern);
    return true;
  });
}

function claimInvoice({ subtotal = "400.00", gst = "40.00", total = "440.00", milestoneIndex = 0 } = {}) {
  const money = claimMoney({
    subtotal,
    gst,
    total,
    taxRate: "10.000",
    milestoneKey: String(milestoneIndex),
    name: claimLineName({ label: "Deposit", percent: "50.000", quoteReference: "EQ-2610-03 v2" }),
    description: `Milestone ${milestoneIndex + 1} of 2`,
  });
  return {
    milestoneKey: String(milestoneIndex),
    kind: "deposit",
    revision: 1,
    currency: "AUD",
    quoteVersion: 2,
    quoteVersionInferred: false,
    ...money.totals,
    taxTotalSource: money.taxTotalSource,
    taxTotalReason: money.taxTotalReason,
    lines: money.lines,
    dueOn: null,
    note: null,
  };
}

function pdfFor(number) {
  return Buffer.from(`%PDF-1.4\nTax invoice ${number}\n%%EOF\n`);
}

describe("invoice issue service", () => {
  let t;
  let a;
  let b;
  const renders = [];

  function issue(service, overrides = {}) {
    const { key = `key-${renders.length}-${Math.random()}`, issuedAt = "2026-10-12T02:00:00.000Z", ...rest } = overrides;
    return service.issueInvoice({
      jobId: "job-issue",
      idempotencyKey: key,
      reference: "2610-03",
      issuedAt,
      issuedBy: "user-1",
      invoice: claimInvoice(),
      details: { milestoneIndex: 0 },
      render: async (number) => {
        renders.push(number);
        return pdfFor(number);
      },
      ...rest,
    });
  }

  async function counter(orgUid, period) {
    const [row] = await withOrg(t.db, orgUid, (tx) => queryRows(sql`select last_value from document_number_counters where document_type = 'invoice' and period = ${period}`, tx));
    return row ? Number(row.last_value) : 0;
  }

  before(async () => {
    t = await createTestDb();
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    a = createInvoiceIssueService({ db: t.db, orgUid: ORG_A });
    b = createInvoiceIssueService({ db: t.db, orgUid: ORG_B });
  });
  after(async () => {
    await t.close();
  });

  test("numbers are INV-YYYY-MM-N from the issue time's month, in order, per organisation", async () => {
    const period = invoicePeriod(new Date("2026-10-12T02:00:00.000Z"));
    const first = await issue(a);
    const second = await issue(a);
    assert.equal(first.number, `INV-${period}-1`);
    assert.equal(second.number, `INV-${period}-2`);
    assert.equal(first.replayed, false);
    assert.ok(isSequenceInvoiceNumber(first.number));
    assert.equal((await issue(b)).number, `INV-${period}-1`, "another organisation has its own sequence");
    // A new month starts again at 1.
    const nextMonth = new Date(2026, 10, 3, 9, 0, 0).toISOString();
    assert.equal((await issue(a, { issuedAt: nextMonth })).number, `INV-${invoicePeriod(nextMonth)}-1`);
    assert.equal((await issue(a)).number, `INV-${period}-3`);
  });

  test("the PDF is rendered once with the number, stored, and recorded as issued with the frozen row", async () => {
    const result = await issue(a, { key: "frozen-row" });
    assert.equal(renders.at(-1), result.number);
    assert.deepEqual(result.pdfBytes, pdfFor(result.number));
    const documents = createIssuedDocumentService({ db: t.db, orgUid: ORG_A });
    const stored = await documents.readIssuedDocument(result.issuedDocumentUid);
    assert.equal(stored.document.number, result.number);
    assert.equal(stored.document.documentType, "invoice");
    assert.equal(stored.document.source, "live");
    assert.equal(stored.document.details.reference, "2610-03");
    assert.deepEqual(stored.bytes, result.pdfBytes);
    const listed = await documents.listJobDocuments("job-issue");
    const entry = listed.documents.find((document) => document.uid === result.issuedDocumentUid);
    assert.deepEqual(entry.events.map((event) => event.event), ["issued"]);
    assert.equal(entry.events[0].data.issueKey, "frozen-row");

    const rows = await createInvoiceRowService({ db: t.db, orgUid: ORG_A }).readJob("job-issue");
    const row = rows.invoices.find((invoice) => invoice.uid === result.invoiceUid);
    assert.equal(row.number, result.number);
    assert.equal(row.status, "issued");
    assert.equal(row.reference, "2610-03");
    assert.equal(row.issuedDocumentUid, result.issuedDocumentUid);
    assert.deepEqual([row.subtotal, row.taxTotal, row.total], ["400.00", "40.00", "440.00"]);
    assert.deepEqual(row.lines.map((line) => [line.lineType, line.name, line.lineTotal]), [["claim", "Deposit, 50 % of EQ-2610-03 v2", "400.00"]]);

    // Issued never changes: not its key, not its number.
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update invoices set issue_key = 'other' where uid = ${result.invoiceUid}`)), /was issued: change refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update invoices set number = 'INV-2026-10-99' where uid = ${result.invoiceUid}`)), /was issued: change refused/);
  });

  test("a retried issue with the same key returns the same invoice, number and bytes, and allocates nothing", async () => {
    const period = invoicePeriod(new Date("2026-10-12T02:00:00.000Z"));
    const first = await issue(a, { key: "retry-me" });
    const before = await counter(ORG_A, period);
    const rendered = renders.length;
    const again = await issue(a, { key: "retry-me", issuedAt: "2026-10-13T05:00:00.000Z" });
    assert.equal(again.replayed, true);
    assert.equal(again.number, first.number);
    assert.equal(again.invoiceUid, first.invoiceUid);
    assert.equal(again.issuedDocumentUid, first.issuedDocumentUid);
    assert.equal(again.issuedAt, first.issuedAt, "the issue time is the first issue's");
    assert.deepEqual(again.pdfBytes, first.pdfBytes);
    assert.equal(renders.length, rendered, "not rendered again");
    assert.equal(await counter(ORG_A, period), before);
  });

  test("a failed issue rolls its number back: the sequence has no gaps", async () => {
    const period = invoicePeriod(new Date("2026-10-12T02:00:00.000Z"));
    const before = await counter(ORG_A, period);
    await rejects(issue(a, { render: async () => { throw new Error("renderer crashed"); } }), /renderer crashed/);
    await rejects(issue(a, { reference: "  " }), /job number as its reference/);
    assert.equal(await counter(ORG_A, period), before);
    assert.equal((await issue(a)).number, `INV-${period}-${before + 1}`);
  });

  test("issues racing each other get distinct numbers, one after another", async () => {
    const period = invoicePeriod(new Date("2026-10-12T02:00:00.000Z"));
    const before = await counter(ORG_A, period);
    const results = await Promise.all(Array.from({ length: 5 }, () => issue(a)));
    const values = results.map((result) => Number(result.number.split("-").at(-1))).sort((x, y) => x - y);
    assert.deepEqual(values, [1, 2, 3, 4, 5].map((n) => before + n));
  });

  test("the database refuses a sequence-numbered invoice without its reference or with a malformed number", async () => {
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into invoices (uid, job_id, number, kind, status, subtotal, tax_total, total, issued_at, issue_key, created_at, updated_at)
      values ('inv_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'job-x', 'INV-2026-10-77', 'deposit', 'issued', 1, 0, 1, now(), 'no-reference', now(), now())`)), /invoices_issue_check/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into invoices (uid, job_id, number, kind, status, subtotal, tax_total, total, issued_at, issue_key, reference, created_at, updated_at)
      values ('inv_01ARZ3NDEKTSV4RRFFQ69G5FAW', 'job-x', 'EI-2610-03-M1', 'deposit', 'issued', 1, 0, 1, now(), 'bad-number', '2610-03', now(), now())`)), /invoices_issue_check/);
  });

  test("the issue key names the job, milestone, revision and money", () => {
    const key = invoiceIssueKey({ jobId: "job-1", milestoneIndex: 0, revisionNumber: 1, fingerprint: "{\"total\":440}" });
    assert.match(key, /^invoice:job-1:m0:r1:[0-9a-f]{16}$/);
    assert.equal(key, invoiceIssueKey({ jobId: "job-1", milestoneIndex: 0, revisionNumber: 1, fingerprint: "{\"total\":440}" }));
    assert.notEqual(key, invoiceIssueKey({ jobId: "job-1", milestoneIndex: 0, revisionNumber: 1, fingerprint: "{\"total\":441}" }));
  });

  test("without an issuer, or on a server with no database, issuing is refused", async () => {
    await rejects(invoiceIssuer().issueInvoice({}), /invoices are issued in PostgreSQL, and no invoice issuer is installed/);
    const refused = createUnavailableInvoiceIssuer("this server has no database");
    assert.equal(refused.enabled, false);
    await assert.rejects(refused.issueInvoice({}), (error) => error.code === "INVOICE_ISSUE_UNAVAILABLE" && error.statusCode === 503);
  });

  test("the period is the issue time's month in local time", () => {
    assert.equal(invoicePeriod(new Date(2026, 9, 31, 23, 59)), "2026-10");
    assert.equal(invoicePeriod(new Date(2026, 10, 1, 0, 1)), "2026-11");
    assert.equal(isSequenceInvoiceNumber("EI-2610-03-M1"), false);
    assert.equal(isSequenceInvoiceNumber("INV-2026-10-0"), false);
  });
});
