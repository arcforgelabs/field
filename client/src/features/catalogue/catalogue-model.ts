// Pure logic behind the catalogue screen: what the URL says, which rows the
// table shows, the health index, live price maths, bulk-change previews and
// what saving a drawer draft sends. Nothing here touches the network or React.
import type { PriceBookRow, BulkRow } from "@/features/pricing/price-book-api";
import type { PriceCatalogHealthIssue, PriceCatalogHealthReport } from "@/lib/types";
import { convertCatalogQuantity, normalizeCatalogUnit } from "../../../../shared/catalog-units.js";

// ── URL state ───────────────────────────────────────────────────────────

export type StatusFilter = "active" | "draft" | "archived" | "all";
export type SortKey = "name" | "category" | "unit" | "cost" | "sell" | "margin";
export type ManagerTab = "categories" | "tags" | "units" | "suppliers";

/** `null` category means any; `""` means uncategorised. */
export type CatalogueView = {
  q: string;
  status: StatusFilter;
  category: string | null;
  tag: string | null;
  supplier: string | null;
  unit: string | null;
  health: boolean;
  sort: SortKey;
  dir: "asc" | "desc";
  item: string | null;
  manage: ManagerTab | null;
};

const STATUSES: StatusFilter[] = ["active", "draft", "archived", "all"];
const SORTS: SortKey[] = ["name", "category", "unit", "cost", "sell", "margin"];
const TABS: ManagerTab[] = ["categories", "tags", "units", "suppliers"];
export const NO_CATEGORY = "__none";
export const NEW_ITEM = "new";

export function readView(params: URLSearchParams): CatalogueView {
  const status = params.get("status") as StatusFilter;
  const sort = params.get("sort") as SortKey;
  const manage = params.get("manage") as ManagerTab;
  const category = params.get("category");
  return {
    q: params.get("q") || "",
    status: STATUSES.includes(status) ? status : "active",
    category: category === null ? null : category === NO_CATEGORY ? "" : category,
    tag: params.get("tag") || null,
    supplier: params.get("supplier") || null,
    unit: params.get("unit") || null,
    health: params.get("health") === "1",
    sort: SORTS.includes(sort) ? sort : "name",
    dir: params.get("dir") === "desc" ? "desc" : "asc",
    item: params.get("item") || null,
    manage: TABS.includes(manage) ? manage : null,
  };
}

/** The search params for a view; defaults are left out so URLs stay short. */
export function writeView(view: CatalogueView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.q.trim()) params.set("q", view.q);
  if (view.status !== "active") params.set("status", view.status);
  if (view.category !== null) params.set("category", view.category === "" ? NO_CATEGORY : view.category);
  if (view.tag) params.set("tag", view.tag);
  if (view.supplier) params.set("supplier", view.supplier);
  if (view.unit) params.set("unit", view.unit);
  if (view.health) params.set("health", "1");
  if (view.sort !== "name") params.set("sort", view.sort);
  if (view.dir !== "asc") params.set("dir", view.dir);
  if (view.item) params.set("item", view.item);
  if (view.manage) params.set("manage", view.manage);
  return params;
}

/**
 * Links from before the redesign: `?view=items` (the old item editor) and
 * `?itemCode=CODE` (health and quote links) land on the table, opening the
 * named item. Returns the params to replace the URL with, or null.
 */
export function upgradeLegacyParams(params: URLSearchParams): URLSearchParams | null {
  if (!params.has("view") && !params.has("itemCode") && !params.has("quoteCatalogId")) return null;
  const next = new URLSearchParams(params);
  const code = next.get("itemCode");
  next.delete("view");
  next.delete("itemCode");
  next.delete("quoteCatalogId");
  if (code && !next.get("item")) next.set("item", code);
  return next;
}

// ── Health ──────────────────────────────────────────────────────────────

export type HealthIndex = {
  /** Issues per item uid, worst first. */
  byUid: Map<string, PriceCatalogHealthIssue[]>;
  /** Items with a critical or warning issue. */
  attention: Set<string>;
  /** Issues that name no catalogue item (a quote rule's missing item, a staged import). */
  unattached: PriceCatalogHealthIssue[];
};

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

export function buildHealthIndex(report: PriceCatalogHealthReport | null, rows: Pick<PriceBookRow, "uid" | "code">[]): HealthIndex {
  const byUid = new Map<string, PriceCatalogHealthIssue[]>();
  const attention = new Set<string>();
  const unattached: PriceCatalogHealthIssue[] = [];
  if (!report) return { byUid, attention, unattached };
  const uids = new Set(rows.map((row) => row.uid));
  const byCode = new Map(rows.map((row) => [row.code.toLowerCase(), row.uid]));
  for (const issue of report.issues) {
    const uid = (issue.uid && uids.has(issue.uid) ? issue.uid : null)
      ?? (issue.status !== "missing" && issue.code ? byCode.get(issue.code.toLowerCase()) ?? null : null);
    if (!uid) { unattached.push(issue); continue; }
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid)!.push(issue);
    if (issue.severity !== "info") attention.add(uid);
  }
  for (const issues of byUid.values()) issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { byUid, attention, unattached };
}

/** One short line for a row: the worst issue, and how many more. */
export function healthSummary(issues: PriceCatalogHealthIssue[] | undefined): string | null {
  if (!issues?.length) return null;
  const relevant = issues.filter((issue) => issue.severity !== "info");
  const list = relevant.length ? relevant : issues;
  const first = sentenceCase(list[0].label);
  return list.length > 1 ? `${first} +${list.length - 1} more` : first;
}

export function sentenceCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ── Filtering, sorting, facets ─────────────────────────────────────────

export function rowMatchesQuery(row: PriceBookRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    row.name,
    row.category,
    ...row.tags,
    ...row.suppliers.flatMap((link) => [link.supplier_code, link.supplier_name]),
  ].filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

type FilterParts = Pick<CatalogueView, "q" | "status" | "category" | "tag" | "supplier" | "health"> & { unit?: string | null };

function matches(row: PriceBookRow, view: FilterParts, attention: Set<string>, skip: "status" | "category" | "tag" | null = null) {
  if (skip !== "status" && view.status !== "all" && row.status !== view.status) return false;
  if (skip !== "category" && view.category !== null && (row.category || "") !== view.category) return false;
  if (skip !== "tag" && view.tag && !row.tags.includes(view.tag)) return false;
  if (view.supplier && !row.suppliers.some((link) => link.supplier_uid === view.supplier)) return false;
  if (view.unit && row.unit_code !== view.unit) return false;
  if (view.health && !attention.has(row.uid)) return false;
  return rowMatchesQuery(row, view.q);
}

export function filterRows(rows: PriceBookRow[], view: FilterParts, attention: Set<string> = new Set()): PriceBookRow[] {
  return rows.filter((row) => matches(row, view, attention));
}

function compareText(a: string | null | undefined, b: string | null | undefined) {
  // Blank sorts last whichever way the column runs.
  return (a || "￿").localeCompare(b || "￿", "en", { sensitivity: "base" });
}

function compareNumber(a: number | null, b: number | null, dir: 1 | -1) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * dir;
}

export function sortRows(rows: PriceBookRow[], sort: SortKey, dir: "asc" | "desc"): PriceBookRow[] {
  const d = dir === "desc" ? -1 : 1;
  const byName = (a: PriceBookRow, b: PriceBookRow) => compareText(a.name, b.name);
  return [...rows].sort((a, b) => {
    let result = 0;
    if (sort === "cost") result = compareNumber(a.cost, b.cost, d);
    else if (sort === "sell") result = compareNumber(a.sell, b.sell, d);
    else if (sort === "margin") result = compareNumber(a.margin_pct, b.margin_pct, d);
    else if (sort === "category") result = (a.category && b.category) ? compareText(a.category, b.category) * d : compareText(a.category, b.category);
    else if (sort === "unit") result = compareText(a.unit, b.unit) * d;
    else result = byName(a, b) * d;
    return result || byName(a, b);
  });
}

export type Facets = {
  status: Record<StatusFilter, number>;
  categories: Array<{ name: string; count: number }>;
  tags: Array<{ name: string; count: number }>;
};

/** Counts for each filter, over the rows the other filters leave, so a chip says what a click would show. */
export function facetCounts(rows: PriceBookRow[], view: FilterParts, attention: Set<string> = new Set(), categoryOrder: string[] = []): Facets {
  const status: Record<StatusFilter, number> = { active: 0, draft: 0, archived: 0, all: 0 };
  const categories = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const row of rows) {
    if (matches(row, view, attention, "status")) { status[row.status] += 1; status.all += 1; }
    if (matches(row, view, attention, "category")) categories.set(row.category || "", (categories.get(row.category || "") || 0) + 1);
    if (matches(row, view, attention, "tag")) for (const tag of row.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
  }
  const rank = new Map(categoryOrder.map((name, index) => [name.toLowerCase(), index]));
  const orderOf = (name: string) => (name === "" ? Number.MAX_SAFE_INTEGER : rank.get(name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER - 1);
  return {
    status,
    categories: [...categories.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => orderOf(a.name) - orderOf(b.name) || compareText(a.name, b.name)),
    tags: [...tags.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => compareText(a.name, b.name)),
  };
}

// ── Price maths ─────────────────────────────────────────────────────────

export type CostMode = "manual" | "rollup";
export type SellMode = "fixed" | "markup" | "rollup";

export function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Margin is (sell − cost) ÷ sell, as a percentage; null when it can't be worked out. */
export function marginOf(cost: number | null, sell: number | null): number | null {
  if (cost == null || sell == null || !(sell > 0)) return null;
  return round(((sell - cost) / sell) * 100, 2);
}

/** Markup is (sell − cost) ÷ cost. */
export function markupOf(cost: number | null, sell: number | null): number | null {
  if (cost == null || sell == null || !(cost > 0)) return null;
  return round(((sell - cost) / cost) * 100, 2);
}

/** The text a person typed as a number, or null for blank/invalid. Accepts $, commas and %. */
export function parseNumber(text: string | null | undefined): number | null {
  const cleaned = String(text ?? "").replace(/[$,%\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export type DraftComponent = {
  uid: string;
  name: string;
  /** The component item's own unit (what its price is per). */
  unit: string;
  status: string;
  cost: number | null;
  sell: number | null;
  /** What the person typed, in `entryUnit`. */
  entryQuantity: string;
  entryUnit: string;
  /** Quantity in the component's unit per entry unit, for conversions the browser can't do (an item's own). */
  ratio: number | null;
  applicationMode: "proportional" | "fixed";
  contribution: "included" | "listed_only";
};

/** A component's quantity in its own unit, or null when the entry can't be read or converted. */
export function componentQuantity(component: Pick<DraftComponent, "entryQuantity" | "entryUnit" | "unit" | "ratio">): number | null {
  const entry = parseNumber(component.entryQuantity);
  if (entry == null || entry < 0) return null;
  const from = normalizeCatalogUnit(component.entryUnit) || normalizeCatalogUnit(component.unit);
  const to = normalizeCatalogUnit(component.unit);
  const converted = convertCatalogQuantity(entry, from, to);
  if (converted != null) return round(converted, 6);
  return component.ratio != null ? round(entry * component.ratio, 6) : null;
}

export type Rollup = { cost: number | null; sell: number | null; problems: string[] };

/** The kit's components summed the way the server's roll-up sums them (listed-only parts are shown, not added). */
export function rollupOf(components: DraftComponent[]): Rollup {
  let cost = 0;
  let sell = 0;
  let costOk = true;
  let sellOk = true;
  const problems: string[] = [];
  for (const component of components) {
    if (component.contribution === "listed_only") continue;
    const quantity = componentQuantity(component);
    if (quantity == null) { costOk = false; sellOk = false; problems.push(`${component.name}: quantity`); continue; }
    if (component.status !== "active") { costOk = false; sellOk = false; problems.push(`${component.name} is ${component.status}`); continue; }
    if (component.cost == null) { costOk = false; problems.push(`${component.name} has no cost`); } else cost += component.cost * quantity;
    if (component.sell == null) { sellOk = false; problems.push(`${component.name} has no selling price`); } else sell += component.sell * quantity;
  }
  return { cost: costOk ? round(cost, 4) : null, sell: sellOk ? round(sell, 2) : null, problems };
}

export type PriceInputs = {
  costMode: CostMode;
  sellMode: SellMode;
  cost: string;
  markup: string;
  sell: string;
};

/** What the drawer shows as the item's cost, selling price, margin and markup as it is typed. */
export function livePrice(price: PriceInputs, components: DraftComponent[], fallback: Rollup | null = null) {
  const rollup = components.length ? rollupOf(components) : fallback;
  const cost = price.costMode === "rollup" && rollup ? rollup.cost : parseNumber(price.cost);
  let sell: number | null;
  if (price.sellMode === "rollup" && rollup) sell = rollup.sell;
  else if (price.sellMode === "markup") {
    const markup = parseNumber(price.markup);
    sell = cost != null && markup != null ? round(cost * (1 + markup / 100), 2) : null;
  } else sell = parseNumber(price.sell);
  return { cost, sell, margin: marginOf(cost, sell), markup: markupOf(cost, sell), rollup };
}

// ── Drawer drafts and what saving sends ────────────────────────────────

export type SupplierLinkDraft = {
  /** Server link id; null for one not saved yet. */
  id: number | null;
  supplierUid: string;
  supplierName: string;
  supplierCode: string;
  packQty: string;
  isDefault: boolean;
};

export type PricingBasis = "" | "per_tonne" | "per_load" | "per_m3";

export type ItemDraft = {
  name: string;
  sellable: boolean;
  category: string;
  unit: string;
  tags: string[];
  notes: string;
  priceNote: string;
  status: "active" | "draft" | "archived";
  price: PriceInputs;
  /** Disposal costing basis: how a volume converts to what the item is priced per. */
  pricingBasis: PricingBasis;
  pricingBasisFactor: string;
  components: DraftComponent[];
  suppliers: SupplierLinkDraft[];
};

export function emptyDraft(): ItemDraft {
  return {
    name: "",
    sellable: true,
    category: "",
    unit: "each",
    tags: [],
    notes: "",
    priceNote: "",
    status: "active",
    price: { costMode: "manual", sellMode: "markup", cost: "", markup: "", sell: "" },
    pricingBasis: "",
    pricingBasisFactor: "",
    components: [],
    suppliers: [],
  };
}

function textOrNull(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function componentKey(component: DraftComponent) {
  return JSON.stringify([componentQuantity(component), component.entryQuantity.trim(), normalizeCatalogUnit(component.entryUnit), component.applicationMode, component.contribution]);
}

export type ComponentBody = {
  quantity: number;
  entry_quantity: number | null;
  entry_unit: string | null;
  application_mode: "proportional" | "fixed";
  pricing_contribution: "included" | "listed_only";
};

/** The body the kit-component endpoints take; the entry is kept only when it was typed in another unit. */
export function componentBody(component: DraftComponent): ComponentBody | null {
  const quantity = componentQuantity(component);
  if (quantity == null) return null;
  const entryUnit = normalizeCatalogUnit(component.entryUnit);
  const ownUnit = normalizeCatalogUnit(component.unit);
  const separate = entryUnit && entryUnit !== ownUnit;
  return {
    quantity,
    entry_quantity: separate ? parseNumber(component.entryQuantity) : null,
    entry_unit: separate ? entryUnit : null,
    application_mode: component.applicationMode,
    pricing_contribution: component.contribution,
  };
}

export type SavePlan = {
  /** Fields for PATCH /items/:uid (or POST /items for a new one); empty when nothing on the item changed. */
  item: Record<string, unknown>;
  addComponents: Array<{ uid: string; body: ComponentBody }>;
  updateComponents: Array<{ uid: string; body: ComponentBody }>;
  removeComponents: string[];
  linkSuppliers: SupplierLinkDraft[];
  unlinkSuppliers: number[];
  errors: string[];
};

/**
 * What saving `draft` over `base` sends. `base` is null for a new item, when
 * every field goes in the create body. Prices only go when something about
 * them changed, so a rename never writes a price row.
 */
export function planSave(base: ItemDraft | null, draft: ItemDraft, { recipe = false }: { recipe?: boolean } = {}): SavePlan {
  const errors: string[] = [];
  const item: Record<string, unknown> = {};
  const from = base ?? emptyDraft();
  const isNew = base === null;
  const name = draft.name.trim();
  if (!name) errors.push("Give the item a name");
  if (isNew || name !== from.name.trim()) item.name = name;
  if (isNew || draft.sellable !== from.sellable) item.catalog_type = draft.sellable ? "goods_service" : "component";
  if (isNew || draft.category.trim() !== from.category.trim()) item.category = textOrNull(draft.category);
  if (isNew || normalizeCatalogUnit(draft.unit) !== normalizeCatalogUnit(from.unit)) item.unit = normalizeCatalogUnit(draft.unit, "each");
  if ((isNew && draft.tags.length) || !sameList(draft.tags, from.tags)) item.tags = draft.tags;
  if ((isNew && draft.notes.trim()) || draft.notes.trim() !== from.notes.trim()) item.description = textOrNull(draft.notes);
  if ((isNew && draft.priceNote.trim()) || draft.priceNote.trim() !== from.priceNote.trim()) item.price_reference = textOrNull(draft.priceNote);
  if (!isNew && draft.status !== from.status) item.status = draft.status;
  const factor = parseNumber(draft.pricingBasisFactor);
  if (draft.pricingBasis !== from.pricingBasis || (draft.pricingBasis && factor !== parseNumber(from.pricingBasisFactor))) {
    if (draft.pricingBasis && (factor == null || factor <= 0)) errors.push("Enter the disposal conversion factor");
    item.pricing_basis = draft.pricingBasis || null;
    item.pricing_basis_factor = draft.pricingBasis ? factor : null;
  }

  const p = draft.price;
  const q = from.price;
  const priceChanged = isNew
    || p.costMode !== q.costMode || p.sellMode !== q.sellMode
    || (p.costMode === "manual" && parseNumber(p.cost) !== parseNumber(q.cost))
    || (p.sellMode === "markup" && parseNumber(p.markup) !== parseNumber(q.markup))
    || (p.sellMode === "fixed" && parseNumber(p.sell) !== parseNumber(q.sell));
  if (priceChanged) {
    const hasComponents = draft.components.length > 0;
    if ((p.costMode === "rollup" || p.sellMode === "rollup") && !hasComponents && !recipe) errors.push("Add a component before pricing from components");
    item.cost_mode = p.costMode;
    item.sell_mode = p.sellMode;
    if (p.costMode === "manual") {
      const cost = parseNumber(p.cost);
      if (p.cost.trim() && cost == null) errors.push("Cost must be a number");
      else if (cost != null && cost < 0) errors.push("Cost can't be negative");
      item.buy_price = cost;
    }
    if (p.sellMode === "markup") {
      const markup = parseNumber(p.markup);
      if (p.markup.trim() && markup == null) errors.push("Markup must be a number");
      item.markup_pct = markup;
    }
    if (p.sellMode === "fixed") {
      const sell = parseNumber(p.sell);
      if (p.sell.trim() && sell == null) errors.push("Selling price must be a number");
      else if (sell != null && sell < 0) errors.push("Selling price can't be negative");
      item.sell_price = sell;
    }
  }

  const before = new Map(from.components.map((component) => [component.uid, component]));
  const after = new Map(draft.components.map((component) => [component.uid, component]));
  const addComponents: SavePlan["addComponents"] = [];
  const updateComponents: SavePlan["updateComponents"] = [];
  for (const component of draft.components) {
    const body = componentBody(component);
    if (!body) { errors.push(`Enter a quantity for ${component.name}`); continue; }
    const previous = before.get(component.uid);
    if (!previous) addComponents.push({ uid: component.uid, body });
    else if (componentKey(previous) !== componentKey(component)) updateComponents.push({ uid: component.uid, body });
  }
  const removeComponents = from.components.filter((component) => !after.has(component.uid)).map((component) => component.uid);

  const linkKey = (link: SupplierLinkDraft) => JSON.stringify([link.supplierUid, link.supplierCode.trim(), parseNumber(link.packQty) ?? 1, link.isDefault]);
  const oldLinks = new Map(from.suppliers.filter((link) => link.id != null).map((link) => [link.id as number, link]));
  const linkSuppliers = draft.suppliers.filter((link) => {
    if (!link.supplierUid) return false;
    const pack = parseNumber(link.packQty);
    if (link.packQty.trim() && (pack == null || pack <= 0)) { errors.push(`Pack quantity for ${link.supplierName || "the supplier"} must be more than zero`); return false; }
    if (link.id == null) return true;
    const old = oldLinks.get(link.id);
    return !old || linkKey(old) !== linkKey(link);
  });
  const keptIds = new Set(draft.suppliers.map((link) => link.id).filter((id): id is number => id != null));
  // A link whose supplier changed is a new link: drop the old row.
  const changedSupplier = draft.suppliers.filter((link) => link.id != null && oldLinks.get(link.id)?.supplierUid !== link.supplierUid).map((link) => link.id as number);
  const unlinkSuppliers = [...[...oldLinks.keys()].filter((id) => !keptIds.has(id)), ...changedSupplier];

  return { item, addComponents, updateComponents, removeComponents, linkSuppliers, unlinkSuppliers, errors };
}

export function planIsEmpty(plan: SavePlan): boolean {
  return !Object.keys(plan.item).length && !plan.addComponents.length && !plan.updateComponents.length
    && !plan.removeComponents.length && !plan.linkSuppliers.length && !plan.unlinkSuppliers.length;
}

// ── Tags ────────────────────────────────────────────────────────────────

export function normalizeTag(text: string): string {
  return text.trim().replace(/^#+/, "").replace(/\s+/g, " ");
}

export function addTag(tags: string[], tag: string): string[] {
  const value = normalizeTag(tag);
  if (!value || tags.some((existing) => existing.toLowerCase() === value.toLowerCase())) return tags;
  return [...tags, value];
}

export function removeTag(tags: string[], tag: string): string[] {
  return tags.filter((existing) => existing !== tag);
}

/** Rename (or merge, when `to` is already there) a tag on one item's list, keeping its place. */
export function renameTag(tags: string[], from: string, to: string): string[] {
  const value = normalizeTag(to);
  if (!tags.includes(from)) return tags;
  const out: string[] = [];
  for (const tag of tags) {
    const next = tag === from ? value : tag;
    if (next && !out.some((existing) => existing.toLowerCase() === next.toLowerCase())) out.push(next);
  }
  return out;
}

// ── Bulk changes ────────────────────────────────────────────────────────

type Range = { min: number; max: number } | null;

function rangeOf(values: Array<number | null | undefined>): Range {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!numbers.length) return null;
  return { min: Math.min(...numbers), max: Math.max(...numbers) };
}

/** The headline of a bulk price change: how many items move, and the before/after ranges. */
export function bulkSummary(rows: BulkRow[]) {
  const changing = rows.filter((row) => row.action === "update");
  return {
    changing: changing.length,
    skipped: rows.length - changing.length,
    warnings: changing.filter((row) => row.warnings.length).length,
    sellBefore: rangeOf(changing.map((row) => row.before?.sell)),
    sellAfter: rangeOf(changing.map((row) => row.after?.sell)),
    marginBefore: rangeOf(changing.map((row) => row.before?.margin_pct)),
    marginAfter: rangeOf(changing.map((row) => row.after?.margin_pct)),
  };
}

export function formatRange(range: Range, format: (value: number) => string): string {
  if (!range) return "—";
  return range.min === range.max ? format(range.min) : `${format(range.min)} – ${format(range.max)}`;
}

/**
 * Run `task` over `items` one at a time (each is its own versioned write),
 * reporting progress, and collect what failed rather than stopping.
 */
export async function runInSequence<T>(items: T[], task: (item: T) => Promise<unknown>, onProgress?: (done: number, total: number) => void) {
  const failed: Array<{ item: T; error: unknown }> = [];
  let done = 0;
  for (const item of items) {
    try { await task(item); } catch (error) { failed.push({ item, error }); }
    done += 1;
    onProgress?.(done, items.length);
  }
  return { done, failed };
}

// ── Collections ────────────────────────────────────────────────────────

export type CategoryEntry = { id: number | null; name: string; count: number; sortOrder: number | null };

/**
 * Every category: the managed list (in its order) plus names items carry that
 * aren't on it yet, with how many items each holds.
 */
export function categoryEntries(managed: Array<{ id: number; name: string; sort_order: number }>, rows: Pick<PriceBookRow, "category">[]): CategoryEntry[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.category) continue;
    const key = row.category.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const seen = new Set<string>();
  const entries: CategoryEntry[] = [...managed]
    .sort((a, b) => a.sort_order - b.sort_order || compareText(a.name, b.name))
    .map((category) => {
      seen.add(category.name.toLowerCase());
      return { id: category.id, name: category.name, count: counts.get(category.name.toLowerCase()) || 0, sortOrder: category.sort_order };
    });
  const loose = new Map<string, string>();
  for (const row of rows) if (row.category && !seen.has(row.category.toLowerCase())) loose.set(row.category.toLowerCase(), row.category);
  for (const [key, name] of [...loose.entries()].sort((a, b) => compareText(a[1], b[1]))) {
    entries.push({ id: null, name, count: counts.get(key) || 0, sortOrder: null });
  }
  return entries;
}

// ── From the server ────────────────────────────────────────────────────

type ChildLike = {
  uid: string;
  name: string | null;
  unit: string | null;
  status: string;
  source: string;
  quantity: number | null;
  entry_quantity: number | null;
  entry_unit: string | null;
  application_mode: "proportional" | "fixed";
  pricing_contribution: "included" | "listed_only";
  buy_price: number | null;
  sell_price: number | null;
  effective_buy_price?: number | null;
  effective_sell_price?: number | null;
};

type DetailLike = {
  name: string;
  catalog_type: string;
  category: string | null;
  unit: string;
  tags: string[];
  description: string | null;
  price_reference: string | null;
  status: "active" | "draft" | "archived";
  cost_mode: CostMode;
  sell_mode: SellMode;
  buy_price: number | null;
  sell_price: number | null;
  markup_pct: number | null;
  pricing_basis: "per_tonne" | "per_load" | "per_m3" | null;
  pricing_basis_factor: number | null;
  children: ChildLike[];
};

type LinkLike = { id: number; supplier_uid: string | null; supplier_name: string | null; supplier_code: string | null; pack_qty: number; is_default: boolean };

function numberText(value: number | null | undefined) {
  return value == null ? "" : String(value);
}

/**
 * The drawer's editable copy of an item as the server returned it. A kit
 * priced by roll-up has no price row of its own worth editing, so its cost
 * and sell are the effective ones (shown, not sent unless the mode changes).
 */
export function draftFromDetail(detail: DetailLike, links: LinkLike[] = []): ItemDraft {
  const markup = detail.markup_pct ?? (detail.sell_mode !== "markup" ? markupOf(detail.buy_price, detail.sell_price) : null);
  return {
    name: detail.name,
    sellable: detail.catalog_type === "goods_service",
    category: detail.category || "",
    unit: detail.unit,
    tags: [...detail.tags],
    notes: detail.description || "",
    priceNote: detail.price_reference || "",
    status: detail.status,
    price: {
      costMode: detail.cost_mode,
      sellMode: detail.sell_mode,
      cost: numberText(detail.buy_price == null ? null : round(detail.buy_price, 4)),
      markup: numberText(markup == null ? null : round(markup, 3)),
      sell: numberText(detail.sell_price == null ? null : round(detail.sell_price, 2)),
    },
    pricingBasis: detail.pricing_basis || "",
    pricingBasisFactor: numberText(detail.pricing_basis_factor),
    components: detail.children.filter((child) => child.source === "db").map(componentFromChild),
    suppliers: links.filter((link) => link.supplier_uid).map((link) => ({
      id: link.id,
      supplierUid: link.supplier_uid as string,
      supplierName: link.supplier_name || "",
      supplierCode: link.supplier_code || "",
      packQty: numberText(link.pack_qty),
      isDefault: link.is_default,
    })),
  };
}

export function componentFromChild(child: ChildLike): DraftComponent {
  const unit = child.unit || "each";
  const entry = child.entry_quantity ?? child.quantity;
  return {
    uid: child.uid,
    name: child.name || "Unnamed item",
    unit,
    status: child.status,
    cost: child.effective_buy_price ?? child.buy_price,
    sell: child.effective_sell_price ?? child.sell_price,
    entryQuantity: numberText(entry),
    entryUnit: child.entry_unit || unit,
    ratio: child.entry_quantity && child.quantity != null ? child.quantity / child.entry_quantity : null,
    applicationMode: child.application_mode || "proportional",
    contribution: child.pricing_contribution || "included",
  };
}

/** A component picked from the table: one of it per unit of the kit, in its own unit. */
export function componentFromRow(row: Pick<PriceBookRow, "uid" | "name" | "unit" | "status" | "cost" | "sell">): DraftComponent {
  return {
    uid: row.uid,
    name: row.name,
    unit: row.unit,
    status: row.status,
    cost: row.cost,
    sell: row.sell,
    entryQuantity: "1",
    entryUnit: row.unit,
    ratio: null,
    applicationMode: "proportional",
    contribution: "included",
  };
}

/** Move one entry up or down a list of ids; returns the new order. */
export function moveId(ids: number[], id: number, delta: -1 | 1): number[] {
  const index = ids.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
