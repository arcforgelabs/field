// The app's frame: a sidebar (search, Jobs, Invoices, Catalogue, recent jobs,
// account) beside one working surface. Owns the command palette, the
// new-quote dialog and toasts, which every page reaches through useShell().
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { BookOpen, FileText, LayoutGrid, Moon, Search, Settings, Sun } from "lucide-react";
import { FieldLogo } from "@/components/field";
import { useAuth } from "@/contexts/auth-context";
import { useUpdateStatus } from "@/features/settings/use-update-status";
import { useTheme } from "@/contexts/theme-context";
import { jobStatus, jobTitle } from "@/lib/job-status";
import { useJobs } from "@/lib/use-jobs";
import { CommandPalette } from "./command-palette";
import { NewQuoteDialog } from "./new-quote-dialog";
import { ShellContext, type ShellApi } from "./shell-context";
import "./ui.css";

function initials(name: string | undefined | null) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "·";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { status: updateStatus } = useUpdateStatus();
  const updateAvailable = Boolean(updateStatus?.updateAvailable);
  const { jobs } = useJobs();
  const navigate = useNavigate();
  const location = useLocation();
  const { mode: resolvedMode, setColorMode: setMode, setFamily } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newQuoteOpen, setNewQuoteOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((message: string, undo?: () => void, options?: { durationMs?: number }) => {
    setToast({ message, undo });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), options?.durationMs ?? (undo ? 6000 : 3200));
  }, []);
  const api = useMemo<ShellApi>(() => ({ newQuote: () => setNewQuoteOpen(true), toast: showToast }), [showToast]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (paletteOpen || newQuoteOpen || document.querySelector("[role='dialog']")) return;
      if (event.key === "n") {
        event.preventDefault();
        setNewQuoteOpen(true);
      } else if (event.key === "/") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, newQuoteOpen]);

  const live = (jobs || []).filter((job) => !job.archivedAt);
  const openJobs = live.filter((job) => jobStatus(job) !== "lost" && jobStatus(job) !== "paid").length;
  const openInvoices = live.flatMap((job) => job.milestoneInvoices || []).filter((invoice) => invoice.status === "authorised").length;
  const recentIds = useRecentJobIds(location.pathname);
  const recent = recentIds.map((id) => live.find((job) => job.id === id)).filter(Boolean).slice(0, 4) as typeof live;
  const jobsActive = location.pathname === "/jobs" || location.pathname.startsWith("/jobs/");

  return (
    <ShellContext.Provider value={api}>
      <div className="fx-app">
        <aside className="fx-side" aria-label="Field">
          <div className="fx-side__top">
            <NavLink to="/jobs" className="fx-side__logo" aria-label="Field home">
              <FieldLogo size={22} />
            </NavLink>
            <button type="button" className="fx-search-btn" onClick={() => setPaletteOpen(true)} aria-label="Search and commands">
              <Search size={14} aria-hidden />
              <span>Search or jump to…</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
          <nav className="fx-nav" aria-label="Main">
            <NavLink to="/jobs" className="fx-nav__item" aria-current={jobsActive ? "page" : undefined}>
              <LayoutGrid aria-hidden /><span className="fx-nav__text">Jobs</span>
              {openJobs > 0 && <span className="fx-nav__count">{openJobs}</span>}
            </NavLink>
            <NavLink to="/invoices" className="fx-nav__item">
              <FileText aria-hidden /><span className="fx-nav__text">Invoices</span>
              {openInvoices > 0 && <span className="fx-nav__count">{openInvoices}</span>}
            </NavLink>
            <NavLink to="/pricing" className="fx-nav__item" aria-current={location.pathname.startsWith("/pricing") ? "page" : undefined}>
              <BookOpen aria-hidden /><span className="fx-nav__text">Catalogue</span>
            </NavLink>
          </nav>
          {recent.length > 0 && (
            <>
              <div className="fx-nav__label">Recent</div>
              <nav className="fx-nav fx-nav--recent" aria-label="Recent jobs">
                {recent.map((job) => (
                  <NavLink key={job.id} to={`/jobs/${job.id}`} className="fx-nav__item" style={{ fontSize: 12.5 }}>
                    <span className={`fx-dot fx-dot--${jobStatus(job)}`} aria-hidden />
                    <span className="fx-nav__text">{jobTitle(job).split(",")[0]}</span>
                  </NavLink>
                ))}
              </nav>
            </>
          )}
          <div className="fx-side__foot">
            <button type="button" className="fx-avatar" onClick={() => navigate("/settings")} aria-label="Account and settings">
              {initials(user?.name || user?.email)}
            </button>
            <div className="fx-who">
              <div className="fx-who__name">{user?.name || user?.email || "Signed in"}</div>
              {user?.email && user?.name && <div className="fx-who__sub">{user.email}</div>}
            </div>
            <button
              type="button"
              className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon"
              aria-label={resolvedMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={resolvedMode === "dark" ? "Light mode" : "Dark mode"}
              onClick={() => setMode(resolvedMode === "dark" ? "light" : "dark")}
            >
              {resolvedMode === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
            </button>
            <NavLink
              to="/settings"
              className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon fx-update-anchor"
              aria-label={updateAvailable ? "Settings (a Field update is available)" : "Settings"}
              title={updateAvailable ? "Settings: a Field update is available" : "Settings"}
            >
              <Settings aria-hidden />
              {updateAvailable && <span className="fx-update-dot" aria-hidden />}
            </NavLink>
          </div>
        </aside>
        <main className="fx-main" id="main">{children}</main>
      </div>
      {paletteOpen && (
        <CommandPalette
          jobs={live}
          onDirection={(next) => { setFamily(next); setPaletteOpen(false); }}
          onClose={() => setPaletteOpen(false)}
          onNewQuote={() => { setPaletteOpen(false); setNewQuoteOpen(true); }}
        />
      )}
      {newQuoteOpen && <NewQuoteDialog onClose={() => setNewQuoteOpen(false)} />}
      {toast && (
        <div className="fx-toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button type="button" onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button>
          )}
        </div>
      )}
    </ShellContext.Provider>
  );
}

const RECENT_KEY = "field.recentJobs";

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Jobs opened most recently in this browser, newest first. */
function useRecentJobIds(pathname: string) {
  const ids = useMemo(() => {
    const match = /^\/jobs\/([^/]+)$/.exec(pathname);
    const stored = readRecent();
    return match ? [match[1], ...stored.filter((id) => id !== match[1])].slice(0, 8) : stored;
  }, [pathname]);
  useEffect(() => {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(ids)); } catch { /* storage unavailable */ }
  }, [ids]);
  return ids;
}
