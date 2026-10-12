import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInternalBreakdownMarkdown,
} from "./quote-internal-breakdown.js";
import { normalizeStructuredTrace } from "./quote-trace.js";

test("internal breakdown markdown renders line item maths and material orders", () => {
  const markdown = buildInternalBreakdownMarkdown({
    meta: {
      id: "job-123",
      title: "Test Job",
      jobNumber: "JOB-123",
    },
    quote: {
      quoteNumber: "EQ-2603-99",
      jobNumber: "JOB-123",
      lineItems: [
        {
          code: "drainage",
          label: "Drainage installation",
          section: "Drainage",
          quantity: 12,
          unit: "lm",
          unitPrice: 145,
          totalPrice: 1740,
          quoteCatalogItemCode: "drainage",
          quoteCatalogEntry: {
            code: "drainage",
            quoteCatalogId: "embark-default",
            authorityItemCode: "DRAINAGE-INSTALL",
          },
          evidence: [
            {
              segmentId: "seg-1",
              start: 12,
              end: 21,
              speaker: "Alex",
              snippet: "Drainage run confirmed on site.",
            },
          ],
        },
      ],
      totals: {
        subtotal: 1740,
        gst: 174,
        total: 1914,
      },
      internalPricing: {
        mode: "flat_quote",
        totals: {
          charge: 1740,
          cost: 1224,
        },
        coverage: {
          sourceLineItemCount: 1,
          exactRecipeCount: 1,
          directPassThroughCount: 0,
        },
        lineItemBreakdowns: [
          {
            sourceLineItemCode: "drainage",
            sourceLineItemLabel: "Drainage installation",
            recipe: "direct_pass_through",
            sourceTotalPrice: 1740,
            totals: {
              charge: 1740,
              cost: 1224,
            },
            commercialLines: [
              {
                code: "drainage::drainage-1",
                itemCode: "drainage",
                description: "Drainage run required.",
                quantity: 12,
                unit: "lm",
                unitPrice: 145,
                unitCost: 102,
                totalPrice: 1740,
                totalCost: 1224,
              },
            ],
            budgetLines: [
              {
                code: "drainage::drainage-1-cost",
                itemCode: "drainage",
                quantity: 12,
                unit: "lm",
                unitPrice: 102,
                totalPrice: 1224,
              },
            ],
            materialOrders: [
              {
                itemCode: "AGPIPE-100",
                label: "Ag pipe",
                quantity: 12,
                unit: "lm",
                unitCost: 48,
                unitPrice: 65,
                sourceLineItemCode: "drainage",
              },
            ],
          },
        ],
      },
    },
  });

  assert.match(markdown, /Internal Pricing Breakdown — Test Job/);
  assert.match(markdown, /Drainage installation/);
  assert.match(markdown, /Gross margin/);
  assert.match(markdown, /AGPIPE-100/);
  assert.match(markdown, /Coverage/);
  assert.match(markdown, /Line Traces/);
  assert.match(markdown, /Quantity Derivation:/);
  assert.match(markdown, /Pricing Math:/);
  assert.match(markdown, /Engine: Quote Commercial Compiler/);
  assert.match(markdown, /Quote inputs JSON/);
});

test("trace normalization keeps quantity provenance separate from pricing totals", () => {
  const trace = normalizeStructuredTrace({
    formulas: [
      {
        label: "Tier classification",
        expression: "0.95 m is below the tier-2 trigger so the bay stays 1 tier.",
      },
      {
        label: "Charge total",
        expression: "5 each × $45.82 / each = $229.10",
      },
      {
        label: "Cost total",
        expression: "5 each × $38.18 / each = $190.90",
      },
    ],
    inputs: [
      { label: "Measured height", value: 0.95, unit: "m" },
    ],
  });

  assert.deepEqual(
    trace.quantityDerivation.map((entry) => entry.label),
    ["Tier classification"],
  );
  assert.deepEqual(
    trace.pricingDerivation.map((entry) => entry.label),
    ["Charge total", "Cost total"],
  );
  assert.equal(trace.inputs[0]?.value, "0.95 m");
});

