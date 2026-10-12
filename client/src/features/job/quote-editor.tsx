// The quote, edited in place: sections and rows like a spreadsheet, items
// added from the catalogue by typing, scope, validity and payment schedule
// below. A draft saves itself as you go; a sent version is read-only until
// the operator starts a new version (the sent one never changes).
//
// Prices come from the shared renderer (shared/quote-presentation-renderer.js),
// the same code the server and PDFs use, so what is shown is what is sent.
import { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown, ArrowUp, ChevronRight, Copy, CornerDownRight, EyeOff, Eye, FolderInput, Lock, MoreHorizontal,
  Pin, PinOff, Plus, RotateCcw, Search, Trash2, CircleSlash,
} from "lucide-react";
import type {
  PaymentSchedule, PriceCatalogItem, QuoteCatalogChanges, QuotePresentationOrganizerSourceNode,
  QuotePresentationScheduleItem, RecordingDetail,
} from "@/lib/types";
import { api } from "@/lib/api";
import { money } from "@/lib/job-status";
import { Menu, type MenuItem } from "@/components/shell/menu";
import { useShell } from "@/components/shell/shell-context";
import {
  buildRenderedPresentationScheduleItems,
  calculatePresentationScheduleTotals,
} from "../../../../shared/quote-presentation-renderer.js";
import { searchCatalogItems } from "../../../../shared/catalog-search.js";
import { taxOnSubtotal } from "../../../../shared/money.js";
import { COMMON_QUOTE_UNITS, convertCatalogQuantity, normalizeCatalogUnit } from "../../../../shared/catalog-units.js";
import { buildCatalogQuoteRows, catalogChangesEditedSinceCheck } from "@/features/job-detail/quote-catalog-rows";
import { QuoteCatalogChangesBanner } from "@/features/job-detail/components/quote-catalog-changes-banner";
import {
  buildMilestoneDraftRows, buildPaymentScheduleFromDraftRows, buildVisiblePaymentSchedule, createMilestoneDraftRow,
  getPaymentScheduleValidationError, roundSchedulePercentage, type MilestoneScheduleDraftRow,
} from "@/features/job-detail/payment-schedule";
import {
  addOneOffLine, addSection, buildInitialOrganizer, buildParentIndex, childrenOf, getSourceItems,
  insertNode, moveToParent, moveWithinParent, nodeOrigin, removeNode, type Organizer, type ParentId,
} from "./quote-organizer";

export type QuoteTotals = { subtotal: number; gst: number; total: number; cost: number };
export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

type SourceNode = QuotePresentationOrganizerSourceNode;
const round2 = (value: number) => Math.round(value * 100) / 100;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

function catalogPaymentSchedule(detail: RecordingDetail): unknown {
  const record = detail.quote as unknown as Record<string, unknown> | undefined;
  const catalog = record?.quoteCatalog as Record<string, unknown> | undefined;
  return (catalog?.businessProfile as Record<string, unknown> | undefined)?.paymentSchedule ?? null;
}

export function QuoteEditor({ detail, editable: canEdit, lockReason, onNewVersion, newVersionBusy, onTotals, onSaveState, onSaved, autoFocusAdd }: {
  detail: RecordingDetail;
  editable: boolean;
  lockReason: string | null;
  onNewVersion: () => void;
  newVersionBusy: boolean;
  onTotals: (totals: QuoteTotals) => void;
  onSaveState: (state: SaveState, error?: string | null) => void;
  onSaved: () => void;
  autoFocusAdd?: boolean;
}) {
  const shell = useShell();
  const quote = detail.quote!;
  const jobId = detail.meta.id;
  const sourceItems = useMemo(() => getSourceItems(quote), [quote]);
  const [organizer, setOrganizer] = useState<Organizer>(() => buildInitialOrganizer(quote, sourceItems));
  // When a quote fails its pricing checks the server sends it with every
  // amount blanked. Editing that copy would save the blanks over the real
  // rates, so the quote stays read-only until its prices can be shown.
  const [pricesHidden] = useState(() => quote.totals?.subtotal == null && Object.keys(quote.presentation?.organizer?.nodes || {}).length > 0);
  const editable = canEdit && !pricesHidden;
  const presentation = (quote.presentation || {}) as Record<string, unknown>;
  const [scope, setScope] = useState<string>(() => initialScope(presentation.scopeText, quote.summary));
  const [validity, setValidity] = useState<string>(() => (typeof presentation.validityDays === "number" ? String(presentation.validityDays) : ""));
  const initialSchedule = useMemo(
    () => buildVisiblePaymentSchedule(detail.meta.paymentSchedule || null, [], catalogPaymentSchedule(detail)),
    [detail],
  );
  const [scheduleRows, setScheduleRows] = useState<MilestoneScheduleDraftRow[]>(() => buildMilestoneDraftRows(initialSchedule));
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showCost, setShowCost] = useState(() => { try { return localStorage.getItem("field.showCost") !== "0"; } catch { return true; } });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<string | null>(null);
  const history = useRef<{ past: Organizer[]; future: Organizer[]; lastKey: string | null; lastAt: number }>({ past: [], future: [], lastKey: null, lastAt: 0 });

  useEffect(() => { try { localStorage.setItem("field.showCost", showCost ? "1" : "0"); } catch { /* storage unavailable */ } }, [showCost]);

  // The catalogue's rate, never one divided back out of saved totals: a saved
  // GST that was a cent off (#2) would carry its error into every edit.
  const catalogGstRate = quote.quoteCatalog?.gstRate;
  const gstRate = catalogGstRate != null && Number.isFinite(Number(catalogGstRate)) ? Number(catalogGstRate) : 0.1;
  const rendered = useMemo(
    () => buildRenderedPresentationScheduleItems({ organizer, sourceItems, includeCollapsedChildren: true }) as QuotePresentationScheduleItem[],
    [organizer, sourceItems],
  );
  const renderedById = useMemo(() => new Map(rendered.map((item) => [String(item.nodeId), item])), [rendered]);
  const totals = useMemo(() => {
    const { charge, cost } = calculatePresentationScheduleTotals({ organizer, sourceItems });
    const gst = taxOnSubtotal(round2(charge), gstRate) ?? 0;
    return { subtotal: charge, gst, total: round2(charge + gst), cost };
  }, [organizer, sourceItems, gstRate]);
  useEffect(() => { if (!pricesHidden) onTotals(totals); }, [totals, onTotals, pricesHidden]);

  const parentIndex = useMemo(() => buildParentIndex(organizer), [organizer]);
  const sections = organizer.root.filter((id) => organizer.nodes[id]?.kind === "group");

  // ── Changes, undo and autosave ──────────────────────────────────────────
  const change = useCallback((mutate: (draft: Organizer) => void, key?: string) => {
    setOrganizer((current) => {
      const next = structuredClone(current);
      mutate(next);
      const h = history.current;
      const now = Date.now();
      if (!key || key !== h.lastKey || now - h.lastAt > 1200) h.past.push(current);
      if (h.past.length > 60) h.past.shift();
      h.future = [];
      h.lastKey = key || null;
      h.lastAt = now;
      return next;
    });
    setDirty(true);
  }, []);

  const undo = useCallback(() => {
    const h = history.current;
    const previous = h.past.pop();
    if (!previous) return;
    setOrganizer((current) => { h.future.push(current); return previous; });
    h.lastKey = null;
    setDirty(true);
  }, []);
  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    setOrganizer((current) => { h.past.push(current); return next; });
    h.lastKey = null;
    setDirty(true);
  }, []);

  useEffect(() => {
    if (!editable) return;
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA") return;
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, undo, redo]);

  const scheduleError = useMemo(() => getPaymentScheduleValidationError(scheduleRows), [scheduleRows]);
  const latest = useRef({ organizer, scope, validity, scheduleRows, scheduleDirty, scheduleError });
  latest.current = { organizer, scope, validity, scheduleRows, scheduleDirty, scheduleError };
  const saving = useRef(false);
  const queued = useRef(false);

  const save = useCallback(async () => {
    if (saving.current) { queued.current = true; return; }
    saving.current = true;
    onSaveState("saving");
    const snapshot = latest.current;
    try {
      const patch: Record<string, unknown> = { organizer: snapshot.organizer, scopeText: snapshot.scope };
      const days = parseInt(snapshot.validity, 10);
      if (days > 0) patch.validityDays = days;
      const schedule: PaymentSchedule | null = snapshot.scheduleDirty && !snapshot.scheduleError
        ? buildPaymentScheduleFromDraftRows(snapshot.scheduleRows)
        : null;
      await api.quoteUpdate(jobId, { presentation: patch, ...(schedule ? { paymentSchedule: schedule } : {}) });
      if (schedule) setScheduleDirty(false);
      onSaveState("saved");
      onSaved();
    } catch (err) {
      onSaveState("error", err instanceof Error ? err.message : "Changes could not be saved.");
    } finally {
      saving.current = false;
      if (queued.current) { queued.current = false; void save(); }
    }
  }, [jobId, onSaveState, onSaved]);

  useEffect(() => {
    if (!editable || !dirty) return;
    onSaveState("pending");
    const timer = window.setTimeout(() => { setDirty(false); void save(); }, 900);
    return () => window.clearTimeout(timer);
  }, [organizer, scope, validity, scheduleRows, dirty, editable, save, onSaveState]);

  // Leaving with unsaved edits: save them on the way out, warn on reload.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (dirtyRef.current || saving.current) { event.preventDefault(); }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (dirtyRef.current) void save();
    };
  }, [save]);

  // ── Catalogue changes since rows were added (drafts only) ───────────────
  const [catalogChanges, setCatalogChanges] = useState<QuoteCatalogChanges | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const checkCatalog = useCallback(async (draft: Organizer) => {
    setCatalogBusy(true);
    setCatalogNotice(null);
    try {
      setCatalogChanges(await api.quoteCatalogChanges(jobId, draft));
      setCatalogError(null);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : "The catalogue could not be checked.");
    } finally {
      setCatalogBusy(false);
    }
  }, [jobId]);
  useEffect(() => {
    if (!editable) return;
    void api.revalidatePriceCatalogCache().catch(() => undefined);
    void checkCatalog(latest.current.organizer);
  }, [editable, checkCatalog]);
  const editedSinceCheck = useMemo(() => catalogChangesEditedSinceCheck(catalogChanges, organizer), [catalogChanges, organizer]);

  async function applyCatalogChanges(nodeIds: string[]) {
    if (!catalogChanges) return;
    const draft = latest.current.organizer;
    const edited = catalogChangesEditedSinceCheck(catalogChanges, draft);
    const editedTicked = catalogChanges.lines.filter((line) => nodeIds.includes(line.nodeId) && edited.has(line.nodeId));
    if (editedTicked.length) {
      await checkCatalog(draft);
      setCatalogNotice(`You changed ${editedTicked.map((line) => line.label).join(", ")} since the check, so nothing was applied. Review the updated list, then apply.`);
      return;
    }
    const reviewed: Record<string, string> = {};
    for (const line of catalogChanges.lines) if (nodeIds.includes(line.nodeId) && typeof line.reviewKey === "string") reviewed[line.nodeId] = line.reviewKey;
    setCatalogBusy(true);
    try {
      const result = await api.applyQuoteCatalogChanges(jobId, { organizer: draft, nodeIds, reviewed, expectedCatalogVersion: catalogChanges.catalogVersion });
      change((next) => {
        next.root = result.organizer.root;
        next.nodes = result.organizer.nodes;
        if (result.organizer.removedSourceCodes) next.removedSourceCodes = result.organizer.removedSourceCodes;
      });
      setCatalogChanges(result.changes);
      setCatalogNotice(result.skipped.length ? `${result.skipped.length} ${result.skipped.length === 1 ? "row was" : "rows were"} not changed: ${result.skipped.map((entry) => entry.reason).filter(Boolean).join(" ")}` : null);
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      await checkCatalog(draft);
      if (code === "CATALOG_CHANGED") setCatalogNotice("The catalogue changed while you were reviewing, so nothing was applied. Review the list again.");
      else setCatalogError(err instanceof Error ? err.message : "The changes could not be applied.");
    } finally {
      setCatalogBusy(false);
    }
  }

  // ── Row operations ──────────────────────────────────────────────────────
  function setSourceField(nodeId: string, field: "quantity" | "sellRate" | "buyRate", value: number) {
    change((draft) => {
      const node = draft.nodes[nodeId] as SourceNode | undefined;
      if (!node || node.kind !== "source") return;
      node[field] = Number.isFinite(value) ? value : 0;
      delete node.manualPrice;
      delete node.manualCost;
    }, `${field}:${nodeId}`);
  }

  function setUnit(nodeId: string, raw: string) {
    change((draft) => {
      const node = draft.nodes[nodeId] as SourceNode | undefined;
      if (!node || node.kind !== "source") return;
      const nextUnit = normalizeCatalogUnit(raw, "each");
      const previous = normalizeCatalogUnit(node.unit, nextUnit);
      if (previous !== nextUnit) {
        const quantity = convertCatalogQuantity(node.quantity ?? 1, previous, nextUnit);
        if (quantity != null && Number.isFinite(quantity)) node.quantity = round6(quantity);
        const scale = convertCatalogQuantity(1, nextUnit, previous);
        if (scale != null && Number.isFinite(scale)) {
          if (node.sellRate != null) node.sellRate = round6(Number(node.sellRate) * scale);
          if (node.buyRate != null) node.buyRate = round6(Number(node.buyRate) * scale);
        }
        if (node.rateMode === "catalog-linked") node.rateMode = "manual";
      }
      node.unit = nextUnit;
    });
  }

  function setLabel(nodeId: string, value: string) {
    change((draft) => {
      const node = draft.nodes[nodeId];
      if (!node) return;
      if (node.kind === "group") node.label = value;
      else node.labelOverride = value;
    }, `label:${nodeId}`);
  }

  function setPriceOverride(nodeId: string, value: number | null) {
    change((draft) => {
      const node = draft.nodes[nodeId];
      if (!node) return;
      if (value == null) { delete node.priceOverride; delete node.costOverride; } else node.priceOverride = round2(value);
    }, `override:${nodeId}`);
  }

  function toggle(nodeId: string, field: "amountVisible" | "excludedFromPrice") {
    change((draft) => {
      const node = draft.nodes[nodeId];
      if (!node) return;
      if (field === "amountVisible") node.amountVisible = node.amountVisible === false;
      else if (node.excludedFromPrice) delete node.excludedFromPrice;
      else node.excludedFromPrice = true;
    });
  }

  function resetToCatalogue(nodeId: string) {
    change((draft) => {
      const node = draft.nodes[nodeId] as SourceNode | undefined;
      if (!node || node.kind !== "source") return;
      if (node.catalogSellRate != null && !(node.children?.length)) node.sellRate = node.catalogSellRate;
      if (node.catalogBuyRate != null && !(node.children?.length)) node.buyRate = node.catalogBuyRate;
      if (node.catalogUnit) node.unit = node.catalogUnit;
      if (node.catalogName) node.labelOverride = node.catalogName;
      node.rateMode = "catalog-linked";
      delete node.priceOverride;
      delete node.costOverride;
    });
  }

  function duplicate(nodeId: string) {
    change((draft) => {
      const parentId = buildParentIndex(draft).get(nodeId) ?? null;
      const idMap = new Map<string, string>();
      const copy = (id: string): string => {
        const node = structuredClone(draft.nodes[id]);
        const nextId = `${id.split(":")[0]}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        idMap.set(id, nextId);
        if (node.kind === "source") node.sourceCode = `${node.sourceCode}-copy-${Math.random().toString(36).slice(2, 6)}`;
        node.children = (node.children || []).map(copy);
        draft.nodes[nextId] = node;
        return nextId;
      };
      const newId = copy(nodeId);
      const siblings = childrenOf(draft, parentId);
      insertNode(draft, newId, parentId, siblings.indexOf(nodeId) + 1);
    });
  }

  function remove(nodeId: string) {
    const node = organizer.nodes[nodeId];
    const label = node?.kind === "group" ? node.label : (node as SourceNode | undefined)?.labelOverride || renderedById.get(nodeId)?.label || "row";
    change((draft) => removeNode(draft, nodeId));
    shell.toast(`Removed ${label}`, undo);
  }

  async function addCatalogItem(parentId: ParentId, item: PriceCatalogItem) {
    try {
      const line = await api.priceCatalogQuoteLine(item.uid || item.code);
      const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const nodeId = `manual:${nonce}`;
      const rows = buildCatalogQuoteRows(line, { nodeId, nonce });
      change((draft) => {
        draft.nodes[nodeId] = rows.parent;
        for (const child of rows.children) draft.nodes[child.id] = child.node;
        insertNode(draft, nodeId, parentId);
      });
      setFresh(nodeId);
      window.setTimeout(() => document.getElementById(`qty-${nodeId}`)?.focus(), 40);
    } catch (err) {
      shell.toast(err instanceof Error ? err.message : "That item could not be added.");
    }
  }

  function addOneOff(parentId: ParentId, label: string) {
    let id = "";
    change((draft) => { id = addOneOffLine(draft, parentId, label); });
    setFresh(id);
    window.setTimeout(() => document.getElementById(`rate-${id}`)?.focus(), 40);
  }

  function newSection() {
    let id = "";
    change((draft) => {
      // Loose rows at the top level go into the first section, so the quote reads as sections.
      const loose = draft.root.filter((nodeId) => draft.nodes[nodeId]?.kind !== "group");
      id = addSection(draft, sectionsCount(draft) === 0 && loose.length ? "Works" : "New section");
      if (sectionsCount(draft) === 1 && loose.length) {
        for (const nodeId of loose) moveToParent(draft, nodeId, id);
      }
    });
    window.setTimeout(() => {
      const input = document.getElementById(`label-${id}`) as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }, 40);
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  const columns = showCost ? 8 : 6;
  const rows: React.ReactNode[] = [];
  const looseRoot = organizer.root.filter((id) => organizer.nodes[id]?.kind !== "group");

  function moveMenu(nodeId: string): MenuItem[] {
    const parentId = parentIndex.get(nodeId) ?? null;
    const siblings = childrenOf(organizer, parentId);
    const index = siblings.indexOf(nodeId);
    const node = organizer.nodes[nodeId];
    const items: MenuItem[] = [
      { label: "Move up", icon: <ArrowUp />, disabled: index <= 0, onSelect: () => change((draft) => { moveWithinParent(draft, nodeId, -1); }) },
      { label: "Move down", icon: <ArrowDown />, disabled: index < 0 || index >= siblings.length - 1, onSelect: () => change((draft) => { moveWithinParent(draft, nodeId, 1); }) },
    ];
    const generated = node?.kind === "source" && nodeOrigin(node) === "generated";
    const parentIsGroupOrRoot = !parentId || organizer.nodes[parentId]?.kind === "group";
    if (node?.kind === "source" && !generated && parentIsGroupOrRoot) {
      for (const sectionId of sections) {
        if (sectionId === parentId) continue;
        const section = organizer.nodes[sectionId];
        items.push({ label: `Move to ${section?.kind === "group" ? section.label || "section" : "section"}`, icon: <FolderInput />, onSelect: () => change((draft) => { moveToParent(draft, nodeId, sectionId); }) });
      }
    }
    return items;
  }

  function renderSource(nodeId: string, indent: number, isChild: boolean) {
    const node = organizer.nodes[nodeId] as SourceNode;
    const item = renderedById.get(nodeId);
    if (!node || !item) return;
    const origin = nodeOrigin(node);
    const manual = origin === "manual";
    const kids = node.children || [];
    const isKit = kids.length > 0;
    const open = expanded.has(nodeId);
    const overridden = typeof node.priceOverride === "number";
    const rateChanged = manual && !isKit && node.catalogSellRate != null && Math.abs(Number(node.sellRate || 0) - node.catalogSellRate) > 0.0001;
    const excluded = node.excludedFromPrice === true;
    const hidden = node.amountVisible === false;
    const unitPrice = isKit || !manual ? item.unitPrice : Number(node.sellRate || 0);
    const unitCost = isKit || !manual ? (item.unitCost ?? 0) : Number(node.buyRate || 0);
    const margin = item.totalPrice > 0 ? (item.totalPrice - (item.totalCost ?? 0)) / item.totalPrice : null;
    const readOnly = !editable;
    const menu: MenuItem[] = [
      ...moveMenu(nodeId),
      { kind: "separator" },
      overridden
        ? { label: "Use the calculated price", icon: <PinOff />, onSelect: () => setPriceOverride(nodeId, null) }
        : { label: "Fix the price", icon: <Pin />, onSelect: () => { setPriceOverride(nodeId, item.totalPrice); window.setTimeout(() => document.getElementById(`amt-${nodeId}`)?.focus(), 40); } },
      { label: hidden ? "Show the price on the quote" : "Hide the price on the quote", icon: hidden ? <Eye /> : <EyeOff />, onSelect: () => toggle(nodeId, "amountVisible") },
      { label: excluded ? "Include in the total" : "Leave out of the total", icon: <CircleSlash />, onSelect: () => toggle(nodeId, "excludedFromPrice") },
      ...(manual && (node.catalogItemUid || node.catalogItemCode) ? [{ label: "Reset to catalogue price", icon: <RotateCcw />, onSelect: () => resetToCatalogue(nodeId) } as MenuItem] : []),
      ...(manual && !isChild ? [{ label: "Duplicate", icon: <Copy />, onSelect: () => duplicate(nodeId) } as MenuItem] : []),
      { kind: "separator" },
      { label: "Remove", icon: <Trash2 />, tone: "danger", onSelect: () => remove(nodeId) },
    ];
    rows.push(
      <tr key={nodeId} className="fx-item" data-fresh={fresh === nodeId} data-child={isChild} data-muted={excluded || item.pricingMuted || undefined}>
        <td style={{ paddingLeft: 28 + indent * 20 }}>
          <div className="fx-lines__name">
            {isKit ? (
              <button type="button" className="fx-twisty" aria-expanded={open} aria-label={open ? "Hide components" : "Show components"} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId); return next; })}>
                <ChevronRight />
              </button>
            ) : isChild ? <CornerDownRight size={13} className="fx-mute" aria-hidden style={{ flex: "none" }} /> : null}
            <input
              id={`label-${nodeId}`}
              className="fx-cell"
              style={{ marginLeft: isKit || isChild ? 0 : -7 }}
              value={node.labelOverride ?? item.label ?? ""}
              readOnly={readOnly}
              aria-label="Description"
              onChange={(event) => setLabel(nodeId, event.target.value)}
            />
            {isKit && <span className="fx-lines__tag">{kids.length} parts</span>}
            {overridden && <span className="fx-lines__tag fx-lines__tag--warn" title="Price fixed by hand">Fixed</span>}
            {hidden && <span className="fx-lines__tag" title="Price not shown on the quote">Hidden</span>}
            {excluded && <span className="fx-lines__tag" title="Not counted in the total">Optional</span>}
          </div>
        </td>
        <td className="fx-r">
          {manual
            ? <NumCell id={`qty-${nodeId}`} value={Number(node.quantity ?? 1)} readOnly={readOnly} label="Quantity" onChange={(value) => setSourceField(nodeId, "quantity", value)} />
            : <span className="fx-num fx-dim">{item.quantity}</span>}
        </td>
        <td>
          {manual && !readOnly
            ? <UnitCell value={node.unit || "each"} onChange={(value) => setUnit(nodeId, value)} />
            : <span className="fx-dim">{item.unit}</span>}
        </td>
        <td className="fx-r">
          {manual && !isKit
            ? <NumCell id={`rate-${nodeId}`} value={unitPrice} currency readOnly={readOnly} label="Rate" className={rateChanged ? "fx-cell--changed" : undefined} title={rateChanged ? `Catalogue rate ${money(node.catalogSellRate)}` : undefined} onChange={(value) => setSourceField(nodeId, "sellRate", value)} />
            : <span className="fx-num fx-dim">{money(unitPrice)}</span>}
        </td>
        {showCost && (
          <>
            <td className="fx-r">
              {manual && !isKit
                ? <NumCell value={unitCost} currency readOnly={readOnly} label="Cost" muted onChange={(value) => setSourceField(nodeId, "buyRate", value)} />
                : <span className="fx-num fx-mute">{money(unitCost)}</span>}
            </td>
            <td className="fx-r fx-num" style={{ color: margin != null && margin < 0.15 ? "var(--t-warn)" : "var(--t-mute)", fontSize: 12 }}>
              {margin == null ? "—" : `${Math.round(margin * 100)}%`}
            </td>
          </>
        )}
        <td className="fx-r fx-lines__amt">
          {overridden && editable
            ? <NumCell id={`amt-${nodeId}`} value={Number(node.priceOverride)} currency label="Fixed price" onChange={(value) => setPriceOverride(nodeId, value)} />
            : <span className="fx-num">{money(item.totalPrice)}</span>}
        </td>
        <td>
          {editable && (
            <Menu label="Row actions" items={menu} trigger={(props) => (
              <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon fx-row-menu" aria-label="Row actions" {...props}><MoreHorizontal /></button>
            )} />
          )}
        </td>
      </tr>,
    );
    if (isKit && open) for (const childId of kids) renderNode(childId, indent + 1, true);
  }

  function renderNode(nodeId: string, indent: number, isChild = false) {
    const node = organizer.nodes[nodeId];
    if (!node) return;
    if (node.kind === "group") {
      const item = renderedById.get(nodeId);
      const hidden = node.amountVisible === false;
      const index = organizer.root.indexOf(nodeId);
      const sectionMenu: MenuItem[] = [
        { label: "Move up", icon: <ArrowUp />, disabled: index === 0, onSelect: () => change((draft) => { moveWithinParent(draft, nodeId, -1); }) },
        { label: "Move down", icon: <ArrowDown />, disabled: index === organizer.root.length - 1, onSelect: () => change((draft) => { moveWithinParent(draft, nodeId, 1); }) },
        { label: hidden ? "Show the subtotal on the quote" : "Hide the subtotal on the quote", icon: hidden ? <Eye /> : <EyeOff />, onSelect: () => toggle(nodeId, "amountVisible") },
        { kind: "separator" },
        { label: "Remove section and its items", icon: <Trash2 />, tone: "danger", onSelect: () => remove(nodeId) },
      ];
      rows.push(
        <tr key={nodeId} className="fx-sec">
          <td colSpan={columns - 2} style={{ paddingLeft: 28 + indent * 20 }}>
            <input id={`label-${nodeId}`} className="fx-cell" style={{ marginLeft: -7, fontSize: indent ? 13 : 14 }} value={node.label} readOnly={!editable} aria-label="Section name" onChange={(event) => setLabel(nodeId, event.target.value)} />
          </td>
          <td className="fx-r fx-lines__sub">{item ? money(item.totalPrice) : money(0)}</td>
          <td>
            {editable && (
              <Menu label="Section actions" items={sectionMenu} trigger={(props) => (
                <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon fx-row-menu" aria-label="Section actions" {...props}><MoreHorizontal /></button>
              )} />
            )}
          </td>
        </tr>,
      );
      for (const childId of node.children || []) renderNode(childId, indent + (organizer.nodes[childId]?.kind === "group" ? 1 : 0));
      if (editable) {
        rows.push(
          <tr key={`${nodeId}:add`} className="fx-adder">
            <td colSpan={columns} style={{ paddingLeft: 28 + indent * 20 }}>
              <AddItem onPick={(picked) => addCatalogItem(nodeId, picked)} onOneOff={(label) => addOneOff(nodeId, label)} />
            </td>
          </tr>,
        );
      }
      return;
    }
    renderSource(nodeId, indent, isChild);
  }

  // Rows outside any section come first, with their own add box; then each
  // section with its rows and add box.
  for (const nodeId of looseRoot) renderNode(nodeId, 0);
  if (editable && (looseRoot.length > 0 || sections.length === 0)) {
    rows.push(
      <tr key="root:add" className="fx-adder">
        <td colSpan={columns}>
          <AddItem autoFocus={autoFocusAdd} onPick={(picked) => addCatalogItem(null, picked)} onOneOff={(label) => addOneOff(null, label)} />
        </td>
      </tr>,
    );
  }
  for (const nodeId of sections) renderNode(nodeId, 0);

  const scheduleTotal = roundSchedulePercentage(scheduleRows.reduce((sum, row) => sum + (Number(row.percentage) || 0), 0));
  function updateSchedule(next: MilestoneScheduleDraftRow[]) {
    setScheduleRows(next);
    setScheduleDirty(true);
    setDirty(true);
  }
  const empty = rendered.length === 0 && sections.length === 0;

  return (
    <div>
      {pricesHidden && (
        <div className="fx-notice fx-notice--warn">
          <span>Prices on this quote are hidden because it hasn't passed Field's pricing checks{quote.pricing?.blockingReason ? ` (${quote.pricing.blockingReason.replace(/\.$/, "")})` : ""}. Editing is paused so the hidden prices aren't overwritten.</span>
        </div>
      )}
      {!canEdit && (
        <div className="fx-notice">
          <Lock aria-hidden />
          <span>{lockReason || "This is the version the customer was sent, kept exactly as sent."} Editing starts a new version.</span>
          <button type="button" className="fx-btn fx-btn--sm" onClick={onNewVersion} disabled={newVersionBusy}>{newVersionBusy ? "Starting…" : "Edit as new version"}</button>
        </div>
      )}
      {quote.pricing && quote.pricing.displayable === false && (
        <div className="fx-notice fx-notice--warn"><span>Pricing is blocked: {quote.pricing.blockingReason || "the catalogue is unavailable"}. Prices can't be shown or sent until it's fixed.</span></div>
      )}
      {editable && catalogChanges && catalogChanges.changedCount > 0 && (
        <div style={{ margin: "16px 28px 0" }}>
          <QuoteCatalogChangesBanner
            changes={catalogChanges}
            busy={catalogBusy}
            error={catalogError}
            notice={catalogNotice}
            editedSinceCheck={editedSinceCheck}
            onApply={applyCatalogChanges}
            onRecheck={() => checkCatalog(latest.current.organizer)}
          />
        </div>
      )}

      <div className="fx-scroll-x">
        <table className="fx-lines">
          <colgroup>
            <col />
            <col style={{ width: 64 }} />
            <col style={{ width: 84 }} />
            <col style={{ width: 96 }} />
            {showCost && <col style={{ width: 88 }} />}
            {showCost && <col style={{ width: 56 }} />}
            <col style={{ width: 108 }} />
            <col style={{ width: 36 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Item</th>
              <th className="fx-r">Qty</th>
              <th>Unit</th>
              <th className="fx-r">Rate</th>
              {showCost && <th className="fx-r">Cost</th>}
              {showCost && <th className="fx-r">Margin</th>}
              <th className="fx-r">Amount</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows}
            {!editable && empty && (
              <tr className="fx-table__empty"><td colSpan={columns}>This version has no items.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="fx-doc-actions">
        {editable && <button type="button" className="fx-btn fx-btn--sm" onClick={newSection}><Plus aria-hidden />Section</button>}
        {editable && empty && <span className="fx-mute" style={{ fontSize: 12 }}>Type in the box above to add items from your catalogue.</span>}
        <span className="fx-spacer" />
        <label className="fx-check"><input type="checkbox" checked={showCost} onChange={(event) => setShowCost(event.target.checked)} />Show cost and margin</label>
      </div>

      <section className="fx-block">
        <h3 className="fx-block__h">Scope of works <small>printed above the price table</small></h3>
        <textarea
          id="quote-scope"
          className="fx-textarea"
          value={scope}
          readOnly={!editable}
          placeholder="What's included, in plain words the customer will read."
          onChange={(event) => { setScope(event.target.value); setDirty(true); }}
        />
      </section>

      <section className="fx-block">
        <h3 className="fx-block__h">Payment schedule <small>becomes the invoices once the customer accepts</small></h3>
        <div className="fx-sched" role="table" aria-label="Payment schedule">
          <div className="fx-sched__h" role="columnheader">Milestone</div>
          <div className="fx-sched__h fx-r" role="columnheader">Share</div>
          <div className="fx-sched__h fx-r" role="columnheader">Amount</div>
          <div className="fx-sched__h fx-r" role="columnheader">Due after</div>
          <div className="fx-sched__h" role="columnheader" aria-label="Remove" />
          {scheduleRows.map((row, index) => (
            <ScheduleRow
              key={row.id}
              row={row}
              total={totals.total}
              editable={editable}
              canRemove={scheduleRows.length > 1}
              onChange={(next) => updateSchedule(scheduleRows.map((candidate, i) => (i === index ? next : candidate)))}
              onRemove={() => updateSchedule(scheduleRows.filter((_, i) => i !== index))}
            />
          ))}
          <div className="fx-sched__foot">
            {editable
              ? <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => updateSchedule([...scheduleRows, createMilestoneDraftRow("Milestone", String(Math.max(0, roundSchedulePercentage(100 - scheduleTotal))))])}><Plus aria-hidden />Milestone</button>
              : <span />}
            <span style={{ color: scheduleError ? "var(--t-danger)" : "var(--t-mute)", alignSelf: "center" }}>{scheduleError || `${scheduleTotal}% of ${money(totals.total)}`}</span>
          </div>
        </div>
      </section>

      <section className="fx-block">
        <h3 className="fx-block__h">Validity</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input id="quote-validity" className="fx-input fx-input--num" style={{ width: 80 }} inputMode="numeric" placeholder="30" value={validity} readOnly={!editable} onChange={(event) => { setValidity(event.target.value.replace(/[^0-9]/g, "")); setDirty(true); }} />
          <span className="fx-dim">days from sending. Terms come from Settings.</span>
        </div>
      </section>
    </div>
  );
}

// New manual jobs carry a placeholder summary from the recording era; it is
// not scope, so the box starts empty instead of saving it onto the quote.
const PLACEHOLDER_SUMMARY = /^Manual quote draft created without an audio recording/;
function initialScope(scopeText: unknown, summary: string | undefined) {
  const text = typeof scopeText === "string" && scopeText ? scopeText : summary || "";
  return PLACEHOLDER_SUMMARY.test(text) ? "" : text;
}

function sectionsCount(organizer: Organizer) {
  return organizer.root.filter((id) => organizer.nodes[id]?.kind === "group").length;
}

function ScheduleRow({ row, total, editable, canRemove, onChange, onRemove }: {
  row: MilestoneScheduleDraftRow;
  total: number;
  editable: boolean;
  canRemove: boolean;
  onChange: (row: MilestoneScheduleDraftRow) => void;
  onRemove: () => void;
}) {
  const pct = Number(row.percentage) || 0;
  return (
    <>
      <div role="cell"><input className="fx-cell" aria-label="Milestone" value={row.label} readOnly={!editable} onChange={(event) => onChange({ ...row, label: event.target.value })} /></div>
      <div role="cell" className="fx-r" style={{ gap: 2 }}>
        <input className="fx-cell fx-cell--num" style={{ width: 56 }} aria-label="Share in percent" inputMode="decimal" value={row.percentage} readOnly={!editable} onChange={(event) => onChange({ ...row, percentage: event.target.value.replace(/[^0-9.]/g, "") })} />
        <span className="fx-mute">%</span>
      </div>
      <div role="cell" className="fx-r fx-num">{money(round2(total * pct / 100))}</div>
      <div role="cell" className="fx-r" style={{ gap: 4 }}>
        <input className="fx-cell fx-cell--num" style={{ width: 44 }} aria-label="Due after days" inputMode="numeric" placeholder="—" value={row.dueDays ?? ""} readOnly={!editable} onChange={(event) => { const days = parseInt(event.target.value, 10); onChange({ ...row, dueDays: Number.isFinite(days) && days > 0 ? days : null }); }} />
        <span className="fx-mute" style={{ fontSize: 12 }}>days</span>
      </div>
      <div role="cell">
        {editable && canRemove && <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon" aria-label={`Remove ${row.label}`} onClick={onRemove}><Trash2 /></button>}
      </div>
    </>
  );
}

/** A number input that shows a formatted value until it's being edited. */
const NumCell = forwardRef<HTMLInputElement, {
  id?: string;
  value: number;
  dp?: number;
  /** Show as money ($1,234.50) until edited. */
  currency?: boolean;
  readOnly?: boolean;
  label: string;
  muted?: boolean;
  className?: string;
  title?: string;
  onChange: (value: number) => void;
}>(function NumCell({ id, value, dp, currency, readOnly, label, muted, className, title, onChange }, ref) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (currency ? money(Number(value || 0)) : dp != null ? Number(value || 0).toFixed(dp) : String(Number(value || 0)));
  return (
    <input
      ref={ref}
      id={id}
      className={`fx-cell fx-cell--num${className ? ` ${className}` : ""}`}
      style={muted ? { color: "var(--t-dim)" } : undefined}
      value={shown}
      readOnly={readOnly}
      inputMode="decimal"
      aria-label={label}
      title={title}
      onFocus={(event) => { if (readOnly) return; setDraft(String(Number(value || 0))); const el = event.target; requestAnimationFrame(() => el.select()); }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") { setDraft(null); (event.target as HTMLInputElement).blur(); }
      }}
      onChange={(event) => {
        const raw = event.target.value.replace(/[^0-9.-]/g, "");
        setDraft(raw);
        const parsed = Number(raw);
        if (raw !== "" && raw !== "-" && Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
});

function UnitCell({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const options = Array.from(new Set([value, ...COMMON_QUOTE_UNITS]));
  return (
    <select className="fx-cell" style={{ paddingRight: 0, cursor: "pointer" }} aria-label="Unit" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
    </select>
  );
}

// ── Adding items ──────────────────────────────────────────────────────────

let catalogueItems: Promise<PriceCatalogItem[]> | null = null;
function loadCatalogue() {
  if (!catalogueItems) {
    catalogueItems = api.priceCatalogItems({ status: "active" }).catch((error) => { catalogueItems = null; throw error; });
  }
  return catalogueItems;
}

function itemPrice(item: PriceCatalogItem) {
  return item.effective_sell_price ?? item.sell_price ?? null;
}

function AddItem({ onPick, onOneOff, autoFocus }: {
  onPick: (item: PriceCatalogItem) => void;
  onOneOff: (label: string) => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<PriceCatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLLabelElement>(null);
  const listId = useId();
  const [rect, setRect] = useState<{ top: number; left: number; width: number; above: boolean } | null>(null);

  // The list floats above the table (which scrolls sideways on small screens).
  const place = useCallback(() => {
    const bounds = box.current?.getBoundingClientRect();
    if (!bounds) return;
    const above = bounds.bottom + 330 > window.innerHeight && bounds.top > 340;
    setRect({ top: above ? bounds.top - 4 : bounds.bottom + 4, left: bounds.left, width: bounds.width, above });
  }, []);
  useEffect(() => {
    if (!open) return;
    const scroller = document.querySelector(".fx-main");
    scroller?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => { scroller?.removeEventListener("scroll", place); window.removeEventListener("resize", place); };
  }, [open, place]);

  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    if (!open || items) return;
    loadCatalogue().then(setItems).catch((err) => setError(err instanceof Error ? err.message : "The catalogue could not be loaded."));
  }, [open, items]);

  const results = useMemo(() => {
    if (!items) return [];
    const sellable = items.filter((item) => item.status !== "archived");
    const list = query.trim() ? searchCatalogItems(sellable, query) : sellable.filter((item) => item.catalog_type !== "component" && item.catalog_type !== "item");
    return list.slice(0, 8);
  }, [items, query]);

  function pick(item: PriceCatalogItem) {
    onPick(item);
    setQuery("");
    setActive(0);
  }

  return (
    <div className="fx-add">
      <label className="fx-add__in" ref={box}>
        <Search aria-hidden />
        <input
          ref={input}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder="Add an item — type to search the catalogue"
          value={query}
          onFocus={() => { place(); setOpen(true); }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => { setQuery(event.target.value); place(); setOpen(true); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, Math.max(results.length - 1, 0))); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
            else if (event.key === "Enter") {
              event.preventDefault();
              if (results[active]) pick(results[active]);
              else if (query.trim()) { onOneOff(query.trim()); setQuery(""); }
            } else if (event.key === "Escape") { setOpen(false); (event.target as HTMLInputElement).blur(); }
          }}
        />
        <span className="fx-add__hint">↵ add</span>
      </label>
      {open && rect && createPortal(
        <div
          className="fx-pop"
          id={listId}
          role="listbox"
          style={{ position: "fixed", left: rect.left, width: rect.width, right: "auto", ...(rect.above ? { top: "auto", bottom: window.innerHeight - rect.top } : { top: rect.top }) }}
        >
          {error && <div className="fx-pop__empty">{error}</div>}
          {!items && !error && <div className="fx-pop__empty">Loading the catalogue…</div>}
          {items && !query.trim() && results.length > 0 && <div className="fx-pop__head">Goods and services</div>}
          {results.map((item, index) => {
            const price = itemPrice(item);
            return (
              <button
                key={item.uid || item.code}
                type="button"
                role="option"
                aria-selected={index === active}
                className="fx-pop__opt"
                data-active={index === active}
                onMouseDown={(event) => { event.preventDefault(); pick(item); }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="fx-pop__name">{item.name}</span>
                <span className="fx-pop__meta">
                  {[item.category, `per ${item.unit}`, item.child_count ? `kit of ${item.child_count}` : null, item.catalog_type === "component" || item.catalog_type === "item" ? "component" : null].filter(Boolean).join(" · ")}
                </span>
                <span className="fx-pop__price">{price == null ? "—" : money(price)}</span>
              </button>
            );
          })}
          {items && query.trim() && results.length === 0 && (
            <div className="fx-pop__empty">Nothing in the catalogue matches “{query}”. Press Enter to add it as a one-off line.</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
