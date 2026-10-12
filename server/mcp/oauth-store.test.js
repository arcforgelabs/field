import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore } from "./oauth-store.js";
import { FORBIDDEN_BOUNDARY_MARKERS } from "../../scripts/verification/contract.js";

const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "field-oauth-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new OAuthStore({ dataDir, ...options });
  await store.init();
  return { dataDir, store };
}

async function issueTokens(store, subject = "u1") {
  const client = await store.registerClient({
    client_name: "Example Agent",
    redirect_uris: ["http://localhost:8989/oauth/callback"],
  });
  const { request, csrf } = await store.createRequest({
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    state: "opaque-state",
    scope: ["quote.read"],
    resource: "https://field.example/mcp",
    codeChallenge: challenge,
  });
  const approved = await store.approve({ id: request.id, csrf, subject });
  const tokens = await store.exchangeCode({
    code: approved.code,
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    verifier,
  });
  return { client, csrf, approved, tokens };
}

test("OAuth secrets are hashed, one-time, audience-bound, and rotated", async (t) => {
  let now = 1_000_000;
  const { dataDir, store } = await fixture(t, {
    now: () => now,
    accessTtlMs: 1000,
    codeTtlMs: 500,
  });
  const issued = await issueTokens(store);

  assert.equal(await store.exchangeCode({
    code: issued.approved.code,
    clientId: issued.client.client_id,
    redirectUri: issued.client.redirect_uris[0],
    verifier,
  }), null);
  assert.ok(store.access(issued.tokens.access_token, {
    resource: "https://field.example/mcp",
    requiredScopes: ["quote.read"],
  }));
  assert.equal(store.access(issued.tokens.access_token, {
    resource: "https://other.example/mcp",
  }), null);

  const rotated = await store.refresh({
    refreshToken: issued.tokens.refresh_token,
    clientId: issued.client.client_id,
  });
  assert.notEqual(rotated.refresh_token, issued.tokens.refresh_token);
  assert.equal(await store.refresh({
    refreshToken: issued.tokens.refresh_token,
    clientId: issued.client.client_id,
  }), null);
  assert.equal(store.access(rotated.access_token, { resource: "https://field.example/mcp" }), null);

  const disk = await readFile(join(dataDir, "mcp/as-state.json"), "utf8");
  for (const plaintext of [
    issued.approved.code,
    issued.tokens.access_token,
    issued.tokens.refresh_token,
    rotated.access_token,
    rotated.refresh_token,
    issued.csrf,
  ]) {
    assert.equal(disk.includes(plaintext), false);
  }

  now += 2000;
  assert.equal(store.access(issued.tokens.access_token, { resource: "https://field.example/mcp" }), null);
});

test("installations retain one grant across refresh and enforce subject revocation", async (t) => {
  const { store } = await fixture(t);
  const issued = await issueTokens(store, "u1");
  const installation = store.listInstallations({ subject: "u1" })[0];
  assert.ok(installation.id);
  assert.equal(installation.clientName, "Example Agent");

  await store.refresh({
    refreshToken: issued.tokens.refresh_token,
    clientId: issued.client.client_id,
  });
  assert.equal(store.listInstallations({ subject: "u1" }).length, 1);
  assert.equal(await store.revokeInstallation({ id: installation.id, subject: "u2" }), false);
  assert.equal(await store.revokeInstallation({ id: installation.id, subject: "u1" }), true);
  assert.equal(store.listInstallations({ subject: "u1" }).length, 0);
  assert.equal(store.listInstallations({ subject: "u1", includeRevoked: true })[0].revokedAt !== null, true);
});

test("authorization-server state path stays outside verification boundary markers", async (t) => {
  const { dataDir, store } = await fixture(t);
  const relativePath = store.path.slice(dataDir.length + 1);
  const disk = await readFile(store.path, "utf8");
  for (const marker of FORBIDDEN_BOUNDARY_MARKERS) {
    assert.equal(relativePath.toLowerCase().includes(marker), false, relativePath);
    assert.equal(disk.toLowerCase().includes(marker), false, marker);
  }
});

test("authorization requests and codes expire", async (t) => {
  let now = 100;
  const { store } = await fixture(t, { now: () => now, codeTtlMs: 10 });
  const client = await store.registerClient({ redirect_uris: ["http://localhost/cb"] });
  const pending = await store.createRequest({
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    scope: ["quote.read"],
    resource: "https://field.example/mcp",
    state: "s",
    codeChallenge: challenge,
  });
  now = 111;
  assert.equal(await store.approve({
    id: pending.request.id,
    csrf: pending.csrf,
    subject: "u",
  }), null);
});

test("revokeSubjects cuts off everything a removed or disabled person approved, and nobody else", async (t) => {
  const { store } = await fixture(t);
  const removed = await issueTokens(store, "person-1");
  const other = await issueTokens(store, "person-2");
  // An approved code not yet exchanged.
  const client = store.client(removed.client.client_id);
  const { request, csrf } = await store.createRequest({
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    state: "s",
    scope: ["quote.read"],
    resource: "https://field.example/mcp",
    codeChallenge: challenge,
  });
  const pendingCode = await store.approve({ id: request.id, csrf, subject: "person-1" });

  assert.equal(await store.revokeSubjects(["person-1", "nobody"]), 1);
  assert.equal(store.access(removed.tokens.access_token, { resource: "https://field.example/mcp" }), null);
  assert.equal(await store.refresh({ refreshToken: removed.tokens.refresh_token, clientId: removed.client.client_id }), null);
  assert.equal(await store.exchangeCode({
    code: pendingCode.code,
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    verifier,
  }), null);
  assert.deepEqual(store.listInstallations({ subject: "person-1" }), []);
  assert.equal(store.listInstallations({ subject: "person-1", includeRevoked: true })[0].revokedAt !== null, true);

  assert.ok(store.access(other.tokens.access_token, { resource: "https://field.example/mcp" }));
  assert.equal(store.listInstallations({ subject: "person-2" }).length, 1);
  assert.equal(await store.revokeSubjects([]), 0);
});
