#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  OUTCOMES,
  artifact,
  buildEvidence,
  buildSummary,
  compareLanes,
  compareSmoke,
  laneResult,
} from "./evidence.js";
import { renderReport } from "./report.js";
import { getScenario, listScenarios } from "./scenarios/index.js";
import { addWorktree, pruneWorktrees, removeWorktree } from "./worktrees.js";

const USAGE = `surveyor — before/after proof for Field bugs

Usage:
  node scripts/surveyor/cli.js list
  node scripts/surveyor/cli.js run --scenario <id> --baseline <ref> --candidate <ref> [options]
  node scripts/surveyor/cli.js smoke --scenario <id> [--candidate <ref>]

Options:
  --scenario <id>       scenario to run (see \`list\`)
  --baseline <ref>      ref expected to reproduce the bug
  --candidate <ref>     ref expected to fix it (default: HEAD)
  --output-dir <dir>    default .artifacts/surveyor/<scenario>-<timestamp>
  --provider <name>     machine lane; only \`local\` is wired today
  --keep-worktrees      leave the lane checkouts in place for inspection

Exit codes: 0 verified, 1 not verified, 2 harness failure.
`;

function parseArgs(argv) {
  const options = { candidate: "HEAD", provider: "local" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valued = {
      "--scenario": "scenario",
      "--baseline": "baseline",
      "--candidate": "candidate",
      "--output-dir": "outputDir",
      "--provider": "provider",
    };
    if (valued[arg]) {
      options[valued[arg]] = argv[++i];
      continue;
    }
    if (arg === "--keep-worktrees") options.keepWorktrees = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
  }
  return options;
}

function stampedDir(scenarioId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(".artifacts", "surveyor", `${scenarioId}-${stamp}`);
}

function collectPaths(root) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.add(relative(root, full));
    }
  };
  try {
    walk(root);
  } catch {
    /* nothing written yet */
  }
  return found;
}

async function runLane({ scenario, lane, ref, repoRoot, outputDir, logPath }) {
  const log = (line) => appendFileSync(logPath, `${line}\n`);
  let tree = null;
  try {
    tree = await addWorktree({ repoRoot, ref, lane, outputDir });
    log(`SURVEYOR_PHASE:checkout:${lane} ${tree.sha}`);
    const outcome = await withTimeout(
      scenario.run({
        checkoutPath: tree.path,
        laneDir: join(outputDir, lane),
        lane,
        log,
      }),
      scenario.timeoutMs,
      `${lane} lane exceeded ${scenario.timeoutMs}ms`,
    );
    return {
      result: laneResult({
        ref,
        sha: tree.sha,
        status: outcome.status,
        expected: lane === "baseline" ? scenario.baselineExpectation : scenario.candidateExpectation,
        oracle: outcome.oracle ?? null,
        notes: outcome.notes ?? [],
      }),
      tree,
    };
  } catch (error) {
    // Any throw is harness failure by definition: the oracle never ran.
    log(`SURVEYOR_HARNESS_ERROR:${lane} ${error.message}`);
    return {
      result: laneResult({
        ref,
        sha: tree?.sha ?? null,
        status: "error",
        expected: lane === "baseline" ? scenario.baselineExpectation : scenario.candidateExpectation,
        oracle: { stage: "harness", message: error.message },
        notes: [`harness failure in ${lane} lane: ${error.message}`],
      }),
      tree,
    };
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export async function main(argv) {
  const [command, ...tail] = argv;
  const options = parseArgs(tail);

  if (!command || options.help || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "list") {
    for (const { id, title, transport } of listScenarios()) {
      process.stdout.write(`${id}\t${transport}\t${title}\n`);
    }
    return 0;
  }

  if (command !== "run" && command !== "smoke") throw new Error(`unknown command: ${command}`);
  if (!options.scenario) throw new Error("--scenario is required");
  if (options.provider !== "local") {
    // Fail closed rather than run locally while reporting a remote machine.
    throw new Error(
      `provider ${options.provider} is not wired yet; run with --provider local (see docs/concepts/surveyor.md)`,
    );
  }

  const scenario = getScenario(options.scenario);
  const repoRoot = resolve(process.cwd());
  const outputDir = resolve(options.outputDir ?? stampedDir(scenario.id));
  mkdirSync(outputDir, { recursive: true });
  const logPath = join(outputDir, "run.log");
  writeFileSync(logPath, "");

  const startedAt = new Date().toISOString();
  const machine = { provider: "local", leaseId: null, host: "localhost" };
  const issues = [];

  const smokeOnly = command === "smoke" || (scenario.smoke && !options.baseline);
  if (command === "run" && !options.baseline) throw new Error("--baseline is required for run");

  const trees = [];
  let comparison;
  if (smokeOnly) {
    const candidate = await runLane({
      scenario,
      lane: "candidate",
      ref: options.candidate,
      repoRoot,
      outputDir,
      logPath,
    });
    if (candidate.tree) trees.push(candidate.tree);
    comparison = compareSmoke(candidate.result);
    issues.push("smoke run: baseline lane not executed, so this proves the harness, not a fix");
  } else {
    for (const [lane, ref] of [
      ["baseline", options.baseline],
      ["candidate", options.candidate],
    ]) {
      const outcome = await runLane({ scenario, lane, ref, repoRoot, outputDir, logPath });
      if (outcome.tree) trees.push(outcome.tree);
      if (lane === "baseline") comparison = { baseline: outcome.result };
      else comparison = compareLanes(comparison.baseline, outcome.result);
    }
  }

  const finishedAt = new Date().toISOString();
  const summary = buildSummary({
    id: `${scenario.id}-${startedAt}`,
    scenario,
    startedAt,
    finishedAt,
    comparison,
    machine,
    artifactDir: outputDir,
    issues,
  });

  const evidence = buildEvidence({
    id: scenario.id,
    title: scenario.title,
    summary: summaryLine(comparison),
    scenario: scenario.id,
    comparison,
    machine,
    artifacts: [
      artifact({ kind: "report", label: "Surveyor report", path: "surveyor-report.md" }),
      artifact({ kind: "metadata", label: "Run log", path: "run.log" }),
      artifact({ kind: "metadata", label: "Machine-readable summary", path: "surveyor-summary.json" }),
      artifact({
        kind: "timeline",
        lane: "baseline",
        label: "Baseline timeline",
        path: "baseline/timeline.png",
        required: false,
      }),
      artifact({
        kind: "timeline",
        lane: "candidate",
        label: "Candidate timeline",
        path: "candidate/timeline.png",
        required: false,
      }),
    ],
    availablePaths: new Set([
      ...collectPaths(outputDir),
      "surveyor-report.md",
      "surveyor-summary.json",
    ]),
  });

  writeFileSync(join(outputDir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  writeFileSync(join(outputDir, "surveyor-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outputDir, "surveyor-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(join(outputDir, "surveyor-report.md"), renderReport({ summary, evidence }));

  if (!options.keepWorktrees) {
    for (const tree of trees) await removeWorktree({ repoRoot, path: tree.path });
    await pruneWorktrees({ repoRoot });
  }

  process.stdout.write(`${renderReport({ summary, evidence })}\n`);
  if (comparison.outcome === OUTCOMES.HARNESS_FAILURE) return 2;
  return comparison.pass ? 0 : 1;
}

function summaryLine(comparison) {
  switch (comparison.outcome) {
    case OUTCOMES.HARNESS_FAILURE:
      return "Harness failed before the oracle was meaningful; no verdict on the candidate.";
    case OUTCOMES.VERIFIED:
      return "Baseline reproduced the reported behaviour and the candidate fixed it.";
    case OUTCOMES.SMOKE_PASS:
      return "Smoke run passed: the lane works. No baseline executed, so no fix is proven.";
    case OUTCOMES.SMOKE_FAIL:
      return "Smoke run failed its own oracle; the lane cannot produce proof here.";
    default:
      return "Both lanes ran, but the baseline-fails / candidate-passes pattern was not observed.";
  }
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      console.error(`surveyor: ${error?.message ?? error}`);
      process.exit(2);
    },
  );
}
