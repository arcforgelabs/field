// The issue service (phase 3 step 2): every document a customer was
// issued, with its exact bytes and an append-only history.
//
//   recordIssuedDocument(input)   blob + issued_documents row + `issued` event,
//                                 in ONE organisation transaction
//   recordEvent(input)            one document_events row
//   readIssuedDocument(uid)       the row and its bytes, hash-checked
//   listJobDocuments(jobId)       a job's documents, each with its events
//   listEmailedInvoicesByJob()    every emailed invoice, by job, in one transaction
//
// A document is issued once, under its number. Recording the same number with
// the same bytes again is a no-op that returns the existing row, so a retried
// send or a second backfill run changes nothing. The same number with
// different bytes is refused (ISSUED_DOCUMENT_CONFLICT): an issued document
// never changes. Events carry an idempotency key for the same reason.
//
// Writes run in the organisation transaction of `db` (an orgScope, or a
// database plus `orgUid`), which is what row-level security reads.
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { DocumentBytesError, createPostgresBlobStore, sha256Hex } from "./blob-store.js";
import { isDocumentUid, newDocumentEventUid, newDocumentUid } from "./uid.js";
import { compareDocumentNumbers } from "../invoices/numbers.js";

const { issuedDocuments, documentEvents, documentBlobs, ISSUED_DOCUMENT_TYPES, ISSUED_DOCUMENT_SOURCES, DOCUMENT_EVENTS } = schema;

export class IssuedDocumentConflictError extends Error {
  constructor(message, { existing }) {
    super(message);
    this.name = "IssuedDocumentConflictError";
    this.code = "ISSUED_DOCUMENT_CONFLICT";
    this.statusCode = 409;
    this.existing = existing;
  }
}

function invalid(message) {
  const error = new Error(message);
  error.code = "ISSUED_DOCUMENT_INVALID";
  error.statusCode = 400;
  return error;
}

function toDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(`${label} is not a timestamp: ${JSON.stringify(value)}`);
  return date;
}

function positiveIntOrNull(value, label) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw invalid(`${label} must be a positive integer`);
  return number;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

export function documentFromRow(row) {
  return {
    uid: row.uid,
    jobId: row.jobId,
    documentType: row.documentType,
    number: row.number,
    quoteVersion: row.quoteVersion,
    revision: row.revision,
    issuedAt: iso(row.issuedAt),
    issuedBy: row.issuedBy,
    pdfSha256: row.pdfSha256,
    source: row.source,
    details: row.details || {},
    createdAt: iso(row.createdAt),
    createdBy: row.createdBy,
  };
}

export function eventFromRow(row) {
  return {
    uid: row.uid,
    issuedDocumentUid: row.issuedDocumentUid,
    jobId: row.jobId,
    documentType: row.documentType,
    event: row.event,
    at: iso(row.at),
    by: row.by,
    data: row.data || {},
  };
}

function normalizeEvent(input, defaults = {}) {
  const event = input.event;
  if (!DOCUMENT_EVENTS.includes(event)) throw invalid(`unknown document event: ${JSON.stringify(event)}`);
  const documentType = input.documentType ?? defaults.documentType;
  if (!ISSUED_DOCUMENT_TYPES.includes(documentType)) throw invalid(`unknown document type: ${JSON.stringify(documentType)}`);
  const jobId = textOrNull(String(input.jobId ?? defaults.jobId ?? ""));
  if (!jobId) throw invalid("a document event needs its job id");
  return {
    issuedDocumentUid: input.issuedDocumentUid ?? defaults.issuedDocumentUid ?? null,
    jobId,
    documentType,
    event,
    at: toDate(input.at ?? defaults.at, "event time"),
    by: textOrNull(input.by ?? null),
    data: input.data && typeof input.data === "object" ? input.data : {},
    idempotencyKey: textOrNull(input.idempotencyKey ?? null),
  };
}

/**
 * The issue service for one organisation. `db` is an orgScope, or a database
 * with `orgUid`. `blobs` is the byte store (blob-store.js).
 */
export function createIssuedDocumentService({
  db,
  orgUid = undefined,
  blobs = createPostgresBlobStore(),
  now = () => new Date(),
  // Called with the SHA-256s a write stored, after its transaction commits
  // (the R2 replicator, #12). Best effort: it is not awaited, and an error
  // in it never reaches the caller.
  onBlobsStored = null,
}) {
  if (!db) throw new Error("createIssuedDocumentService needs a database");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);

  function afterCommit(sha256s) {
    if (!onBlobsStored) return;
    try {
      Promise.resolve(onBlobsStored(sha256s)).catch(() => {});
    } catch {}
  }

  async function insertEvent(tx, event) {
    const createdAt = now();
    const [row] = await tx.insert(documentEvents).values({
      uid: newDocumentEventUid(createdAt.getTime()),
      ...event,
      createdAt,
    }).onConflictDoNothing({ target: [documentEvents.orgUid, documentEvents.idempotencyKey] }).returning();
    if (row) return { event: eventFromRow(row), created: true };
    const [existing] = await tx.select().from(documentEvents).where(eq(documentEvents.idempotencyKey, event.idempotencyKey));
    return { event: existing ? eventFromRow(existing) : null, created: false };
  }

  async function findByNumber(tx, documentType, number) {
    const [row] = await tx.select().from(issuedDocuments)
      .where(and(eq(issuedDocuments.documentType, documentType), eq(issuedDocuments.number, number)));
    return row || null;
  }

  function conflict(existing, sha256) {
    return new IssuedDocumentConflictError(
      `${existing.documentType} ${existing.number} was already issued with different bytes (${existing.pdfSha256.slice(0, 12)}…, now ${sha256.slice(0, 12)}…); an issued document never changes`,
      { existing: documentFromRow(existing) },
    );
  }

  return {
    orgUid: scope.orgUid,
    blobs,

    /**
     * Record an issued document: its bytes, its row and its `issued` event,
     * in one transaction. `events` are further events for the same document
     * (an `emailed` event with the delivery) written in that transaction too.
     * Returns { document, created, events }.
     */
    async recordIssuedDocument({
      jobId,
      documentType,
      number,
      quoteVersion = null,
      revision = null,
      pdfBytes,
      issuedAt,
      issuedBy = null,
      details = {},
      source,
      createdBy = null,
      contentType = "application/pdf",
      events = [],
    }) {
      if (!ISSUED_DOCUMENT_TYPES.includes(documentType)) throw invalid(`unknown document type: ${JSON.stringify(documentType)}`);
      if (!ISSUED_DOCUMENT_SOURCES.includes(source)) throw invalid(`unknown document source: ${JSON.stringify(source)}`);
      const cleanNumber = textOrNull(number);
      if (!cleanNumber) throw invalid("an issued document needs its number");
      const cleanJobId = textOrNull(String(jobId ?? ""));
      if (!cleanJobId) throw invalid("an issued document needs its job id");
      if (!pdfBytes || !pdfBytes.length) throw invalid("an issued document needs its bytes");
      const issued = toDate(issuedAt, "issuedAt");
      const row = {
        jobId: cleanJobId,
        documentType,
        number: cleanNumber,
        quoteVersion: positiveIntOrNull(quoteVersion, "quoteVersion"),
        revision: positiveIntOrNull(revision, "revision"),
        issuedAt: issued,
        issuedBy: textOrNull(issuedBy),
        source,
        details: details && typeof details === "object" ? details : {},
        createdBy: textOrNull(createdBy),
      };
      const result = await scope.transaction(async (tx) => {
        const sha256 = await blobs.put(pdfBytes, { tx, contentType });
        let existing = await findByNumber(tx, documentType, cleanNumber);
        let created = false;
        if (!existing) {
          const createdAt = now();
          const [inserted] = await tx.insert(issuedDocuments).values({
            uid: newDocumentUid(createdAt.getTime()),
            ...row,
            pdfSha256: sha256,
            createdAt,
          }).onConflictDoNothing({ target: [issuedDocuments.orgUid, issuedDocuments.documentType, issuedDocuments.number] }).returning();
          // Lost a race with another writer of the same number: compare with theirs.
          existing = inserted || await findByNumber(tx, documentType, cleanNumber);
          created = Boolean(inserted);
        }
        if (existing.pdfSha256 !== sha256) throw conflict(existing, sha256);
        const document = documentFromRow(existing);
        const recorded = [];
        recorded.push(await insertEvent(tx, normalizeEvent({
          event: "issued",
          at: existing.issuedAt,
          by: existing.issuedBy,
          data: { number: existing.number, pdfSha256: existing.pdfSha256, source: existing.source },
          idempotencyKey: `issued:${existing.uid}`,
        }, { issuedDocumentUid: existing.uid, jobId: existing.jobId, documentType })));
        for (const extra of events) {
          recorded.push(await insertEvent(tx, normalizeEvent(extra, {
            issuedDocumentUid: existing.uid,
            jobId: existing.jobId,
            documentType,
            at: existing.issuedAt,
          })));
        }
        return { document, created, events: recorded };
      });
      afterCommit([result.document.pdfSha256]);
      return result;
    },

    /** One event; a repeated idempotency key returns the first. */
    async recordEvent(input) {
      const event = normalizeEvent(input);
      return scope.transaction(async (tx) => {
        if (event.issuedDocumentUid) {
          const [owner] = await tx.select({ uid: issuedDocuments.uid }).from(issuedDocuments)
            .where(eq(issuedDocuments.uid, event.issuedDocumentUid));
          if (!owner) throw invalid(`no issued document ${event.issuedDocumentUid}`);
        }
        return insertEvent(tx, event);
      });
    },

    /**
     * Store bytes that were delivered under an issued document's number but
     * differ from what was issued (a resend rendered again), with the event
     * that records the delivery. Returns { sha256, event }.
     */
    async recordRedelivery({ issuedDocumentUid, pdfBytes, contentType = "application/pdf", event }) {
      const result = await scope.transaction(async (tx) => {
        const [owner] = await tx.select().from(issuedDocuments).where(eq(issuedDocuments.uid, issuedDocumentUid));
        if (!owner) throw invalid(`no issued document ${issuedDocumentUid}`);
        const sha256 = await blobs.put(pdfBytes, { tx, contentType });
        const recorded = await insertEvent(tx, normalizeEvent({
          ...event,
          data: { ...(event.data || {}), pdfSha256: sha256, issuedPdfSha256: owner.pdfSha256, bytesMatchIssued: sha256 === owner.pdfSha256 },
        }, { issuedDocumentUid: owner.uid, jobId: owner.jobId, documentType: owner.documentType }));
        return { sha256, ...recorded };
      });
      afterCommit([result.sha256]);
      return result;
    },

    async getIssuedDocument(uid) {
      if (!isDocumentUid(uid)) return null;
      const [row] = await scope.transaction((tx) => tx.select().from(issuedDocuments).where(eq(issuedDocuments.uid, uid)));
      return row ? documentFromRow(row) : null;
    },

    async findIssuedDocument({ documentType, number }) {
      const row = await scope.transaction((tx) => findByNumber(tx, documentType, String(number || "").trim()));
      return row ? documentFromRow(row) : null;
    },

    /**
     * The document and its exact bytes, or null when there is no such
     * document in this organisation. Bytes that are missing or do not match
     * the document's hash throw DocumentBytesError; they are never served.
     */
    async readIssuedDocument(uid) {
      if (!isDocumentUid(uid)) return null;
      return scope.transaction(async (tx) => {
        const [row] = await tx.select().from(issuedDocuments).where(eq(issuedDocuments.uid, uid));
        if (!row) return null;
        const bytes = await blobs.get(row.pdfSha256, { tx, orgUid: scope.orgUid });
        if (!bytes) throw new DocumentBytesError(`the bytes of ${row.uid} (${row.pdfSha256}) are not stored`, { code: "DOCUMENT_BYTES_MISSING" });
        if (sha256Hex(bytes) !== row.pdfSha256) throw new DocumentBytesError(`the bytes of ${row.uid} do not match its hash`);
        return { document: documentFromRow(row), bytes };
      });
    },

    /**
     * A job's issued documents (oldest first), each with its events and the
     * size of its stored bytes (null when the bytes are not stored here), and
     * events with no document.
     */
    async listJobDocuments(jobId) {
      return scope.transaction(async (tx) => {
        // By issue time, then type, then number by its period and sequence
        // (INV-2026-9-… before INV-2026-10-…), never by its text.
        const rows = (await tx.select().from(issuedDocuments).where(eq(issuedDocuments.jobId, String(jobId))))
          .sort((a, b) => new Date(a.issuedAt) - new Date(b.issuedAt)
            || a.documentType.localeCompare(b.documentType)
            || compareDocumentNumbers(a.number, b.number));
        const hashes = [...new Set(rows.map((row) => row.pdfSha256))];
        const sizes = new Map(hashes.length
          ? (await tx.select({ sha256: documentBlobs.sha256, byteLength: documentBlobs.byteLength }).from(documentBlobs)
            .where(inArray(documentBlobs.sha256, hashes))).map((blob) => [blob.sha256, Number(blob.byteLength)])
          : []);
        const events = await tx.select().from(documentEvents)
          .where(eq(documentEvents.jobId, String(jobId)))
          .orderBy(asc(documentEvents.at), asc(documentEvents.createdAt), asc(documentEvents.uid));
        const byDocument = new Map(rows.map((row) => [row.uid, []]));
        const unattached = [];
        for (const event of events) {
          const list = event.issuedDocumentUid ? byDocument.get(event.issuedDocumentUid) : null;
          (list || unattached).push(eventFromRow(event));
        }
        return {
          documents: rows.map((row) => ({ ...documentFromRow(row), byteLength: sizes.get(row.pdfSha256) ?? null, events: byDocument.get(row.uid) })),
          unattachedEvents: unattached,
        };
      });
    },

    /**
     * Every invoice with an `emailed` event, as a Map of job id to its
     * documents (each with its emailed events, oldest first). One transaction,
     * so a report over every job does not open one per job.
     */
    async listEmailedInvoicesByJob() {
      return scope.transaction(async (tx) => {
        const events = await tx.select().from(documentEvents)
          .where(and(eq(documentEvents.documentType, "invoice"), eq(documentEvents.event, "emailed")))
          .orderBy(asc(documentEvents.at), asc(documentEvents.createdAt), asc(documentEvents.uid));
        const uids = [...new Set(events.map((event) => event.issuedDocumentUid).filter(Boolean))];
        const rows = uids.length ? await tx.select().from(issuedDocuments).where(inArray(issuedDocuments.uid, uids)) : [];
        const byDocument = new Map(rows.map((row) => [row.uid, []]));
        for (const event of events) byDocument.get(event.issuedDocumentUid)?.push(eventFromRow(event));
        const byJob = new Map();
        for (const row of rows.sort((a, b) => new Date(a.issuedAt) - new Date(b.issuedAt) || compareDocumentNumbers(a.number, b.number))) {
          const list = byJob.get(row.jobId) || [];
          list.push({ ...documentFromRow(row), events: byDocument.get(row.uid) });
          byJob.set(row.jobId, list);
        }
        return byJob;
      });
    },

    /** Every document of these types and numbers that exists (for the backfill's report). */
    async findIssuedDocuments(documentType, numbers) {
      if (!numbers.length) return [];
      const rows = await scope.transaction((tx) => tx.select().from(issuedDocuments)
        .where(and(eq(issuedDocuments.documentType, documentType), inArray(issuedDocuments.number, numbers))));
      return rows.map(documentFromRow);
    },
  };
}
