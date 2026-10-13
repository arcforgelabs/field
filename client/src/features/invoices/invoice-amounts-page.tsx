// Owner only: old invoices whose milestone record and PDFs show different
// amounts (#60). Each one lists every set of amounts Field holds, and the
// owner chooses the set the customer was issued, with a reason. Field never
// chooses. The server checks the owner role again (requireAdmin) and refuses
// a total that is not the chosen set's.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, RotateCw } from "lucide-react";
import { api } from "@/lib/api";
import { money } from "@/lib/job-status";
import { useLoadedJobs } from "@/lib/use-jobs";
import type { InvoiceAmountEntry, InvoiceAmountReport, InvoiceAmountSet, InvoiceAmountSource, RecordingMeta } from "@/lib/types";
import { useShell } from "@/components/shell/shell-context";
import {
  groupEntries,
  jobLinkLabel,
  loadAmountReport,
  noteWithMoney,
  reportErrorMessage,
  settleErrorMessage,
  SOURCE_LABEL,
  SOURCE_PHRASE,
  STATE_LABEL,
} from "./invoice-amounts-model";
import "./invoice-amounts.css";

type Load =
  | { status: "loading"; report: InvoiceAmountReport | null }
  | { status: "error"; message: string; report: InvoiceAmountReport | null }
  | { status: "ready"; report: InvoiceAmountReport };

function amount(value: string | number | null | undefined) {
  if (value == null || value === "") return "—";
  return money(Number(value));
}

function longDate(iso: string | null | undefined) {
  if (!iso) return "date not known";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "date not known";
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function versionList(versions: number[] | undefined) {
  if (!versions?.length) return null;
  return versions.map((version) => `version ${version}`).join(" or ");
}

export function InvoiceAmountsPage() {
  const [load, setLoad] = useState<Load>({ status: "loading", report: null });
  // The shell has usually loaded the jobs already; this never fetches them.
  const jobs = useLoadedJobs();
  const jobFor = (id: string) => jobs?.find((job) => job.id === id) || null;

  const fetchReport = useCallback(() => {
    loadAmountReport()
      .then((report) => setLoad({ status: "ready", report }))
      .catch((error) => setLoad((current) => ({ status: "error", message: reportErrorMessage(error), report: current.report })));
  }, []);
  const reload = useCallback(() => {
    setLoad((current) => ({ status: "loading", report: current.report }));
    fetchReport();
  }, [fetchReport]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const report = load.report;
  const { open, settled } = groupEntries(report?.invoices || []);

  return (
    <>
      <header className="fx-ph">
        <div className="fx-ph__stack">
          <nav className="fx-crumb" aria-label="Breadcrumb">
            <Link to="/invoices">Invoices</Link><span aria-hidden>/</span><span>Owner</span>
          </nav>
          <div className="fx-ph__line">
            <h1 className="fx-ph__title">Invoice amounts</h1>
            {report && <span className="fx-badge">{open.length} to settle · {settled.length} settled</span>}
          </div>
        </div>
        <div className="fx-spacer" />
        <button type="button" className="fx-btn fx-btn--ghost" onClick={reload} disabled={load.status === "loading"}>
          <RotateCw aria-hidden />Check again
        </button>
      </header>

      <div className="fx-amt">
        <p className="fx-amt__intro">
          Some invoices issued before 5 August 2026 show one amount in the milestone record and a different amount in the PDF.
          For each invoice, choose the amounts the customer got, and say why. Field does not choose for you.
        </p>

        {load.status === "loading" && (
          <div className="fx-amt__state" role="status">
            <span className="fx-spin" aria-hidden />
            <span>Checking every issued invoice. This can take 15 seconds or more.</span>
          </div>
        )}
        {load.status === "error" && (
          <div className="fx-notice fx-notice--bad fx-amt__notice" role="alert">
            <AlertTriangle aria-hidden /><span>{load.message}</span>
            <button type="button" className="fx-btn fx-btn--sm" onClick={reload}>Try again</button>
          </div>
        )}

        {report && load.status !== "loading" && open.length === 0 && settled.length === 0 && (
          <div className="fx-empty">
            <span className="fx-empty__icon"><CheckCircle2 aria-hidden /></span>
            <span className="fx-empty__t">All invoice amounts agree</span>
            <p>No invoice has a record and a PDF with different amounts.</p>
          </div>
        )}

        {report && open.length > 0 && (
          <section className="fx-amt__group" aria-labelledby="amt-open">
            <h2 className="fx-amt__h" id="amt-open">To settle <span className="fx-badge">{open.length}</span></h2>
            {open.map((entry) => <AmountEntry key={`${entry.jobId}/${entry.invoiceNumber}`} entry={entry} job={jobFor(entry.jobId)} onSettled={reload} />)}
          </section>
        )}
        {report && settled.length > 0 && (
          <section className="fx-amt__group" aria-labelledby="amt-settled">
            <h2 className="fx-amt__h" id="amt-settled">Settled <span className="fx-badge">{settled.length}</span></h2>
            {settled.map((entry) => <AmountEntry key={`${entry.jobId}/${entry.invoiceNumber}`} entry={entry} job={jobFor(entry.jobId)} onSettled={reload} />)}
          </section>
        )}
      </div>
    </>
  );
}

type SetCard = {
  source: InvoiceAmountSource;
  amounts: Partial<InvoiceAmountSet> | null;
  detail: string;
  /** Why it cannot be chosen, or null when it can. */
  blocked: string | null;
};

/** Every set of amounts Field holds for the invoice, in a fixed order. */
function amountSets(entry: InvoiceAmountEntry): SetCard[] {
  const settledNow = entry.state === "settled";
  const choosable = new Set(entry.options.map((option) => option.choose));
  const blockedReason = (source: InvoiceAmountSource) => {
    if (settledNow || choosable.has(source)) return null;
    if (entry.sentCopy) return "Field holds the copy it emailed. Only the sent copy can be chosen.";
    return "Same amounts as another set.";
  };
  const cards: SetCard[] = [];
  const recordedFrom = entry.recorded.quoteVersion
    ? `From quote version ${entry.recorded.quoteVersion}.`
    : "Quote version not recorded.";
  cards.push({ source: "milestone-record", amounts: entry.recorded, detail: `What the job page bills now. ${recordedFrom}`, blocked: blockedReason("milestone-record") });
  if (entry.storedPdf) {
    if (entry.storedPdf.unreadable || !entry.storedPdf.total) {
      cards.push({ source: "stored-pdf", amounts: null, detail: "Field cannot read the amounts in this PDF.", blocked: settledNow ? null : "Field cannot read its amounts." });
    } else {
      const versions = versionList(entry.storedPdf.drawnFromVersions);
      cards.push({ source: "stored-pdf", amounts: entry.storedPdf, detail: versions ? `Matches the total of quote ${versions}.` : "Matches no quote version total.", blocked: blockedReason("stored-pdf") });
    }
  }
  if (entry.sentCopy) {
    const versions = versionList(entry.sentCopy.drawnFromVersions);
    cards.push({ source: "sent-copy", amounts: entry.sentCopy, detail: `The copy Field emailed on ${longDate(entry.sentCopy.sentAt)}.${versions ? ` Matches quote ${versions}.` : ""}`, blocked: blockedReason("sent-copy") });
  }
  return cards;
}

export function AmountEntry({ entry, job = null, onSettled }: { entry: InvoiceAmountEntry; job?: RecordingMeta | null; onSettled: () => void }) {
  const shell = useShell();
  const [choice, setChoice] = useState<InvoiceAmountSource | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = entry.state === "settled" ? entry.settlement : null;
  const chosen = entry.options.find((option) => option.choose === choice) || null;
  const canSettle = !settled && entry.options.length > 0;
  const ready = Boolean(chosen) && reason.trim().length > 0;
  const name = `amounts-${entry.jobId}-${entry.invoiceNumber}`;
  const superseded = entry.status === "superseded";
  const versions = Object.entries(entry.quoteVersionTotals || {}).sort(([a], [b]) => Number(a) - Number(b));

  async function settle() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await api.settleInvoiceAmounts({ jobId: entry.jobId, invoiceNumber: entry.invoiceNumber, choose: chosen.choose, total: chosen.total, reason: reason.trim() });
      setConfirming(false);
      shell.toast(`${entry.invoiceNumber} settled at ${amount(chosen.total)}.`);
      onSettled();
    } catch (err) {
      setConfirming(false);
      setError(settleErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="fx-amt__card" aria-label={`Invoice ${entry.invoiceNumber}`}>
      <div className="fx-amt__head">
        <span className="fx-amt__num">{entry.invoiceNumber}</span>
        <span className={`fx-status ${superseded ? "fx-status--doc-superseded" : "fx-status--doc-issued"}`}>{superseded ? "Superseded" : "Current"}</span>
        <span className={`fx-status ${settled ? "fx-status--paid" : "fx-status--invoicing"}`}>{STATE_LABEL[entry.state] || entry.state}</span>
        <span className="fx-spacer" />
        <Link className="fx-amt__job" to={`/jobs/${encodeURIComponent(entry.jobId)}`}>{jobLinkLabel(job)}</Link>
      </div>

      <dl className="fx-amt__facts">
        <div><dt>Revision</dt><dd>{entry.revision}</dd></div>
        <div><dt>Milestone</dt><dd>{entry.milestone}</dd></div>
        <div><dt>Issued</dt><dd>{longDate(entry.issuedAt)}</dd></div>
        <div><dt>Paid</dt><dd className="fx-num">{amount(entry.paid)}</dd></div>
        <div className="fx-amt__wide">
          <dt>Quote totals</dt>
          <dd>{versions.length ? versions.map(([version, total]) => <span key={version} className="fx-amt__ver">Version {version}: <span className="fx-num">{amount(total)}</span></span>) : "None found"}</dd>
        </div>
      </dl>

      {entry.note && <p className="fx-amt__note">{noteWithMoney(entry.note)}</p>}

      {settled && (
        <div className="fx-notice fx-amt__notice" role="note">
          <CheckCircle2 aria-hidden />
          <span>
            Settled with the {SOURCE_PHRASE[settled.source] || settled.source}: <b className="fx-num">{amount(settled.total)}</b>. Decided {longDate(settled.decidedAt)}.
            {settled.recordedTotal != null && settled.recordedTotal !== settled.total ? ` The record showed ${amount(settled.recordedTotal)} before.` : ""}
          </span>
        </div>
      )}

      <fieldset className="fx-amt__sets" disabled={!canSettle || busy}>
        <legend className="fx-amt__legend">{canSettle ? "Choose the amounts the customer got" : "Amounts Field holds"}</legend>
        <div className="fx-choices">
          {amountSets(entry).map((card) => {
            const isChosen = settled?.source === card.source;
            const selectable = canSettle && !card.blocked;
            const body = (
              <span className="fx-amt__set">
                <b>{SOURCE_LABEL[card.source]}{isChosen && <span className="fx-badge fx-badge--brand" style={{ marginLeft: 8 }}>Chosen</span>}</b>
                <small>{card.detail}</small>
                {card.amounts && (
                  <span className="fx-amt__sums">
                    <span><span>Subtotal</span><span className="fx-num">{amount(card.amounts.subtotal)}</span></span>
                    <span><span>GST</span><span className="fx-num">{amount(card.amounts.taxTotal)}</span></span>
                    <span className="fx-amt__total"><span>Total</span><span className="fx-num">{amount(card.amounts.total)}</span></span>
                  </span>
                )}
                {canSettle && card.blocked && <small className="fx-amt__blocked">{card.blocked}</small>}
              </span>
            );
            return selectable ? (
              <label key={card.source} className="fx-choice">
                <input type="radio" className="fx-radio" name={name} value={card.source} checked={choice === card.source} onChange={() => { setChoice(card.source); setError(null); }} />
                {body}
              </label>
            ) : (
              <div key={card.source} className={`fx-choice fx-amt__fixed${isChosen ? " fx-amt__fixed--chosen" : ""}`}>{body}</div>
            );
          })}
        </div>
      </fieldset>

      {entry.emails.length > 0 && (
        <div className="fx-amt__emails">
          <div className="fx-amt__legend">Emails of this invoice</div>
          <ul>
            {entry.emails.map((email, index) => (
              <li key={`${email.sentAt}-${index}`}>
                Emailed {longDate(email.sentAt)}{email.quoteVersion ? `, made from quote version ${email.quoteVersion}` : ""}. {email.hashed ? "Field kept a checked copy." : "Field kept no copy."}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canSettle && (
        <div className="fx-amt__form">
          <label className="fx-label" htmlFor={`${name}-reason`}>
            Reason (required)
            <textarea
              id={`${name}-reason`}
              className="fx-textarea"
              rows={2}
              placeholder="For example: the customer paid the deposit from the July PDF"
              value={reason}
              onChange={(event) => { setReason(event.target.value); setError(null); }}
            />
          </label>
          {error && (
            <div className="fx-notice fx-notice--bad fx-amt__notice" role="alert">
              <AlertTriangle aria-hidden /><span>Field did not settle {entry.invoiceNumber}: {error}</span>
            </div>
          )}
          <div className="fx-amt__actions">
            <span className="fx-hint">{!chosen ? "Choose a set of amounts." : !reason.trim() ? "Type a reason." : `You chose the ${SOURCE_PHRASE[chosen.choose]}: ${amount(chosen.total)}.`}</span>
            <span className="fx-spacer" />
            <button type="button" className="fx-btn fx-btn--primary" disabled={!ready || busy} onClick={() => setConfirming(true)}>Settle invoice</button>
          </div>
        </div>
      )}

      {confirming && chosen && (
        <div className="fx-scrim" onMouseDown={() => { if (!busy) setConfirming(false); }}>
          <div
            className="fx-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${name}-confirm`}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape" && !busy) setConfirming(false); }}
          >
            <div className="fx-dialog__h" id={`${name}-confirm`}>Settle {entry.invoiceNumber} at {amount(chosen.total)}?</div>
            <div className="fx-dialog__b">
              <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>
                Field records that the customer got the {SOURCE_PHRASE[chosen.choose]} amounts: subtotal {amount(chosen.subtotal)}, GST {amount(chosen.taxTotal)}, total {amount(chosen.total)}.
                What is owed changes to match. The PDF and the payments do not change.
              </p>
              <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>Reason: {reason.trim()}</p>
              <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600 }}>You cannot change this later.</p>
            </div>
            <div className="fx-dialog__f">
              <button type="button" className="fx-btn fx-btn--ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="fx-btn fx-btn--primary" disabled={busy} autoFocus onClick={() => void settle()}>
                {busy ? "Settling…" : `Settle at ${amount(chosen.total)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
