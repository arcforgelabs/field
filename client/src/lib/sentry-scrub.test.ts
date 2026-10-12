// The browser loads the same scrubber as the server (instrument.ts imports
// shared/sentry-scrub.js). These cases are what the browser sends: an
// exception, a click and a fetch breadcrumb, and a replay span.
import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent, scrubText } from "../../../shared/sentry-scrub.js";

describe("browser Sentry scrubbing", () => {
  it("an exception loses document numbers and amounts", () => {
    const event = scrubEvent({
      exception: { values: [{ type: "Error", value: "Could not send EI-2501-01-M1 for $1,018.05 (INV-2026-10-3, 925.50)" }] },
    });
    expect(event.exception.values[0].value).toBe("Could not send [doc] for [amount] ([doc], [amount])");
  });

  it("click and fetch breadcrumbs lose them too", () => {
    expect(scrubBreadcrumb({ category: "ui.click", message: "button.send > span EQ-2501-01 v2" })?.message).toBe("button.send > span [doc]");
    expect(scrubBreadcrumb({ category: "fetch", data: { url: "/api/documents/RCT-2026-1-12/pdf", status_code: 404 } })?.data).toEqual({
      url: "/api/documents/[doc]/pdf",
      status_code: 404,
    });
  });

  it("a replay span description keeps its route and uuid", () => {
    const uuid = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
    expect(scrubText(`/api/jobs/${uuid}/invoices 200`)).toBe(`/api/jobs/${uuid}/invoices 200`);
  });
});
