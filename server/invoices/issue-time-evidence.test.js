// Issued invoices whose record holds no issue time (the April 2026 shape,
// test-fixtures.js createAprilMilestoneJob), mapped with a time from the
// job's other records, strongest first, or refused with code no-issue-time
// when there is none. Synthetic data only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runAtomicJobGeneration } from "../job-generation.js";
import { readJobMeta } from "../job-meta-store.js";
import { recordIssuedQuoteDocuments } from "../quote-issuance.js";
import { mapMilestoneState } from "./from-milestones.js";
import { businessMidnight, findIssueTimes, printedIssueDate } from "./issue-time-evidence.js";
import { collectJobInvoices, syncJobInvoiceRows } from "./sync.js";
import { createAprilMilestoneJob } from "./test-fixtures.js";

const PRINTED = businessMidnight("2026-04-14");
const times = (mapped) => mapped.invoices.map((invoice) => [invoice.number, invoice.status, invoice.issuedAt, invoice.issuedOn]);
const sources = (mapped) => mapped.warnings.filter((warning) => warning.kind === "issue-time-from-evidence").map((warning) => [warning.number, warning.code]);

describe("issue times from evidence", () => {
  let dataDir;
  before(() => { dataDir = mkdtempSync(join(tmpdir(), "field-issue-times-")); });
  after(() => rmSync(dataDir, { recursive: true, force: true }));

  test("the April 2026 shape (authorised, no issue time, nothing paid) maps with the date its PDF prints, before and after the legacy freeze", async () => {
    for (const frozen of [false, true]) {
      const job = await createAprilMilestoneJob(dataDir, { id: `job-april-${frozen ? "frozen" : "record"}`, number: frozen ? "2604-91" : "2604-92", frozen });
      const meta = await readJobMeta(job.jobDir);
      // Without evidence (as main maps it): every milestone refused, by code.
      const bare = mapMilestoneState({ meta, basis: null });
      assert.deepEqual(bare.failures.map((failure) => [failure.kind, failure.code, failure.milestone, failure.number]), [0, 1, 2].map((index) => ["unmappable", "no-issue-time", index, job.milestones[index].invoiceNumber]));

      const { mapped } = await collectJobInvoices(job.jobDir);
      assert.deepEqual(mapped.failures, []);
      assert.deepEqual(times(mapped), job.milestones.map((milestone) => [milestone.invoiceNumber, "issued", PRINTED, "2026-04-14"]));
      assert.deepEqual(sources(mapped), job.milestones.map((milestone) => [milestone.invoiceNumber, "stored-pdf-date"]));
      for (const invoice of mapped.invoices) assert.match(invoice.note, /Issue time from the date its stored PDF prints, at midnight in the business time zone: Field recorded none when it was issued\.$/);
      assert.deepEqual(mapped.invoices.map((invoice) => invoice.total), ["3300.00", "4400.00", "3300.00"], "amounts as recorded");

      // The full check, PDF totals included, passes.
      const result = await syncJobInvoiceRows({ jobDir: job.jobDir, verifyIssued: true });
      assert.deepEqual(result.failures, []);
      assert.equal(result.ok, true);
    }
  });

  test("the date printed on the stored PDF: midnight that day in the business time zone (TZ)", async () => {
    const job = await createAprilMilestoneJob(dataDir, { id: "job-april-print", number: "2604-90" });
    assert.equal(printedIssueDate(job.pdfs[0]), "2026-04-14");
    assert.equal(printedIssueDate(Buffer.from("not a pdf")), null);
    assert.equal(businessMidnight("2026-04-14"), new Date(2026, 3, 14).toISOString());
  });

  test("older field: a one-milestone job's invoiceSentAt, from before milestone invoices", async () => {
    const job = await createAprilMilestoneJob(dataDir, { id: "job-april-older", number: "2604-93", schedule: [["Full payment", 100]], evidence: { invoiceSentAt: "2026-04-09T23:40:00.000Z", sentEmail: { 0: "2026-05-20T01:00:00.000Z" } } });
    const { mapped } = await collectJobInvoices(job.jobDir);
    assert.deepEqual(mapped.failures, []);
    assert.deepEqual(times(mapped), [["EI-2604-93-M1", "issued", "2026-04-09T23:40:00.000Z", "2026-04-09"]]);
    assert.deepEqual(sources(mapped), [["EI-2604-93-M1", "older-field"]]);
    assert.match(mapped.invoices[0].note, /invoiceSentAt/);

    // With more than one milestone, a job's invoiceSentAt names none of them.
    const many = await createAprilMilestoneJob(dataDir, { id: "job-april-older-many", number: "2604-94", evidence: { invoiceSentAt: "2026-04-09T23:40:00.000Z" } });
    assert.deepEqual(sources((await collectJobInvoices(many.jobDir)).mapped).map(([, source]) => source), ["stored-pdf-date", "stored-pdf-date", "stored-pdf-date"]);
  });

  test("issued document: the issued_documents row for the number on this job", async () => {
    const job = await createAprilMilestoneJob(dataDir, { id: "job-april-document", number: "2604-95", evidence: { sentEmail: { 1: "2026-05-20T01:00:00.000Z" } } });
    const issuedDocuments = {
      async findIssuedDocument({ documentType, number }) {
        if (documentType !== "invoice") return null;
        if (number === "EI-2604-95-M2") return { uid: "doc-m2", jobId: "job-april-document", documentType, number, issuedAt: "2026-04-20T03:00:00.000Z" };
        // Another job's document under the same number says nothing here.
        if (number === "EI-2604-95-M3") return { uid: "doc-other", jobId: "job-elsewhere", documentType, number, issuedAt: "2026-04-21T03:00:00.000Z" };
        return null;
      },
      async listJobDocuments() { return { documents: [] }; },
      async readIssuedDocument() { return null; },
    };
    const { mapped } = await collectJobInvoices(job.jobDir, { issuedDocuments });
    assert.deepEqual(times(mapped)[1], ["EI-2604-95-M2", "issued", "2026-04-20T03:00:00.000Z", "2026-04-20"]);
    assert.deepEqual(sources(mapped), [["EI-2604-95-M1", "stored-pdf-date"], ["EI-2604-95-M2", "issued-document"], ["EI-2604-95-M3", "stored-pdf-date"]]);
  });

  test("issuance ledger: the first delivery whose PDF names the number", async () => {
    const job = await createAprilMilestoneJob(dataDir, { id: "job-april-ledger", number: "2604-96", evidence: { sentEmail: { 0: "2026-05-20T01:00:00.000Z" } } });
    for (const issuedAt of ["2026-04-17T00:15:00.000Z", "2026-04-16T00:15:00.000Z"]) {
      await runAtomicJobGeneration(job.jobDir, async (staged) => {
        await recordIssuedQuoteDocuments({
          jobDir: staged,
          quoteVersion: 1,
          documentType: "invoice",
          issuedAt,
          deliveryResult: { messageId: `msg-ledger-${issuedAt}`, documentType: "invoice", to: ["customer@example.invalid"], subject: "Invoice EI-2604-96-M1" },
          quotePdf: job.pdfs[0],
        });
      });
    }
    const { mapped } = await collectJobInvoices(job.jobDir);
    assert.deepEqual(times(mapped)[0], ["EI-2604-96-M1", "issued", "2026-04-16T00:15:00.000Z", "2026-04-16"]);
    assert.deepEqual(sources(mapped)[0], ["EI-2604-96-M1", "issuance-ledger"]);
  });

  test("sent email: the first archived send of that invoice, over the activity log", async () => {
    const job = await createAprilMilestoneJob(dataDir, {
      id: "job-april-sent",
      number: "2604-97",
      evidence: { sentEmail: { 0: "2026-05-14T22:05:00.000Z", 2: "2026-06-01T00:00:00.000Z" }, activity: { 0: "2026-05-14T22:05:01.000Z" } },
    });
    const { mapped } = await collectJobInvoices(job.jobDir);
    assert.deepEqual(times(mapped), [
      ["EI-2604-97-M1", "issued", "2026-05-14T22:05:00.000Z", "2026-05-14"],
      ["EI-2604-97-M2", "issued", PRINTED, "2026-04-14"],
      ["EI-2604-97-M3", "issued", "2026-06-01T00:00:00.000Z", "2026-06-01"],
    ]);
    assert.deepEqual(sources(mapped).map(([, source]) => source), ["sent-email", "stored-pdf-date", "sent-email"]);
  });

  test("activity log: the first invoice.sent event naming the number (M1 never matches inside M1-R2 or M10)", async () => {
    const job = await createAprilMilestoneJob(dataDir, { id: "job-april-activity", number: "2604-98", evidence: { activity: { 1: "2026-04-22T05:00:00.000Z" } } });
    const { mapped } = await collectJobInvoices(job.jobDir);
    assert.deepEqual(times(mapped)[1], ["EI-2604-98-M2", "issued", "2026-04-22T05:00:00.000Z", "2026-04-22"]);
    assert.deepEqual(sources(mapped).map(([, source]) => source), ["stored-pdf-date", "activity-log", "stored-pdf-date"]);
    const found = await findIssueTimes({ jobDir: job.jobDir, jobId: "job-april-activity", meta: await readJobMeta(job.jobDir), wanted: [{ number: "EI-2604-98-M" }, { number: "EI-2604-98-M2-R2" }] });
    assert.equal(found.size, 0, "a number is matched as a whole word");
  });

  test("no evidence at all is still refused with code no-issue-time; a PDF naming another invoice is no evidence", async () => {
    const job = await createAprilMilestoneJob(dataDir, { id: "job-april-none", number: "2604-99", withPdf: false });
    const { mapped } = await collectJobInvoices(job.jobDir);
    assert.deepEqual(mapped.invoices, []);
    assert.deepEqual(mapped.failures.map((failure) => [failure.kind, failure.code, failure.milestone, failure.number]), [0, 1, 2].map((index) => ["unmappable", "no-issue-time", index, `EI-2604-99-M${index + 1}`]));
    assert.deepEqual(mapped.warnings.filter((warning) => warning.kind === "issue-time-from-evidence"), []);

    const other = await createAprilMilestoneJob(dataDir, { id: "job-april-other-pdf", number: "2604-89" });
    const found = await findIssueTimes({ jobDir: other.jobDir, jobId: "job-april-other-pdf", meta: await readJobMeta(other.jobDir), wanted: [{ number: "EI-2604-89-M2", pdfPath: other.milestones[0].pdfPath }] });
    assert.equal(found.size, 0, "M1's PDF says nothing about M2");
    await rm(join(other.jobDir, other.milestones[0].pdfPath));
    assert.equal((await findIssueTimes({ jobDir: other.jobDir, jobId: "job-april-other-pdf", meta: await readJobMeta(other.jobDir), wanted: [{ number: "EI-2604-89-M1", pdfPath: other.milestones[0].pdfPath }] })).size, 0);
  });
});
