import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePresentationOrganizer,
  resolvePresentationOrganizer,
} from "./quote-presentation-organizer.js";
import { buildGeneratedPresentationSourceNodeId } from "../shared/quote-presentation-renderer.js";

// ─── normalizePresentationOrganizer: priceSourceNodeIds preservation ───

test("normalizePresentationOrganizer preserves priceSourceNodeIds with values", () => {
  const input = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["src:a", "src:b"],
        priceSourceNodeIds: ["src:a"],
      },
    },
  };
  const result = normalizePresentationOrganizer(input);
  const group = result.nodes["group:g1"];
  assert.ok(group, "group should exist in output");
  assert.deepEqual(group.priceSourceNodeIds, ["src:a"], "should preserve non-empty priceSourceNodeIds");
});

test("normalizePresentationOrganizer preserves group pricing overrides", () => {
  const input = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["src:a"],
        priceOverride: 123,
        costOverride: 45,
      },
    },
  };
  const result = normalizePresentationOrganizer(input);
  assert.equal(result.nodes["group:g1"].priceOverride, 123);
  assert.equal(result.nodes["group:g1"].costOverride, 45);
});

test("normalizePresentationOrganizer preserves item-level listed-only pricing contribution", () => {
  const input = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["src:a"],
        pricingContribution: "listed_only",
      },
      "src:a": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-a",
        pricingContribution: "listed_only",
      },
    },
  };

  const result = normalizePresentationOrganizer(input);
  assert.equal(result.nodes["group:g1"].pricingContribution, "listed_only");
  assert.equal(result.nodes["src:a"].pricingContribution, "listed_only");
});

test("normalizePresentationOrganizer preserves removed source tombstones", () => {
  const result = normalizePresentationOrganizer({
    root: [],
    nodes: {},
    removedSourceCodes: ["removed-row", "removed-row", ""],
  });

  assert.deepEqual(result, {
    root: [],
    nodes: {},
    removedSourceCodes: ["removed-row"],
  });
});

test("normalizePresentationOrganizer preserves empty priceSourceNodeIds []", () => {
  const input = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["src:a"],
        priceSourceNodeIds: [],
      },
    },
  };
  const result = normalizePresentationOrganizer(input);
  const group = result.nodes["group:g1"];
  assert.ok(group, "group should exist");
  assert.ok(Array.isArray(group.priceSourceNodeIds), "priceSourceNodeIds should be an array");
  assert.equal(group.priceSourceNodeIds.length, 0, "priceSourceNodeIds should be empty array");
});

test("normalizePresentationOrganizer omits priceSourceNodeIds when undefined", () => {
  const input = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["src:a"],
      },
    },
  };
  const result = normalizePresentationOrganizer(input);
  const group = result.nodes["group:g1"];
  assert.ok(group);
  assert.equal(group.priceSourceNodeIds, undefined, "should not add priceSourceNodeIds when not provided");
});

// ─── resolvePresentationOrganizer: priceSourceNodeIds preservation ───

test("resolvePresentationOrganizer preserves empty priceSourceNodeIds []", () => {
  const sourceItems = [
    { code: "item-a", label: "Item A", totalPrice: 1000 },
  ];
  const organizer = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["source:item-a"],
        priceSourceNodeIds: [],
      },
    },
  };
  const result = resolvePresentationOrganizer({ organizer, sourceItems });
  const group = result.nodes["group:g1"];
  assert.ok(group, "group should exist in resolved output");
  assert.ok(Array.isArray(group.priceSourceNodeIds), "priceSourceNodeIds should be an array");
  assert.equal(group.priceSourceNodeIds.length, 0, "priceSourceNodeIds should be empty");
});

test("resolvePresentationOrganizer omits priceSourceNodeIds when undefined", () => {
  const sourceItems = [
    { code: "item-a", label: "Item A", totalPrice: 1000 },
  ];
  const organizer = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["source:item-a"],
      },
    },
  };
  const result = resolvePresentationOrganizer({ organizer, sourceItems });
  const group = result.nodes["group:g1"];
  assert.ok(group);
  assert.equal(group.priceSourceNodeIds, undefined, "should not add priceSourceNodeIds when not set");
});

test("resolvePresentationOrganizer preserves group pricing overrides", () => {
  const sourceItems = [
    { code: "item-a", label: "Item A", totalPrice: 1000 },
  ];
  const organizer = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["source:item-a"],
        priceOverride: 321,
        costOverride: 111,
      },
    },
  };
  const result = resolvePresentationOrganizer({ organizer, sourceItems });
  const group = result.nodes["group:g1"];
  assert.equal(group.priceOverride, 321);
  assert.equal(group.costOverride, 111);
});

test("resolvePresentationOrganizer preserves excluded group state", () => {
  const sourceItems = [
    { code: "item-a", label: "Item A", totalPrice: 1000 },
  ];
  const organizer = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["source:item-a"],
        excludedFromPrice: true,
      },
    },
  };
  const result = resolvePresentationOrganizer({ organizer, sourceItems });
  assert.equal(result.nodes["group:g1"].excludedFromPrice, true);
});

test("resolvePresentationOrganizer does not respawn removed engine source rows", () => {
  const result = resolvePresentationOrganizer({
    sourceItems: [
      { code: "kept-row", label: "Kept row", totalPrice: 1000 },
      { code: "removed-row", label: "Removed row", totalPrice: 500 },
    ],
    organizer: {
      root: ["source:kept-row"],
      removedSourceCodes: ["removed-row"],
      nodes: {
        "source:kept-row": {
          kind: "source",
          sourceCode: "kept-row",
        },
      },
    },
  });

  assert.deepEqual(result.root, ["source:kept-row"]);
  assert.ok(result.nodes["source:kept-row"]);
  assert.equal(result.nodes["source:removed-row"], undefined);
  assert.deepEqual(result.removedSourceCodes, ["removed-row"]);
});

// ─── normalizePresentationOrganizer: deduplication ───

test("normalizePresentationOrganizer deduplicates priceSourceNodeIds", () => {
  const input = {
    root: ["group:g1"],
    nodes: {
      "group:g1": {
        kind: "group",
        label: "Test",
        children: ["src:a"],
        priceSourceNodeIds: ["src:a", "src:a", "src:a"],
      },
    },
  };
  const result = normalizePresentationOrganizer(input);
  assert.deepEqual(result.nodes["group:g1"].priceSourceNodeIds, ["src:a"]);
});

test("resolvePresentationOrganizer materializes legacy component rows into generated source nodes", () => {
  const organizer = resolvePresentationOrganizer({
    sourceItems: [
      {
        code: "wall",
        label: "Retaining wall",
        totalPrice: 30,
        components: [
          { code: "wall::detail::sleepers", label: "Concrete sleepers", quantity: 1, unit: "lot", unitPrice: 10, totalPrice: 10, customerFacing: true },
          { code: "wall::detail::steel", label: "Steel posts", quantity: 1, unit: "lot", unitPrice: 20, totalPrice: 20, customerFacing: true },
        ],
      },
    ],
    organizer: {
      root: ["source:wall"],
      nodes: {
        "source:wall": {
          kind: "source",
          sourceCode: "wall",
          componentOrder: ["wall::detail::steel", "wall::detail::sleepers"],
          componentOverrides: {
            "wall::detail::steel": {
              labelOverride: "Steel package",
              collapsed: true,
            },
          },
          componentChildren: {
            "wall::detail::steel": ["wall::detail::sleepers"],
          },
        },
      },
    },
  });

  const steelNodeId = buildGeneratedPresentationSourceNodeId("wall", "wall::detail::steel");
  const sleeperNodeId = buildGeneratedPresentationSourceNodeId("wall", "wall::detail::sleepers");

  assert.deepEqual(organizer.nodes["source:wall"].children, [steelNodeId]);
  assert.deepEqual(organizer.nodes[steelNodeId], {
    kind: "source",
    sourceKind: "generated_component",
    origin: "generated",
    pricingMode: "allocated",
    sourceCode: "wall::detail::steel",
    componentSourceCode: "wall",
    componentCode: "wall::detail::steel",
    componentParentCode: null,
    labelOverride: "Steel package",
    amountVisible: true,
    collapsed: true,
    children: [sleeperNodeId],
  });
  assert.deepEqual(organizer.nodes[sleeperNodeId], {
    kind: "source",
    sourceKind: "generated_component",
    origin: "generated",
    pricingMode: "allocated",
    sourceCode: "wall::detail::sleepers",
    componentSourceCode: "wall",
    componentCode: "wall::detail::sleepers",
    componentParentCode: "wall::detail::steel",
    labelOverride: null,
    amountVisible: true,
    children: [],
  });
});

test("resolvePresentationOrganizer skips generated component rows marked as removed", () => {
  const sleeperNodeId = buildGeneratedPresentationSourceNodeId("wall", "wall::detail::sleepers");
  const steelNodeId = buildGeneratedPresentationSourceNodeId("wall", "wall::detail::steel");
  const organizer = resolvePresentationOrganizer({
    sourceItems: [
      {
        code: "wall",
        label: "Retaining wall",
        totalPrice: 30,
        components: [
          { code: "wall::detail::sleepers", label: "Concrete sleepers", quantity: 1, unit: "lot", unitPrice: 10, totalPrice: 10, customerFacing: true },
          { code: "wall::detail::steel", label: "Steel posts", quantity: 1, unit: "lot", unitPrice: 20, totalPrice: 20, customerFacing: true },
        ],
      },
    ],
    organizer: {
      root: ["source:wall"],
      nodes: {
        "source:wall": {
          kind: "source",
          sourceCode: "wall",
          componentOrder: ["wall::detail::sleepers", "wall::detail::steel"],
          removedComponentCodes: ["wall::detail::sleepers"],
        },
      },
    },
  });

  assert.deepEqual(organizer.nodes["source:wall"].removedComponentCodes, ["wall::detail::sleepers"]);
  assert.deepEqual(organizer.nodes["source:wall"].children, [steelNodeId]);
  assert.equal(organizer.nodes[sleeperNodeId], undefined);
});

test("resolvePresentationOrganizer tags every source node with canonical origin and pricingMode", () => {
  const organizer = resolvePresentationOrganizer({
    sourceItems: [
      {
        code: "excavation",
        label: "Excavation",
        quantity: 1,
        unit: "m3",
        unitPrice: 100,
        totalPrice: 100,
      },
    ],
    organizer: {
      root: ["source:excavation", "manual:extra"],
      nodes: {
        "source:excavation": {
          kind: "source",
          sourceKind: "customer_schedule_item",
          sourceCode: "excavation",
        },
        "manual:extra": {
          kind: "source",
          sourceKind: "manual",
          sourceCode: "manual-extra",
          labelOverride: "Extra allowance",
          manualPrice: 150,
          manualCost: 90,
        },
      },
    },
  });

  assert.equal(organizer.nodes["source:excavation"].origin, "engine");
  assert.equal(organizer.nodes["source:excavation"].pricingMode, "engine");
  assert.equal(organizer.nodes["source:excavation"].sourceKind, "customer_schedule_item");

  assert.equal(organizer.nodes["manual:extra"].origin, "manual");
  assert.equal(organizer.nodes["manual:extra"].pricingMode, "manual");
  assert.equal(organizer.nodes["manual:extra"].sourceKind, "manual");
});

test("normalizePresentationOrganizer accepts explicit origin on new writes and derives the legacy sourceKind", () => {
  const result = normalizePresentationOrganizer({
    root: ["source:manual-only"],
    nodes: {
      "source:manual-only": {
        kind: "source",
        // Consumer writes origin directly, no sourceKind.
        origin: "manual",
        sourceCode: "manual-only",
        labelOverride: "Origin-first manual",
        manualPrice: 99,
      },
    },
  });

  const node = result.nodes["source:manual-only"];
  assert.equal(node.origin, "manual");
  assert.equal(node.pricingMode, "manual");
  assert.equal(node.sourceKind, "manual");
  assert.equal(node.manualPrice, 99);
});

test("normalizePresentationOrganizer preserves manual rate fields for catalog-linked rows", () => {
  const result = normalizePresentationOrganizer({
    root: ["manual:catalog-row"],
    nodes: {
      "manual:catalog-row": {
        kind: "source",
        origin: "manual",
        sourceCode: "manual-catalog-row",
        labelOverride: "Admin Fee",
        quantity: 10,
        unit: "nos",
        sellRate: 300,
        buyRate: 200,
        rateMode: "catalog-linked",
        applicationMode: "fixed",
        catalogItemCode: "ADMIN-FEE",
        isGhostBase: true,
      },
    },
  });

  const node = result.nodes["manual:catalog-row"];
  assert.equal(node.origin, "manual");
  assert.equal(node.pricingMode, "manual");
  assert.equal(node.sourceKind, "manual");
  assert.equal(node.quantity, 10);
  assert.equal(node.unit, "each");
  assert.equal(node.sellRate, 300);
  assert.equal(node.buyRate, 200);
  assert.equal(node.rateMode, "catalog-linked");
  assert.equal(node.applicationMode, "fixed");
  assert.equal(node.catalogItemCode, "ADMIN-FEE");
  assert.equal(node.isGhostBase, true);
});
