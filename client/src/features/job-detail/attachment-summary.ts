// What the email's attachments add up to, and how the picker names a document.
import { EMAIL_ATTACHMENT_LIMITS, type JobDocument } from "@/lib/api";

const TYPE_LABEL: Record<string, string> = {
  quote: "Quote",
  invoice: "Invoice",
  receipt: "Receipt",
  credit_note: "Adjustment note",
};

export function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function documentTypeLabel(documentType: string | null | undefined) {
  return TYPE_LABEL[String(documentType || "")] || "Document";
}

/** "Quote · emailed 18 Sep" — what the picker says under a document's number. */
export function documentMetaLine(document: JobDocument) {
  const emailed = document.emailed?.filter((entry) => entry.event === "emailed").at(-1);
  const when = emailed ? `emailed ${shortDate(emailed.at)}` : `issued ${shortDate(document.issuedAt)}`;
  return [documentTypeLabel(document.documentType), when].filter(Boolean).join(" · ");
}

export type MainAttachment = {
  filename: string;
  documentType: string;
  /** Issued already: its stored size. A draft is issued when the email sends. */
  byteLength: number | null;
  issued: boolean;
};

/** Bytes the email will carry, where known. */
export function attachmentTotals({ main, documents, uploads }: { main: MainAttachment | null; documents: JobDocument[]; uploads: File[] }) {
  const count = (main ? 1 : 0) + documents.length + uploads.length;
  const bytes = (main?.byteLength || 0)
    + documents.reduce((sum, document) => sum + (document.byteLength || 0), 0)
    + uploads.reduce((sum, file) => sum + file.size, 0);
  const oversizedUploads = uploads.filter((file) => file.size > EMAIL_ATTACHMENT_LIMITS.maxUploadBytes);
  const problem = oversizedUploads.length
    ? `${oversizedUploads[0].name} is ${formatBytes(oversizedUploads[0].size)}. Each upload can be at most 10 MB.`
    : bytes > EMAIL_ATTACHMENT_LIMITS.maxTotalBytes
      ? `The attachments add up to ${formatBytes(bytes)}. An email can carry at most 18 MB. Remove an attachment to send.`
      : count > EMAIL_ATTACHMENT_LIMITS.maxAttachments
        ? `An email can carry at most ${EMAIL_ATTACHMENT_LIMITS.maxAttachments} attachments. Remove ${count - EMAIL_ATTACHMENT_LIMITS.maxAttachments} to send.`
        : null;
  return { count, bytes, problem };
}
