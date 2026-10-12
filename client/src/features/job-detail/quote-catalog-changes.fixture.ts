// What the server's catalogue diff (server/quote-catalog-sync.js) returns for
// an older draft whose recipe kit the base-era editor expanded into rows:
// tree-supply-install ($300) on the quote as its LABOURER-HOUR and
// VEHICLE-HOUR rows ($31.20), the kit row at rate 0, code links only. Taken
// from the server test "an older recipe-kit draft expanded by the base editor
// collapses to one row and is never double-priced" (uids shortened).
import type { QuoteCatalogChanges } from "@/lib/types";

export const baseEraRecipeKitChanges: QuoteCatalogChanges = {
  catalogVersion: 3,
  etag: "W/\"catalog-3-0\"",
  changedCount: 3,
  applicableCount: 3,
  lines: [
    {
      nodeId: "manual:k",
      parentNodeId: null,
      label: "Tree supply and install",
      code: "tree-supply-install",
      itemUid: "cat_tree",
      kitComponentOf: null,
      overridden: false,
      priceSourceUnknown: true,
      isKit: true,
      legacyKitRows: true,
      pricedFromChildren: false,
      selectedByDefault: false,
      status: "changed",
      applicable: true,
      message: "The catalogue now prices tree-supply-install as one line, not as its component rows. Applying replaces the component rows with one row at the catalogue price.",
      fields: [
        { field: "sellRate", from: 31.2, to: 300, rowValue: 0, unit: "each" },
        { field: "buyRate", from: 15.6, to: 150, rowValue: 0, unit: "each" },
      ],
      kit: {
        added: [],
        removed: [
          { nodeId: "manual:k:0", itemUid: "cat_labour", code: "LABOURER-HOUR", name: "LABOURER-HOUR" },
          { nodeId: "manual:k:1", itemUid: "cat_vehicle", code: "VEHICLE-HOUR", name: "VEHICLE-HOUR" },
        ],
        quantities: [],
        collapsed: true,
      },
    },
    ...(["LABOURER-HOUR", "VEHICLE-HOUR"] as const).map((code, index) => ({
      nodeId: `manual:k:${index}`,
      parentNodeId: "manual:k",
      label: code,
      code,
      itemUid: index === 0 ? "cat_labour" : "cat_vehicle",
      kitComponentOf: null,
      overridden: false,
      priceSourceUnknown: true,
      isKit: false,
      legacyKitRows: false,
      pricedFromChildren: false,
      selectedByDefault: false,
      status: "changed" as const,
      applicable: true,
      message: null,
      fields: [],
      kit: null,
    })),
  ],
};
