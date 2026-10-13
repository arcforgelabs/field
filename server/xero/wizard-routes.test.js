// The Connect Xero wizard over HTTP against the real server, with no
// FIELD_SECRETS_KEY set and synthetic data: every new route is owner-only
// (403 for staff and for API and MCP tokens, even with integrations:read) and
// answers no-store; the key-generated route takes no body; pending
// credentials are accepted only as well-formed fs1 values, with nothing
// key-like beside them; and no key or plain credential reaches a response,
// the audit history or the server's log. Promotion once the key is set is
// in server/secrets/setup.test.js.
import assert from "node:assert/strict";
import test from "node:test";
import { boot } from "../../scripts/quote-invoice-proof/email-test-server.mjs";
import { SEALED_VALUE, generateSecretsKey, sealForServer } from "../../shared/secrets-web.js";

const PUBLIC_URL = "https://field.example.invalid";
const OWNER = { email: "proof.sender@example.invalid", password: "email-documents-test-password" };
const STAFF = { email: "staff.member@example.invalid", password: "xero-wizard-staff-password", role: "user", name: "Staff Member" };
const CLIENT_ID = "0123456789ABCDEF".repeat(2);
const CLIENT_SECRET = ["fake", "xero", "wizard", "secret"].join("-").padEnd(48, "y");

test("Connect Xero wizard routes: owners only, no-store, fs1 values only, no key anywhere", { timeout: 300_000 }, async (t) => {
  const { api, signIn, output, base } = await boot(t, { extraUsers: [STAFF], config: { publicUrl: PUBLIC_URL } });
  const tokenOf = async ({ email, password }) => (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) })).json()).token;
  const ownerToken = await tokenOf(OWNER);
  const sent = [];
  const raw = async (token, path, { method = "GET", body, text } = {}) => {
    const payload = text ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload) sent.push(payload);
    const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { "content-type": "application/json" } : {}) }, body: payload });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json().catch(() => null) };
  };
  const owner = (path, options) => raw(ownerToken, path, options);
  const staff = await signIn(STAFF.email, STAFF.password);

  const first = await api("/api/integrations/xero");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.secretsKey.configured, false);
  assert.equal(first.body.secretsKey.problem, "SECRETS_KEY_MISSING");
  assert.equal(first.body.appUrl, PUBLIC_URL);
  assert.equal(first.body.setup.step, null);
  const orgUid = first.body.setup.orgUid;
  assert.ok(orgUid);

  const key = generateSecretsKey();
  const sealed = await sealForServer({ keyBytes: key.bytes, orgUid, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
  const pendingBody = { keyId: sealed.keyId, clientId: sealed.values.client_id, clientSecret: sealed.values.client_secret };

  const routes = [
    ["POST", "/api/integrations/secrets-key/generated"],
    ["POST", "/api/integrations/xero/setup/step", { step: "app" }],
    ["PUT", "/api/integrations/xero/pending-credentials", pendingBody],
    ["DELETE", "/api/integrations/xero/pending-credentials"],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await raw(null, path, { method, body })).status, 401, `${method} ${path} without a sign-in`);
    assert.equal((await staff(path, { method, body })).status, 403, `${method} ${path} as staff`);
  }
  const machine = async (permissions) => {
    const created = await api("/api/users", { method: "POST", body: { email: `robot-${permissions.length}@example.invalid`, name: "Robot", kind: "service", role: "user", permissions } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return (await api(`/api/users/${created.body.user.id}/tokens`, { method: "POST", body: { label: "test" } })).body.token;
  };
  for (const token of [await machine([]), await machine(["integrations:read"])]) {
    for (const [method, path, body] of routes) {
      const answer = await raw(token, path, { method, body });
      assert.equal(answer.status, 403, `${method} ${path} with a machine token`);
      assert.equal(answer.body.code, "INTEGRATIONS_FORBIDDEN");
    }
  }
  const asStaff = await staff("/api/integrations/xero");
  assert.equal(asStaff.body.setup, null, "the wizard is for owners");
  assert.equal(asStaff.body.secretsKey.configured, false, "staff see only whether the key is set");

  // The key-generated route: an audit event, no body, never cached.
  const generated = await owner("/api/integrations/secrets-key/generated", { method: "POST" });
  assert.deepEqual([generated.status, generated.cache], [200, "no-store"]);
  for (const body of [{ key: key.text }, { secretsKey: key.text }, { value: "x" }]) {
    const refused = await owner("/api/integrations/secrets-key/generated", { method: "POST", body });
    assert.deepEqual([refused.status, refused.body.code, refused.cache], [400, "SECRETS_KEY_BODY_REFUSED", "no-store"]);
  }

  const step = await owner("/api/integrations/xero/setup/step", { method: "POST", body: { step: "app" } });
  assert.deepEqual([step.status, step.cache, step.body.setup.step], [200, "no-store", "app"]);
  assert.equal((await owner("/api/integrations/xero/setup/step", { method: "POST", body: { step: "app", key: key.text } })).status, 400);
  assert.equal((await owner("/api/integrations/xero/setup/step", { method: "POST", body: { step: "connect" } })).status, 400);
  assert.equal((await owner("/api/integrations/xero/credentials", { method: "PUT", body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } })).status, 409, "without a key the server never takes plain credentials");

  // Pending credentials: only the key id and the two fs1 values.
  const malformed = [
    { ...pendingBody, clientSecret: CLIENT_SECRET },
    { ...pendingBody, key: key.text },
    { ...pendingBody, secretsKey: key.text },
    { keyId: sealed.keyId, clientId: sealed.values.client_id },
    { ...pendingBody, keyId: "000000000000" },
    { ...pendingBody, clientId: "fs1.not.a.real.value" },
  ];
  for (const body of malformed) {
    const refused = await owner("/api/integrations/xero/pending-credentials", { method: "PUT", body });
    assert.equal(refused.status, 400, JSON.stringify(Object.keys(body)));
    assert.equal(refused.body.code, "PENDING_INVALID");
  }
  const stored = await owner("/api/integrations/xero/pending-credentials", { method: "PUT", body: pendingBody });
  assert.deepEqual([stored.status, stored.cache], [200, "no-store"], JSON.stringify(stored.body));
  assert.equal(stored.body.setup.step, "key");
  assert.equal(stored.body.setup.pending.keyId, sealed.keyId);
  const waiting = await api("/api/integrations/xero");
  assert.equal(waiting.body.setup.pending.keyId, sealed.keyId);
  assert.equal(waiting.body.credentials.source, null, "nothing readable until the key is deployed");
  const actions = waiting.body.history.map((event) => event.action);
  for (const action of ["secrets_key_generated", "setup_step", "pending_credentials_stored"]) assert.ok(actions.includes(action), actions.join(","));

  const restarted = await owner("/api/integrations/xero/pending-credentials", { method: "DELETE" });
  assert.deepEqual([restarted.status, restarted.cache, restarted.body.setup.pending, restarted.body.setup.step], [200, "no-store", null, "app"]);

  // What was sent to the server: the accepted body held only the key id and fs1 values.
  assert.deepEqual(Object.keys(pendingBody).sort(), ["clientId", "clientSecret", "keyId"]);
  assert.ok(SEALED_VALUE.test(pendingBody.clientId) && SEALED_VALUE.test(pendingBody.clientSecret));
  const accepted = sent.filter((payload) => payload.includes(sealed.values.client_secret) && !payload.includes("\"key\"") && !payload.includes("secretsKey") && !payload.includes(CLIENT_SECRET));
  assert.ok(accepted.length > 0);
  for (const payload of accepted) assert.ok(!payload.includes(key.text));

  // Nothing key-like or plain comes back, or reaches the log.
  const answers = JSON.stringify([first.body, stored.body, waiting.body, restarted.body]);
  const log = output.join("");
  for (const secret of [key.text, CLIENT_SECRET, CLIENT_ID]) {
    assert.ok(!answers.includes(secret), "no key or credential in a response");
    assert.ok(!log.includes(secret), "no key or credential in the server log");
  }
});
