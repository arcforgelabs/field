// An item, opened in place over the catalogue table: everything about it in
// one sheet, edited where it's read. Prices are append-only history, so edits
// collect in a draft and go together on "Save changes"; nothing saves itself.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, Archive, ArchiveRestore, CheckCircle2, Copy, Layers, MoreHorizontal, Plus, Search, Trash2, X,
} from "lucide-react";
import { Menu, type MenuItem } from "@/components/shell/menu";
import { useShell } from "@/components/shell/shell-context";
import { money } from "@/lib/job-status";
import type { PriceCatalogHealthIssue } from "@/lib/types";
import {
  errorCode, errorMessage, priceBookApi,
  type FieldHistoryRow, type PriceBookRow, type PriceHistoryRow, type Supplier,
} from "@/features/pricing/price-book-api";
import { searchCatalogItems } from "../../../../shared/catalog-search.js";
import {
  CATALOG_UNIT_DEFINITIONS, formatCatalogUnit, getCatalogEntryUnitOptions, normalizeCatalogUnit,
} from "../../../../shared/catalog-units.js";
import { catalogueApi, type ItemDetail } from "./catalogue-api";
import {
  addTag, componentFromRow, componentQuantity, draftFromDetail, emptyDraft, livePrice, NEW_ITEM, planIsEmpty,
  planSave, removeTag, round, sentenceCase,
  type CostMode, type DraftComponent, type ItemDraft, type PricingBasis, type SellMode,
} from "./catalogue-model";
import { ConfirmBox } from "./catalogue-dialogs";

type Props = {
  itemRef: string;
  rows: PriceBookRow[];
  categories: string[];
  tags: string[];
  suppliers: Supplier[];
  issuesFor: (uid: string) => PriceCatalogHealthIssue[] | undefined;
  onClose: () => void;
  onOpen: (uid: string) => void;
  onChanged: (openUid?: string) => void;
  onManageSuppliers: () => void;
};

const pct = (value: number | null) => (value == null ? "—" : `${round(value, 1)}%`);
const BASIS_LABEL: Record<Exclude<PricingBasis, "">, string> = {
  per_tonne: "Density (tonnes per m³)",
  per_load: "Load size (m³ per load)",
  per_m3: "Conversion factor",
};

function when(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export function ItemDrawer({ itemRef, rows, categories, tags, suppliers, issuesFor, onClose, onOpen, onChanged, onManageSuppliers }: Props) {
  const shell = useShell();
  const isNew = itemRef === NEW_ITEM;
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [base, setBase] = useState<ItemDraft | null>(null);
  const [draft, setDraft] = useState<ItemDraft>(emptyDraft);
  const [prices, setPrices] = useState<PriceHistoryRow[] | null>(null);
  const [changes, setChanges] = useState<FieldHistoryRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const [confirm, setConfirm] = useState<null | "delete" | "archive">(null);
  const [showAllPrices, setShowAllPrices] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (ref: string) => {
    const item = await catalogueApi.item(ref);
    const [links, priceRows, fieldRows] = await Promise.all([
      priceBookApi.itemSuppliers(item.uid),
      priceBookApi.priceHistory(item.uid).catch(() => [] as PriceHistoryRow[]),
      priceBookApi.fieldHistory(item.uid).catch(() => [] as FieldHistoryRow[]),
    ]);
    const fresh = draftFromDetail(item, links);
    setDetail(item);
    setBase(fresh);
    setPrices(priceRows);
    setChanges(fieldRows);
    return fresh;
  }, []);

  useEffect(() => {
    if (isNew) { titleRef.current?.focus(); return; }
    let live = true;
    load(itemRef)
      .then((fresh) => { if (live) setDraft(structuredClone(fresh)); })
      .catch((err) => { if (live) setLoadError(errorCode(err) === "NOT_FOUND" || /not found/i.test(errorMessage(err, "")) ? "This item isn't in the catalogue any more." : errorMessage(err, "The item could not be loaded.")); });
    return () => { live = false; };
  }, [isNew, itemRef, load]);

  const row = useMemo(() => rows.find((candidate) => candidate.uid === detail?.uid) || null, [rows, detail]);
  const recipeParts = useMemo(() => (detail?.children || []).filter((child) => child.source === "recipe"), [detail]);
  const plan = useMemo(() => planSave(isNew ? null : base, draft, { recipe: recipeParts.length > 0 }), [isNew, base, draft, recipeParts.length]);
  const dirty = isNew ? Boolean(draft.name.trim()) || !planIsEmpty({ ...plan, item: {} }) : Boolean(base) && !planIsEmpty(plan);
  const fallback = recipeParts.length && detail ? { cost: detail.effective_buy_price, sell: detail.effective_sell_price, problems: [] } : null;
  const live = livePrice(draft.price, draft.components, fallback);
  const hasParts = draft.components.length > 0 || recipeParts.length > 0;
  const pending = row?.pending_price || null;
  const issues = detail ? issuesFor(detail.uid) || [] : [];

  // Leaving with unsaved edits asks first; so does the browser.
  const guard = useCallback((then: () => void) => {
    if (saving) return;
    if (dirty) setLeaving(() => then);
    else then();
  }, [dirty, saving]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || document.querySelector(".fx-scrim:not(.fx-scrim--sheet), .fx-menu, .fx-pop")) return;
      event.preventDefault();
      guard(onClose);
    }
    function onUnload(event: BeforeUnloadEvent) { if (dirty) event.preventDefault(); }
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onUnload); };
  }, [guard, onClose, dirty]);

  const set = (patch: Partial<ItemDraft>) => { setDraft((current) => ({ ...current, ...patch })); setSaveError(null); };
  const setPrice = (patch: Partial<ItemDraft["price"]>) => set({ price: { ...draft.price, ...patch } });
  const setPart = (uid: string, patch: Partial<DraftComponent>) => set({ components: draft.components.map((part) => (part.uid === uid ? { ...part, ...patch } : part)) });

  function receipt(name: string) {
    const before = base ? livePrice(base.price, base.components, fallback).sell : null;
    if (!isNew && before != null && live.sell != null && round(before, 2) !== round(live.sell, 2)) {
      return `Saved ${name} · selling ${money(before)} → ${money(live.sell)}`;
    }
    return isNew ? `Added ${name} to the catalogue` : `Saved ${name}`;
  }

  async function save() {
    if (plan.errors.length || saving) return;
    setSaving(true);
    setSaveError(null);
    let uid = detail?.uid || null;
    try {
      if (!uid) {
        const created = await catalogueApi.create(plan.item);
        uid = created.uid;
      } else if (Object.keys(plan.item).length) {
        await catalogueApi.update(uid, plan.item, detail!.version);
      }
      for (const child of plan.removeComponents) await catalogueApi.removeComponent(uid, child);
      for (const part of plan.updateComponents) await catalogueApi.updateComponent(uid, part.uid, part.body);
      for (const part of plan.addComponents) await catalogueApi.addComponent(uid, part.uid, part.body);
      for (const id of plan.unlinkSuppliers) await priceBookApi.unlinkSupplier(uid, id);
      for (const link of plan.linkSuppliers) {
        await priceBookApi.linkSupplier(uid, {
          supplier_uid: link.supplierUid,
          supplier_code: link.supplierCode.trim() || null,
          pack_qty: Number(link.packQty) || 1,
          is_default: link.isDefault,
        });
      }
      shell.toast(receipt(draft.name.trim()));
      if (isNew) { onChanged(uid); return; }
      const fresh = await load(uid);
      setDraft(structuredClone(fresh));
      onChanged();
    } catch (err) {
      const conflict = errorCode(err) === "VERSION_CONFLICT";
      setSaveError(conflict
        ? "Someone else changed this item since you opened it. Discard to see their version, then make your change again."
        : errorMessage(err, "The changes could not be saved."));
      // Whatever did save is now the base, so the bar shows only what's left.
      if (uid && !conflict) {
        if (isNew) { onChanged(uid); return; }
        await load(uid).catch(() => undefined);
        onChanged();
      }
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (isNew) { onClose(); return; }
    setSaveError(null);
    if (base) setDraft(structuredClone(base));
    if (detail) void load(detail.uid).then((fresh) => setDraft(structuredClone(fresh))).catch(() => undefined);
  }

  async function setStatus(status: "active" | "archived") {
    if (!detail) return;
    setConfirm(null);
    try {
      await catalogueApi.update(detail.uid, { status }, detail.version);
      shell.toast(status === "archived" ? `Archived ${detail.name}` : `${detail.name} is active`);
      const fresh = await load(detail.uid);
      setDraft(structuredClone(fresh));
      onChanged();
    } catch (err) {
      shell.toast(errorMessage(err, "The item could not be changed."));
    }
  }

  async function duplicate() {
    if (!detail) return;
    try {
      const copy = await catalogueApi.duplicate(detail.uid);
      shell.toast(`Duplicated as ${copy.name}`);
      onChanged(copy.uid);
    } catch (err) {
      shell.toast(errorMessage(err, "The item could not be duplicated."));
    }
  }

  async function remove() {
    if (!detail) return;
    setConfirm(null);
    try {
      await catalogueApi.remove(detail.uid);
      shell.toast(`Deleted ${detail.name}`);
      onChanged();
      onClose();
    } catch (err) {
      shell.toast(errorMessage(err, "The item could not be deleted."));
    }
  }

  const menu: MenuItem[] = detail ? [
    { label: "Duplicate", icon: <Copy aria-hidden />, onSelect: () => void duplicate(), disabled: dirty },
    detail.status === "active"
      ? { label: "Archive", icon: <Archive aria-hidden />, onSelect: () => setConfirm("archive"), disabled: dirty }
      : { label: detail.status === "draft" ? "Make active" : "Restore", icon: detail.status === "draft" ? <CheckCircle2 aria-hidden /> : <ArchiveRestore aria-hidden />, onSelect: () => void setStatus("active"), disabled: dirty },
    { kind: "separator" },
    { label: "Delete permanently", icon: <Trash2 aria-hidden />, tone: "danger", onSelect: () => setConfirm("delete") },
  ] : [];

  const unitOptions = useMemo(() => {
    const known = CATALOG_UNIT_DEFINITIONS.map((unit) => unit.code);
    const current = normalizeCatalogUnit(draft.unit);
    return current && !known.includes(current) ? [current, ...known] : known;
  }, [draft.unit]);

  const titleId = useId();
  const listIds = { categories: useId(), tags: useId() };
  const priceLocked = Boolean(pending);
  const priceHistory = prices || [];
  const shownPrices = showAllPrices ? priceHistory : priceHistory.slice(0, 5);

  return createPortal(
    <>
      <div className="fx-scrim fx-scrim--sheet fx-scrim--clear" onMouseDown={() => guard(onClose)}>
      <aside className="fx-sheet fx-sheet--wide" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <div className="fx-sheet__h">
          <span id={titleId} hidden>{isNew ? "New item" : draft.name || "Item"}</span>
          <input
            ref={titleRef}
            className="fx-sheet__title"
            aria-label="Name"
            placeholder={isNew ? "Name the item, e.g. 20mm gravel" : "Name"}
            value={draft.name}
            disabled={!isNew && !base}
            onChange={(event) => set({ name: event.target.value })}
          />
          {detail && detail.status !== "active" && (
            <span className={`fx-status fx-status--${detail.status === "draft" ? "draft" : "archived"}`}>{detail.status === "draft" ? "Draft" : "Archived"}</span>
          )}
          {detail && (
            <Menu label="Item actions" items={menu} trigger={(props) => (
              <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="Item actions" {...props}><MoreHorizontal aria-hidden /></button>
            )} />
          )}
          <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon" aria-label="Close" onClick={() => guard(onClose)}><X aria-hidden /></button>
        </div>

        <div className="fx-sheet__b">
          {loadError && <div className="fx-notice fx-notice--bad"><AlertTriangle aria-hidden /><span>{loadError}</span></div>}
          {!isNew && !base && !loadError && <div className="fx-loading" style={{ minHeight: 200 }}>Loading…</div>}

          {(isNew || base) && (
            <>
              {issues.length > 0 && (
                <div className={`fx-notice ${issues.some((issue) => issue.severity === "critical") ? "fx-notice--bad" : "fx-notice--warn"}`} role="status">
                  <AlertTriangle aria-hidden />
                  <span>
                    {issues.map((issue, index) => (
                      <span key={`${issue.key}-${index}`} style={{ display: "block" }}><b>{sentenceCase(issue.label)}.</b> {issue.message}</span>
                    ))}
                  </span>
                </div>
              )}

              <section className="fx-sheet__sec" aria-label="What it is">
                <div className="fx-grid2">
                  <label className="fx-label">Category
                    <input className="fx-input" list={listIds.categories} value={draft.category} placeholder="No category" onChange={(event) => set({ category: event.target.value })} />
                    <datalist id={listIds.categories}>{categories.map((name) => <option key={name} value={name} />)}</datalist>
                  </label>
                  <label className="fx-label">Sold per
                    <select className="fx-select" value={normalizeCatalogUnit(draft.unit)} disabled={priceLocked} onChange={(event) => set({ unit: event.target.value })}>
                      {unitOptions.map((unit) => <option key={unit} value={unit}>{formatCatalogUnit(unit)}</option>)}
                    </select>
                  </label>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div className="fx-seg" role="group" aria-label="What it is">
                    <button type="button" aria-pressed={draft.sellable} onClick={() => set({ sellable: true })}>Sold on quotes</button>
                    <button type="button" aria-pressed={!draft.sellable} onClick={() => set({ sellable: false })}>Component</button>
                  </div>
                  <span className="fx-hint" style={{ flex: "1 1 200px" }}>
                    {draft.sellable
                      ? "Offered first when you add items to a quote."
                      : "A part for kits. It can still be added to a quote by name."}
                  </span>
                </div>
              </section>

              <section className="fx-sheet__sec" aria-label="Price">
                <h3 className="fx-sheet__sh">Price <small>per {formatCatalogUnit(draft.unit) || "unit"}, excluding GST</small></h3>
                {pending && (
                  <div className="fx-notice fx-notice--warn"><AlertTriangle aria-hidden /><span>A price change is scheduled for {when(pending.effective_from)}. Prices and the unit can be changed after it takes effect.</span></div>
                )}
                <div className="fx-grid2">
                  <div className="fx-label">Cost
                    {hasParts && (
                      <ModeSwitch<CostMode> label="Cost from" value={draft.price.costMode} disabled={priceLocked} options={[["manual", "Entered"], ["rollup", "From parts"]]} onChange={(costMode) => setPrice({ costMode })} />
                    )}
                    {draft.price.costMode === "manual" || !hasParts
                      ? <MoneyInput label="Cost" value={draft.price.cost} disabled={priceLocked} onChange={(cost) => setPrice({ cost })} />
                      : <div className="fx-input fx-input--num" aria-label="Cost from parts" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", background: "var(--t-bg)" }}>{money(live.cost)}</div>}
                  </div>
                  <div className="fx-label">Selling
                    <ModeSwitch<SellMode>
                      label="Selling price from"
                      value={draft.price.sellMode}
                      disabled={priceLocked}
                      options={hasParts ? [["markup", "Markup"], ["fixed", "Fixed"], ["rollup", "From parts"]] : [["markup", "Markup"], ["fixed", "Fixed"]]}
                      onChange={(sellMode) => setPrice({ sellMode })}
                    />
                    {draft.price.sellMode === "markup" && (
                      <span className="fx-affix">
                        <input aria-label="Markup percent" inputMode="decimal" value={draft.price.markup} disabled={priceLocked} placeholder="0" style={{ textAlign: "right" }} onChange={(event) => setPrice({ markup: event.target.value })} />
                        <span>% on cost</span>
                      </span>
                    )}
                    {draft.price.sellMode === "fixed" && <MoneyInput label="Selling price" value={draft.price.sell} disabled={priceLocked} onChange={(sell) => setPrice({ sell })} />}
                    {draft.price.sellMode === "rollup" && (
                      <div className="fx-input fx-input--num" aria-label="Selling from parts" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", background: "var(--t-bg)" }}>{money(live.sell)}</div>
                    )}
                  </div>
                </div>
                <div className="fx-grid3" aria-live="polite">
                  <Figure label="Sells for" value={money(live.sell)} />
                  <Figure label="Margin" value={live.margin == null ? "—" : `${pct(live.margin)} · ${money((live.sell ?? 0) - (live.cost ?? 0))}`} tone={live.margin != null && live.margin < 0 ? "bad" : live.margin != null && live.margin < 10 ? "warn" : undefined} />
                  <Figure label="Markup" value={pct(live.markup)} />
                </div>
                <label className="fx-label">Where the price comes from
                  <input className="fx-input" value={draft.priceNote} placeholder="e.g. Boral quote, March" onChange={(event) => set({ priceNote: event.target.value })} />
                </label>
                <details>
                  <summary className="fx-hint" style={{ cursor: "pointer" }}>Disposal costing basis{draft.pricingBasis ? `: ${draft.pricingBasis.replace("_", " ").replace("m3", "m³")}` : ""}</summary>
                  <div className="fx-grid2" style={{ marginTop: 10 }}>
                    <label className="fx-label">Basis
                      <select className="fx-select" value={draft.pricingBasis} disabled={priceLocked} onChange={(event) => set({ pricingBasis: event.target.value as PricingBasis })}>
                        <option value="">Not a disposal item</option>
                        <option value="per_tonne">Per tonne</option>
                        <option value="per_load">Per load</option>
                        <option value="per_m3">Per m³</option>
                      </select>
                    </label>
                    {draft.pricingBasis && (
                      <label className="fx-label">{BASIS_LABEL[draft.pricingBasis]}
                        <input className="fx-input fx-input--num" inputMode="decimal" value={draft.pricingBasisFactor} disabled={priceLocked} onChange={(event) => set({ pricingBasisFactor: event.target.value })} />
                      </label>
                    )}
                  </div>
                </details>
              </section>

              <section className="fx-sheet__sec" aria-label="Built from">
                <h3 className="fx-sheet__sh">Built from <small>{draft.components.length ? "per one " + (formatCatalogUnit(draft.unit) || "unit") : "a kit is any item made of other items"}</small></h3>
                {recipeParts.length > 0 && (
                  <>
                    <p className="fx-hint">These parts come from a quote catalogue recipe and are changed there.</p>
                    <table className="fx-table fx-parts">
                      <tbody>
                        {recipeParts.map((part, index) => (
                          <tr key={`${part.uid || part.code}-${index}`}>
                            <td>{part.name}</td>
                            <td className="fx-r fx-num fx-dim">{part.quantity ?? "—"} {formatCatalogUnit(part.unit || "")}</td>
                            <td className="fx-r fx-num">{money(part.sell_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
                {draft.components.length > 0 && (
                  <table className="fx-table fx-parts">
                    <thead>
                      <tr><th>Part</th><th style={{ width: 150 }}>Quantity</th><th className="fx-r fx-hide-sm" style={{ width: 90 }}>Selling</th><th style={{ width: 32 }}><span hidden>Actions</span></th></tr>
                    </thead>
                    <tbody>
                      {draft.components.map((part) => (
                        <PartRow
                          key={part.uid}
                          part={part}
                          onChange={(patch) => setPart(part.uid, patch)}
                          onRemove={() => set({ components: draft.components.filter((candidate) => candidate.uid !== part.uid) })}
                          onOpen={() => guard(() => onOpen(part.uid))}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
                {recipeParts.length === 0 && (
                  <PartPicker
                    rows={rows}
                    exclude={new Set([detail?.uid || "", ...draft.components.map((part) => part.uid)])}
                    onPick={(picked) => set({ components: [...draft.components, componentFromRow(picked)] })}
                  />
                )}
                {live.rollup && draft.components.length > 0 && (
                  <div className="fx-kv" style={{ borderTop: "1px solid var(--fx-line)", paddingTop: 8 }}>
                    <span>Parts add up to</span>
                    <span className="fx-num">{money(live.rollup.cost)} cost · {money(live.rollup.sell)} selling</span>
                  </div>
                )}
                {live.rollup?.problems.length ? <p className="fx-hint" style={{ color: "var(--t-warn)" }}>Not priced: {live.rollup.problems.join("; ")}</p> : null}
              </section>

              <section className="fx-sheet__sec" aria-label="Details">
                <h3 className="fx-sheet__sh">Details</h3>
                <TagEditor tags={draft.tags} known={tags} listId={listIds.tags} onChange={(next) => set({ tags: next })} />
                <label className="fx-label">Notes
                  <textarea className="fx-textarea" style={{ minHeight: 64 }} value={draft.notes} placeholder="Anything worth knowing about this item" onChange={(event) => set({ notes: event.target.value })} />
                </label>
                {row?.variant_of_name && (
                  <p className="fx-hint">A variant of{" "}
                    {row.variant_of_uid ? <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" style={{ padding: "0 4px" }} onClick={() => guard(() => onOpen(row.variant_of_uid!))}>{row.variant_of_name}</button> : row.variant_of_name}
                  </p>
                )}
              </section>

              <section className="fx-sheet__sec" aria-label="Suppliers">
                <h3 className="fx-sheet__sh">Suppliers
                  {suppliers.some((supplier) => supplier.status === "active") && (
                    <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => {
                      const first = suppliers.find((supplier) => supplier.status === "active" && !draft.suppliers.some((link) => link.supplierUid === supplier.uid));
                      if (!first) return;
                      set({ suppliers: [...draft.suppliers, { id: null, supplierUid: first.uid, supplierName: first.name, supplierCode: "", packQty: "1", isDefault: draft.suppliers.length === 0 }] });
                    }}><Plus aria-hidden />Add supplier</button>
                  )}
                </h3>
                {draft.suppliers.length === 0 && (
                  <p className="fx-hint">
                    {suppliers.length
                      ? "No supplier linked. Link one so price lists can update this item by its supplier code."
                      : <>No suppliers yet. <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" style={{ padding: "0 4px" }} onClick={() => guard(onManageSuppliers)}>Add one in Manage › Suppliers</button></>}
                  </p>
                )}
                {draft.suppliers.map((link, index) => (
                  <div key={link.id ?? `new-${index}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) 70px auto", gap: 8, alignItems: "end" }}>
                    <label className="fx-label">Supplier
                      <select className="fx-select" value={link.supplierUid} onChange={(event) => {
                        const supplier = suppliers.find((candidate) => candidate.uid === event.target.value);
                        set({ suppliers: draft.suppliers.map((candidate, i) => (i === index ? { ...candidate, supplierUid: event.target.value, supplierName: supplier?.name || "" } : candidate)) });
                      }}>
                        {suppliers.filter((supplier) => supplier.status === "active" || supplier.uid === link.supplierUid).map((supplier) => <option key={supplier.uid} value={supplier.uid}>{supplier.name}</option>)}
                      </select>
                    </label>
                    <label className="fx-label">Supplier code
                      <input className="fx-input" style={{ fontFamily: "var(--t-data)" }} value={link.supplierCode} onChange={(event) => set({ suppliers: draft.suppliers.map((candidate, i) => (i === index ? { ...candidate, supplierCode: event.target.value } : candidate)) })} />
                    </label>
                    <label className="fx-label" title="How many of this item come in one supplier pack">Pack
                      <input className="fx-input fx-input--num" inputMode="decimal" value={link.packQty} onChange={(event) => set({ suppliers: draft.suppliers.map((candidate, i) => (i === index ? { ...candidate, packQty: event.target.value } : candidate)) })} />
                    </label>
                    <span style={{ display: "flex", gap: 2, height: 32, alignItems: "center" }}>
                      <label className="fx-check" title="The supplier price lists update this item from">
                        <input type="radio" name="default-supplier" checked={link.isDefault} onChange={() => set({ suppliers: draft.suppliers.map((candidate, i) => ({ ...candidate, isDefault: i === index })) })} />Default
                      </label>
                      <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon fx-btn--sm" aria-label={`Unlink ${link.supplierName}`} onClick={() => set({ suppliers: draft.suppliers.filter((_, i) => i !== index) })}><X aria-hidden /></button>
                    </span>
                  </div>
                ))}
              </section>

              {detail?.used_in && detail.used_in.length > 0 && (
                <section className="fx-sheet__sec" aria-label="Used in">
                  <h3 className="fx-sheet__sh">Used in <small>{detail.used_in.length} {detail.used_in.length === 1 ? "kit" : "kits"}</small></h3>
                  <table className="fx-table fx-parts">
                    <tbody>
                      {detail.used_in.map((kit) => (
                        <tr key={kit.uid} data-click tabIndex={0} onClick={() => guard(() => onOpen(kit.uid))} onKeyDown={(event) => { if (event.key === "Enter") guard(() => onOpen(kit.uid)); }}>
                          <td><span className="fx-name"><Layers aria-hidden /><b>{kit.name}</b>{kit.status !== "active" && <span className="fx-mute">{kit.status}</span>}</span></td>
                          <td className="fx-r fx-num fx-dim">{kit.quantity ?? "—"} per {formatCatalogUnit(kit.unit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {detail && (
                <section className="fx-sheet__sec" aria-label="Price history">
                  <h3 className="fx-sheet__sh">Price history <small>each change is kept, dated; sent quotes keep the price they used</small></h3>
                  {prices === null ? <p className="fx-hint">Loading…</p> : priceHistory.length === 0 ? <p className="fx-hint">No prices recorded.</p> : (
                    <table className="fx-table fx-parts">
                      <thead><tr><th>From</th><th className="fx-r">Cost</th><th className="fx-r fx-hide-sm">Markup</th><th className="fx-r">Selling</th><th className="fx-hide-sm">By</th></tr></thead>
                      <tbody>
                        {shownPrices.map((price) => {
                          const scheduled = price.effective_from ? Date.parse(price.effective_from) > Date.now() : false;
                          return (
                            <tr key={price.price_id} title={price.reason || undefined}>
                              <td>{when(price.effective_from)}{price.current ? <span className="fx-mute"> · current</span> : scheduled ? <span style={{ color: "var(--t-warn)" }}> · scheduled</span> : null}</td>
                              <td className="fx-r fx-num">{price.cost_per_unit == null ? "—" : `$${price.cost_per_unit.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}</td>
                              <td className="fx-r fx-num fx-hide-sm">{pct(price.markup_pct)}</td>
                              <td className="fx-r fx-num">{money(price.sell_price)}</td>
                              <td className="fx-dim fx-hide-sm">{price.source === "manual" ? price.changed_by : `${price.source === "import" ? "Price list" : price.source === "bulk" ? "Bulk change" : sentenceCase(price.source)} · ${price.changed_by}`}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  {priceHistory.length > 5 && (
                    <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => setShowAllPrices((value) => !value)}>
                      {showAllPrices ? "Show fewer" : `Show all ${priceHistory.length}`}
                    </button>
                  )}
                  {changes.length > 0 && (
                    <details>
                      <summary className="fx-hint" style={{ cursor: "pointer" }}>Change log ({changes.length})</summary>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                        {changes.map((change) => (
                          <div key={change.id} style={{ fontSize: 12, display: "grid", gridTemplateColumns: "92px minmax(0, 1fr)", gap: 8 }}>
                            <span className="fx-mute">{when(change.changed_at)}</span>
                            <span>{change.field === "*" ? "Created" : <><b style={{ fontWeight: 600 }}>{change.field.replace(/_/g, " ")}</b> <span className="fx-mute">{change.old_value ?? "—"}</span> → {change.new_value ?? "—"}</>} <span className="fx-mute">· {change.changed_by}</span></span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        {(isNew || dirty || saveError) && (
          <div className="fx-sheet__f" role="region" aria-label="Save">
            <span className="fx-sheet__msg" data-tone={saveError || (dirty && plan.errors.length) ? "bad" : undefined} role={saveError ? "alert" : undefined}>
              {saving ? "Saving…" : saveError || (dirty && plan.errors[0]) || (isNew ? "New item" : "Unsaved changes")}
            </span>
            <button type="button" className="fx-btn fx-btn--ghost" onClick={discard} disabled={saving}>{isNew ? "Cancel" : "Discard"}</button>
            <button type="button" className="fx-btn fx-btn--primary" onClick={() => void save()} disabled={saving || !dirty || plan.errors.length > 0}>
              {isNew ? "Add item" : "Save changes"}
            </button>
          </div>
        )}
      </aside>
      </div>

      {leaving && (
        <ConfirmBox title="Discard unsaved changes?" confirmLabel="Discard" tone="danger" onCancel={() => setLeaving(null)} onConfirm={() => { const next = leaving; setLeaving(null); next(); }}>
          <p style={{ margin: 0 }}>Your changes to <b>{draft.name.trim() || "this item"}</b> haven't been saved.</p>
        </ConfirmBox>
      )}
      {confirm === "archive" && detail && (
        <ConfirmBox title={`Archive ${detail.name}?`} confirmLabel="Archive" onCancel={() => setConfirm(null)} onConfirm={() => void setStatus("archived")}>
          <p style={{ margin: 0 }}>It stops appearing when you add items to quotes. Kits that use it can't be priced until it's restored. Nothing is deleted; restore it any time.</p>
          {detail.used_in?.some((kit) => kit.status === "active") && <p className="fx-hint" style={{ color: "var(--t-warn)" }}>Used in {detail.used_in.filter((kit) => kit.status === "active").map((kit) => kit.name).join(", ")}.</p>}
        </ConfirmBox>
      )}
      {confirm === "delete" && detail && (
        <ConfirmBox title={`Delete ${detail.name} permanently?`} confirmLabel="Delete permanently" tone="danger" onCancel={() => setConfirm(null)} onConfirm={() => void remove()}>
          <p style={{ margin: 0 }}>This removes the item and takes it out of every kit it's part of. It can't be undone. Archive it instead if you might need it again.</p>
        </ConfirmBox>
      )}
    </>,
    document.body,
  );
}

function ModeSwitch<T extends string>({ label, value, options, disabled, onChange }: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="fx-seg" role="group" aria-label={label} style={{ alignSelf: "flex-start" }}>
      {options.map(([option, text]) => (
        <button key={option} type="button" aria-pressed={value === option} disabled={disabled} onClick={() => onChange(option)} style={{ height: 24, fontSize: 12 }}>{text}</button>
      ))}
    </div>
  );
}

function MoneyInput({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <span className="fx-affix">
      <span>$</span>
      <input aria-label={label} inputMode="decimal" value={value} disabled={disabled} placeholder="0.00" style={{ textAlign: "right" }} onChange={(event) => onChange(event.target.value)} />
    </span>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "bad" | "warn" }) {
  return (
    <div className="fx-figure">
      <span>{label}</span>
      <b style={tone ? { color: tone === "bad" ? "var(--t-danger)" : "var(--t-warn)" } : undefined}>{value}</b>
    </div>
  );
}

function TagEditor({ tags, known, listId, onChange }: { tags: string[]; known: string[]; listId: string; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState("");
  function commit() {
    if (!text.trim()) return;
    onChange(addTag(tags, text));
    setText("");
  }
  return (
    <div className="fx-label">Tags
      <div className="fx-chips" style={{ border: "1px solid var(--fx-line-strong)", borderRadius: "var(--t-radius)", padding: "3px 6px", minHeight: 32, background: "var(--t-paper)" }}>
        {tags.map((tag) => (
          <span key={tag} className="fx-chip fx-chip--tag">{tag}<button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(removeTag(tags, tag))}><X size={12} aria-hidden /></button></span>
        ))}
        <input
          aria-label="Add a tag"
          list={listId}
          value={text}
          placeholder={tags.length ? "" : "Add tags, e.g. walls"}
          onChange={(event) => setText(event.target.value.replace(",", ""))}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") { event.preventDefault(); commit(); }
            else if (event.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={commit}
          style={{ border: 0, outline: "none", background: "none", flex: 1, minWidth: 100, height: 24, font: "13px var(--t-body)", color: "var(--t-text)" }}
        />
        <datalist id={listId}>{known.filter((tag) => !tags.includes(tag)).map((tag) => <option key={tag} value={tag} />)}</datalist>
      </div>
    </div>
  );
}

function PartRow({ part, onChange, onRemove, onOpen }: {
  part: DraftComponent;
  onChange: (patch: Partial<DraftComponent>) => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const options = useMemo(() => {
    const list = getCatalogEntryUnitOptions(part.unit).map((option) => option.value);
    const entry = normalizeCatalogUnit(part.entryUnit);
    return entry && !list.includes(entry) ? [...list, entry] : list;
  }, [part.unit, part.entryUnit]);
  const quantity = componentQuantity(part);
  const listed = part.contribution === "listed_only";
  const items: MenuItem[] = [
    { label: "Open this item", onSelect: onOpen },
    { label: listed ? "Count it in the kit's price" : "List it without pricing", onSelect: () => onChange({ contribution: listed ? "included" : "listed_only" }) },
    { label: part.applicationMode === "fixed" ? "Scale with the quantity" : "Once per kit, whatever the quantity", onSelect: () => onChange({ applicationMode: part.applicationMode === "fixed" ? "proportional" : "fixed" }) },
    { kind: "separator" },
    { label: "Remove from kit", icon: <Trash2 aria-hidden />, tone: "danger", onSelect: onRemove },
  ];
  return (
    <tr>
      <td>
        <span className="fx-name">
          <b style={{ fontWeight: 500 }}>{part.name}</b>
          {part.status !== "active" && <span style={{ color: "var(--t-warn)", fontSize: 12 }}>{part.status}</span>}
        </span>
        {(listed || part.applicationMode === "fixed") && (
          <span className="fx-mute" style={{ fontSize: 11.5 }}>{[listed ? "listed, not priced" : null, part.applicationMode === "fixed" ? "once per kit" : null].filter(Boolean).join(" · ")}</span>
        )}
      </td>
      <td>
        <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input className="fx-input fx-input--num" aria-label={`Quantity of ${part.name}`} inputMode="decimal" value={part.entryQuantity} onChange={(event) => onChange({ entryQuantity: event.target.value })} style={{ width: 70 }} aria-invalid={quantity == null} />
          {options.length > 1 ? (
            <select className="fx-select" aria-label={`Unit for ${part.name}`} value={normalizeCatalogUnit(part.entryUnit)} onChange={(event) => onChange({ entryUnit: event.target.value })} style={{ width: 68 }}>
              {options.map((unit) => <option key={unit} value={unit}>{formatCatalogUnit(unit)}</option>)}
            </select>
          ) : <span className="fx-dim">{formatCatalogUnit(part.entryUnit)}</span>}
        </span>
      </td>
      <td className="fx-r fx-num fx-hide-sm" style={listed ? { color: "var(--t-mute)" } : undefined}>
        {quantity != null && part.sell != null ? money(quantity * part.sell) : "—"}
      </td>
      <td>
        <Menu label={`${part.name} actions`} items={items} trigger={(props) => (
          <button type="button" className="fx-btn fx-btn--ghost fx-btn--icon fx-btn--sm" aria-label={`${part.name} actions`} {...props}><MoreHorizontal aria-hidden /></button>
        )} />
      </td>
    </tr>
  );
}

/** Type to search the catalogue, Enter adds the highlighted item: the quote editor's add box. */
function PartPicker({ rows, exclude, onPick }: { rows: PriceBookRow[]; exclude: Set<string>; onPick: (row: PriceBookRow) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => {
    const candidates = rows.filter((row) => row.status === "active" && !exclude.has(row.uid));
    const list = query.trim() ? searchCatalogItems(candidates, query) : [];
    return list.slice(0, 8);
  }, [rows, exclude, query]);
  function pick(row: PriceBookRow) {
    onPick(row);
    setQuery("");
    setActive(0);
  }
  return (
    <div className="fx-add">
      <label className="fx-add__in">
        <Search aria-hidden />
        <input
          role="combobox"
          aria-label="Add a part"
          aria-expanded={open && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder="Add a part — type to search the catalogue"
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, Math.max(results.length - 1, 0))); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
            else if (event.key === "Enter") { event.preventDefault(); if (results[active]) pick(results[active]); }
            else if (event.key === "Escape" && query) { event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setQuery(""); }
          }}
        />
        <span className="fx-add__hint">↵ add</span>
      </label>
      {open && query.trim() && (
        <div className="fx-pop" id={listId} role="listbox">
          {results.map((row, index) => (
            <button
              key={row.uid}
              type="button"
              role="option"
              aria-selected={index === active}
              className="fx-pop__opt"
              data-active={index === active}
              onMouseDown={(event) => { event.preventDefault(); pick(row); }}
              onMouseEnter={() => setActive(index)}
            >
              <span className="fx-pop__name">{row.name}</span>
              <span className="fx-pop__meta">{[row.category, `per ${formatCatalogUnit(row.unit)}`, row.child_count ? `kit of ${row.child_count}` : null].filter(Boolean).join(" · ")}</span>
              <span className="fx-pop__price fx-num">{money(row.sell)}</span>
            </button>
          ))}
          {results.length === 0 && <div className="fx-pop__empty">Nothing active in the catalogue matches “{query}”.</div>}
        </div>
      )}
    </div>
  );
}
