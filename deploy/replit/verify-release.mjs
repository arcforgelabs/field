#!/usr/bin/env node
// Pins and verifies a Field release for a self-hosted installation
// (docs/SELF_HOSTING.md). No dependencies; Node 24.
//
//   node verify-release.mjs pin <version>
//     Writes field.lock for that release from its GitHub Release manifest,
//     after checking the manifest's .sha256 and that npm serves the same
//     integrity. Commit field.lock to your deploy repository.
//   node verify-release.mjs version
//     Prints the version field.lock pins (install-and-verify.sh uses it).
//   node verify-release.mjs verify <install-dir>
//     After `npm install` in <install-dir>: the installed package is the
//     pinned version with the pinned integrity, and its npm provenance says
//     it was built from the pinned commit of the Field repository by its
//     release workflow. Run `npm audit signatures` too: it checks the
//     signatures cryptographically; this checks what they claim.
//
// Exits 1 with the reason on any mismatch. Overrides, for tests and mirrors:
// FIELD_NPM_REGISTRY (default https://registry.npmjs.org) and
// FIELD_RELEASES_URL (default https://github.com/<repository>/releases/download).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE = "@arcforgelabs/field";
export const DEFAULT_REPOSITORY = "arcforgelabs/field";
export const RELEASE_WORKFLOW = ".github/workflows/field-npm-release.yml";
const VERSION = /^20\d{2}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12]\d|3[01])(?:-beta\.[1-9]\d*)?$/;
const SLSA_V1 = "https://slsa.dev/provenance/v1";

export class VerifyError extends Error {}

function fail(message) {
  throw new VerifyError(message);
}

function registry(env) {
  return (env.FIELD_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
}

function releasesUrl(env, repository) {
  return (env.FIELD_RELEASES_URL || `https://github.com/${repository}/releases/download`).replace(/\/$/, "");
}

async function fetchOk(url, fetchImpl, as = "json") {
  const response = await fetchImpl(url, { headers: { accept: as === "json" ? "application/json" : "*/*" } });
  if (!response.ok) fail(`${url} answered ${response.status}`);
  return as === "json" ? response.json() : Buffer.from(await response.arrayBuffer());
}

export function readLock(path) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}. Run "node verify-release.mjs pin <version>" to write it.`);
  }
  if (lock.package !== PACKAGE) fail(`${path} pins ${lock.package}, not ${PACKAGE}`);
  if (!VERSION.test(String(lock.version))) fail(`${path} has no release version (got "${lock.version}")`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(lock.integrity))) fail(`${path} has no sha512 integrity`);
  if (!/^[0-9a-f]{40}$/.test(String(lock.commit))) fail(`${path} has no 40-character commit`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(lock.repository))) fail(`${path} has no owner/name repository`);
  return lock;
}

// field.lock for a published release.
export async function pin(version, { env = process.env, fetchImpl = fetch, repository = DEFAULT_REPOSITORY } = {}) {
  if (!VERSION.test(String(version))) fail(`"${version}" is not a Field release version (YYYY.M.D or YYYY.M.D-beta.N)`);
  const base = `${releasesUrl(env, repository)}/v${version}`;
  const manifestBytes = await fetchOk(`${base}/release-manifest.json`, fetchImpl, "bytes");
  const sidecar = (await fetchOk(`${base}/release-manifest.json.sha256`, fetchImpl, "bytes")).toString("utf8");
  const sha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (sidecar.split(/\s+/)[0] !== sha256) fail(`release-manifest.json for v${version} does not match its .sha256`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.version !== version || manifest.npm?.package !== PACKAGE) fail(`the manifest for v${version} describes ${manifest.npm?.package}@${manifest.version}`);
  const served = await fetchOk(`${registry(env)}/${PACKAGE.replaceAll("/", "%2f")}/${version}`, fetchImpl);
  if (served.dist?.integrity !== manifest.npm.integrity) {
    fail(`npm serves ${served.dist?.integrity} for ${PACKAGE}@${version}; the release manifest says ${manifest.npm.integrity}`);
  }
  return {
    package: PACKAGE,
    version,
    integrity: manifest.npm.integrity,
    commit: manifest.commit,
    repository,
    image: `${manifest.image.ref}@${manifest.image.digest}`,
    manifestSha256: sha256,
  };
}

// The provenance statement npm holds for one version, decoded.
async function provenance(lock, { env, fetchImpl }) {
  const url = `${registry(env)}/-/npm/v1/attestations/${PACKAGE.replaceAll("/", "%2f")}@${lock.version}`;
  const { attestations = [] } = await fetchOk(url, fetchImpl);
  const slsa = attestations.find((attestation) => attestation.predicateType === SLSA_V1);
  if (!slsa) fail(`${PACKAGE}@${lock.version} has no SLSA provenance on npm`);
  return JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
}

// The installed package against field.lock, and its provenance's claims.
export async function verify(installDir, lock, { env = process.env, fetchImpl = fetch } = {}) {
  const tree = JSON.parse(readFileSync(join(installDir, "package-lock.json"), "utf8"));
  const installed = tree.packages?.[`node_modules/${PACKAGE}`];
  if (!installed) fail(`${PACKAGE} is not installed in ${installDir}`);
  if (installed.version !== lock.version) fail(`installed ${PACKAGE}@${installed.version}; field.lock pins ${lock.version}`);
  if (installed.integrity !== lock.integrity) fail(`installed integrity ${installed.integrity} is not field.lock's ${lock.integrity}`);

  const statement = await provenance(lock, { env, fetchImpl });
  const digest = Buffer.from(lock.integrity.slice("sha512-".length), "base64").toString("hex");
  const subject = statement.subject?.find((entry) => entry.digest?.sha512 === digest);
  if (!subject) fail(`the provenance does not describe the pinned bytes (${lock.integrity})`);
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  const expectedRepository = `https://github.com/${lock.repository}`;
  if (workflow.repository !== expectedRepository) fail(`the provenance says it was built from ${workflow.repository}, not ${expectedRepository}`);
  if (workflow.path !== RELEASE_WORKFLOW) fail(`the provenance says it was built by ${workflow.path}, not ${RELEASE_WORKFLOW}`);
  const commit = statement.predicate?.buildDefinition?.resolvedDependencies?.find((dependency) => dependency.digest?.gitCommit)?.digest.gitCommit;
  if (commit !== lock.commit) fail(`the provenance names commit ${commit}; field.lock pins ${lock.commit}`);
  return { version: lock.version, integrity: lock.integrity, commit, repository: expectedRepository };
}

async function main([command, argument]) {
  const here = import.meta.dirname;
  const lockPath = resolve(process.env.FIELD_LOCK || join(here, "field.lock"));
  if (command === "pin") {
    const lock = await pin(argument);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`Pinned ${PACKAGE}@${lock.version} (${lock.integrity}) in ${lockPath}`);
  } else if (command === "version") {
    console.log(readLock(lockPath).version);
  } else if (command === "verify") {
    const result = await verify(resolve(argument ?? "."), readLock(lockPath));
    console.log(`Verified ${PACKAGE}@${result.version}: integrity ${result.integrity}, built by ${RELEASE_WORKFLOW} in ${result.repository} at ${result.commit}`);
  } else {
    fail("usage: verify-release.mjs pin <version> | version | verify <install-dir>");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[field] REFUSED: ${error instanceof VerifyError ? error.message : error.stack}`);
    process.exit(1);
  });
}
