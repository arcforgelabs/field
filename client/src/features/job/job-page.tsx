// One job: the quote (or its invoices) as the document on the left, and a
// summary rail on the right with the totals, the customer, the site and the
// versions. The header's one primary button is always the next step: send
// the quote, mark it accepted, send the next invoice, or record a payment.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Archive, Check, CircleX, Eye, MoreHorizontal, RotateCcw, Send, Trash2, Wallet } from "lucide-react";
import type { RecordingDetail } from "@/lib/types";
import { api } from "@/lib/api";
import { refreshJobs, patchJobMeta } from "@/lib/use-jobs";
import { useShell } from "@/components/shell/shell-context";
import { Menu, type MenuItem } from "@/components/shell/menu";
import { JOB_STATUS_LABEL, jobInvoices, jobPaid, jobRef, jobStatus, jobTitle, nextOpenInvoice } from "@/lib/job-status";
import { QuoteEditor, type QuoteTotals, type SaveState } from "./quote-editor";
import { JobInvoices, RecordPaymentDialog } from "./job-invoices";
import { JobActivity, JobNotes } from "./job-activity";
import { openDocumentPdf } from "@/lib/open-document";
import { JobRail } from "./job-rail";
import { describeVersions } from "./quote-versions";

type Tab = "quote" | "invoices" | "notes" | "activity";

export function JobPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const shell = useShell();
  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("latest");
  const [tab, setTab] = useState<Tab | null>(null);
  const [totals, setTotals] = useState<QuoteTotals | null>(null);
  const [saveState, setSaveState] = useState<{ state: SaveState; error?: string | null }>({ state: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "accept" | "lost" | "archive" | "delete">(null);
  const [paying, setPaying] = useState<number | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const startQuoting = params.get("start") === "1";

  const load = useCallback(async (nextVersion = version) => {
    try {
      const next = await api.recording(id, nextVersion);
      setDetail(next);
      setError(null);
      patchJobMeta(next.meta);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "This job could not be loaded.");
      return null;
    }
  }, [id, version]);

  useEffect(() => {
    setDetail(null);
    setTab(null);
    setVersion("latest");
    void api.recording(id, "latest").then((next) => { setDetail(next); patchJobMeta(next.meta); }).catch((err) => setError(err instanceof Error ? err.message : "This job could not be loaded."));
  }, [id]);

  useEffect(() => {
    if (!startQuoting) return;
    const timer = window.setTimeout(() => { params.delete("start"); setParams(params, { replace: true }); }, 1500);
    return () => window.clearTimeout(timer);
  }, [startQuoting, params, setParams]);

  const meta = detail?.meta;
  const status = meta ? jobStatus(meta) : "draft";
  const invoices = meta ? jobInvoices(meta) : [];
  const landed = status === "invoicing" || status === "paid";
  const activeTab: Tab = tab ?? (landed ? "invoices" : "quote");
  const policy = detail?.quoteEditPolicy || null;
  const editable = Boolean(detail?.quote) && (policy ? policy.canEditSelectedVersion : status === "draft");
  const selectedVersion = detail?.versionView?.selectedVersion ?? meta?.quoteVersion ?? null;
  const latestVersion = detail?.versionView?.latestVersion ?? selectedVersion;
  const viewingLatest = detail?.versionView?.isLatest !== false;
  const draftAheadOfSent = Boolean(policy?.lastSentQuoteVersion && latestVersion && latestVersion > policy.lastSentQuoteVersion && viewingLatest && editable);
  const nextInvoice = meta ? nextOpenInvoice(meta) : null;
  const priced = totals ? totals.subtotal > 0 : (meta?.quoteTotal || 0) > 0;
  const sendBlocked = detail?.quote?.pricing?.sendable === false ? detail.quote.pricing.blockingReason || "This quote can't be sent yet." : null;
  const sendable = priced && !sendBlocked;

  const onTotals = useCallback((next: QuoteTotals) => setTotals(next), []);
  const onSaveState = useCallback((state: SaveState, err?: string | null) => setSaveState({ state, error: err }), []);
  // After a save, refresh the server's view (pricing checks, totals, versions)
  // without remounting the editor, which keeps its own draft.
  const reloadTimer = useRef<number | null>(null);
  const onSaved = useCallback(() => {
    void refreshJobs();
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      void api.recording(id, "latest").then((next) => {
        // Take the server's status (pricing checks, versions, meta) but keep the
        // quote the editor was opened with: a response can blank amounts.
        setDetail((current) => (current && current.versionView?.selectedVersion === next.versionView?.selectedVersion
          ? { ...next, quote: current.quote && next.quote ? { ...current.quote, pricing: next.quote.pricing } : current.quote }
          : current));
      }).catch(() => undefined);
    }, 400);
  }, [id]);

  async function run(label: string, action: () => Promise<unknown>, success?: string) {
    setBusy(label);
    try {
      await action();
      await load();
      void refreshJobs();
      if (success) shell.toast(success);
    } catch (err) {
      shell.toast(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function sendDocument(documentType: "quote" | "invoice" | "receipt", milestoneIndex?: number) {
    const query = new URLSearchParams({ documentType });
    if (milestoneIndex != null) query.set("milestoneIndex", String(milestoneIndex));
    if (documentType === "quote" && draftAheadOfSent && latestVersion) query.set("version", String(latestVersion));
    // The editor saves on the way out, so the email page reads the latest draft.
    window.setTimeout(() => navigate(`/jobs/${id}/email-editor?${query.toString()}`), saveState.state === "pending" || saveState.state === "saving" ? 700 : 0);
  }

  async function startNewVersion() {
    await run("version", async () => {
      const created = await api.createVersion(id);
      setVersion(String(created.currentVersion));
      const next = await api.recording(id, String(created.currentVersion));
      setDetail(next);
      setEditorKey((key) => key + 1);
      setTab("quote");
    }, "New draft version started. The sent version stays as it was.");
  }

  async function pickVersion(next: number) {
    const ref = next === latestVersion ? "latest" : String(next);
    setVersion(ref);
    const loaded = await load(ref);
    if (loaded) { setEditorKey((key) => key + 1); setTab("quote"); }
  }

  function previewPdf() {
    const doc = landed && activeTab === "invoices" && nextInvoice ? "invoice" : "quote";
    if (doc === "quote" && !priced) {
      shell.toast("Add at least one priced item to preview the quote.");
      return;
    }
    const url = api.quotePdfUrl(id, doc === "quote" && selectedVersion ? String(selectedVersion) : undefined, doc === "invoice" ? nextInvoice?.milestoneIndex : null, doc);
    void openDocumentPdf(url, shell.toast);
  }

  if (error && !detail) {
    return (
      <div className="fx-loading" style={{ gap: 12, display: "grid" }}>
        <span>{error}</span>
        <Link className="fx-btn" to="/jobs">Back to jobs</Link>
      </div>
    );
  }
  if (!detail || !meta) return <div className="fx-loading">Loading…</div>;

  let primary: React.ReactNode = null;
  if (status === "draft" || draftAheadOfSent) {
    primary = (
      <button type="button" className="fx-btn fx-btn--primary" disabled={!sendable || !viewingLatest} title={!priced ? "Add priced items before sending" : sendBlocked || undefined} onClick={() => sendDocument("quote")}>
        <Send aria-hidden />{draftAheadOfSent ? "Send revised quote" : "Send quote"}
      </button>
    );
  } else if (status === "quoted") {
    primary = <button type="button" className="fx-btn fx-btn--primary" onClick={() => setConfirm("accept")} disabled={busy !== null}><Check aria-hidden />Mark accepted</button>;
  } else if (status === "invoicing" && nextInvoice) {
    primary = nextInvoice.status === "draft"
      ? <button type="button" className="fx-btn fx-btn--primary" onClick={() => sendDocument("invoice", nextInvoice.milestoneIndex)}><Send aria-hidden />Send {nextInvoice.milestoneLabel.toLowerCase()} invoice</button>
      : <button type="button" className="fx-btn fx-btn--primary" onClick={() => setPaying(nextInvoice.milestoneIndex)}><Wallet aria-hidden />Record payment</button>;
  } else if (status === "invoicing" && invoices.length === 0) {
    primary = <button type="button" className="fx-btn fx-btn--primary" onClick={() => setTab("invoices")}>Set up invoices</button>;
  } else if (status === "lost") {
    primary = <button type="button" className="fx-btn" disabled={busy !== null} onClick={() => run("reopen", () => api.updatePipelineStage(id, "sent"), "Reopened as quoted")}><RotateCcw aria-hidden />Reopen</button>;
  }

  const moreItems: MenuItem[] = [
    { label: "Preview PDF", icon: <Eye />, onSelect: previewPdf },
    ...(status === "quoted" || status === "invoicing" || status === "paid" ? [{ label: "Resend the quote", icon: <Send />, onSelect: () => sendDocument("quote") } as MenuItem] : []),
    ...(status === "quoted" || status === "draft" ? [{ label: "Mark as lost", icon: <CircleX />, onSelect: () => setConfirm("lost") } as MenuItem] : []),
    { kind: "separator" },
    ...(detail.deletion?.deletable || meta.deletable
      ? [{ label: "Delete job", icon: <Trash2 />, tone: "danger", onSelect: () => setConfirm("delete") } as MenuItem]
      : [{ label: "Archive job", icon: <Archive />, onSelect: () => setConfirm("archive") } as MenuItem]),
  ];

  const saveLabel = busy ? "Working…"
    : !editable ? null
    : saveState.state === "saving" ? "Saving…"
      : saveState.state === "pending" ? "Editing"
        : saveState.state === "error" ? "Not saved"
          : saveState.state === "saved" ? "Saved" : null;

  return (
    <>
      <header className="fx-ph">
        <div className="fx-ph__stack">
          <nav className="fx-crumb" aria-label="Breadcrumb">
            <Link to="/jobs">Jobs</Link><span aria-hidden>/</span><span className="fx-num">{jobRef(meta)}</span>
          </nav>
          <div className="fx-ph__line">
            <h1 className="fx-ph__title">{jobTitle(meta)}</h1>
            <span className={`fx-status fx-status--${status}`}>{JOB_STATUS_LABEL[status]}</span>
            {saveLabel && <span className="fx-save-state" data-state={saveState.state} title={saveState.error || undefined}>{saveLabel}</span>}
          </div>
        </div>
        <div className="fx-spacer" />
        <button type="button" className="fx-btn fx-btn--ghost" onClick={previewPdf}><Eye aria-hidden />Preview</button>
        {primary}
        <Menu label="More job actions" items={moreItems} trigger={(props) => (
          <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="More job actions" {...props}><MoreHorizontal /></button>
        )} />
      </header>
      {(status === "draft" || draftAheadOfSent) && priced && sendBlocked && saveState.state !== "pending" && saveState.state !== "saving" && (
        <div className="fx-notice fx-notice--warn"><span>Can't send yet: {sendBlocked}</span></div>
      )}
      {saveState.state === "error" && (
        <div className="fx-notice fx-notice--bad"><span>Your last change wasn't saved: {saveState.error}</span></div>
      )}
      <div className="fx-job">
        <div className="fx-doc">
          <div className="fx-tabs" role="tablist" aria-label="Job">
            <button type="button" role="tab" aria-selected={activeTab === "quote"} onClick={() => setTab("quote")}>
              Quote
            </button>
            <button type="button" role="tab" aria-selected={activeTab === "invoices"} disabled={!landed && invoices.length === 0} title={!landed ? "Invoices open once the customer accepts" : undefined} onClick={() => setTab("invoices")}>
              Invoices{invoices.length ? <span className="fx-tabs__badge">{invoices.filter((invoice) => invoice.status === "paid").length}/{invoices.length}</span> : null}
            </button>
            <button type="button" role="tab" aria-selected={activeTab === "notes"} onClick={() => setTab("notes")}>Notes</button>
            <button type="button" role="tab" aria-selected={activeTab === "activity"} onClick={() => setTab("activity")}>Activity</button>
          </div>
          <div hidden={activeTab !== "quote"} role="tabpanel">
            {detail.quote ? (
              <QuoteEditor
                key={`${editorKey}:${selectedVersion}`}
                detail={detail}
                editable={editable && viewingLatest}
                lockReason={!viewingLatest ? `You're looking at ${describeVersions(detail.quoteVersions || [], policy?.lastSentQuoteVersion).find((row) => row.version === selectedVersion)?.phrase || "an earlier version"}.` : null}
                onNewVersion={startNewVersion}
                newVersionBusy={busy === "version"}
                onTotals={onTotals}
                onSaveState={onSaveState}
                onSaved={onSaved}
                autoFocusAdd={startQuoting}
              />
            ) : (
              <div className="fx-block fx-dim">This job has no quote yet.</div>
            )}
          </div>
          {activeTab === "invoices" && (
            <div role="tabpanel">
              <JobInvoices
                detail={detail}
                busy={busy}
                onSend={(index, type) => sendDocument(type, index)}
                onRecordPayment={(index) => setPaying(index)}
                run={run}
              />
            </div>
          )}
          {activeTab === "notes" && (
            <div role="tabpanel">
              <JobNotes detail={detail} onDetail={(next) => setDetail((current) => current && { ...current, jobState: next.jobState })} />
            </div>
          )}
          {activeTab === "activity" && (
            <div role="tabpanel">
              <JobActivity detail={detail} />
            </div>
          )}
        </div>
        <JobRail
          detail={detail}
          totals={totals}
          paid={jobPaid(meta)}
          landed={landed}
          selectedVersion={selectedVersion}
          onPickVersion={pickVersion}
          onDetailSaved={(next) => { setDetail((current) => (current ? { ...current, meta: next.meta, jobState: next.jobState } : next)); patchJobMeta(next.meta); }}
        />
      </div>

      {confirm && (
        <ConfirmDialog
          title={{ accept: "Mark as accepted?", lost: "Mark as lost?", archive: "Archive this job?", delete: "Delete this job?" }[confirm]}
          body={{
            accept: "The job moves to invoicing. Its invoices are set up from the payment schedule, ready to send.",
            lost: "It moves out of the pipeline. You can reopen it later.",
            archive: "It leaves the jobs list. Its quotes and invoices are kept.",
            delete: "Nothing has been added to this job yet, so it's removed for good.",
          }[confirm]}
          action={{ accept: "Mark accepted", lost: "Mark lost", archive: "Archive", delete: "Delete" }[confirm]}
          danger={confirm === "delete" || confirm === "lost"}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const kind = confirm;
            setConfirm(null);
            if (kind === "accept") { await run("accept", () => api.markLanded(id), "Accepted. The first invoice is ready to send."); setTab("invoices"); }
            if (kind === "lost") await run("lost", () => api.updatePipelineStage(id, "lost"), "Marked lost");
            if (kind === "archive") { await api.archive(id).catch(() => null); await refreshJobs(); navigate("/jobs"); shell.toast("Job archived"); }
            if (kind === "delete") {
              try { await api.deleteRecording(id); await refreshJobs(); navigate("/jobs"); shell.toast("Job deleted"); } catch (err) { shell.toast(err instanceof Error ? err.message : "The job could not be deleted."); }
            }
          }}
        />
      )}
      {paying != null && (
        <RecordPaymentDialog
          invoice={invoices.find((invoice) => invoice.milestoneIndex === paying) || null}
          onCancel={() => setPaying(null)}
          onRecord={async (payment) => {
            const index = paying;
            setPaying(null);
            await run("pay", () => api.recordMilestonePayment(id, index, payment), "Payment recorded. The receipt is ready.");
          }}
        />
      )}
    </>
  );
}

export function ConfirmDialog({ title, body, action, danger, onCancel, onConfirm }: {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fx-scrim" onMouseDown={onCancel}>
      <div className="fx-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
        <div className="fx-dialog__h" id="confirm-title">{title}</div>
        <div className="fx-dialog__b"><p style={{ margin: 0 }}>{body}</p></div>
        <div className="fx-dialog__f">
          <button type="button" className="fx-btn fx-btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? "fx-btn fx-btn--danger" : "fx-btn fx-btn--primary"} autoFocus onClick={onConfirm}>{action}</button>
        </div>
      </div>
    </div>
  );
}
