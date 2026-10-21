import { describe, expect, it } from "vitest";
import { tagNotify } from "./sentry-feedback";

describe("problem report notify tag", () => {
  it("a problem report is tagged notify=yes only when the person typed an email", () => {
    const withEmail = { type: "feedback", tags: { product: "field" }, contexts: { feedback: { contact_email: "someone@example.com" } } };
    tagNotify(withEmail);
    expect(withEmail.tags).toEqual({ product: "field", notify: "yes" });

    const blank = { type: "feedback", contexts: { feedback: { contact_email: "   " } } } as { type: string; tags?: Record<string, unknown>; contexts: object };
    tagNotify(blank);
    expect(blank.tags).toEqual({ notify: "no" });

    const none = { type: "feedback" } as { type: string; tags?: Record<string, unknown> };
    tagNotify(none);
    expect(none.tags).toEqual({ notify: "no" });
  });

  it("other events are left alone", () => {
    const error = { tags: { product: "field" } };
    tagNotify(error);
    expect(error.tags).toEqual({ product: "field" });
    expect(() => tagNotify(null)).not.toThrow();
  });
});
