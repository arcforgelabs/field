// The quote-row dual-write (#6) through today's real actions: a lock, a
// send and a fork each commit a job generation, the installed listener writes
// the rows, and the send links the issued document. A version the rows
// cannot reproduce is counted and left out; nothing here can fail the action.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { sendJobQuote, updateJobQuote } from "../job-actions.js";
import { installJobGenerationCommitListener, runAtomicJobGeneration } from "../job-generation.js";
import { forkCurrentQuoteVersion } from "../quote-artifacts.js";
import { createQuoteSnapshotStore } from "../quote-snapshots.js";
import { createTestPriceCatalog } from "../test-price-catalog.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { createIssuedDocumentRecorder, installIssuedDocumentRecorder } from "../documents/recorder.js";
import { createQuoteRowService } from "./quote-rows.js";
import { createQuoteRowRecorder, createUnavailableQuoteRowRecorder, installQuoteRowRecorder, quoteRowRecorder } from "./recorder.js";
import { floatRoundedLineQuote, subCentRateQuote } from "./test-fixtures.js";

function sendableQuote(meta, { version = 1 } = {}) {
  return {
    kind: "quote",
    version,
    status: "ready",
    generatedAt: "2026-03-27T00:00:00.000Z",
    updatedAt: "2026-03-27T00:00:00.000Z",
    jobId: meta.id,
    quoteNumber: meta.quoteNumber,
    jobNumber: meta.jobNumber,
    title: meta.title,
    recordingIntent: "job-scope",
    summary: "Install drainage and backfill.",
    quoteCatalog: { id: "sample-default", name: "Sample Default", currency: "AUD", gstRate: 0.1 },
    lineItems: [{ code: "drainage", label: "Drainage installation", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, unitCost: 70, totalCost: 70, section: "Works", customerVisible: true }],
    presentation: {
      scopeText: "Install drainage and backfill.",
      scheduleItems: [{ code: "drainage", label: "Drainage installation", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, sourceLineItemCodes: ["drainage"] }],
    },
    totals: { subtotal: 100, gst: 10, total: 110, currency: "AUD" },
    pricing: {
      authorityProvider: "price_catalog",
      ready: true,
      displayable: true,
      sendable: true,
      blockingReason: null,
      attestation: { status: "verified", requestNonce: "req-verified", verifiedNonce: "req-verified" },
    },
    review: { status: "ready", reasons: [] },
    delivery: { status: "draft", finalizedAt: null },
    assumptions: [],
    assumptionInputs: [],
    missingInputs: [],
  };
}

describe("quote-row dual-write", () => {
  let catalog;
  let rows;
  let recorder;
  let documents;
  const warnings = [];

  before(async () => {
    catalog = await createTestPriceCatalog({ track: false });
    documents = createIssuedDocumentService({ db: catalog.db, orgUid: DEFAULT_ORG_UID });
    installIssuedDocumentRecorder(createIssuedDocumentRecorder({ service: documents, logger: { error: () => {}, warn: () => {} } }));
    rows = createQuoteRowService({ db: catalog.db, orgUid: DEFAULT_ORG_UID });
    recorder = createQuoteRowRecorder({ service: rows, issuedDocuments: documents, logger: { error: (line) => warnings.push(line), warn: (line) => warnings.push(line) } });
    installQuoteRowRecorder(recorder);
    installJobGenerationCommitListener((jobDir) => recorder.syncJob(jobDir, { reason: "test commit" }));
  });
  after(async () => {
    installJobGenerationCommitListener(null);
    installQuoteRowRecorder(null);
    installIssuedDocumentRecorder(null);
    await catalog.close();
  });

  test("lock, send and fork each leave the rows equal to the files; the send links the issued document", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "field-quote-rows-dual-"));
    try {
      const meta = { id: "job-dual-1", title: "Dual-write test", label: "Dual-write test", outputMode: "quote", pipelineStage: "draft", quoteVersion: 1, quoteNumber: "EQ-DUAL-01", jobNumber: "JOB-DUAL-01", contactName: "Robin Customer" };
      await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
      await writeFile(join(jobDir, "quote.json"), JSON.stringify(sendableQuote(meta), null, 2));

      // Lock (a committed generation): v1 is a draft with its rows.
      const locked = await updateJobQuote({ jobDir, meta, config: {}, patch: { lockStatus: "final" }, actor: { kind: "user", label: "Test Operator" } });
      let v1 = await rows.getQuoteVersion(meta.id, 1);
      assert.equal(v1.quote.status, "draft");
      assert.deepEqual([v1.quote.number, v1.quote.subtotal, v1.quote.taxTotal, v1.quote.total], ["EQ-DUAL-01", "100.00", "10.00", "110.00"]);
      assert.deepEqual(v1.lines.map((line) => [line.lineType, line.name, line.lineTotal]), [["custom", "Drainage installation", "100.00"]]);
      assert.equal(v1.quote.customer.name, "Robin Customer");

      // Send: the version is sent, with the issued document the email carried.
      const snapshots = createQuoteSnapshotStore({ db: catalog.db });
      const sent = await sendJobQuote({
        jobDir,
        meta: locked.meta,
        dataDir: jobDir,
        config: { quoteSnapshots: snapshots, priceCatalog: catalog.store },
        user: { id: "user-1", email: "estimator@example.invalid", name: "Estimator" },
        to: "customer@example.invalid",
        documentType: "quote",
        sendEmail: async () => ({ id: "msg-dual-1", threadId: "thread-dual-1", subject: "Quote", to: "customer@example.invalid" }),
      });
      const issued = await documents.findIssuedDocument({ documentType: "quote", number: "EQ-DUAL-01 v1" });
      assert.ok(issued, "the send recorded the issued document");
      v1 = await rows.getQuoteVersion(meta.id, 1);
      assert.equal(v1.quote.status, "sent");
      assert.ok(v1.quote.sentAt, "with its send time");
      assert.equal(v1.quote.issuedDocumentUid, issued.uid);
      assert.equal(v1.quote.total, "110.00");
      assert.equal(issued.details.total, 110, "the issued document's totals agree");

      // Fork: v2 is a new draft; v1 stays sent and frozen.
      await forkCurrentQuoteVersion(jobDir);
      const listed = await rows.listJobQuotes(meta.id);
      assert.deepEqual(listed.map((quote) => [quote.version, quote.status]), [[1, "sent"], [2, "draft"]]);
      const v2 = await rows.getQuoteVersion(meta.id, 2);
      assert.equal(v2.quote.total, "110.00");
      assert.notEqual(v2.quote.uid, v1.quote.uid);
      assert.equal(sent.meta.pipelineStage, "sent");

      const status = recorder.status();
      assert.equal(status.enabled, true);
      assert.equal(status.failures, 0, warnings.join("\n"));
      assert.equal(status.mismatches, 0);
      assert.ok(status.created >= 2 && status.statusUpdated >= 1, JSON.stringify(status));
      assert.ok(status.unchanged > 0, "unchanged versions are skipped on later commits");
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  test("rates with more than two decimals and amounts the old renderer rounded are written as printed", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "field-quote-rows-printed-"));
    try {
      const meta = { id: "job-dual-2", title: "Printed", quoteNumber: "EQ-2501-07", pipelineStage: "draft" };
      await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
      await runAtomicJobGeneration(jobDir, async (staged) => {
        await writeFile(join(staged, "quote.json"), JSON.stringify(floatRoundedLineQuote(), null, 2));
      });
      const written = await rows.getQuoteVersion(meta.id, 1);
      assert.deepEqual([written.quote.subtotal, written.quote.taxTotal, written.quote.total], ["3.01", "0.30", "3.31"]);
      assert.deepEqual([written.lines[0].unitSell, written.lines[0].lineTotal, written.lines[0].lineTotalSource], ["1.0050", "3.01", "printed"]);
      await runAtomicJobGeneration(jobDir, async (staged) => {
        await writeFile(join(staged, "quote.json"), JSON.stringify(subCentRateQuote(), null, 2));
      });
      const replaced = await rows.getQuoteVersion(meta.id, 1);
      assert.deepEqual([replaced.lines[0].unitSell, replaced.lines[0].lineTotal, replaced.lines[0].lineTotalSource], ["33.3350", "100.01", "computed"]);
      assert.equal(recorder.status().mismatches, 0);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  test("a version that fails its check is counted with both numbers, once, and its draft rows removed; nothing throws", async () => {
    const lines = [];
    let deleted = null;
    const failing = {
      jobId: "job-x",
      ok: false,
      removed: [],
      versions: [{ version: 1, number: "EQ-X", ok: false, action: "removed-stale-draft", failures: [{ kind: "totals", against: "shown", field: "subtotal", rows: "10.00", shown: "10.01" }] }],
    };
    const stub = createQuoteRowRecorder({
      service: { deleteDraftVersion: async (...args) => { deleted = args; return { deleted: true }; } },
      logger: { error: (line) => lines.push(line), warn: (line) => lines.push(line) },
      sync: async () => failing,
    });
    assert.equal(await stub.syncJob("/job-x"), failing);
    await stub.syncJob("/job-x");
    const status = stub.status();
    assert.equal(status.mismatches, 1, "the same failure on a later commit is not counted again");
    assert.equal(status.removed, 2);
    assert.deepEqual(status.lastMismatch.failures[0], failing.versions[0].failures[0]);
    assert.equal(lines.filter((line) => /job job-x v1: rows not written \(subtotal rows 10\.00 vs shown 10\.01\)/.test(line)).length, 1);
    assert.equal(deleted, null, "the sync, not the recorder, removes stale rows");
  });

  test("a recorder whose database fails logs, counts and returns null", async () => {
    const lines = [];
    const broken = createQuoteRowRecorder({
      service: { listJobQuotes: async () => { throw new Error("database is down"); } },
      logger: { error: (line) => lines.push(line), warn: () => {} },
    });
    const jobDir = await mkdtemp(join(tmpdir(), "field-quote-rows-broken-"));
    try {
      await writeFile(join(jobDir, "meta.json"), JSON.stringify({ id: "job-broken" }));
      assert.equal(await broken.syncJob(jobDir), null);
      assert.equal(broken.status().failures, 1);
      assert.match(broken.status().lastError.message, /database is down/);
      assert.match(lines[0], /the job files still hold them/);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  test("without a database, the recorder skips with one log line; uninstalled, it is a no-op", async () => {
    const lines = [];
    const unavailable = createUnavailableQuoteRowRecorder("no database configured", { logger: { warn: (line) => lines.push(line) } });
    await unavailable.syncJob("/nowhere");
    await unavailable.syncJob("/nowhere");
    assert.equal(lines.length, 1);
    assert.deepEqual(unavailable.status(), { enabled: false, reason: "no database configured", skipped: 2 });
    installQuoteRowRecorder(null);
    try {
      assert.equal(quoteRowRecorder().enabled, false);
      assert.equal(await quoteRowRecorder().syncJob("/nowhere"), null);
    } finally {
      installQuoteRowRecorder(recorder);
    }
  });
});
