// Invoice numbers from the sequence (#28, step 4b): INV-YYYY-MM-N, one
// sequence per organisation, N restarting each month. Allocated only by the
// invoice issue service (issue.js), in the transaction that issues the
// invoice. Pure: no database, so the job-file code can tell a sequence number
// from an older EI-… one.

export const INVOICE_NUMBER_PATTERN = /^INV-(\d{4})-(\d{2})-([1-9]\d*)$/;

/** Whether a number came from the invoice sequence (INV-2026-10-3), not an older EI-… number. */
export function isSequenceInvoiceNumber(number) {
  return INVOICE_NUMBER_PATTERN.test(String(number || "").trim());
}

/**
 * The numbering period of an issue time: its year and month in the server's
 * local time, which is the date the invoice PDF prints (quote-artifacts.js
 * formatDate), so INV-2026-10-… never carries a date in another month.
 */
export function invoicePeriod(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error(`issue time is not a timestamp: ${JSON.stringify(at)}`);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function formatInvoiceNumber(period, value) {
  return `INV-${period}-${value}`;
}
