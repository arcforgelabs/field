// Milestone rules on a job (#29): where its schedule came from (the account
// rule, or an override set on the job), and the caps an invoice is over,
// shown before it is issued. A hard cap blocks the issue; a soft cap alerts.
import { AlertTriangle, Ban, ScrollText } from "lucide-react";
import type { MilestoneCapFinding, PaymentScheduleSource } from "@/lib/types";

/** "From the account rule …" or "Override: set on this job …". Nothing for a schedule from before rules. */
export function ScheduleSourceBadge({ source }: { source: PaymentScheduleSource | null | undefined }) {
  if (!source) return null;
  if (source.kind === "rule") {
    return (
      <span className="fx-badge fx-badge--brand" title={source.band ? `Contract value ${source.band}` : undefined} data-schedule-source="rule">
        <ScrollText aria-hidden width={12} height={12} />
        Account rule: {source.ruleName}{source.milestonesFrom === "default" ? " (default milestones)" : ""}
      </span>
    );
  }
  return (
    <span className="fx-badge fx-badge--outline" style={{ color: "var(--t-warn)" }} data-schedule-source="override" title={source.ruleName ? `Departs from the account rule "${source.ruleName}". Its caps still apply.` : "Set on this job."}>
      <AlertTriangle aria-hidden width={12} height={12} />
      Override{source.by ? ` by ${source.by}` : ""}{source.ruleName ? `, not "${source.ruleName}"` : ""}
    </span>
  );
}

/** The caps one milestone is over, in the rule's own words. */
export function CapFindings({ findings, issued = false }: { findings: MilestoneCapFinding[]; issued?: boolean }) {
  if (!findings.length) return null;
  return (
    <div style={{ display: "grid", gap: 6, gridColumn: "2 / -1" }}>
      {findings.map((finding, index) => (
        <div key={`${finding.kind}-${index}`} className={`fx-notice ${finding.mode === "hard" ? "fx-notice--bad" : "fx-notice--warn"}`} style={{ margin: 0 }} role={finding.mode === "hard" ? "alert" : "status"}>
          {finding.mode === "hard" ? <Ban aria-hidden /> : <AlertTriangle aria-hidden />}
          <span>{issued ? `Issued over a soft cap. ${finding.message.replace(/ This is a soft cap:.*$/, "")}` : finding.message}</span>
        </div>
      ))}
    </div>
  );
}
