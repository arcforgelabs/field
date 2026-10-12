// The totals printed on an issued milestone invoice, read back from its PDF
// (#27), the way server/quotes/issued-totals.js reads a quote's. Every
// milestone invoice PDF prints a claim box: "This claim (ex GST)", the
// amount, "GST (10%)", the amount, "Amount Due", the amount, in that order.
// Those three are the invoice's subtotal, GST and total. Until step 4b (#28)
// the box followed the quote's schedule; since then it follows the claim
// lines, with the same labels, so one reader serves both. A PDF whose claim
// box cannot be found gives null: the caller reports it as unreadable rather
// than guessing.
import { parseMoneyText, pdfTextRuns } from "../quotes/issued-totals.js";

/** The subtotal, GST and total an invoice PDF claims, as decimal strings, or null. */
export function extractInvoicePdfTotals(bytes) {
  let runs;
  try {
    runs = pdfTextRuns(bytes);
  } catch {
    return null;
  }
  return claimTotals(runs);
}

/**
 * What an invoice PDF says about itself: its claim ({ subtotal, taxTotal,
 * total }, or null), the invoice number printed under "Invoice", and the
 * "Contract value (inc GST)" of the quote it was drawn from. The contract
 * value tells which quote version a PDF was rendered against. Null when the
 * bytes are not a readable PDF.
 */
export function extractInvoicePdfFacts(bytes) {
  let runs;
  try {
    runs = pdfTextRuns(bytes);
  } catch {
    return null;
  }
  const at = (pattern) => runs.findIndex((run) => pattern.test(run));
  const numberAt = at(/^Invoice$/);
  const contractAt = at(/^Contract value\b/);
  return {
    totals: claimTotals(runs),
    number: numberAt >= 0 && runs[numberAt + 1] ? runs[numberAt + 1].trim() : null,
    contractValue: contractAt >= 0 ? parseMoneyText(runs[contractAt + 1]) : null,
  };
}

function claimTotals(runs) {
  let found = null;
  for (let index = 0; index + 5 < runs.length; index += 1) {
    if (!/^This claim\b/.test(runs[index])) continue;
    if (!/^GST\b/.test(runs[index + 2]) || !/^Amount Due$/.test(runs[index + 4])) continue;
    const subtotal = parseMoneyText(runs[index + 1]);
    const taxTotal = parseMoneyText(runs[index + 3]);
    const total = parseMoneyText(runs[index + 5]);
    if (subtotal !== null && taxTotal !== null && total !== null) found = { subtotal, taxTotal, total };
  }
  return found;
}
