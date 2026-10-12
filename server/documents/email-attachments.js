// Field documents as email attachments, by uid.
//
// An email can carry any of the job's issued documents next to the document
// it is for. The send path names them by uid (`documents: [{ uid }]`); the
// bytes always come from the issued-document store, hash-checked
// (readIssuedDocument). Nothing is rendered again and no file path is taken.
//
// Queued and pending sends (the schedule queue, drafts and the delivery
// outbox) store the reference, never the bytes: { uid, documentType, number,
// sha256, byteLength, status }. At dispatch the bytes are read again and must
// still hash to the recorded SHA-256, and a document credited or voided since
// fails the send for review.
//
// Limits (owner's decision, 2026-10-13): 10 attachments, 10 MB per upload and
// 18 MB in total across the main document, Field documents and uploads.
// Base64 adds a third, so 18 MB is about 24 MB on the wire, under Gmail's
// 25 MB message limit.
import { DocumentBytesError, sha256Hex } from "./blob-store.js";
import { WITHDRAWN_DOCUMENT_STATUSES, documentStatus } from "./status.js";
import { isDocumentUid } from "./uid.js";

const MB = 1024 * 1024;
export const EMAIL_ATTACHMENT_LIMITS = Object.freeze({
  maxAttachments: 10,
  maxUploadBytes: 10 * MB,
  maxTotalBytes: 18 * MB,
});

export class EmailAttachmentError extends Error {
  constructor(message, { statusCode = 400, code = "EMAIL_ATTACHMENT_INVALID", details = {} } = {}) {
    super(message);
    this.name = "EmailAttachmentError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    // Refused before anything was handed to Gmail.
    this.deliveryOutcome = "rejected_before_dispatch";
  }
}

const DOCUMENT_LABELS = { quote: "quote", invoice: "invoice", receipt: "receipt", credit_note: "adjustment note" };

function label(documentType) {
  return DOCUMENT_LABELS[documentType] || "document";
}

function formatMegabytes(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** The uids an email names, in order. `[{ uid }]` or `["doc_…"]`; a uid named twice is refused. */
export function parseDocumentRefs(value) {
  if (value == null || value === "") return [];
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = list.split(",");
    }
  }
  if (!Array.isArray(list)) {
    throw new EmailAttachmentError("documents must be a list of { uid }", { code: "EMAIL_DOCUMENTS_INVALID" });
  }
  const uids = [];
  for (const entry of list) {
    const uid = String(typeof entry === "string" ? entry : entry?.uid || "").trim();
    if (!isDocumentUid(uid)) {
      throw new EmailAttachmentError(`not a document uid: ${JSON.stringify(uid.slice(0, 40))}`, { code: "EMAIL_DOCUMENTS_INVALID" });
    }
    if (uids.includes(uid)) {
      throw new EmailAttachmentError(`${uid} is attached twice`, { code: "EMAIL_DOCUMENT_TWICE", details: { uid } });
    }
    uids.push(uid);
  }
  return uids;
}

/** What a queue record or delivery attempt keeps for an attached document: never its bytes. */
export function documentAttachmentRecord(attachment) {
  return {
    uid: attachment.uid,
    documentType: attachment.documentType,
    number: attachment.number,
    filename: attachment.filename,
    sha256: attachment.sha256,
    byteLength: attachment.byteLength,
    status: attachment.status,
  };
}

/** The MIME attachments for loaded documents, in the order they were named. */
export function documentMimeAttachments(attachments = []) {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: "application/pdf",
    buffer: attachment.buffer,
    uid: attachment.uid,
    documentType: attachment.documentType,
    number: attachment.number,
  }));
}

function fileNameFor(document) {
  const slug = String(document.number || document.uid).replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/^[-\s]+|[-\s]+$/g, "") || document.uid;
  return `${slug}.pdf`;
}

/**
 * Read each named document's stored bytes for an email on `jobId`.
 *
 *   404  no such document in this organisation
 *   409  a document of another job, the email's own document attached again,
 *        or (with `recorded`) one credited or voided since the email was written
 *   410  its bytes are missing or fail their hash, or (with `recorded`) they
 *        differ from the bytes recorded when the email was written
 *   503  no database: Field documents cannot be attached
 *
 * `refs` are uids or recorded attachments ({ uid, sha256, status }).
 * `mainDocument` ({ documentType, number }) is the document the email is for.
 */
export async function loadDocumentAttachments({ service, jobId, refs = [], mainDocument = null, meta = null }) {
  const wanted = refs.map((ref) => (typeof ref === "string" ? { uid: ref } : ref)).filter((ref) => ref?.uid);
  if (!wanted.length) return [];
  if (!service) {
    throw new EmailAttachmentError("attaching Field documents needs the database, which this server does not have", {
      statusCode: 503,
      code: "ISSUED_DOCUMENTS_UNAVAILABLE",
    });
  }
  const listed = await service.listJobDocuments(String(jobId));
  const onJob = new Map(listed.documents.map((document) => [document.uid, document]));
  const loaded = [];
  for (const ref of wanted) {
    let found;
    try {
      found = await service.readIssuedDocument(ref.uid);
    } catch (error) {
      if (error instanceof DocumentBytesError || error?.name === "DocumentBytesError") {
        throw new EmailAttachmentError(`the stored bytes of ${ref.number || ref.uid} are unavailable, so it cannot be attached`, {
          statusCode: 410,
          code: "DOCUMENT_BYTES_UNAVAILABLE",
          details: { uid: ref.uid },
        });
      }
      throw error;
    }
    if (!found) {
      throw new EmailAttachmentError(`document ${ref.uid} was not found`, { statusCode: 404, code: "DOCUMENT_NOT_FOUND", details: { uid: ref.uid } });
    }
    const { document, bytes } = found;
    if (String(document.jobId) !== String(jobId) || !onJob.has(document.uid)) {
      throw new EmailAttachmentError(`${document.number} belongs to another job and cannot be attached to this email`, {
        statusCode: 409,
        code: "DOCUMENT_OF_ANOTHER_JOB",
        details: { uid: document.uid },
      });
    }
    if (mainDocument?.number && mainDocument.documentType === document.documentType && mainDocument.number === document.number) {
      throw new EmailAttachmentError(`${document.number} is already this email's ${label(document.documentType)}; it is attached once`, {
        statusCode: 409,
        code: "EMAIL_DOCUMENT_TWICE",
        details: { uid: document.uid },
      });
    }
    const sha256 = sha256Hex(bytes);
    if (ref.sha256 && ref.sha256 !== sha256) {
      throw new EmailAttachmentError(`the stored bytes of ${document.number} changed after this email was written; review it before sending`, {
        statusCode: 410,
        code: "DOCUMENT_BYTES_CHANGED",
        details: { uid: document.uid },
      });
    }
    const status = documentStatus(document, { events: onJob.get(document.uid).events, meta, documents: listed.documents });
    if (ref.sha256 && WITHDRAWN_DOCUMENT_STATUSES.has(status) && !WITHDRAWN_DOCUMENT_STATUSES.has(ref.status)) {
      throw new EmailAttachmentError(`${document.number} was ${status === "void" ? "voided" : "credited"} after this email was written; review it before sending`, {
        statusCode: 409,
        code: "DOCUMENT_WITHDRAWN",
        details: { uid: document.uid, status },
      });
    }
    loaded.push({
      uid: document.uid,
      documentType: document.documentType,
      number: document.number,
      filename: ref.filename || fileNameFor(document),
      buffer: bytes,
      sha256,
      byteLength: bytes.length,
      status,
    });
  }
  return loaded;
}

/**
 * Refuse an email over the limits before Gmail is called (413). `mainBytes`
 * is the size of the email's own document, `documents` the loaded Field
 * documents and `uploads` the uploaded files ({ buffer }).
 */
export function assertEmailAttachmentLimits({ mainBytes = 0, documents = [], uploads = [], limits = EMAIL_ATTACHMENT_LIMITS } = {}) {
  const count = (mainBytes > 0 ? 1 : 0) + documents.length + uploads.length;
  if (count > limits.maxAttachments) {
    throw new EmailAttachmentError(`an email can carry at most ${limits.maxAttachments} attachments; this one has ${count}`, {
      statusCode: 413,
      code: "EMAIL_TOO_MANY_ATTACHMENTS",
      details: { count, limit: limits.maxAttachments },
    });
  }
  for (const upload of uploads) {
    const size = upload?.buffer?.length || 0;
    if (size > limits.maxUploadBytes) {
      throw new EmailAttachmentError(`${upload.filename || "an upload"} is ${formatMegabytes(size)}; each upload can be at most ${formatMegabytes(limits.maxUploadBytes)}`, {
        statusCode: 413,
        code: "EMAIL_UPLOAD_TOO_LARGE",
        details: { filename: upload.filename || null, byteLength: size, limitBytes: limits.maxUploadBytes },
      });
    }
  }
  const totalBytes = mainBytes
    + documents.reduce((sum, document) => sum + (document.byteLength || document.buffer?.length || 0), 0)
    + uploads.reduce((sum, upload) => sum + (upload?.buffer?.length || 0), 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw new EmailAttachmentError(`the attachments add up to ${formatMegabytes(totalBytes)}; an email can carry at most ${formatMegabytes(limits.maxTotalBytes)}`, {
      statusCode: 413,
      code: "EMAIL_TOO_LARGE",
      details: { totalBytes, limitBytes: limits.maxTotalBytes },
    });
  }
  return { count, totalBytes };
}
