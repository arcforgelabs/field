// Release jobs build from the tag, never from a commit passed between jobs:
// the checks prove the tag's commit is on main, and each later job checks out
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
  assert.ok(releaseWorkflows.includes("field-release-checks.yml"));
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
