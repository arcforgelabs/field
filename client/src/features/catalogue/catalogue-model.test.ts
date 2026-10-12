import { describe, expect, it } from "vitest";
import type { BulkRow, PriceBookRow } from "@/features/pricing/price-book-api";
import type { PriceCatalogHealthReport } from "@/lib/types";
import {
  addTag, buildHealthIndex, bulkSummary, categoryEntries, componentFromRow, componentQuantity, draftFromDetail,
  emptyDraft, facetCounts, filterRows, formatRange, healthSummary, livePrice, marginOf, markupOf, moveId,
  parseNumber, planIsEmpty, planSave, readView, renameTag, rollupOf, runInSequence, sortRows,
  upgradeLegacyParams, writeView, type DraftComponent, type ItemDraft,
} from "./catalogue-model";

function row(overrides: Partial<PriceBookRow> = {}): PriceBookRow {
  return {
    uid: "itm_1", code: "itm_1", name: "Gravel", description: null, category: "Materials", tags: [], unit: "tonne",
    unit_code: "tonne", kind: null, catalog_type: "goods_service", status: "active", version: 1, tax_code: "GST",
    cost_mode: "manual", sell_mode: "markup", cost: 40, sell: 60, markup_pct: 50, margin_pct: 33.33, warnings: [],
    price_id: 1, price_effective_from: null, price_source: "manual", pending_price: null, variant_of_uid: null,
    variant_of_code: null, variant_of_name: null, child_count: 0, problems: [], suppliers: [], supplier_name: null,
    supplier_code: null, updated_at: null,
    ...overrides,
  };
}

const view = { q: "", status: "active" as const, category: null, tag: null, supplier: null, health: false };

describe("URL state", () => {
  it("round-trips a view and leaves defaults out", () => {
    const params = new URLSearchParams("q=sand&status=archived&category=__none&tag=walls&health=1&sort=margin&dir=desc&item=itm_9&unit=m3");
    const parsed = readView(params);
    expect(parsed).toMatchObject({ q: "sand", status: "archived", category: "", tag: "walls", health: true, sort: "margin", dir: "desc", item: "itm_9", unit: "m3", manage: null });
    expect(writeView(parsed).toString()).toBe("q=sand&status=archived&category=__none&tag=walls&unit=m3&health=1&sort=margin&dir=desc&item=itm_9");
    expect(writeView(readView(new URLSearchParams(""))).toString()).toBe("");
  });

  it("ignores values it doesn't know", () => {
    expect(readView(new URLSearchParams("status=gone&sort=code&manage=everything"))).toMatchObject({ status: "active", sort: "name", manage: null });
  });

  it("sends old item-editor and health links to the table, opening the named item", () => {
    expect(upgradeLegacyParams(new URLSearchParams("view=items"))?.toString()).toBe("");
    expect(upgradeLegacyParams(new URLSearchParams("quoteCatalogId=embark-default&itemCode=MAT-SAND"))?.toString()).toBe("item=MAT-SAND");
    expect(upgradeLegacyParams(new URLSearchParams("item=itm_1"))).toBeNull();
  });
});

describe("filtering, sorting and facets", () => {
  const rows = [
    row({ uid: "a", name: "Gravel 20mm", tags: ["base"], suppliers: [{ id: 1, supplier_uid: "sup_1", supplier_name: "Boral", supplier_code: "GR-20", pack_qty: 1, is_default: true }] }),
    row({ uid: "b", name: "Sleeper", category: "Walls", cost: null, sell: 120, margin_pct: null }),
    row({ uid: "c", name: "Old turf", category: null, status: "archived", sell: 9 }),
    row({ uid: "d", name: "Labour", category: "Labour", unit_code: "hour", tags: ["base", "crew"], sell: 95 }),
  ];

  it("searches name, tags, category and supplier code, but not codes", () => {
    expect(filterRows(rows, { ...view, q: "gr-20" }).map((r) => r.uid)).toEqual(["a"]);
    expect(filterRows(rows, { ...view, q: "crew" }).map((r) => r.uid)).toEqual(["d"]);
    expect(filterRows(rows, { ...view, q: "walls slee" }).map((r) => r.uid)).toEqual(["b"]);
    expect(filterRows(rows, { ...view, q: "itm_1" })).toEqual([]);
  });

  it("filters by status, category (blank is uncategorised), tag, supplier, unit and health", () => {
    expect(filterRows(rows, { ...view, status: "archived" }).map((r) => r.uid)).toEqual(["c"]);
    expect(filterRows(rows, { ...view, status: "all", category: "" }).map((r) => r.uid)).toEqual(["c"]);
    expect(filterRows(rows, { ...view, tag: "base" }).map((r) => r.uid)).toEqual(["a", "d"]);
    expect(filterRows(rows, { ...view, supplier: "sup_1" }).map((r) => r.uid)).toEqual(["a"]);
    expect(filterRows(rows, { ...view, unit: "hour" }).map((r) => r.uid)).toEqual(["d"]);
    expect(filterRows(rows, { ...view, health: true }, new Set(["b"])).map((r) => r.uid)).toEqual(["b"]);
  });

  it("sorts with blanks last either way", () => {
    expect(sortRows(rows, "cost", "asc").map((r) => r.uid).at(-1)).toBe("b");
    expect(sortRows(rows, "cost", "desc").map((r) => r.uid).at(-1)).toBe("b");
    expect(sortRows(rows, "sell", "desc").map((r) => r.uid)).toEqual(["b", "d", "a", "c"]);
    expect(sortRows(rows, "category", "desc").map((r) => r.uid).at(-1)).toBe("c");
    expect(sortRows(rows, "name", "asc").map((r) => r.name)).toEqual(["Gravel 20mm", "Labour", "Old turf", "Sleeper"]);
  });

  it("counts each facet over what the other filters leave, categories in the managed order", () => {
    const facets = facetCounts(rows, { ...view, tag: "base" }, new Set(), ["Labour", "Materials"]);
    expect(facets.status).toEqual({ active: 2, draft: 0, archived: 0, all: 2 });
    expect(facets.categories).toEqual([{ name: "Labour", count: 1 }, { name: "Materials", count: 1 }]);
    expect(facets.tags).toEqual([{ name: "base", count: 2 }, { name: "crew", count: 1 }]);
  });
});

describe("health", () => {
  const report = {
    issues: [
      { key: "missing_category", severity: "info", label: "Missing Category", uid: "a", message: "" },
      { key: "cost_above_sell", severity: "critical", label: "Cost Above Selling", code: "SLEEPER", message: "" },
      { key: "missing_referenced_item", severity: "critical", label: "Missing Referenced Items", code: "GONE", status: "missing", message: "" },
      { key: "missing_price", severity: "warning", label: "Missing Price", uid: "a", message: "" },
    ],
  } as unknown as PriceCatalogHealthReport;

  it("attaches issues to items by uid or code and counts only warnings and worse", () => {
    const index = buildHealthIndex(report, [{ uid: "a", code: "a" }, { uid: "b", code: "sleeper" }]);
    expect([...index.attention].sort()).toEqual(["a", "b"]);
    expect(index.byUid.get("a")!.map((issue) => issue.key)).toEqual(["missing_price", "missing_category"]);
    expect(index.unattached.map((issue) => issue.code)).toEqual(["GONE"]);
    expect(healthSummary(index.byUid.get("a"))).toBe("Missing price");
    expect(healthSummary(index.byUid.get("b"))).toBe("Cost above selling");
    expect(healthSummary(undefined)).toBeNull();
  });
});

describe("price maths", () => {
  it("keeps margin and markup apart", () => {
    expect(marginOf(40, 60)).toBe(33.33);
    expect(markupOf(40, 60)).toBe(50);
    expect(marginOf(40, 0)).toBeNull();
    expect(markupOf(0, 10)).toBeNull();
  });

  it("reads typed numbers", () => {
    expect(parseNumber("$1,250.50")).toBe(1250.5);
    expect(parseNumber("25%")).toBe(25);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
  });

  const part = (overrides: Partial<DraftComponent>): DraftComponent => ({
    uid: "p", name: "Part", unit: "each", status: "active", cost: 10, sell: 15, entryQuantity: "1", entryUnit: "each", ratio: null,
    applicationMode: "proportional", contribution: "included", ...overrides,
  });

  it("converts component entries to the component's unit", () => {
    expect(componentQuantity(part({ unit: "hour", entryUnit: "min", entryQuantity: "30" }))).toBe(0.5);
    expect(componentQuantity(part({ unit: "tonne", entryUnit: "m3", entryQuantity: "2", ratio: 1.6 }))).toBe(3.2);
    expect(componentQuantity(part({ unit: "tonne", entryUnit: "m3", entryQuantity: "2" }))).toBeNull();
    expect(componentQuantity(part({ entryQuantity: "-1" }))).toBeNull();
  });

  it("rolls up included components and leaves listed-only ones out", () => {
    const rollup = rollupOf([
      part({ uid: "a", entryQuantity: "2" }),
      part({ uid: "b", unit: "hour", entryUnit: "min", entryQuantity: "30", cost: 60, sell: 90 }),
      part({ uid: "c", contribution: "listed_only", cost: 1000, sell: 1000 }),
    ]);
    expect(rollup).toEqual({ cost: 50, sell: 75, problems: [] });
    expect(rollupOf([part({ status: "archived" })]).cost).toBeNull();
    expect(rollupOf([part({ sell: null })])).toMatchObject({ cost: 10, sell: null });
  });

  it("shows the live price for each pricing method", () => {
    expect(livePrice({ costMode: "manual", sellMode: "markup", cost: "40", markup: "50", sell: "" }, [])).toMatchObject({ cost: 40, sell: 60, margin: 33.33, markup: 50 });
    expect(livePrice({ costMode: "manual", sellMode: "fixed", cost: "40", markup: "", sell: "50" }, [])).toMatchObject({ sell: 50, margin: 20 });
    expect(livePrice({ costMode: "rollup", sellMode: "rollup", cost: "", markup: "", sell: "" }, [part({ entryQuantity: "3" })])).toMatchObject({ cost: 30, sell: 45 });
    expect(livePrice({ costMode: "rollup", sellMode: "markup", cost: "", markup: "10", sell: "" }, [], { cost: 100, sell: null, problems: [] })).toMatchObject({ cost: 100, sell: 110 });
  });
});

describe("saving a draft", () => {
  const detail = {
    name: "Path kit", catalog_type: "goods_service", category: "Paths", unit: "m2", tags: ["paving"], description: null,
    price_reference: null, status: "active" as const, cost_mode: "rollup" as const, sell_mode: "markup" as const,
    buy_price: 30, sell_price: 45, markup_pct: 50, pricing_basis: null, pricing_basis_factor: null,
    children: [
      { uid: "gravel", name: "Gravel", unit: "tonne", status: "active", source: "db", quantity: 0.2, entry_quantity: null, entry_unit: null, application_mode: "proportional" as const, pricing_contribution: "included" as const, buy_price: 40, sell_price: 60 },
      { uid: "labour", name: "Labour", unit: "hour", status: "active", source: "db", quantity: 0.25, entry_quantity: 15, entry_unit: "min", application_mode: "proportional" as const, pricing_contribution: "included" as const, buy_price: 88, sell_price: 120 },
    ],
  };
  const links = [{ id: 7, supplier_uid: "sup_1", supplier_name: "Boral", supplier_code: "P-1", pack_qty: 1, is_default: true }];

  it("starts with nothing to save", () => {
    const base = draftFromDetail(detail, links);
    expect(base.components.map((c) => [c.uid, c.entryQuantity, c.entryUnit])).toEqual([["gravel", "0.2", "tonne"], ["labour", "15", "min"]]);
    expect(planIsEmpty(planSave(base, structuredClone(base)))).toBe(true);
  });

  it("a rename sends only the name, never a price", () => {
    const base = draftFromDetail(detail, links);
    const plan = planSave(base, { ...structuredClone(base), name: "  Garden path kit " });
    expect(plan.item).toEqual({ name: "Garden path kit" });
    expect(plan.errors).toEqual([]);
  });

  it("a price change sends the modes and the value that drives the price", () => {
    const base = draftFromDetail(detail, links);
    const draft = structuredClone(base);
    draft.price.markup = "60";
    expect(planSave(base, draft).item).toEqual({ cost_mode: "rollup", sell_mode: "markup", markup_pct: 60 });
    draft.price.sellMode = "fixed";
    draft.price.sell = "49.5";
    expect(planSave(base, draft).item).toEqual({ cost_mode: "rollup", sell_mode: "fixed", sell_price: 49.5 });
  });

  it("diffs components: added, changed and removed", () => {
    const base = draftFromDetail(detail, links);
    const draft: ItemDraft = structuredClone(base);
    draft.components = [
      { ...draft.components[1], entryQuantity: "30" },
      componentFromRow({ uid: "edging", name: "Edging", unit: "m", status: "active", cost: 5, sell: 8 }),
    ];
    const plan = planSave(base, draft);
    expect(plan.removeComponents).toEqual(["gravel"]);
    expect(plan.updateComponents).toEqual([{ uid: "labour", body: { quantity: 0.5, entry_quantity: 30, entry_unit: "min", application_mode: "proportional", pricing_contribution: "included" } }]);
    expect(plan.addComponents).toEqual([{ uid: "edging", body: { quantity: 1, entry_quantity: null, entry_unit: null, application_mode: "proportional", pricing_contribution: "included" } }]);
  });

  it("diffs supplier links", () => {
    const base = draftFromDetail(detail, links);
    const draft = structuredClone(base);
    draft.suppliers[0].supplierCode = "P-2";
    draft.suppliers.push({ id: null, supplierUid: "sup_2", supplierName: "Bunnings", supplierCode: "", packQty: "", isDefault: false });
    const plan = planSave(base, draft);
    expect(plan.linkSuppliers.map((link) => [link.supplierUid, link.supplierCode])).toEqual([["sup_1", "P-2"], ["sup_2", ""]]);
    expect(plan.unlinkSuppliers).toEqual([]);
    draft.suppliers = [];
    expect(planSave(base, draft).unlinkSuppliers).toEqual([7]);
  });

  it("a new item sends everything it needs, and no code", () => {
    const draft = { ...emptyDraft(), name: "Sand", category: "Materials", unit: "tonnes", price: { costMode: "manual" as const, sellMode: "markup" as const, cost: "30", markup: "40", sell: "" } };
    const plan = planSave(null, draft);
    expect(plan.item).toEqual({ name: "Sand", catalog_type: "goods_service", category: "Materials", unit: "tonne", cost_mode: "manual", sell_mode: "markup", buy_price: 30, markup_pct: 40 });
    expect(plan.item).not.toHaveProperty("code");
    expect(planSave(null, emptyDraft()).errors).toContain("Give the item a name");
  });

  it("refuses what the server would refuse", () => {
    const base = draftFromDetail(detail, links);
    const draft = structuredClone(base);
    draft.components = [];
    expect(planSave(base, { ...draft, price: { ...draft.price, markup: "70" } }).errors).toContain("Add a component before pricing from components");
    expect(planSave(base, { ...draft, price: { ...draft.price, markup: "70" } }, { recipe: true }).errors).toEqual([]);
    expect(planSave(base, { ...structuredClone(base), pricingBasis: "per_tonne", pricingBasisFactor: "" }).errors).toContain("Enter the disposal conversion factor");
    expect(planSave(base, { ...structuredClone(base), pricingBasis: "per_tonne", pricingBasisFactor: "1.6" }).item).toEqual({ pricing_basis: "per_tonne", pricing_basis_factor: 1.6 });
  });
});

describe("tags", () => {
  it("adds without duplicates and renames or merges in place", () => {
    expect(addTag(["walls"], "#Walls ")).toEqual(["walls"]);
    expect(addTag(["walls"], "drainage")).toEqual(["walls", "drainage"]);
    expect(renameTag(["a", "walls", "b"], "walls", "retaining")).toEqual(["a", "retaining", "b"]);
    expect(renameTag(["walls", "retaining"], "walls", "retaining")).toEqual(["retaining"]);
    expect(renameTag(["a"], "walls", "x")).toEqual(["a"]);
  });
});

describe("bulk changes", () => {
  const bulkRow = (action: "update" | "skip", before: number | null, after: number | null, warnings: BulkRow["warnings"] = []): BulkRow => ({
    uid: String(Math.random()), code: null, name: "x", action, reason: null, warnings,
    before: { cost: 10, sell: before, markup_pct: null, sell_mode: "markup", category: null, status: "active", margin_pct: before == null ? null : before - 10 },
    after: action === "update" ? { cost: 10, sell: after, markup_pct: null, sell_mode: "markup", category: null, status: "active", margin_pct: after == null ? null : after - 10 } : null,
  });

  it("summarises how many items move and the before and after ranges", () => {
    const summary = bulkSummary([bulkRow("update", 20, 22), bulkRow("update", 50, 55, [{ code: "low_margin", message: "" }]), bulkRow("skip", 99, null)]);
    expect(summary).toMatchObject({ changing: 2, skipped: 1, warnings: 1, sellBefore: { min: 20, max: 50 }, sellAfter: { min: 22, max: 55 } });
    expect(formatRange(summary.sellAfter, (v) => `$${v}`)).toBe("$22 – $55");
    expect(formatRange({ min: 3, max: 3 }, String)).toBe("3");
    expect(formatRange(null, String)).toBe("—");
  });

  it("runs per-item writes in order and collects failures", async () => {
    const seen: number[] = [];
    const progress: number[] = [];
    const result = await runInSequence([1, 2, 3], async (n) => { seen.push(n); if (n === 2) throw new Error("conflict"); }, (done) => progress.push(done));
    expect(seen).toEqual([1, 2, 3]);
    expect(progress).toEqual([1, 2, 3]);
    expect(result.failed.map((f) => f.item)).toEqual([2]);
  });
});

describe("collections", () => {
  it("lists managed categories in order, then names only items carry", () => {
    const entries = categoryEntries(
      [{ id: 2, name: "Walls", sort_order: 1 }, { id: 1, name: "Earthworks", sort_order: 0 }, { id: 3, name: "Empty", sort_order: 2 }],
      [{ category: "walls" }, { category: "Walls" }, { category: "Haulage" }, { category: null }],
    );
    expect(entries).toEqual([
      { id: 1, name: "Earthworks", count: 0, sortOrder: 0 },
      { id: 2, name: "Walls", count: 2, sortOrder: 1 },
      { id: 3, name: "Empty", count: 0, sortOrder: 2 },
      { id: null, name: "Haulage", count: 1, sortOrder: null },
    ]);
  });

  it("moves an id up or down and stops at the ends", () => {
    expect(moveId([1, 2, 3], 3, -1)).toEqual([1, 3, 2]);
    expect(moveId([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(moveId([1, 2, 3], 9, 1)).toEqual([1, 2, 3]);
  });
});
