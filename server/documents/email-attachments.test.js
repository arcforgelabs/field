// Field documents as email attachments: read by uid from the issue service,
// hash-checked, refused when they belong to another job, are the email's own
// document, changed or were withdrawn since a queued email recorded them, and
// held to the email limits.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { DocumentBytesError, sha256Hex } from "./blob-store.js";
import {
  EMAIL_ATTACHMENT_LIMITS,
  EmailAttachmentError,
  assertEmailAttachmentLimits,
  documentAttachmentRecord,
  documentMimeAttachments,
  loadDocumentAttachments,
  parseDocumentRefs,
} from "./email-attachments.js";
import { createIssuedDocumentService } from "./issued-documents.js";
import { documentStatus, notIssuedDocuments, statusFromEvents } from "./status.js";

const AT = "2026-10-13T00:30:00.000Z";
const MB = 1024 * 1024;

function pdf(text) {
  return Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);
}

async function refuses(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EmailAttachmentError, error.message);
    assert.equal(error.statusCode, statusCode, error.message);
    assert.equal(error.code, code);
    assert.equal(error.deliveryOutcome, "rejected_before_dispatch");
    return true;
  });
}

describe("email attachments by uid", () => {
  let t;
  let service;
  let quote;
  let invoice;
  let otherJob;

  before(async () => {
    t = await createTestDb();
    service = createIssuedDocumentService({ db: t.db, orgUid: DEFAULT_ORG_UID });
    const issue = async (jobId, documentType, number, text, extra = {}) => (await service.recordIssuedDocument({
      jobId, documentType, number, pdfBytes: pdf(text), issuedAt: AT, source: "live", ...extra,
    })).document;
    quote = await issue("job-a", "quote", "EQ-2610-14 v2", "quote v2", { quoteVersion: 2 });
    invoice = await issue("job-a", "invoice", "INV-2026-10-1", "invoice 1");
    otherJob = await issue("job-b", "quote", "EQ-2610-15 v1", "other quote", { quoteVersion: 1 });
  });
  after(() => t.close());

  test("uids are parsed in order; a uid named twice or a malformed one is refused", () => {
    assert.deepEqual(parseDocumentRefs([{ uid: quote.uid }, invoice.uid]), [quote.uid, invoice.uid]);
    assert.deepEqual(parseDocumentRefs(JSON.stringify([{ uid: quote.uid }])), [quote.uid]);
    assert.deepEqual(parseDocumentRefs(undefined), []);
    assert.throws(() => parseDocumentRefs([quote.uid, { uid: quote.uid }]), (error) => error.code === "EMAIL_DOCUMENT_TWICE");
    assert.throws(() => parseDocumentRefs(["../etc/passwd"]), (error) => error.code === "EMAIL_DOCUMENTS_INVALID" && error.statusCode === 400);
    assert.throws(() => parseDocumentRefs({ uid: quote.uid }), (error) => error.code === "EMAIL_DOCUMENTS_INVALID");
  });

  test("each document's stored bytes, named by its number, in the order asked", async () => {
    const loaded = await loadDocumentAttachments({ service, jobId: "job-a", refs: [invoice.uid, quote.uid] });
    assert.deepEqual(loaded.map((entry) => entry.filename), ["INV-2026-10-1.pdf", "EQ-2610-14 v2.pdf"]);
    assert.ok(loaded[0].buffer.equals(pdf("invoice 1")));
    assert.equal(loaded[1].sha256, quote.pdfSha256);
    assert.equal(loaded[1].byteLength, pdf("quote v2").length);
    const record = documentAttachmentRecord(loaded[1]);
    assert.equal(record.buffer, undefined, "a queued email keeps the reference, never the bytes");
    assert.deepEqual(Object.keys(record).sort(), ["byteLength", "documentType", "filename", "number", "sha256", "status", "uid"]);
    assert.deepEqual(documentMimeAttachments(loaded).map((entry) => [entry.contentType, entry.uid]), [["application/pdf", invoice.uid], ["application/pdf", quote.uid]]);
    assert.deepEqual(await loadDocumentAttachments({ service: null, jobId: "job-a", refs: [] }), [], "nothing to attach needs no database");
  });

  test("another job's document, an unknown uid and the email's own document are refused", async () => {
    await refuses(loadDocumentAttachments({ service, jobId: "job-a", refs: [otherJob.uid] }), 409, "DOCUMENT_OF_ANOTHER_JOB");
    await refuses(loadDocumentAttachments({ service, jobId: "job-a", refs: ["doc_01ARZ3NDEKTSV4RRFFQ69G5FAV"] }), 404, "DOCUMENT_NOT_FOUND");
    await refuses(loadDocumentAttachments({
      service, jobId: "job-a", refs: [invoice.uid], mainDocument: { documentType: "invoice", number: "INV-2026-10-1" },
    }), 409, "EMAIL_DOCUMENT_TWICE");
    await refuses(loadDocumentAttachments({ service: null, jobId: "job-a", refs: [quote.uid] }), 503, "ISSUED_DOCUMENTS_UNAVAILABLE");
  });

  test("bytes that fail their hash are refused (410), never re-rendered", async () => {
    const broken = {
      listJobDocuments: (jobId) => service.listJobDocuments(jobId),
      readIssuedDocument: async () => { throw new DocumentBytesError("mismatch"); },
    };
    await refuses(loadDocumentAttachments({ service: broken, jobId: "job-a", refs: [quote.uid] }), 410, "DOCUMENT_BYTES_UNAVAILABLE");
  });

  test("a queued email's recorded document must still be the same bytes and not withdrawn since", async () => {
    const [recorded] = (await loadDocumentAttachments({ service, jobId: "job-a", refs: [invoice.uid] })).map(documentAttachmentRecord);
    assert.equal(recorded.status, "issued");
    assert.equal((await loadDocumentAttachments({ service, jobId: "job-a", refs: [recorded] })).length, 1);
    await refuses(loadDocumentAttachments({ service, jobId: "job-a", refs: [{ ...recorded, sha256: sha256Hex(pdf("something else")) }] }), 410, "DOCUMENT_BYTES_CHANGED");
    await service.recordEvent({
      issuedDocumentUid: invoice.uid, jobId: "job-a", documentType: "invoice", event: "credited", at: AT,
      data: { creditNote: "CN-2026-10-1" }, idempotencyKey: `credited:${invoice.uid}`,
    });
    await refuses(loadDocumentAttachments({ service, jobId: "job-a", refs: [recorded] }), 409, "DOCUMENT_WITHDRAWN");
    // Picked while already credited (the replaced invoice, on purpose): it goes.
    const picked = await loadDocumentAttachments({ service, jobId: "job-a", refs: [invoice.uid] });
    assert.equal(picked[0].status, "credited");
    assert.equal((await loadDocumentAttachments({ service, jobId: "job-a", refs: [documentAttachmentRecord(picked[0])] })).length, 1);
  });

  test("the limits: 10 attachments, 10 MB per upload, 18 MB in total (413)", () => {
    const upload = (size, filename = "file.bin") => ({ filename, buffer: Buffer.alloc(size) });
    assert.deepEqual(EMAIL_ATTACHMENT_LIMITS, { maxAttachments: 10, maxUploadBytes: 10 * MB, maxTotalBytes: 18 * MB });
    assert.deepEqual(assertEmailAttachmentLimits({ mainBytes: 200_000, documents: [{ byteLength: 100_000 }], uploads: [upload(10 * MB)] }), { count: 3, totalBytes: 10 * MB + 300_000 });
    const refused = (input, code) => assert.throws(() => assertEmailAttachmentLimits(input), (error) => error.statusCode === 413 && error.code === code);
    refused({ uploads: [upload(10 * MB + 1, "plan.pdf")] }, "EMAIL_UPLOAD_TOO_LARGE");
    refused({ mainBytes: 1, uploads: Array.from({ length: 10 }, () => upload(1)) }, "EMAIL_TOO_MANY_ATTACHMENTS");
    refused({ mainBytes: 1 * MB, documents: [{ byteLength: 8 * MB }], uploads: [upload(9 * MB + 1)] }, "EMAIL_TOO_LARGE");
    assertEmailAttachmentLimits({ mainBytes: 1 * MB, documents: [{ byteLength: 8 * MB }], uploads: [upload(9 * MB)] });
    try {
      assertEmailAttachmentLimits({ uploads: [upload(9 * MB), upload(9 * MB + 1)] });
      assert.fail("expected a refusal");
    } catch (error) {
      assert.deepEqual(error.details, { totalBytes: 18 * MB + 1, limitBytes: 18 * MB });
    }
  });
});

describe("document status", () => {
  const meta = {
    pipelineStage: "landed",
    quoteVersion: 2,
    milestoneInvoices: [
      { milestoneIndex: 0, milestoneLabel: "Deposit", status: "paid", issuedRevision: { invoiceNumber: "INV-2026-10-1" } },
      { milestoneIndex: 1, milestoneLabel: "Completion", status: "draft", total: 4400 },
    ],
  };
  const documents = [
    { documentType: "quote", number: "EQ v1", quoteVersion: 1, events: [] },
    { documentType: "quote", number: "EQ v2", quoteVersion: 2, events: [] },
  ];

  test("from events first, then the job", () => {
    assert.equal(statusFromEvents([{ event: "issued" }, { event: "credited" }]), "credited");
    assert.equal(statusFromEvents([{ event: "voided" }]), "void");
    assert.equal(documentStatus(documents[0], { meta, documents }), "superseded");
    assert.equal(documentStatus(documents[1], { meta, documents }), "accepted");
    assert.equal(documentStatus(documents[1], { meta: { ...meta, pipelineStage: "sent" }, documents }), "issued");
    assert.equal(documentStatus({ documentType: "invoice", number: "INV-2026-10-1", events: [] }, { meta }), "paid");
    assert.equal(documentStatus({ documentType: "invoice", number: "INV-2026-10-1", events: [{ event: "credited" }] }, { meta }), "credited");
    assert.equal(documentStatus({ documentType: "receipt", number: "ER-1", events: [] }, { meta }), "paid");
    assert.equal(documentStatus({ documentType: "credit_note", number: "CN-1", events: [] }, { meta }), "issued");
  });

  test("draft milestone invoices are listed as not issued yet", () => {
    assert.deepEqual(notIssuedDocuments(meta), [{
      documentType: "invoice",
      milestoneIndex: 1,
      label: "Completion",
      total: 4400,
      reason: "Draft. Customers only get issued documents. Issue it from Invoices.",
    }]);
  });
});
