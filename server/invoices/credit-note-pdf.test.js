// The credit (adjustment) note PDF (#28, step 4b) meets the ATO's
// requirements for an adjustment note: it says it is one; names the supplier
// and its ABN; names the recipient (the original here is over $1,000); has its
// date and number, the original invoice and the reason; and shows the amount
// of the adjustment, the GST adjustment and the price difference.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateCreditNotePdfBuffer } from "../quote-artifacts.js";
import { pdfTextRuns } from "../quotes/issued-totals.js";
import { invoiceQuote, landedMeta } from "./test-fixtures.js";

test("an adjustment note prints everything the ATO asks of one", async () => {
  const meta = { ...landedMeta({ id: "job-cn", number: "2610-04" }), siteAddress: "12 Sample Street, Exampleton SA 5000" };
  const quote = {
    ...invoiceQuote(meta, { rows: [["Retaining wall", 2000]] }),
    quoteCatalog: {
      id: "sample-default",
      currency: "AUD",
      gstRate: 0.1,
      businessProfile: { legalName: "Sample Earthworks Pty Ltd", abn: "11 111 111 111", address: "1 Example Road, Exampleton SA 5000", phone: "08 0000 0000", email: "accounts@example.invalid" },
    },
  };
  const bytes = await generateCreditNotePdfBuffer({
    meta,
    quote,
    reference: "JOB-2610-04",
    creditNote: {
      number: "CN-2026-10-1",
      issuedAt: "2026-10-13T02:00:00.000Z",
      reason: "Approved variation: rock clause on the north bench",
      currency: "AUD",
      subtotal: 1000,
      gst: 100,
      total: 1100,
      lines: [{ name: "Credit of INV-2026-10-1: Deposit: 50% of the quoted price", detail: "Quote EQ-2610-04, accepted 1 October 2026", subtotal: 1000, gst: 100, total: 1100 }],
    },
    credited: { number: "INV-2026-10-1", issuedAt: "2026-10-01T02:00:00.000Z", subtotal: 1000, gst: 100, total: 1100 },
    replacement: { number: "INV-2026-10-2", subtotal: 1100, gst: 110, total: 1210 },
  });
  const runs = pdfTextRuns(bytes);
  const has = (text) => assert.ok(runs.some((run) => run.includes(text)), `the PDF prints "${text}"`);
  has("Adjustment note");
  has("CN-2026-10-1");
  has("Sample Earthworks Pty Ltd");
  has("ABN 11 111 111 111");
  has("ISSUED TO");
  has("Sam Customer");
  has("12 Sample Street, Exampleton SA 5000");
  has("Issued: 13 October 2026");
  has("Original tax invoice: INV-2026-10-1");
  has("Job reference: JOB-2610-04");
  has("Replaced by: INV-2026-10-2");
  has("Approved variation: rock clause on the north bench");
  has("Credit of INV-2026-10-1: Deposit: 50% of the quoted price");
  has("Quote EQ-2610-04, accepted 1 October 2026");
  assert.ok(!runs.some((run) => / v\d\b/.test(run)), "no bare quote version");
  has("Adjustment (ex GST)");
  has("GST adjustment");
  has("-$100.00");
  has("Total credited");
  has("-$1,100.00");
  has("PRICE DIFFERENCE");
  has("Original invoice INV-2026-10-1");
  has("Adjusted price: invoice INV-2026-10-2");
  // The difference: $100.00 ex GST, $10.00 GST, $110.00 in all.
  const difference = runs.indexOf("Difference");
  assert.deepEqual(runs.slice(difference + 1, difference + 4), ["$100.00", "$10.00", "$110.00"]);
});
