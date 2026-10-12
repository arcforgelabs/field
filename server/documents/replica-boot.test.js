// Booting the real server with FIELD_DOCUMENT_REPLICA=r2 (#240): the Replit
// workspace keeps starting with the replica off and one warning; the
// published app refuses to start when a setting is missing, naming the
// variable and never a value. Neither touches R2.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "field-replica-boot-"));
  dirs.push(dir);
  return dir;
}

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

function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(FIELD_|REPL_|REPLIT_)/.test(name) || name === "DATABASE_URL") delete env[name];
  }
  return env;
}

// The real server on an empty data directory and no database (the catalogue's
// degraded-boot override is set: this is about the replica's configuration).
function bootServer(env) {
  const child = spawn(process.execPath, [new URL("../index.js", import.meta.url).pathname], {
    env: { ...cleanEnv(), FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1", FIELD_TOKEN: randomBytes(16).toString("hex"), FIELD_DATA: tempDir(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
  return { child, exited, output: () => output };
}

async function waitFor(check, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message());
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

const SECRET = "Zq9xW4vT7kP2mN8bR5yH3jL6dF1gC0aa"; // gitleaks:allow (synthetic test credential)
const ACCESS = "AKIDQ7ZX93M2N8P4K6W1JHV5"; // gitleaks:allow (synthetic test credential)

test("Replit workspace with FIELD_DOCUMENT_REPLICA=r2: starts, one warning, replica off in /health", async () => {
  const port = await freePort();
  const server = bootServer({
    FIELD_PORT: String(port),
    FIELD_RUNTIME: "replit",
    FIELD_DOCUMENT_REPLICA: "r2",
    // Shared settings that leaked in, one of them malformed: never read here.
    FIELD_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    FIELD_R2_ACCESS_KEY_ID: ACCESS,
    FIELD_R2_SECRET_ACCESS_KEY: `${SECRET} not valid`,
  });
  let exited = false;
  server.exited.then(() => (exited = true));
  try {
    let health = null;
    await waitFor(async () => {
      if (exited) return true;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) health = await res.json();
      } catch {}
      return Boolean(health);
    }, () => `server did not answer /health: ${server.output()}`);
    assert.ok(health, server.output());
    assert.deepEqual(health.storage.documentReplica, { state: "off" });
    const warnings = server.output().split("\n").filter((line) => line.includes("[documents-replica]"));
    assert.equal(warnings.length, 1, server.output());
    assert.match(warnings[0], /FIELD_DOCUMENT_REPLICA=r2 is ignored in the Replit workspace.*nothing is written to R2/);
    assert.ok(!server.output().includes(SECRET) && !server.output().includes(ACCESS));
  } finally {
    server.child.kill("SIGTERM");
  }
  await server.exited;
});

test("published app with FIELD_DOCUMENT_REPLICA=r2 and a setting missing: refuses to start, names it, prints no value", async () => {
  const server = bootServer({
    FIELD_PORT: String(await freePort()),
    FIELD_RUNTIME: "replit",
    REPLIT_DEPLOYMENT: "1",
    FIELD_DOCUMENT_REPLICA: "r2",
    FIELD_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    FIELD_R2_ACCESS_KEY_ID: ACCESS,
    FIELD_R2_SECRET_ACCESS_KEY: SECRET,
  });
  const code = await server.exited;
  assert.equal(code, 1, server.output());
  assert.match(server.output(), /\[documents-replica\] FIELD_R2_BUCKET is not set/);
  assert.ok(!server.output().includes(SECRET) && !server.output().includes(ACCESS));
  assert.doesNotMatch(server.output(), /listening on/);
});
