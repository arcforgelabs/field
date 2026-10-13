// The key that encrypts every integration secret Field stores (#112):
// integration credentials (an app's client id and client secret) and OAuth
// tokens, per organisation, in PostgreSQL.
//
//   FIELD_SECRETS_KEY           the current key: 32 random bytes, base64 or hex
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
import { createHash } from "node:crypto";

export class SecretsKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecretsKeyError";
    this.code = code;
  }
}

function decodeKey(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(text)) {
    const bytes = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length === 32) return bytes;
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
  SECRETS_KEY_INVALID: "FIELD_SECRETS_KEY is not 32 bytes in base64 or hex, so Field cannot store or read integration credentials (docs/INTEGRATIONS.md).",
  SECRETS_KEY_PREVIOUS_INVALID: "FIELD_SECRETS_KEY_PREVIOUS holds a value that is not a 32-byte key in base64 or hex (docs/INTEGRATIONS.md).",
  SECRETS_KEY_UNKNOWN: "A stored secret was written with a key Field does not have now. Put the earlier key in FIELD_SECRETS_KEY_PREVIOUS, or enter the credentials and connect again.",
  SECRET_UNREADABLE: "A stored secret could not be decrypted with its key.",
});
