// Jobs: what needs doing (the strip), then every live job as a board by stage
// or as a sortable list. Dragging a quoted job to Invoicing marks it accepted.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, Columns3, List, Plus, Search } from "lucide-react";
import type { RecordingMeta } from "@/lib/types";
import { api } from "@/lib/api";
import { useJobs, refreshJobs } from "@/lib/use-jobs";
import { useShell } from "@/components/shell/shell-context";
import {
  JOB_STATUS_LABEL, invoiceState, jobCustomer, jobInvoices, jobNextStep, jobPaid, jobRef, jobStatus,
  jobTitle, jobTotal, jobUpdatedAt, money, moneyRound, relativeDay, type JobStatus,
} from "@/lib/job-status";

type View = "board" | "list";
type Focus = "drafts" | "waiting" | "invoice" | "overdue" | null;

const VIEW_KEY = "field.jobsView";
const COLUMNS: Array<{ id: JobStatus; label: string; empty: string }> = [
  { id: "draft", label: "Drafts", empty: "New quotes appear here" },
  { id: "quoted", label: "Quoted", empty: "Sent quotes wait here for a reply" },
  { id: "invoicing", label: "Accepted · invoicing", empty: "Drag a quoted job here when the customer accepts" },
  { id: "paid", label: "Paid", empty: "Fully paid jobs land here" },
];

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"; } catch { return "board"; }
}

function matchesQuery(job: RecordingMeta, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [jobTitle(job), jobCustomer(job), jobRef(job), job.contactEmail, job.contactPhone, job.quotedBy].filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

export function JobsPage() {
  const navigate = useNavigate();
  const shell = useShell();
  const { jobs, loading, error } = useJobs();
  const [view, setView] = useState<View>(readView);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<Focus>(null);
  const [showLost, setShowLost] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<JobStatus | null>(null);
  const [accepting, setAccepting] = useState<RecordingMeta | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => { void refreshJobs(); }, []);
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* storage unavailable */ } }, [view]);

  const live = useMemo(() => (jobs || []).filter((job) => !job.archivedAt), [jobs]);
  const now = new Date();
  const groups = useMemo(() => {
    const drafts = live.filter((job) => jobStatus(job) === "draft");
    const waiting = live.filter((job) => jobStatus(job) === "quoted");
    const invoice = live.filter((job) => jobStatus(job) === "invoicing"
      && !jobInvoices(job).some((inv) => inv.status === "authorised")
      && (jobInvoices(job).length === 0 || jobInvoices(job).some((inv) => inv.status === "draft")));
    const overdueInvoices = live.flatMap((job) => jobInvoices(job).filter((inv) => invoiceState(inv) === "overdue").map((inv) => ({ job, inv })));
    return { drafts, waiting, invoice, overdueInvoices };
  }, [live]);
  const sum = (list: RecordingMeta[]) => list.reduce((total, job) => total + (jobTotal(job) || 0), 0);
  const overdueAmount = groups.overdueInvoices.reduce((total, { inv }) => total + (inv.amountDue || 0), 0);
  const focusIds = focus === null ? null : new Set(
    focus === "drafts" ? groups.drafts.map((job) => job.id)
      : focus === "waiting" ? groups.waiting.map((job) => job.id)
        : focus === "invoice" ? groups.invoice.map((job) => job.id)
          : groups.overdueInvoices.map(({ job }) => job.id),
  );
  const visible = live.filter((job) => (showLost || jobStatus(job) !== "lost") && (!focusIds || focusIds.has(job.id)) && matchesQuery(job, query));

  async function moveTo(job: RecordingMeta, target: JobStatus) {
    const from = jobStatus(job);
    if (from === target) return;
    if (target === "invoicing" && from === "quoted") { setAccepting(job); return; }
    if (target === "lost" && (from === "quoted" || from === "draft")) {
      try {
        await api.updatePipelineStage(job.id, "lost");
        await refreshJobs();
        shell.toast(`${jobTitle(job).split(",")[0]} marked lost`, () => {
          void api.updatePipelineStage(job.id, from === "draft" ? "draft" : "sent").then(() => refreshJobs());
        });
      } catch (err) {
        shell.toast(err instanceof Error ? err.message : "The job could not be moved.");
      }
      return;
    }
    if (target === "quoted" && from === "draft") return shell.toast("Send the quote from the job to move it to Quoted.");
    if (target === "paid") return shell.toast("Jobs move to Paid when their last invoice is paid.");
    if (target === "draft") return shell.toast("Open the job and edit the quote to start a new draft version.");
    shell.toast("Open the job to change where it stands.");
  }

  async function confirmAccept() {
    const job = accepting;
    if (!job) return;
    setAccepting(null);
    try {
      await api.markLanded(job.id);
      await refreshJobs();
      shell.toast(`${jobTitle(job).split(",")[0]} accepted. The first invoice is ready to send.`);
    } catch (err) {
      shell.toast(err instanceof Error ? err.message : "The job could not be marked accepted.");
    }
  }

  async function archiveSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      await api.bulkArchive(ids);
      setSelected(new Set());
      await refreshJobs();
      shell.toast(`Archived ${ids.length} ${ids.length === 1 ? "job" : "jobs"}`);
    } catch (err) {
      shell.toast(err instanceof Error ? err.message : "Those jobs could not be archived.");
    }
  }

  const strip: Array<{ id: Exclude<Focus, null>; label: string; value: string; sub: string; tone?: "bad" }> = [
    { id: "drafts", label: "Drafts to finish", value: String(groups.drafts.length), sub: groups.drafts.length ? `oldest updated ${relativeDay(groups.drafts.map(jobUpdatedAt).sort()[0])}` : "nothing in progress" },
    { id: "waiting", label: "Awaiting reply", value: String(groups.waiting.length), sub: `${moneyRound(sum(groups.waiting))} quoted` },
    { id: "invoice", label: "Ready to invoice", value: String(groups.invoice.length), sub: "next invoice not sent yet" },
    { id: "overdue", label: "Overdue", value: moneyRound(overdueAmount), sub: `${groups.overdueInvoices.length} ${groups.overdueInvoices.length === 1 ? "invoice" : "invoices"} past due`, tone: groups.overdueInvoices.length ? "bad" : undefined },
  ];
  const columns = showLost ? [...COLUMNS, { id: "lost" as JobStatus, label: "Lost", empty: "Drag a quote here when the customer says no" }] : COLUMNS;

  return (
    <>
      <header className="fx-ph">
        <h1 className="fx-ph__title">Jobs</h1>
        <div className="fx-seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}><Columns3 aria-hidden />Board</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}><List aria-hidden />List</button>
        </div>
        <div className="fx-spacer" />
        {view === "list" && selected.size > 0 && (
          <button type="button" className="fx-btn" onClick={archiveSelected}><Archive aria-hidden />Archive {selected.size}</button>
        )}
        <label className="fx-filter">
          <Search aria-hidden />
          <input id="jobs-filter" placeholder="Filter by address, customer or ref" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
        </label>
        <button type="button" className="fx-btn fx-btn--ghost" aria-pressed={showLost} onClick={() => setShowLost((value) => !value)}>{showLost ? "Hide lost" : "Show lost"}</button>
        <button type="button" className="fx-btn fx-btn--primary" onClick={shell.newQuote}><Plus aria-hidden />New quote<span className="fx-btn__kbd">N</span></button>
      </header>

      <div className="fx-strip">
        {strip.map((item) => (
          <button key={item.id} type="button" className="fx-strip__item" aria-pressed={focus === item.id} onClick={() => setFocus(focus === item.id ? null : item.id)}>
            <span className="fx-strip__k">{item.label}</span>
            <span className="fx-strip__v" style={item.tone === "bad" ? { color: "var(--t-danger)" } : undefined}>{item.value}</span>
            <span className="fx-strip__s">{item.sub}</span>
          </button>
        ))}
      </div>

      {error && !jobs && <div className="fx-notice fx-notice--bad"><span>{error}</span><button type="button" className="fx-btn fx-btn--sm" onClick={() => refreshJobs()}>Try again</button></div>}
      {!jobs && loading && <div className="fx-loading" style={{ minHeight: 240 }}>Loading jobs…</div>}
      {jobs && live.length === 0 && (
        <div style={{ display: "grid", placeItems: "center", padding: "80px 24px", textAlign: "center", gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 650 }}>No jobs yet</div>
          <p className="fx-dim" style={{ margin: 0, maxWidth: 380 }}>Start with a site address. You'll build the quote from your catalogue, send it, and invoice from the same page when it's accepted.</p>
          <button type="button" className="fx-btn fx-btn--primary" onClick={shell.newQuote}><Plus aria-hidden />New quote</button>
        </div>
      )}

      {jobs && live.length > 0 && view === "board" && (
        <div className="fx-board" style={showLost ? { gridTemplateColumns: "repeat(5, minmax(240px, 1fr))" } : undefined}>
          {columns.map((column) => {
            const items = visible.filter((job) => jobStatus(job) === column.id)
              .sort((a, b) => jobUpdatedAt(b).localeCompare(jobUpdatedAt(a)));
            return (
              <section key={column.id} className="fx-col" aria-label={column.label}>
                <div className="fx-col__h">
                  <span className={`fx-dot fx-dot--${column.id}`} aria-hidden />
                  {column.label}
                  <span className="fx-num fx-mute" style={{ fontSize: 12, fontWeight: 500 }}>{items.length}</span>
                  {items.some((job) => jobTotal(job) != null) && <span className="fx-col__sum">{moneyRound(sum(items))}</span>}
                </div>
                <div
                  className="fx-col__b"
                  data-over={overColumn === column.id}
                  onDragOver={(event) => { if (dragId) { event.preventDefault(); setOverColumn(column.id); } }}
                  onDragLeave={() => setOverColumn((current) => (current === column.id ? null : current))}
                  onDrop={(event) => {
                    event.preventDefault();
                    setOverColumn(null);
                    const job = live.find((candidate) => candidate.id === dragId);
                    setDragId(null);
                    if (job) void moveTo(job, column.id);
                  }}
                >
                  {items.length === 0 && <div className="fx-col__empty">{column.empty}</div>}
                  {items.map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      now={now}
                      dragging={dragId === job.id}
                      onDragStart={() => setDragId(job.id)}
                      onDragEnd={() => { setDragId(null); setOverColumn(null); }}
                      onOpen={() => navigate(`/jobs/${job.id}`)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {jobs && live.length > 0 && view === "list" && (
        <JobList jobs={visible} selected={selected} onSelect={setSelected} onOpen={(id) => navigate(`/jobs/${id}`)} />
      )}

      {accepting && (
        <div className="fx-scrim" onMouseDown={() => setAccepting(null)}>
          <div className="fx-dialog" role="dialog" aria-modal="true" aria-labelledby="accept-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setAccepting(null); }}>
            <div className="fx-dialog__h" id="accept-title">Mark as accepted?</div>
            <div className="fx-dialog__b">
              <p style={{ margin: 0 }}><b>{jobTitle(accepting)}</b> moves to invoicing. Its invoices are set up from the quote's payment schedule, ready to send.</p>
              <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>Quote total {money(jobTotal(accepting))} inc GST · {jobRef(accepting)}</p>
            </div>
            <div className="fx-dialog__f">
              <button type="button" className="fx-btn fx-btn--ghost" onClick={() => setAccepting(null)}>Cancel</button>
              <button type="button" className="fx-btn fx-btn--primary" autoFocus onClick={confirmAccept}>Mark accepted</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function JobCard({ job, now, dragging, onDragStart, onDragEnd, onOpen }: {
  job: RecordingMeta;
  now: Date;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const status = jobStatus(job);
  const total = jobTotal(job);
  const paid = jobPaid(job);
  const next = jobNextStep(job, now);
  return (
    <button
      type="button"
      className="fx-card"
      draggable
      data-dragging={dragging}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", job.id); onDragStart(); }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      <span className="fx-card__t">{jobTitle(job)}</span>
      <span className="fx-card__row">
        <span>{jobCustomer(job) || "No customer yet"}</span>
        {total == null ? null : <span className="fx-num">{money(total)}</span>}
      </span>
      {status === "invoicing" && total ? (
        <span className="fx-bar" title={`${money(paid)} paid`}><i style={{ width: `${Math.min(100, (paid / total) * 100)}%` }} /></span>
      ) : null}
      <span className="fx-card__next" data-tone={next.tone}>
        <span className="fx-num fx-mute" style={{ fontSize: 11 }}>{jobRef(job)}</span>
        <span aria-hidden>·</span>
        <span>{next.text}</span>
      </span>
    </button>
  );
}

type SortKey = "ref" | "title" | "customer" | "status" | "total" | "updated";

function JobList({ jobs, selected, onSelect, onOpen }: {
  jobs: RecordingMeta[];
  selected: Set<string>;
  onSelect: (next: Set<string>) => void;
  onOpen: (id: string) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "updated", dir: -1 });
  const order: Record<JobStatus, number> = { draft: 0, quoted: 1, invoicing: 2, paid: 3, lost: 4 };
  const value = (job: RecordingMeta): string | number => {
    switch (sort.key) {
      case "ref": return jobRef(job);
      case "title": return jobTitle(job).toLowerCase();
      case "customer": return jobCustomer(job).toLowerCase();
      case "status": return order[jobStatus(job)];
      case "total": return jobTotal(job) ?? -1;
      default: return jobUpdatedAt(job);
    }
  };
  const rows = [...jobs].sort((a, b) => (value(a) > value(b) ? 1 : value(a) < value(b) ? -1 : 0) * sort.dir);
  const allSelected = rows.length > 0 && rows.every((job) => selected.has(job.id));
  const header = (key: SortKey, label: string, numeric = false) => (
    <th className={numeric ? "fx-r" : undefined} aria-sort={sort.key === key ? (sort.dir > 0 ? "ascending" : "descending") : undefined}>
      <button type="button" data-active={sort.key === key} onClick={() => setSort((current) => ({ key, dir: current.key === key ? (current.dir === 1 ? -1 : 1) : (key === "updated" || key === "total" ? -1 : 1) }))}>
        {label}{sort.key === key ? (sort.dir > 0 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
  return (
    <div className="fx-scroll-x" style={{ paddingTop: 12 }}>
      <table className="fx-table">
        <thead>
          <tr>
            <th style={{ width: 44 }}>
              <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => onSelect(allSelected ? new Set() : new Set(rows.map((job) => job.id)))} />
            </th>
            {header("ref", "Ref")}
            {header("title", "Job")}
            {header("customer", "Customer")}
            {header("status", "Status")}
            {header("total", "Quote inc GST", true)}
            <th style={{ width: 150 }}>Paid</th>
            {header("updated", "Updated", true)}
          </tr>
        </thead>
        <tbody>
          {rows.map((job) => {
            const status = jobStatus(job);
            const total = jobTotal(job);
            const paid = jobPaid(job);
            const invoiced = jobInvoices(job).length > 0;
            return (
              <tr key={job.id} data-click tabIndex={0} onClick={() => onOpen(job.id)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(job.id); }} aria-selected={selected.has(job.id) || undefined}>
                <td onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${jobTitle(job)}`}
                    checked={selected.has(job.id)}
                    onChange={() => { const next = new Set(selected); if (next.has(job.id)) next.delete(job.id); else next.add(job.id); onSelect(next); }}
                  />
                </td>
                <td className="fx-num fx-dim">{jobRef(job)}</td>
                <td className="fx-table__strong">{jobTitle(job)}</td>
                <td className="fx-dim">{jobCustomer(job) || "—"}</td>
                <td><span className={`fx-status fx-status--${status}`}>{JOB_STATUS_LABEL[status]}</span></td>
                <td className="fx-r fx-num">{money(total)}</td>
                <td>
                  {invoiced && total ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="fx-bar" style={{ flex: 1 }}><i style={{ width: `${Math.min(100, (paid / total) * 100)}%` }} /></span>
                      <span className="fx-num fx-mute" style={{ fontSize: 11, width: 32, textAlign: "right" }}>{Math.round((paid / total) * 100)}%</span>
                    </span>
                  ) : <span className="fx-mute">—</span>}
                </td>
                <td className="fx-r fx-dim">{relativeDay(jobUpdatedAt(job))}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr className="fx-table__empty"><td colSpan={8}>No jobs match. Clear the filter or start a new quote.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
