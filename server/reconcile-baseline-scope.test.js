import assert from "node:assert/strict";
import test from "node:test";

import { reconcileBaselineScope } from "./reconcile-baseline-scope.js";

test("reconcileBaselineScope preserves baseline items that were not explicitly removed", () => {
  const reconciled = reconcileBaselineScope({
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage only was re-extracted.",
      jobScope: {},
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          rationale: "Current transcript described drainage.",
          section: "Drainage",
          evidence: [],
        },
      ],
      assumptions: [],
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
    },
    baselineQuote: {
      version: 1,
      lineItems: [
        {
          code: "retaining-wall__section-rear-yard",
          quoteCatalogItemCode: "retaining-wall",
          label: "Rear retaining wall",
          section: "Rear Yard",
          scopeSummary: "Rear retaining wall to the fence line.",
          quantity: 1,
          unit: "job",
          customerVisible: true,
        },
      ],
    },
    clarificationNotes: [
      {
        source: "operator",
        itemCode: "retaining-wall",
        itemLabel: "Rear retaining wall",
        text: "Is this still needed for the rear wall?",
        signals: {
          questionRaised: true,
        },
      },
    ],
  });

  assert.equal(reconciled.reviewStatus, "manual_review");
  assert.equal(reconciled.lineItemCandidates.length, 2);
  const preserved = reconciled.lineItemCandidates.find((item) => item.quoteCatalogItemCode === "retaining-wall");
  assert.ok(preserved);
  assert.equal(preserved.label, "Rear retaining wall");
  assert.match(preserved.rationale || "", /Preserved from prior quote v1/i);
  assert.equal(
    reconciled.assumptions.some((item) => /Preserved Rear retaining wall from prior quote v1/i.test(item.statement)),
    true,
  );
});

test("reconcileBaselineScope respects explicit operator removal notes", () => {
  const reconciled = reconcileBaselineScope({
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "No drainage retained.",
      jobScope: {},
      lineItemCandidates: [],
      assumptions: [],
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
    },
    baselineQuote: {
      version: 2,
      lineItems: [
        {
          code: "drainage__section-drainage",
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          section: "Drainage",
          quantity: 12,
          unit: "lm",
          customerVisible: true,
        },
      ],
    },
    clarificationNotes: [
      {
        source: "operator",
        itemCode: "drainage",
        itemLabel: "Drainage installation",
        text: "Remove drainage from this quote.",
        signals: {
          questionRaised: false,
        },
      },
    ],
  });

  assert.equal(reconciled.lineItemCandidates.length, 0);
  assert.equal(reconciled.reviewStatus, "ready");
});

test("DEL-30 (P0-2): a candidate whose label differs from the rule label is not duplicated as missing", () => {
  // Reproduces the field-verification invoice fixture: the candidate carries
  // the operator/transcript label ("Concrete breakout") while the baseline
  // line item generated from the same catalogue rule carries rule.label
  // ("Concrete surface demolition"). Both sides share the same
  // quoteCatalogItemCode and section, so identity must key on the code, not
  // the label, or the "missing" baseline item is re-injected as a duplicate.
  const quoteInputs = {
    recordingIntent: "job-scope",
    reviewStatus: "ready",
    summary: "Concrete demolition and haulage.",
    jobScope: {},
    lineItemCandidates: [
      {
        quoteCatalogItemCode: "concrete-surface-demolition",
        label: "Concrete breakout",
        quantity: 18,
        unit: "m2",
        rationale: "Concrete breakout is the lead repair scope.",
        section: "Demolition",
        evidence: [],
      },
    ],
    assumptions: [],
    missingInputs: [],
    processReferences: [],
    siteConstraints: [],
    measurements: [],
  };
  const baselineQuote = {
    version: 1,
    lineItems: [
      {
        code: "concrete-surface-demolition__section-demolition",
        quoteCatalogItemCode: "concrete-surface-demolition",
        label: "Concrete surface demolition",
        section: "Demolition",
        scopeSummary: "Concrete surface demolition across the site.",
        quantity: 18,
        unit: "m2",
        customerVisible: true,
      },
    ],
  };

  const reconciled = reconcileBaselineScope({ quoteInputs, baselineQuote, clarificationNotes: [] });

  assert.equal(reconciled.lineItemCandidates.length, 1);
  assert.equal(reconciled.lineItemCandidates[0].label, "Concrete breakout");

  // Idempotency: running reconciliation again over its own output (as a
  // second rebuild would) must not add a second reference to the same item.
  const reconciledAgain = reconcileBaselineScope({
    quoteInputs: reconciled,
    baselineQuote,
    clarificationNotes: [],
  });
  assert.equal(reconciledAgain.lineItemCandidates.length, 1);
});

test("DEL-30 (P2-1): two option siblings sharing a catalogue rule and section both survive a rebuild", () => {
  // Option candidates in a "select one" section deliberately get their own
  // `code` (not the rule code) so siblings that share one quote-catalog rule
  // stay as separate line items (server/generate-evidence-quote.js:1015-1024,
  // 1200-1203) — both still carry the SAME quoteCatalogItemCode. Keying
  // identity on quoteCatalogItemCode alone would make the two siblings look
  // like the same item and drop one on rebuild. Neither is re-mentioned in
  // this round's transcript (lineItemCandidates is empty), so both must be
  // preserved from the baseline, not merged into one.
  const quoteInputs = {
    recordingIntent: "job-scope",
    reviewStatus: "ready",
    summary: "Plant package unchanged this round.",
    jobScope: {},
    lineItemCandidates: [],
    assumptions: [],
    missingInputs: [],
    processReferences: [],
    siteConstraints: [],
    measurements: [],
  };
  const baselineQuote = {
    version: 1,
    lineItems: [
      {
        code: "plant-option-native",
        quoteCatalogItemCode: "plant-supply-install",
        label: "Native planting package",
        section: "Select one — Planting package",
        scopeSummary: "Native planting package option.",
        quantity: 1,
        unit: "plant",
        customerVisible: true,
      },
      {
        code: "plant-option-formal",
        quoteCatalogItemCode: "plant-supply-install",
        label: "Formal planting package",
        section: "Select one — Planting package",
        scopeSummary: "Formal planting package option.",
        quantity: 1,
        unit: "plant",
        customerVisible: true,
      },
    ],
  };

  const reconciled = reconcileBaselineScope({ quoteInputs, baselineQuote, clarificationNotes: [] });

  assert.equal(reconciled.lineItemCandidates.length, 2);
  assert.deepEqual(
    reconciled.lineItemCandidates.map((item) => item.label).sort(),
    ["Formal planting package", "Native planting package"],
  );

  // Idempotency must hold for option siblings too.
  const reconciledAgain = reconcileBaselineScope({
    quoteInputs: reconciled,
    baselineQuote,
    clarificationNotes: [],
  });
  assert.equal(reconciledAgain.lineItemCandidates.length, 2);
});

test("DEL-30 (P3-1, documents a known asymmetry — see buildCandidateKey comment, tracked under DEL-66): a re-mentioned option candidate without its own `code` duplicates rather than merges with its baseline sibling", () => {
  // Not reachable today: options only ever enter via the agent-driven PUT
  // /quote-inputs path, which always supplies `code`, and AI transcript
  // extraction never emits option codes at all. This test exists so that if
  // a future producer starts emitting quoteCatalogItemCode-only candidates
  // for an option that already has a baseline sibling, the test suite flags
  // the resulting duplicate loudly instead of it shipping silently.
  const quoteInputs = {
    recordingIntent: "job-scope",
    reviewStatus: "ready",
    summary: "Native package re-selected this round.",
    jobScope: {},
    lineItemCandidates: [
      {
        // No `code` here, unlike the baseline sibling below — the asymmetry.
        quoteCatalogItemCode: "plant-supply-install",
        label: "Native planting package",
        quantity: 1,
        unit: "plant",
        rationale: "Operator re-confirmed the native package this round.",
        section: "Select one — Planting package",
        evidence: [],
      },
    ],
    assumptions: [],
    missingInputs: [],
    processReferences: [],
    siteConstraints: [],
    measurements: [],
  };
  const baselineQuote = {
    version: 1,
    lineItems: [
      {
        code: "plant-option-native",
        quoteCatalogItemCode: "plant-supply-install",
        label: "Native planting package",
        section: "Select one — Planting package",
        scopeSummary: "Native planting package option.",
        quantity: 1,
        unit: "plant",
        customerVisible: true,
      },
    ],
  };

  const reconciled = reconcileBaselineScope({ quoteInputs, baselineQuote, clarificationNotes: [] });

  // Documents the current (undesirable but safer-than-loss) behaviour: the
  // candidate and its baseline sibling fail to match, so the item is
  // preserved a second time instead of being recognised as already present.
  assert.equal(reconciled.lineItemCandidates.length, 2);
  assert.equal(
    reconciled.lineItemCandidates.filter((item) => item.label === "Native planting package").length,
    2,
  );
});

test("DEL-30 (P3-1, documents a known asymmetry — see buildCandidateKey comment, tracked under DEL-66): a candidate carrying its own `code` distinct from quoteCatalogItemCode duplicates against an ordinary (non-option) baseline item", () => {
  // Not reachable today: no current producer emits a `code` on a candidate
  // for an ordinary (non-"select one") item. normalizeLineItemCandidates
  // (server/extract-quote-inputs.js) does not strip an incoming `code`
  // though, so nothing structurally prevents this shape from appearing.
  const quoteInputs = {
    recordingIntent: "job-scope",
    reviewStatus: "ready",
    summary: "Drainage re-confirmed with an unexpected candidate code.",
    jobScope: {},
    lineItemCandidates: [
      {
        // A `code` that is neither the rule code nor an extractRuleCode-able
        // rule-code-plus-section-suffix — the asymmetry, mirrored from the
        // option case but on an ordinary single-per-rule-per-section item.
        code: "operator-entered-drainage-reference",
        quoteCatalogItemCode: "drainage",
        label: "Drainage installation",
        quantity: 12,
        unit: "lm",
        rationale: "Operator re-confirmed drainage this round.",
        section: "Drainage",
        evidence: [],
      },
    ],
    assumptions: [],
    missingInputs: [],
    processReferences: [],
    siteConstraints: [],
    measurements: [],
  };
  const baselineQuote = {
    version: 1,
    lineItems: [
      {
        code: "drainage__section-drainage",
        quoteCatalogItemCode: "drainage",
        label: "Drainage installation",
        section: "Drainage",
        scopeSummary: "Drainage run across the site.",
        quantity: 12,
        unit: "lm",
        customerVisible: true,
      },
    ],
  };

  const reconciled = reconcileBaselineScope({ quoteInputs, baselineQuote, clarificationNotes: [] });

  // Same failure mode as the option case above, mirrored: the candidate's
  // own `code` keys it separately from the baseline item's catalogue-code
  // key, so the baseline item is preserved a second time.
  assert.equal(reconciled.lineItemCandidates.length, 2);
  assert.equal(
    reconciled.lineItemCandidates.filter((item) => item.label === "Drainage installation").length,
    2,
  );
});
