// scripts/replit-workspace-db.js: the comparison on its own, the production
// /health read against a local stand-in, the fetch against a local bare
// repository standing in for GitHub, and sync end to end against PGlite (and
// PostgreSQL when FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER is set).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  EXIT,
  compareMigrations,
  fetchProductionBuild,
  fetchReleaseMigrations,
  productionOrigin,
  readAppliedMigrations,
  readJournal,
  run,
} from "./replit-workspace-db.js";
import { MIGRATIONS_FOLDER, createTestDb, queryRows } from "../server/db-runtime/index.js";
import { startTestPostgres } from "../server/db-runtime/test-postgres.js";
import { sql } from "drizzle-orm";

const SCRIPT = resolve(import.meta.dirname, "replit-workspace-db.js");

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: { ...GIT_ENV, HOME: cwd }, encoding: "utf8" }).trim();
}

const entry = (tag, when, hash = `hash-${tag}`) => ({ tag, when, hash });
const row = (e) => ({ hash: e.hash, created_at: e.when });
const A = entry("0000_a", 100);
const B = entry("0001_b", 200);
const C = entry("0002_c", 300);

test("compareMigrations: level when the database has exactly the release's migrations", () => {
  const result = compareMigrations({ release: [A, B], applied: [row(A), row(B)] });
  assert.equal(result.state, "level");
  assert.deepEqual(result.missing, []);
  // created_at comes back from PostgreSQL as a string (bigint).
  assert.equal(compareMigrations({ release: [A], applied: [{ hash: A.hash, created_at: "100" }] }).state, "level");
});

test("compareMigrations: behind when the database lacks the release's newest migrations", () => {
  assert.deepEqual(compareMigrations({ release: [A, B, C], applied: [row(A)] }), {
    state: "behind",
    missing: ["0001_b", "0002_c"],
    extra: [],
    mismatched: [],
    skipped: [],
  });
  assert.equal(compareMigrations({ release: [A, B], applied: [] }).state, "behind");
});

test("compareMigrations: ahead when the database has migrations the release does not", () => {
  const result = compareMigrations({ release: [A], applied: [row(A), row(B)], known: [A, B] });
  assert.equal(result.state, "ahead");
  assert.deepEqual(result.extra, [{ created_at: 200, hash: B.hash, tag: "0001_b" }]);
  // A row nobody's journal knows is still listed, by its created_at.
  assert.equal(compareMigrations({ release: [A], applied: [row(A), row(C)] }).extra[0].tag, null);
});

test("compareMigrations: diverged on a different hash, a skipped migration, or extra and missing at once", () => {
  const changed = compareMigrations({ release: [A, B], applied: [row(A), { hash: "other", created_at: 200 }] });
  assert.equal(changed.state, "diverged");
  assert.deepEqual(changed.mismatched, ["0001_b"]);
  // drizzle applies only migrations newer than its newest row, so B would never run.
  const skipped = compareMigrations({ release: [A, B, C], applied: [row(A), row(C)] });
  assert.equal(skipped.state, "diverged");
  assert.deepEqual(skipped.skipped, ["0001_b"]);
  const both = compareMigrations({ release: [A, B], applied: [row(A), row(C)] });
  assert.equal(both.state, "diverged");
  assert.deepEqual(both.missing, ["0001_b"]);
});

test("readJournal computes the hash and created_at that drizzle-orm records", async () => {
  const t = await createTestDb();
  try {
    const applied = await readAppliedMigrations(t.db, { queryRows, sql });
    const release = readJournal(MIGRATIONS_FOLDER);
    assert.equal(applied.length, release.length);
    assert.equal(compareMigrations({ release, applied }).state, "level");
  } finally {
    await t.close();
  }
});

test("productionOrigin keeps the origin and refuses credentials and other schemes", () => {
  assert.equal(productionOrigin("https://field.example.com/some/path?x=1"), "https://field.example.com");
  assert.throws(() => productionOrigin("https://user:pass@field.example.com"), /user name or password/);
  assert.throws(() => productionOrigin("ftp://field.example.com"), /https/);
  assert.throws(() => productionOrigin("field.example.com"), /not a URL/);
});

async function standInProduction() {
  const state = { health: { ok: true, build: {} }, status: 200, requests: [] };
  const server = createServer((req, res) => {
    state.requests.push({ url: req.url, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
    // One request for each connection, as for a real CLI run: a kept-alive
    // socket the server closes between tests would reset the next request.
    res.writeHead(state.status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(state.health));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

test("fetchProductionBuild reads build.revision and build.release from /health, without credentials", async () => {
  const production = await standInProduction();
  try {
    const revision = "a".repeat(40);
    production.state.health = { ok: true, build: { revision, release: "v2026.10.22", ref: "stable", source: "github" } };
    assert.deepEqual(await fetchProductionBuild(production.origin), { revision, release: "v2026.10.22", ref: "stable", source: "github" });
    assert.deepEqual(production.state.requests.at(-1), { url: "/health", authorization: null, cookie: null });

    production.state.health = { ok: true, build: { revision: null } };
    await assert.rejects(fetchProductionBuild(production.origin), /no build\.revision/);
    production.state.status = 503;
    await assert.rejects(fetchProductionBuild(production.origin), /HTTP 503/);
  } finally {
    await production.close();
  }
  await assert.rejects(fetchProductionBuild(production.origin), /did not answer/);
});

// A bare repository standing in for GitHub: commit `older` lacks the newest
// migration, `newer` has all of them.
function fixtureRepository(root) {
  const work = join(root, "work");
  git(root, "init", "-q", "-b", "main", work);
  const drizzle = join(work, "server", "db", "drizzle");
  cpSync(MIGRATIONS_FOLDER, drizzle, { recursive: true });
  const journalPath = join(drizzle, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const newest = journal.entries.at(-1);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) }, null, 2));
  rmSync(join(drizzle, `${newest.tag}.sql`));
  writeFileSync(join(work, "README.md"), "fixture\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "older");
  const older = git(work, "rev-parse", "HEAD");
  cpSync(MIGRATIONS_FOLDER, drizzle, { recursive: true });
  git(work, "add", "-A");
  git(work, "commit", "-qm", "newer");
  const newer = git(work, "rev-parse", "HEAD");
  const bare = join(root, "field.git");
  git(root, "clone", "-q", "--bare", work, bare);
  return { repo: `file://${bare}`, older, newer, newestTag: newest.tag, total: journal.entries.length };
}

test("fetchReleaseMigrations fetches exactly that commit's server/db/drizzle and reuses it", () => {
  const root = mkdtempSync(join(tmpdir(), "field-workspace-db-fetch-"));
  try {
    const fixture = fixtureRepository(root);
    const cacheDir = join(root, "cache");
    const folder = fetchReleaseMigrations({ repo: fixture.repo, revision: fixture.older, cacheDir });
    assert.equal(folder, join(cacheDir, fixture.older, "drizzle"));
    assert.equal(readJournal(folder).length, fixture.total - 1);
    // Only the migrations are written; nothing else from the commit.
    assert.throws(() => readFileSync(join(cacheDir, fixture.older, "README.md")));

    // A second call reuses the folder: it works with the repository gone.
    rmSync(join(root, "field.git"), { recursive: true });
    assert.equal(fetchReleaseMigrations({ repo: fixture.repo, revision: fixture.older, cacheDir }), folder);
    assert.throws(
      () => fetchReleaseMigrations({ repo: fixture.repo, revision: fixture.newer, cacheDir }),
      /could not fetch/,
    );
    assert.throws(() => fetchReleaseMigrations({ repo: "--upload-pack=x", revision: fixture.older, cacheDir }), /https/);
    assert.throws(() => fetchReleaseMigrations({ repo: fixture.repo, revision: "main", cacheDir }), /40-character/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run refuses the published app and skips without FIELD_PRODUCTION_URL", async () => {
  const refused = await run({ command: "sync", env: { REPLIT_DEPLOYMENT: "1", FIELD_PRODUCTION_URL: "https://x.example" } });
  assert.equal(refused.exitCode, EXIT.failed);
  assert.match(refused.summary.error, /published app/);
  const skipped = await run({ command: "sync", env: {} });
  assert.equal(skipped.exitCode, EXIT.ok);
  assert.equal(skipped.summary.state, "skipped");
  assert.match(skipped.summary.message, /FIELD_PRODUCTION_URL/);
});

// Sync end to end: a fresh database follows production as it moves forward,
// and refuses to follow it backwards.
async function followProduction(t, databaseEnv) {
  const root = mkdtempSync(join(tmpdir(), "field-workspace-db-run-"));
  const production = await standInProduction();
  const warnings = [];
  try {
    const fixture = fixtureRepository(root);
    const env = { ...databaseEnv, FIELD_PRODUCTION_URL: production.origin, FIELD_DEPLOY_REPO: fixture.repo };
    const deps = {
      fetchReleaseMigrations: (options) => fetchReleaseMigrations({ ...options, cacheDir: join(root, "cache") }),
    };
    const go = (command) => run({ command, env, deps, warn: (line) => warnings.push(line) });
    const publish = (revision) => {
      production.state.health = { ok: true, build: { revision, release: "v2026.10.22", ref: "stable", source: "github" } };
    };

    publish(fixture.older);
    let result = await go("status");
    assert.equal(result.exitCode, EXIT.behind);
    assert.equal(result.summary.migrations.workspace, 0);
    // This checkout has a migration production does not run: say so.
    assert.deepEqual(result.summary.checkout, { state: "ahead", ahead: [fixture.newestTag] });
    assert.match(warnings.join("\n"), /checkout has migrations production does not run/);

    result = await go("sync");
    assert.equal(result.exitCode, EXIT.ok, JSON.stringify(result.summary));
    assert.equal(result.summary.state, "level");
    assert.equal(result.summary.appliedNow, fixture.total - 1);
    assert.doesNotMatch(JSON.stringify(result.summary), /postgres(ql)?:\/\//);

    result = await go("sync");
    assert.equal(result.summary.state, "level");
    assert.equal(result.summary.appliedNow, 0);

    // Production boots a newer release: the workspace follows.
    publish(fixture.newer);
    result = await go("status");
    assert.equal(result.exitCode, EXIT.behind);
    assert.deepEqual(result.summary.missing, [fixture.newestTag]);
    result = await go("sync");
    assert.equal(result.summary.state, "level");
    assert.equal(result.summary.appliedNow, 1);
    assert.equal(result.summary.checkout.state, "level");

    // Production rolls back: the workspace is ahead, and nothing is dropped.
    publish(fixture.older);
    result = await go("sync");
    assert.equal(result.exitCode, EXIT.attention);
    assert.equal(result.summary.state, "ahead");
    assert.deepEqual(result.summary.extra, [fixture.newestTag]);
    assert.match(result.summary.message, /Nothing was changed.*press Cancel/);
    assert.equal(result.summary.migrations.workspace, fixture.total);
  } finally {
    await production.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("sync brings a PGlite workspace database to production's migrations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "field-workspace-db-pglite-"));
  try {
    await followProduction(t, { FIELD_PGLITE_DIR: join(dir, "pglite") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync brings a PostgreSQL workspace database to production's migrations, under the migration lock", async (t) => {
  const server = await startTestPostgres();
  if (!server) {
    t.skip("set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1");
    return;
  }
  try {
    await followProduction(t, { FIELD_DB_URL: server.url });
  } finally {
    await server.stop();
  }
});

test("--warn-only never fails the workspace start", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "sync", "--warn-only"], {
    env: { PATH: process.env.PATH, FIELD_PRODUCTION_URL: "https://user:pw@example.invalid" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(result.stderr, /WARNING: .*user name or password.*Starting anyway/);
  assert.doesNotMatch(result.stdout + result.stderr, /user:pw/);
  const strict = spawnSync(process.execPath, [SCRIPT, "sync"], {
    env: { PATH: process.env.PATH, FIELD_PRODUCTION_URL: "https://user:pw@example.invalid" },
    encoding: "utf8",
  });
  assert.equal(strict.status, EXIT.failed);
});
