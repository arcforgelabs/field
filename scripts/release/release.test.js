import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildManifest, checkTag, compareBase, nextVersion, parseTag, planTag } from "./release.mjs";

const script = join(import.meta.dirname, "release.mjs");
const packageVersion = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")).version;
// Dates in October 2026, when the tests' versions are cut.
const october = new Date("2026-10-20T00:00:00Z");

test("package.json holds a stable calendar version", () => {
  assert.equal(parseTag(`v${packageVersion}`).channel, "stable");
});

test("release tags are vYYYY.M.N or vYYYY.M.N-beta.B, without leading zeros", () => {
  assert.deepEqual(parseTag("v2026.10.14"), {
    tag: "v2026.10.14", version: "2026.10.14", base: "2026.10.14", channel: "stable", beta: null, npmDistTag: "latest", prerelease: false,
  });
  assert.deepEqual(parseTag("v2026.10.14-beta.2"), {
    tag: "v2026.10.14-beta.2", version: "2026.10.14-beta.2", base: "2026.10.14", channel: "beta", beta: 2, npmDistTag: "beta", prerelease: true,
  });
  for (const bad of ["2026.10.14", "v2026.01.14", "v2026.10.04", "v2026.13.1", "v2026.10.0", "v2026.10.14-beta.0", "v2026.10.14-rc.1", "v2026.10.14-1", "v1999.1.1"]) {
    assert.throws(() => parseTag(bad), /not a release tag/, bad);
  }
  // N counts the month's releases, not the day, so it can pass 31.
  assert.equal(parseTag("v2026.10.32").base, "2026.10.32");
  assert.equal(parseTag("v2026.10.104-beta.1").base, "2026.10.104");
});

test("calendar versions compare by date, not as text", () => {
  assert.ok(compareBase("2026.10.2", "2026.9.30") > 0);
  assert.ok(compareBase("2026.10.14", "2026.10.14") === 0);
  assert.ok(compareBase("2027.1.1", "2026.12.31") > 0);
  assert.ok(compareBase("2026.10.32", "2026.10.9") > 0);
  assert.ok(compareBase("2026.11.1", "2026.10.40") > 0);
});

test("the next version counts this month's stable releases, and starts at 1 in a new month", () => {
  const tags = ["v2026.9.30", "v2026.10.15", "v2026.10.16-beta.1", "v2026.10.17", "v2026.10.19", "v2026.10.20", "v2026.10.21-beta.1"];
  assert.equal(nextVersion({ tags, now: october }), "2026.10.21");
  assert.equal(nextVersion({ tags: [...tags, "v2026.10.31"], now: october }), "2026.10.32");
  assert.equal(nextVersion({ tags, now: new Date("2026-11-01T00:00:00Z") }), "2026.11.1");
  assert.equal(nextVersion({ tags: ["v2026.10.2"], now: new Date("2027-10-03T00:00:00Z") }), "2027.10.1");
});

test("a release is refused unless package.json holds the next version this month", () => {
  const tags = ["v2026.10.19", "v2026.10.20"];
  assert.equal(planTag({ packageVersion: "2026.10.21", channel: "stable", tags, now: october }).tag, "v2026.10.21");
  assert.equal(planTag({ packageVersion: "2026.10.32", channel: "beta", tags: ["v2026.10.31"], now: october }).tag, "v2026.10.32-beta.1");
  assert.throws(() => planTag({ packageVersion: "2026.10.22", channel: "stable", tags, now: october }), /not the next release this month, 2026.10.21/);
  assert.throws(() => planTag({ packageVersion: "2026.11.1", channel: "beta", tags, now: october }), /not the next release this month, 2026.10.21/);
  assert.throws(() => planTag({ packageVersion: "2026.10.21", channel: "stable", tags, now: new Date("2026-11-01T00:00:00Z") }), /not the next release this month, 2026.11.1/);
});

test("a beta takes the next free beta number for package.json's version", () => {
  const tags = ["v2026.10.13", "v2026.10.14-beta.1", "v2026.10.14-beta.3", "v2026.10.13-beta.9", "not-a-release"];
  assert.equal(planTag({ packageVersion: "2026.10.14", channel: "beta", tags, now: october }).tag, "v2026.10.14-beta.4");
  assert.equal(planTag({ packageVersion: "2026.10.1", channel: "beta", tags: ["v2026.9.40"], now: october }).tag, "v2026.10.1-beta.1");
});

test("a stable tag is package.json's version, and must be newer than every stable release", () => {
  assert.equal(planTag({ packageVersion: "2026.10.14", channel: "stable", tags: ["v2026.10.13", "v2026.10.14-beta.2"], now: october }).tag, "v2026.10.14");
  assert.throws(() => planTag({ packageVersion: "2026.10.14", channel: "stable", tags: ["v2026.10.14"], now: october }), /not newer than the latest stable release v2026.10.14/);
  assert.throws(() => planTag({ packageVersion: "2026.10.2", channel: "beta", tags: ["v2026.10.14"], now: october }), /not newer/);
  assert.throws(() => planTag({ packageVersion: "2026.10.14", channel: "nightly", tags: [], now: october }), /beta or stable/);
  assert.throws(() => planTag({ packageVersion: "0.1.0", channel: "beta", tags: [], now: october }), /not a calendar version/);
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
  // package.json's version, as the next release of its month on that month's
  // first day.
  const [year, month, count] = packageVersion.split(".").map(Number);
  const today = `${year}-${String(month).padStart(2, "0")}-01`;
  const earlier = count > 1 ? `v${year}.${month}.${count - 1}\n` : "";
  writeFileSync(join(dir, "tags"), `${earlier}v${packageVersion}-beta.1\n`);
  const plan = JSON.parse(execFileSync(process.execPath, [script, "plan", "--channel", "beta", "--tags", join(dir, "tags"), "--today", today], { encoding: "utf8" }));
  assert.equal(plan.tag, `v${packageVersion}-beta.2`);
  const next = JSON.parse(execFileSync(process.execPath, [script, "next", "--tags", join(dir, "tags"), "--today", today], { encoding: "utf8" }));
  assert.equal(next.version, packageVersion);
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
