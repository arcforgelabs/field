import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommercialAdjustmentKey,
  canonicalizeQuoteOverrides,
  findCommercialAdjustmentForLineItem,
  mergeCommercialAdjustments,
  mergePresentationOverrides,
} from "./quote-commercial-adjustments.js";
import { generateEvidenceQuote } from "./generate-evidence-quote.js";
import { refreshQuoteCatalogAuthority } from "./quote-catalogs.js";
import { closeTestPriceCatalogs, createTestPriceCatalog } from "./test-price-catalog.js";

// Rule rates come only from the price catalogue: overlay the quote catalog
// from the fixture catalogue for tests that build quotes.
async function withFixturePricing(run) {
  const { store } = await createTestPriceCatalog();
  await refreshQuoteCatalogAuthority({ priceCatalog: store, required: false });
  try {
    return await run();
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await closeTestPriceCatalogs();
  }
}

test("canonicalizeQuoteOverrides lifts legacy line-item rates into commercial adjustments", () => {
  const overrides = canonicalizeQuoteOverrides({
    lineItems: {
      "misc-site-works__section-concrete-demolition": {
        quantity: 2,
        unitPrice: 940,
        notes: "Reviewed demolition uplift",
      },
    },
  });

  assert.equal(overrides.lineItems["misc-site-works__section-concrete-demolition"].quantity, 2);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      overrides.lineItems["misc-site-works__section-concrete-demolition"],
      "unitPrice"
    ),
    false
  );
  assert.deepEqual(overrides.commercialAdjustments, [
    {
      id: "line:misc-site-works__section-concrete-demolition",
      kind: "set_unit_price",
      target: {
        lineItemCode: "misc-site-works__section-concrete-demolition",
        quoteCatalogItemCode: "misc-site-works",
        section: "concrete demolition",
      },
      unitPrice: 940,
      unitCost: null,
      notes: "Reviewed demolition uplift",
      source: "legacy_line_item_override",
      createdAt: null,
      updatedAt: null,
      remove: false,
    },
  ]);
});

test("mergeCommercialAdjustments updates and removes adjustments by stable target key", () => {
  const key = buildCommercialAdjustmentKey({
    quoteCatalogItemCode: "misc-site-works",
    section: "Concrete demolition",
  });

  const merged = mergeCommercialAdjustments(
    [
      {
        id: key,
        kind: "set_unit_price",
        target: {
          quoteCatalogItemCode: "misc-site-works",
          section: "Concrete demolition",
        },
        unitPrice: 940,
      },
    ],
    [
      {
        target: {
          quoteCatalogItemCode: "misc-site-works",
          section: "Concrete demolition",
        },
        unitPrice: 980,
      },
    ]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].unitPrice, 980);

  const removed = mergeCommercialAdjustments(merged, [
    {
      target: {
        quoteCatalogItemCode: "misc-site-works",
        section: "Concrete demolition",
      },
      remove: true,
    },
  ]);

  assert.deepEqual(removed, []);
});

test("findCommercialAdjustmentForLineItem prefers exact line-item code then rule plus section", () => {
  const adjustments = [
    {
      target: {
        quoteCatalogItemCode: "misc-site-works",
        section: "Concrete demolition",
      },
      unitPrice: 940,
    },
    {
      target: {
        lineItemCode: "misc-site-works__section-concrete-demolition",
      },
      unitPrice: 975,
    },
  ];

  const exact = findCommercialAdjustmentForLineItem(adjustments, {
    lineItemCode: "misc-site-works__section-concrete-demolition",
    quoteCatalogItemCode: "misc-site-works",
    section: "Concrete demolition",
  });
  assert.equal(exact.unitPrice, 975);

  const fallback = findCommercialAdjustmentForLineItem(adjustments.slice(0, 1), {
    lineItemCode: "misc-site-works__section-concrete-demolition",
    quoteCatalogItemCode: "misc-site-works",
    section: "Concrete demolition",
  });
  assert.equal(fallback.unitPrice, 940);
});

test("normalizeCommercialAdjustment accepts unitCost alone without unitPrice", () => {
  const normalized = mergeCommercialAdjustments([], [
    {
      target: {
        quoteCatalogItemCode: "misc-site-works",
        section: "Concrete demolition",
      },
      unitCost: 480,
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].unitPrice, null);
  assert.equal(normalized[0].unitCost, 480);
});

test("normalizeCommercialAdjustment accepts unitPrice and unitCost together as independent fields", () => {
  const normalized = mergeCommercialAdjustments([], [
    {
      target: {
        quoteCatalogItemCode: "misc-site-works",
        section: "Concrete demolition",
      },
      unitPrice: 940,
      unitCost: 480,
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].unitPrice, 940);
  assert.equal(normalized[0].unitCost, 480);
});

test("normalizeCommercialAdjustment allows unitCost of zero as an explicit override", () => {
  const normalized = mergeCommercialAdjustments([], [
    {
      target: { quoteCatalogItemCode: "misc-site-works" },
      unitCost: 0,
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].unitCost, 0);
});

test("mergeCommercialAdjustments preserves unitCost on subsequent unitPrice edits", () => {
  const initial = mergeCommercialAdjustments([], [
    {
      target: { quoteCatalogItemCode: "misc-site-works" },
      unitCost: 480,
    },
  ]);
  const merged = mergeCommercialAdjustments(initial, [
    {
      target: { quoteCatalogItemCode: "misc-site-works" },
      unitPrice: 940,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].unitPrice, 940);
  assert.equal(merged[0].unitCost, 480);
});

test("mergePresentationOverrides preserves organizer across re-versioning when incoming patch omits it", () => {
  const existing = {
    organizer: {
      root: ["source:soil-removal"],
      nodes: {
        "source:soil-removal": {
          kind: "source",
          sourceCode: "soil-removal",
          labelOverride: "Site prep",
          costOverride: 480,
        },
      },
    },
    scopeText: "Original scope",
  };

  const merged = mergePresentationOverrides(existing, { validityDays: 30 });

  assert.ok(merged, "expected merged overrides");
  assert.deepEqual(merged.organizer.root, ["source:soil-removal"]);
  assert.equal(merged.organizer.nodes["source:soil-removal"].costOverride, 480);
  assert.equal(merged.organizer.nodes["source:soil-removal"].labelOverride, "Site prep");
  assert.equal(merged.scopeText, "Original scope");
  assert.equal(merged.validityDays, 30);
});

test("mergePresentationOverrides lets an explicit organizer update replace the previous one", () => {
  const existing = {
    organizer: {
      root: ["source:old"],
      nodes: {
        "source:old": { kind: "source", sourceCode: "old" },
      },
    },
  };

  const merged = mergePresentationOverrides(existing, {
    organizer: {
      root: ["source:new"],
      nodes: {
        "source:new": { kind: "source", sourceCode: "new" },
      },
    },
  });

  assert.deepEqual(merged.organizer.root, ["source:new"]);
  assert.equal(merged.organizer.nodes["source:new"].sourceCode, "new");
  assert.equal(merged.organizer.nodes["source:old"], undefined);
});

test("generateEvidenceQuote applies commercial adjustments without treating them as catalog authority", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: {
      id: "job-commercial-adjustment",
      quoteCatalogId: "default",
      quoteCatalogId: "default",
    },
    transcript: null,
    quoteInputs: {
      summary: "Concrete demolition",
      lineItemCandidates: [
        {
          label: "Concrete demolition",
          quoteCatalogItemCode: "misc-site-works",
          quantity: 2,
          unit: "ea",
          section: "Concrete demolition",
          confidence: 0.98,
          rationale: "Manual scope",
          evidence: [],
          evidenceSummary: [],
        },
      ],
      exclusions: [],
      assumptions: [],
      missingInputs: [],
      pricingIssues: [],
      reviewFlags: [],
      customerQuestions: [],
      sourceTranscriptPath: null,
      sourceRecordingPath: null,
      measurementSummary: null,
    },
    overrides: {
      commercialAdjustments: [
        {
          target: {
            quoteCatalogItemCode: "misc-site-works",
            section: "Concrete demolition",
          },
          unitPrice: 940,
          notes: "Reviewed demolition uplift",
        },
      ],
    },
  });

  const item = quote.lineItems.find((entry) => entry.section === "Concrete demolition");
  assert.ok(item, "expected demolition line item");
  assert.equal(item.authorityUnitPrice, 650);
  assert.equal(item.unitPrice, 940);
  assert.equal(item.commercialAdjustment?.notes, "Reviewed demolition uplift");
}));

test("generateEvidenceQuote applies unitCost overrides to line item totalCost", async () => withFixturePricing(async () => {
  const quote = generateEvidenceQuote({
    meta: {
      id: "job-cost-override",
      quoteCatalogId: "default",
    },
    transcript: null,
    quoteInputs: {
      summary: "Concrete demolition with manual cost override",
      lineItemCandidates: [
        {
          label: "Concrete demolition",
          quoteCatalogItemCode: "misc-site-works",
          quantity: 1,
          unit: "job",
          section: "Concrete demolition",
          confidence: 0.95,
          rationale: "Manual scope with operator cost override",
          evidence: [],
          evidenceSummary: [],
        },
      ],
      exclusions: [],
      assumptions: [],
      missingInputs: [],
      pricingIssues: [],
      reviewFlags: [],
      customerQuestions: [],
      sourceTranscriptPath: null,
      sourceRecordingPath: null,
      measurementSummary: null,
    },
    overrides: {
      commercialAdjustments: [
        {
          target: {
            quoteCatalogItemCode: "misc-site-works",
            section: "Concrete demolition",
          },
          unitCost: 420,
          notes: "Cost override from operator",
        },
      ],
    },
  });

  const item = quote.lineItems.find((entry) => entry.section === "Concrete demolition");
  assert.ok(item, "expected demolition line item");
  assert.equal(item.quantity, 1);
  assert.equal(item.unitCost, 420);
  assert.equal(item.totalCost, 420);
  assert.equal(item.commercialAdjustment?.unitCost, 420);
}));

test("generateEvidenceQuote lets unitPrice and unitCost overrides coexist on the same line", () => {
  const quote = generateEvidenceQuote({
    meta: {
      id: "job-both-overrides",
      quoteCatalogId: "default",
    },
    transcript: null,
    quoteInputs: {
      summary: "Concrete demolition with price and cost override",
      lineItemCandidates: [
        {
          label: "Concrete demolition",
          quoteCatalogItemCode: "misc-site-works",
          quantity: 1,
          unit: "job",
          section: "Concrete demolition",
          confidence: 0.95,
          rationale: "Manual scope with full commercial override",
          evidence: [],
          evidenceSummary: [],
        },
      ],
      exclusions: [],
      assumptions: [],
      missingInputs: [],
      pricingIssues: [],
      reviewFlags: [],
      customerQuestions: [],
      sourceTranscriptPath: null,
      sourceRecordingPath: null,
      measurementSummary: null,
    },
    overrides: {
      commercialAdjustments: [
        {
          target: {
            quoteCatalogItemCode: "misc-site-works",
            section: "Concrete demolition",
          },
          unitPrice: 940,
          unitCost: 480,
        },
      ],
    },
  });

  const item = quote.lineItems.find((entry) => entry.section === "Concrete demolition");
  assert.ok(item, "expected demolition line item");
  assert.equal(item.quantity, 1);
  assert.equal(item.unitPrice, 940);
  assert.equal(item.totalPrice, 940);
  assert.equal(item.unitCost, 480);
  assert.equal(item.totalCost, 480);
});
