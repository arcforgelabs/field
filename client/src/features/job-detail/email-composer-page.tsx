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
import { AlertCircle, ArrowLeft, CalendarClock, ChevronDown, ChevronUp, Clock3, Eye, MoreVertical, Paperclip, Send, Trash2 } from "lucide-react";
import { renderComposerTemplate, renderSignature } from "../../../../shared/email-templates.js";
import { api, type EmailContext, type EmailPreview, type GoogleContact, type JobDocument, type NotIssuedDocument, type ScheduledEmail } from "@/lib/api";
import type { JobDocumentType, MilestoneInvoice, RecordingDetail } from "@/lib/types";
import { jobRef, jobTitle } from "@/lib/job-status";
import { Menu, type MenuItem } from "@/components/shell/menu";
import { useShell } from "@/components/shell/shell-context";
import { AttachmentPicker, AttachmentTray, attachmentTotals, type MainAttachment } from "./email-attachments";
import { EmailBodyEditor, type EmailBodyEditorHandle } from "./email-body-editor";
import { RecipientField, recipientProblem, type ContactSuggestion, type Recipient } from "./recipient-field";

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

export function schedulePresets(now = new Date()) {
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

export function scheduleLabel(date: Date) {
  return date.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function defaultMilestone(invoices: MilestoneInvoice[]) {
  return invoices.find((invoice) => invoice.status === "draft") || invoices[0] || null;
}

function namesOf(recipients: Recipient[]) {
  return recipients.map((entry) => entry.name || entry.email).join(", ");
}

/** The body for a template: the server's template with its values, then the signature. */
export function composeTemplateBody(template: { html: string }, context: Pick<EmailContext, "mergeValues" | "signature">) {
  const html = renderComposerTemplate(template, context.mergeValues).html;
  // A template that signs off itself (an owner-edited one) is not signed twice.
  if (/Regards,|Kind regards|Thanks,/i.test(html)) return html;
  return `${html}${renderSignature(context.signature?.html || null, context.mergeValues)}`;
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

  useEffect(() => {
    if (!id) return;
    api.recording(id, params.get("version") || undefined).then(setDetail).catch((err) => setLoadError(err instanceof Error ? err.message : "This job could not be loaded."));
    api.googleContacts().then((result) => setGoogleContacts(result.contacts)).catch(() => setGoogleContacts([]));
    api.jobDocuments(id)
      .then((result) => { setJobDocuments(result.documents); setNotIssued(result.notIssued || []); })
      .catch(() => { setJobDocuments(null); setNotIssued([]); });
  }, [id, params]);

  const refreshScheduled = useCallback(async () => {
    if (!id) return;
    try {
      setScheduledEmails((await api.scheduledEmails(id)).scheduledEmails);
    } catch {
      // Sending stays usable if the list cannot refresh.
    }
  }, [id]);
  useEffect(() => { void refreshScheduled(); }, [refreshScheduled]);

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

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.emailContext(id, { documentType, milestoneIndex: milestoneInvoice?.milestoneIndex ?? null, version })
      .then((next) => { if (!cancelled) setContext(next); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : "The composer could not load."); });
    return () => { cancelled = true; };
  }, [id, documentType, milestoneInvoice?.milestoneIndex, version]);

  // A new message: the job's contact, the first template and the signature.
  useEffect(() => {
    if (!context || initialised || draft) return;
    const template = context.templates[0];
    const contact = context.jobContacts.find((entry) => entry.source === "job");
    if (contact) setTo([{ email: contact.email, name: contact.name || null }]);
    if (template) {
      setTemplateId(template.id);
      setSubject(renderComposerTemplate(template, context.mergeValues).subject || context.defaultSubject);
      setBody(composeTemplateBody(template, context));
    } else {
      setSubject(context.defaultSubject);
      setBody(renderSignature(context.signature?.html || null, context.mergeValues));
    }
    setInitialised(true);
  }, [context, initialised, draft]);

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
  const previewKey = JSON.stringify({ subject, body, to: to.map((entry) => entry.email), cc: cc.map((entry) => entry.email), bcc: bcc.map((entry) => entry.email), docs: trayDocuments.map((entry) => entry.uid), uploads: uploads.map((file) => [file.name, file.size]), documentType, m: milestoneInvoice?.milestoneIndex ?? null, version });
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

  async function send(scheduledAt: string | null = null) {
    if (!canSend || !detail) return;
    setPhase("sending");
    setError("");
    try {
      const recipients = to.map((entry) => entry.email);
      const options = {
        cc: cc.map((entry) => entry.email),
        bcc: bcc.map((entry) => entry.email),
        attachments: uploads,
        scheduledAt,
        draftId: draft?.id || null,
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
      toast(result.scheduled && scheduledAt
        ? `${what} scheduled for ${scheduleLabel(new Date(scheduledAt))}`
        : `${what} sent to ${namesOf(to)}`);
      navigate(`/jobs/${id}`);
    } catch (err) {
      const code = (err as Error & { code?: unknown })?.code;
      setError(err instanceof Error ? err.message : "The email could not be sent.");
      setPhase(code === "gmail_auth_expired" ? "auth_expired" : "error");
    }
  }

  async function reconnectGmail() {
    try {
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const { url } = await api.gmailAuthUrl(`/jobs/${id}/email-editor${suffix}`);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gmail could not be reconnected.");
    }
  }

  function openDraft(item: ScheduledEmail) {
    setDraft(item);
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
  const title = documentType ? `Send ${label}${mainNumber && mainIssued ? ` ${mainNumber}` : ""}` : "Send email";
  const presets = schedulePresets();
  const sendMenu: MenuItem[] = [
    ...presets.map((preset) => ({ label: `${preset.label} · ${scheduleLabel(preset.at)}`, icon: <Clock3 aria-hidden />, onSelect: () => void send(preset.at.toISOString()) })),
    { label: "Pick date and time…", icon: <CalendarClock aria-hidden />, onSelect: () => setScheduleOpen(true) },
  ];
  const activity = scheduledEmails.filter((item) => item.status !== "sent" && item.status !== "cancelled");
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
      <div className="fx-composer__field">
        <label className="fx-rcpt__label" htmlFor="composer-subject">Subject</label>
        <input id="composer-subject" className="fx-composer__subject" value={subject} onChange={(event) => { setSubject(event.target.value); setTouched(true); }} placeholder="Subject" />
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
            { label: "Discard", icon: <Trash2 aria-hidden />, tone: "danger", onSelect: () => navigate(`/jobs/${id}`) },
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
            <span className="fx-mute fx-composer__ref">{jobRef(meta)}</span>
          </div>
        </div>
      </header>

      {draft ? (
        <div className="fx-notice"><span>Editing a draft. Sending or scheduling uses this draft, so no copy is left behind.</span></div>
      ) : null}
      {phase === "error" ? (
        <div className="fx-notice fx-notice--bad" role="alert"><AlertCircle aria-hidden /><span>Not sent. {error}</span></div>
      ) : null}
      {phase === "auth_expired" ? (
        <div className="fx-notice fx-notice--warn" role="alert">
          <AlertCircle aria-hidden />
          <span>Not sent. The Gmail sign-in for {context.from.email || "this account"} has expired. Reconnect Gmail, then send again.</span>
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
          {creditNoteNumber ? (
            <label className="fx-check fx-composer__check">
              <input type="checkbox" className="fx-checkbox" checked={attachCreditNote} onChange={(event) => setAttachCreditNote(event.target.checked)} />
              Also attach the adjustment note ({creditNoteNumber})
            </label>
          ) : null}
          <AttachmentTray
            main={mainAttachment}
            documents={trayDocuments}
            uploads={uploads}
            retainedNames={draft?.attachmentNames || []}
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
            <EmailActivityList items={activity} onEdit={(item) => (item.status === "draft" ? openDraft(item) : void unschedule(item, true))} onCancel={(item) => void unschedule(item, false)} />
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

const STATUS_TEXT: Record<string, string> = { draft: "Draft", pending: "Scheduled", sending: "Sending", failed: "Not sent" };

export function EmailActivityList({ items, onEdit, onCancel }: { items: ScheduledEmail[]; onEdit: (item: ScheduledEmail) => void; onCancel: (item: ScheduledEmail) => void }) {
  if (!items.length) return <p className="fx-mute fx-composer__empty">No scheduled emails or drafts on this job.</p>;
  return (
    <ul className="fx-composer__activity">
      {items.map((item) => (
        <li key={item.id}>
          <div className="fx-composer__activity-h">
            <span className={`fx-status fx-status--${item.status === "failed" ? "lost" : item.status === "draft" ? "draft" : "quoted"}`}>{STATUS_TEXT[item.status] || item.status}</span>
            {item.scheduledAt ? <span className="fx-mute">{scheduleLabel(new Date(item.scheduledAt))}</span> : null}
          </div>
          <strong>{item.subject || "(no subject)"}</strong>
          <span className="fx-mute">To {item.to.join(", ")}{(item.attachmentNames.length + (item.documents?.length || 0)) ? ` · ${item.attachmentNames.length + (item.documents?.length || 0) + 1} attachments` : ""}</span>
          {item.lastError ? <span className="fx-composer__activity-error">{item.lastError}</span> : null}
          <div className="fx-composer__activity-actions">
            {item.status === "pending" ? <button type="button" className="fx-btn fx-btn--sm" onClick={() => onCancel(item)}>Cancel send</button> : null}
            {item.status === "pending" || item.status === "draft" ? <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => onEdit(item)}>Edit</button> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
