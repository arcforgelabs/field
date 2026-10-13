// The invoice issue service (#28, step 4b): INV-YYYY-M-N numbers from
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
import { createBusinessSettingsService } from "./business-settings.js";
import {
  createInvoiceIssueService,
  createUnavailableInvoiceIssuer,
  formatCreditNoteNumber,
  formatInvoiceNumber,
  formatReceiptNumber,
  invoiceIssueKey,
  receiptIssueKey,
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
    const { key = `key-${renders.length}-${Math.random()}`, issuedAt = "2026-10-12T02:00:00.000Z", jobId = "job-issue", ...rest } = overrides;
    return service.issueInvoice({
      jobId,
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

  async function counterOf(documentType, period, orgUid = ORG_A) {
    const [row] = await withOrg(t.db, orgUid, (tx) => queryRows(sql`select last_value from document_number_counters where document_type = ${documentType} and period = ${period}`, tx));
    return row ? Number(row.last_value) : 0;
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

  test("numbers are INV-YYYY-M-N from the issue time's month, in order, per organisation", async () => {
    const period = invoicePeriod(new Date("2026-10-12T02:00:00.000Z"));
    const first = await issue(a);
    const second = await issue(a);
    assert.equal(first.number, formatInvoiceNumber(period, 1));
    assert.equal(second.number, formatInvoiceNumber(period, 2));
    assert.equal(first.replayed, false);
    assert.ok(isSequenceInvoiceNumber(first.number));
    assert.equal((await issue(b)).number, formatInvoiceNumber(period, 1), "another organisation has its own sequence");
    // A new month starts again at 1.
    const nextMonth = new Date(2026, 10, 3, 9, 0, 0).toISOString();
    assert.equal((await issue(a, { issuedAt: nextMonth })).number, formatInvoiceNumber(invoicePeriod(nextMonth), 1));
    assert.equal((await issue(a)).number, formatInvoiceNumber(period, 3));
  });

  test("the issue works out the reference line once: rendered into the PDF and stored with the document (#93)", async () => {
    const seen = [];
    const result = await issue(a, { key: "reference-line", render: async (number, options) => { seen.push(options?.referenceLine ?? null); return pdfFor(number); }, quoteNumber: "EQ-2610-03" });
    assert.deepEqual(seen, ["Job 2610-03 · Quote EQ-2610-03 v2"], "no quote row: the files' number");
    assert.equal(result.referenceLine, "Job 2610-03 · Quote EQ-2610-03 v2");
    const [document] = await withOrg(t.db, ORG_A, (tx) => queryRows(sql`select details from issued_documents where uid = ${result.issuedDocumentUid}`, tx));
    assert.equal(document.details.referenceLine, "Job 2610-03 · Quote EQ-2610-03 v2");
    const replay = await issue(a, { key: "reference-line", render: async () => { throw new Error("not rendered again"); } });
    assert.equal(replay.referenceLine, "Job 2610-03 · Quote EQ-2610-03 v2", "a retry returns what was issued");
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
    assert.equal((await issue(a)).number, formatInvoiceNumber(period, before + 1));
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
    // The month is not zero-padded (owner's decision, 2026-10-13).
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into invoices (uid, job_id, number, kind, status, subtotal, tax_total, total, issued_at, issue_key, reference, created_at, updated_at)
      values ('inv_01ARZ3NDEKTSV4RRFFQ69G5FAX', 'job-x', 'INV-2026-01-5', 'deposit', 'issued', 1, 0, 1, now(), 'padded', '2610-03', now(), now())`)), /invoices_issue_check/);
  });

  test("credit and reissue: a credit note from its own sequence credits the invoice in full, the replacement is issued, payments move, all in one go", async () => {
    const period = invoicePeriod(new Date("2026-10-12T02:00:00.000Z"));
    const original = await issue(a, { key: "to-credit", jobId: "job-credit" });
    await withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into payments (uid, job_id, invoice_uid, amount, paid_on, recorded_at, created_at, updated_at)
      values ('pay_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'job-credit', ${original.invoiceUid}, 200, '2026-10-12', now(), now(), now())`));
    const credit = (overrides = {}) => a.creditAndReissue({
      jobId: "job-credit",
      idempotencyKey: "credit-1",
      reference: "2610-03",
      issuedAt: "2026-10-13T02:00:00.000Z",
      issuedBy: "user-2",
      reason: "Approved variation: rock clause",
      credited: { number: original.number, invoice: { ...claimInvoice(), key: original.number, number: original.number, issuedAt: original.issuedAt, reference: "2610-03" } },
      creditNote: { ...claimInvoice(), lines: claimInvoice().lines.map((line) => ({ ...line, name: `Credit of ${original.number}: ${line.name}` })) },
      renderCreditNote: async (number, { invoiceNumber }) => Buffer.from(`%PDF-1.4\nAdjustment note ${number} -> ${invoiceNumber}\n%%EOF\n`),
      invoice: { ...claimInvoice({ subtotal: "500.00", gst: "50.00", total: "550.00" }), revision: 2 },
      render: async (number, { creditNoteNumber }) => Buffer.from(`%PDF-1.4\nTax invoice ${number} after ${creditNoteNumber}\n%%EOF\n`),
      ...overrides,
    });
    const result = await credit();
    assert.ok(result.creditNote.number.startsWith(formatCreditNoteNumber(period, 1).replace(/1$/, "")), result.creditNote.number);
    assert.ok(result.invoice.number.startsWith(formatInvoiceNumber(period, 1).replace(/1$/, "")), result.invoice.number);
    assert.deepEqual(result.creditNote.pdfBytes, Buffer.from(`%PDF-1.4\nAdjustment note ${result.creditNote.number} -> ${result.invoice.number}\n%%EOF\n`), "each document names the other");

    const read = await createInvoiceRowService({ db: t.db, orgUid: ORG_A }).readJob("job-credit");
    const credited = read.invoices.find((invoice) => invoice.number === original.number);
    const replacement = read.invoices.find((invoice) => invoice.number === result.invoice.number);
    assert.deepEqual([credited.status, credited.amountPaid, replacement.status, replacement.amountPaid, replacement.supersedesInvoiceUid], ["credited", "0.00", "issued", "200.00", credited.uid]);
    assert.deepEqual(read.creditNotes.map((note) => [note.number, note.reason, note.createdBy, note.total, note.invoiceUid, note.replacementInvoiceUid, note.issuedDocumentUid]), [
      [result.creditNote.number, "Approved variation: rock clause", "user-2", "440.00", credited.uid, replacement.uid, result.creditNote.issuedDocumentUid],
    ]);
    assert.deepEqual(read.allocations.map((allocation) => [allocation.fromInvoiceUid, allocation.toInvoiceUid, allocation.amount]), [[credited.uid, replacement.uid, "200.00"]]);
    const documents = createIssuedDocumentService({ db: t.db, orgUid: ORG_A });
    const listed = await documents.listJobDocuments("job-credit");
    const creditedEvents = listed.documents.find((document) => document.number === original.number).events.map((event) => [event.event, event.by, event.data.reason || null]);
    assert.deepEqual(creditedEvents, [["issued", "user-1", null], ["credited", "user-2", "Approved variation: rock clause"]]);
    assert.equal(listed.documents.find((document) => document.number === result.creditNote.number).documentType, "credit_note");

    // A retry returns the same documents; a second credit of the same invoice is refused.
    const again = await credit();
    assert.equal(again.replayed, true);
    assert.deepEqual([again.creditNote.number, again.invoice.number], [result.creditNote.number, result.invoice.number]);
    await rejects(credit({ idempotencyKey: "credit-2" }), /was already credited by CN-/);
    // A failed credit rolls both numbers back.
    const notesBefore = await counterOf("credit_note", period);
    const invoicesBefore = await counter(ORG_A, period);
    const second = await issue(a, { key: "to-credit-2", jobId: "job-credit-2" });
    await rejects(a.creditAndReissue({
      jobId: "job-credit-2",
      idempotencyKey: "credit-fails",
      reference: "2610-03",
      issuedAt: "2026-10-13T02:00:00.000Z",
      reason: "Wrong amount",
      credited: { number: second.number, invoice: { ...claimInvoice(), key: second.number, number: second.number, issuedAt: second.issuedAt } },
      creditNote: claimInvoice(),
      renderCreditNote: async () => Buffer.from("%PDF-1.4\n%%EOF\n"),
      invoice: claimInvoice(),
      render: async () => { throw new Error("renderer crashed"); },
    }), /renderer crashed/);
    assert.equal(await counterOf("credit_note", period), notesBefore);
    assert.equal(await counter(ORG_A, period), invoicesBefore + 1, "only the invoice issued before moved the invoice counter");
    await rejects(credit({ idempotencyKey: "no-reason", reason: " " }), /needs its reason/);
  });

  test("reissued after a return to draft: the business setting decides whether the old invoice is credited", async () => {
    const settings = createBusinessSettingsService({ db: t.db, orgUid: ORG_A });
    const documents = createIssuedDocumentService({ db: t.db, orgUid: ORG_A });
    assert.equal((await settings.get()).creditNoteOnReissue, "when-emailed", "the default");
    let jobs = 0;
    // An invoice issued, maybe emailed or sent, then returned to draft and
    // reissued with different content.
    async function reissue({ emailed = false, sendRecord = false } = {}) {
      jobs += 1;
      const jobId = `job-reissue-${jobs}`;
      const original = await issue(a, { key: `reissue-original-${jobs}`, jobId });
      if (emailed) {
        await documents.recordEvent({ issuedDocumentUid: original.issuedDocumentUid, jobId, documentType: "invoice", event: "emailed", at: "2026-10-12T03:00:00.000Z", data: { messageId: `msg-${jobs}` }, idempotencyKey: `emailed:msg-${jobs}` });
      }
      if (sendRecord) {
        await withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into quote_snapshots (attempt_id, job_id, document_type, status, document_number, prepared_at, sent_at, lines, recipients, pricing)
          values (${`attempt-${jobs}`}, ${jobId}, 'invoice', 'sent', ${original.number}, now(), now(), '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)`));
      }
      return a.creditAndReissue({
        jobId,
        idempotencyKey: `reissue-${jobs}`,
        reference: "2610-03",
        issuedAt: "2026-10-13T02:00:00.000Z",
        issuedBy: "user-1",
        reason: "Reissued after the invoice was returned to draft",
        credited: { number: original.number, invoice: { ...claimInvoice(), key: original.number, number: original.number, issuedAt: original.issuedAt } },
        creditNote: claimInvoice(),
        renderCreditNote: async (number) => Buffer.from(`%PDF-1.4\n${number}\n%%EOF\n`),
        invoice: { ...claimInvoice({ subtotal: "500.00", gst: "50.00", total: "550.00" }), revision: 2 },
        render: async (number) => Buffer.from(`%PDF-1.4\n${number}\n%%EOF\n`),
        whenToCredit: "by-setting",
      });
    }
    const credited = (result) => [Boolean(result.creditNote), result.decision.setting, result.decision.evidence.emailed, result.decision.evidence.sendRecord];

    // when-emailed: only with evidence the customer was sent it.
    assert.deepEqual(credited(await reissue()), [false, "when-emailed", false, false]);
    assert.deepEqual(credited(await reissue({ emailed: true })), [true, "when-emailed", true, false]);
    assert.deepEqual(credited(await reissue({ sendRecord: true })), [true, "when-emailed", false, true]);
    // always: even when it never left Field.
    await settings.update({ creditNoteOnReissue: "always" }, { actor: "owner-1" });
    assert.deepEqual(credited(await reissue()), [true, "always", false, false]);
    // never: not even when it was emailed.
    await settings.update({ creditNoteOnReissue: "never" }, { actor: "owner-1" });
    const never = await reissue({ emailed: true });
    assert.deepEqual(credited(never), [false, "never", true, false]);
    assert.match(never.invoice.number, /^INV-/);
    // Without a credit the reissue is the new invoice alone, and a retry returns it.
    const replay = await a.creditAndReissue({ jobId: `job-reissue-${jobs}`, idempotencyKey: `reissue-${jobs}`, reference: "2610-03", issuedAt: "2026-10-13T02:00:00.000Z", reason: "x", credited: { number: "unused", invoice: claimInvoice() }, creditNote: claimInvoice(), renderCreditNote: async () => { throw new Error("not rendered"); }, invoice: claimInvoice(), render: async () => { throw new Error("not rendered"); }, whenToCredit: "by-setting" });
    assert.deepEqual([replay.replayed, replay.creditNote, replay.invoice.number], [true, null, never.invoice.number]);
    // "Credit and reissue" credits whatever the setting says.
    jobs += 1;
    const original = await issue(a, { key: `reissue-original-${jobs}`, jobId: `job-reissue-${jobs}` });
    const forced = await a.creditAndReissue({ jobId: `job-reissue-${jobs}`, idempotencyKey: `reissue-${jobs}`, reference: "2610-03", issuedAt: "2026-10-13T02:00:00.000Z", reason: "Approved variation", credited: { number: original.number, invoice: { ...claimInvoice(), key: original.number, number: original.number, issuedAt: original.issuedAt } }, creditNote: claimInvoice(), renderCreditNote: async (number) => Buffer.from(`%PDF-1.4\n${number}\n%%EOF\n`), invoice: claimInvoice(), render: async (number) => Buffer.from(`%PDF-1.4\n${number}\n%%EOF\n`) });
    assert.ok(forced.creditNote);
    assert.equal(forced.decision.whenToCredit, "always");
    await assert.rejects(settings.update({ creditNoteOnReissue: "sometimes" }), /must be one of when-emailed, always, never/);
    await settings.update({ creditNoteOnReissue: "when-emailed" }, { actor: "owner-1" });
    assert.deepEqual(await settings.get(), { creditNoteOnReissue: "when-emailed", updatedAt: (await settings.get()).updatedAt, updatedBy: "owner-1" });
  });

  test("receipts: RCT-YYYY-M-N from their own counter, stored with the invoice they pay; a retry replays", async () => {
    const issuedAt = "2026-10-12T02:00:00.000Z";
    const period = invoicePeriod(new Date(issuedAt));
    const invoicesBefore = await counterOf("invoice", period);
    const receiptsBefore = await counterOf("receipt", period);
    const receipt = (key, overrides = {}) => a.issueReceipt({
      jobId: "job-receipts",
      idempotencyKey: key,
      issuedAt,
      issuedBy: "user-1",
      invoiceNumber: "INV-2026-10-1",
      quoteVersion: 2,
      details: { milestoneIndex: 0, amount: 440 },
      render: async (number) => {
        renders.push(number);
        return pdfFor(number);
      },
      ...overrides,
    });
    const first = await receipt(receiptIssueKey({ jobId: "job-receipts", milestoneIndex: 0, paymentId: "pay-1", invoiceNumber: "INV-2026-10-1" }));
    assert.equal(first.number, formatReceiptNumber(period, receiptsBefore + 1));
    assert.equal(first.replayed, false);
    assert.equal(renders.at(-1), first.number);
    const documents = createIssuedDocumentService({ db: t.db, orgUid: ORG_A });
    const stored = await documents.readIssuedDocument(first.issuedDocumentUid);
    assert.deepEqual([stored.document.documentType, stored.document.number, stored.document.details.invoiceNumber], ["receipt", first.number, "INV-2026-10-1"]);
    assert.deepEqual(stored.bytes, first.pdfBytes);

    const rendered = renders.length;
    const again = await receipt(receiptIssueKey({ jobId: "job-receipts", milestoneIndex: 0, paymentId: "pay-1", invoiceNumber: "INV-2026-10-1" }), { issuedAt: "2026-10-13T02:00:00.000Z" });
    assert.deepEqual([again.replayed, again.number, again.issuedDocumentUid, again.issuedAt], [true, first.number, first.issuedDocumentUid, first.issuedAt]);
    assert.equal(renders.length, rendered, "not rendered again");

    const second = await receipt(receiptIssueKey({ jobId: "job-receipts", milestoneIndex: 0, paymentId: "pay-2", invoiceNumber: "INV-2026-10-1" }));
    assert.equal(second.number, formatReceiptNumber(period, receiptsBefore + 2));
    assert.equal(await counterOf("invoice", period), invoicesBefore, "receipts do not use invoice numbers");
    await rejects(receipt("no-invoice", { invoiceNumber: null }), /a receipt names the invoice it pays/);
    await rejects(createUnavailableInvoiceIssuer("this server has no database").issueReceipt({}), /receipts are issued in PostgreSQL/);
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
