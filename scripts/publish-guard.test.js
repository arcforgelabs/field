// scripts/publish-guard.js: an automation publishes only a finished, checked
// release, and confirms it went live, from stand-ins for GitHub, npm and the
// app's /health.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { REQUIRED_CHECKS } from "./deploy-checks.js";
import { after, before, withGitHubToken } from "./publish-guard.js";

const SLUG = "arcforgelabs/field";
const API = "https://api.test";
const DOWNLOADS = "https://downloads.test";
const NPM = "https://npm.test";
const APP = "https://app.test";
const COMMIT = "c".repeat(40);
const ENV = { FIELD_DEPLOY_RELEASES_API: API, FIELD_DEPLOY_RELEASE_DOWNLOADS: DOWNLOADS, FIELD_DEPLOY_NPM_REGISTRY: NPM, FIELD_DEPLOY_CHECKS_API: API };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function world({ github = "v2026.10.42", npm = "2026.10.42", checks = "success", live = "v2026.10.41", health = {}, build = {} } = {}) {
  const manifest = Buffer.from(JSON.stringify({ tag: github, version: github.slice(1), commit: COMMIT }));
  const sha = createHash("sha256").update(manifest).digest("hex");
  const run = (name) => ({ id: 1, name, status: "completed", conclusion: checks, app: { id: 15368 } });
  const routes = {
    [`${API}/repos/${SLUG}/releases/latest`]: () => json({ tag_name: github, prerelease: false, draft: false }),
    [`${NPM}/@arcforgelabs%2ffield`]: () => json({ "dist-tags": { latest: npm } }),
    [`${DOWNLOADS}/${SLUG}/releases/download/${github}/release-manifest.json`]: () => new Response(manifest),
    [`${DOWNLOADS}/${SLUG}/releases/download/${github}/release-manifest.json.sha256`]: () => new Response(`${sha}  release-manifest.json\n`),
    [`${API}/repos/${SLUG}/commits/${COMMIT}/check-runs?per_page=100&page=1`]: () => json({ total_count: 4, check_runs: REQUIRED_CHECKS.map(run) }),
    [`${APP}/health`]: () => json({ ok: true, build: { ref: "stable", source: "github", checks: "passed", release: live, revision: COMMIT, ...build }, ...health }),
  };
  return async (url) => (routes[url] ? routes[url]() : new Response("not found", { status: 404 }));
}

const guard = (options) => before({ origin: APP, env: ENV, retryDelayMs: 1, fetchImpl: world(options) });

test("a finished, checked release newer than the live app may be published", async () => {
  const result = await guard();
  assert.equal(result.decision, "publish", result.problems.join("; "));
  assert.equal(result.tag, "v2026.10.42");
  assert.equal(result.commit, COMMIT);
  assert.equal(result.live, "v2026.10.41");
});

test("an app that already runs the release needs nothing", async () => {
  assert.equal((await guard({ live: "v2026.10.42" })).decision, "up-to-date");
});

test("GitHub and npm must name the same release, so a half-finished release is not published", async () => {
  const result = await guard({ npm: "2026.10.41" });
  assert.equal(result.decision, "stop");
  assert.match(result.problems[0], /not finished/);
});

test("GitHub or npm that cannot be read stops the guard", async () => {
  const result = await guard({ npm: "not-a-release" });
  assert.equal(result.decision, "stop");
  assert.match(result.problems[0], /^npm: /);
});

test("a release whose commit did not pass CI is not published", async () => {
  const result = await guard({ checks: "failure" });
  assert.equal(result.decision, "stop");
  assert.ok(result.problems.some((problem) => /test: failure/.test(problem)));
});

test("the guard stops for a live app that is unwell, pinned, built from the workspace or newer", async () => {
  assert.equal((await guard({ health: { ok: false } })).decision, "stop");
  assert.equal((await guard({ build: { ref: "v2026.10.40" } })).decision, "stop");
  assert.equal((await guard({ build: { source: "workspace" } })).decision, "stop");
  const newer = await guard({ live: "v2026.10.43" });
  assert.equal(newer.decision, "stop");
  assert.match(newer.problems[0], /rollback/);
});

test("durable storage that is not ok is a warning, not a stop", async () => {
  const result = await guard({ health: { storage: { enabled: true, state: "degraded" } } });
  assert.equal(result.decision, "publish");
  assert.deepEqual(result.warnings, ["storage: state is degraded, not ok"]);
});

test("after a publish, the live app must name the release with checks passed", async () => {
  const live = await after({ origin: APP, tag: "v2026.10.42", waitSeconds: 0, fetchImpl: world({ live: "v2026.10.42" }) });
  assert.equal(live.decision, "live");
  const stale = await after({ origin: APP, tag: "v2026.10.42", waitSeconds: 0, fetchImpl: world({ live: "v2026.10.41" }) });
  assert.equal(stale.decision, "stop");
  const unchecked = await after({ origin: APP, tag: "v2026.10.42", waitSeconds: 0, fetchImpl: world({ live: "v2026.10.42", build: { checks: "unchecked" } }) });
  assert.equal(unchecked.decision, "stop");
});

test("after waits while the app restarts", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return world({ live: calls < 3 ? "v2026.10.41" : "v2026.10.42" })(url);
  };
  const result = await after({ origin: APP, tag: "v2026.10.42", waitSeconds: 60, intervalMs: 1, fetchImpl, sleep: async () => {} });
  assert.equal(result.decision, "live");
  assert.equal(calls, 3);
});

test("the token goes to api.github.com only", async () => {
  const seen = [];
  const fetchImpl = withGitHubToken("secret", async (url, options) => {
    seen.push([new URL(url).host, options?.headers?.authorization]);
    return json({});
  });
  await fetchImpl("https://api.github.com/x");
  await fetchImpl("https://registry.npmjs.org/x");
  await fetchImpl(`${APP}/health`);
  assert.deepEqual(seen, [["api.github.com", "Bearer secret"], ["registry.npmjs.org", undefined], ["app.test", undefined]]);
});
