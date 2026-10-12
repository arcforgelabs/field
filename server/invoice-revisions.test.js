import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInvoiceRevisionFingerprint,
  buildInvoiceRevisionNumber,
  describeInvoiceRevisionChange,
  findInvoiceRevision,
  listInvoiceRevisions,
  parseInvoiceRevisionSuffix,
  resolveMilestoneRevisionState,
  stripInvoiceRevisionSuffix,
} from "./invoice-revisions.js";

function createFinancials(total = 110) {
  return {
    subtotal: Math.round(total / 1.1 * 100) / 100,
    gst: Math.round((total - total / 1.1) * 100) / 100,
    total,
    currency: "AUD",
    lineItems: [
      { description: "Retaining wall", quantity: 1, unit: "lot", unitPrice: total, totalPrice: total },
    ],
  };
}

test("the first revision keeps the historical invoice number and later revisions are suffixed", () => {
  assert.equal(buildInvoiceRevisionNumber("EI-0041-M1", 1), "EI-0041-M1");
  assert.equal(buildInvoiceRevisionNumber("EI-0041-M1", 2), "EI-0041-M1-R2");
  assert.equal(buildInvoiceRevisionNumber("EI-0041-M1-R2", 3), "EI-0041-M1-R3");
  assert.equal(stripInvoiceRevisionSuffix("EI-0041-M1-R7"), "EI-0041-M1");
  assert.equal(parseInvoiceRevisionSuffix("EI-0041-M1"), 1);
  assert.equal(parseInvoiceRevisionSuffix("EI-0041-M1-R4"), 4);
});

test("issuing freezes the financial content and reissuing does not move it", () => {
  const issued = resolveMilestoneRevisionState({
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    issuedAt: "2026-05-01T00:00:00.000Z",
    quoteVersion: 2,
    financials: createFinancials(110),
  });
  assert.equal(issued.revisionNumber, 1);
  assert.equal(issued.invoiceNumber, "EI-0041-M1");
  assert.equal(issued.issuedRevision.total, 110);
  assert.equal(issued.issuedRevision.quoteVersion, 2);

  // A later rebuild against a changed quote must not touch the issued snapshot.
  const rebuilt = resolveMilestoneRevisionState({
    issuedRevision: issued.issuedRevision,
    revisionHistory: issued.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    issuedAt: "2026-05-01T00:00:00.000Z",
    quoteVersion: 3,
    financials: createFinancials(330),
  });
  assert.equal(rebuilt.revisionNumber, 1);
  assert.equal(rebuilt.issuedRevision.total, 110);
  assert.equal(rebuilt.issuedRevision.quoteVersion, 2);
});

test("an authorized revision mints a new number and retains the superseded revision", () => {
  const issued = resolveMilestoneRevisionState({
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    issuedAt: "2026-05-01T00:00:00.000Z",
    quoteVersion: 2,
    financials: createFinancials(110),
  });

  const revised = resolveMilestoneRevisionState({
    issuedRevision: issued.issuedRevision,
    revisionHistory: issued.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    issuedAt: "2026-05-01T00:00:00.000Z",
    quoteVersion: 3,
    financials: createFinancials(330),
    authorization: {
      reason: "Approved rock clause variation",
      actor: { kind: "user", label: "Alex" },
      at: "2026-05-09T02:00:00.000Z",
    },
  });

  assert.equal(revised.revisionNumber, 2);
  assert.equal(revised.invoiceNumber, "EI-0041-M1-R2");
  assert.equal(revised.issuedRevision.total, 330);
  assert.equal(revised.issuedRevision.quoteVersion, 3);
  assert.equal(revised.issuedRevision.issuedAt, "2026-05-09T02:00:00.000Z");
  assert.equal(revised.issuedRevision.revisionReason, "Approved rock clause variation");
  assert.equal(revised.issuedRevision.revisedBy, "Alex");
  assert.equal(revised.issuedRevision.supersedesInvoiceNumber, "EI-0041-M1");
  assert.equal(revised.issuedRevision.supersededTotal, 110);
  assert.equal(revised.issuedRevision.supersededQuoteVersion, 2);

  assert.equal(revised.revisionHistory.length, 1);
  const superseded = revised.revisionHistory[0];
  assert.equal(superseded.invoiceNumber, "EI-0041-M1");
  assert.equal(superseded.total, 110);
  assert.equal(superseded.supersededByRevisionNumber, 2);
  assert.ok(superseded.supersededAt);

  const listed = listInvoiceRevisions(revised);
  assert.deepEqual(listed.map((entry) => entry.invoiceNumber), ["EI-0041-M1", "EI-0041-M1-R2"]);
  assert.deepEqual(listed.map((entry) => entry.current), [false, true]);
  assert.equal(findInvoiceRevision({ ...revised, revisionNumber: 1 }).invoiceNumber, "EI-0041-M1");

  const change = describeInvoiceRevisionChange({
    previous: issued.issuedRevision,
    next: revised.issuedRevision,
  });
  assert.equal(change.totalDelta, 220);
  assert.equal(change.supersedesInvoiceNumber, "EI-0041-M1");
});

test("un-issuing retires the revision and reissuing identical content restores it", () => {
  const issued = resolveMilestoneRevisionState({
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    issuedAt: "2026-05-01T00:00:00.000Z",
    quoteVersion: 2,
    financials: createFinancials(110),
  });

  const unsent = resolveMilestoneRevisionState({
    issuedRevision: issued.issuedRevision,
    revisionHistory: issued.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: false,
    quoteVersion: 2,
    financials: createFinancials(110),
  });
  assert.equal(unsent.issuedRevision, null);
  assert.equal(unsent.revisionHistory.length, 1);
  // Unchanged content keeps pointing at the same revision, so an accidental
  // unsend does not burn a number.
  assert.equal(unsent.revisionNumber, 1);
  assert.equal(unsent.invoiceNumber, "EI-0041-M1");

  const reissued = resolveMilestoneRevisionState({
    issuedRevision: null,
    revisionHistory: unsent.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    quoteVersion: 2,
    financials: createFinancials(110),
  });
  assert.equal(reissued.revisionNumber, 1);
  assert.equal(reissued.invoiceNumber, "EI-0041-M1");
  assert.equal(reissued.revisionHistory.length, 0);

  // Reissuing different content after an unsend mints the next revision
  // instead of reusing a number the customer already holds.
  const changed = resolveMilestoneRevisionState({
    issuedRevision: null,
    revisionHistory: unsent.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    quoteVersion: 3,
    financials: createFinancials(330),
  });
  assert.equal(changed.revisionNumber, 2);
  assert.equal(changed.invoiceNumber, "EI-0041-M1-R2");
  assert.equal(changed.revisionHistory.length, 1);
  assert.equal(changed.revisionHistory[0].invoiceNumber, "EI-0041-M1");
});

test("restoring a retired revision preserves its original issuedAt and records a separate reissuedAt (DEL-30 P3-4)", () => {
  const issued = resolveMilestoneRevisionState({
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    issuedAt: "2026-05-01T00:00:00.000Z",
    quoteVersion: 2,
    financials: createFinancials(110),
  });

  const unsent = resolveMilestoneRevisionState({
    issuedRevision: issued.issuedRevision,
    revisionHistory: issued.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: false,
    quoteVersion: 2,
    financials: createFinancials(110),
  });

  const restored = resolveMilestoneRevisionState({
    issuedRevision: null,
    revisionHistory: unsent.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    issuedAt: "2026-05-10T00:00:00.000Z",
    quoteVersion: 2,
    financials: createFinancials(110),
    now: "2026-05-10T00:00:00.000Z",
  });

  assert.equal(restored.restored, true);
  // The original issue event must survive a restore untouched — the
  // customer received this document on 2026-05-01, not the reissue date.
  assert.equal(restored.issuedRevision.issuedAt, "2026-05-01T00:00:00.000Z");
  assert.equal(restored.issuedRevision.reissuedAt, "2026-05-10T00:00:00.000Z");
});

test("a restore-below-max attributes the next authorized revision to the actual predecessor, not the highest history entry (DEL-30 P3-1)", () => {
  // R1 issued, then authorized straight to R2.
  const r1 = resolveMilestoneRevisionState({
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    issuedAt: "2026-05-01T00:00:00.000Z",
    quoteVersion: 1,
    financials: createFinancials(110),
  });
  const r2 = resolveMilestoneRevisionState({
    issuedRevision: r1.issuedRevision,
    revisionHistory: r1.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    quoteVersion: 2,
    financials: createFinancials(330),
    authorization: {
      reason: "Approved rock clause variation",
      actor: { kind: "user", label: "Alex" },
      at: "2026-05-05T00:00:00.000Z",
    },
  });
  assert.equal(r2.revisionNumber, 2);

  // Unsend R2 (retires it) and restore R1 by reissuing its identical
  // content — R1 is now active again with R2 sitting in history above it.
  const unsentR2 = resolveMilestoneRevisionState({
    issuedRevision: r2.issuedRevision,
    revisionHistory: r2.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: false,
    quoteVersion: 2,
    financials: createFinancials(330),
  });
  const restoredR1 = resolveMilestoneRevisionState({
    issuedRevision: null,
    revisionHistory: unsentR2.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    quoteVersion: 1,
    financials: createFinancials(110),
  });
  assert.equal(restoredR1.revisionNumber, 1);
  assert.equal(restoredR1.restored, true);
  // History now holds R2 (revisionNumber 2) while the active revision is R1
  // (revisionNumber 1) — the exact "restore-below-max" divergence.
  assert.deepEqual(restoredR1.revisionHistory.map((entry) => entry.revisionNumber), [2]);

  // A later approved change authorizes on top of the restored R1.
  const r3 = resolveMilestoneRevisionState({
    issuedRevision: restoredR1.issuedRevision,
    revisionHistory: restoredR1.revisionHistory,
    baseInvoiceNumber: "EI-0041-M1",
    isIssued: true,
    quoteVersion: 3,
    financials: createFinancials(550),
    authorization: {
      reason: "Second approved variation",
      actor: { kind: "user", label: "Alex" },
      at: "2026-05-15T00:00:00.000Z",
    },
  });

  // The true successor is R3 (not R1.revisionNumber + 1 = 2, which R2
  // already occupies), and it supersedes the revision the customer actually
  // held immediately before — R1 — not R2, which merely has the highest
  // revision number in history.
  assert.equal(r3.revisionNumber, 3);
  assert.equal(r3.issuedRevision.supersedesRevisionNumber, 1);
  assert.equal(r3.issuedRevision.supersedesInvoiceNumber, "EI-0041-M1");

  const retiredR1 = r3.revisionHistory.find((entry) => entry.revisionNumber === 1);
  assert.ok(retiredR1, "R1 is retained in history");
  assert.equal(retiredR1.supersededByRevisionNumber, 3);

  const retiredR2 = r3.revisionHistory.find((entry) => entry.revisionNumber === 2);
  assert.ok(retiredR2, "R2 is retained in history");
});

test("the fingerprint only changes when customer-visible money content changes", () => {
  const base = buildInvoiceRevisionFingerprint({ ...createFinancials(110), quoteVersion: 2 });
  assert.equal(base, buildInvoiceRevisionFingerprint({ ...createFinancials(110), quoteVersion: 2 }));
  assert.notEqual(base, buildInvoiceRevisionFingerprint({ ...createFinancials(120), quoteVersion: 2 }));
  assert.notEqual(base, buildInvoiceRevisionFingerprint({ ...createFinancials(110), quoteVersion: 3 }));
});
