import { describe, expect, it } from "vitest";
import { jobTimeline } from "./job-timeline";

describe("jobTimeline", () => {
  it("keeps what happened to the job and drops engine output", () => {
    const events = jobTimeline([
      { id: "1", kind: "job.opened", ts: "2026-10-01T00:00:00Z", actor: { kind: "system", label: "Field" }, body: "General Site Works — 1 Collins Street" },
      { id: "2", kind: "quote.updated", ts: "2026-10-02T00:00:00Z", actor: { kind: "user", label: "Alex" }, body: "customer-facing presentation updated" },
      { id: "3", kind: "gap.detected", ts: "2026-10-02T00:00:00Z", body: "site access constraints" },
      { id: "4", kind: "quote.sent", ts: "2026-10-03T00:00:00Z", actor: { kind: "system", label: "Field" }, body: "Quote emailed to customer@example.invalid." },
      { id: "5", kind: "note.manual", ts: "2026-10-04T00:00:00Z", actor: { kind: "user", label: "Alex Operator" }, body: "Gate code 1234" },
    ]);
    expect(events.map((event) => event.title)).toEqual(["Note added", "Quote sent", "Job created"]);
    expect(events[0]).toMatchObject({ who: "Alex Operator", detail: "Gate code 1234" });
    expect(events[1].who).toBeNull();
    expect(events[2].detail).toBeNull();
  });

  it("says accepted and invoices, not landed and milestone invoice(s)", () => {
    const [accepted] = jobTimeline([
      { id: "1", kind: "quote.landed", ts: "2026-10-05T00:00:00Z", actor: { kind: "user", label: "User" }, body: "Quote marked as landed. 3 milestone invoice(s) prepared." },
    ]);
    expect(accepted).toMatchObject({ title: "Quote accepted", who: null, detail: "3 invoices prepared." });
  });

  it("adds a created event from the job when the log has none", () => {
    expect(jobTimeline([], { at: "2026-10-01T00:00:00Z" })).toEqual([
      { id: "job-created", at: "2026-10-01T00:00:00Z", who: null, title: "Job created", detail: null },
    ]);
  });
});
