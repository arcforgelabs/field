// deploy/replit/verify-release.mjs: what a self-hosted installation checks
// before it runs a release. The registry and GitHub are stand-ins here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pin, readLock, verify } from "../../deploy/replit/verify-release.mjs";

const script = join(import.meta.dirname, "../../deploy/replit/verify-release.mjs");
const VERSION = "2026.10.14";
const COMMIT = "c".repeat(40);
const tarball = Buffer.from("synthetic tarball bytes");
const INTEGRITY = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const DIGEST = `sha256:${"d".repeat(64)}`;

function manifest(overrides = {}) {
  return {
    version: VERSION,
    tag: `v${VERSION}`,
    commit: COMMIT,
    npm: { package: "@arcforgelabs/field", integrity: INTEGRITY },
    image: { ref: "ghcr.io/arcforgelabs/field", digest: DIGEST },
    ...overrides,
  };
}

function statement({ digest = createHash("sha512").update(tarball).digest("hex"), repository = "https://github.com/arcforgelabs/field", path = ".github/workflows/release-publish.yml", commit = COMMIT } = {}) {
  return {
    subject: [{ name: `pkg:npm/%40arcforgelabs/field@${VERSION}`, digest: { sha512: digest } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { ref: "refs/heads/main", repository, path } },
        resolvedDependencies: [{ uri: `git+${repository}@refs/heads/main`, digest: { gitCommit: commit } }],
      },
    },
  };
}

// A fetch that serves a GitHub Release and the npm registry from memory.
function world({ manifestBody = manifest(), sidecar, served = INTEGRITY, provenance = statement() } = {}) {
  const manifestBytes = Buffer.from(JSON.stringify(manifestBody));
  const sha = sidecar ?? `${createHash("sha256").update(manifestBytes).digest("hex")}  release-manifest.json\n`;
  const routes = {
    [`https://releases.test/v${VERSION}/release-manifest.json`]: manifestBytes,
    [`https://releases.test/v${VERSION}/release-manifest.json.sha256`]: Buffer.from(sha),
    [`https://registry.test/@arcforgelabs%2ffield/${VERSION}`]: { dist: { integrity: served } },
    [`https://registry.test/-/npm/v1/attestations/@arcforgelabs%2ffield@${VERSION}`]: {
      attestations: [
        { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {} },
        { predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(provenance)).toString("base64") } } },
      ],
    },
  };
  return async (url) => {
    const body = routes[url];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(Buffer.isBuffer(body) ? body : JSON.stringify(body), { status: 200 });
  };
}

const env = { FIELD_NPM_REGISTRY: "https://registry.test", FIELD_RELEASES_URL: "https://releases.test" };

function installDir({ version = VERSION, integrity = INTEGRITY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "field-self-host-"));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@arcforgelabs/field": { version, integrity } } }));
  return dir;
}

test("pin writes field.lock from the release manifest when npm serves the same integrity", async () => {
  const lock = await pin(VERSION, { env, fetchImpl: world() });
  assert.deepEqual(
    { ...lock, manifestSha256: typeof lock.manifestSha256 },
    { package: "@arcforgelabs/field", version: VERSION, integrity: INTEGRITY, commit: COMMIT, repository: "arcforgelabs/field", image: `ghcr.io/arcforgelabs/field@${DIGEST}`, manifestSha256: "string" },
  );
});

test("pin refuses a manifest that fails its .sha256, or that npm contradicts", async () => {
  await assert.rejects(pin(VERSION, { env, fetchImpl: world({ sidecar: `${"0".repeat(64)}  release-manifest.json` }) }), /does not match its .sha256/);
  await assert.rejects(pin(VERSION, { env, fetchImpl: world({ served: "sha512-other" }) }), /npm serves sha512-other/);
  await assert.rejects(pin("latest", { env, fetchImpl: world() }), /not a Field release version/);
});

test("verify passes the pinned bytes, built from the pinned commit by Field's release workflow", async () => {
  const lock = await pin(VERSION, { env, fetchImpl: world() });
  const result = await verify(installDir(), lock, { env, fetchImpl: world() });
  assert.equal(result.commit, COMMIT);
});

test("verify refuses another version, other bytes, or provenance that names another source", async () => {
  const lock = await pin(VERSION, { env, fetchImpl: world() });
  await assert.rejects(verify(installDir({ version: "2026.10.13" }), lock, { env, fetchImpl: world() }), /installed @arcforgelabs\/field@2026.10.13/);
  await assert.rejects(verify(installDir({ integrity: "sha512-tampered" }), lock, { env, fetchImpl: world() }), /installed integrity sha512-tampered/);
  const cases = [
    [{ digest: "0".repeat(128) }, /does not describe the pinned bytes/],
    [{ repository: "https://github.com/someone/field" }, /built from https:\/\/github.com\/someone\/field/],
    [{ path: ".github/workflows/other.yml" }, /built by .github\/workflows\/other.yml/],
    [{ commit: "e".repeat(40) }, /names commit e{40}/],
  ];
  for (const [change, says] of cases) {
    await assert.rejects(verify(installDir(), lock, { env, fetchImpl: world({ provenance: statement(change) }) }), says);
  }
});

test("a lock file that is missing, the example, or for another package is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "field-lock-"));
  assert.throws(() => readLock(join(dir, "field.lock")), /pin <version>/);
  writeFileSync(join(dir, "other.lock"), JSON.stringify({ package: "left-pad", version: VERSION }));
  assert.throws(() => readLock(join(dir, "other.lock")), /pins left-pad/);
  const example = readLock(join(import.meta.dirname, "../../deploy/replit/field.lock.example"));
  assert.equal(example.version, VERSION);
  const refused = (() => {
    try {
      execFileSync(process.execPath, [script, "version"], { env: { ...process.env, FIELD_LOCK: join(dir, "field.lock") }, stdio: "pipe" });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(refused?.status, 1);
  assert.match(String(refused.stderr), /REFUSED: cannot read/);
});
