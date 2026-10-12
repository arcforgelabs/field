// The milestone invoice PDF (#28, step 4b): one claim line per milestone it
// bills, against the quote it references, with its subtotal, GST and total;
// no quote schedule; and what the ATO asks of a tax invoice: "Tax invoice",
// the supplier and its ABN, the date, a description and the GST. Its totals
// read back as the invoice rows and the backfill read them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMilestoneInvoiceDocument } from "../job-documents.js";
import { generateQuotePdfBuffer, invoiceClaimLineName } from "../quote-artifacts.js";
import { pdfTextRuns } from "../quotes/issued-totals.js";
import { extractInvoicePdfTotals } from "./issued-totals.js";
import { invoiceQuote, landedMeta } from "./test-fixtures.js";

function job() {
  const meta = { ...landedMeta({ id: "job-pdf", number: "2610-05" }), siteAddress: "12 Sample Street, Exampleton SA 5000" };
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

test("an issued milestone invoice is a tax invoice with one claim line against the quote, not the quote's schedule", async () => {
  const { meta, quote, deposit } = job();
  const prepared = prepareMilestoneInvoiceDocument({ meta, quote, milestoneInvoice: deposit });
  const bytes = await generateQuotePdfBuffer({ meta: prepared.meta, quote: prepared.quote, documentType: "invoice" });
  const runs = pdfTextRuns(bytes);
  const has = (text) => assert.ok(runs.some((run) => run.includes(text)), `the PDF prints "${text}"`);
  has("Tax invoice");
  has("INV-2026-10-4");
  has("Sample Earthworks Pty Ltd");
  has("ABN 11 111 111 111");
  has("Issued: 12 October 2026");
  has("Job reference: 2610-05");
  has("Sam Customer");
  has("CLAIM");
  // The claim line, with its subtotal, GST and total.
  const line = runs.indexOf("Deposit, 50 % of EQ-2610-05 v2");
  assert.ok(line >= 0, runs.join(" | "));
  assert.deepEqual(runs.slice(line + 2, line + 5), ["$2,000.00", "$200.00", "$2,200.00"]);
  has("QUOTE SUMMARY");
  has("EQ-2610-05 v2");
  assert.ok(!runs.some((run) => run.includes("CONTRACT SCHEDULE")), "no quote schedule");
  assert.ok(!runs.includes("Retaining wall") && !runs.includes("Drainage"), "the quote's lines are not printed");
  assert.deepEqual(extractInvoicePdfTotals(bytes), { subtotal: "2000.00", taxTotal: "200.00", total: "2200.00" });
});

test("a draft preview is not a tax invoice and has no number yet", async () => {
  const { meta, quote, completion } = job();
  const prepared = prepareMilestoneInvoiceDocument({ meta, quote, milestoneInvoice: completion });
  const runs = pdfTextRuns(await generateQuotePdfBuffer({ meta: prepared.meta, quote: prepared.quote, documentType: "invoice" }));
  assert.ok(!runs.some((run) => run.includes("Tax invoice")));
  assert.ok(runs.includes("Invoice"));
  assert.ok(runs.includes("Draft, not yet issued"));
  assert.ok(runs.includes("Completion, 50 % of EQ-2610-05 v2"));
});

test("the claim line is named the way the invoice rows name it", () => {
  assert.equal(invoiceClaimLineName({ milestoneLabel: "Deposit", percentage: 50, reference: "EQ-2610-03" }, 2), "Deposit, 50 % of EQ-2610-03 v2");
  assert.equal(invoiceClaimLineName({ milestoneLabel: "Deposit", percentage: 12.5, reference: "EQ-2610-03" }, 1), "Deposit, 12.5 % of EQ-2610-03 v1");
  assert.equal(invoiceClaimLineName({ milestoneLabel: "Deposit", percentage: 0, fixedTotal: 1000, reference: "EQ-2610-03" }, 1), "Deposit of EQ-2610-03 v1");
});
