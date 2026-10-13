// The owner's report of legacy invoices whose milestone record and PDFs
// disagree (#60): one shared load per tab, so the Invoices notice and the
// screen never start two reports at once (the server refuses a second one
// with 409 while the first runs, and one run can take 15 s or more).
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { jobRef, jobTitle, money } from "@/lib/job-status";
import type { InvoiceAmountEntry, InvoiceAmountReport, InvoiceAmountSource, InvoiceAmountState, RecordingMeta } from "@/lib/types";

export const SOURCE_LABEL: Record<InvoiceAmountSource, string> = {
  "milestone-record": "Milestone record",
  "stored-pdf": "Stored PDF",
  "sent-copy": "Sent copy",
};

/** The same names inside a sentence. */
export const SOURCE_PHRASE: Record<InvoiceAmountSource, string> = {
  "milestone-record": "milestone record",
  "stored-pdf": "stored PDF",
  "sent-copy": "sent copy",
};

export const STATE_LABEL: Record<InvoiceAmountState, string> = {
  "needs-owner-decision": "Needs your decision",
  "recorded-matches-sent": "Sent copy found",
  "sent-differs-from-recorded": "Sent copy found",
  "sent-copies-differ": "Sent copies differ",
  settled: "Settled",
};

/** How many invoices wait for the owner: every one not settled yet. */
export function decisionCount(report: Pick<InvoiceAmountReport, "invoices"> | null | undefined): number {
  return (report?.invoices || []).filter((entry) => entry.state !== "settled").length;
}

/** "Open job EQ-2607-01 · 12 Example Street" when the job list is loaded, else "Open job". */
export function jobLinkLabel(job: RecordingMeta | null | undefined) {
  if (!job) return "Open job";
  return `Open job ${jobRef(job)} · ${jobTitle(job)}`;
}

/** The server's note prints bare amounts ("5115.00"): show them as money ("$5,115.00"). */
export function noteWithMoney(note: string): string {
  return note.replace(/(?<![\d.$])\d+\.\d{2}(?![\d.])/g, (figure) => money(Number(figure)));
}

/** The invoices still to settle, then the settled ones. */
export function groupEntries(invoices: InvoiceAmountEntry[]) {
  return {
    open: invoices.filter((entry) => entry.state !== "settled"),
    settled: invoices.filter((entry) => entry.state === "settled"),
  };
}

type ErrorLike = { status?: number; message?: string } | null | undefined;

/** A plain sentence for a report that did not load. */
export function reportErrorMessage(error: unknown): string {
  const err = error as ErrorLike;
  if (err?.status === 409) return "Another check of invoice amounts is running now. Wait one minute, then try again.";
  if (err?.status === 504) return "The check did not finish in time. Nothing changed. Try again in a few minutes.";
  if (err?.status === 403) return `Only an owner can see this report. ${err.message || ""}`.trim();
  return err?.message ? `The check did not run: ${err.message}` : "The check did not run. Try again.";
}

/** The server's own words for a refused settle (400, 404, 409), or a plain fallback. */
export function settleErrorMessage(error: unknown): string {
  const err = error as ErrorLike;
  if (err?.message && err.message !== "unauthorized") return err.message;
  return "Field did not settle this invoice. Try again.";
}

const COUNT_KEY = "field.invoiceAmountDecisions";
const COUNT_FRESH_MS = 10 * 60_000;

let inflight: Promise<InvoiceAmountReport> | null = null;

function rememberCount(count: number) {
  try { sessionStorage.setItem(COUNT_KEY, JSON.stringify({ count, at: Date.now() })); } catch { /* storage unavailable */ }
  listeners.forEach((listener) => listener(count));
}

function storedCount(): number | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(COUNT_KEY) || "null");
    if (raw && Number.isInteger(raw.count) && Date.now() - Number(raw.at) < COUNT_FRESH_MS) return raw.count;
  } catch { /* storage unavailable */ }
  return null;
}

const listeners = new Set<(count: number) => void>();

/** Run the report, or join the run this tab already started. */
export function loadAmountReport(): Promise<InvoiceAmountReport> {
  if (!inflight) {
    inflight = api.invoiceAmountDisagreements()
      .then((report) => { rememberCount(decisionCount(report)); return report; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Owners only: how many invoices are not settled yet, from this browser
 * session's last report (at most 10 minutes old), else from a new one run
 * quietly. 0 until known, and on any error.
 */
export function useAmountDecisionCount(enabled: boolean): number {
  const [count, setCount] = useState<number>(() => storedCount() ?? 0);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setCount);
    if (storedCount() == null) loadAmountReport().catch(() => { /* the screen shows errors; the notice stays hidden */ });
    return () => { listeners.delete(setCount); };
  }, [enabled]);
  return enabled ? count : 0;
}

/** Testing only: forget the shared load and the remembered count. */
export function resetAmountReportCache() {
  inflight = null;
  try { sessionStorage.removeItem(COUNT_KEY); } catch { /* storage unavailable */ }
}
