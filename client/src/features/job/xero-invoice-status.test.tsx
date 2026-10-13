import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/lib/api";
import type { XeroInvoiceState, XeroPushPreview } from "@/lib/types";
import { XeroInvoiceStatus, XeroPushDialog } from "./xero-invoice-status";

function entry(overrides: Partial<XeroInvoiceState>): XeroInvoiceState {
  return { invoiceUid: "inv_01ARZ3NDEKTSV4RRFFQ69G5FAV", state: "created", label: "Xero draft created", xeroStatus: "DRAFT", reason: null, nextAttemptAt: null, canRetry: false, canSend: false, ...overrides };
}

afterEach(() => vi.restoreAllMocks());

describe("XeroInvoiceStatus", () => {
  it("shows the Xero state as a pill: draft created, approved", () => {
    const { rerender } = render(<XeroInvoiceStatus entry={entry({})} isOwner onRetry={() => {}} onSend={() => {}} />);
    expect(screen.getByText("Xero draft created").className).toMatch(/fx-status--paid/);
    rerender(<XeroInvoiceStatus entry={entry({ label: "Approved in Xero", xeroStatus: "AUTHORISED" })} isOwner onRetry={() => {}} onSend={() => {}} />);
    expect(screen.getByText("Approved in Xero")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a failure shows the plain reason, and owners get Retry", () => {
    const onRetry = vi.fn();
    const failed = entry({ state: "failed", label: "Xero failed", reason: "Xero refused it: Account code '200' is not a valid code for this document.", canRetry: true });
    render(<XeroInvoiceStatus entry={failed} isOwner onRetry={onRetry} onSend={() => {}} />);
    expect(screen.getByText("Xero failed").className).toMatch(/fx-status--overdue/);
    expect(screen.getByText(/Account code '200' is not a valid code/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  it("staff see the state and the reason, without Retry or Send", () => {
    render(<XeroInvoiceStatus entry={entry({ state: "failed", label: "Xero failed", reason: "Xero refused it.", canRetry: true })} isOwner={false} onRetry={() => {}} onSend={() => {}} />);
    expect(screen.getByText("Xero refused it.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("not sent: owners can send it to Xero", () => {
    const onSend = vi.fn();
    render(<XeroInvoiceStatus entry={entry({ state: "not-sent", label: "Not sent to Xero", xeroStatus: null, canSend: true })} isOwner onRetry={() => {}} onSend={onSend} />);
    expect(screen.getByText("Not sent to Xero").className).toMatch(/fx-status--draft/);
    fireEvent.click(screen.getByRole("button", { name: /Send to Xero/ }));
    expect(onSend).toHaveBeenCalled();
  });

  it("credited in Field after it reached Xero: says to void it in Xero, with the reason, and no Retry", () => {
    render(<XeroInvoiceStatus entry={entry({ state: "void-in-xero", label: "Void this in Xero", xeroStatus: "AUTHORISED", reason: "It was credited in Field after it reached Xero, and Xero still has it. Void it, or credit it, in Xero.", canRetry: true })} isOwner onRetry={() => {}} onSend={() => {}} />);
    expect(screen.getByText("Void this in Xero").className).toMatch(/fx-status--overdue/);
    expect(screen.getByText(/credited in Field after it reached Xero/).className).toMatch(/fx-xero__why--bad/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("held for another Xero organisation: owners can send it to the one connected now", () => {
    const onSend = vi.fn();
    render(<XeroInvoiceStatus entry={entry({ state: "held", label: "Held: another Xero organisation", reason: "It was queued for another Xero organisation.", canSend: true })} isOwner onRetry={() => {}} onSend={onSend} />);
    expect(screen.getByText("Held: another Xero organisation").className).toMatch(/fx-status--invoicing/);
    fireEvent.click(screen.getByRole("button", { name: /Send to Xero/ }));
    expect(onSend).toHaveBeenCalled();
  });

  it("sending: the reason it waits", () => {
    render(<XeroInvoiceStatus entry={entry({ state: "pending", label: "Sending to Xero", reason: "Field could not reach Xero. It tries again by itself." })} isOwner onRetry={() => {}} onSend={() => {}} />);
    expect(screen.getByText("Sending to Xero").className).toMatch(/fx-status--invoicing/);
    expect(screen.getByText(/tries again by itself/)).toBeTruthy();
  });
});

describe("XeroPushDialog", () => {
  const preview: XeroPushPreview = {
    ok: true,
    wroteNothing: true,
    connected: true,
    mode: "draft",
    invoices: [
      { invoiceUid: "inv_A", jobId: "job-1", number: "INV-2026-9-4", reference: "2609-11", customer: "Synthetic Customer", issuedAt: "2026-09-20T01:00:00.000Z", total: "440.00", status: "issued", creates: "Draft invoice", previously: null, problem: null },
      { invoiceUid: "inv_B", jobId: "job-2", number: "INV-2026-9-5", reference: "2609-12", customer: null, issuedAt: "2026-09-21T01:00:00.000Z", total: "110.00", status: "paid", creates: "Draft invoice", previously: null, problem: "It has no customer name or email for the Xero contact." },
    ],
  };

  it("previews first, then sends the invoices chosen; one with a problem cannot be chosen", async () => {
    const previewing = vi.spyOn(api, "previewXeroPush").mockResolvedValue(preview);
    const push = vi.spyOn(api, "pushToXero").mockResolvedValue({ ok: true, queued: ["inv_A"], mode: "draft" });
    const onSent = vi.fn();
    render(<XeroPushDialog sinceDays={90} onCancel={() => {}} onSent={onSent} />);
    await waitFor(() => expect(screen.getByText("INV-2026-9-4")).toBeTruthy());
    expect(previewing).toHaveBeenCalledWith({ sinceDays: 90 });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText(/as drafts, each with its PDF/)).toBeTruthy();
    expect(screen.getByText(/no customer name or email/)).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send 1 to Xero" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(["inv_A"]));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(1));
  });

  it("says when there is nothing to send", async () => {
    vi.spyOn(api, "previewXeroPush").mockResolvedValue({ ...preview, invoices: [] });
    render(<XeroPushDialog invoiceUids={["inv_A"]} onCancel={() => {}} onSent={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nothing to send/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Send 0 to Xero" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
