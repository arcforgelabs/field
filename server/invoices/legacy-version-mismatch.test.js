// Legacy milestone invoices whose milestone record and stored PDF come from
// different quote versions. Synthetic jobs shaped like the production ones: a
// 30 % deposit invoiced and emailed against quote v1 before invoice revisions
// were frozen, quote v2 accepted since, then adopted through today's code.
//
//   - Reproduction: today's adoption freezes the record as the issued snapshot
//     (quote version inferred) and adopts the file as its PDF without
//     checking one against the other, and the invoice-row backfill refuses
//     the job with both numbers.
//   - What the customer was sent decides: a hash-verified sent copy (the
//     issuance ledger, or an issued document with an `emailed` event) gives
//     the rows the amounts emailed, marked printed with the version mismatch.
//   - Without one the job stays refused, and an owner settles it from the
//     report: the choice is recorded with who and why, what is owed follows
//     it, and payments are never changed.
//   - Today's code never rewrites an issued snapshot or redraws an issued PDF
//     when the quote moves on (both directions).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { sha256Hex } from "../documents/blob-store.js";
import { recordJobMilestonePayment, settleJobMilestoneInvoiceAmounts } from "../job-actions.js";
import { readJobMeta } from "../job-meta-store.js";
import { readJobState } from "../job-state.js";
import { resolveActiveJobGeneration, runAtomicJobGeneration } from "../job-generation.js";
import { recordIssuedQuoteDocuments } from "../quote-issuance.js";
import { listInvoiceAmountDisagreements } from "./amount-evidence.js";
import { createInvoiceAmountDisagreementsHandler, createInvoiceAmountSettleHandler } from "./amount-routes.js";
import { backfillInvoiceRows } from "./backfill.js";
import { createInvoiceRowService } from "./invoice-rows.js";
import { syncJobInvoiceRows } from "./sync.js";
import { act, actions, applyVariation, createLegacyVersionMismatchJob, renderLegacyInvoicePdf } from "./test-fixtures.js";

const OWNER = { kind: "user", label: "Owner Test" };

async function readPdf(jobDir, path) {
  return readFile(join(await resolveActiveJobGeneration(jobDir), path));
}

async function deposit(jobDir) {
  return (await readJobMeta(jobDir)).milestoneInvoices[0];
}

/** Record `bytes` as the PDF Field emailed for the job's deposit, in its issuance ledger. */
async function ledgerSend(jobDir, number, bytes, quoteVersion) {
  await runAtomicJobGeneration(jobDir, async (staged) => {
    await recordIssuedQuoteDocuments({
      jobDir: staged,
      quoteVersion,
      documentType: "invoice",
      issuedAt: "2026-09-20T01:00:00.000Z",
      deliveryResult: { messageId: `msg-ledger-${number}`, documentType: "invoice", to: ["customer@example.invalid"], subject: `Invoice ${number}` },
      quotePdf: bytes,
    });
  });
}

function settle(jobDir, input) {
  return act(jobDir, settleJobMilestoneInvoiceAmounts, { actor: OWNER, issuedDocuments: null, ...input });
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe("legacy milestone invoices from two quote versions", () => {
  let root;
  let t;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "field-legacy-version-"));
    t = await createTestDb();
  });
  after(async () => {
    await t.close();
    rmSync(root, { recursive: true, force: true });
  });
  const dataDirFor = (name) => join(root, name);

  test("reproduction: today's adoption freezes the record and adopts the file from different versions; the backfill refuses the job", async () => {
    for (const [name, recordVersion, pdfVersion] of [["pdf-redrawn", 1, 2], ["record-reallocated", 2, 1]]) {
      const dataDir = dataDirFor(`repro-${name}`);
      const job = await createLegacyVersionMismatchJob(dataDir, { id: `job-${name}`, number: name === "pdf-redrawn" ? "2607-91" : "2607-92", recordVersion, pdfVersion, sentVersion: 1 });
      assert.equal((await deposit(job.jobDir)).issuedRevision, null, "nothing is frozen before today's code touches it");

      // Any milestone action: here one on the completion milestone only.
      await actions.update(job.jobDir, 1, { dueDate: "2026-09-30" });
      const frozen = (await deposit(job.jobDir)).issuedRevision;
      // The record's amounts become the issued snapshot, pinned to the quote
      // current at the freeze (v2) and marked inferred ...
      assert.deepEqual([frozen.subtotal, frozen.gst, frozen.total], [job.claims[recordVersion].subtotal, job.claims[recordVersion].gst, job.claims[recordVersion].total]);
      assert.equal(frozen.quoteVersion, 2);
      assert.equal(frozen.quoteVersionInferred, true);
      // ... and the file on disk becomes its PDF, byte for byte, never redrawn.
      assert.equal(frozen.artifactState, "stored");
      assert.equal(frozen.pdfSha256, sha256Hex(job.pdf));
      assert.deepEqual(await readPdf(job.jobDir, job.deposit.pdfPath), job.pdf);
      const { activity } = await readJobState(job.jobDir);
      const differs = activity.find((entry) => entry.kind === "invoice.adopted_pdf_differs");
      assert.ok(differs, "the adoption says the file and the record disagree");
      assert.match(differs.body, new RegExp(`claims ${job.claims[pdfVersion].total.toFixed(2)}, but its milestone record holds ${job.claims[recordVersion].total.toFixed(2)}`));

      const report = await backfillInvoiceRows({ dataDir });
      assert.equal(report.jobsRefused, 1);
      assert.deepEqual(report.mismatches.filter((entry) => entry.field === "total").map((entry) => [entry.number, entry.against, entry.rows, entry.shown]), [
        [job.number, "revision-pdf", job.claims[recordVersion].total.toFixed(2), job.claims[pdfVersion].total.toFixed(2)],
      ]);
      const entry = report.entries[0].invoices.find((invoice) => invoice.number === job.number);
      assert.deepEqual(entry.sends, [{ sentAt: "2026-07-10T01:00:00.000Z", quoteVersion: 1, hashed: false }], "the archived email says which version was sent, with no hash");
    }
  });

  test("a hash-verified sent copy decides: the rows take the amounts emailed, marked printed, and the job is written", async () => {
    // The record was re-allocated to v2 after the v1 PDF was emailed.
    const dataDir = dataDirFor("sent-ledger");
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-sent-ledger", number: "2607-93", recordVersion: 2, pdfVersion: 1 });
    await actions.update(job.jobDir, 1, { dueDate: "2026-09-30" });
    await ledgerSend(job.jobDir, job.number, job.pdf, 1);

    const service = createInvoiceRowService({ db: t.db, orgUid: DEFAULT_ORG_UID });
    const report = await backfillInvoiceRows({ dataDir, service });
    assert.equal(report.jobsRefused, 0, JSON.stringify(report.mismatches));
    const warning = report.warnings.find((entry) => entry.kind === "rows-from-sent-copy");
    assert.deepEqual([warning.number, warning.rows, warning.shown], [job.number, job.claims[2].total.toFixed(2), job.claims[1].total.toFixed(2)]);
    assert.match(warning.reason, /ledger-emailed/);
    assert.match(warning.reason, /\(quote v1\)/, "the reason names the version the sent PDF was drawn from");
    assert.match(warning.reason, /quote v2, inferred/, "and the version the record says, inferred");

    const rows = await service.readJob("job-sent-ledger");
    const invoice = rows.invoices.find((candidate) => candidate.number === job.number);
    assert.deepEqual([invoice.subtotal, invoice.taxTotal, invoice.total], [job.claims[1].subtotal.toFixed(2), job.claims[1].gst.toFixed(2), job.claims[1].total.toFixed(2)]);
    assert.equal(invoice.taxTotalSource, "printed");
    assert.match(invoice.taxTotalReason, /Amounts as sent/);
  });

  test("a stored PDF redrawn after sending: a sent copy that matches the record keeps the record, and the stored PDF is reported as not the copy sent", async () => {
    const dataDir = dataDirFor("redrawn");
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-redrawn", number: "2607-94", recordVersion: 1, pdfVersion: 2 });
    await actions.update(job.jobDir, 1, { dueDate: "2026-09-30" });
    const sentBytes = await renderLegacyInvoicePdf({ meta: job.meta, quote: job.quotes[1], milestone: job.deposit, amounts: job.claims[1], milestones: [job.deposit, job.completion] });
    await ledgerSend(job.jobDir, job.number, sentBytes, 1);

    const report = await backfillInvoiceRows({ dataDir });
    assert.equal(report.jobsRefused, 0, JSON.stringify(report.mismatches));
    assert.equal(report.warnings.some((entry) => entry.kind === "rows-from-sent-copy"), false);
    const notSent = report.warnings.find((entry) => entry.kind === "stored-copy-not-sent");
    assert.deepEqual([notSent.number, notSent.against, notSent.rows, notSent.shown], [job.number, "revision-pdf", job.claims[2].total.toFixed(2), job.claims[1].total.toFixed(2)]);
    assert.match(notSent.reason, /\(quote v2\)/);
    const entry = report.entries[0].invoices.find((invoice) => invoice.number === job.number);
    assert.deepEqual(entry.rows.total, job.claims[1].total.toFixed(2));
  });

  test("an issued document with an emailed event is a verified sent copy; one without is not", async () => {
    const fresh = await createTestDb();
    try {
      const documents = createIssuedDocumentService({ db: fresh.db, orgUid: DEFAULT_ORG_UID });
      const dataDir = dataDirFor("sent-document");
      const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-sent-document", number: "2607-95", recordVersion: 2, pdfVersion: 1 });
      await actions.update(job.jobDir, 1, { dueDate: "2026-09-30" });
      await documents.recordIssuedDocument({
        jobId: "job-sent-document", documentType: "invoice", number: job.number, revision: 1,
        pdfBytes: job.pdf, issuedAt: "2026-07-10T01:00:00.000Z", source: "invoice-revision-backfill",
      });
      const unsent = await backfillInvoiceRows({ dataDir, issuedDocuments: documents });
      assert.equal(unsent.jobsRefused, 1, "an issued document is not proof that it was emailed");

      const { document } = await documents.recordIssuedDocument({
        jobId: "job-sent-document", documentType: "invoice", number: job.number, revision: 1,
        pdfBytes: job.pdf, issuedAt: "2026-07-10T01:00:00.000Z", source: "invoice-revision-backfill",
      });
      await documents.recordEvent({ issuedDocumentUid: document.uid, jobId: "job-sent-document", documentType: "invoice", event: "emailed", at: "2026-07-10T01:00:00.000Z", data: { messageId: "msg-1" }, idempotencyKey: "emailed:msg-1" });
      const sent = await backfillInvoiceRows({ dataDir, issuedDocuments: documents });
      assert.equal(sent.jobsRefused, 0, JSON.stringify(sent.mismatches));
      const warning = sent.warnings.find((entry) => entry.kind === "rows-from-sent-copy");
      assert.match(warning.reason, /issued-document-emailed/);
    } finally {
      await fresh.close();
    }
  });

  test("without a verified copy the report shows both sets and an owner settles one, recorded with who and why", async () => {
    const dataDir = dataDirFor("settle-record");
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-settle-record", number: "2607-96", recordVersion: 1, pdfVersion: 2, sentVersion: 1 });
    // The customer paid the deposit the record holds (the v1 amount).
    await actions.pay(job.jobDir, 0, job.claims[1].total);

    const listed = await listInvoiceAmountDisagreements({ dataDir });
    assert.deepEqual(listed.summary, { jobs: 1, issuedInvoices: 1, disagreeing: 1, byState: { "needs-owner-decision": 1 }, settledBySentCopyAvailable: 0, emailedBeforeHashes: 1, errors: 0 });
    const [entry] = listed.invoices;
    assert.equal(entry.jobId, "job-settle-record");
    assert.equal(entry.invoiceNumber, job.number);
    assert.deepEqual([entry.recorded.total, entry.recorded.quoteVersion, entry.recorded.quoteVersionInferred], [job.claims[1].total.toFixed(2), 2, true]);
    assert.deepEqual([entry.storedPdf.total, entry.storedPdf.drawnFromVersions], [job.claims[2].total.toFixed(2), [2]]);
    assert.deepEqual(entry.emails, [{ sentAt: "2026-07-10T01:00:00.000Z", quoteVersion: 1, hashed: false }]);
    assert.equal(entry.paid, job.claims[1].total.toFixed(2));
    assert.deepEqual(entry.options.map((option) => [option.choose, option.total]), [["milestone-record", job.claims[1].total.toFixed(2)], ["stored-pdf", job.claims[2].total.toFixed(2)]]);
    assert.equal(entry.sentCopy, null);
    assert.equal(JSON.stringify(listed).includes("Sam Customer"), false, "no customer text in the report");

    // Field refuses a total the owner did not see, a choice without a reason,
    // and settling below what is already paid.
    await assert.rejects(() => settle(job.jobDir, { invoiceNumber: job.number, choose: "milestone-record", total: "1.00", reason: "x" }), /totals 3960.00, not 1.00/);
    await assert.rejects(() => settle(job.jobDir, { invoiceNumber: job.number, choose: "milestone-record", total: "3960.00", reason: " " }), /reason is required/);
    await assert.rejects(() => settle(job.jobDir, { invoiceNumber: job.number, choose: "sent-copy", total: "3960.00", reason: "x" }), /gives no amounts/);

    const result = await settle(job.jobDir, { invoiceNumber: job.number, choose: "milestone-record", total: "3960.00", reason: "The archived email was built against v1 and the customer paid 3960.00" });
    assert.equal(result.settlement.source, "milestone-record");
    const settled = (await deposit(job.jobDir)).issuedRevision;
    assert.deepEqual({ ...settled.amountsSettlement, decidedAt: null }, {
      source: "milestone-record",
      subtotal: 3600,
      gst: 360,
      total: 3960,
      recorded: { subtotal: 3600, gst: 360, total: 3960 },
      storedPdfSha256: sha256Hex(job.pdf),
      storedPdfTotal: 5115,
      sentSha256: null,
      decidedBy: "Owner Test",
      decidedAt: null,
      reason: "The archived email was built against v1 and the customer paid 3960.00",
    });
    assert.deepEqual(await readPdf(job.jobDir, job.deposit.pdfPath), job.pdf, "the PDF is never touched");
    const { activity } = await readJobState(job.jobDir);
    assert.match(activity.find((candidate) => candidate.kind === "invoice.amounts_settled").body, /was issued for 3960.00, from the milestone record \(the stored PDF prints 5115.00\)/);
    await assert.rejects(() => settle(job.jobDir, { invoiceNumber: job.number, choose: "milestone-record", total: "3960.00", reason: "again" }), /already settled/);

    const report = await backfillInvoiceRows({ dataDir });
    assert.equal(report.jobsRefused, 0, JSON.stringify(report.mismatches));
    assert.ok(report.warnings.some((candidate) => candidate.kind === "settled-copy-differs" && candidate.shown === "5115.00"));
    const invoice = report.entries[0].invoices.find((candidate) => candidate.number === job.number);
    assert.equal(invoice.taxTotalSource, "printed");
    assert.equal((await listInvoiceAmountDisagreements({ dataDir })).invoices[0].state, "settled");
  });

  test("settling to the PDF's amounts changes what Field shows as owed, re-spreads the open milestone, and never changes a payment", async () => {
    // The record was re-allocated to v2 (5115.00) after the v1 PDF (3960.00)
    // was emailed, and the customer paid what that PDF said: Field shows
    // 1155.00 still owing that the customer was never invoiced for.
    const dataDir = dataDirFor("settle-pdf");
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-settle-pdf", number: "2607-97", recordVersion: 2, pdfVersion: 1 });
    await actions.pay(job.jobDir, 0, job.claims[1].total);
    const before = await deposit(job.jobDir);
    assert.deepEqual([before.total, before.amountPaid, before.amountDue], [5115, 3960, 1155]);
    const payments = before.payments;

    await settle(job.jobDir, { invoiceNumber: job.number, choose: "stored-pdf", total: 3960, reason: "The PDF on file is the v1 deposit the archive says was emailed" });
    const meta = await readJobMeta(job.jobDir);
    const [settled, completion] = meta.milestoneInvoices;
    assert.deepEqual([settled.subtotal, settled.gst, settled.total, settled.amountPaid, settled.amountDue], [3600, 360, 3960, 3960, 0]);
    assert.deepEqual(settled.issuedRevision.amountsSettlement.recorded, { subtotal: 4650, gst: 465, total: 5115 }, "what the record held is kept");
    assert.deepEqual(settled.payments, payments, "payments are never changed");
    assert.equal(completion.total, 17050 - 3960, "the open milestone claims the rest of the quote");
    assert.deepEqual(await readPdf(job.jobDir, job.deposit.pdfPath), job.pdf);

    const report = await backfillInvoiceRows({ dataDir });
    assert.equal(report.jobsRefused, 0, JSON.stringify(report.mismatches));
  });

  test("settling below what is already paid is refused; the payment has to be voided or moved first", async () => {
    const dataDir = dataDirFor("settle-overpaid");
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-settle-overpaid", number: "2607-98", recordVersion: 2, pdfVersion: 1 });
    await actions.pay(job.jobDir, 0, job.claims[2].total);
    await assert.rejects(() => settle(job.jobDir, { invoiceNumber: job.number, choose: "stored-pdf", total: "3960.00", reason: "x" }), (error) => error.statusCode === 409 && /5115.00 is already paid against/.test(error.message));
    assert.equal((await deposit(job.jobDir)).issuedRevision.amountsSettlement, undefined);
  });

  test("the owner routes: the report is read-only numbers, and settling needs every input", async () => {
    const dataDir = dataDirFor("routes");
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-routes", number: "2607-99", recordVersion: 2, pdfVersion: 1 });
    const report = createInvoiceAmountDisagreementsHandler({ dataDir, logger: { error() {} } });
    const res = fakeResponse();
    await report({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.wroteNothing, true);
    assert.equal(res.body.invoices[0].invoiceNumber, job.number);
    assert.equal((await deposit(job.jobDir)).issuedRevision, null, "the report writes nothing, not even the freeze");

    const calls = [];
    const handler = createInvoiceAmountSettleHandler({
      findJob: async (id) => (id === "job-routes" ? { dir: job.jobDir, meta: { id } } : null),
      settle: async (found, input) => { calls.push(input); return { settlement: { source: input.choose }, milestoneInvoices: [] }; },
    });
    const bad = fakeResponse();
    await handler({ body: { jobId: "job-routes", invoiceNumber: job.number, choose: "the PDF" } }, bad);
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body.error, /choose, total, reason required/);
    const missing = fakeResponse();
    await handler({ body: { jobId: "job-unknown", invoiceNumber: job.number, choose: "stored-pdf", total: "3960.00", reason: "x" } }, missing);
    assert.equal(missing.statusCode, 404);
    const ok = fakeResponse();
    await handler({ body: { jobId: "job-routes", invoiceNumber: job.number, choose: "stored-pdf", total: "3960.00", reason: "the v1 PDF was sent" } }, ok);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(calls, [{ invoiceNumber: job.number, choose: "stored-pdf", total: "3960.00", reason: "the v1 PDF was sent" }]);

    const logged = [];
    const failing = createInvoiceAmountSettleHandler({
      findJob: async (id) => ({ dir: job.jobDir, meta: { id } }),
      settle: async () => { throw new Error(`ENOENT: ${job.jobDir}/milestone-invoices/state.json`); },
      logger: { error: (line) => logged.push(line) },
    });
    const broken = fakeResponse();
    await failing({ body: { jobId: "job-routes", invoiceNumber: job.number, choose: "stored-pdf", total: "3960.00", reason: "x" } }, broken);
    assert.equal(broken.statusCode, 500);
    assert.equal(broken.body.error, "The invoice could not be settled. The server log has the reason.");
    assert.equal(JSON.stringify([broken.body, logged]).includes(job.jobDir), false, "no path in the answer or the log");
  });

  test("after a sent-copy backfill every later sync keeps the emailed amounts; the owner can only settle with the sent copy, and then the job bills it too", async () => {
    const fresh = await createTestDb();
    try {
      const service = createInvoiceRowService({ db: fresh.db, orgUid: DEFAULT_ORG_UID });
      const dataDir = dataDirFor("sent-then-sync");
      const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-sent-then-sync", number: "2607-71", recordVersion: 2, pdfVersion: 1 });
      await actions.update(job.jobDir, 1, { dueDate: "2026-09-30" });
      await ledgerSend(job.jobDir, job.number, job.pdf, 1);
      const backfilled = await backfillInvoiceRows({ dataDir, service });
      assert.equal(backfilled.jobsRefused, 0, JSON.stringify(backfilled.mismatches));

      // A later milestone action, then the dual-write sync (no PDF checks).
      await actions.update(job.jobDir, 1, { dueDate: "2026-10-30" });
      const synced = await syncJobInvoiceRows({ jobDir: job.jobDir, service });
      assert.equal(synced.ok, true, JSON.stringify(synced.failures));
      assert.equal(synced.failures.length, 0);
      const row = (await service.readJob("job-sent-then-sync")).invoices.find((invoice) => invoice.number === job.number);
      assert.equal(row.total, "3960.00", "the row keeps what was emailed");

      // The report offers only the copy emailed, and says the record still bills.
      const [entry] = (await listInvoiceAmountDisagreements({ dataDir })).invoices;
      assert.equal(entry.state, "sent-differs-from-recorded");
      assert.deepEqual(entry.options.map((option) => [option.choose, option.total]), [["sent-copy", "3960.00"]]);
      assert.match(entry.note, /still bill the record's 5115.00 until you settle with "sent-copy"/);
      assert.equal((await deposit(job.jobDir)).amountDue, 5115, "until settled, the job bills the record");
      await assert.rejects(() => settle(job.jobDir, { invoiceNumber: job.number, choose: "milestone-record", total: "5115.00", reason: "x" }), /only "sent-copy" can be chosen/);

      await settle(job.jobDir, { invoiceNumber: job.number, choose: "sent-copy", total: "3960.00", reason: "The ledger holds the PDF emailed" });
      const settled = await deposit(job.jobDir);
      assert.deepEqual([settled.invoiceNumber, settled.revisionNumber, settled.total, settled.amountDue], [job.number, 1, 3960, 3960]);
      const after = await syncJobInvoiceRows({ jobDir: job.jobDir, service, verifyIssued: true });
      assert.equal(after.ok, true, JSON.stringify(after.failures));
      assert.equal(after.summary.conflicts.length, 0);
    } finally {
      await fresh.close();
    }
  });

  test("a legacy invoice whose PDF is missing takes the hash-verified copy Field emailed, and a payment on it goes ahead", async () => {
    const dataDir = dataDirFor("missing-sent");
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-missing-sent", number: "2607-72", recordVersion: 1, pdfVersion: 1 });
    await ledgerSend(job.jobDir, job.number, job.pdf, 1);
    await runAtomicJobGeneration(job.jobDir, async (staged) => rm(join(staged, job.deposit.pdfPath)));
    await actions.pay(job.jobDir, 0, 500);
    const paid = await deposit(job.jobDir);
    assert.equal(paid.amountPaid, 500);
    assert.equal(paid.issuedRevision.artifactState, "stored");
    assert.equal(paid.issuedRevision.pdfSha256, sha256Hex(job.pdf));
    assert.deepEqual(await readPdf(job.jobDir, job.deposit.pdfPath), job.pdf, "restored byte for byte from the ledger");
    const { activity } = await readJobState(job.jobDir);
    assert.ok(activity.some((entry) => entry.kind === "invoice.artifact_restored_from_sent_copy"));
  });

  test("settling is refused when it would make the issued invoices claim more than the quote", async () => {
    const dataDir = dataDirFor("settle-overclaim");
    // Record 3960.00 (v1), stored PDF 5115.00 (v2); the completion is then
    // issued for the rest of v2 (13090.00).
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-settle-overclaim", number: "2607-73", recordVersion: 1, pdfVersion: 2 });
    await actions.issue(job.jobDir, 1);
    const before = await readJobMeta(job.jobDir);
    assert.equal(before.milestoneInvoices[1].total, 13090);
    await assert.rejects(
      () => settle(job.jobDir, { invoiceNumber: job.number, choose: "stored-pdf", total: "5115.00", reason: "x" }),
      (error) => error.statusCode === 409 && /claim 18205.00, more than the quote's 17050.00/.test(error.message),
    );
    const after = await readJobMeta(job.jobDir);
    assert.equal(after.milestoneInvoices[0].issuedRevision.amountsSettlement, undefined, "nothing was settled");
    assert.equal(after.milestoneInvoices[1].total, 13090);
  });

  test("settling a superseded revision (a deposit revised since) changes only that revision's amounts, under the same number", async () => {
    const dataDir = dataDirFor("settle-superseded");
    // The record was re-allocated to v2 (5115.00) after the v1 PDF (3960.00)
    // was emailed; a later variation (v3) revised the deposit to -R2.
    const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-settle-superseded", number: "2607-74", recordVersion: 2, pdfVersion: 1 });
    await actions.update(job.jobDir, 1, { dueDate: "2026-09-30" });
    // Paid against the first revision, more than the PDF's 3960.00; the
    // payment carries to the revision that replaces it.
    await act(job.jobDir, recordJobMilestonePayment, { milestoneIndex: 0, payment: { amount: 5000, date: "2026-07-20", method: "bank_transfer" } });
    await applyVariation(job.jobDir, job.quotes[2], ["Extra drainage", 2000]);
    await actions.revise(job.jobDir, 0);
    const revised = await deposit(job.jobDir);
    const current = revised.issuedRevision;
    assert.notEqual(current.invoiceNumber, job.number);

    const listed = await listInvoiceAmountDisagreements({ dataDir });
    const entry = listed.invoices.find((candidate) => candidate.invoiceNumber === job.number);
    assert.deepEqual([entry.status, entry.revision, entry.recorded.total, entry.storedPdf.total], ["superseded", 1, "5115.00", "3960.00"]);

    await settle(job.jobDir, { invoiceNumber: job.number, choose: "stored-pdf", total: "3960.00", reason: "The archived email was built against v1" });
    const after = await deposit(job.jobDir);
    const r1 = after.revisionHistory.find((revision) => revision.invoiceNumber === job.number);
    assert.deepEqual([r1.invoiceNumber, r1.revisionNumber, r1.total, r1.amountsSettlement.recorded.total], [job.number, 1, 3960, 5115]);
    assert.deepEqual(
      [after.issuedRevision.invoiceNumber, after.issuedRevision.revisionNumber, after.issuedRevision.total, after.total, after.amountDue],
      [current.invoiceNumber, current.revisionNumber, current.total, revised.total, revised.amountDue],
      "the current revision and what is owed are unchanged",
    );
    assert.deepEqual(await readPdf(job.jobDir, job.deposit.pdfPath), job.pdf);
    const report = await backfillInvoiceRows({ dataDir });
    assert.equal(report.jobsRefused, 0, JSON.stringify(report.mismatches));
    const row = report.entries[0].invoices.find((invoice) => invoice.number === job.number);
    assert.deepEqual([row.status, row.rows.total], ["credited", "3960.00"]);
  });

  describe("today's code keeps issued history (regressions, both directions)", () => {
    test("an issued snapshot is never re-allocated when the quote moves on, and a revision retires it unchanged", async () => {
      const dataDir = dataDirFor("keeps-snapshot");
      const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-keeps-snapshot", number: "2607-81", recordVersion: 1, pdfVersion: 1 });
      await actions.update(job.jobDir, 1, { dueDate: "2026-09-30" });
      const frozen = (await deposit(job.jobDir)).issuedRevision;
      const v3 = await applyVariation(job.jobDir, job.quotes[2], ["Extra drainage", 2000]);
      assert.equal(v3.version, 3);
      await actions.update(job.jobDir, 1, { dueDate: "2026-10-30" });
      await actions.update(job.jobDir, 0, { dueDate: "2026-07-31" });
      await act(job.jobDir, recordJobMilestonePayment, { milestoneIndex: 0, payment: { amount: 1000, date: "2026-10-01", method: "bank_transfer" } });
      const after = (await deposit(job.jobDir)).issuedRevision;
      assert.deepEqual([after.subtotal, after.gst, after.total, after.quoteVersion, after.pdfSha256], [frozen.subtotal, frozen.gst, frozen.total, frozen.quoteVersion, frozen.pdfSha256]);

      await actions.revise(job.jobDir, 0);
      const revised = await deposit(job.jobDir);
      const retired = revised.revisionHistory.find((entry) => entry.invoiceNumber === job.number);
      assert.deepEqual([retired.subtotal, retired.gst, retired.total, retired.pdfSha256], [frozen.subtotal, frozen.gst, frozen.total, frozen.pdfSha256]);
      assert.notEqual(revised.issuedRevision.invoiceNumber, job.number, "the change is a new revision under a new number");
      assert.deepEqual(await readPdf(job.jobDir, job.deposit.pdfPath), job.pdf, "the retired revision's PDF is the same bytes");
    });

    test("an issued PDF is never redrawn by later actions, whichever quote is current", async () => {
      const dataDir = dataDirFor("keeps-pdf");
      const job = await createLegacyVersionMismatchJob(dataDir, { id: "job-keeps-pdf", number: "2607-82", recordVersion: 1, pdfVersion: 1 });
      await actions.update(job.jobDir, 0, { dueDate: "2026-07-31" });
      const v3 = await applyVariation(job.jobDir, job.quotes[2], ["Extra drainage", 2000]);
      await actions.update(job.jobDir, 0, { dueDate: "2026-08-15" });
      await actions.pay(job.jobDir, 0, 100);
      await actions.update(job.jobDir, 1, { dueDate: "2026-10-30" });
      assert.equal(v3.version, 3);
      assert.deepEqual(await readPdf(job.jobDir, job.deposit.pdfPath), job.pdf);
      assert.equal((await deposit(job.jobDir)).issuedRevision.pdfSha256, sha256Hex(job.pdf));
    });
  });
});
