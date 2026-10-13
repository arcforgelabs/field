// scripts/deploy-checks.js: whether a commit passed GitHub CI, before a Replit
// publish builds it. scripts/replit-deploy.test.js runs it through the deploy.
import test from "node:test";
import assert from "node:assert/strict";
import { checkCommit, evaluateChecks, githubRepoSlug, REQUIRED_CHECKS } from "./deploy-checks.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ACTIONS = { id: 15368 };
const run = (id, name, conclusion = "success", status = "completed", app = ACTIONS) => ({ id, name, status, conclusion, app });
const allPassed = () => REQUIRED_CHECKS.map((name, i) => run(i + 1, name));

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("the required checks are CI's test, client-build and docker-build, and Secret Scan's gitleaks", () => {
  assert.deepEqual(REQUIRED_CHECKS, ["test", "client-build", "docker-build", "gitleaks"]);
});

test("only an https://github.com repository URL has a slug", () => {
  assert.equal(githubRepoSlug("https://github.com/embarkearthworks/field.git"), "embarkearthworks/field");
  assert.equal(githubRepoSlug("https://github.com/embarkearthworks/field"), "embarkearthworks/field");
  assert.equal(githubRepoSlug("https://github.com/a-b/c.d/"), "a-b/c.d");
  for (const url of ["file:///tmp/field.git", "git@github.com:a/b.git", "https://github.com.evil.example/a/b", "https://github.com/a/b/c", "", undefined]) {
    assert.equal(githubRepoSlug(url), null, String(url));
  }
});

test("every required check must have completed with success", () => {
  assert.deepEqual(evaluateChecks(allPassed()), { passed: true, problems: [] });
  const skipped = allPassed().map((r) => (r.name === "test" ? { ...r, conclusion: "skipped" } : r));
  assert.deepEqual(evaluateChecks(skipped).problems, ["test: skipped"]);
  const queued = allPassed().map((r) => (r.name === "gitleaks" ? { ...r, status: "queued", conclusion: null } : r));
  assert.deepEqual(evaluateChecks(queued).problems, ["gitleaks: still queued"]);
  assert.deepEqual(evaluateChecks([]).problems, REQUIRED_CHECKS.map((name) => `${name}: no run on this commit`));
  assert.equal(evaluateChecks(null).passed, false);
});

test("the newest GitHub Actions run of each check counts, and other apps' runs do not", () => {
  const rerunFixed = [...allPassed().filter((r) => r.name !== "test"), run(10, "test", "failure"), run(11, "test")];
  assert.equal(evaluateChecks(rerunFixed).passed, true);
  const rerunBroke = [...allPassed(), run(20, "test", "failure")];
  assert.deepEqual(evaluateChecks(rerunBroke).problems, ["test: failure"]);
  const spoofed = [...allPassed().filter((r) => r.name !== "docker-build"), run(30, "docker-build", "success", "completed", { id: 999 })];
  assert.deepEqual(evaluateChecks(spoofed).problems, ["docker-build: no run on this commit"]);
});

test("checkCommit reads every page of check runs for the commit", async () => {
  const urls = [];
  const filler = Array.from({ length: 100 }, (_, i) => run(100 + i, `other-${i}`));
  const fetchImpl = async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return reply(200, { total_count: 104, check_runs: page === 1 ? filler : allPassed() });
  };
  const result = await checkCommit({ repoUrl: "https://github.com/acme/field.git", commit: COMMIT, api: "https://api.example", fetchImpl });
  assert.deepEqual(result, { passed: true, problems: [] });
  assert.deepEqual(urls, [1, 2].map((page) => `https://api.example/repos/acme/field/commits/${COMMIT}/check-runs?per_page=100&page=${page}`));
});

test("checkCommit fails closed when GitHub cannot say", async () => {
  const check = (fetchImpl, extra = {}) => checkCommit({ repoUrl: "https://github.com/acme/field", commit: COMMIT, fetchImpl, retryDelayMs: 1, ...extra });

  const limited = await check(async () => reply(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791874800" }));
  assert.equal(limited.passed, false);
  assert.match(limited.unavailable, /rate limit .* is used up\. It resets at 2026-10-13T/);

  const missing = await check(async () => reply(404, { message: "Not Found" }));
  assert.match(missing.unavailable, /no such commit/);

  // A server error is retried, then gives up.
  let calls = 0;
  const flaky = await check(async () => { calls += 1; return reply(502, {}); });
  assert.equal(calls, 3);
  assert.match(flaky.unavailable, /HTTP 502/);

  // A network failure is retried, then gives up; a later success passes.
  calls = 0;
  const recovered = await check(async () => {
    calls += 1;
    if (calls < 2) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return reply(200, { total_count: 4, check_runs: allPassed() });
  });
  assert.deepEqual(recovered, { passed: true, problems: [] });
  const down = await check(async () => { throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }); });
  assert.match(down.unavailable, /GitHub did not answer \(ENOTFOUND\)/);

  // Nothing is asked for a URL or commit that cannot be checked.
  const never = async () => assert.fail("must not fetch");
  assert.match((await check(never, { repoUrl: "file:///tmp/field.git" })).unavailable, /not an https:\/\/github\.com repository/);
  assert.match((await check(never, { commit: "main" })).unavailable, /not a full commit hash/);
});
