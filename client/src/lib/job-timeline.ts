// A job's activity timeline: the things that happened to it, in plain words
// (created, quote sent and accepted, invoices, payments, notes). Engine output
// such as quote rebuilds and autosaves is left out; it lives in the job log.
import type { ActivityEntry } from "./types";

export type TimelineEvent = { id: string; at: string; who: string | null; title: string; detail: string | null };

const TITLES: Record<string, string> = {
  "job.opened": "Job created",
  "quote.sent": "Quote sent",
  "quote.landed": "Quote accepted",
  "quote.status_updated": "Quote status changed",
  "invoice.milestones_generated": "Invoices set up",
  "invoice.sent": "Invoice sent",
  "invoice.payment_recorded": "Payment recorded",
  "invoice.payment_voided": "Payment removed",
  "invoice.marked_unpaid": "Invoice marked unpaid",
  "invoice.marked_unsent": "Invoice marked unsent",
  "receipt.sent": "Receipt sent",
  "note.manual": "Note added",
  "job.archived": "Job archived",
};

const SYSTEM_ACTORS = new Set(["field", "field system", "system", "user"]);

export function jobTimeline(activity: ActivityEntry[] | undefined, created?: { at?: string | null; who?: string | null }): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const entry of activity || []) {
    const title = TITLES[String(entry.kind || "")];
    const at = entry.ts || entry.createdAt || "";
    if (!title || !at) continue;
    const label = entry.actor?.label?.trim() || null;
    const detail = entry.kind === "job.opened" ? null : plainDetail((entry.body || entry.text || "").trim()) || null;
    events.push({
      id: entry.id,
      at,
      who: label && !SYSTEM_ACTORS.has(label.toLowerCase()) ? label : null,
      title,
      detail: entry.kind === "note.manual" && detail && detail.length > 140 ? `${detail.slice(0, 140).trimEnd()}…` : detail,
    });
  }
  if (created?.at && !events.some((event) => event.title === "Job created")) {
    events.push({ id: "job-created", at: created.at, who: created.who || null, title: "Job created", detail: null });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

// Older entries use the engine's words ("landed", "milestone invoice(s)").
function plainDetail(text: string) {
  return text
    .replace(/^Quote marked as landed\.\s*/, "")
    .replace(/(\d+) milestone invoice\(s\)/g, (_, count) => `${count} ${count === "1" ? "invoice" : "invoices"}`);
}
