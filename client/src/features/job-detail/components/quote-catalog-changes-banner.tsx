// "N lines changed in the catalogue": the draft quote's catalogue-linked
// rows compared with the catalogue by the server, with a per-row diff and
// apply. Shown when the quote editor opens and after it saves.
//
// The list and its ticks are from the last check. A row the operator edits
// afterwards is marked, and applying it checks again first instead (the
// editor and the server both compare each row's reviewKey), so an edit made
// after the check is never replaced by a tick from before it.
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react";
import type { QuoteCatalogChanges } from "@/lib/types";
import { catalogChangeSelectedByDefault, catalogChangesHeadline, describeCatalogChange } from "../quote-catalog-rows";

const STATUS_LABEL: Record<string, string> = {
  changed: "Changed",
  missing: "Missing from catalogue",
  archived: "Archived in catalogue",
  unpriced: "No complete catalogue price",
  unit_mismatch: "Unit can't convert",
};

const NO_ROWS: ReadonlySet<string> = new Set();

export function QuoteCatalogChangesBanner({
  changes,
  busy,
  error,
  notice = null,
  editedSinceCheck = NO_ROWS,
  onApply,
  onRecheck,
}: {
  changes: QuoteCatalogChanges | null;
  busy: boolean;
  error: string | null;
  /** Why the last apply left (some) ticked rows unchanged. */
  notice?: string | null;
  /** Listed rows the operator edited since this list was checked. */
  editedSinceCheck?: ReadonlySet<string>;
  onApply: (nodeIds: string[]) => void | Promise<void>;
  onRecheck: () => void | Promise<void>;
}) {
  // A notice is about the list: show it, when it first comes and each time
  // it changes.
  const [open, setOpen] = useState(() => Boolean(notice));
  const [lastNotice, setLastNotice] = useState(notice);
  if (notice !== lastNotice) {
    setLastNotice(notice);
    if (notice) setOpen(true);
  }
  // Only plain catalogue updates start ticked. Rows edited on this quote,
  // rows whose price source is unknown and kits resting on legacy rows start
  // unselected, so the default apply never replaces a negotiated rate or
  // rebuilds an older kit the operator has not looked at.
  const defaultIds = useMemo(
    () => (changes?.lines || []).filter(catalogChangeSelectedByDefault).map((line) => line.nodeId),
    [changes],
  );
  // The ticks belong to one list: a new list (a check, an apply) starts from
  // its own defaults in the same render, so no tick from an older list is
  // ever shown against, or applied with, a newer one.
  const [selection, setSelection] = useState(() => ({ list: changes, ids: new Set(defaultIds) }));
  let selected = selection.ids;
  if (selection.list !== changes) {
    selected = new Set(defaultIds);
    setSelection({ list: changes, ids: selected });
  }

  if (!error && !notice && (!changes || changes.changedCount === 0)) return null;
  const editedTicked = [...selected].filter((nodeId) => editedSinceCheck.has(nodeId)).length;

  const toggle = (nodeId: string) => {
    setSelection((current) => {
      const next = new Set(current.ids);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { list: current.list, ids: next };
    });
  };

  return (
    <div
      role="status"
      data-testid="quote-catalog-changes"
      style={{
        border: "1px solid var(--t-warn, #c58a00)",
        background: "color-mix(in srgb, var(--t-warn, #c58a00) 10%, transparent)",
        borderRadius: "var(--t-radius)",
        padding: "10px 12px",
        display: "grid",
        gap: 8,
        textAlign: "left",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <AlertTriangle size={16} aria-hidden="true" />
        <strong style={{ fontSize: 13 }}>{error ? "Couldn't check the catalogue" : catalogChangesHeadline(changes)}</strong>
        <span style={{ flex: 1 }} />
        {changes && changes.changedCount > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, background: "none", border: "none", color: "inherit", cursor: "pointer" }}
          >
            {open ? "Hide changes" : "Review changes"}
            <ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : undefined }} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => { void onRecheck(); }}
          disabled={busy}
          title="Check the catalogue again"
          aria-label="Check the catalogue again"
          style={{ background: "none", border: "none", color: "inherit", cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {error ? <div style={{ fontSize: 12 }}>{error}</div> : null}
      {notice ? <div data-testid="quote-catalog-changes-notice" style={{ fontSize: 12 }}>{notice}</div> : null}
      {changes?.locked ? (
        <div style={{ fontSize: 12, color: "var(--t-dim)" }}>
          The sent version never changes. Changes you apply here go into a new draft revision when you save.
        </div>
      ) : null}
      {open && changes ? (
        <div style={{ display: "grid", gap: 6 }}>
          {changes.lines.map((line) => (
            <label
              key={line.nodeId}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: 8,
                alignItems: "start",
                padding: "6px 0",
                borderTop: "1px solid var(--t-border, rgba(127,127,127,.25))",
                opacity: line.applicable ? 1 : 0.8,
              }}
            >
              <input
                type="checkbox"
                checked={line.applicable && selected.has(line.nodeId)}
                disabled={!line.applicable || busy}
                onChange={() => toggle(line.nodeId)}
                aria-label={`Apply catalogue change to ${line.label}`}
              />
              <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {line.label}
                </span>
                <span style={{ fontSize: 11, color: "var(--t-dim)" }}>
                  {STATUS_LABEL[line.status] || line.status}
                  {line.overridden ? " · edited on this quote (applying replaces your edit)" : ""}
                  {line.priceSourceUnknown ? " · price source unknown" : ""}
                  {editedSinceCheck.has(line.nodeId) ? " · you changed this row after the check; applying checks again first" : ""}
                </span>
                {describeCatalogChange(line).map((text, index) => (
                  <span key={index} style={{ fontSize: 12, fontFamily: "var(--t-data)" }}>{text}</span>
                ))}
              </span>
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
            {editedTicked > 0 && !busy ? (
              <span style={{ fontSize: 12, color: "var(--t-dim)" }}>
                Your draft changed since this list was checked. Review the updated list before applying.
              </span>
            ) : null}
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => { void onApply([...selected]); }}
              style={{ fontSize: 12, padding: "6px 10px", borderRadius: "var(--t-radius)", cursor: busy || selected.size === 0 ? "default" : "pointer" }}
            >
              {busy
                ? "Applying…"
                : editedTicked > 0
                  ? "Check again"
                  : `Apply ${selected.size} ${selected.size === 1 ? "change" : "changes"}`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
