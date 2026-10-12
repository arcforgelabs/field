import assert from "node:assert/strict";
import test from "node:test";
import { applyQuoteIdentity, ensureQuoteIdentityMeta } from "./quote-identity.js";

test("ensureQuoteIdentityMeta reuses the Field job id as the canonical job uid", () => {
  const meta = ensureQuoteIdentityMeta({
    meta: {
      id: "57d997d9-6ec3-446e-aea5-30b73d3c962b",
      quoteVersion: 1,
    },
    version: 1,
    now: "2026-03-26T10:00:00.000Z",
  });

  assert.equal(meta.quoteIdentity.jobUid, "57d997d9-6ec3-446e-aea5-30b73d3c962b");
  assert.equal(meta.quoteIdentity.activeRevisionNumber, 1);
  assert.match(meta.quoteIdentity.activeThreadUid, /^QT-/);
  assert.match(meta.quoteIdentity.activeRevisionUid, /^QR-/);
});

test("ensureQuoteIdentityMeta preserves the same revision uid while the version stays the same", () => {
  const first = ensureQuoteIdentityMeta({
    meta: {
      id: "job-123",
    },
    version: 1,
    now: "2026-03-26T10:00:00.000Z",
  });

  const second = ensureQuoteIdentityMeta({
    meta: first,
    version: 1,
    now: "2026-03-26T10:05:00.000Z",
  });

  assert.equal(second.quoteIdentity.activeThreadUid, first.quoteIdentity.activeThreadUid);
  assert.equal(second.quoteIdentity.activeRevisionUid, first.quoteIdentity.activeRevisionUid);
  assert.equal(second.quoteIdentity.revisions.length, 1);
  assert.equal(second.quoteIdentity.revisions[0].quoteRevisionUid, first.quoteIdentity.activeRevisionUid);
  assert.equal(second.quoteIdentity.revisions[0].lastBuiltAt, "2026-03-26T10:05:00.000Z");
});

test("ensureQuoteIdentityMeta creates a new revision uid when the quote version increments", () => {
  const first = ensureQuoteIdentityMeta({
    meta: {
      id: "job-456",
    },
    version: 1,
    now: "2026-03-26T10:00:00.000Z",
  });

  const second = ensureQuoteIdentityMeta({
    meta: first,
    version: 2,
    now: "2026-03-26T11:00:00.000Z",
  });

  assert.equal(second.quoteIdentity.activeThreadUid, first.quoteIdentity.activeThreadUid);
  assert.notEqual(second.quoteIdentity.activeRevisionUid, first.quoteIdentity.activeRevisionUid);
  assert.equal(second.quoteIdentity.activeRevisionNumber, 2);
  assert.equal(second.quoteIdentity.supersedesQuoteRevisionUid, first.quoteIdentity.activeRevisionUid);
});

test("applyQuoteIdentity attaches revision linkage and a stable scope fingerprint", () => {
  const preparedMeta = ensureQuoteIdentityMeta({
    meta: {
      id: "job-789",
      quoteNumber: "EQ-2603-99",
      jobNumber: "JOB-20260326-JOB789",
    },
    version: 1,
    now: "2026-03-26T10:00:00.000Z",
  });

  const quote = {
    kind: "quote",
    version: 1,
    quoteNumber: "EQ-2603-99",
    jobNumber: "JOB-20260326-JOB789",
    title: "Exampleton soil and concrete",
    summary: "Soil removal and disposal",
    status: "manual_review",
    review: {
      status: "manual_review",
      reasons: ["Quote extraction flagged manual review."],
    },
    delivery: {
      status: "draft",
    },
    totals: {
      subtotal: 8060.55,
      gst: 806.06,
      total: 8866.61,
      currency: "AUD",
    },
    lineItems: [
      {
        code: "soil-removal__section-shed-area-levelling",
        label: "Soil removal and disposal",
        quantity: 25.86,
        unit: "m3",
        unitPrice: 85,
        totalPrice: 2198.1,
        section: "Shed area levelling",
        customerVisible: true,
      },
    ],
    presentation: {
      scheduleItems: [
        {
          code: "soil-removal__section-shed-area-levelling",
          label: "Soil removal and disposal",
          quantity: 1,
          unit: "lot",
          unitPrice: 4040.06,
          totalPrice: 4040.06,
          sourceLineItemCodes: ["soil-removal__section-shed-area-levelling"],
        },
      ],
    },
  };

  const applied = applyQuoteIdentity({
    meta: preparedMeta,
    quote,
    quoteInputs: {
      recordingIntent: "job-scope",
    },
    overrides: {
      lockStatus: "draft",
    },
    now: "2026-03-26T10:15:00.000Z",
  });

  assert.equal(applied.quote.identity.jobUid, "job-789");
  assert.equal(applied.quote.identity.quoteRevisionUid, preparedMeta.quoteIdentity.activeRevisionUid);
  assert.equal(applied.quote.identity.revisionLabel, "v001");
  assert.match(applied.quote.identity.scopeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(applied.meta.quoteIdentity.scopeFingerprint, applied.quote.identity.scopeFingerprint);
});

test("applyQuoteIdentity preserves variation thread linkage when the meta is already on a variation thread", () => {
  const preparedMeta = ensureQuoteIdentityMeta({
    meta: {
      id: "job-var-001",
      quoteNumber: "EQ-2603-10",
      jobNumber: "JOB-20260326-JOBVAR01",
      quoteIdentity: {
        activeThreadKind: "variation",
        parentThreadUid: "QT-BASE-001",
      },
    },
    version: 1,
    now: "2026-03-26T12:00:00.000Z",
  });

  const applied = applyQuoteIdentity({
    meta: preparedMeta,
    quote: {
      kind: "quote",
      version: 1,
      quoteNumber: "EQ-2603-10",
      jobNumber: "JOB-20260326-JOBVAR01",
      title: "Variation quote",
      summary: "Additional spoil removal",
      totals: {
        subtotal: 1000,
        gst: 100,
        total: 1100,
        currency: "AUD",
      },
      lineItems: [],
      presentation: {
        scheduleItems: [],
      },
    },
    now: "2026-03-26T12:15:00.000Z",
  });

  assert.equal(applied.quote.identity.quoteKind, "variation");
  assert.equal(applied.quote.identity.quoteThreadKind, "variation");
  assert.equal(applied.quote.identity.parentQuoteThreadUid, "QT-BASE-001");
});
