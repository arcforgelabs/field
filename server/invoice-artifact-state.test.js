import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_STATE,
  artifactIsGenuinelyIssued,
  artifactIsMissing,
  artifactIsStored,
  artifactIsUnwritten,
  artifactRequiresAdoptAttempt,
  deriveArtifactState,
  transitionArtifactState,
} from "./invoice-artifact-state.js";

test("deriveArtifactState trusts an explicit, known artifactState field over any legacy flag", () => {
  assert.equal(deriveArtifactState({ artifactState: ARTIFACT_STATE.STORED }), ARTIFACT_STATE.STORED);
  assert.equal(deriveArtifactState({ artifactState: ARTIFACT_STATE.MISSING }), ARTIFACT_STATE.MISSING);
  assert.equal(deriveArtifactState({ artifactState: ARTIFACT_STATE.ADOPT_PENDING }), ARTIFACT_STATE.ADOPT_PENDING);
  assert.equal(deriveArtifactState({ artifactState: ARTIFACT_STATE.UNWRITTEN }), ARTIFACT_STATE.UNWRITTEN);
});

test("deriveArtifactState ignores an unrecognized artifactState value and falls back to legacy inference", () => {
  assert.equal(
    deriveArtifactState({ artifactState: "not-a-real-state", pdfIssuedAt: "2026-01-01T00:00:00.000Z" }),
    ARTIFACT_STATE.STORED,
  );
});

test("deriveArtifactState returns UNWRITTEN for null, missing, or empty entries", () => {
  assert.equal(deriveArtifactState(null), ARTIFACT_STATE.UNWRITTEN);
  assert.equal(deriveArtifactState(undefined), ARTIFACT_STATE.UNWRITTEN);
  assert.equal(deriveArtifactState({}), ARTIFACT_STATE.UNWRITTEN);
});

// DEL-30 round-4 architecture correction: existing jobs on disk have
// persisted revisions carrying the pre-refactor `pdfIssuedAt` /
// `pdfUnrecoverable` / `legacyOrigin` flags and NO `artifactState` field at
// all — this must be inferred correctly so no existing job breaks or
// silently changes behaviour.
test("deriveArtifactState infers the correct state from every pre-refactor stored shape", () => {
  // A normally-issued, successfully-written revision: only `pdfIssuedAt`.
  assert.equal(
    deriveArtifactState({ pdfIssuedAt: "2026-01-01T00:00:00.000Z" }),
    ARTIFACT_STATE.STORED,
  );
  // An opportunistic write that failed and was caught (DEL-30 P1-C, round
  // 3): only `pdfUnrecoverable`.
  assert.equal(
    deriveArtifactState({ pdfUnrecoverable: true }),
    ARTIFACT_STATE.MISSING,
  );
  // `pdfUnrecoverable` takes priority over a stale/absent `pdfIssuedAt`.
  assert.equal(
    deriveArtifactState({ pdfUnrecoverable: true, pdfIssuedAt: null }),
    ARTIFACT_STATE.MISSING,
  );
  // A legacy-synthesized revision mid-rebuild (DEL-30 F3, round 1): only
  // the transient `legacyOrigin` marker.
  assert.equal(
    deriveArtifactState({ legacyOrigin: true }),
    ARTIFACT_STATE.ADOPT_PENDING,
  );
  // A genuinely never-issued pre-refactor record: none of the flags set.
  assert.equal(
    deriveArtifactState({ invoiceNumber: "EI-OLD-01", total: 110 }),
    ARTIFACT_STATE.UNWRITTEN,
  );
});

test("the predicates agree with deriveArtifactState for every state, including legacy-inferred ones", () => {
  const stored = { pdfIssuedAt: "2026-01-01T00:00:00.000Z" };
  const missing = { pdfUnrecoverable: true };
  const adoptPending = { legacyOrigin: true };
  const unwritten = {};

  assert.equal(artifactIsStored(stored), true);
  assert.equal(artifactIsStored(missing), false);
  assert.equal(artifactIsStored(adoptPending), false);
  assert.equal(artifactIsStored(unwritten), false);

  assert.equal(artifactIsMissing(missing), true);
  assert.equal(artifactIsMissing(stored), false);

  assert.equal(artifactRequiresAdoptAttempt(adoptPending), true);
  assert.equal(artifactRequiresAdoptAttempt(stored), false);

  assert.equal(artifactIsUnwritten(unwritten), true);
  assert.equal(artifactIsUnwritten(stored), false);

  // Genuinely issued = anything other than UNWRITTEN (DEL-30 P2-C read path).
  assert.equal(artifactIsGenuinelyIssued(stored), true);
  assert.equal(artifactIsGenuinelyIssued(missing), true);
  assert.equal(artifactIsGenuinelyIssued(adoptPending), true);
  assert.equal(artifactIsGenuinelyIssued(unwritten), false);
});

test("transitionArtifactState is the single owner that sets state and data fields together", () => {
  const entry = { invoiceNumber: "EI-TX-01", total: 110, artifactState: ARTIFACT_STATE.UNWRITTEN };

  const stored = transitionArtifactState(entry, {
    toState: ARTIFACT_STATE.STORED,
    pdfPath: "milestone-invoices/EI-TX-01.pdf",
    pdfSha256: "abc123",
    pdfIssuedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(stored.artifactState, ARTIFACT_STATE.STORED);
  assert.equal(stored.pdfPath, "milestone-invoices/EI-TX-01.pdf");
  assert.equal(stored.pdfSha256, "abc123");
  assert.equal(stored.pdfIssuedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(stored.pdfUnrecoverableReason, null);
  // Unrelated fields are preserved.
  assert.equal(stored.invoiceNumber, "EI-TX-01");
  assert.equal(stored.total, 110);

  const missing = transitionArtifactState(stored, {
    toState: ARTIFACT_STATE.MISSING,
    reason: "pinned quote version unavailable",
  });
  assert.equal(missing.artifactState, ARTIFACT_STATE.MISSING);
  assert.equal(missing.pdfUnrecoverableReason, "pinned quote version unavailable");
  // Fields not passed this time (pdfPath/pdfSha256/pdfIssuedAt) are left
  // untouched, not cleared.
  assert.equal(missing.pdfPath, "milestone-invoices/EI-TX-01.pdf");
  assert.equal(missing.pdfSha256, "abc123");

  // Recovering back to STORED clears the unrecoverable reason.
  const recovered = transitionArtifactState(missing, {
    toState: ARTIFACT_STATE.STORED,
    pdfSha256: "def456",
    pdfIssuedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(recovered.artifactState, ARTIFACT_STATE.STORED);
  assert.equal(recovered.pdfUnrecoverableReason, null);
  assert.equal(recovered.pdfSha256, "def456");
});

test("transitionArtifactState rejects an unknown target state", () => {
  assert.throws(
    () => transitionArtifactState({}, { toState: "not-a-real-state" }),
    /invalid artifact state/i,
  );
});
