// scripts/replit-deploy.sh against a local bare repository standing in for
// GitHub, and a local server standing in for GitHub's check-runs API. The
// fixture's own scripts/replit-build.sh and replit-start.sh stand in for
// Field's build and start, because the deploy helper runs the fetched commit's
// scripts, not the workspace's.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const HELPER = resolve(import.meta.dirname, "replit-deploy.sh");
const CHECKS_HELPER = resolve(import.meta.dirname, "deploy-checks.js");
// The deploy fetches this URL; git config maps it to the fixture's bare
// repository, and the checks are read for acme/field from the stand-in API.
const GITHUB_URL = "https://github.com/acme/field.git";
const REQUIRED = ["test", "client-build", "docker-build", "gitleaks"];

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: { ...GIT_ENV, HOME: cwd }, encoding: "utf8" }).trim();
}

function write(path, content) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

// The fetched commit's build: records which version it built, and writes the
// runtime state a real run leaves behind (data/) and a stale .field-revision,
// both of which the helper must replace or remove.
const FIXTURE_BUILD = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cp version.txt built-version.txt
mkdir -p data && echo state > data/field.db
echo not-the-commit > .field-revision
`;
const FIXTURE_START = `#!/usr/bin/env bash
cd "$(dirname "$0")/.."
echo "cwd=$(pwd)"
echo "revision=\${FIELD_REVISION:-}"
echo "ref=\${FIELD_DEPLOYED_REF:-}"
echo "from=\${FIELD_DEPLOYED_FROM:-}"
echo "checks=\${FIELD_DEPLOYED_CHECKS:-}"
`;

// A GitHub stand-in with main at v2, a tag v1 at v1, a branch whose build
// fails, and a workspace cloned from v1 with local edits and runtime state.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "field-replit-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = join(dir, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  write(join(upstream, ".gitignore"), "data/\n.field-deploy/\n.field-revision\n");
  write(join(upstream, "scripts/replit-build.sh"), FIXTURE_BUILD);
  write(join(upstream, "scripts/replit-start.sh"), FIXTURE_START);
  copyFileSync(HELPER, join(upstream, "scripts/replit-deploy.sh"));
  copyFileSync(CHECKS_HELPER, join(upstream, "scripts/deploy-checks.js"));
  write(join(upstream, "version.txt"), "v1\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "v1");
  git(upstream, "tag", "v1");
  const v1 = git(upstream, "rev-parse", "HEAD");
  write(join(upstream, "version.txt"), "v2\n");
  git(upstream, "commit", "-q", "-am", "v2");
  const v2 = git(upstream, "rev-parse", "HEAD");
  git(upstream, "switch", "-q", "-c", "broken");
  write(join(upstream, "scripts/replit-build.sh"), "#!/usr/bin/env bash\nexit 7\n");
  git(upstream, "commit", "-q", "-am", "broken build");
  git(upstream, "switch", "-q", "main");
  // A commit on its own branch whose CI has not passed (the API says so below).
  git(upstream, "switch", "-q", "-c", "untested");
  write(join(upstream, "version.txt"), "untested\n");
  git(upstream, "commit", "-q", "-am", "untested");
  const untested = git(upstream, "rev-parse", "HEAD");
  git(upstream, "switch", "-q", "main");

  const remote = join(dir, "remote.git");
  git(dir, "clone", "-q", "--bare", upstream, remote);

  // The workspace is stale (v1) and dirty, and holds runtime state.
  const workspace = join(dir, "workspace");
  git(dir, "-c", "advice.detachedHead=false", "clone", "-q", "--branch", "v1", remote, workspace);
  write(join(workspace, "version.txt"), "workspace-edit\n");
  write(join(workspace, "new-file.txt"), "untracked\n");
  write(join(workspace, "data/field.db"), "workspace state\n");
  return { dir, workspace, remote: `file://${remote}`, v1, v2, untested };
}

const passing = (names = REQUIRED) => names.map((name, i) => ({ id: i + 1, name, status: "completed", conclusion: "success", app: { id: 15368 } }));

// GitHub's check-runs API for acme/field: every commit passed, unless the test
// says otherwise in `runs` (commit -> check runs) or `respond` (commit -> a
// raw status, headers and body).
async function checksApi(t, { runs = {}, respond = {} } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const match = /^\/repos\/acme\/field\/commits\/([0-9a-f]{40})\/check-runs/.exec(req.url);
    const commit = match?.[1];
    if (commit && respond[commit]) {
      const { status, headers = {}, body = {} } = respond[commit];
      res.writeHead(status, { "content-type": "application/json", ...headers });
      return res.end(JSON.stringify(body));
    }
    if (!commit) {
      res.writeHead(404);
      return res.end("{}");
    }
    const list = runs[commit] ?? passing();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ total_count: list.length, check_runs: list }));
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((closed) => server.close(closed)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// Every file in the workspace outside .field-deploy/, with its content hash,
// plus HEAD and status: proof the helper never touched the workspace's files.
function snapshot(workspace) {
  const files = {};
  const walk = (path) => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const rel = relative(workspace, full);
      if (rel === ".field-deploy") continue;
      if (statSync(full).isDirectory()) walk(full);
      else files[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(workspace);
  return { files, head: git(workspace, "rev-parse", "HEAD"), status: git(workspace, "status", "--porcelain") };
}

// Runs the workspace's deploy helper. Asynchronous, so the stand-in API in
// this process can answer it. `remote` maps GITHUB_URL to the bare repository.
function deploy(workspace, command, env = {}, { remote, api } = {}) {
  const mapped = remote
    ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: GITHUB_URL, FIELD_DEPLOY_REPO: GITHUB_URL }
    : {};
  const child = spawn("bash", [join(workspace, "scripts/replit-deploy.sh"), command], {
    cwd: workspace,
    env: { ...GIT_ENV, HOME: workspace, ...mapped, ...(api ? { FIELD_DEPLOY_CHECKS_API: api.url } : {}), ...env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return new Promise((done) => child.once("close", (status) => done({ status, output })));
}

const out = (workspace, name) => readFileSync(join(workspace, ".field-deploy", name), "utf8").trim();

test("by default the build fetches main from GitHub, checks its CI, and builds it, not the workspace files", async (t) => {
  const { workspace, remote, v2 } = fixture(t);
  const api = await checksApi(t);
  const before = snapshot(workspace);
  const result = await deploy(workspace, "build", {}, { remote, api });
  assert.equal(result.status, 0, result.output);
  assert.equal(out(workspace, "built-version.txt"), "v2");
  assert.equal(out(workspace, ".field-revision"), v2);
  assert.equal(out(workspace, ".field-deploy-ref"), "main");
  assert.equal(out(workspace, ".field-deploy-source"), "github");
  assert.equal(out(workspace, ".field-deploy-checks"), "passed");
  assert.match(result.output, new RegExp(`fetched main at ${v2}`));
  assert.match(result.output, new RegExp(`checks: passed \\(test, client-build, docker-build, gitleaks\\) at ${v2}`));
  assert.match(result.output, /\(checks: passed\)/);
  // It asked about the fetched commit, once.
  assert.deepEqual(api.requests.map((url) => url.split("?")[0]), [`/repos/acme/field/commits/${v2}/check-runs`]);
  // Runtime state never ships, and the workspace's own edits are not in it.
  assert.equal(existsSync(join(workspace, ".field-deploy/data")), false);
  assert.equal(existsSync(join(workspace, ".field-deploy/.git")), false);
  assert.equal(existsSync(join(workspace, ".field-deploy/new-file.txt")), false);
  assert.deepEqual(snapshot(workspace), before);
});

test("FIELD_DEPLOY_REF pins a tag or a full commit hash, and its CI is checked too", async (t) => {
  const { workspace, remote, v1 } = fixture(t);
  const api = await checksApi(t);
  const before = snapshot(workspace);
  for (const ref of ["v1", v1]) {
    const result = await deploy(workspace, "build", { FIELD_DEPLOY_REF: ref }, { remote, api });
    assert.equal(result.status, 0, result.output);
    assert.equal(out(workspace, "built-version.txt"), "v1");
    assert.equal(out(workspace, ".field-revision"), v1);
    assert.equal(out(workspace, ".field-deploy-ref"), ref);
    assert.equal(out(workspace, ".field-deploy-checks"), "passed");
  }
  assert.equal(api.requests.length, 2);
  assert.ok(api.requests.every((url) => url.includes(`/commits/${v1}/`)));
  assert.deepEqual(snapshot(workspace), before);
});

test("a commit whose CI failed, is still running or never ran is not built", async (t) => {
  const { workspace, remote, untested } = fixture(t);
  const cases = [
    { runs: passing().map((run) => (run.name === "test" ? { ...run, conclusion: "failure" } : run)), says: /test: failure/ },
    { runs: passing().map((run) => (run.name === "docker-build" ? { ...run, status: "in_progress", conclusion: null } : run)), says: /docker-build: still in progress/ },
    { runs: passing(["test", "client-build", "docker-build"]), says: /gitleaks: no run on this commit/ },
    // Another app reporting a required name does not count.
    { runs: passing().map((run) => (run.name === "client-build" ? { ...run, app: { id: 1 } } : run)), says: /client-build: no run on this commit/ },
  ];
  const before = snapshot(workspace);
  for (const { runs, says } of cases) {
    const api = await checksApi(t, { runs: { [untested]: runs } });
    const result = await deploy(workspace, "build", { FIELD_DEPLOY_REF: "untested" }, { remote, api });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, says);
    assert.match(result.output, new RegExp(`FAILED: untested at ${untested} has not passed GitHub CI, so nothing was built`));
    assert.doesNotMatch(result.output, /building github/);
    assert.equal(existsSync(join(workspace, ".field-deploy")), false);
  }
  assert.deepEqual(snapshot(workspace), before);
});

test("the API's rate limit or no answer from GitHub fails the build closed", async (t) => {
  const { workspace, remote, v2 } = fixture(t);
  const limited = await checksApi(t, {
    respond: { [v2]: { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791874800" }, body: { message: "API rate limit exceeded" } } },
  });
  const rate = await deploy(workspace, "build", {}, { remote, api: limited });
  assert.notEqual(rate.status, 0, rate.output);
  assert.match(rate.output, /rate limit for unauthenticated requests \(60 an hour per address\) is used up\. It resets at 2026-10-13T\d\d:00:00\.000Z/);
  assert.match(rate.output, /has not passed GitHub CI, so nothing was built/);
  assert.equal(existsSync(join(workspace, ".field-deploy")), false);

  // Nothing listens on this port: a network failure.
  const closed = createServer();
  await new Promise((ready) => closed.listen(0, "127.0.0.1", ready));
  const { port } = closed.address();
  await new Promise((done) => closed.close(done));
  const down = await deploy(workspace, "build", {}, { remote, api: { url: `http://127.0.0.1:${port}` } });
  assert.notEqual(down.status, 0, down.output);
  assert.match(down.output, /checks: could not be read: GitHub did not answer/);
  assert.match(down.output, /reading from http:\/\/127\.0\.0\.1/);
  assert.equal(existsSync(join(workspace, ".field-deploy")), false);

  // A repository that is not on github.com has no checks to read.
  const local = await deploy(workspace, "build", { FIELD_DEPLOY_REPO: remote });
  assert.notEqual(local.status, 0, local.output);
  assert.match(local.output, /is not an https:\/\/github\.com repository/);
});

test("FIELD_DEPLOY_ALLOW_UNCHECKED=1 builds an unchecked commit, says so, and records it", async (t) => {
  const { workspace, remote, untested } = fixture(t);
  const api = await checksApi(t, { runs: { [untested]: [] } });
  const result = await deploy(workspace, "build", { FIELD_DEPLOY_REF: "untested", FIELD_DEPLOY_ALLOW_UNCHECKED: "1" }, { remote, api });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /test: no run on this commit/);
  assert.match(result.output, new RegExp(`WARNING: FIELD_DEPLOY_ALLOW_UNCHECKED=1: building untested at ${untested} although CI did not pass`));
  assert.equal(out(workspace, "built-version.txt"), "untested");
  assert.equal(out(workspace, ".field-deploy-checks"), "unchecked");
  const start = await deploy(workspace, "start", { FIELD_DEPLOY_REF: "untested" });
  assert.match(start.output, /\(checks: unchecked\)/);
  assert.match(start.output, /checks=unchecked\n/);

  // A commit that passed is recorded as passed even with the override set.
  const passed = await deploy(workspace, "build", { FIELD_DEPLOY_ALLOW_UNCHECKED: "1" }, { remote, api });
  assert.equal(passed.status, 0, passed.output);
  assert.doesNotMatch(passed.output, /WARNING/);
  assert.equal(out(workspace, ".field-deploy-checks"), "passed");
});

test("a failed fetch fails the build and deploys nothing, not the workspace copy", async (t) => {
  const { dir, workspace, remote } = fixture(t);
  const api = await checksApi(t);
  const before = snapshot(workspace);
  // A good build first, so a stale one is there to be (wrongly) reused.
  assert.equal((await deploy(workspace, "build", {}, { remote, api })).status, 0);
  for (const env of [
    { FIELD_DEPLOY_REPO: `file://${join(dir, "missing.git")}` },
    { FIELD_DEPLOY_REPO: remote, FIELD_DEPLOY_REF: "no-such-branch" },
  ]) {
    const result = await deploy(workspace, "build", env);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /\[deploy\] FAILED: could not fetch/);
    assert.equal(existsSync(join(workspace, ".field-deploy")), false);
    const start = await deploy(workspace, "start");
    assert.notEqual(start.status, 0);
    assert.match(start.output, /no deployment build/);
  }
  assert.deepEqual(snapshot(workspace), before);
});

test("a ref that git could read as an option is refused", async (t) => {
  const { workspace, remote } = fixture(t);
  const result = await deploy(workspace, "build", { FIELD_DEPLOY_REPO: remote, FIELD_DEPLOY_REF: "--upload-pack=touch pwned" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /is not a branch, tag or full commit hash/);
  assert.equal(existsSync(join(workspace, "pwned")), false);
});

test("a failing build of the fetched commit fails the deployment build", async (t) => {
  const { workspace, remote } = fixture(t);
  const api = await checksApi(t);
  const result = await deploy(workspace, "build", { FIELD_DEPLOY_REF: "broken" }, { remote, api });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /FAILED: the build of broken failed/);
});

test("FIELD_DEPLOY_FROM_WORKSPACE=1 needs FIELD_DEPLOY_ALLOW_UNCHECKED=1, then builds the workspace files as they are", async (t) => {
  const { workspace, v1 } = fixture(t);
  const before = snapshot(workspace);
  // No FIELD_DEPLOY_REPO that works: the opt-out never fetches.
  const refused = await deploy(workspace, "build", { FIELD_DEPLOY_FROM_WORKSPACE: "1", FIELD_DEPLOY_REPO: "file:///nowhere.git" });
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /FIELD_DEPLOY_FROM_WORKSPACE=1 builds files no CI ran on, so it also needs FIELD_DEPLOY_ALLOW_UNCHECKED=1/);
  assert.equal(existsSync(join(workspace, ".field-deploy")), false);

  const result = await deploy(workspace, "build", {
    FIELD_DEPLOY_FROM_WORKSPACE: "1",
    FIELD_DEPLOY_ALLOW_UNCHECKED: "1",
    FIELD_DEPLOY_REPO: "file:///nowhere.git",
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /NOT GitHub/);
  assert.match(result.output, /uncommitted changes/);
  assert.equal(out(workspace, "built-version.txt"), "workspace-edit");
  assert.equal(out(workspace, "new-file.txt"), "untracked");
  assert.equal(out(workspace, ".field-revision"), v1);
  assert.equal(out(workspace, ".field-deploy-source"), "workspace");
  assert.equal(out(workspace, ".field-deploy-checks"), "unchecked");
  assert.equal(existsSync(join(workspace, ".field-deploy/data")), false);
  assert.deepEqual(snapshot(workspace), before);
});

test("start runs the fetched build's start script with its commit, ref and CI result", async (t) => {
  const { workspace, remote, v1 } = fixture(t);
  const api = await checksApi(t);
  assert.equal((await deploy(workspace, "build", { FIELD_DEPLOY_REF: "v1" }, { remote, api })).status, 0);
  const result = await deploy(workspace, "start", { FIELD_DEPLOY_REF: "v1", FIELD_REVISION: "stale", FIELD_DEPLOYED_CHECKS: "stale" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`cwd=${join(workspace, ".field-deploy")}\\n`));
  assert.match(result.output, new RegExp(`revision=${v1}\\n`));
  assert.match(result.output, /ref=v1\n/);
  assert.match(result.output, /from=github\n/);
  assert.match(result.output, /checks=passed\n/);
  assert.match(result.output, new RegExp(`starting github v1 at ${v1} \\(checks: passed\\)`));
  assert.doesNotMatch(result.output, /WARNING/);
  // The runtime asks for another ref than the build fetched: say so loudly.
  const drift = await deploy(workspace, "start", { FIELD_DEPLOY_REF: "main" });
  assert.match(drift.output, /WARNING: FIELD_DEPLOY_REF is 'main' now, but this build fetched 'v1'/);
});
