// The invoice-row dual-write (#27) through today's real milestone actions,
// each committed as a job generation the way the routes run them: generate,
// issue, email, payment, receipt email, void a payment, update, unsend, mark
// unpaid, re-issue and revise. After each one the rows equal the files, issued
// invoices and receipts link their issued documents, and nothing can fail the
// action.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { sendJobQuote } from "../job-actions.js";
import { installJobGenerationCommitListener } from "../job-generation.js";
import { readJobMeta } from "../job-meta-store.js";
import { createTestPriceCatalog } from "../test-price-catalog.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { createIssuedDocumentRecorder, installIssuedDocumentRecorder } from "../documents/recorder.js";
import { createInvoiceRowService } from "./invoice-rows.js";
import { createInvoiceRowRecorder, createUnavailableInvoiceRowRecorder, installInvoiceRowRecorder, invoiceRowRecorder } from "./recorder.js";
import { createInvoiceIssueService, installInvoiceIssuer } from "./issue.js";
import { actions, applyVariation, createLandedJob } from "./test-fixtures.js";

const quiet = { error: () => {}, warn: () => {} };

describe("invoice-row dual-write", () => {
  let catalog;
  let rows;
  let recorder;
  let documents;
  const warnings = [];

  before(async () => {
    catalog = await createTestPriceCatalog({ track: false });
    documents = createIssuedDocumentService({ db: catalog.db, orgUid: DEFAULT_ORG_UID });
    installIssuedDocumentRecorder(createIssuedDocumentRecorder({ service: documents, logger: quiet }));
    rows = createInvoiceRowService({ db: catalog.db, orgUid: DEFAULT_ORG_UID });
    recorder = createInvoiceRowRecorder({ service: rows, issuedDocuments: documents, logger: { error: (line) => warnings.push(line), warn: (line) => warnings.push(line) } });
    installInvoiceRowRecorder(recorder);
    installJobGenerationCommitListener((jobDir) => recorder.syncJob(jobDir, { reason: "test commit" }));
  });
  after(async () => {
    installJobGenerationCommitListener(null);
    installInvoiceRowRecorder(null);
    installIssuedDocumentRecorder(null);
    await catalog.close();
  });

  const summary = async (jobId) => {
    const read = await rows.readJob(jobId);
    return {
      invoices: read.invoices.map((invoice) => [invoice.number, invoice.status, invoice.total, invoice.amountPaid]),
      payments: read.payments.map((payment) => [payment.amount, payment.voidedAt ? "voided" : "active"]),
      receipts: read.receipts.map((receipt) => [receipt.number, receipt.amount, receipt.status]),
      read,
    };
  };

  async function send(jobDir, documentType, milestoneIndex, id) {
    return sendJobQuote({
      jobDir,
      meta: await readJobMeta(jobDir),
      dataDir: jobDir,
      config: {},
      to: "customer@example.invalid",
      documentType,
      milestoneIndex,
      sendEmail: async ({ quote }) => ({ id, threadId: `thread-${id}`, subject: `${documentType} ${quote.quoteNumber}`, to: "customer@example.invalid" }),
    });
  }

  test("every milestone action leaves the rows equal to the files", async () => {
    const root = await mkdtemp(join(tmpdir(), "field-invoice-rows-dual-"));
    try {
      const { jobDir, quote } = await createLandedJob(join(root, "job-dual"), { id: "job-dual", number: "2610-01", rows: [["Retaining wall", 1000]] });

      await actions.generate(jobDir, [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }]);
      let state = await summary("job-dual");
      assert.deepEqual(state.invoices, [["EI-2610-01-M1", "draft", "550.00", "0.00"], ["EI-2610-01-M2", "draft", "550.00", "0.00"]]);
      assert.equal(state.read.milestones.length, 2);

      // Issue: the deposit is issued and linked to its issued document.
      await actions.issue(jobDir, 0);
      state = await summary("job-dual");
      assert.deepEqual(state.invoices[0], ["EI-2610-01-M1", "issued", "550.00", "0.00"]);
      const issuedInvoice = await documents.findIssuedDocument({ documentType: "invoice", number: "EI-2610-01-M1" });
      assert.ok(issuedInvoice);
      assert.equal(state.read.invoices[0].issuedDocumentUid, issuedInvoice.uid);

      // Email it: still the same issued invoice.
      await send(jobDir, "invoice", 0, "msg-invoice");
      state = await summary("job-dual");
      assert.equal(state.read.invoices[0].issuedDocumentUid, issuedInvoice.uid);

      // Payment in full: paid, a payment and a receipt; email the receipt.
      await actions.pay(jobDir, 0, 550);
      await send(jobDir, "receipt", 0, "msg-receipt");
      state = await summary("job-dual");
      assert.deepEqual(state.invoices[0], ["EI-2610-01-M1", "paid", "550.00", "550.00"]);
      assert.deepEqual(state.payments, [["550.00", "active"]]);
      assert.deepEqual(state.receipts, [["ER-2610-01-M1", "550.00", "issued"]]);
      const issuedReceipt = await documents.findIssuedDocument({ documentType: "receipt", number: "ER-2610-01-M1" });
      assert.ok(issuedReceipt);
      assert.equal(state.read.receipts[0].issuedDocumentUid, issuedReceipt.uid);

      // Void the payment: the payment keeps its row, the receipt is voided.
      const paymentId = (await readJobMeta(jobDir)).milestoneInvoices[0].payments[0].id;
      await actions.voidPayment(jobDir, 0, paymentId);
      state = await summary("job-dual");
      assert.deepEqual(state.invoices[0], ["EI-2610-01-M1", "issued", "550.00", "0.00"]);
      assert.deepEqual(state.payments, [["550.00", "voided"]]);
      assert.deepEqual(state.receipts, [["ER-2610-01-M1", "550.00", "void"]]);

      // Update: the completion's due date.
      await actions.update(jobDir, 1, { dueDate: "2026-07-01" });
      state = await summary("job-dual");
      assert.equal(state.read.invoices[1].dueOn, "2026-07-01");

      // Issue then unsend the completion: its row stays, void.
      await actions.issue(jobDir, 1);
      await actions.unsent(jobDir, 1);
      state = await summary("job-dual");
      assert.deepEqual(state.invoices[1], ["EI-2610-01-M2", "void", "550.00", "0.00"]);

      // Pay the deposit again, then mark it unpaid: the files drop the
      // payment; its row is voided and the deposit returns to draft (void).
      await actions.pay(jobDir, 0, 550);
      state = await summary("job-dual");
      assert.deepEqual(state.receipts.map((receipt) => receipt[2]), ["void", "issued"], "a new receipt for the new payment, same number");
      await actions.unpaid(jobDir, 0);
      state = await summary("job-dual");
      assert.deepEqual(state.invoices[0], ["EI-2610-01-M1", "void", "550.00", "0.00"]);
      assert.deepEqual(state.payments, [["550.00", "voided"], ["550.00", "voided"]]);
      assert.match(state.read.payments[1].voidReason, /marked unpaid/);
      assert.deepEqual(state.receipts.map((receipt) => receipt[2]), ["void", "void"]);

      // Re-issue with the same content: the same number, issued again.
      await actions.issue(jobDir, 0);
      state = await summary("job-dual");
      assert.deepEqual(state.invoices[0], ["EI-2610-01-M1", "issued", "550.00", "0.00"]);

      // Revise after an approved variation: -R2 issued, the original credited.
      await applyVariation(jobDir, quote, ["Drainage", 200]);
      await actions.revise(jobDir, 0);
      state = await summary("job-dual");
      // The completion's draft changed content, so it takes the next number
      // under the void row that kept the old one.
      assert.deepEqual(state.invoices, [
        ["EI-2610-01-M1", "credited", "550.00", "0.00"],
        ["EI-2610-01-M2", "void", "550.00", "0.00"],
        ["EI-2610-01-M1-R2", "issued", "660.00", "0.00"],
        ["EI-2610-01-M2-R2", "draft", "660.00", "0.00"],
      ]);
      const byNumber = Object.fromEntries(state.read.invoices.map((invoice) => [invoice.number, invoice]));
      assert.equal(byNumber["EI-2610-01-M1-R2"].supersedesInvoiceUid, byNumber["EI-2610-01-M1"].uid);

      const status = recorder.status();
      assert.equal(status.failures, 0, warnings.join("\n"));
      assert.equal(status.mismatches, 0, JSON.stringify(status.lastMismatch));
      assert.equal(status.conflicts, 0, JSON.stringify(status.lastMismatch));
      assert.ok(status.written >= 10, JSON.stringify(status));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("invoices issued from the sequence: the issue writes the row, and every later sync finds it as issued", async () => {
    const issuer = installInvoiceIssuer(createInvoiceIssueService({ db: catalog.db, orgUid: DEFAULT_ORG_UID }));
    const root = await mkdtemp(join(tmpdir(), "field-invoice-rows-issue-"));
    const before = recorder.status();
    try {
      const { jobDir } = await createLandedJob(join(root, "job-issue"), { id: "job-issue", number: "2610-02", rows: [["Retaining wall", 1000]] });
      await actions.generate(jobDir, [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }]);
      await actions.issue(jobDir, 0);
      const deposit = (await readJobMeta(jobDir)).milestoneInvoices[0];
      assert.match(deposit.invoiceNumber, /^INV-\d{4}-\d{2}-[1-9]\d*$/);
      let state = await summary("job-issue");
      assert.deepEqual(state.invoices.map(([number, status]) => [number, status]), [["EI-2610-02-M2", "draft"], [deposit.invoiceNumber, "issued"]]);
      const row = state.read.invoices.find((invoice) => invoice.number === deposit.invoiceNumber);
      assert.equal(row.reference, "JOB-2610-02", "the job number is the invoice's reference");
      assert.deepEqual(row.lines.map((line) => line.name), ["Deposit, 50 % of EQ-2610-02 v1"]);
      const issuedDocument = await documents.findIssuedDocument({ documentType: "invoice", number: deposit.invoiceNumber });
      assert.equal(row.issuedDocumentUid, issuedDocument.uid);
      assert.equal(issuedDocument.pdfSha256, deposit.issuedRevision.pdfSha256);

      // Email it, pay it, send the receipt (still ER-…): one issued invoice.
      await send(jobDir, "invoice", 0, "msg-issue-invoice");
      await actions.pay(jobDir, 0, 550);
      await send(jobDir, "receipt", 0, "msg-issue-receipt");
      state = await summary("job-issue");
      assert.deepEqual(state.invoices.find(([number]) => number === deposit.invoiceNumber), [deposit.invoiceNumber, "paid", "550.00", "550.00"]);
      assert.deepEqual(state.receipts, [["ER-2610-02-M1", "550.00", "issued"]]);
      const listed = await documents.listJobDocuments("job-issue");
      const emailed = listed.documents.find((document) => document.number === deposit.invoiceNumber).events.find((event) => event.event === "emailed");
      assert.equal(emailed.data.pdfSha256, deposit.issuedRevision.pdfSha256, "the email carried the issued bytes");

      // Issue the completion, unsend it, issue it again unchanged: the same
      // number comes back; nothing new is issued.
      await actions.issue(jobDir, 1);
      const completion = (await readJobMeta(jobDir)).milestoneInvoices[1];
      await actions.unsent(jobDir, 1);
      state = await summary("job-issue");
      assert.deepEqual(state.invoices.find(([number]) => number === completion.invoiceNumber).slice(0, 2), [completion.invoiceNumber, "void"]);
      await actions.issue(jobDir, 1);
      assert.equal((await readJobMeta(jobDir)).milestoneInvoices[1].invoiceNumber, completion.invoiceNumber);
      state = await summary("job-issue");
      assert.deepEqual(state.invoices.find(([number]) => number === completion.invoiceNumber).slice(0, 2), [completion.invoiceNumber, "issued"]);
      assert.equal(state.read.invoices.filter((invoice) => /^INV-/.test(invoice.number)).length, 2);

      const status = recorder.status();
      assert.equal(status.failures, before.failures, warnings.join("\n"));
      assert.equal(status.mismatches, before.mismatches, JSON.stringify(status.lastMismatch));
      assert.equal(status.conflicts, before.conflicts, JSON.stringify(status.lastMismatch));
    } finally {
      installInvoiceIssuer(null);
      await rm(root, { recursive: true, force: true });
    }
    assert.ok(issuer.enabled);
  });

  test("a job that fails its checks is counted with both numbers, once, and not written; nothing throws", async () => {
    const lines = [];
    const failing = { jobId: "job-x", ok: false, action: "refused", failures: [{ kind: "totals", against: "revision-pdf", number: "EI-X-M1", field: "total", rows: "110.00", shown: "120.00" }] };
    const stub = createInvoiceRowRecorder({ service: {}, logger: { error: (line) => lines.push(line), warn: (line) => lines.push(line) }, sync: async () => failing });
    assert.equal(await stub.syncJob("/job-x"), failing);
    await stub.syncJob("/job-x");
    const status = stub.status();
    assert.equal(status.mismatches, 1, "the same failure on a later commit is not counted again");
    assert.deepEqual(status.lastMismatch.failures, failing.failures);
    assert.equal(lines.filter((line) => /job job-x: rows not written \(EI-X-M1 total rows 110\.00 vs revision-pdf 120\.00\)/.test(line)).length, 1);
  });

  test("a recorder whose database fails logs, counts and returns null", async () => {
    const lines = [];
    const broken = createInvoiceRowRecorder({ service: { hasRows: async () => { throw new Error("database is down"); } }, logger: { error: (line) => lines.push(line), warn: () => {} } });
    const jobDir = await mkdtemp(join(tmpdir(), "field-invoice-rows-broken-"));
    try {
      await writeFile(join(jobDir, "meta.json"), JSON.stringify({ id: "job-broken" }));
      assert.equal(await broken.syncJob(jobDir), null);
      assert.equal(broken.status().failures, 1);
      assert.match(broken.status().lastError.message, /database is down/);
      assert.match(lines[0], /the job files still hold them/);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  test("without a database, the recorder skips with one log line; uninstalled, it is a no-op", async () => {
    const lines = [];
    const unavailable = createUnavailableInvoiceRowRecorder("no database configured", { logger: { warn: (line) => lines.push(line) } });
    await unavailable.syncJob("/nowhere");
    await unavailable.syncJob("/nowhere");
    assert.equal(lines.length, 1);
    assert.deepEqual(unavailable.status(), { enabled: false, reason: "no database configured", skipped: 2 });
    installInvoiceRowRecorder(null);
    try {
      assert.equal(invoiceRowRecorder().enabled, false);
      assert.equal(await invoiceRowRecorder().syncJob("/nowhere"), null);
    } finally {
      installInvoiceRowRecorder(recorder);
    }
  });
});
