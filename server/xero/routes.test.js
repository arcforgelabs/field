// Settings, Integrations, Xero over HTTP against the real server (#93, #112),
// with a fake Xero (fake-xero.js) and synthetic data: the screen is
// read-only for anyone who is not an owner, and every route that changes
// anything refuses them; the owner enters the Xero app's credentials in
// Settings (no XERO_CLIENT_ID or XERO_CLIENT_SECRET in the environment), and
// they are write-only; the callback acts only on a state an owner started;
// and no credential or token reaches a response or the server's log.
import assert from "node:assert/strict";
import test from "node:test";
import { boot } from "../../scripts/quote-invoice-proof/email-test-server.mjs";
import { TEST_SECRETS_KEY } from "../secrets/test-keyring.js";
import { startFakeXero } from "./fake-xero.js";

const PUBLIC_URL = "https://field.example.invalid";
const STAFF = { email: "staff.member@example.invalid", password: "xero-routes-staff-password", role: "user", name: "Staff Member" };

test("Xero settings: owners change it, others read it, credentials are write-only, and no secret leaves the server", { timeout: 300_000 }, async (t) => {
  const xero = await startFakeXero();
  t.after(() => xero.close());
  const { api, signIn, output, base } = await boot(t, {
    extraUsers: [STAFF],
    config: { publicUrl: PUBLIC_URL },
    env: { FIELD_SECRETS_KEY: TEST_SECRETS_KEY, FIELD_XERO_FAKE_BASE_URL: xero.base },
  });
  const staff = await signIn(STAFF.email, STAFF.password);
  const anonymous = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status };
  };

  const writeRoutes = [
    ["POST", "/api/integrations/xero/connect"],
    ["POST", "/api/integrations/xero/organisation", { tenantId: "x" }],
    ["POST", "/api/integrations/xero/disconnect"],
    ["PUT", "/api/integrations/xero/settings", { createMode: "off" }],
    ["PUT", "/api/integrations/xero/credentials", { clientId: "staff-client-id-0001", clientSecret: "staff-client-secret-0001" }],
    ["DELETE", "/api/integrations/xero/credentials"],
    ["GET", "/api/integrations/xero/codes"],
  ];
  for (const [method, path, body] of [...writeRoutes, ["GET", "/api/integrations/xero"]]) {
    assert.equal((await anonymous(path, { method, body })).status, 401, `${method} ${path} without a sign-in`);
  }
  for (const [method, path, body] of writeRoutes) {
    assert.equal((await staff(path, { method, body })).status, 403, `${method} ${path} as staff`);
  }
  const readOnly = await staff("/api/integrations/xero");
  assert.equal(readOnly.status, 200, "staff read the screen");
  assert.equal(readOnly.body.canManage, false);
  assert.equal(readOnly.body.credentials.settings.clientSecret.set, false, "staff's attempt changed nothing");

  const first = await api("/api/integrations/xero");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.canManage, true);
  assert.equal(first.body.secretsKey.configured, true);
  assert.equal(first.body.credentials.source, null);
  assert.equal(first.body.credentials.environmentOverride, false);
  assert.equal(first.body.redirectUri, `${PUBLIC_URL}/api/integrations/xero/callback`);
  assert.equal((await api("/api/integrations/xero/connect", { method: "POST" })).status, 409, "no credentials yet: Connect is refused");

  // The owner enters the Xero app's credentials: write-only.
  const saved = await api("/api/integrations/xero/credentials", { method: "PUT", body: { clientId: xero.clientId, clientSecret: xero.clientSecret } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(!JSON.stringify(saved.body).includes(xero.clientSecret) && !JSON.stringify(saved.body).includes(xero.clientId), "never sent back");
  const afterSave = await api("/api/integrations/xero");
  assert.equal(afterSave.body.credentials.source, "settings");
  assert.equal(afterSave.body.credentials.settings.clientSecret.set, true);
  assert.equal(afterSave.body.credentials.settings.clientSecret.setBy, "Proof Operator");
  assert.equal(afterSave.body.history[0].action, "credentials_set");
  assert.equal(afterSave.body.history[0].actor, "Proof Operator");
  assert.equal((await api("/api/integrations/xero/credentials", { method: "PUT", body: { clientId: "x", clientSecret: "" } })).status, 400);

  // A callback with a state no owner started does nothing.
  const forged = await fetch(`${base}/api/integrations/xero/callback?code=fake-code&state=forged`, { redirect: "manual" });
  assert.equal(forged.status, 302);
  assert.equal(forged.headers.get("location"), "/#/settings?section=integrations&xero=error&code=XERO_STATE_INVALID");
  const cancelled = await fetch(`${base}/api/integrations/xero/callback?error=access_denied&state=x`, { redirect: "manual" });
  assert.equal(cancelled.headers.get("location"), "/#/settings?section=integrations&xero=error&code=XERO_ACCESS_DENIED");

  // Connect with the stored credentials: Field's sign-in address, Xero's consent, the callback.
  const connect = await api("/api/integrations/xero/connect", { method: "POST" });
  assert.equal(connect.status, 200, JSON.stringify(connect.body));
  assert.ok(connect.body.url.startsWith(`${xero.base}/identity/connect/authorize?`));
  const back = await xero.authorize(connect.body.url);
  assert.equal(`${back.origin}${back.pathname}`, `${PUBLIC_URL}/api/integrations/xero/callback`);
  // A guessed callback while the owner is at Xero changes nothing.
  const guessed = await fetch(`${base}/api/integrations/xero/callback?code=fake-code&state=guessed`, { redirect: "manual" });
  assert.equal(guessed.headers.get("location"), "/#/settings?section=integrations&xero=error&code=XERO_STATE_INVALID");
  const callback = await fetch(`${base}${back.pathname}${back.search}`, { redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/#/settings?section=integrations&xero=connected");
  const connected = await api("/api/integrations/xero");
  assert.equal(connected.body.connection.status, "connected");
  assert.equal(connected.body.connection.tenantName, "Synthetic Earthworks Pty Ltd");
  const seenByStaff = await staff("/api/integrations/xero");
  assert.equal(seenByStaff.body.connection.status, "connected", "staff see the status");
  for (const body of [connected.body, seenByStaff.body]) {
    for (const secret of xero.issuedSecrets()) assert.ok(!JSON.stringify(body).includes(secret), "no token or secret in the screen's data");
    assert.ok(!JSON.stringify(body).includes(xero.clientId));
  }

  const savedSettings = await api("/api/integrations/xero/settings", { method: "PUT", body: { createMode: "authorised", salesAccountCode: "4000", taxType: "OUTPUT" } });
  assert.equal(savedSettings.status, 200, JSON.stringify(savedSettings.body));
  assert.equal(savedSettings.body.settings.createMode, "authorised");
  assert.equal((await api("/api/integrations/xero/settings", { method: "PUT", body: { salesAccountCode: "not a code!" } })).status, 400);

  // Removing the credentials disconnects first, and both are audited.
  const removed = await api("/api/integrations/xero/credentials", { method: "DELETE" });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const end = await api("/api/integrations/xero");
  assert.equal(end.body.connection.status, "disconnected");
  assert.equal(end.body.credentials.settings.clientSecret.set, false);
  const actions = end.body.history.map((event) => event.action);
  for (const action of ["credentials_set", "connected", "disconnected", "credentials_removed"]) assert.ok(actions.includes(action), actions.join(","));

  const log = output.join("");
  for (const secret of xero.issuedSecrets()) assert.ok(!log.includes(secret), "no token, code or secret in the server log");
  assert.ok(!log.includes(xero.clientId) && !log.includes(TEST_SECRETS_KEY), "no client id or key in the server log");
});
