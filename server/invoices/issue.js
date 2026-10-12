// The invoice issue service (#28, pricing engine phase 3 step 4b): an
// invoice is issued when it is finalised, in ONE organisation transaction
// that holds the organisation's issue lock:
//
//   1. allocate the number: INV-YYYY-MM-N from document_number_counters (per
//      organisation, document type and month; N restarts each month);
//   2. render the PDF once, with that number;
//   3. store its bytes (document_blobs) and its issued document, with an
//      `issued` event;
//   4. write the invoice row and its lines, frozen (migration 0013's
//      triggers), with the job number as its required reference.
//
// The counter only moves inside that transaction, so a number is used by an
// invoice that was issued, or by nothing: an issue that fails (the render
// throws, a check refuses it) rolls the counter back, and the sequence has
// no gaps. Numbers are never reused.
//
// Email is delivery, recorded later as an `emailed` or `email_failed` event
// against the stored bytes (server/documents/recorder.js). A failed email
// never undoes an issue.
//
// Idempotency: the caller names the issue with a key. A retried issue with
// the same key (say the job generation that called it failed after this
// transaction committed) returns the same invoice, number and bytes, and
// allocates nothing.
//
// The R2 replica (#12) copies the stored bytes after the transaction commits
// (`onBlobsStored`), as the issued-document service does.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { createPostgresBlobStore, DocumentBytesError, sha256Hex } from "../documents/blob-store.js";
import { newDocumentEventUid, newDocumentUid } from "../documents/uid.js";
import { mapMilestoneState } from "./from-milestones.js";
import { insertIssuedInvoiceRow } from "./invoice-rows.js";
import { formatInvoiceNumber, invoicePeriod } from "./numbers.js";

export { INVOICE_NUMBER_PATTERN, formatInvoiceNumber, invoicePeriod, isSequenceInvoiceNumber } from "./numbers.js";

const { invoices, issuedDocuments, documentEvents, documentNumberCounters, paymentMilestones, quotes } = schema;

export class InvoiceIssueError extends Error {
  constructor(message, { code = "INVOICE_ISSUE_INVALID", statusCode = 400 } = {}) {
    super(message);
    this.name = "InvoiceIssueError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * The idempotency key of one issue: the job, the milestone, the revision and
 * the money it issues. A retry of the same issue has the same key; an issue
 * of different content (the quote changed in between) is a different one.
 */
export function invoiceIssueKey({ jobId, milestoneIndex, revisionNumber, fingerprint }) {
  const digest = createHash("sha256").update(String(fingerprint ?? "")).digest("hex").slice(0, 16);
  return `invoice:${jobId}:m${milestoneIndex}:r${revisionNumber}:${digest}`;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The invoice row an issue writes, mapped exactly as the job's files will map
 * it once the issue is committed (from-milestones.js), so the next sync of
 * the job finds it unchanged. `milestoneInvoices` is the job's normalized
 * milestone state with the issuing revision on its milestone, still under
 * its provisional number. Throws when the milestone does not map.
 */
export function mapInvoiceForIssue({ milestoneInvoices, paymentSchedule = null, milestoneIndex, basis = null, reference = null }) {
  const mapped = mapMilestoneState({ meta: { milestoneInvoices, paymentSchedule }, basis, jobNumber: reference });
  const milestone = milestoneInvoices.find((entry) => entry.milestoneIndex === milestoneIndex);
  const number = milestone?.issuedRevision?.invoiceNumber;
  const invoice = mapped.invoices.find((entry) => entry.milestoneKey === String(milestoneIndex) && entry.number === number);
  const failure = mapped.failures.find((entry) => entry.milestone === milestoneIndex);
  if (!invoice || failure) {
    throw new InvoiceIssueError(`milestone ${milestoneIndex + 1} cannot be issued: ${failure?.reason || "it has no issued revision"}`, { code: "INVOICE_ISSUE_UNMAPPABLE", statusCode: 409 });
  }
  return invoice;
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function lockKey(orgUid) {
  return `field:invoice-issue:${orgUid}`;
}

/**
 * The issue service for one organisation. `db` is an orgScope, or a database
 * with `orgUid`; `blobs` the byte store (documents/blob-store.js).
 */
export function createInvoiceIssueService({
  db,
  orgUid = undefined,
  blobs = createPostgresBlobStore(),
  now = () => new Date(),
  onBlobsStored = null,
}) {
  if (!db) throw new Error("createInvoiceIssueService needs a database");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);

  function afterCommit(sha256s) {
    if (!onBlobsStored) return;
    try {
      Promise.resolve(onBlobsStored(sha256s)).catch(() => {});
    } catch {}
  }

  async function replay(tx, row) {
    const [document] = row.issuedDocumentUid
      ? await tx.select().from(issuedDocuments).where(eq(issuedDocuments.uid, row.issuedDocumentUid))
      : [];
    if (!document) throw new InvoiceIssueError(`invoice ${row.number} was issued without its document`, { code: "INVOICE_ISSUE_INCOMPLETE", statusCode: 500 });
    const bytes = await blobs.get(document.pdfSha256, { tx, orgUid: scope.orgUid });
    if (!bytes) throw new DocumentBytesError(`the bytes of ${document.uid} (${document.pdfSha256}) are not stored`, { code: "DOCUMENT_BYTES_MISSING" });
    return {
      replayed: true,
      number: row.number,
      reference: row.reference,
      invoiceUid: row.uid,
      issuedDocumentUid: document.uid,
      pdfSha256: document.pdfSha256,
      pdfBytes: bytes,
      issuedAt: iso(row.issuedAt),
    };
  }

  return {
    enabled: true,
    orgUid: scope.orgUid,

    /**
     * Issue one invoice. `invoice` is the invoice as the job's milestone
     * state maps it (from-milestones.js): kind, money, its claim line, the
     * quote version it bills, its milestone index (`milestoneKey`). Its
     * number is allocated here. `render(number)` returns the PDF bytes with
     * that number printed. Returns { replayed, number, reference, invoiceUid,
     * issuedDocumentUid, pdfSha256, pdfBytes, issuedAt }.
     */
    async issueInvoice({
      jobId,
      idempotencyKey,
      reference,
      issuedAt,
      issuedBy = null,
      invoice,
      details = {},
      render,
    }) {
      const cleanJobId = text(String(jobId ?? ""));
      if (!cleanJobId) throw new InvoiceIssueError("an invoice is issued for a job: its job id is missing");
      const key = text(idempotencyKey);
      if (!key) throw new InvoiceIssueError("an invoice issue needs its idempotency key");
      const cleanReference = text(reference);
      if (!cleanReference) {
        throw new InvoiceIssueError("an invoice for a job carries the job number as its reference, and this job has none", { code: "INVOICE_REFERENCE_REQUIRED", statusCode: 409 });
      }
      if (!invoice || !Array.isArray(invoice.lines) || !invoice.lines.length) throw new InvoiceIssueError("an invoice issue needs the invoice and its lines");
      if (typeof render !== "function") throw new InvoiceIssueError("an invoice issue needs its renderer");
      const issuedDate = new Date(issuedAt);
      if (Number.isNaN(issuedDate.getTime())) throw new InvoiceIssueError(`issue time is not a timestamp: ${JSON.stringify(issuedAt)}`);
      const actor = text(issuedBy);

      const result = await scope.transaction(async (tx) => {
        // One issue at a time per organisation: numbers are allocated in the
        // order invoices are issued, and a retry waits for the first try.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey(scope.orgUid)}))`);
        const [existing] = await tx.select().from(invoices).where(eq(invoices.issueKey, key));
        if (existing) return replay(tx, existing);

        const at = now();
        const period = invoicePeriod(issuedDate);
        const [counter] = await tx.insert(documentNumberCounters)
          .values({ documentType: "invoice", period, lastValue: 1, createdAt: at, updatedAt: at })
          .onConflictDoUpdate({
            target: [documentNumberCounters.orgUid, documentNumberCounters.documentType, documentNumberCounters.period],
            set: { lastValue: sql`${documentNumberCounters.lastValue} + 1`, updatedAt: at },
          })
          .returning();
        const number = formatInvoiceNumber(period, counter.lastValue);

        const rendered = await render(number);
        if (!rendered || !rendered.length) throw new InvoiceIssueError(`invoice ${number} rendered no bytes`, { statusCode: 500 });
        const pdfBytes = Buffer.from(rendered);
        const pdfSha256 = await blobs.put(pdfBytes, { tx, contentType: "application/pdf" });

        const issuedDocumentUid = newDocumentUid(at.getTime());
        await tx.insert(issuedDocuments).values({
          uid: issuedDocumentUid,
          jobId: cleanJobId,
          documentType: "invoice",
          number,
          quoteVersion: Number(invoice.quoteVersion) > 0 ? Number(invoice.quoteVersion) : null,
          revision: Number(invoice.revision) > 0 ? Number(invoice.revision) : 1,
          issuedAt: issuedDate,
          issuedBy: actor,
          pdfSha256,
          source: "live",
          details: { ...(details && typeof details === "object" ? details : {}), reference: cleanReference },
          createdAt: at,
          createdBy: actor,
        });
        await tx.insert(documentEvents).values({
          uid: newDocumentEventUid(at.getTime()),
          issuedDocumentUid,
          jobId: cleanJobId,
          documentType: "invoice",
          event: "issued",
          at: issuedDate,
          by: actor,
          data: { number, pdfSha256, source: "live", reference: cleanReference, issueKey: key },
          idempotencyKey: `issued:${issuedDocumentUid}`,
          createdAt: at,
        });

        const milestoneIndex = Number(invoice.milestoneKey);
        const [milestone] = Number.isInteger(milestoneIndex)
          ? await tx.select({ uid: paymentMilestones.uid }).from(paymentMilestones)
            .where(and(eq(paymentMilestones.jobId, cleanJobId), eq(paymentMilestones.sortOrder, milestoneIndex)))
          : [];
        const [quote] = Number(invoice.quoteVersion) > 0
          ? await tx.select({ uid: quotes.uid }).from(quotes)
            .where(and(eq(quotes.jobId, cleanJobId), eq(quotes.version, Number(invoice.quoteVersion))))
          : [];
        const invoiceUid = await insertIssuedInvoiceRow(tx, {
          jobId: cleanJobId,
          invoice: {
            ...invoice,
            key: number,
            number,
            status: "issued",
            issuedAt: issuedDate.toISOString(),
            issuedOn: null,
            reference: cleanReference,
          },
          issueKey: key,
          issuedDocumentUid,
          milestoneUid: milestone?.uid || null,
          quoteUid: quote?.uid || null,
          actor,
          at,
        });
        return {
          replayed: false,
          number,
          reference: cleanReference,
          invoiceUid,
          issuedDocumentUid,
          pdfSha256,
          pdfBytes,
          issuedAt: issuedDate.toISOString(),
        };
      });
      if (!result.replayed) afterCommit([result.pdfSha256]);
      if (sha256Hex(result.pdfBytes) !== result.pdfSha256) throw new DocumentBytesError(`the bytes of invoice ${result.number} do not match their hash`);
      return result;
    },
  };
}

// The issuer the server installs (server/index.js): the service above when
// the server has a database, else one that refuses. Code that runs without a
// server installs nothing and is refused too: an invoice is never issued
// outside PostgreSQL.
function unavailable(reason) {
  return Object.freeze({
    enabled: false,
    reason,
    async issueInvoice() {
      throw new InvoiceIssueError(`invoices are issued in PostgreSQL, and ${reason}; nothing was issued`, { code: "INVOICE_ISSUE_UNAVAILABLE", statusCode: 503 });
    },
  });
}

let installed = null;

export function installInvoiceIssuer(issuer) {
  installed = issuer || null;
  return installed;
}

export function invoiceIssuer() {
  return installed || unavailable("no invoice issuer is installed");
}

/** For a server with no database. */
export function createUnavailableInvoiceIssuer(reason) {
  return unavailable(reason);
}
