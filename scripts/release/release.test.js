import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildManifest, checkTag, compareBase, parseTag, planTag } from "./release.mjs";

const script = join(import.meta.dirname, "release.mjs");
const packageVersion = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")).version;

test("package.json holds a stable calendar version", () => {
  assert.equal(parseTag(`v${packageVersion}`).channel, "stable");
});

test("release tags are vYYYY.M.D or vYYYY.M.D-beta.N, without leading zeros", () => {
  assert.deepEqual(parseTag("v2026.10.14"), {
    tag: "v2026.10.14", version: "2026.10.14", base: "2026.10.14", channel: "stable", beta: null, npmDistTag: "next", prerelease: false,
  });
  assert.deepEqual(parseTag("v2026.10.14-beta.2"), {
    tag: "v2026.10.14-beta.2", version: "2026.10.14-beta.2", base: "2026.10.14", channel: "beta", beta: 2, npmDistTag: "beta", prerelease: true,
  });
  for (const bad of ["2026.10.14", "v2026.01.14", "v2026.10.04", "v2026.13.1", "v2026.10.32", "v2026.10.14-beta.0", "v2026.10.14-rc.1", "v2026.10.14-1", "v1999.1.1"]) {
    assert.throws(() => parseTag(bad), /not a release tag/, bad);
  }
});

test("calendar versions compare by date, not as text", () => {
  assert.ok(compareBase("2026.10.2", "2026.9.30") > 0);
  assert.ok(compareBase("2026.10.14", "2026.10.14") === 0);
  assert.ok(compareBase("2027.1.1", "2026.12.31") > 0);
});

test("a beta takes the next free beta number for package.json's version", () => {
  const tags = ["v2026.10.2", "v2026.10.14-beta.1", "v2026.10.14-beta.3", "v2026.10.13-beta.9", "not-a-release"];
  assert.equal(planTag({ packageVersion: "2026.10.14", channel: "beta", tags }).tag, "v2026.10.14-beta.4");
  assert.equal(planTag({ packageVersion: "2026.10.15", channel: "beta", tags }).tag, "v2026.10.15-beta.1");
});

test("a stable tag is package.json's version, and must be newer than every stable release", () => {
  assert.equal(planTag({ packageVersion: "2026.10.14", channel: "stable", tags: ["v2026.10.2", "v2026.10.14-beta.2"] }).tag, "v2026.10.14");
  assert.throws(() => planTag({ packageVersion: "2026.10.14", channel: "stable", tags: ["v2026.10.14"] }), /not newer than the latest stable release v2026.10.14/);
  assert.throws(() => planTag({ packageVersion: "2026.10.2", channel: "beta", tags: ["v2026.10.14"] }), /not newer/);
  assert.throws(() => planTag({ packageVersion: "2026.10.14", channel: "nightly", tags: [] }), /beta or stable/);
  assert.throws(() => planTag({ packageVersion: "0.1.0", channel: "beta", tags: [] }), /not a calendar version/);
});

test("the publish workflow refuses a tag that does not match package.json at its commit", () => {
  assert.equal(checkTag({ tag: "v2026.10.14-beta.1", packageVersion: "2026.10.14" }).version, "2026.10.14-beta.1");
  assert.throws(() => checkTag({ tag: "v2026.10.15", packageVersion: "2026.10.14" }), /does not match package.json's version 2026.10.14/);
});

test("the manifest records the commit, checks, npm integrity, image digest and migrations", () => {
  const facts = {
    tag: "v2026.10.14-beta.1",
    commit: "a".repeat(40),
    repository: "arcforgelabs/field",
    workflowRun: "https://github.com/arcforgelabs/field/actions/runs/1",
    createdAt: "2026-10-14T00:00:00Z",
    node: "24",
    checks: { "unit-server": "success", smoke: "success" },
    npm: { package: "@arcforgelabs/field", integrity: "sha512-x", shasum: "abc", tarball: "arcforgelabs-field-2026.10.14-beta.1.tgz", tarballSha256: "d".repeat(64) },
    image: { ref: "ghcr.io/arcforgelabs/field", digest: `sha256:${"e".repeat(64)}`, tags: ["2026.10.14-beta.1", "beta"] },
  };
  const manifest = buildManifest(facts, { schema: ["0000_toolchain_probe"], data: ["2026-10-12-quote-rows-by-uid"] });
  assert.equal(manifest.version, "2026.10.14-beta.1");
  assert.equal(manifest.channel, "beta");
  assert.equal(manifest.npm.distTag, "beta");
  assert.equal(manifest.npm.integrity, "sha512-x");
  assert.equal(manifest.image.digest, facts.image.digest);
  assert.deepEqual(manifest.migrations.data, ["2026-10-12-quote-rows-by-uid"]);
});

test("the command line plans from a tag list and prints the manifest with this checkout's migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "field-release-"));
  writeFileSync(join(dir, "tags"), `v${packageVersion}-beta.1\n`);
  const plan = JSON.parse(execFileSync(process.execPath, [script, "plan", "--channel", "beta", "--tags", join(dir, "tags")], { encoding: "utf8" }));
  assert.equal(plan.tag, `v${packageVersion}-beta.2`);
  writeFileSync(join(dir, "facts.json"), JSON.stringify({
    tag: plan.tag, commit: "b".repeat(40), checks: {}, npm: { package: "@arcforgelabs/field" }, image: { ref: "ghcr.io/arcforgelabs/field", digest: "sha256:0", tags: [] },
  }));
  execFileSync(process.execPath, [script, "migrations", "--output", join(dir, "migrations.json")]);
  const manifest = JSON.parse(execFileSync(process.execPath, [script, "manifest", "--input", join(dir, "facts.json"), "--migrations", join(dir, "migrations.json")], { encoding: "utf8" }));
  assert.ok(manifest.migrations.schema.includes("0000_toolchain_probe"));
  assert.ok(manifest.migrations.data.length > 0);
  const refused = (() => {
    try {
      execFileSync(process.execPath, [script, "check", "--tag", "v2099.1.1"], { encoding: "utf8", stdio: "pipe" });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(refused?.status, 1);
  assert.match(refused.stderr, /does not match package.json's version/);
});
