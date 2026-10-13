// Settings: your account (Clerk's own screens, in Field's theme), the team,
// the terms printed on quotes, and how Field looks.
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { LogOut, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { useShell } from "@/components/shell/shell-context";
import { AppearanceSection } from "./appearance-section";
import { PeopleSection } from "./people-section";
import { InvoicingPanel } from "./invoicing-panel";
import { MilestoneRulesPanel } from "./milestone-rules-panel";
import { EmailSignaturePanel } from "./email-signature-panel";
import "./settings-page.css";

const ClerkAccount = lazy(() => import("./clerk-account"));

type Section = "account" | "team" | "documents" | "email" | "appearance";

export function SettingsPage() {
  const { logout, user, mode, isOwner } = useAuth();
  const [params, setParams] = useSearchParams();
  const sections: Array<{ id: Section; label: string; show: boolean }> = [
    { id: "account", label: "Account and security", show: true },
    { id: "team", label: "Team", show: mode === "clerk" && isOwner },
    { id: "documents", label: "Quotes and invoices", show: true },
    { id: "email", label: "Email", show: true },
    { id: "appearance", label: "Appearance", show: true },
  ];
  const requested = params.get("section") as Section | null;
  const active: Section = sections.some((section) => section.id === requested && section.show) ? (requested as Section) : "account";
  const go = (id: Section) => setParams(id === "account" ? {} : { section: id }, { replace: true });

  return (
    <>
      <header className="fx-ph"><h1 className="fx-ph__title">Settings</h1></header>
      <div className="fx-set">
        <nav className="fx-set__nav" aria-label="Settings">
          {sections.filter((section) => section.show).map((section) => (
            <button key={section.id} type="button" className="fx-nav__item" aria-current={active === section.id ? "page" : undefined} onClick={() => go(section.id)}>
              {section.label}
            </button>
          ))}
        </nav>
        <div className="fx-set__body">
          {active === "account" && (
            <Panel title="Account and security" description={mode === "clerk" ? "Your sign-in, email addresses, connected accounts and devices." : "The account you're signed in with."}>
              {mode === "clerk" ? (
                <>
                  {isOwner && user && !user.mfaVerified && (
                    <div className="fx-notice fx-notice--warn" style={{ margin: 0 }}>
                      <span>Owner actions (approving people, issuing tokens, connecting AI agents) need a verified owner sign-in. {user.ownerVerificationHelp ?? "Sign out, then sign in with your Google Workspace work account, or with two-step verification."}</span>
                    </div>
                  )}
                  <Suspense fallback={<div className="fx-dim" style={{ padding: 24 }}>Loading your account…</div>}>
                    <ClerkAccount />
                  </Suspense>
                </>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="fx-avatar" style={{ width: 40, height: 40, fontSize: 14 }}>{(user?.name || user?.email || "·").slice(0, 1).toUpperCase()}</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>{user?.name || "Signed in"}</div>
                    {user?.email && <div className="fx-dim">{user.email}</div>}
                  </div>
                </div>
              )}
              <div>
                <button type="button" className="fx-btn" onClick={() => logout()}><LogOut aria-hidden />Sign out</button>
              </div>
            </Panel>
          )}
          {active === "team" && user && (
            <Panel title="Team" description="Approve people who signed in and are waiting for access, change roles, or turn access off.">
              {user.mfaVerified
                ? <PeopleSection selfId={user.id} />
                : <p className="fx-dim" style={{ margin: 0 }}>Sign in with a verified owner sign-in to manage the team.</p>}
            </Panel>
          )}
          {active === "documents" && (
            <>
              <TermsPanel />
              <InvoicingPanel />
              <MilestoneRulesPanel />
            </>
          )}
          {active === "email" && <EmailSignaturePanel />}
          {active === "appearance" && (
            <Panel title="Appearance" description="Saved in this browser. Clerk's account screens follow the same choice.">
              <AppearanceSection />
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="fx-set__section" aria-label={title}>
      <div>
        <h2 className="fx-set__h">{title}</h2>
        {description && <p className="fx-set__p">{description}</p>}
      </div>
      {children}
    </section>
  );
}

type Term = { id: string; title: string; body: string };

function TermsPanel() {
  const shell = useShell();
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getTerms()
      .then((res) => { setTerms(res.terms); setSaved(JSON.stringify(res.terms)); })
      .catch((err) => setError(err instanceof Error ? err.message : "Terms could not be loaded."));
  }, []);

  const dirty = terms != null && JSON.stringify(terms) !== saved;
  async function save() {
    if (!terms) return;
    setBusy(true);
    try {
      await api.updateTerms(terms);
      setSaved(JSON.stringify(terms));
      shell.toast("Terms saved. New quotes and previews use them.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Terms could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  const update = (index: number, patch: Partial<Term>) => setTerms((current) => current && current.map((term, i) => (i === index ? { ...term, ...patch } : term)));

  return (
    <Panel title="Terms and conditions" description="Printed on every quote. A quote already sent keeps the terms it was sent with.">
      {error && <div className="fx-notice fx-notice--bad" style={{ margin: 0 }}><span>{error}</span></div>}
      {!terms && !error && <p className="fx-dim">Loading…</p>}
      {terms && terms.map((term, index) => (
        <div key={term.id} style={{ display: "grid", gap: 6, paddingBottom: 14, borderBottom: "1px solid var(--fx-line)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input className="fx-input" aria-label="Heading" style={{ fontWeight: 600 }} value={term.title} onChange={(event) => update(index, { title: event.target.value })} />
            <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label={`Remove ${term.title || "term"}`} onClick={() => setTerms((current) => current && current.filter((_, i) => i !== index))}><Trash2 /></button>
          </div>
          <textarea className="fx-textarea" aria-label={`${term.title || "Term"} wording`} value={term.body} onChange={(event) => update(index, { body: event.target.value })} />
        </div>
      ))}
      {terms && (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="fx-btn" onClick={() => setTerms((current) => [...(current || []), { id: `term-${Date.now().toString(36)}`, title: "New term", body: "" }])}><Plus aria-hidden />Add a term</button>
          <span className="fx-spacer" />
          <button type="button" className="fx-btn fx-btn--primary" disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save terms"}</button>
        </div>
      )}
    </Panel>
  );
}
