import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  errorCode,
  errorMessage,
  money,
  pct,
  priceBookApi,
  type ImportDecision,
  type ImportMatch,
  type ImportRow,
  type PriceImport,
} from "./price-book-api";
import { chipStyle, controlStyle, noticeStyle, numberCell, panelStyle, tdStyle, thStyle } from "./price-book-styles";

const TABS: Array<{ key: string; label: string; matches: ImportMatch[] }> = [
  { key: "changed", label: "Changed", matches: ["changed"] },
  { key: "new", label: "New", matches: ["new"] },
  { key: "missing", label: "Missing from file", matches: ["missing"] },
  { key: "problems", label: "Ambiguous / invalid", matches: ["ambiguous", "invalid"] },
  { key: "unchanged", label: "Unchanged", matches: ["unchanged"] },
];

const DECISION_LABELS: Record<ImportDecision, string> = {
  apply: "Apply",
  skip: "Skip",
  create: "Create item",
  archive: "Archive item",
};

const LARGE_CHANGE_PCT = 15;

function sortRows(rows: ImportRow[], tab: string): ImportRow[] {
  if (tab !== "changed") return rows;
  return [...rows].sort((a, b) => Math.abs(b.delta_pct ?? 0) - Math.abs(a.delta_pct ?? 0));
}

function deltaColor(delta: number | null): string {
  if (delta == null) return "var(--t-dim)";
  if (Math.abs(delta) > LARGE_CHANGE_PCT) return "var(--t-danger)";
  return delta > 0 ? "var(--t-warn)" : "var(--t-success)";
}

/** The staged diff: rows by match, per-row decisions, then apply or discard. */
export function ImportReview({ record, onChanged }: { record: PriceImport; onChanged: (next: PriceImport) => void }) {
  const rows = useMemo(() => record.rows || [], [record.rows]);
  const staged = record.status === "staged";
  const [decisions, setDecisions] = useState<Record<number, ImportDecision>>(() => Object.fromEntries(rows.map((row) => [row.row_no, (row.decision || "skip") as ImportDecision])));
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const tab of TABS) out[tab.key] = rows.filter((row) => tab.matches.includes(row.match)).length;
    return out;
  }, [rows]);
  const [tab, setTab] = useState(() => TABS.find((entry) => counts[entry.key] > 0)?.key || "changed");
  const [confirm, setConfirm] = useState<"apply" | "discard" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = sortRows(rows.filter((row) => TABS.find((entry) => entry.key === tab)!.matches.includes(row.match)), tab);
  const totals = useMemo(() => {
    const out = { apply: 0, create: 0, archive: 0 };
    for (const row of rows) {
      const decision = decisions[row.row_no];
      if (decision === "apply" || decision === "create" || decision === "archive") out[decision] += 1;
    }
    return out;
  }, [rows, decisions]);
  const effective = record.effective_from ? new Date(record.effective_from) : null;
  const future = effective ? effective.getTime() > Date.now() + 60_000 : false;

  function setAll(match: ImportMatch, decision: ImportDecision) {
    setDecisions((current) => {
      const next = { ...current };
      for (const row of rows) if (row.match === match && row.allowed_decisions.includes(decision)) next[row.row_no] = decision;
      return next;
    });
  }

  async function run(action: "apply" | "discard") {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      if (action === "apply") {
        const changed = Object.fromEntries(rows.filter((row) => row.allowed_decisions.length > 1).map((row) => [row.row_no, decisions[row.row_no]]));
        onChanged(await priceBookApi.applyImport(record.uid, changed));
      } else {
        onChanged(await priceBookApi.discardImport(record.uid));
      }
    } catch (err) {
      const code = errorCode(err);
      setError(code === "VERSION_CONFLICT" ? `${errorMessage(err, "Prices changed")} Upload the file again to restage it.` : errorMessage(err, action === "apply" ? "Could not apply" : "Could not discard"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline" }}>
        <strong style={{ fontSize: 15 }}>{record.supplier_name || "Supplier"} · {record.file_name || record.uid}</strong>
        <span style={{ fontFamily: "var(--t-data)", fontSize: 12, color: "var(--t-dim)" }}>
          {record.status.toUpperCase()} · effective {effective ? effective.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "on apply"}
          {future ? " (scheduled)" : ""}
        </span>
      </div>
      {!staged && record.summary?.result ? (
        <div role="status" style={noticeStyle(record.status === "applied" ? "success" : "info")}>
          {record.status === "applied"
            ? `Applied: ${record.summary.result.applied ?? 0} prices, ${record.summary.result.created ?? 0} new items, ${record.summary.result.archived ?? 0} archived, ${record.summary.result.skipped ?? 0} skipped.`
            : "Discarded."}
        </div>
      ) : null}
      {!staged && !record.summary?.result ? <div role="status" style={noticeStyle("info")}>{record.status === "discarded" ? "Discarded; nothing was changed." : record.status}</div> : null}
      {error ? <div role="alert" style={noticeStyle("danger")}>{error}</div> : null}

      <div role="tablist" aria-label="Import rows" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map((entry) => (
          <button key={entry.key} type="button" role="tab" aria-selected={tab === entry.key} onClick={() => setTab(entry.key)} style={chipStyle(tab === entry.key)}>
            {entry.label}
            <span style={{ fontFamily: "var(--t-data)", fontSize: 11, opacity: 0.75 }}>{counts[entry.key]}</span>
          </button>
        ))}
      </div>

      {staged && tab === "changed" && counts.changed ? (
        <div style={{ display: "flex", gap: 6 }}>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll("changed", "apply")}>Apply all</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll("changed", "skip")}>Skip all</Button>
        </div>
      ) : null}
      {staged && tab === "new" && counts.new ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll("new", "create")}>Create all as drafts</Button>
          <span style={{ fontSize: 12, color: "var(--t-dim)" }}>New items are created as drafts so they are not quoted until reviewed.</span>
        </div>
      ) : null}
      {tab === "missing" ? <div style={{ fontSize: 12, color: "var(--t-dim)" }}>Items linked to this supplier that the file does not list. They are kept unless you choose to archive them; nothing is ever deleted.</div> : null}

      <div style={{ ...panelStyle, overflowX: "auto" }}>
        <table aria-label="Import changes" style={{ width: "100%", minWidth: 820, borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Row</th>
              <th style={thStyle}>Supplier code</th>
              <th style={thStyle}>Item</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Cost</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Change</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Sell / margin</th>
              <th style={thStyle}>Notes</th>
              <th style={thStyle}>Decision</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.row_no}>
                <td style={{ ...tdStyle, padding: "6px 8px", fontFamily: "var(--t-data)", color: "var(--t-dim)" }}>{row.match === "missing" ? "—" : row.row_no}</td>
                <td style={{ ...tdStyle, padding: "6px 8px", fontFamily: "var(--t-data)" }}>{row.supplier_code || "—"}</td>
                <td style={{ ...tdStyle, padding: "6px 8px" }}>
                  <div style={{ fontWeight: 600 }}>{row.item?.name || row.name || "—"}</div>
                  <div style={{ fontFamily: "var(--t-data)", fontSize: 11, color: "var(--t-dim)" }}>
                    {row.item ? `per ${row.item.unit}` : row.unit ? `per ${row.unit}` : ""}
                    {row.matched_by && row.matched_by !== "supplier_link" ? ` · by ${row.matched_by.replace("_", " ")}` : ""}
                  </div>
                </td>
                <td style={{ ...tdStyle, ...numberCell, padding: "6px 8px" }}>
                  {row.old_cost != null && row.new_cost != null && row.old_cost !== row.new_cost ? (
                    <><span style={{ color: "var(--t-mute)" }}>{money(row.old_cost)}</span> → <strong>{money(row.new_cost)}</strong></>
                  ) : money(row.new_cost ?? row.old_cost)}
                </td>
                <td style={{ ...tdStyle, ...numberCell, padding: "6px 8px", color: deltaColor(row.delta_pct), fontWeight: row.delta_pct != null && Math.abs(row.delta_pct) > LARGE_CHANGE_PCT ? 700 : 400 }}>
                  {pct(row.delta_pct, { signed: true })}
                </td>
                <td style={{ ...tdStyle, ...numberCell, padding: "6px 8px" }}>
                  {money(row.new_sell ?? row.old_sell)}
                  <div style={{ fontSize: 11, color: "var(--t-dim)" }}>{pct(row.new_margin_pct ?? row.old_margin_pct)}</div>
                </td>
                <td style={{ ...tdStyle, padding: "6px 8px", fontSize: 12, maxWidth: 260 }}>
                  {row.issues.map((issue) => (
                    <div key={issue.code} style={{ color: "var(--t-danger)", display: "flex", gap: 4, alignItems: "flex-start" }}><AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />{issue.message}</div>
                  ))}
                  {row.flags.map((flag) => (
                    <div key={flag.code} style={{ color: flag.code === "negative_margin" || flag.code === "large_change" || flag.code === "name_match" ? "var(--t-warn)" : "var(--t-dim)" }}>{flag.message}</div>
                  ))}
                  {row.candidates.filter(Boolean).length ? (
                    <div style={{ color: "var(--t-dim)" }}>Candidates: {row.candidates.filter(Boolean).map((c) => c!.name).join(", ")}</div>
                  ) : null}
                </td>
                <td style={{ ...tdStyle, padding: "6px 8px" }}>
                  {staged && row.allowed_decisions.length > 1 ? (
                    <select
                      aria-label={`Decision for row ${row.row_no}`}
                      value={decisions[row.row_no]}
                      onChange={(event) => setDecisions((current) => ({ ...current, [row.row_no]: event.target.value as ImportDecision }))}
                      style={{ ...controlStyle, height: 28 }}
                    >
                      {row.allowed_decisions.map((decision) => <option key={decision} value={decision}>{DECISION_LABELS[decision]}</option>)}
                    </select>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--t-dim)" }}>{DECISION_LABELS[(decisions[row.row_no] || "skip") as ImportDecision]}</span>
                  )}
                </td>
              </tr>
            ))}
            {!visible.length ? <tr><td colSpan={8} style={{ ...tdStyle, padding: 14, color: "var(--t-dim)" }}>Nothing here.</td></tr> : null}
          </tbody>
        </table>
      </div>

      {staged ? (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--t-data)", fontSize: 12, color: "var(--t-dim)" }}>
            {totals.apply} prices · {totals.create} new · {totals.archive} archive
          </span>
          <Button type="button" variant="ghost" className="border border-[var(--t-brd)] rounded-[4px]" size="sm" disabled={busy} onClick={() => setConfirm("discard")}>Discard</Button>
          <Button type="button" variant="accent" size="sm" disabled={busy || totals.apply + totals.create + totals.archive === 0} onClick={() => setConfirm("apply")}>
            Apply import
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "apply" ? "Apply supplier prices" : "Discard import"}
        description={confirm === "apply"
          ? `Write ${totals.apply} new price${totals.apply === 1 ? "" : "s"}${totals.create ? `, create ${totals.create} draft item${totals.create === 1 ? "" : "s"}` : ""}${totals.archive ? `, archive ${totals.archive} item${totals.archive === 1 ? "" : "s"}` : ""} in one step${future ? ", effective on the chosen date" : ""}. Price history keeps the old prices.`
          : "Discard this staged price list? The catalogue is not changed."}
        confirmLabel={confirm === "apply" ? "Apply" : "Discard"}
        tone={confirm === "discard" ? "danger" : "accent"}
        busy={busy}
        onConfirm={() => { if (confirm) void run(confirm); }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
