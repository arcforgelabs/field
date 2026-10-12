// Settings > Email: your own signature, added under each new message in the
// email composer, as Gmail does. Plain lines; {{senderName}} and
// {{businessName}} are filled in when the email is written. Empty returns to
// the default sign-off.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useShell } from "@/components/shell/shell-context";

export function signatureToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'")
    .trim();
}

export function textToSignature(text: string) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.trim()
    ? text.trim().split(/\n{2,}/).map((block) => `<p>${block.split("\n").map(escape).join("<br/>")}</p>`).join("")
    : "";
}

export function EmailSignaturePanel() {
  const shell = useShell();
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.emailSignature()
      .then((res) => { const value = signatureToText(res.signature.html); setSaved(value); setText(value); setIsDefault(res.signature.isDefault); })
      .catch((err) => setError(err instanceof Error ? err.message : "Your signature could not be loaded."));
  }, []);

  async function save(next: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.saveEmailSignature(textToSignature(next));
      const value = signatureToText(res.signature.html);
      setSaved(value);
      setText(value);
      setIsDefault(res.signature.isDefault);
      shell.toast("Signature saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your signature could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fx-set__section" aria-label="Email signature">
      <div>
        <h2 className="fx-set__h">Email signature</h2>
        <p className="fx-set__p">Added under each new email you write in Field. Only you see and change yours. Use {"{{senderName}}"} for your name and {"{{businessName}}"} for the business.</p>
      </div>
      {error && <div className="fx-notice fx-notice--bad" style={{ margin: 0 }}><span>{error}</span></div>}
      {saved === null && !error ? <p className="fx-dim">Loading…</p> : null}
      {saved !== null ? (
        <>
          <label className="fx-label" htmlFor="email-signature">Signature
            <textarea id="email-signature" className="fx-input fx-textarea" rows={4} style={{ height: "auto", padding: 10, lineHeight: 1.5 }} value={text} onChange={(event) => setText(event.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            {!isDefault ? <button type="button" className="fx-btn fx-btn--ghost" disabled={busy} onClick={() => void save("")}>Use the default</button> : null}
            <span className="fx-spacer" />
            <button type="button" className="fx-btn fx-btn--primary" disabled={busy || text === saved} onClick={() => void save(text)}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </>
      ) : null}
    </section>
  );
}
