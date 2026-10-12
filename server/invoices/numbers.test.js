// Invoice numbers (#28, owner's decision 2026-10-13): INV-YYYY-M-N, the month
// not zero-padded, and ordered by period and sequence, never by their text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareDocumentNumbers, formatCreditNoteNumber, formatInvoiceNumber, formatSequenceNumber, invoicePeriod, isSequenceInvoiceNumber, parseSequenceNumber } from "./numbers.js";

test("the month is printed without a leading zero; the counter's period keeps it", () => {
  assert.equal(invoicePeriod(new Date(2026, 0, 15, 9)), "2026-01");
  assert.equal(formatInvoiceNumber("2026-01", 1), "INV-2026-1-1");
  assert.equal(formatInvoiceNumber("2026-10", 2), "INV-2026-10-2");
  assert.equal(formatInvoiceNumber(invoicePeriod(new Date(2026, 11, 31, 23)), 40), "INV-2026-12-40");
  assert.throws(() => formatInvoiceNumber("2026-1", 1), /not a numbering period/);
});

test("only INV-YYYY-M-N with a real month and a positive sequence is a sequence number", () => {
  for (const number of ["INV-2026-1-1", "INV-2026-9-12", "INV-2026-10-2", "INV-2026-12-1"]) assert.ok(isSequenceInvoiceNumber(number), number);
  for (const number of ["INV-2026-01-1", "INV-2026-0-1", "INV-2026-13-1", "INV-2026-1-0", "EI-2601-01-M1", "INV-26-1-1"]) assert.equal(isSequenceInvoiceNumber(number), false, number);
  assert.deepEqual(parseSequenceNumber("INV-2026-10-3"), { prefix: "INV", year: 2026, month: 10, sequence: 3 });
  assert.equal(parseSequenceNumber("EI-2601-01-M1"), null);
});

test("numbers sort by year, month and sequence, never as text; older EI-… numbers first", () => {
  const shuffled = ["INV-2026-10-1", "INV-2026-9-2", "INV-2027-1-1", "EI-2601-01-M1-R2", "INV-2026-9-10", "INV-2026-12-1", "EI-2601-01-M1", "INV-2026-9-1"];
  assert.deepEqual([...shuffled].sort(compareDocumentNumbers), [
    "EI-2601-01-M1",
    "EI-2601-01-M1-R2",
    "INV-2026-9-1",
    "INV-2026-9-2",
    "INV-2026-9-10",
    "INV-2026-10-1",
    "INV-2026-12-1",
    "INV-2027-1-1",
  ]);
  // As text, October would come before September.
  assert.ok("INV-2026-10-1" < "INV-2026-9-1");
});

test("credit notes take the same format: CN-2026-1-1", () => {
  assert.equal(formatCreditNoteNumber("2026-01", 1), "CN-2026-1-1");
  assert.equal(formatCreditNoteNumber("2026-10", 3), "CN-2026-10-3");
  assert.deepEqual(["CN-2026-10-1", "CN-2026-9-2"].sort(compareDocumentNumbers), ["CN-2026-9-2", "CN-2026-10-1"]);
});

test("one allocator format for every series; an unknown series is refused", () => {
  assert.equal(formatSequenceNumber("invoice", "2026-01", 7), "INV-2026-1-7");
  assert.equal(formatSequenceNumber("credit_note", "2026-11", 1), "CN-2026-11-1");
  assert.throws(() => formatSequenceNumber("quote", "2026-01", 1), /no number series/);
  assert.throws(() => formatSequenceNumber("invoice", "2026-01", 0), /not a sequence value/);
});
