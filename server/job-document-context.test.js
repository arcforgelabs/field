import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMilestoneInvoiceRevisionState,
  buildMilestoneInvoices,
  recordMilestoneInvoicePayment,
  updateMilestoneInvoice,
} from "./job-documents.js";
import {
  readDocumentQuoteArtifacts,
  readPreparedJobDocument,
  resolveIssuedMilestoneInvoiceArtifact,
  resolveIssuedQuotePdf,
} from "./job-document-context.js";
import { findIssuedQuoteVersion, readQuoteIssuanceLedger, recordIssuedQuoteDocuments } from "./quote-issuance.js";
import { isIssuedQuoteVersion } from "./quote-pricing-attestation.js";
import { writeJobMeta } from "./job-meta-store.js";
import { writeMilestoneInvoiceArtifact } from "./quote-artifacts.js";
import { QUOTE_LIFECYCLE_FILE } from "./quote-lifecycle.js";
import { ARTIFACT_STATE } from "./invoice-artifact-state.js";

function createMeta(overrides = {}) {
  return {
    id: "job-document-context-1",
    title: "Document context test",
    label: "Document context test",
    outputMode: "quote",
    pipelineStage: "landed",
    deliveryStatus: "landed",
    quoteSentAt: "2026-04-10T00:00:00.000Z",
    quoteVersion: 2,
    quoteNumber: "EQ-DOC-01",
    jobNumber: "JOB-DOC-01",
    createdAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function createQuote(meta, { version, total, deliveryStatus = "draft" }) {
  const subtotal = Math.round((total / 1.1) * 100) / 100;
  const gst = Math.round((total - subtotal) * 100) / 100;
  return {
    kind: "quote",
    version,
    quoteNumber: meta.quoteNumber,
    jobNumber: meta.jobNumber,
    title: meta.title,
    summary: `Document context test v${version}`,
    quoteCatalog: {
      id: "embark-default",
      name: "Sample Catalogue",
      currency: "AUD",
      gstRate: 0.1,
    },
    presentation: {
      scopeText: `Document context test v${version}`,
      scheduleItems: [
        {
          code: "scope",
          label: `Scope item v${version}`,
          quantity: 1,
          unit: "lot",
          unitPrice: subtotal,
          totalPrice: subtotal,
          sourceLineItemCodes: ["scope"],
        },
      ],
    },
    lineItems: [
      {
        code: "scope",
        label: `Scope item v${version}`,
        quantity: 1,
        unit: "lot",
        unitPrice: subtotal,
        totalPrice: subtotal,
        customerVisible: true,
      },
    ],
    totals: {
      subtotal,
      gst,
      total,
      currency: "AUD",
    },
    delivery: {
      status: deliveryStatus,
    },
  };
}

async function writeQuoteVersion(jobDir, quote, version = null) {
  const baseDir = version == null
    ? jobDir
    : join(jobDir, "quote-versions", `v${String(version).padStart(3, "0")}`);
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, "quote.json"), JSON.stringify(quote, null, 2));
}

async function seedVersionedQuoteJob(jobDir, { paidMilestone = false } = {}) {
  const paymentSchedule = {
    milestones: [
      { label: "Full payment", percentage: 100 },
    ],
  };
  const meta = createMeta({ paymentSchedule });
  const customerQuote = createQuote(meta, { version: 1, total: 220, deliveryStatus: "final" });
  const latestDraftQuote = createQuote(meta, { version: 2, total: 330, deliveryStatus: "draft" });
  let milestoneInvoices = buildMilestoneInvoices({
    meta: {
      ...meta,
      quoteVersion: 1,
    },
    quote: customerQuote,
    paymentSchedule,
  }).milestoneInvoices;
  if (paidMilestone) {
    const authorised = updateMilestoneInvoice({
      milestoneInvoices,
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });
    const paid = recordMilestoneInvoicePayment({
      milestoneInvoices: authorised.milestoneInvoices,
      milestoneIndex: 0,
      payment: {
        amount: customerQuote.totals.total,
        date: "2026-04-10",
        reference: "EFT-DOC-01",
        method: "bank_transfer",
      },
    });
    milestoneInvoices = paid.milestoneInvoices;
  }

  await writeJobMeta(jobDir, {
    ...meta,
    milestoneInvoices,
  });
  await writeQuoteVersion(jobDir, latestDraftQuote);
  await writeQuoteVersion(jobDir, customerQuote, 1);
  await writeFile(join(jobDir, QUOTE_LIFECYCLE_FILE), JSON.stringify({
    version: 1,
    currentQuoteVersion: 2,
    lastSentQuoteVersion: 1,
    currentPipelineStage: "landed",
    sendCount: 1,
  }, null, 2));

  return {
    meta,
    customerQuote,
    latestDraftQuote,
  };
}

test("readDocumentQuoteArtifacts defaults non-draft quote reads to the locked customer version and allows explicit latest selection", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-context-"));

  try {
    const { meta, customerQuote, latestDraftQuote } = await seedVersionedQuoteJob(jobDir);

    const defaultQuote = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "quote",
    });
    assert.equal(defaultQuote.selectedVersion, 1);
    assert.equal(defaultQuote.selectedQuoteArtifacts.quote.version, customerQuote.version);

    const latestQuote = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "quote",
      requestedVersion: 2,
    });
    assert.equal(latestQuote.selectedVersion, 2);
    assert.equal(latestQuote.selectedQuoteArtifacts.quote.version, latestDraftQuote.version);

    // The "latest" sentinel must bypass the lastSent fallback so post-mutation
    // refetches resolve to the actual newest version, not the locked one.
    const latestSentinel = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "quote",
      requestedVersion: "latest",
    });
    assert.equal(latestSentinel.selectedVersion, 2);
    assert.equal(latestSentinel.selectedQuoteArtifacts.quote.version, latestDraftQuote.version);

    // Invoices must continue to ignore "latest" and stay on the customer-locked
    // version, mirroring the existing numeric-override invariant.
    const invoiceLatest = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "invoice",
      requestedVersion: "latest",
    });
    assert.equal(invoiceLatest.selectedVersion, 1);
    assert.equal(invoiceLatest.selectedQuoteArtifacts.quote.version, customerQuote.version);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("readDocumentQuoteArtifacts with intent 'delivery' resolves an unversioned quote request to the latest revision", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-context-delivery-"));

  try {
    const { meta, customerQuote, latestDraftQuote } = await seedVersionedQuoteJob(jobDir);

    // Default (view) intent: unchanged — locks to what the customer last saw.
    const viewDefault = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "quote",
    });
    assert.equal(viewDefault.selectedVersion, 1);
    assert.equal(viewDefault.selectedQuoteArtifacts.quote.version, customerQuote.version);

    // Delivery intent, no explicit version: resolves to the latest revision —
    // the fix for defect B. A revised quote sent with no explicit version
    // must go out as the new revision, not the stale customer-seen one.
    const deliveryDefault = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "quote",
      intent: "delivery",
    });
    assert.equal(deliveryDefault.selectedVersion, 2);
    assert.equal(deliveryDefault.selectedQuoteArtifacts.quote.version, latestDraftQuote.version);

    // Delivery intent with an explicit version still honours it.
    const deliveryExplicit = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "quote",
      intent: "delivery",
      requestedVersion: 1,
    });
    assert.equal(deliveryExplicit.selectedVersion, 1);
    assert.equal(deliveryExplicit.selectedQuoteArtifacts.quote.version, customerQuote.version);

    // Delivery intent must not change invoice/receipt resolution — invoices
    // stay pinned to the customer-seen quote basis regardless of intent.
    const deliveryInvoice = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "invoice",
      intent: "delivery",
    });
    assert.equal(deliveryInvoice.selectedVersion, 1);
    assert.equal(deliveryInvoice.selectedQuoteArtifacts.quote.version, customerQuote.version);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("readDocumentQuoteArtifacts falls back to latest when implicit locked version was deleted", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-missing-locked-"));

  try {
    const { meta, latestDraftQuote } = await seedVersionedQuoteJob(jobDir);
    await rm(join(jobDir, "quote-versions", "v001"), { recursive: true, force: true });

    const defaultQuote = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "quote",
    });
    assert.equal(defaultQuote.selectedVersion, 2);
    assert.equal(defaultQuote.selectedQuoteArtifacts.quote.version, latestDraftQuote.version);

    const defaultInvoice = await readDocumentQuoteArtifacts({
      jobDir,
      meta,
      documentType: "invoice",
    });
    assert.equal(defaultInvoice.selectedVersion, 2);
    assert.equal(defaultInvoice.selectedQuoteArtifacts.quote.version, latestDraftQuote.version);

    let explicitHistoricalError = null;
    try {
      await readDocumentQuoteArtifacts({
        jobDir,
        meta,
        documentType: "quote",
        requestedVersion: 1,
      });
    } catch (err) {
      explicitHistoricalError = err;
    }
    assert.ok(explicitHistoricalError, "expected explicit missing version to fail");
    assert.equal(explicitHistoricalError.statusCode, 404);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("readPreparedJobDocument ignores explicit draft version overrides for milestone invoices", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-invoice-"));

  try {
    const { meta, customerQuote } = await seedVersionedQuoteJob(jobDir);

    const preparedInvoice = await readPreparedJobDocument({
      jobDir,
      meta,
      documentType: "invoice",
      requestedVersion: 2,
      milestoneIndex: 0,
    });

    assert.equal(preparedInvoice.selectedVersion, 1);
    assert.equal(preparedInvoice.preparedDocumentType, "invoice");
    assert.equal(preparedInvoice.preparedQuote.version, customerQuote.version);
    assert.equal(preparedInvoice.preparedQuote.totals.total, 220);
    assert.equal(preparedInvoice.preparedMilestoneInvoice.invoiceNumber, "EI-DOC-01-M1");
    assert.equal(preparedInvoice.preparedMilestoneInvoice.total, 220);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("readPreparedJobDocument ignores explicit draft version overrides for milestone receipts", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-receipt-"));

  try {
    const { meta, customerQuote } = await seedVersionedQuoteJob(jobDir, { paidMilestone: true });

    const preparedReceipt = await readPreparedJobDocument({
      jobDir,
      meta,
      documentType: "receipt",
      requestedVersion: 2,
      milestoneIndex: 0,
    });

    assert.equal(preparedReceipt.selectedVersion, 1);
    assert.equal(preparedReceipt.preparedDocumentType, "receipt");
    assert.equal(preparedReceipt.preparedQuote.version, customerQuote.version);
    assert.equal(preparedReceipt.preparedQuote.quoteNumber, "ER-DOC-01-M1");
    assert.equal(preparedReceipt.preparedMilestoneInvoice.receiptNumber, "ER-DOC-01-M1");
    assert.equal(preparedReceipt.preparedMilestoneInvoice.total, 220);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("readPreparedJobDocument honours explicit documentType=quote on a landed job (H1)", async () => {
  // Covers the /api/jobs/:id/quote-pdf?documentType=quote GET flow. On a
  // landed job the default resolves to invoice, but the caller can override.
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-landed-quote-doc-"));

  try {
    const { meta, customerQuote, latestDraftQuote } = await seedVersionedQuoteJob(jobDir);

    // No override — landed job defaults to invoice on the customer version.
    const defaultInvoice = await readPreparedJobDocument({
      jobDir,
      meta,
    });
    assert.equal(defaultInvoice.preparedDocumentType, "invoice");
    assert.equal(defaultInvoice.selectedVersion, 1);

    // documentType=quote — still anchors to the locked customer revision
    // (no explicit version override), and returns the customer quote, not
    // the milestone-invoice synthesized document.
    const quoteOnLanded = await readPreparedJobDocument({
      jobDir,
      meta,
      documentType: "quote",
    });
    assert.equal(quoteOnLanded.preparedDocumentType, "quote");
    assert.equal(quoteOnLanded.selectedVersion, 1);
    assert.equal(quoteOnLanded.preparedQuote.version, customerQuote.version);
    assert.equal(quoteOnLanded.preparedMilestoneInvoice, null);

    // documentType=quote + explicit latest — intentionally serve the newer
    // draft for internal preview, even though the job is landed.
    const latestQuoteOnLanded = await readPreparedJobDocument({
      jobDir,
      meta,
      documentType: "quote",
      requestedVersion: 2,
    });
    assert.equal(latestQuoteOnLanded.preparedDocumentType, "quote");
    assert.equal(latestQuoteOnLanded.selectedVersion, 2);
    assert.equal(latestQuoteOnLanded.preparedQuote.version, latestDraftQuote.version);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("readPreparedJobDocument surfaces 404 for an out-of-range milestone index", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-bad-ms-"));

  try {
    const { meta } = await seedVersionedQuoteJob(jobDir);

    let caught = null;
    try {
      await readPreparedJobDocument({
        jobDir,
        meta,
        documentType: "invoice",
        milestoneIndex: 99,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected milestone lookup failure");
    assert.equal(caught.statusCode, 404);
    assert.match(caught.message, /milestone invoice not found/i);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// Shared resolver used by every invoice download/preview route:
// a sent invoice must be served from the bytes it was issued with, never
// re-rendered from whatever the quote looks like now.
// The quote-pdf and preview routes ask resolveIssuedQuotePdf with what they
// resolved for the request; this mirrors that sequence.
async function resolveIssuedQuotePdfForRequest(jobDir, meta, { documentType = null, milestoneIndex = null } = {}) {
  const prepared = await readPreparedJobDocument({ jobDir, meta, documentType, milestoneIndex });
  const issuanceRecord = prepared.preparedDocumentType === "quote"
    ? findIssuedQuoteVersion(await readQuoteIssuanceLedger(jobDir), prepared.selectedVersion, "quote")
    : null;
  const issuedVersion = isIssuedQuoteVersion({
    quote: prepared.preparedQuote,
    quoteLifecycle: prepared.quoteLifecycle,
    version: prepared.selectedVersion,
    meta: prepared.meta,
    issuanceRecord,
  });
  return {
    prepared,
    issuedVersion,
    result: await resolveIssuedQuotePdf({
      jobDir,
      documentType: prepared.preparedDocumentType,
      issuanceRecord,
      issuedVersion,
      selectedVersion: prepared.selectedVersion,
      storedPdfPath: prepared.selectedQuoteArtifacts?.quotePdfPath,
    }),
  };
}

test("resolveIssuedQuotePdf never refuses an invoice or receipt because the quote it was built from was sent", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-context-"));
  try {
    const { meta } = await seedVersionedQuoteJob(jobDir, { paidMilestone: true });
    const issuedPdf = Buffer.from("%PDF-1.3 issued quote v1");
    await recordIssuedQuoteDocuments({ jobDir, quoteVersion: 1, quotePdf: issuedPdf });

    // A landed job with no documentType resolves to its invoice (documented
    // default); with the quote sent this used to answer 410 "the exact issued
    // quote PDF bytes are unavailable".
    const bare = await resolveIssuedQuotePdfForRequest(jobDir, meta);
    assert.equal(bare.prepared.preparedDocumentType, "invoice");
    assert.equal(bare.issuedVersion, true);
    assert.deepEqual(bare.result, { render: true });

    const invoice = await resolveIssuedQuotePdfForRequest(jobDir, meta, { documentType: "invoice", milestoneIndex: 0 });
    assert.deepEqual(invoice.result, { render: true });
    const receipt = await resolveIssuedQuotePdfForRequest(jobDir, meta, { documentType: "receipt", milestoneIndex: 0 });
    assert.deepEqual(receipt.result, { render: true });

    // The quote itself is still served from its exact issued bytes.
    const quote = await resolveIssuedQuotePdfForRequest(jobDir, meta, { documentType: "quote" });
    assert.equal(quote.result.source, "issuance-ledger");
    assert.ok(quote.result.bytes.equals(issuedPdf));
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("resolveIssuedQuotePdf answers gone for a sent quote with no exact copy, and render for an unsent one", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-context-"));
  try {
    const { meta } = await seedVersionedQuoteJob(jobDir);
    // v1 was sent before the issuance ledger and no PDF of it survives.
    const legacy = await resolveIssuedQuotePdfForRequest(jobDir, meta, { documentType: "quote" });
    assert.equal(legacy.issuedVersion, true);
    assert.deepEqual(legacy.result, { gone: true });

    // A ledger record whose bytes no longer match is gone too, never re-rendered.
    const record = await recordIssuedQuoteDocuments({ jobDir, quoteVersion: 1, quotePdf: Buffer.from("%PDF-1.3 v1") });
    await writeFile(join(jobDir, record.artifacts.quotePdf.path), "%PDF-1.3 tampered");
    const tampered = await resolveIssuedQuotePdfForRequest(jobDir, meta, { documentType: "quote" });
    assert.deepEqual(tampered.result, { gone: true });

    assert.deepEqual(await resolveIssuedQuotePdf({ jobDir, documentType: "quote", issuedVersion: false }), { render: true });
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("resolveIssuedMilestoneInvoiceArtifact serves stored issued bytes regardless of the current quote, and 404s an unknown requested revision", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-resolver-"));

  try {
    const paymentSchedule = { milestones: [{ label: "Full payment", percentage: 100 }] };
    const meta = createMeta({ paymentSchedule, quoteNumber: "EQ-RESOLVER-01", jobNumber: "JOB-RESOLVER-01" });
    const quote = createQuote(meta, { version: 1, total: 220, deliveryStatus: "final" });

    const built = buildMilestoneInvoices({ meta: { ...meta, quoteVersion: 1 }, quote, paymentSchedule });
    const issued = updateMilestoneInvoice({
      milestoneInvoices: built.milestoneInvoices,
      milestoneIndex: 0,
      patch: { status: "authorised" },
      quoteVersion: 1,
    }).milestoneInvoice;

    const writtenArtifact = await writeMilestoneInvoiceArtifact({
      jobDir,
      meta,
      quote,
      milestoneInvoice: issued,
    });
    assert.equal(writtenArtifact.alreadyIssued, false);

    // The resolver never looks at the current quote — it resolves purely
    // from the milestone invoice's own issued-revision state.
    const currentResolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: issued,
    });
    assert.ok(currentResolved.storedArtifact, "expected stored bytes for the current issued revision");
    assert.deepEqual(currentResolved.storedArtifact.pdfBuffer, writtenArtifact.pdfBuffer);
    assert.equal(currentResolved.revision.invoiceNumber, issued.invoiceNumber);

    const explicitResolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: issued,
      requestedRevision: 1,
    });
    assert.ok(explicitResolved.storedArtifact, "expected stored bytes for the explicitly requested revision 1");
    assert.deepEqual(explicitResolved.storedArtifact.pdfBuffer, writtenArtifact.pdfBuffer);

    const unknownResolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: issued,
      requestedRevision: 99,
    });
    assert.equal(unknownResolved.notFound, true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("resolveIssuedMilestoneInvoiceArtifact leaves draft, legacy, receipt and quote documents rendering as before, and 410s a superseded revision with no stored file", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-resolver-render-"));

  try {
    const paymentSchedule = { milestones: [{ label: "Full payment", percentage: 100 }] };
    const meta = createMeta({ paymentSchedule, quoteNumber: "EQ-RESOLVER-02", jobNumber: "JOB-RESOLVER-02" });
    const quote = createQuote(meta, { version: 1, total: 220, deliveryStatus: "final" });
    const built = buildMilestoneInvoices({ meta: { ...meta, quoteVersion: 1 }, quote, paymentSchedule });
    const draftMilestone = built.milestoneInvoices[0];

    // A draft (never issued) milestone always renders.
    const draftResolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: draftMilestone,
    });
    assert.equal(draftResolved.render, true);

    // A legacy invoice with no issuedRevision (legacy data) also renders.
    const legacyMilestone = {
      ...draftMilestone,
      status: "authorised",
      issuedAt: "2026-04-10T00:00:00.000Z",
      issuedRevision: null,
    };
    const legacyResolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: legacyMilestone,
    });
    assert.equal(legacyResolved.render, true);

    const issued = updateMilestoneInvoice({
      milestoneInvoices: built.milestoneInvoices,
      milestoneIndex: 0,
      patch: { status: "authorised" },
      quoteVersion: 1,
    }).milestoneInvoice;

    // Receipts and quotes are untouched regardless of milestone state.
    const receiptResolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "receipt",
      milestoneInvoice: issued,
    });
    assert.equal(receiptResolved.render, true);
    const quoteResolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "quote",
      milestoneInvoice: issued,
    });
    assert.equal(quoteResolved.render, true);

    // Mint a second revision without ever writing revision 1's PDF — this
    // reproduces the exact gap the write-once fix closes: a superseded
    // revision that points at bytes which were never captured.
    const revised = applyMilestoneInvoiceRevisionState({
      ...issued,
      total: issued.total + 10,
      subtotal: issued.subtotal + 10,
    }, {
      isIssued: true,
      quoteVersion: 2,
      authorization: {
        reason: "test revision",
        actor: { label: "Tester" },
        at: "2026-04-11T00:00:00.000Z",
      },
    });
    assert.equal(revised.revisionNumber, 2);
    assert.equal(revised.revisionHistory.length, 1);
    assert.ok(revised.revisionHistory[0].supersededAt);

    const goneResolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: revised,
      requestedRevision: 1,
    });
    assert.equal(goneResolved.gone, true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// Before this fix, only a *superseded* revision with a missing file 410'd —
// the ACTIVE, currently-issued revision fell through to `render: true` and
// the caller rendered a fresh document from whatever quote the request
// resolved, serving it under the invoice number the customer already holds.
test("resolveIssuedMilestoneInvoiceArtifact 410s an active (non-superseded) issued revision whose stored file is missing, instead of rendering", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-resolver-active-gone-"));

  try {
    const paymentSchedule = { milestones: [{ label: "Full payment", percentage: 100 }] };
    const meta = createMeta({ paymentSchedule, quoteNumber: "EQ-RESOLVER-03", jobNumber: "JOB-RESOLVER-03" });
    const quote = createQuote(meta, { version: 1, total: 220, deliveryStatus: "final" });
    const built = buildMilestoneInvoices({ meta: { ...meta, quoteVersion: 1 }, quote, paymentSchedule });
    const issued = updateMilestoneInvoice({
      milestoneInvoices: built.milestoneInvoices,
      milestoneIndex: 0,
      patch: { status: "authorised" },
      quoteVersion: 1,
    }).milestoneInvoice;

    const writtenArtifact = await writeMilestoneInvoiceArtifact({ jobDir, meta, quote, milestoneInvoice: issued });
    assert.equal(writtenArtifact.alreadyIssued, false);

    // Simulate the persisted, stamped state (the write path always transitions
    // artifactState to STORED, alongside pdfIssuedAt, the moment the artifact
    // is first written) and then the file going missing from disk afterwards —
    // lost, deleted, moved — while the revision itself is still the current,
    // active one.
    const stampedIssued = {
      ...issued,
      issuedRevision: {
        ...issued.issuedRevision,
        artifactState: ARTIFACT_STATE.STORED,
        pdfIssuedAt: "2026-04-10T00:05:00.000Z",
      },
    };
    await rm(writtenArtifact.pdfPath, { force: true });
    assert.equal(existsSync(writtenArtifact.pdfPath), false);

    const resolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: stampedIssued,
    });
    assert.equal(resolved.gone, true);
    assert.equal(resolved.render, undefined);
    assert.equal(resolved.storedArtifact, undefined);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("resolveIssuedMilestoneInvoiceArtifact 410s a legacyOrigin-synthesized revision whose stored file is missing, instead of rendering", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-resolver-legacy-gone-"));

  try {
    const milestoneInvoice = {
      milestoneIndex: 0,
      invoiceNumber: "EI-LEGACY-GONE-01",
      status: "authorised",
      issuedAt: "2026-01-01T00:00:00.000Z",
      issuedRevision: {
        revisionNumber: 1,
        invoiceNumber: "EI-LEGACY-GONE-01",
        issuedAt: "2026-01-01T00:00:00.000Z",
        subtotal: 100,
        gst: 10,
        total: 110,
        currency: "AUD",
        lineItems: [],
        pdfPath: "milestone-invoices/EI-LEGACY-GONE-01.pdf",
        // Marks a revision synthesized mid-rebuild from stored content that
        // predates per-revision tracking. A caller would not normally hand
        // this to a read-only resolver, but it is checked defensively.
        legacyOrigin: true,
      },
      revisionHistory: [],
    };
    assert.equal(existsSync(join(jobDir, "milestone-invoices", "EI-LEGACY-GONE-01.pdf")), false);

    const resolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice,
    });
    assert.equal(resolved.gone, true);
    assert.equal(resolved.render, undefined);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// `pdfUnrecoverable` is the signal that survives what `legacyOrigin` does
// not: an opportunistic (implicit) artifact write can fail and get caught
// rather than aborting an unrelated mutation, leaving a
// revision with no `pdfIssuedAt` and no `legacyOrigin` (stripped by
// normalization on the very next touch). Without this flag the read path
// would have no signal left at all and would fall through to `render`.
test("resolveIssuedMilestoneInvoiceArtifact 410s a pdfUnrecoverable revision whose stored file is missing, instead of rendering", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-resolver-unrecoverable-"));

  try {
    const milestoneInvoice = {
      milestoneIndex: 0,
      invoiceNumber: "EI-UNRECOVERABLE-01",
      status: "authorised",
      issuedAt: "2026-01-01T00:00:00.000Z",
      issuedRevision: {
        revisionNumber: 1,
        invoiceNumber: "EI-UNRECOVERABLE-01",
        issuedAt: "2026-01-01T00:00:00.000Z",
        subtotal: 100,
        gst: 10,
        total: 110,
        currency: "AUD",
        lineItems: [],
        pdfPath: "milestone-invoices/EI-UNRECOVERABLE-01.pdf",
        pdfIssuedAt: null,
        pdfUnrecoverable: true,
      },
      revisionHistory: [],
    };
    assert.equal(existsSync(join(jobDir, "milestone-invoices", "EI-UNRECOVERABLE-01.pdf")), false);

    const resolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice,
    });
    assert.equal(resolved.gone, true);
    assert.equal(resolved.render, undefined);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// Guards the legacy self-heal mechanism from over-firing: it must only
// adopt an existing file for a revision synthesized from legacy stored
// content (`legacyOrigin`), never for an ordinary fresh mint that simply
// happens to find a stray file already sitting at its path — e.g. a draft
// preview rendered before the milestone was authorised. Adopting that would
// silently ship stale pre-issue bytes as the "issued" document.
test("writeMilestoneInvoiceArtifact never self-heals an ordinary mint, only a legacyOrigin-marked revision", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-document-write-once-"));

  try {
    const paymentSchedule = { milestones: [{ label: "Full payment", percentage: 100 }] };
    const meta = createMeta({ paymentSchedule, quoteNumber: "EQ-WRITEONCE-01", jobNumber: "JOB-WRITEONCE-01" });
    const quote = createQuote(meta, { version: 1, total: 220, deliveryStatus: "final" });
    const built = buildMilestoneInvoices({ meta: { ...meta, quoteVersion: 1 }, quote, paymentSchedule });
    const freshlyIssued = updateMilestoneInvoice({
      milestoneInvoices: built.milestoneInvoices,
      milestoneIndex: 0,
      patch: { status: "authorised" },
      quoteVersion: 1,
    }).milestoneInvoice;
    assert.ok(freshlyIssued.issuedRevision, "expected a freshly minted issued revision");
    assert.notEqual(freshlyIssued.issuedRevision.artifactState, ARTIFACT_STATE.ADOPT_PENDING, "an ordinary mint must not be ADOPT_PENDING");

    // A stray file already sits at the target path (e.g. a draft preview
    // rendered before authorising) — it must be ignored, not adopted.
    const pdfPath = join(jobDir, freshlyIssued.pdfPath);
    await mkdir(join(jobDir, "milestone-invoices"), { recursive: true });
    const staleBytes = Buffer.from("%PDF-1.4 stale pre-issue draft bytes");
    await writeFile(pdfPath, staleBytes);

    const written = await writeMilestoneInvoiceArtifact({
      jobDir,
      meta,
      quote,
      milestoneInvoice: freshlyIssued,
    });
    assert.equal(written.alreadyIssued, false, "an ordinary mint renders fresh rather than adopting the stray file");
    assert.notDeepEqual(written.pdfBuffer, staleBytes);
    assert.notDeepEqual(await readFile(pdfPath), staleBytes);

    // A revision synthesized from legacy content (ARTIFACT_STATE.ADOPT_PENDING,
    // which supersedes the old transient `legacyOrigin` marker),
    // by contrast, does adopt the existing file. `freshlyIssued.issuedRevision`
    // already carries a real `artifactState` (UNWRITTEN, from its own mint) —
    // it must be overridden, not merely added alongside, exactly as the real
    // legacy-synthesis seam in `buildMilestoneInvoices` sets it directly
    // rather than layering it onto whatever state happened to be there.
    const legacyIssued = {
      ...freshlyIssued,
      issuedRevision: {
        ...freshlyIssued.issuedRevision,
        artifactState: ARTIFACT_STATE.ADOPT_PENDING,
        pdfIssuedAt: null,
      },
    };
    const legacyPdfPath = join(jobDir, "milestone-invoices", "EI-WRITEONCE-LEGACY.pdf");
    await writeFile(legacyPdfPath, staleBytes);
    const legacyWritten = await writeMilestoneInvoiceArtifact({
      jobDir,
      meta,
      quote,
      milestoneInvoice: { ...legacyIssued, pdfPath: "milestone-invoices/EI-WRITEONCE-LEGACY.pdf" },
    });
    assert.equal(legacyWritten.selfHealed, true);
    assert.deepEqual(legacyWritten.pdfBuffer, staleBytes);
    assert.ok(existsSync(legacyPdfPath));
    assert.deepEqual(await readFile(legacyPdfPath), staleBytes);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
