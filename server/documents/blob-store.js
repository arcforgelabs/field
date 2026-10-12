// Document bytes, by SHA-256 (#223). The only reader and writer of
// `document_blobs`, behind two calls:
//
//   put(bytes, { tx, contentType }) -> sha256
//   get(sha256, { tx })             -> Buffer, or null when it is not stored
//
// The PostgreSQL store writes inside the caller's organisation transaction, so
// a document row and its bytes commit together. Object storage with Object
// Lock (S3, R2) can replace it behind the same two calls: put would upload
// before the row's transaction (an unreferenced blob is harmless, because
// blobs are content-addressed and immutable) and ignore `tx`.
//
// get() always re-hashes what it read; bytes that do not match their hash are
// an error, never served.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";

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
