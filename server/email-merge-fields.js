// Merge-field values for an email, worked out once, here, from the same
// meta and quote the email's document is built from. The composer shows
// them (GET /api/jobs/:id/email-context), the preview uses them
// (POST /api/jobs/:id/email-preview), and the send fills every field in the
// body and subject with them again (sendJobQuote, after the document is
// prepared, so an invoice number issued at send is the one printed).
// Definitions: shared/email-templates.js (EMAIL_MERGE_FIELDS).
import { EMAIL_MERGE_FIELDS } from "../shared/email-templates.js";
import { applyBusinessProfileOverride, businessDisplayName, installationBusinessName } from "./business-profile.js";
import { buildInvoiceDocumentNumber, buildReceiptDocumentNumber } from "./job-documents.js";
import { resolveMailSender } from "./send-quote-email.js";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function longDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}

function businessName(quote) {
  const profile = quote?.quoteCatalog?.businessProfile || quote?.profile?.businessProfile || null;
  return businessDisplayName(applyBusinessProfileOverride(profile || {})) || installationBusinessName();
}

/** The invoice a replacement was issued in place of (step 4b), by its credit note. */
function replacedInvoiceNumber(milestone) {
  const note = milestone?.issuedRevision?.creditNoteNumber || null;
  if (!note) return null;
  const replaced = (milestone.revisionHistory || []).find((entry) => entry?.creditNote?.number === note);
  return text(replaced?.invoiceNumber) || null;
}

/** Whether the invoice has its issued number yet (a draft gets it when it is sent). */
function invoiceIsIssued(milestone) {
  return Boolean(milestone && milestone.status && milestone.status !== "draft");
}

/**
 * The values of every merge field (strings, or null when the email has none
 * yet), plus `milestoneLabel` and `defaultSubject` for the templates.
 */
export function buildEmailMergeValues({
  meta = null,
  quote = null,
  documentType = null,
  milestoneInvoice = null,
  config = {},
  user = null,
  attachmentNames = [],
  defaultSubject = null,
}) {
  const milestone = milestoneInvoice || meta?.milestoneInvoice || null;
  let senderName = null;
  try {
    senderName = text(user?.name) || resolveMailSender({ config, user }).fromName;
  } catch {
    senderName = text(user?.name);
  }
  const values = {
    clientName: text(meta?.contactName) || text(meta?.customerName),
    jobTitle: text(meta?.title) || text(meta?.label) || text(meta?.siteAddress),
    siteAddress: text(meta?.siteAddress),
    businessName: businessName(quote),
    senderName,
    attachmentList: attachmentNames.filter(Boolean).join(", ") || null,
    documentNumber: null,
    amountDue: null,
    dueDate: null,
    replacesNumber: null,
    creditNoteNumber: null,
    milestoneLabel: text(milestone?.milestoneLabel),
    defaultSubject,
  };
  if (documentType === "quote") {
    values.documentNumber = text(quote?.quoteNumber) || text(meta?.quoteNumber);
    values.amountDue = money(quote?.totals?.total);
  } else if (documentType === "invoice" && milestone) {
    values.documentNumber = invoiceIsIssued(milestone)
      ? text(milestone.issuedRevision?.invoiceNumber) || text(buildInvoiceDocumentNumber({ meta, quote, milestoneInvoice: milestone }))
      : null;
    const total = Number(milestone.issuedRevision?.total ?? milestone.total);
    const paid = Number(milestone.amountPaid || 0);
    values.amountDue = Number.isFinite(total) ? money(Math.max(0, Math.round((total - paid) * 100) / 100)) : null;
    values.dueDate = longDate(milestone.dueDate || milestone.issuedRevision?.dueDate);
    values.creditNoteNumber = text(milestone.issuedRevision?.creditNoteNumber);
    values.replacesNumber = replacedInvoiceNumber(milestone);
  } else if (documentType === "receipt" && milestone) {
    values.documentNumber = text(buildReceiptDocumentNumber({ meta, quote, milestoneInvoice: milestone }));
    values.amountDue = money(milestone.amountPaid);
  }
  return values;
}

/** The fields the composer offers (Insert field), with their current values. */
export function listEmailMergeFields(values) {
  return EMAIL_MERGE_FIELDS.map((field) => ({ ...field, value: values?.[field.key] ?? null }));
}
