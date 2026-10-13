// The job's email: every email Field sent for it, exactly as it went out
// (recipients including Bcc, the HTML, the attachments as stored), and the
// ones still waiting (held, scheduled, drafts, not sent). Shown on the job's
// Email tab and in the composer's rail.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FileText, Paperclip, Upload, X } from "lucide-react";
import { api, type JobDocument, type ScheduledEmail, type SentEmail } from "@/lib/api";
import { formatBytes } from "./attachment-summary";
import { whenLabel, isUnconfirmed, plainQueueError, emailRows, type EmailRow } from "./email-rows";

const QUEUED_LABEL: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "draft" },
  pending: { label: "Scheduled", tone: "quoted" },
  sending: { label: "Sending", tone: "quoted" },
  failed: { label: "Not sent", tone: "lost" },
};

function recipientsLine(record: { to?: string[]; cc?: string[]; bcc?: string[] }) {
  return [
    record.to?.length ? `To ${record.to.join(", ")}` : null,
    record.cc?.length ? `cc ${record.cc.join(", ")}` : null,
    record.bcc?.length ? `bcc ${record.bcc.join(", ")}` : null,
  ].filter(Boolean).join(" · ");
}

export function EmailRows({ rows, onOpen, onCancel, onEdit }: {
  rows: EmailRow[];
  onOpen: (record: SentEmail) => void;
  onCancel?: (record: ScheduledEmail) => void;
  onEdit?: (record: ScheduledEmail) => void;
}) {
  if (!rows.length) return <p className="fx-mute fx-composer__empty">No email on this job yet.</p>;
  return (
    <ul className="fx-composer__activity" aria-label="Email on this job">
      {rows.map((row) => {
        if (row.kind === "sent") {
          const record = row.record;
          return (
            <li key={`sent-${record.id}`}>
              <button type="button" className="fx-email-row" onClick={() => onOpen(record)} aria-label={`Open ${record.subject || "email"}, sent ${whenLabel(record.ts)}`}>
                <span className="fx-composer__activity-h">
                  <span className="fx-status fx-status--paid">Sent</span>
                  <span className="fx-mute">{whenLabel(record.ts)}{record.reconciled ? " · found in Sent Mail; later edits were not sent" : ""}</span>
                </span>
                <strong>{record.subject || "(no subject)"}</strong>
                <span className="fx-mute">{recipientsLine(record)}{record.attachments.length ? ` · ${record.attachments.map((entry) => entry.filename).join(", ")}` : ""}</span>
              </button>
            </li>
          );
        }
        const record = row.record;
        const unknown = isUnconfirmed(record);
        const state = record.held && record.status === "pending"
          ? { label: "Sending", tone: "quoted" }
          : unknown ? { label: "Not confirmed", tone: "invoicing" } : QUEUED_LABEL[record.status] || { label: record.status, tone: "draft" };
        return (
          <li key={`queued-${record.id}`}>
            <span className="fx-composer__activity-h">
              <span className={`fx-status fx-status--${state.tone}`}>{state.label}</span>
              {record.scheduledAt && record.status === "pending" ? <span className="fx-mute">{whenLabel(record.scheduledAt)}</span> : <span className="fx-mute">{whenLabel(record.updatedAt)}</span>}
            </span>
            <strong>{record.subject || "(no subject)"}</strong>
            <span className="fx-mute">{recipientsLine(record)}{record.createdBy?.name ? ` · by ${record.createdBy.name}` : ""}</span>
            {record.status === "failed" ? <span className="fx-composer__activity-error">{plainQueueError(record.lastError, record)}</span> : null}
            <span className="fx-composer__activity-actions">
              {record.status === "pending" && onCancel ? <button type="button" className="fx-btn fx-btn--sm" onClick={() => onCancel(record)}>Cancel send</button> : null}
              {(record.status === "pending" || record.status === "draft" || (record.status === "failed" && record.resend !== "blocked")) && onEdit
                ? <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => onEdit(record)}>{record.status === "draft" ? "Open draft" : "Edit"}</button>
                : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One sent email exactly as it went out, in a side sheet. */
export function SentEmailSheet({ record, documents, onClose }: { record: SentEmail; documents: JobDocument[] | null; onClose: () => void }) {
  const mainDocument = record.mainDocument
    ? (documents || []).find((entry) => entry.documentType === record.mainDocument?.documentType && entry.number === record.mainDocument?.number) || null
    : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fx-scrim fx-scrim--sheet" onMouseDown={onClose}>
      <div className="fx-sheet fx-sheet--wide fx-email-sheet" role="dialog" aria-modal="true" aria-labelledby="sent-email-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="fx-email-sheet__h">
          <div>
            <h2 id="sent-email-title">{record.subject || "(no subject)"}</h2>
            <p className="fx-mute">Sent {whenLabel(record.ts)}{record.sentBy?.name ? ` by ${record.sentBy.name}` : ""}</p>
          </div>
          <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="Close" autoFocus onClick={onClose}><X aria-hidden /></button>
        </div>
        <dl className="fx-email-sheet__meta">
          <dt>From</dt><dd>{record.fromName ? `${record.fromName} <${record.from}>` : record.from}</dd>
          <dt>To</dt><dd>{record.to.join(", ")}</dd>
          {record.cc?.length ? <><dt>Cc</dt><dd>{record.cc.join(", ")}</dd></> : null}
          {record.bcc?.length ? <><dt>Bcc</dt><dd>{record.bcc.join(", ")}</dd></> : null}
        </dl>
        <ul className="fx-email-sheet__att" aria-label="Attachments as sent">
          {record.attachments.map((attachment, index) => {
            const isMain = index === 0 && record.mainDocument && !attachment.source;
            const uid = attachment.uid || (isMain ? mainDocument?.uid : null);
            return (
              <li key={`${attachment.filename}-${index}`}>
                {attachment.source === "upload" ? <Upload aria-hidden /> : <FileText aria-hidden />}
                {uid
                  ? <a href={`/api/documents/${uid}/pdf`} target="_blank" rel="noreferrer">{attachment.filename}</a>
                  : <span>{attachment.filename}</span>}
                <small className="fx-mute">
                  {attachment.source === "upload"
                    ? `Upload · ${formatBytes(attachment.byteLength)}${attachment.sha256 ? ` · SHA-256 ${attachment.sha256.slice(0, 12)}…` : ""}`
                    : attachment.number || (isMain ? record.mainDocument?.number : null) || ""}
                </small>
              </li>
            );
          })}
        </ul>
        <iframe className="fx-email-sheet__frame" title="The email as sent" sandbox="" srcDoc={record.htmlBody || `<pre>${record.bodyText.replace(/</g, "&lt;")}</pre>`} />
      </div>
    </div>
  );
}

/** The job's Email tab. */
export function JobEmails({ jobId }: { jobId: string }) {
  const [sent, setSent] = useState<SentEmail[] | null>(null);
  const [queued, setQueued] = useState<ScheduledEmail[]>([]);
  const [documents, setDocuments] = useState<JobDocument[] | null>(null);
  const [open, setOpen] = useState<SentEmail | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    return Promise.all([api.sentEmails(jobId), api.scheduledEmails(jobId)]).then(([sentResult, queuedResult]) => {
      setSent(sentResult.sentEmails);
      setQueued(queuedResult.scheduledEmails);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : "The job's email could not be loaded.");
    });
  }
  useEffect(() => {
    void refresh();
    api.jobDocuments(jobId).then((result) => setDocuments(result.documents)).catch(() => setDocuments(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  const rows = useMemo(() => emailRows(sent || [], queued), [sent, queued]);

  return (
    <div className="fx-block fx-job-emails">
      <div className="fx-job-emails__h">
        <Paperclip aria-hidden />
        <span>Every email sent for this job opens exactly as it went out, Bcc included.</span>
        <span className="fx-spacer" />
        <Link className="fx-btn fx-btn--sm" to={`/jobs/${jobId}/email-editor`}>New email</Link>
      </div>
      {error ? <div className="fx-notice fx-notice--bad" style={{ margin: 0 }}><span>{error}</span></div> : null}
      {sent === null && !error ? <p className="fx-mute">Loading…</p> : null}
      {sent !== null ? (
        <EmailRows
          rows={rows}
          onOpen={setOpen}
          onCancel={async (record) => { await api.unscheduleEmail(jobId, record.id).catch(() => {}); await refresh(); }}
          onEdit={(record) => { window.location.hash = `#/jobs/${jobId}/email-editor?draft=${record.id}`; }}
        />
      ) : null}
      {open ? <SentEmailSheet record={open} documents={documents} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
