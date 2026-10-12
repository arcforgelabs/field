// Quote rows built from a catalogue line the server priced
// (GET /api/price-catalog/items/:code/quote-line). The rows keep their link
// to the catalogue (uid, price id, price key, frozen values) so the draft
// "catalogue changed" diff (server/quote-catalog-sync.js) can compare them
// with the catalogue later. Mirrors buildKitComponentNode on the server.
import type {
  QuoteCatalogChanges,
  QuoteCatalogChangeLine,
  QuoteCatalogFrozenKitComponent,
  QuoteCatalogLine,
  QuoteCatalogLineComponent,
  QuotePresentationOrganizerSourceNode,
} from "@/lib/types";
import { normalizeCatalogUnit } from "../../../../shared/catalog-units.js";
import { quoteCatalogReviewKey } from "../../../../shared/quote-catalog-review.js";

export class CatalogLineUnpricedError extends Error {
  constructor(line: QuoteCatalogLine) {
    super(`${line.name} (${line.code}) has no complete price in the catalogue, so it can't be added to a quote. Fix it in the catalogue first.`);
    this.name = "CatalogLineUnpricedError";
  }
}

export function slugifyCatalogCode(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

/** The link fields a row records for a catalogue line (rates in the line's unit). */
export function catalogLinkFieldsFromLine(line: QuoteCatalogLine): Partial<QuotePresentationOrganizerSourceNode> {
  const fields: Partial<QuotePresentationOrganizerSourceNode> = {
    catalogItemCode: line.code,
    catalogItemUid: line.itemUid,
    catalogPriceId: line.priceId ?? null,
    catalogPriceKey: line.priceKey,
    catalogName: line.name,
    catalogUnit: normalizeCatalogUnit(line.unit, "each"),
  };
  if (line.sellRate != null) fields.catalogSellRate = line.sellRate;
  if (line.buyRate != null) fields.catalogBuyRate = line.buyRate;
  if (line.assemblyVersion != null) fields.catalogAssemblyVersion = line.assemblyVersion;
  return fields;
}

/**
 * The link fields for refreshing an existing row from the catalogue without
 * rebuilding its rows. A kit row priced from its component rows keeps its
 * price key and price id: they stand for the kit contents its rows were built
 * from, and only rebuilding the rows (or applying the kit's catalogue change)
 * may move them. Otherwise the draft diff would take the kit's contents as
 * unchanged while its rows still differ.
 */
export function catalogLinkFieldsForExistingRow(
  line: QuoteCatalogLine,
  { isKitRow }: { isKitRow: boolean },
): Partial<QuotePresentationOrganizerSourceNode> {
  const fields = catalogLinkFieldsFromLine(line);
  if (isKitRow) {
    delete fields.catalogPriceKey;
    delete fields.catalogPriceId;
  }
  return fields;
}

/** The components a kit row added as component rows freezes (see server frozenKitComponents). */
export function frozenKitComponentsFromLine(components: QuoteCatalogLineComponent[]): QuoteCatalogFrozenKitComponent[] {
  return components
    .filter((component) => component.itemUid)
    .map((component) => ({
      itemUid: component.itemUid as string,
      code: component.code || null,
      quantity: component.quantity,
      unit: component.unit,
    }));
}

export function assertCatalogLinePriced(line: QuoteCatalogLine) {
  if (!line.priced || line.sellRate == null || line.buyRate == null) throw new CatalogLineUnpricedError(line);
}

export function buildCatalogComponentRow(
  line: QuoteCatalogLine,
  component: QuoteCatalogLineComponent,
  nonce: string,
): QuotePresentationOrganizerSourceNode {
  const node: QuotePresentationOrganizerSourceNode = {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: `manual-catalog-${slugifyCatalogCode(line.code)}-${slugifyCatalogCode(component.code || "")}-${nonce}-${component.index}`,
    labelOverride: component.name || component.code,
    amountVisible: true,
    quantity: component.quantity,
    unit: component.unit,
    sellRate: component.sellRate ?? 0,
    buyRate: component.buyRate ?? 0,
    applicationMode: component.applicationMode,
    rateMode: "catalog-linked",
    catalogItemCode: component.code || undefined,
    catalogItemUid: component.itemUid || undefined,
    catalogPriceId: component.priceId ?? null,
    catalogPriceKey: component.priceKey || undefined,
    catalogName: component.name || undefined,
    catalogUnit: component.unit,
    catalogQuantity: component.quantity,
    catalogComponentOf: line.itemUid,
  };
  if (component.sellRate != null) node.catalogSellRate = component.sellRate;
  if (component.buyRate != null) node.catalogBuyRate = component.buyRate;
  if (component.pricingContribution === "listed_only") node.pricingContribution = "listed_only";
  return node;
}

/**
 * Whether a kit's component rows add up to its catalogue cost and sell to the
 * cent. A kit row prices from its component rows (its own rate is 0), so a kit
 * whose rows do not add up (the server withholds those, e.g. recipe kits with
 * a materials allowance) must go on the quote as one row at its own price.
 */
export function catalogComponentsReproducePrice(line: QuoteCatalogLine) {
  const components = line.components || [];
  if (!components.length || line.sellRate == null || line.buyRate == null) return false;
  let sell = 0;
  let cost = 0;
  for (const component of components) {
    if (!component.itemUid || component.sellRate == null || component.buyRate == null) return false;
    if (component.pricingContribution === "listed_only") continue;
    sell += component.sellRate * component.quantity;
    cost += component.buyRate * component.quantity;
  }
  return Math.abs(sell - line.sellRate) < 0.005 && Math.abs(cost - line.buyRate) < 0.005;
}

/**
 * A catalogue item as quote rows: the item's row and, for a kit whose
 * component rows add up to its price, one row per component. A kit row prices
 * from its component rows (its own rate is 0); any other item is one row at
 * the catalogue price.
 */
export function buildCatalogQuoteRows(line: QuoteCatalogLine, { nodeId, nonce }: { nodeId: string; nonce: string }) {
  assertCatalogLinePriced(line);
  const components = catalogComponentsReproducePrice(line) ? line.components : [];
  const children = components.map((component, index) => ({
    id: `manual:${nonce}:child-${index}-${slugifyCatalogCode(component.code || "").slice(0, 8)}`,
    node: buildCatalogComponentRow(line, component, nonce),
  }));
  const parent: QuotePresentationOrganizerSourceNode = {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: `manual-catalog-${slugifyCatalogCode(line.code)}-${nonce}`,
    labelOverride: line.name,
    amountVisible: true,
    quantity: 1,
    unit: normalizeCatalogUnit(line.unit, "each"),
    sellRate: children.length > 0 ? 0 : (line.sellRate ?? 0),
    buyRate: children.length > 0 ? 0 : (line.buyRate ?? 0),
    rateMode: "catalog-linked",
    collapsed: false,
    ...catalogLinkFieldsFromLine(line),
    ...(children.length > 0
      ? { children: children.map((child) => child.id), catalogKitComponents: frozenKitComponentsFromLine(components) }
      : {}),
  };
  return { nodeId, parent, children };
}

export function catalogChangesHeadline(changes: QuoteCatalogChanges | null) {
  const count = changes?.changedCount || 0;
  if (!count) return "Prices match the catalogue";
  return `${count} ${count === 1 ? "line" : "lines"} changed in the catalogue`;
}

function money(value: number | string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return `$${numeric.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function percent(from: number, to: number) {
  if (!from) return "";
  const delta = ((to - from) / from) * 100;
  return ` (${delta > 0 ? "+" : ""}${delta.toFixed(1)}%)`;
}

/**
 * Whether the banner ticks a row before the operator does. The server decides
 * (`selectedByDefault`); the client also refuses anything flagged, so a
 * missing or stale flag fails closed: overridden rows, rows whose price
 * source is unknown and kits resting on legacy rows wait for the operator.
 */
export function catalogChangeSelectedByDefault(line: QuoteCatalogChangeLine) {
  return line.applicable
    && line.selectedByDefault === true
    && !line.overridden
    && !line.priceSourceUnknown
    && !line.legacyKitRows
    && !line.pricedFromChildren;
}

/**
 * The listed rows the operator changed on `organizer` since the check that
 * listed them: the row, or a row directly under it (a kit's component rows),
 * no longer matches the state the check saw (`reviewKey`). Their diff, and
 * whether they should be ticked, may be out of date, so the editor checks
 * again before it applies them. A line without a key (an older server) is
 * left to the server's own check.
 */
export function catalogChangesEditedSinceCheck(
  changes: QuoteCatalogChanges | null,
  organizer: { nodes?: Record<string, unknown> } | null | undefined,
): Set<string> {
  const edited = new Set<string>();
  for (const line of changes?.lines || []) {
    if (line.reviewKey === undefined) continue;
    if (quoteCatalogReviewKey(organizer, line.nodeId) !== line.reviewKey) edited.add(line.nodeId);
  }
  return edited;
}

/** Plain-language lines describing one row's change, for the banner. */
export function describeCatalogChange(line: QuoteCatalogChangeLine): string[] {
  const out: string[] = [];
  if (line.message) out.push(line.message);
  for (const field of line.fields) {
    if (field.field === "sellRate" || field.field === "buyRate") {
      const label = field.field === "sellRate" ? "Sell" : "Cost";
      const per = field.unit ? ` / ${field.unit}` : "";
      out.push(`${label} ${money(field.from)} → ${money(field.to)}${per}${percent(Number(field.from), Number(field.to))}`);
    } else if (field.field === "name") {
      out.push(`Renamed "${field.from}" → "${field.to}"`);
    } else if (field.field === "unit") {
      out.push(`Catalogue unit ${field.from} → ${field.to}`);
    } else if (field.field === "code") {
      out.push(`Code ${field.from} → ${field.to}`);
    }
  }
  for (const added of line.kit?.added || []) {
    const note = added.unconfirmed ? " (not on this quote; you may have removed it)" : "";
    out.push(`Kit adds ${added.name || added.code} × ${added.quantity} ${added.unit}${note}`);
  }
  for (const removed of line.kit?.removed || []) out.push(`Kit no longer includes ${removed.name || removed.code}`);
  for (const quantity of line.kit?.quantities || []) {
    const note = quantity.overridden
      ? " (edited on this quote)"
      : quantity.fromUnknown ? " (the quote's quantity; it may be your edit)" : "";
    out.push(`${quantity.name || quantity.code}: ${quantity.from} → ${quantity.to} ${quantity.unit} per kit${note}`);
  }
  if (line.legacyKitRows) out.push("Its rows were added before Field linked kit rows to the catalogue. Check them before applying.");
  if (line.priceSourceUnknown && !out.length) out.push("Price source unknown: this row was added before Field recorded which catalogue price it used.");
  return out;
}
