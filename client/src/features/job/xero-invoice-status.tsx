// An invoice's way to Xero, on the job's Invoices tab (#93): Xero draft
// created, Approved in Xero, Sending, Xero failed (with the reason), totals
// differ, held for another Xero organisation, Void this in Xero (credited in
// Field after it reached Xero), or Not sent to Xero. Owners get Retry, and Send to Xero (after a
// preview) for an invoice issued before Xero was connected.
import { useEffect, useState } from "react";
import { RotateCw, Send } from "lucide-react";
import { api } from "@/lib/api";
import type { XeroInvoiceState, XeroPushPreview } from "@/lib/types";
import { money, shortDate } from "@/lib/job-status";

const TONE: Record<XeroInvoiceState["state"], string> = {
  created: "paid",
  pending: "invoicing",
  failed: "overdue",
  mismatch: "overdue",
  skipped: "draft",
  "not-sent": "draft",
  held: "invoicing",
  "void-in-xero": "overdue",
};

export function XeroInvoiceStatus({ entry, isOwner, onRetry, onSend }: {
  entry: XeroInvoiceState;
  isOwner: boolean;
  onRetry: (entry: XeroInvoiceState) => void;
  onSend: (entry: XeroInvoiceState) => void;
}) {
  const showReason = entry.reason && entry.state !== "created";
  return (
    <div className="fx-xero" data-state={entry.state}>
      <span className={`fx-status fx-status--${TONE[entry.state]}`}>{entry.label}</span>
      {isOwner && entry.canRetry && entry.state !== "void-in-xero" && (
        <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => onRetry(entry)}><RotateCw aria-hidden />Retry</button>
      )}
      {isOwner && entry.canSend && (
        <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => onSend(entry)}><Send aria-hidden />Send to Xero</button>
      )}
      {showReason && <span className={`fx-xero__why${["failed", "mismatch", "void-in-xero"].includes(entry.state) ? " fx-xero__why--bad" : ""}`}>{entry.reason}</span>}
    </div>
  );
}

/**
 * The owner's preview before invoices go to Xero: what each one creates, and
 * why one cannot go. Nothing is written until Send.
 */
export function XeroPushDialog({ invoiceUids = null, sinceDays = null, onCancel, onSent }: {
  invoiceUids?: string[] | null;
  sinceDays?: number | null;
  onCancel: () => void;
  onSent: (count: number) => void;
}) {
  const [preview, setPreview] = useState<XeroPushPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.previewXeroPush(invoiceUids ? { invoiceUids } : { sinceDays: sinceDays || 30 })
      .then((res) => {
        setPreview(res);
        setChosen(new Set(res.invoices.filter((invoice) => !invoice.problem).map((invoice) => invoice.invoiceUid)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "The preview could not be made."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    setBusy(true);
    try {
      const res = await api.pushToXero([...chosen]);
      onSent(res.queued.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invoices could not be sent.");
      setBusy(false);
    }
  }

  const toggle = (uid: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    return next;
  });
  const what = preview?.mode === "authorised" ? "approved invoices" : "drafts";

  return (
    <div className="fx-scrim" onMouseDown={onCancel}>
      <div className="fx-dialog fx-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="xero-push-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
        <div className="fx-dialog__h" id="xero-push-title">Send to Xero</div>
        <div className="fx-dialog__b">
          {error && <div className="fx-notice fx-notice--bad" style={{ margin: 0 }}><span>{error}</span></div>}
          {!preview && !error && <p className="fx-dim" style={{ margin: 0 }}>Checking what would go…</p>}
          {preview && preview.invoices.length === 0 && <p className="fx-dim" style={{ margin: 0 }}>There is nothing to send: these invoices are in Xero already, or on their way.</p>}
          {preview && preview.invoices.length > 0 && (
            <>
              <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>Field creates these in Xero as {what}, each with its PDF. Nothing changes in Field.</p>
              <ul className="fx-xero-push" aria-label="Invoices to send">
                {preview.invoices.map((invoice) => (
                  <li key={invoice.invoiceUid}>
                    <label className="fx-check">
                      <input type="checkbox" className="fx-checkbox" checked={chosen.has(invoice.invoiceUid)} disabled={Boolean(invoice.problem)} onChange={() => toggle(invoice.invoiceUid)} />
                      <span className="fx-xero-push__main">
                        <b className="fx-num">{invoice.number}</b>
                        <span className="fx-dim">{[invoice.reference ? `Job ${invoice.reference}` : null, invoice.customer, invoice.issuedAt ? `issued ${shortDate(invoice.issuedAt)}` : null].filter(Boolean).join(" · ")}</span>
                        {invoice.problem && <span className="fx-xero__why fx-xero__why--bad">{invoice.problem}</span>}
                        {invoice.previously && <span className="fx-mute">Before: {invoice.previously}</span>}
                      </span>
                      <span className="fx-num">{money(Number(invoice.total))}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="fx-dialog__f">
          <button type="button" className="fx-btn fx-btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="fx-btn fx-btn--primary" disabled={busy || !chosen.size} onClick={send}>{busy ? "Sending…" : `Send ${chosen.size} to Xero`}</button>
        </div>
      </div>
    </div>
  );
}
