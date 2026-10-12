// Clerk sign-in with Clerk mocked: no network, no real keys. The users
// table is a fresh in-process PostgreSQL (PGlite) per test; machine tokens use
// the real users.js store in a temporary data directory.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { eq } from "drizzle-orm";
import { createTestDb, schema } from "../db-runtime/index.js";
import * as users from "../users.js";
import {
  BREAK_GLASS_HEADER,
  createClerkAuth,
  createClerkAuthRouter,
  googleWorkspaceOwner,
  parseOwnerMfaMaxAge,
  primaryEmailOf,
  resolveAuthorizedParties,
  resolveClerkKeys,
  resolveFieldAuthMode,
  resolveOwnerVerificationConfig,
  secondFactorVerified,
} from "./clerk-auth.js";
import { resolveTrustProxy } from "./trust-proxy.js";
import { findFieldUserByEmail, importLegacyUsers, listFieldUsers } from "./field-users-store.js";
import { createRemoteMcpRouter, MCP_SCOPES } from "../mcp/remote-mcp.js";
import { authorizeFieldMcpScopes } from "../mcp/scope-authority.js";

const BREAK_GLASS_KEY = "break-glass-fixture-key";

// ── Fake Clerk ───────────────────────────────────────────────────
// A session "token" here is sess:<base64url JSON {userId, fva}>, sent as a
// Bearer header (fetch from the SPA) or the __session cookie (browser forms).
// `mfa`: true (second factor 2 minutes ago), false (none) or an age in minutes.
function sessionToken(userId, { mfa = false } = {}) {
  const secondFactorAge = mfa === true ? 2 : mfa === false ? -1 : mfa;
  return `sess:${Buffer.from(JSON.stringify({ userId, fva: [2, secondFactorAge] })).toString("base64url")}`;
}

// `google`: give the Clerk user a Google external account (Clerk's backend
// shape) for `googleEmail` (default: the primary email); `passwordEnabled`
// mirrors Clerk's flag (a Google-only sign-up has none).
function clerkUser(id, email, {
  verified = true,
  firstName = "Pat",
  lastName = "Example",
  google = false,
  googleEmail = email,
  googleVerified = true,
  googleProvider = "oauth_google",
  passwordEnabled = !google,
} = {}) {
  return {
    id,
    firstName,
    lastName,
    passwordEnabled,
    primaryEmailAddressId: `idn_${id}`,
    emailAddresses: [
      { id: `idn_other_${id}`, emailAddress: `other-${email}`, verification: { status: "verified" } },
      { id: `idn_${id}`, emailAddress: email, verification: { status: verified ? "verified" : "unverified" } },
    ],
    externalAccounts: google
      ? [{ id: `eac_${id}`, provider: googleProvider, emailAddress: googleEmail, verification: { status: googleVerified ? "verified" : "unverified" } }]
      : [],
  };
}

function fakeClerk(directory) {
  const calls = { getUser: [] };
  return {
    calls,
    middleware(req, _res, next) {
      const header = req.headers.authorization || "";
      const cookie = /(?:^|;\s*)__session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
      const raw = header.startsWith("Bearer ") ? header.slice(7) : cookie;
      req.fakeClerkSession = raw?.startsWith("sess:")
        ? JSON.parse(Buffer.from(raw.slice(5), "base64url").toString("utf8"))
        : null;
      next();
    },
    getAuth(req) {
      const session = req.fakeClerkSession;
      return session
        ? { userId: session.userId, factorVerificationAge: session.fva }
        : { userId: null, factorVerificationAge: null };
    },
    async getUser(userId) {
      calls.getUser.push(userId);
      if (directory.failing) throw new Error("Clerk API unavailable (test)");
      const user = directory.get(userId);
      if (!user) throw new Error(`Clerk user ${userId} not found`);
      return user;
    },
  };
}

function captureLog() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

// ── Fixture ──────────────────────────────────────────────────────
let dataDir;
let legacyOwner;
let legacyStaff;
let serviceAccount;
let ownerToken;
let staffToken;
let serviceToken;

// A fresh users.json per test (tests remove people and revoke tokens).
beforeEach(async (t) => {
  dataDir = await mkdtemp(join(tmpdir(), "field-clerk-auth-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await users.initUsers(dataDir);
  // Today's users.json: an admin, a plain user and a service account, each
  // with a token minted before the cutover.
  legacyOwner = await users.ensureUser({ email: "Owner@Example.com", name: "Olive Owner", password: "pw-owner", role: "admin" });
  legacyStaff = await users.ensureUser({ email: "staff@example.com", name: "Sam Staff", password: "pw-staff", role: "user" });
  serviceAccount = await users.createUser({ email: "agent-cli@example.com", name: "Agent CLI", kind: "service", role: "admin" });
  ownerToken = (await users.addToken(legacyOwner.id, "cli")).token;
  staffToken = (await users.addToken(legacyStaff.id, "session")).token;
  serviceToken = (await users.addToken(serviceAccount.id, "cli")).token;
});

let ctx;

// Builds the app under test. Tests that need other owner-verification options
// call it again; the first beforeEach call uses the defaults.
async function setup(t, authOptions = {}) {
  const testDb = authOptions.reuseDb ? null : await createTestDb();
  const db = testDb ? testDb.db : ctx.db;
  const directory = authOptions.reuseDb ? ctx.directory : new Map();
  const clerk = fakeClerk(directory);
  const log = captureLog();
  let clock = authOptions.now ?? Date.now;
  const auth = createClerkAuth({
    db,
    clerk,
    legacy: { findUserByToken: users.findUserByToken, findUserById: users.findUserById },
    breakGlassKey: BREAK_GLASS_KEY,
    log,
    ownerGoogleDomains: authOptions.ownerGoogleDomains ?? [],
    ...(authOptions.ownerMfaMaxAgeMinutes ? { ownerMfaMaxAgeMinutes: authOptions.ownerMfaMaxAgeMinutes } : {}),
    now: () => clock(),
  });
  await auth.importLegacyUsers(users.listUsers());
  const revokedSubjects = [];

  const app = express();
  app.use(express.json());
  app.use(createClerkAuthRouter({
    auth,
    db,
    users: {
      listUsers: users.listUsers,
      createUser: users.createUser,
      deleteUser: users.deleteUser,
      findUserById: users.findUserById,
      findUserByEmail: users.findUserByEmail,
      findUserByToken: users.findUserByToken,
      ensureUser: users.ensureUser,
      addToken: users.addToken,
      revokeToken: users.revokeToken,
      revokeAllTokens: users.revokeAllTokens,
      revokeTokenByPlaintext: users.revokeTokenByPlaintext,
      listUserTokens: users.listUserTokens,
    },
    revokeMcpAccess: (subjects) => ctx.revokeMcp(subjects),
    log,
  }));
  // Stand-ins for the product API and an owner-only action.
  app.get("/api/jobs", auth.requireAuth, (req, res) => res.json({ ok: true, caller: req.caller }));
  app.post("/api/owner-only", auth.requireAuth, auth.requireOwner, (req, res) => res.json({ ok: true, via: req.caller.via }));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  ctx = {
    db,
    directory,
    clerk,
    log,
    auth,
    base,
    revokedSubjects,
    revokeMcp: async (subjects) => { revokedSubjects.push(...subjects); return 0; },
    setClock: (next) => { clock = next; },
  };
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (testDb) await testDb.close();
  });
}

beforeEach(async (t) => {
  await setup(t);
});

async function call(method, path, { session, token, headers = {}, body } = {}) {
  const response = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: json, text };
}

// The person with their membership of the default organisation (role, status).
async function fieldRow(email) {
  return findFieldUserByEmail(ctx.db, email);
}

// Sign the imported owner in once (links them) and return an MFA session.
async function signInOwner({ mfa = true } = {}) {
  ctx.directory.set("user_owner", clerkUser("user_owner", "owner@example.com"));
  return sessionToken("user_owner", { mfa });
}

// ── Configuration ────────────────────────────────────────────────
test("FIELD_AUTH unset keeps password sign-in; clerk switches; anything else stops boot", () => {
  assert.equal(resolveFieldAuthMode({}), "password");
  assert.equal(resolveFieldAuthMode({ FIELD_AUTH: "" }), "password");
  assert.equal(resolveFieldAuthMode({ FIELD_AUTH: " Clerk " }), "clerk");
  assert.throws(() => resolveFieldAuthMode({ FIELD_AUTH: "clerck" }), /FIELD_AUTH must be "clerk" or unset/);
});

test("Clerk keys come from the environment and errors never echo them", () => {
  // Assembled at runtime so secret scanners do not mistake the fixture for a key.
  const secret = ["sk", "test", "abcdefSECRETVALUE"].join("_");
  const publishable = "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA";
  assert.deepEqual(resolveClerkKeys({ CLERK_SECRET_KEY: secret, CLERK_PUBLISHABLE_KEY: publishable }), {
    secretKey: secret,
    publishableKey: publishable,
    publishableSource: "CLERK_PUBLISHABLE_KEY",
    proxyUrl: null,
  });
  assert.equal(resolveClerkKeys({ CLERK_SECRET_KEY: secret, VITE_CLERK_PUBLISHABLE_KEY: publishable }).publishableSource, "VITE_CLERK_PUBLISHABLE_KEY");
  assert.throws(() => resolveClerkKeys({}), /CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY/);
  for (const env of [
    { CLERK_SECRET_KEY: "not-a-key-SECRETVALUE", CLERK_PUBLISHABLE_KEY: publishable },
    { CLERK_SECRET_KEY: secret, CLERK_PUBLISHABLE_KEY: "nope-SECRETVALUE" },
  ]) {
    assert.throws(() => resolveClerkKeys(env), (error) => {
      assert.doesNotMatch(error.message, /SECRETVALUE/);
      return true;
    });
  }
});

test("primary email and second-factor helpers read Clerk's shapes", () => {
  assert.deepEqual(primaryEmailOf(clerkUser("u", "A@Example.com")), { email: "a@example.com", verified: true });
  assert.deepEqual(primaryEmailOf(clerkUser("u", "a@example.com", { verified: false })), { email: "a@example.com", verified: false });
  assert.deepEqual(primaryEmailOf({ emailAddresses: [] }), { email: null, verified: false });
  assert.equal(secondFactorVerified({ factorVerificationAge: [3, 3] }), true);
  assert.equal(secondFactorVerified({ factorVerificationAge: [3, -1] }), false);
  assert.equal(secondFactorVerified({ sessionClaims: { fva: [3, 0] } }), true);
  assert.equal(secondFactorVerified({ factorVerificationAge: null }), false);
  // A second factor counts for 12 hours by default, then needs redoing.
  assert.equal(secondFactorVerified({ factorVerificationAge: [800, 720] }), true);
  assert.equal(secondFactorVerified({ factorVerificationAge: [800, 721] }), false);
  assert.equal(secondFactorVerified({ factorVerificationAge: [10, 10] }, 5), false);
  assert.equal(secondFactorVerified({ factorVerificationAge: [3, "3"] }), false);
});

test("owner verification settings: FIELD_OWNER_MFA_MAX_AGE and FIELD_OWNER_GOOGLE_DOMAINS", () => {
  assert.deepEqual(resolveOwnerVerificationConfig({}), { ownerMfaMaxAgeMinutes: 720, ownerGoogleDomains: [] });
  assert.equal(parseOwnerMfaMaxAge("90"), 90);
  assert.equal(parseOwnerMfaMaxAge("90m"), 90);
  assert.equal(parseOwnerMfaMaxAge(" 2h "), 120);
  for (const bad of ["0", "-5", "12d", "abc", "1.5h"]) {
    assert.throws(() => parseOwnerMfaMaxAge(bad), /FIELD_OWNER_MFA_MAX_AGE/);
  }
  assert.deepEqual(
    resolveOwnerVerificationConfig({ FIELD_OWNER_GOOGLE_DOMAINS: " Business.Example, example.com,business.example " }).ownerGoogleDomains,
    ["business.example", "example.com"],
  );
  for (const bad of ["@business.example", "localhost", "*.example.com", "exämple.com"]) {
    assert.throws(() => resolveOwnerVerificationConfig({ FIELD_OWNER_GOOGLE_DOMAINS: bad }), /FIELD_OWNER_GOOGLE_DOMAINS/);
  }
});

test("Google Workspace owner check: verified Google account, matching email, allowed domain, no password", () => {
  const domains = ["example.com"];
  const ok = clerkUser("u", "owner@example.com", { google: true });
  assert.equal(googleWorkspaceOwner(ok, "Owner@Example.com", domains), true);
  assert.equal(googleWorkspaceOwner(clerkUser("u", "owner@example.com", { google: true, googleProvider: "google" }), "owner@example.com", domains), true);
  // Each condition on its own is required.
  assert.equal(googleWorkspaceOwner(ok, "owner@example.com", []), false, "no domains configured: path off");
  assert.equal(googleWorkspaceOwner(ok, "owner@other.example", ["other.example"]), false, "Google email must be the Field email");
  assert.equal(googleWorkspaceOwner(clerkUser("u", "owner@example.com", { google: true }), "owner@example.com", ["example.org"]), false, "domain not allowed");
  assert.equal(googleWorkspaceOwner(clerkUser("u", "owner@example.com", { google: true, passwordEnabled: true }), "owner@example.com", domains), false, "password set");
  assert.equal(googleWorkspaceOwner({ ...ok, passwordEnabled: undefined }), false, "unknown password state");
  assert.equal(googleWorkspaceOwner(clerkUser("u", "owner@example.com", { google: true, googleVerified: false }), "owner@example.com", domains), false, "unverified Google account");
  assert.equal(googleWorkspaceOwner(clerkUser("u", "owner@example.com", { google: true, googleProvider: "oauth_github" }), "owner@example.com", domains), false, "not Google");
  assert.equal(googleWorkspaceOwner(clerkUser("u", "owner@example.com", { google: true, googleEmail: "owner@sub.example.com" }), "owner@example.com", domains), false);
  assert.equal(googleWorkspaceOwner(clerkUser("u", "owner@sub.example.com", { google: true }), "owner@sub.example.com", domains), false, "subdomains are not the domain");
  assert.equal(googleWorkspaceOwner(null, "owner@example.com", domains), false);
});

test("Clerk authorized parties come from the configured public origin", () => {
  assert.deepEqual(resolveAuthorizedParties({ env: {}, config: {} }), []);
  assert.deepEqual(resolveAuthorizedParties({ env: { FIELD_PUBLIC_ORIGIN: "https://field.example.com/" }, config: {} }), ["https://field.example.com"]);
  assert.deepEqual(
    resolveAuthorizedParties({ env: { FIELD_PUBLIC_ORIGIN: "https://field.example.com" }, config: { publicUrl: "https://quotes.example.com/app" } }),
    ["https://field.example.com", "https://quotes.example.com"],
  );
  assert.throws(() => resolveAuthorizedParties({ env: { FIELD_PUBLIC_ORIGIN: "field.example.com" } }), /absolute URL/);
  assert.throws(() => resolveAuthorizedParties({ env: { FIELD_PUBLIC_ORIGIN: "ftp://field.example.com" } }), /http\(s\)/);
});

test("trust proxy: one hop on Replit, off elsewhere, never `true`", () => {
  assert.deepEqual(resolveTrustProxy({}), { value: false, source: "default" });
  assert.deepEqual(resolveTrustProxy({ REPL_ID: "abc" }), { value: 1, source: "Replit default" });
  assert.deepEqual(resolveTrustProxy({ REPLIT_DEPLOYMENT: "1" }), { value: 1, source: "Replit default" });
  assert.deepEqual(resolveTrustProxy({ REPL_ID: "abc", FIELD_TRUST_PROXY: "2" }), { value: 2, source: "FIELD_TRUST_PROXY" });
  assert.deepEqual(resolveTrustProxy({ REPL_ID: "abc", FIELD_TRUST_PROXY: "0" }), { value: false, source: "FIELD_TRUST_PROXY" });
  assert.deepEqual(resolveTrustProxy({ FIELD_TRUST_PROXY: "loopback, 10.0.0.0/8" }), { value: "loopback, 10.0.0.0/8", source: "FIELD_TRUST_PROXY" });
  assert.throws(() => resolveTrustProxy({ FIELD_TRUST_PROXY: "true" }), /hop count/);
  assert.throws(() => resolveTrustProxy({ FIELD_TRUST_PROXY: "everyone" }), /FIELD_TRUST_PROXY/);
  assert.throws(() => resolveTrustProxy({ FIELD_TRUST_PROXY: "99" }), /between 0 and 10/);
});

test("break-glass rate limiting is per client behind one trusted proxy hop", async (t) => {
  const app = express();
  app.set("trust proxy", resolveTrustProxy({ REPL_ID: "x" }).value);
  app.get("/api/owner-only", ctx.auth.requireAuth, ctx.auth.requireOwner, (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const attempt = (forwardedFor) => fetch(`${base}/api/owner-only`, {
    headers: { [BREAK_GLASS_HEADER]: "wrong", "x-forwarded-for": forwardedFor },
  }).then((response) => response.status);
  // The proxy appends the real client: a spoofed left-hand entry changes nothing.
  const statuses = [];
  for (let i = 0; i < 7; i += 1) statuses.push(await attempt(`198.51.100.${i}, 203.0.113.7`));
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429);
  // A different client is not locked out by the first one.
  assert.equal(await attempt("203.0.113.8"), 401);
  assert.ok(ctx.log.lines.some((line) => /BREAK-GLASS refused \(wrong key\): GET \/api\/owner-only from 203\.0\.113\.7/.test(line)));
});

// ── Import ───────────────────────────────────────────────────────
test("users.json people are imported once, keeping their ids; admin becomes owner", async () => {
  const rows = await listFieldUsers(ctx.db);
  const byEmail = Object.fromEntries(rows.map((row) => [row.email, row]));
  assert.deepEqual(Object.keys(byEmail).sort(), ["owner@example.com", "staff@example.com"]);
  assert.equal(byEmail["owner@example.com"].id, legacyOwner.id);
  assert.equal(byEmail["owner@example.com"].role, "owner");
  assert.equal(byEmail["staff@example.com"].role, "staff");
  assert.ok(rows.every((row) => row.status === "active" && row.clerkUserId === null));
  // Service accounts are machine identities, not people.
  assert.equal(byEmail["agent-cli@example.com"], undefined);
  // Once the table has anyone in it, a restart never re-imports (an owner's removals stick).
  assert.deepEqual(await importLegacyUsers(ctx.db, users.listUsers()), { imported: 0, skipped: "users table already populated" });
});

// ── Linking ──────────────────────────────────────────────────────
test("first sign-in links the Clerk user to the Field user with the same verified email", async () => {
  const session = await signInOwner();
  const me = await call("GET", "/api/auth/me", { session });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, legacyOwner.id);
  assert.equal(me.body.user.fieldRole, "owner");
  assert.equal(me.body.user.role, "admin");
  assert.equal(me.body.user.via, "clerk");
  assert.equal((await fieldRow("owner@example.com")).clerkUserId, "user_owner");

  // Later requests resolve by Clerk id without asking Clerk again.
  const jobs = await call("GET", "/api/jobs", { session });
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.caller.id, legacyOwner.id);
  assert.deepEqual(ctx.clerk.calls.getUser, ["user_owner"]);
});

test("an unverified primary email is refused and links nothing", async () => {
  ctx.directory.set("user_sneaky", clerkUser("user_sneaky", "owner@example.com", { verified: false }));
  const session = sessionToken("user_sneaky", { mfa: true });
  for (const path of ["/api/jobs", "/api/auth/me"]) {
    const response = await call("GET", path, { session });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "email_unverified");
  }
  assert.equal((await fieldRow("owner@example.com")).clerkUserId, null);
  assert.equal((await ctx.db.select().from(schema.fieldUsers)).length, 2);
});

test("a second Clerk account with an already-linked email gets nothing", async () => {
  const owner = await signInOwner();
  assert.equal((await call("GET", "/api/jobs", { session: owner })).status, 200);
  ctx.directory.set("user_dupe", clerkUser("user_dupe", "owner@example.com"));
  const response = await call("GET", "/api/jobs", { session: sessionToken("user_dupe", { mfa: true }) });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "email_linked_elsewhere");
});

test("a session cookie alone authorizes reads, never changes (no cross-site request forgery)", async () => {
  const owner = await signInOwner();
  const cookie = { cookie: `__session=${owner}` };
  assert.equal((await call("GET", "/api/jobs", { headers: cookie })).status, 200);
  assert.equal((await call("POST", "/api/owner-only", { headers: cookie })).status, 401);
  assert.equal((await call("POST", "/api/owner-only", { session: owner })).status, 200);
});

test("signed out is 401; a non-Field ?token= is never a session", async () => {
  assert.equal((await call("GET", "/api/jobs")).status, 401);
  assert.equal((await call("GET", "/api/jobs?token=sess:whatever")).status, 401);
  // A real session token in ?token= is still not a session.
  const owner = await signInOwner();
  assert.equal((await call("GET", `/api/jobs?token=${encodeURIComponent(owner)}`)).status, 401);
  assert.equal((await call("GET", "/api/jobs", { token: "field_not-a-real-token" })).status, 401);
});

test("a stale ?token= on a PDF/preview link falls back to the session cookie for reads only", async () => {
  const owner = await signInOwner();
  const cookie = { cookie: `__session=${owner}` };
  const stale = "field_stale-password-era-token";
  const read = await call("GET", `/api/jobs?token=${stale}`, { headers: cookie });
  assert.equal(read.status, 200);
  assert.equal(read.body.caller.via, "clerk");
  assert.equal(read.body.caller.id, legacyOwner.id);
  // No session: still refused.
  assert.equal((await call("GET", `/api/jobs?token=${stale}`)).status, 401);
  // Never for changes, cookie or not.
  assert.equal((await call("POST", `/api/owner-only?token=${stale}`, { headers: cookie })).status, 401);
  // A recognised token for someone without access is refused, not laundered through the cookie.
  ctx.directory.set("user_staff", clerkUser("user_staff", "staff@example.com"));
  const owner2 = sessionToken("user_owner", { mfa: true });
  await call("PATCH", `/api/users/${legacyStaff.id}`, { session: owner2, body: { status: "pending" } });
  const pending = await call("GET", `/api/jobs?token=${encodeURIComponent(staffToken)}`, { headers: cookie });
  assert.equal(pending.status, 403);
  assert.equal(pending.body.code, "field_access_pending");
});

// ── Pending users and approval ───────────────────────────────────
test("an unknown Clerk user is pending with no access until an owner approves them", async () => {
  ctx.directory.set("user_new", clerkUser("user_new", "New.Person@Example.com", { firstName: "New", lastName: "Person" }));
  const newcomer = sessionToken("user_new");

  const blocked = await call("GET", "/api/jobs", { session: newcomer });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "field_access_pending");
  const me = await call("GET", "/api/auth/me", { session: newcomer });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.status, "pending");
  assert.equal(me.body.user.name, "New Person");
  const row = await fieldRow("new.person@example.com");
  assert.equal(row.status, "pending");
  assert.equal(row.clerkUserId, "user_new");

  // The owner sees them first in the list and approves them.
  const owner = await signInOwner();
  const list = await call("GET", "/api/users", { session: owner });
  assert.equal(list.status, 200);
  assert.equal(list.body.users[0].email, "new.person@example.com");
  assert.equal(list.body.users[0].status, "pending");
  assert.deepEqual(list.body.serviceAccounts.map((user) => user.email), ["agent-cli@example.com"]);

  const approved = await call("POST", `/api/users/${row.id}/approve`, { session: owner, body: { role: "staff" } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.user.status, "active");
  const allowed = await call("GET", "/api/jobs", { session: newcomer });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.caller.fieldRole, "staff");

  // Disabling cuts them off again.
  const disabled = await call("PATCH", `/api/users/${row.id}`, { session: owner, body: { status: "disabled" } });
  assert.equal(disabled.status, 200);
  const off = await call("GET", "/api/jobs", { session: newcomer });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, "field_access_disabled");
});

test("an owner can add someone ahead of time; they link on first verified sign-in", async () => {
  const owner = await signInOwner();
  const added = await call("POST", "/api/users", { session: owner, body: { email: "Crew@Example.com", name: "Crew", role: "staff" } });
  assert.equal(added.status, 201);
  assert.equal(added.body.user.status, "active");
  assert.equal(added.body.user.linked, false);
  ctx.directory.set("user_crew", clerkUser("user_crew", "crew@example.com"));
  const jobs = await call("GET", "/api/jobs", { session: sessionToken("user_crew") });
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.caller.id, added.body.user.id);
  assert.equal((await call("POST", "/api/users", { session: owner, body: { email: "crew@example.com" } })).status, 409);
});

// ── The first owner of a fresh installation ──────────────────────
// There is no implicit bootstrap user: a new Clerk installation gets its first
// owner from config bootstrapUsers (imported once, as owner), or, with nobody
// configured, through break-glass approval of the first person who signs in.
async function freshInstallation(t, config) {
  const fresh = await mkdtemp(join(tmpdir(), "field-clerk-fresh-"));
  t.after(() => rm(fresh, { recursive: true, force: true }));
  await users.initUsers(fresh);
  for (const user of users.resolveBootstrapUsers({ config, authToken: "fixture-auth-token" })) await users.ensureUser(user);
  await setup(t);
}

test("a fresh installation's first owner comes from bootstrapUsers in config", async (t) => {
  await freshInstallation(t, { bootstrapUsers: [{ email: "First.Owner@Example.com", name: "First Owner", role: "admin" }] });
  const row = await fieldRow("first.owner@example.com");
  assert.equal(row.role, "owner");
  assert.equal(row.status, "active");
  ctx.directory.set("user_first", clerkUser("user_first", "first.owner@example.com"));
  const jobs = await call("GET", "/api/jobs", { session: sessionToken("user_first") });
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.caller.fieldRole, "owner");
});

test("with nobody configured, nobody gets in until break-glass approves the first owner", async (t) => {
  await freshInstallation(t, {});
  assert.deepEqual(await listFieldUsers(ctx.db), [], "no placeholder account is created");
  ctx.directory.set("user_first", clerkUser("user_first", "first.owner@example.com"));
  const session = sessionToken("user_first");
  const blocked = await call("GET", "/api/jobs", { session });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "field_access_pending");
  const row = await fieldRow("first.owner@example.com");
  const approved = await call("POST", `/api/users/${row.id}/approve`, { headers: { [BREAK_GLASS_HEADER]: BREAK_GLASS_KEY }, body: { role: "owner" } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.user.role, "owner");
  const jobs = await call("GET", "/api/jobs", { session });
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.caller.fieldRole, "owner");
});

// ── Owner MFA gate ───────────────────────────────────────────────
test("owner-only actions need the owner's session to have passed a second factor", async () => {
  const withoutMfa = await signInOwner({ mfa: false });
  // Everyday work does not need MFA.
  assert.equal((await call("GET", "/api/jobs", { session: withoutMfa })).status, 200);
  for (const [method, path] of [["GET", "/api/users"], ["POST", "/api/owner-only"], ["POST", `/api/users/${legacyStaff.id}/tokens`]]) {
    const response = await call(method, path, { session: withoutMfa });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.body.code, "owner_mfa_required");
    assert.match(response.body.error, /two-step verification/);
  }
  const withMfa = sessionToken("user_owner", { mfa: true });
  assert.equal((await call("GET", "/api/users", { session: withMfa })).status, 200);
  assert.equal((await call("POST", "/api/owner-only", { session: withMfa })).status, 200);
  // A second factor older than FIELD_OWNER_MFA_MAX_AGE (12h by default) no longer counts.
  const stale = await call("POST", "/api/owner-only", { session: sessionToken("user_owner", { mfa: 721 }) });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, "owner_mfa_required");
  assert.equal((await call("POST", "/api/owner-only", { session: sessionToken("user_owner", { mfa: 720 }) })).status, 200);
});

test("owner path (b): Google Workspace sign-in on an allowed domain with no password, checked with Clerk", async (t) => {
  await setup(t, { ownerGoogleDomains: ["example.com"] });
  ctx.directory.set("user_owner", clerkUser("user_owner", "owner@example.com", { google: true }));
  const session = sessionToken("user_owner", { mfa: false });
  const ok = await call("POST", "/api/owner-only", { session });
  assert.equal(ok.status, 200);
  const me = await call("GET", "/api/auth/me", { session });
  assert.equal(me.body.user.mfaVerified, true);
  assert.equal(me.body.user.ownerVerifiedBy, "google_workspace");
  // The Clerk user is fetched once and briefly cached, not on every request.
  const before = ctx.clerk.calls.getUser.length;
  assert.equal((await call("GET", "/api/users", { session })).status, 200);
  assert.equal(ctx.clerk.calls.getUser.length, before);

  // Everyday (non-owner) requests never ask Clerk.
  assert.equal((await call("GET", "/api/jobs", { session })).status, 200);
  assert.equal(ctx.clerk.calls.getUser.length, before);
});

test("owner path (b) is refused when any condition fails, with a message naming both ways in", async (t) => {
  let now = 1_000_000;
  await setup(t, { ownerGoogleDomains: ["example.com"], now: () => now });
  const session = sessionToken("user_owner", { mfa: false });
  const cases = [
    ["password set", { google: true, passwordEnabled: true }],
    ["unverified Google account", { google: true, googleVerified: false }],
    ["Google email differs", { google: true, googleEmail: "someone-else@example.com" }],
    ["no Google account", { google: false, passwordEnabled: false }],
  ];
  for (const [label, options] of cases) {
    now += 120_000; // past the Clerk user cache
    ctx.directory.set("user_owner", clerkUser("user_owner", "owner@example.com", options));
    const response = await call("POST", "/api/owner-only", { session });
    assert.equal(response.status, 403, label);
    assert.equal(response.body.code, "owner_mfa_required", label);
    assert.match(response.body.error, /Google using your work account \(@example\.com\)/, label);
    assert.match(response.body.error, /two-step verification \(it counts for 12 hours\)/, label);
  }
  const me = await call("GET", "/api/auth/me", { session });
  assert.equal(me.body.user.mfaVerified, false);
  assert.match(me.body.user.ownerVerificationHelp, /Google/);
});

test("owner path (b) fails closed when Clerk cannot be asked, and is off without FIELD_OWNER_GOOGLE_DOMAINS", async (t) => {
  await setup(t, { ownerGoogleDomains: ["example.com"] });
  ctx.directory.set("user_owner", clerkUser("user_owner", "owner@example.com", { google: true }));
  const session = sessionToken("user_owner", { mfa: false });
  // Link first (needs Clerk), then make Clerk unavailable.
  assert.equal((await call("GET", "/api/jobs", { session })).status, 200);
  ctx.directory.failing = true;
  const down = await call("POST", "/api/owner-only", { session });
  assert.equal(down.status, 503);
  assert.equal(down.body.code, "owner_check_unavailable");
  // A second factor still works without asking Clerk.
  assert.equal((await call("POST", "/api/owner-only", { session: sessionToken("user_owner", { mfa: true }) })).status, 200);
  ctx.directory.failing = false;

  // Same Google-only owner, but no domains configured: path (b) is off.
  await setup(t, { reuseDb: true });
  const off = await call("POST", "/api/owner-only", { session });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, "owner_mfa_required");
  assert.doesNotMatch(off.body.error, /Google/);
  assert.match(off.body.error, /two-step verification/);
});

test("staff cannot do owner actions even with MFA", async () => {
  ctx.directory.set("user_staff", clerkUser("user_staff", "staff@example.com"));
  const staff = sessionToken("user_staff", { mfa: true });
  assert.equal((await call("GET", "/api/jobs", { session: staff })).status, 200);
  const response = await call("GET", "/api/users", { session: staff });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "owner_required");
});

test("owners cannot change their own role or remove the last owner", async () => {
  const owner = await signInOwner();
  const self = await call("PATCH", `/api/users/${legacyOwner.id}`, { session: owner, body: { role: "staff" } });
  assert.equal(self.status, 400);
  assert.equal(self.body.code, "self_change");
  assert.equal((await call("DELETE", `/api/users/${legacyOwner.id}`, { session: owner })).status, 400);
  // A break-glass caller is not that owner, but Field still keeps one active owner.
  const viaBreakGlass = await call("PATCH", `/api/users/${legacyOwner.id}`, {
    headers: { [BREAK_GLASS_HEADER]: BREAK_GLASS_KEY },
    body: { status: "disabled" },
  });
  assert.equal(viaBreakGlass.status, 409);
  assert.equal(viaBreakGlass.body.code, "last_owner");
});

// ── Machine access ───────────────────────────────────────────────
test("existing Field bearer tokens keep working, with the role from PostgreSQL", async () => {
  const asOwner = await call("GET", "/api/jobs", { token: ownerToken });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.body.caller.id, legacyOwner.id);
  assert.equal(asOwner.body.caller.fieldRole, "owner");
  assert.equal(asOwner.body.caller.via, "token");
  const asService = await call("GET", "/api/jobs", { token: serviceToken });
  assert.equal(asService.status, 200);
  assert.equal(asService.body.caller.kind, "service");
  // ?token= (PDF links, previews) still works for Field tokens.
  assert.equal((await call("GET", `/api/jobs?token=${encodeURIComponent(staffToken)}`)).status, 200);
  assert.equal((await call("GET", "/api/auth/me", { token: ownerToken })).body.user.id, legacyOwner.id);
  // Bearer tokens never touch Clerk.
  assert.deepEqual(ctx.clerk.calls.getUser, []);
});

test("machine tokens cannot do owner actions, issue tokens or approve people", async () => {
  for (const token of [ownerToken, serviceToken]) {
    for (const [method, path] of [["GET", "/api/users"], ["POST", `/api/users/${legacyOwner.id}/tokens`], ["POST", "/api/owner-only"]]) {
      const response = await call(method, path, { token });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.ok(["owner_session_required", "owner_required"].includes(response.body.code));
    }
  }
});

test("a disabled or removed person's old tokens stop working, and are revoked", async () => {
  const owner = await signInOwner();
  assert.equal((await call("PATCH", `/api/users/${legacyStaff.id}`, { session: owner, body: { status: "disabled" } })).status, 200);
  assert.equal((await call("GET", "/api/jobs", { token: staffToken })).status, 401);
  assert.deepEqual(users.listUserTokens(legacyStaff.id), []);
  assert.deepEqual(ctx.revokedSubjects, [legacyStaff.id]);
  // Re-enabling does not bring revoked tokens back.
  assert.equal((await call("PATCH", `/api/users/${legacyStaff.id}`, { session: owner, body: { status: "active" } })).status, 200);
  assert.equal((await call("GET", "/api/jobs", { token: staffToken })).status, 401);

  const fresh = await call("POST", `/api/users/${legacyStaff.id}/tokens`, { session: owner, body: { label: "again" } });
  assert.equal(fresh.status, 201);
  assert.equal((await call("DELETE", `/api/users/${legacyStaff.id}`, { session: owner })).status, 200);
  assert.equal((await call("GET", "/api/jobs", { token: fresh.body.token })).status, 401);
  // Their users.json record (tokens, any old password hash) is gone too.
  assert.equal(users.findUserById(legacyStaff.id), null);
  assert.equal(users.findUserByEmail("staff@example.com"), null);
  assert.deepEqual(ctx.revokedSubjects, [legacyStaff.id, legacyStaff.id]);
  assert.ok(ctx.log.lines.some((line) => /cut off machine access for Field user .*users\.json record removed/.test(line)));
});

test("a removed person's tokens never come back for a new row with the same email", async () => {
  const owner = await signInOwner();
  // A person added in Clerk mode, with a token.
  const added = await call("POST", "/api/users", { session: owner, body: { email: "crew@example.com", role: "staff" } });
  const crewId = added.body.user.id;
  const crewToken = (await call("POST", `/api/users/${crewId}/tokens`, { session: owner, body: { label: "cli" } })).body.token;
  assert.equal((await call("GET", "/api/jobs", { token: crewToken })).status, 200);
  assert.equal(users.findUserById(crewId)?.email, "crew@example.com", "tokens are held under the person's PostgreSQL id");

  // Removed, then added again with the same email (a new row).
  assert.equal((await call("DELETE", `/api/users/${crewId}`, { session: owner })).status, 200);
  const readded = await call("POST", "/api/users", { session: owner, body: { email: "crew@example.com", role: "owner" } });
  assert.equal(readded.status, 201);
  assert.notEqual(readded.body.user.id, crewId);
  assert.ok([401, 403].includes((await call("GET", "/api/jobs", { token: crewToken })).status));
  // The new row starts with no tokens, and new ones work.
  assert.deepEqual((await call("GET", `/api/users/${readded.body.user.id}/tokens`, { session: owner })).body.tokens, []);
  const newToken = (await call("POST", `/api/users/${readded.body.user.id}/tokens`, { session: owner })).body.token;
  assert.equal((await call("GET", "/api/jobs", { token: newToken })).body.caller.id, readded.body.user.id);
  assert.equal((await call("GET", "/api/jobs", { token: crewToken })).status, 401);
});

test("removed, then back through sign-in and approval: the old token stays dead", async () => {
  const owner = await signInOwner();
  // Imported staff member with a pre-cutover token.
  assert.equal((await call("GET", "/api/jobs", { token: staffToken })).status, 200);
  assert.equal((await call("DELETE", `/api/users/${legacyStaff.id}`, { session: owner })).status, 200);

  // They sign in with Clerk: a new pending row, which the owner approves.
  ctx.directory.set("user_staff_again", clerkUser("user_staff_again", "staff@example.com"));
  const session = sessionToken("user_staff_again");
  assert.equal((await call("GET", "/api/jobs", { session })).body.code, "field_access_pending");
  const row = await fieldRow("staff@example.com");
  assert.notEqual(row.id, legacyStaff.id);
  assert.equal((await call("POST", `/api/users/${row.id}/approve`, { session: owner, body: { role: "staff" } })).status, 200);
  assert.equal((await call("GET", "/api/jobs", { session })).status, 200);
  assert.ok([401, 403].includes((await call("GET", "/api/jobs", { token: staffToken })).status));
});

test("a stale users.json record from before this fix still cannot lend its tokens to a new row", async () => {
  const owner = await signInOwner();
  // Simulate an older version: the PostgreSQL row is gone but the users.json
  // record with its token was left behind.
  await ctx.db.delete(schema.orgMemberships).where(eq(schema.orgMemberships.userUid, legacyStaff.id));
  await ctx.db.delete(schema.fieldUsers).where(eq(schema.fieldUsers.id, legacyStaff.id));
  const added = await call("POST", "/api/users", { session: owner, body: { email: "staff@example.com", role: "owner" } });
  assert.equal(added.status, 201);
  const old = await call("GET", "/api/jobs", { token: staffToken });
  assert.equal(old.status, 403);
  assert.equal(old.body.code, "no_field_access");
  // Issuing the new row a token replaces the stale record instead of reusing it.
  const minted = await call("POST", `/api/users/${added.body.user.id}/tokens`, { session: owner });
  assert.equal(minted.status, 201);
  assert.equal(users.findUserById(legacyStaff.id), null);
  assert.equal((await call("GET", "/api/jobs", { token: staffToken })).status, 401);
  assert.equal((await call("GET", "/api/jobs", { token: minted.body.token })).body.caller.fieldRole, "owner");
});

test("a service account cannot share a person's email, and emails must be ASCII", async () => {
  const owner = await signInOwner();
  const clash = await call("POST", "/api/users", { session: owner, body: { email: "Staff@Example.com", kind: "service" } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "email_in_use");
  assert.equal((await call("POST", "/api/users", { session: owner, body: { email: "robot@example.com", kind: "service" } })).status, 201);
  for (const email of ["jos\u00e9@example.com", "crew@ex\u0430mple.com", "crew @example.com"]) {
    for (const kind of [undefined, "service"]) {
      const response = await call("POST", "/api/users", { session: owner, body: { email, kind } });
      assert.equal(response.status, 400, `${email} ${kind}`);
      assert.equal(response.body.code, "email_not_ascii");
      assert.match(response.body.error, /plain ASCII/);
    }
  }
  // A Clerk account whose verified email is not ASCII is refused, not linked or recorded.
  ctx.directory.set("user_unicode", clerkUser("user_unicode", "\u00f8wner@example.com"));
  const refused = await call("GET", "/api/jobs", { session: sessionToken("user_unicode") });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "email_not_ascii");
  assert.equal((await ctx.db.select().from(schema.fieldUsers)).length, 2);
});

test("an MFA-verified owner issues and revokes Field tokens, including for a Clerk-only user", async () => {
  const owner = await signInOwner();
  const minted = await call("POST", `/api/users/${legacyOwner.id}/tokens`, { session: owner, body: { label: "laptop CLI" } });
  assert.equal(minted.status, 201);
  assert.match(minted.body.token, /^field_/);
  assert.equal((await call("GET", "/api/jobs", { token: minted.body.token })).status, 200);
  const listed = await call("GET", `/api/users/${legacyOwner.id}/tokens`, { session: owner });
  assert.ok(listed.body.tokens.some((token) => token.label === "laptop CLI"));
  assert.ok(listed.body.tokens.every((token) => !("hash" in token)));
  const revoked = await call("DELETE", `/api/users/${legacyOwner.id}/tokens/${minted.body.metadata.id}`, { session: owner });
  assert.equal(revoked.status, 200);
  assert.equal((await call("GET", "/api/jobs", { token: minted.body.token })).status, 401);

  // A person added in Clerk mode (not in users.json) can still be given a token.
  const added = await call("POST", "/api/users", { session: owner, body: { email: "tablet@example.com", role: "staff" } });
  const theirs = await call("POST", `/api/users/${added.body.user.id}/tokens`, { session: owner, body: { label: "tablet" } });
  assert.equal(theirs.status, 201);
  const asThem = await call("GET", "/api/jobs", { token: theirs.body.token });
  assert.equal(asThem.status, 200);
  assert.equal(asThem.body.caller.id, added.body.user.id);
  assert.equal(asThem.body.caller.fieldRole, "staff");
});

// ── Retired password login and break-glass ───────────────────────
test("password sign-in is retired for people", async () => {
  const login = await call("POST", "/api/auth/login", { body: { email: "owner@example.com", password: "pw-owner" } });
  assert.equal(login.status, 410);
  assert.equal(login.body.code, "password_login_retired");
  assert.equal(login.body.token, undefined);
  const owner = await signInOwner();
  assert.equal((await call("POST", `/api/users/${legacyOwner.id}/password`, { session: owner, body: { password: "x" } })).status, 410);
});

test("break-glass: the authToken in its header acts as owner, is logged loudly and is rate-limited", async () => {
  const ok = await call("GET", "/api/users", { headers: { [BREAK_GLASS_HEADER]: BREAK_GLASS_KEY } });
  assert.equal(ok.status, 200);
  assert.ok(ctx.log.lines.some((line) => /^warn \[auth\] BREAK-GLASS OWNER ACCESS USED: GET \/api\/users/.test(line)));

  // Not as a Bearer token, not as a query string.
  assert.equal((await call("GET", "/api/jobs", { token: BREAK_GLASS_KEY })).status, 401);
  assert.equal((await call("GET", `/api/jobs?token=${BREAK_GLASS_KEY}`)).status, 401);

  const wrong = await call("GET", "/api/users", { headers: { [BREAK_GLASS_HEADER]: "wrong" } });
  assert.equal(wrong.status, 401);
  let limited = null;
  for (let attempt = 0; attempt < 6 && !limited; attempt += 1) {
    const response = await call("GET", "/api/users", { headers: { [BREAK_GLASS_HEADER]: BREAK_GLASS_KEY } });
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, "break-glass attempts are rate-limited");
  assert.equal(limited.body.code, "break_glass_rate_limited");
  // The key itself is never logged.
  assert.ok(ctx.log.lines.every((line) => !line.includes(BREAK_GLASS_KEY)));
});

// ── MCP OAuth stays Field-issued ───────────────────────────
test("MCP OAuth: only an MFA-verified owner's session approves an MCP client; its tokens then work as before", async (t) => {
  const mcpDataDir = await mkdtemp(join(tmpdir(), "field-clerk-mcp-"));
  t.after(() => rm(mcpDataDir, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  const port = 19000 + Math.floor(Math.random() * 900);
  const publicOrigin = `http://127.0.0.1:${port}`;
  const calls = [];
  const built = await createRemoteMcpRouter({
    dataDir: mcpDataDir,
    publicOrigin,
    authenticate: async () => null,
    approveWithSession: (req, res) => ctx.auth.authenticateOwnerSession(req, res),
    authorizeScopes: authorizeFieldMcpScopes,
    authenticateInstallationRequest: [ctx.auth.requireAuth, ctx.auth.requireOwner],
    service: { call: async (name, args, actor) => { calls.push({ name, actor }); return { ok: true }; } },
  });
  app.use(built.router);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const registered = await (await fetch(`${publicOrigin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Example Agent", redirect_uris: ["http://127.0.0.1/callback"] }),
  })).json();
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = `${publicOrigin}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: "http://127.0.0.1/callback",
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${publicOrigin}/mcp`,
    scope: MCP_SCOPES.join(" "),
  })}`;

  // Signed out: a sign-in page that returns here, and no password form.
  const signedOut = await fetch(authorizeUrl);
  assert.equal(signedOut.status, 401);
  const signedOutHtml = await signedOut.text();
  assert.match(signedOutHtml, /Owner sign-in required/);
  assert.match(signedOutHtml, /href="\/\?return_to=%2Foauth%2Fauthorize%3F/);
  assert.doesNotMatch(signedOutHtml, /name="password"/);

  // An owner without MFA is refused.
  await signInOwner();
  const noMfa = await fetch(authorizeUrl, { headers: { cookie: `__session=${sessionToken("user_owner")}` } });
  assert.equal(noMfa.status, 403);
  assert.match(await noMfa.text(), /two-step verification/);

  // An MFA-verified owner sees who they are signed in as and approves.
  const cookie = `__session=${sessionToken("user_owner", { mfa: true })}`;
  const page = await fetch(authorizeUrl, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Signed in as Olive Owner\./);
  assert.doesNotMatch(html, /name="password"/);
  const field = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)[1];
  const form = { request: field("request"), csrf: field("csrf"), email: "owner@example.com", password: "pw-owner" };

  // The approval page cannot be framed by another site.
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(signedOut.headers.get("x-frame-options"), "DENY");

  // A password alone no longer approves anything: with no session the form
  // goes back to the same authorization request (which offers sign-in).
  const passwordOnly = await fetch(`${publicOrigin}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
  assert.equal(passwordOnly.status, 303);
  const back = passwordOnly.headers.get("location");
  assert.ok(back.startsWith("/oauth/authorize?"), back);
  const backParams = new URL(back, publicOrigin).searchParams;
  const originalParams = new URL(authorizeUrl).searchParams;
  for (const name of ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"]) {
    assert.equal(backParams.get(name), originalParams.get(name), name);
  }
  assert.equal(passwordOnly.headers.get("x-frame-options"), "DENY");

  const approved = await fetch(`${publicOrigin}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
  assert.equal(approved.status, 303);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const tokens = await (await fetch(`${publicOrigin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registered.client_id,
      redirect_uri: "http://127.0.0.1/callback",
      code_verifier: verifier,
      resource: `${publicOrigin}/mcp`,
    }),
  })).json();
  assert.ok(tokens.access_token);

  // The Field-issued MCP access token works on /mcp without any Clerk session.
  const rpc = await fetch(`${publicOrigin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "field_quote_list", arguments: {} } }),
  });
  assert.equal(rpc.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor.subject, legacyOwner.id);

  // Managing installations is owner-only: a machine token cannot.
  const viaToken = await fetch(`${publicOrigin}/api/mcp/installations`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(viaToken.status, 403);
  const viaOwner = await fetch(`${publicOrigin}/api/mcp/installations`, { headers: { cookie } });
  assert.equal(viaOwner.status, 200);
  assert.equal((await viaOwner.json()).installations.length, 1);

  // Disabling the person who approved the client revokes the installation: a second
  // owner disables the first, and the client's tokens stop working.
  ctx.revokeMcp = (subjects) => built.store.revokeSubjects(subjects);
  const second = await call("POST", "/api/users", { session: sessionToken("user_owner", { mfa: true }), body: { email: "second@example.com", role: "owner" } });
  ctx.directory.set("user_second", clerkUser("user_second", "second@example.com"));
  const secondOwner = sessionToken("user_second", { mfa: true });
  assert.equal((await call("GET", "/api/jobs", { session: secondOwner })).body.caller.id, second.body.user.id);
  assert.equal((await call("PATCH", `/api/users/${legacyOwner.id}`, { session: secondOwner, body: { status: "disabled" } })).status, 200);
  const afterDisable = await fetch(`${publicOrigin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(afterDisable.status, 401);
  const refreshed = await fetch(`${publicOrigin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: registered.client_id }),
  });
  assert.equal(refreshed.status, 400);
  assert.deepEqual(built.store.listInstallations({ subject: legacyOwner.id }), []);
});
