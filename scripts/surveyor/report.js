import { OUTCOMES } from "./evidence.js";

/**
 * Markdown report for humans and for PR or issue comments.
 *
 * Rule: when the run failed because the harness failed,
 * the report must say so instead of implying the candidate failed.
 */

const OUTCOME_HEADLINE = {
  [OUTCOMES.VERIFIED]:
    "Surveyor reproduced the reported behaviour on the baseline and confirmed the candidate fixes it.",
  [OUTCOMES.NOT_VERIFIED]:
    "Surveyor ran both lanes but did not get the baseline-fails / candidate-passes pattern. This is not a verdict on the fix; read the lane results below.",
  [OUTCOMES.HARNESS_FAILURE]:
    "Surveyor could not produce a meaningful result: the harness failed before the oracle mattered. This says nothing about the candidate.",
  [OUTCOMES.SMOKE_PASS]:
    "Surveyor smoke run: the lane works end to end. No baseline was executed, so this proves the harness, not a fix.",
  [OUTCOMES.SMOKE_FAIL]:
    "Surveyor smoke run failed its own oracle. No baseline was executed, so this proves the harness is broken or the lane cannot run here.",
};

function laneRow(lane, result) {
  const sha = result.sha ? result.sha.slice(0, 12) : "unknown";
  return `| ${lane} | \`${result.ref}\` | \`${sha}\` | \`${result.status}\` | ${result.expected ?? "-"} |`;
}

export function renderReport({ summary, evidence }) {
  const { comparison } = evidence;
  const lines = [
    `# ${evidence.title}`,
    "",
    OUTCOME_HEADLINE[comparison.outcome],
    "",
    `- Scenario: \`${summary.scenario}\``,
    `- Transport: \`${summary.transport}\``,
    `- Outcome: \`${comparison.outcome}\``,
    `- Reproduced on baseline: ${formatTristate(comparison.reproducedOnBaseline)}`,
    `- Fixed on candidate: ${formatTristate(comparison.fixedOnCandidate)}`,
    `- Machine: \`${summary.machine.provider}\`${summary.machine.leaseId ? ` lease \`${summary.machine.leaseId}\`` : ""}`,
    `- Credential source: \`${summary.credentialSource}\``,
    `- Duration: ${Math.round(summary.durationMs / 1000)}s`,
    "",
    "| Lane | Ref | SHA | Status | Expected |",
    "| --- | --- | --- | --- | --- |",
    ...(comparison.baseline
      ? [laneRow("baseline", comparison.baseline)]
      : ["| baseline | _not executed_ | - | - | - |"]),
    laneRow("candidate", comparison.candidate),
    "",
  ];

  for (const lane of ["baseline", "candidate"]) {
    const result = comparison[lane];
    if (!result?.oracle) continue;
    lines.push(`### ${lane} oracle`, "", "```json", JSON.stringify(result.oracle, null, 2), "```", "");
  }

  const visual = evidence.artifacts.filter((entry) =>
    ["timeline", "desktopScreenshot", "motionPreview"].includes(entry.kind),
  );
  if (visual.length) {
    lines.push("### Evidence", "");
    for (const entry of visual) {
      lines.push(`- ${entry.lane ? `**${entry.lane}** ` : ""}${entry.label}: \`${entry.path}\``);
    }
    lines.push("");
  }

  const notes = [
    ...(comparison.baseline?.notes ?? []),
    ...comparison.candidate.notes,
    ...summary.issues,
  ];
  if (notes.length) {
    lines.push("### Notes", "", ...notes.map((note) => `- ${note}`), "");
  }

  lines.push(`Artifacts: \`${summary.artifactDir}\``, "");
  return lines.join("\n");
}

function formatTristate(value) {
  if (value === null) return "not established";
  return value ? "yes" : "no";
}
