// Document bytes, by SHA-256 (#223). The only reader and writer of
// `document_blobs`, behind two calls:
//
//   put(bytes, { tx, contentType }) -> sha256
//   get(sha256, { tx })             -> Buffer, or null when it is not stored
//
// The PostgreSQL store writes inside the caller's organisation transaction, so
// a document row and its bytes commit together. PostgreSQL stays the store of
// record (#240): a locked R2 bucket holds a write-once replica, copied after
// the transaction commits (replicator.js), and createReplicaFallbackBlobStore
// reads from it only when PostgreSQL cannot give the bytes.
//
// get() always re-hashes what it read; bytes that do not match their hash are
// an error, never served.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { objectKeyFor } from "./r2-client.js";

const { documentBlobs } = schema;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export class DocumentBytesError extends Error {
  constructor(message, { code = "DOCUMENT_BYTES_MISMATCH" } = {}) {
    super(message);
    this.name = "DocumentBytesError";
    this.code = code;
  }
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new TypeError("document bytes must be a Buffer or Uint8Array");
}

export function createPostgresBlobStore({ now = () => new Date() } = {}) {
  return {
    kind: "postgres",
    async put(bytes, { tx, contentType = "application/pdf" } = {}) {
      if (!tx) throw new Error("the PostgreSQL blob store writes inside an organisation transaction");
      const buffer = asBuffer(bytes);
      if (!buffer.length) throw new Error("refusing to store an empty document");
      const sha256 = sha256Hex(buffer);
      await tx.insert(documentBlobs).values({
        sha256,
        byteLength: buffer.length,
        contentType,
        bytes: buffer,
        createdAt: now(),
      }).onConflictDoNothing({ target: [documentBlobs.orgUid, documentBlobs.sha256] });
      return sha256;
    },
    async get(sha256, { tx } = {}) {
      if (!tx) throw new Error("the PostgreSQL blob store reads inside an organisation transaction");
      const [row] = await tx.select({ bytes: documentBlobs.bytes }).from(documentBlobs)
        .where(eq(documentBlobs.sha256, String(sha256)));
      if (!row) return null;
      const bytes = asBuffer(row.bytes);
      if (sha256Hex(bytes) !== sha256) {
        throw new DocumentBytesError(`stored bytes for ${sha256} do not match their hash`);
      }
      return bytes;
    },
  };
}

/**
 * Reads PostgreSQL first and falls back to the R2 replica (#240) only when
 * PostgreSQL has no bytes for the hash, or bytes that fail it. Bytes from R2
 * are hashed before they are returned; a mismatch is an error, never served.
 * Writes go to PostgreSQL only (the replicator copies them after commit).
 * `get` needs `orgUid` (the object key is `<org_uid>/<sha256>`).
 */
export function createReplicaFallbackBlobStore({ primary = createPostgresBlobStore(), replica, logger = console }) {
  if (!replica) throw new Error("createReplicaFallbackBlobStore needs a replica");
  return {
    kind: `${primary.kind}+r2-fallback`,
    put: (bytes, options) => primary.put(bytes, options),
    async get(sha256, options = {}) {
      let primaryError = null;
      try {
        const bytes = await primary.get(sha256, options);
        if (bytes) return bytes;
      } catch (error) {
        if (!(error instanceof DocumentBytesError)) throw error;
        primaryError = error;
      }
      if (!options.orgUid) {
        if (primaryError) throw primaryError;
        return null;
      }
      const why = primaryError ? "failed their hash check" : "are missing";
      let bytes;
      try {
        bytes = await replica.get(objectKeyFor(options.orgUid, sha256));
      } catch (error) {
        logger.error(`[documents-replica] the PostgreSQL bytes for ${sha256} ${why}, and R2 could not be read (${error?.code || "error"})`);
        if (primaryError) throw primaryError;
        return null;
      }
      if (!bytes) {
        logger.error(`[documents-replica] the PostgreSQL bytes for ${sha256} ${why}, and R2 has no copy`);
        if (primaryError) throw primaryError;
        return null;
      }
      if (sha256Hex(bytes) !== sha256) {
        logger.error(`[documents-replica] INTEGRITY ALARM: the R2 copy of ${sha256} does not match its hash; not served`);
        throw new DocumentBytesError(`the R2 copy of ${sha256} does not match its hash`);
      }
      logger.warn(`[documents-replica] served ${sha256} from R2: the PostgreSQL bytes ${why}`);
      return bytes;
    },
  };
}
