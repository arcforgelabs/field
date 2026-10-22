import { describe, expect, it } from "vitest";
import { addResponseBox, RESPONSE_LABEL, responseRequested, tagNotify } from "./sentry-feedback";

describe("problem report notify tag", () => {
  it("a problem report is tagged notify=yes only when a response was asked for with an email", () => {
    const asked = { type: "feedback", tags: { product: "field" }, contexts: { feedback: { contact_email: "someone@example.com" } } };
    tagNotify(asked, true);
    expect(asked.tags).toEqual({ product: "field", notify: "yes" });

    const emailOnly = { type: "feedback", contexts: { feedback: { contact_email: "someone@example.com" } } } as { type: string; tags?: Record<string, unknown>; contexts: object };
    tagNotify(emailOnly, false);
    expect(emailOnly.tags).toEqual({ notify: "no" });

    const blank = { type: "feedback", contexts: { feedback: { contact_email: "   " } } } as { type: string; tags?: Record<string, unknown>; contexts: object };
    tagNotify(blank, true);
    expect(blank.tags).toEqual({ notify: "no" });

    const none = { type: "feedback" } as { type: string; tags?: Record<string, unknown> };
    tagNotify(none);
    expect(none.tags).toEqual({ notify: "no" });
  });

  it("other events are left alone", () => {
    const error = { tags: { product: "field" } };
    tagNotify(error, true);
    expect(error.tags).toEqual({ product: "field" });
    expect(() => tagNotify(null)).not.toThrow();
  });
});

function formRoot(): ShadowRoot {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<form><label class="form__label">Email<input name="email" type="text"></label><textarea name="message"></textarea></form>';
  return root;
}

describe("Request a response tick box", () => {
  it("goes under the email field once, off by default", () => {
    const root = formRoot();
    expect(addResponseBox(root)).toBe(true);
    expect(addResponseBox(root)).toBe(true);
    const boxes = root.querySelectorAll(".form__response");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].textContent).toBe(RESPONSE_LABEL);
    expect(boxes[0].previousElementSibling?.querySelector('input[name="email"]')).not.toBeNull();
    expect(responseRequested(root)).toBe(false);
  });

  it("ticked, it asks for a response and makes the email required", () => {
    const root = formRoot();
    addResponseBox(root);
    const box = root.querySelector<HTMLInputElement>('input[name="response"]')!;
    const email = root.querySelector<HTMLInputElement>('input[name="email"]')!;
    box.click();
    expect(responseRequested(root)).toBe(true);
    expect(email.required).toBe(true);
    box.click();
    expect(responseRequested(root)).toBe(false);
    expect(email.required).toBe(false);
  });

  it("no form open: no box", () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    expect(addResponseBox(root)).toBe(false);
    expect(addResponseBox(null)).toBe(false);
    expect(responseRequested(null)).toBe(false);
  });
});
