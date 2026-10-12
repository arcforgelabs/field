import { appendFile, readFile } from "./storage/fs-promises.js";
import { join } from "node:path";

const SENT_EMAIL_ARCHIVE = "sent-emails.jsonl";

export async function appendSentEmailArchive({ jobDir, record }) {
  if (!jobDir) throw new Error("jobDir required");
  const archivePath = join(jobDir, SENT_EMAIL_ARCHIVE);
  const normalized = {
    id: record.id || `sent_${Date.now()}`,
    ts: record.ts || new Date().toISOString(),
    kind: record.kind || "email.sent",
    documentType: record.documentType || null,
    messageId: record.messageId || null,
    threadId: record.threadId || null,
    authMode: record.authMode || null,
    gmailUser: record.gmailUser || null,
    from: record.from || null,
    fromName: record.fromName || null,
    replyTo: record.replyTo || null,
    to: Array.isArray(record.to) ? record.to : [],
    cc: Array.isArray(record.cc) ? record.cc : [],
    // Bcc too (#51): the operator sees everyone the email went to. It stays
    // out of the email the customer gets, as Gmail sends it.
    bcc: Array.isArray(record.bcc) ? record.bcc : [],
    subject: record.subject || null,
    bodyText: record.bodyText || "",
    htmlBody: record.htmlBody || "",
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
    // The document the email was for, by type and number as issued.
    mainDocument: record.mainDocument && typeof record.mainDocument === "object" ? record.mainDocument : null,
    quoteVersion: record.quoteVersion ?? null,
    milestoneIndex: record.milestoneIndex ?? null,
    scheduledEmailId: record.scheduledEmailId || null,
    scheduledAt: record.scheduledAt || null,
    sentBy: record.sentBy || null,
    // Found in Sent Mail after a send of unknown outcome, not sent again.
    ...(record.reconciled === true ? { reconciled: true } : {}),
  };
  await appendFile(archivePath, `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export async function readSentEmailArchive(jobDir) {
  try {
    const text = await readFile(join(jobDir, SENT_EMAIL_ARCHIVE), "utf8");
    return text
      .split(/\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
