// Pure operations on a quote's presentation organizer (the tree of sections
// and rows the customer sees). Prices are never computed here: the shared
// renderer (shared/quote-presentation-renderer.js) prices the tree exactly as
// the server and the PDF do. These helpers only change its shape.
import type {
  Quote,
  QuotePresentationOrganizer,
  QuotePresentationOrganizerNode,
  QuotePresentationOrganizerSourceNode,
  QuotePresentationScheduleItem,
} from "@/lib/types";
import { materializePresentationOrganizerGeneratedNodes } from "../../../../shared/quote-presentation-renderer.js";

export type Organizer = QuotePresentationOrganizer;
export type ParentId = string | null;

export function nodeOrigin(node: QuotePresentationOrganizerNode | undefined): "engine" | "manual" | "generated" | "group" {
  if (!node) return "manual";
  if (node.kind === "group") return "group";
  if (node.origin === "manual" || node.origin === "generated" || node.origin === "engine") return node.origin;
  if (node.sourceKind === "manual") return "manual";
  if (node.sourceKind === "generated_component") return "generated";
  return "engine";
}

function isGeneratedItem(item: QuotePresentationScheduleItem) {
  return item.origin === "generated" || item.sourceKind === "generated_component";
}

/** The engine's own schedule items: what engine-origin rows are priced from. */
export function getSourceItems(quote: Quote): QuotePresentationScheduleItem[] {
  const presentation = quote.presentation;
  if (Array.isArray(presentation?.sourceItems) && presentation.sourceItems.length) {
    return presentation.sourceItems.filter((item) => item.kind !== "component" && item.kind !== "group" && !isGeneratedItem(item));
  }
  if (Array.isArray(presentation?.scheduleItems) && presentation.scheduleItems.length) {
    return presentation.scheduleItems.filter((item) => (item.kind === "source" || !item.kind) && !isGeneratedItem(item));
  }
  return (quote.lineItems || []).map((item) => ({
    code: item.code,
    label: item.customerLabel || item.label,
    quantity: 1,
    unit: "lot",
    unitPrice: item.totalPrice,
    totalPrice: item.totalPrice,
    section: item.section || null,
    sourceLineItemCodes: [item.code],
    componentLineItemCodes: [item.code],
    allocatedLineItemCodes: [],
  }));
}

function fallbackOrganizer(sourceItems: QuotePresentationScheduleItem[]): Organizer {
  const nodes: Record<string, QuotePresentationOrganizerNode> = {};
  const root = sourceItems.map((item) => {
    const nodeId = `source:${item.code}`;
    nodes[nodeId] = {
      kind: "source",
      sourceKind: "customer_schedule_item",
      origin: "engine",
      pricingMode: "engine",
      sourceCode: String(item.code),
      labelOverride: null,
      amountVisible: true,
    };
    return nodeId;
  });
  return { root, nodes };
}

/** Group price filters were replaced by per-row "listed only"; upgrade old trees. */
function migrateLegacyGroupPriceFilters(organizer: Organizer): Organizer {
  for (const node of Object.values(organizer.nodes || {})) {
    if (node.kind !== "group" || !Array.isArray(node.priceSourceNodeIds)) continue;
    const included = new Set(node.priceSourceNodeIds);
    for (const childId of node.children || []) {
      const child = organizer.nodes[childId];
      if (!child) continue;
      if (included.has(childId)) delete child.pricingContribution;
      else child.pricingContribution = "listed_only";
    }
    delete node.priceSourceNodeIds;
  }
  return organizer;
}

export function buildInitialOrganizer(quote: Quote, sourceItems: QuotePresentationScheduleItem[]): Organizer {
  const existing = quote.presentation?.organizer;
  const base = existing?.root && existing?.nodes ? structuredClone(existing) : fallbackOrganizer(sourceItems);
  if (!base.root) base.root = [];
  if (!base.nodes) base.nodes = {};
  return migrateLegacyGroupPriceFilters(materializePresentationOrganizerGeneratedNodes({ organizer: base, sourceItems }));
}

export function childrenOf(organizer: Organizer, parentId: ParentId): string[] {
  if (!parentId) return organizer.root;
  const parent = organizer.nodes[parentId];
  return parent?.children || [];
}

function setChildren(organizer: Organizer, parentId: ParentId, children: string[]) {
  if (!parentId) {
    organizer.root = children;
    return;
  }
  const parent = organizer.nodes[parentId];
  if (parent) parent.children = children;
}

export function buildParentIndex(organizer: Organizer): Map<string, ParentId> {
  const index = new Map<string, ParentId>();
  const visit = (nodeId: string, parentId: ParentId) => {
    if (index.has(nodeId)) return;
    index.set(nodeId, parentId);
    for (const childId of organizer.nodes[nodeId]?.children || []) visit(childId, nodeId);
  };
  for (const nodeId of organizer.root || []) visit(nodeId, null);
  return index;
}

export function descendantIds(organizer: Organizer, nodeId: string): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    for (const childId of organizer.nodes[id]?.children || []) {
      if (out.includes(childId)) continue;
      out.push(childId);
      visit(childId);
    }
  };
  visit(nodeId);
  return out;
}

export function insertNode(organizer: Organizer, nodeId: string, parentId: ParentId, index?: number) {
  const siblings = [...childrenOf(organizer, parentId)].filter((id) => id !== nodeId);
  const at = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  siblings.splice(at, 0, nodeId);
  setChildren(organizer, parentId, siblings);
}

export function detachNode(organizer: Organizer, nodeId: string) {
  const parentId = buildParentIndex(organizer).get(nodeId) ?? null;
  setChildren(organizer, parentId, childrenOf(organizer, parentId).filter((id) => id !== nodeId));
  return parentId;
}

export function moveWithinParent(organizer: Organizer, nodeId: string, direction: -1 | 1) {
  const parentId = buildParentIndex(organizer).get(nodeId) ?? null;
  const siblings = [...childrenOf(organizer, parentId)];
  const index = siblings.indexOf(nodeId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= siblings.length) return false;
  siblings.splice(index, 1);
  siblings.splice(next, 0, nodeId);
  setChildren(organizer, parentId, siblings);
  return true;
}

/** Move a row into a section (or to the top level) at its end. Engine rows keep their place in the engine's tree. */
export function moveToParent(organizer: Organizer, nodeId: string, parentId: ParentId) {
  if (nodeId === parentId || (parentId && descendantIds(organizer, nodeId).includes(parentId))) return false;
  detachNode(organizer, nodeId);
  insertNode(organizer, nodeId, parentId);
  return true;
}

function findEngineNode(organizer: Organizer, sourceCode: string): QuotePresentationOrganizerSourceNode | null {
  for (const node of Object.values(organizer.nodes)) {
    if (node.kind === "source" && nodeOrigin(node) === "engine" && String(node.sourceCode || "") === sourceCode) return node;
  }
  return null;
}

/**
 * Remove a row or section and everything under it. Engine rows and their
 * generated components are recorded as removed so the next rebuild does not
 * bring them back.
 */
export function removeNode(organizer: Organizer, nodeId: string) {
  const ids = [nodeId, ...descendantIds(organizer, nodeId)];
  for (const id of ids) {
    const node = organizer.nodes[id];
    if (!node || node.kind !== "source") continue;
    const origin = nodeOrigin(node);
    if (origin === "engine" && node.sourceCode) {
      organizer.removedSourceCodes = Array.from(new Set([...(organizer.removedSourceCodes || []), String(node.sourceCode)]));
    } else if (origin === "generated") {
      const owner = node.componentSourceCode ? findEngineNode(organizer, String(node.componentSourceCode)) : null;
      const code = String(node.componentCode || node.sourceCode || "");
      if (owner && code) owner.removedComponentCodes = Array.from(new Set([...(owner.removedComponentCodes || []), code]));
    }
  }
  detachNode(organizer, nodeId);
  for (const id of ids) delete organizer.nodes[id];
}

let sequence = 0;
export function newNodeId(prefix: "group" | "manual") {
  sequence += 1;
  return `${prefix}:${Date.now().toString(36)}:${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addSection(organizer: Organizer, label = "New section", index?: number) {
  const id = newNodeId("group");
  organizer.nodes[id] = { kind: "group", label, amountVisible: true, collapsed: false, children: [] };
  insertNode(organizer, id, null, index);
  return id;
}

export function addOneOffLine(organizer: Organizer, parentId: ParentId, label: string) {
  const id = newNodeId("manual");
  organizer.nodes[id] = {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: `manual-item-${id.split(":").slice(1).join("-")}`,
    labelOverride: label || "New item",
    amountVisible: true,
    quantity: 1,
    unit: "each",
    sellRate: 0,
    buyRate: 0,
    rateMode: "manual",
  };
  insertNode(organizer, id, parentId);
  return id;
}
