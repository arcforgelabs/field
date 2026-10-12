// The email's attachments: the document the email is for, other issued
// documents of the job (attached by uid, their stored bytes), and uploads,
// with the running total against the 18 MB limit. "Add" opens the picker.
//
// A draft document cannot go to a customer: the picker lists drafts under
// "Not issued yet", disabled, with where to issue them. Without a database
// (no issued-document store) the picker is not offered and uploads work as
// before.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FileText, Lock, Paperclip, Plus, Search, Upload, X } from "lucide-react";
import { EMAIL_ATTACHMENT_LIMITS, type JobDocument, type JobDocumentStatus, type NotIssuedDocument } from "@/lib/api";

const TYPE_LABEL: Record<string, string> = {
  quote: "Quote",
  invoice: "Invoice",
  receipt: "Receipt",
  credit_note: "Adjustment note",
};

const STATUS_LABEL: Record<JobDocumentStatus, string> = {
  issued: "Issued",
  accepted: "Accepted",
  paid: "Paid",
  credited: "Credited",
  superseded: "Superseded",
  void: "Void",
};

export function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function documentTypeLabel(documentType: string | null | undefined) {
  return TYPE_LABEL[String(documentType || "")] || "Document";
}

/** "Quote · emailed 18 Sep" — what the picker says under a document's number. */
export function documentMetaLine(document: JobDocument) {
  const emailed = document.emailed?.filter((entry) => entry.event === "emailed").at(-1);
  const when = emailed ? `emailed ${shortDate(emailed.at)}` : `issued ${shortDate(document.issuedAt)}`;
  return [documentTypeLabel(document.documentType), when].filter(Boolean).join(" · ");
}

export type MainAttachment = {
  filename: string;
  documentType: string;
  /** Issued already: its stored size. A draft is issued when the email sends. */
  byteLength: number | null;
  issued: boolean;
};

/** Bytes the email will carry, where known. */
export function attachmentTotals({ main, documents, uploads }: { main: MainAttachment | null; documents: JobDocument[]; uploads: File[] }) {
  const count = (main ? 1 : 0) + documents.length + uploads.length;
  const bytes = (main?.byteLength || 0)
    + documents.reduce((sum, document) => sum + (document.byteLength || 0), 0)
    + uploads.reduce((sum, file) => sum + file.size, 0);
  const oversizedUploads = uploads.filter((file) => file.size > EMAIL_ATTACHMENT_LIMITS.maxUploadBytes);
  const problem = oversizedUploads.length
    ? `${oversizedUploads[0].name} is ${formatBytes(oversizedUploads[0].size)}. Each upload can be at most 10 MB.`
    : bytes > EMAIL_ATTACHMENT_LIMITS.maxTotalBytes
      ? `The attachments add up to ${formatBytes(bytes)}. An email can carry at most 18 MB. Remove an attachment to send.`
      : count > EMAIL_ATTACHMENT_LIMITS.maxAttachments
        ? `An email can carry at most ${EMAIL_ATTACHMENT_LIMITS.maxAttachments} attachments. Remove ${count - EMAIL_ATTACHMENT_LIMITS.maxAttachments} to send.`
        : null;
  return { count, bytes, problem };
}

export function AttachmentTray({
  main,
  documents,
  uploads,
  retainedNames = [],
  onRemoveRetained,
  pickerAvailable,
  onAdd,
  onRemoveDocument,
  onRemoveUpload,
}: {
  main: MainAttachment | null;
  documents: JobDocument[];
  uploads: File[];
  retainedNames?: string[];
  /** Uploads kept with a saved draft can be removed too. */
  onRemoveRetained?: (name: string) => void;
  pickerAvailable: boolean;
  onAdd: () => void;
  onRemoveDocument: (uid: string) => void;
  onRemoveUpload: (index: number) => void;
}) {
  const totals = attachmentTotals({ main, documents, uploads });
  return (
    <section className="fx-att" aria-label="Attachments">
      <div className="fx-att__h">
        <Paperclip aria-hidden />
        <strong>Attachments</strong>
        <span className="fx-mute">{totals.count + retainedNames.length}</span>
        <span className={`fx-att__total${totals.problem ? " fx-att__total--over" : ""}`}>
          {formatBytes(totals.bytes)} of 18 MB
        </span>
        {pickerAvailable ? (
          <button type="button" className="fx-btn fx-btn--sm" onClick={onAdd}>
            <Plus aria-hidden /> Add
          </button>
        ) : null}
      </div>
      <ul className="fx-att__list">
        {main ? (
          <li className="fx-att__row">
            <FileText aria-hidden className="fx-att__icon" />
            <span className="fx-att__name">
              <span>{main.filename}</span>
              <small>{documentTypeLabel(main.documentType)} · this send{main.issued ? "" : " · issued when you send"}</small>
            </span>
            <span className="fx-att__size">{formatBytes(main.byteLength)}</span>
            <span className="fx-att__lock" title="The document this email is for"><Lock aria-label="Locked" /></span>
          </li>
        ) : null}
        {documents.map((document) => (
          <li className="fx-att__row" key={document.uid}>
            <FileText aria-hidden className="fx-att__icon" />
            <span className="fx-att__name">
              <span>{document.number}.pdf</span>
              <small>{documentMetaLine(document)}</small>
            </span>
            <span className="fx-att__size">{formatBytes(document.byteLength)}</span>
            <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon" aria-label={`Remove ${document.number}`} onClick={() => onRemoveDocument(document.uid)}>
              <X aria-hidden />
            </button>
          </li>
        ))}
        {uploads.map((file, index) => (
          <li className="fx-att__row" key={`${file.name}-${index}`}>
            <Upload aria-hidden className="fx-att__icon" />
            <span className="fx-att__name">
              <span>{file.name}</span>
              <small>Upload</small>
            </span>
            <span className="fx-att__size">{formatBytes(file.size)}</span>
            <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon" aria-label={`Remove ${file.name}`} onClick={() => onRemoveUpload(index)}>
              <X aria-hidden />
            </button>
          </li>
        ))}
        {retainedNames.map((name) => (
          <li className="fx-att__row" key={`kept-${name}`}>
            <Upload aria-hidden className="fx-att__icon" />
            <span className="fx-att__name">
              <span>{name}</span>
              <small>Upload · kept with this draft</small>
            </span>
            <span className="fx-att__size" />
            {onRemoveRetained ? (
              <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon" aria-label={`Remove ${name}`} onClick={() => onRemoveRetained(name)}>
                <X aria-hidden />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {totals.problem ? <p className="fx-att__problem" role="alert">{totals.problem}</p> : null}
    </section>
  );
}

/**
 * The picker: every issued document of the job, then the drafts that cannot
 * be attached. Ticking documents and pressing Attach replaces the selection.
 */
export function AttachmentPicker({
  jobId,
  documents,
  notIssued,
  selected,
  mainNumber,
  lockedNote = {},
  onCancel,
  onAttach,
  onUpload,
}: {
  jobId: string;
  documents: JobDocument[];
  notIssued: NotIssuedDocument[];
  selected: string[];
  /** The number of the document this email is for: it is already attached. */
  mainNumber: string | null;
  /** Documents attached another way (uid → why), shown ticked and disabled. */
  lockedNote?: Record<string, string>;
  onCancel: () => void;
  onAttach: (uids: string[]) => void;
  onUpload: (files: File[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>(selected);
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
  }, []);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const newestFirst = [...documents].reverse();
    if (!needle) return newestFirst;
    return newestFirst.filter((document) => `${document.number} ${documentTypeLabel(document.documentType)} ${STATUS_LABEL[document.status] || ""}`.toLowerCase().includes(needle));
  }, [documents, query]);
  const toggle = (uid: string) => setPicked((current) => (current.includes(uid) ? current.filter((entry) => entry !== uid) : [...current, uid]));
  const changed = picked.length !== selected.length || picked.some((uid) => !selected.includes(uid));

  return (
    <div className="fx-scrim" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="fx-dialog fx-att-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="att-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
      >
        <div className="fx-dialog__h fx-att-picker__h">
          <span id="att-picker-title">Attach from this job</span>
          <label className="fx-filter">
            <Search aria-hidden />
            <input type="search" placeholder="Search number or type" aria-label="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
        <div className="fx-dialog__b fx-att-picker__b">
          <div className="fx-menu__label">Issued documents</div>
          {visible.length ? (
            <ul className="fx-att-picker__list">
              {visible.map((document) => {
                const isMain = Boolean(mainNumber) && document.number === mainNumber;
                const lockedWhy = isMain ? "This email's document" : lockedNote[document.uid] || null;
                const checked = Boolean(lockedWhy) || picked.includes(document.uid);
                const id = `att-${document.uid}`;
                return (
                  <li key={document.uid}>
                    <label className="fx-att-picker__row" htmlFor={id} data-disabled={lockedWhy ? "true" : undefined}>
                      <input id={id} type="checkbox" className="fx-checkbox" checked={checked} disabled={Boolean(lockedWhy)} onChange={() => toggle(document.uid)} />
                      <span className="fx-att__name">
                        <span>{document.number}</span>
                        <small>{lockedWhy || documentMetaLine(document)}</small>
                      </span>
                      <span className={`fx-status fx-status--doc-${document.status}`}>{STATUS_LABEL[document.status] || document.status}</span>
                      <span className="fx-att__size">{formatBytes(document.byteLength)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="fx-mute" style={{ margin: "4px 0", fontSize: 12.5 }}>{documents.length ? "No document matches." : "This job has no issued documents yet."}</p>
          )}
          {notIssued.length ? (
            <>
              <div className="fx-menu__label">Not issued yet</div>
              <ul className="fx-att-picker__list">
                {notIssued.map((draft) => (
                  <li key={`draft-${draft.milestoneIndex}`}>
                    <div className="fx-att-picker__row" data-disabled="true">
                      <input type="checkbox" className="fx-checkbox" disabled aria-label={`${draft.label}: draft, cannot be attached`} />
                      <span className="fx-att__name">
                        <span>{draft.label}</span>
                        <small>Draft. Customers only get issued documents. <Link to={`/jobs/${jobId}`}>Issue it from Invoices</Link></small>
                      </span>
                      <span className="fx-status fx-status--draft">Draft</span>
                      <span className="fx-att__size">–</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        <div className="fx-dialog__f fx-att-picker__f">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = "";
              if (files.length) onUpload(files);
            }}
          />
          <button type="button" className="fx-btn fx-btn--ghost" onClick={() => fileInput.current?.click()}>
            <Upload aria-hidden /> Upload from this computer
          </button>
          <span className="fx-mute fx-att-picker__hint">Up to 10 MB each</span>
          <button type="button" className="fx-btn fx-btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="fx-btn fx-btn--primary" disabled={!changed} onClick={() => onAttach(picked)}>
            {picked.length ? `Attach ${picked.length}` : "Attach"}
          </button>
        </div>
      </div>
    </div>
  );
}
