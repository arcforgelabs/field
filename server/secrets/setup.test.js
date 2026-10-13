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

test("stale pending credentials never overwrite newer ones (pending under K, B deployed, newer credentials, then K as previous)", async () => {
  const t = await createTestDb();
  try {
    const k = generateSecretsKey();
    const b = generateSecretsKey();
    const sealed = await sealForServer({ keyBytes: k.bytes, orgUid: ORG, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    await setupFor(t.db, loadSecretsKeyring({})).storePending({ keyId: sealed.keyId, values: sealed.values }, { actor: "Owner Person" });

    // B is deployed: the pending values were written with K, so they wait.
    const withB = loadSecretsKeyring({ FIELD_SECRETS_KEY: b.text });
    assert.equal((await setupFor(t.db, withB).state()).problem, "PENDING_KEY_MISMATCH");

    // The owner enters newer credentials (PUT /credentials): pending goes in the same transaction.
    const NEWER = "newer-synthetic-client-secret-0000000000000000";
    await createCredentialStore({ db: t.db, orgUid: ORG, keyring: withB, now }).set("xero", { client_id: CLIENT_ID, client_secret: NEWER }, { actor: "Owner Person" });
    const afterPut = await setupFor(t.db, withB).state();
    assert.deepEqual([afterPut.pending, afterPut.problem], [null, null]);

    // K is added as the previous key, and Field boots: nothing is overwritten.
    const both = loadSecretsKeyring({ FIELD_SECRETS_KEY: b.text, FIELD_SECRETS_KEY_PREVIOUS: k.text });
    assert.deepEqual(await setupFor(t.db, both).promote(), { promoted: false });
    assert.equal((await createCredentialStore({ db: t.db, orgUid: ORG, keyring: both }).read("xero")).client_secret, NEWER);
    const events = await withOrg(t.db, ORG, (tx) => queryRows(sql`select action, details from integration_audit_events order by at, uid`, tx));
    assert.deepEqual(events.map((row) => row.action), ["pending_credentials_stored", "credentials_set", "pending_credentials_discarded"]);
    assert.equal(events[2].details.reason, "credentials_entered");
  } finally {
    await t.close();
  }
});

test("removing the credentials forgets pending ones too", async () => {
  const t = await createTestDb();
  try {
    const k = generateSecretsKey();
    const sealed = await sealForServer({ keyBytes: k.bytes, orgUid: ORG, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    await setupFor(t.db, loadSecretsKeyring({})).storePending({ keyId: sealed.keyId, values: sealed.values }, { actor: "Owner Person" });
    await createCredentialStore({ db: t.db, orgUid: ORG, keyring: loadSecretsKeyring({}), now }).remove("xero", { actor: "Owner Person" });
    assert.equal((await setupFor(t.db, loadSecretsKeyring({})).state()).pending, null);
    assert.equal((await setupFor(t.db, loadSecretsKeyring({ FIELD_SECRETS_KEY: k.text })).promote()).promoted, false);
  } finally {
    await t.close();
  }
});

test("promotion skips, and forgets, pending credentials older than the stored ones", async () => {
  const t = await createTestDb();
  try {
    const k = generateSecretsKey();
    const sealed = await sealForServer({ keyBytes: k.bytes, orgUid: ORG, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    await setupFor(t.db, loadSecretsKeyring({})).storePending({ keyId: sealed.keyId, values: sealed.values }, { actor: "Owner Person" });
    // Credentials written later some other way (not through the store, so the pending row stays).
    const withK = loadSecretsKeyring({ FIELD_SECRETS_KEY: k.text });
    const box = createSecretBox({ keyring: withK, orgUid: ORG, integration: "xero" });
    const LATER = "later-synthetic-client-secret-00000000000000000";
    const later = new Date(Date.UTC(2027, 0, 1));
    await withOrg(t.db, ORG, async (tx) => {
      for (const [field, value] of [["client_id", CLIENT_ID], ["client_secret", LATER]]) {
        const valueEnc = box.seal(value, field);
        await tx.execute(sql`insert into integration_credentials (integration, field, value_enc, key_id, set_at, set_by) values ('xero', ${field}, ${valueEnc}, ${withK.currentId}, ${later.toISOString()}, 'Owner Person')`);
      }
    });
    assert.deepEqual(await setupFor(t.db, withK).promote(), { promoted: false, discarded: true });
    assert.equal((await createCredentialStore({ db: t.db, orgUid: ORG, keyring: withK }).read("xero")).client_secret, LATER);
    assert.equal((await setupFor(t.db, withK).state()).pending, null);
    const [last] = await withOrg(t.db, ORG, (tx) => queryRows(sql`select action, details from integration_audit_events order by at desc, uid desc limit 1`, tx));
    assert.deepEqual([last.action, last.details.reason], ["pending_credentials_discarded", "newer_credentials"]);
  } finally {
    await t.close();
  }
});

test("pending credentials only replace a missing or unusable key, never a working one", async () => {
  const t = await createTestDb();
  try {
    const k = generateSecretsKey();
    const sealed = await sealForServer({ keyBytes: k.bytes, orgUid: ORG, integration: "xero", values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    const body = { keyId: sealed.keyId, values: sealed.values };
    const working = generateSecretsKey().text;
    // A working key with a wrong previous key: fix the previous key, never a new key.
    const previousWrong = loadSecretsKeyring({ FIELD_SECRETS_KEY: working, FIELD_SECRETS_KEY_PREVIOUS: "too-short" });
    assert.equal(previousWrong.problem, "SECRETS_KEY_PREVIOUS_INVALID");
    await assert.rejects(setupFor(t.db, previousWrong).storePending(body), (error) => error.code === "SECRETS_KEY_PREVIOUS_INVALID" && /fix FIELD_SECRETS_KEY_PREVIOUS/.test(error.message));
    await assert.rejects(setupFor(t.db, loadSecretsKeyring({ FIELD_SECRETS_KEY: working })).storePending(body), (error) => error.code === "SECRETS_KEY_SET");
    assert.equal((await setupFor(t.db, loadSecretsKeyring({})).state()).pending, null, "nothing stored");
    // An unusable value (too short) is replaced by the key made in the browser.
    const unusable = loadSecretsKeyring({ FIELD_SECRETS_KEY: "too-short" });
    assert.equal(unusable.problem, "SECRETS_KEY_INVALID");
    assert.equal((await setupFor(t.db, unusable).storePending(body)).pending.keyId, sealed.keyId);
  } finally {
    await t.close();
  }
});
