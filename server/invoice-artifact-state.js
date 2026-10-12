// Single owner of an invoice revision's ARTIFACT state.
//
// Before this module, "is this revision's PDF real, present and safe to
// serve?" was answered by recombining up to four independent signals —
// `pdfIssuedAt`, `pdfUnrecoverable`, the transient `legacyOrigin`, and a
// path-match against `revisionHistory` — and every consumer (the write
// path in quote-artifacts.js, the read path in job-document-context.js,
// the persist step in job-actions.js) recombined them a little differently.
// Every round of fixes added one more flag to patch a hole the previous
// flag left. This module makes the revision's artifact state a
// single enum field, computed and transitioned in exactly one place, so the
// unrepresentable states simply cannot occur again.
//
// `pdfPath` / `pdfSha256` / `pdfIssuedAt` remain plain DATA on the revision
// (a location, a hash, a timestamp) — this module does not own them. What
// it owns is the INFERENCE of state from data, which used to be recomputed
// ad hoc at every call site.

export const ARTIFACT_STATE = Object.freeze({
  // The revision has never had an artifact write attempted for it. An
  // ordinary fresh mint: render from the current quote and write once.
  UNWRITTEN: "unwritten",
  // The revision was synthesized from legacy stored data on this
  // rebuild and has no prior persisted artifact state at all. Its very
  // first touch must attempt to ADOPT a file already sitting at its path
  // (the document the customer actually received, before this freeze
  // mechanism existed) rather than render over it as if it were a fresh,
  // never-issued mint.
  ADOPT_PENDING: "adopt_pending",
  // Bytes are present and authoritative at `pdfPath`. `pdfSha256` and
  // `pdfIssuedAt` are trustworthy.
  STORED: "stored",
  // Bytes are absent. The last write/reconstruct attempt (if any) could not
  // recover them — no pinned quote version was available, or the file was
  // simply never written. Read paths must 410, not render.
  // Write paths must re-verify (never trust a stale MISSING claim — a file
  // can reappear out of band, e.g. an operator restoring it from backup)
  // and either adopt what is actually on disk, reconstruct, or fail loudly
  // again.
  MISSING: "missing",
});

const KNOWN_STATES = new Set(Object.values(ARTIFACT_STATE));

// Backward compatibility: existing jobs on disk have persisted revisions
// carrying the pre-refactor `pdfIssuedAt` / `pdfUnrecoverable` /
// `legacyOrigin` flags and no `artifactState` at all. This is the ONE place
// that infers a state from that legacy shape, so every consumer — however
// old the stored data is — sees the same canonical answer.
export function deriveArtifactState(entry) {
  if (!entry || typeof entry !== "object") return ARTIFACT_STATE.UNWRITTEN;
  if (KNOWN_STATES.has(entry.artifactState)) return entry.artifactState;
  if (entry.pdfUnrecoverable) return ARTIFACT_STATE.MISSING;
  if (entry.pdfIssuedAt) return ARTIFACT_STATE.STORED;
  if (entry.legacyOrigin) return ARTIFACT_STATE.ADOPT_PENDING;
  return ARTIFACT_STATE.UNWRITTEN;
}

export function artifactIsStored(entry) {
  return deriveArtifactState(entry) === ARTIFACT_STATE.STORED;
}

export function artifactIsMissing(entry) {
  return deriveArtifactState(entry) === ARTIFACT_STATE.MISSING;
}

export function artifactRequiresAdoptAttempt(entry) {
  return deriveArtifactState(entry) === ARTIFACT_STATE.ADOPT_PENDING;
}

export function artifactIsUnwritten(entry) {
  return deriveArtifactState(entry) === ARTIFACT_STATE.UNWRITTEN;
}

// True for any revision that is genuinely a money document — the read path
// (`resolveIssuedMilestoneInvoiceArtifact`) uses this: a genuinely issued
// revision with no stored bytes must 410, never fall through to a render.
// Any state other than UNWRITTEN means this revision claims to be a real
// money document — including ADOPT_PENDING, a legacy revision whose file
// has not yet been confirmed present on THIS touch but which the record's
// own status/issuedAt already say was issued to the customer.
export function artifactIsGenuinelyIssued(entry) {
  return deriveArtifactState(entry) !== ARTIFACT_STATE.UNWRITTEN;
}

// The single function that owns transitioning artifact state. Every write
// site (mint, adopt, reconstruct, fail) produces its patch by calling this,
// so "what does state X with these data fields look like on a revision"
// is answered in exactly one place.
export function transitionArtifactState(entry, {
  toState,
  pdfPath = undefined,
  pdfSha256 = undefined,
  pdfIssuedAt = undefined,
  reason = undefined,
} = {}) {
  if (!KNOWN_STATES.has(toState)) {
    throw new Error(`invalid artifact state: ${toState}`);
  }
  const base = entry && typeof entry === "object" ? entry : {};
  return {
    ...base,
    artifactState: toState,
    ...(pdfPath !== undefined ? { pdfPath } : {}),
    ...(pdfSha256 !== undefined ? { pdfSha256 } : {}),
    ...(pdfIssuedAt !== undefined ? { pdfIssuedAt } : {}),
    // Data field for operator-facing messaging only — never dispatched on.
    // Cleared on any transition away from MISSING.
    pdfUnrecoverableReason: toState === ARTIFACT_STATE.MISSING ? (reason || null) : null,
    // Legacy flags are not written going forward; `deriveArtifactState`
    // reads them only for pre-refactor data that predates this field.
    legacyOrigin: undefined,
    pdfUnrecoverable: undefined,
  };
}
