// Where FIELD_SECRETS_KEY goes (Connect Xero wizard, step 3): the hosts in
// SECRET_HOSTS (xero-wizard-model.ts) as icon buttons, each with its steps
// and a setup prompt that names the secret, never its value.
import { useState } from "react";
import { Copy, MessageSquareText } from "lucide-react";
import { SECRET_HOSTS, SECRET_NAME, type SecretHost } from "./xero-wizard-model";

/** "Where does this go?": the hosts as icon buttons, collapsed until opened. */
export function HostChoices({ onCopy, hosts = SECRET_HOSTS }: { onCopy: (text: string, what: string) => void; hosts?: SecretHost[] }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const host = hosts.find((entry) => entry.id === chosen) || null;
  return (
    <details className="xero__history xwiz__more xwiz__hosts">
      <summary>Where does this go?</summary>
      <div className="xwiz__morebody">
        <div className="xwiz__hostrow" role="group" aria-label="Where Field runs">
          {hosts.map((entry) => (
            <button key={entry.id} type="button" className="fx-btn fx-btn--sm xwiz__host" aria-pressed={chosen === entry.id} onClick={() => setChosen(entry.id)}>
              <entry.Icon aria-hidden />{entry.label}
            </button>
          ))}
        </div>
        {host && (
          <div className="xwiz__hoststeps" data-host={host.id}>
            {host.path && (
              <p className="xwiz__path" aria-label={`In ${host.label}`}>
                {host.path.map((screen, index) => <span key={screen}>{index > 0 && <span aria-hidden className="xwiz__arrow">→</span>}<span className="xwiz__chip">{screen}</span></span>)}
              </p>
            )}
            {host.steps.length > 1 ? (
              <ol className="xwiz__list">{host.steps.map((text) => <li key={text}><StepText text={text} onCopy={onCopy} /></li>)}</ol>
            ) : (
              <p className="xero__p"><StepText text={host.steps[0]} onCopy={onCopy} /></p>
            )}
            <div className="xwiz__actions xwiz__actions--start">
              <button type="button" className="fx-btn fx-btn--sm" onClick={() => onCopy(host.prompt, "Setup prompt")}><MessageSquareText aria-hidden />Copy setup prompt</button>
              <span className="fx-mute xero__hint">For an assistant that works in {host.id === "other" ? "your server" : host.label}. It holds the name, never the key.</span>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function StepText({ text, onCopy }: { text: string; onCopy: (text: string, what: string) => void }) {
  const [before, after] = text.split("{name}");
  if (after === undefined) return <>{text}</>;
  return (
    <>
      {before}
      <span className="xero__copy xwiz__inline">
        <code>{SECRET_NAME}</code>
        <button type="button" className="fx-btn fx-btn--sm" onClick={() => onCopy(SECRET_NAME, "Name")}><Copy aria-hidden />Copy</button>
      </span>
      {after}
    </>
  );
}
