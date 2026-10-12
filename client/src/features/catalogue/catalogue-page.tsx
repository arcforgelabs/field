// The catalogue: one table of everything Field prices from. Click a row to
// open the item in place; tick rows to change them together; Manage handles
// the collections (categories, tags, units, suppliers). Filters, the open
// item and the open manager live in the URL, so every view can be linked.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, Archive, ArchiveRestore, ChevronDown, Plus, Search, SlidersHorizontal, Tag, Tags, Upload, X,
} from "lucide-react";
import { Menu, type MenuItem } from "@/components/shell/menu";
import { useShell } from "@/components/shell/shell-context";
import { money } from "@/lib/job-status";
import type { PriceCatalogHealthReport } from "@/lib/types";
import { errorCode, errorMessage, priceBookApi, type BulkOp, type BulkResult, type PriceBookRow, type Supplier } from "@/features/pricing/price-book-api";
import { formatCatalogUnit } from "../../../../shared/catalog-units.js";
import { catalogueApi, loadAllRows, type ManagedCategory } from "./catalogue-api";
import {
  addTag, buildHealthIndex, bulkSummary, facetCounts, filterRows, formatRange, healthSummary, NEW_ITEM, readView,
  removeTag, round, runInSequence, sortRows, upgradeLegacyParams, writeView,
  type CatalogueView, type ManagerTab, type SortKey, type StatusFilter,
} from "./catalogue-model";
import { ConfirmBox, PromptBox } from "./catalogue-dialogs";
import { ItemDrawer } from "./item-drawer";
import { ManagerSheet } from "./manager-sheet";

export type CatalogueData = {
  rows: PriceBookRow[] | null;
  categories: ManagedCategory[];
  suppliers: Supplier[];
  health: PriceCatalogHealthReport | null;
  error: string | null;
  reload: () => Promise<void>;
};

function fetchCatalogue() {
  return Promise.allSettled([loadAllRows(), catalogueApi.categories(), catalogueApi.suppliers(), catalogueApi.health()]);
}

function useCatalogueData(): CatalogueData {
  const [rows, setRows] = useState<PriceBookRow[] | null>(null);
  const [categories, setCategories] = useState<ManagedCategory[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [health, setHealth] = useState<PriceCatalogHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = useCallback((results: Awaited<ReturnType<typeof fetchCatalogue>>) => {
    const [grid, cats, sups, report] = results;
    if (grid.status === "fulfilled") { setRows(grid.value.rows); setError(null); } else setError(errorMessage(grid.reason, "The catalogue could not be loaded."));
    if (cats.status === "fulfilled") setCategories(cats.value);
    if (sups.status === "fulfilled") setSuppliers(sups.value);
    // Health is a hint, not a gate: the table still works without it.
    if (report.status === "fulfilled") setHealth(report.value);
  }, []);
  const reload = useCallback(async () => apply(await fetchCatalogue()), [apply]);
  useEffect(() => {
    let live = true;
    void fetchCatalogue().then((results) => { if (live) apply(results); });
    return () => { live = false; };
  }, [apply]);
  return { rows, categories, suppliers, health, error, reload };
}

const STATUS_LABEL: Record<StatusFilter, string> = { active: "Active", draft: "Draft", archived: "Archived", all: "All" };

type BulkPrompt = null
  | { kind: "category" }
  | { kind: "addTag" }
  | { kind: "price"; op: "setMarkupPct" | "adjustCostPct" | "adjustSellPct" };

const PRICE_PROMPTS = {
  setMarkupPct: { title: "Set markup", label: "Markup on cost", hint: "Items on a fixed selling price switch to markup. Kits priced from their parts are skipped.", submit: "Preview" },
  adjustCostPct: { title: "Change cost by a percentage", label: "Change", hint: "Use a minus for a decrease, e.g. -5. Markup items' selling prices follow their cost.", submit: "Preview" },
  adjustSellPct: { title: "Change fixed selling prices by a percentage", label: "Change", hint: "Only items on a fixed selling price change; markup items follow their cost.", submit: "Preview" },
} as const;

export function CataloguePage() {
  const navigate = useNavigate();
  const shell = useShell();
  const [params, setParams] = useSearchParams();
  const data = useCatalogueData();
  const view = readView(params);
  const [search, setSearch] = useState(view.q);
  // The q the search box last agreed with the URL on: a different q in the
  // URL came from elsewhere (a link, Back), so the box follows it.
  const [syncedQ, setSyncedQ] = useState(view.q);
  if (view.q !== syncedQ) {
    setSyncedQ(view.q);
    setSearch(view.q);
  }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPrompt, setBulkPrompt] = useState<BulkPrompt>(null);
  const [preview, setPreview] = useState<{ title: string; op: BulkOp; result: BulkResult } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const upgraded = upgradeLegacyParams(params);
    if (upgraded) setParams(upgraded, { replace: true });
  }, [params, setParams]);

  const update = useCallback((patch: Partial<CatalogueView>, { push = false } = {}) => {
    setParams((current) => writeView({ ...readView(current), ...patch }), { replace: !push });
  }, [setParams]);

  // Search as you type, a beat after the last key.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (search === view.q) return;
      setSyncedQ(search);
      update({ q: search });
    }, 180);
    return () => window.clearTimeout(handle);
  }, [search, view.q, update]);

  const rows = useMemo(() => data.rows || [], [data.rows]);
  const health = useMemo(() => buildHealthIndex(data.health, rows), [data.health, rows]);
  const categoryOrder = useMemo(() => [...data.categories].sort((a, b) => a.sort_order - b.sort_order).map((category) => category.name), [data.categories]);
  const visible = useMemo(() => sortRows(filterRows(rows, view, health.attention), view.sort, view.dir), [rows, view, health.attention]);
  const facets = useMemo(() => facetCounts(rows, view, health.attention, categoryOrder), [rows, view, health.attention, categoryOrder]);
  const allTags = useMemo(() => [...new Set(rows.flatMap((row) => row.tags))].sort((a, b) => a.localeCompare(b)), [rows]);
  const allCategories = useMemo(() => {
    const names = new Map<string, string>();
    for (const name of [...categoryOrder, ...rows.map((row) => row.category).filter(Boolean) as string[]]) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    return [...names.values()];
  }, [categoryOrder, rows]);
  const selectedRows = useMemo(() => rows.filter((row) => selected.has(row.uid)), [rows, selected]);
  const supplierName = view.supplier ? data.suppliers.find((supplier) => supplier.uid === view.supplier)?.name || "Supplier" : null;

  // Selection follows what's on screen: rows filtered away drop out of it.
  useEffect(() => {
    const shown = new Set(visible.map((row) => row.uid));
    setSelected((current) => {
      const next = new Set([...current].filter((uid) => shown.has(uid)));
      return next.size === current.size ? current : next;
    });
  }, [visible]);

  const sortBy = (key: SortKey) => update({
    sort: key,
    dir: view.sort === key ? (view.dir === "asc" ? "desc" : "asc") : (key === "name" || key === "category" || key === "unit" ? "asc" : "desc"),
  });
  const openItem = (uid: string) => update({ item: uid }, { push: !view.item });
  const allSelected = visible.length > 0 && visible.every((row) => selected.has(row.uid));

  // ── Bulk actions ──
  const uids = [...selected];

  async function previewOp(title: string, op: BulkOp, { confirm }: { confirm: boolean }) {
    setBusy("Working out the changes…");
    try {
      const result = await priceBookApi.bulkPreview(uids, op);
      if (confirm) { setPreview({ title, op, result }); return; }
      await applyOp(op, result);
    } catch (err) {
      shell.toast(errorMessage(err, "Those items could not be changed."));
    } finally {
      setBusy(null);
    }
  }

  async function applyOp(op: BulkOp, result: BulkResult) {
    const expected = Object.fromEntries(result.rows.filter((row) => row.version != null).map((row) => [row.uid, row.version as number]));
    setBusy("Saving…");
    try {
      const applied = await priceBookApi.bulkApply(uids, op, expected);
      setPreview(null);
      setSelected(new Set());
      const { updated, skipped } = applied.summary;
      shell.toast(`Updated ${updated} ${updated === 1 ? "item" : "items"}${skipped ? `, skipped ${skipped}` : ""}`);
      await data.reload();
    } catch (err) {
      shell.toast(errorCode(err) === "VERSION_CONFLICT" ? "Some of those items changed since the preview. Try again to see their current prices." : errorMessage(err, "Those items could not be changed."));
      setPreview(null);
      await data.reload();
    } finally {
      setBusy(null);
    }
  }

  async function perItem(label: string, targets: PriceBookRow[], patchFor: (row: PriceBookRow) => Record<string, unknown> | null) {
    const work = targets.map((row) => ({ row, patch: patchFor(row) })).filter((entry) => entry.patch);
    if (!work.length) { shell.toast("Nothing to change."); return; }
    const result = await runInSequence(work, ({ row, patch }) => priceBookApi.updateItem(row.uid, patch!, row.version), (done, total) => setBusy(`${label} ${done} of ${total}…`));
    setBusy(null);
    setSelected(new Set());
    await data.reload();
    const ok = work.length - result.failed.length;
    shell.toast(result.failed.length ? `Updated ${ok}; ${result.failed.length} changed elsewhere and were left alone. Try them again.` : `Updated ${ok} ${ok === 1 ? "item" : "items"}`);
  }

  const tagsOnSelection = [...new Set(selectedRows.flatMap((row) => row.tags))].sort();
  const categoryItems: MenuItem[] = [
    ...allCategories.map((name) => ({ label: name, onSelect: () => void previewOp(`Move to ${name}`, { setCategory: name }, { confirm: false }) })),
    ...(allCategories.length ? [{ kind: "separator" } as const] : []),
    { label: "New category…", icon: <Plus aria-hidden />, onSelect: () => setBulkPrompt({ kind: "category" }) },
    { label: "Remove category", onSelect: () => void previewOp("Remove category", { setCategory: null }, { confirm: false }) },
  ];
  const tagItems: MenuItem[] = [
    { label: "Add a tag…", icon: <Plus aria-hidden />, onSelect: () => setBulkPrompt({ kind: "addTag" }) },
    ...(tagsOnSelection.length ? [{ kind: "separator" } as const] : []),
    ...tagsOnSelection.map((tag) => ({ label: `Remove “${tag}”`, icon: <X aria-hidden />, onSelect: () => void perItem("Removing tag from", selectedRows, (row) => (row.tags.includes(tag) ? { tags: removeTag(row.tags, tag) } : null)) })),
  ];
  const priceItems: MenuItem[] = [
    { label: "Set markup…", onSelect: () => setBulkPrompt({ kind: "price", op: "setMarkupPct" }) },
    { label: "Change cost by %…", onSelect: () => setBulkPrompt({ kind: "price", op: "adjustCostPct" }) },
    { label: "Change fixed selling price by %…", onSelect: () => setBulkPrompt({ kind: "price", op: "adjustSellPct" }) },
  ];
  const canArchive = selectedRows.some((row) => row.status !== "archived");
  const canRestore = selectedRows.some((row) => row.status !== "active");

  const dropdown = (label: string, icon: React.ReactNode, items: MenuItem[]) => (
    <Menu label={label} items={items} align="start" trigger={(props) => (
      <button type="button" className="fx-btn fx-btn--sm" disabled={Boolean(busy)} {...props}>{icon}{label}<ChevronDown aria-hidden /></button>
    )} />
  );

  const loading = !data.rows && !data.error;
  const empty = data.rows && rows.length === 0;

  return (
    <>
      <header className="fx-ph">
        <h1 className="fx-ph__title">Catalogue</h1>
        {data.rows && <span className="fx-mute fx-num" style={{ fontSize: 12 }}>{rows.filter((row) => row.status === "active").length} active</span>}
        <div className="fx-spacer" />
        <label className="fx-filter">
          <Search aria-hidden />
          <input
            aria-label="Search the catalogue"
            placeholder="Search items, tags, supplier codes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setSearch(""); }}
          />
        </label>
        <button type="button" className="fx-btn" onClick={() => navigate("/pricing/import")}><Upload aria-hidden />Import price list</button>
        <Menu
          label="Manage"
          items={[
            { label: "Categories", onSelect: () => update({ manage: "categories" }) },
            { label: "Tags", onSelect: () => update({ manage: "tags" }) },
            { label: "Units", onSelect: () => update({ manage: "units" }) },
            { label: "Suppliers", onSelect: () => update({ manage: "suppliers" }) },
          ]}
          trigger={(props) => <button type="button" className="fx-btn" {...props}><SlidersHorizontal aria-hidden />Manage<ChevronDown aria-hidden /></button>}
        />
        <button type="button" className="fx-btn fx-btn--primary" onClick={() => update({ item: NEW_ITEM }, { push: !view.item })}><Plus aria-hidden />New item</button>
      </header>

      <div className="fx-toolbar">
        <div className="fx-seg" role="group" aria-label="Status">
          {(["active", "draft", "archived", "all"] as StatusFilter[]).filter((status) => status !== "draft" || facets.status.draft > 0 || view.status === "draft").map((status) => (
            <button key={status} type="button" aria-pressed={view.status === status} onClick={() => update({ status })}>
              {STATUS_LABEL[status]}{status !== "all" && <span className="fx-seg__count">{facets.status[status]}</span>}
            </button>
          ))}
        </div>
        {(health.attention.size > 0 || view.health) && (
          <button type="button" className="fx-chip fx-chip--warn" aria-pressed={view.health} onClick={() => update(view.health ? { health: false, status: "active" } : { health: true, status: "all" })}>
            <AlertTriangle aria-hidden />{health.attention.size} need attention
          </button>
        )}
        {allTags.length > 0 && (
          <Menu
            label="Filter by tag"
            align="start"
            items={[
              ...(view.tag ? [{ label: "Any tag", onSelect: () => update({ tag: null }) }, { kind: "separator" } as const] : []),
              ...facets.tags.map((facet) => ({ label: `${facet.name} (${facet.count})`, onSelect: () => update({ tag: facet.name }) })),
            ]}
            trigger={(props) => <button type="button" className="fx-chip" aria-pressed={Boolean(view.tag)} {...props}><Tags aria-hidden />{view.tag ? view.tag : "Tag"}<ChevronDown aria-hidden /></button>}
          />
        )}
        {supplierName && <button type="button" className="fx-chip" aria-pressed="true" onClick={() => update({ supplier: null })}>{supplierName}<X aria-hidden /></button>}
        {view.unit && <button type="button" className="fx-chip" aria-pressed="true" onClick={() => update({ unit: null })}>Per {formatCatalogUnit(view.unit)}<X aria-hidden /></button>}
        <div className="fx-chips" role="group" aria-label="Categories" style={{ flexWrap: "nowrap", overflowX: "auto", flex: "1 1 240px", paddingBottom: 1 }}>
          <button type="button" className="fx-chip" aria-pressed={view.category === null} onClick={() => update({ category: null })}>All categories</button>
          {facets.categories.map((facet) => (
            <button key={facet.name || "(none)"} type="button" className="fx-chip" aria-pressed={view.category === facet.name} onClick={() => update({ category: view.category === facet.name ? null : facet.name })}>
              {facet.name || "Uncategorised"}<span className="fx-chip__n">{facet.count}</span>
            </button>
          ))}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="fx-bulk fx-bulk--dock" role="region" aria-label="Change selected items">
          <b>{selected.size} selected</b>
          {dropdown("Category", null, categoryItems)}
          {dropdown("Tags", <Tag aria-hidden />, tagItems)}
          {dropdown("Prices", null, priceItems)}
          {canArchive && <button type="button" className="fx-btn fx-btn--sm" disabled={Boolean(busy)} onClick={() => void previewOp(`Archive ${selected.size} ${selected.size === 1 ? "item" : "items"}`, { archive: true }, { confirm: true })}><Archive aria-hidden />Archive</button>}
          {canRestore && <button type="button" className="fx-btn fx-btn--sm" disabled={Boolean(busy)} onClick={() => void perItem("Restoring", selectedRows, (row) => (row.status === "active" ? null : { status: "active" }))}><ArchiveRestore aria-hidden />{selectedRows.every((row) => row.status === "draft") ? "Make active" : "Restore"}</button>}
          {busy && <span className="" role="status" style={{ fontSize: 12 }}>{busy}</span>}
        
          <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      {view.health && health.unattached.length > 0 && (
        <div className="fx-notice fx-notice--warn">
          <AlertTriangle aria-hidden />
          <span>
            {health.unattached.map((issue, index) => (
              <span key={`${issue.key}-${index}`} style={{ display: "block" }}>
                {issue.message}
                {issue.importUid && <> <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => navigate(`/pricing/import/${encodeURIComponent(issue.importUid!)}`)}>Open the import</button></>}
              </span>
            ))}
          </span>
        </div>
      )}

      {data.error && <div className="fx-notice fx-notice--bad"><span>{data.error}</span><button type="button" className="fx-btn fx-btn--sm" onClick={() => void data.reload()}>Try again</button></div>}
      {loading && <div className="fx-loading" style={{ minHeight: 240 }}>Loading the catalogue…</div>}
      {empty && (
        <div style={{ display: "grid", placeItems: "center", padding: "80px 24px", textAlign: "center", gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 650 }}>Nothing in the catalogue yet</div>
          <p className="fx-dim" style={{ margin: 0, maxWidth: 400 }}>Add the materials, labour and plant you price from, or import a supplier's price list. Quotes are built from these.</p>
          <button type="button" className="fx-btn fx-btn--primary" onClick={() => update({ item: NEW_ITEM }, { push: true })}><Plus aria-hidden />New item</button>
        </div>
      )}

      {data.rows && rows.length > 0 && (
        <div className="fx-scroll-x" style={selected.size ? { paddingBottom: 88 } : undefined}>
          <table className="fx-table" aria-label="Catalogue items">
            <thead>
              <tr>
                <th className="fx-check-cell">
                  <input type="checkbox" className="fx-checkbox" aria-label="Select all shown" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map((row) => row.uid)))} />
                </th>
                <SortHeader label="Name" sortKey="name" view={view} onSort={sortBy} />
                <SortHeader label="Category" sortKey="category" view={view} onSort={sortBy} className="fx-hide-sm" />
                <SortHeader label="Unit" sortKey="unit" view={view} onSort={sortBy} className="fx-hide-sm" />
                <SortHeader label="Cost" sortKey="cost" view={view} onSort={sortBy} numeric className="fx-hide-sm" />
                <SortHeader label="Selling" sortKey="sell" view={view} onSort={sortBy} numeric />
                <SortHeader label="Margin" sortKey="margin" view={view} onSort={sortBy} numeric />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const issues = health.byUid.get(row.uid);
                const reason = health.attention.has(row.uid) ? healthSummary(issues) : null;
                const marginTone = row.warnings.includes("negative_margin") ? "var(--t-danger)" : row.warnings.includes("low_margin") ? "var(--t-warn)" : undefined;
                return (
                  <tr
                    key={row.uid}
                    data-click
                    tabIndex={0}
                    aria-selected={selected.has(row.uid) || view.item === row.uid || undefined}
                    onClick={() => openItem(row.uid)}
                    onKeyDown={(event) => { if (event.key === "Enter") openItem(row.uid); }}
                    style={row.status === "archived" ? { color: "var(--t-dim)" } : undefined}
                  >
                    <td className="fx-check-cell" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="fx-checkbox"
                        aria-label={`Select ${row.name}`}
                        checked={selected.has(row.uid)}
                        onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(row.uid)) next.delete(row.uid); else next.add(row.uid); return next; })}
                      />
                    </td>
                    <td style={{ maxWidth: 0, width: "44%" }}>
                      <div className="fx-name">
                        <b>{row.name}</b>
                        {row.child_count > 0 && <span className="fx-mute" style={{ fontSize: 11.5, whiteSpace: "nowrap" }} title={`Built from ${row.child_count} parts`}>kit · {row.child_count}</span>}
                        {row.status !== "active" && <span className={`fx-status fx-status--${row.status === "draft" ? "draft" : "archived"}`} style={{ height: 18, fontSize: 11 }}>{STATUS_LABEL[row.status]}</span>}
                        {row.catalog_type === "component" && <span className="fx-mute" style={{ fontSize: 11.5 }}>component</span>}
                        {row.tags.length > 0 && <span className="fx-name__tags">{row.tags.join(" · ")}</span>}
                      </div>
                      {reason && <div className="fx-name__warn"><AlertTriangle aria-hidden />{reason}</div>}
                    </td>
                    <td className="fx-dim fx-hide-sm">{row.category || <span className="fx-mute">—</span>}</td>
                    <td className="fx-dim fx-hide-sm">{formatCatalogUnit(row.unit)}</td>
                    <td className="fx-r fx-num fx-dim fx-hide-sm" title={row.cost_mode === "rollup" ? "From its parts" : undefined}>{money(row.cost)}</td>
                    <td className="fx-r fx-num" title={row.pending_price ? `Price change scheduled for ${row.pending_price.effective_from.slice(0, 10)}` : undefined}>{money(row.sell)}{row.pending_price ? <span style={{ color: "var(--t-warn)" }}> •</span> : null}</td>
                    <td className="fx-r fx-num" style={marginTone ? { color: marginTone } : undefined}>{row.margin_pct == null ? "—" : `${row.margin_pct.toFixed(1)}%`}</td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr className="fx-table__empty"><td colSpan={7}>No items match. Clear a filter or search for something else.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view.item && (
        <ItemDrawer
          key={view.item}
          itemRef={view.item}
          rows={rows}
          categories={allCategories}
          tags={allTags}
          suppliers={data.suppliers}
          issuesFor={(uid) => health.byUid.get(uid)}
          onClose={() => update({ item: null })}
          onOpen={(uid) => update({ item: uid })}
          onChanged={(uid) => { void data.reload(); if (uid) update({ item: uid }); }}
          onManageSuppliers={() => update({ item: null, manage: "suppliers" })}
        />
      )}

      {view.manage && !view.item && (
        <ManagerSheet
          tab={view.manage}
          data={data}
          onTab={(tab: ManagerTab) => update({ manage: tab })}
          onClose={() => update({ manage: null })}
          onFilter={(patch) => { setSearch(""); update({ ...patch, q: "", manage: null, status: "all" }); }}
        />
      )}

      {bulkPrompt?.kind === "category" && (
        <PromptBox title="Move to a new category" label="Category name" options={allCategories} submitLabel="Move" onCancel={() => setBulkPrompt(null)} onSubmit={(name) => { setBulkPrompt(null); void previewOp(`Move to ${name}`, { setCategory: name }, { confirm: false }); }} />
      )}
      {bulkPrompt?.kind === "addTag" && (
        <PromptBox title={`Tag ${selected.size} ${selected.size === 1 ? "item" : "items"}`} label="Tag" options={allTags} submitLabel="Add tag" onCancel={() => setBulkPrompt(null)} onSubmit={(tag) => { setBulkPrompt(null); void perItem("Tagging", selectedRows, (row) => { const next = addTag(row.tags, tag); return next === row.tags ? null : { tags: next }; }); }} />
      )}
      {bulkPrompt?.kind === "price" && (
        <PromptBox
          title={PRICE_PROMPTS[bulkPrompt.op].title}
          label={PRICE_PROMPTS[bulkPrompt.op].label}
          hint={PRICE_PROMPTS[bulkPrompt.op].hint}
          suffix="%"
          numeric
          submitLabel={PRICE_PROMPTS[bulkPrompt.op].submit}
          validate={(value) => {
            const n = Number(value.replace(/[%\s]/g, ""));
            if (!value.trim() || !Number.isFinite(n)) return "Enter a number";
            if (bulkPrompt.op !== "setMarkupPct" && n <= -100) return "A decrease must be less than 100%";
            return null;
          }}
          onCancel={() => setBulkPrompt(null)}
          onSubmit={(value) => {
            const n = Number(value.replace(/[%\s]/g, ""));
            const op = bulkPrompt.op;
            setBulkPrompt(null);
            const title = op === "setMarkupPct" ? `Set markup to ${n}%` : `${op === "adjustCostPct" ? "Cost" : "Fixed selling price"} ${n > 0 ? "+" : ""}${n}%`;
            void previewOp(title, { [op]: n } as BulkOp, { confirm: true });
          }}
        />
      )}
      {preview && <BulkPreviewBox title={preview.title} result={preview.result} busy={busy === "Saving…"} onCancel={() => setPreview(null)} onApply={() => void applyOp(preview.op, preview.result)} />}
    </>
  );
}

function SortHeader({ label, sortKey, view, onSort, numeric, className }: {
  label: string;
  sortKey: SortKey;
  view: CatalogueView;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  className?: string;
}) {
  const active = view.sort === sortKey;
  return (
    <th className={[numeric ? "fx-r" : "", className || ""].join(" ").trim() || undefined} aria-sort={active ? (view.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" data-active={active} onClick={() => onSort(sortKey)}>
        {label}{active ? (view.dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
}

/** The confirm step for a change that touches prices or archives: how many, and the before and after. */
function BulkPreviewBox({ title, result, busy, onCancel, onApply }: { title: string; result: BulkResult; busy: boolean; onCancel: () => void; onApply: () => void }) {
  const summary = bulkSummary(result.rows);
  const isPrice = !("archive" in result.op);
  const skipped = result.rows.filter((row) => row.action === "skip");
  const warned = result.rows.filter((row) => row.action === "update" && row.warnings.length);
  const pctText = (value: number) => `${round(value, 1)}%`;
  return (
    <ConfirmBox
      title={title}
      confirmLabel={summary.changing ? `${isPrice ? "Change" : "Archive"} ${summary.changing} ${summary.changing === 1 ? "item" : "items"}` : "Nothing to change"}
      busy={busy}
      tone={isPrice ? undefined : "danger"}
      onCancel={onCancel}
      onConfirm={() => { if (summary.changing) onApply(); else onCancel(); }}
    >
      <p style={{ margin: 0 }}>
        <b>{summary.changing}</b> {summary.changing === 1 ? "item changes" : "items change"}{summary.skipped ? `, ${summary.skipped} skipped` : ""}.
        {isPrice && " Each new price is added to the item's history, effective now; sent quotes keep their prices."}
      </p>
      {isPrice && summary.changing > 0 && (
        <div className="fx-grid2">
          <div className="fx-figure"><span>Selling</span><b style={{ fontSize: 14 }}>{formatRange(summary.sellAfter, money)}</b><span className="fx-hint">was {formatRange(summary.sellBefore, money)}</span></div>
          <div className="fx-figure"><span>Margin</span><b style={{ fontSize: 14 }}>{formatRange(summary.marginAfter, pctText)}</b><span className="fx-hint">was {formatRange(summary.marginBefore, pctText)}</span></div>
        </div>
      )}
      {warned.length > 0 && (
        <details open={!isPrice}>
          <summary className="fx-hint" style={{ cursor: "pointer", color: "var(--t-warn)" }}>{warned.length} with warnings</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, maxHeight: 140, overflowY: "auto" }}>
            {warned.map((row) => <li key={row.uid}><b style={{ fontWeight: 600 }}>{row.name}</b>: {row.warnings.map((warning) => warning.message).join("; ")}</li>)}
          </ul>
        </details>
      )}
      {skipped.length > 0 && (
        <details>
          <summary className="fx-hint" style={{ cursor: "pointer" }}>{skipped.length} skipped</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, maxHeight: 140, overflowY: "auto" }}>
            {skipped.map((row) => <li key={row.uid}><b style={{ fontWeight: 600 }}>{row.name}</b>: {row.reason}</li>)}
          </ul>
        </details>
      )}
    </ConfirmBox>
  );
}
