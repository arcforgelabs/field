// Encrypts one organisation's secrets for one integration (#112).
//
// AES-256-GCM, a fresh 12-byte nonce for every value, and the organisation,
// the integration and the field as additional data: a value copied to
// another organisation, integration or field does not decrypt. A value is
// `fs1.<key id>.<nonce>.<ciphertext>.<tag>` (base64url), so the key that
// wrote it is known and rotation can read old values and rewrite them.
// Errors carry a code, never a value or a key.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MESSAGES, SecretsKeyError } from "./keyring.js";

const VERSION = "fs1";

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");

/** Whether a stored value is in this module's format (not an older one). */
export function isSealed(value) {
  return typeof value === "string" && value.startsWith(`${VERSION}.`);
}

/** The id of the key that wrote a sealed value, or null. */
export function sealedKeyId(value) {
  return isSealed(value) ? value.split(".")[1] || null : null;
}

export function createSecretBox({ keyring, orgUid, integration }) {
  if (!keyring || !orgUid || !integration) throw new Error("a secret box needs the keyring, the organisation and the integration");
  const aad = (field) => Buffer.from(`${orgUid}\0${integration}\0${field}`, "utf8");

  return {
    available: keyring.available,

    /** Encrypt with the current key. Throws when there is none (fail closed). */
    seal(plaintext, field) {
      if (typeof plaintext !== "string" || !plaintext) throw new SecretsKeyError("SECRET_EMPTY", "nothing to encrypt");
      const key = keyring.currentKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(field));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return `${VERSION}.${keyring.currentId}.${b64(iv)}.${b64(ciphertext)}.${b64(cipher.getAuthTag())}`;
    },

    /** Decrypt with the key that wrote it (current or previous). Throws when it is not on the keyring. */
    open(value, field) {
      if (!keyring.available) throw new SecretsKeyError(keyring.problem || "SECRETS_KEY_MISSING", MESSAGES[keyring.problem] || MESSAGES.SECRETS_KEY_MISSING);
      const parts = typeof value === "string" ? value.split(".") : [];
      if (parts.length !== 5 || parts[0] !== VERSION) throw new SecretsKeyError("SECRET_UNREADABLE", MESSAGES.SECRET_UNREADABLE);
      const key = keyring.key(parts[1]);
      if (!key) throw new SecretsKeyError("SECRETS_KEY_UNKNOWN", MESSAGES.SECRETS_KEY_UNKNOWN);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64url"));
        decipher.setAAD(aad(field));
        decipher.setAuthTag(Buffer.from(parts[4], "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretsKeyError("SECRET_UNREADABLE", MESSAGES.SECRET_UNREADABLE);
      }
    },

    /** Whether a value was written with an older key (rotation rewrites it). */
    isStale(value) {
      return keyring.available && isSealed(value) && sealedKeyId(value) !== keyring.currentId;
    },
  };
}
