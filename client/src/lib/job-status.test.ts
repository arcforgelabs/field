import { describe, expect, it } from "vitest";
import type { MilestoneInvoice, RecordingMeta } from "./types";
import { invoiceState, jobNextStep, jobStatus, relativeDay } from "./job-status";

// Local times, so the tests read the same in every timezone.
const now = new Date(2026, 9, 12, 10, 0);
const local = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString();

function job(overrides: Partial<RecordingMeta> = {}): RecordingMeta {
  return { id: "job-1", createdAt: "2026-10-01T00:00:00Z", outputMode: "quote", quoteCatalogId: "c", status: "complete", ...overrides } as RecordingMeta;
}

function invoice(overrides: Partial<MilestoneInvoice> = {}): MilestoneInvoice {
  return {
    id: "i", jobId: "job-1", quoteId: null, milestoneIndex: 0, milestoneLabel: "Deposit", invoiceNumber: "EI-1-M1", receiptNumber: "ER-1-M1",
    reference: null, percentage: 50, subtotal: 100, gst: 10, total: 110, currency: "AUD", amountPaid: 0, amountDue: 110, lineItems: [],
    dueDate: null, issuedAt: null, paidAt: null, status: "draft", payments: [], pdfPath: null, receiptPdfPath: null, ...overrides,
  };
}

describe("job status", () => {
  it("maps the pipeline stage and invoices to the board's columns", () => {
    expect(jobStatus(job())).toBe("draft");
    expect(jobStatus(job({ pipelineStage: "sent" }))).toBe("quoted");
    expect(jobStatus(job({ pipelineStage: "lost" }))).toBe("lost");
    expect(jobStatus(job({ pipelineStage: "landed" }))).toBe("invoicing");
    expect(jobStatus(job({ pipelineStage: "landed", milestoneInvoices: [invoice({ status: "paid", amountDue: 0 })] }))).toBe("paid");
    expect(jobStatus(job({ pipelineStage: "landed", milestoneInvoices: [invoice({ status: "paid" }), invoice({ milestoneIndex: 1 })] }))).toBe("invoicing");
  });

  it("calls a sent invoice overdue only once its due date has passed and money is owed", () => {
    expect(invoiceState(invoice(), now)).toBe("not-sent");
    expect(invoiceState(invoice({ status: "authorised", dueDate: "2026-10-12" }), now)).toBe("sent");
    expect(invoiceState(invoice({ status: "authorised", dueDate: "2026-10-11" }), now)).toBe("overdue");
    expect(invoiceState(invoice({ status: "authorised", dueDate: "2026-10-11", amountDue: 0 }), now)).toBe("sent");
    expect(invoiceState(invoice({ status: "paid", dueDate: "2026-10-01" }), now)).toBe("paid");
  });

  it("names the next step for a card", () => {
    expect(jobNextStep(job({ pipelineStage: "sent", quoteSentAt: "2026-10-01T00:00:00Z" }), now).text).toMatch(/follow up/);
    // Moved to Sent by hand: nothing was delivered, so there is no send date.
    expect(jobStatus(job({ pipelineStage: "sent", quoteSentAt: null }))).toBe("quoted");
    expect(jobNextStep(job({ pipelineStage: "sent", quoteSentAt: null }), now).text).toBe("Quoted");
    expect(jobNextStep(job({ pipelineStage: "landed", milestoneInvoices: [invoice()] }), now).text).toBe("Send deposit invoice");
    expect(jobNextStep(job({ pipelineStage: "landed", milestoneInvoices: [invoice({ status: "authorised", dueDate: "2026-10-01" })] }), now)).toEqual({ text: "Invoice overdue", tone: "bad" });
  });

  it("describes days in plain words", () => {
    expect(relativeDay(local(12, 1), now)).toBe("today");
    expect(relativeDay(local(11, 12), now)).toBe("yesterday");
    expect(relativeDay(local(5, 12), now)).toBe("7 days ago");
  });
});
