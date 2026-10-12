import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGeneratedPresentationSourceNodeId,
  calculatePresentationScheduleTotals,
  buildRenderedPresentationScheduleItems,
  collectOrganizerSubtreeNodeIds,
  organizerSubtreeHasOverride,
} from "./quote-presentation-renderer.js";

// Helper: build a minimal organizer + sourceItems for testing
function makeTestFixture({ priceSourceNodeIds, excludedFromPrice, priceOverride, costOverride } = {}) {
  const sourceItems = [
    { code: "item-a", label: "Item A", totalPrice: 1000, totalCost: 500 },
    { code: "item-b", label: "Item B", totalPrice: 2000, totalCost: 900 },
  ];
  const groupNode = {
    kind: "group",
    label: "Test Group",
    children: ["src:item-a", "src:item-b"],
    amountVisible: true,
    collapsed: false,
  };
  if (priceSourceNodeIds !== undefined) groupNode.priceSourceNodeIds = priceSourceNodeIds;
  if (excludedFromPrice) groupNode.excludedFromPrice = true;
  if (priceOverride !== undefined) groupNode.priceOverride = priceOverride;
  if (costOverride !== undefined) groupNode.costOverride = costOverride;
  const organizer = {
    root: ["group:test"],
    nodes: {
      "group:test": groupNode,
      "src:item-a": { kind: "source", sourceKind: "customer_schedule_item", sourceCode: "item-a", amountVisible: true },
      "src:item-b": { kind: "source", sourceKind: "customer_schedule_item", sourceCode: "item-b", amountVisible: true },
    },
  };
  return { organizer, sourceItems };
}

// ─── priceSourceNodeIds semantics ───

test("undefined priceSourceNodeIds includes all children in totals", () => {
  const { organizer, sourceItems } = makeTestFixture({ priceSourceNodeIds: undefined });
  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems });
  assert.equal(totals.charge, 3000, "charge should be sum of both items");
  assert.equal(totals.cost, 1400, "cost should be sum of both items");
});

test("priceSourceNodeIds with one child filters display price", () => {
  const { organizer, sourceItems } = makeTestFixture({ priceSourceNodeIds: ["src:item-a"] });
  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems });
  assert.equal(totals.charge, 1000, "charge should be only item A");
  assert.equal(totals.cost, 500, "cost should be only item A");
});

test("empty priceSourceNodeIds [] means include nothing — display price is $0", () => {
  const { organizer, sourceItems } = makeTestFixture({ priceSourceNodeIds: [] });
  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems });
  assert.equal(totals.charge, 0, "charge should be $0 when all price sources removed");
  assert.equal(totals.cost, 0, "cost should be $0 when all price sources removed");
});

test("empty priceSourceNodeIds [] shows group with $0 but NOT excluded", () => {
  const { organizer, sourceItems } = makeTestFixture({ priceSourceNodeIds: [] });
  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  const group = items.find((i) => i.nodeId === "group:test");
  assert.ok(group, "group should still be rendered");
  assert.equal(group.excludedFromPrice, false, "group should NOT be excluded — exclusion is a separate user action");
  assert.equal(group.totalPrice, 0, "group totalPrice should be $0 because no price sources selected");
});

// ─── excludedFromPrice ───

test("excludedFromPrice on group sets totals to $0", () => {
  const { organizer, sourceItems } = makeTestFixture({ excludedFromPrice: true });
  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems });
  assert.equal(totals.charge, 0);
  assert.equal(totals.cost, 0);
});

test("excludedFromPrice cascades to children in rendered items", () => {
  const { organizer, sourceItems } = makeTestFixture({ excludedFromPrice: true });
  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  for (const item of items) {
    assert.equal(item.excludedFromPrice, true, `${item.label} should be excluded`);
    assert.equal(item.totalPrice, 0, `${item.label} price should be $0`);
  }
});

// ─── Normal case (no filters, no exclusions) ───

test("normal group sums all children", () => {
  const { organizer, sourceItems } = makeTestFixture();
  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  const group = items.find((i) => i.nodeId === "group:test");
  assert.ok(group);
  assert.equal(group.totalPrice, 3000);
  assert.equal(group.excludedFromPrice, false);
});

test("group overrides replace rolled-up totals", () => {
  const { organizer, sourceItems } = makeTestFixture({ priceOverride: 1600, costOverride: 700 });
  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems });
  assert.equal(totals.charge, 1600);
  assert.equal(totals.cost, 700);

  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  const group = items.find((item) => item.nodeId === "group:test");
  assert.ok(group);
  assert.equal(group.totalPrice, 1600);
  assert.equal(group.totalCost, 700);
  assert.equal(group.priceOverride, 1600);
  assert.equal(group.costOverride, 700);
});

test("totals use displayPrice not summaryPrice", () => {
  // When priceSourceNodeIds filters to one child, summaryPrice is still 3000
  // but displayPrice (and therefore totals) should be 1000
  const { organizer, sourceItems } = makeTestFixture({ priceSourceNodeIds: ["src:item-a"] });
  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems });
  assert.equal(totals.charge, 1000, "totals should use displayPrice, not summaryPrice");
});

test("listed-only child stays visible but does not contribute to parent or quote totals", () => {
  const { organizer, sourceItems } = makeTestFixture();
  organizer.nodes["src:item-b"].pricingContribution = "listed_only";

  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems });
  assert.equal(totals.charge, 1000);
  assert.equal(totals.cost, 500);

  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  const group = items.find((item) => item.nodeId === "group:test");
  const listed = items.find((item) => item.nodeId === "src:item-b");
  assert.ok(group);
  assert.ok(listed);
  assert.equal(group.totalPrice, 1000);
  assert.equal(group.contributionPrice, 1000);
  assert.equal(listed.totalPrice, 2000);
  assert.equal(listed.contributionPrice, 0);
  assert.equal(listed.excludedFromPrice, false);
  assert.equal(listed.pricingMuted, true);
});

test("listed-only source child is excluded from source parent rollups", () => {
  const organizer = {
    root: ["manual:bundle"],
    nodes: {
      "manual:bundle": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-bundle",
        labelOverride: "Bundle",
        quantity: 1,
        unit: "lot",
        sellRate: 0,
        buyRate: 0,
        children: ["manual:included", "manual:option"],
      },
      "manual:included": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-included",
        labelOverride: "Included item",
        quantity: 1,
        unit: "each",
        sellRate: 100,
        buyRate: 40,
      },
      "manual:option": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-option",
        labelOverride: "Listed option",
        quantity: 1,
        unit: "each",
        sellRate: 250,
        buyRate: 90,
        pricingContribution: "listed_only",
      },
    },
  };

  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems: [] });
  assert.equal(totals.charge, 100);
  assert.equal(totals.cost, 40);

  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems: [] });
  const parent = items.find((item) => item.nodeId === "manual:bundle");
  const option = items.find((item) => item.nodeId === "manual:option");
  assert.ok(parent);
  assert.ok(option);
  assert.equal(parent.totalPrice, 100);
  assert.equal(option.totalPrice, 250);
  assert.equal(option.contributionPrice, 0);
  assert.equal(option.pricingMuted, true);
});

test("manual source override mutes descendant rows while replacing their total contribution", () => {
  const organizer = {
    root: ["manual:bundle"],
    nodes: {
      "manual:bundle": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-bundle",
        labelOverride: "Bundle",
        quantity: 1,
        unit: "lot",
        sellRate: 0,
        buyRate: 0,
        priceOverride: 120,
        costOverride: 60,
        children: ["manual:child"],
      },
      "manual:child": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-child",
        labelOverride: "Child",
        quantity: 1,
        unit: "each",
        sellRate: 500,
        buyRate: 200,
      },
    },
  };

  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems: [] });
  assert.equal(totals.charge, 120);
  assert.equal(totals.cost, 60);

  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems: [] });
  const parent = items.find((item) => item.nodeId === "manual:bundle");
  const child = items.find((item) => item.nodeId === "manual:child");
  assert.ok(parent);
  assert.ok(child);
  assert.equal(parent.pricingMuted, false);
  assert.equal(child.totalPrice, 500);
  assert.equal(child.pricingMuted, true);
});

test("generated source children do not double-count their owner source totals", () => {
  const parentNodeId = "source:wall";
  const sleepersNodeId = buildGeneratedPresentationSourceNodeId("wall", "wall::detail::sleepers");
  const steelNodeId = buildGeneratedPresentationSourceNodeId("wall", "wall::detail::steel");
  const sourceItems = [
    {
      code: "wall",
      label: "Retaining wall",
      totalPrice: 30,
      totalCost: 12,
      components: [
        { code: "wall::detail::sleepers", label: "Concrete sleepers", quantity: 1, unit: "lot", unitPrice: 10, totalPrice: 10, unitCost: 4, totalCost: 4, customerFacing: true },
        { code: "wall::detail::steel", label: "Steel posts", quantity: 1, unit: "lot", unitPrice: 20, totalPrice: 20, unitCost: 8, totalCost: 8, customerFacing: true },
      ],
    },
  ];
  const organizer = {
    root: [parentNodeId],
    nodes: {
      [parentNodeId]: {
        kind: "source",
        sourceCode: "wall",
        amountVisible: true,
        children: [sleepersNodeId, steelNodeId],
      },
      [sleepersNodeId]: {
        kind: "source",
        sourceKind: "generated_component",
        sourceCode: "wall::detail::sleepers",
        componentSourceCode: "wall",
        componentCode: "wall::detail::sleepers",
        amountVisible: true,
        children: [],
      },
      [steelNodeId]: {
        kind: "source",
        sourceKind: "generated_component",
        sourceCode: "wall::detail::steel",
        componentSourceCode: "wall",
        componentCode: "wall::detail::steel",
        amountVisible: true,
        children: [],
      },
    },
  };

  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems });
  assert.equal(totals.charge, 30);
  assert.equal(totals.cost, 12);

  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  assert.deepEqual(
    items.map((item) => [item.label, item.totalPrice, item.totalCost, item.depth, item.sourceKind || null]),
    [
      ["Retaining wall", 30, 12, 0, "customer_schedule_item"],
      ["Concrete sleepers", 10, 4, 1, "generated_component"],
      ["Steel posts", 20, 8, 1, "generated_component"],
    ]
  );
});

test("editor preview mode includes collapsed descendants for manual child rollups", () => {
  const organizer = {
    root: ["group:soil"],
    nodes: {
      "group:soil": {
        kind: "group",
        label: "Soil Removal and Disposal",
        collapsed: true,
        amountVisible: true,
        children: ["manual:soil", "manual:equipment"],
      },
      "manual:soil": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        pricingMode: "manual",
        sourceCode: "manual-soil",
        labelOverride: "Soil Removal and Disposal",
        amountVisible: true,
        quantity: 64,
        unit: "m3",
        sellRate: 91.89,
        buyRate: 68.57,
        children: [],
      },
      "manual:equipment": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        pricingMode: "manual",
        sourceCode: "manual-equipment",
        labelOverride: "Large Equipment Hire",
        amountVisible: true,
        quantity: 4,
        unit: "day",
        sellRate: 0,
        buyRate: 0,
        children: ["manual:excavator", "manual:tipper"],
      },
      "manual:excavator": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        pricingMode: "manual",
        sourceCode: "manual-excavator",
        labelOverride: "Excavator Rubber Tracked - 8t",
        amountVisible: true,
        quantity: 8,
        unit: "job",
        sellRate: 51.14,
        buyRate: 45,
        applicationMode: "proportional",
        children: [],
      },
      "manual:tipper": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        pricingMode: "manual",
        sourceCode: "manual-tipper",
        labelOverride: "Tipper Truck - 6 Wheel",
        amountVisible: true,
        quantity: 8,
        unit: "job",
        sellRate: 54.55,
        buyRate: 48,
        applicationMode: "proportional",
        children: [],
      },
    },
  };

  const customerItems = buildRenderedPresentationScheduleItems({ organizer, sourceItems: [] });
  assert.deepEqual(
    customerItems.map((item) => item.nodeId),
    ["group:soil"],
    "collapsed descendants stay hidden by default"
  );

  const editorItems = buildRenderedPresentationScheduleItems({
    organizer,
    sourceItems: [],
    includeCollapsedChildren: true,
  });
  const equipment = editorItems.find((item) => item.nodeId === "manual:equipment");
  assert.ok(equipment);
  assert.equal(equipment.totalPrice, 3382.08);
  assert.equal(equipment.totalCost, 2976);
  assert.deepEqual(
    editorItems.map((item) => [item.nodeId, item.totalPrice, item.totalCost]),
    [
      ["group:soil", 9263.04, 7364.48],
      ["manual:soil", 5880.96, 4388.48],
      ["manual:equipment", 3382.08, 2976],
      ["manual:excavator", 409.12, 360],
      ["manual:tipper", 436.4, 384],
    ]
  );
});

// ─── Reset-to-engine cascade helpers ───

function makeNestedFixture({ topOverride, childOverride, leafOverride } = {}) {
  const organizer = {
    root: ["group:top"],
    nodes: {
      "group:top": {
        kind: "group",
        label: "Top",
        children: ["group:inner", "src:a"],
        ...(topOverride ? { priceOverride: topOverride.price, costOverride: topOverride.cost } : {}),
      },
      "group:inner": {
        kind: "group",
        label: "Inner",
        children: ["src:b"],
        ...(childOverride ? { priceOverride: childOverride.price, costOverride: childOverride.cost } : {}),
      },
      "src:a": {
        kind: "source",
        sourceKind: "customer_schedule_item",
        sourceCode: "a",
        children: [],
        ...(leafOverride?.a ? { priceOverride: leafOverride.a.price, costOverride: leafOverride.a.cost } : {}),
      },
      "src:b": {
        kind: "source",
        sourceKind: "customer_schedule_item",
        sourceCode: "b",
        children: [],
        ...(leafOverride?.b ? { priceOverride: leafOverride.b.price, costOverride: leafOverride.b.cost } : {}),
      },
    },
  };
  return organizer;
}

test("collectOrganizerSubtreeNodeIds walks every descendant (groups + sources)", () => {
  const organizer = makeNestedFixture();
  const ids = collectOrganizerSubtreeNodeIds(organizer, "group:top");
  assert.deepEqual(ids, ["group:top", "group:inner", "src:b", "src:a"]);
});

test("collectOrganizerSubtreeNodeIds returns empty array for unknown roots", () => {
  const organizer = makeNestedFixture();
  assert.deepEqual(collectOrganizerSubtreeNodeIds(organizer, "group:missing"), []);
  assert.deepEqual(collectOrganizerSubtreeNodeIds(null, "group:top"), []);
});

test("organizerSubtreeHasOverride returns true when an inner node carries an override", () => {
  const organizer = makeNestedFixture({
    leafOverride: { b: { price: 250, cost: 150 } },
  });
  assert.equal(organizerSubtreeHasOverride(organizer, "group:top"), true);
  // Walking from a sibling should not see the override.
  assert.equal(organizerSubtreeHasOverride(organizer, "src:a"), false);
});

test("organizerSubtreeHasOverride returns false when no descendant carries an override", () => {
  const organizer = makeNestedFixture();
  assert.equal(organizerSubtreeHasOverride(organizer, "group:top"), false);
});

test("cascade-clearing overrides via collectOrganizerSubtreeNodeIds wipes the entire subtree", () => {
  const organizer = makeNestedFixture({
    topOverride: { price: 1000, cost: 400 },
    childOverride: { price: 500, cost: 200 },
    leafOverride: {
      a: { price: 300, cost: 120 },
      b: { price: 200, cost: 80 },
    },
  });

  for (const id of collectOrganizerSubtreeNodeIds(organizer, "group:top")) {
    const node = organizer.nodes[id];
    delete node.priceOverride;
    delete node.costOverride;
  }

  assert.equal(organizerSubtreeHasOverride(organizer, "group:top"), false);
  assert.equal(organizer.nodes["group:top"].priceOverride, undefined);
  assert.equal(organizer.nodes["group:inner"].costOverride, undefined);
  assert.equal(organizer.nodes["src:a"].priceOverride, undefined);
  assert.equal(organizer.nodes["src:b"].costOverride, undefined);
});

// ─── manual item qty × rate (v1 feature) ───

function makeManualRowOrganizer(nodeProps) {
  return {
    organizer: {
      root: ["manual:x"],
      nodes: {
        "manual:x": {
          kind: "source",
          sourceKind: "manual",
          origin: "manual",
          sourceCode: "manual-item-x",
          labelOverride: "Bluestone supply",
          amountVisible: true,
          ...nodeProps,
        },
      },
    },
    sourceItems: [],
  };
}

test("manual row with qty × sellRate drives totalPrice", () => {
  const { organizer, sourceItems } = makeManualRowOrganizer({
    quantity: 2,
    unit: "tonne",
    sellRate: 194.4,
    buyRate: 120,
  });
  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.quantity, 2);
  assert.equal(item.unit, "tonne");
  assert.equal(item.totalPrice, 388.8);
  assert.equal(item.totalCost, 240);
});

test("manual row without rate fields falls back to legacy manualPrice/manualCost", () => {
  const { organizer, sourceItems } = makeManualRowOrganizer({
    manualPrice: 500,
    manualCost: 200,
  });
  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  const [item] = items;
  assert.equal(item.quantity, 1);
  assert.equal(item.unit, "lot");
  assert.equal(item.totalPrice, 500, "legacy rows render via manualPrice");
  assert.equal(item.totalCost, 200, "legacy rows render via manualCost");
});

test("manual row with quantity but no sellRate still renders as zero via rate path", () => {
  const { organizer, sourceItems } = makeManualRowOrganizer({
    quantity: 3,
    unit: "m",
  });
  const [item] = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  assert.equal(item.quantity, 3);
  assert.equal(item.unit, "m");
  assert.equal(item.totalPrice, 0);
  assert.equal(item.totalCost, 0);
});

test("manual row qty × rate totals are rounded to 2dp", () => {
  const { organizer, sourceItems } = makeManualRowOrganizer({
    quantity: 3,
    unit: "tonne",
    sellRate: 33.333,
  });
  const [item] = buildRenderedPresentationScheduleItems({ organizer, sourceItems });
  assert.equal(item.totalPrice, 100);
});

test("manual child rows roll up to the parent unit rate before parent quantity is applied", () => {
  const organizer = {
    root: ["manual:parent"],
    nodes: {
      "manual:parent": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-parent",
        labelOverride: "Rock/boulder wall shed section",
        quantity: 19,
        unit: "m",
        sellRate: 0,
        buyRate: 0,
        children: ["manual:lawn", "manual:extra"],
      },
      "manual:lawn": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-lawn",
        labelOverride: "Rock/boulder wall lawn section",
        quantity: 1,
        unit: "m",
        sellRate: 310,
        buyRate: 310,
        children: [],
      },
      "manual:extra": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-extra",
        labelOverride: "Extra finish",
        quantity: 2,
        unit: "each",
        sellRate: 15,
        buyRate: 10,
        children: [],
      },
    },
  };

  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems: [] });
  assert.equal(totals.charge, 6460);
  assert.equal(totals.cost, 6270);

  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems: [] });
  const parent = items.find((item) => item.nodeId === "manual:parent");
  const lawn = items.find((item) => item.nodeId === "manual:lawn");
  assert.ok(parent);
  assert.ok(lawn);
  assert.equal(lawn.unitPrice, 310);
  assert.equal(lawn.totalPrice, 310);
  assert.equal(parent.unitPrice, 340);
  assert.equal(parent.totalPrice, 6460);
  assert.equal(parent.unitCost, 330);
  assert.equal(parent.totalCost, 6270);
});

test("group price sources include selected manual items with child rollups", () => {
  const organizer = {
    root: ["group:package"],
    nodes: {
      "group:package": {
        kind: "group",
        label: "Package",
        children: ["manual:site", "manual:delivery"],
        priceSourceNodeIds: ["manual:site", "manual:delivery"],
      },
      "manual:site": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-site",
        labelOverride: "Site Levelling and Cut",
        quantity: 1,
        unit: "lot",
        sellRate: 0,
        buyRate: 0,
        children: ["manual:site-labour"],
      },
      "manual:site-labour": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-site-labour",
        labelOverride: "Site labour",
        quantity: 1,
        unit: "lot",
        sellRate: 3937.5,
        buyRate: 2362.5,
        children: [],
      },
      "manual:delivery": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-delivery",
        labelOverride: "Delivery",
        quantity: 1,
        unit: "lot",
        sellRate: 160,
        buyRate: 0,
        children: ["manual:delivery-freight", "manual:delivery-labour"],
      },
      "manual:delivery-freight": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-delivery-freight",
        labelOverride: "Freight",
        quantity: 1,
        unit: "each",
        sellRate: 300,
        buyRate: 200,
        children: [],
      },
      "manual:delivery-labour": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-delivery-labour",
        labelOverride: "Delivery labour",
        quantity: 1,
        unit: "each",
        sellRate: 60,
        buyRate: 50,
        children: [],
      },
    },
  };

  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems: [] });
  assert.equal(totals.charge, 4457.5);
  assert.equal(totals.cost, 2612.5);

  organizer.nodes["group:package"].priceSourceNodeIds = ["manual:delivery"];
  const filteredTotals = calculatePresentationScheduleTotals({ organizer, sourceItems: [] });
  assert.equal(filteredTotals.charge, 520);
  assert.equal(filteredTotals.cost, 250);
});

test("manual source rollups use nested group display totals before parent quantity", () => {
  const organizer = {
    root: ["manual:supply"],
    nodes: {
      "manual:supply": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-supply",
        labelOverride: "Sandy Loam Supply",
        quantity: 2,
        unit: "m3",
        sellRate: 100,
        buyRate: 50,
        children: ["group:outer", "manual:delivery"],
      },
      "group:outer": {
        kind: "group",
        label: "New group",
        children: ["group:inner"],
        priceSourceNodeIds: ["group:inner"],
      },
      "group:inner": {
        kind: "group",
        label: "Edging supply and install options",
        children: ["manual:selected", "manual:unticked"],
        priceSourceNodeIds: ["manual:selected"],
      },
      "manual:selected": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-selected",
        labelOverride: "Option #1 - 100mm Metal Edging",
        quantity: 1,
        unit: "each",
        sellRate: 25,
        buyRate: 10,
        children: [],
      },
      "manual:unticked": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-unticked",
        labelOverride: "Unticked option",
        quantity: 1,
        unit: "each",
        sellRate: 900,
        buyRate: 300,
        children: [],
      },
      "manual:delivery": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-delivery",
        labelOverride: "Delivery",
        quantity: 1,
        unit: "each",
        sellRate: 5,
        buyRate: 2,
        children: [],
      },
    },
  };

  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems: [] });
  const parent = items.find((item) => item.nodeId === "manual:supply");
  const outerGroup = items.find((item) => item.nodeId === "group:outer");
  const innerGroup = items.find((item) => item.nodeId === "group:inner");
  assert.ok(parent);
  assert.ok(outerGroup);
  assert.ok(innerGroup);
  assert.equal(innerGroup.totalPrice, 25);
  assert.equal(outerGroup.totalPrice, 25);
  assert.equal(parent.unitPrice, 130);
  assert.equal(parent.totalPrice, 260);
  assert.equal(parent.unitCost, 62);
  assert.equal(parent.totalCost, 124);

  organizer.nodes["group:outer"].priceSourceNodeIds = [];
  const untickedItems = buildRenderedPresentationScheduleItems({ organizer, sourceItems: [] });
  const untickedParent = untickedItems.find((item) => item.nodeId === "manual:supply");
  const untickedOuterGroup = untickedItems.find((item) => item.nodeId === "group:outer");
  assert.ok(untickedParent);
  assert.ok(untickedOuterGroup);
  assert.equal(untickedOuterGroup.totalPrice, 0);
  assert.equal(untickedParent.unitPrice, 105);
  assert.equal(untickedParent.totalPrice, 210);
  assert.equal(untickedParent.unitCost, 52);
  assert.equal(untickedParent.totalCost, 104);
});

test("manual source rollups keep fixed child rows outside parent quantity scaling", () => {
  const organizer = {
    root: ["manual:edging"],
    nodes: {
      "manual:edging": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-edging",
        labelOverride: "Block edging supply and install",
        quantity: 10,
        unit: "m",
        sellRate: 0,
        buyRate: 0,
        children: ["manual:labour", "manual:admin"],
      },
      "manual:labour": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-labour",
        labelOverride: "Labour",
        quantity: 5,
        unit: "min",
        sellRate: 1.333333,
        buyRate: 0.833333,
        applicationMode: "proportional",
        children: [],
      },
      "manual:admin": {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        sourceCode: "manual-admin",
        labelOverride: "Admin Fee",
        quantity: 1,
        unit: "each",
        sellRate: 300,
        buyRate: 200,
        applicationMode: "fixed",
        children: [],
      },
    },
  };

  const items = buildRenderedPresentationScheduleItems({ organizer, sourceItems: [] });
  const parent = items.find((item) => item.nodeId === "manual:edging");
  assert.ok(parent);
  assert.equal(parent.totalPrice, 366.7);
  assert.equal(parent.totalCost, 241.7);
  assert.equal(parent.unitPrice, 36.67);
  assert.equal(parent.unitCost, 24.17);
});

test("isolated source reset leaves sibling and ancestor overrides intact", () => {
  const organizer = makeNestedFixture({
    topOverride: { price: 1000, cost: 400 },
    leafOverride: {
      a: { price: 300, cost: 120 },
      b: { price: 200, cost: 80 },
    },
  });

  // Simulate the source-level reset handler: only touch the single node.
  delete organizer.nodes["src:a"].priceOverride;
  delete organizer.nodes["src:a"].costOverride;

  assert.equal(organizer.nodes["src:a"].priceOverride, undefined);
  assert.equal(organizer.nodes["src:b"].priceOverride, 200, "sibling source override must survive");
  assert.equal(organizer.nodes["group:top"].priceOverride, 1000, "ancestor override must survive");
  assert.equal(organizerSubtreeHasOverride(organizer, "group:top"), true);
});
