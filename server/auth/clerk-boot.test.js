// Boots the real server in both sign-in modes. FIELD_AUTH unset must
// behave as before; FIELD_AUTH=clerk (with dummy keys, so Clerk is never
// contacted) must start, refuse unauthenticated API calls and never print a key.
// The Clerk boot needs PostgreSQL: it runs when FIELD_DB_TEST_DATABASE_URL (CI)
// or FIELD_DB_TEST_DOCKER=1 is set, and is skipped otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startTestPostgres, testPostgresMode } from "../db-runtime/test-postgres.js";

const ROOT = resolve(import.meta.dirname, "../..");
const BREAK_GLASS_KEY = "boot-test-break-glass-key-0001";
// Syntactically valid, never real: the publishable key encodes "clerk.example.invalid$".
// (Assembled at runtime so secret scanners do not mistake the fixture for a key.)
const DUMMY_SECRET = ["sk", "test", "bootTestDummySecretValue0001"].join("_");
const DUMMY_PUBLISHABLE = `pk_test_${Buffer.from("clerk.example.invalid$").toString("base64")}`;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function bootServer(t, env) {
  const dir = await mkdtemp(join(tmpdir(), "field-auth-boot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    authToken: BREAK_GLASS_KEY,
    bootstrapUsers: [{ email: "owner@example.invalid", name: "Boot Owner", password: "boot-password" }],
  }));
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FIELD_CONFIG: configPath,
      FIELD_DATA: join(dir, "data"),
      FIELD_PORT: String(port),
      FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output.join("")}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${output.join("")}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
  return { base, output };
}

async function json(response) {
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("FIELD_AUTH unset: password sign-in works exactly as before", async (t) => {
  const { base } = await bootServer(t, {});
  assert.deepEqual((await json(await fetch(`${base}/api/auth/config`))).body, { ok: true, mode: "password" });
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
  const login = await json(await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.invalid", password: "boot-password" }),
  }));
  assert.equal(login.status, 200);
  assert.match(login.body.token, /^field_/);
  const me = await json(await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${login.body.token}` } }));
  assert.equal(me.body.user.email, "owner@example.invalid");
  assert.equal(me.body.user.role, "admin");
  assert.equal((await fetch(`${base}/api/users`, { headers: { authorization: `Bearer ${login.body.token}` } })).status, 200);
  // The break-glass header means nothing without Clerk sign-in.
  assert.equal((await fetch(`${base}/api/users`, { headers: { "x-field-break-glass": BREAK_GLASS_KEY } })).status, 401);
});

async function bootFailure(t, env) {
  const dir = await mkdtemp(join(tmpdir(), "field-auth-boot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ authToken: BREAK_GLASS_KEY }));
  const output = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FIELD_CONFIG: configPath,
      FIELD_DATA: join(dir, "data"),
      FIELD_PORT: "0",
      FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  return { code, log: output.join("") };
}

test("FIELD_AUTH=clerk with a bad owner setting refuses to start", async (t) => {
  const base = { FIELD_AUTH: "clerk", CLERK_SECRET_KEY: DUMMY_SECRET, CLERK_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE };
  const domains = await bootFailure(t, { ...base, FIELD_OWNER_GOOGLE_DOMAINS: "@business.example" });
  assert.equal(domains.code, 1);
  assert.match(domains.log, /\[auth\] Clerk sign-in could not start: FIELD_OWNER_GOOGLE_DOMAINS must be/);
  const age = await bootFailure(t, { ...base, FIELD_OWNER_MFA_MAX_AGE: "forever" });
  assert.equal(age.code, 1);
  assert.match(age.log, /FIELD_OWNER_MFA_MAX_AGE must be/);
  assert.doesNotMatch(domains.log + age.log, new RegExp(DUMMY_SECRET));
});

test("FIELD_AUTH=clerk without its keys refuses to start and names only the variables", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "field-auth-boot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ authToken: BREAK_GLASS_KEY }));
  const output = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FIELD_CONFIG: configPath,
      FIELD_DATA: join(dir, "data"),
      FIELD_PORT: "0",
      FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1",
      FIELD_AUTH: "clerk",
      CLERK_SECRET_KEY: "not-a-clerk-key-SECRETVALUE",
      CLERK_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  const log = output.join("");
  assert.equal(code, 1);
  assert.match(log, /\[auth\] Clerk sign-in could not start: CLERK_SECRET_KEY is not a Clerk secret key/);
  assert.doesNotMatch(log, /SECRETVALUE/);
});

const postgresMode = testPostgresMode();

test("FIELD_AUTH=clerk with dummy keys: starts, API needs sign-in, password login retired, no key printed", {
  skip: postgresMode.kind === "none" ? "set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1" : false,
}, async (t) => {
  const database = await startTestPostgres();
  t.after(() => database.stop());
  const { base, output } = await bootServer(t, {
    FIELD_AUTH: "clerk",
    FIELD_DB_URL: database.url,
    CLERK_SECRET_KEY: DUMMY_SECRET,
    CLERK_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE,
    FIELD_OWNER_GOOGLE_DOMAINS: "example.invalid",
    FIELD_PUBLIC_ORIGIN: "https://field.example.invalid",
    REPL_ID: "boot-test",
  });

  const config = await json(await fetch(`${base}/api/auth/config`));
  assert.deepEqual(config.body, { ok: true, mode: "clerk", clerk: { publishableKey: DUMMY_PUBLISHABLE, proxyUrl: null } });
  for (const path of ["/api/jobs", "/api/auth/me", "/api/users", "/api/ui-config"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, path);
  }
  const login = await json(await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.invalid", password: "boot-password" }),
  }));
  assert.equal(login.status, 410);
  assert.equal(login.body.code, "password_login_retired");

  // Break-glass reaches the owner screens; the bootstrap user was imported as owner.
  const people = await json(await fetch(`${base}/api/users`, { headers: { "x-field-break-glass": BREAK_GLASS_KEY } }));
  assert.equal(people.status, 200);
  assert.deepEqual(people.body.users.map((user) => [user.email, user.role, user.status]), [["owner@example.invalid", "owner", "active"]]);

  const log = output.join("");
  assert.match(log, /\[auth\] imported 1 user\(s\) from users\.json/);
  assert.match(log, /\[auth\] Clerk sign-in on \(CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY\)/);
  assert.match(log, /\[auth\] BREAK-GLASS OWNER ACCESS USED: GET \/api\/users/);
  assert.match(log, /\[auth\] owner actions: second factor within 720 min, or Google Workspace sign-in on example\.invalid with no password; Clerk authorized parties: https:\/\/field\.example\.invalid/);
  assert.match(log, /\[field\] trust proxy: 1 \(Replit default\)/);
  assert.doesNotMatch(log, new RegExp(DUMMY_SECRET));
  assert.doesNotMatch(log, new RegExp(BREAK_GLASS_KEY));
  assert.doesNotMatch(log, /pk_test_/);
});
