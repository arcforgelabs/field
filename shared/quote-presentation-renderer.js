import { normalizeCatalogUnit } from "./catalog-units.js";

function dedupe(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function sum(values) {
  return (values || []).reduce((total, value) => total + Number(value || 0), 0);
}

function resolveSingleValue(values) {
  const normalized = dedupe(values);
  return normalized.length === 1 ? normalized[0] : null;
}

// Canonical origin derivation. Accepts either the new `origin` field or the
// legacy `sourceKind`. Downstream code should prefer presentationNodeOrigin()
// over direct sourceKind checks so the legacy field can eventually be dropped.
function presentationNodeOrigin(node) {
  if (!node) return null;
  if (node.origin === "engine" || node.origin === "manual" || node.origin === "generated") {
    return node.origin;
  }
  const kind = String(node.sourceKind || "").trim();
  if (kind === "manual") return "manual";
  if (kind === "generated_component") return "generated";
  return "engine";
}

function isGeneratedComponentSourceNode(node) {
  return node?.kind === "source" && presentationNodeOrigin(node) === "generated";
}

function isManualSourceNode(node) {
  return node?.kind === "source" && presentationNodeOrigin(node) === "manual";
}

function isFixedApplicationSourceNode(node) {
  return node?.kind === "source" && node.applicationMode === "fixed";
}

function isListedOnlyNode(node) {
  return node?.pricingContribution === "listed_only";
}

function getGeneratedOwnerSourceCode(node) {
  return String(node?.componentSourceCode || "").trim();
}

function getGeneratedComponentCode(node) {
  return String(node?.componentCode || node?.sourceCode || "").trim();
}

function clonePresentationOrganizerNode(node) {
  if (!node || typeof node !== "object") return node;
  const cloned = { ...node };
  if (Array.isArray(node.children)) cloned.children = [...node.children];
  if (node.kind === "source" && Array.isArray(node.componentOrder)) {
    cloned.componentOrder = [...node.componentOrder];
  }
  if (node.kind === "source" && Array.isArray(node.removedComponentCodes)) {
    cloned.removedComponentCodes = [...node.removedComponentCodes];
  }
  if (node.kind === "source" && node.componentOverrides && typeof node.componentOverrides === "object") {
    cloned.componentOverrides = Object.fromEntries(
      Object.entries(node.componentOverrides).map(([code, override]) => [code, { ...override }])
    );
  }
  if (node.kind === "source" && node.componentChildren && typeof node.componentChildren === "object") {
    cloned.componentChildren = Object.fromEntries(
      Object.entries(node.componentChildren).map(([code, childCodes]) => [code, [...(childCodes || [])]])
    );
  }
  return cloned;
}

/**
 * Collect all descendant node IDs under `rootNodeId` (inclusive), walking
 * through every kind of node — groups and sources alike. Used by the reset
 * cascade to clear overrides from an entire subtree when the operator resets
 * an item-level row. Returns a de-duplicated array in walk order.
 */
export function collectOrganizerSubtreeNodeIds(organizer, rootNodeId) {
  if (!organizer?.nodes || !rootNodeId || !organizer.nodes[rootNodeId]) return [];
  const visited = new Set();
  const out = [];
  const walk = (nodeId) => {
    if (!nodeId || visited.has(nodeId)) return;
    const node = organizer.nodes[nodeId];
    if (!node) return;
    visited.add(nodeId);
    out.push(nodeId);
    for (const childId of node.children || []) {
      walk(childId);
    }
  };
  walk(rootNodeId);
  return out;
}

/**
 * Return true if `rootNodeId` or any descendant (groups + sources) carries a
 * priceOverride or costOverride. Used by the reset-to-engine cascade to decide
 * whether the Reset button is enabled on an item-level row.
 */
export function organizerSubtreeHasOverride(organizer, rootNodeId) {
  for (const id of collectOrganizerSubtreeNodeIds(organizer, rootNodeId)) {
    const node = organizer.nodes[id];
    if (node && (node.priceOverride != null || node.costOverride != null)) {
      return true;
    }
  }
  return false;
}

function buildOrganizerParentIndex(organizer) {
  const parentIndex = new Map();
  const visit = (nodeId, parentId) => {
    if (!nodeId || parentIndex.has(nodeId)) return;
    parentIndex.set(nodeId, parentId);
    const node = organizer?.nodes?.[nodeId];
    if (!node?.children?.length) return;
    for (const childId of node.children) {
      visit(childId, nodeId);
    }
  };
  for (const nodeId of organizer?.root || []) {
    visit(nodeId, null);
  }
  return parentIndex;
}

function splitGeneratedChildren({
  children,
  nodes,
  ownerSourceCode,
  componentParentCode,
}) {
  const generatedChildIds = [];
  const additiveChildIds = [];
  const expectedParentCode = String(componentParentCode || "");
  for (const childId of children || []) {
    const child = nodes?.[childId];
    if (
      isGeneratedComponentSourceNode(child)
      && getGeneratedOwnerSourceCode(child) === ownerSourceCode
      && String(child.componentParentCode || "") === expectedParentCode
    ) {
      generatedChildIds.push(childId);
      continue;
    }
    additiveChildIds.push(childId);
  }
  return { generatedChildIds, additiveChildIds };
}

function resolveGeneratedComponentParentCode({
  ownerSourceCode,
  parentId,
  nodes,
}) {
  if (!parentId) return null;
  const parent = nodes?.[parentId];
  if (!parent || parent.kind !== "source") return null;
  const parentOrigin = presentationNodeOrigin(parent);
  if (parentOrigin === "generated" && getGeneratedOwnerSourceCode(parent) === ownerSourceCode) {
    return getGeneratedComponentCode(parent) || null;
  }
  if (parentOrigin !== "generated" && String(parent.sourceCode || "") === ownerSourceCode) {
    return null;
  }
  return null;
}

export function isTrivialSelfPresentationComponent({
  sourceItem,
  component,
}) {
  if (!sourceItem || !component) return false;
  return String(component.code || "") === String(sourceItem.code || "")
    && normalizeText(component.label) === normalizeText(sourceItem.label)
    && roundMoney(component.totalPrice) === roundMoney(sourceItem.totalPrice);
}

export function getMeaningfulPresentationSourceComponents(sourceItem) {
  const components = sourceItem?.components || [];
  return components.filter((component) => (
    component?.customerFacing
    && !isTrivialSelfPresentationComponent({
      sourceItem,
      component,
    })
  ));
}

export function getPresentationRootComponentCodes(node, components) {
  const removedCodes = new Set((node?.removedComponentCodes || []).map((code) => String(code || "")));
  const allChildCodes = new Set(Object.values(node?.componentChildren || {}).flat());
  const order = node?.componentOrder?.length
    ? [...node.componentOrder]
    : (components || []).map((component) => component.code);
  return order.filter((code) => !allChildCodes.has(code) && !removedCodes.has(String(code || "")));
}

export function findPresentationComponentParent(node, componentCode) {
  for (const [parentCode, childCodes] of Object.entries(node?.componentChildren || {})) {
    if (childCodes.includes(componentCode)) return parentCode;
  }
  return null;
}

export function isPresentationComponentDescendant(node, ancestorCode, candidateCode) {
  const children = node?.componentChildren?.[ancestorCode];
  if (!children) return false;
  if (children.includes(candidateCode)) return true;
  return children.some((childCode) => (
    isPresentationComponentDescendant(node, childCode, candidateCode)
  ));
}

export function getOrderedPresentationComponents({
  node,
  sourceItem,
}) {
  const components = getMeaningfulPresentationSourceComponents(sourceItem);
  if (!components.length || !node?.componentOrder?.length) return components;

  const ordered = node.componentOrder
    .map((code) => components.find((component) => component.code === code))
    .filter(Boolean);
  const orderedCodes = new Set(ordered.map((component) => component.code));
  const extra = components.filter((component) => !orderedCodes.has(component.code));
  return [...ordered, ...extra];
}

export function buildGeneratedPresentationSourceNodeId(sourceCode, componentCode) {
  const source = String(sourceCode || "").trim();
  const component = String(componentCode || "").trim();
  return source && component ? `generated:${source}:${component}` : null;
}

function buildManualPresentationSourceItem(node) {
  if (!isManualSourceNode(node)) return null;
  const hasRate = node.sellRate != null || node.buyRate != null
    || node.quantity != null || (node.unit && node.unit !== "lot");
  const quantity = Math.max(0, Number(node.quantity ?? 1));
  const unit = normalizeCatalogUnit(node.unit, "lot");
  let unitPrice;
  let totalPrice;
  let unitCost;
  let totalCost;
  if (hasRate) {
    const sellRate = Number(node.sellRate || 0);
    const buyRate = Number(node.buyRate || 0);
    unitPrice = roundMoney(sellRate);
    totalPrice = roundMoney(quantity * sellRate);
    unitCost = roundMoney(buyRate);
    totalCost = roundMoney(quantity * buyRate);
  } else {
    const manualPrice = roundMoney(Number(node.manualPrice || 0));
    const manualCost = roundMoney(Number(node.manualCost || 0));
    unitPrice = manualPrice;
    totalPrice = manualPrice;
    unitCost = manualCost;
    totalCost = manualCost;
  }
  return {
    code: node.sourceCode,
    label: node.labelOverride || "Manual item",
    quantity,
    unit,
    unitPrice,
    totalPrice,
    unitCost,
    totalCost,
    sourceLineItemCodes: [node.sourceCode],
    componentLineItemCodes: [],
    allocatedLineItemCodes: [],
    amountVisible: node.amountVisible !== false,
  };
}

function buildGeneratedPresentationSourceItem({
  node,
  sourceItemIndex,
}) {
  if (!isGeneratedComponentSourceNode(node)) return null;
  const ownerSourceCode = getGeneratedOwnerSourceCode(node);
  const componentCode = getGeneratedComponentCode(node);
  if (!ownerSourceCode || !componentCode) return null;
  const ownerSourceItem = sourceItemIndex.get(ownerSourceCode);
  if (!ownerSourceItem) return null;
  const component = getMeaningfulPresentationSourceComponents(ownerSourceItem)
    .find((candidate) => String(candidate?.code || "") === componentCode);
  if (!component) return null;
  return {
    code: component.code,
    label: component.label,
    quantity: Number(component.quantity || 0),
    unit: normalizeCatalogUnit(component.unit, "lot"),
    unitPrice: Number(component.unitPrice || 0),
    totalPrice: Number(component.totalPrice || 0),
    unitCost: component.unitCost ?? null,
    totalCost: component.totalCost ?? null,
    amountVisible: node.amountVisible !== false,
    section: ownerSourceItem.section || null,
    workDomain: component.workDomain || ownerSourceItem.workDomain || null,
    scopeSummary: component.scopeSummary || component.label,
    sourceLineItemCodes: ownerSourceItem.sourceLineItemCodes || [ownerSourceItem.code],
    componentLineItemCodes: ownerSourceItem.componentLineItemCodes || [],
    allocatedLineItemCodes: ownerSourceItem.allocatedLineItemCodes || [],
  };
}

export function materializePresentationOrganizerGeneratedNodes({
  organizer,
  sourceItems,
}) {
  if (!organizer?.nodes) return organizer || { root: [], nodes: {} };

  const removedSourceCodes = Array.isArray(organizer.removedSourceCodes)
    ? dedupe(organizer.removedSourceCodes.map((code) => String(code || "").trim()).filter(Boolean))
    : [];
  const next = {
    root: [...(organizer.root || [])],
    nodes: Object.fromEntries(
      Object.entries(organizer.nodes || {}).map(([nodeId, node]) => [nodeId, clonePresentationOrganizerNode(node)])
    ),
    ...(removedSourceCodes.length ? { removedSourceCodes } : {}),
  };
  const sourceItemIndex = new Map(
    (sourceItems || [])
      .filter((item) => item?.code)
      .map((item) => [String(item.code), item])
  );
  const originalParentIndex = buildOrganizerParentIndex(next);
  const expectedGeneratedNodeIds = new Set();

  function materializeGeneratedChildren({
    ownerNode,
    orderedComponents,
    componentIndex,
    componentParentCode,
    defaultParentId,
    currentParentChildren,
  }) {
    const ownerSourceCode = String(ownerNode.sourceCode || "");
    const removedComponentCodes = new Set((ownerNode.removedComponentCodes || []).map((code) => String(code || "")));
    const legacyChildCodes = componentParentCode
      ? (ownerNode.componentChildren?.[componentParentCode] || []).filter((code) => !removedComponentCodes.has(String(code || "")))
      : getPresentationRootComponentCodes(ownerNode, orderedComponents);
    const currentGeneratedCodes = splitGeneratedChildren({
      children: currentParentChildren,
      nodes: next.nodes,
      ownerSourceCode,
      componentParentCode,
    }).generatedChildIds
      .map((childId) => getGeneratedComponentCode(next.nodes[childId]))
      .filter((code) => code && !removedComponentCodes.has(String(code)));
    const desiredCodes = currentGeneratedCodes.length
      ? dedupe([...currentGeneratedCodes, ...legacyChildCodes])
      : dedupe(legacyChildCodes);
    const generatedChildIds = [];

    for (const componentCode of desiredCodes) {
      const component = componentIndex.get(componentCode);
      if (!component) continue;

      const nodeId = buildGeneratedPresentationSourceNodeId(ownerSourceCode, componentCode);
      if (!nodeId) continue;

      const existingNode = isGeneratedComponentSourceNode(next.nodes[nodeId]) ? next.nodes[nodeId] : null;
      const hasExistingPlacement = originalParentIndex.has(nodeId);
      const existingParentId = hasExistingPlacement
        ? originalParentIndex.get(nodeId)
        : defaultParentId;
      const resolvedParentCode = hasExistingPlacement
        ? resolveGeneratedComponentParentCode({
            ownerSourceCode,
            parentId: existingParentId,
            nodes: next.nodes,
          })
        : (componentParentCode || null);
      const existingChildren = Array.isArray(existingNode?.children) ? existingNode.children : [];
      const additiveChildIds = splitGeneratedChildren({
        children: existingChildren,
        nodes: next.nodes,
        ownerSourceCode,
        componentParentCode: resolvedParentCode,
      }).additiveChildIds;
      const nestedGeneratedIds = materializeGeneratedChildren({
        ownerNode,
        orderedComponents,
        componentIndex,
        componentParentCode: componentCode,
        defaultParentId: nodeId,
        currentParentChildren: existingChildren,
      });
      const legacyOverride = ownerNode.componentOverrides?.[componentCode];
      const nextNode = {
        kind: "source",
        sourceKind: "generated_component",
        origin: "generated",
        pricingMode: "allocated",
        sourceCode: component.code,
        componentSourceCode: ownerSourceCode,
        componentCode: component.code,
        componentParentCode: resolvedParentCode,
        labelOverride: existingNode?.labelOverride ?? legacyOverride?.labelOverride ?? null,
        amountVisible: typeof existingNode?.amountVisible === "boolean"
          ? existingNode.amountVisible
          : (typeof legacyOverride?.amountVisible === "boolean" ? legacyOverride.amountVisible : true),
        children: [...nestedGeneratedIds, ...additiveChildIds],
      };

      if ((existingNode?.amountBlank ?? legacyOverride?.amountBlank) === true) nextNode.amountBlank = true;
      if ((existingNode?.collapsed ?? legacyOverride?.collapsed) === true) nextNode.collapsed = true;
      if (existingNode?.excludedFromPrice === true) nextNode.excludedFromPrice = true;
      if (existingNode?.pricingContribution === "listed_only") nextNode.pricingContribution = "listed_only";
      if (typeof existingNode?.priceOverride === "number") nextNode.priceOverride = existingNode.priceOverride;
      if (typeof existingNode?.costOverride === "number") nextNode.costOverride = existingNode.costOverride;
      if (["branded", "bold", "normal"].includes(existingNode?.rowStyle || legacyOverride?.rowStyle)) {
        nextNode.rowStyle = existingNode?.rowStyle || legacyOverride?.rowStyle;
      }

      next.nodes[nodeId] = nextNode;
      expectedGeneratedNodeIds.add(nodeId);

      if (existingParentId === defaultParentId) {
        generatedChildIds.push(nodeId);
      }
    }

    return generatedChildIds;
  }

  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (node?.kind !== "source" || presentationNodeOrigin(node) !== "engine") {
      continue;
    }

    const sourceItem = sourceItemIndex.get(String(node.sourceCode || ""));
    const orderedComponents = getOrderedPresentationComponents({
      node,
      sourceItem,
    });
    const componentIndex = new Map(orderedComponents.map((component) => [String(component.code), component]));
    const currentChildren = Array.isArray(node.children) ? node.children : [];
    const additiveChildIds = splitGeneratedChildren({
      children: currentChildren,
      nodes: next.nodes,
      ownerSourceCode: String(node.sourceCode || ""),
      componentParentCode: null,
    }).additiveChildIds;
    const generatedChildIds = materializeGeneratedChildren({
      ownerNode: node,
      orderedComponents,
      componentIndex,
      componentParentCode: null,
      defaultParentId: nodeId,
      currentParentChildren: currentChildren,
    });

    node.children = [...generatedChildIds, ...additiveChildIds];
    delete node.componentOrder;
    delete node.componentOverrides;
    delete node.componentChildren;
  }

  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (isGeneratedComponentSourceNode(node) && !expectedGeneratedNodeIds.has(nodeId)) {
      delete next.nodes[nodeId];
    }
  }

  next.root = (next.root || []).filter((nodeId) => next.nodes[nodeId]);
  for (const node of Object.values(next.nodes)) {
    if (Array.isArray(node.children)) {
      node.children = node.children.filter((childId) => next.nodes[childId]);
    }
  }

  return next;
}

function createPresentationMetricsResolver({
  organizer,
  sourceItems,
}) {
  const sourceItemIndex = new Map(
    (sourceItems || [])
      .filter((item) => item?.code)
      .map((item) => [String(item.code), item])
  );
  const nodes = organizer?.nodes || {};
  const sourceNodeItemCache = new Map();
  const nodeMetricsCache = new Map();

  function getNodeChildren(node) {
    return Array.isArray(node?.children)
      ? node.children.filter((childId) => typeof childId === "string" && childId)
      : [];
  }

  function getSourceItemForNode(nodeId) {
    if (sourceNodeItemCache.has(nodeId)) {
      return sourceNodeItemCache.get(nodeId);
    }
    const node = nodes[nodeId];
    let sourceItem = null;
    if (node?.kind === "source") {
      const origin = presentationNodeOrigin(node);
      if (origin === "manual") {
        sourceItem = buildManualPresentationSourceItem(node);
      } else if (origin === "generated") {
        sourceItem = buildGeneratedPresentationSourceItem({
          node,
          sourceItemIndex,
        });
      } else {
        sourceItem = sourceItemIndex.get(String(node.sourceCode || "")) || null;
      }
    }
    sourceNodeItemCache.set(nodeId, sourceItem);
    return sourceItem;
  }

  function getBreakdownChildIds(_nodeId, node, childIds, sourceItem) {
    if (node.kind !== "source") return [];

    if (isGeneratedComponentSourceNode(node)) {
      const parentComponentCode = getGeneratedComponentCode(node);
      const ownerSourceCode = getGeneratedOwnerSourceCode(node);
      return childIds.filter((childId) => {
        const child = nodes[childId];
        return isGeneratedComponentSourceNode(child)
          && getGeneratedOwnerSourceCode(child) === ownerSourceCode
          && String(child.componentParentCode || "") === parentComponentCode;
      });
    }

    const hasGeneratedBreakdown = getMeaningfulPresentationSourceComponents(sourceItem).length > 0;
    if (!hasGeneratedBreakdown) return [];
    return childIds.filter((childId) => {
      const child = nodes[childId];
      return isGeneratedComponentSourceNode(child)
        && getGeneratedOwnerSourceCode(child) === String(node.sourceCode || "")
        && !String(child.componentParentCode || "").trim();
    });
  }

  function computeNodeMetrics(nodeId) {
    if (nodeMetricsCache.has(nodeId)) {
      return nodeMetricsCache.get(nodeId);
    }

    const zeroMetrics = {
      summaryPrice: 0,
      summaryCost: 0,
      displayPrice: 0,
      displayCost: 0,
      contributionPrice: 0,
      contributionCost: 0,
      displayUnitPrice: 0,
      displayUnitCost: 0,
    };
    const node = nodes[nodeId];
    if (!node) {
      nodeMetricsCache.set(nodeId, zeroMetrics);
      return zeroMetrics;
    }

    const childIds = getNodeChildren(node);
    const excluded = node.excludedFromPrice === true;
    const listedOnly = isListedOnlyNode(node);

    if (node.kind === "group") {
      const displaySourceIds = dedupe(
        (Array.isArray(node.priceSourceNodeIds) ? node.priceSourceNodeIds : childIds).filter((childId) => nodes[childId])
      );
      const rolledUpSummaryPrice = excluded
        ? 0
        : roundMoney(sum(childIds.map((childId) => computeNodeMetrics(childId).summaryPrice)));
      const rolledUpSummaryCost = excluded
        ? 0
        : roundMoney(sum(childIds.map((childId) => computeNodeMetrics(childId).summaryCost)));
      const rolledUpDisplayPrice = excluded
        ? 0
        : roundMoney(sum(displaySourceIds.map((childId) => computeNodeMetrics(childId).contributionPrice)));
      const rolledUpDisplayCost = excluded
        ? 0
        : roundMoney(sum(displaySourceIds.map((childId) => computeNodeMetrics(childId).contributionCost)));
      const displayPrice = excluded
        ? 0
        : (typeof node.priceOverride === "number" ? roundMoney(node.priceOverride) : rolledUpDisplayPrice);
      const displayCost = excluded
        ? 0
        : (typeof node.costOverride === "number" ? roundMoney(node.costOverride) : rolledUpDisplayCost);
      const metrics = {
        summaryPrice: excluded
          ? 0
          : (typeof node.priceOverride === "number" ? roundMoney(node.priceOverride) : rolledUpSummaryPrice),
        summaryCost: excluded
          ? 0
          : (typeof node.costOverride === "number" ? roundMoney(node.costOverride) : rolledUpSummaryCost),
        displayPrice,
        displayCost,
        contributionPrice: excluded || listedOnly ? 0 : displayPrice,
        contributionCost: excluded || listedOnly ? 0 : displayCost,
      };
      nodeMetricsCache.set(nodeId, metrics);
      return metrics;
    }

    const sourceItem = getSourceItemForNode(nodeId);
    if (!sourceItem) {
      nodeMetricsCache.set(nodeId, zeroMetrics);
      return zeroMetrics;
    }

    const breakdownChildIds = getBreakdownChildIds(nodeId, node, childIds, sourceItem);
    const breakdownChildIdSet = new Set(breakdownChildIds);
    const additiveChildIds = childIds.filter((childId) => !breakdownChildIdSet.has(childId));
    const sourceQuantity = Math.max(0, Number(sourceItem.quantity ?? 1));
    const selfUnitPrice = roundMoney(Number(
      sourceItem.unitPrice ?? (sourceQuantity > 0 ? Number(sourceItem.totalPrice || 0) / sourceQuantity : sourceItem.totalPrice) ?? 0
    ));
    const selfUnitCost = roundMoney(Number(
      sourceItem.unitCost ?? (sourceQuantity > 0 ? Number(sourceItem.totalCost || 0) / sourceQuantity : sourceItem.totalCost) ?? 0
    ));
    const selfPrice = roundMoney(Number(sourceItem.totalPrice ?? (sourceQuantity * selfUnitPrice) ?? 0));
    const selfCost = roundMoney(Number(sourceItem.totalCost ?? (sourceQuantity * selfUnitCost) ?? 0));
    // When a ghost-base child exists it already represents the parent's own
    // price, so zero out selfPrice/selfCost to avoid double-counting.
    const hasGhostBase = additiveChildIds.some((childId) => {
      const child = nodes[childId];
      return child?.kind === "source" && child.isGhostBase === true;
    });
    const effectiveSelfPrice = hasGhostBase ? 0 : selfPrice;
    const effectiveSelfCost = hasGhostBase ? 0 : selfCost;
    const effectiveSelfUnitPrice = hasGhostBase ? 0 : selfUnitPrice;
    const effectiveSelfUnitCost = hasGhostBase ? 0 : selfUnitCost;
    const hasGeneratedBreakdown = !isGeneratedComponentSourceNode(node)
      && getMeaningfulPresentationSourceComponents(sourceItem).length > 0;
    const replacedByBreakdown = hasGeneratedBreakdown || breakdownChildIds.length > 0;
    const breakdownPrice = roundMoney(sum(breakdownChildIds.map((childId) => computeNodeMetrics(childId).contributionPrice)));
    const breakdownCost = roundMoney(sum(breakdownChildIds.map((childId) => computeNodeMetrics(childId).contributionCost)));
    const scalableAdditiveChildIds = additiveChildIds.filter((childId) => !isFixedApplicationSourceNode(nodes[childId]));
    const fixedAdditiveChildIds = additiveChildIds.filter((childId) => isFixedApplicationSourceNode(nodes[childId]));
    const additiveDisplayPrice = roundMoney(sum(scalableAdditiveChildIds.map((childId) => computeNodeMetrics(childId).contributionPrice)));
    const additiveDisplayCost = roundMoney(sum(scalableAdditiveChildIds.map((childId) => computeNodeMetrics(childId).contributionCost)));
    const fixedDisplayPrice = sourceQuantity > 0
      ? roundMoney(sum(fixedAdditiveChildIds.map((childId) => computeNodeMetrics(childId).contributionPrice)))
      : 0;
    const fixedDisplayCost = sourceQuantity > 0
      ? roundMoney(sum(fixedAdditiveChildIds.map((childId) => computeNodeMetrics(childId).contributionCost)))
      : 0;
    const hasChildRollup = childIds.length > 0;
    const rollupUnitPrice = roundMoney(
      (replacedByBreakdown ? breakdownPrice : (hasChildRollup ? effectiveSelfUnitPrice : effectiveSelfPrice))
      + additiveDisplayPrice
    );
    const rollupUnitCost = roundMoney(
      (replacedByBreakdown ? breakdownCost : (hasChildRollup ? effectiveSelfUnitCost : effectiveSelfCost))
      + additiveDisplayCost
    );
    const rolledUpPrice = hasChildRollup ? roundMoney(sourceQuantity * rollupUnitPrice + fixedDisplayPrice) : rollupUnitPrice;
    const rolledUpCost = hasChildRollup ? roundMoney(sourceQuantity * rollupUnitCost + fixedDisplayCost) : rollupUnitCost;
    const overriddenPrice = typeof node.priceOverride === "number";
    const overriddenCost = typeof node.costOverride === "number";
    const metrics = {
      summaryPrice: excluded
        ? 0
        : (overriddenPrice
            ? roundMoney(node.priceOverride)
            : rolledUpPrice),
      summaryCost: excluded
        ? 0
        : (overriddenCost
            ? roundMoney(node.costOverride)
            : rolledUpCost),
      displayPrice: 0,
      displayCost: 0,
      contributionPrice: 0,
      contributionCost: 0,
      displayUnitPrice: 0,
      displayUnitCost: 0,
    };
    metrics.displayPrice = metrics.summaryPrice;
    metrics.displayCost = metrics.summaryCost;
    metrics.contributionPrice = excluded || listedOnly ? 0 : metrics.displayPrice;
    metrics.contributionCost = excluded || listedOnly ? 0 : metrics.displayCost;
    metrics.displayUnitPrice = hasChildRollup
      ? (sourceQuantity > 0 ? roundMoney(metrics.displayPrice / sourceQuantity) : metrics.displayPrice)
      : selfUnitPrice;
    metrics.displayUnitCost = hasChildRollup
      ? (sourceQuantity > 0 ? roundMoney(metrics.displayCost / sourceQuantity) : metrics.displayCost)
      : selfUnitCost;
    nodeMetricsCache.set(nodeId, metrics);
    return metrics;
  }

  return {
    nodes,
    getSourceItemForNode,
    computeNodeMetrics,
  };
}

export function calculatePresentationScheduleTotals({
  organizer,
  sourceItems,
}) {
  const fallbackTotals = {
    charge: roundMoney(sum((sourceItems || []).map((item) => item?.totalPrice || 0))),
    cost: roundMoney(sum((sourceItems || []).map((item) => item?.totalCost ?? item?.unitCost ?? 0))),
  };

  if (!organizer?.root?.length || !organizer?.nodes) {
    return fallbackTotals;
  }

  const materializedOrganizer = materializePresentationOrganizerGeneratedNodes({
    organizer,
    sourceItems,
  });
  const { computeNodeMetrics } = createPresentationMetricsResolver({
    organizer: materializedOrganizer,
    sourceItems,
  });
  const rootIds = dedupe(materializedOrganizer.root);
  return rootIds.reduce((totals, nodeId) => {
    const metrics = computeNodeMetrics(nodeId);
    totals.charge = roundMoney(totals.charge + metrics.contributionPrice);
    totals.cost = roundMoney(totals.cost + metrics.contributionCost);
    return totals;
  }, {
    charge: 0,
    cost: 0,
  });
}

export function buildRenderedPresentationScheduleItems({
  organizer,
  sourceItems,
  includeCollapsedChildren = false,
}) {
  const materializedOrganizer = materializePresentationOrganizerGeneratedNodes({
    organizer,
    sourceItems,
  });
  const {
    nodes,
    getSourceItemForNode,
    computeNodeMetrics,
  } = createPresentationMetricsResolver({
    organizer: materializedOrganizer,
    sourceItems,
  });
  const descendantSourceNodeIdCache = new Map();
  const rendered = [];

  function collectDescendantSourceNodeIds(nodeId) {
    if (descendantSourceNodeIdCache.has(nodeId)) {
      return descendantSourceNodeIdCache.get(nodeId);
    }

    const node = nodes[nodeId];
    if (!node) return [];
    if (node.kind === "source") {
      const nodeIds = getSourceItemForNode(nodeId) ? [nodeId] : [];
      for (const childId of node.children || []) {
        nodeIds.push(...collectDescendantSourceNodeIds(childId));
      }
      const deduped = dedupe(nodeIds);
      descendantSourceNodeIdCache.set(nodeId, deduped);
      return deduped;
    }

    const deduped = dedupe(
      (node.children || []).flatMap((childId) => collectDescendantSourceNodeIds(childId))
    );
    descendantSourceNodeIdCache.set(nodeId, deduped);
    return deduped;
  }

  function collectDescendantSourceItems(nodeId) {
    return collectDescendantSourceNodeIds(nodeId)
      .map((descendantNodeId) => getSourceItemForNode(descendantNodeId))
      .filter(Boolean);
  }

  function walk(nodeId, depth = 0, ancestorExcluded = false, ancestorPricingMuted = false) {
    const node = nodes[nodeId];
    if (!node) return;
    const metrics = computeNodeMetrics(nodeId);
    const selfListedOnly = isListedOnlyNode(node);
    const selfOverrideActive = typeof node.priceOverride === "number" || typeof node.costOverride === "number";
    const rowPricingMuted = ancestorPricingMuted || selfListedOnly;
    const descendantPricingMuted = ancestorPricingMuted || selfListedOnly || selfOverrideActive;

    if (node.kind === "group") {
      const allItems = collectDescendantSourceItems(nodeId);
      if (!allItems.length && !metrics.summaryPrice && !metrics.summaryCost) return;

      const excluded = node.excludedFromPrice === true || ancestorExcluded;
      rendered.push({
        code: nodeId,
        nodeId,
        kind: "group",
        label: node.label || "Group",
        quantity: 1,
        unit: "lot",
        unitPrice: excluded ? 0 : metrics.displayPrice,
        totalPrice: excluded ? 0 : metrics.displayPrice,
        unitCost: excluded ? 0 : metrics.displayCost,
        totalCost: excluded ? 0 : metrics.displayCost,
        depth,
        amountVisible: excluded ? false : node.amountVisible !== false,
        amountBlank: node.amountBlank === true,
        rowStyle: node.rowStyle || null,
        collapsed: node.collapsed === true,
        excludedFromPrice: excluded,
        pricingContribution: node.pricingContribution || "included",
        pricingMuted: rowPricingMuted,
        contributionPrice: excluded ? 0 : metrics.contributionPrice,
        contributionCost: excluded ? 0 : metrics.contributionCost,
        ...(typeof node.priceOverride === "number" ? { priceOverride: node.priceOverride } : {}),
        ...(typeof node.costOverride === "number" ? { costOverride: node.costOverride } : {}),
        sourceLineItemCodes: dedupe(allItems.flatMap((item) => item.sourceLineItemCodes || [item.code])),
        componentLineItemCodes: dedupe(allItems.flatMap((item) => item.componentLineItemCodes || [])),
        allocatedLineItemCodes: dedupe(allItems.flatMap((item) => item.allocatedLineItemCodes || [])),
        components: [],
        section: resolveSingleValue(allItems.map((item) => item.section || null)),
        workDomain: resolveSingleValue(allItems.map((item) => item.workDomain || null)),
        scopeSummary: node.label || "Group",
      });

      if (includeCollapsedChildren || !node.collapsed) {
        for (const childId of node.children || []) {
          walk(childId, depth + 1, excluded, descendantPricingMuted);
        }
      }
      return;
    }

    const sourceItem = getSourceItemForNode(nodeId);
    if (!sourceItem) return;
    const excluded = node.excludedFromPrice === true || ancestorExcluded;
    const srcCollapsed = node.collapsed === true;

    const nodeOrigin = presentationNodeOrigin(node);
    rendered.push({
      ...sourceItem,
      nodeId,
      kind: "source",
      sourceCode: node.sourceCode,
      sourceKind: node.sourceKind || "customer_schedule_item",
      origin: nodeOrigin,
      pricingMode: nodeOrigin === "manual" ? "manual" : (nodeOrigin === "generated" ? "allocated" : "engine"),
      componentSourceCode: node.componentSourceCode || null,
      componentCode: node.componentCode || null,
      label: node.labelOverride || sourceItem.label,
      amountVisible: excluded ? false : node.amountVisible !== false,
      amountBlank: node.amountBlank === true,
      rowStyle: node.rowStyle || null,
      unitPrice: excluded ? 0 : metrics.displayUnitPrice,
      totalPrice: excluded ? 0 : metrics.displayPrice,
      unitCost: excluded ? 0 : metrics.displayUnitCost,
      totalCost: excluded ? 0 : metrics.displayCost,
      pricingContribution: node.pricingContribution || "included",
      pricingMuted: rowPricingMuted,
      contributionPrice: excluded ? 0 : metrics.contributionPrice,
      contributionCost: excluded ? 0 : metrics.contributionCost,
      ...(typeof node.priceOverride === "number" ? { priceOverride: node.priceOverride } : {}),
      ...(typeof node.costOverride === "number" ? { costOverride: node.costOverride } : {}),
      depth,
      collapsed: srcCollapsed,
      excludedFromPrice: excluded,
    });

    if (srcCollapsed && !includeCollapsedChildren) return;

    for (const childId of node.children || []) {
      walk(childId, depth + 1, excluded, descendantPricingMuted);
    }
  }

  for (const nodeId of materializedOrganizer?.root || []) {
    walk(nodeId, 0);
  }

  return rendered;
}
