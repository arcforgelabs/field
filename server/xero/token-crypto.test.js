// Xero tokens are encrypted at rest (#93): AES-256-GCM under a key derived
// from XERO_CLIENT_SECRET, bound to the organisation and the column.
import assert from "node:assert/strict";
import test from "node:test";
import { createTokenCipher, TokenCryptoError } from "./token-crypto.js";

const ORG = "org_01M4NF6NV3HW3CCZB7NVB9B157";

test("a token round-trips, and the stored value does not contain it", () => {
  const cipher = createTokenCipher({ clientSecret: "fake-secret-a", orgUid: ORG });
  const stored = cipher.encrypt("fake-refresh-token-value", "refresh_token");
  assert.match(stored, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!stored.includes("fake-refresh-token-value"));
  assert.notEqual(stored, cipher.encrypt("fake-refresh-token-value", "refresh_token"), "a fresh IV every time");
  assert.equal(cipher.decrypt(stored, "refresh_token"), "fake-refresh-token-value");
});

test("a value moved to another column or organisation does not decrypt", () => {
  const cipher = createTokenCipher({ clientSecret: "fake-secret-a", orgUid: ORG });
  const stored = cipher.encrypt("fake-access", "access_token");
  assert.throws(() => cipher.decrypt(stored, "refresh_token"), TokenCryptoError);
  const other = createTokenCipher({ clientSecret: "fake-secret-a", orgUid: "org_01TESTSECONDORGANISATION0" });
  assert.throws(() => other.decrypt(stored, "access_token"), TokenCryptoError);
});

test("another client secret has another fingerprint and cannot decrypt; errors never quote the value", () => {
  const a = createTokenCipher({ clientSecret: "fake-secret-a", orgUid: ORG });
  const b = createTokenCipher({ clientSecret: "fake-secret-b", orgUid: ORG });
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
  const stored = a.encrypt("fake-token-xyz", "access_token");
  assert.throws(() => b.decrypt(stored, "access_token"), (error) => {
    assert.equal(error.code, "TOKEN_DECRYPT_FAILED");
    assert.ok(!error.message.includes(stored) && !error.message.includes("fake-token-xyz") && !error.message.includes("fake-secret"));
    return true;
  });
  assert.throws(() => a.decrypt("not-a-token", "access_token"), TokenCryptoError);
});

test("without XERO_CLIENT_SECRET nothing can be stored", () => {
  assert.throws(() => createTokenCipher({ clientSecret: "", orgUid: ORG }), (error) => error.code === "XERO_SECRET_MISSING");
});
