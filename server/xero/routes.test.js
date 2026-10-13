// Settings, Integrations, Xero over HTTP against the real server (#93), with
// a fake Xero (fake-xero.js) and synthetic data: every route is for owners
// only, the callback acts only on a state an owner started, the screen shows
// whether each secret is set and this installation's redirect address but
// never a secret or a token, and no token reaches the server's log.
import assert from "node:assert/strict";
import test from "node:test";
import { boot } from "../../scripts/quote-invoice-proof/email-test-server.mjs";
import { startFakeXero } from "./fake-xero.js";

const PUBLIC_URL = "https://field.example.invalid";
const STAFF = { email: "staff.member@example.invalid", password: "xero-routes-staff-password", role: "user", name: "Staff Member" };

test("Xero settings routes: owners only, the callback needs the owner's state, and no secret leaves the server", { timeout: 300_000 }, async (t) => {
  const xero = await startFakeXero();
  t.after(() => xero.close());
  const { api, signIn, output, base } = await boot(t, {
    extraUsers: [STAFF],
    config: { publicUrl: PUBLIC_URL },
    env: { XERO_CLIENT_ID: xero.clientId, XERO_CLIENT_SECRET: xero.clientSecret, FIELD_XERO_FAKE_BASE_URL: xero.base },
  });
  const staff = await signIn(STAFF.email, STAFF.password);
  const anonymous = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status };
  };

  const ownerRoutes = [
    ["GET", "/api/integrations/xero"],
    ["POST", "/api/integrations/xero/connect"],
    ["POST", "/api/integrations/xero/organisation", { tenantId: "x" }],
    ["POST", "/api/integrations/xero/disconnect"],
    ["PUT", "/api/integrations/xero/settings", { createMode: "off" }],
  ];
  for (const [method, path, body] of ownerRoutes) {
    assert.equal((await anonymous(path, { method, body })).status, 401, `${method} ${path} without a sign-in`);
    assert.equal((await staff(path, { method, body })).status, 403, `${method} ${path} as staff`);
  }

  const first = await api("/api/integrations/xero");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.secrets, { clientIdSet: true, clientSecretSet: true });
  assert.equal(first.body.redirectUri, `${PUBLIC_URL}/api/integrations/xero/callback`);
  assert.equal(first.body.publicUrlConfigured, true);
  assert.equal(first.body.connection.status, "disconnected");
  assert.equal(first.body.settings.createMode, "draft");
  assert.ok(!JSON.stringify(first.body).includes(xero.clientSecret), "the secret never reaches the browser");
  assert.ok(!JSON.stringify(first.body).includes(xero.clientId), "nor the client id: only whether it is set");

  // A callback with a state no owner started does nothing.
  const forged = await fetch(`${base}/api/integrations/xero/callback?code=fake-code&state=forged`, { redirect: "manual" });
  assert.equal(forged.status, 302);
  assert.equal(forged.headers.get("location"), "/#/settings?section=integrations&xero=error&code=XERO_STATE_INVALID");
  const cancelled = await fetch(`${base}/api/integrations/xero/callback?error=access_denied&state=x`, { redirect: "manual" });
  assert.equal(cancelled.headers.get("location"), "/#/settings?section=integrations&xero=error&code=XERO_ACCESS_DENIED");
  assert.equal((await api("/api/integrations/xero")).body.connection.status, "disconnected");

  // Connect: Field's sign-in address, Xero's consent, the callback.
  const connect = await api("/api/integrations/xero/connect", { method: "POST" });
  assert.equal(connect.status, 200, JSON.stringify(connect.body));
  assert.ok(connect.body.url.startsWith(`${xero.base}/identity/connect/authorize?`));
  const back = await xero.authorize(connect.body.url);
  // A guessed callback while the owner is at Xero changes nothing.
  const guessed = await fetch(`${base}/api/integrations/xero/callback?code=fake-code&state=guessed`, { redirect: "manual" });
  assert.equal(guessed.headers.get("location"), "/#/settings?section=integrations&xero=error&code=XERO_STATE_INVALID");
  assert.equal(`${back.origin}${back.pathname}`, `${PUBLIC_URL}/api/integrations/xero/callback`);
  const callback = await fetch(`${base}${back.pathname}${back.search}`, { redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/#/settings?section=integrations&xero=connected");
  const connected = await api("/api/integrations/xero");
  assert.equal(connected.body.connection.status, "connected");
  assert.equal(connected.body.connection.tenantName, "Synthetic Earthworks Pty Ltd");
  for (const secret of xero.issuedSecrets()) assert.ok(!JSON.stringify(connected.body).includes(secret), "no token in the screen's data");

  const saved = await api("/api/integrations/xero/settings", { method: "PUT", body: { createMode: "authorised", salesAccountCode: "4000", taxType: "OUTPUT" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.createMode, "authorised");
  const refused = await api("/api/integrations/xero/settings", { method: "PUT", body: { salesAccountCode: "not a code!" } });
  assert.equal(refused.status, 400);

  const disconnected = await api("/api/integrations/xero/disconnect", { method: "POST" });
  assert.equal(disconnected.status, 200);
  assert.equal((await api("/api/integrations/xero")).body.connection.status, "disconnected");

  const log = output.join("");
  for (const secret of xero.issuedSecrets()) assert.ok(!log.includes(secret), "no token, code or secret in the server log");
});
