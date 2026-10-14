// server/release-channel.js: which release a channel points at, from
// stand-ins for GitHub's API, its release downloads and npm.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compareReleases, parseReleaseTag, ReleaseUnavailable, resolveChannelRelease, verifyReleaseManifest } from "./release-channel.js";

const SLUG = "acme/field";
const API = "https://api.test";
const DOWNLOADS = "https://downloads.test";
const NPM = "https://npm.test";
const COMMIT = "c".repeat(40);

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// routes: url -> Response factory. Unknown URLs answer 404.
function fetcher(routes) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetchImpl, requests };
}

const options = (fetchImpl) => ({ slug: SLUG, githubApi: API, npmRegistry: NPM, fetchImpl, retryDelayMs: 1 });

test("release tags parse as openclaw/openclaw's do, and a stable release sorts after its own betas", () => {
  assert.deepEqual(parseReleaseTag("v2026.10.15").channel, "stable");
  assert.deepEqual(parseReleaseTag("2026.10.15-beta.2").tag, "v2026.10.15-beta.2");
  for (const bad of ["v2026.01.15", "0.0.0-placeholder", "v2026.10.15-rc.1", "main", ""]) assert.equal(parseReleaseTag(bad), null, bad);
  const ordered = ["v2026.9.30", "v2026.10.15-beta.1", "v2026.10.15-beta.2", "v2026.10.15", "v2026.10.16-beta.1"];
  assert.deepEqual([...ordered].reverse().sort(compareReleases), ordered);
});

test("stable is GitHub's latest release, so a rollback with Field Release Promote is followed", async () => {
  const { fetchImpl } = fetcher({ [`${API}/repos/${SLUG}/releases/latest`]: () => json({ tag_name: "v2026.10.15", prerelease: false, draft: false }) });
  assert.deepEqual(await resolveChannelRelease({ channel: "stable", ...options(fetchImpl) }), { tag: "v2026.10.15", source: "github" });
});

test("beta is the newest release of all, so a beta installation is never behind stable", async () => {
  const list = [
    { tag_name: "v2026.10.15", prerelease: false, draft: false },
    { tag_name: "v2026.10.15-beta.2", prerelease: true, draft: false },
    { tag_name: "v2026.10.16-beta.1", prerelease: true, draft: true },
    { tag_name: "not-a-release", prerelease: true, draft: false },
  ];
  const { fetchImpl } = fetcher({ [`${API}/repos/${SLUG}/releases?per_page=50`]: () => json(list) });
  assert.equal((await resolveChannelRelease({ channel: "beta", ...options(fetchImpl) })).tag, "v2026.10.15");
  list.push({ tag_name: "v2026.10.17-beta.1", prerelease: true, draft: false });
  assert.equal((await resolveChannelRelease({ channel: "beta", ...options(fetchImpl) })).tag, "v2026.10.17-beta.1");
});

test("when GitHub cannot say, npm's dist-tag answers; a placeholder or a beta is never stable", async () => {
  const limited = () => json({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0" });
  const npm = (distTags) => () => json({ "dist-tags": distTags });
  let { fetchImpl } = fetcher({
    [`${API}/repos/${SLUG}/releases/latest`]: limited,
    [`${NPM}/@arcforgelabs%2ffield`]: npm({ latest: "2026.10.15", beta: "2026.10.16-beta.1" }),
  });
  const stable = await resolveChannelRelease({ channel: "stable", ...options(fetchImpl) });
  assert.equal(stable.tag, "v2026.10.15");
  assert.equal(stable.source, "npm");
  assert.match(stable.githubError, /rate limit/);
  ({ fetchImpl } = fetcher({ [`${API}/repos/${SLUG}/releases/latest`]: limited, [`${NPM}/@arcforgelabs%2ffield`]: npm({ latest: "0.0.0-placeholder" }) }));
  await assert.rejects(resolveChannelRelease({ channel: "stable", ...options(fetchImpl) }), /GitHub: .*rate limit.*; npm: npm latest \(0.0.0-placeholder\) is not a stable Field release/);
  ({ fetchImpl } = fetcher({ [`${API}/repos/${SLUG}/releases/latest`]: () => json({ tag_name: "v2026.10.16-beta.1", prerelease: true }) }));
  await assert.rejects(resolveChannelRelease({ channel: "stable", ...options(fetchImpl) }), ReleaseUnavailable);
  await assert.rejects(resolveChannelRelease({ channel: "main", ...options(fetchImpl) }), /stable or beta/);
});

test("the manifest must match its .sha256 and describe the tag; it names the commit", async () => {
  const manifest = Buffer.from(JSON.stringify({ tag: "v2026.10.15", version: "2026.10.15", commit: COMMIT }));
  const sha = createHash("sha256").update(manifest).digest("hex");
  const base = `${DOWNLOADS}/${SLUG}/releases/download/v2026.10.15`;
  const serve = (sidecar, body = manifest) => fetcher({
    [`${base}/release-manifest.json`]: () => new Response(body),
    [`${base}/release-manifest.json.sha256`]: () => new Response(`${sidecar}  release-manifest.json\n`),
  }).fetchImpl;
  const args = { slug: SLUG, tag: "v2026.10.15", githubDownloads: DOWNLOADS, retryDelayMs: 1 };
  assert.deepEqual(await verifyReleaseManifest({ ...args, fetchImpl: serve(sha) }), { commit: COMMIT, version: "2026.10.15", manifestSha256: sha });
  await assert.rejects(verifyReleaseManifest({ ...args, fetchImpl: serve("0".repeat(64)) }), /does not match its .sha256/);
  const other = Buffer.from(JSON.stringify({ tag: "v2026.10.14", commit: COMMIT }));
  await assert.rejects(verifyReleaseManifest({ ...args, fetchImpl: serve(createHash("sha256").update(other).digest("hex"), other) }), /does not describe v2026.10.15/);
});
