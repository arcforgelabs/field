// Every milestone invoice across jobs: what's outstanding, what's overdue,
// what's been paid. Record a payment straight from the row; open the job for
// anything else.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, Search, Wallet } from "lucide-react";
import type { MilestoneInvoice, RecordingMeta } from "@/lib/types";
import { api } from "@/lib/api";
import { openDocumentPdf } from "@/lib/open-document";
import { useJobs, refreshJobs } from "@/lib/use-jobs";
import { useShell } from "@/components/shell/shell-context";
import { INVOICE_STATE_LABEL, INVOICE_STATE_TONE, invoiceState, jobCustomer, jobInvoices, jobTitle, money, moneyRound, shortDate, type InvoiceState } from "@/lib/job-status";
import { RecordPaymentDialog } from "@/features/job/job-invoices";
import { useAuth } from "@/contexts/auth-context";
import { useAmountDecisionCount } from "./invoice-amounts-model";

type Filter = "open" | "overdue" | "not-sent" | "paid" | "all";
type Row = { job: RecordingMeta; invoice: MilestoneInvoice; state: InvoiceState };

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "open", label: "Awaiting payment" },
  { id: "overdue", label: "Overdue" },
  { id: "not-sent", label: "Not sent" },
  { id: "paid", label: "Paid" },
  { id: "all", label: "All" },
];

function matches(filter: Filter, row: Row) {
  if (filter === "all") return true;
  if (filter === "open") return row.state === "sent" || row.state === "overdue";
  return row.state === filter;
}

export function InvoicesPage() {
  const navigate = useNavigate();
  const shell = useShell();
  const { jobs, loading } = useJobs();
  const [chosen, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState("");
  const [paying, setPaying] = useState<Row | null>(null);
  const [now] = useState(() => Date.now());
  const { isOwner } = useAuth();
  const decisions = useAmountDecisionCount(isOwner);

  useEffect(() => { void refreshJobs(); }, []);

  const rows = useMemo<Row[]>(() => (jobs || [])
    .filter((job) => !job.archivedAt)
    .flatMap((job) => jobInvoices(job).map((invoice) => ({ job, invoice, state: invoiceState(invoice) }))), [jobs]);
  // Until someone picks a filter, open on the first one with something in it.
  const filter: Filter = chosen
    ?? (rows.some((row) => matches("open", row)) ? "open" : rows.some((row) => matches("not-sent", row)) ? "not-sent" : "all");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows
    .filter((row) => matches(filter, row))
    .filter((row) => terms.every((term) => [row.invoice.invoiceNumber, jobTitle(row.job), jobCustomer(row.job)].join(" ").toLowerCase().includes(term)))
    .sort((a, b) => {
      const key = (row: Row) => row.state === "paid" ? `1${row.invoice.paidAt || ""}` : `0${row.invoice.dueDate || row.invoice.issuedAt || "9"}`;
      return filter === "paid" ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b));
    });
  const sumBy = (predicate: (row: Row) => boolean, field: "amountDue" | "total" = "amountDue") => rows.filter(predicate).reduce((total, row) => total + (row.invoice[field] || 0), 0);
  const monthAgo = now - 30 * 86_400_000;
  const paidRecently = rows.filter((row) => row.state === "paid" && row.invoice.paidAt && new Date(row.invoice.paidAt).getTime() >= monthAgo)
    .reduce((total, row) => total + (row.invoice.amountPaid || 0), 0);
  const notSentTotal = sumBy((row) => row.state === "not-sent", "total");

  return (
    <>
      <header className="fx-ph">
        <h1 className="fx-ph__title">Invoices</h1>
        <div className="fx-seg" role="group" aria-label="Show">
          {FILTERS.map((item) => (
            <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
              {item.label}<span className="fx-seg__count">{rows.filter((row) => matches(item.id, row)).length}</span>
            </button>
          ))}
        </div>
        <div className="fx-spacer" />
        <label className="fx-filter">
          <Search aria-hidden />
          <input id="invoices-filter" placeholder="Invoice number, job or customer" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
        </label>
      </header>

      {decisions > 0 && (
        <div className="fx-notice fx-notice--warn" role="status">
          <AlertTriangle aria-hidden />
          <span>{decisions === 1 ? "1 old invoice shows" : `${decisions} old invoices show`} two different amounts. Choose the amounts the customer got.</span>
          <Link className="fx-btn fx-btn--sm" to="/invoices/amounts">Choose amounts <span className="fx-badge fx-badge--solid">{decisions}</span></Link>
        </div>
      )}

      <div className="fx-strip">
        <button type="button" className="fx-strip__item" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
          <span className="fx-strip__k">Outstanding</span>
          <span className="fx-strip__v">{moneyRound(sumBy((row) => row.state === "sent" || row.state === "overdue"))}</span>
          <span className="fx-strip__s">sent, not yet paid</span>
        </button>
        <button type="button" className="fx-strip__item" aria-pressed={filter === "overdue"} onClick={() => setFilter("overdue")}>
          <span className="fx-strip__k">Overdue</span>
          <span className="fx-strip__v" style={{ color: rows.some((row) => row.state === "overdue") ? "var(--t-danger)" : undefined }}>{moneyRound(sumBy((row) => row.state === "overdue"))}</span>
          <span className="fx-strip__s">past the due date</span>
        </button>
        <button type="button" className="fx-strip__item" aria-pressed={filter === "not-sent"} onClick={() => setFilter("not-sent")}>
          <span className="fx-strip__k">Ready to send</span>
          <span className="fx-strip__v">{moneyRound(notSentTotal)}</span>
          <span className="fx-strip__s">invoices not sent yet</span>
        </button>
        <button type="button" className="fx-strip__item" aria-pressed={filter === "paid"} onClick={() => setFilter("paid")}>
          <span className="fx-strip__k">Paid · last 30 days</span>
          <span className="fx-strip__v" style={{ color: paidRecently ? "var(--t-success)" : undefined }}>{moneyRound(paidRecently)}</span>
          <span className="fx-strip__s">receipts issued</span>
        </button>
      </div>

      <div className="fx-scroll-x" style={{ paddingTop: 12 }}>
        <table className="fx-table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Job</th>
              <th>Milestone</th>
              <th>Sent</th>
              <th>Due</th>
              <th>Status</th>
              <th className="fx-r">Amount</th>
              <th className="fx-r">Due now</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const { job, invoice, state } = row;
              const open = () => navigate(`/jobs/${job.id}`);
              return (
                <tr key={`${job.id}:${invoice.milestoneIndex}`} data-click tabIndex={0} onClick={open} onKeyDown={(event) => { if (event.key === "Enter") open(); }}>
                  <td className="fx-num">{invoice.invoiceNumber}</td>
                  <td>
                    <div className="fx-table__strong">{jobTitle(job)}</div>
                    {jobCustomer(job) && <div className="fx-mute" style={{ fontSize: 12 }}>{jobCustomer(job)}</div>}
                  </td>
                  <td className="fx-dim">{invoice.milestoneLabel} · {invoice.percentage}%</td>
                  <td className="fx-dim">{shortDate(invoice.issuedAt)}</td>
                  <td style={{ color: state === "overdue" ? "var(--t-danger)" : "var(--t-dim)" }}>{shortDate(invoice.dueDate)}</td>
                  <td><span className={`fx-status fx-status--${INVOICE_STATE_TONE[state]}`}>{INVOICE_STATE_LABEL[state]}</span></td>
                  <td className="fx-r fx-num">{money(invoice.total)}</td>
                  <td className="fx-r fx-num">{state === "paid" ? <span className="fx-mute">—</span> : money(invoice.amountDue)}</td>
                  <td className="fx-r" onClick={(event) => event.stopPropagation()}>
                    {(state === "sent" || state === "overdue") && (
                      <button type="button" className="fx-btn fx-btn--sm" onClick={() => setPaying(row)}><Wallet aria-hidden />Record payment</button>
                    )}
                    {state === "not-sent" && (
                      <button type="button" className="fx-btn fx-btn--sm" onClick={() => navigate(`/jobs/${job.id}/email-editor?documentType=invoice&milestoneIndex=${invoice.milestoneIndex}`)}>Send</button>
                    )}
                    {state === "paid" && (
                      <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => void openDocumentPdf(api.quotePdfUrl(job.id, undefined, invoice.milestoneIndex, "receipt"), shell.toast)}>Receipt</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr className="fx-table__empty">
                <td colSpan={9}>
                  {loading && !jobs ? "Loading invoices…"
                    : rows.length === 0 ? "No invoices yet. They're created when a customer accepts a quote."
                      : filter === "overdue" ? "Nothing overdue." : "Nothing here."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {paying && (
        <RecordPaymentDialog
          invoice={paying.invoice}
          onCancel={() => setPaying(null)}
          onRecord={async (payment) => {
            const row = paying;
            setPaying(null);
            try {
              await api.recordMilestonePayment(row.job.id, row.invoice.milestoneIndex, payment);
              await refreshJobs();
              shell.toast(`Payment of ${money(payment.amount)} recorded on ${row.invoice.invoiceNumber}`);
            } catch (err) {
              shell.toast(err instanceof Error ? err.message : "The payment could not be recorded.");
            }
          }}
        />
      )}
    </>
  );
}
