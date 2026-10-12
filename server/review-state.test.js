import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewState, findReviewItem, restoreStatusForResolvedGap } from "./review-state.js";

test("accepted gap becomes an assumed review item with direct actions", () => {
  const review = buildReviewState({
    quote: {
      lineItems: [{
        code: "retaining-wall",
        label: "Retaining wall",
        quantity: 1,
        unit: "item",
        unitPrice: 1200,
        totalPrice: 1200,
        requiredInputs: ["access"],
      }],
      assumptionInputs: [{
        field: "access",
        value: "Good site access",
        source: "default",
        relatedLineItems: ["retaining-wall"],
        evidenceSummary: ["No access risks mentioned in the site discussion."],
      }],
    },
    jobState: {
      gaps: [{
        id: "gap_access",
        field: "access",
        status: "accepted",
        presentInCurrentContext: true,
        reason: "Access not explicitly confirmed.",
        evidence: [{ text: "No access risks mentioned in the site discussion." }],
        resolution: {
          note: "Good site access",
          reason: "Accepted for quoting.",
          at: "2026-03-12T01:02:03.000Z",
          by: { kind: "user", label: "Alex" },
        },
      }],
    },
  });

  assert.equal(review.counts.assumed, 1);
  assert.equal(review.counts.confirmed, 0);
  assert.equal(review.canSend, true);
  assert.deepEqual(review.assumedItems[0].allowedActions, ["confirm", "edit", "reject"]);
  assert.equal(review.assumedItems[0].gapId, "gap_access");
  assert.equal(findReviewItem(review, "gap_access")?.category, "assumed");
});

test("confirmed gap moves out of assumed and into confirmed", () => {
  const review = buildReviewState({
    quote: {
      lineItems: [],
      assumptionInputs: [],
    },
    jobState: {
      gaps: [{
        id: "gap_material",
        field: "material",
        status: "confirmed",
        presentInCurrentContext: true,
        reason: "Material confirmed on review.",
        evidence: [{ text: "Customer confirmed treated pine." }],
        resolution: {
          note: "Treated pine sleepers",
          reason: "Confirmed during quote review.",
          at: "2026-03-12T01:02:03.000Z",
          by: { kind: "user", label: "Alex" },
        },
      }],
    },
  });

  assert.equal(review.counts.assumed, 0);
  assert.equal(review.counts.confirmed, 1);
  assert.equal(review.confirmedItems[0].id, "resolved-gap:gap_material");
});

test("confirmed gap keeps a source ref and classifies assistant review as chat", () => {
  const review = buildReviewState({
    quote: {
      lineItems: [],
      assumptionInputs: [],
    },
    jobState: {
      gaps: [{
        id: "gap_height",
        field: "height",
        status: "confirmed",
        presentInCurrentContext: true,
        reason: "Height confirmed in review.",
        evidence: [{ text: "Assistant confirmed 1.8 m fence height." }],
        resolution: {
          note: "1.8 m",
          reason: "Confirmed from chat review.",
          at: "2026-03-12T01:02:03.000Z",
          by: { kind: "ai", label: "Assistant" },
        },
      }],
      activity: [{
        id: "evt_gap_height_confirmed",
        kind: "gap.state_changed",
        title: "Gap confirmed",
        body: "height — Confirmed from chat review.",
        gapId: "gap_height",
        gapStatus: "confirmed",
      }],
    },
  });

  assert.equal(review.confirmedItems[0].provenance?.[0]?.sourceType, "chat");
  assert.deepEqual(review.confirmedItems[0].provenance?.[0]?.sourceRef, {
    kind: "activity",
    activityId: "evt_gap_height_confirmed",
    label: "Gap confirmed",
  });
});

test("confirmed gap restores to assumed when it was confirmed from an accepted assumption", () => {
  const gap = {
    id: "gap_height",
    field: "height",
    status: "confirmed",
    presentInCurrentContext: true,
    resolution: {
      at: "2026-03-12T02:00:00.000Z",
      by: { kind: "user", label: "Alex" },
    },
  };
  const status = restoreStatusForResolvedGap({
    activity: [
      {
        id: "evt_gap_height_confirmed",
        ts: "2026-03-12T02:00:00.000Z",
        kind: "gap.state_changed",
        gapId: "gap_height",
        gapStatus: "confirmed",
      },
      {
        id: "evt_gap_height_accepted",
        ts: "2026-03-12T01:00:00.000Z",
        kind: "gap.state_changed",
        gapId: "gap_height",
        gapStatus: "accepted",
      },
    ],
  }, gap);

  assert.equal(status, "accepted");
});

test("confirmed gap restores to the previous gap-lane state when there is no accepted history", () => {
  const gap = {
    id: "gap_gate_width",
    field: "gate width",
    status: "confirmed",
    presentInCurrentContext: true,
    resolution: {
      at: "2026-03-12T02:00:00.000Z",
      by: { kind: "user", label: "Alex" },
    },
  };
  const status = restoreStatusForResolvedGap({
    activity: [
      {
        id: "evt_gap_gate_width_in_progress",
        ts: "2026-03-12T01:30:00.000Z",
        kind: "gap.state_changed",
        gapId: "gap_gate_width",
        gapStatus: "in_progress",
      },
      {
        id: "evt_gap_gate_width_confirmed",
        ts: "2026-03-12T02:00:00.000Z",
        kind: "gap.state_changed",
        gapId: "gap_gate_width",
        gapStatus: "confirmed",
      },
    ],
  }, gap);

  assert.equal(status, "in_progress");
});

test("quote-only assumptions stay editable without pretending they are confirmed", () => {
  const review = buildReviewState({
    quote: {
      lineItems: [],
      assumptionInputs: [{
        field: "obstructions",
        value: "No hidden concrete or obstructions",
        source: "default",
        evidenceSummary: ["No hidden obstructions were discussed."],
      }],
    },
    jobState: {
      gaps: [],
    },
  });

  assert.equal(review.counts.assumed, 1);
  assert.equal(review.assumedItems[0].canConfirm, false);
  assert.deepEqual(review.assumedItems[0].allowedActions, ["edit", "reject"]);
  assert.equal(review.assumedItems[0].gapId, null);
});

test("excluded assumption becomes a rejected review item instead of reopening the gap", () => {
  const review = buildReviewState({
    quote: {
      lineItems: [],
      assumptionInputs: [],
    },
    quoteOverrides: {
      assumptions: {
        access: {
          value: "Good site access",
          reviewState: {
            excluded: true,
            reason: "Access assumption not needed after removing the wall scope.",
            at: "2026-03-12T01:02:03.000Z",
            by: { kind: "user", label: "Alex" },
            originCategory: "assumed",
            relatedLineItems: ["retaining-wall"],
          },
        },
      },
    },
    jobState: {
      gaps: [{
        id: "gap_access",
        field: "access",
        status: "rejected",
        presentInCurrentContext: true,
        reason: "Access assumption not needed after removing the wall scope.",
        resolution: {
          reason: "Access assumption not needed after removing the wall scope.",
          at: "2026-03-12T01:02:03.000Z",
          by: { kind: "user", label: "Alex" },
        },
      }],
    },
  });

  assert.equal(review.assumedItems.length, 0);
  assert.equal(review.rejectedItems.length, 1);
  assert.equal(review.rejectedItems[0].kind, "assumption");
  assert.equal(review.rejectedItems[0].originCategory, "assumed");
  assert.deepEqual(review.rejectedItems[0].relatedLineItems, ["retaining-wall"]);
  assert.deepEqual(review.rejectedItems[0].allowedActions, ["reopen"]);
  assert.equal(findReviewItem(review, "gap_access")?.category, "rejected");
});

test("excluded line item becomes a rejected confirmed item", () => {
  const review = buildReviewState({
    quote: {
      lineItems: [],
      assumptionInputs: [],
    },
    quoteOverrides: {
      lineItems: {
        "retaining-wall": {
          label: "Retaining wall",
          reviewState: {
            excluded: true,
            reason: "Wall removed from the current quote.",
            at: "2026-03-12T01:02:03.000Z",
            by: { kind: "user", label: "Alex" },
            originCategory: "confirmed",
            detail: "Quoted scope item",
          },
        },
      },
    },
    jobState: {
      gaps: [],
    },
  });

  assert.equal(review.confirmedItems.length, 0);
  assert.equal(review.rejectedItems.length, 1);
  assert.equal(review.rejectedItems[0].kind, "line_item");
  assert.equal(review.rejectedItems[0].originCategory, "confirmed");
  assert.equal(review.rejectedItems[0].id, "line-item:retaining-wall");
  assert.deepEqual(review.rejectedItems[0].allowedActions, ["reopen"]);
});
