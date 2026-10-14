// Settings, Team, Access (#133): owners see and revoke command-line tokens and
// connected agents (MCP installations). Clerk is faked (no network, no real
// keys); the users table and the audit trail are a fresh in-process
// PostgreSQL (PGlite) per test; tokens use the real users.js store in a
// temporary data directory. All data is synthetic.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { sql } from "drizzle-orm";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import * as users from "../users.js";
import { createClerkAuth, createClerkAuthRouter } from "./clerk-auth.js";
import { createAccessAuditStore } from "./access-audit.js";
import { createAccessEventsRouter, createPasswordTokenRouter } from "./token-access.js";
import { createRemoteMcpRouter, MCP_SCOPES } from "../mcp/remote-mcp.js";
import { authorizeFieldMcpScopes } from "../mcp/scope-authority.js";

const BREAK_GLASS_KEY = "break-glass-fixture-key";

function sessionToken(userId, { mfa = true } = {}) {
  return `sess:${Buffer.from(JSON.stringify({ userId, fva: [2, mfa ? 2 : -1] })).toString("base64url")}`;
}

function clerkUser(id, email) {
  return {
    id,
    firstName: "Synthetic",
    lastName: "Person",
    passwordEnabled: true,
    primaryEmailAddressId: `idn_${id}`,
    emailAddresses: [{ id: `idn_${id}`, emailAddress: email, verification: { status: "verified" } }],
    externalAccounts: [],
  };
}

function fakeClerk(directory) {
  return {
    middleware(req, _res, next) {
      const header = req.headers.authorization || "";
      const raw = header.startsWith("Bearer ") ? header.slice(7) : null;
      req.fakeClerkSession = raw?.startsWith("sess:") ? JSON.parse(Buffer.from(raw.slice(5), "base64url").toString("utf8")) : null;
      next();
    },
    getAuth(req) {
      const session = req.fakeClerkSession;
      return session ? { userId: session.userId, factorVerificationAge: session.fva } : { userId: null, factorVerificationAge: null };
    },
    async getUser(userId) {
      const user = directory.get(userId);
      if (!user) throw Object.assign(new Error("not found"), { status: 404 });
      return user;
    },
  };
}

const quietLog = { info() {}, warn() {}, error() {} };
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

// ── Fixture ──────────────────────────────────────────────────────
let ctx;

beforeEach(async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-access-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await users.initUsers(dataDir);
  const owner = await users.ensureUser({ email: "owner@example.test", name: "Olive Owner", password: "pw-owner", role: "admin" });
  const staff = await users.ensureUser({ email: "staff@example.test", name: "Sam Staff", password: "pw-staff", role: "user" });
  const service = await users.createUser({ email: "retired-agent@example.test", name: "Retired Agent", kind: "service", role: "admin" });
  const tokens = {
    ownerCli: await users.addToken(owner.id, "owner laptop CLI"),
    staffCli: await users.addToken(staff.id, "staff tablet"),
    serviceOld: await users.addToken(service.id, "retired agent field token"),
  };

  const testDb = await createTestDb();
  t.after(() => testDb.close());
  const directory = new Map([["user_owner", clerkUser("user_owner", "owner@example.test")], ["user_staff", clerkUser("user_staff", "staff@example.test")]]);
  const auth = createClerkAuth({
    db: testDb.db,
    clerk: fakeClerk(directory),
    legacy: { findUserByToken: users.findUserByToken, findUserById: users.findUserById, recordTokenUse: users.recordTokenUse },
    breakGlassKey: BREAK_GLASS_KEY,
    log: quietLog,
  });
  await auth.importLegacyUsers(users.listUsers());
  const audit = createAccessAuditStore({ db: testDb.db, orgUid: DEFAULT_ORG_UID });

  const mcpDataDir = await mkdtemp(join(tmpdir(), "field-access-mcp-"));
  t.after(() => rm(mcpDataDir, { recursive: true, force: true }));
  const port = 19000 + Math.floor(Math.random() * 900);
  const publicOrigin = `http://127.0.0.1:${port}`;
  const mcp = await createRemoteMcpRouter({
    dataDir: mcpDataDir,
    publicOrigin,
    authenticate: async () => null,
    approveWithSession: (req, res) => auth.authenticateOwnerSession(req, res),
    authorizeScopes: authorizeFieldMcpScopes,
    currentScopes: (subject) => auth.currentMcpScopes(subject),
    authenticateInstallationRequest: [auth.requireAuth, auth.requireOwner],
    onInstallationDisconnected: async ({ req, installation }) => {
      await audit.record("mcp_installation_disconnected", {
        actor: req.caller,
        target: { id: installation.id, name: installation.clientName },
        holder: { id: installation.subject, name: await auth.holderName(installation.subject) },
      });
    },
    service: { call: async () => ({ ok: true }) },
  });

  const app = express();
  app.use(express.json());
  app.use(createClerkAuthRouter({
    auth,
    db: testDb.db,
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
      tokenIdForPlaintext: users.tokenIdForPlaintext,
    },
    revokeMcpAccess: (subjects) => mcp.store.revokeSubjects(subjects),
    accessAudit: audit,
    log: quietLog,
  }));
  app.use(createAccessEventsRouter({ requireAuth: auth.requireAuth, requireOwner: auth.requireOwner, audit: () => audit }));
  app.get("/api/jobs", auth.requireAuth, (req, res) => res.json({ ok: true, caller: req.caller.id }));
  app.use(mcp.router);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // A connected agent the owner approved, issued straight from the store.
  const client = await (await fetch(`${publicOrigin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Synthetic Desktop Agent", redirect_uris: ["http://127.0.0.1/callback"] }),
  })).json();
  const grant = await mcp.store.transaction((data) => mcp.store.issue(data, {
    clientId: client.client_id,
    subject: owner.id,
    scope: [...MCP_SCOPES],
    resource: `${publicOrigin}/mcp`,
  }));

  ctx = { base: publicOrigin, db: testDb.db, owner, staff, service, tokens, grant, mcp, audit, ownerSession: sessionToken("user_owner") };
});

async function call(method, path, { bearer, headers = {}, body } = {}) {
  const response = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
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

async function rpc(accessToken) {
  const response = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

// Every secret in the fixture, and its SHA-256: none may appear in a response.
function secrets() {
  const values = [
    ctx.tokens.ownerCli.token,
    ctx.tokens.staffCli.token,
    ctx.tokens.serviceOld.token,
    ctx.grant.access_token,
    ctx.grant.refresh_token,
  ];
  return [...values, ...values.map(sha256)];
}

function assertNoSecrets(response, where) {
  for (const secret of secrets()) assert.ok(!response.text.includes(secret), `${where} leaks a token value or hash`);
  assert.doesNotMatch(response.text, /"hash"\s*:/, `${where} has a hash field`);
  assert.doesNotMatch(response.text, /field_(at|rt|code)_|field_(?!client_)[A-Za-z0-9_-]{40,}/, `${where} has something shaped like a token`);
}

// ── Listing ──────────────────────────────────────────────────────
test("an owner lists people, service accounts, their tokens and connected agents: metadata only, never a value or hash", async () => {
  // Use two tokens and the agent, so "last used" has something to show.
  assert.equal((await call("GET", "/api/jobs", { bearer: ctx.tokens.serviceOld.token })).status, 200);
  assert.equal((await call("GET", "/api/jobs", { bearer: ctx.tokens.staffCli.token })).status, 200);
  assert.equal(await rpc(ctx.grant.access_token), 200);

  const people = await call("GET", "/api/users", { bearer: ctx.ownerSession });
  assert.equal(people.status, 200);
  assertNoSecrets(people, "GET /api/users");
  assert.deepEqual(people.body.serviceAccounts.map((account) => account.name), ["Retired Agent"]);

  const serviceTokens = await call("GET", `/api/users/${ctx.service.id}/tokens`, { bearer: ctx.ownerSession });
  assert.equal(serviceTokens.status, 200);
  assertNoSecrets(serviceTokens, "GET service account tokens");
  const [old] = serviceTokens.body.tokens;
  assert.deepEqual(Object.keys(old).sort(), ["createdAt", "current", "id", "label", "lastUsedAt"]);
  assert.equal(old.label, "retired agent field token");
  assert.equal(old.current, false);
  assert.ok(old.lastUsedAt, "last used is recorded");

  const ownerTokens = await call("GET", `/api/users/${ctx.owner.id}/tokens`, { bearer: ctx.ownerSession });
  assertNoSecrets(ownerTokens, "GET owner tokens");
  assert.equal(ownerTokens.body.tokens[0].lastUsedAt, null, "an unused token was never used");

  const installations = await call("GET", "/api/mcp/installations", { bearer: ctx.ownerSession });
  assert.equal(installations.status, 200);
  assertNoSecrets(installations, "GET /api/mcp/installations");
  const [agent] = installations.body.installations;
  assert.equal(agent.clientName, "Synthetic Desktop Agent");
  assert.equal(agent.subject, ctx.owner.id);
  assert.deepEqual(agent.scopes, [...MCP_SCOPES]);
  assert.ok(agent.createdAt);
  assert.ok(agent.lastUsedAt, "an agent's last use is recorded");
});

// ── Owner only, including for machine tokens ─────────────────────
test("the Access routes are for owners signed in to Field: machine tokens and staff are refused", async () => {
  const routes = [
    ["GET", "/api/users"],
    ["GET", `/api/users/${ctx.service.id}/tokens`],
    ["DELETE", `/api/users/${ctx.service.id}/tokens/${ctx.tokens.serviceOld.metadata.id}`],
    ["GET", "/api/mcp/installations"],
    ["DELETE", `/api/mcp/installations/${ctx.mcp.store.listInstallations()[0].id}`],
    ["GET", "/api/access/events"],
  ];
  // The owner's own CLI token, an admin service account's token, staff's.
  const machine = [ctx.tokens.ownerCli.token, ctx.tokens.serviceOld.token, ctx.tokens.staffCli.token];
  for (const [method, path] of routes) {
    for (const bearer of machine) {
      const refused = await call(method, path, { bearer });
      assert.equal(refused.status, 403, `${method} ${path} with a machine token`);
      assertNoSecrets(refused, `${method} ${path} refusal`);
    }
    assert.equal((await call(method, path, { bearer: sessionToken("user_staff") })).status, 403, `${method} ${path} as staff`);
    assert.equal((await call(method, path, { bearer: sessionToken("user_owner", { mfa: false }) })).status, 403, `${method} ${path} without a verified owner sign-in`);
    assert.equal((await call(method, path)).status, 401, `${method} ${path} signed out`);
  }
  // Nothing was revoked by any of that.
  assert.equal((await call("GET", "/api/jobs", { bearer: ctx.tokens.serviceOld.token })).status, 200);
  assert.equal(await rpc(ctx.grant.access_token), 200);
});

// ── Revoke ───────────────────────────────────────────────────────
test("revoking a service account's old token: refused on the very next request, with an audit event and no value", async () => {
  assert.equal((await call("GET", "/api/jobs", { bearer: ctx.tokens.serviceOld.token })).status, 200);
  const tokenId = ctx.tokens.serviceOld.metadata.id;
  const revoked = await call("DELETE", `/api/users/${ctx.service.id}/tokens/${tokenId}`, { bearer: ctx.ownerSession });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { ok: true, audited: true, signedOut: false });
  assertNoSecrets(revoked, "DELETE token");

  // At once: the next request with it is refused.
  assert.equal((await call("GET", "/api/jobs", { bearer: ctx.tokens.serviceOld.token })).status, 401);
  assert.deepEqual((await call("GET", `/api/users/${ctx.service.id}/tokens`, { bearer: ctx.ownerSession })).body.tokens, []);
  // Again: nothing left to revoke.
  assert.equal((await call("DELETE", `/api/users/${ctx.service.id}/tokens/${tokenId}`, { bearer: ctx.ownerSession })).status, 404);

  const events = await call("GET", "/api/access/events", { bearer: ctx.ownerSession });
  assert.equal(events.status, 200);
  assertNoSecrets(events, "GET /api/access/events");
  assert.equal(events.body.events.length, 1);
  const [event] = events.body.events;
  assert.equal(event.action, "token_revoked");
  assert.deepEqual(event.actor, { id: ctx.owner.id, name: "Olive Owner" });
  assert.deepEqual(event.target, { id: tokenId, name: "retired agent field token" });
  assert.deepEqual(event.holder, { id: ctx.service.id, name: "Retired Agent" });
  assert.ok(Date.parse(event.at) > 0);
});

test("an owner revoking their own command-line token: the CLI is refused, their Field sign-in carries on", async () => {
  const tokenId = ctx.tokens.ownerCli.metadata.id;
  const revoked = await call("DELETE", `/api/users/${ctx.owner.id}/tokens/${tokenId}`, { bearer: ctx.ownerSession });
  assert.equal(revoked.status, 200);
  // Owners sign in with Clerk, never with a Field token, so this is never the current session.
  assert.equal(revoked.body.signedOut, false);
  assert.equal((await call("GET", "/api/jobs", { bearer: ctx.tokens.ownerCli.token })).status, 401);
  assert.equal((await call("GET", "/api/jobs", { bearer: ctx.ownerSession })).status, 200);
  const [event] = (await call("GET", "/api/access/events", { bearer: ctx.ownerSession })).body.events;
  assert.deepEqual(event.holder, { id: ctx.owner.id, name: "Olive Owner" });
});

test("a revoke still takes effect when the audit trail cannot be written, and says so", async () => {
  const failing = { record: async () => { throw new Error("database unavailable (test)"); } };
  const { revokeHolderToken } = await import("./token-access.js");
  const result = await revokeHolderToken({
    users,
    audit: failing,
    log: quietLog,
    req: { headers: {}, query: {}, caller: { id: ctx.owner.id, name: "Olive Owner" } },
    holder: ctx.service,
    tokenId: ctx.tokens.serviceOld.metadata.id,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.audited, false);
  assert.equal((await call("GET", "/api/jobs", { bearer: ctx.tokens.serviceOld.token })).status, 401);
});

// ── Disconnect ───────────────────────────────────────────────────
test("disconnecting a connected agent stops it at once and writes an audit event", async () => {
  const [installation] = ctx.mcp.store.listInstallations();
  const disconnected = await call("DELETE", `/api/mcp/installations/${installation.id}`, { bearer: ctx.ownerSession });
  assert.equal(disconnected.status, 200);
  assert.deepEqual(disconnected.body, { ok: true, audited: true });
  assertNoSecrets(disconnected, "DELETE installation");
  assert.equal(await rpc(ctx.grant.access_token), 401);
  assert.deepEqual((await call("GET", "/api/mcp/installations", { bearer: ctx.ownerSession })).body.installations, []);

  const [event] = (await call("GET", "/api/access/events", { bearer: ctx.ownerSession })).body.events;
  assert.equal(event.action, "mcp_installation_disconnected");
  assert.deepEqual(event.target, { id: installation.id, name: "Synthetic Desktop Agent" });
  assert.deepEqual(event.holder, { id: ctx.owner.id, name: "Olive Owner" });
  assert.deepEqual(event.actor, { id: ctx.owner.id, name: "Olive Owner" });
});

// ── The audit trail ──────────────────────────────────────────────
test("access audit events are append-only and hold no value", async () => {
  await ctx.audit.record("token_revoked", { actor: { id: "a", name: "A" }, target: { id: "t1", name: "n" }, holder: { id: "h", name: "H" } });
  // The app's role may not change or remove a row; the table owner is stopped by the trigger.
  const refused = (error) => /append-only|permission denied/.test(`${error.message} ${error.cause?.message ?? ""}`);
  await assert.rejects(() => withOrg(ctx.db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update access_audit_events set target_name = 'changed'`)), refused);
  await assert.rejects(() => withOrg(ctx.db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`delete from access_audit_events`)), refused);
  await assert.rejects(() => ctx.db.execute(sql`delete from access_audit_events`), refused);
  await assert.rejects(() => ctx.audit.record("token_viewed", { target: { id: "t" } }), /unknown access audit action/);
  const columns = await withOrg(ctx.db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`select column_name from information_schema.columns where table_name = 'access_audit_events'`));
  const names = (columns.rows ?? columns).map((row) => row.column_name);
  assert.ok(names.every((name) => !/hash|value|secret|token$/.test(name)), names.join(", "));
});

// ── Password sign-in: the session is itself a token ──────────────
test("password sign-in: revoking the token this session uses needs an explicit confirm, then signs it out", async (t) => {
  const audit = { events: [], async record(action, entry) { this.events.push({ action, ...entry }); } };
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
    const caller = users.findUserByToken(bearer);
    if (!caller) return res.status(401).json({ error: "unauthorized" });
    req.caller = caller;
    return next();
  };
  app.use(createPasswordTokenRouter({ users, requireAuth, audit: () => audit, log: quietLog }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, path, bearer) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` } });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  };

  const browser = await users.addToken(ctx.owner.id, "session");
  const listed = await send("GET", `/api/users/${ctx.owner.id}/tokens`, browser.token);
  assertNoSecrets(listed, "password GET tokens");
  assert.ok(!listed.text.includes(browser.token));
  assert.deepEqual(listed.body.tokens.filter((token) => token.current).map((token) => token.id), [browser.metadata.id]);

  const warned = await send("DELETE", `/api/users/${ctx.owner.id}/tokens/${browser.metadata.id}`, browser.token);
  assert.equal(warned.status, 409);
  assert.equal(warned.body.code, "current_token");
  assert.equal((await send("GET", `/api/users/${ctx.owner.id}/tokens`, browser.token)).status, 200, "not revoked without the confirm");
  assert.equal(audit.events.length, 0);

  const confirmed = await send("DELETE", `/api/users/${ctx.owner.id}/tokens/${browser.metadata.id}?confirm=current`, browser.token);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.signedOut, true);
  assert.equal((await send("GET", `/api/users/${ctx.owner.id}/tokens`, browser.token)).status, 401);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].target.id, browser.metadata.id);
  assert.ok(!JSON.stringify(audit.events).includes(browser.token));

  // An admin revokes someone else's token without any confirm; staff cannot.
  assert.equal((await send("DELETE", `/api/users/${ctx.owner.id}/tokens/${ctx.tokens.ownerCli.metadata.id}`, ctx.tokens.staffCli.token)).status, 403);
  assert.equal((await send("DELETE", `/api/users/${ctx.staff.id}/tokens/${ctx.tokens.staffCli.metadata.id}`, ctx.tokens.ownerCli.token)).status, 200);
  assert.equal((await send("GET", `/api/users/${ctx.staff.id}/tokens`, ctx.tokens.staffCli.token)).status, 401);
});
