// The key that encrypts every integration secret Field stores (#112):
// integration credentials (an app's client id and client secret) and OAuth
// tokens, per organisation, in PostgreSQL.
//
//   FIELD_SECRETS_KEY           the current key: a random string of at least
//                               40 characters (a password manager's generator),
//                               or 32 random bytes in base64 or hex
//                               (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
//   FIELD_SECRETS_KEY_PREVIOUS  earlier keys, comma-separated: read with them,
//                               write with the current one (rotation, docs/INTEGRATIONS.md)
//
// It is a deployment secret of its own: never SESSION_SECRET, and never
// derived from an integration's credentials, so rotating an app's client
// secret loses nothing. Each key has an id (a hash of the key, never the
// key), stored with every value, so Field knows which key wrote it.
//
// Fails closed: without a usable FIELD_SECRETS_KEY nothing can be stored or
// read, and the integration shows that it needs setting up. Errors name the
// variable and a code, never a key or a value.
import { createHash, hkdfSync } from "node:crypto";

export class SecretsKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecretsKeyError";
    this.code = code;
  }
}

// A generated password (Bitwarden's generator, at least 40 characters) is
// accepted as well as raw key bytes: HKDF-SHA256 turns it into the 32-byte
// key. It must be random, not a memorable phrase: HKDF does not slow down
// guessing the way a password hash does, so the strength is the string's own.
export const MIN_KEY_STRING_LENGTH = 40;
const KEY_DERIVATION_LABEL = "field-secrets-v1";

function decodeKey(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  // 32 bytes in hex or base64 are used as they are, so keys made that way
  // keep their ids and every value they stored stays readable.
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(text)) {
    const bytes = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length === 32) return bytes;
    // Padding marks a base64 key (a password generator does not end in
    // "="): one that is not 32 bytes is a mistyped key, not a password.
    if (text.endsWith("=")) return false;
  }
  if (text.length >= MIN_KEY_STRING_LENGTH) {
    return Buffer.from(hkdfSync("sha256", Buffer.from(text, "utf8"), KEY_DERIVATION_LABEL, KEY_DERIVATION_LABEL, 32));
  }
  return false;
}

/** A key's id: 12 hex characters of a hash of it. Safe to store and show. */
export function secretsKeyId(key) {
  return createHash("sha256").update("field-secrets-key-id\0").update(key).digest("hex").slice(0, 12);
}

/**
 * The keyring from the environment. `available` is false (and `problem`
 * says why) when FIELD_SECRETS_KEY is missing or not 32 bytes, or when a
 * previous key is not; then nothing is encrypted or decrypted.
 */
export function loadSecretsKeyring(env = process.env) {
  const keys = new Map();
  let problem = null;
  const current = decodeKey(env.FIELD_SECRETS_KEY);
  if (current === null) problem = "SECRETS_KEY_MISSING";
  else if (current === false) problem = "SECRETS_KEY_INVALID";
  const currentId = current ? secretsKeyId(current) : null;
  if (current) keys.set(currentId, current);
  for (const part of String(env.FIELD_SECRETS_KEY_PREVIOUS || "").split(",")) {
    if (!part.trim()) continue;
    const previous = decodeKey(part);
    if (!previous) {
      problem = problem || "SECRETS_KEY_PREVIOUS_INVALID";
      continue;
    }
    keys.set(secretsKeyId(previous), previous);
  }
  const available = Boolean(current) && !problem;
  return Object.freeze({
    available,
    problem,
    currentId: available ? currentId : null,
    /** The key for an id, or null. */
    key(id) {
      return available ? keys.get(id) || null : null;
    },
    currentKey() {
      if (!available) throw new SecretsKeyError(problem || "SECRETS_KEY_MISSING", MESSAGES[problem] || MESSAGES.SECRETS_KEY_MISSING);
      return current;
    },
    /** What the owner's screen may show. */
    status() {
      return { configured: available, problem, keyId: available ? currentId : null, previousKeys: Math.max(0, keys.size - (current ? 1 : 0)) };
    },
  });
}

export const MESSAGES = Object.freeze({
  SECRETS_KEY_MISSING: "FIELD_SECRETS_KEY is not set, so Field cannot store or read integration credentials (docs/INTEGRATIONS.md).",
  SECRETS_KEY_INVALID: "FIELD_SECRETS_KEY is too short. Use a random string of at least 40 characters from a password generator, or 32 bytes in base64 or hex. Until then Field cannot store or read integration credentials (docs/INTEGRATIONS.md).",
  SECRETS_KEY_PREVIOUS_INVALID: "FIELD_SECRETS_KEY_PREVIOUS holds a value that is too short to be a key: each must be a random string of at least 40 characters, or 32 bytes in base64 or hex (docs/INTEGRATIONS.md).",
  SECRETS_KEY_UNKNOWN: "A stored secret was written with a key Field does not have now. Put the earlier key in FIELD_SECRETS_KEY_PREVIOUS, or enter the credentials and connect again.",
  SECRET_UNREADABLE: "A stored secret could not be decrypted with its key.",
});
