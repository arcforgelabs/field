// Backfill: a fixture data directory with an issuance ledger, an
// invoice with an -R2 revision and its superseded R1, a corrupt and a missing
// invoice PDF, and quotes sent before the ledger. Then the live recorder over
// the same files, and the read routes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import express from "express";
import { sql } from "drizzle-orm";
import { createTestDb, NoDatabaseError, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, requestOrgUid, withOrg } from "../db-runtime/tenancy.js";
import { createPostgresBlobStore, sha256Hex } from "./blob-store.js";
import { backfillIssuedDocuments, collectJobDocuments } from "./backfill.js";
import { createIssuedDocumentService } from "./issued-documents.js";
import { createIssuedDocumentRecorder, createUnavailableIssuedDocumentRecorder } from "./recorder.js";
import { describeDeliveredDocument } from "./delivery.js";
import { registerIssuedDocumentRoutes } from "./routes.js";

const ORG_B = "org_01TESTSECONDORGANISATION0";
const pdf = (text) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
}

function revision({ number, revisionNumber, bytes, path, state = "stored", extra = {} }) {
  return {
    revisionNumber,
    invoiceNumber: number,
    quoteVersion: 1,
    issuedAt: `2026-01-1${revisionNumber}T00:00:00.000Z`,
    subtotal: 1000,
    gst: 100,
    total: 1100,
    currency: "AUD",
    lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 1000, totalPrice: 1000 }],
    pdfPath: path,
    pdfSha256: bytes ? sha256Hex(bytes) : null,
    pdfIssuedAt: `2026-01-1${revisionNumber}T00:00:00.000Z`,
    artifactState: state,
    ...extra,
  };
}

// <dataDir>/2026-01-15/job-ledger: ledger quote + invoice + receipt, an
// invoice with R1 superseded by R2, a corrupt PDF and a missing one.
function buildLedgerJob(dataDir) {
  const dir = join(dataDir, "2026-01-15", "job-ledger");
  const bytes = {
    quote: pdf("EQ-2601-01 v1 as sent"),
    r1: pdf("EI-2601-01-M1 revision 1"),
    r2: pdf("EI-2601-01-M1-R2 revision 2"),
    m2: pdf("EI-2601-01-M2 as issued"),
    receipt: pdf("ER-2601-01-M1 as sent"),
  };
  write(join(dir, "meta.json"), { id: "job-ledger", title: "Ledger job", quoteNumber: "EQ-2601-01", contactName: "Pat Customer" });
  write(join(dir, "quote.json"), { version: 1, quoteNumber: "EQ-2601-01", quoteSentAt: "2026-01-10T00:00:00.000Z" });
  write(join(dir, "issued-documents/v001/iss-quote/quote.pdf"), bytes.quote);
  write(join(dir, "issued-documents/v001/iss-invoice/quote.pdf"), bytes.r2);
  write(join(dir, "issued-documents/v001/iss-receipt/quote.pdf"), bytes.receipt);
  const ledgerRecord = (id, documentType, buffer, subject, messageId, issuedAt = "2026-01-10T00:00:00.000Z") => ({
    issuanceId: id,
    quoteVersion: 1,
    documentType,
    issuedAt,
    delivery: { messageId, threadId: `t-${messageId}`, documentType, to: "customer@example.invalid", subject },
    artifacts: { quotePdf: { path: `issued-documents/v001/${id}/quote.pdf`, sha256: sha256Hex(buffer), byteLength: buffer.length, mimeType: "application/pdf" } },
  });
  write(join(dir, "quote-issuance.json"), {
    version: 1,
    issuedVersions: [1],
    records: [
      ledgerRecord("iss-quote", "quote", bytes.quote, "Quote — Ledger job", "msg-quote"),
      ledgerRecord("iss-invoice", "invoice", bytes.r2, "Invoice — EI-2601-01-M1-R2 — Deposit", "msg-invoice", "2026-01-13T00:00:00.000Z"),
      ledgerRecord("iss-receipt", "receipt", bytes.receipt, "Receipt — ER-2601-01-M1 — Deposit", "msg-receipt", "2026-01-14T00:00:00.000Z"),
    ],
  });
  write(join(dir, "milestone-invoices/EI-2601-01-M1.pdf"), bytes.r1);
  write(join(dir, "milestone-invoices/EI-2601-01-M1-R2.pdf"), bytes.r2);
  // M2's file was changed after it was issued: its recorded hash no longer matches.
  write(join(dir, "milestone-invoices/EI-2601-01-M2.pdf"), pdf("EI-2601-01-M2 edited afterwards"));
  write(join(dir, "milestone-invoices/state.json"), {
    version: 1,
    milestoneInvoices: [
      {
        milestoneIndex: 0,
        milestoneLabel: "Deposit",
        status: "paid",
        receiptNumber: "ER-2601-01-M1",
        issuedAt: "2026-01-11T00:00:00.000Z",
        issuedRevision: revision({
          number: "EI-2601-01-M1-R2",
          revisionNumber: 2,
          bytes: bytes.r2,
          path: "milestone-invoices/EI-2601-01-M1-R2.pdf",
          extra: { revisedBy: "Alex", revisionReason: "scope change", supersedesInvoiceNumber: "EI-2601-01-M1", supersedesRevisionNumber: 1, revisedAt: "2026-01-12T00:00:00.000Z" },
        }),
        revisionHistory: [
          revision({ number: "EI-2601-01-M1", revisionNumber: 1, bytes: bytes.r1, path: "milestone-invoices/EI-2601-01-M1.pdf", extra: { supersededAt: "2026-01-12T00:00:00.000Z", supersededByRevisionNumber: 2 } }),
        ],
      },
      {
        milestoneIndex: 1,
        milestoneLabel: "Progress",
        status: "authorised",
        issuedAt: "2026-01-13T00:00:00.000Z",
        issuedRevision: revision({ number: "EI-2601-01-M2", revisionNumber: 1, bytes: bytes.m2, path: "milestone-invoices/EI-2601-01-M2.pdf" }),
      },
      {
        milestoneIndex: 2,
        milestoneLabel: "Completion",
        status: "authorised",
        issuedAt: "2026-01-14T00:00:00.000Z",
        issuedRevision: revision({ number: "EI-2601-01-M3", revisionNumber: 1, bytes: null, path: "milestone-invoices/EI-2601-01-M3.pdf", state: "missing" }),
      },
    ],
  });
  return { dir, bytes };
}

// <dataDir>/2025-12-01/job-legacy: v1 sent before the ledger with its
// attachment saved, v2 sent with only the stored version PDF.
function buildLegacyJob(dataDir) {
  const dir = join(dataDir, "2025-12-01", "job-legacy");
  const bytes = { v1: pdf("EQ-2512-04 v1 attachment"), v2: pdf("EQ-2512-04 v2 stored") };
  write(join(dir, "meta.json"), { id: "job-legacy", title: "Legacy job", quoteNumber: "EQ-2512-04", lastSentQuoteVersion: 1 });
  write(join(dir, "quote-versions/v001/quote.json"), { version: 1, quoteNumber: "EQ-2512-04", quoteSentAt: "2025-12-02T00:00:00.000Z" });
  write(join(dir, "quote-versions/v001/quote.pdf"), pdf("EQ-2512-04 v1 as generated, not as sent"));
  write(join(dir, "quote.json"), { version: 2, quoteNumber: "EQ-2512-04", quoteSentAt: "2025-12-05T00:00:00.000Z" });
  write(join(dir, "quote.pdf"), bytes.v2);
  write(join(dir, "EQ-2512-04 — Quote.pdf"), bytes.v1);
  appendFileSync(join(dir, "sent-emails.jsonl"), `${JSON.stringify({ kind: "quote.sent", documentType: "quote", quoteVersion: 1, ts: "2025-12-02T00:00:00.000Z", attachments: [{ filename: "EQ-2512-04 — Quote.pdf" }] })}\n`);
  return { dir, bytes };
}

describe("backfill", () => {
  let t;
  let dataDir;
  let ledgerJob;
  let legacyJob;
  let service;

  before(async () => {
    t = await createTestDb();
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    dataDir = mkdtempSync(join(tmpdir(), "field-backfill-"));
    ledgerJob = buildLedgerJob(dataDir);
    legacyJob = buildLegacyJob(dataDir);
    write(join(dataDir, "2026-01-15", "not-a-job", "notes.txt"), "no meta here");
    service = createIssuedDocumentService({ db: t.db, orgUid: DEFAULT_ORG_UID });
  });
  after(async () => {
    await t.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function counts(orgUid = DEFAULT_ORG_UID) {
    const [row] = await withOrg(t.db, orgUid, (tx) => queryRows(sql`
      select (select count(*) from issued_documents)::int as docs,
             (select count(*) from document_events)::int as events,
             (select count(*) from document_blobs)::int as blobs`, tx));
    return row;
  }

  test("a dry run reads every job, records nothing and says what it would record", async () => {
    const report = await backfillIssuedDocuments({ dataDir, service, dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.jobs, 2);
    assert.deepEqual(report.found, {
      "invoice/invoice-revision-backfill": 2,
      "invoice/ledger-backfill": 1,
      "quote/ledger-backfill": 1,
      "receipt/ledger-backfill": 1,
      "quote/legacy-sent-attachment": 1,
      "quote/legacy-stored-version": 1,
    });
    assert.deepEqual(report.recorded, {
      "invoice/invoice-revision-backfill": 2,
      "quote/ledger-backfill": 1,
      "receipt/ledger-backfill": 1,
      "quote/legacy-sent-attachment": 1,
      "quote/legacy-stored-version": 1,
    });
    assert.equal(report.alreadyRecorded, 1, "the ledger's invoice is the R2 revision already planned");
    assert.deepEqual(await counts(), { docs: 0, events: 0, blobs: 0 });
  });

  test("records each document once with its original bytes, and reports mismatches and missing files", async () => {
    const report = await backfillIssuedDocuments({ dataDir, service });
    assert.deepEqual(report.recorded, {
      "invoice/invoice-revision-backfill": 2,
      "quote/ledger-backfill": 1,
      "receipt/ledger-backfill": 1,
      "quote/legacy-sent-attachment": 1,
      "quote/legacy-stored-version": 1,
    });
    assert.equal(report.alreadyRecorded, 1);
    assert.equal(report.emailedEvents, 3, "one emailed event per ledger delivery");
    assert.deepEqual(report.mismatches.map((entry) => [entry.number, entry.reason]), [["EI-2601-01-M2", "hash does not match the recorded hash"]]);
    assert.equal(report.mismatches[0].recordedSha256, sha256Hex(ledgerJob.bytes.m2));
    assert.deepEqual(report.missing.map((entry) => entry.number), ["EI-2601-01-M3"]);
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.errors, []);

    const ledgerDocs = (await service.listJobDocuments("job-ledger")).documents;
    assert.deepEqual(ledgerDocs.map((doc) => [doc.documentType, doc.number, doc.source, doc.revision]).sort(), [
      ["invoice", "EI-2601-01-M1", "invoice-revision-backfill", 1],
      ["invoice", "EI-2601-01-M1-R2", "invoice-revision-backfill", 2],
      ["quote", "EQ-2601-01 v1", "ledger-backfill", null],
      ["receipt", "ER-2601-01-M1", "ledger-backfill", null],
    ]);
    const byNumber = Object.fromEntries(ledgerDocs.map((doc) => [doc.number, doc]));
    // Original bytes, hash-checked on the way out.
    for (const [number, bytes] of [["EI-2601-01-M1", ledgerJob.bytes.r1], ["EI-2601-01-M1-R2", ledgerJob.bytes.r2], ["EQ-2601-01 v1", ledgerJob.bytes.quote], ["ER-2601-01-M1", ledgerJob.bytes.receipt]]) {
      assert.deepEqual((await service.readIssuedDocument(byNumber[number].uid)).bytes, bytes, number);
    }
    assert.equal(byNumber["EI-2601-01-M1"].details.superseded, true);
    assert.equal(byNumber["EI-2601-01-M1-R2"].issuedBy, "Alex");
    assert.equal(byNumber["EI-2601-01-M1-R2"].details.revisionReason, "scope change");
    // The ledger's invoice delivery became an emailed event on the R2 revision.
    assert.deepEqual(byNumber["EI-2601-01-M1-R2"].events.map((event) => [event.event, event.data.messageId ?? null]), [["issued", null], ["emailed", "msg-invoice"]]);
    assert.deepEqual(byNumber["EI-2601-01-M1"].events.map((event) => event.event), ["issued"]);

    const legacyDocs = (await service.listJobDocuments("job-legacy")).documents;
    assert.deepEqual(legacyDocs.map((doc) => [doc.number, doc.source]).sort(), [
      ["EQ-2512-04 v1", "legacy-sent-attachment"],
      ["EQ-2512-04 v2", "legacy-stored-version"],
    ]);
    const v1 = legacyDocs.find((doc) => doc.quoteVersion === 1);
    assert.deepEqual((await service.readIssuedDocument(v1.uid)).bytes, legacyJob.bytes.v1, "the attachment that was sent, not the version's own PDF");
  });

  test("a second run records nothing new", async () => {
    const before = await counts();
    const report = await backfillIssuedDocuments({ dataDir, service });
    assert.deepEqual(report.recorded, {});
    assert.equal(report.alreadyRecorded, 7);
    assert.equal(report.emailedEvents, 0);
    assert.deepEqual(await counts(), before);
  });

  test("the backfill never fixes bytes: a file that changed since it was recorded is reported, not re-recorded", async () => {
    write(join(ledgerJob.dir, "milestone-invoices/EI-2601-01-M1.pdf"), pdf("tampered"));
    const { problems } = await collectJobDocuments(ledgerJob.dir);
    assert.ok(problems.some((problem) => problem.kind === "mismatch" && problem.number === "EI-2601-01-M1"));
    write(join(ledgerJob.dir, "milestone-invoices/EI-2601-01-M1.pdf"), ledgerJob.bytes.r1);
  });

  test("the same legacy PDF for two versions is reported as ambiguous and skipped", async () => {
    const dir = join(dataDir, "2025-11-01", "job-ambiguous");
    const bytes = pdf("EQ-2511-09 attachment");
    write(join(dir, "meta.json"), { id: "job-ambiguous", quoteNumber: "EQ-2511-09" });
    write(join(dir, "quote-versions/v001/quote.json"), { version: 1, quoteNumber: "EQ-2511-09", quoteSentAt: "2025-11-02T00:00:00.000Z" });
    write(join(dir, "quote.json"), { version: 2, quoteNumber: "EQ-2511-09", quoteSentAt: "2025-11-03T00:00:00.000Z" });
    write(join(dir, "EQ-2511-09.pdf"), bytes);
    // An archive entry without a version answers for every version.
    appendFileSync(join(dir, "sent-emails.jsonl"), `${JSON.stringify({ kind: "quote.sent", ts: "2025-11-03T00:00:00.000Z", attachments: [{ filename: "EQ-2511-09.pdf" }] })}\n`);
    const { candidates, problems } = await collectJobDocuments(dir);
    assert.deepEqual(candidates, []);
    assert.equal(problems.filter((problem) => problem.kind === "ambiguous").length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  describe("live recorder", () => {
    test("records a milestone's active issued revision once, and its delivery as an emailed event", async () => {
      const t2 = await createTestDb();
      try {
        const live = createIssuedDocumentService({ db: t2.db, orgUid: DEFAULT_ORG_UID });
        const errors = [];
        const recorder = createIssuedDocumentRecorder({ service: live, logger: { error: (line) => errors.push(line), warn: () => {} } });
        await recorder.recordInvoiceRevisions(ledgerJob.dir);
        await recorder.recordInvoiceRevisions(ledgerJob.dir);
        const docs = (await live.listJobDocuments("job-ledger")).documents;
        // Active revisions only: R2 (M1) is recorded; M2's PDF fails its hash
        // and M3's is missing, so they are reported, never recorded.
        assert.deepEqual(docs.map((doc) => [doc.number, doc.source]), [["EI-2601-01-M1-R2", "live"]]);
        assert.equal(recorder.status().recorded, 1);
        assert.equal(recorder.status().failures, 2);
        assert.match(errors.join("\n"), /EI-2601-01-M2.*hash does not match/);

        // The same invoice emailed: the same bytes, so an emailed event on it.
        const delivered = await recorder.recordDelivery({
          jobId: "job-ledger",
          documentType: "invoice",
          number: "EI-2601-01-M1-R2",
          revision: 2,
          pdfBytes: ledgerJob.bytes.r2,
          issuedAt: "2026-01-12T00:00:00.000Z",
          issuedBy: { id: "user-1", email: "operator@example.invalid" },
          email: { sentAt: "2026-01-13T00:00:00.000Z", messageId: "msg-live", to: "customer@example.invalid", by: { id: "user-1" } },
        });
        assert.equal(delivered.created, false);
        const [document] = (await live.listJobDocuments("job-ledger")).documents;
        assert.deepEqual(document.events.map((event) => [event.event, event.by, event.data.messageId ?? null]), [["issued", "Alex", null], ["emailed", "user-1", "msg-live"]]);

        // A resend with bytes rendered again keeps the issued bytes.
        const resent = await recorder.recordDelivery({
          jobId: "job-ledger",
          documentType: "invoice",
          number: "EI-2601-01-M1-R2",
          pdfBytes: pdf("rendered again"),
          issuedAt: "2026-01-14T00:00:00.000Z",
          email: { sentAt: "2026-01-14T00:00:00.000Z", messageId: "msg-resend", to: ["customer@example.invalid"] },
        });
        assert.equal(resent.redelivery.event.data.bytesMatchIssued, false);
        assert.deepEqual((await live.readIssuedDocument(document.uid)).bytes, ledgerJob.bytes.r2);
        assert.equal(recorder.status().redelivered, 1);

        // A failed email with no issued document yet.
        await recorder.recordEmailFailure({ jobId: "job-ledger", documentType: "quote", number: "EQ-2601-01 v2", attemptId: "att-9", outcome: "failed", error: new Error("smtp said no"), at: "2026-01-15T00:00:00.000Z" });
        const listed = await live.listJobDocuments("job-ledger");
        assert.deepEqual(listed.unattachedEvents.map((event) => [event.event, event.data.outcome, event.data.error]), [["email_failed", "failed", "smtp said no"]]);
      } finally {
        await t2.close();
      }
    });

    test("a database failure is logged and counted, never thrown", async () => {
      const lines = [];
      const broken = {
        recordIssuedDocument: async () => { throw new Error("connection reset"); },
        findIssuedDocument: async () => { throw new Error("connection reset"); },
        recordEvent: async () => { throw new Error("connection reset"); },
      };
      const recorder = createIssuedDocumentRecorder({ service: broken, logger: { error: (line) => lines.push(line), warn: () => {} } });
      assert.equal(await recorder.recordDelivery({ jobId: "j", documentType: "quote", number: "EQ-1 v1", pdfBytes: pdf("x"), issuedAt: "2026-01-01T00:00:00.000Z" }), null);
      assert.equal(await recorder.recordInvoiceRevisions(ledgerJob.dir), null);
      assert.equal(await recorder.recordEmailFailure({ jobId: "j", documentType: "quote", number: "EQ-1 v1", outcome: "failed", at: "2026-01-01T00:00:00.000Z" }), null);
      assert.equal(recorder.status().failures, 3);
      assert.equal(recorder.status().lastError.message, "connection reset");
      assert.match(lines[0], /quote delivery not recorded for job j \(EQ-1 v1\): connection reset; the job files still hold it/);
    });

    test("without a database every call is skipped with one log line per kind", async () => {
      const lines = [];
      const recorder = createUnavailableIssuedDocumentRecorder("no database configured", { logger: { warn: (line) => lines.push(line) } });
      await recorder.recordDelivery({});
      await recorder.recordDelivery({});
      assert.deepEqual(recorder.status(), { enabled: false, reason: "no database configured", skipped: { delivery: 2, emailFailure: 0, attachmentEmails: 0, invoiceRevisions: 0 } });
      assert.equal(lines.length, 1);
      assert.match(lines[0], /no database configured: issued deliveries are not recorded/);
    });

    test("the send path names a document the way its PDF prints it", () => {
      const quote = describeDeliveredDocument({ documentType: "quote", preparedMeta: { id: "j", contactName: "Pat" }, preparedQuote: { quoteNumber: "EQ-2601-01", version: 2 }, version: 2 });
      assert.equal(quote.number, "EQ-2601-01 v2");
      assert.equal(quote.details.customer.name, "Pat");
      const milestoneInvoice = { milestoneIndex: 0, invoiceNumber: "EI-2601-01-M1-R2", receiptNumber: "ER-2601-01-M1", issuedRevision: { invoiceNumber: "EI-2601-01-M1-R2", revisionNumber: 2, quoteVersion: 1, issuedAt: "2026-01-12T00:00:00.000Z", total: 1100 } };
      const invoice = describeDeliveredDocument({ documentType: "invoice", preparedMeta: { id: "j", milestoneInvoice }, preparedQuote: { quoteNumber: "EI-2601-01-M1-R2" }, preparedMilestoneInvoice: milestoneInvoice, version: 1 });
      assert.deepEqual([invoice.number, invoice.revision, invoice.quoteVersion, invoice.issuedAt], ["EI-2601-01-M1-R2", 2, 1, "2026-01-12T00:00:00.000Z"]);
      const receipt = describeDeliveredDocument({ documentType: "receipt", preparedMeta: { id: "j", milestoneInvoice }, preparedQuote: {}, preparedMilestoneInvoice: milestoneInvoice, version: 1 });
      assert.equal(receipt.number, "ER-2601-01-M1");
    });
  });

  describe("read routes", () => {
    let server;
    let base;
    let fail410 = false;
    let noDatabase = false;

    before(async () => {
      const app = express();
      const real = createPostgresBlobStore();
      const blobs = { ...real, get: async (sha, options) => (fail410 ? null : real.get(sha, options)) };
      const jobs = { "job-ledger": { dir: ledgerJob.dir, meta: { id: "job-ledger" } } };
      registerIssuedDocumentRoutes(app, {
        // Test sign-in: the X-Org header names the caller's organisation.
        requireAuth: (req, _res, next) => { req.fieldOrg = req.get("x-org") ? { uid: req.get("x-org") } : null; next(); },
        getDb: () => { if (noDatabase) throw new NoDatabaseError(); return t.db; },
        requestOrgUid,
        findJob: async (id) => jobs[id] || null,
        blobs,
      });
      server = createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((resolve) => server.close(resolve)));

    const get = (path, org = DEFAULT_ORG_UID) => fetch(`${base}${path}`, { headers: org ? { "x-org": org } : {} });

    test("lists a job's documents with their emails, and serves each one's exact bytes", async () => {
      const res = await get("/api/jobs/job-ledger/documents");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.documents.length, 4);
      const r2 = body.documents.find((doc) => doc.number === "EI-2601-01-M1-R2");
      assert.deepEqual(r2.emailed.map((entry) => entry.messageId), ["msg-invoice"]);
      for (const doc of body.documents) {
        const pdfRes = await get(doc.pdfUrl);
        assert.equal(pdfRes.status, 200, doc.number);
        assert.equal(pdfRes.headers.get("content-type"), "application/pdf");
        const bytes = Buffer.from(await pdfRes.arrayBuffer());
        assert.equal(sha256Hex(bytes), doc.pdfSha256);
        assert.equal(pdfRes.headers.get("etag"), `"${doc.pdfSha256}"`);
      }
      assert.equal((await get(`/api/documents/${r2.uid}/pdf`)).headers.get("content-disposition"), 'inline; filename="EI-2601-01-M1-R2.pdf"');
    });

    test("404 for another organisation's document, a malformed uid or an unknown job; 403 without an organisation", async () => {
      const { documents } = await (await get("/api/jobs/job-ledger/documents")).json();
      assert.equal((await get(`/api/documents/${documents[0].uid}/pdf`, ORG_B)).status, 404);
      assert.deepEqual((await (await get("/api/jobs/job-ledger/documents", ORG_B)).json()).documents, []);
      assert.equal((await get("/api/documents/doc_nope/pdf")).status, 404);
      assert.equal((await get("/api/documents/doc_01ARZ3NDEKTSV4RRFFQ69G5FAV/pdf")).status, 404);
      assert.equal((await get("/api/jobs/job-unknown/documents")).status, 404);
      assert.equal((await get(`/api/documents/${documents[0].uid}/pdf`, null)).status, 403);
    });

    test("410 when the bytes are gone, 503 without a database", async () => {
      const { documents } = await (await get("/api/jobs/job-ledger/documents")).json();
      fail410 = true;
      try {
        const res = await get(`/api/documents/${documents[0].uid}/pdf`);
        assert.equal(res.status, 410);
        assert.equal((await res.json()).code, "DOCUMENT_BYTES_MISSING");
      } finally {
        fail410 = false;
      }
      noDatabase = true;
      try {
        assert.equal((await get(`/api/documents/${documents[0].uid}/pdf`)).status, 503);
        assert.equal((await get("/api/jobs/job-ledger/documents")).status, 503);
      } finally {
        noDatabase = false;
      }
    });
  });
});
