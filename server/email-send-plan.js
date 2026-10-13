// What a send attaches by default, and whether it continues an earlier
// conversation, by send type (the email composer proposal's table, owner's
// decisions 2 and 5, 2026-10-13):
//
//   send type             ticked by default                 offered, unticked
//   quote                 the quote version being sent      none
//   revised quote         the new version                   none (the old one is superseded)
//   milestone invoice     the invoice                       the accepted quote
//   replacement invoice   the new invoice and the           the accepted quote
//                         adjustment note
//   adjustment note       the adjustment note               the invoice it credits
//   receipt               the receipt                       the invoice it pays
//   job email             none                              any issued document, through Add
//
// The email's own document is attached by the send itself; the plan names
// the other documents by uid. A follow-up for the same document line is
// offered into the earlier Gmail conversation, on by default.
import { documentStatus } from "./documents/status.js";
import { earlierEmailForLine, threadSummary } from "./email-threads.js";

function newest(documents, predicate) {
  return [...documents].reverse().find(predicate) || null;
}

/** The quote the job was accepted on (else the latest issued quote). */
function acceptedQuote(documents, meta) {
  return newest(documents, (document) => document.documentType === "quote" && documentStatus(document, { meta, documents }) === "accepted")
    || newest(documents, (document) => document.documentType === "quote");
}

/**
 * { sendType, suggestions: [{ uid, number, ticked, reason }], replacement, thread }
 * for a send. `view` is the prepared document view (email-compose-routes.js),
 * `documents` the job's issued documents (empty without a database).
 */
export async function buildSendPlan({ jobDir, view, meta, documents = [], purpose = null, creditNoteNumber = null }) {
  const suggestions = [];
  const offer = (document, ticked, reason) => {
    if (document && !suggestions.some((entry) => entry.uid === document.uid)) {
      suggestions.push({ uid: document.uid, number: document.number, documentType: document.documentType, ticked, reason });
    }
  };
  const milestone = view.milestoneInvoice || null;
  let sendType = view.documentType || "email";
  let replacement = null;
  let line = { documentType: view.documentType, milestoneIndex: milestone?.milestoneIndex ?? null };

  if (view.documentType === "quote") {
    const version = Number(view.quote?.version) || 0;
    if (documents.some((document) => document.documentType === "quote" && Number(document.quoteVersion) < version)) sendType = "revised-quote";
  } else if (view.documentType === "invoice") {
    const noteNumber = milestone?.issuedRevision?.creditNoteNumber || null;
    if (noteNumber) {
      sendType = "replacement-invoice";
      const note = documents.find((document) => document.documentType === "credit_note" && document.number === noteNumber) || null;
      const replacesNumber = note?.details?.creditedInvoiceNumber
        || (milestone.revisionHistory || []).find((entry) => entry?.creditNote?.number === noteNumber)?.invoiceNumber
        || null;
      const replaced = replacesNumber ? documents.find((document) => document.documentType === "invoice" && document.number === replacesNumber) : null;
      replacement = {
        creditNoteNumber: noteNumber,
        creditNoteUid: note?.uid || null,
        replacesNumber,
        replacesTotal: replaced?.details?.total ?? null,
        total: milestone.issuedRevision?.total ?? milestone.total ?? null,
      };
      // Decision 2: the adjustment note is ticked; the operator can untick it.
      offer(note, true, "Adjustment note · cancels the invoice this one replaces");
    }
    offer(acceptedQuote(documents, meta), false, "The accepted quote · suggested");
  } else if (view.documentType === "receipt") {
    const invoiceNumber = milestone?.issuedRevision?.invoiceNumber || milestone?.invoiceNumber || null;
    offer(documents.find((document) => document.documentType === "invoice" && document.number === invoiceNumber) || null, false, "The invoice it pays · suggested");
  } else if (purpose === "adjustment-note" && creditNoteNumber) {
    sendType = "adjustment-note";
    const note = documents.find((document) => document.documentType === "credit_note" && document.number === creditNoteNumber) || null;
    const credited = note?.details?.creditedInvoiceNumber || null;
    offer(note, true, "The adjustment note");
    offer(credited ? documents.find((document) => document.documentType === "invoice" && document.number === credited) || null : null, false, "The invoice it credits · suggested");
    replacement = { creditNoteNumber, creditNoteUid: note?.uid || null, replacesNumber: credited, replacementNumber: note?.details?.replacementInvoiceNumber || null };
    line = { documentType: null, creditedInvoiceNumber: credited };
  }

  const earlier = line.documentType || line.creditedInvoiceNumber
    ? await earlierEmailForLine({ jobDir, ...line })
    : null;
  return { sendType, suggestions, replacement, thread: threadSummary(earlier) };
}
