// The milestone invoice PDF (#28, step 4b): one claim line per milestone it
// bills, in plain words, with the quote on a quieter line; its subtotal, GST
// and total; a two-column quote summary; no quote schedule; and what the ATO
// asks of a tax invoice: "Tax invoice", the supplier and its ABN, the date, a
// description and the GST. Its totals read back as the invoice rows and the
// backfill read them. A pre-4b invoice drawn again because its PDF was lost
// keeps its old layout, marked "Reconstructed copy" (owner, 2026-10-13).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareMilestoneInvoiceDocument } from "../job-documents.js";
import { generateQuotePdfBuffer } from "../quote-artifacts.js";
import { pdfTextRuns } from "../quotes/issued-totals.js";
import { extractInvoicePdfTotals } from "./issued-totals.js";
import { invoiceQuote, landedMeta } from "./test-fixtures.js";

// Midday UTC: the same calendar day in every time zone the tests run in.
const ACCEPTED_AT = "2026-09-14T12:00:00.000Z";

function job() {
  const meta = { ...landedMeta({ id: "job-pdf", number: "2610-05" }), landedAt: ACCEPTED_AT, siteAddress: "12 Sample Street, Exampleton SA 5000" };
  const quote = {
    ...invoiceQuote(meta, { version: 2, rows: [["Retaining wall", 3000], ["Drainage", 1000]] }),
    quoteCatalog: {
      id: "sample-default",
      currency: "AUD",
      gstRate: 0.1,
      businessProfile: { legalName: "Sample Earthworks Pty Ltd", abn: "11 111 111 111", address: "1 Example Road, Exampleton SA 5000", phone: "08 0000 0000", email: "accounts@example.invalid" },
    },
  };
  const deposit = {
    id: "m1",
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    invoiceNumber: "INV-2026-10-4",
    receiptNumber: "ER-2610-05-M1",
    reference: "EQ-2610-05",
    percentage: 50,
    subtotal: 2000,
    gst: 200,
    total: 2200,
    currency: "AUD",
    issuedAt: "2026-10-12T02:00:00.000Z",
    status: "authorised",
    payments: [],
    issuedRevision: { revisionNumber: 1, invoiceNumber: "INV-2026-10-4", jobReference: "2610-05", quoteVersion: 2, issuedAt: "2026-10-12T02:00:00.000Z", subtotal: 2000, gst: 200, total: 2200, currency: "AUD", lineItems: [] },
  };
  const completion = { ...deposit, id: "m2", milestoneIndex: 1, milestoneLabel: "Completion", invoiceNumber: "EI-2610-05-M2", status: "draft", issuedAt: null, issuedRevision: null };
  return { meta: { ...meta, milestoneInvoices: [deposit, completion] }, quote, deposit, completion };
}

async function render({ meta, quote, milestoneInvoice, ...options }) {
  const prepared = prepareMilestoneInvoiceDocument({ meta, quote, milestoneInvoice });
  const bytes = await generateQuotePdfBuffer({ meta: prepared.meta, quote: prepared.quote, documentType: "invoice", ...options });
  return { bytes, runs: pdfTextRuns(bytes) };
}

function expectPrinted(runs) {
  return (text) => assert.ok(runs.some((run) => run.includes(text)), `the PDF prints "${text}": ${runs.join(" | ")}`);
}

const NO_VERSION_LABEL = /\bv\d+\b/;

test("an issued milestone invoice is a tax invoice with one claim line in plain words, not the quote's schedule", async () => {
  const { meta, quote, deposit } = job();
  const { bytes, runs } = await render({ meta, quote, milestoneInvoice: deposit });
  const has = expectPrinted(runs);
  has("Tax invoice");
  has("INV-2026-10-4");
  has("Sample Earthworks Pty Ltd");
  has("ABN 11 111 111 111");
  has("Issued: 12 October 2026");
  has("Job reference: 2610-05");
  has("Sam Customer");
  has("CLAIM");
  // The claim line, its quote on a quieter line, and its subtotal, GST and total.
  const line = runs.indexOf("Deposit: 50% of the quoted price");
  assert.ok(line >= 0, runs.join(" | "));
  assert.equal(runs[line + 1], "Quote EQ-2610-05, accepted 14 September 2026");
  assert.deepEqual(runs.slice(line + 2, line + 5), ["$2,000.00", "$200.00", "$2,200.00"]);
  assert.ok(!runs.some((run) => run.includes("CONTRACT SCHEDULE")), "no quote schedule");
  assert.ok(!runs.includes("Retaining wall") && !runs.includes("Drainage"), "the quote's lines are not printed");
  assert.ok(!runs.some((run) => NO_VERSION_LABEL.test(run)), `no "v1" anywhere: ${runs.join(" | ")}`);
  assert.ok(!runs.includes("Reconstructed copy"));
  assert.ok(runs.join(" ").includes("Milestone 1 of 2 for Quote EQ-2610-05, accepted 14 September 2026."), "the milestone reference in the same words");
  assert.deepEqual(extractInvoicePdfTotals(bytes), { subtotal: "2000.00", taxTotal: "200.00", total: "2200.00" });
});

test("the quote summary: the quote, then contract value, previously claimed, this claim and what remains, GST said once", async () => {
  const { meta, quote, deposit } = job();
  const { runs } = await render({ meta, quote, milestoneInvoice: deposit });
  const at = runs.indexOf("QUOTE SUMMARY");
  assert.ok(at >= 0, runs.join(" | "));
  assert.deepEqual(runs.slice(at, at + 11), [
    "QUOTE SUMMARY",
    "All amounts include GST",
    "Quote EQ-2610-05, accepted 14 September 2026",
    "Contract value", "$4,400.00",
    "Previously claimed", "$0.00",
    "This claim", "$2,200.00",
    "Remaining after this claim", "$2,200.00",
  ]);
  assert.equal(runs.filter((run) => run.includes("include GST")).length, 1, "GST is said once");
});

test("the quote names its revision only when the customer was sent more than one version", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-invoice-pdf-"));
  try {
    const { meta, quote, deposit } = job();
    const sends = (versions) => writeFile(join(jobDir, "quote-issuance.json"), JSON.stringify({ version: 1, records: versions.map((quoteVersion, index) => ({ id: `r${index}`, quoteVersion, documentType: "quote", issuedAt: "2026-09-01T02:00:00.000Z" })) }));
    await sends([2]);
    let { runs } = await render({ meta, quote, milestoneInvoice: deposit, jobDir });
    assert.ok(runs.includes("Quote EQ-2610-05, accepted 14 September 2026"), runs.join(" | "));
    await sends([1, 2]);
    ({ runs } = await render({ meta, quote, milestoneInvoice: deposit, jobDir }));
    assert.equal(runs.filter((run) => run === "Quote EQ-2610-05, revision 2, accepted 14 September 2026").length, 2, "on the claim line and in the summary");
    assert.ok(runs.join(" ").includes("Milestone 1 of 2 for Quote EQ-2610-05, revision 2, accepted 14 September 2026."), "and in the milestone reference");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a quote that was sent but not accepted says sent", async () => {
  const { meta, quote, deposit } = job();
  const sent = { ...meta, pipelineStage: "sent", deliveryStatus: "sent", landedAt: null, quoteSentAt: ACCEPTED_AT };
  const { runs } = await render({ meta: sent, quote, milestoneInvoice: deposit });
  assert.ok(runs.includes("Quote EQ-2610-05, sent 14 September 2026"), runs.join(" | "));
});

test("a draft preview is not a tax invoice and has no number yet", async () => {
  const { meta, quote, completion } = job();
  const { runs } = await render({ meta, quote, milestoneInvoice: completion });
  assert.ok(!runs.some((run) => run.includes("Tax invoice")));
  assert.ok(runs.includes("Invoice"));
  assert.ok(runs.includes("Draft, not yet issued"));
  assert.ok(runs.includes("Completion: 50% of the quoted price"), runs.join(" | "));
});

test("a pre-4b invoice drawn again keeps the layout it was issued with, marked as a reconstructed copy", async () => {
  const { meta, quote, deposit } = job();
  const legacy = {
    ...deposit,
    invoiceNumber: "EI-2610-05-M1",
    issuedRevision: { ...deposit.issuedRevision, invoiceNumber: "EI-2610-05-M1", jobReference: null },
  };
  const { bytes, runs } = await render({ meta: { ...meta, milestoneInvoices: [legacy, meta.milestoneInvoices[1]] }, quote, milestoneInvoice: legacy, reconstructed: true });
  const has = expectPrinted(runs);
  has("Reconstructed copy");
  has("EI-2610-05-M1");
  has("CONTRACT SCHEDULE");
  has("Retaining wall");
  has("THIS CLAIM");
  assert.ok(runs.includes("Invoice") && !runs.includes("Tax invoice"), "the title it was issued with");
  assert.ok(!runs.includes("QUOTE SUMMARY"), "not the step 4b layout");
  assert.deepEqual(extractInvoicePdfTotals(bytes), { subtotal: "2000.00", taxTotal: "200.00", total: "2200.00" });
});

test("an INV invoice drawn again keeps the step 4b layout, also marked as a reconstructed copy", async () => {
  const { meta, quote, deposit } = job();
  const { runs } = await render({ meta, quote, milestoneInvoice: deposit, reconstructed: true });
  assert.ok(runs.includes("Reconstructed copy"));
  assert.ok(runs.includes("Tax invoice"));
  assert.ok(runs.includes("QUOTE SUMMARY"));
  assert.ok(!runs.some((run) => run.includes("CONTRACT SCHEDULE")));
});
