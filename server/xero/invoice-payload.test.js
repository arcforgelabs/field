// A Field invoice as a Xero invoice (#93): the reference, the lines, GST to
// the cent, and the attachment's file name.
import assert from "node:assert/strict";
import test from "node:test";
import { attachmentFileName, buildXeroInvoice, contactFor, lineTaxCents, totalsMatch, xeroReference } from "./invoice-payload.js";

const SETTINGS = { salesAccountCode: "200", taxType: "OUTPUT" };

function line(overrides) {
  return { sortOrder: 0, lineType: "item", name: "Item", description: null, quantity: "1.0000", unitSell: "100.0000", taxRate: "10.000", lineTotal: "100.00", ...overrides };
}

test("the reference names the job and the quote", () => {
  assert.equal(xeroReference({ jobReference: "2610-07", quoteNumber: "EQ-2610-07", quoteVersion: 2 }), "Job 2610-07 · Quote EQ-2610-07 v2");
  assert.equal(xeroReference({ jobReference: "2610-07", quoteNumber: "EQ-2610-07", quoteVersion: 1 }), "Job 2610-07 · Quote EQ-2610-07", "never v1");
  assert.equal(xeroReference({ jobReference: "2610-07" }), "Job 2610-07");
  assert.equal(xeroReference({ quoteNumber: "EQ-2610-07" }), "Quote EQ-2610-07");
  assert.equal(xeroReference({}), null);
});

test("lines: quantity and unit price when they give the amount, else 1 x the amount; no GST lines are EXEMPTOUTPUT; notes are text", () => {
  const invoice = { number: "INV-2026-10-4", issuedAt: "2026-10-13T01:00:00.000Z", issuedOn: null, dueOn: "2026-10-27", currency: "AUD", subtotal: "357.55", taxTotal: "25.75", total: "383.30" };
  const built = buildXeroInvoice({
    invoice,
    contactId: "c-1",
    reference: "Job 2610-07",
    settings: SETTINGS,
    mode: "draft",
    lines: [
      line({ sortOrder: 2, name: "Retaining wall", quantity: "2.5000", unitSell: "41.3333", lineTotal: "103.33" }),
      line({ sortOrder: 0, name: "Excavation", description: "Bobcat, 4 hours", quantity: "4.0000", unitSell: "38.7500", lineTotal: "155.00" }),
      line({ sortOrder: 1, name: "Permit fee", taxRate: "0.000", unitSell: "99.1700", lineTotal: "99.17" }),
      line({ sortOrder: 3, lineType: "note", name: "Access via the side gate", unitSell: null, lineTotal: "0.00" }),
    ],
  });
  assert.equal(built.Type, "ACCREC");
  assert.equal(built.InvoiceNumber, "INV-2026-10-4");
  assert.equal(built.Status, "DRAFT");
  assert.equal(built.DueDate, "2026-10-27");
  // GST per line is 15.50 + 10.33 = 25.83; the invoice was issued with
  // 25.75, so the 8 cents come off the largest line with GST.
  assert.deepEqual(built.LineItems, [
    { Description: "Excavation\nBobcat, 4 hours", Quantity: 4, UnitAmount: 38.75, AccountCode: "200", TaxType: "OUTPUT", TaxAmount: 15.42 },
    { Description: "Permit fee", Quantity: 1, UnitAmount: 99.17, AccountCode: "200", TaxType: "EXEMPTOUTPUT", TaxAmount: 0 },
    // 2.5 x 41.3333 rounds to the 103.33 Field printed: sent as it is.
    { Description: "Retaining wall", Quantity: 2.5, UnitAmount: 41.3333, AccountCode: "200", TaxType: "OUTPUT", TaxAmount: 10.33 },
    { Description: "Access via the side gate" },
  ]);

  // A printed amount that quantity x unit price does not give: 1 x the amount.
  const printed = buildXeroInvoice({
    invoice: { ...invoice, subtotal: "100.05", taxTotal: "10.01", total: "110.06" },
    contactId: "c-1",
    reference: null,
    settings: SETTINGS,
    mode: "authorised",
    lines: [line({ name: "Claim", quantity: "3.0000", unitSell: "33.3333", lineTotal: "100.05" })],
  });
  assert.equal(printed.Status, "AUTHORISED");
  assert.equal(printed.Reference, undefined);
  assert.deepEqual(printed.LineItems[0], { Description: "Claim", Quantity: 1, UnitAmount: 100.05, AccountCode: "200", TaxType: "OUTPUT", TaxAmount: 10.01 });
});

test("GST: per line, with the difference to the invoice's GST on the largest line with GST", () => {
  const lines = [
    { amountCents: 15500, rate: 10, taxable: true },
    { amountCents: 9917, rate: 0, taxable: false },
    { amountCents: 10333, rate: 10, taxable: true },
  ];
  assert.deepEqual(lineTaxCents(lines, "25.83"), [1550, 0, 1033]);
  assert.deepEqual(lineTaxCents(lines, "25.84"), [1551, 0, 1033]);
  assert.throws(() => lineTaxCents([{ amountCents: 100, rate: 0, taxable: false }], "0.10"), (error) => error.code === "XERO_GST_WITHOUT_LINE");
});

test("totals match only to the cent", () => {
  const invoice = { subtotal: "333.33", taxTotal: "33.34", total: "366.67" };
  assert.equal(totalsMatch(invoice, { SubTotal: 333.33, TotalTax: 33.34, Total: 366.67 }), true);
  assert.equal(totalsMatch(invoice, { SubTotal: 333.33, TotalTax: 33.33, Total: 366.66 }), false);
});

test("attachment names and the contact", () => {
  assert.equal(attachmentFileName("INV-2026-10-4"), "INV-2026-10-4.pdf");
  assert.equal(attachmentFileName('EI/2501:"M1"'), "EI-2501--M1-.pdf");
  assert.deepEqual(contactFor({ details: { customer: { name: " Synthetic Co ", email: "a@b.invalid" } } }), { name: "Synthetic Co", email: "a@b.invalid" });
  assert.deepEqual(contactFor({ details: { customer: { email: "a@b.invalid" } } }), { name: "a@b.invalid", email: "a@b.invalid" });
  assert.throws(() => contactFor({ details: { customer: {} } }), (error) => error.code === "XERO_NO_CUSTOMER");
});
