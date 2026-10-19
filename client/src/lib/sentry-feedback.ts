// "Report a problem" has an optional email field. A person who types an
// address asks to hear back, so the report is tagged notify=yes; the
// Sentry-to-ClickUp relay copies that tag onto the support task. The address
// itself stays in Sentry.

interface FeedbackLike {
  type?: string;
  tags?: Record<string, unknown>;
  contexts?: { feedback?: { contact_email?: unknown } };
}

export function tagNotify(event: FeedbackLike | null | undefined): void {
  if (event?.type !== "feedback") return;
  const email = String(event.contexts?.feedback?.contact_email ?? "").trim();
  event.tags = { ...event.tags, notify: email ? "yes" : "no" };
}
