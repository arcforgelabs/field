import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { createPortal } from "react-dom";
import { AlertCircle, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock3, FileText, History, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { api, type GoogleContact, type ScheduledEmail } from "@/lib/api";
import type { JobDocumentType, MilestoneInvoice, RecordingDetail } from "@/lib/types";
import { renderEmailTemplate } from "../../../../shared/email-templates.js";
import { suggestGoogleContacts } from "./contact-suggestions";
import { QuoteEmailEditor, type QuoteEmailTemplate } from "./components/quote-email-editor";

type SendPhase = "compose" | "sending" | "sent" | "scheduled" | "error" | "auth_expired";
type SendMode = "now" | "later";

function localDateTimeInputValue(value: Date) {
  const offset = value.getTimezoneOffset();
  return new Date(value.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function nextBusinessMorningLocal() {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  return localDateTimeInputValue(next);
}

function atLocalTime(date: Date, hours: number, minutes = 0) {
  const next = new Date(date);
  next.setHours(hours, minutes, 0, 0);
  return localDateTimeInputValue(next);
}

function nextMondayMorningLocal() {
  const next = new Date();
  const daysUntilMonday = ((8 - next.getDay()) % 7) || 7;
  next.setDate(next.getDate() + daysUntilMonday);
  return atLocalTime(next, 8);
}

function schedulePresets() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [
    { label: "Tomorrow morning", value: atLocalTime(tomorrow, 8) },
    { label: "Tomorrow afternoon", value: atLocalTime(tomorrow, 13) },
    { label: "Monday morning", value: nextMondayMorningLocal() },
  ];
}

function presetDateTimeLabel(value: string) {
  const date = scheduledLocalDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function selectedDateLabel(value: string) {
  const date = scheduledLocalDate(value);
  if (!date) return "Choose a date";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function scheduledLocalDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function scheduledTimeValue(value: string) {
  const date = scheduledLocalDate(value);
  if (!date) return "08:00";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function scheduleTimeLabel(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  return new Intl.DateTimeFormat("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(2000, 0, 1, hours, minutes)).toLowerCase();
}

function parseScheduleTimeInput(input: string) {
  const normalized = input.trim().toLowerCase().replaceAll(".", "").replace(/\s+/g, "");
  if (normalized === "noon") return "12:00";
  if (normalized === "midnight") return "00:00";

  const periodMatch = normalized.match(/(am|pm|a|p)$/);
  const period = periodMatch?.[1]?.startsWith("p") ? "pm" : periodMatch ? "am" : null;
  const numeric = periodMatch ? normalized.slice(0, -periodMatch[1].length) : normalized;
  let hoursText = numeric;
  let minutesText = "0";
  if (numeric.includes(":")) {
    const parts = numeric.split(":");
    if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1])) return null;
    [hoursText, minutesText] = parts;
  } else {
    if (!/^\d{1,4}$/.test(numeric)) return null;
    if (numeric.length === 3) {
      hoursText = numeric.slice(0, 1);
      minutesText = numeric.slice(1);
    } else if (numeric.length === 4) {
      hoursText = numeric.slice(0, 2);
      minutesText = numeric.slice(2);
    }
  }

  let hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (minutes > 59) return null;
  if (period) {
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (period === "pm") hours += 12;
  } else if (hours > 23) {
    return null;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

const fullDayTimeOptions = Array.from({ length: 96 }, (_, index) => {
  const hours = Math.floor(index / 4);
  const minutes = (index % 4) * 15;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
});

function scheduleSelectionLabel(value: string) {
  const date = scheduledLocalDate(value);
  if (!date) return "Choose a date and time";
  const weekday = new Intl.DateTimeFormat("en-AU", { weekday: "long" }).format(date);
  const calendarDate = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).toLowerCase();
  return `${weekday}, ${calendarDate} at ${time}`;
}

function withScheduledDate(value: string, selectedDate: Date) {
  const current = scheduledLocalDate(value);
  const next = new Date(selectedDate);
  next.setHours(current?.getHours() ?? 8, current?.getMinutes() ?? 0, 0, 0);
  return localDateTimeInputValue(next);
}

function withScheduledTime(value: string, time: string) {
  const current = scheduledLocalDate(value) || new Date();
  const [hours, minutes] = time.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  current.setHours(hours, minutes, 0, 0);
  return localDateTimeInputValue(current);
}

function startOfLocalDay(value: Date) {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);
  return start;
}

function ScheduleTimeCombobox({
  value,
  onChange,
  placement = "above",
}: {
  value: string;
  onChange: (value: string) => void;
  placement?: "above" | "below";
}) {
  const listboxId = useId();
  const listboxRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(() => scheduleTimeLabel(value));
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const matchedTime = parseScheduleTimeInput(draft) || value;

  useEffect(() => {
    if (!open) return;
    const listbox = listboxRef.current;
    const matchedOption = listbox?.querySelector<HTMLElement>(`[data-time="${matchedTime}"]`);
    if (!listbox || !matchedOption) return;
    listbox.scrollTop = Math.max(0, matchedOption.offsetTop - (listbox.clientHeight - matchedOption.offsetHeight) / 2);
  }, [matchedTime, open]);

  function accept(input: string) {
    const parsed = parseScheduleTimeInput(input);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(scheduleTimeLabel(parsed));
    onChange(parsed);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative", marginTop: 7 }}>
      <Clock3 size={16} style={{ position: "absolute", left: 12, top: 19, transform: "translateY(-50%)", color: "var(--t-dim)", pointerEvents: "none", zIndex: 1 }} />
      <input
        id="quote-email-scheduled-at"
        aria-label="Time"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-invalid={invalid}
        autoComplete="off"
        inputMode="text"
        placeholder="e.g. 8:30 am"
        value={draft}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
          setOpen(true);
        }}
        onBlur={() => {
          const parsed = parseScheduleTimeInput(draft);
          if (parsed) accept(draft);
          else {
            setInvalid(true);
            setOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            accept(draft);
          }
          if (event.key === "Escape") {
            setDraft(scheduleTimeLabel(value));
            setInvalid(false);
            setOpen(false);
          }
        }}
        style={{ ...inputStyle, paddingLeft: 38 }}
      />
      {open ? (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label="Suggested times"
          style={{ position: "absolute", ...(placement === "above" ? { bottom: "calc(100% + 5px)" } : { top: "calc(100% + 5px)" }), left: 0, right: 0, zIndex: 40, display: "grid", maxHeight: 190, overflowY: "scroll", overscrollBehavior: "contain", scrollbarGutter: "stable", padding: 5, border: "1px solid var(--t-brd)", borderRadius: "var(--t-radius)", background: "var(--t-bg)", boxShadow: "0 12px 30px rgba(0, 0, 0, 0.34)" }}
        >
          {fullDayTimeOptions.map((suggestion) => (
            <button
              key={suggestion}
              data-time={suggestion}
              type="button"
              role="option"
              aria-selected={suggestion === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(suggestion)}
              style={{ border: 0, borderRadius: "var(--t-radius)", background: suggestion === value ? "var(--t-accent-bg)" : "transparent", color: "var(--t-text)", padding: "8px 10px", textAlign: "left", font: "inherit", fontSize: 13, cursor: "pointer" }}
            >
              {scheduleTimeLabel(suggestion)}
            </button>
          ))}
        </div>
      ) : null}
      {invalid ? <div role="alert" style={{ marginTop: 6, color: "var(--t-danger)", fontSize: 11 }}>Enter a time like 8:30 am or 17:15.</div> : null}
    </div>
  );
}

export function QuoteEmailPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toEmails, setToEmails] = useState<string[]>([]);
  const [toDraft, setToDraft] = useState("");
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [ccDraft, setCcDraft] = useState("");
  const [bccEmails, setBccEmails] = useState<string[]>([]);
  const [bccDraft, setBccDraft] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("standard");
  const [storedTemplates, setStoredTemplates] = useState<Record<string, QuoteEmailTemplate[]> | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [automaticAttachmentBaseName, setAutomaticAttachmentBaseName] = useState("");
  const [phase, setPhase] = useState<SendPhase>("compose");
  const [sendMode, setSendMode] = useState<SendMode>("now");
  const [scheduledLocal, setScheduledLocal] = useState(nextBusinessMorningLocal);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  const [googleContacts, setGoogleContacts] = useState<GoogleContact[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [activeDraftDocumentType, setActiveDraftDocumentType] = useState<JobDocumentType | null>(null);
  const [activeDraftMilestoneIndex, setActiveDraftMilestoneIndex] = useState<number | null>(null);
  const [activeDraftQuoteVersion, setActiveDraftQuoteVersion] = useState<number | null>(null);
  const [activeDraftInvoicePaidAmount, setActiveDraftInvoicePaidAmount] = useState<number | null>(null);
  const [activeDraftAttachmentFilename, setActiveDraftAttachmentFilename] = useState<string | null>(null);
  const [retainedAttachmentNames, setRetainedAttachmentNames] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [themeFontFamily, setThemeFontFamily] = useState("Helvetica, Arial, sans-serif");

  useEffect(() => {
    const computed = getComputedStyle(document.documentElement).getPropertyValue("--t-body").trim();
    if (computed) setThemeFontFamily(computed);
  }, []);

  useEffect(() => {
    if (!id) return;
    api.recording(id, params.get("version") || undefined)
      .then((data) => {
        setDetail(data);
        setToEmails(parseEmailAddresses(data.meta.contactEmail || ""));
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load job");
      });
  }, [id, params]);

  useEffect(() => {
    api.emailTemplates()
      .then((result) => setStoredTemplates(result.templates))
      .catch(() => setStoredTemplates(null));
  }, []);

  useEffect(() => {
    api.googleContacts()
      .then((result) => setGoogleContacts(result.contacts))
      .catch(() => setGoogleContacts([]));
  }, []);

  async function refreshScheduledEmails() {
    if (!id) return;
    try {
      const result = await api.scheduledEmails(id);
      setScheduledEmails(result.scheduledEmails);
    } catch {
      // Sending must remain usable even if the status panel cannot refresh.
    }
  }

  useEffect(() => {
    void refreshScheduledEmails();
  }, [id]);

  const documentType = useMemo<JobDocumentType | null>(() => {
    if (activeDraftDocumentType) return activeDraftDocumentType;
    const explicit = params.get("documentType");
    if (explicit === "invoice" || explicit === "receipt" || explicit === "quote") return explicit;
    return null;
  }, [params, activeDraftDocumentType]);

  const milestoneInvoice = useMemo(() => {
    const invoices = detail?.meta.milestoneInvoices || [];
    if (!invoices.length) return null;
    const requestedIndex = activeDraftMilestoneIndex ?? params.get("milestoneIndex");
    if (requestedIndex != null) {
      const numericIndex = Number(requestedIndex);
      const match = invoices.find((invoice) => invoice.milestoneIndex === numericIndex);
      if (match) return match;
    }
    return selectDefaultMilestoneInvoice(invoices);
  }, [detail?.meta.milestoneInvoices, params, activeDraftMilestoneIndex]);

  const templates = useMemo(
    () => {
      if (!detail) return [];
      const context = {
        clientName: detail.meta.contactName || detail.meta.customerName || "",
        jobTitle: detail.meta.title || detail.meta.label || "",
        milestoneLabel: milestoneInvoice?.milestoneLabel || "",
        defaultSubject: buildDefaultSubject({ detail, documentType, milestoneInvoice }),
      };
      const configured = storedTemplates?.[documentType || "email"];
      if (configured?.length) {
        return configured.map((template) => renderEmailTemplate(template, context));
      }
      return buildEmailTemplates({
        clientName: context.clientName,
        jobTitle: context.jobTitle,
        documentType,
        milestoneInvoice,
      });
    },
    [detail, documentType, milestoneInvoice, storedTemplates],
  );

  useEffect(() => {
    if (!templates.length) return;
    if (activeDraftId) return;
    const current = templates.find((template) => template.id === selectedTemplateId) || templates[0];
    setSelectedTemplateId(current.id);
    setBodyHtml(current.html);
    setSubject(current.subject || buildDefaultSubject({
      detail,
      documentType,
      milestoneInvoice,
    }));
  }, [templates, activeDraftId]);

  const automaticAttachmentName = useMemo(
    () => detail ? buildAutomaticAttachmentFilename({ detail, documentType, milestoneInvoice }) : "",
    [detail, documentType, milestoneInvoice],
  );
  const automaticAttachmentDefaultBaseName = useMemo(
    () => stripPdfExtension(automaticAttachmentName),
    [automaticAttachmentName],
  );

  useEffect(() => {
    setAutomaticAttachmentBaseName("");
  }, [automaticAttachmentDefaultBaseName]);

  function handleTemplateSelect(templateId: string) {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setSelectedTemplateId(template.id);
    setBodyHtml(template.html);
    if (template.subject) setSubject(template.subject);
  }

  async function handleSend(mode: SendMode = sendMode) {
    if (!id || !detail || !subject.trim()) return;
    const recipients = mergeEmailAddresses(toEmails, parseEmailAddresses(toDraft));
    const ccRecipients = mergeEmailAddresses(ccEmails, parseEmailAddresses(ccDraft));
    const bccRecipients = mergeEmailAddresses(bccEmails, parseEmailAddresses(bccDraft));
    if (!recipients.length) return;
    setToEmails(recipients);
    setToDraft("");
    setCcEmails(ccRecipients);
    setCcDraft("");
    setBccEmails(bccRecipients);
    setBccDraft("");
    setPhase("sending");
    setErrorMsg("");
    try {
      const scheduledAt = mode === "later" ? new Date(scheduledLocal).toISOString() : null;
      const result = documentType
        ? await api.emailQuote(id, recipients, bodyHtml, {
          subject: subject.trim(),
          cc: ccRecipients,
          bcc: bccRecipients,
          documentType,
          milestoneIndex: documentType !== "quote" ? milestoneInvoice?.milestoneIndex ?? null : null,
          invoicePaidAmount: documentType === "invoice"
            ? activeDraftInvoicePaidAmount ?? milestoneInvoice?.amountPaid ?? detail.meta.invoicePaidAmount ?? 0
            : null,
          version: activeDraftQuoteVersion ? String(activeDraftQuoteVersion) : params.get("version") || null,
          themeFontFamily,
          attachmentFilename: activeDraftAttachmentFilename
            || buildPdfFilename(automaticAttachmentBaseName, automaticAttachmentDefaultBaseName),
          attachments,
          scheduledAt,
          draftId: activeDraftId,
        })
        : await api.emailJob(id, recipients, subject.trim(), bodyHtml, {
          cc: ccRecipients,
          bcc: bccRecipients,
          themeFontFamily,
          attachments,
          scheduledAt,
          draftId: activeDraftId,
        });
      if (result.scheduled) {
        await refreshScheduledEmails();
        setActiveDraftId(null);
        setActiveDraftDocumentType(null);
        setRetainedAttachmentNames([]);
        setPhase("scheduled");
      } else {
        await refreshScheduledEmails();
        setActiveDraftId(null);
        setActiveDraftDocumentType(null);
        setRetainedAttachmentNames([]);
        setPhase("sent");
      }
    } catch (err) {
      const isAuthExpired = (err as Error & { code?: unknown })?.code === "gmail_auth_expired";
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setPhase(isAuthExpired ? "auth_expired" : "error");
    }
  }

  function openDraft(item: ScheduledEmail) {
    setActiveDraftId(item.id);
    setActiveDraftDocumentType(
      item.documentType === "quote" || item.documentType === "invoice" || item.documentType === "receipt"
        ? item.documentType
        : null,
    );
    setActiveDraftMilestoneIndex(item.milestoneIndex ?? null);
    setActiveDraftQuoteVersion(item.quoteVersion ?? null);
    setActiveDraftInvoicePaidAmount(item.draftContent?.invoicePaidAmount ?? null);
    setActiveDraftAttachmentFilename(item.draftContent?.attachmentFilename ?? null);
    setToEmails(item.to);
    setToDraft("");
    setCcEmails(item.cc);
    setCcDraft("");
    setBccEmails(item.bcc || []);
    setBccDraft("");
    setShowCc(item.cc.length > 0);
    setShowBcc((item.bcc || []).length > 0);
    setSubject(item.subject || "");
    setBodyHtml(item.draftContent?.customBody || "");
    setRetainedAttachmentNames(item.attachmentNames || []);
    setAttachments([]);
    setThemeFontFamily(item.draftContent?.themeFontFamily || themeFontFamily);
    setSendMode("now");
    setPhase("compose");
    setErrorMsg("");
  }

  async function unschedule(item: ScheduledEmail, { edit = false } = {}) {
    if (!id) return;
    try {
      const result = await api.unscheduleEmail(id, item.id);
      await refreshScheduledEmails();
      if (edit) openDraft(result.scheduledEmail);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not cancel the schedule");
      setPhase("error");
      await refreshScheduledEmails();
    }
  }

  async function handleReauthorize() {
    if (!id) return;
    try {
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const { url } = await api.gmailAuthUrl(`/jobs/${id}/email-editor${suffix}`);
      window.location.href = url;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to start Gmail re-authorization");
      setPhase("error");
    }
  }

  if (loadError) {
    return <CenteredNotice title="Email editor unavailable" message={loadError} onBack={() => navigate(-1)} />;
  }

  if (!detail) {
    return <CenteredNotice title="Loading email editor" message="Preparing quote and client details..." />;
  }

  const documentLabel = documentType === "invoice" ? "Invoice" : documentType === "receipt" ? "Receipt" : documentType === "quote" ? "Quote" : "Email";
  const sendRecipients = mergeEmailAddresses(toEmails, parseEmailAddresses(toDraft));
  const canSend = sendRecipients.length > 0 && Boolean(subject.trim()) && phase !== "sending";

  if (phase === "sent") {
    const sentRecipients = toEmails.join(", ");
    return (
      <CenteredNotice
        title={`${documentLabel} sent`}
        message={`The email was sent to ${sentRecipients}.`}
        primaryLabel="Return to job"
        onBack={() => navigate(`/jobs/${detail.meta.id}`)}
      />
    );
  }

  if (phase === "scheduled") {
    const formatted = new Date(scheduledLocal).toLocaleString("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    return (
      <CenteredNotice
        title={`${documentLabel} scheduled`}
        message={`Field will send it at ${formatted}. You can cancel it from this email page before sending starts.`}
        primaryLabel="Return to job"
        onBack={() => navigate(`/jobs/${detail.meta.id}`)}
      />
    );
  }

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "var(--t-bg)",
        color: "var(--t-text)",
        fontFamily: "var(--t-body)",
      }}
    >
      <style>{`
        .quote-email-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(300px, 350px);
          gap: 18px;
        }
        .quote-email-topbar {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 14px;
        }
        .quote-email-recipient-actions {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .quote-email-address-chip button {
          opacity: .62;
          transition: opacity 120ms ease;
        }
        .quote-email-address-chip:hover button,
        .quote-email-address-chip:focus-within button {
          opacity: 1;
        }
        @media (max-width: 860px) {
          .quote-email-layout {
            grid-template-columns: minmax(0, 1fr);
          }
        }
        @media (max-width: 620px) {
          .quote-email-address-row {
            grid-template-columns: 58px minmax(0, 1fr);
          }
          .quote-email-schedule-dialog {
            max-height: calc(100dvh - 24px);
            overflow-y: auto !important;
          }
          .quote-email-schedule-dialog-grid {
            grid-template-columns: minmax(0, 1fr) !important;
          }
        }
      `}</style>
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          borderBottom: "1px solid var(--t-brd)",
          background: "color-mix(in srgb, var(--t-bg) 94%, transparent)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div
          className="quote-email-topbar"
          style={{
            maxWidth: 1260,
            margin: "0 auto",
            padding: "14px 18px",
          }}
        >
          <button type="button" onClick={() => navigate(`/jobs/${detail.meta.id}`)} style={iconButtonStyle} aria-label="Back to job">
            <ChevronLeft size={18} />
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: "var(--t-text)" }}>
              {documentType ? `Send ${documentLabel}` : "Send Email"}
            </div>
            <div style={{ fontSize: 12, color: "var(--t-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {detail.meta.title || detail.meta.label || detail.meta.siteAddress || detail.meta.id}
            </div>
          </div>
        </div>
      </div>

      <main
        className="quote-email-layout"
        style={{
          maxWidth: 1260,
          margin: "0 auto",
          padding: "22px 18px 34px",
        }}
      >
        <section style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <EmailHeaderFields
            contacts={googleContacts}
            to={{ addresses: toEmails, draft: toDraft, setDraft: setToDraft, setAddresses: setToEmails }}
            cc={{ addresses: ccEmails, draft: ccDraft, setDraft: setCcDraft, setAddresses: setCcEmails }}
            bcc={{ addresses: bccEmails, draft: bccDraft, setDraft: setBccDraft, setAddresses: setBccEmails }}
            showCc={showCc}
            showBcc={showBcc}
            onShowCc={() => setShowCc(true)}
            onShowBcc={() => setShowBcc(true)}
            onHideCc={() => setShowCc(false)}
            onHideBcc={() => setShowBcc(false)}
            subject={subject}
            onSubjectChange={setSubject}
          />

          {activeDraftId ? (
            <div style={{ ...panelStyle, borderColor: "var(--t-accent-brd)", background: "var(--t-accent-bg)" }}>
              <div style={{ fontWeight: 800, color: "var(--t-text)" }}>Editing draft</div>
              <div style={{ marginTop: 6, color: "var(--t-dim)", fontSize: 12, lineHeight: 1.5 }}>
                Its previous schedule has been cancelled. Sending or scheduling will reuse this draft rather than create a duplicate.
              </div>
              {retainedAttachmentNames.length ? (
                <div style={{ marginTop: 8, color: "var(--t-dim)", fontSize: 12 }}>
                  Retained attachments: {retainedAttachmentNames.join(", ")}
                </div>
              ) : null}
            </div>
          ) : null}

          <QuoteEmailEditor
            fullPage
            initialContent={bodyHtml}
            templates={templates}
            selectedTemplateId={selectedTemplateId}
            onTemplateSelect={handleTemplateSelect}
            onChange={setBodyHtml}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
          />

          <div className="quote-email-send-footer" style={{ display: "flex", alignItems: "flex-end", justifyContent: "flex-start", minHeight: 42, padding: "0 2px" }}>
            <SendControl
              canSend={canSend}
              phase={phase}
              mode={sendMode}
              scheduledLocal={scheduledLocal}
              onModeChange={setSendMode}
              onScheduledLocalChange={setScheduledLocal}
              onSend={(mode) => void handleSend(mode)}
            />
          </div>

          {phase === "error" ? (
            <StatusPanel tone="error" title="Send failed" message={errorMsg} />
          ) : null}
          {phase === "auth_expired" ? (
            <div style={{ ...panelStyle, borderColor: "var(--t-warn-brd)", background: "var(--t-warn-bg)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, color: "var(--t-text)" }}>
                <AlertCircle size={18} color="var(--t-warn)" />
                Gmail authorization expired
              </div>
              <div style={{ marginTop: 8, fontSize: 13, color: "var(--t-dim)", lineHeight: 1.6 }}>
                Re-authorize Gmail, then return here and send again. Local file attachments must be reselected after the browser redirect.
              </div>
              <button type="button" onClick={() => void handleReauthorize()} style={{ ...primaryButtonStyle, marginTop: 12 }}>
                Re-authorize Gmail
              </button>
            </div>
          ) : null}
        </section>

        <aside style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <AttachmentSummary
            documentType={documentType}
            automaticAttachmentBaseName={automaticAttachmentBaseName}
            automaticAttachmentDefaultBaseName={automaticAttachmentDefaultBaseName}
            onAutomaticAttachmentBaseNameChange={setAutomaticAttachmentBaseName}
            additionalAttachmentCount={attachments.length + retainedAttachmentNames.length}
          />

          {scheduledEmails.length ? (
            <EmailActivityPanel
              items={scheduledEmails}
              onEditDraft={openDraft}
              onEditScheduled={(item) => void unschedule(item, { edit: true })}
              onCancelSchedule={(item) => void unschedule(item)}
            />
          ) : null}
        </aside>
      </main>
    </div>
  );
}

type AddressState = {
  addresses: string[];
  draft: string;
  setDraft: (value: string) => void;
  setAddresses: (addresses: string[]) => void;
};

export function EmailHeaderFields({
  contacts = [],
  to,
  cc,
  bcc,
  showCc,
  showBcc,
  onShowCc,
  onShowBcc,
  onHideCc,
  onHideBcc,
  subject,
  onSubjectChange,
}: {
  contacts?: GoogleContact[];
  to: AddressState;
  cc: AddressState;
  bcc: AddressState;
  showCc: boolean;
  showBcc: boolean;
  onShowCc: () => void;
  onShowBcc: () => void;
  onHideCc: () => void;
  onHideBcc: () => void;
  subject: string;
  onSubjectChange: (value: string) => void;
}) {
  return (
    <div style={{ ...panelStyle, padding: "8px 14px" }}>
      <AddressRow
        label="To"
        placeholder="client@example.com"
        contacts={contacts}
        {...to}
        trailingActions={(
          <div className="quote-email-recipient-actions">
            {!showCc ? <RecipientToggle label="Cc" onClick={onShowCc} /> : null}
            {!showBcc ? <RecipientToggle label="Bcc" onClick={onShowBcc} /> : null}
          </div>
        )}
      />
      {showCc ? (
        <AddressRow
          label="Cc"
          placeholder="cc@example.com"
          contacts={contacts}
          {...cc}
          onEmpty={onHideCc}
        />
      ) : null}
      {showBcc ? (
        <AddressRow
          label="Bcc"
          placeholder="bcc@example.com"
          contacts={contacts}
          {...bcc}
          onEmpty={onHideBcc}
        />
      ) : null}
      <div
        className="quote-email-address-row"
        style={{
          minHeight: 54,
          display: "grid",
          gridTemplateColumns: "88px minmax(0, 1fr)",
          alignItems: "center",
          borderTop: "1px solid var(--t-brd)",
        }}
      >
        <label htmlFor="quote-email-subject" style={{ color: "var(--t-text)", fontSize: 13, fontWeight: 800 }}>
          Subject
        </label>
        <input
          id="quote-email-subject"
          type="text"
          value={subject}
          onChange={(event) => onSubjectChange(event.target.value)}
          placeholder="Email subject"
          style={addressInputStyle}
        />
      </div>
    </div>
  );
}

function RecipientToggle({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minWidth: 38,
        minHeight: 36,
        padding: "7px 8px",
        border: "none",
        borderRadius: "var(--t-radius)",
        background: "transparent",
        color: "var(--t-dim)",
        fontFamily: "var(--t-body)",
        fontSize: 13,
        fontWeight: 750,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function AddressRow({
  label,
  placeholder,
  contacts,
  addresses,
  draft,
  setDraft,
  setAddresses,
  onEmpty,
  trailingActions,
}: {
  label: string;
  placeholder: string;
  contacts: GoogleContact[];
  addresses: string[];
  draft: string;
  setDraft: (value: string) => void;
  setAddresses: (addresses: string[]) => void;
  onEmpty?: () => void;
  trailingActions?: ReactNode;
}) {
  const listboxId = useId();
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const suggestions = useMemo(
    () => suggestGoogleContacts(contacts, draft, addresses),
    [addresses, contacts, draft],
  );
  const showSuggestions = suggestionsOpen
    && suggestions.length > 0
    && (!addresses.length || Boolean(draft.trim()));

  function commitDraft(value = draft) {
    const next = parseEmailAddresses(value);
    if (!next.length) {
      setDraft("");
      if (!addresses.length) onEmpty?.();
      return;
    }
    setAddresses(mergeEmailAddresses(addresses, next));
    setDraft("");
    setSuggestionsOpen(false);
  }

  function selectContact(contact: GoogleContact) {
    setAddresses(mergeEmailAddresses(addresses, [contact.email]));
    setDraft("");
    setSuggestionsOpen(false);
  }

  function removeAddress(address: string) {
    const next = addresses.filter((item) => item !== address);
    setAddresses(next);
    if (!next.length && !draft) onEmpty?.();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && suggestions.length) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setHighlightedIndex((current) => Math.min(current + 1, suggestions.length - 1));
      return;
    }
    if (event.key === "ArrowUp" && showSuggestions) {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Escape" && showSuggestions) {
      event.preventDefault();
      setSuggestionsOpen(false);
      return;
    }
    if (["Enter", "Tab", ",", ";"].includes(event.key)) {
      if (event.key === "Enter" && showSuggestions) {
        event.preventDefault();
        selectContact(suggestions[highlightedIndex]);
        return;
      }
      if (draft.trim()) {
        event.preventDefault();
        commitDraft();
      }
      return;
    }
    if (event.key === "Backspace" && !draft && addresses.length) {
      const next = addresses.slice(0, -1);
      setAddresses(next);
      if (!next.length) onEmpty?.();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    const parsed = parseEmailAddresses(pasted);
    if (parsed.length <= 1) return;
    event.preventDefault();
    setAddresses(mergeEmailAddresses(addresses, parsed));
    setDraft("");
  }

  return (
    <div
      className="quote-email-address-row"
      style={{
        minHeight: 58,
        display: "grid",
        gridTemplateColumns: "88px minmax(0, 1fr) auto",
        alignItems: "center",
        borderTop: label === "To" ? "none" : "1px solid var(--t-brd)",
      }}
    >
      <label htmlFor={`quote-email-${label.toLowerCase()}`} style={{ color: "var(--t-text)", fontSize: 13, fontWeight: 800 }}>
        {label}
      </label>
      <div
        style={{
          position: "relative",
          minHeight: 44,
          width: "100%",
          padding: "5px 0",
          color: "var(--t-text)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 7,
        }}
      >
        {addresses.map((address) => (
          <span
            key={address}
            className="quote-email-address-chip"
            style={{
              maxWidth: "100%",
              minHeight: 28,
              borderRadius: "var(--t-radius)",
              border: "1px solid var(--t-accent-brd)",
              background: "var(--t-accent-bg)",
              color: "var(--t-text)",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "4px 5px 4px 9px",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{address}</span>
            <button
              type="button"
              aria-label={`Remove ${address}`}
              onClick={() => removeAddress(address)}
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: "none",
                background: "transparent",
                color: "var(--t-dim)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <X size={13} />
            </button>
          </span>
        ))}
        <input
          type="text"
          id={`quote-email-${label.toLowerCase()}`}
          value={draft}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={listboxId}
          onFocus={() => setSuggestionsOpen(true)}
          onChange={(event) => {
            setDraft(event.target.value);
            setSuggestionsOpen(true);
            setHighlightedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => {
            setSuggestionsOpen(false);
            commitDraft();
          }}
          placeholder={addresses.length ? "" : placeholder}
          style={{ ...addressInputStyle, flex: "1 1 180px", minWidth: 120, padding: "8px 4px" }}
        />
        {showSuggestions ? (
          <div
            id={listboxId}
            role="listbox"
            aria-label={`${label} Google Contacts suggestions`}
            style={{
              position: "absolute",
              top: "calc(100% + 5px)",
              left: 0,
              right: 0,
              zIndex: 40,
              maxHeight: 292,
              overflowY: "auto",
              border: "1px solid var(--t-brd)",
              borderRadius: "var(--t-radius)",
              background: "color-mix(in srgb, var(--t-bg) 94%, var(--t-text))",
              boxShadow: "0 18px 45px rgba(0, 0, 0, 0.48)",
              padding: 6,
            }}
          >
            <div style={{ padding: "5px 9px 7px", color: "var(--t-dim)", fontSize: 10, fontWeight: 850, letterSpacing: ".08em", textTransform: "uppercase" }}>
              Google Contacts
            </div>
            {suggestions.map((contact, index) => (
              <button
                key={contact.email}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectContact(contact)}
                style={{
                  width: "100%",
                  border: 0,
                  borderRadius: "var(--t-radius)",
                  background: index === highlightedIndex ? "var(--t-accent-bg)" : "transparent",
                  color: "var(--t-text)",
                  display: "grid",
                  gap: 3,
                  padding: "9px 10px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "var(--t-body)",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 800 }}>{contact.name}</span>
                {contact.name.toLowerCase() !== contact.email.toLowerCase() ? (
                  <span style={{ color: "var(--t-dim)", fontSize: 12 }}>{contact.email}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {trailingActions || null}
    </div>
  );
}

const addressInputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--t-text)",
  fontFamily: "var(--t-body)",
  fontSize: 15,
  padding: "10px 4px",
};

export function SendControl({
  canSend,
  phase,
  mode,
  scheduledLocal,
  onModeChange,
  onScheduledLocalChange,
  onSend,
}: {
  canSend: boolean;
  phase: SendPhase;
  mode: SendMode;
  scheduledLocal: string;
  onModeChange: (mode: SendMode) => void;
  onScheduledLocalChange: (value: string) => void;
  onSend: (mode: SendMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"options" | "schedule">("options");
  const rootRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const disabled = phase === "sending";
  const selectedScheduleDate = scheduledLocalDate(scheduledLocal);
  const selectedScheduleTime = scheduledTimeValue(scheduledLocal);
  const scheduleIsFuture = Boolean(selectedScheduleDate && selectedScheduleDate.getTime() > Date.now() + 30_000);
  const actionEnabled = canSend && (mode === "now" || scheduleIsFuture);
  const presets = useMemo(schedulePresets, [open]);

  function chooseSchedule(value: string) {
    onScheduledLocalChange(value);
    onModeChange("later");
    close({ restoreFocus: true });
  }

  function close({ restoreFocus = false } = {}) {
    setOpen(false);
    setView("options");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node) && !modalRef.current?.contains(event.target as Node)) close();
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") close({ restoreFocus: true });
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const scheduledLabel = mode === "later" && scheduledLocal ? formatScheduledLocal(scheduledLocal) : "";
  return (
    <div ref={rootRef} className="quote-email-send-control" style={{ position: "relative", display: "grid", justifyItems: "start", gap: 5 }}>
      {scheduledLabel ? (
        <button
          type="button"
          onClick={() => { setView("schedule"); setOpen(true); }}
          style={{ border: 0, background: "transparent", color: "var(--t-dim)", font: "inherit", fontSize: 11, cursor: "pointer", padding: 0 }}
        >
          {scheduledLabel}
        </button>
      ) : null}
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <button
          type="button"
          onClick={() => onSend(mode)}
          disabled={!actionEnabled}
          style={{
            ...primaryButtonStyle,
            width: 72,
            minWidth: 72,
            height: 36,
            minHeight: 36,
            padding: "0 16px",
            borderRadius: "18px 0 0 18px",
            justifyContent: "center",
            fontSize: 14,
            fontWeight: 500,
            opacity: actionEnabled ? 1 : 0.55,
            cursor: actionEnabled ? "pointer" : "not-allowed",
          }}
        >
          {phase === "sending" ? "Sending…" : "Send"}
        </button>
        <button
          ref={triggerRef}
          type="button"
          aria-label="Open send options"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setView("options"); setOpen((current) => !current); }}
          style={{
            width: 33,
            minWidth: 33,
            height: 36,
            minHeight: 36,
            border: "none",
            borderLeft: "1px solid color-mix(in srgb, #000 34%, transparent)",
            borderRadius: "0 18px 18px 0",
            background: "var(--t-accent)",
            color: "#17130a",
            display: "inline-grid",
            placeItems: "center",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.55 : 1,
          }}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && view === "options" ? createPortal(
        <div
          role="presentation"
          onPointerDown={(event) => { if (event.target === event.currentTarget) close({ restoreFocus: true }); }}
          style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", padding: 20, background: "rgba(0, 0, 0, 0.66)" }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Schedule send"
            className="quote-email-schedule-dialog"
            style={{ ...schedulePickerThemeStyle, width: "min(392px, calc(100vw - 32px))", border: "1px solid var(--t-brd)", borderRadius: "var(--t-radius)", background: "var(--t-bg)", boxShadow: "0 28px 90px rgba(0, 0, 0, 0.58)", color: "var(--t-text)", overflow: "hidden" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px 8px" }}>
              <div style={{ color: "var(--t-text)", fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Schedule send</div>
              <button type="button" aria-label="Close schedule options" onClick={() => close({ restoreFocus: true })} style={iconButtonStyle}><X size={18} /></button>
            </div>
            <div style={{ padding: "0 24px 14px", color: "var(--t-dim)", fontSize: 12 }}>
              {Intl.DateTimeFormat().resolvedOptions().timeZone || "This device’s timezone"}
            </div>
            <div style={{ borderTop: "1px solid var(--t-brd)", borderBottom: "1px solid var(--t-brd)" }}>
              {presets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  aria-label={`${preset.label}, ${presetDateTimeLabel(preset.value)}`}
                  onClick={() => chooseSchedule(preset.value)}
                  style={{ width: "100%", minHeight: 48, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: 16, padding: "11px 24px", border: 0, borderTop: preset === presets[0] ? 0 : "1px solid color-mix(in srgb, var(--t-brd) 62%, transparent)", background: "transparent", color: "var(--t-text)", font: "inherit", fontSize: 13, textAlign: "left", cursor: "pointer" }}
                >
                  <span>{preset.label}</span>
                  <span style={{ color: "var(--t-dim)", fontVariantNumeric: "tabular-nums" }}>{presetDateTimeLabel(preset.value)}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setView("schedule")}
              style={{ width: "100%", minHeight: 52, display: "flex", alignItems: "center", gap: 12, padding: "13px 24px", border: 0, background: "transparent", color: "var(--t-text)", font: "inherit", fontSize: 13, textAlign: "left", cursor: "pointer" }}
            >
              <CalendarDays size={17} style={{ color: "var(--t-dim)" }} />
              Select date and time
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
      {open && view === "schedule" ? createPortal(
        <div
          role="presentation"
          onPointerDown={(event) => { if (event.target === event.currentTarget) close({ restoreFocus: true }); }}
          style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", padding: 20, background: "rgba(0, 0, 0, 0.66)" }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Select date and time"
            className="quote-email-schedule-dialog"
            style={{ ...schedulePickerThemeStyle, width: "min(552px, calc(100vw - 32px))", minHeight: 448, border: "1px solid var(--t-brd)", borderRadius: "var(--t-radius)", background: "var(--t-bg)", boxShadow: "0 28px 90px rgba(0, 0, 0, 0.58)", color: "var(--t-text)", overflow: "visible" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px 8px" }}>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Select date and time</div>
              <button type="button" aria-label="Close date and time picker" onClick={() => close({ restoreFocus: true })} style={iconButtonStyle}><X size={18} /></button>
            </div>
            <div className="quote-email-schedule-dialog-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(220px, 0.9fr)", gap: 16, padding: "10px 24px 8px" }}>
              <div role="group" aria-label="Schedule date" style={{ minWidth: 0 }}>
                <Calendar
                  mode="single"
                  selected={selectedScheduleDate}
                  defaultMonth={selectedScheduleDate}
                  disabled={{ before: startOfLocalDay(new Date()) }}
                  onSelect={(date) => { if (date) onScheduledLocalChange(withScheduledDate(scheduledLocal, date)); }}
                  className="quote-email-schedule-calendar w-full bg-transparent p-0"
                  classNames={{ root: "w-full", month: "flex w-full flex-col gap-2", month_grid: "w-full", week: "mt-1 flex w-full" }}
                />
              </div>
              <div style={{ display: "grid", alignContent: "start", gap: 14, paddingTop: 3 }}>
                <div>
                  <div style={fieldLabelStyle}>Date</div>
                  <div style={{ ...inputStyle, display: "flex", alignItems: "center", minHeight: 40, marginTop: 7, fontVariantNumeric: "tabular-nums" }}>{selectedDateLabel(scheduledLocal)}</div>
                </div>
                <div>
                  <label htmlFor="quote-email-scheduled-at" style={fieldLabelStyle}>Time</label>
                  <ScheduleTimeCombobox
                    value={selectedScheduleTime}
                    placement="below"
                    onChange={(time) => onScheduledLocalChange(withScheduledTime(scheduledLocal, time))}
                  />
                </div>
                {!scheduleIsFuture ? <div role="alert" style={{ color: "var(--t-danger)", fontSize: 11 }}>Choose a time in the future.</div> : null}
                <div aria-live="polite" style={{ color: "var(--t-dim)", fontSize: 12, lineHeight: 1.45 }}>
                  Email will be ready to schedule for <span style={{ color: "var(--t-text)", fontWeight: 750 }}>{scheduleSelectionLabel(scheduledLocal)}</span>.
                </div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, padding: "8px 24px 20px" }}>
              <Button type="button" variant="ghost" size="lg" onClick={() => close({ restoreFocus: true })} className="h-10 rounded-full border border-[var(--t-brd)] bg-transparent px-5 text-[var(--t-text)] hover:bg-[var(--t-s1)]">Cancel</Button>
              <Button type="button" variant="accent" size="lg" disabled={!scheduleIsFuture} onClick={() => chooseSchedule(scheduledLocal)} className="h-10 rounded-full px-5">Use this schedule</Button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function formatScheduledLocal(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Review scheduled time";
  return date.toLocaleString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AttachmentSummary({
  documentType,
  automaticAttachmentBaseName,
  automaticAttachmentDefaultBaseName,
  onAutomaticAttachmentBaseNameChange,
  additionalAttachmentCount,
}: {
  documentType: JobDocumentType | null;
  automaticAttachmentBaseName: string;
  automaticAttachmentDefaultBaseName: string;
  onAutomaticAttachmentBaseNameChange: (value: string) => void;
  additionalAttachmentCount: number;
}) {
  const [editing, setEditing] = useState(false);
  const automaticName = buildPdfFilename(automaticAttachmentBaseName, automaticAttachmentDefaultBaseName);

  return (
    <div style={{ ...panelStyle, padding: 14 }}>
      <div style={asideTitleStyle}>
        <Paperclip size={15} />
        Automatic attachment
      </div>
      {documentType ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "32px minmax(0, 1fr) auto", alignItems: "center", gap: 10, marginTop: 12 }}>
            <span style={{ width: 32, height: 32, borderRadius: "var(--t-radius)", display: "grid", placeItems: "center", background: "var(--t-bg)", color: "var(--t-dim)" }}>
              <FileText size={16} />
            </span>
            <span style={{ minWidth: 0 }}>
              <span title={automaticName} style={{ display: "block", color: "var(--t-text)", fontSize: 13, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {automaticName}
              </span>
              <span style={{ display: "block", marginTop: 2, color: "var(--t-dim)", fontSize: 11 }}>Automatic PDF</span>
            </span>
            <button type="button" onClick={() => setEditing((current) => !current)} style={{ ...quietButtonStyle, padding: "7px 9px" }}>
              {editing ? "Done" : "Rename"}
            </button>
          </div>
          {editing ? (
            <FilenameField
              value={automaticAttachmentBaseName}
              fallbackValue={automaticAttachmentDefaultBaseName}
              onChange={onAutomaticAttachmentBaseNameChange}
            />
          ) : null}
        </>
      ) : (
        <div style={{ marginTop: 10, color: "var(--t-dim)", fontSize: 13 }}>No automatic attachment</div>
      )}
      {additionalAttachmentCount ? (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--t-brd)", color: "var(--t-dim)", fontSize: 12 }}>
          {additionalAttachmentCount} additional {additionalAttachmentCount === 1 ? "file" : "files"} attached in the editor
        </div>
      ) : null}
    </div>
  );
}

export function EmailActivityPanel({
  items,
  onEditDraft,
  onEditScheduled,
  onCancelSchedule,
}: {
  items: ScheduledEmail[];
  onEditDraft: (item: ScheduledEmail) => void;
  onEditScheduled: (item: ScheduledEmail) => void;
  onCancelSchedule: (item: ScheduledEmail) => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [previewItem, setPreviewItem] = useState<ScheduledEmail | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const actionable = items.filter((item) => ["draft", "pending", "sending", "failed"].includes(item.status));
  const history = items.filter((item) => !["draft", "pending", "sending", "failed"].includes(item.status));

  useEffect(() => {
    if (!drawerOpen) return;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!previewItem) return;
    previewCloseRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setPreviewItem(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [previewItem]);

  function openPreview(item: ScheduledEmail) {
    setDrawerOpen(false);
    setPreviewItem(item);
  }

  return (
    <>
      <div style={{ ...panelStyle, padding: 14 }}>
        <div style={{ ...asideTitleStyle, paddingBottom: 11, borderBottom: "1px solid var(--t-brd)" }}>
          <History size={15} />
          Email activity
          <span style={{ marginLeft: 2, minWidth: 23, padding: "2px 7px", borderRadius: "var(--t-radius)", background: "var(--t-bg)", color: "var(--t-text)", textAlign: "center", fontSize: 11, letterSpacing: 0 }}>
            {items.length}
          </span>
        </div>
        {actionable.length ? (
          <section style={{ marginTop: 12 }}>
            <div style={activitySectionLabelStyle}>Actionable</div>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {actionable.slice(0, 3).map((item) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  onPreview={openPreview}
                  onEditDraft={onEditDraft}
                  onEditScheduled={onEditScheduled}
                />
              ))}
            </div>
          </section>
        ) : null}
        {history.length ? (
          <section style={{ marginTop: 13 }}>
            <div style={activitySectionLabelStyle}>History</div>
            <button type="button" onClick={() => setDrawerOpen(true)} style={historySummaryButtonStyle}>
              <span style={{ minWidth: 0, textAlign: "left" }}>
                <span style={{ display: "block", color: "var(--t-text)", fontSize: 12, fontWeight: 750 }}>{history.length} previous {history.length === 1 ? "email" : "emails"}</span>
                <span style={{ display: "block", marginTop: 4, color: "var(--t-dim)", fontSize: 11 }}>{latestActivityLabel(history)}</span>
              </span>
              <ChevronRight size={17} />
            </button>
          </section>
        ) : null}
        {history.length ? (
          <button type="button" onClick={() => setDrawerOpen(true)} style={{ ...quietButtonStyle, width: "100%", marginTop: 10, justifyContent: "center" }}>
            View all activity
          </button>
        ) : null}
      </div>

      {drawerOpen ? (
        <div
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}
          style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", justifyContent: "flex-end", background: "rgba(0, 0, 0, 0.72)" }}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Email activity"
            style={{ width: "min(430px, 100vw)", height: "100%", background: "var(--t-bg)", borderLeft: "1px solid var(--t-brd)", boxShadow: "-18px 0 60px rgba(0, 0, 0, 0.6)", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}
          >
            <div style={{ minHeight: 68, padding: "14px 16px", borderBottom: "1px solid var(--t-brd)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
              <div>
                <div style={{ color: "var(--t-text)", fontSize: 16, fontWeight: 850 }}>Email activity</div>
                <div style={{ marginTop: 3, color: "var(--t-dim)", fontSize: 12 }}>{items.length} recorded {items.length === 1 ? "email" : "emails"}</div>
              </div>
              <button ref={closeRef} type="button" aria-label="Close email activity" onClick={() => setDrawerOpen(false)} style={iconButtonStyle}><X size={17} /></button>
            </div>
            <div style={{ overflowY: "auto", padding: 16 }}>
              <div style={{ display: "grid", gap: 10 }}>
                {items.map((item) => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    detailed
                    onPreview={openPreview}
                    onEditDraft={onEditDraft}
                    onEditScheduled={onEditScheduled}
                  />
                ))}
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {previewItem?.status === "pending" ? (
        <ScheduledEmailPreview
          item={previewItem}
          closeRef={previewCloseRef}
          onClose={() => setPreviewItem(null)}
          onEdit={() => {
            setPreviewItem(null);
            onEditScheduled(previewItem);
          }}
          onCancelSend={() => {
            setPreviewItem(null);
            onCancelSchedule(previewItem);
          }}
        />
      ) : null}
    </>
  );
}

function ActivityRow({
  item,
  detailed = false,
  onPreview,
  onEditDraft,
  onEditScheduled,
}: {
  item: ScheduledEmail;
  detailed?: boolean;
  onPreview: (item: ScheduledEmail) => void;
  onEditDraft: (item: ScheduledEmail) => void;
  onEditScheduled: (item: ScheduledEmail) => void;
}) {
  const status = activityStatus(item);
  const isScheduled = item.status === "pending";
  const isDraft = item.status === "draft";
  return (
    <article style={{ border: "1px solid var(--t-brd)", borderRadius: "var(--t-radius)", background: "color-mix(in srgb, var(--t-bg) 94%, var(--t-text))", padding: 11 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ color: status.color, fontSize: 13, fontWeight: 850 }}>{status.label}</span>
            {item.attemptCount > 1 ? <span style={{ color: "var(--t-dim)", fontSize: 10 }}>Attempt {item.attemptCount}</span> : null}
          </div>
          <div title={item.to.join(", ")} style={{ marginTop: 5, color: "var(--t-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.to.join(", ") || "No recipient"}
          </div>
        </div>
        <span style={{ flex: "0 0 auto", color: "var(--t-dim)", fontSize: 10, textAlign: "right" }}>{activityTimeLabel(item)}</span>
      </div>
      {detailed && item.subject ? <div style={{ marginTop: 9, color: "var(--t-text)", fontSize: 12, fontWeight: 750 }}>{item.subject}</div> : null}
      {item.lastError ? <div style={{ marginTop: 8, color: "var(--t-danger)", fontSize: 11, lineHeight: 1.45 }}>{item.lastError}</div> : null}
      {isScheduled || isDraft || item.status === "failed" ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 7, marginTop: 10 }}>
          {isScheduled ? <button type="button" onClick={() => onPreview(item)} style={quietButtonStyle}>Preview</button> : null}
          <button type="button" onClick={() => isScheduled ? onEditScheduled(item) : onEditDraft(item)} style={quietButtonStyle}>
            {isDraft || item.status === "failed" ? "Edit draft" : "Edit"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function ScheduledEmailPreview({
  item,
  closeRef,
  onClose,
  onEdit,
  onCancelSend,
}: {
  item: ScheduledEmail;
  closeRef: { current: HTMLButtonElement | null };
  onClose: () => void;
  onEdit: () => void;
  onCancelSend: () => void;
}) {
  const previewText = emailBodyPreviewText(item.previewBodyHtml || "");
  return (
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 70, display: "grid", placeItems: "center", padding: 20, background: "rgba(0, 0, 0, 0.72)" }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Scheduled email preview"
        style={{ width: "min(720px, calc(100vw - 32px))", maxHeight: "min(760px, calc(100dvh - 32px))", border: "1px solid var(--t-brd)", borderRadius: "var(--t-radius)", background: "var(--t-bg)", boxShadow: "0 28px 90px rgba(0, 0, 0, 0.62)", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", overflow: "hidden" }}
      >
        <header style={{ minHeight: 66, padding: "13px 16px 13px 20px", borderBottom: "1px solid var(--t-brd)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
          <div>
            <div style={{ color: "var(--t-text)", fontSize: 16, fontWeight: 850 }}>Scheduled email</div>
            <div style={{ marginTop: 3, color: "var(--t-dim)", fontSize: 11 }}>Read-only preview</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" onClick={onEdit} style={quietButtonStyle}>Edit</button>
            <button ref={closeRef} type="button" aria-label="Close scheduled email preview" onClick={onClose} style={iconButtonStyle}><X size={17} /></button>
          </div>
        </header>
        <div style={{ minHeight: 0, overflowY: "auto", padding: "20px clamp(16px, 4vw, 32px) 28px" }}>
          <h2 style={{ margin: 0, color: "var(--t-text)", fontSize: 20, fontWeight: 800, lineHeight: 1.3 }}>{item.subject || "(No subject)"}</h2>
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "42px minmax(0, 1fr)", gap: "5px 10px", color: "var(--t-dim)", fontSize: 12, lineHeight: 1.5 }}>
            <span>To</span><span style={{ color: "var(--t-text)", overflowWrap: "anywhere" }}>{item.to.join(", ") || "No recipient"}</span>
            {item.cc.length ? <><span>Cc</span><span style={{ color: "var(--t-text)", overflowWrap: "anywhere" }}>{item.cc.join(", ")}</span></> : null}
            {item.bcc.length ? <><span>Bcc</span><span style={{ color: "var(--t-text)", overflowWrap: "anywhere" }}>{item.bcc.join(", ")}</span></> : null}
          </div>

          <div style={{ marginTop: 18, minHeight: 42, padding: "9px 12px", border: "1px solid var(--t-accent-brd)", borderRadius: "var(--t-radius)", background: "var(--t-accent-bg)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 9, color: "var(--t-text)", fontSize: 12, lineHeight: 1.4 }}>
              <Clock3 size={15} style={{ flex: "0 0 auto", color: "var(--t-accent)" }} />
              <span>{scheduledPreviewLabel(item.scheduledAt)}</span>
            </span>
            <button type="button" onClick={onCancelSend} style={{ border: 0, background: "transparent", color: "var(--t-accent)", font: "inherit", fontSize: 12, fontWeight: 800, textDecoration: "underline", textUnderlineOffset: 2, whiteSpace: "nowrap", cursor: "pointer", padding: "4px 0" }}>
              Cancel send
            </button>
          </div>

          <div style={{ minHeight: 180, marginTop: 22, color: "var(--t-text)", fontFamily: item.previewThemeFontFamily || "var(--t-body)", fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {previewText || <span style={{ color: "var(--t-dim)", fontStyle: "italic" }}>No message body</span>}
          </div>

          {item.attachmentNames.length ? (
            <div style={{ marginTop: 22, paddingTop: 14, borderTop: "1px solid var(--t-brd)" }}>
              <div style={{ ...activitySectionLabelStyle, display: "flex", alignItems: "center", gap: 7 }}><Paperclip size={13} /> Attachments</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                {item.attachmentNames.map((name) => (
                  <span key={name} style={{ maxWidth: "100%", padding: "7px 10px", border: "1px solid var(--t-brd)", borderRadius: "var(--t-radius)", background: "var(--t-s1)", color: "var(--t-text)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function scheduledPreviewLabel(value: string | null) {
  if (!value) return "Scheduled send time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Scheduled send time unavailable";
  return `Send scheduled for ${date.toLocaleString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function emailBodyPreviewText(html: string) {
  if (!html.trim()) return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("br").forEach((element) => element.replaceWith("\n"));
  parsed.querySelectorAll("p, li, div").forEach((element) => element.append("\n"));
  return (parsed.body.textContent || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function activityStatus(item: ScheduledEmail) {
  if (item.status === "pending") return { label: "Scheduled", color: "var(--t-accent)" };
  if (item.status === "sending") return { label: "Sending", color: "var(--t-accent)" };
  if (item.status === "sent") return { label: "Sent", color: "var(--t-success)" };
  if (item.status === "failed") return { label: "Needs attention", color: "var(--t-danger)" };
  if (item.status === "cancelled") return { label: "Cancelled", color: "var(--t-dim)" };
  return { label: "Draft", color: "var(--t-text)" };
}

function activityTimeLabel(item: ScheduledEmail) {
  if (item.status === "draft") return "Not scheduled";
  const value = item.sentAt || item.cancelledAt || item.failedAt || item.scheduledAt || item.updatedAt;
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function latestActivityLabel(items: ScheduledEmail[]) {
  const timestamps = items
    .map((item) => Date.parse(item.sentAt || item.cancelledAt || item.failedAt || item.updatedAt || item.createdAt))
    .filter(Number.isFinite);
  if (!timestamps.length) return "History available";
  return `Latest ${new Date(Math.max(...timestamps)).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`;
}

function FilenameField({
  value,
  fallbackValue,
  onChange,
}: {
  value: string;
  fallbackValue: string;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const fullName = buildPdfFilename(value, fallbackValue);
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ ...fieldLabelStyle, marginBottom: 7 }}>File Name</label>
      <div
        title={fullName}
        style={{
          minHeight: 46,
          width: "100%",
          borderRadius: "var(--t-radius)",
          border: focused ? "1px solid var(--t-accent)" : "1px solid var(--t-brd)",
          background: "var(--t-bg)",
          color: "var(--t-text)",
          display: "flex",
          alignItems: "center",
          overflow: "hidden",
          boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--t-accent) 16%, transparent)" : "none",
        }}
      >
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(sanitizeAttachmentBaseName(event.target.value))}
          placeholder={fallbackValue}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-label="Automatic attachment file name"
          style={{
            minWidth: 0,
            flex: "1 1 auto",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--t-text)",
            fontFamily: "var(--t-body)",
            fontSize: 14,
            fontWeight: 750,
            padding: "12px 0 12px 12px",
          }}
        />
        <span
          aria-hidden="true"
          style={{
            flex: "0 0 auto",
            color: "var(--t-dim)",
            fontFamily: "var(--t-data)",
            fontSize: 13,
            fontWeight: 800,
            padding: "12px 12px 12px 6px",
          }}
        >
          .pdf
        </span>
      </div>
      <div
        title={fullName}
        style={{
          marginTop: 8,
          borderRadius: "var(--t-radius)",
          background: "color-mix(in srgb, var(--t-s1) 65%, var(--t-bg))",
          border: "1px solid color-mix(in srgb, var(--t-brd) 70%, transparent)",
          color: "var(--t-dim)",
          fontSize: 12,
          lineHeight: 1.45,
          padding: "8px 10px",
          overflowWrap: "anywhere",
        }}
      >
        {fullName}
      </div>
    </div>
  );
}

function buildEmailTemplates({
  clientName,
  jobTitle,
  documentType,
  milestoneInvoice,
}: {
  clientName: string;
  jobTitle: string;
  documentType: JobDocumentType | null;
  milestoneInvoice: MilestoneInvoice | null;
}): QuoteEmailTemplate[] {
  const greeting = clientName ? `Hi ${escapeText(clientName)},` : "Hi,";
  const escapedJobTitle = escapeText(jobTitle);
  if (!documentType) {
    return [
      {
        id: "standard",
        name: "Standard email",
        description: "General job email.",
        html: `<p>${greeting}</p><p>I wanted to send through an update${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""}.</p><p>Regards,<br/>Your Business</p>`,
      },
      {
        id: "follow-up",
        name: "Follow-up",
        description: "Quick follow-up message.",
        html: `<p>${greeting}</p><p>Just following up${escapedJobTitle ? ` on <strong>${escapedJobTitle}</strong>` : ""}.</p><p>Let me know if you have any questions.</p><p>Regards,<br/>Your Business</p>`,
      },
      {
        id: "site-note",
        name: "Site note",
        description: "Site or scheduling note.",
        html: `<p>${greeting}</p><p>I have a quick site note${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""}:</p><p></p><p>Regards,<br/>Your Business</p>`,
      },
    ];
  }
  if (documentType === "invoice") {
    const milestone = milestoneInvoice?.milestoneLabel ? `${escapeText(milestoneInvoice.milestoneLabel.toLowerCase())} ` : "";
    return [
      {
        id: "standard",
        name: "Standard invoice",
        description: "Short invoice delivery note.",
        html: `<p>${greeting}</p><p>Your ${milestone}invoice${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""} is ready. The invoice PDF is attached.</p><p>Reply to this email if you have any questions about this invoice.</p><p>Regards,<br/>Your Business</p>`,
      },
      {
        id: "payment",
        name: "Payment prompt",
        description: "Adds a clear payment request.",
        html: `<p>${greeting}</p><p>Please find your ${milestone}invoice${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""} attached.</p><p>When payment is made, reply with the reference and I will mark it off against the job.</p><p>Regards,<br/>Your Business</p>`,
      },
      {
        id: "friendly",
        name: "Friendly check-in",
        description: "Softer wording for known clients.",
        html: `<p>${greeting}</p><p>I have attached the ${milestone}invoice${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""}.</p><p>Let me know if you need anything clarified.</p><p>Regards,<br/>Your Business</p>`,
      },
    ];
  }
  if (documentType === "receipt") {
    const milestone = milestoneInvoice?.milestoneLabel ? `${escapeText(milestoneInvoice.milestoneLabel.toLowerCase())} ` : "";
    return [
      {
        id: "standard",
        name: "Standard receipt",
        description: "Short receipt delivery note.",
        html: `<p>${greeting}</p><p>Your ${milestone}receipt${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""} is ready. The receipt PDF is attached.</p><p>Reply to this email if you need another copy.</p><p>Regards,<br/>Your Business</p>`,
      },
      {
        id: "thanks",
        name: "Thank you",
        description: "Receipt with a thank-you note.",
        html: `<p>${greeting}</p><p>Thanks for the payment. I have attached the ${milestone}receipt${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""}.</p><p>Regards,<br/>Your Business</p>`,
      },
      {
        id: "records",
        name: "For records",
        description: "Simple records copy.",
        html: `<p>${greeting}</p><p>Please find the ${milestone}receipt attached for your records.</p><p>Regards,<br/>Your Business</p>`,
      },
    ];
  }
  return [
    {
      id: "standard",
      name: "Standard quote",
      description: "Default quote delivery.",
      html: `<p>${greeting}</p><p>Your quote${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""} is ready. The full quote is attached as a PDF.</p><p>Reply to this email if you'd like any adjustments or have questions.</p><p>Regards,<br/>Your Business</p>`,
    },
    {
      id: "approval",
      name: "Ready for approval",
      description: "Asks the client to approve or request changes.",
      html: `<p>${greeting}</p><p>I have attached the quote${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""} for review.</p><p>If everything looks right, reply with approval and we can line up the next step. If anything needs changing, send through the adjustment and I will update it.</p><p>Regards,<br/>Your Business</p>`,
    },
    {
      id: "warm",
      name: "Warm follow-up",
      description: "More conversational tone.",
      html: `<p>${greeting}</p><p>Thanks again for the details. The quote${escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : ""} is attached.</p><p>I have kept the main scope and pricing in the PDF so it is easy to review. Let me know what you would like changed or confirmed.</p><p>Regards,<br/>Your Business</p>`,
    },
  ];
}

function buildDefaultSubject({
  detail,
  documentType,
  milestoneInvoice,
}: {
  detail: RecordingDetail | null;
  documentType: JobDocumentType | null;
  milestoneInvoice: MilestoneInvoice | null;
}) {
  const title = detail?.meta.title || detail?.meta.label || detail?.meta.siteAddress || "Your Business";
  if (documentType === "invoice") {
    return ["Invoice", milestoneInvoice?.invoiceNumber, milestoneInvoice?.milestoneLabel || title].filter(Boolean).join(" - ");
  }
  if (documentType === "receipt") {
    return ["Receipt", milestoneInvoice?.receiptNumber || milestoneInvoice?.invoiceNumber, milestoneInvoice?.milestoneLabel || title].filter(Boolean).join(" - ");
  }
  if (documentType === "quote") {
    return `Quote - ${title}`;
  }
  return `Job update - ${title}`;
}

function buildAutomaticAttachmentFilename({
  detail,
  documentType,
  milestoneInvoice,
}: {
  detail: RecordingDetail;
  documentType: JobDocumentType | null;
  milestoneInvoice: MilestoneInvoice | null;
}) {
  if (!documentType) return "No automatic attachment";
  const resolvedMilestoneInvoice = milestoneInvoice || detail.meta.milestoneInvoice || null;
  const documentNumber = documentType === "invoice"
    ? resolvedMilestoneInvoice?.invoiceNumber
    : documentType === "receipt"
      ? resolvedMilestoneInvoice?.receiptNumber || resolvedMilestoneInvoice?.invoiceNumber
      : detail.quote?.quoteNumber || detail.meta.quoteNumber || "";
  const clientName = detail.meta.contactName || detail.meta.title?.split("—")[0]?.trim() || "";
  const scope = (detail.quote?.summary || "").split("\n")[0].replace(/[^\w\s,&-]/g, "").trim().slice(0, 80);
  const label = documentType === "invoice" ? "Invoice" : documentType === "receipt" ? "Receipt" : "Quote";
  const parts = [documentNumber, clientName, scope].filter(Boolean);
  if (!parts.length) return `${label.toLowerCase()}.pdf`;
  return `${parts.join(" — ").replace(/[/\\:*?"<>|]+/g, "-")} — ${label}.pdf`;
}

function stripPdfExtension(value: string) {
  return String(value || "").replace(/\.pdf$/i, "").trim();
}

function sanitizeAttachmentBaseName(value: string) {
  return stripPdfExtension(value)
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trimStart()
    .slice(0, 160);
}

function buildPdfFilename(baseName: string, fallbackBaseName: string) {
  const cleanedBaseName = sanitizeAttachmentBaseName(baseName || fallbackBaseName).trim();
  return `${cleanedBaseName || "attachment"}.pdf`;
}

function selectDefaultMilestoneInvoice(invoices: MilestoneInvoice[]) {
  return invoices.find((invoice) => invoice.status === "draft")
    || invoices.find((invoice) => invoice.status === "authorised")
    || invoices[0]
    || null;
}

function StatusPanel({ tone, title, message }: { tone: "success" | "error"; title: string; message: string }) {
  const isSuccess = tone === "success";
  return (
    <div
      style={{
        ...panelStyle,
        borderColor: isSuccess ? "var(--t-success)" : "var(--t-danger)",
        background: isSuccess ? "var(--t-success-bg)" : "var(--t-danger-bg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800 }}>
        {isSuccess ? <CheckCircle2 size={18} color="var(--t-success)" /> : <AlertCircle size={18} color="var(--t-danger)" />}
        {title}
      </div>
      <div style={{ marginTop: 6, color: "var(--t-dim)", fontSize: 13 }}>{message}</div>
    </div>
  );
}

function CenteredNotice({
  title,
  message,
  primaryLabel = "Back",
  onBack,
}: {
  title: string;
  message: string;
  primaryLabel?: string;
  onBack?: () => void;
}) {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20, background: "var(--t-bg)", color: "var(--t-text)", fontFamily: "var(--t-body)" }}>
      <div style={{ ...panelStyle, maxWidth: 420, textAlign: "center" }}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>{title}</div>
        <div style={{ color: "var(--t-dim)", fontSize: 13, lineHeight: 1.6, marginTop: 8 }}>{message}</div>
        {onBack ? <button type="button" onClick={onBack} style={{ ...primaryButtonStyle, marginTop: 14 }}>{primaryLabel}</button> : null}
      </div>
    </div>
  );
}

function escapeText(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseEmailAddresses(value: string) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
}

function mergeEmailAddresses(...groups: string[][]) {
  return [...new Set(groups.flat().map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

const panelStyle = {
  border: "1px solid var(--t-brd)",
  borderRadius: "var(--t-radius)",
  background: "var(--t-s1)",
  padding: 16,
} satisfies CSSProperties;

const fieldLabelStyle = {
  display: "block",
  marginBottom: 8,
  fontFamily: "var(--t-data)",
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  color: "var(--t-mute)",
} satisfies CSSProperties;

const inputStyle = {
  width: "100%",
  padding: "12px 13px",
  borderRadius: "var(--t-radius)",
  border: "1px solid var(--t-brd)",
  background: "var(--t-bg)",
  color: "var(--t-text)",
  fontFamily: "var(--t-body)",
  fontSize: 15,
  outline: "none",
} satisfies CSSProperties;

const iconButtonStyle = {
  width: 38,
  height: 38,
  borderRadius: "var(--t-radius)",
  border: "1px solid var(--t-brd)",
  background: "var(--t-s1)",
  color: "var(--t-text)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
} satisfies CSSProperties;

const schedulePickerThemeStyle = {
  "--background": "var(--t-bg)",
  "--foreground": "var(--t-text)",
  "--popover": "var(--t-bg)",
  "--popover-foreground": "var(--t-text)",
  "--primary": "var(--t-accent)",
  "--primary-foreground": "#17130a",
  "--secondary": "var(--t-s2)",
  "--secondary-foreground": "var(--t-text)",
  "--muted": "var(--t-s1)",
  "--muted-foreground": "var(--t-dim)",
  "--border": "var(--t-brd)",
  "--ring": "var(--t-accent)",
} as CSSProperties;

const primaryButtonStyle = {
  border: "none",
  borderRadius: "var(--t-radius)",
  background: "var(--t-accent)",
  color: "var(--t-bg)",
  fontFamily: "var(--t-body)",
  fontSize: 13,
  fontWeight: 800,
  padding: "11px 15px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  cursor: "pointer",
} satisfies CSSProperties;

const quietButtonStyle = {
  minHeight: 34,
  border: "1px solid var(--t-brd)",
  borderRadius: "var(--t-radius)",
  background: "transparent",
  color: "var(--t-text)",
  fontFamily: "var(--t-body)",
  fontSize: 12,
  fontWeight: 750,
  padding: "7px 10px",
  display: "inline-flex",
  alignItems: "center",
  cursor: "pointer",
} satisfies CSSProperties;

const activitySectionLabelStyle = {
  fontFamily: "var(--t-data)",
  color: "var(--t-mute)",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: ".1em",
  textTransform: "uppercase",
} satisfies CSSProperties;

const historySummaryButtonStyle = {
  width: "100%",
  minHeight: 64,
  marginTop: 8,
  padding: "10px 11px",
  border: "1px solid var(--t-brd)",
  borderRadius: "var(--t-radius)",
  background: "transparent",
  color: "var(--t-dim)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  fontFamily: "var(--t-body)",
  cursor: "pointer",
} satisfies CSSProperties;

const asideTitleStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "var(--t-dim)",
  fontSize: 12,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".1em",
} satisfies CSSProperties;

export default QuoteEmailPage;
