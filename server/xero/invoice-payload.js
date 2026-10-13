// A Field invoice as a Xero invoice (#93, phase 1). Pure: the sync
// (invoice-sync.js) reads the rows, this builds what Xero is sent.
//
//   Type             ACCREC (a sales invoice)
//   InvoiceNumber    Field's number, as issued (INV-2026-10-1)
//   Reference        the job and the quote: "Job 2610-07 · Quote EQ-2610-07 v2"
//   Status           DRAFT, or AUTHORISED (approved; Xero does not email it)
//   Date, DueDate    the issue date and the due date Field holds (the issue
//                    date when there is none: Xero needs a due date to approve)
//   LineAmountTypes  Exclusive: amounts are before GST, as Field's rows are
//   LineItems        one per invoice line: its description, quantity and unit
//                    price (or quantity 1 and its amount, when the amount was
//                    printed rather than computed), the sales account code,
//                    the GST tax type (EXEMPTOUTPUT for a line without GST)
//                    and the GST Field calculated
//
// GST is sent per line so that Xero's totals are Field's to the cent: each
// line's GST is round(amount x rate, 2), and the difference to the GST the
// invoice was issued with (a milestone's share of the quote's GST can differ
// by a cent) goes on the largest line with GST.

const NO_GST_TAX_TYPE = "EXEMPTOUTPUT";
const DESCRIPTION_MAX = 4000;
const REFERENCE_MAX = 255;

/** Cents, from a numeric string or number. */
export function cents(value) {
  return Math.round(Number(value) * 100);
}

function amount(centsValue) {
  return Number((centsValue / 100).toFixed(2));
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** "Job 2610-07 · Quote EQ-2610-07 v2", from what the invoice row and its quote say. */
export function xeroReference({ jobReference = null, quoteNumber = null, quoteVersion = null }) {
  const parts = [];
  if (text(jobReference)) parts.push(`Job ${text(jobReference)}`);
  if (text(quoteNumber)) parts.push(`Quote ${text(quoteNumber)}${Number(quoteVersion) > 0 ? ` v${Number(quoteVersion)}` : ""}`);
  const reference = parts.join(" · ");
  return reference ? reference.slice(0, REFERENCE_MAX) : null;
}

/** YYYY-MM-DD of a timestamp in this server's time zone: the date the PDF prints (invoices/numbers.js). */
export function localDate(at) {
  const date = at instanceof Date ? at : new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class XeroPayloadError extends Error {
  constructor(code, reason) {
    super(`Xero payload: ${code}`);
    this.name = "XeroPayloadError";
    this.code = code;
    this.reason = reason;
    this.retryable = false;
  }
}

/**
 * Each line's GST in cents: round(amount x rate) per line with GST, the
 * difference to the invoice's GST on the largest of them.
 */
export function lineTaxCents(lines, taxTotal) {
  const taxes = lines.map((line) => (line.taxable ? Math.round((line.amountCents * line.rate) / 100) : 0));
  const target = cents(taxTotal);
  const difference = target - taxes.reduce((sum, value) => sum + value, 0);
  if (difference !== 0) {
    let largest = -1;
    lines.forEach((line, index) => {
      if (line.taxable && (largest < 0 || line.amountCents > lines[largest].amountCents)) largest = index;
    });
    if (largest < 0) throw new XeroPayloadError("XERO_GST_WITHOUT_LINE", "The invoice has GST but no line with a GST rate, so Xero could not show the same GST.");
    taxes[largest] += difference;
  }
  return taxes;
}

/**
 * The Xero invoice for one Field invoice. `invoice` and `lines` are the rows
 * (invoices, invoice_lines); `settings` the connection's (salesAccountCode,
 * taxType); `mode` draft or authorised.
 */
export function buildXeroInvoice({ invoice, lines, contactId, reference, settings, mode }) {
  const printable = [...lines].sort((a, b) => a.sortOrder - b.sortOrder);
  const priced = printable.map((line) => {
    const rate = Number(line.taxRate) || 0;
    return { line, amountCents: cents(line.lineTotal), rate, taxable: line.lineType !== "note" && rate > 0 };
  });
  const taxes = lineTaxCents(priced, invoice.taxTotal);
  const lineItems = priced.map(({ line, amountCents, taxable }, index) => {
    const description = [text(line.name), text(line.description)].filter(Boolean).join("\n").slice(0, DESCRIPTION_MAX) || "Invoice line";
    if (line.lineType === "note") return { Description: description };
    const quantity = Number(line.quantity);
    const unit = line.unitSell == null ? null : Number(line.unitSell);
    // Quantity x unit price when that is the amount Field printed; else 1 x the amount.
    const exact = unit != null && Number.isFinite(quantity) && quantity > 0 && Math.round(quantity * unit * 100) === amountCents;
    return {
      Description: description,
      Quantity: exact ? quantity : 1,
      UnitAmount: exact ? unit : amount(amountCents),
      AccountCode: settings.salesAccountCode,
      TaxType: taxable ? settings.taxType : NO_GST_TAX_TYPE,
      TaxAmount: amount(taxes[index]),
    };
  });
  if (!lineItems.some((item) => item.AccountCode)) throw new XeroPayloadError("XERO_NO_LINES", "The invoice has no priced line to send to Xero.");
  const date = invoice.issuedOn || localDate(invoice.issuedAt);
  return {
    Type: "ACCREC",
    Contact: { ContactID: contactId },
    InvoiceNumber: invoice.number,
    ...(reference ? { Reference: reference } : {}),
    Date: date,
    DueDate: invoice.dueOn || date,
    LineAmountTypes: "Exclusive",
    CurrencyCode: invoice.currency || "AUD",
    Status: mode === "authorised" ? "AUTHORISED" : "DRAFT",
    LineItems: lineItems,
  };
}

/** Do Xero's totals equal Field's, to the cent? */
export function totalsMatch(invoice, xeroInvoice) {
  return cents(xeroInvoice?.Total) === cents(invoice.total)
    && cents(xeroInvoice?.SubTotal) === cents(invoice.subtotal)
    && cents(xeroInvoice?.TotalTax) === cents(invoice.taxTotal);
}

/** A file name Xero accepts (no < > : " / \ | ? * + or control characters). */
export function attachmentFileName(number) {
  const clean = String(number || "invoice").replace(/[<>:"/\\|?*+\u0000-\u001f]/g, "-").slice(0, 100);
  return `${clean}.pdf`;
}

/** The customer for the Xero contact, from what the issued document recorded. */
export function contactFor({ details = null, quoteCustomer = null }) {
  const customer = { ...(quoteCustomer || {}), ...(details?.customer || {}) };
  const name = text(customer.name);
  const email = text(customer.email);
  if (!name && !email) throw new XeroPayloadError("XERO_NO_CUSTOMER", "The invoice has no customer name or email, which Xero needs for the contact.");
  return { name: (name || email).slice(0, 255), email };
}
