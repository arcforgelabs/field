import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  googleServiceAccountAuthOptions,
  googleServiceAccountCacheId,
  hasGoogleServiceAccountKey,
  loadGoogleServiceAccountCredentials,
  resolveGoogleServiceAccountKeySource,
} from "./google-service-account.js";

// Synthetic, non-functional key material.
const KEY = { type: "service_account", client_email: "field@example.iam.gserviceaccount.com", private_key: "not-a-real-key" };

test("no key configured", () => {
  assert.equal(resolveGoogleServiceAccountKeySource({}, { env: {} }), null);
  assert.equal(hasGoogleServiceAccountKey({}, { env: {} }), false);
  assert.equal(loadGoogleServiceAccountCredentials({}, { env: {} }), null);
  assert.equal(googleServiceAccountAuthOptions({}, { env: {} }), null);
});

test("a key file path still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "field-sa-"));
  try {
    const path = join(dir, "service-account.json");
    await writeFile(path, JSON.stringify(KEY));
    const config = { googleServiceAccountKey: path };
    assert.deepEqual(resolveGoogleServiceAccountKeySource(config, { env: {} }), { kind: "file", value: path });
    assert.deepEqual(loadGoogleServiceAccountCredentials(config, { env: {} }), KEY);
    assert.deepEqual(googleServiceAccountAuthOptions(config, { env: {} }), { keyFile: path });
    assert.equal(googleServiceAccountCacheId(config, { env: {} }), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inline key JSON in GOOGLE_SERVICE_ACCOUNT_KEY wins over config", () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_KEY: `  ${JSON.stringify(KEY)}\n` };
  const config = { googleServiceAccountKey: "/does/not/exist.json" };
  assert.equal(resolveGoogleServiceAccountKeySource(config, { env }).kind, "inline");
  assert.deepEqual(loadGoogleServiceAccountCredentials(config, { env }), KEY);
  assert.deepEqual(googleServiceAccountAuthOptions(config, { env }), { credentials: KEY });
});

test("inline key in config as a string or an object", () => {
  for (const googleServiceAccountKey of [JSON.stringify(KEY), KEY]) {
    const config = { googleServiceAccountKey };
    assert.equal(hasGoogleServiceAccountKey(config, { env: {} }), true);
    assert.deepEqual(loadGoogleServiceAccountCredentials(config, { env: {} }), KEY);
  }
});

test("inline key cache id is a short hash, never key material", () => {
  const id = googleServiceAccountCacheId({ googleServiceAccountKey: JSON.stringify(KEY) }, { env: {} });
  assert.match(id, /^inline:[0-9a-f]{16}$/);
  assert.ok(!id.includes("not-a-real-key"));
});

test("invalid inline key fails without echoing the value", () => {
  assert.throws(
    () => loadGoogleServiceAccountCredentials({ googleServiceAccountKey: '{"private_key": "do-not-log' }, { env: {} }),
    (err) => {
      assert.match(err.message, /not valid JSON/);
      assert.ok(!err.message.includes("do-not-log"));
      return true;
    }
  );
});
