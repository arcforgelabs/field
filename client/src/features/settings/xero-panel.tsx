// Settings > Integrations > Xero (#93, owners only): Connect Xero opens a
// 4-step wizard (xero-connect-wizard.tsx) that installs the owner's own Xero
// app, takes its credentials, sets up FIELD_SECRETS_KEY when it is missing,
// and connects. Then the screen says what Field creates in Xero for each
// invoice it issues. It shows this installation's real addresses and whether
// each secret is set; never a secret. Everyone else sees the status only.
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, KeyRound, Link2, Plug, Trash2, Unlink } from "lucide-react";
import { api } from "@/lib/api";
import type { XeroCodes, XeroCreateMode, XeroIntegration } from "@/lib/types";
import { useShell } from "@/components/shell/shell-context";
import { shortDate } from "@/lib/job-status";
import { XeroPushDialog } from "@/features/job/xero-invoice-status";
import { XeroConnectWizard } from "./xero-connect-wizard";

/** What the owner reads for a code from the callback (docs/XERO.md "When connecting fails"). */
const CALLBACK_MESSAGES: Record<string, string> = {
  XERO_STATE_INVALID: "That Xero sign-in was not started here, was used already, or took longer than 10 minutes. Press Connect again.",
  XERO_ACCESS_DENIED: "You cancelled at Xero. Nothing changed.",
  XERO_AUTHORISE_REFUSED: "Xero refused the sign-in. Check that the redirect address in your Xero app is exactly the one below.",
  XERO_NO_ORGANISATION: "No Xero organisation was connected. Press Connect again and choose one at Xero.",
  XERO_CLIENT_REJECTED: "Xero did not accept the app's client id and client secret. Check them under App credentials, then connect again.",
  XERO_CREDENTIALS_MISSING: "Enter the Xero app's client id and client secret under App credentials first.",
  SECRETS_KEY_MISSING: "FIELD_SECRETS_KEY is not set, so Field cannot store or read the Xero credentials.",
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
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [earlierDays, setEarlierDays] = useState(30);
  const [codes, setCodes] = useState<XeroCodes | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardClosed, setWizardClosed] = useState(false);

  async function load() {
    try {
      const res = await api.xeroIntegration();
      setData(res);
      setMode(res.settings.createMode);
      setAccount(res.settings.salesAccountCode);
      setTaxType(res.settings.taxType);
      setTenant(res.connection.organisations[0]?.tenantId || "");
      setError(null);
      // The organisation's own accounts and tax rates, for the lists.
      if (res.connection.status === "connected" && res.canManage) api.xeroCodes().then(setCodes).catch(() => setCodes(null));
      else setCodes(null);
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

  if (error) return <Section><div className="fx-notice fx-notice--bad" style={{ margin: 0 }}><span>{error}</span></div></Section>;
  if (!data) return <Section><p className="fx-dim" style={{ margin: 0 }}>Loading…</p></Section>;

  const { connection, credentials, settings, canManage } = data;
  const secretsReady = credentials.source !== null;
  const canConnect = canManage && data.secretsKey.configured && secretsReady && data.publicUrlConfigured;
  const stored = credentials.settings;
  const status = STATUS_LABEL[connection.status];
  const dirty = mode !== settings.createMode || account.trim() !== settings.salesAccountCode || taxType.trim().toUpperCase() !== settings.taxType;
  const connected = connection.status === "connected";
  // The wizard: opened with Connect Xero, and reopened by itself while a
  // setup is under way (after a republish, or after Xero's sign-in).
  const wizardActive = canManage && !wizardClosed && (wizardOpen || Boolean(data.setup?.step));
  const keyLine = data.secretsKey.configured ? `Encryption key: set${canManage && data.secretsKey.keyId ? ` (id ${data.secretsKey.keyId})` : ""}` : "Encryption key: not set";

  if (wizardActive) {
    return (
      <Section>
        {notice && <div className={`fx-notice ${notice.tone === "bad" ? "fx-notice--bad" : ""}`} role="status" style={{ margin: 0 }}><span>{notice.text}</span></div>}
        <XeroConnectWizard data={data} onChanged={load} busy={busy === "connect"} onConnect={connect} onClose={() => { setWizardOpen(false); setWizardClosed(true); }} />
      </Section>
    );
  }

  return (
    <Section>
      {!canManage && (
        <div className="fx-notice" role="note" style={{ margin: 0 }}>
          <span>Only an owner can change the Xero connection and its settings. You can see how it is set up.</span>
        </div>
      )}
      {canManage && !data.secretsKey.configured && (
        <div className="fx-notice fx-notice--bad" role="alert" style={{ margin: 0 }}>
          <span>{data.secretsKey.problem === "SECRETS_KEY_INVALID" ? "FIELD_SECRETS_KEY is too short to be a key" : data.secretsKey.problem === "SECRETS_KEY_PREVIOUS_INVALID" ? "FIELD_SECRETS_KEY_PREVIOUS holds a value that is too short to be a key" : "FIELD_SECRETS_KEY, the encryption key, is not set"}, so Field cannot store or read the Xero credentials and sign-in, and sends nothing to Xero. {connection.status === "disconnected" ? "Press Connect Xero: it makes the key in this browser and shows where to put it." : "Set it in the deployment's secrets and republish (docs/INTEGRATIONS.md)."}</span>
        </div>
      )}
      {!data.publicUrlConfigured && (
        <div className="fx-notice fx-notice--warn" role="note" style={{ margin: 0 }}>
          <span>Set <code>publicUrl</code>, this installation's public address, in Field's configuration (on Replit, in <code>FIELD_CONFIG_JSON</code>), then restart Field. Field builds the redirect address from it, and Connect stays off until it is set.</span>
        </div>
      )}
      {connection.codesMessage && (
        <div className="fx-notice fx-notice--warn" role="alert" style={{ margin: 0 }}>
          <span>{connection.codesMessage}</span>
        </div>
      )}
      {notice && <div className={`fx-notice ${notice.tone === "bad" ? "fx-notice--bad" : ""}`} role="status" style={{ margin: 0 }}><span>{notice.text}</span></div>}

      <div className="xero__card" aria-label="Connection">
        <div className="xero__row">
          <div style={{ minWidth: 0 }}>
            <div className="xero__title">
              <span className={`fx-status fx-status--${status.tone}`}>{status.text}</span>
              {connection.tenantName && connection.status !== "choose_organisation" && <b className="xero__org">{connection.tenantName}</b>}
            </div>
            <p className="fx-dim xero__meta">
              {!canManage ? <>{keyLine}. </> : null}
              {connected && connection.connectedAt ? `Connected ${shortDate(connection.connectedAt)}${connection.connectedBy ? ` by ${connection.connectedBy}` : ""}. Field refreshes the sign-in by itself.` : null}
              {connection.status === "needs_reconnect" ? connection.reconnectMessage : null}
              {connection.status === "disconnected" ? (canManage ? "Connect Xero walks you through it in four steps." : "An owner connects Xero.") : null}
            </p>
          </div>
          <div className="xero__actions">
            {canManage && connection.status === "disconnected" && (
              <button type="button" className="fx-btn fx-btn--primary" disabled={busy !== null} onClick={() => { setWizardClosed(false); setWizardOpen(true); }}><Plug aria-hidden />Connect Xero</button>
            )}
            {canManage && connection.status === "needs_reconnect" && (
              <button type="button" className="fx-btn fx-btn--primary" disabled={!canConnect || busy !== null} onClick={connect}><Link2 aria-hidden />{busy === "connect" ? "Opening Xero…" : "Connect again"}</button>
            )}
            {canManage && connection.status !== "disconnected" && (
              <button type="button" className="fx-btn" disabled={busy !== null} onClick={() => setConfirmDisconnect(true)}><Unlink aria-hidden />Disconnect</button>
            )}
          </div>
        </div>

        {canManage && connection.status === "choose_organisation" && (
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

      <div className="xero__card" role="group" aria-label="App credentials">
        <div className="xero__row">
          <div style={{ minWidth: 0 }}>
            <div className="xero__title"><b className="xero__org">App credentials</b></div>
            <p className="fx-dim xero__meta">The client id and client secret of your Xero app. Field stores them encrypted and never shows them again.{canManage ? ` ${keyLine}.` : ""}</p>
          </div>
          {canManage && !editing && (
            <div className="xero__actions">
              <button type="button" className="fx-btn" disabled={!data.secretsKey.configured || busy !== null} onClick={() => setEditing(true)}><KeyRound aria-hidden />{stored.clientId.set || stored.clientSecret.set ? "Replace" : "Enter credentials"}</button>
              {(stored.clientId.set || stored.clientSecret.set) && (
                <button type="button" className="fx-btn" disabled={busy !== null} onClick={() => setConfirmRemove(true)}><Trash2 aria-hidden />Remove</button>
              )}
            </div>
          )}
        </div>
        {credentials.environmentOverride && (
          <div className="fx-notice fx-notice--warn" role="note" style={{ margin: 0 }}>
            <span>XERO_CLIENT_ID and XERO_CLIENT_SECRET are set in the deployment environment, so Field uses those. Credentials saved here are kept but not used while they are set.</span>
          </div>
        )}
        <dl className="xero__creds">
          <CredentialState label="Client id" state={stored.clientId} />
          <CredentialState label="Client secret" state={stored.clientSecret} />
        </dl>
        {canManage && editing && (
          <form
            className="xero__credform"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void act("credentials", async () => {
                await api.setXeroCredentials({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
                setEditing(false);
                setClientId("");
                setClientSecret("");
              }, "Credentials saved.");
            }}
          >
            <div className="fx-grid2">
              <label className="fx-label">Client id
                <input className="fx-input" name="xero-client-id" autoComplete="off" spellCheck={false} value={clientId} onChange={(event) => setClientId(event.target.value)} />
              </label>
              <label className="fx-label">Client secret
                <input className="fx-input" type="password" name="xero-client-secret" autoComplete="new-password" spellCheck={false} value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span className="fx-spacer" />
              <button type="button" className="fx-btn fx-btn--ghost" onClick={() => { setEditing(false); setClientId(""); setClientSecret(""); }}>Cancel</button>
              <button type="submit" className="fx-btn fx-btn--primary" disabled={!clientId.trim() || !clientSecret.trim() || busy !== null}>{busy === "credentials" ? "Saving…" : "Save credentials"}</button>
            </div>
          </form>
        )}
        {data.history.length > 0 && (
          <details className="xero__history">
            <summary>Recent changes</summary>
            <ul>
              {data.history.map((event, index) => (
                <li key={`${event.at}-${index}`}><span>{HISTORY_LABEL[event.action] || event.action}</span> <span className="fx-dim">{event.actor ? `by ${event.actor} ` : ""}on {shortDate(event.at)}</span></li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <fieldset className="xero__group" aria-label="Create in Xero" disabled={!canManage}>
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

      <fieldset className="xero__group" aria-label="Codes" disabled={!canManage}>
        <legend className="xero__h">Account and tax</legend>
        {connected && codes && !codes.available && <p className="fx-dim xero__p">Field could not read your accounts and tax rates from Xero ({codes.code}), so type the codes. They are checked against Xero when Field can read it.</p>}
        <div className="fx-grid2">
          <label className="fx-label">Sales account
            {codes?.available ? (
              <select className="fx-select" value={account} onChange={(event) => setAccount(event.target.value)}>
                {!codes.accounts.some((option) => option.code === account) && <option value={account}>{account} (not an active revenue account in Xero)</option>}
                {codes.accounts.map((option) => <option key={option.code} value={option.code}>{option.code} · {option.name}</option>)}
              </select>
            ) : (
              <input className="fx-input" value={account} maxLength={10} aria-invalid={!/^[A-Za-z0-9._-]{1,10}$/.test(account.trim())} onChange={(event) => setAccount(event.target.value)} />
            )}
            <span className="fx-mute xero__hint">{codes?.available ? "Your active revenue accounts in Xero." : "The code of your sales account in Xero. 200 is “Sales” in Xero's standard chart."}</span>
          </label>
          <label className="fx-label">GST tax type
            {codes?.available ? (
              <select className="fx-select" value={taxType} onChange={(event) => setTaxType(event.target.value)}>
                {!codes.taxRates.some((option) => option.taxType === taxType) && <option value={taxType}>{taxType} (not an active sales tax rate in Xero)</option>}
                {codes.taxRates.map((option) => <option key={option.taxType} value={option.taxType}>{option.name} · {option.rate}%</option>)}
              </select>
            ) : (
              <input className="fx-input" value={taxType} maxLength={40} aria-invalid={!/^[A-Za-z0-9_]{1,40}$/.test(taxType.trim())} onChange={(event) => setTaxType(event.target.value)} />
            )}
            <span className="fx-mute xero__hint">{codes?.available ? "Your active tax rates for sales in Xero. Lines without GST use EXEMPTOUTPUT." : "Xero's code for GST on Income in Australia is OUTPUT. Lines without GST use EXEMPTOUTPUT."}</span>
          </label>
        </div>
        {canManage && <div style={{ display: "flex" }}>
          <span className="fx-spacer" />
          <button
            type="button"
            className="fx-btn fx-btn--primary"
            disabled={!dirty || busy !== null}
            onClick={() => act("save", async () => {
              const saved = await api.updateXeroSettings({ createMode: mode, salesAccountCode: account.trim(), taxType: taxType.trim().toUpperCase() });
              if (saved.settings.warning) setNotice({ tone: "bad", text: saved.settings.warning });
            }, "Saved.")}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>}
      </fieldset>

      {connected && canManage && (
        <fieldset className="xero__group" aria-label="Invoices issued before">
          <legend className="xero__h">Invoices issued before</legend>
          <p className="fx-dim xero__p">Invoices issued before Xero was connected, or while Create in Xero was off, are not sent by themselves. Preview them, then choose which to send{settings.createMode === "authorised" ? " as approved invoices" : " as drafts"}.</p>
          <div className="xero__row">
            <label className="fx-label" style={{ flex: "0 1 220px" }}>Issued in the last
              <select className="fx-select" value={earlierDays} onChange={(event) => setEarlierDays(Number(event.target.value))}>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>12 months</option>
              </select>
            </label>
            <button type="button" className="fx-btn" style={{ alignSelf: "flex-end" }} onClick={() => setPreviewing(true)}>Preview</button>
          </div>
        </fieldset>
      )}

      {previewing && (
        <XeroPushDialog
          sinceDays={earlierDays}
          onCancel={() => setPreviewing(false)}
          onSent={(count) => { setPreviewing(false); shell.toast(count ? `Sending ${count} to Xero` : "Nothing was sent"); }}
        />
      )}

      {confirmRemove && (
        <div className="fx-scrim" onMouseDown={() => setConfirmRemove(false)}>
          <div className="fx-dialog" role="dialog" aria-modal="true" aria-labelledby="xero-remove-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setConfirmRemove(false); }}>
            <div className="fx-dialog__h" id="xero-remove-title">Remove the Xero app's credentials?</div>
            <div className="fx-dialog__b">
              <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>Field forgets the client id and client secret{credentials.environmentOverride ? "" : ", and disconnects Xero"}. Invoices already in Xero stay there. You can enter them again later.</p>
            </div>
            <div className="fx-dialog__f">
              <button type="button" className="fx-btn fx-btn--ghost" autoFocus onClick={() => setConfirmRemove(false)}>Cancel</button>
              <button type="button" className="fx-btn fx-btn--danger" onClick={() => { setConfirmRemove(false); void act("remove", () => api.removeXeroCredentials(), "Credentials removed."); }}>Remove</button>
            </div>
          </div>
        </div>
      )}

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

const HISTORY_LABEL: Record<string, string> = {
  credentials_set: "Credentials entered",
  credentials_replaced: "Credentials replaced",
  credentials_removed: "Credentials removed",
  connected: "Connected",
  disconnected: "Disconnected",
  tokens_rewrapped: "Sign-in re-encrypted",
  tokens_unreadable: "Sign-in could not be read",
  setup_step: "Connect wizard step finished",
  secrets_key_generated: "Encryption key generated in the browser",
  pending_credentials_stored: "Credentials saved, waiting for the key",
  pending_credentials_promoted: "Credentials stored with the key",
  pending_credentials_discarded: "Wizard started again",
};

function CredentialState({ label, state }: { label: string; state: { set: boolean; setAt: string | null; setBy: string | null } }) {
  return (
    <div className="xero__cred">
      <dt>{label}</dt>
      <dd>
        {state.set
          ? <><span className="fx-status fx-status--paid">Set</span> <span className="fx-dim">last changed{state.setBy ? ` by ${state.setBy}` : ""}{state.setAt ? ` on ${shortDate(state.setAt)}` : ""}</span></>
          : <span className="fx-status fx-status--draft">Not set</span>}
      </dd>
    </div>
  );
}
