// "Report a problem" (Sentry's feedback form). Only signed-in people see it:
// the integration never puts its button on the page by itself, and
// ReportProblem (components/report-problem.tsx) adds it after sign-in.
//
// "Request a response": a tick box under the form's email field, off by
// default, as in arcforgelabs/flow. A report sent with the box ticked and an
// email is tagged notify=yes; the Sentry-to-ClickUp relay copies that tag onto
// the support task, so the support desk replies. Every other report is
// notify=no. The address itself stays in Sentry. Sentry's form has no tick
// box of its own, so Field adds one to it.

/** The id of the element that holds the form's shadow root. */
export const FEEDBACK_HOST_ID = "sentry-feedback";

export const RESPONSE_LABEL = "Request a response";

interface FeedbackLike {
  type?: string;
  tags?: Record<string, unknown>;
  contexts?: { feedback?: { contact_email?: unknown } };
}

export function tagNotify(event: FeedbackLike | null | undefined, wantsResponse = false): void {
  if (event?.type !== "feedback") return;
  const email = String(event.contexts?.feedback?.contact_email ?? "").trim();
  event.tags = { ...event.tags, notify: wantsResponse && email ? "yes" : "no" };
}

export function feedbackRoot(): ShadowRoot | null {
  return document.getElementById(FEEDBACK_HOST_ID)?.shadowRoot ?? null;
}

/** True when the form open now has "Request a response" ticked. */
export function responseRequested(root: ParentNode | null | undefined): boolean {
  const box = root?.querySelector<HTMLInputElement>('.form__response input[name="response"]');
  return Boolean(box?.checked);
}

// The tick box is inside the form's shadow root, so index.css cannot reach
// it: its look comes from the form's own variables. Ticked, the email is
// required.
const RESPONSE_STYLE = `
.form__response { display: flex; flex-direction: row; align-items: center; gap: 8px; margin: 0; cursor: pointer; }
.form__response input { margin: 0; width: 16px; height: 16px; accent-color: var(--accent-background); cursor: pointer; }`;

/**
 * Adds the tick box under the form's email field, once per form. Returns
 * false when there is no email field (no form open yet).
 */
export function addResponseBox(root: ShadowRoot | null | undefined): boolean {
  const email = root?.querySelector<HTMLInputElement>('input[name="email"]:not([type="hidden"])');
  if (!root || !email) return false;
  if (root.querySelector(".form__response")) return true;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.name = "response";
  box.addEventListener("change", () => {
    email.required = box.checked;
  });
  const label = document.createElement("label");
  label.className = "form__response";
  label.append(box, RESPONSE_LABEL);
  (email.closest("label") ?? email).after(label);
  if (!root.querySelector("style[data-field-response]")) {
    const style = document.createElement("style");
    style.dataset.fieldResponse = "";
    style.textContent = RESPONSE_STYLE;
    root.append(style);
  }
  return true;
}
