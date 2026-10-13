#!/usr/bin/env node
// Did this commit pass GitHub CI? scripts/replit-deploy.sh asks before it
// builds, so a Replit publish only ever deploys a commit whose CI passed.
//
//   node scripts/deploy-checks.js <repository-url> <commit>
//
// It reads the commit's check runs from the GitHub API, without a token (the
// repository is public), and exits 0 only when every required check below
// completed with success. Anything else exits 1 with the reason: a check that
// failed, is still running or never ran, the API's rate limit (60 requests an
// hour without a token), or no answer from GitHub. It never passes a commit it
// could not check.
//
// Only check runs from GitHub Actions count, so another app cannot report a
// required name. `context` (PR context) runs on pull requests only, so a commit
// on main never has it; the ruleset on main requires it before the merge
// (.github/rulesets/main.json).
//
//   FIELD_DEPLOY_CHECKS_API=<url>   tests only: read the checks from here, not https://api.github.com
import { resolve } from "node:path";

export const REQUIRED_CHECKS = ["test", "client-build", "docker-build", "gitleaks"];
export const GITHUB_ACTIONS_APP_ID = 15368;
const DEFAULT_API = "https://api.github.com";
const ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;

// "owner/name" for an https://github.com repository URL, or null.
export function githubRepoSlug(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? ""));
  return match ? `${match[1]}/${match[2]}` : null;
}

// Whether the check runs show every required check passed. Per name, the
// newest GitHub Actions run counts (a re-run replaces the earlier result).
export function evaluateChecks(checkRuns, required = REQUIRED_CHECKS) {
  const latest = new Map();
  for (const run of checkRuns ?? []) {
    if (run?.app?.id !== GITHUB_ACTIONS_APP_ID) continue;
    const seen = latest.get(run.name);
    if (!seen || run.id > seen.id) latest.set(run.name, run);
  }
  const problems = [];
  for (const name of required) {
    const run = latest.get(name);
    if (!run) problems.push(`${name}: no run on this commit`);
    else if (run.status !== "completed") problems.push(`${name}: still ${String(run.status).replace(/_/g, " ")}`);
    else if (run.conclusion !== "success") problems.push(`${name}: ${run.conclusion}`);
  }
  return { passed: problems.length === 0, problems };
}

class ChecksUnavailable extends Error {}

function rateLimitMessage(response) {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const when = Number.isFinite(reset) && reset > 0 ? ` It resets at ${new Date(reset * 1000).toISOString()}.` : "";
  return `GitHub's API rate limit for unauthenticated requests (60 an hour per address) is used up.${when} Publish again after that`;
}

async function getJson(url, fetchImpl, retryDelayMs) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "field-replit-deploy",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      lastError = `GitHub did not answer (${error?.cause?.code || error?.name || "network error"})`;
      await pause(attempt, retryDelayMs);
      continue;
    }
    if (response.ok) return response.json();
    if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
      throw new ChecksUnavailable(rateLimitMessage(response));
    }
    if (response.status === 404 || response.status === 422) {
      throw new ChecksUnavailable(`GitHub has no such commit in this repository (HTTP ${response.status})`);
    }
    lastError = `GitHub answered HTTP ${response.status}`;
    if (response.status < 500 && response.status !== 429) break;
    await pause(attempt, retryDelayMs);
  }
  throw new ChecksUnavailable(lastError);
}

function pause(attempt, retryDelayMs) {
  if (attempt >= ATTEMPTS) return Promise.resolve();
  return new Promise((wake) => setTimeout(wake, attempt * retryDelayMs));
}

// Every check run on the commit (the API pages at 100).
export async function fetchCheckRuns({ slug, commit, api = DEFAULT_API, fetchImpl = fetch, retryDelayMs = 2000 }) {
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await getJson(`${api}/repos/${slug}/commits/${commit}/check-runs?per_page=100&page=${page}`, fetchImpl, retryDelayMs);
    const batch = Array.isArray(body?.check_runs) ? body.check_runs : [];
    runs.push(...batch);
    if (batch.length < 100 || runs.length >= Number(body?.total_count ?? 0)) break;
  }
  return runs;
}

// { passed, problems } for the commit, or { passed: false, unavailable } when
// GitHub could not say.
export async function checkCommit({ repoUrl, commit, api = DEFAULT_API, fetchImpl = fetch, retryDelayMs }) {
  const slug = githubRepoSlug(repoUrl);
  if (!slug) return { passed: false, unavailable: `${repoUrl} is not an https://github.com repository, so its checks cannot be read` };
  if (!/^[0-9a-f]{40}$/.test(String(commit ?? ""))) return { passed: false, unavailable: `'${commit}' is not a full commit hash` };
  try {
    return evaluateChecks(await fetchCheckRuns({ slug, commit, api, fetchImpl, retryDelayMs }));
  } catch (error) {
    if (error instanceof ChecksUnavailable) return { passed: false, unavailable: error.message };
    throw error;
  }
}

async function main(argv, env) {
  const [repoUrl, commit] = argv;
  const api = (env.FIELD_DEPLOY_CHECKS_API || DEFAULT_API).replace(/\/+$/, "");
  const log = (line) => console.log(`[deploy] ${line}`);
  if (api !== DEFAULT_API) log(`checks: reading from ${api}, not ${DEFAULT_API}`);
  log(`checks: asking GitHub whether ${commit} passed ${REQUIRED_CHECKS.join(", ")}`);
  const result = await checkCommit({ repoUrl, commit, api });
  if (result.passed) {
    log(`checks: passed (${REQUIRED_CHECKS.join(", ")}) at ${commit}`);
    return 0;
  }
  if (result.unavailable) {
    log(`checks: could not be read: ${result.unavailable}`);
  } else {
    log(`checks: NOT passed at ${commit}`);
    for (const problem of result.problems) log(`  ${problem}`);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[deploy] checks: failed: ${error?.stack || error}`);
      process.exit(1);
    },
  );
}
