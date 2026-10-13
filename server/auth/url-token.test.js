// Boots the real server with password sign-in (FIELD_AUTH unset) and checks
// that a Field token is read only from the Authorization header: a token in
// the URL (?token=) authorizes nothing, neither a read nor a change.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

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

async function bootServer(t) {
  const dir = await mkdtemp(join(tmpdir(), "field-url-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    authToken: "url-token-test-service-key-0001",
    bootstrapUsers: [{ email: "owner@example.invalid", name: "Url Owner", password: "url-token-test-password" }],
  }));
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FIELD_CONFIG: configPath,
      FIELD_DATA: dataDir,
      FIELD_PORT: String(port),
      FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1",
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
      if ((await fetch(`${base}/health`)).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${output.join("")}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
  return { base, output };
}

test("password sign-in: a token in the URL authorizes nothing; the Authorization header does", async (t) => {
  const { base, output } = await bootServer(t);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.invalid", password: "url-token-test-password" }),
  });
  const { token } = await login.json();
  assert.ok(token, `sign-in failed:\n${output.join("")}`);
  const query = `token=${encodeURIComponent(token)}`;

  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/me?${query}`)).status, 401);
  assert.equal((await fetch(`${base}/api/jobs?${query}`)).status, 401);
  for (const [method, path] of [
    ["PUT", "/api/terms"],
    ["POST", "/api/jobs/00000000-0000-4000-8000-000000000000/archive"],
    ["DELETE", "/api/jobs/00000000-0000-4000-8000-000000000000"],
    ["POST", "/api/users"],
    ["POST", "/api/auth/logout"],
  ]) {
    const response = await fetch(`${base}${path}?${query}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify({ email: "someone@example.invalid", terms: [] }),
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  // The URL-borne logout did not revoke the token: it still works in the header.
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
});
