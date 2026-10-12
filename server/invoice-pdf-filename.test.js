import assert from "node:assert/strict";
import test from "node:test";
import { OutgoingMessage } from "node:http";

import { buildIssuedInvoicePdfFilename } from "./invoice-pdf-filename.js";

// Node rejects any header value containing a code point above 0xFF with
// `TypeError [ERR_INVALID_CHAR]`. This is the exact failure the issued
// invoice PDF routes hit in production: every one of them sets
// `Content-Disposition: inline; filename="${invoiceNumber} — Invoice.pdf"`
// straight from the stored invoice number, and the em dash (U+2014) alone is
// enough to 500 the response. Asserting against `OutgoingMessage.setHeader`
// exercises the real Node header validator Express's `res.setHeader` calls
// into, rather than a hand-rolled ASCII check.
function assertHeaderSafe(filename) {
  const res = new OutgoingMessage();
  assert.doesNotThrow(() => {
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  });
}

test("an em dash in the invoice number (the reported failure) no longer breaks the header", () => {
  const filename = buildIssuedInvoicePdfFilename("EI-0041-M1 — Invoice");
  assertHeaderSafe(filename);
  assert.equal(filename, "ei-0041-m1-invoice-invoice.pdf");
});

test("a quote character in the invoice number cannot break out of the quoted filename value", () => {
  const filename = buildIssuedInvoicePdfFilename('EI-0041-M1" onerror="x"');
  assertHeaderSafe(filename);
  assert.ok(!filename.includes('"'));
});

test("other non-Latin-1 content (emoji, CJK) is stripped to a safe ASCII slug", () => {
  const filename = buildIssuedInvoicePdfFilename("EI-0041-M1 😀 発注書");
  assertHeaderSafe(filename);
  assert.equal(filename, "ei-0041-m1-invoice.pdf");
});

test("a plain invoice number slugifies predictably and stays safe", () => {
  const filename = buildIssuedInvoicePdfFilename("EI-0041-M1-R2");
  assertHeaderSafe(filename);
  assert.equal(filename, "ei-0041-m1-r2-invoice.pdf");
});

test("an empty or missing invoice number still produces a safe, non-empty filename", () => {
  assert.equal(buildIssuedInvoicePdfFilename(null), "invoice-invoice.pdf");
  assert.equal(buildIssuedInvoicePdfFilename(""), "invoice-invoice.pdf");
  assert.equal(buildIssuedInvoicePdfFilename("   "), "invoice-invoice.pdf");
  assertHeaderSafe(buildIssuedInvoicePdfFilename(null));
});
