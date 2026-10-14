#!/usr/bin/env node
// Which release a Replit deploy of FIELD_DEPLOY_REF=stable or beta builds.
// scripts/replit-deploy.sh asks before it fetches anything.
//
//   node scripts/deploy-release.js <repository-url> <stable|beta>
//
// Prints "<tag> <commit>" on stdout: the release the channel points at
// (server/release-channel.js: GitHub Releases, else npm's dist-tags), and the
// commit its release-manifest.json names, after the manifest is checked
// against its .sha256. Exits 1 with the reason when either cannot be
// established; it never guesses.
//
//   FIELD_DEPLOY_RELEASES_API=<url>       tests only: GitHub's API (default https://api.github.com)
//   FIELD_DEPLOY_RELEASE_DOWNLOADS=<url>  tests only: release downloads (default https://github.com)
//   FIELD_DEPLOY_NPM_REGISTRY=<url>       tests only: npm (default https://registry.npmjs.org)
import { resolve } from "node:path";
import { githubRepoSlug } from "./deploy-checks.js";
import {
  DEFAULT_GITHUB_API,
  DEFAULT_GITHUB_DOWNLOADS,
  DEFAULT_NPM_REGISTRY,
  ReleaseUnavailable,
  resolveChannelRelease,
  verifyReleaseManifest,
} from "../server/release-channel.js";

export async function resolveDeployRelease({ repoUrl, channel, env = process.env, fetchImpl = fetch, retryDelayMs, log = () => {} }) {
  const slug = githubRepoSlug(repoUrl);
  if (!slug) throw new ReleaseUnavailable(`${repoUrl} is not an https://github.com repository, so its releases cannot be read`);
  const trim = (value, fallback) => (value || fallback).replace(/\/+$/, "");
  const githubApi = trim(env.FIELD_DEPLOY_RELEASES_API, DEFAULT_GITHUB_API);
  const githubDownloads = trim(env.FIELD_DEPLOY_RELEASE_DOWNLOADS, DEFAULT_GITHUB_DOWNLOADS);
  const npmRegistry = trim(env.FIELD_DEPLOY_NPM_REGISTRY, DEFAULT_NPM_REGISTRY);
  const found = await resolveChannelRelease({ channel, slug, githubApi, npmRegistry, fetchImpl, retryDelayMs });
  if (found.source === "npm") log(`release: GitHub could not say (${found.githubError}); npm's dist-tag names ${found.tag}`);
  const manifest = await verifyReleaseManifest({ slug, tag: found.tag, githubDownloads, fetchImpl, retryDelayMs });
  return { tag: found.tag, commit: manifest.commit, source: found.source, manifestSha256: manifest.manifestSha256 };
}

async function main([repoUrl, channel]) {
  const log = (line) => console.error(`[deploy] ${line}`);
  log(`release: resolving the ${channel} channel of ${repoUrl}`);
  try {
    const release = await resolveDeployRelease({ repoUrl, channel, log });
    log(`release: ${channel} is ${release.tag} at ${release.commit} (from ${release.source}; release-manifest.json sha256 ${release.manifestSha256} verified)`);
    console.log(`${release.tag} ${release.commit}`);
    return 0;
  } catch (error) {
    if (!(error instanceof ReleaseUnavailable)) throw error;
    log(`release: could not resolve the ${channel} channel: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[deploy] release: failed: ${error?.stack || error}`);
      process.exit(1);
    },
  );
}
