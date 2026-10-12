// Where a job stands, derived from its list meta: the one place the jobs
// board, the jobs list, the job page and the invoices ledger read status from.
import type { MilestoneInvoice, PipelineStage, RecordingMeta } from "./types";

/** The board's columns, plus Lost (hidden unless asked for). */
export type JobStatus = "draft" | "quoted" | "invoicing" | "paid" | "lost";

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  draft: "Draft",
  quoted: "Quoted",
  invoicing: "Invoicing",
  paid: "Paid",
  lost: "Lost",
};

export function jobStage(meta: Pick<RecordingMeta, "pipelineStage" | "deliveryStatus">): PipelineStage {
  return meta.pipelineStage || meta.deliveryStatus || "draft";
}

export function jobInvoices(meta: Pick<RecordingMeta, "milestoneInvoices">): MilestoneInvoice[] {
  return [...(meta.milestoneInvoices || [])].sort((a, b) => a.milestoneIndex - b.milestoneIndex);
}

export function jobStatus(meta: RecordingMeta): JobStatus {
  const stage = jobStage(meta);
  if (stage === "lost") return "lost";
  if (stage === "draft") return "draft";
  if (stage === "sent") return "quoted";
  const invoices = jobInvoices(meta);
  if (invoices.length > 0 && invoices.every((invoice) => invoice.status === "paid")) return "paid";
  return "invoicing";
}

export function jobTitle(meta: Pick<RecordingMeta, "siteAddress" | "title" | "label">): string {
  return meta.siteAddress || meta.title || meta.label || "Untitled job";
}

export function jobCustomer(meta: Pick<RecordingMeta, "customerName" | "contactName">): string {
  return meta.customerName || meta.contactName || "";
}

export function jobRef(meta: Pick<RecordingMeta, "quoteNumber" | "jobNumber" | "id">): string {
  return meta.quoteNumber || meta.jobNumber || meta.id.slice(0, 8);
}

/** The quote total including GST, or null before anything is priced. */
export function jobTotal(meta: Pick<RecordingMeta, "quoteTotal">): number | null {
  return typeof meta.quoteTotal === "number" ? meta.quoteTotal : null;
}

export function jobPaid(meta: RecordingMeta): number {
  if (typeof meta.totalInvoicePaidAmount === "number") return meta.totalInvoicePaidAmount;
  return jobInvoices(meta).reduce((sum, invoice) => sum + (invoice.amountPaid || 0), 0);
}

function startOfToday(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export type InvoiceState = "not-sent" | "sent" | "overdue" | "paid";

export function invoiceState(invoice: MilestoneInvoice, now = new Date()): InvoiceState {
  if (invoice.status === "paid") return "paid";
  if (invoice.status === "draft") return "not-sent";
  if (invoice.dueDate && (invoice.amountDue ?? 0) > 0) {
    const due = new Date(`${invoice.dueDate.slice(0, 10)}T00:00:00`).getTime();
    if (due < startOfToday(now)) return "overdue";
  }
  return "sent";
}

export const INVOICE_STATE_LABEL: Record<InvoiceState, string> = {
  "not-sent": "Not sent",
  sent: "Sent",
  overdue: "Overdue",
  paid: "Paid",
};

export const INVOICE_STATE_TONE: Record<InvoiceState, string> = {
  "not-sent": "draft",
  sent: "quoted",
  overdue: "overdue",
  paid: "paid",
};

/** The next milestone invoice that still needs sending or paying. */
export function nextOpenInvoice(meta: RecordingMeta): MilestoneInvoice | null {
  return jobInvoices(meta).find((invoice) => invoice.status !== "paid") || null;
}

/** The one-line "what happens next" for a job, as the board card shows it. */
export function jobNextStep(meta: RecordingMeta, now = new Date()): { text: string; tone?: "bad" } {
  const status = jobStatus(meta);
  if (status === "draft") return { text: `Updated ${relativeDay(jobUpdatedAt(meta), now)}` };
  if (status === "quoted") {
    const sentAt = meta.quoteSentAt;
    if (!sentAt) return { text: "Quoted" };
    const days = (now.getTime() - new Date(sentAt).getTime()) / 86_400_000;
    return { text: `Sent ${relativeDay(sentAt, now)}${days >= 7 ? " · follow up" : ""}` };
  }
  if (status === "lost") return { text: `Lost ${meta.lostAt ? relativeDay(meta.lostAt, now) : ""}`.trim(), tone: "bad" };
  const invoices = jobInvoices(meta);
  if (status === "paid") {
    const last = invoices.map((invoice) => invoice.paidAt).filter(Boolean).sort().pop();
    return { text: last ? `Paid ${relativeDay(last, now)}` : "Paid" };
  }
  if (invoices.some((invoice) => invoiceState(invoice, now) === "overdue")) return { text: "Invoice overdue", tone: "bad" };
  if (!invoices.length) return { text: "Set up the invoices" };
  const sent = invoices.find((invoice) => invoice.status === "authorised");
  if (sent) return { text: `${sent.milestoneLabel} invoice sent` };
  const next = invoices.find((invoice) => invoice.status === "draft");
  return { text: next ? `Send ${next.milestoneLabel.toLowerCase()} invoice` : "Invoicing" };
}

export function jobUpdatedAt(meta: RecordingMeta): string {
  const candidates = [meta.createdAt, meta.quoteSentAt, meta.landedAt, meta.lostAt, meta.invoiceSentAt]
    .concat(jobInvoices(meta).flatMap((invoice) => [invoice.issuedAt, invoice.paidAt]))
    .filter((value): value is string => Boolean(value));
  return candidates.sort().pop() || meta.createdAt;
}

export function relativeDay(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.round((startOfToday(now) - startOfToday(then)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  if (days < 0) return `in ${-days} days`;
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: then.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function moneyRound(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${Math.round(value).toLocaleString("en-AU")}`;
}
