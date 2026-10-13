// Encryption at rest for the Xero OAuth tokens (#93).
//
// Field stored no credential encrypted before this: Gmail's refresh tokens are
// a mode-0600 file in the data directory (server/gmail-oauth-store.js), and
// docs/PRICING_ENGINE.md plans `oauth_tokens` "with the refresh token
// encrypted at rest". The Xero tokens live in PostgreSQL (xero_connections),
// so they are encrypted before they reach it:
//
//   - AES-256-GCM, a fresh 12-byte IV per value, and the organisation and the
//     column as additional data, so a value copied to another row or column
//     does not decrypt;
//   - the key is derived with HKDF-SHA256 from XERO_CLIENT_SECRET, a
//     deployment secret that never reaches the database. A database dump or
//     backup alone does not give the tokens;
//   - `fingerprint` (HMAC of a fixed label) is stored beside the tokens, so a
//     changed client secret is recognised and the owner is asked to connect
//     again, instead of Field failing to decrypt with an unclear error.
//
// Values are `v1.<iv>.<ciphertext>.<tag>` in base64url. Errors never quote a
// value.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const INFO = "field xero oauth tokens v1";
const SALT = "field/xero/token-crypto";

export class TokenCryptoError extends Error {
  constructor(message, code = "TOKEN_DECRYPT_FAILED") {
    super(message);
    this.name = "TokenCryptoError";
    this.code = code;
  }
}

function b64(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

/**
 * The cipher for one organisation, keyed from the Xero client secret. Throws
 * when there is no secret: nothing is stored unencrypted.
 */
export function createTokenCipher({ clientSecret, orgUid }) {
  const secret = typeof clientSecret === "string" ? clientSecret : "";
  if (!secret) throw new TokenCryptoError("XERO_CLIENT_SECRET is not set: Xero tokens cannot be stored", "XERO_SECRET_MISSING");
  if (!orgUid) throw new TokenCryptoError("the token cipher needs the organisation", "TOKEN_CIPHER_INVALID");
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(SALT), Buffer.from(INFO), 32));
  const fingerprint = createHmac("sha256", key).update("field xero key fingerprint").digest("hex").slice(0, 16);
  const aad = (column) => Buffer.from(`${orgUid}:${column}`, "utf8");

  return {
    fingerprint,

    /** Encrypt one value for one column of this organisation's row. */
    encrypt(plaintext, column) {
      if (typeof plaintext !== "string" || !plaintext) throw new TokenCryptoError("nothing to encrypt", "TOKEN_CIPHER_INVALID");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(column));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return `${VERSION}.${b64(iv)}.${b64(ciphertext)}.${b64(cipher.getAuthTag())}`;
    },

    /** Decrypt a value written by `encrypt` for the same column. */
    decrypt(value, column) {
      const parts = typeof value === "string" ? value.split(".") : [];
      if (parts.length !== 4 || parts[0] !== VERSION) throw new TokenCryptoError("a stored Xero token is not in the expected format");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
        decipher.setAAD(aad(column));
        decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw new TokenCryptoError("a stored Xero token could not be decrypted with this XERO_CLIENT_SECRET");
      }
    },
  };
}
