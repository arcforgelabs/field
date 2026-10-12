// New quote: only the site address is needed. The customer can be filled in
// now or later; the job opens straight into the quote with item search ready.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { forwardGeocode } from "@/lib/geo";
import { useAuth } from "@/contexts/auth-context";
import { patchJobMeta, refreshJobs } from "@/lib/use-jobs";

export function NewQuoteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [address, setAddress] = useState("");
  const [customer, setCustomer] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!address.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createManual(undefined, undefined, address.trim(), user?.name);
      patchJobMeta(created.meta);
      const details: Array<[string, string]> = [];
      if (customer.trim()) details.push(["customer.name", customer.trim()], ["contact.name", customer.trim()]);
      if (email.trim()) details.push(["contact.email", email.trim()]);
      for (const [key, value] of details) await api.updateDetail(created.id, key, value);
      // Disposal distances need the site's position; it can land after the job opens.
      void forwardGeocode(address.trim())
        .then((point) => (point ? api.updateDetail(created.id, "gps", { lat: point.lat, lng: point.lng }) : null))
        .catch(() => null);
      void refreshJobs();
      onClose();
      navigate(`/jobs/${created.id}?start=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The quote could not be created.");
      setBusy(false);
    }
  }

  return (
    <div className="fx-scrim" onMouseDown={onClose}>
      <form
        className="fx-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-quote-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={create}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
      >
        <div className="fx-dialog__h" id="new-quote-title">New quote</div>
        <div className="fx-dialog__b">
          <label className="fx-label" htmlFor="new-quote-address">
            Site address
            <input id="new-quote-address" className="fx-input" autoFocus placeholder="e.g. 12 Example Street, Sampleton SA 5000" value={address} onChange={(event) => setAddress(event.target.value)} />
          </label>
          <div className="fx-grid2">
            <label className="fx-label" htmlFor="new-quote-customer">
              Customer
              <input id="new-quote-customer" className="fx-input" placeholder="Name or company" value={customer} onChange={(event) => setCustomer(event.target.value)} />
            </label>
            <label className="fx-label" htmlFor="new-quote-email">
              Email
              <input id="new-quote-email" className="fx-input" type="email" placeholder="Where the quote goes" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
          </div>
          <p className="fx-mute" style={{ fontSize: 12, margin: 0 }}>Only the address is needed to start. You'll land in the quote with item search ready.</p>
          {error && <p role="alert" style={{ color: "var(--t-danger)", fontSize: 12.5, margin: 0 }}>{error}</p>}
        </div>
        <div className="fx-dialog__f">
          <button type="button" className="fx-btn fx-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="fx-btn fx-btn--primary" disabled={!address.trim() || busy}>{busy ? "Creating…" : "Create and start quoting"}</button>
        </div>
      </form>
    </div>
  );
}
