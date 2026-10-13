// The job's email as rows: sent, then waiting, and a failure in plain words.
import type { ScheduledEmail, SentEmail } from "@/lib/api";

export type EmailRow =
  | { kind: "sent"; at: string; record: SentEmail }
  | { kind: "queued"; at: string; record: ScheduledEmail };

export function whenLabel(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Is a failed email not confirmed (Gmail may have sent it)? Only a failure
 * known to have happened before Gmail took it is "Not sent"; a time-out, a
 * network reset, a restart or an older record is not confirmed.
 */
export function isUnconfirmed(record: Pick<ScheduledEmail, "status" | "deliveryOutcome">) {
  return record.status === "failed" && record.deliveryOutcome !== "rejected";
}

/** A failure in words an operator can act on. */
export function plainQueueError(message: string | null | undefined, record?: Pick<ScheduledEmail, "status" | "deliveryOutcome" | "resend" | "resendAfter" | "deliveryMailbox">) {
  const text = String(message || "");
  if (record && isUnconfirmed(record)) {
    if (record.resend === "blocked") {
      return "Not confirmed: Field could not tell whether Gmail sent it. Check Sent Mail; if it is not there, write it again as a new email.";
    }
    const mailbox = record.deliveryMailbox ? ` of ${record.deliveryMailbox}` : "";
    const after = record.resendAfter && Date.parse(record.resendAfter) > Date.now() ? ` after ${whenLabel(record.resendAfter)}` : "";
    // A refusal at the resend (a mailbox Field cannot reach) says why.
    const why = /cannot reach|still be delivering/i.test(text) ? ` ${text}` : "";
    return `Not confirmed: Field could not tell whether Gmail sent it.${why} Check the Sent Mail${mailbox}. If you send it again${after}, Field looks for it there first and does not send it twice.`;
  }
  if (!text) return null;
  if (/Gmail delivery was in progress|unknown outcome/i.test(text)) {
    return "Not confirmed: Field lost contact with Gmail during the send. Check Sent Mail before sending it again.";
  }
  if (/invalid_grant|not configured for/i.test(text)) return "The Gmail sign-in has expired. Reconnect Gmail, then send it again.";
  if (/changed after this email was scheduled|changed after this email was written|credited|voided/i.test(text)) return `${text}`;
  return `Gmail did not accept it: ${text}`;
}

/** Sent, then waiting, newest first; cancelled ones are left out. */
export function emailRows(sent: SentEmail[], queued: ScheduledEmail[]): EmailRow[] {
  const rows: EmailRow[] = [
    ...sent.map((record) => ({ kind: "sent" as const, at: record.ts, record })),
    ...queued
      .filter((record) => record.status !== "cancelled" && record.status !== "sent")
      .map((record) => ({ kind: "queued" as const, at: record.scheduledAt || record.updatedAt || record.createdAt, record })),
  ];
  return rows.sort((a, b) => {
    // Waiting ones first (they need attention), then sent, newest first.
    if (a.kind !== b.kind) return a.kind === "queued" ? -1 : 1;
    return String(b.at).localeCompare(String(a.at));
  });
}
