// The email composer: /jobs/:id/email-editor, for a quote, an invoice, a
// receipt or a plain job email. Gmail's patterns in Field's look: chips for
// recipients, Send at the bottom left with a menu for scheduling, Ctrl/⌘
// Enter to send, and a preview of exactly what the customer gets, built by
// the server with the code that builds the sent email. On a phone it is
// full-screen like the Gmail app.
//
// Templates, merge fields, the default subject and the signature all come
// from the server (GET /api/jobs/:id/email-context); the composer keeps no
// defaults of its own.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertCircle, ArrowLeft, CalendarClock, ChevronDown, ChevronUp, Clock3, Eye, FlaskConical, MoreVertical, Paperclip, Send, Trash2 } from "lucide-react";
import { EMAIL_MERGE_FIELDS, renderComposerTemplate, renderSignature } from "../../../../shared/email-templates.js";
import { api, type EmailContext, type EmailDraftInput, type EmailPreview, type GoogleContact, type JobDocument, type NotIssuedDocument, type ScheduledEmail, type SentEmail } from "@/lib/api";
import type { JobDocumentType, MilestoneInvoice, RecordingDetail } from "@/lib/types";
import { jobRef, jobTitle } from "@/lib/job-status";
import { Menu, type MenuItem } from "@/components/shell/menu";
import { useShell } from "@/components/shell/shell-context";
import { AttachmentPicker, AttachmentTray } from "./email-attachments";
import { attachmentTotals, type MainAttachment } from "./attachment-summary";
import { EmailBodyEditor, type EmailBodyEditorHandle } from "./email-body-editor";
import { RecipientField } from "./recipient-field";
import { recipientProblem, type ContactSuggestion, type Recipient } from "./recipients";
import { EmailRows, SentEmailSheet } from "./email-record";
import { emailRows, whenLabel } from "./email-rows";
import { UNDO_SECONDS, composeTemplateBody, plainSendError, undoWindowMs } from "./email-composer";

const MERGE_TOKEN = /(\{\{\s*[A-Za-z]+\s*\}\})/;

/**
 * The subject: a plain input while it is edited. Away from it, a merge field
 * such as {{documentNumber}} reads as a chip with its value (or its name
 * while it has none), as the body shows them. The send fills it.
 */
export function SubjectField({ value, onChange, values }: { value: string; onChange: (next: string) => void; values: Record<string, string | null> | undefined }) {
  const [focused, setFocused] = useState(false);
  const parts = value.split(MERGE_TOKEN).filter(Boolean);
  const hasFields = parts.some((part) => MERGE_TOKEN.test(part));
  const masked = hasFields && !focused;
  return (
    <span className="fx-subject">
      <input
        id="composer-subject"
        className={`fx-composer__subject${masked ? " fx-composer__subject--masked" : ""}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Subject"
        aria-describedby={hasFields ? "composer-subject-fields" : undefined}
      />
      {masked ? (
        <span className="fx-subject__mirror" aria-hidden="true">
          {parts.map((part, index) => {
            const key = part.match(/^\{\{\s*([A-Za-z]+)\s*\}\}$/)?.[1];
            if (!key) return <span key={index}>{part}</span>;
            const label = EMAIL_MERGE_FIELDS.find((field) => field.key === key)?.label || key;
            return <span key={index} className="fx-subject__field" data-merge={key}>{values?.[key] || label}</span>;
          })}
        </span>
      ) : null}
      {hasFields ? <span id="composer-subject-fields" className="fx-sr">Fields in double braces are filled in when the email is sent.</span> : null}
    </span>
  );
}

type Phase = "compose" | "sending" | "error" | "auth_expired";

const DOCUMENT_LABEL: Record<string, string> = { quote: "quote", invoice: "invoice", receipt: "receipt" };

function documentTypeParam(value: string | null): JobDocumentType | null {
  return value === "quote" || value === "invoice" || value === "receipt" ? value : null;
}

function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function atTime(date: Date, hours: number) {
  const next = new Date(date);
  next.setHours(hours, 0, 0, 0);
  return next;
}

function schedulePresets(now = new Date()) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const monday = new Date(now);
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7));
  return [
    { label: "Tomorrow morning", at: atTime(tomorrow, 8) },
    { label: "Tomorrow afternoon", at: atTime(tomorrow, 13) },
    { label: "Monday morning", at: atTime(monday, 8) },
  ];
}

function scheduleLabel(date: Date) {
  return date.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function defaultMilestone(invoices: MilestoneInvoice[]) {
  return invoices.find((invoice) => invoice.status === "draft") || invoices[0] || null;
}

function namesOf(recipients: Recipient[]) {
  return recipients.map((entry) => entry.name || entry.email).join(", ");
}

export function EmailComposerPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useShell();
  const editorRef = useRef<EmailBodyEditorHandle>(null);
  const ccInput = useRef<HTMLInputElement>(null);
  const bccInput = useRef<HTMLInputElement>(null);

  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [context, setContext] = useState<EmailContext | null>(null);
  const [googleContacts, setGoogleContacts] = useState<GoogleContact[]>([]);
  const [jobDocuments, setJobDocuments] = useState<JobDocument[] | null>(null);
  const [notIssued, setNotIssued] = useState<NotIssuedDocument[]>([]);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);

  // Opening a draft replaces what the URL asked for.
  const [draft, setDraft] = useState<ScheduledEmail | null>(null);
  // Opened from a saved draft (not one autosave just made): say so.
  const [openedDraft, setOpenedDraft] = useState(false);
  const documentType = draft
    ? documentTypeParam(draft.documentType)
    : documentTypeParam(params.get("documentType"));

  const [to, setTo] = useState<Recipient[]>([]);
  const [cc, setCc] = useState<Recipient[]>([]);
  const [bcc, setBcc] = useState<Recipient[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [phoneCcOpen, setPhoneCcOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateId, setTemplateId] = useState("standard");
  const [touched, setTouched] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [uploads, setUploads] = useState<File[]>([]);
  const [selectedUids, setSelectedUids] = useState<string[]>([]);
  const [attachCreditNote, setAttachCreditNote] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => localInput(schedulePresets()[0].at));
  const [phase, setPhase] = useState<Phase>("compose");
  const [error, setError] = useState("");
  const [rail, setRail] = useState<"preview" | "activity">("preview");
  const [phonePreview, setPhonePreview] = useState(false);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [initialised, setInitialised] = useState(false);
  // Drafts are kept on the server as the operator writes (uploads included).
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [retained, setRetained] = useState<string[]>([]);
  const lastSaved = useRef<string | null>(null);
  const saving = useRef<Promise<ScheduledEmail | null> | null>(null);
  const [sentEmails, setSentEmails] = useState<SentEmail[]>([]);
  const [openSent, setOpenSent] = useState<SentEmail | null>(null);
  const [testing, setTesting] = useState(false);
  // The latest draft id, kept uploads and new uploads, for a send that waits
  // for an autosave in flight (its render's values are stale by then).
  const latest = useRef<{ draftId: string | null; retained: string[]; uploads: File[] }>({ draftId: null, retained: [], uploads: [] });

  useEffect(() => {
    if (!id) return;
    api.recording(id, params.get("version") || undefined).then(setDetail).catch((err) => setLoadError(err instanceof Error ? err.message : "This job could not be loaded."));
    api.googleContacts().then((result) => setGoogleContacts(result.contacts)).catch(() => setGoogleContacts([]));
    api.jobDocuments(id)
      .then((result) => { setJobDocuments(result.documents); setNotIssued(result.notIssued || []); })
      .catch(() => { setJobDocuments(null); setNotIssued([]); });
  }, [id, params]);

  const refreshScheduled = useCallback(() => {
    if (!id) return Promise.resolve(undefined);
    return Promise.all([api.scheduledEmails(id), api.sentEmails(id).catch(() => ({ ok: false, sentEmails: [] as SentEmail[] }))]).then(([queued, sent]) => {
      setScheduledEmails(queued.scheduledEmails);
      setSentEmails(sent.sentEmails);
      return queued.scheduledEmails;
    }).catch(() => {
      // Sending stays usable if the list cannot refresh.
      return null;
    });
  }, [id]);
  useEffect(() => {
    void refreshScheduled().then(async (queued) => {
      // ?draft=<id>: open that draft (Undo, Edit, or back from Gmail sign-in).
      const wanted = params.get("draft");
      const item = wanted ? (queued || []).find((entry) => entry.id === wanted) : null;
      if (!item) return;
      if (item.status === "pending") {
        const back = await api.unscheduleEmail(id, item.id).catch(() => null);
        if (back) openDraft(back.scheduledEmail);
      } else if (item.status === "draft" || item.status === "failed") {
        openDraft(item);
      }
    });
    // Opening a draft once, when the page loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshScheduled]);

  const milestoneInvoice = useMemo(() => {
    const invoices = detail?.meta.milestoneInvoices || [];
    if (!invoices.length || !documentType || documentType === "quote") return null;
    const requested = draft ? draft.milestoneIndex : params.get("milestoneIndex");
    if (requested != null && requested !== "") {
      const match = invoices.find((invoice) => invoice.milestoneIndex === Number(requested));
      if (match) return match;
    }
    return defaultMilestone(invoices);
  }, [detail, documentType, draft, params]);
  const version = draft?.quoteVersion ? String(draft.quoteVersion) : params.get("version");
  // An adjustment note on its own (from the invoice's menu).
  const adjustmentNote = draft?.draftContent?.adjustmentNote
    || (!documentType && params.get("purpose") === "adjustment-note" ? params.get("creditNote") : null)
    || null;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.emailContext(id, {
      documentType,
      milestoneIndex: milestoneInvoice?.milestoneIndex ?? null,
      version,
      ...(adjustmentNote ? { purpose: "adjustment-note", creditNote: adjustmentNote } : {}),
    })
      .then((next) => { if (!cancelled) setContext(next); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : "The composer could not load."); });
    return () => { cancelled = true; };
  }, [id, documentType, milestoneInvoice?.milestoneIndex, version, adjustmentNote]);

  // Into the earlier Gmail conversation for this document line (decision 5):
  // on by default; the subject then follows that conversation's.
  const [threadOn, setThreadOn] = useState(false);
  const [templateSubject, setTemplateSubject] = useState("");
  const thread = context?.thread || null;

  // A new message: the job's contact, the first template and the signature.
  // Set while rendering, once the context has come, so the first composer
  // drawn already holds them.
  if (context && !initialised && !draft) {
    const template = context.templates[0];
    const contact = context.jobContacts.find((entry) => entry.source === "job");
    if (contact) setTo([{ email: contact.email, name: contact.name || null }]);
    const fresh = template ? renderComposerTemplate(template, context.mergeValues).subject || context.defaultSubject : context.defaultSubject;
    setTemplateSubject(fresh);
    if (template) {
      setTemplateId(template.id);
      setBody(composeTemplateBody(template, context));
    } else {
      setBody(renderSignature(context.signature?.html || null, context.mergeValues));
    }
    setThreadOn(Boolean(context.thread));
    setSubject(context.thread ? context.thread.replySubject : fresh);
    // The send type's default attachments: ticked ones attached, the others offered.
    setSelectedUids((context.suggestions || []).filter((entry) => entry.ticked).map((entry) => entry.uid));
    setInitialised(true);
  }

  const contacts = useMemo<ContactSuggestion[]>(() => [
    ...(context?.jobContacts || []).map((entry) => ({ email: entry.email, name: entry.name || "", source: entry.source })),
    ...googleContacts.map((entry) => ({ email: entry.email.toLowerCase(), name: entry.name, source: "google" as const })),
  ], [context, googleContacts]);

  const creditNoteNumber = documentType === "invoice" ? milestoneInvoice?.issuedRevision?.creditNoteNumber ?? null : null;
  const creditNoteDocument = creditNoteNumber ? (jobDocuments || []).find((entry) => entry.documentType === "credit_note" && entry.number === creditNoteNumber) || null : null;
  const mainNumber = !documentType
    ? null
    : documentType === "quote"
      ? (() => {
        const ref = detail?.quote?.quoteNumber || detail?.meta.quoteNumber || null;
        const quoteVersion = draft?.quoteVersion || detail?.quote?.version || null;
        return ref && quoteVersion ? `${ref} v${quoteVersion}` : null;
      })()
      : documentType === "invoice"
        ? milestoneInvoice?.issuedRevision?.invoiceNumber || milestoneInvoice?.invoiceNumber || null
        : milestoneInvoice?.receiptNumber || null;
  const mainIssued = mainNumber ? (jobDocuments || []).find((entry) => entry.documentType === documentType && entry.number === mainNumber) || null : null;
  const previewMain = preview?.attachments.find((entry) => entry.source === "main") || null;
  const draftInvoice = documentType === "invoice" && (milestoneInvoice?.status || "draft") === "draft";
  const mainAttachment: MainAttachment | null = documentType ? {
    filename: draft?.draftContent?.attachmentFilename
      || (draftInvoice ? "Invoice PDF, named when it is issued" : previewMain?.filename || `${mainNumber || DOCUMENT_LABEL[documentType]}.pdf`),
    documentType,
    byteLength: mainIssued?.byteLength ?? null,
    issued: Boolean(mainIssued),
  } : null;
  const attachedDocuments = (jobDocuments || []).filter((entry) => (
    selectedUids.includes(entry.uid)
    && entry.number !== mainNumber
    && !(attachCreditNote && creditNoteDocument?.uid === entry.uid)
  ));
  const trayDocuments = [...attachedDocuments, ...(attachCreditNote && creditNoteDocument ? [creditNoteDocument] : [])];
  // Offered by the send type, not attached until ticked.
  const suggestedDocuments = (context?.suggestions || [])
    .filter((entry) => !selectedUids.includes(entry.uid) && entry.number !== mainNumber)
    .map((entry) => ({ document: (jobDocuments || []).find((candidate) => candidate.uid === entry.uid) || null, reason: entry.reason }))
    .filter((entry): entry is { document: JobDocument; reason: string } => Boolean(entry.document));
  const totals = attachmentTotals({ main: mainAttachment, documents: trayDocuments, uploads });
  const recipientIssues = [...to, ...cc, ...bcc].filter((entry) => recipientProblem(entry.email, context?.deliveryPolicy));
  const blockers = [
    !to.length ? "Add a recipient" : null,
    recipientIssues.length ? `Fix ${recipientIssues.length} ${recipientIssues.length === 1 ? "address" : "addresses"}` : null,
    !subject.trim() ? "Add a subject" : null,
    totals.problem ? "Remove an attachment" : null,
  ].filter(Boolean) as string[];
  const canSend = phase !== "sending" && blockers.length === 0 && Boolean(context);

  // The preview: what the server would send now. Debounced; cancelled when
  // the message changes again.
  const previewKey = JSON.stringify({ subject, body, to: to.map((entry) => entry.email), cc: cc.map((entry) => entry.email), bcc: bcc.map((entry) => entry.email), docs: trayDocuments.map((entry) => entry.uid), uploads: uploads.map((file) => [file.name, file.size]), documentType, m: milestoneInvoice?.milestoneIndex ?? null, version, adjustmentNote });
  useEffect(() => {
    if (!id || !context || !initialised) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.emailPreview(id, {
        documentType,
        milestoneIndex: milestoneInvoice?.milestoneIndex ?? null,
        version,
        subject,
        customBody: body,
        to: to.map((entry) => entry.email),
        cc: cc.map((entry) => entry.email),
        bcc: bcc.map((entry) => entry.email),
        documents: trayDocuments.map(({ uid }) => ({ uid })),
        uploads: uploads.map((file) => ({ filename: file.name, byteLength: file.size })),
        attachmentFilename: draft?.draftContent?.attachmentFilename || null,
        adjustmentNote,
      }, { signal: controller.signal })
        .then((next) => { setPreview(next); setPreviewError(null); })
        .catch((err) => { if (!controller.signal.aborted) setPreviewError(err instanceof Error ? err.message : "Preview unavailable"); });
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // previewKey carries every input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, context, initialised, previewKey]);

  function applyTemplate(nextId: string) {
    const template = context?.templates.find((entry) => entry.id === nextId);
    if (!template || !context) return;
    setTemplateId(template.id);
    setSubject(renderComposerTemplate(template, context.mergeValues).subject || context.defaultSubject);
    setBody(composeTemplateBody(template, context));
    setTouched(false);
    setPendingTemplate(null);
  }

  // The draft id, kept uploads and new uploads as of now: a save updates
  // this at once, before React renders, so a send or another save that
  // waited for it uses the saved draft and never makes a second one.
  latest.current = { draftId: draft?.id || null, retained, uploads };

  function draftInput(): EmailDraftInput {
    return {
      draftId: latest.current.draftId,
      to: to.map((entry) => entry.email),
      cc: cc.map((entry) => entry.email),
      bcc: bcc.map((entry) => entry.email),
      subject,
      customBody: body,
      documentType,
      milestoneIndex: documentType && documentType !== "quote" ? milestoneInvoice?.milestoneIndex ?? null : null,
      version: version || null,
      invoicePaidAmount: documentType === "invoice" ? draft?.draftContent?.invoicePaidAmount ?? milestoneInvoice?.amountPaid ?? 0 : null,
      attachmentFilename: draft?.draftContent?.attachmentFilename || null,
      attachCreditNote: Boolean(creditNoteNumber && attachCreditNote),
      documents: attachedDocuments.map(({ uid }) => ({ uid })),
      keepAttachments: latest.current.retained,
      inReplyTo: threadOn && thread ? thread.id : null,
      adjustmentNote,
    };
  }
  const draftSignature = JSON.stringify({ ...draftInput(), draftId: null, uploads: uploads.map((file) => [file.name, file.size]) });

  /** Save the email as a draft on the server now; new uploads go with it. */
  async function saveDraftNow(): Promise<ScheduledEmail | null> {
    if (saving.current) await saving.current;
    const signature = draftSignature;
    const files = latest.current.uploads;
    const run = (async () => {
      try {
        const result = await api.saveEmailDraft(id, draftInput(), files);
        const kept = (result.scheduledEmail.attachments || []).map((entry) => entry.filename);
        latest.current = {
          draftId: result.scheduledEmail.id,
          retained: kept,
          uploads: latest.current.uploads.filter((file) => !files.includes(file)),
        };
        setDraft(result.scheduledEmail);
        setRetained(kept);
        setUploads((current) => current.filter((file) => !files.includes(file)));
        lastSaved.current = signature;
        setSavedAt(new Date().toISOString());
        setSaveError(null);
        return result.scheduledEmail;
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "The draft could not be saved.");
        return null;
      }
    })();
    saving.current = run;
    try {
      return await run;
    } finally {
      saving.current = null;
    }
  }

  // Autosave: a second and a half after the last change.
  useEffect(() => {
    if (!initialised || !context || phase === "sending") return;
    if (lastSaved.current === null) { lastSaved.current = draftSignature; return; }
    if (lastSaved.current === draftSignature) return;
    const timer = window.setTimeout(() => { void saveDraftNow(); }, 1500);
    return () => window.clearTimeout(timer);
    // draftSignature carries every input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSignature, initialised, context, phase]);

  /** After a held send: Sent, or Not sent with why, once the hold is over. */
  function followHeldSend(scheduledId: string, names: string, checks = [UNDO_SECONDS * 1000 + 2500, 15_000, 30_000]) {
    const [wait, ...rest] = checks;
    if (wait == null) return;
    window.setTimeout(async () => {
      const queued = await api.scheduledEmails(id).catch(() => null);
      const record = queued?.scheduledEmails.find((entry) => entry.id === scheduledId);
      if (record?.status === "sent" && record.reconciled) toast(`Already sent: Field found the first send to ${names} in Sent Mail, so it did not send it again. Your edits were not sent.`);
      else if (record?.status === "sent") toast(`Sent to ${names}.`);
      else if (record?.status === "failed" && record.deliveryOutcome === "rejected") toast(`Not sent: ${record.lastError || "Gmail did not accept it"}. It is in the job's email list.`);
      else if (record?.status === "failed") toast(`Not confirmed: Field could not tell whether Gmail sent it to ${names}. ${/cannot reach|still be delivering/i.test(record.lastError || "") ? record.lastError : "Check Sent Mail before sending it again."} It is in the job's email list.`);
      else if (record?.status === "pending" || record?.status === "sending") followHeldSend(scheduledId, names, rest);
    }, wait);
  }

  async function send(scheduledAt: string | null = null) {
    if (!canSend || !detail) return;
    setPhase("sending");
    setError("");
    // An autosave in flight finishes first, so its uploads go once and the
    // send uses the draft it saved (latest is updated by the save itself).
    if (saving.current) await saving.current;
    const { draftId, retained: keep, uploads: files } = latest.current;
    const requestedAt = Date.now();
    try {
      const recipients = to.map((entry) => entry.email);
      const options = {
        cc: cc.map((entry) => entry.email),
        bcc: bcc.map((entry) => entry.email),
        attachments: files,
        scheduledAt,
        // Send now is held, so it can be undone; a schedule is not.
        holdSeconds: scheduledAt ? null : UNDO_SECONDS,
        draftId,
        keepAttachments: draftId ? keep : null,
        inReplyTo: threadOn && thread ? thread.id : null,
        adjustmentNote,
        documents: attachedDocuments.map(({ uid }) => ({ uid })),
      };
      const result = documentType
        ? await api.emailQuote(id, recipients, body, {
          ...options,
          subject: subject.trim(),
          documentType,
          milestoneIndex: documentType !== "quote" ? milestoneInvoice?.milestoneIndex ?? null : null,
          invoicePaidAmount: documentType === "invoice" ? draft?.draftContent?.invoicePaidAmount ?? milestoneInvoice?.amountPaid ?? 0 : null,
          version: version || null,
          attachmentFilename: draft?.draftContent?.attachmentFilename || null,
          attachCreditNote: Boolean(creditNoteNumber && attachCreditNote),
        })
        : await api.emailJob(id, recipients, subject.trim(), body, options);
      const what = documentType ? `${documentType[0].toUpperCase()}${documentType.slice(1)}` : "Email";
      const names = namesOf(to);
      const queuedId = result.scheduledEmail?.id || null;
      // Back to the job's email list, where a held send shows as Sending.
      navigate(result.scheduled ? `/jobs/${id}?tab=email` : `/jobs/${id}`);
      if (result.held && queuedId) {
        // Undo lasts until the server's hold ends, counted from the request.
        const undoMs = undoWindowMs(result.scheduledEmail?.scheduledAt, requestedAt);
        toast(`Sending ${label} to ${names}…`, () => {
          void api.unscheduleEmail(id, queuedId)
            .then(() => {
              navigate(`/jobs/${id}/email-editor?draft=${queuedId}`);
              toast("Send undone. Your email is a draft again.");
            })
            .catch((err) => toast(`Too late to undo: ${err instanceof Error ? err.message : "it is already sending"}.`));
        }, { durationMs: undoMs });
        followHeldSend(queuedId, names, [undoMs + 2500, 15_000, 30_000]);
      } else {
        toast(result.scheduled && scheduledAt ? `${what} scheduled for ${scheduleLabel(new Date(scheduledAt))}` : `${what} sent to ${names}`);
      }
    } catch (err) {
      const code = (err as Error & { code?: unknown })?.code;
      setError(plainSendError(err));
      setPhase(code === "gmail_auth_expired" ? "auth_expired" : "error");
      void refreshScheduled();
    }
  }

  // Send a test to me: to the signed-in person only, "[Test]" in the subject.
  // Nothing is issued and nothing is recorded.
  async function sendTest() {
    if (!detail || testing) return;
    setTesting(true);
    try {
      const recipients = to.length ? to.map((entry) => entry.email) : [context?.from.email || ""];
      const options = {
        cc: [],
        bcc: [],
        attachments: uploads,
        test: true,
        documents: attachedDocuments.map(({ uid }) => ({ uid })),
        adjustmentNote,
      };
      const result = documentType
        ? await api.emailQuote(id, recipients, body, {
          ...options,
          subject: subject.trim(),
          documentType,
          milestoneIndex: documentType !== "quote" ? milestoneInvoice?.milestoneIndex ?? null : null,
          version: version || null,
          attachCreditNote: Boolean(creditNoteNumber && attachCreditNote),
        })
        : await api.emailJob(id, recipients, subject.trim(), body, options);
      toast(`Test sent to ${(result.result?.to || []).join(", ") || "you"}. Nothing was issued or recorded.`);
    } catch (err) {
      setError(`The test was not sent. ${plainSendError(err)}`);
      setPhase("error");
    } finally {
      setTesting(false);
    }
  }

  async function discard() {
    if (draft?.id) await api.discardEmailDraft(id, draft.id).catch(() => null);
    toast(draft?.id ? "Draft discarded." : "Email discarded.");
    navigate(`/jobs/${id}`);
  }

  async function reconnectGmail() {
    try {
      // The draft, uploads included, is kept on the server through the
      // sign-in redirect, and opened again when Gmail sends the operator back.
      const saved = await saveDraftNow();
      const next = new URLSearchParams(params);
      if (saved?.id) next.set("draft", saved.id);
      const suffix = next.toString() ? `?${next.toString()}` : "";
      const { url } = await api.gmailAuthUrl(`/jobs/${id}/email-editor${suffix}`);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gmail could not be reconnected.");
    }
  }

  function openDraft(item: ScheduledEmail) {
    setDraft(item);
    setOpenedDraft(true);
    setRetained((item.attachments || []).map((entry) => entry.filename));
    setAttachCreditNote(item.draftContent?.attachCreditNote === true);
    lastSaved.current = null;
    setTo(item.to.map((email) => ({ email, name: contacts.find((entry) => entry.email === email)?.name || null })));
    setCc((item.cc || []).map((email) => ({ email, name: null })));
    setBcc((item.bcc || []).map((email) => ({ email, name: null })));
    setShowCc((item.cc || []).length > 0);
    setShowBcc((item.bcc || []).length > 0);
    setSubject(item.subject || "");
    setBody(item.draftContent?.customBody || "");
    setSelectedUids((item.documents || []).map((entry) => entry.uid));
    setUploads([]);
    setPhase("compose");
    setInitialised(true);
  }

  async function unschedule(item: ScheduledEmail, edit: boolean) {
    try {
      const result = await api.unscheduleEmail(id, item.id);
      await refreshScheduled();
      if (edit) openDraft(result.scheduledEmail);
      else toast("Send cancelled. It is kept as a draft.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The send could not be cancelled.");
      setPhase("error");
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key === "Enter") {
      event.preventDefault();
      void send(null);
      return;
    }
    if (mod && event.shiftKey && (event.key === "C" || event.key === "c")) {
      event.preventDefault();
      setShowCc(true);
      setPhoneCcOpen(true);
      window.setTimeout(() => ccInput.current?.focus(), 0);
      return;
    }
    if (mod && event.shiftKey && (event.key === "B" || event.key === "b")) {
      event.preventDefault();
      setShowBcc(true);
      setPhoneCcOpen(true);
      window.setTimeout(() => bccInput.current?.focus(), 0);
    }
  }

  if (loadError) {
    return (
      <div className="fx-composer fx-composer--notice">
        <div className="fx-notice fx-notice--bad"><AlertCircle aria-hidden /><span>{loadError}</span></div>
        <Link className="fx-btn" to={id ? `/jobs/${id}` : "/jobs"}>Back to the job</Link>
      </div>
    );
  }
  if (!detail || !context) {
    return <div className="fx-composer fx-composer--notice" role="status">Loading the composer…</div>;
  }

  const meta = detail.meta;
  const label = documentType ? DOCUMENT_LABEL[documentType] : "email";
  const title = adjustmentNote
    ? `Send adjustment note ${adjustmentNote}`
    : documentType ? `Send ${label}${mainNumber && mainIssued ? ` ${mainNumber}` : ""}` : "Send email";
  const replacement = context.replacement || null;
  const money = (value: number | null | undefined) => (value == null ? null : Number(value).toLocaleString("en-AU", { style: "currency", currency: "AUD" }));
  const presets = schedulePresets();
  const sendMenu: MenuItem[] = [
    ...presets.map((preset) => ({ label: `${preset.label} · ${scheduleLabel(preset.at)}`, icon: <Clock3 aria-hidden />, onSelect: () => void send(preset.at.toISOString()) })),
    { label: "Pick date and time…", icon: <CalendarClock aria-hidden />, onSelect: () => setScheduleOpen(true) },
    { kind: "separator" },
    { label: `Send a test to me · ${context.from.email || "your address"}`, icon: <FlaskConical aria-hidden />, onSelect: () => void sendTest() },
  ];
  const activity = emailRows(sentEmails, scheduledEmails.filter((item) => item.id !== draft?.id));
  const saveLabel = saveError ? "Draft not saved" : savedAt ? `Draft saved ${whenLabel(savedAt).split(", ").pop()}` : null;
  const shortcut = IS_MAC ? "⌘ Enter" : "Ctrl Enter";
  const contactSubline = [meta.contactName, jobTitle(meta)].filter(Boolean).join(" · ");

  const recipientRows = (
    <>
      <div className="fx-composer__field fx-composer__from">
        <span className="fx-rcpt__label">From</span>
        <span className="fx-composer__from-value">{context.from.name ? `${context.from.name} <${context.from.email || ""}>` : context.from.email || "Your Gmail account"}</span>
      </div>
      <RecipientField
        label="To"
        recipients={to}
        onChange={setTo}
        contacts={contacts}
        policy={context.deliveryPolicy}
        trailing={(
          <span className="fx-rcpt__toggles">
            {!showCc ? <button type="button" className="fx-rcpt__toggle" onClick={() => { setShowCc(true); window.setTimeout(() => ccInput.current?.focus(), 0); }}>Cc</button> : null}
            {!showBcc ? <button type="button" className="fx-rcpt__toggle" onClick={() => { setShowBcc(true); window.setTimeout(() => bccInput.current?.focus(), 0); }}>Bcc</button> : null}
            <button type="button" className="fx-rcpt__toggle fx-rcpt__fold" aria-expanded={phoneCcOpen} aria-label={phoneCcOpen ? "Hide Cc and Bcc" : "Show Cc and Bcc"} onClick={() => { setPhoneCcOpen((open) => !open); setShowCc(true); setShowBcc(true); }}>
              {phoneCcOpen ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            </button>
          </span>
        )}
      />
      {showCc ? <div className="fx-composer__fold" data-open={phoneCcOpen ? "true" : undefined}><RecipientField label="Cc" recipients={cc} onChange={setCc} contacts={contacts} policy={context.deliveryPolicy} inputRef={ccInput} /></div> : null}
      {showBcc ? <div className="fx-composer__fold" data-open={phoneCcOpen ? "true" : undefined}><RecipientField label="Bcc" recipients={bcc} onChange={setBcc} contacts={contacts} policy={context.deliveryPolicy} inputRef={bccInput} /></div> : null}
      {thread ? (
        <label className="fx-composer__thread">
          <input
            type="checkbox"
            className="fx-checkbox"
            checked={threadOn}
            onChange={(event) => {
              setThreadOn(event.target.checked);
              setSubject(event.target.checked ? thread.replySubject : templateSubject);
            }}
          />
          <span>
            Send in the conversation of &ldquo;{thread.subject}&rdquo;{thread.sentAt ? `, sent ${whenLabel(thread.sentAt)}` : ""}
            <small>{threadOn
              ? `Gmail keeps it in that conversation while the subject stays "${thread.replySubject}".${thread.headers ? "" : " That email was sent before Field kept its Message-ID, so the customer's mail may show it apart."}`
              : "Off: this email starts a new conversation."}</small>
          </span>
        </label>
      ) : null}
      <div className="fx-composer__field">
        <label className="fx-rcpt__label" htmlFor="composer-subject">Subject</label>
        <SubjectField value={subject} onChange={(next) => { setSubject(next); setTouched(true); }} values={context?.mergeValues} />
      </div>
    </>
  );

  return (
    <div className="fx-composer" onKeyDown={onKeyDown}>
      {/* Phone: full-screen, Send in the top bar. */}
      <div className="fx-composer__bar">
        <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="Back to the job" onClick={() => navigate(`/jobs/${id}`)}><ArrowLeft aria-hidden /></button>
        <span className="fx-composer__bar-title">{documentType ? `Send ${label}` : "Send email"}</span>
        <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="Attach" onClick={() => setPickerOpen(true)}><Paperclip aria-hidden /></button>
        <button type="button" className="fx-composer__fab" aria-label="Send" disabled={!canSend} onClick={() => void send(null)}><Send aria-hidden /></button>
        <Menu
          label="More send options"
          items={[
            ...sendMenu,
            { kind: "separator" },
            { label: "Preview", icon: <Eye aria-hidden />, onSelect: () => setPhonePreview(true) },
            { label: "Discard", icon: <Trash2 aria-hidden />, tone: "danger", onSelect: () => void discard() },
          ]}
          trigger={(props) => <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="More send options" {...props}><MoreVertical aria-hidden /></button>}
        />
      </div>

      <header className="fx-ph fx-composer__ph">
        <div className="fx-ph__stack">
          <nav className="fx-crumb" aria-label="Breadcrumb">
            <Link to="/jobs">Jobs</Link><span aria-hidden>/</span>
            <Link to={`/jobs/${id}`}>{jobTitle(meta)}</Link><span aria-hidden>/</span>
            <span>{documentType === "quote" ? "Quote" : documentType ? "Invoices" : "Email"}</span>
          </nav>
          <div className="fx-ph__line">
            <h1 className="fx-ph__title">{title}</h1>
            {replacement?.replacesNumber && context.sendType === "replacement-invoice" ? <span className="fx-mute fx-composer__ref">Replaces {replacement.replacesNumber}</span> : null}
            <span className="fx-mute fx-composer__ref">{jobRef(meta)}</span>
            {saveLabel ? <span className="fx-save-state" data-state={saveError ? "error" : "saved"} title={saveError || undefined}>{saveLabel}</span> : null}
          </div>
        </div>
      </header>

      {replacement?.replacesNumber && context.sendType === "replacement-invoice" ? (
        <div className="fx-notice">
          <span>
            {mainNumber}{money(replacement.total) ? ` (${money(replacement.total)})` : ""} replaces {replacement.replacesNumber}{money(replacement.replacesTotal) ? ` (${money(replacement.replacesTotal)})` : ""}, which adjustment note {replacement.creditNoteNumber} credits in full. Both are issued and attach as stored. Nothing is rendered again.
          </span>
        </div>
      ) : null}
      {replacement && context.sendType === "adjustment-note" ? (
        <div className="fx-notice">
          <span>Adjustment note {replacement.creditNoteNumber} cancels {replacement.replacesNumber || "the credited invoice"}{replacement.replacementNumber ? `, replaced by ${replacement.replacementNumber}` : ""}. It attaches as stored.</span>
        </div>
      ) : null}
      {openedDraft ? (
        <div className="fx-notice"><span>Editing a draft. Sending or scheduling uses this draft, so no copy is left behind.{draft?.checksSentMail ? " An earlier send of it was not confirmed: Field looks for it in Sent Mail first, and does not send it twice." : ""}</span></div>
      ) : null}
      {phase === "error" ? (
        <div className="fx-notice fx-notice--bad" role="alert"><AlertCircle aria-hidden /><span>{error.startsWith("Not confirmed") ? "" : "Not sent. "}{error} Your message, recipients and attachments are kept{draft?.id ? " in this draft" : ""}.</span></div>
      ) : null}
      {phase === "auth_expired" ? (
        <div className="fx-notice fx-notice--warn" role="alert">
          <AlertCircle aria-hidden />
          <span>Not sent. The Gmail sign-in for {context.from.email || "this account"} has expired. Reconnect Gmail, then send again. Your message, recipients and attachments are kept: Field saves them as a draft before you go to Gmail.</span>
          <button type="button" className="fx-btn fx-btn--sm" onClick={() => void reconnectGmail()}>Reconnect Gmail</button>
        </div>
      ) : null}

      <div className="fx-composer__grid">
        <section className="fx-composer__card" aria-label="Message">
          {recipientRows}
          <EmailBodyEditor
            ref={editorRef}
            content={body}
            onChange={(html) => { setBody(html); setTouched(true); }}
            templates={context.templates.map((template) => ({ id: template.id, name: template.name, description: template.description }))}
            templateId={templateId}
            onTemplateSelect={(next) => (touched ? setPendingTemplate(next) : applyTemplate(next))}
            mergeFields={context.mergeFields}
            onInsertSignature={() => editorRef.current?.insertHtml(renderSignature(context.signature?.html || null, context.mergeValues))}
          />
          {creditNoteNumber && jobDocuments === null ? (
            <label className="fx-check fx-composer__check">
              <input type="checkbox" className="fx-checkbox" checked={attachCreditNote} onChange={(event) => setAttachCreditNote(event.target.checked)} />
              Also attach the adjustment note ({creditNoteNumber})
            </label>
          ) : null}
          <AttachmentTray
            main={mainAttachment}
            documents={trayDocuments}
            suggested={suggestedDocuments}
            onAddSuggested={(uid: string) => setSelectedUids((current) => [...current, uid])}
            uploads={uploads}
            retainedNames={retained}
            onRemoveRetained={(name: string) => setRetained((current) => current.filter((entry) => entry !== name))}
            pickerAvailable
            onAdd={() => setPickerOpen(true)}
            onRemoveDocument={(uid) => {
              if (uid === creditNoteDocument?.uid) setAttachCreditNote(false);
              setSelectedUids((current) => current.filter((entry) => entry !== uid));
            }}
            onRemoveUpload={(index) => setUploads((current) => current.filter((_file, fileIndex) => fileIndex !== index))}
          />
          <div className="fx-composer__send">
            <div className="fx-split">
              <button type="button" className="fx-btn fx-btn--primary" disabled={!canSend} onClick={() => void send(null)}>
                {phase === "sending" ? "Sending…" : "Send"}
              </button>
              <Menu
                label="Schedule send"
                align="start"
                items={sendMenu}
                trigger={(props) => <button type="button" className="fx-btn fx-btn--primary fx-split__more" aria-label="Schedule send" disabled={!canSend} {...props}><ChevronDown aria-hidden /></button>}
              />
            </div>
            <span className="fx-mute fx-composer__hint">{blockers.length ? blockers.join(" · ") : `${shortcut} to send`}</span>
          </div>
          <div className="fx-sr" role="status" aria-live="polite">{phase === "sending" ? "Sending" : ""}</div>
        </section>

        <aside className={`fx-composer__rail${phonePreview ? " fx-composer__rail--open" : ""}`} aria-label="Preview and email on this job">
          <div className="fx-seg fx-composer__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={rail === "preview"} onClick={() => setRail("preview")}>Preview</button>
            <button type="button" role="tab" aria-selected={rail === "activity"} onClick={() => setRail("activity")}>Email on this job{activity.length ? ` · ${activity.length}` : ""}</button>
            {phonePreview ? <button type="button" className="fx-composer__close" onClick={() => setPhonePreview(false)}>Done</button> : null}
          </div>
          {rail === "preview" ? (
            <EmailPreviewPanel preview={preview} error={previewError} recipients={to} cc={cc} />
          ) : (
            <EmailRows rows={activity} onOpen={setOpenSent} onEdit={(item) => (item.status === "pending" ? void unschedule(item, true) : openDraft(item))} onCancel={(item) => void unschedule(item, false)} />
          )}
        </aside>
      </div>

      {pickerOpen ? (
        <AttachmentPicker
          jobId={id}
          documents={jobDocuments || []}
          notIssued={notIssued.filter((entry) => !(documentType === "invoice" && entry.milestoneIndex === milestoneInvoice?.milestoneIndex))}
          selected={attachedDocuments.map((entry) => entry.uid)}
          mainNumber={mainNumber}
          lockedNote={attachCreditNote && creditNoteDocument ? { [creditNoteDocument.uid]: "Attached by the adjustment note box" } : {}}
          onCancel={() => setPickerOpen(false)}
          onAttach={(uids) => { setSelectedUids(uids); setPickerOpen(false); }}
          onUpload={(files) => setUploads((current) => [...current, ...files])}
        />
      ) : null}

      {scheduleOpen ? (
        <div className="fx-scrim" onMouseDown={() => setScheduleOpen(false)}>
          <form
            className="fx-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="schedule-title"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setScheduleOpen(false); }}
            onSubmit={(event) => { event.preventDefault(); setScheduleOpen(false); void send(new Date(scheduleAt).toISOString()); }}
          >
            <div className="fx-dialog__h" id="schedule-title">Schedule send</div>
            <div className="fx-dialog__b">
              <label className="fx-label" htmlFor="schedule-at">Date and time<input id="schedule-at" className="fx-input" type="datetime-local" required value={scheduleAt} min={localInput(new Date(Date.now() + 60_000))} onChange={(event) => setScheduleAt(event.target.value)} autoFocus /></label>
              <p className="fx-mute" style={{ margin: 0, fontSize: 12 }}>Field sends it at this time ({Intl.DateTimeFormat().resolvedOptions().timeZone}). It stays in this job's email list until then, with Cancel send.</p>
            </div>
            <div className="fx-dialog__f">
              <button type="button" className="fx-btn fx-btn--ghost" onClick={() => setScheduleOpen(false)}>Cancel</button>
              <button type="submit" className="fx-btn fx-btn--primary">Schedule send</button>
            </div>
          </form>
        </div>
      ) : null}

      {pendingTemplate ? (
        <div className="fx-scrim" onMouseDown={() => setPendingTemplate(null)}>
          <div className="fx-dialog" role="alertdialog" aria-modal="true" aria-labelledby="template-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setPendingTemplate(null); }}>
            <div className="fx-dialog__h" id="template-title">Replace your message with {context.templates.find((entry) => entry.id === pendingTemplate)?.name}?</div>
            <div className="fx-dialog__b"><p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>Your changes to the subject and the message are lost.</p></div>
            <div className="fx-dialog__f">
              <button type="button" className="fx-btn fx-btn--ghost" onClick={() => setPendingTemplate(null)} autoFocus>Keep my message</button>
              <button type="button" className="fx-btn fx-btn--primary" onClick={() => applyTemplate(pendingTemplate)}>Replace</button>
            </div>
          </div>
        </div>
      ) : null}
      {openSent ? <SentEmailSheet record={openSent} documents={jobDocuments} onClose={() => setOpenSent(null)} /> : null}
      <p className="fx-sr">{contactSubline}</p>
    </div>
  );
}

/** The email as the customer gets it, from the server. */
export function EmailPreviewPanel({ preview, error, recipients, cc }: { preview: EmailPreview | null; error: string | null; recipients: Recipient[]; cc: Recipient[] }) {
  if (error) return <div className="fx-composer__preview"><p className="fx-att__problem" role="alert">The preview could not be built: {error}</p></div>;
  if (!preview) return <div className="fx-composer__preview"><p className="fx-mute" role="status">Building the preview…</p></div>;
  const toLine = [
    recipients.length ? `to ${namesOf(recipients)}` : null,
    cc.length ? `cc ${namesOf(cc)}` : null,
  ].filter(Boolean).join(", ");
  return (
    <div className="fx-composer__preview">
      <div className="fx-composer__preview-h">
        <strong>{preview.subject}</strong>
        <span className="fx-mute">{preview.from.name || preview.from.email}{toLine ? ` ${toLine}` : ""}</span>
      </div>
      <iframe className="fx-composer__frame" title="Email preview" sandbox="" srcDoc={preview.html} />
      {preview.attachments.length ? (
        <ul className="fx-composer__preview-att" aria-label="Attachments in the preview">
          {preview.attachments.map((entry) => <li key={`${entry.source}-${entry.filename}`}><Paperclip aria-hidden />{entry.filename}</li>)}
        </ul>
      ) : null}
      {preview.pending.map((note) => <p key={note} className="fx-mute fx-composer__preview-note">{note}</p>)}
      <p className="fx-mute fx-composer__preview-note">Field builds this preview with the same code that builds the sent email.</p>
    </div>
  );
}
