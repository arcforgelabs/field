// The composer's rules that need no screen: the undo window, a failed send
// in plain words, and a template's body with its signature.
import { renderComposerTemplate, renderSignature } from "../../../../shared/email-templates.js";
import type { EmailContext } from "@/lib/api";

// Undo send (owner's decision 3): the server holds a send this long, and
// Undo is Cancel send.
export const UNDO_SECONDS = 10;

/** A send that failed, in words the operator can act on. */
export function plainSendError(err: unknown) {
  const error = err as Error & { code?: unknown; status?: number; deliveryOutcome?: unknown };
  const message = error instanceof Error ? error.message : "The email could not be sent.";
  if (error?.code === "DELIVERY_OUTCOME_UNKNOWN") {
    return "Not confirmed: Field lost contact with Gmail during an earlier send, and checks Sent Mail for it before it allows another. Look in Sent Mail before you send it again.";
  }
  if (error?.code === "FIELD_STORAGE_UNAVAILABLE" || error?.status === 503) return `Field could not record the send first, so nothing was sent. Try again. (${message})`;
  if (error?.status === 413 || error?.status === 409 || error?.status === 410 || error?.status === 404 || error?.status === 400) return message;
  if (error?.status === 403) return `This installation does not send to these addresses. ${message}`;
  // Only a failure known to be before Gmail took it is "not sent"; a
  // time-out, a reset or a 5xx may have sent it.
  if (error?.deliveryOutcome === "rejected") return `Gmail did not accept the email: ${message}`;
  return `Not confirmed: Field could not tell whether Gmail sent it (${message}). Check Sent Mail before you send it again.`;
}

/** How long Undo stays: until the server's hold ends, never longer than the hold. */
export function undoWindowMs(scheduledAt: string | null | undefined, requestedAt: number, now = Date.now()) {
  const byRequest = UNDO_SECONDS * 1000 - (now - requestedAt);
  const due = Date.parse(String(scheduledAt || ""));
  const byServer = Number.isFinite(due) ? due - now : byRequest;
  return Math.max(0, Math.min(byRequest, byServer, UNDO_SECONDS * 1000));
}

/** The body for a template: the server's template with its values, then the signature. */
export function composeTemplateBody(template: { html: string }, context: Pick<EmailContext, "mergeValues" | "signature">) {
  const html = renderComposerTemplate(template, context.mergeValues).html;
  // A template that signs off itself (an owner-edited one) is not signed twice.
  if (/Regards,|Kind regards|Thanks,/i.test(html)) return html;
  return `${html}${renderSignature(context.signature?.html || null, context.mergeValues)}`;
}
