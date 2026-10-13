// The Connect wizard's key and pending credentials: the browser's encryption
// module (shared/secrets-web.js, run here with Node's WebCrypto) writes what
// server/secrets/box.js reads; pending credentials are stored only as
// well-formed fs1 values, are promoted once FIELD_SECRETS_KEY is that key,
// and say so plainly when the deployed key is another one. No key or plain
// value reaches the database or an audit event.
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { generateSecretsKey, isWellFormedSealed, sealForServer, secretsKeyIdOf } from "../../shared/secrets-web.js";
import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createSecretBox } from "./box.js";
import { createCredentialStore } from "./credentials.js";
import { loadSecretsKeyring, secretsKeyId } from "./keyring.js";
import { createIntegrationSetup } from "./setup.js";
import { OTHER_SECRETS_KEY } from "./test-keyring.js";

const ORG = DEFAULT_ORG_UID;
// Made at runtime: synthetic, never a real Xero app's.
const CLIENT_ID = "0123456789ABCDEF".repeat(2);
const CLIENT_SECRET = ["fake", "xero", "client", "secret"].join("-").padEnd(48, "x");
const FIELDS = ["client_id", "client_secret"];
const quiet = { log() {}, warn() {} };

// Each audit event a second after the last, so their order is certain.
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 13) + (tick += 1) * 1000);

function setupFor(db, keyring) {
  return createIntegrationSetup({ db, orgUid: ORG, keyring, integration: "xero", fields: FIELDS, valid: (values) => FIELDS.every((field) => /^\S{8,200}$/.test(values[field])), now, logger: quiet });
}

test("a key made in the browser is 32 random bytes, 44 base64 characters, with the server's key id", async () => {
  const one = generateSecretsKey();
  const two = generateSecretsKey();
  assert.equal(one.text.length, 44);
  assert.match(one.text, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(one.text, "base64").length, 32);
  assert.notEqual(one.text, two.text);
  const keyring = loadSecretsKeyring({ FIELD_SECRETS_KEY: one.text });
  assert.equal(keyring.available, true, "the server takes it as it is");
  assert.equal(await secretsKeyIdOf(one.bytes), keyring.currentId);
  assert.equal(await secretsKeyIdOf(one.bytes), secretsKeyId(Buffer.from(one.bytes)));
});

test("what the browser seals, the server's box opens, bound to the organisation, integration and field", async () => {
  const key = generateSecretsKey();
  const sealed = await sealForServer({ keyBytes: key.bytes, orgUid: ORG, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
  for (const value of Object.values(sealed.values)) {
    assert.ok(isWellFormedSealed(value, sealed.keyId), value);
    assert.ok(!value.includes(CLIENT_SECRET) && !value.includes(CLIENT_ID) && !value.includes(key.text));
  }
  const keyring = loadSecretsKeyring({ FIELD_SECRETS_KEY: key.text });
  const box = createSecretBox({ keyring, orgUid: ORG, integration: "xero" });
  assert.equal(box.open(sealed.values.client_secret, "client_secret"), CLIENT_SECRET);
  assert.equal(box.open(sealed.values.client_id, "client_id"), CLIENT_ID);
  assert.throws(() => box.open(sealed.values.client_secret, "client_id"), (error) => error.code === "SECRET_UNREADABLE", "bound to the field");
  assert.throws(() => createSecretBox({ keyring, orgUid: "org_01TESTSECONDORGANISATION0", integration: "xero" }).open(sealed.values.client_secret, "client_secret"), (error) => error.code === "SECRET_UNREADABLE");
  // And what the server seals has the same shape.
  assert.ok(isWellFormedSealed(box.seal(CLIENT_SECRET, "client_secret"), keyring.currentId));
});

test("pending credentials: stored only as fs1 values while the key is missing, promoted once it is set", async () => {
  const t = await createTestDb();
  try {
    const key = generateSecretsKey();
    const missing = loadSecretsKeyring({});
    const before = setupFor(t.db, missing);
    await before.recordStep("app", { actor: "Owner Person" });
    assert.equal((await before.state()).step, "app");
    const sealed = await sealForServer({ keyBytes: key.bytes, orgUid: before.orgUid, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });

    // Malformed pending values are refused, and nothing is stored.
    const other = await sealForServer({ keyBytes: generateSecretsKey().bytes, orgUid: ORG, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    const refused = [
      { keyId: sealed.keyId, values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } },
      { keyId: sealed.keyId, values: { client_id: sealed.values.client_id } },
      { keyId: sealed.keyId, values: { ...sealed.values, key: key.text } },
      { keyId: sealed.keyId, values: { client_id: sealed.values.client_id, client_secret: other.values.client_secret } },
      { keyId: "not-a-key-id", values: sealed.values },
      { keyId: sealed.keyId, values: { client_id: `${sealed.values.client_id}.extra`, client_secret: sealed.values.client_secret } },
      { keyId: sealed.keyId, values: { client_id: sealed.values.client_id, client_secret: `v1.${sealed.values.client_secret.slice(4)}` } },
    ];
    for (const body of refused) {
      await assert.rejects(before.storePending(body, { actor: "Owner Person" }), (error) => error.code === "PENDING_INVALID", JSON.stringify(Object.keys(body.values)));
    }
    assert.equal((await before.state()).pending, null);

    const stored = await before.storePending({ keyId: sealed.keyId, values: sealed.values }, { actor: "Owner Person" });
    assert.equal(stored.step, "key");
    assert.deepEqual([stored.pending.keyId, stored.pending.fields, stored.problem], [sealed.keyId, FIELDS, null]);
    assert.equal((await before.promote()).promoted, false, "no key yet: nothing moves");

    // The owner republishes with the key: the pending credentials become the Xero app's credentials.
    const keyring = loadSecretsKeyring({ FIELD_SECRETS_KEY: key.text });
    const after = setupFor(t.db, keyring);
    assert.deepEqual(await after.promote(), { promoted: true });
    const state = await after.state();
    assert.deepEqual([state.step, state.pending, state.problem], ["connect", null, null]);
    const credentials = createCredentialStore({ db: t.db, orgUid: ORG, keyring });
    assert.deepEqual(await credentials.read("xero"), { client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    assert.equal((await credentials.status("xero", FIELDS)).client_secret.setBy, "Owner Person");
    await assert.rejects(after.storePending({ keyId: sealed.keyId, values: sealed.values }), (error) => error.code === "SECRETS_KEY_SET", "with a key, the server encrypts");

    await after.recordStep("done", { actor: "Owner Person" });
    assert.equal((await after.state()).step, null, "done ends the wizard");

    const events = await withOrg(t.db, ORG, (tx) => queryRows(sql`select action, actor, details from integration_audit_events order by at, uid`, tx));
    assert.deepEqual(events.map((event) => event.action), ["setup_step", "pending_credentials_stored", "credentials_set", "pending_credentials_promoted", "setup_step"]);
    const rows = JSON.stringify([events, await withOrg(t.db, ORG, (tx) => queryRows(sql`select * from integration_setup`, tx)), await withOrg(t.db, ORG, (tx) => queryRows(sql`select value_enc from integration_credentials`, tx))]);
    for (const secret of [key.text, CLIENT_SECRET, CLIENT_ID]) assert.ok(!rows.includes(secret), "no key or plain value in the database");
  } finally {
    await t.close();
  }
});

test("a deployed key that is not the generated one: the screen says so, and starting again clears it", async () => {
  const t = await createTestDb();
  try {
    const key = generateSecretsKey();
    const before = setupFor(t.db, loadSecretsKeyring({}));
    const sealed = await sealForServer({ keyBytes: key.bytes, orgUid: ORG, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    await before.storePending({ keyId: sealed.keyId, values: sealed.values }, { actor: "Owner Person" });
    await assert.rejects(before.recordStep("done"), (error) => error.code === "SETUP_PENDING");
    await assert.rejects(before.recordStep("key"), (error) => error.code === "SETUP_STEP_INVALID");

    const wrong = setupFor(t.db, loadSecretsKeyring({ FIELD_SECRETS_KEY: OTHER_SECRETS_KEY }));
    const state = await wrong.state();
    assert.equal(state.problem, "PENDING_KEY_MISMATCH");
    assert.equal(state.pending.keyId, sealed.keyId);
    const credentials = createCredentialStore({ db: t.db, orgUid: ORG, keyring: loadSecretsKeyring({ FIELD_SECRETS_KEY: OTHER_SECRETS_KEY }) });
    assert.deepEqual(await credentials.read("xero"), {}, "nothing promoted");

    const restarted = await wrong.discardPending({ actor: "Owner Person" });
    assert.deepEqual([restarted.step, restarted.pending, restarted.problem], ["app", null, null]);
    const actions = (await withOrg(t.db, ORG, (tx) => queryRows(sql`select action from integration_audit_events order by at, uid`, tx))).map((row) => row.action);
    assert.deepEqual(actions, ["pending_credentials_stored", "pending_credentials_discarded"]);
  } finally {
    await t.close();
  }
});
