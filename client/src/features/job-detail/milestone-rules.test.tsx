import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/lib/api";
import type { JobMilestoneRules, RecordingDetail } from "@/lib/types";
import { CapFindings, ScheduleSourceBadge } from "./milestone-rules";
import { JobInvoices } from "@/features/job/job-invoices";

vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast: () => {} }) }));
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => ({ isOwner: false }) }));
afterEach(() => vi.restoreAllMocks());

const hard = {
  milestoneIndex: 0, kind: "deposit" as const, mode: "hard" as const, ruleUid: "mrl_1", ruleName: "SA domestic, under $20,000", valueBasis: "inc-gst" as const,
  contractValue: 16500, amount: 1650, limit: 1000,
  message: "Deposit is $1,650.00 with GST. The rule \"SA domestic, under $20,000\" allows a deposit of at most $1,000.00. This is a hard cap, so Field does not issue the invoice.",
};

describe("ScheduleSourceBadge", () => {
  it("names the account rule, or marks an override and who set it", () => {
    const { rerender } = render(<ScheduleSourceBadge source={{ kind: "rule", ruleUid: "mrl_1", ruleName: "SA domestic, under $20,000", at: null, by: null }} />);
    expect(screen.getByText(/Account rule: SA domestic, under \$20,000/)).toBeTruthy();
    rerender(<ScheduleSourceBadge source={{ kind: "override", ruleUid: "mrl_1", ruleName: "SA domestic, under $20,000", at: null, by: "Sam" }} />);
    expect(screen.getByText(/Override by Sam, not "SA domestic, under \$20,000"/)).toBeTruthy();
    rerender(<ScheduleSourceBadge source={null} />);
    expect(screen.queryByText(/Override|Account rule/)).toBeNull();
  });

  it("a hard cap is an alert in the rule's words", () => {
    render(<CapFindings findings={[hard]} />);
    expect(screen.getByRole("alert").textContent).toContain("allows a deposit of at most $1,000.00");
  });
});

describe("JobInvoices under milestone rules", () => {
  it("shows the override, blocks sending a deposit over a hard cap, and offers the account rule back", async () => {
    const rules: JobMilestoneRules = {
      ok: true, hasRules: true, region: { country: "AU", region: "SA", from: "site-address" },
      rule: { uid: "mrl_1", name: "SA domestic, under $20,000", country: "AU", region: "SA", minValue: 0, maxValue: 20000, valueBasis: "inc-gst", note: null, milestones: [], caps: [] },
      contractValue: 16500,
      scheduleSource: { kind: "override", ruleUid: "mrl_1", ruleName: "SA domestic, under $20,000", at: "2026-10-13T00:00:00.000Z", by: "Sam" },
      milestones: [
        { milestoneIndex: 0, label: "Deposit", kind: "deposit", status: "draft", invoiceNumber: "EI-1-M1", total: 1650, issued: false, findings: [hard], blocked: true },
        { milestoneIndex: 1, label: "Final", kind: "final", status: "draft", invoiceNumber: "EI-1-M2", total: 14850, issued: false, findings: [], blocked: false },
      ],
    };
    vi.spyOn(api, "jobMilestoneRules").mockResolvedValue(rules);
    vi.spyOn(api, "jobXeroStatus").mockRejectedValue(new Error("Xero is not connected"));
    const milestone = (index: number, label: string, total: number) => ({ id: `m${index}`, milestoneIndex: index, milestoneLabel: label, invoiceNumber: `EI-1-M${index + 1}`, percentage: index ? 90 : 10, subtotal: total / 1.1, gst: total / 11, total, amountPaid: 0, amountDue: total, status: "draft", payments: [] });
    const detail = { meta: { id: "job-1", paymentSchedule: { milestones: [{ label: "Deposit", percentage: 10 }, { label: "Final", percentage: 90 }], source: rules.scheduleSource }, milestoneInvoices: [milestone(0, "Deposit", 1650), milestone(1, "Final", 14850)] } } as unknown as RecordingDetail;
    render(<MemoryRouter><JobInvoices detail={detail} busy={null} onSend={() => {}} onRecordPayment={() => {}} run={async () => {}} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/Override by Sam/)).toBeTruthy();
    const sends = screen.getAllByRole("button", { name: "Send" }) as HTMLButtonElement[];
    expect(sends[0].disabled).toBe(true);
    expect(sends[1].disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Use the account rule" })).toBeTruthy();
  });
});
