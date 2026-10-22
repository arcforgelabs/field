// Release jobs build from the tag, never from a commit passed between jobs:
// the checks prove the tag's commit is on its release branch, and each later job checks out
// the tag again and fails if it now points anywhere else. A checkout of a
// job output is code the workflow cannot show was reviewed (CodeQL
// actions/cache-poisoning/poisonable-step).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKFLOWS = resolve(import.meta.dirname, "../../.github/workflows");
const releaseWorkflows = readdirSync(WORKFLOWS).filter((name) => /^field-.*release.*\.yml$/.test(name));

function steps(name) {
  return readFileSync(join(WORKFLOWS, name), "utf8").split(/\n(?=[ \t]+- name: )/).slice(1);
}

function title(step) {
  return step.trim().split("\n")[0];
}

test("no release job checks out a ref taken from another job's output", () => {
  assert.deepEqual(releaseWorkflows.sort(), [
    "field-full-release-validation.yml",
    "field-npm-release.yml",
    "field-release-branch.yml",
    "field-release-checks.yml",
    "field-release-closeout.yml",
    "field-release-prepare.yml",
    "field-release-promote.yml",
    "field-release-publish.yml",
  ]);
  for (const name of releaseWorkflows) {
    for (const step of steps(name).filter((s) => /uses: actions\/checkout@/.test(s))) {
      assert.doesNotMatch(step, /^\s*ref:\s*\$\{\{\s*needs\./m, `${name}: "${title(step)}" checks out a job output`);
    }
  }
});

test("a job that checks out the tag after the checks then requires the commit they proved", () => {
  for (const name of releaseWorkflows) {
    const all = steps(name);
    all.forEach((step, index) => {
      if (!/uses: actions\/checkout@/.test(step) || !/ref: refs\/tags\/\$\{\{ inputs\.tag \}\}/.test(step)) return;
      // The resolve job's own checkout is the one that proves the commit.
      if (title(step) === "- name: Check out the tag") return;
      const next = all[index + 1] || "";
      assert.match(next, /RESOLVED: \$\{\{ needs\.\w+\.outputs\.commit \}\}/, `${name}: the step after "${title(step)}" names the proved commit`);
      assert.match(next, /"\$head" != "\$RESOLVED"/, `${name}: the step after "${title(step)}" compares HEAD with it`);
    });
  }
});

test("no release workflow names Flow, the repository they were copied from", () => {
  for (const name of releaseWorkflows) {
    assert.doesNotMatch(readFileSync(join(WORKFLOWS, name), "utf8"), /flow-|FLOW_|arcforgelabs\/flow|"flow |Flow /, name);
  }
});

const workflow = (name) => readFileSync(join(WORKFLOWS, name), "utf8");

test("every release workflow that changes anything runs only from main", () => {
  for (const name of ["field-release-branch.yml", "field-release-prepare.yml", "field-release-publish.yml", "field-npm-release.yml", "field-release-promote.yml", "field-release-closeout.yml"]) {
    assert.match(workflow(name), /- name: Require the workflow from main\n\s+if: github\.ref != 'refs\/heads\/main'/, name);
  }
});

test("main is validated every 3 hours, and Prepare tags only a commit on a release branch that the validation proved", () => {
  assert.match(workflow("field-full-release-validation.yml"), /cron: "7 \*\/3 \* \* \*"/);
  const prepare = workflow("field-release-prepare.yml");
  assert.match(prepare, /is not on \$\{BRANCH\}\. Only commits on a release branch are released\./);
  assert.ok(prepare.indexOf("require-validation.mjs") < prepare.indexOf("- name: Create the release tag"));
  assert.match(workflow("field-release-checks.yml"), /Only release-branch commits are released\./);
});

test("release tags are signed when a key is set, and the signature is required only when the maintainer turns it on", () => {
  const prepare = workflow("field-release-prepare.yml");
  assert.match(prepare, /git tag --sign "\$TAG"/);
  assert.match(prepare, /git tag --verify "\$TAG"/);
  assert.match(prepare, /if \[\[ -z "\$SIGNING_KEY" \]\]; then\n\s+git tag --annotate "\$TAG"/);
  assert.match(prepare, /-z "\$SIGNING_KEY" && "\$REQUIRE_SIGNED" == "true"/);
  const checks = steps("field-release-checks.yml");
  const verify = checks.findIndex((step) => title(step) === "- name: Require an annotated release tag");
  const checkout = checks.findIndex((step) => /uses: actions\/checkout@/.test(step));
  assert.ok(verify >= 0 && verify < checkout, "the tag is checked before the first checkout");
  assert.match(checks[verify], /\.object\.type <<< "\$ref"\)" != "tag"/);
  assert.match(checks[verify], /"\$verified" != "true" && "\$REQUIRE_SIGNED" == "true"/);
});

test("blocker fixes reach a release branch only as -x cherry-picks of main commits", () => {
  const branch = workflow("field-release-branch.yml");
  assert.match(branch, /git cherry-pick -x "\$commit"/);
  assert.match(branch, /is not on main\. A fix merges to main first, then comes here\./);
  assert.match(branch, /already exists\. A second cut on newer main needs the maintainer's word/);
});

test("a stable release is closed out on main after npm is verified, and the GitHub Release is public only then", () => {
  const npm = workflow("field-npm-release.yml");
  assert.match(npm, /gh workflow run field-release-closeout\.yml/);
  assert.match(npm, /--draft=false/);
  // The release is a draft until npm is verified, so the manifest travels as an artifact of the Publish run.
  assert.match(npm, /gh run download "\$RUN_ID" --repo "\$GITHUB_REPOSITORY" --name release-manifest/);
  assert.doesNotMatch(npm, /gh release download/);
  assert.match(workflow("field-release-publish.yml"), /name: release-manifest\n/);
  assert.match(workflow("field-release-publish.yml"), /--verify-tag --draft/);
  assert.match(workflow("field-release-closeout.yml"), /chore\(release\): close out \$\{VERSION\} on main/);
});

test("the release workflows accept correction tags", () => {
  for (const name of ["field-release-publish.yml", "field-npm-release.yml", "field-release-promote.yml"]) {
    assert.match(workflow(name), /vYYYY\.M\.N-C/, name);
  }
});
