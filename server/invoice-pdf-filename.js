// Filename builder for issued-invoice PDF responses.
//
// Node rejects any HTTP header value containing a code point above 0xFF
// (`TypeError [ERR_INVALID_CHAR]`), so a `Content-Disposition` filename built
// directly from an invoice number can 500 the entire issued-invoice serving
// surface the moment that number contains a non-Latin-1 character (an em
// dash in a customer-facing label, a curly quote pasted from a document,
// etc). This mirrors the same ASCII-hyphen slugify pattern `buildQuotePdfFilename`
// already uses in server/index.js, applied to the invoice number instead of
// the client/quote reference, and doubles as sanitization of any character
// (including `"`) that would otherwise break out of the quoted filename
// value.
function slugify(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function buildIssuedInvoicePdfFilename(invoiceNumber) {
  const slug = slugify(invoiceNumber) || "invoice";
  return `${slug}-invoice.pdf`;
}
