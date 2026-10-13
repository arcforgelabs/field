// Settings > Integrations: a catalogue of cards (integrations-list.ts), with a
// search box and Connected / Browse tabs. A card shows a logo, a name, one
// line, and "+" (or a check once connected). Picking a card opens the
// integration's own view: the connect wizard, or its detail and Configure.
// Nothing here shows a status label, a credential or a key.
//
// The open integration is in the address (?integration=xero), so a reload,
// or Xero's sign-in coming back (?xero=...), lands on it again.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Plus, Search } from "lucide-react";
import { INTEGRATIONS, type IntegrationEntry, type IntegrationStatus } from "./integrations-list";

type Tab = "connected" | "browse";

export function IntegrationsPage({ entries = INTEGRATIONS }: { entries?: IntegrationEntry[] }) {
  const [params, setParams] = useSearchParams();
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus | null>>({});
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("browse");
  const openId = params.get("integration") || (params.get("xero") ? "xero" : null);
  const open = entries.find((entry) => entry.id === openId) || null;

  useEffect(() => {
    if (open) return;
    let live = true;
    for (const entry of entries) {
      entry.loadStatus()
        .then((status) => { if (live) setStatuses((all) => ({ ...all, [entry.id]: status })); })
        .catch(() => { if (live) setStatuses((all) => ({ ...all, [entry.id]: null })); });
    }
    return () => { live = false; };
  }, [entries, open]);

  const go = (id: string | null) => {
    const next = new URLSearchParams(params);
    next.delete("xero");
    next.delete("code");
    if (id) next.set("integration", id);
    else next.delete("integration");
    setParams(next, { replace: !id });
  };

  const connectedCount = entries.filter((entry) => statuses[entry.id]?.connected).length;
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (tab === "connected" && !statuses[entry.id]?.connected) return false;
      if (!words) return true;
      return `${entry.name} ${entry.description}`.toLowerCase().includes(words);
    });
  }, [entries, statuses, query, tab]);

  if (open) return <open.View onBack={() => go(null)} />;

  return (
    <section className="fx-set__section fx-ints" aria-label="Integrations">
      <div>
        <h2 className="fx-set__h">Integrations</h2>
        <p className="fx-set__p">Connect Field to the systems your business already uses.</p>
      </div>
      <div className="fx-ints__bar">
        <div className="fx-seg" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={tab === "connected"} onClick={() => setTab("connected")}>Connected <span className="fx-seg__count">{connectedCount}</span></button>
          <button type="button" role="tab" aria-selected={tab === "browse"} onClick={() => setTab("browse")}>Browse</button>
        </div>
        <label className="fx-ints__search">
          <Search aria-hidden />
          <input type="search" className="fx-input" placeholder="Search" aria-label="Search integrations" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      {shown.length ? (
        <ul className="fx-ints__grid" role="list">
          {shown.map((entry) => {
            const status = statuses[entry.id];
            return (
              <li key={entry.id} className="fx-ints__card">
                <button type="button" className="fx-ints__open" aria-label={`${entry.name}: ${entry.description}`} onClick={() => go(entry.id)}>
                  <entry.Logo />
                  <span className="fx-ints__text">
                    <b>{entry.name}</b>
                    <span className="fx-dim">{entry.description}</span>
                  </span>
                </button>
                {status?.connected ? (
                  <span className="fx-ints__state fx-ints__state--on" role="img" aria-label={`${entry.name} is connected`}><Check aria-hidden /></span>
                ) : status?.canManage ? (
                  <button type="button" className="fx-ints__state" aria-label={`Connect ${entry.name}`} onClick={() => go(entry.id)}><Plus aria-hidden /></button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="fx-dim fx-ints__empty">
          {query.trim() ? `No integration matches “${query.trim()}”.` : tab === "connected" ? "Nothing is connected yet. Browse to connect one." : "No integrations."}
        </p>
      )}
    </section>
  );
}
