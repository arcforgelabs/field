// Rate limits (#135): the budgets, the keys and the 429 answer, first on an
// Express app wired the way server/index.js wires it, then on the real
// server booted with small budgets in its config.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import {
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_CLASSES,
  addressLimitOptions,
  classesFor,
  createRateLimits,
  resolveRateLimitBudgets,
  waitInWords,
} from "./rate-limits.js";

const ROOT = resolve(import.meta.dirname, "..");
const quiet = { warn() {}, error() {}, info() {} };

// The app server/index.js builds, in miniature: trust proxy, the address
// limiter and the address classes first, then requireAuth with the caller
// limits after the caller is known.
async function buildApp(t, { trustProxy = false, rateLimits = {}, log = quiet } = {}) {
  const budgets = resolveRateLimitBudgets(rateLimits);
  const limits = createRateLimits(budgets, { log });
  const tokens = new Map([["token-alex", { id: "user-alex" }], ["token-sam", { id: "user-sam" }]]);
  const app = express();
  if (trustProxy !== false) app.set("trust proxy", trustProxy);
  app.use(rateLimit(addressLimitOptions(budgets, { log })));
  app.use(limits.byAddress);
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    const caller = tokens.get(String(req.headers.authorization || "").replace(/^Bearer /, ""));
    if (!caller) return res.status(401).json({ error: "unauthorized" });
    req.caller = caller;
    return limits.byCaller(req, res, next);
  };
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/thing", requireAuth, (_req, res) => res.json({ ok: true }));
  // Authenticates twice, as a router mounted behind requireAuth can: still one count.
  app.get("/api/twice", requireAuth, requireAuth, (_req, res) => res.json({ ok: true }));
  app.post("/api/jobs/:id/email-quote", requireAuth, (_req, res) => res.json({ ok: true }));
  app.get("/api/jobs/:id/quote-pdf", requireAuth, (_req, res) => res.json({ ok: true }));
  app.post("/api/auth/login", (req, res) => (req.body?.password === "right"
    ? res.json({ ok: true })
    : res.status(401).json({ error: "invalid credentials" })));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolveListen) => server.once("listening", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (path, headers = {}) => fetch(`${base}${path}`, { headers }),
    post: (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
  };
}

const as = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

async function assertLimited(response, budget) {
  assert.equal(response.status, 429);
  const retryAfter = Number(response.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, `Retry-After is whole seconds: ${response.headers.get("retry-after")}`);
  assert.match(response.headers.get("ratelimit") || "", new RegExp(`"${budget}"; r=0`));
  assert.match(response.headers.get("ratelimit-policy") || "", new RegExp(`"${budget}"; q=`));
  const body = await response.json();
  assert.deepEqual(body, { error: `Too many requests. Try again in ${waitInWords(retryAfter)}.`, code: "rate_limited", retryAfter, budget });
}

test("the address limiter answers 429 with Retry-After once its budget is spent, and /health stays open", async (t) => {
  const app = await buildApp(t, { rateLimits: { address: { limit: 3, windowSeconds: 60 } } });
  for (let i = 0; i < 3; i += 1) assert.equal((await app.get("/api/thing", as("token-alex"))).status, 200);
  await assertLimited(await app.get("/api/thing", as("token-alex")), "address");
  // Before sign-in, so an unauthenticated request is refused just the same.
  await assertLimited(await app.get("/api/thing"), "address");
  for (let i = 0; i < 5; i += 1) assert.equal((await app.get("/health")).status, 200);
});

test("two callers behind one address get separate caller budgets", async (t) => {
  const app = await buildApp(t, { rateLimits: { caller: { limit: 2, windowSeconds: 60 } } });
  assert.equal((await app.get("/api/thing", as("token-alex"))).status, 200);
  assert.equal((await app.get("/api/twice", as("token-alex"))).status, 200, "authenticating twice counts once");
  await assertLimited(await app.get("/api/thing", as("token-alex")), "caller");
  assert.equal((await app.get("/api/thing", as("token-sam"))).status, 200);
  assert.equal((await app.get("/api/thing", as("token-sam"))).status, 200);
  await assertLimited(await app.get("/api/thing", as("token-sam")), "caller");
});

test("a forged or invalid token spends no caller's budget", async (t) => {
  const app = await buildApp(t, { rateLimits: { caller: { limit: 2, windowSeconds: 60 } } });
  // Someone who knows Alex's id, but not a token of Alex's.
  for (const forged of ["user-alex", "token-alex-forged", "caller:user-alex"]) {
    for (let i = 0; i < 3; i += 1) assert.equal((await app.get("/api/thing", as(forged))).status, 401);
  }
  assert.equal((await app.get("/api/thing", as("token-alex"))).status, 200);
  assert.equal((await app.get("/api/thing", as("token-alex"))).status, 200);
  await assertLimited(await app.get("/api/thing", as("token-alex")), "caller");
});

test("email-send and pdf-render cut in at their lower budgets, per caller", async (t) => {
  const app = await buildApp(t, { rateLimits: { "email-send": { limit: 2, windowSeconds: 300 }, "pdf-render": { limit: 3, windowSeconds: 300 } } });
  for (let i = 0; i < 2; i += 1) assert.equal((await app.post("/api/jobs/job-1/email-quote", {}, as("token-alex"))).status, 200);
  await assertLimited(await app.post("/api/jobs/job-2/email-quote", {}, as("token-alex")), "email-send");
  // Other routes, and other callers, are unaffected.
  assert.equal((await app.get("/api/thing", as("token-alex"))).status, 200);
  assert.equal((await app.post("/api/jobs/job-1/email-quote", {}, as("token-sam"))).status, 200);
  for (let i = 0; i < 3; i += 1) assert.equal((await app.get(`/api/jobs/job-1/quote-pdf?version=${i}`, as("token-sam"))).status, 200);
  await assertLimited(await app.get("/api/jobs/job-1/quote-pdf", as("token-sam")), "pdf-render");
});

test("sign-in counts failed attempts only, per address", async (t) => {
  const app = await buildApp(t, { rateLimits: { "sign-in": { limit: 2, windowSeconds: 900 } } });
  for (let i = 0; i < 5; i += 1) assert.equal((await app.post("/api/auth/login", { password: "right" })).status, 200);
  assert.equal((await app.post("/api/auth/login", { password: "wrong" })).status, 401);
  assert.equal((await app.post("/api/auth/login", { password: "wrong" })).status, 401);
  await assertLimited(await app.post("/api/auth/login", { password: "wrong" }), "sign-in");
  // Locked out for this window, even with the right password.
  await assertLimited(await app.post("/api/auth/login", { password: "right" }), "sign-in");
});

test("a path with a long run of slashes is classified in linear time, and trailing slashes still match", () => {
  const limits = createRateLimits(resolveRateLimitBudgets({}), { log: quiet });
  const classify = (originalUrl) => {
    let passed = false;
    limits.byAddress({ method: "POST", originalUrl, ip: "203.0.113.9" }, {}, () => { passed = true; });
    return passed;
  };
  const started = performance.now();
  assert.equal(classify(`/api/auth/login${"/".repeat(100_000)}x`), true);
  assert.ok(performance.now() - started < 200, "a long run of slashes takes linear time");
  assert.deepEqual(classesFor("POST", "/api/auth/login", "address"), ["sign-in"]);
});

test("X-Forwarded-For picks the address only when one proxy hop is trusted", async (t) => {
  const budgets = { address: { limit: 2, windowSeconds: 60 } };
  const logged = [];
  const capture = { warn: (line) => logged.push(line), error: (line) => logged.push(line), info() {} };
  const direct = await buildApp(t, { rateLimits: budgets, log: capture });
  // Trust proxy off: a client's own X-Forwarded-For changes nothing.
  assert.equal((await direct.get("/health", { "x-forwarded-for": "203.0.113.1" })).status, 200);
  assert.equal((await direct.get("/api/thing", as("token-alex", { "x-forwarded-for": "203.0.113.1" }))).status, 200);
  assert.equal((await direct.get("/api/thing", as("token-alex", { "x-forwarded-for": "203.0.113.2" }))).status, 200);
  await assertLimited(await direct.get("/api/thing", as("token-alex", { "x-forwarded-for": "203.0.113.3" })), "address");
  // express-rate-limit's check says so once, in one line naming the setting.
  const checks = logged.filter((line) => /ERR_ERL_/.test(line));
  assert.equal(checks.length, 1, logged.join("\n"));
  assert.match(checks[0], /^\[rate-limit\] ERR_ERL_UNEXPECTED_X_FORWARDED_FOR: .*FIELD_TRUST_PROXY/);
  assert.doesNotMatch(checks[0], /\n/);

  // One hop (Replit): the address the proxy appended is the key.
  const proxied = await buildApp(t, { trustProxy: 1, rateLimits: budgets });
  const from = (address) => as("token-alex", { "x-forwarded-for": address });
  assert.equal((await proxied.get("/api/thing", from("203.0.113.1"))).status, 200);
  assert.equal((await proxied.get("/api/thing", from("203.0.113.1"))).status, 200);
  await assertLimited(await proxied.get("/api/thing", from("203.0.113.1")), "address");
  assert.equal((await proxied.get("/api/thing", from("203.0.113.2"))).status, 200);
  // A client prepending its own entry does not get a fresh budget: the
  // proxy's (rightmost) entry decides.
  await assertLimited(await proxied.get("/api/thing", from("198.51.100.7, 203.0.113.1")), "address");
  // IPv6 addresses in one /56 share a budget.
  assert.equal((await proxied.get("/api/thing", from("2001:db8:0:1::1"))).status, 200);
  assert.equal((await proxied.get("/api/thing", from("2001:db8:0:2::1"))).status, 200);
  await assertLimited(await proxied.get("/api/thing", from("2001:db8:0:3::1")), "address");
});

test("routes fall into their class by method and path", () => {
  assert.deepEqual(classesFor("POST", "/api/jobs/abc/email-quote", "caller"), ["email-send"]);
  assert.deepEqual(classesFor("POST", "/api/jobs/abc/email", "caller"), ["email-send"]);
  assert.deepEqual(classesFor("POST", "/api/jobs/abc/email-drafts", "caller"), []);
  assert.deepEqual(classesFor("HEAD", "/api/jobs/abc/quote-pdf", "caller"), ["pdf-render"]);
  assert.deepEqual(classesFor("GET", "/api/jobs/abc/milestones/0/pdf", "caller"), ["pdf-render"]);
  assert.deepEqual(classesFor("GET", "/api/documents/doc_1/pdf", "caller"), [], "stored bytes are served, not rendered");
  assert.deepEqual(classesFor("POST", "/api/integrations/xero/push", "caller"), ["integration"]);
  assert.deepEqual(classesFor("POST", "/api/integrations/xero/connect", "caller"), ["oauth", "integration"]);
  assert.deepEqual(classesFor("GET", "/api/integrations/xero/callback", "address"), ["oauth"]);
  assert.deepEqual(classesFor("POST", "/oauth/approve", "address"), ["sign-in", "oauth"]);
  assert.deepEqual(classesFor("POST", "/oauth/token", "address"), ["oauth"]);
  assert.deepEqual(classesFor("POST", "/api/users/u1/tokens", "caller"), ["token"]);
  assert.deepEqual(classesFor("DELETE", "/api/users/u1/tokens/t1", "caller"), [], "revoking is never held back");
  assert.deepEqual(classesFor("GET", "/api/jobs", "caller"), []);
});

test("a bad rateLimits config is refused with the key named", () => {
  assert.deepEqual(Object.keys(resolveRateLimitBudgets(undefined)), RATE_LIMIT_CLASSES);
  const tuned = resolveRateLimitBudgets({ "pdf-render": { limit: 120 } });
  assert.equal(tuned["pdf-render"].limit, 120);
  assert.equal(tuned["pdf-render"].windowSeconds, DEFAULT_RATE_LIMITS["pdf-render"].windowSeconds);
  assert.equal(tuned.caller.limit, DEFAULT_RATE_LIMITS.caller.limit);
  for (const [raw, named] of [
    [[], /config rateLimits must be an object/],
    [{ pdf: { limit: 5 } }, /rateLimits\.pdf is not a rate limit/],
    [{ caller: 600 }, /rateLimits\.caller must be an object/],
    [{ caller: { limit: 0 } }, /rateLimits\.caller\.limit must be a whole number/],
    [{ caller: { limit: -1 } }, /rateLimits\.caller\.limit/],
    [{ caller: { limit: 1.5 } }, /rateLimits\.caller\.limit/],
    [{ caller: { limit: "600" } }, /rateLimits\.caller\.limit/],
    [{ "email-send": { windowSeconds: 0 } }, /rateLimits\.email-send\.windowSeconds/],
    [{ "email-send": { enabled: false } }, /rateLimits\.email-send\.enabled is not a rate limit setting/],
  ]) {
    assert.throws(() => resolveRateLimitBudgets(raw), named);
  }
});

// ── The real server ─────────────────────────────────────────────────────

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

async function writeConfig(t, config) {
  const dir = await mkdtemp(join(tmpdir(), "field-rate-limits-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return { dir, dataDir, configPath };
}

function startServer({ dir, dataDir, configPath }, port, extraEnv = {}) {
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
  return { child, output, exited };
}

const OWNER = { email: "owner@example.invalid", password: "rate-limit-test-password" };

test("the real server: address, caller, sign-in and pdf-render budgets answer 429, keyed through one trusted proxy hop", async (t) => {
  const files = await writeConfig(t, {
    authToken: "rate-limit-test-service-key-0001",
    bootstrapUsers: [{ email: OWNER.email, name: "Rate Owner", password: OWNER.password }],
    rateLimits: {
      address: { limit: 40, windowSeconds: 60 },
      caller: { limit: 5, windowSeconds: 60 },
      "sign-in": { limit: 3, windowSeconds: 900 },
      "pdf-render": { limit: 2, windowSeconds: 300 },
    },
  });
  const port = await freePort();
  const { child, output, exited } = startServer(files, port, { FIELD_TRUST_PROXY: "1" });
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
  // Each part of the test comes from its own address, through the one
  // trusted hop, so their address budgets stay apart.
  const from = (address, headers = {}) => ({ "x-forwarded-for": address, ...headers });
  const login = (address, password) => fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: from(address, { "content-type": "application/json" }),
    body: JSON.stringify({ email: OWNER.email, password }),
  });

  // Sign-in: failed attempts only.
  const signedIn = await login("203.0.113.10", OWNER.password);
  assert.equal(signedIn.status, 200, output.join(""));
  const { token } = await signedIn.json();
  for (let i = 0; i < 3; i += 1) assert.equal((await login("203.0.113.11", "wrong-password")).status, 401);
  await assertLimited(await login("203.0.113.11", "wrong-password"), "sign-in");
  assert.equal((await login("203.0.113.12", OWNER.password)).status, 200, "another address still signs in");

  // A forged token spends nothing of the owner's caller budget.
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: from("203.0.113.20", { authorization: "Bearer forged-token" }) })).status, 401);
  }
  const me = () => fetch(`${base}/api/auth/me`, { headers: from("203.0.113.21", { authorization: `Bearer ${token}` }) });
  for (let i = 0; i < 5; i += 1) assert.equal((await me()).status, 200);
  await assertLimited(await me(), "caller");

  // The caller budget is the person's: a second session from another
  // address shares it.
  const second = await login("203.0.113.30", OWNER.password);
  assert.equal(second.status, 200);
  await assertLimited(await fetch(`${base}/api/jobs`, { headers: from("203.0.113.30", { authorization: `Bearer ${(await second.json()).token}` }) }), "caller");

  // The address budget: 40 a minute from one address, whoever asks.
  let status = 0;
  let response;
  for (let i = 0; i < 41 && status !== 429; i += 1) {
    response = await fetch(`${base}/api/auth/config`, { headers: from("203.0.113.40") });
    status = response.status;
  }
  await assertLimited(response, "address");
  assert.equal((await fetch(`${base}/api/auth/config`, { headers: from("203.0.113.41") })).status, 200);
  assert.equal((await fetch(`${base}/health`, { headers: from("203.0.113.40") })).status, 200, "/health stays open");
});

test("the real server: pdf-render and email-send cut in at their lower budgets, per caller", async (t) => {
  const files = await writeConfig(t, {
    authToken: "rate-limit-test-service-key-0002",
    bootstrapUsers: [{ email: OWNER.email, name: "Rate Owner", password: OWNER.password }],
    rateLimits: { "pdf-render": { limit: 2, windowSeconds: 300 }, "email-send": { limit: 1, windowSeconds: 300 } },
  });
  const port = await freePort();
  const { child, output, exited } = startServer(files, port);
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
  const signedIn = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  const { token } = await signedIn.json();
  assert.ok(token, output.join(""));
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const job = "00000000-0000-4000-8000-000000000000";
  // No such job: the route still counts, as rendering would.
  for (let i = 0; i < 2; i += 1) assert.notEqual((await fetch(`${base}/api/jobs/${job}/quote-pdf`, { headers })).status, 429);
  await assertLimited(await fetch(`${base}/api/jobs/${job}/quote-pdf`, { headers }), "pdf-render");
  assert.notEqual((await fetch(`${base}/api/jobs/${job}/email-quote`, { method: "POST", headers, body: "{}" })).status, 429);
  await assertLimited(await fetch(`${base}/api/jobs/${job}/email-quote`, { method: "POST", headers, body: "{}" }), "email-send");
  assert.equal((await fetch(`${base}/api/auth/me`, { headers })).status, 200, "other routes are unaffected");
  assert.doesNotMatch(output.join(""), /ERR_ERL_|WRN_ERL_/, "express-rate-limit's checks stay quiet");
});

test("the real server refuses to start on a bad rateLimits config", async (t) => {
  const files = await writeConfig(t, { authToken: "rate-limit-test-service-key-0003", rateLimits: { "email-send": { limit: 0 } } });
  const { child, output, exited } = startServer(files, await freePort());
  // A server that accepts the config keeps running: stop it after a while.
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(code, 1, output.join(""));
  assert.match(output.join(""), /config rateLimits\.email-send\.limit must be a whole number/);
});
