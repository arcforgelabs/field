#!/usr/bin/env node
// field-release-prepare.yml: did every required check pass on the commit?
//
//   node scripts/release/require-checks.mjs <check-runs.json>
//
// <check-runs.json> is the commit's check runs from the GitHub API (an array).
// The rule is scripts/deploy-checks.js's, the one a Replit publish applies:
// each required check ran from GitHub Actions and its newest run passed.
import { readFileSync } from "node:fs";
import { evaluateChecks, REQUIRED_CHECKS } from "../deploy-checks.js";

const result = evaluateChecks(JSON.parse(readFileSync(process.argv[2], "utf8")));
if (!result.passed) {
  console.error(`Checks have not passed on this commit:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(`Required checks passed: ${REQUIRED_CHECKS.join(", ")}`);
