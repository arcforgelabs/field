#!/usr/bin/env node
// field-release-prepare.yml: did Field Full Release Validation prove the commit?
//
//   node scripts/release/require-validation.mjs <runs.json> <commit> <branch>
//
// <runs.json> is the workflow's runs for the commit from the GitHub API (an
// array). The commit is proved when a run of it on its release branch
// passed. OpenClaw publishes only from a sealed Full Release Validation of the exact
// release commit; main's own CI does not gate a release.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function provingRun(runs, { commit, branch }) {
  return (
    runs.find(
      (run) =>
        run.head_sha === commit &&
        run.path === ".github/workflows/field-full-release-validation.yml" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.head_branch === branch,
    ) ?? null
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, commit, branch] = process.argv.slice(2);
  const run = provingRun(JSON.parse(readFileSync(file, "utf8")), { commit, branch });
  if (!run) {
    console.error(`Field Full Release Validation has not passed on ${commit} (${branch}). Start it: gh workflow run field-full-release-validation.yml --ref ${branch}`);
    process.exit(1);
  }
  console.log(`Field Full Release Validation run ${run.id} proved ${commit} on ${run.head_branch}`);
}
