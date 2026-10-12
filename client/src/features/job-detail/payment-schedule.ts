import type {
  MilestoneInvoice,
  PaymentSchedule,
  PaymentScheduleMilestone,
} from "@/lib/types";

export type MilestoneScheduleDraftRow = {
  id: string;
  label: string;
  percentage: string;
  fixedTotal: string;
  dueDays: number | null;
};

export type PaymentScheduleMutationState = {
  lockedMilestones: PaymentScheduleMilestone[];
  editableMilestones: PaymentScheduleMilestone[];
  lockedPercentage: number;
  remainingPercentage: number;
  lockedCount: number;
  canEdit: boolean;
  blockedReason: string | null;
};

export const DEFAULT_PAYMENT_SCHEDULE_MILESTONES = Object.freeze([
  { label: "Deposit", percentage: 10 },
  { label: "Progress payment", percentage: 30 },
  { label: "Final payment", percentage: 60 },
]);

export function roundSchedulePercentage(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function createMilestoneDraftRow(
  label = "",
  percentage = "",
  fixedTotal = "",
  dueDays: number | null = null,
): MilestoneScheduleDraftRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    label,
    percentage,
    fixedTotal,
    dueDays,
  };
}

export function buildMilestoneDraftRows(paymentSchedule: PaymentSchedule): MilestoneScheduleDraftRow[] {
  return (paymentSchedule.milestones || []).map((milestone, index) => createMilestoneDraftRow(
    milestone.label || `Milestone ${index + 1}`,
    milestone.percentage != null ? String(milestone.percentage) : "",
    milestone.fixedTotal != null ? String(milestone.fixedTotal) : "",
    typeof milestone.dueDays === "number" ? milestone.dueDays : null,
  ));
}

export function buildPaymentScheduleFromDraftRows(rows: MilestoneScheduleDraftRow[]): PaymentSchedule {
  return {
    milestones: rows.map((row, index) => ({
      label: row.label.trim() || `Milestone ${index + 1}`,
      percentage: roundSchedulePercentage(Number(row.percentage)),
      ...(Number(row.fixedTotal) > 0 ? { fixedTotal: roundSchedulePercentage(Number(row.fixedTotal)) } : {}),
      ...(typeof row.dueDays === "number" && row.dueDays > 0 ? { dueDays: row.dueDays } : {}),
    })),
  };
}

export function buildVisiblePaymentSchedule(
  paymentSchedule: unknown,
  milestoneInvoices: MilestoneInvoice[] = [],
  fallbackSchedule: unknown = null,
): PaymentSchedule {
  const explicitSchedule = normalizeVisibleSchedule(paymentSchedule);
  if (explicitSchedule) return explicitSchedule;

  const fallbackVisibleSchedule = normalizeVisibleSchedule(fallbackSchedule);
  if (fallbackVisibleSchedule) return fallbackVisibleSchedule;

  if (milestoneInvoices.length) {
    return {
      milestones: milestoneInvoices.map((milestoneInvoice, index) => ({
        label: milestoneInvoice.milestoneLabel || `Milestone ${index + 1}`,
        percentage: roundSchedulePercentage(Number(milestoneInvoice.percentage || 0)),
        ...(Number(milestoneInvoice.fixedTotal || 0) > 0 ? { fixedTotal: roundSchedulePercentage(Number(milestoneInvoice.fixedTotal || 0)) } : {}),
      })),
    };
  }

  return {
    milestones: DEFAULT_PAYMENT_SCHEDULE_MILESTONES.map((milestone) => ({ ...milestone })),
  };
}

export function getPaymentScheduleValidationError(
  rows: MilestoneScheduleDraftRow[],
  { expectedTotal = 100 }: { expectedTotal?: number } = {},
) {
  if (!rows.length) return "Add at least one milestone.";
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.label.trim()) return `Milestone ${index + 1} needs a label.`;
    const percentage = Number(row.percentage);
    if (!Number.isFinite(percentage) || percentage <= 0) {
      return `Milestone ${index + 1} needs a percentage greater than 0.`;
    }
  }
  const total = roundSchedulePercentage(rows.reduce((sum, row) => sum + Number(row.percentage || 0), 0));
  if (total !== roundSchedulePercentage(expectedTotal)) {
    const label = roundSchedulePercentage(expectedTotal) === 100 ? "Percentages" : "Remaining percentages";
    return `${label} must sum to exactly ${roundSchedulePercentage(expectedTotal)}%.`;
  }
  return null;
}

export function isMilestoneInvoicePaidLocked(milestoneInvoice: MilestoneInvoice | null | undefined) {
  if (!milestoneInvoice) return false;
  return Boolean(milestoneInvoice.paidAt)
    || milestoneInvoice.status === "paid"
    || Number(milestoneInvoice.amountPaid || 0) > 0
    || (Array.isArray(milestoneInvoice.payments) && milestoneInvoice.payments.length > 0)
    || Number(milestoneInvoice.amountDue || 0) <= 0;
}

export function isMilestoneInvoiceLocked(milestoneInvoice: MilestoneInvoice | null | undefined) {
  if (!milestoneInvoice) return false;
  return Boolean(milestoneInvoice.issuedAt)
    || milestoneInvoice.status === "authorised"
    || isMilestoneInvoicePaidLocked(milestoneInvoice);
}

export function isMilestoneInvoiceIssuedUnpaid(milestoneInvoice: MilestoneInvoice | null | undefined) {
  if (!milestoneInvoice || isMilestoneInvoicePaidLocked(milestoneInvoice)) return false;
  return Boolean(milestoneInvoice.issuedAt) || milestoneInvoice.status === "authorised";
}

export function buildPaymentScheduleMutationState(
  paymentSchedule: PaymentSchedule,
  milestoneInvoices: MilestoneInvoice[] = [],
): PaymentScheduleMutationState {
  const milestones = Array.isArray(paymentSchedule?.milestones)
    ? paymentSchedule.milestones.map((milestone, index) => ({
        label: String(milestone?.label || "").trim() || `Milestone ${index + 1}`,
        percentage: roundSchedulePercentage(Number(milestone?.percentage || 0)),
        ...(Number(milestone?.fixedTotal || 0) > 0 ? { fixedTotal: roundSchedulePercentage(Number(milestone.fixedTotal || 0)) } : {}),
        ...(typeof milestone?.dueDays === "number" && milestone.dueDays > 0 ? { dueDays: milestone.dueDays } : {}),
      }))
    : [];
  const invoices = Array.isArray(milestoneInvoices) ? milestoneInvoices : [];
  let lockedCount = 0;
  while (lockedCount < invoices.length && isMilestoneInvoiceLocked(invoices[lockedCount])) {
    lockedCount += 1;
  }
  const hasOutOfOrderLockedMilestone = invoices.slice(lockedCount).some(isMilestoneInvoiceLocked);
  const lockedMilestones = milestones.slice(0, lockedCount);
  const editableMilestones = milestones.slice(lockedCount);
  const lockedPercentage = roundSchedulePercentage(
    lockedMilestones.reduce((sum, milestone) => sum + Number(milestone?.percentage || 0), 0),
  );
  const remainingPercentage = roundSchedulePercentage(100 - lockedPercentage);
  let blockedReason = null;
  if (hasOutOfOrderLockedMilestone) {
    blockedReason = "A later invoice is already sent or paid, so the remaining schedule cannot be reshaped safely.";
  } else if (remainingPercentage <= 0) {
    blockedReason = "Every milestone invoice is already locked.";
  }

  return {
    lockedMilestones,
    editableMilestones,
    lockedPercentage,
    remainingPercentage,
    lockedCount,
    canEdit: !blockedReason,
    blockedReason,
  };
}

function normalizeVisibleSchedule(schedule: unknown): PaymentSchedule | null {
  if (!schedule) return null;
  const milestones = Array.isArray(schedule)
    ? schedule
    : (Array.isArray((schedule as PaymentSchedule)?.milestones) ? (schedule as PaymentSchedule).milestones : null);
  if (!milestones?.length) return null;

  return {
    milestones: milestones.map((milestone, index) => ({
      label: String(milestone?.label || "").trim() || `Milestone ${index + 1}`,
      percentage: roundSchedulePercentage(Number(milestone?.percentage || 0)),
      ...(Number(milestone?.fixedTotal || 0) > 0 ? { fixedTotal: roundSchedulePercentage(Number(milestone.fixedTotal || 0)) } : {}),
      ...(typeof milestone?.dueDays === "number" && milestone.dueDays > 0 ? { dueDays: milestone.dueDays } : {}),
    })),
  };
}
