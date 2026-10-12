import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { resolveDatabaseTestMode } from "./data-layer-mode.js";

const dbRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(dbRoot, "../..");
const migrationFolder = resolve(dbRoot, "drizzle");
const compiledEntry = resolve(dbRoot, "dist", "index.js");

let dataLayer;
let connection;
const databaseTestMode = resolveDatabaseTestMode({
  databaseUrl: process.env.FIELD_DB_TEST_DATABASE_URL,
  dockerRequested: process.env.FIELD_DB_TEST_DOCKER === "1",
});
let databaseUrl = databaseTestMode.databaseUrl;
let dockerContainerId = "";

function dockerIsAvailable() {
  return spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
}

function startEphemeralPostgres() {
  if (!dockerIsAvailable()) {
    throw new Error("FIELD_DB_TEST_DOCKER=1 requires a working Docker CLI");
  }

  dockerContainerId = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--detach",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "POSTGRES_DB=field_db_test",
      "postgres:16-alpine",
    ],
    { encoding: "utf8" },
  ).trim();

  const publishedPort = execFileSync(
    "docker",
    ["port", dockerContainerId, "5432/tcp"],
    { encoding: "utf8" },
  )
    .trim()
    .match(/:(\d+)$/)?.[1];

  if (!publishedPort) {
    throw new Error("Docker did not publish a PostgreSQL port");
  }

  databaseUrl = `postgres://postgres@127.0.0.1:${publishedPort}/field_db_test`;
}

async function connectWithRetry() {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    const candidate = dataLayer.createDatabase(databaseUrl);
    try {
      await candidate.client`select 1`;
      return candidate;
    } catch (error) {
      lastError = error;
      await candidate.client.end({ timeout: 1 });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }

  throw new Error(`PostgreSQL did not become ready: ${lastError?.message ?? "unknown error"}`);
}

before(async () => {
  assert.ok(existsSync(compiledEntry), "run npm run db:build before importing the data layer");
  dataLayer = await import(compiledEntry);

  if (databaseTestMode.kind === "docker") {
    startEphemeralPostgres();
  }
  if (databaseTestMode.kind !== "none") {
    connection = await connectWithRetry();
  }
});

after(async () => {
  try {
    if (connection) {
      await connection.client.end({ timeout: 5 });
    }
  } finally {
    if (dockerContainerId) {
      const cleanup = spawnSync("docker", ["rm", "--force", dockerContainerId], {
        stdio: "ignore",
      });
      const removedContainerId = dockerContainerId;
      dockerContainerId = "";
      if (cleanup.error) {
        throw cleanup.error;
      }
      if (cleanup.status !== 0) {
        throw new Error(
          `Failed to remove ephemeral PostgreSQL container ${removedContainerId} (exit ${cleanup.status ?? "unknown"})`,
        );
      }
    }
  }
});

test("compiled data layer is importable as ESM by the plain-JS runtime", () => {
  assert.equal(typeof dataLayer.createDatabase, "function");
  assert.equal(typeof dataLayer.insertToolchainProbe, "function");
  assert.equal(typeof dataLayer.listToolchainProbes, "function");
  assert.equal(dataLayer.toolchainProbe[Symbol.for("drizzle:Name")], "drizzle_toolchain_probe");
});

test("generated migrations: the Drizzle toolchain proof, durable storage, the price catalogue, every SQL file journaled, no quote or customer tables", () => {
  const migrationFiles = readdirSync(migrationFolder)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  const journal = JSON.parse(
    readFileSync(resolve(migrationFolder, "meta", "_journal.json"), "utf8"),
  );
  assert.equal(journal.dialect, "postgresql");
  assert.deepEqual(journal.entries.map((entry) => entry.tag), migrationFiles.map((fileName) => fileName.replace(/\.sql$/, "")));

  const probe = readFileSync(resolve(migrationFolder, migrationFiles[0]), "utf8");
  assert.equal(migrationFiles[0], "0000_toolchain_probe.sql");
  assert.match(probe, /CREATE TABLE "drizzle_toolchain_probe"/);
  assert.doesNotMatch(probe, /\b(quote|document|invoice|outbox|customer)\b/i);

  // Durable file storage.
  const storage = readFileSync(resolve(migrationFolder, "0001_durable_storage.sql"), "utf8");
  for (const table of ["field_blobs", "field_files", "field_sqlite_images"]) {
    assert.match(storage, new RegExp(`CREATE TABLE "${table}"`));
  }

  // Field users for Clerk sign-in.
  const users = migrationFiles
    .map((fileName) => readFileSync(resolve(migrationFolder, fileName), "utf8"))
    .find((migration) => /CREATE TABLE "users"/.test(migration));
  assert.ok(users, "a migration creates the users table");
  assert.match(users, /"clerk_user_id" text/);
  assert.match(users, /UNIQUE\("clerk_user_id"\)/);
  assert.match(users, /UNIQUE\("email"\)/);

  // Price catalogue.
  const catalogue = migrationFiles.find((name) => /_price_catalogue\.sql$/.test(name));
  assert.ok(catalogue, "the price catalogue migration is generated and committed");
  const catalogueSql = readFileSync(resolve(migrationFolder, catalogue), "utf8");
  for (const table of ["items", "item_prices", "item_components", "units", "unit_aliases", "item_unit_conversions", "catalog_history", "catalog_meta"]) {
    assert.match(catalogueSql, new RegExp(`CREATE TABLE "${table}"`));
  }
  // Document tables arrive only by an approved, named step: quotes as rows
  // (#6, migration 0010). Anything else that looks like one is a mistake.
  const approved = new Map([["quotes", "0010_quote_rows.sql"]]);
  for (const name of migrationFiles) {
    const migration = readFileSync(resolve(migrationFolder, name), "utf8");
    for (const match of migration.matchAll(/CREATE TABLE "([^"]*\b(?:quote|document|invoice|outbox|customer)s?\b[^"]*)"/gi)) {
      assert.equal(approved.get(match[1]), name, `${name} creates a quote or customer table (${match[1]})`);
    }
  }
});

test("shared db build removes stale output before emitting the ESM entrypoint", () => {
  // Rebuilding the real server/db/dist here would delete it under every other
  // test file running in parallel that imports it (server/db-runtime, and the
  // server itself). Run the same two build steps on a private copy instead.
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["db:build"],
    "node server/db/clean-dist.js && tsc -p server/db/tsconfig.json",
    "update this test's copy of the db:build steps",
  );
  const copyRoot = mkdtempSync(join(tmpdir(), "field-db-build-"));
  try {
    const copyDb = join(copyRoot, "server", "db");
    mkdirSync(copyDb, { recursive: true });
    for (const name of ["clean-dist.js", "tsconfig.json", "src"]) {
      cpSync(resolve(dbRoot, name), join(copyDb, name), { recursive: true });
    }
    cpSync(resolve(repositoryRoot, "package.json"), join(copyRoot, "package.json"));
    symlinkSync(resolve(repositoryRoot, "node_modules"), join(copyRoot, "node_modules"), "dir");

    const staleOutput = join(copyDb, "dist", "obsolete-deleted-output.js");
    mkdirSync(dirname(staleOutput), { recursive: true });
    writeFileSync(staleOutput, "export const stale = true;\n");

    execFileSync(process.execPath, [join(copyDb, "clean-dist.js")], { stdio: "ignore" });
    execFileSync(
      process.execPath,
      [resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(copyDb, "tsconfig.json")],
      { stdio: "ignore" },
    );

    assert.equal(existsSync(staleOutput), false);
    assert.equal(existsSync(join(copyDb, "dist", "index.js")), true);
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("generated migration applies and the typed probe can be queried", async (t) => {
  if (!databaseUrl) {
    t.skip("set FIELD_DB_TEST_DATABASE_URL or use npm run db:test:docker");
    return;
  }

  await migrate(connection.db, { migrationsFolder: migrationFolder });

  const probe = await dataLayer.insertToolchainProbe(connection.db, {
    probeKey: `del-75-${Date.now()}`,
    payload: { scope: "toolchain-test" },
  });
  const rows = await dataLayer.listToolchainProbes(connection.db);

  assert.equal(rows.some((row) => row.id === probe.id), true);
  assert.deepEqual(probe.payload, { scope: "toolchain-test" });

  await connection.db
    .delete(dataLayer.toolchainProbe)
    .where(eq(dataLayer.toolchainProbe.id, probe.id));
});
