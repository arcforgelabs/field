// The invoice issue service (#28, pricing engine phase 3 step 4b): an
// invoice is issued when it is finalised, in ONE organisation transaction
// that holds the organisation's issue lock:
//
//   1. allocate the number: INV-YYYY-M-N from document_number_counters (per
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
import { allocateCreditedPayments, insertCreditNoteRow, insertIssuedInvoiceRow, isIssuedInvoice, refreshAmountsPaid } from "./invoice-rows.js";
import { formatSequenceNumber, invoicePeriod } from "./numbers.js";
import { readCreditNoteOnReissue } from "./business-settings.js";

export { CREDIT_NOTE_NUMBER_PATTERN, INVOICE_NUMBER_PATTERN, SEQUENCE_PREFIXES, formatCreditNoteNumber, formatInvoiceNumber, formatSequenceNumber, invoicePeriod, isSequenceInvoiceNumber } from "./numbers.js";

const { invoices, creditNotes, issuedDocuments, documentEvents, documentNumberCounters, paymentMilestones, quotes, quoteSnapshots } = schema;

export class InvoiceIssueError extends Error {
  constructor(message, { code = "INVOICE_ISSUE_INVALID", statusCode = 400 } = {}) {
    super(message);
    this.name = "InvoiceIssueError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * The credit note a reissue writes for the revision it replaces, mapped as
 * the job's files map it once the reissue is committed (from-milestones.js):
 * the credited invoice in full, one line per line it credits. Its number is
 * allocated by the issue service. Throws when it does not map.
 */
export function mapCreditNoteForIssue({ milestoneInvoices, paymentSchedule = null, milestoneIndex, basis = null, reference = null, creditedNumber }) {
  const mapped = mapMilestoneState({ meta: { milestoneInvoices, paymentSchedule }, basis, jobNumber: reference });
  const note = (mapped.creditNotes || []).find((entry) => entry.milestoneKey === String(milestoneIndex) && entry.invoiceKey === creditedNumber);
  if (!note) {
    const failure = mapped.failures.find((entry) => entry.milestone === milestoneIndex);
    throw new InvoiceIssueError(`invoice ${creditedNumber} cannot be credited: ${failure?.reason || "it does not map to a credit note"}`, { code: "INVOICE_ISSUE_UNMAPPABLE", statusCode: 409 });
  }
  return note;
}

/**
 * The idempotency key of one credit and reissue: the job, the milestone, the
 * revision credited, the revision replacing it and the money it issues.
 */
export function creditIssueKey({ jobId, milestoneIndex, creditedRevisionNumber, revisionNumber, fingerprint }) {
  const digest = createHash("sha256").update(String(fingerprint ?? "")).digest("hex").slice(0, 16);
  return `credit:${jobId}:m${milestoneIndex}:r${creditedRevisionNumber}-r${revisionNumber}:${digest}`;
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
export function mapInvoiceForIssue({ milestoneInvoices, paymentSchedule = null, milestoneIndex, basis = null, reference = null, number = null }) {
  const mapped = mapMilestoneState({ meta: { milestoneInvoices, paymentSchedule }, basis, jobNumber: reference });
  const milestone = milestoneInvoices.find((entry) => entry.milestoneIndex === milestoneIndex);
  const wanted = number || milestone?.issuedRevision?.invoiceNumber;
  const invoice = mapped.invoices.find((entry) => entry.milestoneKey === String(milestoneIndex) && entry.number === wanted);
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

  async function lock(tx) {
    // One issue at a time per organisation: numbers are allocated in the
    // order documents are issued, and a retry waits for the first try.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey(scope.orgUid)}))`);
  }

  // The next number of a document type's series (numbers.js
  // SEQUENCE_PREFIXES) for the issue time's month. Inside the issue
  // transaction only: a failed issue rolls it back, so there are no gaps.
  async function allocate(tx, documentType, issuedDate, at) {
    const period = invoicePeriod(issuedDate);
    const [counter] = await tx.insert(documentNumberCounters)
      .values({ documentType, period, lastValue: 1, createdAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: [documentNumberCounters.orgUid, documentNumberCounters.documentType, documentNumberCounters.period],
        set: { lastValue: sql`${documentNumberCounters.lastValue} + 1`, updatedAt: at },
      })
      .returning();
    return formatSequenceNumber(documentType, period, counter.lastValue);
  }

  // The bytes, the issued document and its `issued` event.
  async function storeDocument(tx, { jobId, documentType, number, render, quoteVersion = null, revision = null, issuedDate, actor, details, eventData, at }) {
    const rendered = await render(number);
    if (!rendered || !rendered.length) throw new InvoiceIssueError(`${documentType} ${number} rendered no bytes`, { statusCode: 500 });
    const pdfBytes = Buffer.from(rendered);
    const pdfSha256 = await blobs.put(pdfBytes, { tx, contentType: "application/pdf" });
    const issuedDocumentUid = newDocumentUid(at.getTime());
    await tx.insert(issuedDocuments).values({
      uid: issuedDocumentUid,
      jobId,
      documentType,
      number,
      quoteVersion: Number(quoteVersion) > 0 ? Number(quoteVersion) : null,
      revision: Number(revision) > 0 ? Number(revision) : null,
      issuedAt: issuedDate,
      issuedBy: actor,
      pdfSha256,
      source: "live",
      details,
      createdAt: at,
      createdBy: actor,
    });
    await insertEvent(tx, { issuedDocumentUid, jobId, documentType, event: "issued", at: issuedDate, by: actor, data: { number, pdfSha256, source: "live", ...eventData }, idempotencyKey: `issued:${issuedDocumentUid}`, createdAt: at });
    return { pdfBytes, pdfSha256, issuedDocumentUid };
  }

  async function insertEvent(tx, { createdAt, ...event }) {
    await tx.insert(documentEvents).values({ uid: newDocumentEventUid(createdAt.getTime()), ...event, createdAt });
  }

  async function links(tx, jobId, invoice) {
    const milestoneIndex = Number(invoice.milestoneKey);
    const [milestone] = Number.isInteger(milestoneIndex)
      ? await tx.select({ uid: paymentMilestones.uid }).from(paymentMilestones)
        .where(and(eq(paymentMilestones.jobId, jobId), eq(paymentMilestones.sortOrder, milestoneIndex)))
      : [];
    const [quote] = Number(invoice.quoteVersion) > 0
      ? await tx.select({ uid: quotes.uid }).from(quotes)
        .where(and(eq(quotes.jobId, jobId), eq(quotes.version, Number(invoice.quoteVersion))))
      : [];
    return { milestoneUid: milestone?.uid || null, quoteUid: quote?.uid || null };
  }

  // Allocate, render, store and write one invoice. Returns what issueInvoice
  // returns, without the replay flag.
  async function issueInvoiceNow(tx, { jobId, key, reference, issuedDate, actor, invoice, details, render, supersedesInvoiceUid = null, eventData = {} }) {
    const at = now();
    const number = await allocate(tx, "invoice", issuedDate, at);
    const stored = await storeDocument(tx, {
      jobId,
      documentType: "invoice",
      number,
      render,
      quoteVersion: invoice.quoteVersion,
      revision: Number(invoice.revision) > 0 ? Number(invoice.revision) : 1,
      issuedDate,
      actor,
      details: { ...(details && typeof details === "object" ? details : {}), reference },
      eventData: { reference, issueKey: key, ...eventData },
      at,
    });
    const linked = await links(tx, jobId, invoice);
    const invoiceUid = await insertIssuedInvoiceRow(tx, {
      jobId,
      invoice: { ...invoice, key: number, number, status: "issued", issuedAt: issuedDate.toISOString(), issuedOn: null, reference, supersedesInvoiceUid },
      issueKey: key,
      issuedDocumentUid: stored.issuedDocumentUid,
      ...linked,
      actor,
      at,
    });
    return { number, reference, invoiceUid, issuedDocumentUid: stored.issuedDocumentUid, pdfSha256: stored.pdfSha256, pdfBytes: stored.pdfBytes, issuedAt: issuedDate.toISOString() };
  }

  async function documentBytes(tx, issuedDocumentUid, label) {
    const [document] = issuedDocumentUid
      ? await tx.select().from(issuedDocuments).where(eq(issuedDocuments.uid, issuedDocumentUid))
      : [];
    if (!document) throw new InvoiceIssueError(`${label} was issued without its document`, { code: "INVOICE_ISSUE_INCOMPLETE", statusCode: 500 });
    const bytes = await blobs.get(document.pdfSha256, { tx, orgUid: scope.orgUid });
    if (!bytes) throw new DocumentBytesError(`the bytes of ${document.uid} (${document.pdfSha256}) are not stored`, { code: "DOCUMENT_BYTES_MISSING" });
    return { issuedDocumentUid: document.uid, pdfSha256: document.pdfSha256, pdfBytes: bytes };
  }

  async function replayInvoice(tx, row) {
    return {
      number: row.number,
      reference: row.reference,
      invoiceUid: row.uid,
      ...(await documentBytes(tx, row.issuedDocumentUid, `invoice ${row.number}`)),
      issuedAt: iso(row.issuedAt),
    };
  }

  function validated({ jobId, idempotencyKey, reference, issuedAt, issuedBy }) {
    const cleanJobId = text(String(jobId ?? ""));
    if (!cleanJobId) throw new InvoiceIssueError("an invoice is issued for a job: its job id is missing");
    const key = text(idempotencyKey);
    if (!key) throw new InvoiceIssueError("an invoice issue needs its idempotency key");
    const cleanReference = text(reference);
    if (!cleanReference) {
      throw new InvoiceIssueError("an invoice for a job carries the job number as its reference, and this job has none", { code: "INVOICE_REFERENCE_REQUIRED", statusCode: 409 });
    }
    const issuedDate = new Date(issuedAt);
    if (Number.isNaN(issuedDate.getTime())) throw new InvoiceIssueError(`issue time is not a timestamp: ${JSON.stringify(issuedAt)}`);
    return { jobId: cleanJobId, key, reference: cleanReference, issuedDate, actor: text(issuedBy) };
  }

  function checkInvoice(invoice, render) {
    if (!invoice || !Array.isArray(invoice.lines) || !invoice.lines.length) throw new InvoiceIssueError("an invoice issue needs the invoice and its lines");
    if (typeof render !== "function") throw new InvoiceIssueError("an invoice issue needs its renderer");
  }

  // Whether Field has evidence the customer was sent an invoice: an
  // `emailed` event on its issued document, or a delivered send record (a
  // `sent` quote snapshot of it).
  async function deliveryEvidence(tx, { jobId, number }) {
    const [document] = await tx.select({ uid: issuedDocuments.uid }).from(issuedDocuments)
      .where(and(eq(issuedDocuments.documentType, "invoice"), eq(issuedDocuments.number, number)));
    if (document) {
      const [emailed] = await tx.select({ uid: documentEvents.uid }).from(documentEvents)
        .where(and(eq(documentEvents.issuedDocumentUid, document.uid), eq(documentEvents.event, "emailed"))).limit(1);
      if (emailed) return { emailed: true, sendRecord: false };
    }
    const [sent] = await tx.select({ id: quoteSnapshots.id }).from(quoteSnapshots)
      .where(and(eq(quoteSnapshots.jobId, jobId), eq(quoteSnapshots.documentType, "invoice"), eq(quoteSnapshots.documentNumber, number), eq(quoteSnapshots.status, "sent"))).limit(1);
    return { emailed: false, sendRecord: Boolean(sent) };
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
    async issueInvoice({ jobId, idempotencyKey, reference, issuedAt, issuedBy = null, invoice, details = {}, render }) {
      const input = validated({ jobId, idempotencyKey, reference, issuedAt, issuedBy });
      checkInvoice(invoice, render);
      const result = await scope.transaction(async (tx) => {
        await lock(tx);
        const [existing] = await tx.select().from(invoices).where(eq(invoices.issueKey, input.key));
        if (existing) return { replayed: true, ...(await replayInvoice(tx, existing)) };
        return { replayed: false, ...(await issueInvoiceNow(tx, { ...input, invoice, details, render })) };
      });
      if (!result.replayed) afterCommit([result.pdfSha256]);
      if (sha256Hex(result.pdfBytes) !== result.pdfSha256) throw new DocumentBytesError(`the bytes of invoice ${result.number} do not match their hash`);
      return result;
    },

    /**
     * Correct an issued invoice (step 4b): credit it in full with a credit
     * (adjustment) note, then issue the invoice that replaces it, in ONE
     * transaction. The note takes CN-YYYY-M-N and the invoice INV-YYYY-M-N,
     * each from its own counter; both are rendered once and stored with their
     * `issued` events; the credited invoice gets a `credited` event (reason,
     * who, the note and its replacement) and the status `credited`; and every
     * payment it held moves to the new invoice as an allocation.
     *
     *   credited         { number, invoice }: the invoice being credited, by
     *                    its number on this job, and its row as the files map
     *                    it (written first if the job's rows do not have it)
     *   creditNote       the note as mapped like an invoice: money (the
     *                    credited invoice's, in full), lines, reason
     *   renderCreditNote (number, { invoiceNumber }) -> PDF bytes
     *   invoice, render  the replacement, as for issueInvoice; render gets
     *                    (number, { creditNoteNumber })
     *
     * `whenToCredit`: `always` ("Credit and reissue": the operator says the
     * customer has the invoice), or `by-setting` for an invoice that was
     * returned to draft and is issued again with different content: then the
     * organisation's `creditNoteOnReissue` (business-settings.js) decides,
     * against the evidence that the customer was sent it, and without a
     * credit the invoice is issued on its own (`creditNote` null).
     *
     * A retry with the same key returns the same note and invoice. Returns
     * { replayed, creditNote: { number, creditNoteUid, issuedDocumentUid,
     * pdfSha256, pdfBytes, issuedAt } or null, invoice: (as issueInvoice),
     * decision: { whenToCredit, setting, evidence, credited } }.
     */
    async creditAndReissue({ jobId, idempotencyKey, reference, issuedAt, issuedBy = null, reason, credited, creditNote, renderCreditNote, invoice, details = {}, creditNoteDetails = {}, render, whenToCredit = "always" }) {
      if (!["always", "by-setting"].includes(whenToCredit)) throw new InvoiceIssueError(`whenToCredit must be always or by-setting, not ${JSON.stringify(whenToCredit)}`);
      const input = validated({ jobId, idempotencyKey, reference, issuedAt, issuedBy });
      checkInvoice(invoice, render);
      const why = text(reason);
      if (!why) throw new InvoiceIssueError("a credit note needs its reason", { code: "CREDIT_NOTE_REASON_REQUIRED" });
      if (!credited?.number || !credited?.invoice) throw new InvoiceIssueError("a credit note needs the invoice it credits");
      if (!creditNote || !Array.isArray(creditNote.lines) || !creditNote.lines.length || typeof renderCreditNote !== "function") {
        throw new InvoiceIssueError("a credit note needs its lines and its renderer");
      }
      const result = await scope.transaction(async (tx) => {
        await lock(tx);
        const [existingNote] = await tx.select().from(creditNotes).where(eq(creditNotes.issueKey, input.key));
        if (existingNote) {
          const [replacement] = await tx.select().from(invoices).where(eq(invoices.uid, existingNote.replacementInvoiceUid));
          return {
            replayed: true,
            creditNote: { number: existingNote.number, creditNoteUid: existingNote.uid, ...(await documentBytes(tx, existingNote.issuedDocumentUid, `credit note ${existingNote.number}`)), issuedAt: iso(existingNote.issuedAt) },
            invoice: await replayInvoice(tx, replacement),
            decision: null,
          };
        }
        // Issued before without a credit note (the setting said not to).
        const [issuedAlone] = await tx.select().from(invoices).where(eq(invoices.issueKey, invoiceIssueKeyFor(input.key)));
        if (issuedAlone) return { replayed: true, creditNote: null, invoice: await replayInvoice(tx, issuedAlone), decision: null };
        const at = now();

        // The invoice being credited: issued, on this job, not credited before.
        let [creditedRow] = await tx.select().from(invoices).where(and(eq(invoices.jobId, input.jobId), eq(invoices.number, credited.number)));
        if (!creditedRow) {
          const linked = await links(tx, input.jobId, credited.invoice);
          await insertIssuedInvoiceRow(tx, { jobId: input.jobId, invoice: { ...credited.invoice, status: "issued" }, ...linked, actor: input.actor, at });
          [creditedRow] = await tx.select().from(invoices).where(and(eq(invoices.jobId, input.jobId), eq(invoices.number, credited.number)));
        }
        if (!isIssuedInvoice(creditedRow)) throw new InvoiceIssueError(`invoice ${credited.number} was never issued; there is nothing to credit`, { code: "CREDIT_NOTE_NOT_ISSUED", statusCode: 409 });
        const [already] = await tx.select().from(creditNotes).where(and(eq(creditNotes.invoiceUid, creditedRow.uid), eq(creditNotes.status, "issued")));
        if (already) throw new InvoiceIssueError(`invoice ${credited.number} was already credited by ${already.number}`, { code: "CREDIT_NOTE_EXISTS", statusCode: 409 });

        // An invoice returned to draft: the organisation's setting decides.
        const decision = { whenToCredit, setting: null, evidence: null, credited: true };
        if (whenToCredit === "by-setting") {
          decision.setting = await readCreditNoteOnReissue(tx);
          decision.evidence = await deliveryEvidence(tx, { jobId: input.jobId, number: credited.number });
          decision.credited = decision.setting === "always"
            || (decision.setting === "when-emailed" && (decision.evidence.emailed || decision.evidence.sendRecord));
        }
        if (!decision.credited) {
          const issued = await issueInvoiceNow(tx, {
            ...input,
            key: invoiceIssueKeyFor(input.key),
            invoice,
            details,
            render: (number) => render(number, { creditNoteNumber: null }),
            supersedesInvoiceUid: creditedRow.uid,
          });
          return { replayed: false, creditNote: null, invoice: issued, decision };
        }

        const noteNumber = await allocate(tx, "credit_note", input.issuedDate, at);
        // The replacement's number is allocated before either is rendered, so
        // each document can name the other.
        const invoiceNumber = await allocate(tx, "invoice", input.issuedDate, at);
        const noteStored = await storeDocument(tx, {
          jobId: input.jobId,
          documentType: "credit_note",
          number: noteNumber,
          render: () => renderCreditNote(noteNumber, { invoiceNumber }),
          quoteVersion: credited.invoice.quoteVersion,
          issuedDate: input.issuedDate,
          actor: input.actor,
          details: { ...(creditNoteDetails && typeof creditNoteDetails === "object" ? creditNoteDetails : {}), reference: input.reference, reason: why, creditedInvoiceNumber: credited.number, replacementInvoiceNumber: invoiceNumber },
          eventData: { reference: input.reference, issueKey: input.key, reason: why, creditedInvoiceNumber: credited.number, replacementInvoiceNumber: invoiceNumber },
          at,
        });

        // The replacement, under the number already allocated.
        const invoiceStored = await storeDocument(tx, {
          jobId: input.jobId,
          documentType: "invoice",
          number: invoiceNumber,
          render: () => render(invoiceNumber, { creditNoteNumber: noteNumber }),
          quoteVersion: invoice.quoteVersion,
          revision: Number(invoice.revision) > 0 ? Number(invoice.revision) : 1,
          issuedDate: input.issuedDate,
          actor: input.actor,
          details: { ...(details && typeof details === "object" ? details : {}), reference: input.reference, replacesInvoiceNumber: credited.number, creditNoteNumber: noteNumber },
          eventData: { reference: input.reference, issueKey: invoiceIssueKeyFor(input.key), replacesInvoiceNumber: credited.number, creditNoteNumber: noteNumber },
          at,
        });
        const linked = await links(tx, input.jobId, invoice);
        const invoiceUid = await insertIssuedInvoiceRow(tx, {
          jobId: input.jobId,
          invoice: { ...invoice, key: invoiceNumber, number: invoiceNumber, status: "issued", issuedAt: input.issuedDate.toISOString(), issuedOn: null, reference: input.reference, supersedesInvoiceUid: creditedRow.uid },
          issueKey: invoiceIssueKeyFor(input.key),
          issuedDocumentUid: invoiceStored.issuedDocumentUid,
          ...linked,
          actor: input.actor,
          at,
        });

        const creditNoteUid = await insertCreditNoteRow(tx, {
          jobId: input.jobId,
          creditNote: { ...creditNote, number: noteNumber, reason: why, issuedAt: input.issuedDate.toISOString(), reference: input.reference, createdBy: input.actor },
          invoiceUid: creditedRow.uid,
          replacementInvoiceUid: invoiceUid,
          issueKey: input.key,
          issuedDocumentUid: noteStored.issuedDocumentUid,
          actor: input.actor,
          at,
        });
        await tx.update(invoices).set({
          status: "credited",
          ...(creditedRow.supersededAt ? {} : { supersededAt: input.issuedDate }),
          note: `Credited by ${noteNumber} and replaced by ${invoiceNumber}.`,
          updatedAt: at,
          updatedBy: input.actor,
          version: creditedRow.version + 1,
        }).where(eq(invoices.uid, creditedRow.uid));
        if (creditedRow.issuedDocumentUid) {
          await insertEvent(tx, {
            issuedDocumentUid: creditedRow.issuedDocumentUid,
            jobId: input.jobId,
            documentType: "invoice",
            event: "credited",
            at: input.issuedDate,
            by: input.actor,
            data: { number: credited.number, creditNoteNumber: noteNumber, replacementInvoiceNumber: invoiceNumber, reason: why },
            idempotencyKey: `credited:${creditedRow.uid}`,
            createdAt: at,
          });
        }
        await allocateCreditedPayments(tx, { jobId: input.jobId, actor: input.actor, at });
        await refreshAmountsPaid(tx, { jobId: input.jobId, actor: input.actor, at });
        return {
          replayed: false,
          creditNote: { number: noteNumber, creditNoteUid, issuedDocumentUid: noteStored.issuedDocumentUid, pdfSha256: noteStored.pdfSha256, pdfBytes: noteStored.pdfBytes, issuedAt: input.issuedDate.toISOString() },
          invoice: { number: invoiceNumber, reference: input.reference, invoiceUid, issuedDocumentUid: invoiceStored.issuedDocumentUid, pdfSha256: invoiceStored.pdfSha256, pdfBytes: invoiceStored.pdfBytes, issuedAt: input.issuedDate.toISOString() },
          decision,
        };
      });
      if (!result.replayed) afterCommit([result.creditNote?.pdfSha256, result.invoice.pdfSha256].filter(Boolean));
      for (const document of [result.creditNote, result.invoice].filter(Boolean)) {
        if (sha256Hex(document.pdfBytes) !== document.pdfSha256) throw new DocumentBytesError(`the bytes of ${document.number} do not match their hash`);
      }
      return result;
    },
  };
}

// The replacement invoice's issue key: the credit's key, so a retry finds both.
function invoiceIssueKeyFor(creditKey) {
  return `${creditKey}:invoice`;
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
    async creditAndReissue() {
      throw new InvoiceIssueError(`credit notes and invoices are issued in PostgreSQL, and ${reason}; nothing was issued`, { code: "INVOICE_ISSUE_UNAVAILABLE", statusCode: 503 });
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
