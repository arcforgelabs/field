// What the email composer reads, and its customer preview.
//
//   GET  /api/jobs/:id/email-context    templates (with placeholders), the
//        merge-field values, the default subject, the operator's signature,
//        the job's own people for the To/Cc/Bcc suggestions, the sender and
//        the delivery policy, for one document send (or a plain job email)
//   POST /api/jobs/:id/email-preview    the subject, HTML and attachment list
//        a send with this body would produce, built by the same functions the
//        send uses (composeDocumentEmail / composeJobEmail and the merge
//        fields). It calls no Gmail and issues nothing.
//   GET  /api/settings/email-signature  the signed-in person's signature
//   PUT  /api/settings/email-signature  change it ({ html }; empty resets)
import { applyMergeFields, applyMergeFieldsToText } from "../shared/email-templates.js";
import { buildEmailMergeValues, listEmailMergeFields } from "./email-merge-fields.js";
import { readEmailSignature, saveEmailSignature } from "./email-signatures.js";
import { listEmailTemplates } from "./email-templates.js";
import { readDocumentQuoteArtifacts } from "./job-document-context.js";
import { readQuoteArtifacts } from "./quote-artifacts.js";
import { prepareRequestedJobDocument } from "./job-documents.js";
import { buildQuotePdfFilename } from "./quote-artifacts.js";
import {
  composeDocumentEmail,
  composeJobEmail,
  defaultDocumentSubject,
  defaultJobEmailSubject,
  resolveMailDeliveryPolicy,
  resolveMailSender,
} from "./send-quote-email.js";
import { readSentEmailArchive } from "./sent-email-archive.js";
import { EMAIL_ATTACHMENT_LIMITS, EmailAttachmentError, loadDocumentAttachments, parseDocumentRefs } from "./documents/email-attachments.js";

const DOCUMENT_TYPES = new Set(["quote", "invoice", "receipt"]);
// What a draft invoice's number reads as before the send issues it.
export const PENDING_NUMBER_TEXT = "[number when issued]";

/** A draft invoice gets its number when the send issues it. */
function isDraftInvoice(view) {
  return view.documentType === "invoice" && Boolean(view.milestoneInvoice) && String(view.milestoneInvoice.status || "draft") === "draft";
}

/** The view with a draft invoice's number shown as `number` (a merge field, or the pending text). */
function withPendingNumber(view, number) {
  if (!isDraftInvoice(view)) return view;
  const milestoneInvoice = { ...view.milestoneInvoice, invoiceNumber: number };
  return { ...view, milestoneInvoice, meta: { ...view.meta, milestoneInvoice } };
}

function documentTypeOf(value) {
  const type = String(value || "").trim().toLowerCase();
  return DOCUMENT_TYPES.has(type) ? type : null;
}

function milestoneIndexOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function addressList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  return [...new Set(raw.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
}

/**
 * The meta and quote a document email is built from, as a send would
 * prepare them (the quote final, an invoice or receipt's milestone chosen),
 * without writing anything.
 */
export async function readEmailDocumentView({ job, meta, documentType, milestoneIndex = null, version = null }) {
  // A job email has no document, but signs for the business the job's quote
  // names (the merge field businessName).
  if (!documentType) return { documentType: null, meta, quote: await jobQuoteForEmail(job), milestoneInvoice: null };
  const context = await readDocumentQuoteArtifacts({
    jobDir: job.dir,
    meta,
    documentType,
    requestedVersion: version || null,
    intent: "delivery",
  });
  const baseQuote = context.selectedQuoteArtifacts?.quote || null;
  const quote = baseQuote ? { ...baseQuote, delivery: { ...(baseQuote.delivery || {}), status: "final" } } : null;
  const resolvedDocumentType = context.resolvedDocumentType || documentType;
  if (resolvedDocumentType === "quote") return { documentType: "quote", meta: context.meta, quote, milestoneInvoice: null };
  const prepared = prepareRequestedJobDocument({ meta: context.meta, quote, documentType: resolvedDocumentType, milestoneIndex });
  return { documentType: resolvedDocumentType, meta: prepared.meta, quote: prepared.quote, milestoneInvoice: prepared.milestoneInvoice || null };
}

/** The job's current quote, for a job email's business name; null when it has none. */
export async function jobQuoteForEmail(job) {
  try {
    return (await readQuoteArtifacts(job.dir))?.quote || null;
  } catch {
    return null;
  }
}

/** The job's own people: its contact, then everyone it already emailed. */
export async function jobContactsFor({ job, meta }) {
  const contacts = [];
  const email = String(meta?.contactEmail || "").trim().toLowerCase();
  if (email) contacts.push({ email, name: meta?.contactName || meta?.customerName || "", source: "job" });
  const archive = await readSentEmailArchive(job.dir).catch(() => []);
  for (const record of archive) {
    for (const address of [...(record.to || []), ...(record.cc || [])]) {
      const normalized = String(address || "").trim().toLowerCase();
      if (normalized && !contacts.some((contact) => contact.email === normalized)) {
        contacts.push({ email: normalized, name: "", source: "sent" });
      }
    }
  }
  return contacts;
}

function publicPolicy(config) {
  const policy = resolveMailDeliveryPolicy(config);
  return policy.mode === "allowlist" ? policy : { mode: policy.mode };
}

function senderFor(config, user) {
  try {
    const sender = resolveMailSender({ config, user });
    return { name: sender.fromName || null, email: sender.fromEmail || null };
  } catch {
    return { name: user?.name || null, email: user?.email || null };
  }
}

export function registerEmailComposeRoutes(app, { requireAuth, findJob, config, dataDir, normalizeJobMeta, documentServiceFor }) {
  app.get("/api/settings/email-signature", requireAuth, async (req, res) => {
    try {
      res.json({ ok: true, signature: await readEmailSignature({ dataDir, user: req.caller }) });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.put("/api/settings/email-signature", requireAuth, async (req, res) => {
    try {
      res.json({ ok: true, signature: await saveEmailSignature({ dataDir, user: req.caller, html: req.body?.html ?? "" }) });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get("/api/jobs/:id/email-context", requireAuth, async (req, res) => {
    const job = await findJob(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    try {
      const meta = normalizeJobMeta(job.meta);
      const view = await readEmailDocumentView({
        job,
        meta,
        documentType: documentTypeOf(req.query.documentType),
        milestoneIndex: milestoneIndexOf(req.query.milestoneIndex),
        version: req.query.version ? String(req.query.version) : null,
      });
      // A draft invoice's subject names its number as a merge field: the send
      // fills it with the number it issues.
      const subjectView = withPendingNumber(view, "{{documentNumber}}");
      const defaultSubject = view.documentType
        ? defaultDocumentSubject({ meta: subjectView.meta, quote: view.quote, documentType: view.documentType })
        : defaultJobEmailSubject(view.meta);
      const values = buildEmailMergeValues({
        meta: view.meta,
        quote: view.quote,
        documentType: view.documentType,
        milestoneInvoice: view.milestoneInvoice,
        config,
        user: req.caller,
        defaultSubject,
      });
      const signature = await readEmailSignature({ dataDir, user: req.caller }).catch(() => null);
      res.json({
        ok: true,
        jobId: meta.id,
        documentType: view.documentType,
        milestoneIndex: view.milestoneInvoice?.milestoneIndex ?? null,
        from: senderFor(config, req.caller),
        defaultSubject,
        templates: listEmailTemplates().templates[view.documentType || "email"] || [],
        mergeValues: values,
        mergeFields: listEmailMergeFields(values),
        signature,
        jobContacts: await jobContactsFor({ job, meta: view.meta }),
        deliveryPolicy: publicPolicy(config),
        limits: EMAIL_ATTACHMENT_LIMITS,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.post("/api/jobs/:id/email-preview", requireAuth, async (req, res) => {
    const job = await findJob(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    const payload = req.body || {};
    try {
      const meta = normalizeJobMeta(job.meta);
      const pendingNumber = (await readEmailDocumentView({
        job,
        meta,
        documentType: documentTypeOf(payload.documentType),
        milestoneIndex: milestoneIndexOf(payload.milestoneIndex),
        version: payload.version ? String(payload.version) : null,
      }));
      const draftInvoice = isDraftInvoice(pendingNumber);
      const view = withPendingNumber(pendingNumber, PENDING_NUMBER_TEXT);
      const documents = await loadDocumentAttachments({
        service: documentServiceFor(req),
        jobId: meta.id,
        refs: parseDocumentRefs(payload.documents),
        meta: view.meta,
      });
      const uploads = Array.isArray(payload.uploads)
        ? payload.uploads.map((upload) => ({ filename: String(upload?.filename || "attachment"), byteLength: Number(upload?.byteLength) || null }))
        : [];
      const mainFilename = view.documentType
        ? String(payload.attachmentFilename || "").trim()
          || (draftInvoice ? "Invoice PDF, named when it is issued" : buildQuotePdfFilename(view.meta, view.quote, view.documentType))
        : null;
      const attachments = [
        ...(mainFilename ? [{ filename: mainFilename, source: "main", documentType: view.documentType }] : []),
        ...documents.map((document) => ({ filename: document.filename, source: "document", uid: document.uid, documentType: document.documentType, number: document.number, byteLength: document.byteLength })),
        ...uploads.map((upload) => ({ ...upload, source: "upload" })),
      ];
      const defaultSubject = view.documentType
        ? defaultDocumentSubject({ meta: view.meta, quote: view.quote, documentType: view.documentType })
        : defaultJobEmailSubject(view.meta);
      const values = buildEmailMergeValues({
        meta: view.meta,
        quote: view.quote,
        documentType: view.documentType,
        milestoneInvoice: view.milestoneInvoice,
        config,
        user: req.caller,
        attachmentNames: attachments.map((attachment) => attachment.filename),
        defaultSubject,
      });
      if (draftInvoice) values.documentNumber = PENDING_NUMBER_TEXT;
      const customBody = payload.customBody ? applyMergeFields(String(payload.customBody), values, { final: true }) : null;
      const subject = payload.subject ? applyMergeFieldsToText(String(payload.subject), values, { final: true }) : null;
      const from = senderFor(config, req.caller);
      const built = view.documentType
        ? await composeDocumentEmail({ meta: view.meta, quote: view.quote, documentType: view.documentType, customBody, subjectOverride: subject, fromName: from.name })
        : composeJobEmail({ meta: view.meta, subject, customBody, fromName: from.name });
      res.json({
        ok: true,
        subject: built.subject,
        html: built.htmlBody,
        text: built.body,
        from,
        to: addressList(payload.to),
        cc: addressList(payload.cc),
        bcc: addressList(payload.bcc),
        attachments,
        // The invoice a draft send issues gets its number when it is sent.
        pending: draftInvoice ? ["The invoice gets its number when the email is sent; the preview shows it as [number when issued]."] : [],
      });
    } catch (error) {
      if (error instanceof EmailAttachmentError) return res.status(error.statusCode).json({ error: error.message, code: error.code, ...(error.details || {}) });
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });
}
