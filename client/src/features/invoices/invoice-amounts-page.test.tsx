import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { api } from "@/lib/api";
import { refreshJobs } from "@/lib/use-jobs";
import type { InvoiceAmountEntry, InvoiceAmountReport, RecordingMeta } from "@/lib/types";
import { InvoiceAmountsPage } from "./invoice-amounts-page";
import { noteWithMoney, resetAmountReportCache, useAmountDecisionCount } from "./invoice-amounts-model";

const toast = vi.fn();
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast }) }));

// Synthetic, shaped like server/invoices/amount-evidence.js publicEntry().
const open: InvoiceAmountEntry = {
  jobId: "job-synthetic-a",
  invoiceNumber: "EI-2607-01-M1",
  milestone: 1,
  revision: 1,
  status: "authorised",
  state: "needs-owner-decision",
  issuedAt: "2026-07-10T01:00:00.000Z",
  recorded: { subtotal: "4650.00", taxTotal: "465.00", total: "5115.00", quoteVersion: null, quoteVersionInferred: true, frozen: false },
  storedPdf: { subtotal: "3600.00", taxTotal: "360.00", total: "3960.00", contractValue: "13200.00", drawnFromVersions: [1] },
  sentCopy: null,
  emails: [{ sentAt: "2026-07-10T01:00:00.000Z", quoteVersion: 1, hashed: false }],
  quoteVersionTotals: { 1: "13200.00", 2: "17050.00" },
  paid: "1000.00",
  settlement: null,
  options: [
    { choose: "milestone-record", subtotal: "4650.00", taxTotal: "465.00", total: "5115.00" },
    { choose: "stored-pdf", subtotal: "3600.00", taxTotal: "360.00", total: "3960.00" },
  ],
  note: "No copy of what was emailed is held. Field bills the record's 5115.00 until you settle; the emails list the quote version each send was built against.",
};

const settled: InvoiceAmountEntry = {
  ...open,
  jobId: "job-synthetic-b",
  invoiceNumber: "EI-2607-02-M1",
  status: "superseded",
  revision: 2,
  state: "settled",
  paid: "0.00",
  settlement: { source: "stored-pdf", total: "3960.00", recordedTotal: "5115.00", decidedAt: "2026-10-01T02:00:00.000Z" },
  options: [],
  note: "Settled: Field bills 3960.00.",
};

function report(invoices: InvoiceAmountEntry[]): InvoiceAmountReport {
  return { ok: true, wroteNothing: true, durationMs: 1200, summary: { jobs: 2, issuedInvoices: 2, disagreeing: invoices.length, byState: {}, errors: 0 }, invoices };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function renderPage() {
  return render(<HashRouter><InvoiceAmountsPage /></HashRouter>);
}

async function openCard() {
  await waitFor(() => expect(screen.getByRole("article", { name: "Invoice EI-2607-01-M1" })).toBeTruthy());
  return screen.getByRole("article", { name: "Invoice EI-2607-01-M1" });
}

beforeEach(() => {
  resetAmountReportCache();
  toast.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("InvoiceAmountsPage", () => {
  it("says the check can take a while, then shows each invoice, its sets of amounts, the note and settled decisions", async () => {
    let finish: (value: InvoiceAmountReport) => void = () => {};
    vi.spyOn(api, "invoiceAmountDisagreements").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderPage();
    expect(screen.getByRole("status").textContent).toMatch(/can take 15 seconds/);
    finish(report([open, settled]));

    const card = await openCard();
    // No job list loaded: the link does not show the raw job id.
    const job = within(card).getByRole("link", { name: "Open job" }) as HTMLAnchorElement;
    expect(job.getAttribute("href")).toBe("#/jobs/job-synthetic-a");
    expect(within(card).getByText("Current")).toBeTruthy();
    expect(within(card).getByText("Needs your decision")).toBeTruthy();
    expect(within(card).getByText("$1,000.00")).toBeTruthy();
    expect(within(card).getByText("$13,200.00")).toBeTruthy();
    expect(within(card).getByText("$17,050.00")).toBeTruthy();
    const record = within(card).getByRole("radio", { name: /Milestone record/ }).closest("label") as HTMLElement;
    expect(within(record).getByText("$4,650.00")).toBeTruthy();
    expect(within(record).getByText("$465.00")).toBeTruthy();
    expect(within(record).getByText("$5,115.00")).toBeTruthy();
    const pdf = within(card).getByRole("radio", { name: /Stored PDF/ }).closest("label") as HTMLElement;
    expect(within(pdf).getByText("$3,600.00")).toBeTruthy();
    expect(within(pdf).getByText("$360.00")).toBeTruthy();
    expect(within(pdf).getByText("$3,960.00")).toBeTruthy();
    expect(within(pdf).getByText(/Matches the total of quote version 1/)).toBeTruthy();
    expect(within(card).getByText("No copy of what was emailed is held. Field bills the record's $5,115.00 until you settle; the emails list the quote version each send was built against.")).toBeTruthy();
    expect(within(card).getByText(/Field kept no copy/)).toBeTruthy();

    const done = screen.getByRole("article", { name: "Invoice EI-2607-02-M1" });
    expect(within(done).getByText("Superseded")).toBeTruthy();
    expect(within(done).getByRole("note").textContent).toMatch(/Settled with the stored PDF: \$3,960\.00\. Decided 1 Oct 2026\. The record showed \$5,115\.00 before\./);
    expect(within(done).queryByRole("radio")).toBeNull();
    expect(within(done).queryByRole("button", { name: "Settle invoice" })).toBeNull();
    expect(within(done).getByText("Chosen")).toBeTruthy();
  });

  it("needs a chosen set and a reason before it can settle", async () => {
    vi.spyOn(api, "invoiceAmountDisagreements").mockResolvedValue(report([open]));
    const settle = vi.spyOn(api, "settleInvoiceAmounts");
    renderPage();
    const card = await openCard();
    const button = within(card).getByRole("button", { name: "Settle invoice" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(card).getByText("Choose a set of amounts.")).toBeTruthy();
    fireEvent.click(within(card).getByRole("radio", { name: /Stored PDF/ }));
    expect(button.disabled).toBe(true);
    expect(within(card).getByText("Type a reason.")).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(/Reason/), { target: { value: "   " } });
    expect(button.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(/Reason/), { target: { value: "Customer paid from the July PDF" } });
    expect(button.disabled).toBe(false);
    expect(settle).not.toHaveBeenCalled();
  });

  it("confirms the chosen total, sends that set's total from the report, then checks again", async () => {
    const load = vi.spyOn(api, "invoiceAmountDisagreements")
      .mockResolvedValueOnce(report([open]))
      .mockResolvedValueOnce(report([{ ...open, state: "settled", options: [], settlement: { source: "stored-pdf", total: "3960.00", recordedTotal: "5115.00", decidedAt: "2026-10-13T00:00:00.000Z" } }]));
    const settle = vi.spyOn(api, "settleInvoiceAmounts").mockResolvedValue({ ok: true, settlement: {} });
    renderPage();
    const card = await openCard();
    fireEvent.click(within(card).getByRole("radio", { name: /Stored PDF/ }));
    fireEvent.change(within(card).getByLabelText(/Reason/), { target: { value: "  Customer paid from the July PDF  " } });
    fireEvent.click(within(card).getByRole("button", { name: "Settle invoice" }));

    const dialog = screen.getByRole("alertdialog", { name: "Settle EI-2607-01-M1 at $3,960.00?" });
    expect(dialog.textContent).toMatch(/total \$3,960\.00/);
    expect(dialog.textContent).toMatch(/Reason: Customer paid from the July PDF/);
    expect(settle).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Settle at $3,960.00" }));

    await waitFor(() => expect(settle).toHaveBeenCalledWith({
      jobId: "job-synthetic-a",
      invoiceNumber: "EI-2607-01-M1",
      choose: "stored-pdf",
      total: "3960.00",
      reason: "Customer paid from the July PDF",
    }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(toast).toHaveBeenCalledWith("EI-2607-01-M1 settled at $3,960.00.");
    await waitFor(() => expect(screen.getByRole("heading", { name: /Settled/ })).toBeTruthy());
  });

  it("shows the server's words when it refuses to settle (409), and keeps the choice", async () => {
    vi.spyOn(api, "invoiceAmountDisagreements").mockResolvedValue(report([open]));
    const message = "the stored PDF for EI-2607-01-M1 totals 3960.00, not 3961.00; reload and choose again";
    vi.spyOn(api, "settleInvoiceAmounts").mockRejectedValue(httpError(409, message));
    renderPage();
    const card = await openCard();
    fireEvent.click(within(card).getByRole("radio", { name: /Stored PDF/ }));
    fireEvent.change(within(card).getByLabelText(/Reason/), { target: { value: "July PDF" } });
    fireEvent.click(within(card).getByRole("button", { name: "Settle invoice" }));
    fireEvent.click(screen.getByRole("button", { name: "Settle at $3,960.00" }));

    await waitFor(() => expect(within(card).getByRole("alert").textContent).toBe(`Field did not settle EI-2607-01-M1: ${message}`));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((within(card).getByRole("radio", { name: /Stored PDF/ }) as HTMLInputElement).checked).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it("explains a report that is already running (409) or ran out of time (504) in plain words", async () => {
    vi.spyOn(api, "invoiceAmountDisagreements")
      .mockRejectedValueOnce(httpError(409, "The invoice amount report is already running. Try again when it has finished."))
      .mockRejectedValueOnce(httpError(504, "Gateway Timeout"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Another check of invoice amounts is running now\. Wait one minute, then try again\./));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/The check did not finish in time\. Nothing changed\./));
  });

  it("offers only the sent copy when Field holds what it emailed", async () => {
    const withSent: InvoiceAmountEntry = {
      ...open,
      state: "sent-differs-from-recorded",
      sentCopy: { subtotal: "3600.00", taxTotal: "360.00", total: "3960.00", sentAt: "2026-07-10T01:00:00.000Z", drawnFromVersions: [1] },
      options: [{ choose: "sent-copy", subtotal: "3600.00", taxTotal: "360.00", total: "3960.00" }],
    };
    vi.spyOn(api, "invoiceAmountDisagreements").mockResolvedValue(report([withSent]));
    renderPage();
    const card = await openCard();
    expect(within(card).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["sent-copy"]);
    expect(within(card).getAllByText("Field holds the copy it emailed. Only the sent copy can be chosen.")).toHaveLength(2);
  });

  it("names the job by its number and address when the job list is already loaded", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue([
      { id: "job-synthetic-a", quoteNumber: "EQ-2607-01", siteAddress: "1 Example Road, Testville" } as RecordingMeta,
    ]);
    await refreshJobs();
    vi.spyOn(api, "invoiceAmountDisagreements").mockResolvedValue(report([open]));
    renderPage();
    const card = await openCard();
    const link = within(card).getByRole("link", { name: "Open job EQ-2607-01 · 1 Example Road, Testville" });
    expect(link.getAttribute("href")).toBe("#/jobs/job-synthetic-a");
  });
});

describe("noteWithMoney", () => {
  it("shows the note's bare amounts as money and leaves other numbers alone", () => {
    expect(noteWithMoney("Field holds the copy it emailed (3960.00), but the job page still bills the record's 15115.00 until you settle with \"sent-copy\"."))
      .toBe("Field holds the copy it emailed ($3,960.00), but the job page still bills the record's $15,115.00 until you settle with \"sent-copy\".");
    expect(noteWithMoney("Quote version 2 and 3 emails.")).toBe("Quote version 2 and 3 emails.");
  });
});

describe("useAmountDecisionCount", () => {
  it("never runs the report for someone who is not an owner", () => {
    const load = vi.spyOn(api, "invoiceAmountDisagreements");
    const { result } = renderHook(() => useAmountDecisionCount(false));
    expect(result.current).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("counts every invoice not settled yet, sent copy found included", async () => {
    vi.spyOn(api, "invoiceAmountDisagreements").mockResolvedValue(report([open, { ...open, invoiceNumber: "EI-2607-03-M1" }, settled, { ...open, invoiceNumber: "EI-2607-04-M1", state: "sent-differs-from-recorded" }]));
    const { result } = renderHook(() => useAmountDecisionCount(true));
    await waitFor(() => expect(result.current).toBe(3));
  });
});
