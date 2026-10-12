// FIELD_DOCUMENT_REPLICA and the FIELD_R2_* settings (#240): off when unset,
// refused when anything is missing or malformed, refused in a Replit
// workspace, and no message ever carries a value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { replitPlacement } from "../runtime-config.js";
import { ReplicaConfigError, resolveDocumentReplicaConfig, resolveR2Connection } from "./r2-config.js";

const ACCESS = "AKIDQ7ZX93M2N8P4K6W1JHV5"; // gitleaks:allow (synthetic test credential)
const SECRET = "Zq9/xW4+vT7kP2mN8bR5yH3jL6dF1gC0"; // gitleaks:allow (synthetic test credential)
const GOOD = Object.freeze({
  FIELD_DOCUMENT_REPLICA: "r2",
  FIELD_R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  FIELD_R2_BUCKET: "example-documents",
  FIELD_R2_ACCESS_KEY_ID: ACCESS,
  FIELD_R2_SECRET_ACCESS_KEY: SECRET,
});

// No message contains a value, or any 6-character piece of one.
function assertNoValue(message, ...values) {
  for (const value of values) {
    for (let i = 0; i + 6 <= value.length; i += 1) {
      assert.ok(!message.includes(value.slice(i, i + 6)), `message leaks part of a value: ${message}`);
    }
  }
}

function refused(env, variable, pattern, values = []) {
  assert.throws(() => resolveDocumentReplicaConfig(env), (error) => {
    assert.ok(error instanceof ReplicaConfigError);
    assert.equal(error.variable, variable);
    assert.match(error.message, new RegExp(`^${variable}`));
    if (pattern) assert.match(error.message, pattern);
    assertNoValue(error.message, ACCESS, SECRET, "0123456789abcdef0123456789abcdef", ...values); // gitleaks:allow (synthetic test account id)
    return true;
  });
}

test("unset FIELD_DOCUMENT_REPLICA is off, whatever else is set", () => {
  assert.deepEqual(resolveDocumentReplicaConfig({}), { enabled: false });
  assert.deepEqual(resolveDocumentReplicaConfig({ ...GOOD, FIELD_DOCUMENT_REPLICA: "" }), { enabled: false });
  assert.deepEqual(resolveDocumentReplicaConfig({ FIELD_DOCUMENT_REPLICA: "  " }), { enabled: false });
});

test("r2 with all four settings is on, region auto", () => {
  const config = resolveDocumentReplicaConfig(GOOD);
  assert.equal(config.enabled, true);
  assert.equal(config.kind, "r2");
  assert.equal(config.placement, null);
  assert.deepEqual(config.connection, {
    endpoint: GOOD.FIELD_R2_ENDPOINT,
    bucket: "example-documents",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    region: "auto",
  });
  assert.equal(resolveDocumentReplicaConfig({ ...GOOD, FIELD_DOCUMENT_REPLICA: "R2" }).enabled, true);
  assert.equal(resolveDocumentReplicaConfig({ ...GOOD, FIELD_R2_ENDPOINT: `${GOOD.FIELD_R2_ENDPOINT}/` }).connection.endpoint, GOOD.FIELD_R2_ENDPOINT);
});

test("an unknown mode is refused", () => {
  refused({ ...GOOD, FIELD_DOCUMENT_REPLICA: "s3" }, "FIELD_DOCUMENT_REPLICA", /"r2" or unset/);
});

test("each missing setting is named, never valued", () => {
  for (const name of ["FIELD_R2_ENDPOINT", "FIELD_R2_BUCKET", "FIELD_R2_ACCESS_KEY_ID", "FIELD_R2_SECRET_ACCESS_KEY"]) {
    const env = { ...GOOD };
    delete env[name];
    refused(env, name, /is not set$/);
    refused({ ...GOOD, [name]: "   " }, name, /is not set$/);
  }
});

test("a malformed endpoint is refused without quoting it", () => {
  refused({ ...GOOD, FIELD_R2_ENDPOINT: "zzqq-not-a-url" }, "FIELD_R2_ENDPOINT", /not a URL/, ["zzqq-not-a-url"]);
  refused({ ...GOOD, FIELD_R2_ENDPOINT: "http://0123456789abcdef.r2.cloudflarestorage.com" }, "FIELD_R2_ENDPOINT", /https/);
  refused({ ...GOOD, FIELD_R2_ENDPOINT: `${GOOD.FIELD_R2_ENDPOINT}/example-documents` }, "FIELD_R2_ENDPOINT", /no path/);
  refused({ ...GOOD, FIELD_R2_ENDPOINT: `${GOOD.FIELD_R2_ENDPOINT}?x=1` }, "FIELD_R2_ENDPOINT", /no path or query/);
  refused({ ...GOOD, FIELD_R2_ENDPOINT: `https://${ACCESS}:${SECRET.replace(/[/+]/g, "")}@example.r2.cloudflarestorage.com` }, "FIELD_R2_ENDPOINT", /must not carry credentials/);
  // A local test server may be plain http.
  assert.equal(resolveR2Connection({ ...GOOD, FIELD_R2_ENDPOINT: "http://127.0.0.1:9000" }).endpoint, "http://127.0.0.1:9000");
  assert.equal(resolveR2Connection({ ...GOOD, FIELD_R2_ENDPOINT: "http://localhost:9000" }).endpoint, "http://localhost:9000");
});

test("a malformed bucket or credential is refused without quoting it", () => {
  for (const bucket of ["Field-Issued", "ab", "field_issued", "-field", "field.issued.documents"]) {
    refused({ ...GOOD, FIELD_R2_BUCKET: bucket }, "FIELD_R2_BUCKET", /not a valid bucket name/, bucket.length >= 6 ? [bucket] : []);
  }
  refused({ ...GOOD, FIELD_R2_ACCESS_KEY_ID: "short" }, "FIELD_R2_ACCESS_KEY_ID", /malformed/);
  refused({ ...GOOD, FIELD_R2_SECRET_ACCESS_KEY: `${SECRET} trailing` }, "FIELD_R2_SECRET_ACCESS_KEY", /malformed/);
  refused({ ...GOOD, FIELD_R2_SECRET_ACCESS_KEY: `${SECRET}\n` }, "FIELD_R2_SECRET_ACCESS_KEY", /malformed/);
  refused({ ...GOOD, FIELD_R2_ACCESS_KEY_ID: `${ACCESS}é` }, "FIELD_R2_ACCESS_KEY_ID", /malformed/);
});

test("where on Replit: published deployment, workspace, or not Replit", () => {
  assert.equal(replitPlacement({}), null);
  assert.equal(replitPlacement({ REPLIT_DEPLOYMENT: "1", FIELD_RUNTIME: "replit" }), "published");
  assert.equal(replitPlacement({ FIELD_RUNTIME: "replit" }), "workspace");
  assert.equal(replitPlacement({ REPL_ID: "abc" }), "workspace");
  assert.equal(replitPlacement({ FIELD_RUNTIME: "replit", REPLIT_DEPLOYMENT: "0" }), "workspace");
});

test("the Replit workspace runs with the replica off and one warning, unless FIELD_R2_ALLOW_WORKSPACE=1; the published app replicates", () => {
  for (const env of [
    { ...GOOD, FIELD_RUNTIME: "replit" },
    { ...GOOD, REPL_ID: "workspace-id" },
    { ...GOOD, FIELD_RUNTIME: "replit", FIELD_R2_ALLOW_WORKSPACE: "yes" },
    // A shared value with nothing else: still starts, nothing is read.
    { FIELD_DOCUMENT_REPLICA: "r2", FIELD_RUNTIME: "replit" },
    // Even with a malformed secret: the workspace never reads it.
    { ...GOOD, FIELD_RUNTIME: "replit", FIELD_R2_SECRET_ACCESS_KEY: "bad value" },
  ]) {
    const config = resolveDocumentReplicaConfig(env);
    assert.equal(config.enabled, false);
    assert.equal(config.placement, "workspace");
    assert.equal(config.connection, undefined, "no R2 connection exists in the workspace");
    assert.match(config.warning, /^FIELD_DOCUMENT_REPLICA=r2 is ignored in the Replit workspace.*locked.*until its retention ends.*nothing is written to R2.*FIELD_R2_ALLOW_WORKSPACE=1/);
    assertNoValue(config.warning, ACCESS, SECRET, "0123456789abcdef0123456789abcdef"); // gitleaks:allow (synthetic test account id)
  }
  const allowed = resolveDocumentReplicaConfig({ ...GOOD, FIELD_RUNTIME: "replit", FIELD_R2_ALLOW_WORKSPACE: "1" });
  assert.equal(allowed.enabled, true);
  assert.equal(allowed.placement, "workspace");
  const published = resolveDocumentReplicaConfig({ ...GOOD, FIELD_RUNTIME: "replit", REPLIT_DEPLOYMENT: "1" });
  assert.equal(published.enabled, true);
  assert.equal(published.placement, "published");
});

test("the published app still refuses to boot with the replica on and a setting missing or malformed", () => {
  const published = { ...GOOD, FIELD_RUNTIME: "replit", REPLIT_DEPLOYMENT: "1" };
  for (const name of ["FIELD_R2_ENDPOINT", "FIELD_R2_BUCKET", "FIELD_R2_ACCESS_KEY_ID", "FIELD_R2_SECRET_ACCESS_KEY"]) {
    const env = { ...published };
    delete env[name];
    refused(env, name, /is not set$/);
  }
  refused({ ...published, FIELD_R2_SECRET_ACCESS_KEY: `${SECRET} x` }, "FIELD_R2_SECRET_ACCESS_KEY", /malformed/);
  refused({ ...published, FIELD_R2_ENDPOINT: "http://example.r2.cloudflarestorage.com" }, "FIELD_R2_ENDPOINT", /https/);
});
