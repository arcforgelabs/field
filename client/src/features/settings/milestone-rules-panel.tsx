// Settings > Quotes and invoices > Payment milestone rules (#29): the
// organisation's default milestones and caps, by region and contract value.
// Everyone sees them; only an owner changes them, and only here (or with the
// owner's CLI key). Field holds no legal limits of its own.
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { useShell } from "@/components/shell/shell-context";
import type { MilestoneCapKind, MilestoneCapMode, MilestoneRule, MilestoneRuleValueBasis, MilestoneRulesResponse } from "@/lib/types";

type Text = string;
type MilestoneDraft = { label: Text; percentage: Text; fixedTotal: Text; dueDays: Text };
type CapDraft = { kind: MilestoneCapKind; mode: MilestoneCapMode; maxPercent: Text; maxAmount: Text };
type RuleDraft = {
  key: string;
  uid: string | null;
  name: Text;
  country: Text;
  region: Text;
  minValue: Text;
  maxValue: Text;
  valueBasis: MilestoneRuleValueBasis;
  note: Text;
  milestones: MilestoneDraft[];
  caps: CapDraft[];
};

const KIND_LABEL: Record<MilestoneCapKind, string> = { deposit: "Deposit", progress: "Progress claim", final: "Final claim", variation: "Variation claim" };
const text = (value: number | null | undefined) => (value == null || value === 0 ? "" : String(value));
const number = (value: Text) => (value.trim() === "" ? null : Number(value));
let nextKey = 0;
const key = () => `rule-${(nextKey += 1)}`;

function toDraft(rule: MilestoneRule): RuleDraft {
  return {
    key: key(),
    uid: rule.uid ?? null,
    name: rule.name,
    country: rule.country || "",
    region: rule.region || "",
    minValue: text(rule.minValue),
    maxValue: text(rule.maxValue),
    valueBasis: rule.valueBasis,
    note: rule.note || "",
    milestones: rule.milestones.map((milestone) => ({ label: milestone.label, percentage: text(milestone.percentage), fixedTotal: text(milestone.fixedTotal), dueDays: text(milestone.dueDays) })),
    caps: rule.caps.map((cap) => ({ kind: cap.kind, mode: cap.mode, maxPercent: text(cap.maxPercent), maxAmount: text(cap.maxAmount) })),
  };
}

function fromDraft(draft: RuleDraft): MilestoneRule {
  return {
    uid: draft.uid,
    name: draft.name.trim(),
    country: draft.country.trim().toUpperCase() || null,
    region: draft.region.trim().toUpperCase() || null,
    minValue: number(draft.minValue) ?? 0,
    maxValue: number(draft.maxValue),
    valueBasis: draft.valueBasis,
    note: draft.note.trim() || null,
    milestones: draft.milestones.map((milestone) => ({
      label: milestone.label.trim(),
      percentage: number(milestone.percentage) ?? 0,
      ...(number(milestone.fixedTotal) ? { fixedTotal: number(milestone.fixedTotal) } : {}),
      ...(number(milestone.dueDays) ? { dueDays: number(milestone.dueDays) } : {}),
    })),
    caps: draft.caps.map((cap) => ({ kind: cap.kind, mode: cap.mode, maxPercent: number(cap.maxPercent), maxAmount: number(cap.maxAmount) })),
  };
}

function emptyRule(country: string, region: string): RuleDraft {
  return {
    key: key(), uid: null, name: "", country, region, minValue: "", maxValue: "", valueBasis: "inc-gst", note: "",
    milestones: [],
    caps: [{ kind: "deposit", mode: "hard", maxPercent: "", maxAmount: "" }],
  };
}

export function MilestoneRulesPanel() {
  const { isOwner } = useAuth();
  const shell = useShell();
  const [loaded, setLoaded] = useState<MilestoneRulesResponse | null>(null);
  const [drafts, setDrafts] = useState<RuleDraft[]>([]);
  const [saved, setSaved] = useState("");
  const [region, setRegion] = useState({ country: "", region: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function accept(response: MilestoneRulesResponse) {
    const next = response.rules.map(toDraft);
    setLoaded(response);
    setDrafts(next);
    setSaved(JSON.stringify(next.map(fromDraft)));
  }

  useEffect(() => {
    api.milestoneRules()
      .then((response) => {
        accept(response);
        setRegion({ country: response.businessRegion.country || "", region: response.businessRegion.region || "" });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "The milestone rules could not be loaded."));
  }, []);

  const dirty = loaded != null && JSON.stringify(drafts.map(fromDraft)) !== saved;
  const update = (at: number, patch: Partial<RuleDraft>) => setDrafts((current) => current.map((draft, index) => (index === at ? { ...draft, ...patch } : draft)));
  const regions = loaded?.options.regions || {};

  async function save() {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    try {
      accept(await api.saveMilestoneRules(drafts.map(fromDraft), loaded.version));
      shell.toast("Milestone rules saved. New jobs take them; issued invoices keep what they were issued with.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The rules could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRegion() {
    setBusy(true);
    setError(null);
    try {
      await api.updateInvoicingSettings({ country: region.country.trim().toUpperCase() || null, region: region.region.trim().toUpperCase() || null });
      const response = await api.milestoneRules();
      setLoaded(response);
      shell.toast("Business region saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The business region could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const business = loaded?.businessRegion;
  const regionDirty = loaded != null && (region.country.trim().toUpperCase() !== (business?.from === "settings" ? business.country || "" : "") || region.region.trim().toUpperCase() !== (business?.from === "settings" ? business.region || "" : ""));

  return (
    <section className="fx-set__section" aria-label="Payment milestone rules">
      <div>
        <h2 className="fx-set__h">Payment milestone rules</h2>
        <p className="fx-set__p">
          Default milestones and caps by region and contract value. A job takes the rule for its region (its site address, else your business region) whose band holds its contract value, when its invoices are first set up. A <b>hard cap</b> stops an invoice being issued; a <b>soft cap</b> alerts, and the alert is kept with the invoice. A job can change its own schedule, but never a cap. Field holds no legal limits of its own: enter the ones that apply to you.
        </p>
      </div>
      {error && <div className="fx-notice fx-notice--bad" style={{ margin: 0 }} role="alert"><span>{error}</span></div>}
      {!loaded && !error && <p className="fx-dim">Loading…</p>}
      {loaded && !isOwner && <div className="fx-notice" style={{ margin: 0 }}><span>Only an owner changes these rules.</span></div>}
      {loaded && (
        <fieldset disabled={!isOwner || busy} style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: 14, minWidth: 0 }}>
          <div className="fx-mr__region">
            <span className="fx-label" style={{ margin: 0 }}>Business region</span>
            <input className="fx-input" aria-label="Business country code" placeholder="AU" maxLength={2} style={{ width: 64 }} value={region.country} onChange={(event) => setRegion({ ...region, country: event.target.value })} />
            <RegionInput country={region.country} value={region.region} regions={regions} label="Business state" onChange={(value) => setRegion({ ...region, region: value })} />
            <span className="fx-mute" style={{ fontSize: 12, flex: "1 1 200px" }}>
              {business?.country ? `${business.region ? `${business.region}, ` : ""}${business.country}, ${business.from === "settings" ? "set here" : "read from the business address"}.` : "Not set, and not readable from the business address."}
            </span>
            <button type="button" className="fx-btn fx-btn--sm" disabled={!regionDirty} onClick={saveRegion}>Save region</button>
          </div>

          {drafts.length === 0 && <p className="fx-dim" style={{ margin: 0 }}>No rules: jobs use Field's default schedule, and no invoice is capped.</p>}
          {drafts.map((draft, index) => (
            <RuleEditor
              key={draft.key}
              draft={draft}
              regions={regions}
              onChange={(patch) => update(index, patch)}
              onRemove={() => setDrafts((current) => current.filter((_, at) => at !== index))}
            />
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="fx-btn" onClick={() => setDrafts((current) => [...current, emptyRule(business?.country || "", business?.region || "")])}><Plus aria-hidden />Add a rule</button>
            <span className="fx-spacer" />
            <button type="button" className="fx-btn fx-btn--primary" disabled={!dirty} onClick={save}>{busy ? "Saving…" : "Save rules"}</button>
          </div>
        </fieldset>
      )}
    </section>
  );
}

function RegionInput({ country, value, regions, label, onChange }: { country: string; value: string; regions: Record<string, Array<{ code: string; name: string }>>; label: string; onChange: (value: string) => void }) {
  const known = regions[country.trim().toUpperCase()];
  if (known) {
    return (
      <select className="fx-input" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} style={{ width: "auto" }}>
        <option value="">Whole country</option>
        {known.map((entry) => <option key={entry.code} value={entry.code}>{entry.name}</option>)}
      </select>
    );
  }
  return <input className="fx-input" aria-label={label} placeholder="State code" maxLength={3} style={{ width: 96 }} value={value} disabled={!country.trim()} onChange={(event) => onChange(event.target.value)} />;
}

function RuleEditor({ draft, regions, onChange, onRemove }: { draft: RuleDraft; regions: Record<string, Array<{ code: string; name: string }>>; onChange: (patch: Partial<RuleDraft>) => void; onRemove: () => void }) {
  const id = draft.key;
  const setMilestone = (at: number, patch: Partial<MilestoneDraft>) => onChange({ milestones: draft.milestones.map((milestone, index) => (index === at ? { ...milestone, ...patch } : milestone)) });
  const setCap = (at: number, patch: Partial<CapDraft>) => onChange({ caps: draft.caps.map((cap, index) => (index === at ? { ...cap, ...patch } : cap)) });
  const percentTotal = draft.milestones.reduce((sum, milestone) => sum + (Number(milestone.percentage) || 0), 0);
  return (
    <div className="fx-mr" data-rule={draft.name || "new"}>
      <div className="fx-mr__head">
        <input className="fx-input" aria-label="Rule name" placeholder="Rule name, for example: SA domestic, under $20,000" style={{ fontWeight: 600, flex: 1, minWidth: 0 }} value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />
        <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label={`Remove ${draft.name || "rule"}`} onClick={onRemove}><Trash2 /></button>
      </div>
      <div className="fx-mr__grid">
        <label className="fx-label" htmlFor={`${id}-country`}>Country<input id={`${id}-country`} className="fx-input" placeholder="Every country" maxLength={2} value={draft.country} onChange={(event) => onChange({ country: event.target.value, ...(event.target.value ? {} : { region: "" }) })} /></label>
        <label className="fx-label">State<RegionInput country={draft.country} value={draft.region} regions={regions} label="State" onChange={(value) => onChange({ region: value })} /></label>
        <label className="fx-label" htmlFor={`${id}-min`}>Contract value from<input id={`${id}-min`} className="fx-input fx-input--num" inputMode="decimal" placeholder="$0" value={draft.minValue} onChange={(event) => onChange({ minValue: event.target.value.replace(/[^0-9.]/g, "") })} /></label>
        <label className="fx-label" htmlFor={`${id}-max`}>Under<input id={`${id}-max`} className="fx-input fx-input--num" inputMode="decimal" placeholder="No limit" value={draft.maxValue} onChange={(event) => onChange({ maxValue: event.target.value.replace(/[^0-9.]/g, "") })} /></label>
        <label className="fx-label" htmlFor={`${id}-basis`}>Measured<select id={`${id}-basis`} className="fx-input" value={draft.valueBasis} onChange={(event) => onChange({ valueBasis: event.target.value as MilestoneRuleValueBasis })}><option value="inc-gst">With GST</option><option value="ex-gst">Before GST</option></select></label>
      </div>
      <label className="fx-label" htmlFor={`${id}-note`}>Why (shown with every cap message)<input id={`${id}-note`} className="fx-input" placeholder="For example, the regulation this follows" value={draft.note} onChange={(event) => onChange({ note: event.target.value })} /></label>

      <div className="fx-mr__sub">
        <div className="fx-mr__subh">Caps <span className="fx-mute">apply to every invoice of this kind, whatever the job's schedule</span></div>
        {draft.caps.map((cap, at) => (
          <div key={at} className="fx-mr__row">
            <select className="fx-input" aria-label="Milestone kind" value={cap.kind} onChange={(event) => setCap(at, { kind: event.target.value as MilestoneCapKind })}>
              {(Object.keys(KIND_LABEL) as MilestoneCapKind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
            </select>
            <input className="fx-input fx-input--num" aria-label="At most, dollars" placeholder="At most $" inputMode="decimal" value={cap.maxAmount} onChange={(event) => setCap(at, { maxAmount: event.target.value.replace(/[^0-9.]/g, "") })} />
            <input className="fx-input fx-input--num" aria-label="At most, percent of the contract value" placeholder="or %" inputMode="decimal" value={cap.maxPercent} onChange={(event) => setCap(at, { maxPercent: event.target.value.replace(/[^0-9.]/g, "") })} />
            <select className="fx-input" aria-label="Hard or soft cap" value={cap.mode} onChange={(event) => setCap(at, { mode: event.target.value as MilestoneCapMode })}>
              <option value="hard">Hard: blocks issuing</option>
              <option value="soft">Soft: alerts</option>
            </select>
            <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="Remove cap" onClick={() => onChange({ caps: draft.caps.filter((_, index) => index !== at) })}><Trash2 /></button>
          </div>
        ))}
        <div><button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => onChange({ caps: [...draft.caps, { kind: "progress", mode: "soft", maxPercent: "", maxAmount: "" }] })}><Plus aria-hidden />Cap</button></div>
      </div>

      <div className="fx-mr__sub">
        <div className="fx-mr__subh">Default milestones <span className="fx-mute">{draft.milestones.length ? `${Math.round(percentTotal * 1000) / 1000}% in all` : "none: Field's default schedule"}</span></div>
        {draft.milestones.map((milestone, at) => (
          <div key={at} className="fx-mr__row">
            <input className="fx-input" aria-label="Milestone label" placeholder="Label" value={milestone.label} onChange={(event) => setMilestone(at, { label: event.target.value })} />
            <input className="fx-input fx-input--num" aria-label="Percent" placeholder="%" inputMode="decimal" value={milestone.percentage} onChange={(event) => setMilestone(at, { percentage: event.target.value.replace(/[^0-9.]/g, "") })} />
            <input className="fx-input fx-input--num" aria-label="Fixed amount" placeholder="or $" inputMode="decimal" value={milestone.fixedTotal} onChange={(event) => setMilestone(at, { fixedTotal: event.target.value.replace(/[^0-9.]/g, "") })} />
            <input className="fx-input fx-input--num" aria-label="Due after, days" placeholder="Days" inputMode="numeric" value={milestone.dueDays} onChange={(event) => setMilestone(at, { dueDays: event.target.value.replace(/[^0-9]/g, "") })} />
            <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="Remove milestone" onClick={() => onChange({ milestones: draft.milestones.filter((_, index) => index !== at) })}><Trash2 /></button>
          </div>
        ))}
        <div><button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => onChange({ milestones: [...draft.milestones, { label: draft.milestones.length ? "Milestone" : "Deposit", percentage: "", fixedTotal: "", dueDays: "" }] })}><Plus aria-hidden />Milestone</button></div>
      </div>
    </div>
  );
}
