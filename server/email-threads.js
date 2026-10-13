// Sending into the earlier Gmail conversation (owner's decision 5,
// 2026-10-13): a follow-up send for the same document line (a quote's
// revision, a milestone's invoice, its replacement or receipt, an adjustment
// note about that invoice) is offered into the conversation of the last email
// Field sent for that line, on by default.
//
// Gmail puts a message in a thread when the send names the threadId, the
// message carries In-Reply-To and References for the earlier message, and
// the subjects match (a "Re: " prefix is fine). The earlier message's own
// Message-ID is the one Field stored with its delivery attempt (`rfcMessageId`
// in the sent record); an email sent before Field recorded it is threaded by
// threadId alone.
import { readSentEmailArchive } from "./sent-email-archive.js";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Does `record` belong to the same document line as the email being written? */
export function sameDocumentLine(record, { documentType, milestoneIndex = null, creditedInvoiceNumber = null }) {
  if (!record?.threadId) return false;
  const recordType = record.documentType;
  if (documentType === "quote") return recordType === "quote";
  if (documentType === "invoice" || documentType === "receipt") {
    return (recordType === "invoice" || recordType === "receipt")
      && milestoneIndex != null && Number(record.milestoneIndex) === Number(milestoneIndex);
  }
  if (creditedInvoiceNumber) {
    return recordType === "invoice" && record.mainDocument?.number === creditedInvoiceNumber;
  }
  return false;
}

/** The last email sent for this document line, or null. */
export async function earlierEmailForLine({ jobDir, documentType, milestoneIndex = null, creditedInvoiceNumber = null }) {
  const archive = await readSentEmailArchive(jobDir).catch(() => []);
  return archive.find((record) => sameDocumentLine(record, { documentType, milestoneIndex, creditedInvoiceNumber })) || null;
}

/** What the composer shows about the earlier conversation. */
export function threadSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    subject: record.subject || null,
    sentAt: record.ts || null,
    to: record.to || [],
    threadId: record.threadId,
    // Without the earlier Message-ID, Gmail may show it as a new conversation.
    headers: Boolean(text(record.rfcMessageId)),
  };
}

/** The send's thread fields for an earlier sent record. */
export function threadFromRecord(record) {
  if (!record?.threadId) return null;
  const inReplyTo = text(record.rfcMessageId);
  const references = [text(record.references), inReplyTo].filter(Boolean).join(" ") || null;
  // The mailbox the earlier email went from: its Gmail thread id is used
  // only when the same mailbox sends again (threadIdForMailbox).
  return { threadId: record.threadId, inReplyTo, references, archiveId: record.id, gmailUser: text(record.gmailUser) };
}

/** Resolve `inReplyTo` (a sent record id on this job) to the send's thread fields; 404 when it is not this job's. */
export async function resolveReplyThread({ jobDir, inReplyTo }) {
  const id = text(inReplyTo);
  if (!id) return null;
  const archive = await readSentEmailArchive(jobDir).catch(() => []);
  const record = archive.find((entry) => entry.id === id);
  if (!record) {
    const error = new Error("the email to reply to was not sent on this job");
    error.statusCode = 404;
    error.code = "REPLY_NOT_FOUND";
    throw error;
  }
  const thread = threadFromRecord(record);
  if (!thread) {
    const error = new Error("that email has no Gmail conversation to continue");
    error.statusCode = 409;
    error.code = "REPLY_NO_THREAD";
    throw error;
  }
  return thread;
}

/** "Re: subject", as the earlier conversation's subject, so Gmail threads it. */
export function replySubject(subject) {
  const base = String(subject || "").replace(/^\s*(re:\s*)+/i, "").trim();
  return base ? `Re: ${base}` : "";
}
