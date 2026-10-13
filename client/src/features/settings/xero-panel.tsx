// Settings > Integrations > Xero (#93, owners only): install the owner's own
// Xero app, connect it, choose the organisation, and say what Field creates
// in Xero for each invoice it issues. The screen shows this installation's
// real redirect address and whether each secret is set; never a secret.
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, ChevronDown, Copy, ExternalLink, Link2, Unlink } from "lucide-react";
import { api } from "@/lib/api";
import type { XeroCreateMode, XeroIntegration } from "@/lib/types";
import { useShell } from "@/components/shell/shell-context";
import { shortDate } from "@/lib/job-status";

/** What the owner reads for a code from the callback (docs/XERO.md "When connecting fails"). */
const CALLBACK_MESSAGES: Record<string, string> = {
  XERO_STATE_INVALID: "That Xero sign-in was not started here, was used already, or took longer than 10 minutes. Press Connect again.",
  XERO_ACCESS_DENIED: "You cancelled at Xero. Nothing changed.",
  XERO_AUTHORISE_REFUSED: "Xero refused the sign-in. Check that the redirect address in your Xero app is exactly the one below.",
  XERO_NO_ORGANISATION: "No Xero organisation was connected. Press Connect again and choose one at Xero.",
  XERO_CLIENT_REJECTED: "Xero did not accept XERO_CLIENT_ID and XERO_CLIENT_SECRET. Check both secrets, restart Field, then connect again.",
  XERO_SECRETS_MISSING: "Set XERO_CLIENT_ID and XERO_CLIENT_SECRET first.",
  XERO_NO_DATABASE: "Xero needs the database, which this server does not have.",
};

const STATUS_LABEL: Record<XeroIntegration["connection"]["status"], { text: string; tone: string }> = {
  connected: { text: "Connected", tone: "paid" },
  choose_organisation: { text: "Choose an organisation", tone: "invoicing" },
  needs_reconnect: { text: "Connect again", tone: "overdue" },
  disconnected: { text: "Not connected", tone: "draft" },
};

export function XeroPanel() {
  const shell = useShell();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<XeroIntegration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<XeroCreateMode>("draft");
  const [account, setAccount] = useState("");
  const [taxType, setTaxType] = useState("");
  const [tenant, setTenant] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  async function load() {
    try {
      const res = await api.xeroIntegration();
      setData(res);
      setMode(res.settings.createMode);
      setAccount(res.settings.salesAccountCode);
      setTaxType(res.settings.taxType);
      setTenant(res.connection.organisations[0]?.tenantId || "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Xero settings could not be loaded.");
    }
  }

  useEffect(() => {
    void load();
    // The callback came back here: say how it went, once.
    const outcome = params.get("xero");
    if (outcome) {
      const code = params.get("code") || "";
      if (outcome === "connected") setNotice({ tone: "ok", text: "Xero is connected." });
      else if (outcome === "choose") setNotice({ tone: "ok", text: "Xero is signed in. Choose the organisation Field writes to." });
      else setNotice({ tone: "bad", text: CALLBACK_MESSAGES[code] || `Connecting to Xero did not work (${code || "unknown"}). Try again.` });
      const next = new URLSearchParams(params);
      next.delete("xero");
      next.delete("code");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(label: string, action: () => Promise<unknown>, success?: string) {
    setBusy(label);
    setNotice(null);
    try {
      await action();
      if (success) shell.toast(success);
      await load();
    } catch (err) {
      setNotice({ tone: "bad", text: err instanceof Error ? err.message : "That did not work." });
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    setBusy("connect");
    setNotice(null);
    try {
      const { url } = await api.connectXero();
      window.location.assign(url);
    } catch (err) {
      setNotice({ tone: "bad", text: err instanceof Error ? err.message : "Connecting to Xero did not start." });
      setBusy(null);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      shell.toast("Copied.");
    } catch {
      shell.toast("Select the address and copy it.");
    }
  }

  if (error) return <Section><div className="fx-notice fx-notice--bad" style={{ margin: 0 }}><span>{error}</span></div></Section>;
  if (!data) return <Section><p className="fx-dim" style={{ margin: 0 }}>Loading…</p></Section>;

  const { connection, secrets, settings } = data;
  const secretsReady = secrets.clientIdSet && secrets.clientSecretSet;
  const status = STATUS_LABEL[connection.status];
  const dirty = mode !== settings.createMode || account.trim() !== settings.salesAccountCode || taxType.trim().toUpperCase() !== settings.taxType;
  const connected = connection.status === "connected";

  return (
    <Section>
      {notice && <div className={`fx-notice ${notice.tone === "bad" ? "fx-notice--bad" : ""}`} role="status" style={{ margin: 0 }}><span>{notice.text}</span></div>}

      <div className="xero__card" aria-label="Connection">
        <div className="xero__row">
          <div style={{ minWidth: 0 }}>
            <div className="xero__title">
              <span className={`fx-status fx-status--${status.tone}`}>{status.text}</span>
              {connection.tenantName && connection.status !== "choose_organisation" && <b className="xero__org">{connection.tenantName}</b>}
            </div>
            <p className="fx-dim xero__meta">
              {connected && connection.connectedAt ? `Connected ${shortDate(connection.connectedAt)}${connection.connectedBy ? ` by ${connection.connectedBy}` : ""}. Field refreshes the sign-in by itself.` : null}
              {connection.status === "needs_reconnect" ? connection.reconnectMessage : null}
              {connection.status === "disconnected" ? (secretsReady ? "Connect to choose the Xero organisation Field writes to." : "Set up your Xero app first (below).") : null}
            </p>
          </div>
          <div className="xero__actions">
            {(connection.status === "disconnected" || connection.status === "needs_reconnect") && (
              <button type="button" className="fx-btn fx-btn--primary" disabled={!secretsReady || busy !== null} onClick={connect}><Link2 aria-hidden />{busy === "connect" ? "Opening Xero…" : connection.status === "needs_reconnect" ? "Connect again" : "Connect to Xero"}</button>
            )}
            {connection.status !== "disconnected" && (
              <button type="button" className="fx-btn" disabled={busy !== null} onClick={() => setConfirmDisconnect(true)}><Unlink aria-hidden />Disconnect</button>
            )}
          </div>
        </div>

        {connection.status === "choose_organisation" && (
          <fieldset className="xero__choose" aria-label="Xero organisation">
            <legend className="fx-dim">Your Xero sign-in reaches more than one organisation. Choose the one Field writes to.</legend>
            <div className="fx-choices">
              {connection.organisations.map((organisation) => (
                <label key={organisation.tenantId} className="fx-choice">
                  <input type="radio" className="fx-radio" name="xero-tenant" value={organisation.tenantId} checked={tenant === organisation.tenantId} onChange={() => setTenant(organisation.tenantId)} />
                  <span><b>{organisation.tenantName}</b></span>
                </label>
              ))}
            </div>
            <div><button type="button" className="fx-btn fx-btn--primary" disabled={!tenant || busy !== null} onClick={() => act("choose", () => api.chooseXeroOrganisation(tenant), "Xero is connected.")}><Check aria-hidden />Use this organisation</button></div>
          </fieldset>
        )}
      </div>

      <fieldset className="xero__group" aria-label="Create in Xero">
        <legend className="xero__h">Create in Xero</legend>
        <p className="fx-dim xero__p">For every invoice Field issues from now on. Invoices issued before are sent only when you choose to.</p>
        <div className="fx-choices">
          {data.choices.createMode.map((choice) => (
            <label key={choice.value} className="fx-choice">
              <input type="radio" className="fx-radio" name="xero-create-mode" value={choice.value} checked={mode === choice.value} onChange={() => setMode(choice.value)} />
              <span><b>{choice.label}</b><small>{choice.description}</small></span>
            </label>
          ))}
        </div>
        <p className="fx-mute xero__p">Email from Xero is coming later. Customers get Field's own invoice email.</p>
      </fieldset>

      <fieldset className="xero__group" aria-label="Codes">
        <legend className="xero__h">Account and tax</legend>
        <div className="fx-grid2">
          <label className="fx-label">Sales account code
            <input className="fx-input" value={account} maxLength={10} aria-invalid={!/^[A-Za-z0-9._-]{1,10}$/.test(account.trim())} onChange={(event) => setAccount(event.target.value)} />
            <span className="fx-mute xero__hint">The code of your sales account in Xero. 200 is “Sales” in Xero's standard chart.</span>
          </label>
          <label className="fx-label">GST tax type
            <input className="fx-input" value={taxType} maxLength={40} aria-invalid={!/^[A-Za-z0-9_]{1,40}$/.test(taxType.trim())} onChange={(event) => setTaxType(event.target.value)} />
            <span className="fx-mute xero__hint">Xero's code for GST on Income in Australia is OUTPUT. Lines without GST use EXEMPTOUTPUT.</span>
          </label>
        </div>
        <div style={{ display: "flex" }}>
          <span className="fx-spacer" />
          <button
            type="button"
            className="fx-btn fx-btn--primary"
            disabled={!dirty || busy !== null}
            onClick={() => act("save", () => api.updateXeroSettings({ createMode: mode, salesAccountCode: account.trim(), taxType: taxType.trim().toUpperCase() }), "Saved.")}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </fieldset>

      <SetupSteps data={data} open={!secretsReady || connection.status === "disconnected"} onCopy={copy} />

      {confirmDisconnect && (
        <div className="fx-scrim" onMouseDown={() => setConfirmDisconnect(false)}>
          <div className="fx-dialog" role="dialog" aria-modal="true" aria-labelledby="xero-disconnect-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setConfirmDisconnect(false); }}>
            <div className="fx-dialog__h" id="xero-disconnect-title">Disconnect Xero?</div>
            <div className="fx-dialog__b">
              <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>Field stops creating invoices in {connection.tenantName || "Xero"} and forgets its sign-in. Invoices already in Xero stay there. Your settings are kept.</p>
            </div>
            <div className="fx-dialog__f">
              <button type="button" className="fx-btn fx-btn--ghost" autoFocus onClick={() => setConfirmDisconnect(false)}>Cancel</button>
              <button type="button" className="fx-btn fx-btn--danger" onClick={() => { setConfirmDisconnect(false); void act("disconnect", () => api.disconnectXero(), "Xero is disconnected."); }}>Disconnect</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <section className="fx-set__section xero" aria-label="Xero">
      <div>
        <h2 className="fx-set__h">Xero</h2>
        <p className="fx-set__p">Field creates a matching invoice in your own Xero organisation for every invoice it issues, so your books stay up to date without typing invoices twice.</p>
      </div>
      {children}
    </section>
  );
}

function SetupSteps({ data, open, onCopy }: { data: XeroIntegration; open: boolean; onCopy: (text: string) => void }) {
  const [expanded, setExpanded] = useState(open);
  const { secrets, redirectUri } = data;
  return (
    <div className="fx-acc">
      <div className="fx-acc__item">
        <button type="button" className="fx-acc__trigger" aria-expanded={expanded} aria-controls="xero-setup" onClick={() => setExpanded((value) => !value)}>
          Set up your Xero app <ChevronDown aria-hidden />
        </button>
        <div className="fx-acc__panel" id="xero-setup" data-open={expanded}>
          <div>
            <div className="fx-acc__body xero__steps">
              <p style={{ margin: "0 0 10px" }}>Field connects through a Xero app that you create, so your Xero sign-in stays with your installation.</p>
              <ol>
                <li>Sign in at <a href="https://developer.xero.com/app/manage" target="_blank" rel="noreferrer" className="xero__link">developer.xero.com/app/manage<ExternalLink aria-hidden /></a> with your Xero login, and create a new app.</li>
                <li>Choose <b>Web app</b>, the authorization code flow (not PKCE, and not a custom connection). Give it a name, for example “Field”, and your company's website.</li>
                <li>
                  Paste this installation's redirect address:
                  <div className="xero__copy">
                    <code>{redirectUri || "unknown: set publicUrl"}</code>
                    {redirectUri && <button type="button" className="fx-btn fx-btn--sm" onClick={() => onCopy(redirectUri)}><Copy aria-hidden />Copy</button>}
                  </div>
                  {!data.publicUrlConfigured && <span className="xero__warn">Field's public address (publicUrl) is not configured, so this is the address you opened Field at. Set publicUrl so it never changes.</span>}
                </li>
                <li>In the app's configuration, copy the client id and generate a client secret. Xero shows the secret once.</li>
                <li>
                  Add both as deployment secrets (Replit: Secrets), then restart Field:
                  <ul className="xero__secrets">
                    <li><code>XERO_CLIENT_ID</code> <SecretState set={secrets.clientIdSet} /></li>
                    <li><code>XERO_CLIENT_SECRET</code> <SecretState set={secrets.clientSecretSet} /></li>
                  </ul>
                </li>
                <li>Press <b>Connect to Xero</b> above, sign in, and allow access for your organisation.</li>
              </ol>
              <p className="fx-mute" style={{ margin: "10px 0 0" }}>Field asks Xero for: {data.scopes.join(", ")}. A new Xero app starts on Xero's free Starter plan, which allows this one connection.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SecretState({ set }: { set: boolean }) {
  return set
    ? <span className="fx-status fx-status--paid">Set</span>
    : <span className="fx-status fx-status--overdue">Not set</span>;
}
