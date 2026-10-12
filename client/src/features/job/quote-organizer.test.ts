import { describe, expect, it } from "vitest";
import type { Quote, QuoteCatalogLine } from "@/lib/types";
import { calculatePresentationScheduleTotals } from "../../../../shared/quote-presentation-renderer.js";
import { buildCatalogQuoteRows } from "@/features/job-detail/quote-catalog-rows";
import {
  addOneOffLine, addSection, buildInitialOrganizer, buildParentIndex, getSourceItems, insertNode, moveToParent,
  moveWithinParent, removeNode, type Organizer,
} from "./quote-organizer";

function engineQuote(): Quote {
  return {
    lineItems: [],
    totals: { subtotal: 300, gst: 30, total: 330, currency: "AUD" },
    presentation: {
      sourceItems: [
        { code: "dig", label: "Excavation", quantity: 1, unit: "lot", unitPrice: 200, totalPrice: 200, unitCost: 120, totalCost: 120 },
        { code: "cart", label: "Cartage", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, unitCost: 70, totalCost: 70 },
      ],
    },
  } as unknown as Quote;
}

function line(overrides: Partial<QuoteCatalogLine> = {}): QuoteCatalogLine {
  return {
    itemUid: "uid-kit", code: "kit", name: "Retaining wall", unit: "m2", status: "active", priced: true, problems: [],
    sellRate: 100, buyRate: 60, priceId: 7, priceKey: "k1", assemblyVersion: 1, catalogVersion: 3, etag: "e",
    components: [], ...overrides,
  };
}

describe("quote organizer", () => {
  it("builds a flat tree from the engine's items when the quote has no organizer", () => {
    const quote = engineQuote();
    const organizer = buildInitialOrganizer(quote, getSourceItems(quote));
    expect(organizer.root).toEqual(["source:dig", "source:cart"]);
    expect(calculatePresentationScheduleTotals({ organizer, sourceItems: getSourceItems(quote) })).toEqual({ charge: 300, cost: 190 });
  });

  it("adds sections and one-off lines, and moves rows between sections", () => {
    const organizer: Organizer = { root: [], nodes: {} };
    const first = addSection(organizer, "Earthworks");
    const second = addSection(organizer, "Landscape");
    const row = addOneOffLine(organizer, first, "Fencing");
    expect(organizer.nodes[row]).toMatchObject({ kind: "source", origin: "manual", labelOverride: "Fencing", quantity: 1, sellRate: 0 });
    expect(organizer.nodes[first].children).toEqual([row]);
    expect(moveToParent(organizer, row, second)).toBe(true);
    expect(organizer.nodes[first].children).toEqual([]);
    expect(buildParentIndex(organizer).get(row)).toBe(second);
    // A section can't move inside itself.
    expect(moveToParent(organizer, second, second)).toBe(false);
  });

  it("reorders siblings and stops at the ends", () => {
    const organizer: Organizer = { root: [], nodes: {} };
    const a = addOneOffLine(organizer, null, "A");
    const b = addOneOffLine(organizer, null, "B");
    expect(moveWithinParent(organizer, a, -1)).toBe(false);
    expect(moveWithinParent(organizer, a, 1)).toBe(true);
    expect(organizer.root).toEqual([b, a]);
  });

  it("records a removed engine row so a rebuild doesn't bring it back", () => {
    const quote = engineQuote();
    const organizer = buildInitialOrganizer(quote, getSourceItems(quote));
    removeNode(organizer, "source:cart");
    expect(organizer.root).toEqual(["source:dig"]);
    expect(organizer.removedSourceCodes).toEqual(["cart"]);
    expect(organizer.nodes["source:cart"]).toBeUndefined();
  });

  it("removes a section with everything in it", () => {
    const organizer: Organizer = { root: [], nodes: {} };
    const section = addSection(organizer, "Works");
    const row = addOneOffLine(organizer, section, "Row");
    removeNode(organizer, section);
    expect(organizer.root).toEqual([]);
    expect(organizer.nodes[row]).toBeUndefined();
  });

  it("prices a catalogue kit from its component rows, the way the server does", () => {
    const kit = line({
      sellRate: 100, buyRate: 60,
      components: [
        { index: 0, itemUid: "uid-block", code: "block", name: "Blocks", unit: "each", quantity: 10, sellRate: 6, buyRate: 4, priceId: 1, priceKey: "b", status: "active", priced: true, applicationMode: "proportional", pricingContribution: "included" },
        { index: 1, itemUid: "uid-lab", code: "labour", name: "Labour", unit: "hour", quantity: 1, sellRate: 40, buyRate: 20, priceId: 2, priceKey: "l", status: "active", priced: true, applicationMode: "proportional", pricingContribution: "included" },
      ],
    });
    const organizer: Organizer = { root: [], nodes: {} };
    const rows = buildCatalogQuoteRows(kit, { nodeId: "manual:kit", nonce: "n1" });
    organizer.nodes["manual:kit"] = rows.parent;
    for (const child of rows.children) organizer.nodes[child.id] = child.node;
    insertNode(organizer, "manual:kit", null);
    (organizer.nodes["manual:kit"] as { quantity?: number }).quantity = 3;
    expect(calculatePresentationScheduleTotals({ organizer, sourceItems: [] })).toEqual({ charge: 300, cost: 180 });
  });
});
