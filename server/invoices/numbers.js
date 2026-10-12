// Invoice numbers from the sequence (#28, step 4b): INV-YYYY-M-N, one
// sequence per organisation, the month not zero-padded (January 2026 is
// INV-2026-1-1, October INV-2026-10-2), N restarting each month. Allocated
// only by the invoice issue service (issue.js), in the transaction that
// issues the invoice. Pure: no database, so the job-file code can tell a
// sequence number from an older EI-… one.
//
// The counter's period (document_number_counters.period) is YYYY-MM, padded,
// so periods compare in order; only the printed number drops the zero. Never
// order numbers by their text (INV-2026-10-1 sorts before INV-2026-9-1 as
// text): compareDocumentNumbers orders by year, month and sequence.

export const INVOICE_NUMBER_PATTERN = /^INV-(\d{4})-([1-9]|1[0-2])-([1-9]\d*)$/;

/** Whether a number came from the invoice sequence (INV-2026-10-3), not an older EI-… number. */
export function isSequenceInvoiceNumber(number) {
  return INVOICE_NUMBER_PATTERN.test(String(number || "").trim());
}

/**
 * The numbering period of an issue time: its year and month in the server's
 * local time, which is the date the invoice PDF prints (quote-artifacts.js
 * formatDate), so INV-2026-10-… never carries a date in another month.
 * YYYY-MM, as the counters key it.
 */
export function invoicePeriod(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error(`issue time is not a timestamp: ${JSON.stringify(at)}`);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function printedPeriod(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period));
  if (!match) throw new Error(`not a numbering period: ${JSON.stringify(period)}`);
  return `${match[1]}-${Number(match[2])}`;
}

/** INV-2026-1-1 from the period 2026-01 and the counter's value 1. */
export function formatInvoiceNumber(period, value) {
  return `INV-${printedPeriod(period)}-${value}`;
}

const SEQUENCE_PATTERN = /^([A-Z]+)-(\d{4})-([1-9]|1[0-2])-([1-9]\d*)$/;

/** { prefix, year, month, sequence } of a number from a sequence (INV-, CN-), or null. */
export function parseSequenceNumber(number) {
  const match = SEQUENCE_PATTERN.exec(String(number || "").trim());
  if (!match) return null;
  return { prefix: match[1], year: Number(match[2]), month: Number(match[3]), sequence: Number(match[4]) };
}

/**
 * Orders document numbers: numbers from a sequence by year, month and
 * sequence (never by their text), after older numbers that are not (EI-…),
 * which keep their natural order among themselves.
 */
export function compareDocumentNumbers(a, b) {
  const left = parseSequenceNumber(a);
  const right = parseSequenceNumber(b);
  if (left && right) {
    return left.prefix.localeCompare(right.prefix)
      || left.year - right.year
      || left.month - right.month
      || left.sequence - right.sequence;
  }
  if (left) return 1;
  if (right) return -1;
  return String(a ?? "").localeCompare(String(b ?? ""), "en", { numeric: true });
}

// Credit (adjustment) notes (#28, step 4b): CN-YYYY-MM-N from the same
// counters (document type `credit_note`), allocated when the note is issued.
export const CREDIT_NOTE_NUMBER_PATTERN = /^CN-(\d{4})-(\d{2})-([1-9]\d*)$/;

export function formatCreditNoteNumber(period, value) {
  return `CN-${period}-${value}`;
}

/**
 * The number recorded for a credit note against an invoice that was revised
 * in place before credit notes existed (EI-2605-04-M1 is credited by
 * CN-EI-2605-04-M1). Such a note was never issued to the customer as a
 * document, so it takes no number from the sequence.
 */
export function revisionCreditNoteNumber(invoiceNumber) {
  return `CN-${String(invoiceNumber || "").trim()}`;
}
