// A job's milestone invoices, in order: how much is paid, and for each
// invoice its state and the one thing to do next (send it, record the
// payment, or send the receipt).
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Eye, FileMinus, Mail, MoreHorizontal, Send, Undo2, Wallet } from "lucide-react";
import type { MilestoneInvoice, RecordingDetail } from "@/lib/types";
import { api } from "@/lib/api";
import { openDocumentPdf } from "@/lib/open-document";
import { useShell } from "@/components/shell/shell-context";
import { Menu, type MenuItem } from "@/components/shell/menu";
import { INVOICE_STATE_LABEL, INVOICE_STATE_TONE, invoiceState, jobInvoices, money, shortDate } from "@/lib/job-status";
import { buildVisiblePaymentSchedule } from "@/features/job-detail/payment-schedule";
import { CapFindings, ScheduleSourceBadge } from "@/features/job-detail/milestone-rules";
import { useJobMilestoneRules } from "@/features/job-detail/use-job-milestone-rules";

export function JobInvoices({ detail, busy, onSend, onRecordPayment, run }: {
  detail: RecordingDetail;
  busy: string | null;
  onSend: (milestoneIndex: number, type: "invoice" | "receipt") => void;
  onRecordPayment: (milestoneIndex: number) => void;
  run: (label: string, action: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const meta = detail.meta;
  const invoices = jobInvoices(meta);
  const total = invoices.reduce((sum, invoice) => sum + (invoice.total || 0), 0);
  const paid = invoices.reduce((sum, invoice) => sum + (invoice.amountPaid || 0), 0);
  const firstOpen = invoices.find((invoice) => invoice.status !== "paid");
  const shell = useShell();
  const [crediting, setCrediting] = useState<MilestoneInvoice | null>(null);
  const pdf = (invoice: MilestoneInvoice, type: "invoice" | "receipt") => void openDocumentPdf(api.quotePdfUrl(meta.id, undefined, invoice.milestoneIndex, type), shell.toast);
  const credit = (invoice: MilestoneInvoice): MenuItem => ({ label: "Credit and reissue", icon: <FileMinus />, onSelect: () => setCrediting(invoice) });
  const navigate = useNavigate();
  // The account's milestone rules (#29): read again whenever an invoice moves.
  const rules = useJobMilestoneRules(meta.id, JSON.stringify([meta.paymentSchedule?.source?.at ?? null, invoices.map((invoice) => [invoice.status, invoice.total, invoice.milestoneLabel])]));
  const ruleFor = (index: number) => rules?.milestones.find((entry) => entry.milestoneIndex === index) || null;
  const source = meta.paymentSchedule?.source || rules?.scheduleSource || null;
  // An invoice issued in place of a credited one: its adjustment note can
  // also go on its own, in the credited invoice's conversation.
  const emailNote = (invoice: MilestoneInvoice): MenuItem[] => {
    const number = invoice.issuedRevision?.creditNoteNumber;
    return number ? [{ label: `Email adjustment note ${number}`, icon: <Mail />, onSelect: () => navigate(`/jobs/${meta.id}/email-editor?purpose=adjustment-note&creditNote=${encodeURIComponent(number)}`) }] : [];
  };

  if (!invoices.length) {
    // The job's own schedule, else the account rule's, else Field's default.
    const proposed = !meta.paymentSchedule && rules?.proposedSchedule ? rules.proposedSchedule : null;
    const schedule = buildVisiblePaymentSchedule(meta.paymentSchedule || proposed, [], null);
    return (
      <div className="fx-block" style={{ paddingBottom: 28 }}>
        <h3 className="fx-block__h">No invoices yet {proposed && rules?.rule ? <ScheduleSourceBadge source={{ kind: "rule", ruleUid: rules.rule.uid ?? null, ruleName: rules.rule.name, milestonesFrom: rules.rule.milestones.length ? undefined : "default", at: null, by: null }} /> : <ScheduleSourceBadge source={source} />}</h3>
        <p className="fx-dim" style={{ margin: "0 0 12px", maxWidth: "60ch" }}>
          Invoices are made from {proposed ? "the account rule's" : "the quote's"} payment schedule: {schedule.milestones.map((milestone) => `${milestone.label} ${milestone.percentage}%`).join(", ")}.
        </p>
        <button
          type="button"
          className="fx-btn fx-btn--primary"
          disabled={busy !== null}
          onClick={() => run("milestones", () => api.generateMilestones(meta.id), "Invoices are ready to send")}
        >
          Set up invoices
        </button>
      </div>
    );
  }

  return (
    <div>
      {(source || rules?.rule) && (
        <div className="fx-doc-actions" style={{ paddingBottom: 0 }} aria-label="Payment schedule source">
          <ScheduleSourceBadge source={source} />
          {rules?.rule && (
            <span className="fx-mute" style={{ fontSize: 12 }}>
              Caps from &ldquo;{rules.rule.name}&rdquo; apply to every invoice on this job{rules.region?.country ? ` (${rules.region.region ? `${rules.region.region}, ` : ""}${rules.region.country}, from the ${rules.region.from === "site-address" ? "site address" : "business region"})` : ""}.
            </span>
          )}
          <span className="fx-spacer" />
          {source?.kind === "override" && rules?.rule && (
            <button type="button" className="fx-btn fx-btn--sm" disabled={busy !== null} onClick={() => run("rule", () => api.generateMilestones(meta.id, { applyAccountRule: true }), `Schedule set back to "${rules.rule?.name}"`)}>Use the account rule</button>
          )}
        </div>
      )}
      <div className="fx-progress">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span><b className="fx-num">{money(paid)}</b> <span className="fx-dim">of {money(total)} paid</span></span>
          <span className="fx-num fx-dim">{total ? Math.round((paid / total) * 100) : 0}%</span>
        </div>
        <span className="fx-bar fx-bar--lg"><i style={{ width: `${total ? Math.min(100, (paid / total) * 100) : 0}%` }} /></span>
      </div>
      {invoices.map((invoice, position) => {
        const state = invoiceState(invoice);
        const isNext = firstOpen?.milestoneIndex === invoice.milestoneIndex;
        const when = state === "paid" ? `Paid ${shortDate(invoice.paidAt)}`
          : state === "overdue" ? `Overdue since ${shortDate(invoice.dueDate)}`
            : state === "sent" ? (invoice.dueDate ? `Due ${shortDate(invoice.dueDate)}` : `Sent ${shortDate(invoice.issuedAt)}`)
              : "Not sent";
        const check = ruleFor(invoice.milestoneIndex);
        const blocked = invoice.status === "draft" && Boolean(check?.blocked);
        const recordedAlerts = invoice.status !== "draft" ? (invoice.issuedRevision?.milestoneRule?.capAlerts || []) : [];
        const menu: MenuItem[] = [
          { label: "Preview invoice", icon: <Eye />, onSelect: () => pdf(invoice, "invoice") },
          ...(invoice.status === "draft" && !blocked ? [{ label: "Mark as sent (sent outside Field)", icon: <Check />, onSelect: () => run("sent", () => api.updateMilestone(meta.id, invoice.milestoneIndex, { status: "authorised" }), `${invoice.invoiceNumber} marked sent`) } as MenuItem] : []),
          ...(invoice.status === "authorised" ? [
            { label: "Resend invoice", icon: <Send />, onSelect: () => onSend(invoice.milestoneIndex, "invoice") } as MenuItem,
            credit(invoice),
            ...emailNote(invoice),
            { label: "Mark as not sent", icon: <Undo2 />, onSelect: () => run("unsent", () => api.markMilestoneUnsent(meta.id, invoice.milestoneIndex), `${invoice.invoiceNumber} back to not sent`) } as MenuItem,
          ] : []),
          ...(invoice.status === "paid" ? [
            { label: "Preview receipt", icon: <Eye />, onSelect: () => pdf(invoice, "receipt") } as MenuItem,
            credit(invoice),
            ...emailNote(invoice),
            { label: "Mark as unpaid", icon: <Undo2 />, onSelect: () => run("unpaid", () => api.markMilestoneUnpaid(meta.id, invoice.milestoneIndex), `${invoice.invoiceNumber} marked unpaid`) } as MenuItem,
          ] : []),
        ];
        return (
          <div key={invoice.id || invoice.milestoneIndex} className="fx-ms" data-status={invoice.status}>
            <span className="fx-ms__idx" aria-hidden>{invoice.status === "paid" ? <Check /> : position + 1}</span>
            <div style={{ minWidth: 0 }}>
              <div className="fx-ms__t">{invoice.milestoneLabel} <span className="fx-dim" style={{ fontWeight: 400 }}>· {invoice.percentage}%</span></div>
              <div className="fx-ms__s fx-num">{invoice.invoiceNumber}{invoice.payments?.length ? ` · ${invoice.payments.filter((payment) => !payment.voidedAt).length} payment${invoice.payments.length === 1 ? "" : "s"}` : ""}</div>
              {invoice.status !== "draft" && invoice.issuedRevision?.milestoneRule?.scheduleSource === "override" && (
                <span className="fx-badge fx-badge--outline" style={{ color: "var(--t-warn)", marginTop: 4 }} title="This invoice was issued while the job's schedule overrode the account rule.">Issued under an override{invoice.issuedRevision.milestoneRule.ruleName ? ` of "${invoice.issuedRevision.milestoneRule.ruleName}"` : ""}</span>
              )}
            </div>
            <div className="fx-ms__hide-sm"><span className={`fx-status fx-status--${INVOICE_STATE_TONE[state]}`} title={INVOICE_STATE_LABEL[state]}>{when}</span></div>
            <div className="fx-ms__hide-sm fx-num" style={{ textAlign: "right" }}>
              {money(invoice.total)}
              {invoice.status !== "paid" && invoice.amountPaid > 0 && <div className="fx-mute" style={{ fontSize: 11.5 }}>{money(invoice.amountDue)} due</div>}
            </div>
            <div className="fx-ms__acts">
              {invoice.status === "draft" && (
                <button type="button" className={`fx-btn fx-btn--sm${isNext && !blocked ? " fx-btn--primary" : ""}`} disabled={blocked} title={blocked ? "A hard cap in the account's milestone rules blocks this invoice" : undefined} onClick={() => onSend(invoice.milestoneIndex, "invoice")}><Send aria-hidden />Send</button>
              )}
              {invoice.status === "authorised" && (
                <button type="button" className={`fx-btn fx-btn--sm${isNext ? " fx-btn--primary" : ""}`} onClick={() => onRecordPayment(invoice.milestoneIndex)}><Wallet aria-hidden />Record payment</button>
              )}
              {invoice.status === "paid" && (
                <button type="button" className="fx-btn fx-btn--sm" onClick={() => onSend(invoice.milestoneIndex, "receipt")}><Send aria-hidden />Send receipt</button>
              )}
              <Menu label={`${invoice.invoiceNumber} actions`} items={menu} trigger={(props) => (
                <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon" aria-label={`${invoice.invoiceNumber} actions`} {...props}><MoreHorizontal /></button>
              )} />
            </div>
            {invoice.status === "draft"
              ? <CapFindings findings={check?.findings || []} />
              : <CapFindings findings={recordedAlerts} issued />}
          </div>
        );
      })}
      <div className="fx-doc-actions">
        <span className="fx-mute" style={{ fontSize: 12 }}>Sent and paid invoices are locked: to correct one, credit and reissue it. Later milestones follow the {source?.kind === "rule" ? "account rule's" : "quote's"} payment schedule.</span>
      </div>
      {crediting && (
        <CreditInvoiceDialog
          invoice={crediting}
          onCancel={() => setCrediting(null)}
          onCredit={async (reason) => {
            const target = crediting;
            setCrediting(null);
            await run("credit", () => api.creditAndReissueInvoice(meta.id, target.milestoneIndex, { reason, expectedRevisionNumber: target.revisionNumber ?? null }), `${target.invoiceNumber} credited. The new invoice is ready to send.`);
          }}
        />
      )}
    </div>
  );
}

/**
 * Credit an issued invoice and issue its replacement (step 4b): a credit
 * note for its full amount, with the reason, and a new invoice from the
 * current quote. Payments made against it move to the new invoice.
 */
export function CreditInvoiceDialog({ invoice, onCancel, onCredit }: {
  invoice: MilestoneInvoice;
  onCancel: () => void;
  onCredit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const valid = reason.trim().length > 0;
  return (
    <div className="fx-scrim" onMouseDown={onCancel}>
      <form
        className="fx-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credit-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
        onSubmit={(event) => { event.preventDefault(); if (valid) onCredit(reason.trim()); }}
      >
        <div className="fx-dialog__h" id="credit-title">Credit and reissue {invoice.invoiceNumber}</div>
        <div className="fx-dialog__b">
          <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>
            Field issues a credit note for the full {money(invoice.total)} of {invoice.invoiceNumber}, then a new invoice for {invoice.milestoneLabel} from the current quote.
            {invoice.amountPaid > 0 ? ` The ${money(invoice.amountPaid)} already paid moves to the new invoice.` : ""}
          </p>
          <label className="fx-label" htmlFor="credit-reason">Reason<textarea id="credit-reason" className="fx-input" rows={3} autoFocus placeholder="For example: approved variation to the retaining wall" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <p className="fx-mute" style={{ margin: 0, fontSize: 12 }}>The reason is printed on the credit note.</p>
        </div>
        <div className="fx-dialog__f">
          <button type="button" className="fx-btn fx-btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="fx-btn fx-btn--primary" disabled={!valid}>Credit and reissue</button>
        </div>
      </form>
    </div>
  );
}

export function RecordPaymentDialog({ invoice, onCancel, onRecord }: {
  invoice: MilestoneInvoice | null;
  onCancel: () => void;
  onRecord: (payment: { amount: number; date: string; reference: string | null; method: string | null }) => void;
}) {
  const [amount, setAmount] = useState(() => (invoice ? String(invoice.amountDue || invoice.total || 0) : "0"));
  const [date, setDate] = useState(() => localDate(new Date()));
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState("Bank transfer");
  if (!invoice) return null;
  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && value <= (invoice.amountDue || invoice.total) + 0.005;
  return (
    <div className="fx-scrim" onMouseDown={onCancel}>
      <form
        className="fx-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
        onSubmit={(event) => { event.preventDefault(); if (valid) onRecord({ amount: Math.round(value * 100) / 100, date, reference: reference.trim() || null, method: method.trim() || null }); }}
      >
        <div className="fx-dialog__h" id="pay-title">Record payment</div>
        <div className="fx-dialog__b">
          <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>{invoice.invoiceNumber} · {invoice.milestoneLabel} · {money(invoice.amountDue)} due</p>
          <div className="fx-grid2">
            <label className="fx-label" htmlFor="pay-amount">Amount<input id="pay-amount" className="fx-input fx-input--num" inputMode="decimal" autoFocus value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} /></label>
            <label className="fx-label" htmlFor="pay-date">Date received<input id="pay-date" className="fx-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          </div>
          <div className="fx-grid2">
            <label className="fx-label" htmlFor="pay-method">Method<input id="pay-method" className="fx-input" value={method} onChange={(event) => setMethod(event.target.value)} /></label>
            <label className="fx-label" htmlFor="pay-ref">Reference<input id="pay-ref" className="fx-input" placeholder="Optional" value={reference} onChange={(event) => setReference(event.target.value)} /></label>
          </div>
          {!valid && <p style={{ margin: 0, color: "var(--t-danger)", fontSize: 12.5 }}>Enter an amount up to {money(invoice.amountDue)}.</p>}
          <p className="fx-mute" style={{ margin: 0, fontSize: 12 }}>Paying the full amount issues a receipt you can send.</p>
        </div>
        <div className="fx-dialog__f">
          <button type="button" className="fx-btn fx-btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="fx-btn fx-btn--primary" disabled={!valid}>Record {Number.isFinite(value) ? money(value) : ""}</button>
        </div>
      </form>
    </div>
  );
}

/** yyyy-mm-dd in the operator's own timezone (toISOString would give UTC's date). */
function localDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
