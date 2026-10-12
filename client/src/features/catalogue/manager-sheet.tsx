// Managing the catalogue's collections as a whole, the way a tag or custom
// field manager works: each list shows how many items use an entry, opens the
// table filtered to it, and renames, merges, reorders or retires it.
import { useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, X } from "lucide-react";
import { Menu, type MenuItem } from "@/components/shell/menu";
import { useShell } from "@/components/shell/shell-context";
import { errorMessage, priceBookApi, type PriceBookRow } from "@/features/pricing/price-book-api";
import { CATALOG_UNIT_ALIASES, CATALOG_UNIT_DEFINITIONS, formatCatalogUnit } from "../../../../shared/catalog-units.js";
import { catalogueApi } from "./catalogue-api";
import { categoryEntries, moveId, renameTag, runInSequence, type CatalogueView, type CategoryEntry, type ManagerTab } from "./catalogue-model";
import { ConfirmBox, PromptBox } from "./catalogue-dialogs";
import type { CatalogueData } from "./catalogue-page";

type Props = {
  tab: ManagerTab;
  data: CatalogueData;
  onTab: (tab: ManagerTab) => void;
  onClose: () => void;
  onFilter: (patch: Partial<CatalogueView>) => void;
};

const TABS: Array<[ManagerTab, string]> = [["categories", "Categories"], ["tags", "Tags"], ["units", "Units"], ["suppliers", "Suppliers"]];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ManagerSheet({ tab, data, onTab, onClose, onFilter }: Props) {
  const rows = data.rows || [];
  return createPortal(
    <>
      <div className="fx-scrim fx-scrim--sheet fx-scrim--clear" onMouseDown={onClose}>
      <aside
        className="fx-sheet fx-sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Manage the catalogue"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape" && !document.querySelector(".fx-scrim:not(.fx-scrim--sheet), .fx-menu")) onClose(); }}
      >
        <div className="fx-sheet__h">
          <span style={{ flex: 1 }}>Manage the catalogue</span>
          <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="Close" onClick={onClose} autoFocus><X aria-hidden /></button>
        </div>
        <div className="fx-tabs" role="tablist" aria-label="Collections">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}>{label}</button>
          ))}
        </div>
        <div className="fx-sheet__b" role="tabpanel">
          {tab === "categories" && <CategoriesPanel rows={rows} data={data} onFilter={onFilter} />}
          {tab === "tags" && <TagsPanel rows={rows} data={data} onFilter={onFilter} />}
          {tab === "units" && <UnitsPanel rows={rows} onFilter={onFilter} />}
          {tab === "suppliers" && <SuppliersPanel rows={rows} data={data} onFilter={onFilter} />}
        </div>
      </aside>
      </div>
    </>,
    document.body,
  );
}

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  return (
    <Menu label={label} items={items} trigger={(props) => (
      <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon fx-btn--sm" aria-label={label} {...props}><MoreHorizontal aria-hidden /></button>
    )} />
  );
}

function AddForm({ placeholder, label, onAdd }: { placeholder: string; label: string; onAdd: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try { await onAdd(name.trim()); setName(""); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
      <input className="fx-input" aria-label={label} placeholder={placeholder} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      <button type="submit" className="fx-btn" disabled={busy || !name.trim()}><Plus aria-hidden />Add</button>
    </form>
  );
}

/** Move every item in `rows` to `category` in one versioned batch. */
async function moveItems(rows: PriceBookRow[], category: string | null) {
  if (!rows.length) return;
  const uids = rows.map((row) => row.uid);
  const op = { setCategory: category };
  const preview = await priceBookApi.bulkPreview(uids, op);
  const expected = Object.fromEntries(preview.rows.filter((row) => row.version != null).map((row) => [row.uid, row.version as number]));
  await priceBookApi.bulkApply(uids, op, expected);
}

function CategoriesPanel({ rows, data, onFilter }: { rows: PriceBookRow[]; data: CatalogueData; onFilter: Props["onFilter"] }) {
  const shell = useShell();
  const entries = useMemo(() => categoryEntries(data.categories, rows), [data.categories, rows]);
  const managedIds = entries.filter((entry) => entry.id != null).map((entry) => entry.id as number);
  const [renaming, setRenaming] = useState<CategoryEntry | null>(null);
  const [merging, setMerging] = useState<CategoryEntry | null>(null);
  const [deleting, setDeleting] = useState<CategoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const itemsIn = (name: string) => rows.filter((row) => (row.category || "").toLowerCase() === name.toLowerCase());

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    try { await work(); shell.toast(done); } catch (err) { shell.toast(errorMessage(err, "That change could not be made.")); } finally { setBusy(false); await data.reload(); }
  }

  function rename(entry: CategoryEntry, name: string) {
    setRenaming(null);
    const target = entries.find((candidate) => candidate !== entry && candidate.name.toLowerCase() === name.toLowerCase());
    if (target) { void merge(entry, target); return; }
    void run(async () => {
      await moveItems(itemsIn(entry.name), name);
      if (entry.id != null) await catalogueApi.renameCategory(entry.id, name);
      else await catalogueApi.createCategory(name);
    }, `Renamed ${entry.name} to ${name}`);
  }

  function merge(source: CategoryEntry, target: CategoryEntry) {
    setMerging(null);
    return run(async () => {
      await moveItems(itemsIn(source.name), target.name);
      if (source.id != null) await catalogueApi.deleteCategory(source.id);
    }, `Merged ${source.name} into ${target.name}`);
  }

  function reorder(id: number, delta: -1 | 1) {
    void run(async () => { await catalogueApi.reorderCategories(moveId(managedIds, id, delta)); }, "Order saved");
  }

  return (
    <section className="fx-sheet__sec">
      <p className="fx-hint">The work sections items are grouped by. Their order here is the order of the filter chips on the table.</p>
      <AddForm label="New category" placeholder="New category, e.g. Retaining walls" onAdd={async (name) => {
        try { await catalogueApi.createCategory(name); shell.toast(`Added ${name}`); await data.reload(); } catch (err) { shell.toast(errorMessage(err, "The category could not be added.")); }
      }} />
      <table className="fx-table" aria-label="Categories" style={{ opacity: busy ? 0.6 : 1 }}>
        <thead><tr><th style={{ width: 64 }}><span hidden>Order</span></th><th>Category</th><th className="fx-r">Items</th><th style={{ width: 32 }}><span hidden>Actions</span></th></tr></thead>
        <tbody>
          {entries.map((entry) => {
            const index = entry.id == null ? -1 : managedIds.indexOf(entry.id);
            return (
              <tr key={`${entry.id ?? "loose"}-${entry.name}`}>
                <td>
                  {entry.id != null && (
                    <span style={{ display: "flex", gap: 2 }}>
                      <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon fx-btn--sm" aria-label={`Move ${entry.name} up`} disabled={busy || index === 0} onClick={() => reorder(entry.id!, -1)}><ArrowUp aria-hidden /></button>
                      <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon fx-btn--sm" aria-label={`Move ${entry.name} down`} disabled={busy || index === managedIds.length - 1} onClick={() => reorder(entry.id!, 1)}><ArrowDown aria-hidden /></button>
                    </span>
                  )}
                </td>
                <td>
                  <span className="fx-table__strong">{entry.name}</span>
                  {entry.id == null && <span className="fx-mute" style={{ fontSize: 12 }}> · only on items</span>}
                </td>
                <td className="fx-r fx-num">
                  {entry.count ? <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => onFilter({ category: entry.name })}>{plural(entry.count, "item")}</button> : <span className="fx-mute">none</span>}
                </td>
                <td>
                  <RowMenu label={`${entry.name} actions`} items={[
                    { label: "Show these items", onSelect: () => onFilter({ category: entry.name }), disabled: !entry.count },
                    { label: "Rename…", onSelect: () => setRenaming(entry) },
                    { label: "Merge into…", onSelect: () => setMerging(entry), disabled: entries.length < 2 },
                    ...(entry.id == null ? [{ label: "Add to the list", onSelect: () => void run(async () => { await catalogueApi.createCategory(entry.name); }, `Added ${entry.name}`) }] : []),
                    { kind: "separator" },
                    entry.id != null
                      ? { label: entry.count ? "Delete (move its items first)" : "Delete", tone: "danger", disabled: entry.count > 0, onSelect: () => setDeleting(entry) }
                      : { label: "Clear from its items", tone: "danger", onSelect: () => setDeleting(entry) },
                  ]} />
                </td>
              </tr>
            );
          })}
          {entries.length === 0 && <tr className="fx-table__empty"><td colSpan={4}>No categories yet.</td></tr>}
        </tbody>
      </table>
      <p className="fx-hint">Categories have no archived state: merge one into another, or delete it once no items use it.</p>

      {renaming && (
        <PromptBox title={`Rename ${renaming.name}`} label="Name" initial={renaming.name} submitLabel="Rename" hint={renaming.count ? `${plural(renaming.count, "item")} move with it. Using another category's name merges them.` : undefined} onCancel={() => setRenaming(null)} onSubmit={(name) => rename(renaming, name)} />
      )}
      {merging && (
        <PromptBox
          title={`Merge ${merging.name} into…`}
          label="Category to keep"
          options={entries.filter((entry) => entry !== merging).map((entry) => entry.name)}
          submitLabel="Merge"
          hint={`${plural(merging.count, "item")} move to the category you pick, and ${merging.name} is removed.`}
          validate={(value) => (entries.some((entry) => entry !== merging && entry.name.toLowerCase() === value.trim().toLowerCase()) ? null : "Pick an existing category")}
          onCancel={() => setMerging(null)}
          onSubmit={(name) => { const target = entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase()); if (target) void merge(merging, target); }}
        />
      )}
      {deleting && (
        <ConfirmBox
          title={deleting.id != null ? `Delete ${deleting.name}?` : `Clear ${deleting.name} from ${plural(deleting.count, "item")}?`}
          confirmLabel={deleting.id != null ? "Delete" : "Clear"}
          tone="danger"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const entry = deleting;
            setDeleting(null);
            void run(async () => {
              if (entry.id != null) await catalogueApi.deleteCategory(entry.id);
              else await moveItems(itemsIn(entry.name), null);
            }, entry.id != null ? `Deleted ${entry.name}` : `Cleared ${entry.name}`);
          }}
        >
          <p style={{ margin: 0 }}>{deleting.id != null ? "Nothing uses it, so nothing else changes." : "Those items become uncategorised."}</p>
        </ConfirmBox>
      )}
    </section>
  );
}

function TagsPanel({ rows, data, onFilter }: { rows: PriceBookRow[]; data: CatalogueData; onFilter: Props["onFilter"] }) {
  const shell = useShell();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) for (const tag of row.tags) map.set(tag, (map.get(tag) || 0) + 1);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  async function rewrite(tag: string, next: (tags: string[]) => string[], done: string) {
    const targets = rows.filter((row) => row.tags.includes(tag));
    const result = await runInSequence(targets, (row) => priceBookApi.updateItem(row.uid, { tags: next(row.tags) }, row.version), (n, total) => setProgress(`Updating ${n} of ${total}…`));
    setProgress(null);
    await data.reload();
    shell.toast(result.failed.length ? `${done}, except ${plural(result.failed.length, "item")} changed elsewhere; try again` : done);
  }

  return (
    <section className="fx-sheet__sec">
      <p className="fx-hint">Tags are free labels on items, added in an item or to several at once from the table. Rename or merge them here.</p>
      {progress && <p className="fx-hint" role="status">{progress}</p>}
      <table className="fx-table" aria-label="Tags">
        <thead><tr><th>Tag</th><th className="fx-r">Items</th><th style={{ width: 32 }}><span hidden>Actions</span></th></tr></thead>
        <tbody>
          {counts.map(([tag, count]) => (
            <tr key={tag}>
              <td><span className="fx-chip fx-chip--tag" style={{ paddingRight: 9 }}>{tag}</span></td>
              <td className="fx-r"><button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-num" onClick={() => onFilter({ tag })}>{plural(count, "item")}</button></td>
              <td>
                <RowMenu label={`${tag} actions`} items={[
                  { label: "Show these items", onSelect: () => onFilter({ tag }) },
                  { label: "Rename or merge…", onSelect: () => setRenaming(tag), disabled: Boolean(progress) },
                  { kind: "separator" },
                  { label: "Remove from every item", tone: "danger", onSelect: () => setRemoving(tag), disabled: Boolean(progress) },
                ]} />
              </td>
            </tr>
          ))}
          {counts.length === 0 && <tr className="fx-table__empty"><td colSpan={3}>No tags yet. Add them in an item, or select items on the table and choose Tags.</td></tr>}
        </tbody>
      </table>
      {renaming && (
        <PromptBox
          title={`Rename “${renaming}”`}
          label="New name"
          initial={renaming}
          options={counts.map(([tag]) => tag).filter((tag) => tag !== renaming)}
          hint="Using another tag's name merges the two."
          submitLabel="Rename"
          onCancel={() => setRenaming(null)}
          onSubmit={(name) => { const from = renaming; setRenaming(null); if (name !== from) void rewrite(from, (tags) => renameTag(tags, from, name), `Renamed ${from} to ${name}`); }}
        />
      )}
      {removing && (
        <ConfirmBox title={`Remove “${removing}” from every item?`} confirmLabel="Remove" tone="danger" onCancel={() => setRemoving(null)} onConfirm={() => { const tag = removing; setRemoving(null); void rewrite(tag, (tags) => tags.filter((t) => t !== tag), `Removed ${tag}`); }}>
          <p style={{ margin: 0 }}>{plural(counts.find(([tag]) => tag === removing)?.[1] || 0, "item")} lose the tag. The items themselves don't change.</p>
        </ConfirmBox>
      )}
    </section>
  );
}

const CONVERTS: Record<string, string> = { hour: "min", min: "hour", m: "mm", mm: "m" };

function UnitsPanel({ rows, onFilter }: { rows: PriceBookRow[]; onFilter: Props["onFilter"] }) {
  const aliases = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [alias, unit] of Object.entries(CATALOG_UNIT_ALIASES)) if (alias !== unit) map.set(unit, [...(map.get(unit) || []), alias]);
    return map;
  }, []);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.unit_code, (map.get(row.unit_code) || 0) + 1);
    return map;
  }, [rows]);
  return (
    <section className="fx-sheet__sec">
      <p className="fx-hint">
        Units are fixed by Field, not edited here: each has a dimension so quantities convert exactly (minutes and hours, millimetres and metres), and a kit can't mix units that don't convert.
        Typing an alias (hrs, metres, ea) saves the unit it stands for.
      </p>
      <table className="fx-table" aria-label="Units">
        <thead><tr><th>Unit</th><th className="fx-hide-sm">Measures</th><th>Also typed as</th><th className="fx-r">Items</th></tr></thead>
        <tbody>
          {CATALOG_UNIT_DEFINITIONS.map((unit) => {
            const count = counts.get(unit.code) || 0;
            return (
              <tr key={unit.code}>
                <td><span className="fx-table__strong">{formatCatalogUnit(unit.code)}</span>{CONVERTS[unit.code] && <span className="fx-mute" style={{ fontSize: 12 }}> · converts to {formatCatalogUnit(CONVERTS[unit.code])}</span>}</td>
                <td className="fx-dim fx-hide-sm">{unit.dimension}</td>
                <td className="fx-dim" style={{ fontSize: 12, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={(aliases.get(unit.code) || []).join(", ")}>{(aliases.get(unit.code) || []).slice(0, 4).join(", ") || "—"}</td>
                <td className="fx-r">{count ? <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-num" onClick={() => onFilter({ unit: unit.code })}>{plural(count, "item")}</button> : <span className="fx-mute">none</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function SuppliersPanel({ rows, data, onFilter }: { rows: PriceBookRow[]; data: CatalogueData; onFilter: Props["onFilter"] }) {
  const shell = useShell();
  const [renaming, setRenaming] = useState<{ uid: string; name: string } | null>(null);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) for (const link of row.suppliers) if (link.supplier_uid) map.set(link.supplier_uid, (map.get(link.supplier_uid) || 0) + 1);
    return map;
  }, [rows]);
  const suppliers = [...data.suppliers].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1));

  async function change(uid: string, patch: { name?: string; status?: "active" | "archived" }, done: string) {
    try { await catalogueApi.updateSupplier(uid, patch); shell.toast(done); } catch (err) { shell.toast(errorMessage(err, "The supplier could not be changed.")); }
    await data.reload();
  }

  return (
    <section className="fx-sheet__sec">
      <p className="fx-hint">Who you buy from. Link an item to a supplier with its supplier code, and that supplier's price list updates the item's cost.</p>
      <AddForm label="New supplier" placeholder="New supplier, e.g. Boral" onAdd={async (name) => {
        try { await catalogueApi.createSupplier(name); shell.toast(`Added ${name}`); await data.reload(); } catch (err) { shell.toast(errorMessage(err, "The supplier could not be added.")); }
      }} />
      <table className="fx-table" aria-label="Suppliers">
        <thead><tr><th>Supplier</th><th className="fx-r">Items</th><th style={{ width: 32 }}><span hidden>Actions</span></th></tr></thead>
        <tbody>
          {suppliers.map((supplier) => {
            const count = counts.get(supplier.uid) || 0;
            return (
              <tr key={supplier.uid}>
                <td>
                  <span className="fx-table__strong" style={supplier.status === "archived" ? { color: "var(--t-dim)" } : undefined}>{supplier.name}</span>
                  {supplier.status === "archived" && <span className="fx-status fx-status--archived" style={{ marginLeft: 8, height: 18, fontSize: 11 }}>Archived</span>}
                </td>
                <td className="fx-r">{count ? <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-num" onClick={() => onFilter({ supplier: supplier.uid })}>{plural(count, "item")}</button> : <span className="fx-mute">none</span>}</td>
                <td>
                  <RowMenu label={`${supplier.name} actions`} items={[
                    { label: "Show these items", onSelect: () => onFilter({ supplier: supplier.uid }), disabled: !count },
                    { label: "Rename…", onSelect: () => setRenaming({ uid: supplier.uid, name: supplier.name }) },
                    { kind: "separator" },
                    supplier.status === "active"
                      ? { label: "Archive", onSelect: () => void change(supplier.uid, { status: "archived" }, `Archived ${supplier.name}`) }
                      : { label: "Restore", onSelect: () => void change(supplier.uid, { status: "active" }, `Restored ${supplier.name}`) },
                  ]} />
                </td>
              </tr>
            );
          })}
          {suppliers.length === 0 && <tr className="fx-table__empty"><td colSpan={3}>No suppliers yet.</td></tr>}
        </tbody>
      </table>
      <p className="fx-hint">Archiving keeps a supplier's links and history but hides it when linking items. Suppliers can't be merged: each supplier code belongs to its own supplier's price list.</p>
      {renaming && (
        <PromptBox title={`Rename ${renaming.name}`} label="Name" initial={renaming.name} submitLabel="Rename" onCancel={() => setRenaming(null)} onSubmit={(name) => { const target = renaming; setRenaming(null); void change(target.uid, { name }, `Renamed ${target.name} to ${name}`); }} />
      )}
    </section>
  );
}
