// Which published Field release a channel points at, read anonymously from
// GitHub Releases (with npm's dist-tags as the fallback). Used by the Replit
// deploy (scripts/deploy-release.js, FIELD_DEPLOY_REF=stable|beta).
//
// Release names follow docs/RELEASING.md: vYYYY.M.N is stable,
// vYYYY.M.N-beta.B is a beta of the upcoming YYYY.M.N, and vYYYY.M.N-C is a
// stable correction of YYYY.M.N.
//
//   stable  GitHub's latest release (what Field Release Promote points at, so
//           a rollback is followed), else npm `latest`
//   beta    the newest release of all, betas and stable releases alike, so a
//           beta installation is never behind stable; else npm `beta`
//
// Nothing here sends anything about the installation: each request is an
// anonymous GET of public data.

const TAG = /^v(20\d{2})\.([1-9]|1[0-2])\.([1-9]\d*)(?:-beta\.([1-9]\d*)|-([1-9]\d*))?$/;
export const CHANNELS = ["stable", "beta"];
export const DEFAULT_GITHUB_API = "https://api.github.com";
export const DEFAULT_GITHUB_DOWNLOADS = "https://github.com";
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_PACKAGE = "@arcforgelabs/field";
const ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;

export class ReleaseUnavailable extends Error {}

// { tag, version, channel, parts } for a release tag (with or without its
// leading "v"), or null.
export function parseReleaseTag(value) {
  const tag = String(value ?? "").startsWith("v") ? String(value) : `v${value}`;
  const match = TAG.exec(tag);
  if (!match) return null;
  const beta = match[4] ? Number(match[4]) : null;
  return {
    tag,
    version: tag.slice(1),
    channel: beta ? "beta" : "stable",
    // A stable release sorts after every beta of its own version, and its
    // corrections after it.
    parts: [Number(match[1]), Number(match[2]), Number(match[3]), beta ?? Number.POSITIVE_INFINITY, Number(match[5] ?? 0)],
  };
}

// Negative when a is older than b, positive when newer, 0 when the same.
export function compareReleases(a, b) {
  const [x, y] = [parseReleaseTag(a), parseReleaseTag(b)];
  if (!x || !y) throw new ReleaseUnavailable(`cannot compare ${a} with ${b}`);
  for (let index = 0; index < 5; index += 1) {
    if (x.parts[index] !== y.parts[index]) return x.parts[index] < y.parts[index] ? -1 : 1;
  }
  return 0;
}

async function get(url, { fetchImpl, retryDelayMs, as = "json" }) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: as === "json" ? "application/json" : "*/*", "user-agent": "field-release-channel" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      lastError = `${new URL(url).host} did not answer (${error?.cause?.code || error?.name || "network error"})`;
    }
    if (response) {
      if (response.ok) return as === "json" ? response.json() : Buffer.from(await response.arrayBuffer());
      if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
        throw new ReleaseUnavailable(`GitHub's rate limit for anonymous requests is used up (${url})`);
      }
      lastError = `${url} answered HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) break;
    }
    if (attempt < ATTEMPTS) await new Promise((wake) => setTimeout(wake, attempt * retryDelayMs));
  }
  throw new ReleaseUnavailable(lastError);
}

async function fromGitHub(channel, { slug, githubApi, fetchImpl, retryDelayMs }) {
  if (channel === "stable") {
    const latest = await get(`${githubApi}/repos/${slug}/releases/latest`, { fetchImpl, retryDelayMs });
    const release = parseReleaseTag(latest?.tag_name);
    if (!release || release.channel !== "stable" || latest.prerelease || latest.draft) {
      throw new ReleaseUnavailable(`GitHub's latest release (${latest?.tag_name}) is not a stable Field release`);
    }
    return release.tag;
  }
  const list = await get(`${githubApi}/repos/${slug}/releases?per_page=50`, { fetchImpl, retryDelayMs });
  const tags = (Array.isArray(list) ? list : [])
    .filter((release) => !release.draft && parseReleaseTag(release.tag_name))
    .map((release) => release.tag_name)
    .sort(compareReleases);
  if (!tags.length) throw new ReleaseUnavailable(`${slug} has no published Field release`);
  return tags.at(-1);
}

async function fromNpm(channel, { npmRegistry, packageName, fetchImpl, retryDelayMs }) {
  const metadata = await get(`${npmRegistry}/${packageName.replaceAll("/", "%2f")}`, { fetchImpl, retryDelayMs });
  const distTag = channel === "stable" ? "latest" : "beta";
  const version = metadata?.["dist-tags"]?.[distTag];
  const release = parseReleaseTag(version);
  if (!release || (channel === "stable" && release.channel !== "stable")) {
    throw new ReleaseUnavailable(`npm ${distTag} (${version}) is not a ${channel} Field release`);
  }
  return release.tag;
}

// { tag, source } for the release the channel points at, or a
// ReleaseUnavailable naming why neither GitHub nor npm could say.
export async function resolveChannelRelease({
  channel,
  slug,
  githubApi = DEFAULT_GITHUB_API,
  npmRegistry = DEFAULT_NPM_REGISTRY,
  packageName = DEFAULT_PACKAGE,
  fetchImpl = fetch,
  retryDelayMs = 2000,
}) {
  if (!CHANNELS.includes(channel)) throw new ReleaseUnavailable(`channel must be stable or beta, not "${channel}"`);
  try {
    return { tag: await fromGitHub(channel, { slug, githubApi, fetchImpl, retryDelayMs }), source: "github" };
  } catch (github) {
    if (!(github instanceof ReleaseUnavailable)) throw github;
    try {
      return { tag: await fromNpm(channel, { npmRegistry, packageName, fetchImpl, retryDelayMs }), source: "npm", githubError: github.message };
    } catch (npm) {
      if (!(npm instanceof ReleaseUnavailable)) throw npm;
      throw new ReleaseUnavailable(`GitHub: ${github.message}; npm: ${npm.message}`);
    }
  }
}

// The release's manifest, checked against its .sha256: { commit, version,
// manifestSha256 }.
export async function verifyReleaseManifest({ slug, tag, githubDownloads = DEFAULT_GITHUB_DOWNLOADS, fetchImpl = fetch, retryDelayMs = 2000 }) {
  const { createHash } = await import("node:crypto");
  const base = `${githubDownloads}/${slug}/releases/download/${tag}`;
  const bytes = await get(`${base}/release-manifest.json`, { fetchImpl, retryDelayMs, as: "bytes" });
  const sidecar = (await get(`${base}/release-manifest.json.sha256`, { fetchImpl, retryDelayMs, as: "bytes" })).toString("utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sidecar.trim().split(/\s+/)[0] !== sha256) throw new ReleaseUnavailable(`${tag}'s release-manifest.json does not match its .sha256`);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.tag !== tag || !/^[0-9a-f]{40}$/.test(String(manifest.commit))) {
    throw new ReleaseUnavailable(`${tag}'s release-manifest.json does not describe ${tag}`);
  }
  return { commit: manifest.commit, version: manifest.version, manifestSha256: sha256 };
}
