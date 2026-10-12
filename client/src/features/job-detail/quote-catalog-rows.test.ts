import { describe, expect, it } from "vitest";
import type { QuoteCatalogChangeLine, QuoteCatalogLine, QuoteCatalogLineComponent } from "@/lib/types";
import {
  buildCatalogQuoteRows,
  catalogChangeSelectedByDefault,
  catalogComponentsReproducePrice,
  catalogLinkFieldsForExistingRow,
  describeCatalogChange,
} from "./quote-catalog-rows";
import { baseEraRecipeKitChanges } from "./quote-catalog-changes.fixture";

function component(overrides: Partial<QuoteCatalogLineComponent>): QuoteCatalogLineComponent {
  return {
    index: 0,
    itemUid: "itm_child",
    code: "CHILD",
    name: "Child",
    unit: "each",
    quantity: 1,
    sellRate: 10,
    buyRate: 4,
    priceId: 1,
    priceKey: "pk_child",
    status: "active",
    priced: true,
    applicationMode: "proportional",
    pricingContribution: "included",
    ...overrides,
  };
}

function line(overrides: Partial<QuoteCatalogLine>): QuoteCatalogLine {
  return {
    itemUid: "itm_kit",
    code: "KIT",
    name: "Kit",
    unit: "each",
    status: "active",
    priced: true,
    problems: [],
    sellRate: 300,
    buyRate: 150,
    priceId: null,
    priceKey: "pk_kit",
    assemblyVersion: null,
    catalogVersion: 1,
    etag: "W/\"catalog-1-0\"",
    components: [],
    ...overrides,
  };
}

function rowsTotal(rows: ReturnType<typeof buildCatalogQuoteRows>) {
  const own = Number(rows.parent.sellRate) * Number(rows.parent.quantity);
  return rows.children.reduce((sum, child) => (
    child.node.pricingContribution === "listed_only" ? sum : sum + Number(child.node.sellRate) * Number(child.node.quantity)
  ), own);
}

describe("catalogue quote rows", () => {
  it("adds a recipe kit with a materials allowance as one row at the kit's price", () => {
    const rows = buildCatalogQuoteRows(line({ componentsWithheld: "recipe" }), { nodeId: "manual:a", nonce: "a" });
    expect(rows.children).toHaveLength(0);
    expect(rows.parent.sellRate).toBe(300);
    expect(rows.parent.buyRate).toBe(150);
    expect(rowsTotal(rows)).toBe(300);
  });

  it("expands a kit whose component rows add up to its price, and the rows total the kit price", () => {
    const kit = line({
      sellRate: 31,
      buyRate: 12.4,
      components: [
        component({ index: 0, itemUid: "itm_lab", code: "LABOURER-HOUR", unit: "min", quantity: 15, sellRate: 80 / 60, buyRate: 40 / 60 }),
        component({ index: 1, itemUid: "itm_gravel", code: "GRAVEL", unit: "m3", quantity: 0.2, sellRate: 55, buyRate: 12 }),
        component({ index: 2, itemUid: "itm_tag", code: "TAG", quantity: 1, sellRate: 99, buyRate: 99, pricingContribution: "listed_only" }),
      ],
    });
    expect(catalogComponentsReproducePrice(kit)).toBe(true);
    const rows = buildCatalogQuoteRows(kit, { nodeId: "manual:b", nonce: "b" });
    expect(rows.children).toHaveLength(3);
    expect(rows.parent.sellRate).toBe(0);
    expect(rowsTotal(rows)).toBeCloseTo(31, 2);
    // The kit row freezes the components it was added with, so a row the
    // operator deletes later is not taken for a catalogue addition.
    expect(rows.parent.catalogKitComponents).toEqual([
      { itemUid: "itm_lab", code: "LABOURER-HOUR", quantity: 15, unit: "min" },
      { itemUid: "itm_gravel", code: "GRAVEL", quantity: 0.2, unit: "m3" },
      { itemUid: "itm_tag", code: "TAG", quantity: 1, unit: "each" },
    ]);
  });

  it("freezes no kit components on a kit added as one row", () => {
    const rows = buildCatalogQuoteRows(line({ componentsWithheld: "recipe" }), { nodeId: "manual:a", nonce: "a" });
    expect(rows.parent.catalogKitComponents).toBeUndefined();
  });

  it("keeps a kit row's price key when the row is refreshed without rebuilding its rows", () => {
    const current = line({ priceKey: "pk_kit_now", priceId: null });
    const kitRow = catalogLinkFieldsForExistingRow(current, { isKitRow: true });
    expect(kitRow).not.toHaveProperty("catalogPriceKey");
    expect(kitRow).not.toHaveProperty("catalogPriceId");
    expect(kitRow.catalogName).toBe("Kit");
    const leafRow = catalogLinkFieldsForExistingRow(line({ priceKey: "pk_leaf", priceId: 7 }), { isKitRow: false });
    expect(leafRow.catalogPriceKey).toBe("pk_leaf");
    expect(leafRow.catalogPriceId).toBe(7);
  });

  it("falls back to one row when the component rows do not add up to the kit's price", () => {
    // The pre-fix shape: tree-supply-install at $300 with only its labour and
    // vehicle rows ($31.20), the materials allowance dropped.
    const kit = line({
      components: [
        component({ index: 0, itemUid: "itm_lab", code: "LABOURER-HOUR", unit: "min", quantity: 21, sellRate: 80 / 60, buyRate: 40 / 60 }),
        component({ index: 1, itemUid: "itm_veh", code: "VEHICLE-HOUR", unit: "min", quantity: 4.8, sellRate: 40 / 60, buyRate: 20 / 60 }),
      ],
    });
    expect(catalogComponentsReproducePrice(kit)).toBe(false);
    const rows = buildCatalogQuoteRows(kit, { nodeId: "manual:c", nonce: "c" });
    expect(rows.children).toHaveLength(0);
    expect(rowsTotal(rows)).toBe(300);
  });

  it("falls back to one row when a component has no catalogue item", () => {
    const kit = line({
      sellRate: 10,
      buyRate: 4,
      components: [component({ itemUid: null })],
    });
    expect(buildCatalogQuoteRows(kit, { nodeId: "manual:d", nonce: "d" }).children).toHaveLength(0);
  });
});

describe("catalogue change default selection", () => {
  const plain: QuoteCatalogChangeLine = {
    nodeId: "manual:turf",
    parentNodeId: null,
    label: "Turf",
    code: "TURF",
    itemUid: "itm_turf",
    kitComponentOf: null,
    overridden: false,
    priceSourceUnknown: false,
    isKit: false,
    legacyKitRows: false,
    selectedByDefault: true,
    status: "changed",
    applicable: true,
    message: null,
    fields: [{ field: "sellRate", from: 14, to: 15, rowValue: 14, unit: "m2" }],
    kit: null,
  };

  it("ticks a plain catalogue update", () => {
    expect(catalogChangeSelectedByDefault(plain)).toBe(true);
  });

  it("leaves an older recipe-kit draft's collapse and its legacy rows unticked", () => {
    expect(baseEraRecipeKitChanges.lines.filter(catalogChangeSelectedByDefault)).toEqual([]);
    const kit = baseEraRecipeKitChanges.lines[0];
    const described = describeCatalogChange(kit);
    expect(described).toContain("Sell $31.20 → $300.00 / each (+861.5%)");
    expect(described.some((text) => /added before Field linked kit rows/.test(text))).toBe(true);
  });

  it("fails closed on anything flagged, even if the server's flag says otherwise", () => {
    for (const flagged of [
      { overridden: true },
      { priceSourceUnknown: true },
      { legacyKitRows: true },
      { pricedFromChildren: true, applicable: false },
      { applicable: false },
      { selectedByDefault: false },
    ]) {
      expect(catalogChangeSelectedByDefault({ ...plain, ...flagged })).toBe(false);
    }
    const { selectedByDefault: _omitted, ...withoutFlag } = plain;
    expect(catalogChangeSelectedByDefault(withoutFlag as QuoteCatalogChangeLine)).toBe(false);
  });

  it("notes when a legacy kit quantity's 'from' may be the operator's edit", () => {
    const line: QuoteCatalogChangeLine = {
      ...plain,
      isKit: true,
      legacyKitRows: true,
      fields: [],
      kit: { added: [], removed: [], quantities: [{ nodeId: "n", itemUid: "itm_pit", code: "PIT", name: "Pit", from: 0.2, to: 0.1, unit: "each", overridden: false, fromUnknown: true }] },
    };
    expect(describeCatalogChange(line)).toContain("Pit: 0.2 → 0.1 each per kit (the quote's quantity; it may be your edit)");
  });

  it("notes when a kit addition may be a row the operator removed", () => {
    const line: QuoteCatalogChangeLine = {
      ...plain,
      isKit: true,
      overridden: true,
      selectedByDefault: false,
      fields: [],
      kit: { added: [{ itemUid: "itm_fit", code: "FITTING", name: "Fitting", quantity: 4, unit: "each", unconfirmed: true }], removed: [], quantities: [] },
    };
    expect(describeCatalogChange(line)).toContain("Kit adds Fitting × 4 each (not on this quote; you may have removed it)");
    expect(catalogChangeSelectedByDefault(line)).toBe(false);
  });
});
