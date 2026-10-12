/**
 * Surveyor evidence model.
 *
 * The schema is the handoff between scenario code and anything that publishes proof:
 * a PR or issue comment, or a local report (docs/concepts/surveyor.md).
 */

export const EVIDENCE_SCHEMA_VERSION = 1;

/** Artifact kinds, fixed so publishers stay interchangeable. */
export const ARTIFACT_KINDS = new Set([
  "timeline",
  "desktopScreenshot",
  "motionPreview",
  "motionClip",
  "fullVideo",
  "metadata",
  "report",
]);

export const LANES = ["baseline", "candidate"];

/**
 * A run has exactly two useful outcomes and one useless one. Rule: the
 * report must never let a broken harness read as a product verdict.
 */
export const OUTCOMES = {
  /** Baseline failed as expected and candidate passed. The proof we want. */
  VERIFIED: "verified",
  /** Both lanes ran a meaningful oracle, but the pattern is not baseline-fail/candidate-pass. */
  NOT_VERIFIED: "not_verified",
  /** Setup, deps, build, ports or credentials failed before the oracle meant anything. */
  HARNESS_FAILURE: "harness_failure",
  /** One-lane harness check. Proves the lane works; proves nothing about a fix. */
  SMOKE_PASS: "smoke_pass",
  SMOKE_FAIL: "smoke_fail",
};

export function laneResult({ ref, sha, status, expected, oracle = null, notes = [] }) {
  if (!["pass", "fail", "error"].includes(status)) {
    throw new Error(`lane status must be pass|fail|error, got ${status}`);
  }
  return { ref, sha: sha ?? null, status, expected: expected ?? null, oracle, notes };
}

/**
 * The oracle. Verified means the bug reproduced on baseline AND the candidate
 * fixed it — not merely that the candidate passed.
 */
export function compareLanes(baseline, candidate) {
  const harnessFailure = baseline.status === "error" || candidate.status === "error";
  const reproduced = baseline.status === "fail";
  const fixed = candidate.status === "pass";
  const outcome = harnessFailure
    ? OUTCOMES.HARNESS_FAILURE
    : reproduced && fixed
      ? OUTCOMES.VERIFIED
      : OUTCOMES.NOT_VERIFIED;
  return {
    baseline,
    candidate,
    reproducedOnBaseline: harnessFailure ? null : reproduced,
    fixedOnCandidate: harnessFailure ? null : fixed,
    outcome,
    pass: outcome === OUTCOMES.VERIFIED,
  };
}

/**
 * One-lane smoke comparison. It must never synthesize a baseline: a run that did
 * not execute a baseline cannot claim a bug reproduced, so both reproduction
 * fields stay null and `pass` only ever means "the lane works".
 */
export function compareSmoke(candidate) {
  const outcome =
    candidate.status === "error"
      ? OUTCOMES.HARNESS_FAILURE
      : candidate.status === "pass"
        ? OUTCOMES.SMOKE_PASS
        : OUTCOMES.SMOKE_FAIL;
  return {
    baseline: null,
    candidate,
    reproducedOnBaseline: null,
    fixedOnCandidate: null,
    outcome,
    pass: outcome === OUTCOMES.SMOKE_PASS,
  };
}

/** Reject path traversal and absolute paths before anything gets published. */
export function assertSafeRelativePath(value, label = "path") {
  const path = String(value ?? "");
  if (!path) throw new Error(`${label} is required`);
  if (path.startsWith("/")) throw new Error(`${label} must be relative: ${path}`);
  if (path.split("/").includes("..")) throw new Error(`${label} must not traverse upward: ${path}`);
  return path;
}

export function artifact({
  kind,
  lane = null,
  label,
  path,
  targetPath = null,
  alt = null,
  width = null,
  required = true,
}) {
  if (!ARTIFACT_KINDS.has(kind)) {
    throw new Error(`unknown artifact kind: ${kind} (known: ${[...ARTIFACT_KINDS].join(", ")})`);
  }
  if (lane !== null && !LANES.includes(lane)) throw new Error(`unknown lane: ${lane}`);
  assertSafeRelativePath(path, "artifact.path");
  if (targetPath) assertSafeRelativePath(targetPath, "artifact.targetPath");
  return { kind, lane, label, path, targetPath, alt, width, required };
}

/**
 * Build the publishable manifest. Optional artifacts that were never produced
 * are dropped; a missing *required* artifact is an error, not a quiet omission.
 */
export function buildEvidence({
  id,
  title,
  summary,
  scenario,
  comparison,
  machine,
  artifacts = [],
  availablePaths = null,
}) {
  const kept = [];
  for (const entry of artifacts) {
    const present = availablePaths ? availablePaths.has(entry.path) : true;
    if (present) {
      kept.push(entry);
      continue;
    }
    if (entry.required) throw new Error(`required artifact missing: ${entry.path}`);
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id,
    title,
    summary,
    scenario,
    comparison,
    machine,
    artifacts: kept,
  };
}

/**
 * `surveyor-summary.json` is the machine-readable source of truth; the markdown
 * report is for humans. The field list is fixed.
 */
export function buildSummary({
  id,
  scenario,
  startedAt,
  finishedAt,
  comparison,
  machine,
  credentialSource = "none",
  artifactDir,
  issues = [],
}) {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id,
    scenario: scenario.id,
    transport: scenario.transport,
    title: scenario.title,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt) - new Date(startedAt),
    refs: {
      baseline: comparison.baseline
        ? { ref: comparison.baseline.ref, sha: comparison.baseline.sha }
        : null,
      candidate: { ref: comparison.candidate.ref, sha: comparison.candidate.sha },
    },
    machine,
    credentialSource,
    baseline: comparison.baseline,
    candidate: comparison.candidate,
    reproducedOnBaseline: comparison.reproducedOnBaseline,
    fixedOnCandidate: comparison.fixedOnCandidate,
    outcome: comparison.outcome,
    pass: comparison.pass,
    artifactDir,
    // Sanitized setup/cleanup problems. Never credential values.
    issues,
  };
}
