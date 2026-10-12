// Prefixed ULIDs for document rows (docs/PRICING_ENGINE.md "Identity"):
// `doc_01JB8Z…` for an issued document, `dev_01JB8Z…` for a document event.
// 48 bits of milliseconds then 80 random bits, in Crockford base 32.
//
// The random part comes from Web Crypto (getRandomValues), not
// crypto.randomBytes. The quote/invoice proof's deterministic preload replaces
// randomBytes and randomUUID with one seeded sequence; drawing from it here
// would shift every later id in a proof run and break the byte comparison
// against a checkout without these tables.
import { webcrypto } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const DOCUMENT_UID_PREFIX = "doc_";
export const DOCUMENT_EVENT_UID_PREFIX = "dev_";

function encodeTime(ms) {
  let value = Math.max(0, Math.floor(ms));
  let out = "";
  for (let index = 0; index < 10; index += 1) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom() {
  const bytes = webcrypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (let index = 0; index < 16; index += 1) out += ALPHABET[bytes[index] % 32];
  return out;
}

export function ulid(now = Date.now()) {
  return encodeTime(now) + encodeRandom();
}

export function newDocumentUid(now) {
  return `${DOCUMENT_UID_PREFIX}${ulid(now)}`;
}

export function newDocumentEventUid(now) {
  return `${DOCUMENT_EVENT_UID_PREFIX}${ulid(now)}`;
}

export function isDocumentUid(value) {
  return typeof value === "string" && /^doc_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
