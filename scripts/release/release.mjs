#!/usr/bin/env node
// Release helpers for the release workflows (docs/RELEASING.md).
//
//   node scripts/release/release.mjs plan --channel beta|stable [--tags <file>]
//     The next release tag for package.json's version on that channel, given
//     the existing tags (one per line in <file>, default: git tag --list).
//   node scripts/release/release.mjs check --tag <tag>
//     Whether <tag> is a release tag that matches package.json's version.
//   node scripts/release/release.mjs migrations
//     The schema and data migrations this checkout ships (needs npm ci).
//   node scripts/release/release.mjs manifest --input <file> --migrations <file>
//     release-manifest.json from the publish workflow's facts and the output
//     of `migrations`.
//
// Each prints JSON on stdout and exits 1 with a reason on stderr.
//
// Versions are calendar versions, named as openclaw/openclaw names its own.
// A stable release is vYYYY.M.D (no leading zeros) and a beta is
// vYYYY.M.D-beta.N, where the beta number belongs to the upcoming stable
// version: v2026.10.15-beta.1 and -beta.2 come before v2026.10.15.
// package.json holds that upcoming stable version. npm dist-tags: a beta
// publishes to `beta`, a stable release to `latest`.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE = /^(20\d{2})\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])$/;
const TAG = /^v(20\d{2}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12]\d|3[01]))(?:-beta\.([1-9]\d*))?$/;

export class ReleaseError extends Error {}

export function parseBaseVersion(version) {
  const match = BASE.exec(String(version ?? ""));
  if (!match) throw new ReleaseError(`"${version}" is not a calendar version YYYY.M.D (no leading zeros)`);
  return { version: match[0], parts: [Number(match[1]), Number(match[2]), Number(match[3])] };
}

// A release tag: its version, base version, channel and beta number.
export function parseTag(tag) {
  const match = TAG.exec(String(tag ?? ""));
  if (!match) throw new ReleaseError(`"${tag}" is not a release tag (vYYYY.M.D or vYYYY.M.D-beta.N)`);
  const base = match[1];
  const beta = match[2] ? Number(match[2]) : null;
  const channel = beta ? "beta" : "stable";
  return {
    tag: match[0],
    version: beta ? `${base}-beta.${beta}` : base,
    base,
    channel,
    beta,
    npmDistTag: channel === "beta" ? "beta" : "latest",
    prerelease: channel === "beta",
  };
}

export function compareBase(a, b) {
  const [x, y] = [parseBaseVersion(a).parts, parseBaseVersion(b).parts];
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

function releaseTags(tags) {
  const parsed = [];
  for (const tag of tags) {
    try {
      parsed.push(parseTag(tag.trim()));
    } catch {
      // Not a release tag.
    }
  }
  return parsed;
}

// The tag field-release-prepare.yml creates for package.json's version.
export function planTag({ packageVersion, channel, tags }) {
  const { version } = parseBaseVersion(packageVersion);
  if (channel !== "beta" && channel !== "stable") throw new ReleaseError(`channel must be beta or stable, not "${channel}"`);
  const existing = releaseTags(tags);
  const newestStable = existing.filter((tag) => tag.channel === "stable").map((tag) => tag.base).sort(compareBase).at(-1);
  if (newestStable && compareBase(version, newestStable) <= 0) {
    throw new ReleaseError(
      `package.json's version ${version} is not newer than the latest stable release v${newestStable}. Open a pull request that sets a newer version first (docs/RELEASING.md).`,
    );
  }
  if (channel === "stable") return parseTag(`v${version}`);
  const betas = existing.filter((tag) => tag.channel === "beta" && tag.base === version).map((tag) => tag.beta);
  return parseTag(`v${version}-beta.${Math.max(0, ...betas) + 1}`);
}

// A tag the publish workflow is asked to release must match package.json.
export function checkTag({ tag, packageVersion }) {
  const parsed = parseTag(tag);
  if (parsed.base !== packageVersion) {
    throw new ReleaseError(`${parsed.tag} does not match package.json's version ${packageVersion} at that commit`);
  }
  return parsed;
}

export async function listMigrations(root) {
  const schema = readdirSync(join(root, "server/db/drizzle"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort();
  let data = [];
  const index = join(root, "server/data-migrations/index.js");
  if (existsSync(index)) {
    const { DATA_MIGRATIONS } = await import(pathToFileURL(index).href);
    data = DATA_MIGRATIONS.map((migration) => migration.id);
  }
  return { schema, data };
}

// release-manifest.json: what was released, from which commit, and how to
// verify each artifact.
export function buildManifest(facts, migrations) {
  const release = parseTag(facts.tag);
  return {
    schemaVersion: 1,
    name: "field",
    version: release.version,
    tag: release.tag,
    channel: release.channel,
    commit: facts.commit,
    repository: facts.repository,
    workflowRun: facts.workflowRun,
    createdAt: facts.createdAt,
    node: facts.node,
    checks: facts.checks,
    npm: {
      package: facts.npm.package,
      version: release.version,
      distTag: release.npmDistTag,
      integrity: facts.npm.integrity,
      shasum: facts.npm.shasum,
      tarball: facts.npm.tarball,
      tarballSha256: facts.npm.tarballSha256,
      provenance: "https://slsa.dev/provenance/v1",
    },
    image: {
      ref: facts.image.ref,
      digest: facts.image.digest,
      tags: facts.image.tags,
      platform: "linux/amd64",
    },
    migrations,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv) {
  const root = resolve(import.meta.dirname, "../..");
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const [command, ...args] = argv;
  let result;
  if (command === "plan") {
    const file = option(args, "--tags");
    const tags = (file ? readFileSync(file, "utf8") : execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" })).split("\n");
    result = planTag({ packageVersion, channel: option(args, "--channel"), tags });
  } else if (command === "check") {
    result = checkTag({ tag: option(args, "--tag"), packageVersion });
  } else if (command === "migrations") {
    result = await listMigrations(root);
  } else if (command === "manifest") {
    const facts = JSON.parse(readFileSync(option(args, "--input"), "utf8"));
    const migrations = JSON.parse(readFileSync(option(args, "--migrations"), "utf8"));
    result = buildManifest(facts, migrations);
  } else {
    throw new ReleaseError("usage: release.mjs plan|check|migrations|manifest (see the header of this file)");
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (result) => {
      const out = option(process.argv, "--output");
      const json = `${JSON.stringify(result, null, 2)}\n`;
      if (out) writeFileSync(out, json);
      else process.stdout.write(json);
    },
    (error) => {
      console.error(error instanceof ReleaseError ? error.message : error);
      process.exit(1);
    },
  );
}
