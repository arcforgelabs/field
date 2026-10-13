// The Xero connection (#93) against a fake Xero (fake-xero.js) and PGlite:
// connect with the authorization code, choose among several organisations,
// refresh with rotation, a rejected refresh that asks the owner to connect
// again, a changed client secret, disconnect, the settings, and no token in
// the database's clear text or in any log line.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createXeroHttp } from "./client.js";
import { readXeroSecrets, xeroEndpoints, xeroRedirectUri } from "./config.js";
import { createXeroConnectionService } from "./connection.js";
import { startFakeXero } from "./fake-xero.js";

const REDIRECT = "https://field.example.invalid/api/integrations/xero/callback";
let xero;
let testDb;

before(async () => {
  xero = await startFakeXero({
    tenants: [
      { tenantId: "aaaaaaaa-0000-0000-0000-000000000001", tenantName: "Synthetic Earthworks Pty Ltd" },
    ],
  });
});
after(async () => {
  await xero?.close();
  await testDb?.close();
});

function recorder() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(" "));
  return { lines, logger: { log, warn: log, error: log, info: log } };
}

async function fresh({ secret = xero.clientSecret, clock = null } = {}) {
  await testDb?.close();
  testDb = await createTestDb();
  const logs = recorder();
  let now = clock || new Date("2026-10-13T00:00:00.000Z");
  const secrets = readXeroSecrets({ XERO_CLIENT_ID: xero.clientId, XERO_CLIENT_SECRET: secret });
  const make = (withSecrets = secrets) => createXeroConnectionService({
    db: testDb.db,
    orgUid: DEFAULT_ORG_UID,
    secrets: withSecrets,
    http: (s) => createXeroHttp({ clientId: s.clientId, clientSecret: s.clientSecret, endpoints: xeroEndpoints(xero.base) }),
    now: () => now,
    logger: logs.logger,
  });
  return { service: make(), make, logs, advance: (ms) => { now = new Date(now.getTime() + ms); }, rawRow: async () => (await withOrg(testDb.db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select * from xero_connections`, tx)))[0] };
}

async function connect(service) {
  const { url } = await service.startConnect({ redirectUri: REDIRECT, actor: "owner-1" });
  const authorize = new URL(url);
  assert.equal(authorize.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.match(authorize.searchParams.get("scope"), /offline_access/);
  assert.match(authorize.searchParams.get("scope"), /accounting\.invoices/);
  assert.equal(authorize.searchParams.get("code_challenge"), null, "a web app with a secret uses the plain code flow");
  const back = await xero.authorize(url);
  return service.completeConnect({ code: back.searchParams.get("code"), state: back.searchParams.get("state"), redirectUri: REDIRECT });
}

test("connect: the code becomes encrypted tokens and the one organisation is chosen", async () => {
  const { service, rawRow, logs } = await fresh();
  const before = await service.status();
  assert.equal(before.connection.status, "disconnected");
  assert.deepEqual(before.secrets, { clientIdSet: true, clientSecretSet: true });
  assert.equal(before.settings.createMode, "draft");

  assert.deepEqual(await connect(service), { status: "connected" });
  const status = await service.status();
  assert.equal(status.connection.status, "connected");
  assert.equal(status.connection.tenantName, "Synthetic Earthworks Pty Ltd");
  assert.equal(status.connection.connectedBy, "owner-1");
  assert.equal(status.settings.autoFrom, "2026-10-13T00:00:00.000Z", "invoices issued from now go to Xero by themselves");

  const row = await rawRow();
  const stored = JSON.stringify(row);
  for (const secret of xero.issuedSecrets()) assert.ok(!stored.includes(secret), "no token or secret in the clear in the database");
  assert.match(row.access_token_enc, /^v1\./);
  assert.match(row.refresh_token_enc, /^v1\./);
  assert.equal(row.pending_state_hash, null, "the state is spent");
  assert.ok(!JSON.stringify(status).includes("fake-"), "the screen never gets a token");

  const token = await service.accessToken();
  assert.equal(token.tenantId, "aaaaaaaa-0000-0000-0000-000000000001");
  assert.equal(xero.tokenCalls("refresh_token").length, 0, "a fresh access token is used as is");
  for (const line of logs.lines) for (const secret of xero.issuedSecrets()) assert.ok(!line.includes(secret));
});

test("the callback refuses a state it did not start, an expired one and a reused one", async () => {
  const { service, advance } = await fresh();
  await assert.rejects(service.completeConnect({ code: "x", state: "forged", redirectUri: REDIRECT }), (error) => error.code === "XERO_STATE_INVALID");

  const { url } = await service.startConnect({ redirectUri: REDIRECT });
  const back = await xero.authorize(url);
  advance(11 * 60_000);
  await assert.rejects(service.completeConnect({ code: back.searchParams.get("code"), state: back.searchParams.get("state"), redirectUri: REDIRECT }), (error) => error.code === "XERO_STATE_INVALID");

  const second = await xero.authorize((await service.startConnect({ redirectUri: REDIRECT })).url);
  await service.completeConnect({ code: second.searchParams.get("code"), state: second.searchParams.get("state"), redirectUri: REDIRECT });
  await assert.rejects(service.completeConnect({ code: second.searchParams.get("code"), state: second.searchParams.get("state"), redirectUri: REDIRECT }), (error) => error.code === "XERO_STATE_INVALID");
  assert.equal((await service.status()).connection.status, "connected");
});

test("a guessed state is refused and leaves the owner's sign-in in progress as it was", async () => {
  const { service, rawRow } = await fresh();
  const { url } = await service.startConnect({ redirectUri: REDIRECT, actor: "Owner" });
  const pending = (await rawRow()).pending_state_hash;
  for (const guess of ["guessed", "", "AAAA"]) {
    await assert.rejects(service.completeConnect({ code: "fake-code", state: guess, redirectUri: REDIRECT }), (error) => ["XERO_STATE_INVALID", "XERO_CALLBACK_INCOMPLETE"].includes(error.code));
  }
  assert.equal((await rawRow()).pending_state_hash, pending, "still the owner's");
  const back = await xero.authorize(url);
  assert.deepEqual(await service.completeConnect({ code: back.searchParams.get("code"), state: back.searchParams.get("state"), redirectUri: REDIRECT }), { status: "connected" });
});

test("Connect is refused without publicUrl: no redirect address is built from the request", async () => {
  const { service } = await fresh();
  await assert.rejects(service.startConnect({ redirectUri: null }), (error) => error.code === "XERO_PUBLIC_URL_MISSING" && error.statusCode === 409);
  assert.deepEqual(xeroRedirectUri({ publicUrl: null }), { redirectUri: null, configured: false });
  assert.deepEqual(xeroRedirectUri({ publicUrl: "https://field.example.invalid/", req: { headers: { "x-forwarded-host": "attacker.example.invalid" } } }), { redirectUri: REDIRECT, configured: true });
});

test("several organisations: the owner chooses one", async () => {
  const many = await startFakeXero({
    tenants: [
      { tenantId: "bbbbbbbb-0000-0000-0000-000000000001", tenantName: "Synthetic Holdings" },
      { tenantId: "bbbbbbbb-0000-0000-0000-000000000002", tenantName: "Synthetic Earthworks" },
    ],
  });
  try {
    await testDb?.close();
    testDb = await createTestDb();
    const service = createXeroConnectionService({
      db: testDb.db,
      orgUid: DEFAULT_ORG_UID,
      secrets: readXeroSecrets({ XERO_CLIENT_ID: many.clientId, XERO_CLIENT_SECRET: many.clientSecret }),
      http: (s) => createXeroHttp({ clientId: s.clientId, clientSecret: s.clientSecret, endpoints: xeroEndpoints(many.base) }),
      logger: recorder().logger,
    });
    const back = await many.authorize((await service.startConnect({ redirectUri: REDIRECT })).url);
    assert.deepEqual(await service.completeConnect({ code: back.searchParams.get("code"), state: back.searchParams.get("state"), redirectUri: REDIRECT }), { status: "choose_organisation" });
    const status = await service.status();
    assert.deepEqual(status.connection.organisations.map((entry) => entry.tenantName), ["Synthetic Holdings", "Synthetic Earthworks"]);
    await assert.rejects(service.accessToken(), (error) => error.code === "XERO_NOT_CONNECTED");
    await assert.rejects(service.chooseOrganisation({ tenantId: "not-one" }), (error) => error.code === "XERO_UNKNOWN_ORGANISATION");
    await service.chooseOrganisation({ tenantId: "bbbbbbbb-0000-0000-0000-000000000002", actor: "owner-1" });
    const chosen = await service.status();
    assert.equal(chosen.connection.status, "connected");
    assert.equal(chosen.connection.tenantName, "Synthetic Earthworks");
    assert.equal((await service.accessToken()).tenantId, "bbbbbbbb-0000-0000-0000-000000000002");
  } finally {
    await many.close();
  }
});

test("refresh: an expiring access token is refreshed, the rotated refresh token is stored, and one refresh serves concurrent callers", async () => {
  const { service, advance, rawRow } = await fresh();
  await connect(service);
  const first = (await rawRow()).refresh_token_enc;
  advance(29 * 60_000);
  const calls = xero.tokenCalls("refresh_token").length;
  const [a, b, c] = await Promise.all([service.accessToken(), service.accessToken(), service.accessToken()]);
  assert.equal(xero.tokenCalls("refresh_token").length, calls + 1, "one refresh for three callers");
  assert.equal(a.accessToken, b.accessToken);
  assert.equal(b.accessToken, c.accessToken);
  const second = (await rawRow()).refresh_token_enc;
  assert.notEqual(second, first, "the rotated refresh token replaced the spent one");

  // The spent one is refused at Xero; the stored one works.
  advance(29 * 60_000);
  await service.accessToken();
  assert.equal(xero.tokenCalls("refresh_token").length, calls + 2);
  assert.equal((await service.status()).connection.status, "connected");
});

test("a 401 from Xero refreshes once and retries", async () => {
  const { service } = await fresh();
  await connect(service);
  xero.expireAccessTokens();
  const calls = xero.tokenCalls("refresh_token").length;
  const result = await service.withAccessToken(async ({ accessToken, tenantId }) => {
    const http = createXeroHttp({ clientId: xero.clientId, clientSecret: xero.clientSecret, endpoints: xeroEndpoints(xero.base) });
    return http.accounting({ accessToken, tenantId, path: "/Accounts" });
  });
  assert.equal(result.Accounts[0].Code, "200");
  assert.equal(xero.tokenCalls("refresh_token").length, calls + 1);
});

test("a refresh Xero rejects marks the connection as needing the owner to connect again", async () => {
  const { service, advance, logs } = await fresh();
  await connect(service);
  xero.revokeAllRefreshTokens();
  advance(40 * 60_000);
  await assert.rejects(service.accessToken(), (error) => {
    assert.equal(error.code, "XERO_REFRESH_REJECTED");
    assert.equal(error.reconnect, true);
    return true;
  });
  const status = await service.status();
  assert.equal(status.connection.status, "needs_reconnect");
  assert.equal(status.connection.reconnectReason, "XERO_REFRESH_REJECTED");
  assert.match(status.connection.reconnectMessage, /Connect again/);
  await assert.rejects(service.accessToken(), (error) => error.code === "XERO_NOT_CONNECTED");
  assert.ok(logs.lines.some((line) => line.includes("XERO_REFRESH_REJECTED")));
  for (const line of logs.lines) for (const secret of xero.issuedSecrets()) assert.ok(!line.includes(secret), "no token in the log");

  // Connecting again keeps the organisation and its start.
  const { status: again } = await connect(service);
  assert.equal(again, "connected");
  assert.equal((await service.status()).settings.autoFrom, "2026-10-13T00:00:00.000Z");
});

test("a changed XERO_CLIENT_SECRET is recognised: the owner connects again", async () => {
  const { service, make } = await fresh();
  await connect(service);
  const changed = make(readXeroSecrets({ XERO_CLIENT_ID: xero.clientId, XERO_CLIENT_SECRET: "another-fake-secret" }));
  const status = await changed.status();
  assert.equal(status.connection.status, "needs_reconnect");
  assert.equal(status.connection.reconnectReason, "CLIENT_SECRET_CHANGED");
});

test("disconnect revokes the refresh token at Xero and forgets the tokens; the settings stay", async () => {
  const { service, rawRow } = await fresh();
  await connect(service);
  await service.updateSettings({ salesAccountCode: "4000", taxType: "output" }, { actor: "owner-1" });
  const revoked = xero.state.revoked.length;
  assert.deepEqual(await service.disconnect({ actor: "owner-1" }), { status: "disconnected" });
  assert.equal(xero.state.revoked.length, revoked + 1);
  const row = await rawRow();
  assert.equal(row.status, "disconnected");
  assert.equal(row.access_token_enc, null);
  assert.equal(row.refresh_token_enc, null);
  assert.equal(row.tenant_id, null);
  assert.equal(row.auto_from, null);
  const status = await service.status();
  assert.equal(status.settings.salesAccountCode, "4000");
  assert.equal(status.settings.taxType, "OUTPUT");
  await assert.rejects(service.accessToken(), (error) => error.code === "XERO_NOT_CONNECTED");
});

test("settings: the choices are checked, and turning Create in Xero off and on moves the start", async () => {
  const { service, advance } = await fresh();
  await assert.rejects(service.updateSettings({ createMode: "emailed" }), /createMode must be one of off, draft, authorised/);
  await assert.rejects(service.updateSettings({ salesAccountCode: "" }), (error) => error.code === "XERO_ACCOUNT_CODE_INVALID");
  await assert.rejects(service.updateSettings({ taxType: "GST on Income" }), (error) => error.code === "XERO_TAX_TYPE_INVALID");
  await connect(service);
  advance(60_000);
  assert.equal((await service.updateSettings({ createMode: "authorised" })).autoFrom, "2026-10-13T00:00:00.000Z", "draft to approved keeps the start");
  assert.equal((await service.updateSettings({ createMode: "off" })).autoFrom, null);
  advance(60_000);
  assert.equal((await service.updateSettings({ createMode: "draft" })).autoFrom, "2026-10-13T00:02:00.000Z", "invoices issued while it was off are not sent by themselves");
});

test("without the secrets, Connect explains what to set", async () => {
  await testDb?.close();
  testDb = await createTestDb();
  const service = createXeroConnectionService({
    db: testDb.db,
    orgUid: DEFAULT_ORG_UID,
    secrets: readXeroSecrets({}),
    http: () => { throw new Error("no HTTP without secrets"); },
  });
  const status = await service.status();
  assert.deepEqual(status.secrets, { clientIdSet: false, clientSecretSet: false });
  await assert.rejects(service.startConnect({ redirectUri: REDIRECT }), (error) => error.code === "XERO_SECRETS_MISSING" && error.statusCode === 409);
});
