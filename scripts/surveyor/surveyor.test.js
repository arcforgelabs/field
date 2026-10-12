import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_KINDS,
  OUTCOMES,
  artifact,
  assertSafeRelativePath,
  buildEvidence,
  buildSummary,
  compareLanes,
  compareSmoke,
  laneResult,
} from "./evidence.js";
import { renderReport } from "./report.js";
import { REQUIRED_SCENARIO_FIELDS, getScenario, listScenarios, validateScenario } from "./scenarios/index.js";

const baselineFail = laneResult({ ref: "origin/main", sha: "a".repeat(40), status: "fail", expected: "bug" });
const candidatePass = laneResult({ ref: "HEAD", sha: "b".repeat(40), status: "pass", expected: "fixed" });

test("verified requires baseline to fail AND candidate to pass", () => {
  const comparison = compareLanes(baselineFail, candidatePass);
  assert.equal(comparison.outcome, OUTCOMES.VERIFIED);
  assert.equal(comparison.reproducedOnBaseline, true);
  assert.equal(comparison.fixedOnCandidate, true);
  assert.equal(comparison.pass, true);
});

test("a candidate that passes without the bug reproducing is not verified", () => {
  const comparison = compareLanes({ ...baselineFail, status: "pass" }, candidatePass);
  assert.equal(comparison.outcome, OUTCOMES.NOT_VERIFIED);
  assert.equal(comparison.reproducedOnBaseline, false);
  assert.equal(comparison.pass, false);
});

test("harness failure is a distinct outcome and never claims a verdict", () => {
  const comparison = compareLanes(baselineFail, { ...candidatePass, status: "error" });
  assert.equal(comparison.outcome, OUTCOMES.HARNESS_FAILURE);
  assert.equal(comparison.reproducedOnBaseline, null);
  assert.equal(comparison.fixedOnCandidate, null);
  assert.equal(comparison.pass, false);
});

test("harness failure report says so instead of blaming the candidate", () => {
  const comparison = compareLanes({ ...baselineFail, status: "error" }, candidatePass);
  const summary = buildSummary({
    id: "x",
    scenario: { id: "s", transport: "http", title: "T" },
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:00:10.000Z",
    comparison,
    machine: { provider: "local", leaseId: null },
    artifactDir: "/tmp/x",
  });
  const evidence = buildEvidence({
    id: "s",
    title: "T",
    summary: "s",
    scenario: "s",
    comparison,
    machine: { provider: "local", leaseId: null },
  });
  const report = renderReport({ summary, evidence });
  assert.match(report, /harness failed before the oracle mattered/i);
  assert.match(report, /says nothing about the candidate/i);
  assert.match(report, /not established/);
});

test("a smoke run never claims a bug reproduced", () => {
  const comparison = compareSmoke(candidatePass);
  assert.equal(comparison.baseline, null);
  assert.equal(comparison.outcome, OUTCOMES.SMOKE_PASS);
  assert.equal(comparison.reproducedOnBaseline, null);
  assert.equal(comparison.fixedOnCandidate, null);
  assert.equal(comparison.pass, true);
});

test("smoke report says the harness passed, not that a fix was verified", () => {
  const comparison = compareSmoke(candidatePass);
  const summary = buildSummary({
    id: "x",
    scenario: { id: "server-boot-smoke", transport: "http", title: "T" },
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:00:03.000Z",
    comparison,
    machine: { provider: "local", leaseId: null },
    artifactDir: "/tmp/x",
    issues: ["smoke run: baseline lane not executed, so this proves the harness, not a fix"],
  });
  assert.equal(summary.refs.baseline, null);
  const report = renderReport({
    summary,
    evidence: buildEvidence({
      id: "s",
      title: "T",
      summary: "s",
      scenario: "s",
      comparison,
      machine: { provider: "local", leaseId: null },
    }),
  });
  assert.match(report, /proves the harness, not a fix/);
  assert.match(report, /_not executed_/);
  assert.doesNotMatch(report, /reproduced the reported behaviour/);
});

test("a failing smoke is not a harness failure unless the lane errored", () => {
  assert.equal(compareSmoke({ ...candidatePass, status: "fail" }).outcome, OUTCOMES.SMOKE_FAIL);
  assert.equal(compareSmoke({ ...candidatePass, status: "error" }).outcome, OUTCOMES.HARNESS_FAILURE);
});

test("lane status is constrained to pass|fail|error", () => {
  assert.throws(() => laneResult({ ref: "x", status: "flaky" }), /pass\|fail\|error/);
});

test("artifact paths reject traversal and absolute paths", () => {
  assert.throws(() => assertSafeRelativePath("/etc/passwd"), /must be relative/);
  assert.throws(() => assertSafeRelativePath("../../secrets"), /must not traverse upward/);
  assert.throws(() => artifact({ kind: "report", label: "l", path: "../x.md" }), /traverse upward/);
  assert.equal(assertSafeRelativePath("baseline/timeline.png"), "baseline/timeline.png");
});

test("artifact kinds are the published set", () => {
  assert.deepEqual(
    [...ARTIFACT_KINDS].sort(),
    ["desktopScreenshot", "fullVideo", "metadata", "motionPreview", "motionClip", "report", "timeline"].sort(),
  );
  assert.throws(() => artifact({ kind: "gif", label: "l", path: "a.gif" }), /unknown artifact kind/);
});

test("optional artifacts drop out, required artifacts fail the build", () => {
  const args = {
    id: "s",
    title: "T",
    summary: "s",
    scenario: "s",
    comparison: compareLanes(baselineFail, candidatePass),
    machine: { provider: "local", leaseId: null },
  };
  const evidence = buildEvidence({
    ...args,
    artifacts: [
      artifact({ kind: "report", label: "r", path: "surveyor-report.md" }),
      artifact({ kind: "timeline", lane: "baseline", label: "t", path: "baseline/timeline.png", required: false }),
    ],
    availablePaths: new Set(["surveyor-report.md"]),
  });
  assert.deepEqual(evidence.artifacts.map((entry) => entry.path), ["surveyor-report.md"]);

  assert.throws(
    () =>
      buildEvidence({
        ...args,
        artifacts: [artifact({ kind: "report", label: "r", path: "surveyor-report.md" })],
        availablePaths: new Set(),
      }),
    /required artifact missing/,
  );
});

test("summary records refs, machine and outcome for machine readers", () => {
  const comparison = compareLanes(baselineFail, candidatePass);
  const summary = buildSummary({
    id: "run-1",
    scenario: { id: "server-boot-smoke", transport: "http", title: "T" },
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:01:00.000Z",
    comparison,
    machine: { provider: "libvirt", leaseId: "fbx_0123456789abcdef" },
    artifactDir: "/tmp/run-1",
  });
  assert.equal(summary.durationMs, 60_000);
  assert.equal(summary.refs.baseline.sha, "a".repeat(40));
  assert.equal(summary.machine.provider, "libvirt");
  assert.equal(summary.outcome, OUTCOMES.VERIFIED);
  assert.equal(summary.credentialSource, "none");
});

test("scenarios must declare the full contract", () => {
  assert.throws(() => validateScenario({ id: "half" }), /is missing/);
  assert.throws(() => validateScenario({ ...stubScenario(), run: "nope" }), /run must be a function/);
  assert.equal(validateScenario(stubScenario()).id, "stub");
});

test("registered scenarios are valid and discoverable", () => {
  const scenarios = listScenarios();
  assert.ok(scenarios.length >= 1);
  const smoke = getScenario("server-boot-smoke");
  for (const field of REQUIRED_SCENARIO_FIELDS) assert.notEqual(smoke[field], undefined, field);
  assert.throws(() => getScenario("nope"), /unknown scenario/);
});

function stubScenario() {
  return {
    id: "stub",
    title: "Stub",
    transport: "http",
    requiredCredentials: [],
    baselineExpectation: "fails",
    candidateExpectation: "passes",
    timeoutMs: 1000,
    run: async () => ({ status: "pass" }),
  };
}
