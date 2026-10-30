import assert from "node:assert/strict";
import test from "node:test";

import {
  getDisplayableJobReport,
  getDisplayableQuoteMarkdown,
  serializeClientJobDetail,
  sanitizeClientJobMeta,
  sanitizeQuoteDocumentSurfaces,
  sanitizeQuoteForPricingDisplay,
} from "./quote-pricing-visibility.js";
import { projectQuoteForReviewState } from "./quote-review-projection.js";
import { applyPresentationToQuote } from "./quote-presentation.js";
import {
  assertQuoteLineItemCostsComplete,
  buildQuotePricingAttestation,
  attachQuotePricingAttestation,
  buildQuotePricingOutputDigest,
  isQuotePricingDisplayable,
  isQuotePricingSendable,
  listLineItemsMissingCost,
} from "./quote-pricing-attestation.js";

test("sanitizeQuoteForPricingDisplay strips monetary values when pricing is unverified", () => {
  const quote = {
    lineItems: [
      {
        code: "soil-removal",
        quantity: 2,
        unit: "m3",
        authorityUnitPrice: 91.89,
        unitCost: 68.57,
        unitPrice: 91.89,
        totalPrice: 183.78,
      },
    ],
    presentation: {
      scheduleItems: [
        {
          code: "soil-removal",
          quantity: 1,
          unit: "lot",
          unitPrice: 183.78,
          totalPrice: 183.78,
          amountVisible: true,
          components: [
            {
              code: "soil-removal-component",
              quantity: 2,
              unitPrice: 91.89,
              totalPrice: 183.78,
              amountVisible: true,
            },
          ],
        },
      ],
    },
    totals: {
      subtotal: 183.78,
      gst: 18.38,
      total: 202.16,
      currency: "AUD",
    },
    commercialLines: [{ code: "machine", totalPrice: 100 }],
    budgetLines: [{ code: "machine-cost", totalPrice: 80 }],
    materialOrders: [{ code: "material", totalPrice: 20 }],
    internalPricing: {
      totals: {
        cost: 100,
        charge: 183.78,
      },
    },
    pricing: {
      displayable: false,
      sendable: false,
      attestation: {
        status: "unverified",
        requestNonce: "nonce-1",
        verifiedNonce: null,
      },
    },
  };

  const sanitized = sanitizeQuoteForPricingDisplay(quote);

  assert.equal(sanitized.lineItems[0].authorityUnitPrice, null);
  assert.equal(sanitized.lineItems[0].unitCost, null);
  assert.equal(sanitized.lineItems[0].unitPrice, null);
  assert.equal(sanitized.lineItems[0].totalPrice, null);
  assert.equal(sanitized.totals.subtotal, null);
  assert.equal(sanitized.totals.gst, null);
  assert.equal(sanitized.totals.total, null);
  assert.deepEqual(sanitized.commercialLines, []);
  assert.deepEqual(sanitized.budgetLines, []);
  assert.deepEqual(sanitized.materialOrders, []);
  assert.equal(sanitized.internalPricing, null);
  assert.equal(sanitized.presentation.scheduleItems[0].unitPrice, null);
  assert.equal(sanitized.presentation.scheduleItems[0].totalPrice, null);
  assert.equal(sanitized.presentation.scheduleItems[0].amountVisible, false);
  assert.equal(sanitized.presentation.scheduleItems[0].components[0].totalPrice, null);
  assert.equal(sanitized.presentation.scheduleItems[0].components[0].amountVisible, false);
  assert.equal(getDisplayableQuoteMarkdown(quote, "# Quote"), null);
});

test("customer-seen pipeline stages keep locked quote pricing visible", () => {
  const quote = {
    totals: {
      total: 250,
      currency: "AUD",
    },
    pricing: {
      displayable: false,
      sendable: false,
      attestation: {
        status: "unverified",
        requestNonce: "nonce-locked",
        verifiedNonce: null,
      },
    },
  };

  assert.equal(isQuotePricingDisplayable(quote, { pipelineStage: "sent" }), true);
  assert.equal(isQuotePricingDisplayable(quote, { pipelineStage: "landed" }), true);
  assert.equal(isQuotePricingDisplayable(quote, { pipelineStage: "lost" }), true);
  assert.equal(getDisplayableQuoteMarkdown(quote, "# Quote", "landed"), "# Quote");
  assert.equal(sanitizeQuoteForPricingDisplay(quote, "lost"), quote);
  assert.equal(isQuotePricingSendable(quote), false);
});

test("draft quotes still fail closed when pricing attestation is unverified", () => {
  const quote = {
    totals: {
      total: 250,
      currency: "AUD",
    },
    pricing: {
      displayable: false,
      sendable: false,
      attestation: {
        status: "unverified",
        requestNonce: "nonce-draft",
        verifiedNonce: null,
      },
    },
  };

  assert.equal(isQuotePricingDisplayable(quote, { pipelineStage: "draft" }), false);
  assert.equal(getDisplayableQuoteMarkdown(quote, "# Quote", "draft"), null);
  assert.notEqual(sanitizeQuoteForPricingDisplay(quote, "draft"), quote);
});

test("a landed job's newly rebuilt current draft does not inherit historical visibility", () => {
  const quote = {
    totals: { total: 250, currency: "AUD" },
    pricing: { ready: true, displayable: true },
  };
  assert.equal(isQuotePricingDisplayable(quote, { pipelineStage: "landed", current: true }), false);
  assert.equal(getDisplayableQuoteMarkdown(quote, "# Draft", "landed", { current: true }), null);
  const detail = serializeClientJobDetail({
    meta: { outputMode: "quote", pipelineStage: "landed" },
    quote,
    quoteMarkdown: "# Draft",
    report: "# Draft",
  });
  assert.equal(detail.quote.totals.total, null);
  assert.equal(detail.quoteMarkdown, null);
  assert.equal(detail.report, null);
});

test("sanitizeQuoteForPricingDisplay strips future monetary-looking fields by naming convention", () => {
  const quote = {
    lineItems: [
      {
        code: "future-pricing-line",
        sellAmount: 123,
        compositeCharge: 456,
        sellingRate: 200,
        cost_hr: 100,
      },
    ],
    pricing: {
      displayable: false,
      sendable: false,
      attestation: {
        status: "unverified",
        requestNonce: "nonce-3",
        verifiedNonce: null,
      },
    },
  };

  const sanitized = sanitizeQuoteForPricingDisplay(quote);
  assert.equal(sanitized.lineItems[0].sellAmount, null);
  assert.equal(sanitized.lineItems[0].compositeCharge, null);
  assert.equal(sanitized.lineItems[0].sellingRate, null);
  assert.equal(sanitized.lineItems[0].cost_hr, null);
});

test("sanitizeQuoteForPricingDisplay preserves quotes with verified pricing", () => {
  const quote = {
    totals: {
      total: 250,
      currency: "AUD",
    },
    pricing: {
      displayable: true,
      sendable: true,
      attestation: {
        status: "verified",
        requestNonce: "nonce-2",
        verifiedNonce: "nonce-2",
      },
    },
  };

  assert.equal(sanitizeQuoteForPricingDisplay(quote), quote);
  assert.equal(getDisplayableQuoteMarkdown(quote, "# Quote"), "# Quote");
});

test("quotes without pricing metadata fail closed for display and send actions", () => {
  const quote = {
    totals: {
      total: 250,
      currency: "AUD",
    },
  };

  assert.equal(isQuotePricingDisplayable(quote), false);
  assert.equal(isQuotePricingSendable(quote), false);
});

test("quote report aliases stay hidden when draft pricing is unverified", () => {
  const quote = {
    totals: { total: 250, currency: "AUD" },
    pricing: {
      displayable: false,
      sendable: false,
      attestation: {
        status: "unverified",
        requestNonce: "nonce-report",
        verifiedNonce: null,
      },
    },
  };
  const report = "# Quote\n\nTotal: $250.00";

  assert.equal(
    getDisplayableJobReport({
      meta: { outputMode: "quote", pipelineStage: "draft" },
      quote,
      report,
    }),
    null,
  );
  const detail = sanitizeQuoteDocumentSurfaces({
    meta: { outputMode: "quote", pipelineStage: "draft" },
    quote,
    quoteMarkdown: report,
    report,
  });
  assert.equal(detail.quoteMarkdown, null);
  assert.equal(detail.report, null);
});

test("ordinary task reports remain available and sent quote reports stay visible", () => {
  const report = "# Work report\n\nTotal: $250.00";
  assert.equal(
    getDisplayableJobReport({ meta: { outputMode: "report" }, report }),
    report,
  );

  const quote = {
    totals: { total: 250, currency: "AUD" },
    pricing: {
      displayable: false,
      attestation: {
        status: "unverified",
        requestNonce: "nonce-sent-report",
        verifiedNonce: null,
      },
    },
  };
  assert.equal(
    getDisplayableJobReport({
      meta: { outputMode: "quote", pipelineStage: "sent" },
      quote,
      report,
    }),
    report,
  );
});

test("listLineItemsMissingCost flags priced lines without a valid cost", () => {
  const quote = {
    lineItems: [
      { code: "ok", label: "OK line", totalPrice: 500, totalCost: 300 },
      { code: "zero", label: "Zero-cost line", totalPrice: 800, totalCost: 0 },
      { code: "null", label: "Null-cost line", totalPrice: 200, totalCost: null },
      { code: "free", label: "Free line", totalPrice: 0, totalCost: 0 },
    ],
  };

  const missing = listLineItemsMissingCost(quote);
  assert.equal(missing.length, 2);
  assert.deepEqual(missing.map((entry) => entry.code), ["zero", "null"]);
});

test("assertQuoteLineItemCostsComplete throws 409 when a priced line is missing cost", () => {
  const quote = {
    lineItems: [
      { code: "broken", label: "Broken line", totalPrice: 1000, totalCost: null },
    ],
  };

  assert.throws(
    () => assertQuoteLineItemCostsComplete(quote),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /Broken line/);
      assert.equal(err.details.missing.length, 1);
      return true;
    }
  );
});

test("assertQuoteLineItemCostsComplete passes when every priced line has a positive cost", () => {
  const quote = {
    lineItems: [
      { code: "ok", label: "OK line", totalPrice: 500, totalCost: 300 },
      { code: "free", label: "Free line", totalPrice: 0, totalCost: 0 },
    ],
  };

  assert.doesNotThrow(() => assertQuoteLineItemCostsComplete(quote));
});

test("pricing attestation only exposes the public authority URL", () => {
  const attestation = buildQuotePricingAttestation({
    authorityStatus: {
      provider: "price_catalog",
      mode: "required",
      baseUrl: "http://authority.internal.test:8080",
      publicBaseUrl: "https://field.example.com",
    },
    livePricingAvailable: true,
    requestNonce: "nonce-4",
  });

  assert.equal(attestation.baseUrl, "https://field.example.com");
});

test("verified pricing attestation is bound to the canonical monetary output", () => {
  const quote = {
    lineItems: [{ code: "scope", quantity: 1, unitPrice: 100, totalPrice: 100 }],
    totals: { subtotal: 100, gst: 10, total: 110, currency: "AUD" },
    pricing: { issues: [], ready: true },
  };
  const attestation = buildQuotePricingAttestation({
    authorityStatus: { provider: "price_catalog", catalogRevision: "r1", snapshotDigest: "s1" },
    livePricingAvailable: true,
    requestNonce: "digest-test",
  });
  const attached = attachQuotePricingAttestation({ quote, attestation });
  assert.equal(attached.pricing.displayable, true);
  assert.equal(attached.pricing.attestation.outputDigest, buildQuotePricingOutputDigest(quote));
  assert.equal(isQuotePricingDisplayable(attached, { current: true }), true);
  const changed = {
    ...attached,
    totals: { ...attached.totals, total: 999 },
  };
  assert.equal(isQuotePricingDisplayable(changed, { current: true }), false);
  const legacyDigestlessV2 = {
    ...attached,
    pricing: {
      ...attached.pricing,
      attestation: { ...attached.pricing.attestation, outputDigest: null },
    },
  };
  assert.equal(isQuotePricingDisplayable(legacyDigestlessV2, { current: true }), false);
});

test("confirmed review preserves verified money without certifying tampered prices", () => {
  const quote = attachQuotePricingAttestation({
    quote: {
      lineItems: [{ code: "scope", quantity: 1, unitPrice: 100, totalPrice: 100 }],
      totals: { subtotal: 100, gst: 10, total: 110, currency: "AUD" },
      missingInputs: ["site access constraints"],
      assumptionInputs: [],
      pricing: { issues: [], ready: true },
    },
    attestation: buildQuotePricingAttestation({
      authorityStatus: { provider: "price_catalog", catalogRevision: "r1", snapshotDigest: "s1" },
      livePricingAvailable: true,
      requestNonce: "review-test",
    }),
  });
  const gaps = [{ field: "site access constraints", status: "confirmed", resolution: { note: "Truck access confirmed." } }];
  assert.equal(isQuotePricingSendable(quote), true);
  const reviewed = projectQuoteForReviewState({ quote, gaps });
  assert.deepEqual(reviewed.missingInputs, []);
  assert.deepEqual(reviewed.totals, { subtotal: 100, gst: 10, total: 110, currency: "AUD" });
  assert.equal(isQuotePricingSendable(reviewed), true);
  assert.equal(quote.missingInputs.length, 1);

  const tampered = { ...quote, totals: { ...quote.totals, total: 999 } };
  assert.equal(isQuotePricingSendable(tampered), false);
  assert.equal(isQuotePricingSendable(projectQuoteForReviewState({ quote: tampered, gaps })), false);
  reviewed.totals.total = 999;
  assert.equal(isQuotePricingSendable(reviewed), false);
});

test("job summaries carry the quote's customer-facing total, not the engine's $0 for an editor-built quote", () => {
  // A quote built in the editor has no compiled line items, so the engine's
  // quote.totals stay at 0 while the organizer holds the priced rows the PDF
  // prints. The job list and job detail used to show $0.00 for every such job.
  const quote = applyPresentationToQuote({
    quote: {
      version: 2,
      quoteNumber: "EQ-TEST-01",
      quoteCatalog: { gstRate: 0.1 },
      summary: "Editor-built quote",
      lineItems: [],
      totals: { subtotal: 0, gst: 0, total: 0, currency: "AUD" },
    },
    overrides: {
      presentation: {
        organizer: {
          root: ["manual:fee"],
          nodes: {
            "manual:fee": {
              kind: "source",
              origin: "manual",
              sourceCode: "manual-fee",
              labelOverride: "Site works",
              quantity: 2,
              unit: "each",
              sellRate: 150,
              buyRate: 100,
              rateMode: "catalog-linked",
              catalogItemCode: "FEE",
            },
          },
        },
      },
    },
  });
  const meta = { id: "job-1", pipelineStage: "sent", quoteTotal: 0, quoteSubtotal: 0 };
  const listed = sanitizeClientJobMeta(meta, quote, { issuedVersion: true });
  assert.equal(listed.quoteSubtotal, 300);
  assert.equal(listed.quoteGst, 30);
  assert.equal(listed.quoteTotal, 330);
  assert.equal(listed.quoteVersion, 2);
});
