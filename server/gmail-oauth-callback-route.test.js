// Boots the real server with an offline Google (test-support/fake-google-oauth.mjs)
// and drives GET /api/auth/gmail/callback the way a browser arrives from
// Google's consent screen. The callback has no Field sign-in, so it must
// accept only a state Field issued, once, and must never answer with HTML
// built from the request or an error message.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGmailOAuthStateStore, gmailOAuthRedirectUri } from "./gmail-oauth-routes.js";

const ROOT = resolve(import.meta.dirname, "..");
const OWNER = "owner@example.invalid";
const SCRIPT = "<script>alert(document.domain)</script>";

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

async function bootServer(t, { consentEmail = OWNER, exchangeError = "" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "field-gmail-oauth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    authToken: "gmail-oauth-test-service-key-0001",
    bootstrapUsers: [{ email: OWNER, name: "OAuth Owner", password: "gmail-oauth-test-password" }],
    googleOAuth: { clientId: "test-client.apps.example.invalid", clientSecret: "test-client-secret" },
  }));
  const port = await freePort();
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const output = [];
  const child = spawn(process.execPath, ["--import", "./server/test-support/fake-google-oauth.mjs", "server/index.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FIELD_CONFIG: configPath,
      FIELD_DATA: dataDir,
      FIELD_PORT: String(port),
      FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1",
      FAKE_GOOGLE_EMAIL: consentEmail,
      FAKE_GOOGLE_ERROR: exchangeError,
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
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER, password: "gmail-oauth-test-password" }),
  });
  const { token } = await login.json();
  assert.ok(token, `sign-in failed:\n${output.join("")}`);
  const callback = async (query) => {
    const response = await fetch(`${base}/api/auth/gmail/callback?${new URLSearchParams(query)}`, { redirect: "manual" });
    return { status: response.status, type: response.headers.get("content-type") || "", location: response.headers.get("location"), text: await response.text() };
  };
  const startConsent = async (returnTo = "/settings/email") => {
    const response = await fetch(`${base}/api/auth/gmail?returnTo=${encodeURIComponent(returnTo)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200, `${await response.clone().text()}\n${output.join("")}`);
    return new URL((await response.json()).url).searchParams.get("state");
  };
  const storedUsers = async () => {
    const path = join(dataDir, "gmail-oauth-users.json");
    return existsSync(path) ? Object.keys(JSON.parse(await readFile(path, "utf8")).users || {}) : [];
  };
  return { callback, startConsent, storedUsers, output };
}

function forgedState(fields) {
  return Buffer.from(JSON.stringify({ returnTo: "/", userId: null, ...fields }), "utf8").toString("base64url");
}

function assertPlainText(result) {
  assert.match(result.type, /^text\/plain/, `answered ${result.type}: ${result.text}`);
  assert.ok(!result.text.includes("<"), `answer repeats markup: ${result.text}`);
}

test("a callback with a state Field never issued is refused before the code is exchanged, and nothing from it is echoed", async (t) => {
  const { callback, storedUsers } = await bootServer(t, { consentEmail: "attacker@example.invalid" });
  const result = await callback({ code: "attacker-code", state: forgedState({ userEmail: SCRIPT }) });
  assert.equal(result.status, 400);
  assertPlainText(result);
  assert.match(result.text, /not started from Field/);
  assert.deepEqual(await storedUsers(), [], "no token is stored for a forged state");
});

test("a failed code exchange answers in plain text without the error message", async (t) => {
  const { callback, startConsent, output } = await bootServer(t, { exchangeError: `invalid_grant ${SCRIPT}` });
  const result = await callback({ code: "fail", state: await startConsent() });
  assert.equal(result.status, 500);
  assertPlainText(result);
  assert.ok(output.join("").includes("[gmail-oauth-callback] token exchange failed"), "the detail is logged");
});

test("a consent Field started stores the token once, returns to the app, and its state cannot be replayed", async (t) => {
  const { callback, startConsent, storedUsers } = await bootServer(t);
  const state = await startConsent("/settings/email");
  const result = await callback({ code: "good-code", state });
  assert.equal(result.status, 302, result.text);
  assert.equal(result.location, "/#/settings/email?gmailReauthorized=1");
  assert.deepEqual(await storedUsers(), [OWNER]);

  const replay = await callback({ code: "good-code", state });
  assert.equal(replay.status, 400);
  assertPlainText(replay);
});

test("a consent completed with another Google account is refused in plain text", async (t) => {
  const { callback, startConsent, storedUsers } = await bootServer(t, { consentEmail: "someone-else@example.invalid" });
  const result = await callback({ code: "good-code", state: await startConsent() });
  assert.equal(result.status, 400);
  assertPlainText(result);
  assert.match(result.text, /different Google account/);
  assert.deepEqual(await storedUsers(), []);
});

test("states are single use, expire, and stay bounded", () => {
  let at = 1_000;
  const states = createGmailOAuthStateStore({ now: () => at, ttlMs: 60_000 });
  const first = states.issue({ returnTo: "/a", user: { id: "u1", email: "Owner@Example.invalid " } });
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(states.take(first), { returnTo: "/a", userId: "u1", userEmail: "owner@example.invalid", expiresAt: 61_000 });
  assert.equal(states.take(first), null, "used once");
  assert.equal(states.take(forgedState({ userEmail: SCRIPT })), null);
  assert.equal(states.take(undefined), null);
  assert.equal(states.take(["array"]), null);

  const late = states.issue({ returnTo: "/b", user: null });
  at += 60_000;
  assert.equal(states.take(late), null, "expired");

  for (let i = 0; i < 1500; i += 1) states.issue({ returnTo: "/", user: null });
  assert.equal(states.size, 1000);
});

test("the redirect URI trims trailing slashes in linear time", () => {
  const req = { headers: { "x-forwarded-host": `field.example.invalid${"/".repeat(100_000)}x` }, protocol: "https", get: () => "ignored" };
  const started = performance.now();
  assert.equal(gmailOAuthRedirectUri({}, req), `https://field.example.invalid${"/".repeat(100_000)}x/api/auth/gmail/callback`);
  assert.equal(gmailOAuthRedirectUri({ publicUrl: "https://field.example.invalid///" }, req), "https://field.example.invalid/api/auth/gmail/callback");
  assert.ok(performance.now() - started < 200);
});
