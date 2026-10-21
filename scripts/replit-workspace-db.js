#!/usr/bin/env node
// Keep a Replit workspace's database at exactly the migrations production runs.
//
//   node scripts/replit-workspace-db.js status   # compare; change nothing
//   node scripts/replit-workspace-db.js sync     # apply what the workspace is missing
//   npm run db:follow-production                 # the same as sync
//
// A Replit installation has two databases: the workspace's and the published
// app's. Before each publish Replit compares their tables and, when they
// differ, offers to make production match the workspace ("Development
// database changes detected"). Accepting breaks Field, which migrates
// production itself at boot. The prompt appears when the workspace is behind
// production (production gained a release's migrations when it booted) or
// ahead of it (the workspace applied migrations production has not run).
//
// This asks production which commit it runs (GET <FIELD_PRODUCTION_URL>/health,
// build.revision), fetches that commit's server/db/drizzle/ from GitHub
// without a token (like scripts/replit-deploy.sh), and compares it with the
// workspace database's drizzle.__drizzle_migrations:
//
//   level     the workspace database has exactly production's migrations
//   behind    it lacks some; sync applies them, under the server's migration lock
//   ahead     it has migrations production does not; nothing is changed
//   diverged  it has different ones; nothing is changed
//
// It only ever touches the workspace's database (FIELD_DB_URL or
// DATABASE_URL, chosen like npm run db:smoke) and refuses to run in the
// published app (REPLIT_DEPLOYMENT set). It never connects to production's
// database: production is only asked for its public /health.
//
//   FIELD_PRODUCTION_URL=<https://your-field.example>   the published app (a workspace Secret)
//   FIELD_DEPLOY_REPO=<url>                              fetch from here (default: the public repository)
//
// Without FIELD_PRODUCTION_URL it says how to set it and exits 0.
// --warn-only (scripts/replit-start.sh, .replit onBoot) always exits 0, so a
// failure here never stops the workspace from starting.
//
// It prints one JSON line. The connection string is never printed.
// Exit codes: 0 level, synced or skipped; 1 failed; 2 behind (status only);
// 3 ahead or diverged.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_REPO = "https://github.com/arcforgelabs/field.git";
export const CACHE_DIR = join(REPO_ROOT, ".field-workspace-db");
const MIGRATIONS_PATH = "server/db/drizzle";
const HEALTH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 180_000;
const REVISION = /^[0-9a-f]{40}$/;

export const EXIT = { ok: 0, failed: 1, behind: 2, attention: 3 };

// What drizzle-orm's migrator (0.45, drizzle-orm/migrator.js) records for each
// journal entry: hash is the sha256 of the .sql file read as text, created_at
// is the entry's `when`. It applies an entry only when `when` is later than
// the newest created_at already recorded.
export function readJournal(folder) {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8"));
  return journal.entries.map((entry) => {
    const text = readFileSync(join(folder, `${entry.tag}.sql`)).toString();
    return { tag: entry.tag, when: Number(entry.when), hash: createHash("sha256").update(text).digest("hex") };
  });
}

// Compare a release's journal ([{ tag, when, hash }]) with the rows a database
// recorded ([{ hash, created_at }]). Pure; `known` (other journal entries,
// such as the workspace checkout's) only names rows the release does not have.
//
// Returns { state, missing, extra, mismatched, skipped } where state is
// "level", "behind", "ahead" or "diverged":
//   missing     release tags the database lacks
//   extra       rows the release does not have ({ created_at, hash, tag })
//   mismatched  release tags recorded with a different hash
//   skipped     missing tags older than the newest row, which drizzle's
//               migrator would never apply
export function compareMigrations({ release, applied, known = [] }) {
  const byWhen = new Map(release.map((entry) => [entry.when, entry]));
  const knownByWhen = new Map(known.map((entry) => [entry.when, entry]));
  const recorded = new Set();
  const extra = [];
  const mismatched = [];
  let newest = -Infinity;
  for (const row of applied) {
    const createdAt = Number(row.created_at);
    newest = Math.max(newest, createdAt);
    const entry = byWhen.get(createdAt);
    if (!entry) {
      extra.push({ created_at: createdAt, hash: row.hash, tag: knownByWhen.get(createdAt)?.tag ?? null });
      continue;
    }
    recorded.add(createdAt);
    if (entry.hash !== row.hash) mismatched.push(entry.tag);
  }
  const missingEntries = release.filter((entry) => !recorded.has(entry.when));
  const missing = missingEntries.map((entry) => entry.tag);
  const skipped = missingEntries.filter((entry) => entry.when <= newest).map((entry) => entry.tag);
  let state;
  if (mismatched.length || skipped.length || (extra.length && missing.length)) state = "diverged";
  else if (extra.length) state = "ahead";
  else if (missing.length) state = "behind";
  else state = "level";
  return { state, missing, extra, mismatched, skipped };
}

// The production URL as an origin with no credentials, path or query.
export function productionOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FIELD_PRODUCTION_URL is not a URL; set it to the published app's address, such as https://field.example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("FIELD_PRODUCTION_URL must start with https://");
  }
  if (url.username || url.password) {
    throw new Error("FIELD_PRODUCTION_URL must not hold a user name or password");
  }
  return url.origin;
}

// Ask production which build it runs. No credentials: /health is public.
export async function fetchProductionBuild(origin, { fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(`${origin}/health`, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${origin}/health did not answer (${error?.name === "TimeoutError" ? `no answer in ${timeoutMs} ms` : error?.cause?.code || error?.message || error})`);
  }
  if (!response.ok) throw new Error(`${origin}/health answered HTTP ${response.status}; is production up?`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${origin}/health did not answer JSON; is FIELD_PRODUCTION_URL the published Field app?`);
  }
  const build = body?.build ?? {};
  const revision = typeof build.revision === "string" ? build.revision.trim().toLowerCase() : "";
  if (!REVISION.test(revision)) {
    throw new Error(`${origin}/health has no build.revision (a 40-character commit), so the release production runs is unknown. A publish built by scripts/replit-deploy.sh reports it`);
  }
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return { revision, release: text(build.release), ref: text(build.ref), source: text(build.source) };
}

function runGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, "-c", "credential.helper=", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function validRepo(repo) {
  return /^(https:\/\/|file:\/\/)[^\s]+$/.test(repo);
}

// Fetch `revision`'s server/db/drizzle/ into <cacheDir>/<revision>/drizzle and
// return that folder. Anonymous, depth 1, from `repo`; the fetched commit must
// be `revision`. A folder fetched before is reused. Only <cacheDir> is written.
export function fetchReleaseMigrations({ repo = DEFAULT_REPO, revision, cacheDir = CACHE_DIR }) {
  if (!REVISION.test(revision)) throw new Error(`'${revision}' is not a 40-character commit`);
  if (!validRepo(repo)) throw new Error("FIELD_DEPLOY_REPO must be an https:// URL");
  const target = join(cacheDir, revision);
  const folder = join(target, "drizzle");
  if (existsSync(join(target, "complete"))) return folder;

  mkdirSync(cacheDir, { recursive: true });
  const work = join(cacheDir, `.fetch-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(work);
    runGit(work, ["init", "-q"]);
    try {
      runGit(work, ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30", "fetch", "-q", "--depth", "1", "--no-tags", repo, revision]);
    } catch (error) {
      const reason = String(error.stderr || error.message).trim().split("\n").pop();
      throw new Error(`could not fetch ${revision} from ${repo} (${reason})`);
    }
    const fetched = runGit(work, ["rev-parse", "FETCH_HEAD^{commit}"]).trim();
    if (fetched !== revision) throw new Error(`fetched ${fetched} from ${repo}, not ${revision}`);
    const paths = runGit(work, ["ls-tree", "-r", "-z", "--name-only", "FETCH_HEAD", "--", `${MIGRATIONS_PATH}/`])
      .split("\0")
      .filter(Boolean);
    if (!paths.includes(`${MIGRATIONS_PATH}/meta/_journal.json`)) {
      throw new Error(`${revision} has no ${MIGRATIONS_PATH}/meta/_journal.json`);
    }
    const staged = join(work, "out");
    for (const path of paths) {
      const out = join(staged, "drizzle", path.slice(MIGRATIONS_PATH.length + 1));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, execFileSync("git", ["-C", work, "cat-file", "blob", `FETCH_HEAD:${path}`], { maxBuffer: 64 * 1024 * 1024 }));
    }
    writeFileSync(join(staged, "complete"), `${revision}\n`);
    rmSync(target, { recursive: true, force: true });
    renameSync(staged, target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // Keep only the newest release fetched.
  for (const name of readdirSync(cacheDir)) {
    if (REVISION.test(name) && name !== revision) rmSync(join(cacheDir, name), { recursive: true, force: true });
  }
  return folder;
}

// The rows drizzle-orm recorded, oldest first; [] before the first migration.
export async function readAppliedMigrations(db, { queryRows, sql }) {
  const [exists] = await queryRows(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`, db);
  if (!exists?.present) return [];
  const rows = await queryRows(sql`select hash, created_at from drizzle.__drizzle_migrations order by id`, db);
  return rows.map((row) => ({ hash: row.hash, created_at: Number(row.created_at) }));
}

function describe(result) {
  const named = (rows) => rows.map((row) => row.tag ?? `created_at ${row.created_at}`).join(", ");
  const parts = [];
  if (result.extra.length) parts.push(`it has ${result.extra.length} migration(s) production does not: ${named(result.extra)}`);
  if (result.mismatched.length) parts.push(`it recorded ${result.mismatched.join(", ")} with different contents`);
  if (result.skipped.length) parts.push(`it lacks ${result.skipped.join(", ")}, older than its newest migration`);
  return parts.join("; ");
}

// The workspace database through server/db-runtime, chosen like
// npm run db:smoke. Imported only when needed: it needs server/db/dist.
async function workspaceDb(env) {
  const runtime = await import("../server/db-runtime/index.js");
  const { sql } = await import("drizzle-orm");
  const { loadFieldConfig } = await import("../server/runtime-config.js");
  const { config: fieldConfig } = loadFieldConfig({ defaultPath: join(REPO_ROOT, "config.json") });
  const dataDir = resolve(env.FIELD_DATA || fieldConfig.dataDir || join(REPO_ROOT, "data"));
  const options = { env, dataDir };
  return {
    checkoutFolder: runtime.MIGRATIONS_FOLDER,
    resolveConfig: () => runtime.resolveDbConfig(options),
    readApplied: () => readAppliedMigrations(runtime.getDb(options), { queryRows: runtime.queryRows, sql }),
    apply: (migrationsFolder) => runtime.runMigrations({ ...options, migrationsFolder }),
    close: () => runtime.closeDb(),
  };
}

const ATTENTION_HELP =
  "Nothing was changed. If Replit shows 'Development database changes detected', press Cancel. " +
  "When production publishes a release with these migrations, the workspace is level again by itself. " +
  "Otherwise ask the developer, or replace the workspace database (docs/REPLIT.md, 'The workspace database')";

// The whole command. `deps` replaces the database and network for tests.
export async function run({ command, env = process.env, deps = {}, log = console.log, warn = console.error }) {
  const summary = { ok: false, command };
  const fail = (message, exitCode = EXIT.failed) => ({ exitCode, summary: { ...summary, error: message } });
  if (command !== "status" && command !== "sync") {
    return fail("usage: replit-workspace-db.js status|sync [--warn-only]");
  }
  if (String(env.REPLIT_DEPLOYMENT ?? "").trim()) {
    return fail("refused: this is the published app (REPLIT_DEPLOYMENT is set). It follows production only in the workspace");
  }
  const productionUrl = String(env.FIELD_PRODUCTION_URL ?? "").trim();
  if (!productionUrl) {
    return {
      exitCode: EXIT.ok,
      summary: {
        ...summary,
        ok: true,
        state: "skipped",
        message:
          "FIELD_PRODUCTION_URL is not set, so the workspace database does not follow production. Add a workspace Secret (Tools > Secrets) named FIELD_PRODUCTION_URL with the published app's address, such as https://field.example.com",
      },
    };
  }

  let db;
  try {
    const origin = productionOrigin(productionUrl);
    summary.production = { url: origin };
    db = deps.db ?? (await workspaceDb(env));
    const config = db.resolveConfig();
    summary.database = config.target;
    if (config.driver === "none") return fail("no workspace database: set DATABASE_URL (add Replit's PostgreSQL database)");

    const build = await (deps.fetchProductionBuild ?? fetchProductionBuild)(origin);
    summary.production = { url: origin, revision: build.revision, release: build.release, ref: build.ref };
    if (build.source === "workspace") {
      warn("[workspace-db] production is an emergency build of workspace files; its revision is only their base commit");
    }
    const repo = String(env.FIELD_DEPLOY_REPO ?? "").trim() || DEFAULT_REPO;
    const folder = (deps.fetchReleaseMigrations ?? fetchReleaseMigrations)({ repo, revision: build.revision });
    const release = readJournal(folder);
    const checkout = readJournal(deps.checkoutFolder ?? db.checkoutFolder);

    // Would the workspace server's own boot (server/index.js runMigrations,
    // with this checkout's migrations) take the database past production?
    const checkoutVsRelease = compareMigrations({
      release,
      applied: checkout.map((entry) => ({ hash: entry.hash, created_at: entry.when })),
      known: checkout,
    });
    summary.checkout = {
      state: checkoutVsRelease.state,
      ...(checkoutVsRelease.extra.length ? { ahead: checkoutVsRelease.extra.map((row) => row.tag) } : {}),
    };
    if (checkoutVsRelease.state === "ahead" || checkoutVsRelease.state === "diverged") {
      warn(
        `[workspace-db] WARNING: this workspace's checkout has migrations production does not run (${checkoutVsRelease.extra.map((row) => row.tag).join(", ") || "different ones"}). ` +
          "Starting the workspace server applies them and puts the workspace database ahead of production, so Replit shows 'Development database changes detected' (press Cancel). " +
          "Check out the release production runs (docs/REPLIT.md, 'The workspace database')",
      );
    }

    const applied = await db.readApplied();
    let result = compareMigrations({ release, applied, known: checkout });
    summary.migrations = { release: release.length, workspace: applied.length };
    let appliedNow = 0;
    if (result.state === "behind" && command === "sync") {
      const before = applied.length;
      await db.apply(folder);
      const after = await db.readApplied();
      appliedNow = after.length - before;
      result = compareMigrations({ release, applied: after, known: checkout });
      summary.migrations = { release: release.length, workspace: after.length };
    }
    Object.assign(summary, {
      state: result.state,
      ...(command === "sync" ? { appliedNow } : {}),
      ...(result.missing.length ? { missing: result.missing } : {}),
      ...(result.extra.length ? { extra: result.extra.map((row) => row.tag ?? `created_at ${row.created_at}`) } : {}),
      ...(result.mismatched.length ? { mismatched: result.mismatched } : {}),
      ...(result.skipped.length ? { skipped: result.skipped } : {}),
    });
    if (result.state === "level") {
      summary.ok = true;
      return { exitCode: EXIT.ok, summary };
    }
    if (result.state === "behind") {
      if (command === "sync") return fail(`applied migrations, but the workspace database is still behind: ${result.missing.join(", ")}`);
      summary.ok = true;
      summary.message = "behind production; `npm run db:follow-production` applies the missing migrations";
      return { exitCode: EXIT.behind, summary };
    }
    summary.message = `The workspace database is ${result.state} of production${build.release ? ` (${build.release})` : ""}: ${describe(result)}. ${ATTENTION_HELP}`;
    return { exitCode: EXIT.attention, summary };
  } catch (error) {
    const message = String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]");
    return fail(message);
  } finally {
    await db?.close?.();
  }
}

async function main(argv) {
  const args = argv.slice(2);
  const warnOnly = args.includes("--warn-only");
  const command = args.find((arg) => !arg.startsWith("--")) ?? "status";
  const { exitCode, summary } = await run({ command });
  console.log(JSON.stringify(summary));
  if (warnOnly && exitCode !== EXIT.ok) {
    console.error(`[workspace-db] WARNING: ${summary.error ?? summary.message ?? `the workspace database is ${summary.state}`}. Starting anyway.`);
    return EXIT.ok;
  }
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv);
}
