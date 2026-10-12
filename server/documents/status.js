// A document's current status, for the attachment picker and the send path.
//
// Only issued documents have a status here; a draft has no uid and cannot be
// attached. The status comes from the document's own events first (credited,
// voided) and then from the job:
//
//   credited    an adjustment note credits it (a `credited` event)
//   void        it was voided (a `voided` event)
//   paid        an invoice whose milestone is paid, and every receipt
//   superseded  a quote with a later version issued on the same job
//   accepted    the quote version the landed job was accepted on
//   issued      everything else
//
// `credited` and `void` are the states a scheduled or held send checks again
// at dispatch: a document that became one of them since the email was written
// fails the send for review instead of going out.

export const DOCUMENT_STATUSES = ["issued", "accepted", "paid", "credited", "superseded", "void"];
export const WITHDRAWN_DOCUMENT_STATUSES = new Set(["credited", "void"]);

/** credited / void from the document's own events, else null. */
export function statusFromEvents(events = []) {
  let status = null;
  for (const event of events) {
    if (event?.event === "credited") status = "credited";
    else if (event?.event === "voided") status = "void";
  }
  return status;
}

function invoiceIsPaid(document, meta) {
  const milestones = Array.isArray(meta?.milestoneInvoices) ? meta.milestoneInvoices : [];
  const milestone = milestones.find((entry) => (
    entry?.issuedRevision?.invoiceNumber === document.number
    || entry?.invoiceNumber === document.number
  ));
  return milestone?.status === "paid";
}

/** The status of one issued document, given its events, the job meta and the job's other documents. */
export function documentStatus(document, { events = document?.events || [], meta = null, documents = [] } = {}) {
  const fromEvents = statusFromEvents(events);
  if (fromEvents) return fromEvents;
  if (document.documentType === "receipt") return "paid";
  if (document.documentType === "invoice") return invoiceIsPaid(document, meta) ? "paid" : "issued";
  if (document.documentType === "quote") {
    const version = Number(document.quoteVersion) || 0;
    const later = documents.some((other) => other.documentType === "quote" && Number(other.quoteVersion) > version);
    if (later) return "superseded";
    const stage = String(meta?.pipelineStage || meta?.deliveryStatus || "").toLowerCase();
    if (stage === "landed" && version && version === Number(meta?.quoteVersion)) return "accepted";
  }
  return "issued";
}

/**
 * The job's documents that are not issued yet, for the picker's "Not issued
 * yet" group: milestone invoices still in draft. They cannot be attached; the
 * operator issues them from the job's invoices first.
 */
export function notIssuedDocuments(meta) {
  const milestones = Array.isArray(meta?.milestoneInvoices) ? meta.milestoneInvoices : [];
  return milestones
    .filter((milestone) => String(milestone?.status || "draft") === "draft")
    .map((milestone) => ({
      documentType: "invoice",
      milestoneIndex: Number(milestone.milestoneIndex ?? 0),
      label: milestone.milestoneLabel || `Milestone ${Number(milestone.milestoneIndex ?? 0) + 1}`,
      total: Number.isFinite(Number(milestone.total ?? milestone.amount)) ? Number(milestone.total ?? milestone.amount) : null,
      reason: "Draft. Customers only get issued documents. Issue it from Invoices.",
    }));
}
