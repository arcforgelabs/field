// Catalogue-linked quote rows and the draft "catalogue changed" diff.
//
// A quote row added from the price catalogue is a manual organizer source
// node that keeps a link to the catalogue item and the values it froze:
//
//   catalogItemUid     the item's identity (codes are editable; uids are not)
//   catalogItemCode    the code when the row was linked (display, legacy lookup)
//   catalogPriceId     the item_prices row it was priced from (null for a kit
//                      priced by roll-up, which no single row holds)
//   catalogPriceKey    moves whenever anything behind the price moves,
//                      including a kit's contents and quantities
//   catalogSellRate / catalogBuyRate / catalogName / catalogUnit
//                      what the catalogue said then, in the row's unit
//   catalogQuantity    a kit component's quantity per kit, in the row's unit
//   catalogComponentOf the kit's item uid, on rows added as kit components
//   catalogKitComponents on a kit row added as component rows: the
//                      components (uid, per-kit quantity, unit) it was added
//                      with, so a component row the operator deleted is
//                      told apart from one the catalogue added since
//   catalogPriceSource "unknown" for rows linked before price ids existed
//
// Editing a row's rate or unit marks it overridden (rateMode "manual"); the
// link stays. The prices on a row never change by themselves: a draft shows
// what changed in the catalogue since (computeQuoteCatalogChanges) and the
// operator applies some, all or none (applyQuoteCatalogChanges). A sent
// quote is never changed: the job routes refuse to apply to a locked version.
//
// Everything here is pure over one immutable catalogue snapshot
// (server/catalog/state.js loadCatalogState), so a diff and its apply see
// the same catalogue, and the result names the catalogue version it used.
import { createHash } from "node:crypto";
import { kitSnapshot } from "./catalog/rollup.js";
import { findItem, normalizeCode } from "./catalog/state.js";
import {
  convertCatalogQuantity,
  getDefaultCatalogEntryUnit,
  normalizeCatalogUnit,
} from "../shared/catalog-units.js";
import { quoteCatalogReviewKey } from "../shared/quote-catalog-review.js";

function round6(value) {
  return Math.round(Number(value || 0) * 1e6) / 1e6;
}

function sameValue(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(round6(a) - round6(b)) < 1e-6;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** A catalogue code as a lowercase slug (exported for tests). */
export function slugifyCatalogCode(value) {
  let slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  // The collapse leaves at most one dash at each end.
  if (slug.startsWith("-")) slug = slug.slice(1);
  if (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug.slice(0, 72);
}

// The catalogue editor keeps a kit's own "masterline" component (the kit's
// own price as a row); a quote never adds it as a component row.
function isMasterlineComponent(parentCode, childCode) {
  const suffix = "masterline";
  const parentSlug = slugifyCatalogCode(parentCode);
  const base = parentSlug ? parentSlug.slice(0, Math.max(1, 72 - suffix.length - 1)).replace(/-+$/g, "") : "catalog";
  return normalizeCode(childCode) === normalizeCode(`${base}-${suffix}`);
}

/**
 * A rate per `fromUnit` expressed per `toUnit`, or null when the units do not
 * convert (a per-tonne rate cannot price a per-metre row).
 */
export function convertRate(rate, fromUnit, toUnit) {
  if (rate == null) return null;
  const from = normalizeCatalogUnit(fromUnit, "each");
  const to = normalizeCatalogUnit(toUnit, from);
  if (from === to) return round6(rate);
  const fromPerTo = convertCatalogQuantity(1, to, from);
  if (fromPerTo == null || !Number.isFinite(fromPerTo)) return null;
  return round6(Number(rate) * fromPerTo);
}

function componentLine(component, index) {
  const item = component.item || {};
  const canonicalUnit = normalizeCatalogUnit(item.unit, "each");
  const canonicalQuantity = Math.max(0, Number(component.quantity ?? 0) || 0);
  const preferredEntryUnit = normalizeCatalogUnit(
    component.entryUnit,
    getDefaultCatalogEntryUnit(canonicalUnit, canonicalQuantity) || canonicalUnit,
  ) || canonicalUnit;
  const entryQuantity = component.entryQuantity != null
    ? Number(component.entryQuantity)
    : convertCatalogQuantity(canonicalQuantity, canonicalUnit, preferredEntryUnit);
  const unit = entryQuantity != null ? preferredEntryUnit : canonicalUnit;
  const quantity = entryQuantity != null ? entryQuantity : canonicalQuantity;
  return {
    index,
    itemUid: item.itemUid || null,
    code: item.code || null,
    name: item.name || item.code || null,
    unit,
    quantity: round6(quantity),
    sellRate: item.sell == null ? null : convertRate(item.sell, canonicalUnit, unit),
    buyRate: item.cost == null ? null : convertRate(item.cost, canonicalUnit, unit),
    priceId: item.priceId ?? null,
    priceKey: item.priceKey ?? null,
    status: item.itemUid ? item.status : "missing",
    priced: Boolean(item.priced),
    applicationMode: component.applicationMode === "fixed" ? "fixed" : "proportional",
    pricingContribution: component.pricingContribution === "listed_only" ? "listed_only" : "included",
  };
}

function centsMatch(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

/**
 * Whether a kit can go on a quote as component rows. A quote prices a kit
 * row from its component rows (the kit row's own rate is 0), so the rows
 * must reproduce the kit's catalogue cost and sell to the cent. That holds
 * only for kits built from real catalogue components (kit_components)
 * whose roll-up is the sum of those rows. A recipe-derived kit (a
 * quote-catalog recipe, with or without a balance "allowance" remainder), a
 * kit whose own price is set by hand or by markup, or one with a masterline
 * or missing child cannot be shown as rows that add up, so it goes on the
 * quote as one row at the kit's own price.
 */
function kitRowsReproducePrice(kit, rows) {
  const components = kit.components || [];
  if (!components.length) return { expand: false, reason: null };
  if (components.some((component) => component.source !== "db")) return { expand: false, reason: "recipe" };
  if (components.some((component) => component.balance)) return { expand: false, reason: "recipe" };
  if (!rows.length || rows.some((row) => !row.itemUid)) return { expand: false, reason: "does_not_sum" };
  if (kit.sell == null || kit.cost == null) return { expand: false, reason: "unpriced" };
  let sell = 0;
  let cost = 0;
  for (const row of rows) {
    if (row.pricingContribution === "listed_only") continue;
    if (row.sellRate == null || row.buyRate == null) return { expand: false, reason: "does_not_sum" };
    sell += row.sellRate * row.quantity;
    cost += row.buyRate * row.quantity;
  }
  if (!centsMatch(sell, kit.sell) || !centsMatch(cost, kit.cost)) return { expand: false, reason: "does_not_sum" };
  return { expand: true, reason: null };
}

/**
 * The catalogue line a quote row freezes for one item (code or uid). For a
 * kit whose component rows add up to its price to the cent (see
 * kitRowsReproducePrice), `components` holds the rows a quote adds under it,
 * each in its entry unit with its rate converted to that unit. Every other
 * item, including recipe-derived kits, has no components and goes on the
 * quote as one row at its own price; `componentsWithheld` says why a kit's
 * components were not expanded. Null when there is no such item.
 */
export function buildCatalogQuoteLine(state, identity) {
  const item = findItem(state, identity);
  if (!item) return null;
  const kit = kitSnapshot(state, item.uid);
  const rows = (kit.components || [])
    .filter((component) => !component.balance && !isMasterlineComponent(item.code, component.item?.code))
    .map((component, index) => componentLine(component, index));
  const expansion = kitRowsReproducePrice(kit, rows);
  return {
    itemUid: item.uid,
    code: item.code,
    name: item.name,
    unit: normalizeCatalogUnit(kit.unit, "each"),
    status: item.status,
    priced: Boolean(kit.priced),
    problems: kit.problems || [],
    sellRate: kit.sell == null ? null : round6(kit.sell),
    buyRate: kit.cost == null ? null : round6(kit.cost),
    priceId: kit.priceId ?? null,
    priceKey: kit.priceKey,
    assemblyVersion: null,
    catalogVersion: state.version,
    etag: state.etag,
    components: expansion.expand ? rows : [],
    componentsWithheld: expansion.reason,
  };
}

function originOf(node) {
  const origin = text(node?.origin);
  if (origin) return origin;
  const sourceKind = text(node?.sourceKind);
  if (sourceKind === "manual") return "manual";
  if (sourceKind === "generated_component") return "generated";
  return "engine";
}

export function isCatalogLinkedNode(node) {
  return node?.kind === "source"
    && originOf(node) === "manual"
    && Boolean(text(node.catalogItemUid) || text(node.catalogItemCode));
}

function resolveLinkedItem(state, node) {
  const uid = text(node.catalogItemUid);
  if (uid) return state.items.get(uid) || null;
  return findItem(state, text(node.catalogItemCode));
}

function isOverridden(node) {
  return node.rateMode !== "catalog-linked"
    || typeof node.priceOverride === "number"
    || typeof node.costOverride === "number";
}

// Placed nodes in display order, with each node's parent.
function walkOrganizer(organizer) {
  const nodes = organizer?.nodes || {};
  const order = [];
  const parentOf = new Map();
  const seen = new Set();
  const visit = (nodeId, parentId) => {
    if (seen.has(nodeId) || !nodes[nodeId]) return;
    seen.add(nodeId);
    order.push(nodeId);
    parentOf.set(nodeId, parentId);
    for (const childId of nodes[nodeId].children || []) visit(childId, nodeId);
  };
  for (const nodeId of organizer?.root || []) visit(nodeId, null);
  return { nodes, order, parentOf };
}

// The rows under a kit row that stand for its generated component rows:
//
//   - rows added as its components, which carry catalogComponentOf; and
//   - rows the editor added for its components before catalogComponentOf
//     existed ("legacy" rows). The base-era editor expanded every kit,
//     kit_components and quote-catalog recipe alike, so a legacy row can
//     stand for any component of the kit. Those are recognised only by how
//     the editor built them: the kit row is priced from its children (its
//     own rates are 0), the child links to one of the kit's components, and
//     the child's sourceCode is exactly the editor's component sourceCode,
//     `manual-catalog-<kit slug>-<child slug>-<nonce>-<index>`, where
//     <nonce> is the one in the kit row's own `manual-catalog-<kit slug>-<nonce>`
//     (so kit 'a' + child 'b-c' and kit 'a-b' + child 'c' cannot be
//     confused). A kit row without that sourceCode has no legacy rows.
//
// Anything else under a kit row is the operator's own row, even a row of a
// component item added from the picker (LABOURER-HOUR under a recipe kit):
// it is never counted, diffed, collapsed or removed as part of the kit.
// The base-era editor's nonce: `<Date.now() base 36>-<random base 36>`.
const BASE_ERA_NONCE = "[a-z0-9]+-[a-z0-9]*";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kitMemberTest(state, node, item) {
  const ownSell = finiteOrNull(node.sellRate) ?? 0;
  const ownBuy = finiteOrNull(node.buyRate) ?? 0;
  const pricedFromChildren = ownSell === 0 && ownBuy === 0;
  const components = pricedFromChildren
    ? (kitSnapshot(state, item.uid)?.components || [])
      .filter((component) => (component.item?.itemUid || component.item?.code) && !isMasterlineComponent(item.code, component.item?.code))
    : [];
  const kitSlugs = [...new Set([text(node.catalogItemCode), item.code].filter(Boolean).map(slugifyCatalogCode))];
  // The nonce the kit row was added with, from its own sourceCode.
  const parentSourceCode = text(node.sourceCode);
  const nonces = kitSlugs
    .map((kitSlug) => new RegExp(`^manual-catalog-${escapeRegExp(kitSlug)}-(${BASE_ERA_NONCE})$`).exec(parentSourceCode)?.[1])
    .filter(Boolean);
  const nonce = nonces.length ? `(?:${nonces.map(escapeRegExp).join("|")})` : null;
  return (child) => {
    if (!isCatalogLinkedNode(child)) return false;
    if (text(child.catalogComponentOf)) return child.catalogComponentOf === item.uid;
    return Boolean(legacyMemberComponent(child));
  };
  function legacyMemberComponent(child) {
    if (!components.length || !nonce) return null;
    const sourceCode = text(child.sourceCode);
    return components.find((component) => {
      if (!memberMatches(child, { itemUid: component.item.itemUid || null, code: component.item.code })) return false;
      const childSlugs = [...new Set([text(child.catalogItemCode), component.item.code].filter(Boolean).map(slugifyCatalogCode))];
      return kitSlugs.some((kitSlug) => childSlugs.some((childSlug) => (
        new RegExp(`^manual-catalog-${escapeRegExp(kitSlug)}-${escapeRegExp(childSlug)}-${nonce}-\\d+$`).test(sourceCode)
      )));
    }) || null;
  }
}

// The kit's member rows (see kitMemberTest), and whether any of them is a
// legacy row, recognised by its sourceCode rather than catalogComponentOf.
function kitMembers(state, nodes, node, item) {
  const children = (node.children || []).filter((childId) => nodes[childId]);
  if (!children.length) return { ids: [], legacy: false };
  const isMember = kitMemberTest(state, node, item);
  const ids = children.filter((childId) => isMember(nodes[childId]));
  return { ids, legacy: ids.some((id) => !text(nodes[id].catalogComponentOf)) };
}

function kitMemberIds(state, nodes, node, item) {
  return kitMembers(state, nodes, node, item).ids;
}

function memberMatches(child, component) {
  const uid = text(child.catalogItemUid);
  if (uid) return uid === component.itemUid;
  return normalizeCode(child.catalogItemCode) === normalizeCode(component.code);
}

// A component row the operator changed on this quote: a rate override, or a
// quantity that differs from the per-kit quantity it was added with.
function memberEdited(member) {
  if (isOverridden(member)) return true;
  const frozen = finiteOrNull(member.catalogQuantity);
  return frozen != null && !sameValue(frozen, finiteOrNull(member.quantity) ?? 0);
}

// The component uids a kit row was added (or last refreshed) with, or null
// for a kit row that froze none (a legacy row, or one added before Field
// recorded them).
function frozenKitComponentUids(node) {
  if (!Array.isArray(node.catalogKitComponents)) return null;
  return new Set(node.catalogKitComponents.map((component) => text(component?.itemUid)).filter(Boolean));
}

function diffKit(nodes, memberIds, line, frozenUids) {
  const components = line.components.filter((component) => component.itemUid);
  const added = [];
  const quantities = [];
  for (const component of components) {
    const memberId = memberIds.find((id) => memberMatches(nodes[id], component));
    if (!memberId) {
      // The kit row was added with this component and its row is gone: the
      // operator deleted it on this quote. That is their edit, not a
      // catalogue change, so it is not offered back.
      if (frozenUids?.has(component.itemUid)) continue;
      added.push({
        itemUid: component.itemUid,
        code: component.code,
        name: component.name,
        quantity: component.quantity,
        unit: component.unit,
        index: component.index,
        // With nothing frozen, a missing row may be one the operator deleted.
        ...(frozenUids ? {} : { unconfirmed: true }),
      });
      continue;
    }
    const member = nodes[memberId];
    const memberUnit = normalizeCatalogUnit(member.unit, component.unit);
    const to = component.unit === memberUnit
      ? component.quantity
      : convertCatalogQuantity(component.quantity, component.unit, memberUnit);
    if (to == null) continue;
    const frozen = finiteOrNull(member.catalogQuantity);
    const from = frozen ?? finiteOrNull(member.quantity) ?? 0;
    if (!sameValue(from, to)) {
      quantities.push({
        nodeId: memberId,
        itemUid: component.itemUid,
        code: component.code,
        name: component.name,
        from: round6(from),
        to: round6(to),
        unit: memberUnit,
        overridden: frozen != null && !sameValue(frozen, member.quantity),
        // A legacy row froze no per-kit quantity: "from" is the row's
        // quantity now, which may be the operator's edit.
        fromUnknown: frozen == null,
      });
    }
  }
  const removed = memberIds
    .filter((id) => text(nodes[id].catalogComponentOf) || text(nodes[id].catalogItemUid))
    .filter((id) => !components.some((component) => memberMatches(nodes[id], component)))
    .map((id) => ({
      nodeId: id,
      itemUid: text(nodes[id].catalogItemUid) || null,
      code: text(nodes[id].catalogItemCode) || null,
      name: text(nodes[id].labelOverride) || text(nodes[id].catalogItemCode) || null,
    }));
  return added.length || removed.length || quantities.length ? { added, removed, quantities } : null;
}

// Whether applying a kit's content changes would replace something the
// operator did on its component rows: a per-kit quantity they edited (or one
// a legacy row cannot vouch for) that the catalogue now changes, an edited
// row (rate or quantity) that the catalogue removes from the kit, or a
// component a kit row with no frozen components cannot vouch the operator
// did not delete.
function kitChangeTouchesEdits(nodes, kit) {
  if (!kit) return false;
  return kit.added.some((addition) => addition.unconfirmed)
    || kit.quantities.some((change) => change.overridden || change.fromUnknown)
    || kit.removed.some((removal) => nodes[removal.nodeId] && memberEdited(nodes[removal.nodeId]));
}

function placedChildIds(nodes, node) {
  return (node.children || []).filter((childId) => nodes[childId]);
}

// A row whose own rates are 0 and that has rows under it is priced from those
// rows. Giving it its own rate would add the catalogue price on top of them.
function pricedFromChildRows(nodes, node) {
  return (finiteOrNull(node.sellRate) ?? 0) === 0
    && (finiteOrNull(node.buyRate) ?? 0) === 0
    && placedChildIds(nodes, node).length > 0;
}

// What a kit's member rows add up to per kit (their quantities are per kit).
function memberRowsRate(nodes, memberIds) {
  let sell = 0;
  let buy = 0;
  for (const id of memberIds) {
    const member = nodes[id];
    if (member.pricingContribution === "listed_only") continue;
    const quantity = finiteOrNull(member.quantity) ?? 0;
    sell += (finiteOrNull(member.sellRate) ?? 0) * quantity;
    buy += (finiteOrNull(member.buyRate) ?? 0) * quantity;
  }
  return { sell: round6(sell), buy: round6(buy) };
}

// Whether the banner ticks a row before the operator does. Anything that
// replaces an edit (overridden), rests on a guess about how an older row was
// built (price source unknown, legacy kit rows) or cannot be applied starts
// unselected: the default apply only takes plain catalogue updates.
function selectedByDefault(entry) {
  return Boolean(entry.applicable && !entry.overridden && !entry.priceSourceUnknown && !entry.legacyKitRows);
}

function describeProblems(line) {
  const parts = (line.problems || []).map((problem) => {
    if (problem.kind === "missing_child") return `component ${problem.childCode} is missing`;
    if (problem.kind === "inactive_child") return `component ${problem.childCode} is ${problem.status}`;
    if (problem.kind === "unpriced_child") return `component ${problem.childCode} has no ${problem.side} price`;
    if (problem.kind === "unresolved_quantity") return `component ${problem.childCode} has no quantity`;
    return problem.kind;
  });
  return parts.length ? ` (${[...new Set(parts)].join("; ")})` : "";
}

function diffNode(state, nodes, nodeId, parentNodeId) {
  const node = nodes[nodeId];
  const code = text(node.catalogItemCode) || text(node.catalogItemUid);
  const priceSourceUnknown = node.catalogPriceSource === "unknown"
    || (!text(node.catalogPriceKey) && finiteOrNull(node.catalogPriceId) == null);
  const parent = parentNodeId ? nodes[parentNodeId] : null;
  const base = {
    nodeId,
    parentNodeId: parentNodeId || null,
    label: text(node.labelOverride) || code,
    code,
    itemUid: text(node.catalogItemUid) || null,
    kitComponentOf: text(node.catalogComponentOf) || null,
    overridden: isOverridden(node),
    priceSourceUnknown,
    isKit: false,
    legacyKitRows: false,
    pricedFromChildren: false,
    fields: [],
    kit: null,
  };
  const item = resolveLinkedItem(state, node);
  if (!item) {
    return {
      ...base,
      status: "missing",
      applicable: false,
      message: `Catalogue item ${code} no longer exists. Re-add the row from the catalogue or keep it as a manual row.`,
    };
  }
  const line = buildCatalogQuoteLine(state, item.uid);
  const resolved = {
    ...base,
    code: item.code,
    itemUid: item.uid,
    current: {
      name: line.name,
      unit: line.unit,
      sellRate: line.sellRate,
      buyRate: line.buyRate,
      priceId: line.priceId,
      priceKey: line.priceKey,
    },
    priceKeyChanged: text(node.catalogPriceKey) ? node.catalogPriceKey !== line.priceKey : null,
  };
  if (item.status !== "active") {
    return {
      ...resolved,
      status: "archived",
      applicable: false,
      message: `Catalogue item ${item.code} is ${item.status}. Choose another item or keep this row as it is.`,
    };
  }
  const members = kitMembers(state, nodes, node, item);
  const memberIds = members.ids;
  const isKit = memberIds.length > 0;
  // A kit row added as component rows whose catalogue item can no longer be
  // shown as rows that add up to its price: applying turns it into one row
  // at the kit's price (its component rows are removed).
  const collapse = isKit && line.components.length === 0;
  resolved.isKit = isKit;
  resolved.legacyKitRows = members.legacy;
  if (!line.priced) {
    return {
      ...resolved,
      status: "unpriced",
      applicable: false,
      message: `Catalogue item ${item.code} has no complete price${describeProblems(line)}.`,
    };
  }
  const nodeUnit = normalizeCatalogUnit(node.unit, line.unit);
  const fields = [];
  if (!isKit || collapse) {
    const sellTo = convertRate(line.sellRate, line.unit, nodeUnit);
    const buyTo = convertRate(line.buyRate, line.unit, nodeUnit);
    if (sellTo == null || buyTo == null) {
      return {
        ...resolved,
        status: "unit_mismatch",
        applicable: false,
        message: `This row is in ${nodeUnit} but ${item.code} is priced per ${line.unit}, and the two do not convert.`,
      };
    }
    // A kit row priced from its rows that froze no kit rate (a legacy row)
    // is worth what its rows add up to per kit, not its own 0.
    const rowsFrom = collapse ? memberRowsRate(nodes, memberIds) : null;
    const sellFrom = finiteOrNull(node.catalogSellRate) ?? rowsFrom?.sell ?? finiteOrNull(node.sellRate) ?? 0;
    const buyFrom = finiteOrNull(node.catalogBuyRate) ?? rowsFrom?.buy ?? finiteOrNull(node.buyRate) ?? 0;
    if (!sameValue(sellFrom, sellTo)) {
      fields.push({ field: "sellRate", from: round6(sellFrom), to: sellTo, rowValue: finiteOrNull(node.sellRate), unit: nodeUnit });
    }
    if (!sameValue(buyFrom, buyTo)) {
      fields.push({ field: "buyRate", from: round6(buyFrom), to: buyTo, rowValue: finiteOrNull(node.buyRate), unit: nodeUnit });
    }
  }
  const frozenName = text(node.catalogName);
  if (frozenName && frozenName !== line.name) fields.push({ field: "name", from: frozenName, to: line.name });
  const frozenUnit = normalizeCatalogUnit(node.catalogUnit);
  if (frozenUnit && frozenUnit !== line.unit) fields.push({ field: "unit", from: frozenUnit, to: line.unit });
  const linkedCode = text(node.catalogItemCode);
  if (linkedCode && linkedCode !== item.code) fields.push({ field: "code", from: linkedCode, to: item.code });
  if (!isKit && pricedFromChildRows(nodes, node) && (line.sellRate || line.buyRate)) {
    // A row at rate 0 priced from rows under it that are not the kit's own
    // component rows (the operator's rows, or rows Field cannot tell were
    // generated). Applying would give it the catalogue price on top of them,
    // so it is listed and never applied.
    const meaningfulHere = fields.some((field) => field.field !== "code") || priceSourceUnknown;
    if (!meaningfulHere) return null;
    return {
      ...resolved,
      parentIsKit: Boolean(parent && isCatalogLinkedNode(parent) && text(node.catalogComponentOf)),
      status: "changed",
      applicable: false,
      pricedFromChildren: true,
      fields,
      message: `This row is priced from the rows under it (its own rate is 0), and they are not ${item.code}'s generated component rows. Applying would add ${item.code}'s catalogue price on top of them, so rebuild it from the catalogue or update the rows under it.`,
    };
  }
  if (collapse) {
    // Rows of the operator's own under the kit row, or nested under one of
    // its component rows, would be lost by a collapse: list it, never apply.
    const otherChildren = (node.children || []).filter((childId) => nodes[childId] && !memberIds.includes(childId));
    const nestedOwnRows = memberIds.some((id) => (nodes[id].children || []).some((childId) => nodes[childId]));
    const keepsOwnRows = otherChildren.length === 0 && !nestedOwnRows;
    // Collapsing discards edits made on the component rows (rates or
    // quantities), so it starts unselected like any other overridden row.
    const membersEdited = memberIds.some((id) => memberEdited(nodes[id]));
    return {
      ...resolved,
      overridden: resolved.overridden || membersEdited,
      parentIsKit: Boolean(parent && isCatalogLinkedNode(parent) && text(node.catalogComponentOf)),
      status: "changed",
      applicable: keepsOwnRows,
      fields,
      kit: {
        added: [],
        removed: memberIds.map((id) => ({
          nodeId: id,
          itemUid: text(nodes[id].catalogItemUid) || null,
          code: text(nodes[id].catalogItemCode) || null,
          name: text(nodes[id].labelOverride) || text(nodes[id].catalogItemCode) || null,
        })),
        quantities: [],
        collapsed: true,
      },
      message: keepsOwnRows
        ? `The catalogue now prices ${item.code} as one line, not as its component rows. Applying replaces the component rows with one row at the catalogue price.`
        : `The catalogue now prices ${item.code} as one line, not as its component rows, and this row has rows of your own under it. Rebuild it from the catalogue.`,
    };
  }
  // A kit's price key moves whenever its contents or quantities do, so a kit
  // row whose key still matches has no catalogue change to its contents:
  // anything that differs between its rows and the kit is the operator's.
  const contentsMayHaveChanged = resolved.priceKeyChanged !== false;
  const kit = isKit && contentsMayHaveChanged ? diffKit(nodes, memberIds, line, frozenKitComponentUids(node)) : null;
  const meaningful = fields.some((field) => field.field !== "code") || kit || priceSourceUnknown;
  if (!meaningful) return null;
  return {
    ...resolved,
    // Applying replaces edits on the kit's component rows that the change
    // touches, so it starts unselected like an overridden kit row.
    overridden: resolved.overridden || kitChangeTouchesEdits(nodes, kit),
    parentIsKit: Boolean(parent && isCatalogLinkedNode(parent) && text(node.catalogComponentOf)),
    status: "changed",
    applicable: true,
    fields,
    kit,
    message: null,
  };
}

/**
 * What changed in the catalogue for each catalogue-linked row of an
 * organizer: rates (in the row's unit), names, kit contents and kit
 * quantities, plus rows whose item is missing, archived, unpriced or in a
 * unit that cannot convert. Overridden rows are included and flagged. Rows
 * linked before price ids existed are labelled `priceSourceUnknown` and
 * always listed; kit rows recognised from how the base-era editor built them
 * are labelled `legacyKitRows`. Rows with no change are left out.
 * `selectedByDefault` says whether the banner ticks a row to begin with:
 * only applicable rows with none of those flags. `reviewKey` fingerprints the
 * row (and the rows directly under it) as this check saw it; an apply that
 * sends it back is refused for a row edited since (shared/quote-catalog-review.js).
 */
export function computeQuoteCatalogChanges({ state, organizer }) {
  const { nodes, order, parentOf } = walkOrganizer(organizer);
  const lines = [];
  for (const nodeId of order) {
    if (!isCatalogLinkedNode(nodes[nodeId])) continue;
    const entry = diffNode(state, nodes, nodeId, parentOf.get(nodeId));
    if (entry) {
      lines.push({
        ...entry,
        selectedByDefault: selectedByDefault(entry),
        reviewKey: quoteCatalogReviewKey(organizer, nodeId),
      });
    }
  }
  return {
    catalogVersion: state.version,
    etag: state.etag,
    changedCount: lines.length,
    applicableCount: lines.filter((line) => line.applicable).length,
    lines,
  };
}

/**
 * The components a kit row added as component rows freezes
 * (catalogKitComponents): uid, code, per-kit quantity and unit of each.
 */
export function frozenKitComponents(line) {
  return (line.components || [])
    .filter((component) => component.itemUid)
    .map((component) => ({
      itemUid: component.itemUid,
      code: component.code || null,
      quantity: round6(component.quantity),
      unit: component.unit,
    }));
}

/**
 * The link fields a row records for a catalogue line, rates in `unit`. With
 * `kitComponents`, a kit row added as component rows also freezes them.
 */
export function catalogLinkFields(line, { unit = line.unit, componentOf = null, quantity = null, kitComponents = false } = {}) {
  const fields = {
    catalogItemCode: line.code,
    catalogItemUid: line.itemUid,
    catalogPriceId: line.priceId ?? null,
    catalogPriceKey: line.priceKey,
    catalogName: line.name,
    catalogUnit: line.unit,
  };
  const sell = convertRate(line.sellRate, line.unit, unit);
  const buy = convertRate(line.buyRate, line.unit, unit);
  if (sell != null) fields.catalogSellRate = sell;
  if (buy != null) fields.catalogBuyRate = buy;
  if (line.assemblyVersion != null) fields.catalogAssemblyVersion = line.assemblyVersion;
  if (componentOf) fields.catalogComponentOf = componentOf;
  if (quantity != null) fields.catalogQuantity = round6(quantity);
  if (kitComponents && line.components?.length) fields.catalogKitComponents = frozenKitComponents(line);
  return fields;
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
}

/**
 * The organizer source node for one kit component row, the way the quote
 * editor adds it (client quote-presentation-sheet.tsx), with its link.
 */
export function buildKitComponentNode({ parentCode, parentUid, component, nonce }) {
  const node = {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: `manual-catalog-${slugifyCatalogCode(parentCode)}-${slugifyCatalogCode(component.code)}-${nonce}-${component.index}`,
    labelOverride: component.name || component.code,
    amountVisible: true,
    quantity: component.quantity,
    unit: component.unit,
    sellRate: component.sellRate ?? 0,
    buyRate: component.buyRate ?? 0,
    applicationMode: component.applicationMode,
    rateMode: "catalog-linked",
    catalogItemCode: component.code,
    catalogItemUid: component.itemUid,
    catalogPriceId: component.priceId ?? null,
    catalogPriceKey: component.priceKey,
    catalogName: component.name,
    catalogUnit: component.unit,
    catalogQuantity: component.quantity,
    catalogComponentOf: parentUid,
  };
  if (component.sellRate != null) node.catalogSellRate = component.sellRate;
  if (component.buyRate != null) node.catalogBuyRate = component.buyRate;
  if (component.pricingContribution === "listed_only") node.pricingContribution = "listed_only";
  return node;
}

function releaseOverrides(node) {
  delete node.priceOverride;
  delete node.costOverride;
  delete node.manualPrice;
  delete node.manualCost;
  delete node.userSellRate;
  delete node.userBuyRate;
}

function applyEntry(state, organizer, entry) {
  const nodes = organizer.nodes;
  const node = nodes[entry.nodeId];
  const line = buildCatalogQuoteLine(state, entry.itemUid);
  if (!node || !line) return false;
  const nodeUnit = normalizeCatalogUnit(node.unit, line.unit);
  const previousName = text(node.catalogName);
  if (entry.isKit && entry.kit?.collapsed) {
    const sell = convertRate(line.sellRate, line.unit, nodeUnit);
    const buy = convertRate(line.buyRate, line.unit, nodeUnit);
    if (sell == null || buy == null || line.components.length) return false;
    // The same member test as the diff, on the organizer being changed: only
    // generated component rows are removed, and nothing of the operator's.
    const item = state.items.get(line.itemUid);
    const members = new Set(item ? kitMemberIds(state, nodes, node, item) : []);
    const removing = new Set(entry.kit.removed.map((removal) => removal.nodeId));
    if (members.size !== removing.size || [...removing].some((id) => !members.has(id))) return false;
    if ((node.children || []).some((id) => nodes[id] && !members.has(id))) return false;
    if ([...members].some((id) => (nodes[id].children || []).some((childId) => nodes[childId]))) return false;
    for (const nodeId of members) delete nodes[nodeId];
    delete node.children;
    releaseOverrides(node);
    node.sellRate = sell;
    node.buyRate = buy;
    node.rateMode = "catalog-linked";
  } else if (entry.isKit) {
    if (typeof node.priceOverride === "number" || typeof node.costOverride === "number") {
      node.sellRate = 0;
      node.buyRate = 0;
    }
    releaseOverrides(node);
    node.rateMode = "catalog-linked";
    const kit = entry.kit || { added: [], removed: [], quantities: [] };
    for (const removal of kit.removed) {
      const removed = nodes[removal.nodeId];
      if (!removed) continue;
      // Rows the operator nested under a component row are theirs: they move
      // up to the kit row, in the removed row's place, instead of going with it.
      const kept = (removed.children || []).filter((id) => nodes[id]);
      delete nodes[removal.nodeId];
      node.children = (node.children || []).flatMap((id) => (id === removal.nodeId ? kept : [id]));
    }
    for (const change of kit.quantities) {
      const member = nodes[change.nodeId];
      if (!member) continue;
      member.quantity = change.to;
      member.catalogQuantity = change.to;
    }
    for (const addition of kit.added) {
      const component = line.components.find((candidate) => candidate.itemUid === addition.itemUid);
      if (!component) continue;
      const nonce = shortHash(`${entry.nodeId}|${component.itemUid}`);
      const childId = `manual:catalog-${nonce}`;
      if (nodes[childId]) continue;
      nodes[childId] = buildKitComponentNode({ parentCode: line.code, parentUid: line.itemUid, component, nonce });
      node.children = [...(node.children || []), childId];
    }
  } else {
    const sell = convertRate(line.sellRate, line.unit, nodeUnit);
    const buy = convertRate(line.buyRate, line.unit, nodeUnit);
    if (sell == null || buy == null) return false;
    // Never give a row priced from rows under it its own rate on top of them.
    if (pricedFromChildRows(nodes, node) && (sell || buy)) return false;
    releaseOverrides(node);
    node.sellRate = sell;
    node.buyRate = buy;
    node.rateMode = "catalog-linked";
  }
  if (previousName && text(node.labelOverride) === previousName) node.labelOverride = line.name;
  // A kit component keeps catalogComponentOf and catalogQuantity: its
  // quantity per kit belongs to the kit's own diff. A kit row still made of
  // component rows freezes the kit's components as they are now; a row that
  // is one line at its own price has none.
  const stillRows = entry.isKit && !entry.kit?.collapsed;
  delete node.catalogKitComponents;
  Object.assign(node, catalogLinkFields(line, { unit: nodeUnit, kitComponents: stillRows }));
  delete node.catalogPriceSource;
  return true;
}

function cloneOrganizer(organizer) {
  return JSON.parse(JSON.stringify(organizer || { root: [], nodes: {} }));
}

/**
 * Apply the selected rows' catalogue changes (all applicable rows when
 * `nodeIds` is null; with `defaultOnly`, only the rows the banner ticks by
 * default, never overridden or price-source-unknown ones) to a copy of
 * `organizer`: rates, names, kit contents and
 * quantities, releasing the row's overrides (applying is the operator's
 * explicit choice of the catalogue value) and recording the new price link.
 * Rows that cannot be applied (missing, archived, unpriced, unit mismatch)
 * are reported in `skipped` and left alone.
 *
 * An edit on the quote is only replaced by a caller that saw it:
 *
 *   - `reviewed` maps a row id to the `reviewKey` the caller's check listed
 *     it with. A row whose key differs now (edited, overridden, or its kit
 *     rows changed since that check) is skipped as `changed_since_review`:
 *     the caller checks again and reviews the new list. A row whose key
 *     matches is applied as reviewed, even when it is overridden (the banner
 *     showed it as "edited on this quote").
 *   - A row with no reviewed key (an API or CLI caller that sends none) that
 *     is overridden is skipped as `overridden`, unless `replaceEdits` is true.
 */
export function applyQuoteCatalogChanges({
  state,
  organizer,
  nodeIds = null,
  defaultOnly = false,
  reviewed = null,
  replaceEdits = false,
}) {
  const diff = computeQuoteCatalogChanges({ state, organizer });
  const next = cloneOrganizer(organizer);
  const selected = Array.isArray(nodeIds) ? new Set(nodeIds.map(String)) : null;
  const applied = [];
  const skipped = [];
  for (const entry of diff.lines) {
    if (selected && !selected.has(entry.nodeId)) continue;
    if (defaultOnly && !entry.selectedByDefault) continue;
    if (!entry.applicable) {
      skipped.push({ nodeId: entry.nodeId, status: entry.status, reason: entry.message });
      continue;
    }
    const reviewedKey = reviewed && Object.prototype.hasOwnProperty.call(reviewed, entry.nodeId)
      ? reviewed[entry.nodeId]
      : undefined;
    if (reviewedKey !== undefined) {
      if (reviewedKey !== entry.reviewKey) {
        skipped.push({
          nodeId: entry.nodeId,
          status: "changed_since_review",
          reason: `${entry.label} changed on this quote after the catalogue was checked, so it was not updated. Check again and review it.`,
        });
        continue;
      }
    } else if (entry.overridden && !replaceEdits) {
      skipped.push({
        nodeId: entry.nodeId,
        status: "overridden",
        reason: `${entry.label} was edited on this quote, so it was not updated. Review it in the quote editor, or apply with replaceEdits to replace the edit.`,
      });
      continue;
    }
    if (!next.nodes[entry.nodeId]) {
      skipped.push({ nodeId: entry.nodeId, status: "removed", reason: "The row was removed with its kit." });
      continue;
    }
    if (applyEntry(state, next, entry)) applied.push(entry.nodeId);
    else skipped.push({ nodeId: entry.nodeId, status: entry.status, reason: "The row could not be updated." });
  }
  if (selected) {
    const listed = new Set(diff.lines.map((line) => line.nodeId));
    for (const nodeId of selected) {
      if (!listed.has(nodeId)) skipped.push({ nodeId, status: "unchanged", reason: "No catalogue change for this row." });
    }
  }
  return {
    organizer: next,
    applied,
    skipped,
    catalogVersion: state.version,
    etag: state.etag,
  };
}

/**
 * Lazy upgrade of rows linked by code only (before uids): record the item's
 * uid, so a later code edit cannot break the link, and mark the price source
 * unknown, so the draft diff lists the row against the current price. Returns
 * the same organizer object when nothing needed upgrading.
 */
export function upgradeOrganizerCatalogLinks({ state, organizer }) {
  if (!organizer?.nodes) return { organizer, upgraded: 0 };
  let next = null;
  let upgraded = 0;
  for (const [nodeId, node] of Object.entries(organizer.nodes)) {
    if (!isCatalogLinkedNode(node) || text(node.catalogItemUid)) continue;
    const item = findItem(state, text(node.catalogItemCode));
    if (!item) continue;
    next = next || cloneOrganizer(organizer);
    next.nodes[nodeId].catalogItemUid = item.uid;
    if (!text(node.catalogPriceKey) && finiteOrNull(node.catalogPriceId) == null) {
      next.nodes[nodeId].catalogPriceSource = "unknown";
    }
    upgraded += 1;
  }
  return { organizer: next || organizer, upgraded };
}
