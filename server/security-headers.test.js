// Security headers (#179): the middleware alone, and the real server.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import {
  addScriptNonce,
  buildContentSecurityPolicy,
  resolveCspMode,
  securityHeaders,
} from "./security-headers.js";

const ROOT = resolve(import.meta.dirname, "..");

function directives(policy) {
  return Object.fromEntries(policy.split(";").map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
}

async function listen(app) {
  const server = await new Promise((done) => {
    const s = app.listen(0, "127.0.0.1", () => done(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("FIELD_CSP is report-only unless set, and a wrong value is refused", () => {
  assert.equal(resolveCspMode({}), "report-only");
  assert.equal(resolveCspMode({ FIELD_CSP: " Enforce " }), "enforce");
  assert.equal(resolveCspMode({ FIELD_CSP: "off" }), "off");
  assert.throws(() => resolveCspMode({ FIELD_CSP: "block" }), /FIELD_CSP must be one of/);
});

test("the policy allows scripts only from Field, Clerk and the response's nonce", () => {
  const policy = directives(buildContentSecurityPolicy({ nonce: "abc123" }));
  assert.deepEqual(policy["default-src"], ["'self'"]);
  // The whole source lists, so a widened policy fails here.
  assert.deepEqual(policy["script-src"], [
    "'self'", "'nonce-abc123'", "https://*.clerk.com", "https://*.clerk.accounts.dev", "https://challenges.cloudflare.com",
  ]);
  assert.deepEqual(policy["connect-src"], [
    "'self'", "https://*.clerk.com", "https://*.clerk.accounts.dev", "https://clerk-telemetry.com",
    "https://*.sentry.io", "https://nominatim.openstreetmap.org",
  ]);
  assert.deepEqual(policy["worker-src"], ["'self'", "blob:"]);
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.deepEqual(policy["base-uri"], ["'self'"]);
  assert.deepEqual(policy["frame-ancestors"], ["'none'"]);
  assert.equal("frame-ancestors" in directives(buildContentSecurityPolicy({ nonce: "x", enforce: false })), false);
});

test("every script tag in the built page gets the nonce, once", async () => {
  const source = await readFile(join(ROOT, "client/index.html"), "utf8");
  const sentry = "<script>window.__FIELD_SENTRY__={};</script>";
  const html = addScriptNonce(source.replace("</head>", `${sentry}</head>`), "n0nce");
  const tags = html.match(/<script\b[^>]*>/gi);
  assert.equal(tags.length, 3);
  for (const tag of tags) assert.match(tag, /\snonce="n0nce"/);
  assert.equal(addScriptNonce(html, "n0nce"), html);
  assert.equal(addScriptNonce("<scripts><script>", "x"), '<scripts><script nonce="x">');
  assert.equal(addScriptNonce("<script>", undefined), "<script>");
});

test("each mode sets its header, with a new nonce on every response", async (t) => {
  for (const [mode, header, absent] of [
    ["report-only", "content-security-policy-report-only", "content-security-policy"],
    ["enforce", "content-security-policy", "content-security-policy-report-only"],
  ]) {
    const app = express();
    app.use(securityHeaders({ cspMode: mode }));
    app.get("/", (_req, res) => res.send(addScriptNonce("<script>1</script>", res.locals.cspNonce)));
    const { server, base } = await listen(app);
    t.after(() => server.close());
    const first = await fetch(base);
    const second = await fetch(base);
    const policy = first.headers.get(header);
    assert.ok(policy, `${mode}: ${header}`);
    assert.equal(first.headers.get(absent), null);
    const nonce = policy.match(/'nonce-([^']+)'/)[1];
    assert.equal(await first.text(), `<script nonce="${nonce}">1</script>`);
    assert.notEqual(second.headers.get(header), policy);
  }

  const app = express();
  app.use(securityHeaders({ cspMode: "off" }));
  app.get("/", (_req, res) => res.send("ok"));
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const response = await fetch(base);
  assert.equal(response.headers.get("content-security-policy"), null);
  assert.equal(response.headers.get("content-security-policy-report-only"), null);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

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

async function bootServer(t, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), "field-security-headers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ authToken: "security-headers-test-service-key-0001" }));
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
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
      ...extraEnv,
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
    if (child.exitCode !== null) return { exitCode: child.exitCode, output: output.join("") };
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200) return { base, output };
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${output.join("")}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
}

test("the real server sends the headers on pages, API answers and errors", async (t) => {
  const { base, output } = await bootServer(t);
  assert.ok(base, output);
  for (const path of ["/health", "/api/jobs", "/api/no-such-route"]) {
    const response = await fetch(`${base}${path}`);
    const label = `${path} (${response.status})`;
    assert.equal(response.headers.get("x-powered-by"), null, label);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
    assert.equal(response.headers.get("x-frame-options"), "DENY", label);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", label);
    assert.match(response.headers.get("content-security-policy-report-only") || "", /script-src 'self' 'nonce-/, label);
    // Express's own 404 page sends its stricter default-src 'none'.
    if (response.status !== 404) assert.equal(response.headers.get("content-security-policy"), null, label);
  }
});

test("FIELD_CSP=enforce sends an enforced policy, and a wrong value stops boot", async (t) => {
  const { base, output } = await bootServer(t, { FIELD_CSP: "enforce" });
  assert.ok(base, output);
  const response = await fetch(`${base}/health`);
  assert.match(response.headers.get("content-security-policy") || "", /script-src 'self' 'nonce-.*frame-ancestors 'none'/);
  assert.equal(response.headers.get("content-security-policy-report-only"), null);

  const refused = await bootServer(t, { FIELD_CSP: "block" });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, /FIELD_CSP must be one of/);
});
