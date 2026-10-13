// Settings > Integrations > Xero > Connect Xero: a 4-step wizard for owners.
//
//   1. Create your Xero app: every value to type into Xero, with Copy.
//   2. Paste what Xero gave you: the client id and the client secret.
//   3. Your encryption key, only while FIELD_SECRETS_KEY is not usable: this
//      browser generates the key (crypto.getRandomValues), shows it once, and
//      encrypts the client id and secret with it (shared/secrets-web.js) before
//      anything is sent. The server stores only those encrypted values, as
//      pending credentials, until the owner republishes with the key.
//   4. Connect: Xero's sign-in, the organisation, and draft or approved.
//
// The key lives only in this component's memory while it is on screen. It is
// never sent, stored in the browser, put in the address, logged or given to
// Sentry: its element is inside `sentry-block`, so a session replay never
// records it, and the "Report a problem" button is hidden while it shows.
// The wizard's place survives a republish on the server (integration_setup);
// the key never does.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, Copy, ExternalLink, KeyRound, Link2, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/api";
import type { XeroCreateMode, XeroIntegration } from "@/lib/types";
import { useShell } from "@/components/shell/shell-context";
import { generateSecretsKey, sealForServer, wipe } from "../../../../shared/secrets-web.js";
import { HostChoices } from "./secret-hosts";
import { resumeStep, SECRET_ON_SCREEN, type WizardStep } from "./xero-wizard-model";

const XERO_APPS = "https://developer.xero.com/app/manage";

const CLIENT_ID_USUAL = /^[0-9A-Fa-f]{32}$/;
const CLIENT_SECRET_USUAL = /^[A-Za-z0-9_-]{48}$/;
const PASTED = /^\S{8,200}$/;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function XeroConnectWizard({ data, onChanged, onClose, onConnect, busy }: {
  data: XeroIntegration;
  /** Load the screen again from the server. */
  onChanged: () => Promise<void>;
  onClose: () => void;
  /** Start Xero's sign-in (the panel's Connect). */
  onConnect: () => void;
  busy: boolean;
}) {
  const shell = useShell();
  const serverStep = resumeStep(data);
  const [localStep, setLocalStep] = useState<WizardStep | null>(null);
  const step = localStep ?? serverStep;
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [keyText, setKeyText] = useState<string | null>(null);
  const keyBytes = useRef<Uint8Array | null>(null);
  const keyCopied = useRef(false);
  const [saved, setSaved] = useState(false);
  const [keyDone, setKeyDone] = useState(false);
  const [mode, setMode] = useState<XeroCreateMode>(data.settings.createMode === "authorised" ? "authorised" : "draft");
  const [tenant, setTenant] = useState(data.connection.organisations[0]?.tenantId || "");

  const keyReady = data.secretsKey.configured;
  const override = data.credentials.environmentOverride;
  const credentialsInMemory = Boolean(clientId && clientSecret);

  // Forget the key: wipe its bytes, drop the text, show the Report button again.
  function forgetKey() {
    wipe(keyBytes.current);
    keyBytes.current = null;
    setKeyText(null);
    setSaved(false);
  }

  useEffect(() => {
    if (keyText) document.documentElement.setAttribute(SECRET_ON_SCREEN, "");
    else document.documentElement.removeAttribute(SECRET_ON_SCREEN);
  }, [keyText]);

  // Leaving the wizard forgets the key and the pasted credentials.
  useEffect(() => () => {
    wipe(keyBytes.current);
    keyBytes.current = null;
    document.documentElement.removeAttribute(SECRET_ON_SCREEN);
  }, []);

  async function run(action: () => Promise<void>, fallback: string) {
    setWorking(true);
    setProblem(null);
    try {
      await action();
    } catch (err) {
      setProblem(errorText(err, fallback));
    } finally {
      setWorking(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      if (text === keyText) keyCopied.current = true;
      shell.toast(`${what} copied.`);
    } catch {
      shell.toast("Select it and copy it.");
    }
  }

  const finishApp = () => run(async () => {
    await api.xeroSetupStep("app");
    await onChanged();
    setLocalStep(override ? (keyReady ? 4 : 3) : 2);
  }, "That did not save. Try again.");

  const finishCredentials = () => run(async () => {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (keyReady) {
      // The deployment has the key: the server encrypts them, as Replace does.
      await api.setXeroCredentials({ clientId: id, clientSecret: secret });
      await api.xeroSetupStep("credentials");
      setClientId("");
      setClientSecret("");
      await onChanged();
      setLocalStep(4);
    } else {
      // No key yet: keep them in this browser until step 3 encrypts them.
      setClientId(id);
      setClientSecret(secret);
      await api.xeroSetupStep("credentials");
      setLocalStep(3);
    }
  }, "The credentials did not save. Try again.");

  function generate() {
    forgetKey();
    const made = generateSecretsKey();
    keyBytes.current = made.bytes;
    setKeyText(made.text);
    // An audit event only: who and when. No body, so nothing of the key.
    api.secretsKeyGenerated().catch(() => setProblem("Field could not record that a key was made. The key still works."));
  }

  const saveWithKey = () => run(async () => {
    const bytes = keyBytes.current;
    if (!bytes || !data.setup?.orgUid) throw new Error("Generate the key first.");
    if (credentialsInMemory) {
      const sealed = await sealForServer({ keyBytes: bytes, orgUid: data.setup.orgUid, integration: "xero", values: { client_id: clientId, client_secret: clientSecret } });
      await api.storeXeroPendingCredentials({ keyId: sealed.keyId, clientId: sealed.values.client_id, clientSecret: sealed.values.client_secret });
    }
    forgetKey();
    setClientId("");
    setClientSecret("");
    setKeyDone(true);
    // Copy left the key on the clipboard: replace it with nothing, if the
    // browser allows. A refusal is fine: the docs say to clear it by hand.
    if (keyCopied.current) {
      keyCopied.current = false;
      try {
        void navigator.clipboard?.writeText("")?.catch(() => {});
      } catch {
        // No clipboard access: nothing to do.
      }
    }
    await onChanged();
    setLocalStep(null);
  }, "The credentials did not save. Try again.");

  const startAgain = () => run(async () => {
    forgetKey();
    setKeyDone(false);
    await api.discardXeroPendingCredentials();
    await onChanged();
    setLocalStep(2);
  }, "That did not work. Try again.");

  const chooseOrganisation = () => run(async () => {
    await api.chooseXeroOrganisation(tenant);
    await onChanged();
  }, "Choosing the organisation did not work. Try again.");

  const finish = () => run(async () => {
    if (mode !== data.settings.createMode) await api.updateXeroSettings({ createMode: mode });
    await api.xeroSetupStep("done");
    shell.toast(`Connected to ${data.connection.tenantName || "Xero"}.`);
    await onChanged();
  }, "That did not save. Try again.");

  const stepNames: Array<{ n: WizardStep; label: string; skipped: boolean }> = [
    { n: 1, label: "Create your Xero app", skipped: false },
    { n: 2, label: "Paste what Xero gave you", skipped: override },
    { n: 3, label: "Your encryption key", skipped: keyReady && !data.setup?.pending },
    { n: 4, label: "Connect", skipped: false },
  ];

  return (
    <div className="xero__card xwiz" role="group" aria-label="Connect Xero">
      <div className="xero__row">
        <div className="xero__title"><b className="xero__org">Connect Xero</b></div>
        <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => { forgetKey(); onClose(); }}><X aria-hidden />Close</button>
      </div>
      <ol className="xwiz__steps" aria-label="Steps">
        {stepNames.map((entry) => (
          <li key={entry.n} className="xwiz__stepname" data-state={entry.n === step ? "current" : entry.skipped ? "skipped" : entry.n < step ? "done" : "todo"} aria-current={entry.n === step ? "step" : undefined}>
            <span className="xwiz__num" aria-hidden>{entry.n < step && !entry.skipped ? <Check /> : entry.n}</span>
            <span>{entry.label}{entry.skipped ? <small> · not needed</small> : null}</span>
          </li>
        ))}
      </ol>

      {problem && <div className="fx-notice fx-notice--bad" role="alert" style={{ margin: 0 }}><span>{problem}</span></div>}

      {step === 1 && (
        <Panel title="1. Create your Xero app" lead="Field connects through an app that belongs to you. Type these values into Xero exactly as shown.">
          <ol className="xwiz__list">
            <li>Open <a href={XERO_APPS} target="_blank" rel="noreferrer" className="xero__link">developer.xero.com/app/manage<ExternalLink aria-hidden /></a> and sign in with your Xero login.</li>
            <li>Press <b>New app</b>.</li>
            <li>App name: <CopyValue value="Field" what="App name" onCopy={copy} /></li>
            <li>Integration type: choose <b>Web app</b>.</li>
            <li>Company or application URL: {data.appUrl ? <CopyValue value={data.appUrl} what="Address" onCopy={copy} /> : <Missing />}</li>
            <li>Redirect URI: {data.redirectUri ? <CopyValue value={data.redirectUri} what="Redirect URI" onCopy={copy} /> : <Missing />}</li>
            <li>Tick the terms, then press <b>Create app</b>.</li>
          </ol>
          <More>
            <p>If Xero asks which permissions (scopes) the app needs, give these. Field asks for them when you connect:</p>
            <CopyValue value={data.scopes.join(" ")} what="Scopes" onCopy={copy} />
            <p>Choose Web app because Field keeps the client secret on its server and uses Xero's standard OAuth sign-in (the authorization code flow). Do not choose a mobile or desktop app, or a custom connection.</p>
            <p>The redirect URI comes from <code>publicUrl</code> in Field's configuration, never from the address a request came to. A new Xero app starts on Xero's free Starter plan, which allows this one connection.</p>
          </More>
          {!data.publicUrlConfigured && <p className="xero__warn" role="note">Field does not know its own address yet. Set <code>publicUrl</code> in Field's configuration (on Replit, in <code>FIELD_CONFIG_JSON</code>), then republish.</p>}
          <Actions>
            <button type="button" className="fx-btn fx-btn--primary" disabled={!data.publicUrlConfigured || working} onClick={finishApp}>Next</button>
          </Actions>
        </Panel>
      )}

      {step === 2 && (
        <Panel title="2. Paste what Xero gave you" lead="In your Xero app, open Configuration. Copy the client id. Press Generate a secret and copy it: Xero shows it only once.">
          <form className="xero__credform" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void finishCredentials(); }}>
            <div className="fx-grid2">
              <label className="fx-label">Client id
                <input className="fx-input" autoComplete="off" spellCheck={false} value={clientId} aria-invalid={Boolean(clientId) && !PASTED.test(clientId.trim())} onChange={(event) => setClientId(event.target.value)} />
                <FormatHint value={clientId} usual={CLIENT_ID_USUAL} text="A Xero client id is usually 32 letters and numbers. Check that you copied all of it." />
              </label>
              <label className="fx-label">Client secret
                <input className="fx-input" type="password" autoComplete="new-password" spellCheck={false} value={clientSecret} aria-invalid={Boolean(clientSecret) && !PASTED.test(clientSecret.trim())} onChange={(event) => setClientSecret(event.target.value)} />
                <FormatHint value={clientSecret} usual={CLIENT_SECRET_USUAL} text="A Xero client secret is usually 48 characters. Check that you copied all of it." />
              </label>
            </div>
            <More>
              <p>Field stores them encrypted and never shows them again.{keyReady ? "" : " Field has no encryption key yet, so the next step makes one in this browser and encrypts them before they are sent."}</p>
            </More>
            <Actions>
              <button type="button" className="fx-btn fx-btn--ghost" onClick={() => setLocalStep(1)}><ChevronLeft aria-hidden />Back</button>
              <button type="submit" className="fx-btn fx-btn--primary" disabled={!PASTED.test(clientId.trim()) || !PASTED.test(clientSecret.trim()) || working}>{working ? "Saving…" : "Next"}</button>
            </Actions>
          </form>
        </Panel>
      )}

      {step === 3 && (
        <Panel title="3. Your encryption key" lead="Field encrypts the Xero credentials with a key that only your deployment holds.">
          {data.setup?.problem === "PENDING_KEY_MISMATCH" || data.setup?.problem === "PENDING_UNREADABLE" ? (
            <>
              <div className="fx-notice fx-notice--bad" role="alert" style={{ margin: 0 }}>
                <span>{data.setup.problem === "PENDING_KEY_MISMATCH"
                  ? "The key in Replit is not the one generated here; generate again or paste the right key."
                  : "The saved credentials do not open with the key in Replit. Paste the right key, or start again."}</span>
              </div>
              <More>
                <p>Paste the key you saved into FIELD_SECRETS_KEY and republish, and Field goes on by itself. Or start again: you paste the client id and secret again, and Field encrypts them with the key Replit has now.</p>
              </More>
              <Actions>
                <button type="button" className="fx-btn fx-btn--primary" disabled={working} onClick={startAgain}><RotateCcw aria-hidden />Start again</button>
              </Actions>
            </>
          ) : data.setup?.pending || keyDone ? (
            <>
              <div className="fx-notice" role="status" style={{ margin: 0 }}>
                <span>{data.secretsKey.problem === "SECRETS_KEY_INVALID"
                  ? "The FIELD_SECRETS_KEY in Replit is not a usable key. Paste the key exactly as it was shown, then republish."
                  : "Waiting for the key. Add it where Field runs, then republish or restart Field. When Field is back, open this page: the wizard goes on at step 4."}</span>
              </div>
              <HostChoices onCopy={copy} />
              <More>
                <p>The key is no longer on this screen. If you lost it before you saved it, start again.</p>
              </More>
              <Actions>
                <button type="button" className="fx-btn" disabled={working} onClick={startAgain}><RotateCcw aria-hidden />Start again</button>
              </Actions>
            </>
          ) : data.secretsKey.problem === "SECRETS_KEY_PREVIOUS_INVALID" ? (
            <>
              <div className="fx-notice fx-notice--bad" role="alert" style={{ margin: 0 }}>
                <span>Your previous key setting is wrong: fix FIELD_SECRETS_KEY_PREVIOUS.</span>
              </div>
              <More>
                <p>FIELD_SECRETS_KEY works, but a value in FIELD_SECRETS_KEY_PREVIOUS is too short to be a key. Correct it or remove it where Field runs, then republish or restart Field. Field does not make a new key here, so the key that works is never replaced.</p>
              </More>
            </>
          ) : (
            <>
              {data.secretsKey.problem === "SECRETS_KEY_INVALID" && !keyText && (
                <div className="fx-notice fx-notice--warn" role="note" style={{ margin: 0 }}>
                  <span>The FIELD_SECRETS_KEY set now cannot be used: it is too short to be a key. Generate a key here and put it in place of the current value.</span>
                </div>
              )}
              {!keyText ? (
                <Actions>
                  {!override && <button type="button" className="fx-btn fx-btn--ghost" onClick={() => setLocalStep(2)}><ChevronLeft aria-hidden />Back</button>}
                  <button type="button" className="fx-btn fx-btn--primary" disabled={working || (!override && !credentialsInMemory)} onClick={generate}><KeyRound aria-hidden />Generate key</button>
                </Actions>
              ) : (
                <>
                  <div className="xwiz__key sentry-block" data-sentry-block="">
                    <label className="fx-label">Your key (shown once)
                      <input className="fx-input xwiz__keytext" readOnly value={keyText} autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
                    </label>
                    <button type="button" className="fx-btn fx-btn--sm" onClick={() => copy(keyText, "Key")}><Copy aria-hidden />Copy</button>
                  </div>
                  <p className="xero__p">Save the key in your password manager too. Without it, the stored credentials cannot be read.</p>
                  <HostChoices onCopy={copy} />
                  <label className="fx-choice">
                    <input type="checkbox" className="fx-checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
                    <span>I added the key where Field runs and saved it in my password manager.</span>
                  </label>
                  <More>
                    <p>This browser made the key with its own random number generator. It is never sent to Field's server, stored in this browser, or shown again. {credentialsInMemory ? "The client id and secret are encrypted with it here, and only the encrypted values are sent." : ""}</p>
                  </More>
                  <Actions>
                    <button type="button" className="fx-btn fx-btn--ghost" disabled={working} onClick={generate}><RotateCcw aria-hidden />Generate again</button>
                    <button type="button" className="fx-btn fx-btn--primary" disabled={!saved || working} onClick={saveWithKey}>{working ? "Saving…" : "Done"}</button>
                  </Actions>
                </>
              )}
              {!override && !credentialsInMemory && !keyText && <p className="fx-dim xero__p">Go back and paste the client id and secret first.</p>}
            </>
          )}
        </Panel>
      )}

      {step === 4 && (
        <Panel title="4. Connect" lead={data.connection.status === "connected" ? "" : "Sign in to Xero and allow Field to reach your organisation."}>
          {data.connection.status === "connected" ? (
            <>
              <div className="fx-notice" role="status" style={{ margin: 0 }}><span><b>Connected to {data.connection.tenantName || "Xero"}.</b></span></div>
              <fieldset className="xero__group" aria-label="What Field creates in Xero">
                <legend className="xero__h">For each invoice Field issues, create in Xero</legend>
                <div className="fx-choices">
                  {data.choices.createMode.filter((choice) => choice.value !== "off").map((choice) => (
                    <label key={choice.value} className="fx-choice">
                      <input type="radio" className="fx-radio" name="xwiz-create-mode" value={choice.value} checked={mode === choice.value} onChange={() => setMode(choice.value)} />
                      <span><b>{choice.label}</b><small>{choice.description}</small></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Actions>
                <button type="button" className="fx-btn fx-btn--primary" disabled={working} onClick={finish}><Check aria-hidden />Done</button>
              </Actions>
            </>
          ) : data.connection.status === "choose_organisation" ? (
            <fieldset className="xero__choose" aria-label="Xero organisation">
              <legend className="fx-dim">Your Xero sign-in reaches more than one organisation. Choose the one Field writes to.</legend>
              <div className="fx-choices">
                {data.connection.organisations.map((organisation) => (
                  <label key={organisation.tenantId} className="fx-choice">
                    <input type="radio" className="fx-radio" name="xwiz-tenant" value={organisation.tenantId} checked={tenant === organisation.tenantId} onChange={() => setTenant(organisation.tenantId)} />
                    <span><b>{organisation.tenantName}</b></span>
                  </label>
                ))}
              </div>
              <Actions><button type="button" className="fx-btn fx-btn--primary" disabled={!tenant || working} onClick={chooseOrganisation}><Check aria-hidden />Use this organisation</button></Actions>
            </fieldset>
          ) : (
            <>
              <More>
                <p>Field sends you to Xero's OAuth sign-in. Xero sends you back to the redirect URI from step 1, and Field stores the sign-in encrypted.</p>
              </More>
              <Actions>
                <button type="button" className="fx-btn fx-btn--ghost" onClick={() => setLocalStep(1)}><ChevronLeft aria-hidden />Back to step 1</button>
                <button type="button" className="fx-btn fx-btn--primary" disabled={busy || working || !data.publicUrlConfigured || !keyReady || !data.credentials.source} onClick={onConnect}><Link2 aria-hidden />{busy ? "Opening Xero…" : "Connect to Xero"}</button>
              </Actions>
            </>
          )}
        </Panel>
      )}
    </div>
  );
}

function Panel({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="xwiz__panel" aria-label={title}>
      <h3 className="xero__h">{title}</h3>
      {lead && <p className="fx-dim xero__p">{lead}</p>}
      {children}
    </section>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="xwiz__actions">{children}</div>;
}

function More({ children }: { children: ReactNode }) {
  return (
    <details className="xero__history xwiz__more">
      <summary>More detail</summary>
      <div className="xwiz__morebody">{children}</div>
    </details>
  );
}

function Missing() {
  return <span className="xero__warn">Not known yet (set publicUrl first)</span>;
}

function CopyValue({ value, what, onCopy }: { value: string; what: string; onCopy: (text: string, what: string) => void }) {
  return (
    <span className="xero__copy">
      <code>{value}</code>
      <button type="button" className="fx-btn fx-btn--sm" onClick={() => onCopy(value, what)}><Copy aria-hidden />Copy</button>
    </span>
  );
}

function FormatHint({ value, usual, text }: { value: string; usual: RegExp; text: string }) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!PASTED.test(trimmed)) return <span className="xero__warn">Paste the whole value, with no spaces.</span>;
  if (!usual.test(trimmed)) return <span className="fx-mute xero__hint">{text}</span>;
  return null;
}
