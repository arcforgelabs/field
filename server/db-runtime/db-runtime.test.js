import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

import { sql } from "drizzle-orm";

import {
  MIGRATIONS_FOLDER,
  acquirePgliteLockForTests,
  releasePgliteLockForTests,
  MIGRATION_LOCK_KEY,
  NoDatabaseError,
  checkDb,
  closeDb,
  createTestDb,
  getDb,
  getDbInfo,
  getMigrationStatus,
  queryRows,
  resolveDbConfig,
  runMigrations,
  schema,
} from "./index.js";
import { startTestPostgres, testPostgresMode } from "./test-postgres.js";

// Fake credentials are assembled at runtime so secret scanners do not flag the fixtures.
const FAKE_PASSWORD = ["s3cret", "password"].join("-");
function fakePostgresUrl(rest, scheme = "postgres") {
  return [scheme, "://field:", FAKE_PASSWORD, "@", rest].join("");
}

const SECRET_URL = fakePostgresUrl("db.example.invalid:5432/field");
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")).entries;
const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "field-db-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => closeDb());

function randomToken() {
  return randomBytes(24).toString("hex");
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// Values whose JS type differs between drivers unless the runtime evens them out.
const PARITY_QUERY = sql`select
  9007199254740993::int8 as big,
  12.50::numeric as amount,
  2::int4 as small,
  true as flag,
  '{"a":[1,2]}'::jsonb as doc,
  '2026-01-02'::date as day,
  '2026-01-02 03:04:05.678+00'::timestamptz as at,
  current_setting('TimeZone') as zone`;

const EXPECTED_PARITY = {
  big: "9007199254740993",
  amount: "12.50",
  small: 2,
  flag: true,
  doc: { a: [1, 2] },
  day: "2026-01-02",
  at: "2026-01-02 03:04:05.678+00",
  zone: "UTC",
};

test("resolveDbConfig: FIELD_DB_URL, then DATABASE_URL; PGlite only when asked for", () => {
  assert.deepEqual(
    resolveDbConfig({ env: { FIELD_DB_URL: " postgres://a@h/x ", DATABASE_URL: "postgres://b@h/y" } }),
    {
      driver: "postgres",
      url: "postgres://a@h/x",
      migrationUrl: "postgres://a@h/x",
      source: "FIELD_DB_URL",
      pooled: false,
      target: "postgres (FIELD_DB_URL)",
    },
  );
  assert.equal(resolveDbConfig({ env: { DATABASE_URL: "postgresql://b@h/y" } }).source, "DATABASE_URL");
  assert.deepEqual(resolveDbConfig({ env: { FIELD_PGLITE_DIR: "memory://" } }), {
    driver: "pglite",
    dir: null,
    source: "FIELD_PGLITE_DIR",
    target: "pglite (in memory)",
  });
  assert.equal(resolveDbConfig({ env: { FIELD_PGLITE: "1" }, dataDir: "/srv/field-data" }).dir, "/srv/field-data/pglite");
  assert.equal(resolveDbConfig({ env: { FIELD_PGLITE: "true", FIELD_DATA: "/srv/other" } }).dir, "/srv/other/pglite");
  assert.equal(resolveDbConfig({ env: { FIELD_PGLITE_DIR: "/srv/pg" }, dataDir: "/srv/x" }).dir, "/srv/pg");
});

test("without a URL or an explicit PGlite opt-in there is no database (memory-capped runtimes never start PGlite)", () => {
  for (const env of [{}, { FIELD_DATA: "/srv/field-data" }, { FIELD_PGLITE: "0" }, { NODE_ENV: "production" }]) {
    assert.deepEqual(resolveDbConfig({ env, dataDir: "/srv/field-data" }), {
      driver: "none",
      source: null,
      target: "no database configured",
    });
  }
  // Opting in without anywhere to keep it is an error, not a guess.
  assert.throws(() => resolveDbConfig({ env: { FIELD_PGLITE: "1" } }), /needs a data directory/);
});

test("on Replit PGlite is refused and a missing DATABASE_URL is named", () => {
  for (const replit of [{ FIELD_RUNTIME: "replit" }, { REPLIT_DEPLOYMENT: "1" }]) {
    assert.throws(
      () => resolveDbConfig({ env: { ...replit, FIELD_PGLITE: "1" }, dataDir: "/srv/x" }),
      /PGlite is refused on Replit/,
    );
    assert.throws(() => resolveDbConfig({ env: { ...replit, FIELD_PGLITE_DIR: "/srv/pg" } }), /refused on Replit/);
    const none = resolveDbConfig({ env: replit, dataDir: "/srv/x" });
    assert.equal(none.driver, "none");
    assert.match(none.target, /DATABASE_URL is not set/);
    assert.equal(resolveDbConfig({ env: { ...replit, DATABASE_URL: "postgres://b@h/y" } }).driver, "postgres");
  }
});

test("a transaction-mode pooler host is flagged (prepared statements off) without echoing the URL", () => {
  const config = resolveDbConfig({
    env: { DATABASE_URL: fakePostgresUrl("ep-cool-name-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require", "postgresql") },
  });
  assert.equal(config.pooled, true);
  assert.equal(config.target, "postgres (DATABASE_URL, pooled; migrations use the direct host)");
  // Migrations hold a session advisory lock, so they go to Neon's direct host.
  const migration = new URL(config.migrationUrl);
  assert.equal(migration.hostname, "ep-cool-name-123.us-east-2.aws.neon.tech");
  assert.equal(migration.password, "s3cret-password");
  assert.equal(migration.search, "?sslmode=require");
  assert.doesNotMatch(config.target, /s3cret|neon\.tech/);
  const direct = resolveDbConfig({ env: { DATABASE_URL: "postgresql://f@ep-cool-name-123.neon.tech/db" } });
  assert.equal(direct.pooled, false);
  assert.equal(direct.migrationUrl, direct.url);
});

test("resolveDbConfig never echoes the connection string", () => {
  const config = resolveDbConfig({ env: { DATABASE_URL: SECRET_URL } });
  assert.doesNotMatch(config.target, /s3cret|example\.invalid/);
  assert.throws(
    () => resolveDbConfig({ env: { DATABASE_URL: "mysql://field:s3cret-password@h/x" } }),
    (error) => /DATABASE_URL must be a postgres/.test(error.message) && !error.message.includes("s3cret"),
  );
});

test("no database: runMigrations opens nothing and skips; getDb and checkDb fail closed", async () => {
  const dataDir = tempDir();
  const result = await runMigrations({ env: {}, dataDir });
  assert.deepEqual(result, {
    driver: "none",
    target: "no database configured",
    total: journal.length,
    applied: 0,
    skipped: true,
  });
  assert.equal(getDbInfo(), null, "nothing opened");
  assert.equal(existsSync(join(dataDir, "pglite")), false, "no PGlite directory created");
  assert.throws(() => getDb({ env: {}, dataDir }), (error) => {
    assert.ok(error instanceof NoDatabaseError);
    assert.equal(error.code, "FIELD_NO_DATABASE");
    assert.match(error.message, /set DATABASE_URL or FIELD_DB_URL/);
    return true;
  });
  await assert.rejects(checkDb({ env: {}, dataDir }), NoDatabaseError);
});

test("queryRows refuses plain strings (only parameterised sql`` fragments)", async () => {
  const handle = await createTestDb();
  try {
    await assert.rejects(queryRows("select 1", handle.db), /sql`` fragment, not a string/);
    assert.deepEqual(await queryRows(sql`select ${"x"}::text as v`, handle.db), [{ v: "x" }]);
  } finally {
    await handle.close();
  }
});

test("createTestDb gives isolated, migrated databases with production-like value types", async () => {
  const first = await createTestDb();
  const second = await createTestDb();
  try {
    assert.deepEqual(await getMigrationStatus(first.db), { total: journal.length, applied: journal.length, pending: 0 });
    await first.db.insert(schema.toolchainProbe).values({ probeKey: "only-in-first" });
    assert.equal((await first.db.select().from(schema.toolchainProbe)).length, 1);
    assert.equal((await second.db.select().from(schema.toolchainProbe)).length, 0);

    const [row] = await queryRows(PARITY_QUERY, first.db);
    assert.deepEqual(row, EXPECTED_PARITY);
  } finally {
    await first.close();
    await second.close();
  }
});

test("createTestDb({ install: true }) is what getDb() returns until it closes", async () => {
  const handle = await createTestDb({ install: true });
  assert.equal(getDb(), handle.db);
  assert.deepEqual(getDbInfo(), { driver: "pglite", target: "pglite (test)" });
  await assert.rejects(createTestDb({ install: true }), /already open/);
  await handle.close();
  assert.equal(getDbInfo(), null);
});

test("PGlite under a directory persists, migrates once and is idempotent on reopen", async () => {
  const dataDir = tempDir();
  const env = { FIELD_PGLITE: "1" };
  const first = await runMigrations({ env, dataDir });
  assert.deepEqual(first, {
    driver: "pglite",
    target: `pglite (${join(dataDir, "pglite")})`,
    total: journal.length,
    applied: journal.length,
  });
  assert.equal(readFileSync(join(dataDir, "pglite.holder.lock"), "utf8").trim(), String(process.pid), "lock held while open");
  await getDb().insert(schema.toolchainProbe).values({ probeKey: "persisted" });
  await closeDb();
  assert.equal(existsSync(join(dataDir, "pglite.holder.lock")), false, "lock released on close");

  const second = await runMigrations({ env, dataDir });
  assert.equal(second.applied, 0);
  const rows = await getDb().select().from(schema.toolchainProbe);
  assert.deepEqual(rows.map((row) => row.probeKey), ["persisted"]);
  const status = await checkDb();
  assert.equal(status.ok, true);
  assert.deepEqual(status.migrations, { total: journal.length, applied: journal.length, pending: 0 });
});

// process.env without anything that selects a database.
function cleanEnv() {
  const env = { ...process.env };
  for (const name of ["FIELD_DB_URL", "DATABASE_URL", "FIELD_PGLITE", "FIELD_PGLITE_DIR", "FIELD_RUNTIME", "REPLIT_DEPLOYMENT"]) {
    delete env[name];
  }
  return env;
}

async function waitFor(check, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, message());
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function runChild(source, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...cleanEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, output })));
  return { child, exited, output: () => output };
}

test("a PGlite directory open in another process is refused, and freed when that process exits, even if killed", async () => {
  const dir = join(tempDir(), "pglite");
  const moduleUrl = new URL("./index.js", import.meta.url).href;
  const holderSource = `const rt = await import(${JSON.stringify(moduleUrl)});
     await rt.runMigrations();
     console.log("ready");
     await new Promise((resolve) => process.once("SIGTERM", resolve));
     await rt.closeDb();`;
  const startHolder = async () => {
    const holder = runChild(holderSource, { FIELD_PGLITE_DIR: dir });
    await waitFor(() => holder.output().includes("ready"), () => `holder did not open the database: ${holder.output()}`);
    return holder;
  };

  // A clean shutdown releases the lock and removes the holder record. The lock
  // file itself stays (it is never deleted; see acquirePgliteLock).
  let holder = await startHolder();
  try {
    assert.throws(() => getDb({ env: { FIELD_PGLITE_DIR: dir } }), new RegExp(`in use by process ${holder.child.pid}`));
  } finally {
    holder.child.kill("SIGTERM");
  }
  assert.equal((await holder.exited).code, 0, holder.output());
  assert.equal(existsSync(`${dir}.lock`), true);
  assert.equal(existsSync(`${dir}.holder.lock`), false);

  // A holder killed outright leaves its lock file and holder record behind;
  // the kernel has dropped its lock, so the next process just takes it.
  holder = await startHolder();
  holder.child.kill("SIGKILL");
  await holder.exited;
  assert.equal(readFileSync(`${dir}.holder.lock`, "utf8").trim(), String(holder.child.pid));
  const result = await runMigrations({ env: { FIELD_PGLITE_DIR: dir } });
  assert.equal(result.applied, 0);
  assert.equal(readFileSync(`${dir}.holder.lock`, "utf8").trim(), String(process.pid));
  await closeDb();
  assert.equal(existsSync(`${dir}.holder.lock`), false);
});

test("the PGlite lock is exclusive within one process too", () => {
  const dir = join(tempDir(), "pglite");
  const first = acquirePgliteLockForTests(dir);
  try {
    assert.throws(() => acquirePgliteLockForTests(dir), new RegExp(`in use by process ${process.pid}`));
  } finally {
    releasePgliteLockForTests(first);
  }
  releasePgliteLockForTests(acquirePgliteLockForTests(dir));
});

// The quote/invoice proof compares a PGlite run with a FIELD_STORAGE=postgres
// run under the seeded random source; opening PGlite must not draw from it.
test("opening a PGlite directory draws nothing from the seeded verification random source", async () => {
  const preload = new URL("../../scripts/verification/deterministic-preload.cjs", import.meta.url).pathname;
  const moduleUrl = new URL("./index.js", import.meta.url).href;
  const firstUuid = async (open) => {
    const source = `const { randomUUID } = await import("node:crypto");
      const rt = await import(${JSON.stringify(moduleUrl)});
      ${open ? "await rt.runMigrations();" : ""}
      console.log("uuid " + randomUUID());
      await rt.closeDb();`;
    const child = spawn(process.execPath, ["--require", preload, "--input-type=module", "-e", source], {
      env: { ...cleanEnv(), FIELD_VERIFICATION_DETERMINISTIC: "1", ...(open ? { FIELD_PGLITE_DIR: join(tempDir(), "pglite") } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 0, output);
    return output.match(/^uuid (\S+)$/m)?.[1];
  };
  const [untouched, afterPglite] = await Promise.all([firstUuid(false), firstUuid(true)]);
  assert.ok(untouched);
  assert.equal(afterPglite, untouched);
});

test("a lock file in an old format is reported with how to clear it, not taken over", () => {
  const dir = join(tempDir(), "pglite");
  writeFileSync(`${dir}.lock`, "12345\n");
  assert.throws(() => acquirePgliteLockForTests(dir), /is not a Field lock file .* delete it/);
  assert.equal(readFileSync(`${dir}.lock`, "utf8"), "12345\n");
});

// A process that takes the PGlite lock, prints "won" (or "busy") and holds it
// until SIGTERM.
const LOCK_RACER_SOURCE = `const rt = await import(${JSON.stringify(new URL("./index.js", import.meta.url).href)});
    let lock;
    try { lock = rt.acquirePgliteLockForTests(process.env.LOCK_DIR); } catch (error) {
      console.log(/in use by/.test(error.message) ? "busy" : "error " + error.message);
      process.exit(0);
    }
    console.log("won");
    // Nothing else keeps this process alive while it holds the lock.
    const keepAlive = setInterval(() => {}, 60_000);
    await new Promise((resolve) => process.once("SIGTERM", resolve));
    clearInterval(keepAlive);
    rt.releasePgliteLockForTests(lock);`;

// The earlier pid-file lock treated an empty or unreadable lock file as stale
// and took it over, although a live holder's file is empty for a moment after
// it is created. Whatever the files beside a live holder contain, it keeps
// the lock.
test("a live PGlite lock holder is never taken over, whatever its lock files contain", async () => {
  const dir = join(tempDir(), "pglite");
  const holder = runChild(LOCK_RACER_SOURCE, { LOCK_DIR: dir });
  try {
    await waitFor(() => /won|busy|error/.test(holder.output()), () => `holder: ${holder.output()}`);
    assert.match(holder.output(), /won/);
    for (const [lockContent, record] of [["", ""], ["", "not a pid"], [null, null], ["", "999999999"]]) {
      if (lockContent !== null) writeFileSync(`${dir}.lock`, lockContent);
      if (record === null) rmSync(`${dir}.holder.lock`, { force: true });
      else writeFileSync(`${dir}.holder.lock`, record);
      assert.throws(() => acquirePgliteLockForTests(dir), /is in use by (another process|process \d+)/, JSON.stringify(record));
    }
  } finally {
    holder.child.kill("SIGTERM");
  }
  assert.equal((await holder.exited).code, 0, holder.output());
  releasePgliteLockForTests(acquirePgliteLockForTests(dir));
});

// Many processes race for one PGlite lock, from each starting state that
// broke the earlier pid-file lock: no file, an empty lock file, a lock and
// holder record left by a killed process, and an empty holder record.
// Exactly one may win every round.
test("processes racing for one PGlite lock: exactly one wins, from every starting state", async () => {
  const source = LOCK_RACER_SOURCE;
  const killedHolder = async (dir) => {
    const holder = runChild(source, { LOCK_DIR: dir });
    await waitFor(() => /won|busy|error/.test(holder.output()), () => `holder: ${holder.output()}`);
    assert.match(holder.output(), /won/);
    holder.child.kill("SIGKILL");
    await holder.exited;
  };
  const setups = {
    "no lock file": async () => {},
    "empty lock file": async (dir) => writeFileSync(`${dir}.lock`, ""),
    "left by a killed holder": killedHolder,
    "empty holder record": async (dir) => {
      await killedHolder(dir);
      writeFileSync(`${dir}.holder.lock`, "");
    },
  };
  const racerCount = 6;
  for (const [name, setup] of Object.entries(setups)) {
    for (let round = 0; round < 2; round += 1) {
      const parent = tempDir();
      const dir = join(parent, "pglite");
      await setup(dir);
      const racers = Array.from({ length: racerCount }, () => runChild(source, { LOCK_DIR: dir }));
      let settled = false;
      try {
        await waitFor(
          () => racers.every((racer) => /won|busy|error/.test(racer.output())),
          () => `${name}: racers did not finish: ${racers.map((racer) => racer.output()).join(" | ")}`,
        );
        const outcomes = racers.map((racer) => racer.output().match(/won|busy|error.*/)[0]).sort();
        assert.deepEqual(outcomes, [...Array(racerCount - 1).fill("busy"), "won"], name);
        const winner = racers.find((racer) => racer.output().includes("won"));
        assert.equal(readFileSync(`${dir}.holder.lock`, "utf8").trim(), String(winner.child.pid), name);
        assert.deepEqual(readdirSync(parent).sort(), ["pglite.holder.lock", "pglite.lock"], name);
        settled = true;
      } finally {
        // The losers exit by themselves; signalling one that has printed
        // "busy" but not yet exited would kill it. Stop only the winner,
        // unless the round failed.
        for (const racer of racers) {
          if (!settled || racer.output().includes("won")) racer.child.kill("SIGTERM");
        }
      }
      for (const racer of racers) assert.equal((await racer.exited).code, 0, racer.output());
      assert.deepEqual(readdirSync(parent), ["pglite.lock"], `${name}: holder record removed on release`);
    }
  }
});

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// Boots the real server on an empty data directory. The SQLite price catalogue
// is not provisioned there, so its degraded-boot override is set: these tests
// are about the database runtime, not the catalogue.
function bootServer(env) {
  const child = spawn(process.execPath, [new URL("../index.js", import.meta.url).pathname], {
    env: { ...cleanEnv(), FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
  return { child, exited, output: () => output };
}

test("server boot with no database configured: no PGlite is opened and /health answers 200", async () => {
  const dataDir = tempDir();
  const port = await freePort();
  const server = bootServer({ FIELD_TOKEN: randomToken(), FIELD_DATA: dataDir, FIELD_PORT: String(port), NODE_ENV: "production" });
  let exited = false;
  server.exited.then(() => (exited = true));
  try {
    let healthy = false;
    const poll = setInterval(async () => {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
      } catch {
        // Not listening yet.
      }
    }, 100);
    await waitFor(() => healthy || exited, () => `server did not answer /health: ${server.output()}`, 60_000).finally(() =>
      clearInterval(poll),
    );
    assert.equal(healthy, true, server.output());
    assert.match(server.output(), /\[db\] no database configured: migrations skipped/);
    assert.equal(existsSync(join(dataDir, "pglite")), false, "PGlite must not be created");
    assert.equal(existsSync(join(dataDir, "pglite.lock")), false);
  } finally {
    server.child.kill("SIGTERM");
  }
  await server.exited;
});

test("server boot on Replit with PGlite requested exits with the refusal, before listening", async () => {
  const dataDir = tempDir();
  const port = await freePort();
  const server = bootServer({
    FIELD_TOKEN: randomToken(),
    FIELD_DATA: dataDir,
    FIELD_PORT: String(port),
    FIELD_RUNTIME: "replit",
    FIELD_PGLITE: "1",
  });
  const code = await server.exited;
  assert.equal(code, 1, server.output());
  assert.match(server.output(), /\[db\] migrations failed: PGlite is refused on Replit/);
  assert.equal(existsSync(join(dataDir, "pglite")), false);
});

test("an unreachable PostgreSQL fails without revealing the connection string", async () => {
  const url = "postgres://field:s3cret-password@127.0.0.1:1/field";
  await assert.rejects(runMigrations({ env: { FIELD_DB_URL: url } }), (error) => {
    assert.doesNotMatch(`${error.message}\n${error.stack}`, /s3cret/);
    return true;
  });
  assert.deepEqual(getDbInfo(), { driver: "postgres", target: "postgres (FIELD_DB_URL)" });
});

const realPostgres = testPostgresMode().kind !== "none";

test("real PostgreSQL: migrations apply once, concurrently safe, with the same value types as PGlite", { skip: realPostgres ? false : "set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1" }, async () => {
  const pg = await startTestPostgres();
  try {
    // Two processes booting at once against one empty database.
    const moduleUrl = new URL("./index.js", import.meta.url).href;
    const source = `const rt = await import(${JSON.stringify(moduleUrl)});
      console.log(JSON.stringify(await rt.runMigrations()));
      await rt.closeDb();`;
    const runs = await Promise.all([1, 2].map(() => runChild(source, { FIELD_DB_URL: pg.url }).exited));
    for (const run of runs) assert.equal(run.code, 0, run.output);
    const applied = runs.map((run) => JSON.parse(run.output.trim().split("\n").at(-1)).applied).sort();
    assert.deepEqual(applied, [0, journal.length]);
    assert.doesNotMatch(runs.map((run) => run.output).join("\n"), /postgres:\/\//);

    const again = await runMigrations({ env: { FIELD_DB_URL: pg.url } });
    assert.deepEqual(again, { driver: "postgres", target: "postgres (FIELD_DB_URL)", total: journal.length, applied: 0 });
    const status = await checkDb();
    assert.equal(status.driver, "postgres");
    assert.deepEqual(status.migrations, { total: journal.length, applied: journal.length, pending: 0 });

    const [row] = await queryRows(PARITY_QUERY);
    assert.deepEqual(row, EXPECTED_PARITY);

    await getDb().insert(schema.toolchainProbe).values({ probeKey: "real" });
    const rows = await getDb().select().from(schema.toolchainProbe);
    assert.deepEqual(rows.map((r) => r.probeKey), ["real"]);
    assert.ok(rows[0].createdAt instanceof Date);

    // A hung holder of the migration lock makes boot fail after the bound,
    // instead of blocking forever.
    const [held] = await queryRows(sql`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint) as locked`);
    assert.equal(held.locked, true);
    const started = Date.now();
    const blocked = await runChild(source, { FIELD_DB_URL: pg.url, FIELD_DB_MIGRATION_LOCK_TIMEOUT_MS: "750" }).exited;
    assert.notEqual(blocked.code, 0, blocked.output);
    assert.match(blocked.output, /held the migration lock .* for over 750 ms/);
    assert.doesNotMatch(blocked.output, /s3cret|postgres:\/\/[^[]/);
    assert.ok(Date.now() - started < 20_000, "bounded wait");
    await queryRows(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY.toString()}::bigint)`);
  } finally {
    await closeDb();
    await pg.stop();
  }
});

test("real PostgreSQL: databases on one server migrating at once all succeed (field_app is cluster-wide)", { skip: realPostgres ? false : "set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1" }, async () => {
  // The migration lock is an advisory lock, which is per database, but the
  // field_app role 0005 creates, alters and grants is shared by every
  // database on the server. Several fresh databases migrating together used
  // to fail one of them with "tuple concurrently updated".
  const moduleUrl = new URL("./index.js", import.meta.url).href;
  const source = `const rt = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(await rt.runMigrations()));
    await rt.closeDb();`;
  for (let round = 0; round < 3; round += 1) {
    const databases = await Promise.all(Array.from({ length: 6 }, () => startTestPostgres()));
    try {
      const runs = await Promise.all(databases.map((pg) => runChild(source, { FIELD_DB_URL: pg.url }).exited));
      for (const run of runs) assert.equal(run.code, 0, run.output);
      for (const run of runs) assert.equal(JSON.parse(run.output.trim().split("\n").at(-1)).applied, journal.length);
    } finally {
      await Promise.all(databases.map((pg) => pg.stop()));
    }
  }
});
