import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MilestoneInvoice } from "@/lib/types";
import { CreditInvoiceDialog } from "./job-invoices";

const invoice = {
  id: "m1",
  jobId: "job-1",
  quoteId: null,
  milestoneIndex: 0,
  milestoneLabel: "Deposit",
  invoiceNumber: "INV-2026-10-1",
  receiptNumber: "ER-2610-01-M1",
  reference: "EQ-2610-01",
  percentage: 50,
  subtotal: 400,
  gst: 40,
  total: 440,
  amountPaid: 200,
  amountDue: 240,
  status: "authorised",
  payments: [],
} as unknown as MilestoneInvoice;

describe("CreditInvoiceDialog", () => {
  it("needs a reason, says what happens to the money, and credits with the reason", () => {
    const onCredit = vi.fn();
    render(<CreditInvoiceDialog invoice={invoice} onCancel={() => {}} onCredit={onCredit} />);
    expect(screen.getByRole("dialog", { name: "Credit and reissue INV-2026-10-1" })).toBeTruthy();
    expect(screen.getByText(/credit note for the full \$440\.00 of INV-2026-10-1/)).toBeTruthy();
    expect(screen.getByText(/\$200\.00 already paid moves to the new invoice/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Credit and reissue" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  Approved variation  " } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onCredit).toHaveBeenCalledWith("Approved variation");
  });
});
