// The integration secrets module (#112): AES-256-GCM under FIELD_SECRETS_KEY,
// bound to the organisation, integration and field; a missing, malformed or
// unknown key fails closed; rotation reads with FIELD_SECRETS_KEY_PREVIOUS
// and writes with the current key; values are stored per organisation,
// write-only, with audit events; and no value reaches an error, Sentry or
// the MCP surface.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hkdfSync } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { scrubEvent } from "../../shared/sentry-scrub.js";
import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createSecretBox, isSealed, sealedKeyId } from "./box.js";
import { createCredentialStore } from "./credentials.js";
import { loadSecretsKeyring, secretsKeyId } from "./keyring.js";
import { OTHER_SECRETS_KEY, TEST_SECRETS_KEY, testKeyring } from "./test-keyring.js";

const ORG = DEFAULT_ORG_UID;
const ORG_B = "org_01TESTSECONDORGANISATION0";
const VALUE = "fake-client-secret-value-0001";

function messages(error) {
  let text = "";
  for (let inner = error; inner; inner = inner.cause) text += ` ${inner.message} ${inner.code || ""}`;
  return text;
}

test("a value round-trips, with a fresh nonce, the key's id, and no plain text", () => {
  const box = createSecretBox({ keyring: testKeyring(), orgUid: ORG, integration: "xero" });
  const sealed = box.seal(VALUE, "client_secret");
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes(VALUE));
  assert.notEqual(sealed, box.seal(VALUE, "client_secret"), "a fresh nonce every time");
  assert.equal(sealedKeyId(sealed), testKeyring().currentId);
  assert.equal(sealedKeyId(sealed), secretsKeyId(Buffer.from(TEST_SECRETS_KEY, "base64")));
  assert.equal(box.open(sealed, "client_secret"), VALUE);
});

test("a value moved to another organisation, integration or field does not decrypt", () => {
  const keyring = testKeyring();
  const sealed = createSecretBox({ keyring, orgUid: ORG, integration: "xero" }).seal(VALUE, "client_secret");
  assert.throws(() => createSecretBox({ keyring, orgUid: ORG_B, integration: "xero" }).open(sealed, "client_secret"), (error) => error.code === "SECRET_UNREADABLE");
  assert.throws(() => createSecretBox({ keyring, orgUid: ORG, integration: "other" }).open(sealed, "client_secret"), (error) => error.code === "SECRET_UNREADABLE");
  assert.throws(() => createSecretBox({ keyring, orgUid: ORG, integration: "xero" }).open(sealed, "client_id"), (error) => error.code === "SECRET_UNREADABLE");
});

test("a missing, malformed or wrong key fails closed, and errors never quote a value or a key", () => {
  const sealed = createSecretBox({ keyring: testKeyring(), orgUid: ORG, integration: "xero" }).seal(VALUE, "client_secret");
  const missing = loadSecretsKeyring({});
  assert.deepEqual([missing.available, missing.problem], [false, "SECRETS_KEY_MISSING"]);
  assert.throws(() => createSecretBox({ keyring: missing, orgUid: ORG, integration: "xero" }).seal(VALUE, "client_secret"), (error) => error.code === "SECRETS_KEY_MISSING");
  assert.throws(() => createSecretBox({ keyring: missing, orgUid: ORG, integration: "xero" }).open(sealed, "client_secret"), (error) => error.code === "SECRETS_KEY_MISSING");
  for (const bad of ["too-short", "a39characterstringisnotlongenoughforkey", Buffer.alloc(16, 1).toString("base64")]) {
    const keyring = loadSecretsKeyring({ FIELD_SECRETS_KEY: bad });
    assert.deepEqual([keyring.available, keyring.problem], [false, "SECRETS_KEY_INVALID"], bad);
  }
  assert.equal(loadSecretsKeyring({ FIELD_SECRETS_KEY: TEST_SECRETS_KEY, FIELD_SECRETS_KEY_PREVIOUS: "nope" }).available, false, "a bad previous key fails closed too");
  const wrong = loadSecretsKeyring({ FIELD_SECRETS_KEY: OTHER_SECRETS_KEY });
  assert.throws(() => createSecretBox({ keyring: wrong, orgUid: ORG, integration: "xero" }).open(sealed, "client_secret"), (error) => {
    assert.equal(error.code, "SECRETS_KEY_UNKNOWN");
    const text = messages(error);
    assert.ok(!text.includes(VALUE) && !text.includes(TEST_SECRETS_KEY) && !text.includes(OTHER_SECRETS_KEY));
    return true;
  });
  // A hex key works as well as base64.
  assert.equal(loadSecretsKeyring({ FIELD_SECRETS_KEY: Buffer.alloc(32, 3).toString("hex") }).available, true);
  assert.equal(JSON.stringify(testKeyring().status()).includes(TEST_SECRETS_KEY), false, "the status names the key's id, never the key");
});

test("a generated password of 40 or more characters is a key (HKDF-SHA256); base64 and hex keys are unchanged", () => {
  // Made at runtime, so secret scanners do not flag a fixture as a real key.
  const password = ["field", "test", "generated", "password"].join("-").padEnd(41, "7");
  assert.equal(password.length, 41);
  const keyring = loadSecretsKeyring({ FIELD_SECRETS_KEY: password });
  assert.equal(keyring.available, true);
  // The same derivation every time, so values stay readable across restarts.
  const expected = Buffer.from(hkdfSync("sha256", Buffer.from(password, "utf8"), "field-secrets-v1", "field-secrets-v1", 32));
  assert.equal(keyring.currentId, secretsKeyId(expected));
  assert.deepEqual(keyring.currentKey(), expected);
  const sealed = createSecretBox({ keyring, orgUid: ORG, integration: "xero" }).seal(VALUE, "client_secret");
  const again = createSecretBox({ keyring: loadSecretsKeyring({ FIELD_SECRETS_KEY: `  ${password}\n` }), orgUid: ORG, integration: "xero" });
  assert.equal(again.open(sealed, "client_secret"), VALUE, "surrounding whitespace is ignored");
  // Keys already in use keep their bytes and their ids.
  assert.equal(testKeyring().currentId, secretsKeyId(Buffer.from(TEST_SECRETS_KEY, "base64")));
  const hex = Buffer.alloc(32, 3).toString("hex");
  assert.equal(loadSecretsKeyring({ FIELD_SECRETS_KEY: hex }).currentId, secretsKeyId(Buffer.from(hex, "hex")));
  // A password works as a previous key, for rotation.
  const rotated = createSecretBox({ keyring: loadSecretsKeyring({ FIELD_SECRETS_KEY: TEST_SECRETS_KEY, FIELD_SECRETS_KEY_PREVIOUS: password }), orgUid: ORG, integration: "xero" });
  assert.equal(rotated.open(sealed, "client_secret"), VALUE);
  // A mistyped base64 key (padded, but not 32 bytes) is refused, not taken as a password.
  assert.equal(loadSecretsKeyring({ FIELD_SECRETS_KEY: `${TEST_SECRETS_KEY.slice(0, -4)}xx==` }).problem, "SECRETS_KEY_INVALID");
  // Shorter strings are refused, with a message that says what to use.
  const short = loadSecretsKeyring({ FIELD_SECRETS_KEY: password.slice(0, 39) });
  assert.deepEqual([short.available, short.problem], [false, "SECRETS_KEY_INVALID"]);
  assert.throws(() => short.currentKey(), (error) => /at least 40 characters/.test(error.message) && !error.message.includes(password.slice(0, 39)));
});

test("rotation: values written with the previous key are read with it and rewritten with the current one", () => {
  const old = createSecretBox({ keyring: testKeyring(), orgUid: ORG, integration: "xero" });
  const sealed = old.seal(VALUE, "client_secret");
  const rotated = createSecretBox({ keyring: loadSecretsKeyring({ FIELD_SECRETS_KEY: OTHER_SECRETS_KEY, FIELD_SECRETS_KEY_PREVIOUS: TEST_SECRETS_KEY }), orgUid: ORG, integration: "xero" });
  assert.equal(rotated.isStale(sealed), true);
  assert.equal(rotated.open(sealed, "client_secret"), VALUE);
  const resealed = rotated.seal(rotated.open(sealed, "client_secret"), "client_secret");
  assert.equal(rotated.isStale(resealed), false);
  assert.equal(sealedKeyId(resealed), secretsKeyId(Buffer.from(OTHER_SECRETS_KEY, "base64")));
});

test("the credential store: per organisation, write-only status, audit events without values, and rotation", async () => {
  const t = await createTestDb();
  try {
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    const store = createCredentialStore({ db: t.db, orgUid: ORG, keyring: testKeyring() });
    const storeB = createCredentialStore({ db: t.db, orgUid: ORG_B, keyring: testKeyring() });
    await store.set("xero", { client_id: "FAKECLIENTID000000000000", client_secret: VALUE }, { actor: "Owner Person" });
    await store.set("xero", { client_secret: "fake-client-secret-value-0002" }, { actor: "Owner Person" });
    assert.deepEqual(await store.read("xero"), { client_id: "FAKECLIENTID000000000000", client_secret: "fake-client-secret-value-0002" });
    assert.deepEqual(await storeB.read("xero"), {}, "another organisation stores its own");
    const status = await store.status("xero", ["client_id", "client_secret"]);
    assert.deepEqual(Object.keys(status.client_secret).sort(), ["set", "setAt", "setBy"]);
    assert.equal(status.client_secret.setBy, "Owner Person");
    const raw = await withOrg(t.db, ORG, (tx) => queryRows(sql`select value_enc from integration_credentials`, tx));
    assert.ok(raw.every((row) => !row.value_enc.includes("fake-client-secret")), "no plain text in the database");
    await store.remove("xero", { actor: "Owner Person" });
    const events = await withOrg(t.db, ORG, (tx) => queryRows(sql`select action, actor, details from integration_audit_events order by at, uid`, tx));
    assert.deepEqual(events.map((event) => event.action), ["credentials_set", "credentials_replaced", "credentials_removed"]);
    assert.ok(!JSON.stringify(events).includes("fake-client-secret") && !JSON.stringify(events).includes("FAKECLIENTID"));
    await assert.rejects(withOrg(t.db, ORG, (tx) => tx.execute(sql`delete from integration_audit_events`)), (error) => /append-only|permission denied/.test(messages(error)));

    // Rotation: written with the old key, rewrapped at boot with the new one.
    await store.set("xero", { client_secret: VALUE }, { actor: "Owner Person" });
    const rotated = createCredentialStore({ db: t.db, orgUid: ORG, keyring: loadSecretsKeyring({ FIELD_SECRETS_KEY: OTHER_SECRETS_KEY, FIELD_SECRETS_KEY_PREVIOUS: TEST_SECRETS_KEY }), logger: { log() {} } });
    assert.deepEqual(await rotated.rewrap(), { rewrapped: 1, unreadable: 0, changed: 0 });
    const onlyNew = createCredentialStore({ db: t.db, orgUid: ORG, keyring: loadSecretsKeyring({ FIELD_SECRETS_KEY: OTHER_SECRETS_KEY }) });
    assert.deepEqual(await onlyNew.read("xero"), { client_secret: VALUE }, "readable once the previous key is gone");
    // A Replace during a boot rotation is never overwritten by the rotation.
    await store.set("xero", { client_secret: "fake-client-secret-before-0003" }, { actor: "Owner Person" });
    const during = createCredentialStore({ db: t.db, orgUid: ORG, keyring: loadSecretsKeyring({ FIELD_SECRETS_KEY: OTHER_SECRETS_KEY, FIELD_SECRETS_KEY_PREVIOUS: TEST_SECRETS_KEY }), logger: { log() {} } });
    const replacing = createCredentialStore({ db: t.db, orgUid: ORG, keyring: loadSecretsKeyring({ FIELD_SECRETS_KEY: OTHER_SECRETS_KEY }) });
    const outcome = await during.rewrap({ beforeWrite: () => replacing.set("xero", { client_secret: "fake-client-secret-replaced-0004" }, { actor: "Owner Person" }) });
    assert.deepEqual(outcome, { rewrapped: 0, unreadable: 0, changed: 1 });
    assert.deepEqual(await onlyNew.read("xero"), { client_secret: "fake-client-secret-replaced-0004" }, "the owner's Replace stands");
    // The wrong key fails closed.
    await assert.rejects(store.read("xero"), (error) => error.code === "SECRETS_KEY_UNKNOWN");
  } finally {
    await t.close();
  }
});

test("Sentry never receives a credential: request bodies are dropped and credential keys redacted", () => {
  const event = scrubEvent({
    request: { url: "https://field.example.invalid/api/integrations/xero/credentials", data: { clientId: "FAKECLIENTID000000000000", clientSecret: VALUE } },
    extra: { clientSecret: VALUE, client_secret: VALUE, refreshToken: "fake-refresh-0001" },
    message: `refresh_token=fake-refresh-000123 client_secret=${VALUE}`,
  });
  assert.ok(!JSON.stringify(event).includes(VALUE));
  assert.ok(!JSON.stringify(event).includes("fake-refresh-000"));
});

test("the MCP surface never reaches integration secrets: no MCP module imports them", () => {
  const dir = join(import.meta.dirname, "../mcp");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".js"))) {
    const source = readFileSync(join(dir, name), "utf8");
    assert.ok(!/from\s+["'][^"']*(secrets\/|xero\/|integration)/.test(source), `${name} imports integration secrets`);
    assert.ok(!/integration_credentials|xero_connections/.test(source), `${name} reads integration tables`);
  }
});
