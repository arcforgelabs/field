// scripts/release/release-stable.mjs: the one-command stable release, with
// `gh` and `npm` replaced by a fake that answers from a table.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadState, parseArgs, PHASES, ReleaseRefusal, runReleaseStable } from "./release-stable.mjs";

const CUT = "c".repeat(40);
const HEAD = "d".repeat(40);
const REPO = "arcforgelabs/field";
const PAGE = "---\ntitle: \"v2026.10.40\"\n---\n";

function options(extra = []) {
  return { ...parseArgs(["2026.10.40", ...extra]), stateDir: mkdtempSync(join(tmpdir(), "field-release-stable-")) };
}

// A fake GitHub and npm. `world` changes as dispatched workflows "run".
function fake(world) {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args].join(" "));
    const path = args[1] ?? "";
    if (command === "npm") {
      if (args[1] === `@arcforgelabs/field@2026.10.40`) return world.npm ? "2026.10.40\n" : fail();
      if (args[2] === "dist-tags.beta") return `${world.beta}\n`;
    }
    if (args[0] === "api") {
      if (path === "user") return JSON.stringify({ login: "agent" });
      if (path === `repos/${REPO}/branches/release%2F2026.10.40`) return world.branch ? JSON.stringify({ commit: { sha: HEAD } }) : fail();
      if (path.startsWith(`repos/${REPO}/actions/workflows/field-full-release-validation.yml/runs?branch=main`)) return JSON.stringify({ workflow_runs: [{ head_sha: CUT }] });
      if (path.startsWith(`repos/${REPO}/actions/workflows/field-full-release-validation.yml/runs?head_sha=${HEAD}`)) {
        return JSON.stringify({ workflow_runs: [{ id: 7, head_branch: "release/2026.10.40", status: "completed", conclusion: world.validation ?? "success", html_url: "v" }] });
      }
      if (path.startsWith(`repos/${REPO}/contents/CHANGELOG/2026.10.40.md?ref=notes`)) return "{}";
      if (path.startsWith(`repos/${REPO}/contents/CHANGELOG/2026.10.40.md?ref=main`)) return world.closedOut ? "{}" : fail();
      const runs = /actions\/workflows\/([\w.-]+)\/runs\?/.exec(path);
      if (runs) return JSON.stringify({ workflow_runs: world.runs[runs[1]] ?? [] });
      if (path === `repos/${REPO}/git/ref/tags/v2026.10.40`) return world.tagged ? "{}" : fail();
      if (path === `repos/${REPO}/releases/latest`) return JSON.stringify({ tag_name: "v2026.10.40" });
      if (path.startsWith(`repos/${REPO}/releases?`)) return JSON.stringify([{ id: 5, tag_name: "v2026.10.40", draft: false, prerelease: false }]);
      if (path.startsWith(`repos/${REPO}/pulls?head=arcforgelabs%3Arelease%2F2026.10.40-main-closeout`)) return JSON.stringify(world.pr ? [world.pr] : []);
      if (path.startsWith(`repos/${REPO}/commits/${"e".repeat(40)}/check-runs`)) {
        return JSON.stringify({ check_runs: ["test", "client-build", "docker-build", "gitleaks"].map((name, id) => ({ id, name, app: { id: 15368 }, status: "completed", conclusion: "success" })) });
      }
    }
    if (path === `repos/${REPO}/contents/docs/releases/2026.10.40.md?ref=main`) return JSON.stringify({ content: Buffer.from(PAGE).toString("base64") });
    if (path === `repos/${REPO}/releases/tags/v2026.10.40`) return JSON.stringify({ id: 5, html_url: "r", body: world.body ?? "notes" });
    if (command === "curl") return world.served ?? PAGE;
    if (command === "node" && args[1] === "thanks") return "roster\n";
    if (command === "node" && args[1] === "verify") return "ok\n";
    if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
      world.body = "roster";
      return "{}";
    }
    if (args[0] === "api" && args[1] === "-X" && args[2] === "PUT") return "{}";
    const dispatched = /actions\/workflows\/([\w.-]+)\/dispatches$/.exec(args[3] ?? "");
    if (args[0] === "api" && dispatched) {
      const file = dispatched[1];
      world.runs[file] = [{ id: calls.length, actor: { login: "agent" }, status: "completed", conclusion: "success", display_title: file, html_url: file }];
      if (file === "field-release-branch.yml") world.branch = true;
      if (file === "field-release-prepare.yml") {
        world.tagged = true;
        world.npm = true;
        world.runs["field-release-publish.yml"] = [{ id: 90, status: "completed", conclusion: "success", display_title: "field v2026.10.40", html_url: "p" }];
        world.runs["field-npm-release.yml"] = [{ id: 91, status: "completed", conclusion: "success", display_title: "field npm v2026.10.40", html_url: "n" }];
      }
      return "";
    }
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
  function fail() {
    const error = new Error("404");
    error.stderr = "HTTP 404";
    throw error;
  }
  return { exec, calls };
}

const quiet = { sleep: () => {}, log: () => {} };

test("the options name one stable version and full commit hashes", () => {
  assert.equal(parseArgs(["--help"]), null);
  assert.equal(parseArgs(["2026.10.40", "--from", "publish"]).from, "publish");
  assert.throws(() => parseArgs(["2026.10.40-beta.1"]), /not a calendar version/);
  assert.throws(() => parseArgs([]), /one stable version/);
  assert.throws(() => parseArgs(["2026.10.40", "--from", "macos"]), /Unknown phase macos/);
  assert.throws(() => parseArgs(["2026.10.40", "--cut-sha", "abc"]), /full lowercase commit hash/);
  assert.throws(() => parseArgs(["2026.10.40", "--notes-ref"]), /needs a value/);
  assert.throws(() => parseArgs(["2026.10.40", "--yes"]), /Unknown option --yes/);
  assert.equal(parseArgs(["2026.10.40"]).hold, false);
  assert.equal(parseArgs(["2026.10.40", "--hold"]).hold, true);
  assert.deepEqual(PHASES, ["cut", "validate", "publish", "flip-github", "sync-beta", "closeout", "docs", "thanks"]);
});

test("the cut needs the notes, and prints how to write them at the newest validated main commit", () => {
  const world = { runs: {}, beta: "2026.10.39" };
  const { exec, calls } = fake(world);
  const opts = options();
  assert.throws(() => runReleaseStable(opts, { exec, ...quiet }), (error) => {
    assert.ok(error instanceof ReleaseRefusal);
    assert.match(error.message, new RegExp(`Write the 2026.10.40 notes at the cut ${CUT}`));
    assert.ok(error.next.some((line) => line.includes(`changelog.mjs draft --version 2026.10.40 --target ${CUT}`)));
    assert.ok(error.next.at(-1).includes("--notes-ref"));
    return true;
  });
  assert.deepEqual(calls.filter((call) => call.includes("/dispatches")), []);
  assert.equal(loadState(opts).cut.cutSha, CUT);
});

test("with --hold, the cut waits for the operator to confirm the newest validated main commit", () => {
  const world = { runs: {}, beta: "2026.10.39" };
  const { exec } = fake(world);
  const opts = options(["--hold"]);
  let refusal;
  try {
    runReleaseStable(opts, { exec, ...quiet });
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof ReleaseRefusal);
  assert.match(refusal.message, new RegExp(`Confirm the cut ${CUT}`));
  assert.ok(refusal.next.some((line) => line.includes(`changelog.mjs draft --version 2026.10.40 --target ${CUT}`)));
  assert.ok(refusal.next.at(-1).includes("--hold") && refusal.next.at(-1).includes(`--confirm-cut-sha ${CUT}`));
  const state = loadState(opts);
  assert.equal(state.phases.cut.status, "refused");
  assert.equal(state.cut.cutSha, CUT);
});

test("with the notes named, it runs every phase once with no stop, and a rerun does nothing again", () => {
  const world = { runs: {}, beta: "2026.10.40-beta.2", pr: { number: 12, html_url: "https://github.com/arcforgelabs/field/pull/12", head: { sha: "e".repeat(40) } } };
  const { exec, calls } = fake(world);
  const opts = options(["--notes-ref", "notes"]);
  const state = runReleaseStable(opts, { exec, ...quiet });
  for (const phase of PHASES) assert.equal(state.phases[phase].status, "completed", phase);
  const dispatched = calls.filter((call) => call.includes("/dispatches"));
  const start = (file) => `gh api -X POST repos/${REPO}/actions/workflows/${file}/dispatches -f ref=main`;
  assert.deepEqual(dispatched, [
    `${start("field-release-branch.yml")} -f inputs[operation]=cut -f inputs[version]=2026.10.40 -f inputs[commits]=${CUT} -f inputs[notes_ref]=notes`,
    `${start("field-release-prepare.yml")} -f inputs[channel]=stable -f inputs[branch]=release/2026.10.40 -f inputs[commit]=${HEAD}`,
    `${start("field-release-promote.yml")} -f inputs[tag]=v2026.10.40`,
  ]);
  assert.ok(calls.includes(`gh api -X PUT repos/${REPO}/pulls/12/merge -f merge_method=squash`));
  assert.ok(calls.includes("curl -fsSL https://arcforgelabs.github.io/docs/field/releases/2026.10.40.md"));
  assert.ok(calls.some((call) => call.startsWith(`gh api -X PATCH repos/${REPO}/releases/5 -F body=@`)));
  assert.ok(calls.includes("node scripts/release/changelog.mjs verify --version 2026.10.40 --check-github --post-docs"));
  assert.equal(state.docs.page, "https://arcforgelabs.github.io/docs/field/releases/2026.10.40/");
  const again = fake(world);
  runReleaseStable(opts, { exec: again.exec, ...quiet });
  assert.deepEqual(again.calls.filter((call) => call.includes("/dispatches") || call.includes("/merge")), []);
});

test("with --hold, publication waits for approval; a failed validation stops the release", () => {
  const world = { runs: {}, beta: "2026.10.39", branch: true };
  const opts = options(["--hold"]);
  assert.throws(() => runReleaseStable(opts, { exec: fake(world).exec, ...quiet }), /Approve publishing v2026.10.40/);
  const failing = { ...world, validation: "failure" };
  assert.throws(() => runReleaseStable(options(), { exec: fake(failing).exec, ...quiet }), /Field Full Release Validation of release\/2026.10.40 ended failure/);
});

test("the roster waits until the docs site serves the page main has", () => {
  const world = { runs: {}, beta: "2026.10.40", branch: true, tagged: true, npm: true, closedOut: true, served: "old" };
  const opts = options(["--notes-ref", "notes"]);
  let now = 0;
  assert.throws(() => runReleaseStable(opts, { exec: fake(world).exec, sleep: (ms) => (now += ms), now: () => now, log: () => {} }), /does not serve docs\/releases\/2026\.10\.40\.md/);
  assert.equal(loadState(opts).phases.thanks.status, "pending");
});

test("a state file from before the docs phases resumes at them", () => {
  const opts = options();
  const state = loadState(opts);
  delete state.phases.docs;
  delete state.phases.thanks;
  delete state.docs;
  delete state.thanks;
  writeFileSync(join(opts.stateDir, "state.json"), JSON.stringify(state));
  const loaded = loadState(opts);
  assert.equal(loaded.phases.docs.status, "pending");
  assert.deepEqual(loaded.thanks, {});
});

test("a dry run prints the commands that change anything and runs none of them", () => {
  const world = { runs: {}, beta: "2026.10.39" };
  const { exec, calls } = fake(world);
  const printed = [];
  const original = console.log;
  console.log = (line) => printed.push(line);
  try {
    runReleaseStable(options(["--confirm-cut-sha", CUT, "--notes-ref", "notes", "--approve-publication", "--dry-run"]), { exec, ...quiet });
  } finally {
    console.log = original;
  }
  assert.deepEqual(calls.filter((call) => call.includes("/dispatches")), []);
  assert.ok(printed.some((line) => line.includes("field-release-branch.yml/dispatches")));
  assert.ok(printed.some((line) => line.includes("field-release-prepare.yml/dispatches")));
});
