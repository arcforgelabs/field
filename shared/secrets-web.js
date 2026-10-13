// The browser's half of FIELD_SECRETS_KEY setup (#126 follow-up): the Connect
// Xero wizard makes the key in the browser and encrypts the Xero app's
// credentials with it before anything is sent, so the key never reaches the
// server and the client secret never sits on the server unencrypted.
//
// It uses only WebCrypto (globalThis.crypto), so the same module runs in the
// browser and in Node's tests. A value it seals is exactly what
// server/secrets/box.js writes and reads:
//
//   fs1.<key id>.<nonce>.<ciphertext>.<tag>     (each part base64url, no padding)
//
//   key id  the first 12 hex characters of SHA-256("field-secrets-key-id\0" + key)
//           (keyring.js secretsKeyId)
//   nonce   12 random bytes
//   cipher  AES-256-GCM, 16-byte tag, additional data
//           "<organisation uid>\0<integration>\0<field>"
//
// Nothing here logs, stores or sends the key. The caller keeps the key bytes
// only as long as it shows them, and wipes them (`wipe`) when it is done.

const VERSION = "fs1";
const KEY_BYTES = 32;
const KEY_ID_LABEL = "field-secrets-key-id\0";
const encoder = new TextEncoder();

/** A sealed value in the fs1 format, with nothing else around it. */
export const SEALED_VALUE = /^fs1\.[0-9a-f]{12}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{2,600}\.[A-Za-z0-9_-]{22}$/;
/** A key id: 12 hex characters. */
export const KEY_ID = /^[0-9a-f]{12}$/;

function webCrypto() {
  const found = globalThis.crypto;
  if (!found?.subtle || typeof found.getRandomValues !== "function") throw new Error("This browser cannot make a key (WebCrypto is not available).");
  return found;
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes from the browser, and the same in base64 (44 characters): the value for FIELD_SECRETS_KEY. */
export function generateSecretsKey() {
  const bytes = new Uint8Array(KEY_BYTES);
  webCrypto().getRandomValues(bytes);
  return { bytes, text: toBase64(bytes) };
}

/** The key's id, as keyring.js works it out. Safe to send and show. */
export async function secretsKeyIdOf(keyBytes) {
  const label = encoder.encode(KEY_ID_LABEL);
  const input = new Uint8Array(label.length + keyBytes.length);
  input.set(label, 0);
  input.set(keyBytes, label.length);
  const digest = new Uint8Array(await webCrypto().subtle.digest("SHA-256", input));
  input.fill(0);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/**
 * Seal each of `values` ({ field: plaintext }) for one organisation and
 * integration with the key, as box.js would. Returns { keyId, values } with
 * every value in the fs1 format.
 */
export async function sealForServer({ keyBytes, orgUid, integration, values }) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== KEY_BYTES) throw new Error("The key must be 32 bytes.");
  if (!orgUid || !integration) throw new Error("Sealing needs the organisation and the integration.");
  const subtle = webCrypto().subtle;
  const keyId = await secretsKeyIdOf(keyBytes);
  const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const out = {};
  for (const [field, plaintext] of Object.entries(values)) {
    if (typeof plaintext !== "string" || !plaintext) throw new Error(`Nothing to encrypt for ${field}.`);
    const iv = new Uint8Array(12);
    webCrypto().getRandomValues(iv);
    const sealed = new Uint8Array(await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(`${orgUid}\0${integration}\0${field}`), tagLength: 128 },
      key,
      encoder.encode(plaintext),
    ));
    // WebCrypto appends the 16-byte tag to the ciphertext; fs1 keeps them apart.
    const ciphertext = sealed.slice(0, sealed.length - 16);
    const tag = sealed.slice(sealed.length - 16);
    out[field] = `${VERSION}.${keyId}.${toBase64Url(iv)}.${toBase64Url(ciphertext)}.${toBase64Url(tag)}`;
  }
  return { keyId, values: out };
}

/** Whether `value` is a well-formed fs1 value, written with `keyId` when one is given. */
export function isWellFormedSealed(value, keyId = null) {
  if (typeof value !== "string" || !SEALED_VALUE.test(value)) return false;
  return keyId == null || value.split(".")[1] === keyId;
}

/** Overwrite key bytes once they are no longer needed. */
export function wipe(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}
