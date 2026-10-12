import { materializePresentationOrganizerGeneratedNodes } from "../shared/quote-presentation-renderer.js";
import { normalizeCatalogUnit } from "../shared/catalog-units.js";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function dedupeIds(values = []) {
  const seen = new Set();
  const result = [];
  for (const rawValue of values) {
    const value = normalizeText(rawValue);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeBoolean(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

// A catalogue-linked manual row keeps its link to the catalogue item and the
// values it froze when the row was added or last refreshed:
// identity is the item uid, `catalogPriceId`/`catalogPriceKey` name the price
// it was priced from, and the `catalog*` values are what the catalogue said
// then. Editing a row's rate or unit marks it overridden (rateMode "manual")
// but never drops this link, so the draft catalogue diff
// (server/quote-catalog-sync.js) still sees it.
export const CATALOG_LINK_FIELDS = Object.freeze([
  "catalogItemCode",
  "catalogItemUid",
  "catalogPriceId",
  "catalogPriceKey",
  "catalogAssemblyVersion",
  "catalogSellRate",
  "catalogBuyRate",
  "catalogName",
  "catalogUnit",
  "catalogQuantity",
  "catalogComponentOf",
  "catalogKitComponents",
  "catalogPriceSource",
]);

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// A kit row's frozen components (uid, code, per-kit quantity, unit), as
// server/quote-catalog-sync.js frozenKitComponents records them. Entries
// without a uid are dropped; a list that is not an array is not copied.
const MAX_FROZEN_KIT_COMPONENTS = 500;

function frozenKitComponentsOrNull(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const entry of value.slice(0, MAX_FROZEN_KIT_COMPONENTS)) {
    const itemUid = normalizeText(entry?.itemUid);
    if (!itemUid) continue;
    const component = { itemUid, code: normalizeText(entry.code) || null };
    const quantity = finiteNumberOrNull(entry.quantity);
    if (quantity !== null) component.quantity = quantity;
    const unit = normalizeCatalogUnit(entry.unit);
    if (unit) component.unit = unit;
    out.push(component);
  }
  return out;
}

export function copyCatalogLinkFields(source, target) {
  if (!source || typeof source !== "object") return target;
  const catalogItemCode = normalizeText(source.catalogItemCode);
  if (catalogItemCode) target.catalogItemCode = catalogItemCode;
  const catalogItemUid = normalizeText(source.catalogItemUid);
  if (catalogItemUid) target.catalogItemUid = catalogItemUid;
  if (source.catalogPriceId === null) target.catalogPriceId = null;
  else {
    const priceId = finiteNumberOrNull(source.catalogPriceId);
    if (priceId !== null) target.catalogPriceId = priceId;
  }
  const catalogPriceKey = normalizeText(source.catalogPriceKey);
  if (catalogPriceKey) target.catalogPriceKey = catalogPriceKey;
  const assemblyVersion = finiteNumberOrNull(source.catalogAssemblyVersion);
  if (assemblyVersion !== null) target.catalogAssemblyVersion = assemblyVersion;
  for (const key of ["catalogSellRate", "catalogBuyRate", "catalogQuantity"]) {
    const value = finiteNumberOrNull(source[key]);
    if (value !== null) target[key] = value;
  }
  const catalogName = normalizeText(source.catalogName);
  if (catalogName) target.catalogName = catalogName;
  const catalogUnit = normalizeCatalogUnit(source.catalogUnit);
  if (catalogUnit) target.catalogUnit = catalogUnit;
  const catalogComponentOf = normalizeText(source.catalogComponentOf);
  if (catalogComponentOf) target.catalogComponentOf = catalogComponentOf;
  const kitComponents = frozenKitComponentsOrNull(source.catalogKitComponents);
  if (kitComponents) target.catalogKitComponents = kitComponents;
  if (source.catalogPriceSource === "unknown") target.catalogPriceSource = "unknown";
  return target;
}

export function buildPresentationSourceNodeId(sourceCode) {
  const code = normalizeText(sourceCode);
  return code ? `source:${code}` : null;
}

// Map the legacy `sourceKind` values to the canonical (origin, pricingMode)
// pair. This is the one place where new code and old persisted data agree:
// every downstream consumer should read origin/pricingMode, and persistence
// continues to write sourceKind for backward compatibility.
//
//   customer_schedule_item  → origin=engine,    pricingMode=engine
//   manual                  → origin=manual,    pricingMode=manual
//   generated_component     → origin=generated, pricingMode=allocated
export function sourceKindToOriginPricing(sourceKind) {
  const normalized = normalizeText(sourceKind) || "customer_schedule_item";
  if (normalized === "manual") {
    return { origin: "manual", pricingMode: "manual", sourceKind: "manual" };
  }
  if (normalized === "generated_component") {
    return { origin: "generated", pricingMode: "allocated", sourceKind: "generated_component" };
  }
  return { origin: "engine", pricingMode: "engine", sourceKind: "customer_schedule_item" };
}

export function isManualSourceKind(sourceKind) {
  return sourceKindToOriginPricing(sourceKind).origin === "manual";
}

export function isGeneratedComponentSourceKind(sourceKind) {
  return sourceKindToOriginPricing(sourceKind).origin === "generated";
}

function normalizePresentationGroupNode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const node = {
    kind: "group",
    label: normalizeText(value.label) || "Group",
    collapsed: normalizeBoolean(value.collapsed, false),
    amountVisible: normalizeBoolean(value.amountVisible, true),
    children: dedupeIds(value.children),
  };
  if (normalizeBoolean(value.excludedFromPrice, false)) node.excludedFromPrice = true;
  if (normalizeBoolean(value.amountBlank, false)) node.amountBlank = true;
  if (["branded", "bold", "normal"].includes(value.rowStyle)) node.rowStyle = value.rowStyle;
  if (Array.isArray(value.priceSourceNodeIds)) {
    node.priceSourceNodeIds = dedupeIds(value.priceSourceNodeIds);
  }
  if (value.pricingContribution === "listed_only") {
    node.pricingContribution = "listed_only";
  }
  if (typeof value.priceOverride === "number" && Number.isFinite(value.priceOverride)) {
    node.priceOverride = value.priceOverride;
  }
  if (typeof value.costOverride === "number" && Number.isFinite(value.costOverride)) {
    node.costOverride = value.costOverride;
  }
  return node;
}

function normalizePresentationSourceNode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceCode = normalizeText(value.sourceCode || value.code);
  if (!sourceCode) return null;
  const children = dedupeIds(value.children);
  // Accept either legacy sourceKind or the new origin field. If both are
  // present, origin wins — callers that have migrated emit origin directly.
  const rawOrigin = normalizeText(value.origin);
  const rawSourceKind = rawOrigin
    ? (rawOrigin === "engine" ? "customer_schedule_item"
      : rawOrigin === "manual" ? "manual"
      : rawOrigin === "generated" ? "generated_component"
      : normalizeText(value.sourceKind) || "customer_schedule_item")
    : normalizeText(value.sourceKind) || "customer_schedule_item";
  const { origin, pricingMode, sourceKind } = sourceKindToOriginPricing(rawSourceKind);
  const isManual = origin === "manual";
  const isGeneratedComponent = origin === "generated";
  const node = {
    kind: "source",
    sourceKind,
    origin,
    pricingMode,
    sourceCode,
    labelOverride: normalizeText(value.labelOverride || value.label) || null,
    amountVisible: normalizeBoolean(value.amountVisible, true),
  };
  if (isGeneratedComponent) {
    const componentSourceCode = normalizeText(value.componentSourceCode);
    const componentCode = normalizeText(value.componentCode || sourceCode);
    if (componentSourceCode) node.componentSourceCode = componentSourceCode;
    if (componentCode) node.componentCode = componentCode;
    const componentParentCode = normalizeText(value.componentParentCode);
    if (componentParentCode) node.componentParentCode = componentParentCode;
  }
  if (isManual && typeof value.manualPrice === "number" && Number.isFinite(value.manualPrice)) {
    node.manualPrice = value.manualPrice;
  }
  if (isManual && typeof value.manualCost === "number" && Number.isFinite(value.manualCost)) {
    node.manualCost = value.manualCost;
  }
  if (isManual && typeof value.quantity === "number" && Number.isFinite(value.quantity)) {
    node.quantity = value.quantity;
  }
  if (isManual) {
    const unit = normalizeCatalogUnit(value.unit);
    if (unit) node.unit = unit;
  }
  if (isManual && typeof value.sellRate === "number" && Number.isFinite(value.sellRate)) {
    node.sellRate = value.sellRate;
  }
  if (isManual && typeof value.buyRate === "number" && Number.isFinite(value.buyRate)) {
    node.buyRate = value.buyRate;
  }
  if (isManual && (value.rateMode === "manual" || value.rateMode === "catalog-linked")) {
    node.rateMode = value.rateMode;
  }
  if (isManual && (value.applicationMode === "proportional" || value.applicationMode === "fixed")) {
    node.applicationMode = value.applicationMode;
  }
  if (isManual) copyCatalogLinkFields(value, node);
  if (value.pricingContribution === "listed_only") {
    node.pricingContribution = "listed_only";
  }
  if (typeof value.priceOverride === "number" && Number.isFinite(value.priceOverride)) {
    node.priceOverride = value.priceOverride;
  }
  if (typeof value.costOverride === "number" && Number.isFinite(value.costOverride)) {
    node.costOverride = value.costOverride;
  }
  if (normalizeBoolean(value.excludedFromPrice, false)) node.excludedFromPrice = true;
  if (normalizeBoolean(value.amountBlank, false)) node.amountBlank = true;
  if (normalizeBoolean(value.isGhostBase, false)) node.isGhostBase = true;
  if (["branded", "bold", "normal"].includes(value.rowStyle)) node.rowStyle = value.rowStyle;
  if (normalizeBoolean(value.collapsed, false)) node.collapsed = true;
  if (typeof value.notes === "string" && value.notes.trim()) node.notes = value.notes.trim();
  if (children.length) node.children = children;
  if (value.componentOverrides && typeof value.componentOverrides === "object" && !Array.isArray(value.componentOverrides)) {
    const overrides = {};
    for (const [code, ov] of Object.entries(value.componentOverrides)) {
      if (!ov || typeof ov !== "object") continue;
      const entry = {};
      if (typeof ov.labelOverride === "string" && ov.labelOverride.trim()) entry.labelOverride = ov.labelOverride.trim();
      if (typeof ov.amountVisible === "boolean") entry.amountVisible = ov.amountVisible;
      if (typeof ov.amountBlank === "boolean") entry.amountBlank = ov.amountBlank;
      if (["branded", "bold", "normal"].includes(ov.rowStyle)) entry.rowStyle = ov.rowStyle;
      if (typeof ov.collapsed === "boolean") entry.collapsed = ov.collapsed;
      if (Object.keys(entry).length) overrides[code] = entry;
    }
    if (Object.keys(overrides).length) node.componentOverrides = overrides;
  }
  if (value.componentChildren && typeof value.componentChildren === "object" && !Array.isArray(value.componentChildren)) {
    const tree = {};
    for (const [parentCode, childCodes] of Object.entries(value.componentChildren)) {
      const codes = dedupeIds(childCodes);
      if (codes.length) tree[parentCode] = codes;
    }
    if (Object.keys(tree).length) node.componentChildren = tree;
  }
  const removedComponentCodes = dedupeIds(value.removedComponentCodes);
  if (removedComponentCodes.length) node.removedComponentCodes = removedComponentCodes;
  return node;
}

export function normalizePresentationOrganizer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const nodes = {};
  const rawNodes = value.nodes && typeof value.nodes === "object" && !Array.isArray(value.nodes)
    ? value.nodes
    : {};

  for (const [rawId, rawNode] of Object.entries(rawNodes)) {
    const nodeId = normalizeText(rawId);
    if (!nodeId) continue;
    if (rawNode?.kind === "group") {
      const normalized = normalizePresentationGroupNode(rawNode);
      if (normalized) nodes[nodeId] = normalized;
      continue;
    }
    if (rawNode?.kind === "source") {
      const normalized = normalizePresentationSourceNode(rawNode);
      if (normalized) nodes[nodeId] = normalized;
    }
  }

  const root = dedupeIds(value.root);
  const removedSourceCodes = dedupeIds(value.removedSourceCodes);
  return root.length || Object.keys(nodes).length || removedSourceCodes.length
    ? {
        root,
        nodes,
        ...(removedSourceCodes.length ? { removedSourceCodes } : {}),
      }
    : null;
}

// Build a resolved source node from either an engine sourceItem or a
// persisted organizer node. This is the single code path for every source
// kind — the only differences are which fields get copied through, and they
// are driven by origin, not by structural forking.
function buildResolvedSourceNode({ origin, pricingMode, sourceCode, override, defaultAmountVisible = true }) {
  const resolved = {
    kind: "source",
    sourceKind: origin === "manual"
      ? "manual"
      : origin === "generated"
        ? "generated_component"
        : "customer_schedule_item",
    origin,
    pricingMode,
    sourceCode,
    labelOverride: normalizeText(override?.labelOverride) || null,
    amountVisible: normalizeBoolean(override?.amountVisible, defaultAmountVisible),
    children: [],
  };
  if (origin === "manual") {
    resolved.manualPrice = typeof override?.manualPrice === "number" ? override.manualPrice : 0;
    resolved.manualCost = typeof override?.manualCost === "number" ? override.manualCost : 0;
    if (typeof override?.quantity === "number" && Number.isFinite(override.quantity)) {
      resolved.quantity = override.quantity;
    }
    const unit = normalizeCatalogUnit(override?.unit);
    if (unit) resolved.unit = unit;
    if (typeof override?.sellRate === "number" && Number.isFinite(override.sellRate)) {
      resolved.sellRate = override.sellRate;
    }
    if (typeof override?.buyRate === "number" && Number.isFinite(override.buyRate)) {
      resolved.buyRate = override.buyRate;
    }
    if (override?.rateMode === "manual" || override?.rateMode === "catalog-linked") {
      resolved.rateMode = override.rateMode;
    }
    if (override?.applicationMode === "fixed") {
      resolved.applicationMode = "fixed";
    } else if (override?.applicationMode === "proportional") {
      resolved.applicationMode = "proportional";
    }
    copyCatalogLinkFields(override, resolved);
  }
  if (origin === "generated") {
    const componentSourceCode = normalizeText(override?.componentSourceCode);
    const componentCode = normalizeText(override?.componentCode);
    const componentParentCode = normalizeText(override?.componentParentCode);
    if (componentSourceCode) resolved.componentSourceCode = componentSourceCode;
    if (componentCode) resolved.componentCode = componentCode;
    if (componentParentCode) resolved.componentParentCode = componentParentCode;
  }
  if (typeof override?.priceOverride === "number") resolved.priceOverride = override.priceOverride;
  if (typeof override?.costOverride === "number") resolved.costOverride = override.costOverride;
  if (normalizeBoolean(override?.excludedFromPrice, false)) resolved.excludedFromPrice = true;
  if (normalizeBoolean(override?.amountBlank, false)) resolved.amountBlank = true;
  if (override?.pricingContribution === "listed_only") resolved.pricingContribution = "listed_only";
  if (normalizeBoolean(override?.isGhostBase, false)) resolved.isGhostBase = true;
  if (["branded", "bold", "normal"].includes(override?.rowStyle)) resolved.rowStyle = override.rowStyle;
  if (normalizeBoolean(override?.collapsed, false)) resolved.collapsed = true;
  if (typeof override?.notes === "string" && override.notes.trim()) resolved.notes = override.notes.trim();
  if (override?.componentOverrides) resolved.componentOverrides = override.componentOverrides;
  if (override?.componentChildren) resolved.componentChildren = override.componentChildren;
  if (Array.isArray(override?.removedComponentCodes)) {
    const removedComponentCodes = dedupeIds(override.removedComponentCodes);
    if (removedComponentCodes.length) resolved.removedComponentCodes = removedComponentCodes;
  }
  return resolved;
}

// Match a persisted source node to an already-resolved node by origin+code
// (and, for generated components, the owning componentSourceCode). Used to
// propagate child references from the persisted tree onto resolved nodes.
function findResolvedSourceNodeId(nodes, persistedNode) {
  const origin = persistedNode?.origin || sourceKindToOriginPricing(persistedNode?.sourceKind).origin;
  if (origin === "engine") {
    return buildPresentationSourceNodeId(persistedNode.sourceCode);
  }
  for (const [candidateId, candidate] of Object.entries(nodes)) {
    if (candidate?.kind !== "source") continue;
    if ((candidate.origin || sourceKindToOriginPricing(candidate.sourceKind).origin) !== origin) continue;
    if (candidate.sourceCode !== persistedNode.sourceCode) continue;
    if (origin === "generated"
      && normalizeText(candidate.componentSourceCode) !== normalizeText(persistedNode.componentSourceCode)) {
      continue;
    }
    return candidateId;
  }
  return null;
}

export function resolvePresentationOrganizer({
  sourceItems = [],
  organizer = null,
}) {
  const normalized = normalizePresentationOrganizer(organizer) || { root: [], nodes: {} };
  const removedSourceCodes = new Set(dedupeIds(normalized.removedSourceCodes));

  const sourceOverridesByCode = new Map();
  const groupNodesInOrder = [];

  for (const [nodeId, node] of Object.entries(normalized.nodes)) {
    if (node.kind === "group") {
      groupNodesInOrder.push([nodeId, node]);
      continue;
    }
    if (
      node.kind === "source"
      && node.origin === "engine"
      && node.sourceCode
      && !removedSourceCodes.has(node.sourceCode)
      && !sourceOverridesByCode.has(node.sourceCode)
    ) {
      sourceOverridesByCode.set(node.sourceCode, node);
    }
  }

  const nodes = {};
  const childRequests = new Map();

  for (const [nodeId, node] of groupNodesInOrder) {
    const resolved = {
      kind: "group",
      label: normalizeText(node.label) || "Group",
      collapsed: normalizeBoolean(node.collapsed, false),
      amountVisible: normalizeBoolean(node.amountVisible, true),
      children: [],
    };
    if (normalizeBoolean(node.amountBlank, false)) resolved.amountBlank = true;
    if (normalizeBoolean(node.excludedFromPrice, false)) resolved.excludedFromPrice = true;
    if (["branded", "bold", "normal"].includes(node.rowStyle)) resolved.rowStyle = node.rowStyle;
    if (Array.isArray(node.priceSourceNodeIds)) {
      resolved.priceSourceNodeIds = dedupeIds(node.priceSourceNodeIds);
    }
    if (node.pricingContribution === "listed_only") resolved.pricingContribution = "listed_only";
    if (typeof node.priceOverride === "number") resolved.priceOverride = node.priceOverride;
    if (typeof node.costOverride === "number") resolved.costOverride = node.costOverride;
    nodes[nodeId] = resolved;
    childRequests.set(nodeId, dedupeIds(node.children));
  }

  const sourceNodeIdsInOrder = [];
  for (const item of sourceItems) {
    const sourceCode = normalizeText(item?.code);
    if (!sourceCode) continue;
    if (removedSourceCodes.has(sourceCode)) continue;
    const nodeId = buildPresentationSourceNodeId(sourceCode);
    if (!nodeId) continue;
    const override = sourceOverridesByCode.get(sourceCode);
    // Manual overrides for engine codes are impossible (origin=engine is
    // required to be in sourceOverridesByCode) but double-check for safety.
    if (override && override.origin && override.origin !== "engine") continue;
    const defaultAmountVisible = normalizeBoolean(item?.amountVisible, true);
    nodes[nodeId] = buildResolvedSourceNode({
      origin: "engine",
      pricingMode: "engine",
      sourceCode,
      override,
      defaultAmountVisible,
    });
    sourceNodeIdsInOrder.push(nodeId);
  }

  // Resolve non-engine source items that still participate in the organizer
  // tree. Manual and generated-component nodes live in the persisted
  // organizer and do not come from sourceItems, so they need their own pass.
  const extraSourceNodeIdsInOrder = [];
  for (const [nodeId, node] of Object.entries(normalized.nodes)) {
    if (node.kind !== "source" || nodes[nodeId]) continue;
    if (node.origin === "engine") continue; // handled above via sourceItems
    nodes[nodeId] = buildResolvedSourceNode({
      origin: node.origin,
      pricingMode: node.pricingMode,
      sourceCode: node.sourceCode,
      override: node,
    });
    extraSourceNodeIdsInOrder.push(nodeId);
    childRequests.set(nodeId, dedupeIds(node.children));
  }

  // Propagate persisted source-node child lists onto their resolved
  // counterparts. Match by (origin, sourceCode, componentSourceCode).
  for (const [, node] of Object.entries(normalized.nodes)) {
    if (node.kind === "source" && node.children?.length) {
      const resolvedId = findResolvedSourceNodeId(nodes, node);
      if (resolvedId && nodes[resolvedId]) {
        childRequests.set(resolvedId, dedupeIds(node.children));
      }
    }
  }

  const validNodeIds = new Set(Object.keys(nodes));
  const placed = new Set();
  const resolvedRoot = [];

  function attachNode(nodeId, parentId = null, ancestors = new Set()) {
    if (!validNodeIds.has(nodeId) || placed.has(nodeId)) return;
    if (ancestors.has(nodeId)) return;

    placed.add(nodeId);
    if (parentId) {
      nodes[parentId].children.push(nodeId);
    } else {
      resolvedRoot.push(nodeId);
    }

    const requestedChildren = childRequests.get(nodeId) || [];
    if (!requestedChildren.length) return;

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeId);
    for (const childId of requestedChildren) {
      if (childId === nodeId) continue;
      attachNode(childId, nodeId, nextAncestors);
    }
  }

  for (const rootId of dedupeIds(normalized.root)) {
    attachNode(rootId, null, new Set());
  }
  for (const [groupId] of groupNodesInOrder) {
    attachNode(groupId, null, new Set());
  }
  for (const sourceNodeId of sourceNodeIdsInOrder) {
    attachNode(sourceNodeId, null, new Set());
  }
  for (const extraSourceNodeId of extraSourceNodeIdsInOrder) {
    attachNode(extraSourceNodeId, null, new Set());
  }

  return materializePresentationOrganizerGeneratedNodes({
    organizer: {
      root: resolvedRoot,
      nodes,
      ...(removedSourceCodes.size ? { removedSourceCodes: [...removedSourceCodes] } : {}),
    },
    sourceItems,
  });
}
