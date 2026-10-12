import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPresentationToQuote,
  getCustomerFacingTotal,
  getCustomerPresentationFinancials,
  getCustomerScheduleItems,
  getCustomerSourceScheduleItems,
} from "./quote-presentation.js";
import {
  buildPresentationSourceNodeId,
  resolvePresentationOrganizer,
} from "./quote-presentation-organizer.js";

test("applyPresentationToQuote renders presentation organizer rows without mutating quote pricing truth", () => {
  const quote = applyPresentationToQuote({
    quote: {
      summary: "Default scoped work",
      lineItems: [
        {
          code: "cs-wall",
          label: "Concrete Sleeper Wall — Supply & Install",
          customerLabel: "Concrete Sleeper Wall — Supply & Install",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          section: "Retaining wall",
          customerVisible: true,
        },
        {
          code: "drainage",
          label: "Drainage & backing",
          customerLabel: "Drainage & backing",
          quantity: 1,
          unit: "lot",
          unitPrice: 25,
          totalPrice: 25,
          section: "Retaining wall",
          customerVisible: true,
        },
      ],
    },
    overrides: {
      presentation: {
        scopeText: "Custom scope text",
        organizer: {
          root: ["group:retaining-wall"],
          nodes: {
            "group:retaining-wall": {
              kind: "group",
              label: "Retaining wall package",
              collapsed: false,
              amountVisible: true,
              children: [
                buildPresentationSourceNodeId("cs-wall"),
                buildPresentationSourceNodeId("drainage"),
              ],
            },
            [buildPresentationSourceNodeId("cs-wall")]: {
              kind: "source",
              sourceCode: "cs-wall",
              labelOverride: "Concrete sleeper wall",
              amountVisible: true,
            },
            [buildPresentationSourceNodeId("drainage")]: {
              kind: "source",
              sourceCode: "drainage",
              amountVisible: false,
            },
          },
        },
      },
    },
  });

  assert.equal(quote.summary, "Custom scope text");
  assert.equal(quote.presentation.scopeText, "Custom scope text");
  assert.deepEqual(
    quote.presentation.sourceItems.map((item) => [item.code, item.section]),
    [
      ["cs-wall", "Retaining wall"],
      ["drainage", "Retaining wall"],
    ]
  );
  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [
      item.label,
      item.totalPrice,
      item.depth,
      item.amountVisible,
      item.section || null,
    ]),
    [
      ["Retaining wall package", 125, 0, true, "Retaining wall"],
      ["Concrete sleeper wall", 100, 1, true, "Retaining wall"],
      ["Drainage & backing", 25, 1, false, "Retaining wall"],
    ]
  );
});

test("applyPresentationToQuote keeps hidden support line items as separate source rows", () => {
  const quote = applyPresentationToQuote({
    quote: {
      lineItems: [
        {
          code: "visible-scope",
          label: "Visible scope",
          customerLabel: "Visible scope",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          section: "Main Works",
          customerVisible: true,
        },
        {
          code: "hidden-support",
          label: "Hidden support",
          customerLabel: "Hidden support",
          quantity: 1,
          unit: "lot",
          unitPrice: 25,
          totalPrice: 25,
          section: null,
          customerVisible: false,
        },
      ],
    },
  });

  assert.deepEqual(
    quote.presentation.sourceItems.map((item) => [item.code, item.totalPrice, item.amountVisible]),
    [
      ["visible-scope", 100, true],
      ["hidden-support", 25, false],
    ]
  );
  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [item.label, item.totalPrice, item.amountVisible]),
    [
      ["Visible scope", 100, true],
      ["Hidden support", 25, false],
    ]
  );
});

test("resolvePresentationOrganizer drops missing source references and restores surviving rows to default root order", () => {
  const organizer = resolvePresentationOrganizer({
    sourceItems: [
      { code: "cs-wall", label: "Concrete Sleeper Wall" },
      { code: "drainage", label: "Drainage & backing" },
    ],
    organizer: {
      root: ["group:retaining-wall"],
      nodes: {
        "group:retaining-wall": {
          kind: "group",
          label: "Retaining wall package",
          children: [
            buildPresentationSourceNodeId("removed-row"),
          ],
        },
        [buildPresentationSourceNodeId("removed-row")]: {
          kind: "source",
          sourceCode: "removed-row",
          labelOverride: "Removed row",
        },
      },
    },
  });

  assert.deepEqual(organizer.root, [
    "group:retaining-wall",
    buildPresentationSourceNodeId("cs-wall"),
    buildPresentationSourceNodeId("drainage"),
  ]);
  assert.deepEqual(
    Object.keys(organizer.nodes).sort(),
    [
      buildPresentationSourceNodeId("cs-wall"),
      buildPresentationSourceNodeId("drainage"),
      "group:retaining-wall",
    ].sort()
  );
  assert.deepEqual(organizer.nodes["group:retaining-wall"].children, []);
});

test("applyPresentationToQuote preserves deleted engine source rows as organizer tombstones", () => {
  const keptNodeId = buildPresentationSourceNodeId("kept-row");
  const removedNodeId = buildPresentationSourceNodeId("removed-row");
  const quote = applyPresentationToQuote({
    quote: {
      quoteCatalog: {
        gstRate: 0.1,
      },
      lineItems: [
        {
          code: "kept-row",
          label: "Kept row",
          customerLabel: "Kept row",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          totalCost: 40,
          customerVisible: true,
        },
        {
          code: "removed-row",
          label: "Removed row",
          customerLabel: "Removed row",
          quantity: 1,
          unit: "lot",
          unitPrice: 50,
          totalPrice: 50,
          totalCost: 20,
          customerVisible: true,
        },
      ],
    },
    overrides: {
      presentation: {
        organizer: {
          root: [keptNodeId],
          removedSourceCodes: ["removed-row"],
          nodes: {
            [keptNodeId]: {
              kind: "source",
              sourceCode: "kept-row",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(quote.presentation.organizer.root, [keptNodeId]);
  assert.deepEqual(quote.presentation.organizer.removedSourceCodes, ["removed-row"]);
  assert.equal(quote.presentation.organizer.nodes[removedNodeId], undefined);
  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [item.nodeId, item.label, item.totalPrice]),
    [[keptNodeId, "Kept row", 100]]
  );
  assert.equal(getCustomerFacingTotal(quote), 110);
});

test("applyPresentationToQuote emits deterministic customer components without leaking them into source-only sync rows", () => {
  const quote = applyPresentationToQuote({
    quote: {
      lineItems: [
        {
          code: "cs-wall",
          label: "Concrete Sleeper Wall — Supply & Install",
          customerLabel: "Concrete Sleeper Wall — Supply & Install",
          quantity: 1,
          unit: "lot",
          unitPrice: 121,
          totalPrice: 121,
          section: "Retaining wall",
          customerVisible: true,
          workDomain: "retaining_wall",
        },
      ],
      internalPricing: {
        lineItemBreakdowns: [
          {
            sourceLineItemCode: "cs-wall",
            recipe: "retaining_wall_exact",
            commercialLines: [
              { code: "c1", itemCode: "SLEEPER-KENSINGTON", label: "Kensington Sleeper", totalPrice: 10, category: "materials" },
              { code: "c2", itemCode: "STEEL-CCHANNEL-125-GALV-2200", label: "C-Channel 125 Galv 2200mm", totalPrice: 15, category: "materials" },
              { code: "c3", itemCode: "STEEL-IBEAM-125-GALV-2200", label: "I-Beam 125 Galv 2200mm", totalPrice: 5, category: "materials" },
              { code: "c4", itemCode: "CONCRETE-20KG-BAG", label: "Concrete 20kg Bag", totalPrice: 8, category: "materials" },
              { code: "c5", itemCode: "AGPIPE-BAY", label: "Ag Pipe", totalPrice: 3, category: "materials" },
              { code: "c6", itemCode: "GRAVEL-20MM", label: "20mm Gravel", totalPrice: 4, category: "materials" },
              { code: "c7", itemCode: "EXCAVATOR-HOUR", label: "Excavator Hour", totalPrice: 40, category: "machines" },
              { code: "c8", itemCode: "LABOURER-HOUR", label: "General Labourer Hour", totalPrice: 30, category: "labour" },
              { code: "c9", itemCode: "VEHICLE-HOUR", label: "Vehicle Hour", totalPrice: 6, category: "overhead" },
            ],
          },
        ],
      },
    },
  });

  assert.deepEqual(
    quote.presentation.sourceItems[0].components.map((component) => [component.label, component.totalPrice]),
    [
      ["Concrete sleepers", 10],
      ["Steel posts & channels", 20],
      ["Concrete & footings", 8],
      ["Drainage & backing", 7],
      ["Excavation", 40],
      ["Labour", 30],
      ["Delivery & transport", 6],
    ]
  );

  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [item.kind || "source", item.sourceKind || null, item.label, item.depth || 0]),
    [
      ["source", "customer_schedule_item", "Concrete Sleeper Wall — Supply & Install", 0],
      ["source", "generated_component", "Concrete sleepers", 1],
      ["source", "generated_component", "Steel posts & channels", 1],
      ["source", "generated_component", "Concrete & footings", 1],
      ["source", "generated_component", "Drainage & backing", 1],
      ["source", "generated_component", "Excavation", 1],
      ["source", "generated_component", "Labour", 1],
      ["source", "generated_component", "Delivery & transport", 1],
    ]
  );

  assert.deepEqual(
    getCustomerSourceScheduleItems(quote).map((item) => item.code),
    ["cs-wall"]
  );
});

test("nested source rows roll child totals into the parent rendered row", () => {
  const parentNodeId = buildPresentationSourceNodeId("parent");
  const childNodeId = buildPresentationSourceNodeId("child");
  const quote = applyPresentationToQuote({
    quote: {
      lineItems: [
        {
          code: "parent",
          label: "Large soil removal",
          customerLabel: "Large soil removal",
          quantity: 1,
          unit: "lot",
          unitPrice: 3455.28,
          totalPrice: 3455.28,
          section: "Demolition and site leveling",
          customerVisible: true,
        },
        {
          code: "child",
          label: "Small soil removal",
          customerLabel: "Small soil removal",
          quantity: 1,
          unit: "lot",
          unitPrice: 263.22,
          totalPrice: 263.22,
          section: "Demolition and site leveling",
          customerVisible: true,
        },
      ],
    },
    overrides: {
      presentation: {
        organizer: {
          root: [parentNodeId],
          nodes: {
            [parentNodeId]: {
              kind: "source",
              sourceCode: "parent",
              amountVisible: true,
              children: [childNodeId],
            },
            [childNodeId]: {
              kind: "source",
              sourceCode: "child",
              amountVisible: true,
            },
          },
        },
      },
    },
  });

  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [item.label, item.totalPrice, item.depth]),
    [
      ["Large soil removal", 3718.5, 0],
      ["Small soil removal", 263.22, 1],
    ]
  );
  assert.deepEqual(
    quote.presentation.sourceItems.map((item) => [item.label, item.totalPrice]),
    [
      ["Large soil removal", 3455.28],
      ["Small soil removal", 263.22],
    ]
  );
  assert.equal(getCustomerFacingTotal(quote), 4090.35);
});

test("resolvePresentationOrganizer preserves manual source nodes, overrides, and children", () => {
  const organizer = resolvePresentationOrganizer({
    sourceItems: [],
    organizer: {
      root: ["manual:custom-item"],
      nodes: {
        "manual:custom-item": {
          kind: "source",
          sourceKind: "manual",
          sourceCode: "manual-item-1",
          labelOverride: "Manual item",
          manualPrice: 150,
          manualCost: 90,
          priceOverride: 175,
          costOverride: 95,
          collapsed: true,
          children: ["group:child"],
        },
        "group:child": {
          kind: "group",
          label: "Nested group",
          children: [],
        },
      },
    },
  });

  assert.deepEqual(organizer.root, ["manual:custom-item"]);
  assert.deepEqual(organizer.nodes["manual:custom-item"], {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: "manual-item-1",
    labelOverride: "Manual item",
    amountVisible: true,
    manualPrice: 150,
    manualCost: 90,
    priceOverride: 175,
    costOverride: 95,
    collapsed: true,
    children: ["group:child"],
  });
});

test("applyPresentationToQuote preserves catalog-linked manual row rates in organizer and totals", () => {
  const quote = applyPresentationToQuote({
    quote: {
      summary: "Default scoped work",
      lineItems: [],
    },
    overrides: {
      presentation: {
        organizer: {
          root: ["manual:catalog-row"],
          nodes: {
            "manual:catalog-row": {
              kind: "source",
              origin: "manual",
              sourceCode: "manual-admin-fee",
              labelOverride: "Admin Fee",
              quantity: 10,
              unit: "nos",
              sellRate: 300,
              buyRate: 200,
              rateMode: "catalog-linked",
              catalogItemCode: "ADMIN-FEE",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(quote.presentation.organizer.nodes["manual:catalog-row"], {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: "manual-admin-fee",
    labelOverride: "Admin Fee",
    amountVisible: true,
    children: [],
    manualPrice: 0,
    manualCost: 0,
    quantity: 10,
    unit: "each",
    sellRate: 300,
    buyRate: 200,
    rateMode: "catalog-linked",
    catalogItemCode: "ADMIN-FEE",
  });
  assert.deepEqual(
    quote.presentation.scheduleItems.map((item) => [item.label, item.totalPrice, item.totalCost]),
    [["Admin Fee", 3000, 2000]]
  );
});

test("manual-only quotes do not rehydrate manual rows as duplicate engine rows", () => {
  const quote = applyPresentationToQuote({
    quote: {
      quoteCatalog: {
        gstRate: 0.1,
      },
      summary: "Manual quote draft",
      lineItems: [],
    },
    overrides: {
      presentation: {
        organizer: {
          root: ["manual:admin-fee"],
          nodes: {
            "manual:admin-fee": {
              kind: "source",
              origin: "manual",
              sourceCode: "manual-admin-fee",
              labelOverride: "Admin Fee",
              quantity: 1,
              unit: "nos",
              sellRate: 300,
              buyRate: 200,
              rateMode: "catalog-linked",
              catalogItemCode: "ADMIN-FEE",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(
    quote.presentation.scheduleItems.map((item) => [item.nodeId, item.origin, item.label, item.totalPrice]),
    [["manual:admin-fee", "manual", "Admin Fee", 300]]
  );
  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [item.nodeId, item.sourceKind, item.origin, item.label, item.totalPrice]),
    [["manual:admin-fee", "manual", "manual", "Admin Fee", 300]]
  );
  assert.deepEqual(getCustomerPresentationFinancials(quote), {
    charge: 300,
    cost: 200,
    subtotal: 300,
    gst: 30,
    total: 330,
  });
});

test("GST on a subtotal that lands on exactly half a cent rounds up to the cent (#2)", () => {
  const quote = applyPresentationToQuote({
    quote: { quoteCatalog: { gstRate: 0.1 }, summary: "Half-cent GST", lineItems: [] },
    overrides: {
      presentation: {
        organizer: {
          root: ["manual:fee"],
          nodes: {
            "manual:fee": {
              kind: "source",
              origin: "manual",
              sourceCode: "manual-fee",
              labelOverride: "Fee",
              quantity: 1,
              unit: "nos",
              sellRate: 21.15,
              buyRate: 10,
              rateMode: "catalog-linked",
              catalogItemCode: "FEE",
            },
          },
        },
      },
    },
  });
  // 21.15 × 0.1 is 2.1149999999999998 in floating point, which used to print $2.11.
  assert.deepEqual(getCustomerPresentationFinancials(quote), {
    charge: 21.15,
    cost: 10,
    subtotal: 21.15,
    gst: 2.12,
    total: 23.27,
  });
});

test("source overrides replace nested subtree totals instead of adding on top of children", () => {
  const parentNodeId = buildPresentationSourceNodeId("parent");
  const childNodeId = buildPresentationSourceNodeId("child");
  const quote = applyPresentationToQuote({
    quote: {
      quoteCatalog: {
        gstRate: 0.1,
      },
      lineItems: [
        {
          code: "parent",
          label: "Parent scope",
          customerLabel: "Parent scope",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          totalCost: 50,
          customerVisible: true,
        },
        {
          code: "child",
          label: "Child scope",
          customerLabel: "Child scope",
          quantity: 1,
          unit: "lot",
          unitPrice: 25,
          totalPrice: 25,
          totalCost: 10,
          customerVisible: true,
        },
      ],
    },
    overrides: {
      presentation: {
        organizer: {
          root: [parentNodeId],
          nodes: {
            [parentNodeId]: {
              kind: "source",
              sourceCode: "parent",
              priceOverride: 150,
              costOverride: 80,
              children: [childNodeId],
            },
            [childNodeId]: {
              kind: "source",
              sourceCode: "child",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [item.label, item.totalPrice, item.totalCost]),
    [
      ["Parent scope", 150, 80],
      ["Child scope", 25, 10],
    ]
  );
  assert.equal(getCustomerFacingTotal(quote), 165);
});

test("group overrides replace rolled-up subtree totals", () => {
  const parentNodeId = buildPresentationSourceNodeId("parent");
  const childNodeId = buildPresentationSourceNodeId("child");
  const quote = applyPresentationToQuote({
    quote: {
      quoteCatalog: {
        gstRate: 0.1,
      },
      lineItems: [
        {
          code: "parent",
          label: "Parent scope",
          customerLabel: "Parent scope",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          totalCost: 50,
          customerVisible: true,
        },
        {
          code: "child",
          label: "Child scope",
          customerLabel: "Child scope",
          quantity: 1,
          unit: "lot",
          unitPrice: 25,
          totalPrice: 25,
          totalCost: 10,
          customerVisible: true,
        },
      ],
    },
    overrides: {
      presentation: {
        organizer: {
          root: ["group:package"],
          nodes: {
            "group:package": {
              kind: "group",
              label: "Package",
              priceOverride: 150,
              costOverride: 80,
              children: [parentNodeId, childNodeId],
            },
            [parentNodeId]: {
              kind: "source",
              sourceCode: "parent",
            },
            [childNodeId]: {
              kind: "source",
              sourceCode: "child",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [item.label, item.totalPrice, item.totalCost]),
    [
      ["Package", 150, 80],
      ["Parent scope", 100, 50],
      ["Child scope", 25, 10],
    ]
  );
  assert.equal(getCustomerFacingTotal(quote), 165);
});

test("customer presentation readers rebuild from canonical quote inputs instead of trusting stale persisted rows", () => {
  const wallNodeId = buildPresentationSourceNodeId("cs-wall");
  const drainageNodeId = buildPresentationSourceNodeId("drainage");
  const quote = applyPresentationToQuote({
    quote: {
      lineItems: [
        {
          code: "cs-wall",
          label: "Concrete Sleeper Wall — Supply & Install",
          customerLabel: "Concrete Sleeper Wall — Supply & Install",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          section: "Retaining wall",
          customerVisible: true,
        },
        {
          code: "drainage",
          label: "Drainage & backing",
          customerLabel: "Drainage & backing",
          quantity: 1,
          unit: "lot",
          unitPrice: 25,
          totalPrice: 25,
          section: "Retaining wall",
          customerVisible: true,
        },
      ],
    },
    overrides: {
      presentation: {
        organizer: {
          root: ["group:retaining-wall"],
          nodes: {
            "group:retaining-wall": {
              kind: "group",
              label: "Retaining wall package",
              children: [wallNodeId, drainageNodeId],
            },
            [wallNodeId]: {
              kind: "source",
              sourceCode: "cs-wall",
              labelOverride: "Concrete sleeper wall",
            },
            [drainageNodeId]: {
              kind: "source",
              sourceCode: "drainage",
              amountVisible: false,
            },
          },
        },
      },
    },
  });

  quote.presentation.sourceItems = [
    {
      code: "stale-source",
      label: "Stale source row",
      quantity: 1,
      unit: "lot",
      unitPrice: 999,
      totalPrice: 999,
      kind: "source",
    },
  ];
  quote.presentation.scheduleItems = [
    {
      code: "stale-group",
      label: "Stale grouped row",
      quantity: 1,
      unit: "lot",
      unitPrice: 999,
      totalPrice: 999,
      kind: "group",
      depth: 0,
    },
  ];

  assert.deepEqual(
    getCustomerSourceScheduleItems(quote).map((item) => [item.code, item.totalPrice]),
    [
      ["cs-wall", 100],
      ["drainage", 25],
    ]
  );
  assert.deepEqual(
    getCustomerScheduleItems(quote).map((item) => [item.label, item.totalPrice, item.depth, item.amountVisible]),
    [
      ["Retaining wall package", 125, 0, true],
      ["Concrete sleeper wall", 100, 1, true],
      ["Drainage & backing", 25, 1, false],
    ]
  );
});
