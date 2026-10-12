// Test helper: a real, disposable PostgreSQL database for tests that need more
// than PGlite. Off by default; opt in the same way as server/db/test:
//
//   FIELD_DB_TEST_DATABASE_URL=<url of a disposable dev/test server>  (CI sets this)
//   FIELD_DB_TEST_DOCKER=1  start a throwaway postgres:16-alpine container
//
// startTestPostgres() resolves to null when neither is set. Otherwise it creates
// a fresh, uniquely named database on that server (so parallel test files never
// share one) and returns { url, stop }; stop() drops the database and removes
// any container it started. Never point it at a production server.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { resolveDatabaseTestMode } from "../db/test/data-layer-mode.js";

function startDockerPostgres() {
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("FIELD_DB_TEST_DOCKER=1 requires a working Docker CLI");
  }
  const id = execFileSync(
    "docker",
    [
      "run", "--rm", "--detach",
      "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env", "POSTGRES_DB=field_db_test",
      "postgres:16-alpine",
    ],
    { encoding: "utf8" },
  ).trim();
  const port = execFileSync("docker", ["port", id, "5432/tcp"], { encoding: "utf8" }).trim().match(/:(\d+)$/)?.[1];
  const remove = () => {
    const result = spawnSync("docker", ["rm", "--force", id], { stdio: "ignore" });
    if (result.status !== 0) throw new Error(`Failed to remove test PostgreSQL container ${id}`);
  };
  if (!port) {
    remove();
    throw new Error("Docker did not publish a PostgreSQL port");
  }
  return { url: `postgres://postgres@127.0.0.1:${port}/field_db_test`, remove };
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const client = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });
    try {
      await client`select 1`;
      return client;
    } catch (error) {
      await client.end({ timeout: 1 });
      if (Date.now() > deadline) throw new Error(`PostgreSQL did not become ready: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export function testPostgresMode(env = process.env) {
  return resolveDatabaseTestMode({
    databaseUrl: env.FIELD_DB_TEST_DATABASE_URL,
    dockerRequested: env.FIELD_DB_TEST_DOCKER === "1",
  });
}

export async function startTestPostgres(env = process.env) {
  const mode = testPostgresMode(env);
  if (mode.kind === "none") return null;
  const container = mode.kind === "docker" ? startDockerPostgres() : null;
  const serverUrl = container ? container.url : mode.databaseUrl;
  let admin;
  try {
    admin = await waitForServer(serverUrl);
    const name = `field_test_${randomBytes(6).toString("hex")}`;
    await admin.unsafe(`create database ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    return {
      url: url.toString(),
      async stop() {
        try {
          await admin.unsafe(`drop database if exists ${name} with (force)`);
          await admin.end({ timeout: 5 });
        } finally {
          container?.remove();
        }
      },
    };
  } catch (error) {
    await admin?.end({ timeout: 1 });
    container?.remove();
    throw error;
  }
}
