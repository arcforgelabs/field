import assert from "node:assert/strict";
import { test } from "node:test";
import { rules, runBarnacleAutoResponse } from "./barnacle-auto-response.mjs";

function fakeGitHub() {
  const calls = [];
  const record = (name) => async (args) => calls.push([name, args]);
  return {
    calls,
    rest: {
      issues: { createComment: record("comment"), update: record("updateIssue") },
      pulls: { update: record("updatePull") },
    },
  };
}

const core = { info() {} };
const repo = { owner: "arcforgelabs", repo: "example" };
const rule = rules[0];

test("a close-reason label on an open issue posts the reply and closes it", async () => {
  const github = fakeGitHub();
  const context = { repo, payload: { action: "labeled", label: { name: rule.label }, issue: { number: 7, state: "open", labels: [{ name: rule.label }] } } };
  await runBarnacleAutoResponse({ github, context, core });
  assert.deepEqual(github.calls, [
    ["comment", { ...repo, issue_number: 7, body: rule.message }],
    ["updateIssue", { ...repo, issue_number: 7, state: "closed", state_reason: "not_planned" }],
  ]);
});

test("a pull request closes through the pulls API", async () => {
  const github = fakeGitHub();
  const context = { repo, payload: { action: "labeled", label: { name: rule.label }, pull_request: { number: 8, state: "open", labels: [] } } };
  await runBarnacleAutoResponse({ github, context, core });
  assert.deepEqual(github.calls.map(([name]) => name), ["comment", "updatePull"]);
});

test("bad-barnacle, other labels and closed items do nothing", async () => {
  for (const payload of [
    { action: "labeled", label: { name: rule.label }, issue: { number: 1, state: "open", labels: [{ name: "bad-barnacle" }] } },
    { action: "labeled", label: { name: "bug" }, issue: { number: 2, state: "open", labels: [] } },
    { action: "labeled", label: { name: rule.label }, issue: { number: 3, state: "closed", labels: [] } },
    { action: "opened", issue: { number: 4, state: "open", labels: [] } },
  ]) {
    const github = fakeGitHub();
    await runBarnacleAutoResponse({ github, context: { repo, payload }, core });
    assert.deepEqual(github.calls, []);
  }
});
