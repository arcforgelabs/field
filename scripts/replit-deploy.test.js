// scripts/replit-deploy.sh against a local bare repository standing in for
// GitHub. The fixture's own scripts/replit-build.sh and replit-start.sh stand in
// for Field's build and start, because the deploy helper runs the fetched
// commit's scripts, not the workspace's.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const HELPER = resolve(import.meta.dirname, "replit-deploy.sh");

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

  const remote = join(dir, "remote.git");
  git(dir, "clone", "-q", "--bare", upstream, remote);

  // The workspace is stale (v1) and dirty, and holds runtime state.
  const workspace = join(dir, "workspace");
  git(dir, "-c", "advice.detachedHead=false", "clone", "-q", "--branch", "v1", remote, workspace);
  write(join(workspace, "version.txt"), "workspace-edit\n");
  write(join(workspace, "new-file.txt"), "untracked\n");
  write(join(workspace, "data/field.db"), "workspace state\n");
  return { dir, workspace, remote: `file://${remote}`, v1, v2 };
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

function deploy(workspace, command, env = {}) {
  const result = spawnSync("bash", [join(workspace, "scripts/replit-deploy.sh"), command], {
    cwd: workspace,
    env: { ...GIT_ENV, HOME: workspace, ...env },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const out = (workspace, name) => readFileSync(join(workspace, ".field-deploy", name), "utf8").trim();

test("by default the build fetches main from GitHub, not the workspace files", (t) => {
  const { workspace, remote, v2 } = fixture(t);
  const before = snapshot(workspace);
  const result = deploy(workspace, "build", { FIELD_DEPLOY_REPO: remote });
  assert.equal(result.status, 0, result.output);
  assert.equal(out(workspace, "built-version.txt"), "v2");
  assert.equal(out(workspace, ".field-revision"), v2);
  assert.equal(out(workspace, ".field-deploy-ref"), "main");
  assert.equal(out(workspace, ".field-deploy-source"), "github");
  assert.match(result.output, new RegExp(`fetched main at ${v2}`));
  // Runtime state never ships, and the workspace's own edits are not in it.
  assert.equal(existsSync(join(workspace, ".field-deploy/data")), false);
  assert.equal(existsSync(join(workspace, ".field-deploy/.git")), false);
  assert.equal(existsSync(join(workspace, ".field-deploy/new-file.txt")), false);
  assert.deepEqual(snapshot(workspace), before);
});

test("FIELD_DEPLOY_REF pins a tag or a full commit hash", (t) => {
  const { workspace, remote, v1 } = fixture(t);
  const before = snapshot(workspace);
  for (const ref of ["v1", v1]) {
    const result = deploy(workspace, "build", { FIELD_DEPLOY_REPO: remote, FIELD_DEPLOY_REF: ref });
    assert.equal(result.status, 0, result.output);
    assert.equal(out(workspace, "built-version.txt"), "v1");
    assert.equal(out(workspace, ".field-revision"), v1);
    assert.equal(out(workspace, ".field-deploy-ref"), ref);
  }
  assert.deepEqual(snapshot(workspace), before);
});

test("a failed fetch fails the build and deploys nothing, not the workspace copy", (t) => {
  const { dir, workspace, remote } = fixture(t);
  const before = snapshot(workspace);
  // A good build first, so a stale one is there to be (wrongly) reused.
  assert.equal(deploy(workspace, "build", { FIELD_DEPLOY_REPO: remote }).status, 0);
  for (const env of [
    { FIELD_DEPLOY_REPO: `file://${join(dir, "missing.git")}` },
    { FIELD_DEPLOY_REPO: remote, FIELD_DEPLOY_REF: "no-such-branch" },
  ]) {
    const result = deploy(workspace, "build", env);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /\[deploy\] FAILED: could not fetch/);
    assert.equal(existsSync(join(workspace, ".field-deploy")), false);
    const start = deploy(workspace, "start");
    assert.notEqual(start.status, 0);
    assert.match(start.output, /no deployment build/);
  }
  assert.deepEqual(snapshot(workspace), before);
});

test("a ref that git could read as an option is refused", (t) => {
  const { workspace, remote } = fixture(t);
  const result = deploy(workspace, "build", { FIELD_DEPLOY_REPO: remote, FIELD_DEPLOY_REF: "--upload-pack=touch pwned" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /is not a branch, tag or full commit hash/);
  assert.equal(existsSync(join(workspace, "pwned")), false);
});

test("a failing build of the fetched commit fails the deployment build", (t) => {
  const { workspace, remote } = fixture(t);
  const result = deploy(workspace, "build", { FIELD_DEPLOY_REPO: remote, FIELD_DEPLOY_REF: "broken" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /FAILED: the build of broken failed/);
});

test("FIELD_DEPLOY_FROM_WORKSPACE=1 builds the workspace files as they are, without runtime state", (t) => {
  const { workspace, v1 } = fixture(t);
  const before = snapshot(workspace);
  // No FIELD_DEPLOY_REPO that works: the opt-out never fetches.
  const result = deploy(workspace, "build", { FIELD_DEPLOY_FROM_WORKSPACE: "1", FIELD_DEPLOY_REPO: "file:///nowhere.git" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /NOT GitHub/);
  assert.match(result.output, /uncommitted changes/);
  assert.equal(out(workspace, "built-version.txt"), "workspace-edit");
  assert.equal(out(workspace, "new-file.txt"), "untracked");
  assert.equal(out(workspace, ".field-revision"), v1);
  assert.equal(out(workspace, ".field-deploy-source"), "workspace");
  assert.equal(existsSync(join(workspace, ".field-deploy/data")), false);
  assert.deepEqual(snapshot(workspace), before);
});

test("start runs the fetched build's start script with its commit and ref", (t) => {
  const { workspace, remote, v1 } = fixture(t);
  assert.equal(deploy(workspace, "build", { FIELD_DEPLOY_REPO: remote, FIELD_DEPLOY_REF: "v1" }).status, 0);
  const result = deploy(workspace, "start", { FIELD_DEPLOY_REF: "v1", FIELD_REVISION: "stale" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`cwd=${join(workspace, ".field-deploy")}\\n`));
  assert.match(result.output, new RegExp(`revision=${v1}\\n`));
  assert.match(result.output, /ref=v1\n/);
  assert.match(result.output, /from=github\n/);
  assert.doesNotMatch(result.output, /WARNING/);
  // The runtime asks for another ref than the build fetched: say so loudly.
  const drift = deploy(workspace, "start", { FIELD_DEPLOY_REF: "main" });
  assert.match(drift.output, /WARNING: FIELD_DEPLOY_REF is 'main' now, but this build fetched 'v1'/);
});
