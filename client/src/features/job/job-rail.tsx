// The job page's summary rail: the totals and margin (live while editing),
// then the customer and site, each field editable in place, and the
// quote's versions once it has been revised.
import { useRef, useState } from "react";
import { Check, Upload } from "lucide-react";
import type { RecordingDetail, SoilDump } from "@/lib/types";
import { api } from "@/lib/api";
import { forwardGeocode } from "@/lib/geo";
import { money } from "@/lib/job-status";
import type { QuoteTotals } from "./quote-editor";
import { describeVersions } from "./quote-versions";
import { DEFAULT_SOIL_DUMPS, estimateDrivingDistanceKm, haversineDistanceKm } from "../../../../shared/dumping.js";

const SOIL_DUMPS = DEFAULT_SOIL_DUMPS as SoilDump[];

export function JobRail({ detail, totals, paid, landed, selectedVersion, onPickVersion, onDetailSaved }: {
  detail: RecordingDetail;
  totals: QuoteTotals | null;
  paid: number;
  landed: boolean;
  selectedVersion: number | null;
  onPickVersion: (version: number) => void;
  onDetailSaved: (detail: RecordingDetail) => void;
}) {
  const meta = detail.meta;
  const details = detail.jobState?.details;
  // The saved quote's totals come from its rows (customerPricing, #10).
  const quoteTotals = detail.quote?.customerPricing ?? detail.quote?.totals;
  // Null when the server withholds amounts (pricing checks not passed): shown as "—".
  const subtotal = totals?.subtotal ?? quoteTotals?.subtotal ?? null;
  const gst = totals?.gst ?? quoteTotals?.gst ?? null;
  const total = totals?.total ?? quoteTotals?.total ?? null;
  const cost = totals?.cost ?? detail.quote?.customerPricing?.cost ?? null;
  const margin = subtotal && cost != null ? (subtotal - cost) / subtotal : 0;
  const marginTone = margin < 0.15 ? "var(--t-warn)" : "var(--t-success)";
  const versions = describeVersions(detail.quoteVersions || [], detail.quoteLifecycle?.lastSentQuoteVersion ?? detail.quoteEditPolicy?.lastSentQuoteVersion);
  const gps = meta.gps || details?.gps;
  const dump = details?.soilDump || null;

  async function save(key: string, value: unknown) {
    const result = await api.updateDetail(meta.id, key, value);
    onDetailSaved(result.detail);
  }

  async function saveAddress(value: string) {
    await save("siteAddress", value);
    const point = value.trim() ? await forwardGeocode(value).catch(() => null) : null;
    if (point) await save("gps", { lat: point.lat, lng: point.lng });
  }

  return (
    <aside className="fx-rail" aria-label="Job summary">
      <section>
        <div className="fx-total__k">Quote total inc GST</div>
        <div className="fx-total__v">{money(total)}</div>
        <div style={{ marginTop: 10 }}>
          <div className="fx-kv"><span>Subtotal</span><span className="fx-num">{money(subtotal)}</span></div>
          <div className="fx-kv"><span>GST</span><span className="fx-num">{money(gst)}</span></div>
          <hr className="fx-rule" />
          <div className="fx-kv"><span>Cost</span><span className="fx-num">{money(cost)}</span></div>
          <div className="fx-kv"><span>Margin</span><span className="fx-num" style={{ color: subtotal ? marginTone : undefined }}>{subtotal != null && cost != null ? `${money(subtotal - cost)} · ${subtotal ? `${(margin * 100).toFixed(1)}%` : "—"}` : "—"}</span></div>
          <div className="fx-margin" aria-hidden><i style={{ width: `${Math.max(0, Math.min(1, margin / 0.5)) * 100}%`, background: marginTone }} /></div>
          {landed && (
            <>
              <hr className="fx-rule" />
              <div className="fx-kv"><span>Paid</span><span className="fx-num">{money(paid)}</span></div>
              <div className="fx-kv"><span>Outstanding</span><span className="fx-num">{money(Math.max(0, (meta.milestoneInvoices || []).reduce((sum, invoice) => sum + (invoice.total || 0), 0) - paid))}</span></div>
            </>
          )}
        </div>
      </section>

      <section>
        <h2 className="fx-rail__h">Customer</h2>
        <Prop id="customer" label="Name" value={details?.customer?.name || meta.customerName || ""} placeholder="Add customer" onSave={(value) => save("customer.name", value)} />
        <Prop id="contact" label="Contact" value={details?.contact?.name || meta.contactName || ""} placeholder="Add contact" onSave={(value) => save("contact.name", value)} />
        <Prop id="email" label="Email" type="email" value={details?.contact?.email || meta.contactEmail || ""} placeholder="Add email" onSave={(value) => save("contact.email", value)} />
        <Prop id="phone" label="Phone" type="tel" value={details?.contact?.phone || meta.contactPhone || ""} placeholder="Add phone" onSave={(value) => save("contact.phone", value)} />
      </section>

      <section>
        <h2 className="fx-rail__h">Site</h2>
        <Prop id="address" label="Address" value={details?.siteAddress || meta.siteAddress || ""} placeholder="Add address" onSave={saveAddress} />
        <label className="fx-prop" htmlFor="rail-dump">
          <span>Disposal</span>
          <select
            id="rail-dump"
            value={dump?.name || ""}
            onChange={(event) => {
              const picked = SOIL_DUMPS.find((candidate) => candidate.name === event.target.value);
              if (picked) void save("soilDump", picked);
            }}
          >
            {!dump && <option value="">Choose a facility</option>}
            {SOIL_DUMPS.map((candidate) => {
              const km = gps?.lat && candidate.lat ? Math.round(estimateDrivingDistanceKm(haversineDistanceKm(gps.lat, gps.lng, candidate.lat, candidate.lng))) : null;
              return <option key={candidate.name} value={candidate.name}>{candidate.name}{km != null ? ` · ${km} km` : ""}</option>;
            })}
          </select>
        </label>
        <Prop id="quoted-by" label="Quoted by" value={details?.quotedBy?.name || meta.quotedBy || ""} placeholder="Add name" onSave={(value) => save("quotedBy.name", value)} />
        <Measurements detail={detail} onSaved={onDetailSaved} />
      </section>

      {versions.length > 0 && (
        <section>
          <h2 className="fx-rail__h">Versions</h2>
          <div className="fx-versions">
            {versions.map((row) => (
              <button key={row.version} type="button" className="fx-prop" title={`Version ${row.version}`} aria-current={row.version === selectedVersion || undefined} onClick={() => onPickVersion(row.version)}>
                <span>{row.state}</span>
                <span className="fx-versions__v">{row.detail}{row.version === selectedVersion && <Check aria-hidden />}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

/** A label and an input that saves when you leave it (or press Enter). */
function Prop(props: Parameters<typeof PropInput>[0]) {
  // A new saved value starts a fresh draft.
  return <PropInput key={props.value} {...props} />;
}

function PropInput({ id, label, value, placeholder, type = "text", onSave }: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  async function commit() {
    if (draft.trim() === value.trim()) return;
    setState("saving");
    try { await onSave(draft.trim()); setState("idle"); } catch { setState("error"); }
  }
  return (
    <label className="fx-prop" htmlFor={`rail-${id}`}>
      <span>{label}</span>
      <input
        id={`rail-${id}`}
        type={type}
        value={draft}
        placeholder={placeholder}
        aria-invalid={state === "error" || undefined}
        title={state === "error" ? "Not saved. Try again." : undefined}
        style={state === "error" ? { borderColor: "var(--t-danger)" } : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") { setDraft(value); (event.target as HTMLInputElement).blur(); }
        }}
      />
    </label>
  );
}

/** Measurement files another system captured (e.g. a Moasure export) that quotes can price from. */
function Measurements({ detail, onSaved }: { detail: RecordingDetail; onSaved: (detail: RecordingDetail) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const batches = detail.moasure?.batches?.length ?? detail.meta.moasureBatchCount ?? 0;
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      Array.from(files).forEach((file) => form.append("files", file, file.name));
      await api.moasureUpload(detail.meta.id, form);
      onSaved(await api.recording(detail.meta.id, "latest"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The file could not be added.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="fx-prop">
      <span>Measures</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="fx-dim" style={{ fontSize: 12.5 }}>{batches ? `${batches} import${batches === 1 ? "" : "s"}` : "None"}</span>
        <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" disabled={busy} onClick={() => input.current?.click()}><Upload aria-hidden />{busy ? "Adding…" : "Add"}</button>
        <input ref={input} type="file" hidden multiple accept=".csv,.json,.dxf,.svg,.png,.jpg,.jpeg,.pdf" onChange={(event) => upload(event.target.files)} />
      </div>
      {error && <span style={{ gridColumn: "1 / -1", color: "var(--t-danger)", fontSize: 12 }}>{error}</span>}
    </div>
  );
}
