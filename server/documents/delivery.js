// The send path's side of the issued-document dual-write: what
// job-actions.js calls once a quote, invoice or receipt delivery is committed
// (or has failed). Builds the document's number and frozen details from the
// exact prepared meta and quote the PDF was rendered from, and hands them to
// the installed recorder. Never throws.
import {
  invoiceDocumentNumber,
  invoiceRevisionDetails,
  partiesDetails,
  quoteDocumentNumber,
  quoteMoneyDetails,
  receiptDocumentNumber,
} from "./job-sources.js";
import { issuedDocumentRecorder } from "./recorder.js";
import { countFieldMetric } from "../observability/sentry.js";

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Number, version, revision and frozen details of the document a delivery carries. */
export function describeDeliveredDocument({
  documentType,
  preparedMeta = null,
  preparedQuote = null,
  preparedMilestoneInvoice = null,
  version = null,
}) {
  const milestone = preparedMeta?.milestoneInvoice || preparedMilestoneInvoice || null;
  const parties = partiesDetails({ meta: preparedMeta, quote: preparedQuote });
  if (documentType === "invoice") {
    const revision = preparedMilestoneInvoice?.issuedRevision || milestone?.issuedRevision || null;
    return {
      number: invoiceDocumentNumber({ meta: preparedMeta, quote: preparedQuote, milestoneInvoice: milestone, revision }),
      quoteVersion: numberOrNull(revision?.quoteVersion ?? version),
      revision: numberOrNull(revision?.revisionNumber) || (milestone ? 1 : null),
      issuedAt: revision?.issuedAt || milestone?.issuedAt || null,
      details: revision
        ? { ...invoiceRevisionDetails(milestone, revision), ...parties }
        : { ...quoteMoneyDetails(preparedQuote), ...parties },
    };
  }
  if (documentType === "receipt") {
    return {
      number: receiptDocumentNumber({ meta: preparedMeta, quote: preparedQuote, milestoneInvoice: milestone }),
      quoteVersion: numberOrNull(version),
      revision: null,
      issuedAt: null,
      details: {
        milestoneIndex: numberOrNull(milestone?.milestoneIndex),
        invoiceNumber: milestone?.invoiceNumber || null,
        currency: milestone?.issuedRevision?.currency || "AUD",
        total: numberOrNull(milestone?.issuedRevision?.total ?? milestone?.total),
        amountPaid: numberOrNull(milestone?.amountPaid),
        ...parties,
      },
    };
  }
  return {
    number: quoteDocumentNumber({ quote: preparedQuote, meta: preparedMeta, version }),
    quoteVersion: numberOrNull(version),
    revision: null,
    issuedAt: null,
    details: { ...quoteMoneyDetails(preparedQuote), ...parties },
  };
}

/**
 * A delivery was committed (finalizeAndProjectDelivery): record the document
 * with the exact bytes that were attached, and the email.
 */
export async function recordDeliveredDocument({ finalization, issuance }) {
  const recorder = issuedDocumentRecorder();
  try {
    const documentType = finalization.resolvedDocumentType || "quote";
    const version = finalization.selectedVersion || finalization.preparedQuote?.version || finalization.preparedMeta?.quoteVersion || null;
    const described = describeDeliveredDocument({
      documentType,
      preparedMeta: finalization.preparedMeta,
      preparedQuote: finalization.preparedQuote,
      preparedMilestoneInvoice: finalization.preparedMilestoneInvoice,
      version,
    });
    const pdfBytes = finalization.pendingArtifacts?.quotePdf || finalization.quotePdfBuffer || null;
    const result = finalization.result || {};
    const sentAt = issuance?.issuedAt || finalization.quoteSentAt;
    countFieldMetric("field.document.issued", { document_type: documentType });
    return await recorder.recordDelivery({
      jobId: finalization.preparedMeta?.id,
      documentType,
      number: described.number,
      quoteVersion: described.quoteVersion,
      revision: described.revision,
      pdfBytes,
      issuedAt: described.issuedAt || sentAt,
      issuedBy: finalization.user || null,
      details: described.details,
      email: {
        sentAt,
        by: finalization.user || null,
        messageId: result.id || null,
        threadId: result.threadId || null,
        attemptId: finalization.pendingAttemptId || null,
        issuanceId: issuance?.issuanceId || null,
        to: result.to || finalization.to,
        cc: result.cc || [],
        bcc: result.bcc || [],
        subject: result.subject || null,
      },
    });
  } catch (error) {
    console.error(`[issued-documents] delivery not recorded: ${error.message}`);
    return null;
  }
}

/**
 * The Field documents attached to an email (by uid) next to the document it
 * was for: one `emailed` event each, with the same Gmail message id. Used by
 * the document send (finalizeAndProjectDelivery) and by a plain job email,
 * which has no document of its own. Never throws.
 */
export async function recordAttachedDocumentsEmailed({ jobId, attachments = [], result = {}, user = null, sentAt = null, attemptId = null, withDocument = null }) {
  if (!attachments?.length) return [];
  const recorder = issuedDocumentRecorder();
  try {
    return await recorder.recordAttachmentEmails({
      jobId,
      attachments,
      withDocument,
      email: {
        sentAt: sentAt || new Date().toISOString(),
        by: user || null,
        messageId: result.id || null,
        threadId: result.threadId || null,
        attemptId,
        to: result.to || [],
        cc: result.cc || [],
        bcc: result.bcc || [],
        subject: result.subject || null,
      },
    });
  } catch (error) {
    console.error(`[issued-documents] attached documents' emails not recorded: ${error.message}`);
    return [];
  }
}

/** The email for a prepared attempt failed (or its outcome is unknown). */
export async function recordFailedDelivery({ attempt, documentType, error, outcome, user = null, at = new Date().toISOString() }) {
  const recorder = issuedDocumentRecorder();
  countFieldMetric("field.document.delivery_failed", { document_type: documentType || "unknown", outcome: String(outcome || "unknown") });
  try {
    const version = attempt?.selectedVersion || attempt?.quoteVersion || attempt?.preparedQuote?.version || null;
    const described = describeDeliveredDocument({
      documentType,
      preparedMeta: attempt?.preparedMeta,
      preparedQuote: attempt?.preparedQuote,
      preparedMilestoneInvoice: attempt?.preparedMilestoneInvoice,
      version,
    });
    return await recorder.recordEmailFailure({
      jobId: attempt?.preparedMeta?.id,
      documentType,
      number: described.number,
      attemptId: attempt?.attemptId || null,
      outcome,
      error,
      at,
      by: user,
      to: attempt?.to || [],
    });
  } catch (failure) {
    console.error(`[issued-documents] email failure not recorded: ${failure.message}`);
    return null;
  }
}
