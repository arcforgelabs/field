// Settings > Quotes and invoices: when an invoice that was returned to draft
// is issued again with different content, whether Field credits the earlier
// one with a credit note first (#28). An owner changes it; everyone sees it.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CreditNoteOnReissue, InvoicingSettings } from "@/lib/types";
import { useShell } from "@/components/shell/shell-context";

export function InvoicingPanel() {
  const shell = useShell();
  const [settings, setSettings] = useState<InvoicingSettings | null>(null);
  const [choice, setChoice] = useState<CreditNoteOnReissue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.invoicingSettings()
      .then((res) => { setSettings(res); setChoice(res.creditNoteOnReissue); })
      .catch((err) => setError(err instanceof Error ? err.message : "The invoice settings could not be loaded."));
  }, []);

  async function save() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateInvoicingSettings({ creditNoteOnReissue: choice });
      setSettings(res);
      shell.toast("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The setting could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fx-set__section" aria-label="Reissuing an invoice">
      <div>
        <h2 className="fx-set__h">Reissuing an invoice</h2>
        <p className="fx-set__p">When an invoice you marked as not sent is issued again with different amounts, should Field first credit the old one with a credit note? &ldquo;Credit and reissue&rdquo; always makes a credit note.</p>
      </div>
      {error && <div className="fx-notice fx-notice--bad" style={{ margin: 0 }}><span>{error}</span></div>}
      {!settings && !error && <p className="fx-dim">Loading…</p>}
      {settings && (
        <fieldset aria-label="Credit the old invoice" style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {settings.choices.map((option) => (
            <label key={option.value} className="fx-check" style={{ alignItems: "flex-start", fontSize: 13 }}>
              <input type="radio" className="fx-radio" name="credit-note-on-reissue" value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)} />
              <span><b>{option.label}</b><br /><span className="fx-dim">{option.description}</span></span>
            </label>
          ))}
          <div style={{ display: "flex" }}>
            <span className="fx-spacer" />
            <button type="button" className="fx-btn fx-btn--primary" disabled={busy || choice === settings.creditNoteOnReissue} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </fieldset>
      )}
    </section>
  );
}
