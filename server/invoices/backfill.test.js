// The invoice-row backfill and its verification (#27) on a fixture data
// directory of jobs built by the real milestone actions: every issued invoice
// checked against its stored revision and the totals its PDF printed, the
// payments against the amount paid, the invoices against the quote; a planted
// mismatch (a revision whose stored money no longer matches its PDF) and an
// over-claim are refused with both numbers and nothing written for those jobs;
// a second run writes nothing new. Plus reading totals back from a real
// invoice PDF.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { runAtomicJobGeneration, resolveActiveJobGeneration } from "../job-generation.js";
import { backfillInvoiceRows } from "./backfill.js";
import { createInvoiceRowService } from "./invoice-rows.js";
import { extractInvoicePdfTotals } from "./issued-totals.js";
import { invoiceQuote, scenarios } from "./test-fixtures.js";

const run = promisify(execFile);
const SCRIPT = new URL("../../scripts/backfill-invoice-rows.js", import.meta.url).pathname;

async function editState(jobDir, edit) {
  await runAtomicJobGeneration(jobDir, async (staged) => {
    const path = join(staged, "milestone-invoices/state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    edit(state);
    await writeFile(path, JSON.stringify(state, null, 2));
  });
}

describe("invoice-row backfill", () => {
  let dataDir;
  let t;
  let service;
  let documents;
  const dirs = {};

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "field-invoice-backfill-"));
    for (const name of Object.keys(scenarios)) dirs[name] = await scenarios[name](dataDir);
    t = await createTestDb();
    service = createInvoiceRowService({ db: t.db, orgUid: DEFAULT_ORG_UID });
    documents = createIssuedDocumentService({ db: t.db, orgUid: DEFAULT_ORG_UID });
  });
  after(async () => {
    await t.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("reads the claim back from a real invoice PDF; a PDF without one gives null", async () => {
    const jobDir = await resolveActiveJobGeneration(dirs.single);
    const pdf = readFileSync(join(jobDir, "milestone-invoices/EI-2605-01-M1.pdf"));
    assert.deepEqual(extractInvoicePdfTotals(pdf), { subtotal: "1000.00", taxTotal: "100.00", total: "1100.00" });
    assert.equal(extractInvoicePdfTotals(Buffer.from("%PDF-1.3 not a real pdf")), null);
  });

  test("checking the files: every issued invoice equals its revision and its PDF", async () => {
    const report = await backfillInvoiceRows({ dataDir });
    assert.deepEqual([report.jobs, report.jobsWithMilestones, report.jobsRefused], [7, 7, 0]);
    assert.deepEqual(report.mismatches, []);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.byStatus, { issued: 6, draft: 5, paid: 1, credited: 2 });
    // Every issued invoice was read back from a PDF; the one warning is the
    // payment on the deposit revised in place, which stays where it was recorded.
    assert.deepEqual(report.warnings.map((warning) => [warning.jobId, warning.kind, warning.number]), [["job-revised-paid", "payment-on-superseded", "EI-2605-07-M1"]]);
    for (const entry of report.entries) {
      for (const invoice of entry.invoices.filter((candidate) => candidate.status !== "draft")) {
        const printed = invoice.issued.find((copy) => copy.source === "revision-pdf")?.totals;
        assert.deepEqual(printed, invoice.rows, `${invoice.number}: rows equal the PDF`);
      }
    }
  });

  test("a run writes every job, linking issued documents; a second run writes nothing new", async () => {
    const pdf = readFileSync(join(await resolveActiveJobGeneration(dirs.paid), "milestone-invoices/EI-2605-03-M1.pdf"));
    const { document } = await documents.recordIssuedDocument({
      jobId: "job-paid", documentType: "invoice", number: "EI-2605-03-M1", revision: 1,
      pdfBytes: pdf, issuedAt: "2026-05-02T00:00:00.000Z", source: "invoice-revision-backfill",
    });
    const dry = await backfillInvoiceRows({ dataDir, service, issuedDocuments: documents, dryRun: true });
    assert.deepEqual(dry.actions, { "would-write": 7 });
    assert.deepEqual((await service.readJob("job-paid")).invoices, [], "a dry run writes nothing");

    const report = await backfillInvoiceRows({ dataDir, service, issuedDocuments: documents });
    assert.deepEqual(report.actions, { written: 7 });
    // No credit note is invented for the revisions made in place, and no
    // payment moves.
    assert.deepEqual(report.written, {
      milestones: { created: 12 },
      invoices: { created: 14 },
      creditNotes: {},
      payments: { created: 3 },
      allocations: {},
      receipts: { created: 1 },
    });
    const paid = await service.readJob("job-paid");
    assert.equal(paid.invoices[0].issuedDocumentUid, document.uid);
    const entry = report.entries.find((candidate) => candidate.jobId === "job-paid");
    assert.deepEqual(entry.invoices[0].issued.map((copy) => copy.source), ["issued-document"], "the same bytes are checked once");

    const again = await backfillInvoiceRows({ dataDir, service, issuedDocuments: documents });
    assert.deepEqual(again.actions, { unchanged: 7 });
    assert.deepEqual(again.written, { milestones: { unchanged: 12 }, invoices: { unchanged: 14 }, creditNotes: {}, payments: { unchanged: 3 }, allocations: {}, receipts: { unchanged: 1 } });
  });

  test("a planted mismatch and an over-claim are refused with both numbers, and nothing is written for them", async () => {
    // job-deposit: the deposit's stored revision no longer matches its PDF.
    await editState(dirs.depositCompletion, (state) => {
      const deposit = state.milestoneInvoices[0];
      for (const target of [deposit, deposit.issuedRevision]) Object.assign(target, { subtotal: 900, gst: 90, total: 990 });
    });
    // job-single: the quote was cut below what was already invoiced.
    await runAtomicJobGeneration(dirs.single, async (staged) => {
      const meta = JSON.parse(await readFile(join(staged, "meta.json"), "utf8"));
      await writeFile(join(staged, "quote.json"), JSON.stringify(invoiceQuote(meta, { rows: [["Driveway, reduced", 500]] }), null, 2));
    });
    const fresh = await createTestDb();
    try {
      const freshService = createInvoiceRowService({ db: fresh.db, orgUid: DEFAULT_ORG_UID });
      const report = await backfillInvoiceRows({ dataDir, service: freshService });
      assert.equal(report.jobsRefused, 2);
      assert.deepEqual(report.actions, { refused: 2, written: 5 });
      const deposit = report.mismatches.filter((entry) => entry.jobId === "job-deposit");
      assert.deepEqual(deposit.map((entry) => [entry.number, entry.against, entry.field, entry.rows, entry.shown]), [
        ["EI-2605-02-M1", "revision-pdf", "subtotal", "900.00", "925.50"],
        ["EI-2605-02-M1", "revision-pdf", "taxTotal", "90.00", "92.55"],
        ["EI-2605-02-M1", "revision-pdf", "total", "990.00", "1018.05"],
      ]);
      const single = report.mismatches.filter((entry) => entry.jobId === "job-single");
      assert.deepEqual(single.map((entry) => [entry.kind, entry.rows, entry.shown]), [["reconcile", "1100.00", "550.00"]]);
      assert.deepEqual((await freshService.readJob("job-deposit")).invoices, []);
      assert.deepEqual((await freshService.readJob("job-single")).milestones, []);
      assert.equal((await freshService.readJob("job-paid")).invoices.length, 2, "the other jobs are written");
    } finally {
      await fresh.close();
    }

    // The script: --dry-run without a database checks the files and exits 2.
    const env = { PATH: process.env.PATH, HOME: dataDir, FIELD_CONFIG: join(dataDir, "no-config.json") };
    const result = await run(process.execPath, [SCRIPT, "--dry-run", "--json", "--data-dir", dataDir], { env }).catch((error) => error);
    assert.equal(result.code, 2);
    const scripted = JSON.parse(result.stdout);
    assert.equal(scripted.jobsRefused, 2);
    const plain = await run(process.execPath, [SCRIPT, "--data-dir", dataDir], { env }).catch((error) => error);
    assert.equal(plain.code, 1, "a real run needs a database");
    assert.match(plain.stderr, /no database configured/);
  });
});
