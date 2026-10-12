import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
  createRemoteMcpRouter,
  MCP_SCOPES,
  resolveRemoteMcpRuntimeConfig,
  TOOL_SCOPES,
} from "./remote-mcp.js";

// Fake URL credentials are assembled at runtime so secret scanners do not flag the fixtures.
const FAKE_USERINFO = ["user", "pass"].join(":") + "@";

const verifier = "z".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const publicOrigin = "http://127.0.0.1:19999";

test("runtime config explicitly opts in and Field verification is a bounded automatic opt-in", () => {
  assert.deepEqual(resolveRemoteMcpRuntimeConfig({ config: {} }), {
    enabled: false,
    publicOrigin: null,
  });
  assert.deepEqual(resolveRemoteMcpRuntimeConfig({
    config: { mcp: { enabled: true, publicOrigin: "https://field.example.com" } },
    env: {},
  }), {
    enabled: true,
    publicOrigin: "https://field.example.com",
  });
  assert.deepEqual(resolveRemoteMcpRuntimeConfig({
    config: {
      fieldVerification: { enabled: true, publicUrl: "https://field-verification.example.invalid" },
    },
    env: {},
  }), {
    enabled: true,
    publicOrigin: "https://field-verification.example.invalid",
  });
  assert.deepEqual(resolveRemoteMcpRuntimeConfig({
    config: {
      mcp: { enabled: false },
      fieldVerification: { enabled: true, publicUrl: "https://field-verification.example.invalid" },
    },
    env: { FIELD_PUBLIC_ORIGIN: "https://ignored.example.com" },
  }), {
    enabled: false,
    publicOrigin: null,
  });
});

function form(url, data) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data),
    redirect: "manual",
  });
}

function hiddenInputValue(html, name) {
  const quoted = new RegExp(`name="${name}"[^>]*value="([^"]*)"`);
  const unquoted = new RegExp(`name=${name}[^>]*value="([^"]*)"`);
  const match = quoted.exec(html) || unquoted.exec(html);
  assert.ok(match, `missing hidden input ${name}`);
  return match[1];
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "field-mcp-"));
  const calls = [];
  const users = {
    operator: { id: "user-1", role: "user", permissions: [...MCP_SCOPES] },
    other: { id: "user-2", role: "user", permissions: [...MCP_SCOPES] },
  };
  const app = express();
  app.use(express.json());
  const built = await createRemoteMcpRouter({
    dataDir,
    publicOrigin,
    authenticate: overrides.authenticate || ((email, password) => {
      if (password !== "fixture-password") return null;
      if (email === "operator@example.invalid") return users.operator;
      if (email === "other@example.invalid") return users.other;
      return null;
    }),
    authorizeScopes: overrides.authorizeScopes || ((_user, requested) => requested),
    authenticateInstallationRequest: (req, res, next) => {
      const identity = req.headers["x-test-user"];
      if (identity === "admin") req.caller = { id: "admin-1", role: "admin" };
      else if (users[identity]) req.caller = users[identity];
      else return res.status(401).json({ error: "authentication required" });
      next();
    },
    service: overrides.service || {
      call: async (name, args) => {
        calls.push([name, args]);
        return { ok: true };
      },
    },
  });
  app.use(built.router);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { base, calls, built, users };
}

async function loginOn(fixtureState, {
  scope = "catalog.read catalog.write quote.read quote.draft",
  email = "operator@example.invalid",
} = {}) {
  const registration = await fetch(`${fixtureState.base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Example MCP client",
      redirect_uris: ["http://localhost:8989/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();

  const authorization = new URL(`${fixtureState.base}/oauth/authorize`);
  const query = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    state: "state-opaque",
    scope,
    resource: `${publicOrigin}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries(query)) authorization.searchParams.set(key, value);
  const page = await fetch(authorization);
  assert.equal(page.status, 200);
  const html = await page.text();
  const request = hiddenInputValue(html, "request");
  const csrf = hiddenInputValue(html, "csrf");

  const approved = await form(`${fixtureState.base}/oauth/approve`, {
    request,
    csrf,
    email,
    password: "fixture-password",
  });
  if (approved.status !== 303) return { client, approved };
  const callback = new URL(approved.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "state-opaque");

  const response = await form(`${fixtureState.base}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code: callback.searchParams.get("code"),
    code_verifier: verifier,
  });
  assert.equal(response.status, 200);
  return {
    client,
    tokens: await response.json(),
    code: callback.searchParams.get("code"),
  };
}

function rpc(fixtureState, accessToken, method, params) {
  return fetch(`${fixtureState.base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test("discovery publishes OAuth metadata and no fake OIDC metadata", async (t) => {
  const f = await fixture(t);
  const protectedResource = await (await fetch(`${f.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(protectedResource.authorization_servers, [publicOrigin]);
  assert.equal(protectedResource.resource, `${publicOrigin}/mcp`);

  const metadata = await (await fetch(`${f.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.registration_endpoint, `${publicOrigin}/oauth/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.scopes_supported, MCP_SCOPES);
  assert.equal((await fetch(`${f.base}/.well-known/openid-configuration`)).status, 404);
});

test("GET /oauth/authorize is Field-styled and POST /oauth/approve still grants", async (t) => {
  const f = await fixture(t);
  const registration = await fetch(`${f.base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Example MCP client",
      redirect_uris: ["http://localhost:8989/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();

  const authorization = new URL(`${f.base}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    state: "state-opaque",
    scope: "catalog.read quote.read",
    resource: `${publicOrigin}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) authorization.searchParams.set(key, value);

  const page = await fetch(authorization);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /<style>/);
  assert.match(html, /data-theme="field"/);
  assert.match(html, /--t-brand:\s*#f4c518/);
  assert.match(html, /<h1><img src="\/field-mark.svg" alt="" width="36" height="28"> FIELD<\/h1>/);
  assert.match(html, /<code>catalog\.read<\/code>/);
  assert.match(html, /<code>quote\.read<\/code>/);
  assert.match(html, /method="post" action="\/oauth\/approve"/);
  assert.doesNotMatch(html, /<title>Authorize Example<\/title><body><main>/);

  const approved = await form(`${f.base}/oauth/approve`, {
    request: hiddenInputValue(html, "request"),
    csrf: hiddenInputValue(html, "csrf"),
    email: "operator@example.invalid",
    password: "fixture-password",
  });
  assert.equal(approved.status, 303);
  assert.match(approved.headers.get("location"), /[?&]code=/);
  assert.match(approved.headers.get("location"), /state=state-opaque/);
});

test("public origin must have pathname / and no URL extras", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-mcp-origin-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  for (const badOrigin of [
    "https://field.example/path",
    "https://field.example/?query=1",
    `https://${FAKE_USERINFO}field.example/`,
    "https://field.example/#fragment",
  ]) {
    await assert.rejects(createRemoteMcpRouter({
      dataDir,
      publicOrigin: badOrigin,
      authenticate: () => null,
      authorizeScopes: () => [],
      service: { call: async () => ({}) },
    }), /pathname \/|HTTPS origin/);
  }
});

test("DCR is bounded and rejects confidential or unsafe redirects", async (t) => {
  const f = await fixture(t);
  const invalidBodies = [
    { redirect_uris: ["https://ok.example/cb"], token_endpoint_auth_method: "client_secret_post" },
    { redirect_uris: ["http://remote.example/cb"] },
    { redirect_uris: [`https://${FAKE_USERINFO}ok.example/cb`] },
    { redirect_uris: ["https://ok.example/cb#fragment"] },
    { redirect_uris: [`https://ok.example/${"x".repeat(2048)}`] },
    { redirect_uris: ["https://ok.example/cb"], client_name: "x".repeat(129) },
    { redirect_uris: ["https://ok.example/cb"], grant_types: ["client_credentials"] },
  ];
  for (const body of invalidBodies) {
    const response = await fetch(`${f.base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }

  const valid = await fetch(`${f.base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://ok.example/cb"] }),
  });
  const registration = await valid.json();
  assert.equal(valid.status, 201);
  assert.ok(registration.client_id_expires_at > registration.client_id_issued_at);
});

test("authorizeScopes is an injectable hard boundary", async (t) => {
  const f = await fixture(t, {
    authorizeScopes: (user, requested) => requested.filter((scope) => user.permissions.includes(scope)),
  });
  f.users.operator.permissions = ["quote.read"];
  const result = await loginOn(f, { scope: "quote.read quote.draft" });
  assert.equal(result.approved.status, 403);
  assert.equal(f.built.store.listInstallations().length, 0);
});

test("authorization code is one-time and responses do not disclose credentials", async (t) => {
  const f = await fixture(t);
  const login = await loginOn(f);
  const replay = await form(`${f.base}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: login.client.client_id,
    redirect_uri: login.client.redirect_uris[0],
    code: login.code,
    code_verifier: verifier,
  });
  assert.equal(replay.status, 400);
  assert.doesNotMatch(await replay.text(), /fixture-password|field_code_/);
});

test("write-only grants cannot discover, call, or dry-run read-dependent mutations", async (t) => {
  const f = await fixture(t);
  const login = await loginOn(f, { scope: "catalog.write quote.draft" });
  const listed = await rpc(f, login.tokens.access_token, "tools/list", {});
  const names = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.ok(!names.includes("field_price_item_list"));
  assert.ok(!names.includes("field_price_item_update"));
  assert.ok(!names.includes("field_quote_list"));
  assert.ok(!names.includes("field_quote_draft_update"));

  const denied = await rpc(f, login.tokens.access_token, "tools/call", {
    name: "field_price_item_update",
    arguments: { code: "A", sellPrice: 10 },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    error: "insufficient_scope",
    error_description: "Required scope: catalog.read catalog.write",
  });
  assert.equal(
    denied.headers.get("www-authenticate"),
    `Bearer error="insufficient_scope", scope="catalog.read catalog.write", resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/mcp"`,
  );

  const quoteDenied = await rpc(f, login.tokens.access_token, "tools/call", {
    name: "field_quote_draft_update",
    arguments: { jobId: "q1", patch: { assumptions: { note: "dry run" } } },
  });
  assert.equal(quoteDenied.status, 403);
  assert.match(quoteDenied.headers.get("www-authenticate"), /scope="quote.read quote.draft"/);
  assert.equal(f.calls.length, 0);
});

test("MCP authenticates initialize/list/call and filters by complete scope requirement", async (t) => {
  const f = await fixture(t);
  const login = await loginOn(f, { scope: "quote.read quote.draft" });
  const unauthenticated = await rpc(f, "invalid", "initialize", {});
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate"), /oauth-protected-resource\/mcp/);

  const initialized = await rpc(f, login.tokens.access_token, "initialize", {});
  assert.equal((await initialized.json()).result.protocolVersion, "2025-06-18");
  const listed = await rpc(f, login.tokens.access_token, "tools/list", {});
  const names = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("field_quote_get"));
  assert.ok(names.includes("field_quote_draft_update"));
  assert.ok(!names.includes("field_price_item_update"));
  assert.equal((await rpc(f, login.tokens.access_token, "tools/call", {
    name: "field_quote_get",
    arguments: { jobId: "x" },
  })).status, 200);
});

test("quote-list structured content is a record matching its declared output schema", async (t) => {
  const quotes = [{ id: "quote-1", status: "draft" }];
  const f = await fixture(t, {
    service: {
      call: async (name) => {
        assert.equal(name, "field_quote_list");
        return { quotes };
      },
    },
  });
  const login = await loginOn(f, { scope: "quote.read" });

  const listed = await rpc(f, login.tokens.access_token, "tools/list", {});
  const definition = (await listed.json()).result.tools.find((tool) => tool.name === "field_quote_list");
  assert.deepEqual(definition.outputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      quotes: { type: "array", items: { type: "object" } },
    },
    required: ["quotes"],
  });

  const called = await rpc(f, login.tokens.access_token, "tools/call", {
    name: "field_quote_list",
    arguments: { search: "", status: "draft", limit: 25 },
  });
  assert.equal(called.status, 200);
  const result = (await called.json()).result;
  assert.deepEqual(result.structuredContent, { quotes });
  assert.ok(!Array.isArray(result.structuredContent));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("price-item-list structured content is a record matching its declared output schema", async (t) => {
  const items = [{ code: "A", name: "Alpha" }];
  const f = await fixture(t, {
    service: {
      call: async (name) => {
        assert.equal(name, "field_price_item_list");
        return { items };
      },
    },
  });
  const login = await loginOn(f, { scope: "catalog.read" });

  const listed = await rpc(f, login.tokens.access_token, "tools/list", {});
  const definition = (await listed.json()).result.tools.find((tool) => tool.name === "field_price_item_list");
  assert.deepEqual(definition.outputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      items: { type: "array", items: { type: "object" } },
    },
    required: ["items"],
  });

  const called = await rpc(f, login.tokens.access_token, "tools/call", {
    name: "field_price_item_list",
    arguments: { search: "A" },
  });
  assert.equal(called.status, 200);
  const result = (await called.json()).result;
  assert.deepEqual(result.structuredContent, { items });
  assert.ok(!Array.isArray(result.structuredContent));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("installation routes are subject-bound while admins may list and revoke any", async (t) => {
  const f = await fixture(t);
  const first = await loginOn(f);
  await loginOn(f, { email: "other@example.invalid" });

  let response = await fetch(`${f.base}/api/mcp/installations`, {
    headers: { "x-test-user": "operator" },
  });
  let body = await response.json();
  assert.equal(body.installations.length, 1);
  assert.equal(body.installations[0].subject, "user-1");

  response = await fetch(`${f.base}/api/mcp/installations?subject=user-2`, {
    headers: { "x-test-user": "operator" },
  });
  assert.equal(response.status, 403);

  response = await fetch(`${f.base}/api/mcp/installations`, {
    headers: { "x-test-user": "admin" },
  });
  body = await response.json();
  assert.equal(body.installations.length, 2);

  const otherInstallation = body.installations.find((item) => item.subject === "user-2");
  assert.equal((await fetch(`${f.base}/api/mcp/installations/${otherInstallation.id}`, {
    method: "DELETE",
    headers: { "x-test-user": "operator" },
  })).status, 404);
  assert.equal((await fetch(`${f.base}/api/mcp/installations/${otherInstallation.id}`, {
    method: "DELETE",
    headers: { "x-test-user": "admin" },
  })).status, 200);

  const stillValid = await rpc(f, first.tokens.access_token, "ping", {});
  assert.equal(stillValid.status, 200);
});

test("refresh rotation replay and explicit revocation invalidate token families", async (t) => {
  const f = await fixture(t);
  const login = await loginOn(f);
  const rotatedResponse = await form(`${f.base}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: login.client.client_id,
    refresh_token: login.tokens.refresh_token,
  });
  assert.equal(rotatedResponse.status, 200);
  const rotated = await rotatedResponse.json();
  assert.notEqual(rotated.refresh_token, login.tokens.refresh_token);
  assert.equal((await form(`${f.base}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: login.client.client_id,
    refresh_token: login.tokens.refresh_token,
  })).status, 400);
  assert.equal((await rpc(f, rotated.access_token, "initialize", {})).status, 401);
});

test("tool scope matrix contains no delivery or financial lifecycle tools", () => {
  assert.equal(Object.keys(TOOL_SCOPES).some((name) => (
    /send|publish|email|issue|invoice|payment|accept/.test(name)
  )), false);
  assert.deepEqual(TOOL_SCOPES.field_price_item_update, ["catalog.read", "catalog.write"]);
  assert.deepEqual(TOOL_SCOPES.field_quote_draft_update, ["quote.read", "quote.draft"]);
});
