import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAndPersistQuote } from "./quote-workflow.js";
import {
  applyJobQuoteCatalogChanges,
  generateJobMilestones,
  markJobLanded,
  markJobMilestoneUnsent,
  markJobMilestoneUnpaid,
  migrateJobMilestoneInvoices,
  readJobQuoteCatalogChanges,
  recordJobMilestonePayment,
  regenerateRecordingQuote,
  reviseJobMilestoneInvoice,
  sendJobQuote,
  setJobPipelineStage,
  updateJobMilestone,
  updateJobQuote,
  voidJobMilestonePayment,
} from "./job-actions.js";
import { readJobMeta, writeJobMeta } from "./job-meta-store.js";
import { runAtomicJobGeneration } from "./job-generation.js";
import { forkCurrentQuoteVersion, promoteQuoteVersion, readMilestoneInvoiceRevisionArtifact, readQuoteArtifacts } from "./quote-artifacts.js";
import { findMilestoneInvoiceRevision } from "./job-documents.js";
import { readJobState } from "./job-state.js";
import { resolveIssuedMilestoneInvoiceArtifact } from "./job-document-context.js";
import { ARTIFACT_STATE } from "./invoice-artifact-state.js";
import { GMAIL_SEND_TIMEOUT_MS } from "./send-quote-email.js";
import { closeTestPriceCatalogs, createTestPriceCatalog, seedCatalogFromPriceMaps } from "./test-price-catalog.js";
import { createQuoteSnapshotStore } from "./quote-snapshots.js";
import { readQuoteIssuanceLedger } from "./quote-issuance.js";
import { readPendingQuoteDelivery } from "./quote-delivery-outbox.js";
import { assertQuotePricingDisplayable, attachQuotePricingAttestation, buildQuotePricingAttestation, isIssuedQuoteVersion, isQuotePricingSendable, validateQuoteCommercialArtifact, withCurrentPricingVerdict } from "./quote-pricing-attestation.js";
import { buildQuoteEditPolicy } from "./quote-edit-policy.js";
import { readQuoteLifecycle, recordQuoteLanded } from "./quote-lifecycle.js";
import { installTestInvoiceIssuer } from "./invoices/test-issuer.js";

const TEST_PRICE_CATALOG = await createTestPriceCatalog({ track: false });
const TEST_PRICE_CATALOG_DB = TEST_PRICE_CATALOG.store;
test.after(() => TEST_PRICE_CATALOG.close());
// Invoices are issued through the issue service (server/invoices/issue.js),
// as on a server with a database: INV-YYYY-M-N numbers, stored PDFs.
const TEST_INVOICE_ISSUER = await installTestInvoiceIssuer();
test.after(() => TEST_INVOICE_ISSUER.close());
const SEQUENCE_NUMBER = /^INV-\d{4}-([1-9]|1[0-2])-[1-9]\d*$/;

function createQuoteFixture(meta, overrides = {}) {
  return {
    kind: "quote",
    version: overrides.version || 2,
    status: "ready",
    generatedAt: "2026-03-27T00:00:00.000Z",
    updatedAt: "2026-03-27T00:00:00.000Z",
    jobId: meta.id,
    quoteNumber: overrides.quoteNumber || meta.quoteNumber || "EQ-TEST-01",
    jobNumber: overrides.jobNumber || meta.jobNumber || "JOB-TEST-01",
    title: meta.title || meta.label || "Test quote",
    recordingIntent: "job-scope",
    summary: overrides.summary || "Quote test scope",
    quoteCatalog: {
      id: "embark-default",
      name: "Sample Catalogue",
      currency: "AUD",
      gstRate: 0.1,
      businessProfile: {
        paymentMethods: {
          bankTransfer: {
            accountName: "Your Business Pty Ltd",
            bsb: "000-000",
            accountNumber: "0000 0000 0",
            bank: "Your bank",
          },
        },
      },
    },
    lineItems: overrides.lineItems || [
      {
        code: "scope",
        label: "Scope item",
        quantity: 1,
        unit: "lot",
        unitPrice: 200,
        totalPrice: 200,
        unitCost: 140,
        totalCost: 140,
        section: "Works",
        customerVisible: true,
      },
    ],
    presentation: {
      scopeText: overrides.summary || "Quote test scope",
      scheduleItems: overrides.scheduleItems || [
        {
          code: "scope",
          label: "Scope item",
          quantity: 1,
          unit: "lot",
          unitPrice: 200,
          totalPrice: 200,
          sourceLineItemCodes: ["scope"],
        },
      ],
    },
    totals: overrides.totals || {
      subtotal: 200,
      gst: 20,
      total: 220,
      currency: "AUD",
    },
    pricing: {
      authorityProvider: "price_catalog",
      ready: true,
      displayable: true,
      sendable: true,
      blockingReason: null,
      attestation: {
        status: "verified",
        requestNonce: "req-verified",
        verifiedNonce: "req-verified",
      },
    },
    review: {
      status: "ready",
      reasons: [],
    },
    delivery: {
      status: "final",
    },
    assumptions: [],
    assumptionInputs: [],
    missingInputs: [],
  };
}

function buildSendableQuoteFixture(meta, { version = 1, deliveryStatus = "draft" } = {}) {
  return {
    kind: "quote",
    version,
    status: "ready",
    generatedAt: "2026-03-27T00:00:00.000Z",
    updatedAt: "2026-03-27T00:00:00.000Z",
    jobId: meta.id,
    quoteNumber: meta.quoteNumber || "EQ-TEST-LOCK",
    jobNumber: meta.jobNumber || "JOB-TEST-LOCK",
    title: meta.title || meta.label || "Lock test quote",
    recordingIntent: "job-scope",
    summary: "Install drainage and backfill.",
    quoteCatalog: {
      id: "embark-default",
      name: "Sample Catalogue",
      currency: "AUD",
      gstRate: 0.1,
    },
    lineItems: [
      {
        code: "drainage",
        label: "Drainage installation",
        quantity: 1,
        unit: "lot",
        unitPrice: 100,
        totalPrice: 100,
        unitCost: 70,
        totalCost: 70,
        section: "Works",
        customerVisible: true,
      },
    ],
    presentation: {
      scopeText: "Install drainage and backfill.",
      scheduleItems: [
        {
          code: "drainage",
          label: "Drainage installation",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          sourceLineItemCodes: ["drainage"],
        },
      ],
    },
    totals: {
      subtotal: 100,
      gst: 10,
      total: 110,
      currency: "AUD",
    },
    pricing: {
      authorityProvider: "price_catalog",
      ready: true,
      displayable: true,
      sendable: true,
      blockingReason: null,
      attestation: {
        status: "verified",
        requestNonce: "req-verified",
        verifiedNonce: "req-verified",
      },
    },
    review: {
      status: "ready",
      reasons: [],
    },
    delivery: {
      status: deliveryStatus,
      finalizedAt: deliveryStatus === "final" ? "2026-03-27T00:00:00.000Z" : null,
    },
    assumptions: [],
    assumptionInputs: [],
    missingInputs: [],
  };
}

async function writeQuoteVersionSnapshot(jobDir, quote) {
  const versionDir = join(jobDir, "quote-versions", `v${String(quote.version || 1).padStart(3, "0")}`);
  await mkdir(versionDir, { recursive: true });
  await writeFile(join(versionDir, "quote.json"), JSON.stringify(quote, null, 2));
  // Version-bound report bytes are required for historical delivery. Keep
  // this fixture explicit rather than relying on a renderer to recreate a
  // legacy issued document.
  await writeFile(join(versionDir, "quote.md"), `Historical quote v${quote.version || 1}`);
}

test("presentation-only organizer updates do not require quote inputs once a quote artifact exists", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-presentation-"));

  try {
    const meta = {
      id: "job-presentation-1",
      title: "Casey — 9 Example Cr, Exampleton",
      label: "Casey — 9 Example Cr, Exampleton",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteReviewStatus: "ready",
      quoteStatus: "complete",
      quoteNumber: "EQ-TEST-01",
      jobNumber: "JOB-TEST-01",
    };
    const quote = {
      kind: "quote",
      version: 1,
      status: "ready",
      generatedAt: "2026-03-27T00:00:00.000Z",
      updatedAt: "2026-03-27T00:00:00.000Z",
      jobId: meta.id,
      quoteNumber: meta.quoteNumber,
      jobNumber: meta.jobNumber,
      title: meta.title,
      recordingIntent: "job-scope",
      summary: "Default scope text",
      quoteCatalog: {
        id: "embark-default",
        name: "Sample Catalogue",
        currency: "AUD",
        gstRate: 0.1,
      },
      lineItems: [
        {
          code: "cs-wall",
          label: "Concrete Sleeper Wall — Supply & Install",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          unitCost: 70,
          totalCost: 70,
          section: "Retaining wall",
          customerVisible: true,
        },
        {
          code: "drainage",
          label: "Drainage & backing",
          quantity: 1,
          unit: "lot",
          unitPrice: 25,
          totalPrice: 25,
          unitCost: 18,
          totalCost: 18,
          section: "Retaining wall",
          customerVisible: true,
        },
      ],
      presentation: {
        scopeText: "Default scope text",
        scheduleItems: [
          {
            code: "cs-wall",
            label: "Concrete Sleeper Wall — Supply & Install",
            quantity: 1,
            unit: "lot",
            unitPrice: 100,
            totalPrice: 100,
            sourceLineItemCodes: ["cs-wall"],
          },
          {
            code: "drainage",
            label: "Drainage & backing",
            quantity: 1,
            unit: "lot",
            unitPrice: 25,
            totalPrice: 25,
            sourceLineItemCodes: ["drainage"],
          },
        ],
      },
      totals: {
        subtotal: 125,
        gst: 12.5,
        total: 137.5,
        currency: "AUD",
      },
      review: {
        status: "ready",
        reasons: [],
      },
      delivery: {
        status: "draft",
      },
      assumptions: [],
      assumptionInputs: [],
      missingInputs: [],
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const result = await updateJobQuote({
      jobDir,
      meta,
      config: {},
      patch: {
        paymentSchedule: {
          milestones: [
            { label: "Deposit", percentage: 20 },
            { label: "Completion", percentage: 80 },
          ],
        },
        presentation: {
          scopeText: "Client-ready scope text",
          organizer: {
            root: ["group:retaining-wall"],
            nodes: {
              "group:retaining-wall": {
                kind: "group",
                label: "Retaining wall package",
                collapsed: false,
                amountVisible: true,
                children: ["source:cs-wall", "source:drainage"],
              },
              "source:cs-wall": {
                kind: "source",
                sourceCode: "cs-wall",
                labelOverride: "Concrete sleeper wall",
                amountVisible: true,
              },
              "source:drainage": {
                kind: "source",
                sourceCode: "drainage",
                amountVisible: false,
              },
            },
          },
        },
      },
      actor: { kind: "user", label: "Test Operator" },
    });

    assert.equal(result.quote.summary, "Client-ready scope text");
    assert.equal(result.quote.lineItems.length, 2);
    assert.deepEqual(
      result.quote.presentation.scheduleItems.map((item) => [item.label, item.amountVisible, item.depth]),
      [
        ["Retaining wall package", true, 0],
        ["Concrete sleeper wall", true, 1],
        ["Drainage & backing", false, 1],
      ]
    );

    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedQuote.summary, "Client-ready scope text");
    assert.deepEqual(
      savedQuote.presentation.scheduleItems.map((item) => [item.label, item.amountVisible, item.depth]),
      [
        ["Retaining wall package", true, 0],
        ["Concrete sleeper wall", true, 1],
        ["Drainage & backing", false, 1],
      ]
    );

    const savedOverrides = JSON.parse(await readFile(join(jobDir, "quote-overrides.json"), "utf8"));
    assert.equal(savedOverrides.presentation.scopeText, "Client-ready scope text");
    assert.equal(savedOverrides.presentation.organizer.nodes["source:drainage"].amountVisible, false);

    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.deepEqual(savedMeta.paymentSchedule, {
      milestones: [
        { label: "Deposit", percentage: 20 },
        { label: "Completion", percentage: 80 },
      ],
    });
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a lockStatus-only patch flips delivery state without touching version, totals, or line items", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-lock-only-"));

  try {
    const meta = {
      id: "job-lock-only-1",
      title: "Lock-only regression test",
      label: "Lock-only regression test",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteNumber: "EQ-TEST-LOCKONLY",
      jobNumber: "JOB-TEST-LOCKONLY",
    };
    const quote = buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "draft" });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));
    // Deliberately no transcript.json / quote-inputs.json: if a lock-only
    // patch fell through to buildAndPersistQuote (an earlier defect),
    // this call would throw "quote inputs not generated" instead of
    // completing via persistCurrentQuoteLockArtifacts.

    const result = await updateJobQuote({
      jobDir,
      meta,
      config: {},
      patch: { lockStatus: "final" },
      actor: { kind: "user", label: "Test Operator" },
    });

    assert.equal(result.quote.version, 1);
    assert.equal(result.quote.totals.total, 110);
    assert.deepEqual(result.quote.lineItems, quote.lineItems);
    assert.equal(result.quote.delivery.status, "final");
    assert.equal(result.quoteOverrides.lockStatus, "final");

    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedQuote.version, 1);
    assert.equal(savedQuote.totals.total, 110);
    assert.deepEqual(savedQuote.lineItems, quote.lineItems);
    assert.equal(savedQuote.delivery.status, "final");

    const savedOverrides = JSON.parse(await readFile(join(jobDir, "quote-overrides.json"), "utf8"));
    assert.equal(savedOverrides.lockStatus, "final");

    // Unlocking (return to draft) is the same delivery-state-only move and
    // must be equally cheap and non-repricing.
    const unlocked = await updateJobQuote({
      jobDir,
      meta: result.meta,
      config: {},
      patch: { lockStatus: "draft" },
      actor: { kind: "user", label: "Test Operator" },
    });
    assert.equal(unlocked.quote.version, 1);
    assert.equal(unlocked.quote.totals.total, 110);
    assert.equal(unlocked.quote.delivery.status, "draft");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a patch mixing lockStatus with a real line item edit still takes the rebuild path", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-lock-mixed-"));

  try {
    const meta = {
      id: "job-lock-mixed-1",
      title: "Mixed lock patch regression test",
      label: "Mixed lock patch regression test",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteNumber: "EQ-TEST-LOCKMIXED",
      jobNumber: "JOB-TEST-LOCKMIXED",
    };
    const quote = buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "draft" });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));
    // No transcript.json / quote-inputs.json here either: a patch that mixes
    // lockStatus with a genuine line item edit must NOT take the lock-only
    // fast path, so this must still throw "quote inputs not generated"
    // rather than silently applying only the lock flip.

    await assert.rejects(
      () => updateJobQuote({
        jobDir,
        meta,
        config: {},
        patch: {
          lockStatus: "final",
          lineItems: { drainage: { label: "Drainage installation (revised)" } },
        },
        actor: { kind: "user", label: "Test Operator" },
      }),
      /quote inputs not generated/
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("unlocking a sent quote forks a new draft version instead of mutating the sent version in place", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-unlock-sent-"));

  try {
    const draftMeta = {
      id: "job-unlock-sent-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      title: "Unlock sent quote fork test",
      label: "Unlock sent quote fork test",
      outputMode: "quote",
      quoteCatalogId: "embark-default",
      pipelineStage: "draft",
      quoteVersion: 1,
    };
    const transcript = {
      fullText: "Install twelve metres of drainage.",
      speakers: ["Operator"],
      cleaned: {
        title: "Unlock sent quote fork test",
        cleanedText: "Operator: Install twelve metres of drainage.",
        turns: [
          { speaker: "Operator", text: "Install twelve metres of drainage." },
        ],
      },
      segments: [
        {
          segmentId: "S001",
          speaker: "Operator",
          text: "Install twelve metres of drainage.",
          start: 0,
          end: 4.2,
        },
      ],
    };
    const quoteInputs = {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage installation for one run.",
      assumptions: [],
      jobScope: {
        customerGoal: "Drain water away from the site.",
        workSummary: "Install a drainage run.",
        siteContext: "Residential block.",
      },
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          confidence: 0.97,
          rationale: "Measured run length was stated explicitly.",
          section: "Drainage",
          evidence: [],
        },
      ],
    };

    await writeFile(join(jobDir, "transcript.json"), JSON.stringify(transcript, null, 2));
    await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(quoteInputs, null, 2));

    const initial = await buildAndPersistQuote({
      jobDir,
      meta: draftMeta,
      transcript,
      quoteInputs,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      buildReason: "test_initial_build",
    });
    assert.equal(initial.quote.version, 1);

    // Lock to final while still a draft/never-sent job: this is the
    // non-forking fast path and stays at version 1.
    const locked = await updateJobQuote({
      jobDir,
      meta: initial.meta,
      config: { operatorName: "Test Operator", authorityPricing: null, priceCatalog: TEST_PRICE_CATALOG_DB },
      patch: { lockStatus: "final" },
      actor: { kind: "user", label: "Test Operator" },
    });
    assert.equal(locked.quote.version, 1);
    assert.equal(locked.quote.delivery.status, "final");

    // Simulate the quote having actually been sent to the customer at v1.
    const sentMeta = {
      ...locked.meta,
      pipelineStage: "sent",
      quoteVersion: locked.quote.version || 1,
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(sentMeta, null, 2));

    // Unlocking now must fork a new draft version rather than rewriting the
    // customer-seen v1 artifacts in place.
    const unlocked = await updateJobQuote({
      jobDir,
      meta: sentMeta,
      config: { operatorName: "Test Operator", authorityPricing: null, priceCatalog: TEST_PRICE_CATALOG_DB },
      patch: { lockStatus: "draft" },
      actor: { kind: "user", label: "Test Operator" },
    });

    assert.equal(unlocked.quote.version, 2);
    assert.equal(unlocked.quote.delivery.status, "draft");
    assert.equal(
      unlocked.quoteVersions.some((item) => item.version === 1),
      true
    );

    // The archived v1 snapshot must be untouched: still final, still v1.
    const archivedV1 = await readQuoteArtifacts(jobDir, 1);
    assert.equal(archivedV1.quote.version, 1);
    assert.equal(archivedV1.quote.delivery.status, "final");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a lock-only patch against a job with no quote fails cleanly and writes nothing", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-lock-no-quote-"));

  try {
    const meta = {
      id: "job-lock-no-quote-1",
      title: "Lock with no quote regression test",
      label: "Lock with no quote regression test",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteNumber: "EQ-TEST-LOCKNOQUOTE",
      jobNumber: "JOB-TEST-LOCKNOQUOTE",
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    // No quote.json, no transcript.json, no quote-inputs.json: there is
    // nothing to lock. This must fail cleanly and write nothing, matching
    // updateQuotePresentationOnly's own "quote not generated" precondition,
    // rather than persisting a lock-lifecycle record and activity entry for
    // a quote that does not exist and then crashing the caller on a null
    // quote. And it must be a 404, via the shared
    // createJobActionError helper, not a bare Error surfacing as a 500.

    await assert.rejects(
      () => updateJobQuote({
        jobDir,
        meta,
        config: {},
        patch: { lockStatus: "final" },
        actor: { kind: "user", label: "Test Operator" },
      }),
      (err) => {
        assert.match(err.message, /quote not generated/);
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    assert.equal(existsSync(join(jobDir, "quote-lifecycle.json")), false, "no lock-lifecycle record should have been written");
    assert.equal(existsSync(join(jobDir, "quote-overrides.json")), false, "no override record should have been written");
    const jobStateActivityPath = join(jobDir, "job-state", "activity.jsonl");
    assert.equal(existsSync(jobStateActivityPath), false, "no activity entry should have been written");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a presentation-only patch against a job with no quote is a clean 404, not a 500", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-presentation-no-quote-"));

  try {
    const meta = {
      id: "job-presentation-no-quote-1",
      title: "Presentation with no quote regression test",
      label: "Presentation with no quote regression test",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    // No quote.json here either: updateQuotePresentationOnly's own
    // precondition carries the same bare-Error-surfaces-as-500 wart as the
    // lock-only path above, and both are fixed by the same one-line change.

    await assert.rejects(
      () => updateJobQuote({
        jobDir,
        meta,
        config: {},
        patch: { presentation: { scopeText: "New scope text" } },
        actor: { kind: "user", label: "Test Operator" },
      }),
      (err) => {
        assert.match(err.message, /quote not generated/);
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("presentation-only organizer updates keep legacy deliveryStatus aligned to the canonical pipeline stage", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-presentation-stage-"));

  try {
    const meta = {
      id: "job-presentation-stage-1",
      title: "Stage sync check",
      label: "Stage sync check",
      outputMode: "quote",
      pipelineStage: "sent",
      deliveryStatus: "sent",
      quoteVersion: 2,
      quoteReviewStatus: "ready",
      quoteStatus: "complete",
      quoteNumber: "EQ-TEST-02",
      jobNumber: "JOB-TEST-02",
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    };
    const quote = {
      kind: "quote",
      version: 2,
      status: "ready",
      generatedAt: "2026-03-27T00:00:00.000Z",
      updatedAt: "2026-03-27T00:00:00.000Z",
      jobId: meta.id,
      quoteNumber: meta.quoteNumber,
      jobNumber: meta.jobNumber,
      title: meta.title,
      recordingIntent: "job-scope",
      summary: "Sent quote",
      quoteCatalog: {
        id: "embark-default",
        name: "Sample Catalogue",
        currency: "AUD",
        gstRate: 0.1,
      },
      lineItems: [
        {
          code: "drainage",
          label: "Drainage",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          unitCost: 70,
          totalCost: 70,
          section: "Works",
          customerVisible: true,
        },
      ],
      presentation: {
        scopeText: "Sent quote",
        scheduleItems: [
          {
            code: "drainage",
            label: "Drainage",
            quantity: 1,
            unit: "lot",
            unitPrice: 100,
            totalPrice: 100,
            sourceLineItemCodes: ["drainage"],
          },
        ],
      },
      totals: {
        subtotal: 100,
        gst: 10,
        total: 110,
        currency: "AUD",
      },
      review: {
        status: "ready",
        reasons: [],
      },
      delivery: {
        status: "final",
      },
      assumptions: [],
      assumptionInputs: [],
      missingInputs: [],
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));
    await writeFile(join(jobDir, "transcript.json"), JSON.stringify({
      fullText: "Install drainage.",
      speakers: ["Operator"],
      cleaned: {
        title: "Stage sync check",
        cleanedText: "Operator: Install drainage.",
        turns: [
          { speaker: "Operator", text: "Install drainage." },
        ],
      },
      segments: [
        {
          segmentId: "S001",
          speaker: "Operator",
          text: "Install drainage.",
          start: 0,
          end: 3.4,
        },
      ],
    }, null, 2));
    await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify({
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Install drainage.",
      assumptions: [],
      jobScope: {
        customerGoal: "Drain water away from site.",
        workSummary: "Install drainage.",
        siteContext: "Residential block.",
      },
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage",
          quantity: 1,
          unit: "lot",
          confidence: 0.97,
          rationale: "Explicitly requested.",
          section: "Works",
          evidence: [],
        },
      ],
    }, null, 2));

    const result = await updateJobQuote({
      jobDir,
      meta,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      patch: {
        presentation: {
          scopeText: "Sent quote refreshed",
        },
      },
      actor: { kind: "user", label: "Test Operator" },
    });

    assert.equal(result.meta.pipelineStage, "sent");
    assert.equal(result.meta.deliveryStatus, "sent");
    assert.equal(result.quote.version, 3);

    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal(savedMeta.pipelineStage, "sent");
    assert.equal(savedMeta.deliveryStatus, "sent");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("markJobLanded promotes a sent quote to landed and records lifecycle state", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-landed-"));

  try {
    const meta = {
      id: "job-landed-1",
      outputMode: "quote",
      pipelineStage: "sent",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-LANDED-01",
      jobNumber: "JOB-LANDED-01",
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-LANDED-01",
      jobNumber: "JOB-LANDED-01",
    });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const result = await markJobLanded({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
    });

    assert.equal(result.meta.pipelineStage, "landed");
    assert.equal(result.meta.deliveryStatus, "landed");
    assert.ok(result.meta.landedAt);
    assert.equal(result.meta.paymentSchedule.milestones.length, 3);
    assert.equal(result.meta.milestoneInvoices.length, 3);
    assert.deepEqual(
      result.meta.milestoneInvoices.map((item) => item.total),
      [22, 66, 132]
    );
    assert.equal(result.meta.invoicePaidAmount, 0);
    assert.equal(result.meta.invoiceSentAt, null);

    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal(savedMeta.pipelineStage, "landed");
    assert.equal(savedMeta.deliveryStatus, "landed");
    assert.equal(savedMeta.landedAt, result.meta.landedAt);
    assert.equal("milestoneInvoices" in savedMeta, false);
    assert.equal(savedMeta.invoicePaidAmount, 0);
    assert.equal(savedMeta.invoiceSentAt, null);
    const hydratedMeta = await readJobMeta(jobDir);
    assert.equal(hydratedMeta.milestoneInvoices.length, 3);

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.currentPipelineStage, "landed");
    assert.equal(lifecycle.sendCount, 1);
    assert.equal(lifecycle.lastSentAt, "2026-03-26T01:00:00.000Z");
    assert.equal(lifecycle.lastSentQuoteVersion, 2);
    assert.equal(lifecycle.landedAt, result.meta.landedAt);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("markJobLanded uses the locked customer-seen revision when a newer sent draft exists", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-landed-locked-"));

  try {
    const meta = {
      id: "job-landed-locked-1",
      outputMode: "quote",
      pipelineStage: "sent",
      deliveryStatus: "sent",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-LANDED-LOCK-01",
      jobNumber: "JOB-LANDED-LOCK-01",
    };
    const currentDraftQuote = {
      ...createQuoteFixture(meta, {
        version: 2,
        quoteNumber: "EQ-LANDED-LOCK-01",
        jobNumber: "JOB-LANDED-LOCK-01",
        totals: {
          subtotal: 300,
          gst: 30,
          total: 330,
          currency: "AUD",
        },
        lineItems: [
          {
            code: "scope",
            label: "Scope item",
            quantity: 1,
            unit: "lot",
            unitPrice: 300,
            totalPrice: 300,
            unitCost: 210,
            totalCost: 210,
            section: "Works",
            customerVisible: true,
          },
        ],
        scheduleItems: [
          {
            code: "scope",
            label: "Scope item",
            quantity: 1,
            unit: "lot",
            unitPrice: 300,
            totalPrice: 300,
            sourceLineItemCodes: ["scope"],
          },
        ],
      }),
      delivery: {
        status: "draft",
        finalizedAt: null,
      },
    };
    const lockedQuote = {
      ...createQuoteFixture(meta, {
        version: 1,
        quoteNumber: "EQ-LANDED-LOCK-01",
        jobNumber: "JOB-LANDED-LOCK-01",
      }),
      delivery: {
        status: "final",
        finalizedAt: "2026-03-26T01:00:00.000Z",
      },
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(currentDraftQuote, null, 2));
    await writeQuoteVersionSnapshot(jobDir, lockedQuote);
    await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
      version: 1,
      currentQuoteVersion: 2,
      currentPipelineStage: "sent",
      currentLockStatus: "draft",
      sendCount: 1,
      lastSentAt: "2026-03-26T01:00:00.000Z",
      lastSentQuoteVersion: 1,
      lastSentTo: "client@example.com",
    }, null, 2));

    const result = await markJobLanded({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
    });

    assert.equal(result.meta.pipelineStage, "landed");
    assert.deepEqual(
      result.meta.milestoneInvoices.map((item) => item.total),
      [22, 66, 132]
    );

    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedQuote.version, 2);
    assert.equal(savedQuote.totals.total, 330);
    assert.equal(savedQuote.delivery.status, "draft");

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.lastSentQuoteVersion, 1);
    assert.equal(lifecycle.currentPipelineStage, "landed");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote sends an invoice for landed jobs and preserves landed status", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-send-"));

  try {
    const meta = {
      id: "job-invoice-send-1",
      title: "Invoice send test",
      label: "Invoice send test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-INV-01",
      jobNumber: "JOB-INV-01",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-INV-01",
      jobNumber: "JOB-INV-01",
      summary: "Invoice test scope",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "invoice",
      invoicePaidAmount: 80,
      customBody: null,
      sendEmail: async () => ({
        id: "msg-1",
        threadId: "thread-1",
        subject: "Invoice — Invoice send test",
        to: "test@example.com",
      }),
    });

    assert.equal(result.meta.pipelineStage, "landed");
    assert.equal(result.meta.deliveryStatus, "landed");
    assert.ok(result.meta.invoiceSentAt);
    assert.equal(result.meta.invoicePaidAmount, 80);
    // Issued when finalised, through the issue service: a number from the
    // sequence, the job number as its reference, its PDF stored once.
    const issuedNumber = result.milestoneInvoice.invoiceNumber;
    assert.match(issuedNumber, SEQUENCE_NUMBER);
    assert.equal(result.milestoneInvoice.issuedRevision.jobReference, "JOB-INV-01");
    assert.equal(result.milestoneInvoice.pdfPath, `milestone-invoices/${issuedNumber}.pdf`);
    assert.equal(result.milestoneInvoice.status, "authorised");
    assert.equal(result.milestoneInvoice.amountPaid, 80);
    assert.equal(result.milestoneInvoice.amountDue, 140);
    const issuedDocument = await TEST_INVOICE_ISSUER.documents.findIssuedDocument({ documentType: "invoice", number: issuedNumber });
    assert.equal(issuedDocument.jobId, "job-invoice-send-1");
    assert.equal(issuedDocument.pdfSha256, result.milestoneInvoice.issuedRevision.pdfSha256);
    const storedBytes = (await TEST_INVOICE_ISSUER.documents.readIssuedDocument(issuedDocument.uid)).bytes;
    assert.deepEqual(await readFile(join(jobDir, result.milestoneInvoice.pdfPath)), storedBytes, "the job's PDF is the stored issued document, byte for byte");

    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal(savedMeta.pipelineStage, "landed");
    assert.equal(savedMeta.deliveryStatus, "landed");
    assert.ok(savedMeta.invoiceSentAt);
    assert.equal("milestoneInvoices" in savedMeta, false);
    assert.equal(savedMeta.invoicePaidAmount, 80);
    const hydratedMeta = await readJobMeta(jobDir);
    assert.equal(hydratedMeta.milestoneInvoices.length, 1);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// The milestone-state mint/authorise/payment persist
// happens BEFORE the email network call inside sendJobQuote. A send whose
// network call fails (a bounded timeout firing is exactly this, from the
// caller's perspective — GMAIL_SEND_TIMEOUT_MS is what keeps the
// job mutation lock from being stolen mid-send) must leave that
// already-persisted state exactly as it was, with none of the POST-send
// steps (activity, invoiceSentAt, quote lock) having run — so a retry
// re-sends the identical, already-stored, already-issued document rather
// than risking a duplicate mint or a corrupted partial write.
test("a failed email send leaves the pre-send persisted invoice state intact and unaffected by post-send steps", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-send-network-failure-"));

  try {
    const meta = {
      id: "job-invoice-send-failure-1",
      title: "Invoice send failure test",
      label: "Invoice send failure test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-INV-FAIL-01",
      jobNumber: "JOB-INV-FAIL-01",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-INV-FAIL-01",
      jobNumber: "JOB-INV-FAIL-01",
      summary: "Invoice send failure test scope",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    await assert.rejects(
      () => sendJobQuote({
        jobDir,
        meta,
        dataDir: jobDir,
        config: {},
        to: "test@example.com",
        documentType: "invoice",
        customBody: null,
        // Simulates the network call exceeding GMAIL_SEND_TIMEOUT_MS — from
        // sendJobQuote's perspective this is just a rejected sendEmail call.
        sendEmail: async () => {
          const error = new Error("simulated network timeout");
          // A test double must declare that dispatch was never entered. A
          // plain Error after the transport boundary is deliberately unknown
          // and requires Message-ID reconciliation before retry.
          error.deliveryOutcome = "rejected_before_dispatch";
          throw error;
        },
      }),
      /simulated network timeout/,
    );

    // The mint/authorise persist that runs BEFORE the email call still
    // happened and is intact: the invoice is issued, numbered, and its PDF
    // is on disk.
    const hydrated = await readJobMeta(jobDir);
    const milestone = hydrated.milestoneInvoices[0];
    assert.equal(milestone.status, "authorised");
    assert.match(milestone.invoiceNumber, SEQUENCE_NUMBER);
    assert.ok(milestone.issuedRevision?.pdfSha256);
    assert.ok(existsSync(join(jobDir, milestone.pdfPath)));
    // A failed email never undoes the issue: the invoice stays issued in
    // PostgreSQL under its number, with its stored bytes.
    const issuedDocument = await TEST_INVOICE_ISSUER.documents.findIssuedDocument({ documentType: "invoice", number: milestone.invoiceNumber });
    assert.equal(issuedDocument.pdfSha256, milestone.issuedRevision.pdfSha256);

    // None of the POST-send steps ran: no "invoice.sent" activity was
    // recorded — that only happens after sendEmail resolves successfully.
    const { activity } = await readJobState(jobDir);
    assert.ok(!activity.some((entry) => entry.kind === "invoice.sent"));

    // A retry with a working send now succeeds and serves the SAME
    // already-persisted, already-issued document — no duplicate mint.
    const retried = await sendJobQuote({
      jobDir,
      meta: hydrated,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "invoice",
      customBody: null,
      sendEmail: async () => ({
        id: "msg-retry-1",
        threadId: "thread-retry-1",
        subject: "Invoice — Invoice send failure test",
        to: "test@example.com",
      }),
    });
    assert.equal(retried.milestoneInvoice.invoiceNumber, milestone.invoiceNumber, "the retry sends the invoice already issued, under its number");
    assert.equal(retried.milestoneInvoice.issuedRevision.pdfSha256, milestone.issuedRevision.pdfSha256, "the same bytes");
    assert.equal(retried.milestoneInvoice.revisionNumber, 1);
    assert.ok(retried.meta.invoiceSentAt);

    const { activity: activityAfterRetry } = await readJobState(jobDir);
    assert.ok(activityAfterRetry.some((entry) => entry.kind === "invoice.sent"));
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("GMAIL_SEND_TIMEOUT_MS is comfortably under the job-mutation guard's stale-lock threshold", () => {
  // The bound only closes the stolen-lock race if it is guaranteed to fire well
  // before a competing mutation could steal the lock — "comfortably under"
  // per the finding, not merely numerically less than.
  assert.ok(GMAIL_SEND_TIMEOUT_MS < 60_000, "expected the Gmail send timeout to leave a wide safety margin under the 120s stale-lock threshold");
});

test("sendJobQuote invoices the locked customer-seen revision when a newer landed draft exists", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-send-locked-"));

  try {
    const meta = {
      id: "job-invoice-send-locked-1",
      title: "Invoice send locked revision test",
      label: "Invoice send locked revision test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-INV-LOCK-01",
      jobNumber: "JOB-INV-LOCK-01",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
      milestoneInvoices: [],
    };
    const currentDraftQuote = {
      ...createQuoteFixture(meta, {
        version: 2,
        quoteNumber: "EQ-INV-LOCK-01",
        jobNumber: "JOB-INV-LOCK-01",
        summary: "Current landed draft scope",
        totals: {
          subtotal: 300,
          gst: 30,
          total: 330,
          currency: "AUD",
        },
        lineItems: [
          {
            code: "scope",
            label: "Scope item",
            quantity: 1,
            unit: "lot",
            unitPrice: 300,
            totalPrice: 300,
            unitCost: 210,
            totalCost: 210,
            section: "Works",
            customerVisible: true,
          },
        ],
        scheduleItems: [
          {
            code: "scope",
            label: "Scope item",
            quantity: 1,
            unit: "lot",
            unitPrice: 300,
            totalPrice: 300,
            sourceLineItemCodes: ["scope"],
          },
        ],
      }),
      delivery: {
        status: "draft",
        finalizedAt: null,
      },
    };
    const lockedQuote = {
      ...createQuoteFixture(meta, {
        version: 1,
        quoteNumber: "EQ-INV-LOCK-01",
        jobNumber: "JOB-INV-LOCK-01",
        summary: "Locked landed scope",
      }),
      delivery: {
        status: "final",
        finalizedAt: "2026-03-26T01:00:00.000Z",
      },
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(currentDraftQuote, null, 2));
    await writeQuoteVersionSnapshot(jobDir, lockedQuote);
    await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
      version: 1,
      currentQuoteVersion: 2,
      currentPipelineStage: "landed",
      currentLockStatus: "draft",
      sendCount: 1,
      lastSentAt: "2026-03-26T01:00:00.000Z",
      lastSentQuoteVersion: 1,
      landedAt: "2026-03-27T01:00:00.000Z",
    }, null, 2));

    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "invoice",
      sendEmail: async ({ quote }) => ({
        id: "msg-1",
        threadId: "thread-1",
        subject: "Invoice — Invoice send locked revision test",
        to: "test@example.com",
        total: quote?.totals?.total,
      }),
    });

    assert.equal(result.milestoneInvoice.total, 220);
    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal("milestoneInvoices" in savedMeta, false);
    const hydratedMeta = await readJobMeta(jobDir);
    assert.equal(hydratedMeta.milestoneInvoices[0].total, 220);

    const savedCurrentQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedCurrentQuote.version, 2);
    assert.equal(savedCurrentQuote.totals.total, 330);
    assert.equal(savedCurrentQuote.delivery.status, "draft");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote can send a receipt for a paid landed milestone", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-receipt-send-"));

  try {
    const meta = {
      id: "job-receipt-send-1",
      title: "Receipt send test",
      label: "Receipt send test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-REC-01",
      jobNumber: "JOB-REC-01",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-REC-01",
      jobNumber: "JOB-REC-01",
      summary: "Receipt test scope",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: meta.paymentSchedule,
    });
    const authorised = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });
    const paid = await recordJobMilestonePayment({
      jobDir,
      meta: authorised.meta,
      config: {},
      milestoneIndex: 0,
      payment: {
        amount: authorised.meta.milestoneInvoices[0].total,
        date: "2026-03-28",
        reference: "EFT-REC-01",
        method: "manual",
      },
    });

    const result = await sendJobQuote({
      jobDir,
      meta: paid.meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "receipt",
      sendEmail: async ({ quote: sentQuote }) => ({
        id: "msg-1",
        threadId: "thread-1",
        subject: `Receipt — ${sentQuote.quoteNumber}`,
        to: "test@example.com",
      }),
    });

    assert.equal(result.meta.pipelineStage, "landed");
    assert.equal(result.milestoneInvoice.status, "paid");
    assert.equal(result.milestoneInvoice.receiptNumber, "ER-REC-01-M1");
    assert.equal(existsSync(join(jobDir, result.milestoneInvoice.receiptPdfPath)), true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("generateJobMilestones stores a custom split payment schedule", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-milestones-generate-"));

  try {
    const meta = {
      id: "job-milestones-generate-1",
      title: "Milestone generation test",
      label: "Milestone generation test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-MILE-01",
      jobNumber: "JOB-MILE-01",
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-MILE-01",
      jobNumber: "JOB-MILE-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const result = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 50 },
          { label: "Completion", percentage: 50 },
        ],
      },
    });

    assert.equal(result.meta.paymentSchedule.milestones.length, 2);
    assert.deepEqual(
      result.meta.milestoneInvoices.map((item) => item.total),
      [110, 110]
    );
    assert.equal(result.meta.milestoneInvoices[0].invoiceNumber, "EI-MILE-01-M1");
    assert.equal(result.meta.milestoneInvoices[1].invoiceNumber, "EI-MILE-01-M2");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// `buildMilestoneInvoices` (the rebuild path) now always
// allows a shortfall rather than throwing, which left no seam that actually
// rejected an operator-typed schedule whose fixed dollar amounts already
// exceed the quote total — it would silently pro-rate instead. This is the
// authoring seam that must still reject it outright.
test("generateJobMilestones rejects a payment schedule whose fixed amounts exceed the quote total", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-milestones-overclaim-authoring-"));

  try {
    const meta = {
      id: "job-milestones-overclaim-authoring-1",
      title: "Milestone authoring overclaim test",
      label: "Milestone authoring overclaim test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-MILE-OC-01",
      jobNumber: "JOB-MILE-OC-01",
    };
    // Quote total is 220 (the fixture default).
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-MILE-OC-01",
      jobNumber: "JOB-MILE-OC-01",
    });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    await assert.rejects(
      () => generateJobMilestones({
        jobDir,
        meta,
        config: {},
        paymentSchedule: {
          milestones: [
            { label: "Deposit", fixedTotal: 200 },
            { label: "Completion", fixedTotal: 100 },
          ],
        },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /fixed milestone amounts.*cannot exceed the quote total/i);
        return true;
      },
    );

    // Nothing was persisted — the job never generated milestone invoices
    // from the rejected schedule.
    const hydrated = await readJobMeta(jobDir);
    assert.equal((hydrated.milestoneInvoices || []).length, 0);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("generateJobMilestones rejects payment schedule changes after milestone invoice activity exists", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-milestones-locked-schedule-"));

  try {
    const meta = {
      id: "job-milestones-locked-schedule-1",
      title: "Milestone schedule lock test",
      label: "Milestone schedule lock test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-MILE-LOCK-01",
      jobNumber: "JOB-MILE-LOCK-01",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
      milestoneInvoices: [
        {
          id: "milestone-1",
          milestoneIndex: 0,
          milestoneLabel: "Full payment",
          invoiceNumber: "EI-MILE-LOCK-01-M1",
          reference: "EQ-MILE-LOCK-01",
          percentage: 100,
          subtotal: 200,
          gst: 20,
          total: 220,
          currency: "AUD",
          amountPaid: 0,
          amountDue: 220,
          lineItems: [],
          dueDate: "2026-04-30",
          issuedAt: "2026-04-01T00:00:00.000Z",
          paidAt: null,
          status: "authorised",
          payments: [],
          pdfPath: "milestone-invoices/EI-MILE-LOCK-01-M1.pdf",
        },
      ],
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-MILE-LOCK-01",
      jobNumber: "JOB-MILE-LOCK-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    await assert.rejects(
      () => generateJobMilestones({
        jobDir,
        meta,
        config: {},
        paymentSchedule: {
          milestones: [
            { label: "Deposit", percentage: 50 },
            { label: "Completion", percentage: 50 },
          ],
        },
      }),
      /locked milestone invoices must keep their existing labels and percentages/i
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("generateJobMilestones allows reshaping only the remaining unlocked milestones", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-milestones-reshape-"));

  try {
    const meta = {
      id: "job-milestones-reshape-1",
      title: "Milestone reshape test",
      label: "Milestone reshape test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-MILE-RESHAPE-01",
      jobNumber: "JOB-MILE-RESHAPE-01",
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 30 },
          { label: "Completion", percentage: 70 },
        ],
      },
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-MILE-RESHAPE-01",
      jobNumber: "JOB-MILE-RESHAPE-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: meta.paymentSchedule,
    });
    const sent = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });
    const paid = await recordJobMilestonePayment({
      jobDir,
      meta: sent.meta,
      config: {},
      milestoneIndex: 0,
      payment: {
        amount: generated.meta.milestoneInvoices[0].total,
        date: "2026-04-22",
        reference: "EFT-MILE-RESHAPE-01",
        method: "bank_transfer",
      },
    });

    const reshaped = await generateJobMilestones({
      jobDir,
      meta: paid.meta,
      config: {},
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 30 },
          { label: "Progress", percentage: 20 },
          { label: "Final", percentage: 50 },
        ],
      },
    });

    assert.deepEqual(
      reshaped.meta.paymentSchedule.milestones,
      [
        { label: "Deposit", percentage: 30 },
        { label: "Progress", percentage: 20 },
        { label: "Final", percentage: 50 },
      ],
    );
    assert.equal(reshaped.meta.milestoneInvoices[0].status, "paid");
    assert.equal(reshaped.meta.milestoneInvoices[0].milestoneLabel, "Deposit");
    assert.equal(reshaped.meta.milestoneInvoices[0].percentage, 30);
    assert.equal(reshaped.meta.milestoneInvoices[0].total, 66);
    assert.equal(reshaped.meta.milestoneInvoices[0].amountPaid, 66);
    assert.equal(reshaped.meta.milestoneInvoices[0].amountDue, 0);
    assert.deepEqual(
      reshaped.meta.milestoneInvoices.slice(1).map((item) => ({
        label: item.milestoneLabel,
        percentage: item.percentage,
        total: item.total,
      })),
      [
        { label: "Progress", percentage: 20, total: 44 },
        { label: "Final", percentage: 50, total: 110 },
      ],
    );
    assert.equal(
      reshaped.meta.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
      220,
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("updateJobQuote rejects payment schedule changes after milestone invoice activity exists", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-quote-locked-schedule-"));

  try {
    const meta = {
      id: "job-quote-locked-schedule-1",
      title: "Quote schedule lock test",
      label: "Quote schedule lock test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-QUOTE-LOCK-01",
      jobNumber: "JOB-QUOTE-LOCK-01",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
      milestoneInvoices: [
        {
          id: "milestone-1",
          milestoneIndex: 0,
          milestoneLabel: "Full payment",
          invoiceNumber: "EI-QUOTE-LOCK-01-M1",
          reference: "EQ-QUOTE-LOCK-01",
          percentage: 100,
          subtotal: 200,
          gst: 20,
          total: 220,
          currency: "AUD",
          amountPaid: 0,
          amountDue: 220,
          lineItems: [],
          dueDate: "2026-04-30",
          issuedAt: "2026-04-01T00:00:00.000Z",
          paidAt: null,
          status: "authorised",
          payments: [],
          pdfPath: "milestone-invoices/EI-QUOTE-LOCK-01-M1.pdf",
        },
      ],
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-QUOTE-LOCK-01",
      jobNumber: "JOB-QUOTE-LOCK-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    await assert.rejects(
      () => updateJobQuote({
        jobDir,
        meta,
        config: {},
        patch: {
          paymentSchedule: {
            milestones: [
              { label: "Deposit", percentage: 50 },
              { label: "Completion", percentage: 50 },
            ],
          },
        },
      }),
      /locked milestone invoices must keep their existing labels and percentages/i
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("updateJobQuote rejects changing a locked milestone percentage", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-quote-locked-prefix-"));

  try {
    const meta = {
      id: "job-quote-locked-prefix-1",
      title: "Quote locked prefix test",
      label: "Quote locked prefix test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-QUOTE-LOCKED-PREFIX-01",
      jobNumber: "JOB-QUOTE-LOCKED-PREFIX-01",
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 10 },
          { label: "Progress", percentage: 30 },
          { label: "Final", percentage: 60 },
        ],
      },
      milestoneInvoices: [
        {
          id: "milestone-1",
          milestoneIndex: 0,
          milestoneLabel: "Deposit",
          invoiceNumber: "EI-QUOTE-LOCKED-PREFIX-01-M1",
          reference: "EQ-QUOTE-LOCKED-PREFIX-01",
          percentage: 10,
          subtotal: 20,
          gst: 2,
          total: 22,
          currency: "AUD",
          amountPaid: 0,
          amountDue: 22,
          lineItems: [],
          dueDate: "2026-04-30",
          issuedAt: "2026-04-01T00:00:00.000Z",
          paidAt: null,
          status: "authorised",
          payments: [],
          pdfPath: "milestone-invoices/EI-QUOTE-LOCKED-PREFIX-01-M1.pdf",
        },
        {
          id: "milestone-2",
          milestoneIndex: 1,
          milestoneLabel: "Progress",
          invoiceNumber: "EI-QUOTE-LOCKED-PREFIX-01-M2",
          reference: "EQ-QUOTE-LOCKED-PREFIX-01",
          percentage: 30,
          subtotal: 60,
          gst: 6,
          total: 66,
          currency: "AUD",
          amountPaid: 0,
          amountDue: 66,
          lineItems: [],
          dueDate: null,
          issuedAt: null,
          paidAt: null,
          status: "draft",
          payments: [],
          pdfPath: "milestone-invoices/EI-QUOTE-LOCKED-PREFIX-01-M2.pdf",
        },
        {
          id: "milestone-3",
          milestoneIndex: 2,
          milestoneLabel: "Final",
          invoiceNumber: "EI-QUOTE-LOCKED-PREFIX-01-M3",
          reference: "EQ-QUOTE-LOCKED-PREFIX-01",
          percentage: 60,
          subtotal: 120,
          gst: 12,
          total: 132,
          currency: "AUD",
          amountPaid: 0,
          amountDue: 132,
          lineItems: [],
          dueDate: null,
          issuedAt: null,
          paidAt: null,
          status: "draft",
          payments: [],
          pdfPath: "milestone-invoices/EI-QUOTE-LOCKED-PREFIX-01-M3.pdf",
        },
      ],
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-QUOTE-LOCKED-PREFIX-01",
      jobNumber: "JOB-QUOTE-LOCKED-PREFIX-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    await assert.rejects(
      () => updateJobQuote({
        jobDir,
        meta,
        config: {},
        patch: {
          paymentSchedule: {
            milestones: [
              { label: "Deposit", percentage: 15 },
              { label: "Progress A", percentage: 25 },
              { label: "Final", percentage: 60 },
            ],
          },
        },
      }),
      /locked milestone invoices must keep their existing labels and percentages/i,
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// The same authoring-time guard applies when a payment
// schedule arrives through a quote-update patch, not just through explicit
// milestone generation.
test("updateJobQuote rejects a payment schedule patch whose fixed amounts exceed the quote total", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-quote-schedule-overclaim-"));

  try {
    const meta = {
      id: "job-quote-schedule-overclaim-1",
      title: "Quote schedule overclaim test",
      label: "Quote schedule overclaim test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-QUOTE-OC-01",
      jobNumber: "JOB-QUOTE-OC-01",
    };
    // Quote total is 220 (the fixture default) — no prior milestone
    // invoices, so this is a pure authoring-time check, not a locked-
    // schedule conflict.
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-QUOTE-OC-01",
      jobNumber: "JOB-QUOTE-OC-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    await assert.rejects(
      () => updateJobQuote({
        jobDir,
        meta,
        config: {},
        patch: {
          paymentSchedule: {
            milestones: [
              { label: "Deposit", fixedTotal: 200 },
              { label: "Completion", fixedTotal: 100 },
            ],
          },
        },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /fixed milestone amounts.*cannot exceed the quote total/i);
        return true;
      },
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("updateJobMilestone and recordJobMilestonePayment persist milestone state changes", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-milestones-update-"));

  try {
    const meta = {
      id: "job-milestones-update-1",
      title: "Milestone mutation test",
      label: "Milestone mutation test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-MILE-02",
      jobNumber: "JOB-MILE-02",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-MILE-02",
      jobNumber: "JOB-MILE-02",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: meta.paymentSchedule,
    });

    const updated = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: {
        status: "authorised",
        dueDate: "2026-04-30",
      },
    });
    assert.equal(updated.milestoneInvoice.status, "authorised");
    assert.equal(updated.milestoneInvoice.dueDate, "2026-04-30");

    const paid = await recordJobMilestonePayment({
      jobDir,
      meta: updated.meta,
      config: {},
      milestoneIndex: 0,
      payment: {
        amount: 220,
        date: "2026-04-21",
        reference: "PAY-001",
        method: "bank_transfer",
      },
    });
    assert.equal(paid.milestoneInvoice.status, "paid");
    assert.equal(paid.milestoneInvoice.amountDue, 0);
    assert.equal(paid.payment.reference, "PAY-001");

    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal("milestoneInvoices" in savedMeta, false);
    const hydratedMeta = await readJobMeta(jobDir);
    assert.equal(hydratedMeta.milestoneInvoices[0].status, "paid");
    assert.equal(hydratedMeta.milestoneInvoices[0].payments.length, 1);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote targets the requested milestone on a multi-milestone landed job", async () => {
  // Route-level coverage for POST /api/jobs/:id/email-quote with
  // documentType=invoice and an explicit non-zero milestoneIndex.
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-ms-1-"));

  try {
    const meta = {
      id: "job-invoice-ms-1",
      title: "Milestone 2 send test",
      label: "Milestone 2 send test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 1,
      quoteNumber: "EQ-MS-02",
      jobNumber: "JOB-MS-02",
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 10 },
          { label: "Progress", percentage: 30 },
          { label: "Final", percentage: 60 },
        ],
      },
    };
    const quote = createQuoteFixture(meta, {
      version: 1,
      quoteNumber: "EQ-MS-02",
      jobNumber: "JOB-MS-02",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const capturedSends = [];
    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "invoice",
      milestoneIndex: 1,
      customBody: null,
      sendEmail: async (args) => {
        capturedSends.push({
          total: args.quote?.totals?.total,
          filename: args.quotePdfFilename,
          documentType: args.documentType,
        });
        return {
          id: "msg-m2",
          threadId: "thread-m2",
          subject: "Invoice M2",
          to: "test@example.com",
        };
      },
    });

    // 30% of $220 total = $66 — that's what the Progress milestone totals.
    // The quote pricing surface itself remains the full accepted quote; the
    // milestone amount is carried in meta.milestoneInvoice/payment summary.
    assert.equal(result.milestoneInvoice.milestoneIndex, 1);
    assert.equal(result.milestoneInvoice.total, 66);
    assert.equal(result.milestoneInvoice.status, "authorised");
    assert.equal(capturedSends.length, 1);
    assert.equal(capturedSends[0].total, 220);
    assert.equal(capturedSends[0].documentType, "invoice");

    // totalInvoicePaidAmount compat field surfaces running total (0 here —
    // sending an invoice does not mark a payment).
    const hydratedMeta = await readJobMeta(jobDir);
    assert.equal(hydratedMeta.totalInvoicePaidAmount, 0);
    assert.equal(hydratedMeta.milestoneInvoices.length, 3);
    assert.equal(hydratedMeta.milestoneInvoices[1].status, "authorised");

    // Other milestones are still draft.
    assert.equal(hydratedMeta.milestoneInvoices[0].status, "draft");
    assert.equal(hydratedMeta.milestoneInvoices[2].status, "draft");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("recordJobMilestonePayment accumulates totalInvoicePaidAmount across milestones", async () => {
  // Route-level coverage for POST /api/jobs/:id/milestones/:index/payment
  // verifying the new totalInvoicePaidAmount compat field.
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-paid-total-"));

  try {
    const meta = {
      id: "job-paid-total-1",
      title: "Total paid test",
      label: "Total paid test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-PAID-01",
      jobNumber: "JOB-PAID-01",
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 25 },
          { label: "Progress", percentage: 25 },
          { label: "Final", percentage: 50 },
        ],
      },
    };
    const quote = createQuoteFixture(meta, {
      quoteNumber: "EQ-PAID-01",
      jobNumber: "JOB-PAID-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    let generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: meta.paymentSchedule,
    });

    // Authorise + fully pay milestone 0 (25% of $220 = $55).
    let updated = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });
    let paid = await recordJobMilestonePayment({
      jobDir,
      meta: updated.meta,
      config: {},
      milestoneIndex: 0,
      payment: { amount: 55, date: "2026-05-01" },
    });
    assert.equal(paid.milestoneInvoice.status, "paid");

    let hydrated = await readJobMeta(jobDir);
    assert.equal(hydrated.totalInvoicePaidAmount, 55);
    // Contextual invoicePaidAmount now reflects the NEXT-OPEN milestone (m1),
    // which still has zero paid. This is the documented compat contract.
    assert.equal(hydrated.invoicePaidAmount, 0);

    // Partial payment on milestone 1 (25% of $220 = $55, pay $30).
    updated = await updateJobMilestone({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 1,
      patch: { status: "authorised" },
    });
    paid = await recordJobMilestonePayment({
      jobDir,
      meta: updated.meta,
      config: {},
      milestoneIndex: 1,
      payment: { amount: 30, date: "2026-05-10" },
    });
    assert.equal(paid.milestoneInvoice.status, "authorised");
    assert.equal(paid.milestoneInvoice.amountPaid, 30);

    hydrated = await readJobMeta(jobDir);
    assert.equal(hydrated.totalInvoicePaidAmount, 85);
    assert.equal(hydrated.invoicePaidAmount, 30); // next-open is now m1, partial.
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("migrateJobMilestoneInvoices carries prior deposit, voids accidental top-up, and resets changed sent invoice", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-migration-"));

  try {
    const meta = {
      id: "job-invoice-migration-1",
      title: "Invoice migration test",
      label: "Invoice migration test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-MIG-01",
      jobNumber: "JOB-MIG-01",
      quoteVersion: 3,
      landedAt: "2026-04-29T00:00:00.000Z",
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 10 },
          { label: "Progress", percentage: 30 },
          { label: "Final", percentage: 60 },
        ],
      },
    };
    const quote = createQuoteFixture(meta, {
      version: 3,
      quoteNumber: "EQ-MIG-01",
      jobNumber: "JOB-MIG-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: meta.paymentSchedule,
    });
    let updated = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });
    let paid = await recordJobMilestonePayment({
      jobDir,
      meta: updated.meta,
      config: {},
      milestoneIndex: 0,
      payment: { amount: 11, date: "2026-04-27", reference: "REAL-V2-DEPOSIT" },
    });
    paid = await recordJobMilestonePayment({
      jobDir,
      meta: paid.meta,
      config: {},
      milestoneIndex: 0,
      payment: { amount: 11, date: "2026-04-29", reference: "ACCIDENTAL-TOPUP" },
    });
    const accidentalPaymentId = paid.payment.id;
    updated = await updateJobMilestone({
      jobDir,
      meta: paid.meta,
      config: {},
      milestoneIndex: 1,
      patch: { status: "authorised" },
    });
    assert.equal(updated.milestoneInvoice.total, 66);
    assert.equal(updated.milestoneInvoice.status, "authorised");

    const migrated = await migrateJobMilestoneInvoices({
      jobDir,
      meta: updated.meta,
      config: {},
      sourceQuoteVersion: 2,
      carriedForwardAmount: 11,
      adjustmentMilestoneIndex: 1,
      voidPayments: [
        {
          milestoneIndex: 0,
          paymentId: accidentalPaymentId,
          reason: "Accidental top-up",
        },
      ],
      actor: { kind: "user", label: "Alex" },
    });

    const invoices = migrated.meta.milestoneInvoices;
    assert.deepEqual(invoices.map((invoice) => invoice.total), [11, 77, 132]);
    assert.equal(invoices[0].amountPaid, 11);
    assert.equal(invoices[0].amountDue, 0);
    assert.equal(invoices[0].status, "paid");
    assert.equal(invoices[0].payments.length, 2);
    assert.ok(invoices[0].payments[1].voidedAt);
    assert.equal(invoices[0].payments[0].sourceQuoteVersion, 2);
    assert.equal(invoices[1].status, "draft");
    assert.equal(invoices[1].issuedAt, null);
    assert.equal(invoices[1].amountDue, 77);
    assert.equal(invoices[2].amountDue, 132);
    assert.equal(migrated.meta.totalInvoicePaidAmount, 11);
    assert.equal(migrated.quoteLifecycle.lastSentQuoteVersion, 3);

    const hydrated = await readJobMeta(jobDir);
    assert.equal(hydrated.paymentSchedule.milestones[0].fixedTotal, 11);
    assert.equal(hydrated.paymentSchedule.milestones[1].fixedTotal, 77);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("migrateJobMilestoneInvoices freezes a newly carried deposit at its full amount on the first migration", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-migration-large-carry-"));

  try {
    const meta = {
      id: "job-invoice-migration-large-carry-1",
      title: "Large carried deposit migration test",
      label: "Large carried deposit migration test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-MIG-LARGE-01",
      jobNumber: "JOB-MIG-LARGE-01",
      quoteVersion: 2,
      landedAt: "2026-08-24T00:00:00.000Z",
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 10 },
          { label: "Progress", percentage: 30 },
          { label: "Final", percentage: 60 },
        ],
      },
    };
    const quote = createQuoteFixture(meta, {
      version: 2,
      quoteNumber: "EQ-MIG-LARGE-01",
      jobNumber: "JOB-MIG-LARGE-01",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: meta.paymentSchedule,
    });
    const migrated = await migrateJobMilestoneInvoices({
      jobDir,
      meta: generated.meta,
      config: {},
      sourceQuoteVersion: 1,
      targetQuoteVersion: 2,
      carriedForwardAmount: 55,
      adjustmentMilestoneIndex: 1,
      actor: { kind: "user", label: "Alex" },
    });

    const invoices = migrated.meta.milestoneInvoices;
    assert.deepEqual(invoices.map((invoice) => invoice.total), [55, 33, 132]);
    assert.equal(invoices[0].payments[0].amount, 55);
    assert.equal(invoices[0].amountPaid, 55);
    assert.equal(invoices[0].amountDue, 0);
    assert.equal(invoices[0].status, "paid");
    assert.equal(invoices[0].issuedRevision.total, 55);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// migrateJobMilestoneInvoices had NO version-
// direction guard at all — it writes targetArtifacts.quote straight over
// root via persistCurrentQuoteLockArtifacts with no archive of the
// displaced content, in EITHER direction. Identical fix to revise's.
async function seedSimpleLandedMigrationJob(jobDir, { id, version = 1, paymentSchedule } = {}) {
  const meta = {
    id,
    title: "Migrate version-guard test",
    label: "Migrate version-guard test",
    outputMode: "quote",
    pipelineStage: "landed",
    deliveryStatus: "landed",
    quoteNumber: `EQ-MIG-VG-${id}`,
    jobNumber: `JOB-MIG-VG-${id}`,
    quoteVersion: version,
    landedAt: "2026-05-01T00:00:00.000Z",
    paymentSchedule: paymentSchedule || {
      milestones: [{ label: "Full payment", percentage: 100 }],
    },
  };
  const quote = createQuoteFixture(meta, { version, quoteNumber: `EQ-MIG-VG-${id}` });
  await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));
  const generated = await generateJobMilestones({
    jobDir,
    meta,
    config: {},
    paymentSchedule: meta.paymentSchedule,
  });
  return { meta: generated.meta, quote };
}

test("migrateJobMilestoneInvoices rejects a target quote version OLDER than the current root and leaves root and archives untouched", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-migrate-older-than-root-"));

  try {
    await seedSimpleLandedMigrationJob(jobDir, { id: "migrate-older-1", version: 1 });
    const forked = await forkCurrentQuoteVersion(jobDir); // v1 archived, root becomes v2
    assert.equal(forked.currentVersion, 2);

    const rootBefore = await readFile(join(jobDir, "quote.json"), "utf8");
    const archiveBefore = await readFile(join(jobDir, "quote-versions", "v001", "quote.json"), "utf8");

    const hydrated = await readJobMeta(jobDir);
    await assert.rejects(
      () => migrateJobMilestoneInvoices({
        jobDir,
        meta: hydrated,
        config: {},
        targetQuoteVersion: 1,
      }),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /is not the current quote/i);
        return true;
      },
    );

    assert.equal(await readFile(join(jobDir, "quote.json"), "utf8"), rootBefore);
    assert.equal(await readFile(join(jobDir, "quote-versions", "v001", "quote.json"), "utf8"), archiveBefore);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("migrateJobMilestoneInvoices rejects a target quote version NEWER than the current root and leaves root and archives untouched", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-migrate-newer-than-root-"));

  try {
    await seedSimpleLandedMigrationJob(jobDir, { id: "migrate-newer-1", version: 2 });
    await forkCurrentQuoteVersion(jobDir); // v2 archived to v002, root becomes v3
    // Promote v2 back to current: v3 (displaced root) archives to v003, and
    // v002 (the promoted-from archive) is removed. Root is v2 again, with
    // quote-versions/v003 present — the exact stray-higher-archive state.
    await promoteQuoteVersion(jobDir, 2);
    assert.equal(existsSync(join(jobDir, "quote-versions", "v002")), false);
    assert.equal(existsSync(join(jobDir, "quote-versions", "v003")), true);

    const rootBefore = await readFile(join(jobDir, "quote.json"), "utf8");
    const archiveBefore = await readFile(join(jobDir, "quote-versions", "v003", "quote.json"), "utf8");

    const hydrated = await readJobMeta(jobDir);
    await assert.rejects(
      () => migrateJobMilestoneInvoices({
        jobDir,
        meta: hydrated,
        config: {},
        targetQuoteVersion: 3,
      }),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /is not the current quote/i);
        return true;
      },
    );

    assert.equal(await readFile(join(jobDir, "quote.json"), "utf8"), rootBefore);
    assert.equal(await readFile(join(jobDir, "quote-versions", "v003", "quote.json"), "utf8"), archiveBefore);
    assert.equal(existsSync(join(jobDir, "quote-versions", "v002")), false);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("migrateJobMilestoneInvoices still works when targeting the current quote version explicitly", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-migrate-explicit-current-"));

  try {
    // A single 100%-milestone schedule (as used by the older/newer guard
    // tests above) cannot represent a real migration: buildMigratedPaymentSchedule
    // requires a carried-forward deposit milestone distinct from the
    // adjustment milestone that absorbs the remainder, and rejects a $0
    // carried-forward amount outright. Use a two-milestone schedule with an
    // actual prior deposit payment so this test exercises a genuine
    // same-version migration, not just the version guard.
    await seedSimpleLandedMigrationJob(jobDir, {
      id: "migrate-current-1",
      version: 1,
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 20 },
          { label: "Final", percentage: 80 },
        ],
      },
    });

    let hydrated = await readJobMeta(jobDir);
    const authorisedDeposit = await updateJobMilestone({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });
    const paid = await recordJobMilestonePayment({
      jobDir,
      meta: authorisedDeposit.meta,
      config: {},
      milestoneIndex: 0,
      payment: { amount: 20, date: "2026-05-01", reference: "PRIOR-DEPOSIT" },
    });
    await updateJobMilestone({
      jobDir,
      meta: paid.meta,
      config: {},
      milestoneIndex: 1,
      patch: { status: "authorised" },
    });

    hydrated = await readJobMeta(jobDir);
    const migrated = await migrateJobMilestoneInvoices({
      jobDir,
      meta: hydrated,
      config: {},
      targetQuoteVersion: 1,
      sourceQuoteVersion: 1,
      carriedForwardAmount: 20,
      carryMilestoneIndex: 0,
      adjustmentMilestoneIndex: 1,
      dryRun: true,
    });

    // Reached past the version guard and produced a real migration plan
    // rather than throwing.
    assert.ok(migrated.migrationPlan, "expected a migration plan for a same-version target");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("regenerateRecordingQuote forks a new version for sent quotes", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-regenerate-sent-"));

  try {
    const draftMeta = {
      id: "job-regenerate-sent-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      title: "Sent quote refresh test",
      label: "Sent quote refresh test",
      outputMode: "quote",
      quoteCatalogId: "embark-default",
      pipelineStage: "draft",
      quoteVersion: 1,
    };
    const transcript = {
      fullText: "Install twelve metres of drainage.",
      speakers: ["Operator"],
      cleaned: {
        title: "Sent quote refresh test",
        cleanedText: "Operator: Install twelve metres of drainage.",
        turns: [
          { speaker: "Operator", text: "Install twelve metres of drainage." },
        ],
      },
      segments: [
        {
          segmentId: "S001",
          speaker: "Operator",
          text: "Install twelve metres of drainage.",
          start: 0,
          end: 4.2,
        },
      ],
    };
    const quoteInputs = {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage installation for one run.",
      assumptions: [],
      jobScope: {
        customerGoal: "Drain water away from the site.",
        workSummary: "Install a drainage run.",
        siteContext: "Residential block.",
      },
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          confidence: 0.97,
          rationale: "Measured run length was stated explicitly.",
          section: "Drainage",
          evidence: [],
        },
      ],
    };

    await writeFile(join(jobDir, "transcript.json"), JSON.stringify(transcript, null, 2));
    await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(quoteInputs, null, 2));

    const initial = await buildAndPersistQuote({
      jobDir,
      meta: draftMeta,
      transcript,
      quoteInputs,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      buildReason: "test_initial_build",
    });

    const sentMeta = {
      ...initial.meta,
      pipelineStage: "sent",
      quoteVersion: initial.quote.version || 1,
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(sentMeta, null, 2));

    const regenerated = await regenerateRecordingQuote({
      jobDir,
      meta: sentMeta,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      actor: { kind: "user", label: "Test Operator" },
      buildReason: "quote_pricing_refresh",
    });

    assert.equal(initial.quote.version, 1);
    assert.equal(regenerated.quote.version, 2);
    assert.equal(
      regenerated.quoteVersions.some((item) => item.version === 1),
      true
    );

    const regeneratedAgain = await regenerateRecordingQuote({
      jobDir,
      meta: regenerated.meta,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      actor: { kind: "user", label: "Test Operator" },
      buildReason: "quote_pricing_refresh",
    });

    assert.equal(regeneratedAgain.quote.version, 2);
    assert.equal(
      regeneratedAgain.quoteVersions.some((item) => item.version === 3),
      false
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("regenerateRecordingQuote still forks after a quote has historical sent status even if current stage is draft", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-regenerate-history-"));

  try {
    const draftMeta = {
      id: "job-regenerate-history-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      title: "Historical sent refresh test",
      label: "Historical sent refresh test",
      outputMode: "quote",
      quoteCatalogId: "embark-default",
      pipelineStage: "draft",
      quoteVersion: 1,
    };
    const transcript = {
      fullText: "Install twelve metres of drainage.",
      speakers: ["Operator"],
      cleaned: {
        title: "Historical sent refresh test",
        cleanedText: "Operator: Install twelve metres of drainage.",
        turns: [
          { speaker: "Operator", text: "Install twelve metres of drainage." },
        ],
      },
      segments: [
        {
          segmentId: "S001",
          speaker: "Operator",
          text: "Install twelve metres of drainage.",
          start: 0,
          end: 4.2,
        },
      ],
    };
    const quoteInputs = {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage installation for one run.",
      assumptions: [],
      jobScope: {
        customerGoal: "Drain water away from the site.",
        workSummary: "Install a drainage run.",
        siteContext: "Residential block.",
      },
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          confidence: 0.97,
          rationale: "Measured run length was stated explicitly.",
          section: "Drainage",
          evidence: [],
        },
      ],
    };

    await writeFile(join(jobDir, "transcript.json"), JSON.stringify(transcript, null, 2));
    await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(quoteInputs, null, 2));

    const initial = await buildAndPersistQuote({
      jobDir,
      meta: draftMeta,
      transcript,
      quoteInputs,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      buildReason: "test_initial_build",
    });

    const sentMeta = {
      ...initial.meta,
      pipelineStage: "sent",
      quoteVersion: initial.quote.version || 1,
    };
    await runAtomicJobGeneration(jobDir, async (stagedJobDir) => {
      await writeJobMeta(stagedJobDir, sentMeta);
      await setJobPipelineStage({
        jobDir: stagedJobDir,
        meta: sentMeta,
        stage: "draft",
        actor: { kind: "user", label: "Test Operator" },
      });
    });

    const draftAgainMeta = await readJobMeta(jobDir);
    const regenerated = await regenerateRecordingQuote({
      jobDir,
      meta: draftAgainMeta,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      actor: { kind: "user", label: "Test Operator" },
      buildReason: "quote_pricing_refresh",
    });

    assert.equal(initial.quote.version, 1);
    assert.equal(regenerated.quote.version, 2);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("regenerateRecordingQuote preserves baseline scope across repeated rebuilds after a sent quote", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-regenerate-baseline-"));

  try {
    const draftMeta = {
      id: "job-regenerate-baseline-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      title: "Repeated rebuild baseline test",
      label: "Repeated rebuild baseline test",
      outputMode: "quote",
      quoteCatalogId: "embark-default",
      pipelineStage: "draft",
      quoteVersion: 1,
    };
    const transcript = {
      fullText: "Install twelve metres of drainage.",
      speakers: ["Operator"],
      cleaned: {
        title: "Repeated rebuild baseline test",
        cleanedText: "Operator: Install twelve metres of drainage.",
        turns: [
          { speaker: "Operator", text: "Install twelve metres of drainage." },
        ],
      },
      segments: [
        {
          segmentId: "S001",
          speaker: "Operator",
          text: "Install twelve metres of drainage.",
          start: 0,
          end: 4.2,
        },
      ],
    };
    const initialQuoteInputs = {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage installation for one run.",
      assumptions: [],
      jobScope: {
        customerGoal: "Drain water away from the site.",
        workSummary: "Install a drainage run.",
        siteContext: "Residential block.",
      },
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          confidence: 0.97,
          rationale: "Measured run length was stated explicitly.",
          section: "Drainage",
          evidence: [],
        },
      ],
    };

    await writeFile(join(jobDir, "transcript.json"), JSON.stringify(transcript, null, 2));
    await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(initialQuoteInputs, null, 2));

    const initial = await buildAndPersistQuote({
      jobDir,
      meta: draftMeta,
      transcript,
      quoteInputs: initialQuoteInputs,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      buildReason: "test_initial_build",
    });

    const sentMeta = {
      ...initial.meta,
      pipelineStage: "sent",
      quoteVersion: initial.quote.version || 1,
      quoteSentAt: "2026-03-27T01:00:00.000Z",
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(sentMeta, null, 2));

    const degradedQuoteInputs = {
      ...initialQuoteInputs,
      reviewStatus: "ready",
      summary: "Transcript was terse on rebuild.",
      lineItemCandidates: [],
    };
    await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(degradedQuoteInputs, null, 2));

    const regenerated = await regenerateRecordingQuote({
      jobDir,
      meta: sentMeta,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      actor: { kind: "user", label: "Test Operator" },
      buildReason: "reingest",
    });

    assert.equal(regenerated.quote.version, 2);
    assert.equal(regenerated.quote.review?.status, "manual_review");
    assert.ok(regenerated.quote.lineItems.some((item) => item.quoteCatalogItemCode === "drainage"));

    await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(degradedQuoteInputs, null, 2));

    const regeneratedAgain = await regenerateRecordingQuote({
      jobDir,
      meta: regenerated.meta,
      config: {
        operatorName: "Test Operator",
        authorityPricing: null,
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      actor: { kind: "user", label: "Test Operator" },
      buildReason: "reingest",
    });

    assert.equal(regeneratedAgain.quote.version, 2);
    assert.ok(regeneratedAgain.quote.lineItems.some((item) => item.quoteCatalogItemCode === "drainage"));

    const evidencePack = JSON.parse(await readFile(join(jobDir, "evidence-pack.json"), "utf8"));
    const persistedQuoteInputs = JSON.parse(await readFile(join(jobDir, "quote-inputs.json"), "utf8"));
    assert.equal(evidencePack.baselineQuoteContext?.version, 1);
    assert.ok(persistedQuoteInputs.lineItemCandidates.some((item) => item.quoteCatalogItemCode === "drainage"));
    assert.equal(persistedQuoteInputs.reviewStatus, "manual_review");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("setJobPipelineStage records lost status and preserves sent timestamp", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-lost-"));

  try {
    const meta = {
      id: "job-lost-1",
      outputMode: "quote",
      pipelineStage: "sent",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));

    const result = await setJobPipelineStage({
      jobDir,
      meta,
      stage: "lost",
      actor: { kind: "user", label: "Test Operator" },
    });

    assert.equal(result.meta.pipelineStage, "lost");
    assert.equal(result.meta.quoteSentAt, "2026-03-26T01:00:00.000Z");
    assert.ok(result.meta.lostAt);

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.currentPipelineStage, "lost");
    assert.equal(lifecycle.sendCount, 1);
    assert.equal(lifecycle.lastSentAt, "2026-03-26T01:00:00.000Z");
    assert.equal(lifecycle.lostAt, result.meta.lostAt);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote finalizes the current quote artifact and lifecycle on successful send", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-send-lock-"));

  try {
    const meta = {
      id: "job-send-lock-1",
      title: "Send lock test",
      label: "Send lock test",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteNumber: "EQ-TEST-SEND",
      jobNumber: "JOB-TEST-SEND",
    };
    const quote = buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "draft" });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const capturedSends = [];
    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      attachmentFilename: "Client / renamed quote.pdf",
      scheduledEmailId: "scheduled-email-1",
      scheduledAt: "2026-08-25T11:00:00.000Z",
      sendEmail: async (args) => {
        capturedSends.push({
          filename: args.quotePdfFilename,
        });
        return {
          id: "msg-1",
          threadId: "thread-1",
          subject: "Quote — Send lock test",
          to: "test@example.com",
        };
      },
    });

    assert.equal(result.meta.pipelineStage, "sent");
    assert.equal(result.meta.deliveryStatus, "sent");
    assert.ok(result.meta.quoteSentAt);
    assert.equal(capturedSends[0].filename, "Client - renamed quote.pdf");

    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedQuote.delivery.status, "final");
    assert.equal(savedQuote.delivery.finalizedAt, result.meta.quoteSentAt);

    const savedOverrides = JSON.parse(await readFile(join(jobDir, "quote-overrides.json"), "utf8"));
    assert.equal(savedOverrides.lockStatus, "final");
    assert.equal(savedOverrides.finalizedAt, result.meta.quoteSentAt);

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.lastSentQuoteVersion, 1);
    assert.equal(lifecycle.currentLockStatus, "final");
    assert.equal(lifecycle.currentQuoteVersion, 1);

    const sentEmail = JSON.parse((await readFile(join(jobDir, "sent-emails.jsonl"), "utf8")).trim());
    assert.equal(sentEmail.scheduledEmailId, "scheduled-email-1");
    assert.equal(sentEmail.scheduledAt, "2026-08-25T11:00:00.000Z");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote keeps a timeout outcome unknown and reconciles the stable delivery attempt without a duplicate send", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-send-outbox-reconcile-"));

  try {
    const meta = {
      id: "job-send-outbox-reconcile-1",
      title: "Delivery reconciliation test",
      label: "Delivery reconciliation test",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteNumber: "EQ-TEST-OUTBOX",
      jobNumber: "JOB-TEST-OUTBOX",
    };
    const quote = buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "draft" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    let remoteAcceptedMessageId = null;
    let sendCalls = 0;
    const timeout = Object.assign(new Error("send timed out after Gmail accepted the request"), { code: "ETIMEDOUT" });
    await assert.rejects(
      () => sendJobQuote({
        jobDir,
        meta,
        dataDir: jobDir,
        config: {},
        to: "test@example.com",
        sendEmail: async ({ deliveryAttemptId }) => {
          sendCalls += 1;
          remoteAcceptedMessageId = deliveryAttemptId;
          throw timeout;
        },
      }),
      /timed out/i,
    );
    assert.equal(sendCalls, 1);

    const outboxPath = join(jobDir, "quote-delivery-outbox.json");
    const pending = JSON.parse(await readFile(outboxPath, "utf8"));
    assert.equal(pending.status, "unknown");
    assert.equal(pending.messageId, `<field-${remoteAcceptedMessageId}@arcforge.local>`);

    await assert.rejects(
      () => sendJobQuote({
        jobDir,
        meta,
        dataDir: jobDir,
        config: {},
        to: "test@example.com",
        sendEmail: async () => {
          throw new Error("duplicate send must not be attempted before reconciliation");
        },
      }),
      /unknown outcome.*reconcile/i,
    );

    const reconciled = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      sendEmail: async () => {
        throw new Error("reconciled delivery must not send again");
      },
      reconcileSentDelivery: async (attempt) => ({
        id: "gmail-reconciled-1",
        threadId: "thread-reconciled-1",
        subject: "Quote — Delivery reconciliation test",
        messageId: attempt.messageId,
      }),
    });

    assert.equal(reconciled.quoteLifecycle.lastSentQuoteVersion, 1);
    const completed = JSON.parse(await readFile(outboxPath, "utf8"));
    assert.equal(completed.status, "completed");
    const issuanceLedger = JSON.parse(await readFile(join(jobDir, "quote-issuance.json"), "utf8"));
    assert.equal(issuanceLedger.records[0].quoteVersion, 1);
    assert.equal(issuanceLedger.records[0].artifacts.quotePdf.sha256.length, 64);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote with no explicit version sends the latest revision and advances past the locked customer-seen version", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-resend-locked-"));

  try {
    const meta = {
      id: "job-resend-locked-1",
      title: "Resend locked revision test",
      label: "Resend locked revision test",
      outputMode: "quote",
      pipelineStage: "sent",
      deliveryStatus: "sent",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-RESEND-01",
      jobNumber: "JOB-RESEND-01",
    };
    const currentDraftQuote = {
      ...buildSendableQuoteFixture(meta, { version: 2, deliveryStatus: "draft" }),
      totals: {
        subtotal: 300,
        gst: 30,
        total: 330,
        currency: "AUD",
      },
      lineItems: [
        {
          code: "drainage",
          label: "Drainage installation",
          quantity: 1,
          unit: "lot",
          unitPrice: 300,
          totalPrice: 300,
          unitCost: 210,
          totalCost: 210,
          section: "Works",
          customerVisible: true,
        },
      ],
      presentation: {
        scopeText: "Updated internal draft scope.",
        scheduleItems: [
          {
            code: "drainage",
            label: "Drainage installation",
            quantity: 1,
            unit: "lot",
            unitPrice: 300,
            totalPrice: 300,
            sourceLineItemCodes: ["drainage"],
          },
        ],
      },
    };
    const lockedQuote = {
      ...buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "final" }),
      delivery: {
        status: "final",
        finalizedAt: "2026-03-26T01:00:00.000Z",
      },
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(currentDraftQuote, null, 2));
    await writeQuoteVersionSnapshot(jobDir, lockedQuote);
    await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
      version: 1,
      currentQuoteVersion: 2,
      currentPipelineStage: "sent",
      currentLockStatus: "draft",
      sendCount: 1,
      lastSentAt: "2026-03-26T01:00:00.000Z",
      lastSentQuoteVersion: 1,
      lastSentTo: "client@example.com",
    }, null, 2));

    // A revised quote (v2 draft, since v1 was already sent) must actually
    // reach the customer when sent with no explicit version — not the
    // original v1 the resolver used to fall back to.
    let emailedTotal = null;
    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "quote",
      sendEmail: async ({ quote }) => {
        emailedTotal = quote?.totals?.total || null;
        return {
          id: "msg-1",
          threadId: "thread-1",
          subject: "Quote — Resend locked revision test",
          to: "test@example.com",
        };
      },
    });

    assert.equal(emailedTotal, 330);
    assert.equal(result.meta.pipelineStage, "sent");
    assert.equal(result.quoteLifecycle.lastSentQuoteVersion, 2);
    assert.equal(result.quoteLifecycle.sendCount, 2);
    assert.notEqual(result.quoteLifecycle.lastSentAt, "2026-03-26T01:00:00.000Z");
    assert.equal(result.quoteLifecycle.currentQuoteVersion, 2);

    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedQuote.version, 2);
    assert.equal(savedQuote.totals.total, 330);
    assert.equal(savedQuote.delivery.status, "final");

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    // The whole point of the fix: a second no-version send must not keep
    // re-sending the stale v1 — lastSentQuoteVersion has to have advanced.
    assert.equal(lifecycle.lastSentQuoteVersion, 2);
    assert.equal(lifecycle.sendCount, 2);
    assert.equal(lifecycle.currentQuoteVersion, 2);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote can explicitly resend a historical locked version without disturbing the newer draft", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-resend-explicit-historical-"));

  try {
    const meta = {
      id: "job-resend-explicit-historical-1",
      title: "Explicit historical resend test",
      label: "Explicit historical resend test",
      outputMode: "quote",
      pipelineStage: "sent",
      deliveryStatus: "sent",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-RESEND-02",
      jobNumber: "JOB-RESEND-02",
    };
    const currentDraftQuote = {
      ...buildSendableQuoteFixture(meta, { version: 2, deliveryStatus: "draft" }),
      totals: {
        subtotal: 300,
        gst: 30,
        total: 330,
        currency: "AUD",
      },
    };
    const lockedQuote = {
      ...buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "final" }),
      delivery: {
        status: "final",
        finalizedAt: "2026-03-26T01:00:00.000Z",
      },
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(currentDraftQuote, null, 2));
    await writeQuoteVersionSnapshot(jobDir, lockedQuote);
    await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
      version: 1,
      currentQuoteVersion: 2,
      currentPipelineStage: "sent",
      currentLockStatus: "draft",
      sendCount: 1,
      lastSentAt: "2026-03-26T01:00:00.000Z",
      lastSentQuoteVersion: 1,
      lastSentTo: "client@example.com",
    }, null, 2));

    // Explicitly asking to resend v1 (e.g. a support request for "what did
    // you send me before") must still work and must not touch the v2 draft.
    let emailedTotal = null;
    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "quote",
      quoteVersion: 1,
      sendEmail: async ({ quote }) => {
        emailedTotal = quote?.totals?.total || null;
        return {
          id: "msg-1",
          threadId: "thread-1",
          subject: "Quote — Explicit historical resend test",
          to: "test@example.com",
        };
      },
    });

    assert.equal(emailedTotal, 110);
    assert.equal(result.quoteLifecycle.lastSentQuoteVersion, 1);
    assert.equal(result.quoteLifecycle.currentQuoteVersion, 2);

    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedQuote.version, 2);
    assert.equal(savedQuote.totals.total, 330);
    assert.equal(savedQuote.delivery.status, "draft");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sending a revised quote on a landed job delivers the latest revision without un-landing the job", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-resend-landed-"));

  try {
    const meta = {
      id: "job-resend-landed-1",
      title: "Landed resend preservation test",
      label: "Landed resend preservation test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      landedAt: "2026-03-27T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-RESEND-LANDED-01",
      jobNumber: "JOB-RESEND-LANDED-01",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
      milestoneInvoices: [],
    };
    const currentDraftQuote = {
      ...buildSendableQuoteFixture(meta, { version: 2, deliveryStatus: "draft" }),
      totals: {
        subtotal: 300,
        gst: 30,
        total: 330,
        currency: "AUD",
      },
      lineItems: [
        {
          code: "drainage",
          label: "Drainage installation",
          quantity: 1,
          unit: "lot",
          unitPrice: 300,
          totalPrice: 300,
          unitCost: 210,
          totalCost: 210,
          section: "Works",
          customerVisible: true,
        },
      ],
      presentation: {
        scopeText: "Updated internal draft scope.",
        scheduleItems: [
          {
            code: "drainage",
            label: "Drainage installation",
            quantity: 1,
            unit: "lot",
            unitPrice: 300,
            totalPrice: 300,
            sourceLineItemCodes: ["drainage"],
          },
        ],
      },
    };
    const lockedQuote = {
      ...buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "final" }),
      delivery: {
        status: "final",
        finalizedAt: "2026-03-26T01:00:00.000Z",
      },
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(currentDraftQuote, null, 2));
    await writeQuoteVersionSnapshot(jobDir, lockedQuote);
    await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
      version: 1,
      currentQuoteVersion: 2,
      currentPipelineStage: "landed",
      currentLockStatus: "draft",
      sendCount: 1,
      lastSentAt: "2026-03-26T01:00:00.000Z",
      lastSentQuoteVersion: 1,
      lastSentTo: "client@example.com",
      landedAt: "2026-03-27T01:00:00.000Z",
    }, null, 2));

    let emailedTotal = null;
    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "quote",
      sendEmail: async ({ quote }) => {
        emailedTotal = quote?.totals?.total || null;
        return {
          id: "msg-1",
          threadId: "thread-1",
          subject: "Quote — Landed resend preservation test",
          to: "test@example.com",
        };
      },
    });

    // The revised (latest) version is what actually goes out...
    assert.equal(emailedTotal, 330);
    assert.equal(result.quoteLifecycle.lastSentQuoteVersion, 2);
    // ...but the send must not un-land the job. This is the regression the
    // delivery-intent fix introduced: v2 is now selectedIsLatest, so the
    // send fell through the "resendLockedQuoteVersion" branch (which used
    // to accidentally preserve stage as a side effect) into the finalize
    // branch, which used to hardcode pipelineStage to "sent" unconditionally.
    assert.equal(result.meta.pipelineStage, "landed");
    assert.equal(result.meta.deliveryStatus, "landed");
    assert.equal(result.meta.landedAt, "2026-03-27T01:00:00.000Z");
    assert.equal(result.quoteLifecycle.currentPipelineStage, "landed");

    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal(savedMeta.pipelineStage, "landed");
    assert.equal(savedMeta.deliveryStatus, "landed");
    assert.equal(savedMeta.landedAt, "2026-03-27T01:00:00.000Z");

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.currentPipelineStage, "landed");
    assert.equal(lifecycle.lastSentQuoteVersion, 2);

    // The user-visible harm: an invoice send must still work afterwards.
    // Before the fix, the job would have silently dropped to "sent" and
    // this would 409 with "only landed jobs can send a invoice".
    const invoiceResult = await sendJobQuote({
      jobDir,
      meta: result.meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "invoice",
      sendEmail: async ({ quote }) => ({
        id: "msg-2",
        threadId: "thread-2",
        subject: "Invoice — Landed resend preservation test",
        to: "test@example.com",
        total: quote?.totals?.total,
      }),
    });
    assert.equal(invoiceResult.milestoneInvoice.total, 330);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// This is a CHARACTERISATION test, not a regression test — it pins
// a deliberate policy decision, not a bug fix. Sending a revised quote must
// NOT un-land a landed job (see the test above and the comment at
// job-actions.js:1466), but a lost job is the mirror case: nothing gates on
// "lost", and a deliberate resend to a lost job IS the signal that the
// opportunity is active again. Leaving it stuck on "lost" would hide a
// reactivated opportunity from every active-pipeline view. This asymmetry
// (landed preserved, lost flips to sent) is easy to mistake for an
// inconsistency and "fix" by a later refactor — this test exists solely to
// stop that. It passes both before and after commit 6ece746, because
// lost -> sent on send is unchanged, pre-existing behaviour; do not delete
// it as redundant, and do not "fix" it to preserve "lost".
test("sending a revised quote on a LOST job moves it back to sent, unlike landed (deliberate, not a regression)", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-resend-lost-"));

  try {
    const meta = {
      id: "job-resend-lost-1",
      title: "Lost resend reactivation test",
      label: "Lost resend reactivation test",
      outputMode: "quote",
      pipelineStage: "lost",
      deliveryStatus: "lost",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      lostAt: "2026-03-27T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-RESEND-LOST-01",
      jobNumber: "JOB-RESEND-LOST-01",
    };
    const currentDraftQuote = {
      ...buildSendableQuoteFixture(meta, { version: 2, deliveryStatus: "draft" }),
      totals: {
        subtotal: 300,
        gst: 30,
        total: 330,
        currency: "AUD",
      },
      lineItems: [
        {
          code: "drainage",
          label: "Drainage installation",
          quantity: 1,
          unit: "lot",
          unitPrice: 300,
          totalPrice: 300,
          unitCost: 210,
          totalCost: 210,
          section: "Works",
          customerVisible: true,
        },
      ],
      presentation: {
        scopeText: "Updated internal draft scope.",
        scheduleItems: [
          {
            code: "drainage",
            label: "Drainage installation",
            quantity: 1,
            unit: "lot",
            unitPrice: 300,
            totalPrice: 300,
            sourceLineItemCodes: ["drainage"],
          },
        ],
      },
    };
    const lockedQuote = {
      ...buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "final" }),
      delivery: {
        status: "final",
        finalizedAt: "2026-03-26T01:00:00.000Z",
      },
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(currentDraftQuote, null, 2));
    await writeQuoteVersionSnapshot(jobDir, lockedQuote);
    await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
      version: 1,
      currentQuoteVersion: 2,
      currentPipelineStage: "lost",
      currentLockStatus: "draft",
      sendCount: 1,
      lastSentAt: "2026-03-26T01:00:00.000Z",
      lastSentQuoteVersion: 1,
      lastSentTo: "client@example.com",
      lostAt: "2026-03-27T01:00:00.000Z",
    }, null, 2));

    let emailedTotal = null;
    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "quote",
      sendEmail: async ({ quote }) => {
        emailedTotal = quote?.totals?.total || null;
        return {
          id: "msg-1",
          threadId: "thread-1",
          subject: "Quote — Lost resend reactivation test",
          to: "test@example.com",
        };
      },
    });

    assert.equal(emailedTotal, 330);
    assert.equal(result.quoteLifecycle.lastSentQuoteVersion, 2);
    // The deliberate half: lost flips to sent (reactivating the
    // opportunity), unlike landed which stays put.
    assert.equal(result.meta.pipelineStage, "sent");
    assert.equal(result.meta.deliveryStatus, "sent");
    assert.equal(result.quoteLifecycle.currentPipelineStage, "sent");
    // lostAt survives the transition, mirroring the sanctioned stage-change
    // path's behaviour at job-actions.js:2511-2513 (setJobPipelineStage
    // preserves lostAt when moving off "lost" too).
    assert.equal(result.meta.lostAt, "2026-03-27T01:00:00.000Z");

    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal(savedMeta.pipelineStage, "sent");
    assert.equal(savedMeta.deliveryStatus, "sent");
    assert.equal(savedMeta.lostAt, "2026-03-27T01:00:00.000Z");

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.currentPipelineStage, "sent");
    assert.equal(lifecycle.lastSentQuoteVersion, 2);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote can explicitly send the latest draft revision on a sent job", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-send-explicit-draft-"));

  try {
    const meta = {
      id: "job-send-explicit-draft-1",
      title: "Explicit draft send test",
      label: "Explicit draft send test",
      outputMode: "quote",
      pipelineStage: "sent",
      deliveryStatus: "sent",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 2,
      quoteNumber: "EQ-SEND-DRAFT-01",
      jobNumber: "JOB-SEND-DRAFT-01",
    };
    const currentDraftQuote = {
      ...buildSendableQuoteFixture(meta, { version: 2, deliveryStatus: "draft" }),
      totals: {
        subtotal: 300,
        gst: 30,
        total: 330,
        currency: "AUD",
      },
      lineItems: [
        {
          code: "drainage",
          label: "Drainage installation",
          quantity: 1,
          unit: "lot",
          unitPrice: 300,
          totalPrice: 300,
          unitCost: 210,
          totalCost: 210,
          section: "Works",
          customerVisible: true,
        },
      ],
      presentation: {
        scopeText: "Updated internal draft scope.",
        scheduleItems: [
          {
            code: "drainage",
            label: "Drainage installation",
            quantity: 1,
            unit: "lot",
            unitPrice: 300,
            totalPrice: 300,
            sourceLineItemCodes: ["drainage"],
          },
        ],
      },
    };
    const lockedQuote = {
      ...buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "final" }),
      delivery: {
        status: "final",
        finalizedAt: "2026-03-26T01:00:00.000Z",
      },
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(currentDraftQuote, null, 2));
    await writeQuoteVersionSnapshot(jobDir, lockedQuote);
    await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
      version: 1,
      currentQuoteVersion: 2,
      currentPipelineStage: "sent",
      currentLockStatus: "draft",
      sendCount: 1,
      lastSentAt: "2026-03-26T01:00:00.000Z",
      lastSentQuoteVersion: 1,
      lastSentTo: "client@example.com",
    }, null, 2));

    let emailedTotal = null;
    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: {},
      to: "test@example.com",
      documentType: "quote",
      quoteVersion: 2,
      sendEmail: async ({ quote }) => {
        emailedTotal = quote?.totals?.total || null;
        return {
          id: "msg-1",
          threadId: "thread-1",
          subject: "Quote — Explicit draft send test",
          to: "test@example.com",
        };
      },
    });

    assert.equal(emailedTotal, 330);
    assert.equal(result.meta.pipelineStage, "sent");
    assert.equal(result.quoteLifecycle.lastSentQuoteVersion, 2);

    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedQuote.version, 2);
    assert.equal(savedQuote.delivery.status, "final");

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.lastSentQuoteVersion, 2);
    assert.equal(lifecycle.currentQuoteVersion, 2);
    assert.equal(lifecycle.currentLockStatus, "final");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("setJobPipelineStage to sent finalizes the current quote artifact in place", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-stage-lock-"));

  try {
    const meta = {
      id: "job-stage-lock-1",
      title: "Stage lock test",
      label: "Stage lock test",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteNumber: "EQ-TEST-STAGE",
      jobNumber: "JOB-TEST-STAGE",
    };
    const quote = buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "draft" });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const result = await setJobPipelineStage({
      jobDir,
      meta,
      stage: "sent",
      actor: { kind: "user", label: "Test Operator" },
    });

    assert.equal(result.meta.pipelineStage, "sent");
    assert.equal(result.meta.deliveryStatus, "sent");
    // Nothing was delivered, so there is no send time to record.
    assert.equal(result.meta.quoteSentAt, null);

    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    assert.equal(savedQuote.delivery.status, "final");
    assert.ok(savedQuote.delivery.finalizedAt);

    const savedOverrides = JSON.parse(await readFile(join(jobDir, "quote-overrides.json"), "utf8"));
    assert.equal(savedOverrides.lockStatus, "final");
    assert.equal(savedOverrides.finalizedAt, savedQuote.delivery.finalizedAt);

    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.lastSentQuoteVersion, null);
    assert.equal(lifecycle.markedSentQuoteVersion, 1);
    assert.equal(lifecycle.currentLockStatus, "final");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("moving a quote to Sent by hand records who and when but is not evidence it was issued", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-stage-manual-sent-"));

  try {
    const meta = {
      id: "job-stage-manual-sent-1",
      title: "Manual sent test",
      label: "Manual sent test",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteNumber: "EQ-TEST-MANUAL",
      jobNumber: "JOB-TEST-MANUAL",
    };
    const quote = buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "draft" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const result = await setJobPipelineStage({
      jobDir,
      meta,
      stage: "sent",
      actor: { kind: "user", label: "Test Operator" },
    });

    const lifecycle = await readQuoteLifecycle(jobDir);
    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    const issuance = await readQuoteIssuanceLedger(jobDir);
    assert.equal(result.meta.pipelineStage, "sent");
    assert.equal(result.meta.quoteSentAt, null);
    assert.equal(lifecycle.sendCount, 0);
    assert.equal(lifecycle.lastSentQuoteVersion, null);
    assert.equal(lifecycle.markedSentQuoteVersion, 1);
    assert.ok(lifecycle.markedSentAt);
    assert.equal(lifecycle.markedSentBy, "Test Operator");
    assert.equal(issuance.records.length, 0);
    assert.equal(
      isIssuedQuoteVersion({ quote: savedQuote, quoteLifecycle: lifecycle, version: 1, meta: result.meta }),
      false,
      "a stage change is not a delivery: no issued copy exists for this version",
    );

    // The operator said the customer has it, so it still locks like a sent quote.
    const policy = buildQuoteEditPolicy({
      meta: result.meta,
      quoteLifecycle: lifecycle,
      latestVersion: 1,
      selectedVersion: 1,
    });
    assert.equal(policy.lastSentQuoteVersion, 1);
    assert.equal(policy.latestVersionLocked, true);

    // Landing it later does not turn the hand-marked send into a delivery.
    const landed = await recordQuoteLanded({
      jobDir,
      meta: { ...result.meta, pipelineStage: "landed", landedAt: "2026-04-01T00:00:00.000Z" },
    });
    assert.equal(landed.sendCount, 0);
    assert.equal(landed.lastSentQuoteVersion, null);
    assert.equal(landed.currentLockStatus, "final");
    assert.equal(
      isIssuedQuoteVersion({ quote: savedQuote, quoteLifecycle: landed, version: 1, meta: result.meta }),
      false,
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("moving a job sent before the issuance ledger to Lost keeps it issued", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-stage-legacy-sent-"));

  try {
    const meta = {
      id: "job-stage-legacy-sent-1",
      outputMode: "quote",
      pipelineStage: "sent",
      quoteSentAt: "2026-03-26T01:00:00.000Z",
      quoteVersion: 1,
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));

    const result = await setJobPipelineStage({
      jobDir,
      meta,
      stage: "lost",
      actor: { kind: "user", label: "Test Operator" },
    });

    const lifecycle = await readQuoteLifecycle(jobDir);
    assert.equal(lifecycle.lastSentQuoteVersion, 1);
    assert.equal(lifecycle.markedSentQuoteVersion, null);
    assert.equal(isIssuedQuoteVersion({ quoteLifecycle: lifecycle, version: 1, meta: result.meta }), true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("setJobPipelineStage rejects impossible draft to landed jumps", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invalid-stage-"));

  try {
    const meta = {
      id: "job-invalid-stage-1",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 1,
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));

    await assert.rejects(
      () => setJobPipelineStage({
        jobDir,
        meta,
        stage: "landed",
        actor: { kind: "user", label: "Test Operator" },
      }),
      /cannot move quote status from draft to landed/i
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("markJobLanded rejects draft quotes", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-landed-"));

  try {
    await assert.rejects(
      () => markJobLanded({
        jobDir,
        meta: {
          id: "job-landed-draft",
          outputMode: "quote",
          pipelineStage: "draft",
        },
        dataDir: jobDir,
        config: {},
      }),
      /send this quote before marking it landed/
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("markJobLanded rejects non-quote jobs", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-landed-"));

  try {
    await assert.rejects(
      () => markJobLanded({
        jobDir,
        meta: {
          id: "job-landed-report",
          outputMode: "report",
          pipelineStage: "sent",
        },
        dataDir: jobDir,
        config: {},
      }),
      /only quote jobs can be marked landed/
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("paid milestone invoices write receipt artifacts and markJobMilestoneUnpaid removes them", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-receipt-artifact-"));

  try {
    const meta = {
      id: "job-receipt-artifact-1",
      title: "Receipt artifact test",
      label: "Receipt artifact test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteVersion: 2,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
      quoteNumber: "EQ-TEST-RECEIPT",
      jobNumber: "JOB-TEST-RECEIPT",
    };
    const quote = createQuoteFixture(meta, {
      version: 2,
      quoteNumber: "EQ-TEST-RECEIPT",
      totals: {
        subtotal: 200,
        gst: 20,
        total: 220,
        currency: "AUD",
      },
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    });
    const authorised = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });
    const firstMilestone = authorised.meta.milestoneInvoices[0];

    const paid = await recordJobMilestonePayment({
      jobDir,
      meta: authorised.meta,
      config: {},
      milestoneIndex: 0,
      payment: {
        amount: firstMilestone.total,
        date: "2026-03-28",
        reference: "EFT-RECEIPT-1",
        method: "manual",
      },
    });
    const paidMilestone = paid.meta.milestoneInvoices[0];
    const receiptPath = join(jobDir, paidMilestone.receiptPdfPath);
    assert.equal(paidMilestone.status, "paid");
    assert.ok(existsSync(receiptPath), "expected paid milestone receipt artifact to exist");

    const unpaid = await markJobMilestoneUnpaid({
      jobDir,
      meta: paid.meta,
      config: {},
      milestoneIndex: 0,
    });
    const unpaidMilestone = unpaid.meta.milestoneInvoices[0];
    assert.equal(unpaidMilestone.status, "draft");
    assert.equal(unpaidMilestone.amountPaid, 0);
    assert.equal(unpaidMilestone.amountDue, unpaidMilestone.total);
    assert.equal(unpaidMilestone.issuedAt, null);
    assert.deepEqual(unpaidMilestone.payments, []);
    assert.equal(existsSync(receiptPath), false);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// The same explicit/implicit failure isolation that protects
// invoice artifact writes must also cover receipt writes — an
// I/O failure on an UNRELATED (implicit) milestone's receipt must not abort
// the whole mutation either.
test("an I/O failure writing one milestone's receipt does not abort a mutation that also touches other milestones", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-receipt-isolation-"));

  try {
    const meta = {
      id: "job-receipt-isolation-1",
      title: "Receipt isolation test",
      label: "Receipt isolation test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteVersion: 2,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
      quoteNumber: "EQ-TEST-RECEIPT-ISO",
      jobNumber: "JOB-TEST-RECEIPT-ISO",
    };
    const paymentSchedule = {
      milestones: [
        { label: "Deposit", percentage: 50 },
        { label: "Final", percentage: 50 },
      ],
    };
    const quote = createQuoteFixture(meta, {
      version: 2,
      quoteNumber: "EQ-TEST-RECEIPT-ISO",
      totals: { subtotal: 200, gst: 20, total: 220, currency: "AUD" },
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({ jobDir, meta, config: {}, paymentSchedule });
    let current = generated.meta;
    for (const milestoneIndex of [0, 1]) {
      const authorised = await updateJobMilestone({
        jobDir, meta: current, config: {}, milestoneIndex, patch: { status: "authorised" },
      });
      current = authorised.meta;
      const target = current.milestoneInvoices[milestoneIndex];
      const paid = await recordJobMilestonePayment({
        jobDir, meta: current, config: {}, milestoneIndex,
        payment: { amount: target.total, date: "2026-03-28", reference: `EFT-ISO-${milestoneIndex}`, method: "manual" },
      });
      current = paid.meta;
    }
    assert.equal(current.milestoneInvoices[0].status, "paid");
    assert.equal(current.milestoneInvoices[1].status, "paid");

    const milestone1ReceiptPath = join(jobDir, current.milestoneInvoices[1].receiptPdfPath);
    const milestone0ReceiptPath = join(jobDir, current.milestoneInvoices[0].receiptPdfPath);
    assert.ok(existsSync(milestone1ReceiptPath));

    // Poison milestone 1's receipt path: a DIRECTORY sits where a file must
    // be written, so the next write attempt throws EISDIR.
    await rm(milestone1ReceiptPath, { force: true });
    await mkdir(milestone1ReceiptPath, { recursive: true });

    // `generateJobMilestones` regenerates every milestone unconditionally
    // (writeAllArtifacts) with no single explicit target — every entry,
    // including the poisoned milestone 1, is implicit.
    const regenerated = await generateJobMilestones({ jobDir, meta: current, config: {}, paymentSchedule });

    // The mutation completed: milestone 0's receipt still exists and its
    // own state is untouched by milestone 1's broken receipt.
    assert.ok(existsSync(milestone0ReceiptPath));
    assert.equal(regenerated.meta.milestoneInvoices[0].status, "paid");
    assert.equal(regenerated.meta.milestoneInvoices[1].status, "paid");

    // Milestone 1's receipt genuinely failed to write (still a directory,
    // not silently replaced) — proving the failure was real, not skipped
    // over by some unrelated short-circuit.
    const milestone1ReceiptStat = await stat(milestone1ReceiptPath);
    assert.ok(milestone1ReceiptStat.isDirectory(), "milestone 1's receipt path is still the poisoned directory");

    const { activity } = await readJobState(jobDir);
    assert.ok(
      activity.some((entry) => entry.kind === "invoice.milestones_generated"),
      "the regeneration mutation completed and was recorded",
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("markJobMilestoneUnsent returns an authorised milestone to draft and releases its issue lock", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-unsent-"));

  try {
    const meta = {
      id: "job-unsent-1",
      title: "Unsent milestone test",
      label: "Unsent milestone test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteVersion: 2,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
      quoteNumber: "EQ-TEST-UNSENT",
      jobNumber: "JOB-TEST-UNSENT",
    };
    const quote = createQuoteFixture(meta, {
      version: 2,
      quoteNumber: "EQ-TEST-UNSENT",
    });

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    });
    const authorised = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });

    const unsent = await markJobMilestoneUnsent({
      jobDir,
      meta: authorised.meta,
      config: {},
      milestoneIndex: 0,
    });
    const draftMilestone = unsent.meta.milestoneInvoices[0];
    assert.equal(draftMilestone.status, "draft");
    assert.equal(draftMilestone.issuedAt, null);
    assert.equal(draftMilestone.amountPaid, 0);
    assert.equal(draftMilestone.amountDue, draftMilestone.total);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("sendJobQuote rejects quotes without fresh pricing attestation", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-send-"));

  try {
    await writeFile(join(jobDir, "quote.json"), JSON.stringify({
      kind: "quote",
      version: 1,
      quoteNumber: "EQ-TEST-UNVERIFIED",
      jobNumber: "JOB-TEST-UNVERIFIED",
      lineItems: [],
      assumptionInputs: [],
      missingInputs: [],
      review: {
        status: "ready",
        reasons: [],
      },
      delivery: {
        status: "draft",
      },
      totals: {
        subtotal: 100,
        gst: 10,
        total: 110,
        currency: "AUD",
      },
      pricing: {
        authorityProvider: "price_catalog_unavailable",
        ready: false,
        displayable: false,
        sendable: false,
        blockingReason: "Fresh commercial pricing verification is required before sending this quote.",
        attestation: {
          status: "unverified",
          requestNonce: "req-1",
          verifiedNonce: null,
        },
      },
    }, null, 2));

    await assert.rejects(
      () => sendJobQuote({
        jobDir,
        meta: {
          id: "job-send-unverified",
          title: "Unverified Quote",
          pipelineStage: "draft",
        },
        dataDir: jobDir,
        config: {},
        to: "test@example.com",
      }),
      /fresh commercial pricing verification is required/i,
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

async function seedLandedJobWithSentInvoice(jobDir, { id }) {
  const meta = {
    id,
    title: "Revised invoice test",
    label: "Revised invoice test",
    outputMode: "quote",
    pipelineStage: "landed",
    deliveryStatus: "landed",
    quoteNumber: "EQ-REV-01",
    jobNumber: "JOB-REV-01",
    quoteVersion: 2,
    landedAt: "2026-05-01T00:00:00.000Z",
    paymentSchedule: {
      milestones: [
        { label: "Deposit", percentage: 50 },
        { label: "Final", percentage: 50 },
      ],
    },
  };
  const quote = createQuoteFixture(meta, { version: 2 });
  await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

  const generated = await generateJobMilestones({
    jobDir,
    meta,
    config: {},
    paymentSchedule: meta.paymentSchedule,
  });
  const sent = await updateJobMilestone({
    jobDir,
    meta: generated.meta,
    config: {},
    milestoneIndex: 0,
    patch: { status: "authorised" },
    actor: { kind: "user", label: "Alex" },
  });
  return { meta: sent.meta, quote };
}

async function applyApprovedVariation(jobDir, baseQuote) {
  // An approved variation lands as the newer customer-facing quote revision.
  const variation = {
    ...baseQuote,
    version: 3,
    lineItems: [
      ...baseQuote.lineItems,
      {
        code: "rock",
        label: "Rock clause",
        quantity: 1,
        unit: "lot",
        unitPrice: 100,
        totalPrice: 100,
        unitCost: 70,
        totalCost: 70,
        section: "Works",
        customerVisible: true,
      },
    ],
    presentation: {
      ...baseQuote.presentation,
      scheduleItems: [
        ...baseQuote.presentation.scheduleItems,
        {
          code: "rock",
          label: "Rock clause",
          quantity: 1,
          unit: "lot",
          unitPrice: 100,
          totalPrice: 100,
          sourceLineItemCodes: ["rock"],
        },
      ],
    },
    totals: { subtotal: 300, gst: 30, total: 330, currency: "AUD" },
  };
  await writeFile(join(jobDir, "quote.json"), JSON.stringify(variation, null, 2));
  return variation;
}

test("a sent invoice and its PDF survive an approved quote change untouched", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-freeze-"));

  try {
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-freeze-1" });
    const sentNumber = seeded.meta.milestoneInvoices[0].invoiceNumber;
    assert.match(sentNumber, SEQUENCE_NUMBER);
    const sentPdfPath = join(jobDir, "milestone-invoices", `${sentNumber}.pdf`);
    assert.ok(existsSync(sentPdfPath));
    const sentPdfBytes = await readFile(sentPdfPath);

    await applyApprovedVariation(jobDir, seeded.quote);

    // Any ordinary milestone action re-synchronizes invoice state. None of
    // them may move a document the customer already holds.
    await updateJobMilestone({
      jobDir,
      meta: seeded.meta,
      config: {},
      milestoneIndex: 1,
      patch: { dueDate: "2026-06-01" },
    });

    const hydrated = await readJobMeta(jobDir);
    const sentInvoice = hydrated.milestoneInvoices[0];
    assert.equal(sentInvoice.invoiceNumber, sentNumber);
    assert.equal(sentInvoice.revisionNumber, 1);
    assert.equal(sentInvoice.total, 110);
    assert.equal(sentInvoice.issuedRevision.quoteVersion, 2);
    assert.deepEqual(await readFile(sentPdfPath), sentPdfBytes);

    // The open milestone absorbs the approved increase.
    assert.equal(hydrated.milestoneInvoices[1].total, 220);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("reviseJobMilestoneInvoice issues an attributable new invoice without disturbing the original", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-revise-"));

  try {
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-revise-1" });
    const originalNumber = seeded.meta.milestoneInvoices[0].invoiceNumber;
    assert.match(originalNumber, SEQUENCE_NUMBER);
    const originalPdfPath = join(jobDir, "milestone-invoices", `${originalNumber}.pdf`);
    const originalPdfBytes = await readFile(originalPdfPath);
    await applyApprovedVariation(jobDir, seeded.quote);

    const revised = await reviseJobMilestoneInvoice({
      jobDir,
      meta: seeded.meta,
      config: {},
      milestoneIndex: 0,
      reason: "Approved rock clause variation on the north bench",
      expectedRevisionNumber: 1,
      actor: { kind: "user", label: "Alex" },
    });

    // The revision is issued like any invoice: its own number from the
    // sequence, never a -R2 suffix on the original's.
    const revisedNumber = revised.revision.invoiceNumber;
    assert.match(revisedNumber, SEQUENCE_NUMBER);
    assert.notEqual(revisedNumber, originalNumber);
    assert.equal(revised.revision.revisionNumber, 2);
    assert.equal(revised.revision.supersedesInvoiceNumber, originalNumber);
    assert.equal(revised.revision.supersededTotal, 110);
    assert.equal(revised.revision.total, 165);
    assert.equal(revised.revision.totalDelta, 55);
    assert.equal(revised.revision.revisedBy, "Alex");
    assert.equal(revised.revision.revisionReason, "Approved rock clause variation on the north bench");
    assert.equal(revised.revision.supersededQuoteVersion, 2);
    assert.equal(revised.revision.quoteVersion, 3);

    // The original invoice PDF is byte-identical and still retrievable.
    assert.ok(existsSync(originalPdfPath));
    assert.deepEqual(await readFile(originalPdfPath), originalPdfBytes);

    const revisedPdfPath = join(jobDir, "milestone-invoices", `${revisedNumber}.pdf`);
    assert.ok(existsSync(revisedPdfPath));
    assert.notDeepEqual(await readFile(revisedPdfPath), originalPdfBytes);

    const hydrated = await readJobMeta(jobDir);
    const current = hydrated.milestoneInvoices[0];
    assert.equal(current.invoiceNumber, revisedNumber);
    assert.equal(current.revisionNumber, 2);
    assert.equal(current.total, 165);
    assert.equal(current.status, "authorised");
    assert.equal(current.revisionHistory.length, 1);
    assert.equal(current.revisionHistory[0].invoiceNumber, originalNumber);
    assert.equal(current.revisionHistory[0].total, 110);
    assert.equal(current.revisionHistory[0].pdfPath, `milestone-invoices/${originalNumber}.pdf`);
    assert.equal(current.revisionHistory[0].supersededByRevisionNumber, 2);
    assert.ok(current.revisionHistory[0].pdfSha256);

    // The superseded revision is addressable and serves the original bytes.
    const historical = await readMilestoneInvoiceRevisionArtifact({
      jobDir,
      revision: findMilestoneInvoiceRevision(current, 1),
    });
    assert.deepEqual(historical.pdfBuffer, originalPdfBytes);
    assert.equal(
      createHash("sha256").update(historical.pdfBuffer).digest("hex"),
      current.revisionHistory[0].pdfSha256,
    );
    assert.equal(hydrated.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0), 330);

    const activityLog = await readFile(join(jobDir, "job-state", "activity.jsonl"), "utf8");
    const revisionEvent = activityLog
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.kind === "invoice.revised");
    assert.ok(revisionEvent, "a revision activity entry is recorded");
    assert.ok(revisionEvent.body.includes(`${revisedNumber} (revision 2) supersedes ${originalNumber}`), revisionEvent.body);
    assert.match(revisionEvent.body, /Reason: Approved rock clause variation on the north bench/);
    assert.equal(revisionEvent.actor.label, "Alex");
    assert.equal(revised.quoteLifecycle.lastSentQuoteVersion, 3);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a repeated or stale revision request never duplicates an invoice revision", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-revise-guard-"));

  try {
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-revise-2" });
    await applyApprovedVariation(jobDir, seeded.quote);

    const first = await reviseJobMilestoneInvoice({
      jobDir,
      meta: seeded.meta,
      config: {},
      milestoneIndex: 0,
      reason: "Approved rock clause variation",
      expectedRevisionNumber: 1,
      actor: { kind: "user", label: "Alex" },
    });
    assert.equal(first.revision.revisionNumber, 2);

    // A retried request still carrying the old revision number is rejected.
    await assert.rejects(
      reviseJobMilestoneInvoice({
        jobDir,
        meta: first.meta,
        config: {},
        milestoneIndex: 0,
        reason: "Approved rock clause variation",
        expectedRevisionNumber: 1,
        actor: { kind: "user", label: "Alex" },
      }),
      /already at revision 2/i,
    );

    // And a request with no guard at all still cannot mint a duplicate,
    // because the approved values are already invoiced.
    await assert.rejects(
      reviseJobMilestoneInvoice({
        jobDir,
        meta: first.meta,
        config: {},
        milestoneIndex: 0,
        reason: "Approved rock clause variation",
        actor: { kind: "user", label: "Alex" },
      }),
      /nothing to revise/i,
    );

    const hydrated = await readJobMeta(jobDir);
    assert.equal(hydrated.milestoneInvoices[0].revisionNumber, 2);
    assert.equal(hydrated.milestoneInvoices[0].revisionHistory.length, 1);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("reviseJobMilestoneInvoice refuses unsafe revisions", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-revise-refuse-"));

  try {
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-revise-3" });

    await assert.rejects(
      reviseJobMilestoneInvoice({
        jobDir,
        meta: seeded.meta,
        config: {},
        milestoneIndex: 0,
        reason: "   ",
      }),
      /revision reason is required/i,
    );

    // The second milestone has never been issued, so there is no money
    // document to supersede.
    await assert.rejects(
      reviseJobMilestoneInvoice({
        jobDir,
        meta: seeded.meta,
        config: {},
        milestoneIndex: 1,
        reason: "Approved variation",
      }),
      /already been issued/i,
    );

    // Reducing a claim below what the customer already paid needs the payment
    // voided first, not a quiet credit.
    const paid = await recordJobMilestonePayment({
      jobDir,
      meta: seeded.meta,
      config: {},
      milestoneIndex: 0,
      payment: { amount: 110, date: "2026-05-02", reference: "DEPOSIT" },
    });
    const reduced = {
      ...seeded.quote,
      version: 3,
      lineItems: [{ ...seeded.quote.lineItems[0], unitPrice: 100, totalPrice: 100 }],
      presentation: {
        ...seeded.quote.presentation,
        scheduleItems: [{ ...seeded.quote.presentation.scheduleItems[0], unitPrice: 100, totalPrice: 100 }],
      },
      totals: { subtotal: 100, gst: 10, total: 110, currency: "AUD" },
    };
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(reduced, null, 2));
    await assert.rejects(
      reviseJobMilestoneInvoice({
        jobDir,
        meta: paid.meta,
        config: {},
        milestoneIndex: 0,
        reason: "Scope reduced after approval",
      }),
      /cannot be lower than the amount already paid/i,
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// reviseJobMilestoneInvoice only rejected a version
// older than the invoice's OWN pin — a version older than the CURRENT root
// but at or above that pin was accepted, then written straight over root
// with no archive of the displaced content (root artifacts are only ever
// archived on fork). The promoted-from archive dir was also left in place,
// so root's version number then collided with an existing quote-versions
// dir and bricked the next fork with "version N is already archived".
test("reviseJobMilestoneInvoice rejects a quote version older than the current root and leaves root and archives untouched", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-revise-stale-version-"));

  try {
    // Seeds a landed job with milestone 0 issued against v2 (root).
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-revise-stale-1" });

    // Fork: v2 is archived to quote-versions/v002, root becomes v3 (an
    // exact copy of v2's content, just bumped) — the accepted-but-
    // destructive request names v2: at or above the invoice's own pin
    // (also v2), but older than the current root (v3).
    const forked = await forkCurrentQuoteVersion(jobDir);
    assert.equal(forked.previousVersion, 2);
    assert.equal(forked.currentVersion, 3);

    const rootBefore = await readFile(join(jobDir, "quote.json"), "utf8");
    const archiveBefore = await readFile(
      join(jobDir, "quote-versions", "v002", "quote.json"),
      "utf8",
    );
    assert.equal(existsSync(join(jobDir, "quote-versions", "v003")), false);

    const hydrated = await readJobMeta(jobDir);
    await assert.rejects(
      () => reviseJobMilestoneInvoice({
        jobDir,
        meta: hydrated,
        config: {},
        milestoneIndex: 0,
        reason: "Approved rock clause variation",
        quoteVersion: 2,
      }),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /is not the current quote/i);
        return true;
      },
    );

    // Root and the v2 archive are byte-identical to before the attempt —
    // nothing was overwritten or destroyed.
    assert.equal(await readFile(join(jobDir, "quote.json"), "utf8"), rootBefore);
    assert.equal(
      await readFile(join(jobDir, "quote-versions", "v002", "quote.json"), "utf8"),
      archiveBefore,
    );
    // No stray v3 archive was created either — the rejection happened
    // before any filesystem write.
    assert.equal(existsSync(join(jobDir, "quote-versions", "v003")), false);

    // A subsequent fork still works — the job was never bricked.
    const forkedAgain = await forkCurrentQuoteVersion(jobDir);
    assert.equal(forkedAgain.previousVersion, 3);
    assert.equal(forkedAgain.currentVersion, 4);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// An earlier fix only rejected a target OLDER than
// the current root. `promoteQuoteVersion` archives the DISPLACED root at
// its own number and REMOVES the promoted target's archive dir — so
// promoting an older version back to current can leave an archive dir
// numbered HIGHER than root (e.g. root v2 with quote-versions/v003
// present, after forking to v3 and then promoting v2 back down). Naming
// that archived version in a revise passed both of those guards and wrote
// it straight over root with no archive of the displaced content.
test("reviseJobMilestoneInvoice rejects a quote version NEWER than the current root and leaves root and archives untouched", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-revise-newer-than-root-"));

  try {
    // Seeds a landed job with milestone 0 issued against v2 (root).
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-revise-newer-1" });

    // Fork: v2 archived to quote-versions/v002, root becomes v3.
    await forkCurrentQuoteVersion(jobDir);
    // Promote v2 back to current: v3 (displaced root) archives to
    // quote-versions/v003, and quote-versions/v002 (the promoted-from
    // archive) is removed. Root is now v2 again — matching this invoice's
    // own pin exactly — with quote-versions/v003 present.
    await promoteQuoteVersion(jobDir, 2);
    assert.equal(existsSync(join(jobDir, "quote-versions", "v002")), false);
    assert.equal(existsSync(join(jobDir, "quote-versions", "v003")), true);

    const rootBefore = await readFile(join(jobDir, "quote.json"), "utf8");
    const archiveBefore = await readFile(
      join(jobDir, "quote-versions", "v003", "quote.json"),
      "utf8",
    );

    const hydrated = await readJobMeta(jobDir);
    await assert.rejects(
      () => reviseJobMilestoneInvoice({
        jobDir,
        meta: hydrated,
        config: {},
        milestoneIndex: 0,
        reason: "Approved rock clause variation",
        quoteVersion: 3,
      }),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /is not the current quote/i);
        assert.match(err.message, /promote it to the current version/i);
        return true;
      },
    );

    // Root and the v3 archive are byte-identical to before the attempt.
    assert.equal(await readFile(join(jobDir, "quote.json"), "utf8"), rootBefore);
    assert.equal(
      await readFile(join(jobDir, "quote-versions", "v003", "quote.json"), "utf8"),
      archiveBefore,
    );
    assert.equal(existsSync(join(jobDir, "quote-versions", "v002")), false);

    // The job was never bricked: an ordinary mutation still works
    // afterward. (Deliberately not re-forking or re-revising here:
    // quote-versions/v003 is untouched pre-existing content from the
    // promote-back above, and re-forking from v2 would claim v3 again while
    // that stray archive still exists — forkCurrentQuoteVersion's own
    // handling of a stray future-numbered archive is a separate, unrelated
    // concern from the revise/migrate destructive write this test protects
    // against. A revise at v2 would also be a no-op — content identical to
    // what's already active — and correctly 409 on the fingerprint gate,
    // not proof of anything broken.)
    const hydratedAfterRejection = await readJobMeta(jobDir);
    const updated = await runAtomicJobGeneration(jobDir, (stagedJobDir) => updateJobMilestone({
      jobDir: stagedJobDir,
      meta: hydratedAfterRejection,
      config: {},
      milestoneIndex: 1,
      patch: { dueDate: "2026-06-01" },
    }));
    assert.equal(updated.meta.milestoneInvoices[1].dueDate, "2026-06-01");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("reviseJobMilestoneInvoice still succeeds when explicitly naming the current quote version", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-revise-explicit-current-"));

  try {
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-revise-explicit-current-1" });
    await applyApprovedVariation(jobDir, seeded.quote);

    const revised = await reviseJobMilestoneInvoice({
      jobDir,
      meta: seeded.meta,
      config: {},
      milestoneIndex: 0,
      reason: "Approved rock clause variation, explicit current version",
      quoteVersion: 3,
      actor: { kind: "user", label: "Alex" },
    });

    assert.equal(revised.revision.revisionNumber, 2);
    assert.equal(revised.revision.quoteVersion, 3);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("reviseJobMilestoneInvoice still rejects a version older than the invoice's own pin, distinct from the current-root guard", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-revise-older-than-pin-"));

  try {
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-revise-older-than-pin-1" });
    // Fork twice so a version older than milestone 0's own pin (v2) exists
    // to name: v1 is archived, root becomes v4.
    const rootQuoteContent = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    const v1Quote = { ...rootQuoteContent, version: 1 };
    await mkdir(join(jobDir, "quote-versions", "v001"), { recursive: true });
    await writeFile(join(jobDir, "quote-versions", "v001", "quote.json"), JSON.stringify(v1Quote, null, 2));
    await forkCurrentQuoteVersion(jobDir); // v2 -> archived, root v3
    await forkCurrentQuoteVersion(jobDir); // v3 -> archived, root v4

    const hydrated = await readJobMeta(jobDir);
    await assert.rejects(
      () => reviseJobMilestoneInvoice({
        jobDir,
        meta: hydrated,
        config: {},
        milestoneIndex: 0,
        reason: "Approved rock clause variation",
        quoteVersion: 1,
      }),
      (err) => {
        assert.equal(err.statusCode, 409);
        // Reworded: the old wording ("older than the
        // revision this invoice was issued against (v2)") read as an
        // instruction to pass `--version v2` — which, in the
        // promote-back-down scenario described above, is
        // exactly the destructive request. The new message points the
        // operator at "promote" and explicitly warns against requesting the
        // pinned version directly.
        assert.match(err.message, /pinned to quote v2/i);
        assert.match(err.message, /promote it to current/i);
        assert.match(err.message, /do not request that version number directly/i);
        return true;
      },
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("an issued milestone invoice's PDF is captured even when the persisting call did not target it explicitly, and a later revision leaves it retrievable and byte-identical", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-implicit-issue-"));

  try {
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-implicit-issue-1" });

    // Simulate milestone 1 arriving at "issued" state from an out-of-band
    // source (e.g. a manual data correction) without ever going through an
    // explicit artifact-write target — only the persisted state says it is
    // issued, and no PDF has ever been rendered for it.
    const hydrated = await readJobMeta(jobDir);
    const milestoneInvoices = hydrated.milestoneInvoices.map((invoice) => (
      invoice.milestoneIndex === 1
        ? { ...invoice, issuedAt: "2026-05-02T00:00:00.000Z" }
        : invoice
    ));
    await writeJobMeta(jobDir, { ...hydrated, milestoneInvoices });
    const beforeSync = await readJobMeta(jobDir);
    assert.equal(beforeSync.milestoneInvoices[1].status, "authorised");
    assert.equal(beforeSync.milestoneInvoices[1].issuedRevision, null);

    // Act only on milestone 0. Milestone 1's transition into issued state —
    // and the minting of its issuedRevision — happens purely as a side
    // effect of the ordinary sync this action performs first.
    const updated = await updateJobMilestone({
      jobDir,
      meta: beforeSync,
      config: {},
      milestoneIndex: 0,
      patch: { dueDate: "2026-06-01" },
    });

    const implicitlyIssued = updated.meta.milestoneInvoices[1];
    assert.ok(implicitlyIssued.issuedRevision, "milestone 1 minted an issued revision as a side effect of the sync");
    assert.ok(implicitlyIssued.issuedRevision.pdfIssuedAt, "the implicitly issued revision's PDF was captured");
    const pdfPath = join(jobDir, implicitlyIssued.issuedRevision.pdfPath);
    assert.ok(existsSync(pdfPath), "the PDF for the implicitly issued milestone exists on disk");
    const issuedBytes = await readFile(pdfPath);

    // An approved change later supersedes it. The superseded revision's
    // stored bytes must remain retrievable and byte-identical.
    await applyApprovedVariation(jobDir, seeded.quote);

    const revised = await reviseJobMilestoneInvoice({
      jobDir,
      meta: updated.meta,
      config: {},
      milestoneIndex: 1,
      reason: "Approved rock clause variation",
      expectedRevisionNumber: implicitlyIssued.revisionNumber,
      actor: { kind: "user", label: "Alex" },
    });

    assert.equal(revised.revision.revisionNumber, implicitlyIssued.revisionNumber + 1);
    assert.deepEqual(await readFile(pdfPath), issuedBytes);

    const currentMilestone1 = revised.meta.milestoneInvoices[1];
    const historical = await readMilestoneInvoiceRevisionArtifact({
      jobDir,
      revision: findMilestoneInvoiceRevision(currentMilestone1, implicitlyIssued.revisionNumber),
    });
    assert.ok(historical, "the superseded revision's stored bytes remain retrievable");
    assert.deepEqual(historical.pdfBuffer, issuedBytes);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a quote reduced below the frozen claim produces no minted revision, no paid status, and no artifacts for the open milestone", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-overclaim-"));

  try {
    const meta = {
      id: "job-invoice-overclaim-1",
      title: "Overclaim test",
      label: "Overclaim test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-OVERCLAIM-01",
      jobNumber: "JOB-OVERCLAIM-01",
      quoteVersion: 1,
      landedAt: "2026-05-01T00:00:00.000Z",
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 50 },
          { label: "Final", percentage: 50 },
        ],
      },
    };
    const quote = createQuoteFixture(meta, {
      version: 1,
      quoteNumber: "EQ-OVERCLAIM-01",
      lineItems: [{
        code: "scope", label: "Scope", quantity: 1, unit: "lot",
        unitPrice: 9090.91, totalPrice: 9090.91, unitCost: 5000, totalCost: 5000,
        section: "Works", customerVisible: true,
      }],
      scheduleItems: [{
        code: "scope", label: "Scope", quantity: 1, unit: "lot",
        unitPrice: 9090.91, totalPrice: 9090.91, sourceLineItemCodes: ["scope"],
      }],
      totals: { subtotal: 9090.91, gst: 909.09, total: 10000, currency: "AUD" },
    });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: meta.paymentSchedule,
    });
    const authorised = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
      actor: { kind: "user", label: "Alex" },
    });
    assert.equal(authorised.meta.milestoneInvoices[0].total, 5000);

    // Milestone 1 already has a draft preview PDF from the initial
    // schedule generation (unrelated to being issued) — the assertion
    // below is that the overclaim never touches it, not that no file
    // exists at all.
    const openPdfPath = join(jobDir, generated.meta.milestoneInvoices[1].pdfPath);
    assert.ok(existsSync(openPdfPath));
    const openPdfBytesBeforeReduction = await readFile(openPdfPath);

    // The quote is reduced below what milestone 0 already claims.
    const reduced = {
      ...quote,
      version: 2,
      lineItems: [{ ...quote.lineItems[0], unitPrice: 3636.36, totalPrice: 3636.36 }],
      presentation: {
        ...quote.presentation,
        scheduleItems: [{ ...quote.presentation.scheduleItems[0], unitPrice: 3636.36, totalPrice: 3636.36 }],
      },
      totals: { subtotal: 3636.36, gst: 363.64, total: 4000, currency: "AUD" },
    };
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(reduced, null, 2));

    // Any ordinary action re-syncs milestone state.
    const resynced = await updateJobMilestone({
      jobDir,
      meta: authorised.meta,
      config: {},
      milestoneIndex: 0,
      patch: { dueDate: "2026-06-01" },
    });

    const openMilestone = resynced.meta.milestoneInvoices[1];
    assert.equal(openMilestone.total, 0);
    assert.equal(openMilestone.status, "draft");
    assert.equal(openMilestone.issuedRevision, null);
    assert.equal(openMilestone.issuedAt, null);

    // No money document was minted for the over-claimed milestone: its
    // pre-existing draft preview PDF is untouched (never re-rendered or
    // stamped as issued), and no receipt was ever written for it.
    assert.deepEqual(await readFile(openPdfPath), openPdfBytesBeforeReduction);
    assert.ok(!existsSync(join(jobDir, openMilestone.receiptPdfPath)), "no receipt PDF for the never-issued open milestone");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a stored legacy issued invoice with no issuedRevision keeps its stored total, line items and PDF bytes when rebuilt against a changed quote", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-legacy-freeze-"));

  try {
    const meta = {
      id: "job-invoice-legacy-1",
      title: "Legacy freeze test",
      label: "Legacy freeze test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-LEGACY-01",
      jobNumber: "JOB-LEGACY-01",
      quoteVersion: 1,
      landedAt: "2026-05-01T00:00:00.000Z",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const quote = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-LEGACY-01" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    // A stored record from before invoice revisions: issued, but never froze a
    // snapshot and never stamped pdfIssuedAt (that mechanism did not exist
    // yet).
    const legacyLineItems = [
      { description: "Scope item", quantity: 1, unit: "lot", unitPrice: 200, totalPrice: 200 },
    ];
    const legacyMilestoneInvoices = [{
      milestoneIndex: 0,
      milestoneLabel: "Full payment",
      status: "authorised",
      issuedAt: "2026-05-01T00:00:00.000Z",
      invoiceNumber: "EI-LEGACY-01-M1",
      revisionNumber: 1,
      subtotal: 200,
      gst: 20,
      total: 220,
      currency: "AUD",
      lineItems: legacyLineItems,
      pdfPath: "milestone-invoices/EI-LEGACY-01-M1.pdf",
    }];
    await writeJobMeta(jobDir, { ...meta, milestoneInvoices: legacyMilestoneInvoices });

    const legacyPdfBytes = Buffer.from("%PDF-1.4 legacy invoice bytes fixture");
    const legacyPdfPath = join(jobDir, "milestone-invoices", "EI-LEGACY-01-M1.pdf");
    await mkdir(join(jobDir, "milestone-invoices"), { recursive: true });
    await writeFile(legacyPdfPath, legacyPdfBytes);

    // The customer quote changes after the fact — the frozen record must
    // not be rewritten from it.
    const changed = {
      ...quote,
      version: 2,
      lineItems: [
        ...quote.lineItems,
        { code: "rock", label: "Rock clause", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, unitCost: 70, totalCost: 70, section: "Works", customerVisible: true },
      ],
      presentation: {
        ...quote.presentation,
        scheduleItems: [
          ...quote.presentation.scheduleItems,
          { code: "rock", label: "Rock clause", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, sourceLineItemCodes: ["rock"] },
        ],
      },
    };
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(changed, null, 2));

    const hydrated = await readJobMeta(jobDir);
    const resynced = await updateJobMilestone({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 0,
      patch: { dueDate: "2026-06-01" },
    });

    const legacyResult = resynced.meta.milestoneInvoices[0];
    assert.equal(legacyResult.total, 220);
    assert.deepEqual(legacyResult.lineItems.map((item) => item.totalPrice), [200]);
    assert.ok(legacyResult.issuedRevision, "the legacy record synthesized an issued revision");
    assert.equal(legacyResult.issuedRevision.total, 220);
    assert.equal(legacyResult.issuedRevision.pdfIssuedAt, "2026-05-01T00:00:00.000Z");

    assert.deepEqual(await readFile(legacyPdfPath), legacyPdfBytes);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// reviseJobMilestoneInvoice does not synchronize
// first, so on a never-synchronized legacy invoice the legacy synthesis
// and the authorization happen in the SAME buildMilestoneInvoices call.
// Before the fix, the post-hoc ADOPT_PENDING stamp landed on the freshly
// MINTED revision (which has no prior file) instead of the retired legacy
// copy, so the write path routed the mint through adopt-or-reconstruct and
// fabricated a false "Invoice PDF reconstructed" audit event right beside
// the genuine "Revised invoice issued" one.
test("the first revise of a never-synchronized legacy invoice emits no false reconstruction event", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-legacy-first-revise-"));

  try {
    const meta = {
      id: "job-invoice-legacy-first-revise-1",
      title: "Legacy first revise test",
      label: "Legacy first revise test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-LEGACY-FR-01",
      jobNumber: "JOB-LEGACY-FR-01",
      quoteVersion: 1,
      landedAt: "2026-05-01T00:00:00.000Z",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const quote = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-LEGACY-FR-01" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    // A stored record from before invoice revisions with its real,
    // genuinely-sent PDF on disk.
    const legacyLineItems = [
      { description: "Scope item", quantity: 1, unit: "lot", unitPrice: 200, totalPrice: 200 },
    ];
    const legacyMilestoneInvoices = [{
      milestoneIndex: 0,
      milestoneLabel: "Full payment",
      status: "authorised",
      issuedAt: "2026-05-01T00:00:00.000Z",
      invoiceNumber: "EI-LEGACY-FR-01-M1",
      revisionNumber: 1,
      subtotal: 200,
      gst: 20,
      total: 220,
      currency: "AUD",
      lineItems: legacyLineItems,
      pdfPath: "milestone-invoices/EI-LEGACY-FR-01-M1.pdf",
    }];
    await writeJobMeta(jobDir, { ...meta, milestoneInvoices: legacyMilestoneInvoices });

    const legacyPdfBytes = Buffer.from("%PDF-1.4 legacy invoice bytes fixture");
    const legacyPdfPath = join(jobDir, "milestone-invoices", "EI-LEGACY-FR-01-M1.pdf");
    await mkdir(join(jobDir, "milestone-invoices"), { recursive: true });
    await writeFile(legacyPdfPath, legacyPdfBytes);

    // An approved variation lands as the new current quote — this job was
    // NEVER touched by any revision-tracking action before this revise.
    const variation = {
      ...quote,
      version: 2,
      lineItems: [
        ...quote.lineItems,
        { code: "rock", label: "Rock clause", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, unitCost: 70, totalCost: 70, section: "Works", customerVisible: true },
      ],
      presentation: {
        ...quote.presentation,
        scheduleItems: [
          ...quote.presentation.scheduleItems,
          { code: "rock", label: "Rock clause", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, sourceLineItemCodes: ["rock"] },
        ],
      },
      totals: { subtotal: 300, gst: 30, total: 330, currency: "AUD" },
    };
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(variation, null, 2));

    const hydrated = await readJobMeta(jobDir);
    const revised = await reviseJobMilestoneInvoice({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 0,
      reason: "Approved rock clause variation on the north bench",
      actor: { kind: "user", label: "Alex" },
    });

    assert.equal(revised.revision.revisionNumber, 2);
    assert.equal(revised.revision.total, 330);

    // The original legacy PDF is untouched.
    assert.deepEqual(await readFile(legacyPdfPath), legacyPdfBytes);
    // The retired legacy revision landed in history as ADOPT_PENDING, not
    // UNWRITTEN — still protected by the write path's path-scoped
    // immutability guard.
    const current = revised.meta.milestoneInvoices[0];
    assert.equal(current.revisionHistory.length, 1);
    assert.equal(current.revisionHistory[0].artifactState, ARTIFACT_STATE.ADOPT_PENDING);
    assert.equal(current.revisionHistory[0].pdfPath, "milestone-invoices/EI-LEGACY-FR-01-M1.pdf");

    // No false reconstruction event — only the genuine revision event.
    const { activity } = await readJobState(jobDir);
    assert.ok(
      activity.some((entry) => entry.kind === "invoice.revised"),
      "the genuine revision event was recorded",
    );
    assert.ok(
      !activity.some((entry) => entry.kind === "invoice.artifact_reconstructed"),
      "no false reconstruction event was recorded for the freshly minted revision",
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// The sibling test above proves a GENUINE change
// mints -R2 with no false event. This proves the opposite: a revise of a
// never-synchronized legacy invoice whose reallocated values are IDENTICAL
// to the legacy stored content must 409 like the native-invoice idempotency
// gate does, not silently mint a duplicate-content -R2. Before this fix,
// `currentInvoice.issuedRevision` reading null (the legacy record's raw
// legacy shape) skipped the fingerprint comparison outright.
test("the first revise of a never-synchronized legacy invoice with unchanged values is rejected as a no-op, not minted as a duplicate", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-legacy-noop-revise-"));

  try {
    const meta = {
      id: "job-invoice-legacy-noop-revise-1",
      title: "Legacy no-op revise test",
      label: "Legacy no-op revise test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-LEGACY-NOOP-01",
      jobNumber: "JOB-LEGACY-NOOP-01",
      quoteVersion: 1,
      landedAt: "2026-05-01T00:00:00.000Z",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const quote = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-LEGACY-NOOP-01" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    // A stored record from before invoice revisions whose values already match
    // what a fresh reallocation against the CURRENT (unchanged) quote would
    // produce — including `sourceCode`, since the fingerprint compares it too
    // and a freshly built invoice line item threads it through from the quote's
    // line-item `code`.
    const legacyLineItems = [
      { description: "Scope item", quantity: 1, unit: "lot", unitPrice: 200, totalPrice: 200, sourceCode: "scope" },
    ];
    const legacyMilestoneInvoices = [{
      milestoneIndex: 0,
      milestoneLabel: "Full payment",
      status: "authorised",
      issuedAt: "2026-05-01T00:00:00.000Z",
      invoiceNumber: "EI-LEGACY-NOOP-01-M1",
      revisionNumber: 1,
      subtotal: 200,
      gst: 20,
      total: 220,
      currency: "AUD",
      lineItems: legacyLineItems,
      pdfPath: "milestone-invoices/EI-LEGACY-NOOP-01-M1.pdf",
    }];
    await writeJobMeta(jobDir, { ...meta, milestoneInvoices: legacyMilestoneInvoices });

    const legacyPdfBytes = Buffer.from("%PDF-1.4 legacy invoice bytes fixture");
    const legacyPdfPath = join(jobDir, "milestone-invoices", "EI-LEGACY-NOOP-01-M1.pdf");
    await mkdir(join(jobDir, "milestone-invoices"), { recursive: true });
    await writeFile(legacyPdfPath, legacyPdfBytes);

    // No variation applied — quote.json is exactly what it was when the
    // legacy invoice was issued. A revise request here has nothing to
    // actually revise.
    const hydrated = await readJobMeta(jobDir);
    await assert.rejects(
      () => reviseJobMilestoneInvoice({
        jobDir,
        meta: hydrated,
        config: {},
        milestoneIndex: 0,
        reason: "Requested again with no actual change",
        actor: { kind: "user", label: "Alex" },
      }),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /already reflects the approved values/i);
        return true;
      },
    );

    // Nothing was minted or persisted: still revision 1, no history, and
    // the original legacy PDF is untouched.
    const after = await readJobMeta(jobDir);
    const invoiceAfter = after.milestoneInvoices[0];
    assert.equal(invoiceAfter.revisionNumber, 1);
    assert.equal(invoiceAfter.revisionHistory?.length || 0, 0);
    assert.deepEqual(await readFile(legacyPdfPath), legacyPdfBytes);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// Backward compatibility: a job persisted before `artifactState` existed
// stores issued revisions with `pdfIssuedAt` / `pdfUnrecoverable` and no
// `artifactState` field at all. This is a real stored state.json shape,
// not a hypothetical — it must
// keep resolving correctly with no behaviour change, and a later mutation
// must upgrade it to the new model transparently rather than erroring or
// silently reinterpreting it.
test("a job stored before artifactState (pdfIssuedAt/pdfUnrecoverable, no artifactState) reads, serves and mutates correctly", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-backward-compat-artifact-state-"));

  try {
    const meta = {
      id: "job-backward-compat-1",
      title: "Backward compatibility test",
      label: "Backward compatibility test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-COMPAT-01",
      jobNumber: "JOB-COMPAT-01",
      quoteVersion: 1,
      landedAt: "2026-05-01T00:00:00.000Z",
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 50 },
          { label: "Final", percentage: 50 },
        ],
      },
    };
    const quote = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-COMPAT-01" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    // Milestone 0: successfully issued and stored under the old shape
    // — `pdfIssuedAt` and `pdfSha256`, no `artifactState`. Its PDF is
    // genuinely on disk.
    const storedLineItems = [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 110, totalPrice: 110 }];
    const storedPdfBytes = Buffer.from("%PDF-1.4 pre-round-4 stored bytes");
    const storedPdfRelativePath = "milestone-invoices/EI-COMPAT-01-M1.pdf";
    await mkdir(join(jobDir, "milestone-invoices"), { recursive: true });
    await writeFile(join(jobDir, storedPdfRelativePath), storedPdfBytes);

    // Milestone 1: an opportunistic write that failed under the old model
    // — `pdfUnrecoverable: true`, no `artifactState`, no file on disk.
    const unrecoverableLineItems = [{ description: "Final", quantity: 1, unit: "lot", unitPrice: 110, totalPrice: 110 }];

    const preRound4MilestoneInvoices = [
      {
        milestoneIndex: 0,
        milestoneLabel: "Deposit",
        status: "authorised",
        issuedAt: "2026-05-01T00:00:00.000Z",
        invoiceNumber: "EI-COMPAT-01-M1",
        revisionNumber: 1,
        subtotal: 100,
        gst: 10,
        total: 110,
        currency: "AUD",
        lineItems: storedLineItems,
        pdfPath: storedPdfRelativePath,
        issuedRevision: {
          revisionNumber: 1,
          invoiceNumber: "EI-COMPAT-01-M1",
          issuedAt: "2026-05-01T00:00:00.000Z",
          quoteVersion: 1,
          subtotal: 100,
          gst: 10,
          total: 110,
          currency: "AUD",
          lineItems: storedLineItems,
          pdfPath: storedPdfRelativePath,
          pdfIssuedAt: "2026-05-01T00:05:00.000Z",
          pdfSha256: "precomputed-stored-sha",
        },
      },
      {
        milestoneIndex: 1,
        milestoneLabel: "Final",
        status: "authorised",
        issuedAt: "2026-05-02T00:00:00.000Z",
        invoiceNumber: "EI-COMPAT-01-M2",
        revisionNumber: 1,
        subtotal: 100,
        gst: 10,
        total: 110,
        currency: "AUD",
        lineItems: unrecoverableLineItems,
        pdfPath: "milestone-invoices/EI-COMPAT-01-M2.pdf",
        issuedRevision: {
          revisionNumber: 1,
          invoiceNumber: "EI-COMPAT-01-M2",
          issuedAt: "2026-05-02T00:00:00.000Z",
          // Pinned to a version that will never resolve (not the root
          // version, not archived) — genuinely, not just currently,
          // unrecoverable, so the root-version fallback does not
          // incidentally "fix" it and change what this test is checking.
          quoteVersion: 99,
          subtotal: 100,
          gst: 10,
          total: 110,
          currency: "AUD",
          lineItems: unrecoverableLineItems,
          pdfPath: "milestone-invoices/EI-COMPAT-01-M2.pdf",
          pdfUnrecoverable: true,
        },
      },
    ];
    await writeJobMeta(jobDir, { ...meta, milestoneInvoices: preRound4MilestoneInvoices });

    // 1. Reading the job infers the correct artifactState for both shapes.
    const hydrated = await readJobMeta(jobDir);
    assert.equal(hydrated.milestoneInvoices[0].issuedRevision.artifactState, ARTIFACT_STATE.STORED);
    assert.equal(hydrated.milestoneInvoices[1].issuedRevision.artifactState, ARTIFACT_STATE.MISSING);

    // 2. The read path serves milestone 0's stored bytes and 410s
    // milestone 1, exactly as it would for data stored with `artifactState`.
    const servedStored = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: hydrated.milestoneInvoices[0],
    });
    assert.deepEqual(servedStored.storedArtifact?.pdfBuffer, storedPdfBytes);

    const servedMissing = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: hydrated.milestoneInvoices[1],
    });
    assert.equal(servedMissing.gone, true);
    assert.equal(servedMissing.render, undefined);

    // 3. A real mutation on the STORED milestone succeeds, leaves the
    // stored PDF byte-identical, and does not disturb milestone 1's
    // pre-existing (still old-shape-derived) MISSING state.
    const updated = await updateJobMilestone({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 0,
      patch: { dueDate: "2026-06-01" },
    });
    assert.equal(updated.meta.milestoneInvoices[0].dueDate, "2026-06-01");
    assert.deepEqual(await readFile(join(jobDir, storedPdfRelativePath)), storedPdfBytes);
    assert.equal(updated.meta.milestoneInvoices[1].issuedRevision.artifactState, ARTIFACT_STATE.MISSING);

    // Going forward, the persisted shape is upgraded to carry
    // `artifactState` explicitly (written by the normalization pass this
    // mutation triggered), not left permanently flag-only.
    assert.equal(updated.meta.milestoneInvoices[0].issuedRevision.artifactState, ARTIFACT_STATE.STORED);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a legacy issued invoice with a missing PDF is reconstructed from its pinned quote version, stamped, and audited — not silently re-rendered from the current quote", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-legacy-reconstruct-"));

  try {
    const meta = {
      id: "job-invoice-legacy-reconstruct-1",
      title: "Legacy reconstruction test",
      label: "Legacy reconstruction test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteNumber: "EQ-RECON-01",
      jobNumber: "JOB-RECON-01",
      quoteVersion: 1,
      landedAt: "2026-05-01T00:00:00.000Z",
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const quote = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-RECON-01" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));
    // A real job would have archived v1 into `quote-versions/v001` the
    // moment a v2 draft was created; mirror it here so the pinned-version
    // reconstruction lookup finds it.
    await mkdir(join(jobDir, "quote-versions", "v001"), { recursive: true });
    await writeFile(join(jobDir, "quote-versions", "v001", "quote.json"), JSON.stringify(quote, null, 2));

    // A stored record from before invoice revisions: issued, never froze a
    // snapshot, and its PDF file is missing — deleted, lost, never migrated. No
    // bytes are written to `milestone-invoices/` at all.
    const legacyMilestoneInvoices = [{
      milestoneIndex: 0,
      milestoneLabel: "Full payment",
      status: "authorised",
      issuedAt: "2026-05-01T00:00:00.000Z",
      invoiceNumber: "EI-RECON-01-M1",
      revisionNumber: 1,
      subtotal: 200,
      gst: 20,
      total: 220,
      currency: "AUD",
      lineItems: [{ description: "Scope item", quantity: 1, unit: "lot", unitPrice: 220, totalPrice: 220 }],
      pdfPath: "milestone-invoices/EI-RECON-01-M1.pdf",
    }];
    await writeJobMeta(jobDir, { ...meta, milestoneInvoices: legacyMilestoneInvoices });

    // The current quote changes after the fact — reconstruction must use
    // the pinned v1 quote, never this one.
    const changed = { ...quote, version: 2, summary: "Changed after the fact — must not be used to reconstruct" };
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(changed, null, 2));

    const hydrated = await readJobMeta(jobDir);
    const resynced = await updateJobMilestone({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 0,
      patch: { dueDate: "2026-06-01" },
    });

    const legacyResult = resynced.meta.milestoneInvoices[0];
    assert.ok(legacyResult.issuedRevision, "the legacy record synthesized an issued revision");
    // Reconstruction must stamp `pdfIssuedAt` so the revision reads as
    // genuinely issued on every later read (the read path depends on this
    // being reliable) and record a real sha for the newly
    // written bytes.
    assert.ok(legacyResult.issuedRevision.pdfIssuedAt, "pdfIssuedAt was stamped on reconstruction");
    assert.ok(legacyResult.issuedRevision.pdfSha256, "a sha was recorded for the reconstructed bytes");

    const reconstructedPath = join(jobDir, "milestone-invoices", "EI-RECON-01-M1.pdf");
    assert.ok(existsSync(reconstructedPath), "the reconstructed PDF was written to disk");

    const { activity } = await readJobState(jobDir);
    const reconstructedActivity = activity.find((entry) => entry.kind === "invoice.artifact_reconstructed");
    assert.ok(reconstructedActivity, "an invoice.artifact_reconstructed activity event was recorded");
    assert.match(reconstructedActivity.body, /EI-RECON-01-M1/);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// Two-milestone fixture: milestone 0 is an already-issued invoice pinned to
// quote v1, with no PDF on disk (as if touched once while the quote was still
// at v1, then lost); milestone 1 is a plain open milestone the operator can
// still act on. The CURRENT root quote is v2. A pinned version that IS the
// current root is reconstructable even unarchived, so genuinely exercising
// "unrecoverable" now requires the pinned version to be older than root.
// `pinPdfVersion` controls whether v1 is archived at `quote-versions/v001`
// (reconstructable) or not (genuinely unrecoverable — no archive, and root has
// moved on to v2).
async function seedJobWithBrokenLegacyMilestoneZero(jobDir, { pinPdfVersion = true } = {}) {
  const meta = {
    id: "job-broken-legacy-1",
    title: "Broken legacy artifact test",
    label: "Broken legacy artifact test",
    outputMode: "quote",
    pipelineStage: "landed",
    deliveryStatus: "landed",
    quoteNumber: "EQ-BROKEN-01",
    jobNumber: "JOB-BROKEN-01",
    quoteVersion: 2,
    landedAt: "2026-05-01T00:00:00.000Z",
    paymentSchedule: {
      milestones: [
        { label: "Deposit", percentage: 50 },
        { label: "Final", percentage: 50 },
      ],
    },
  };
  const rootQuote = createQuoteFixture(meta, { version: 2, quoteNumber: "EQ-BROKEN-01" });
  await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  await writeFile(join(jobDir, "quote.json"), JSON.stringify(rootQuote, null, 2));
  if (pinPdfVersion) {
    const pinnedQuote = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-BROKEN-01" });
    await mkdir(join(jobDir, "quote-versions", "v001"), { recursive: true });
    await writeFile(join(jobDir, "quote-versions", "v001", "quote.json"), JSON.stringify(pinnedQuote, null, 2));
  }

  // An already-issued revision whose artifact was never confirmed (not raw
  // legacy shape this time — that path is covered by the legacy reconstruction
  // tests above): pinned to v1, no bytes on disk, ARTIFACT_STATE.ADOPT_PENDING
  // — the state that says "this record's own
  // status/issuedAt already say it was issued to the customer; treat any
  // file at its path as the real document, and reconstruct-or-fail if
  // there is none," without yet having recorded a failed attempt of its
  // own. This lets the isolation test below observe a genuine fresh
  // transition INTO MISSING on its first touch, not an already-MISSING
  // record being re-confirmed.
  const lineItems = [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 110, totalPrice: 110 }];
  const legacyMilestoneInvoices = [{
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    status: "authorised",
    issuedAt: "2026-05-01T00:00:00.000Z",
    invoiceNumber: "EI-BROKEN-01-M1",
    revisionNumber: 1,
    subtotal: 100,
    gst: 10,
    total: 110,
    currency: "AUD",
    lineItems,
    pdfPath: "milestone-invoices/EI-BROKEN-01-M1.pdf",
    issuedRevision: {
      revisionNumber: 1,
      invoiceNumber: "EI-BROKEN-01-M1",
      issuedAt: "2026-05-01T00:00:00.000Z",
      quoteVersion: 1,
      subtotal: 100,
      gst: 10,
      total: 110,
      currency: "AUD",
      lineItems,
      pdfPath: "milestone-invoices/EI-BROKEN-01-M1.pdf",
      artifactState: ARTIFACT_STATE.ADOPT_PENDING,
    },
  }];
  await writeJobMeta(jobDir, { ...meta, milestoneInvoices: legacyMilestoneInvoices });
  return { meta, quote: rootQuote };
}

test("an unrecoverable issued artifact on one milestone does not block a mutation on a different milestone", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-unrecoverable-isolated-"));

  try {
    // No pinned quote version — milestone 0's artifact is unrecoverable.
    await seedJobWithBrokenLegacyMilestoneZero(jobDir, { pinPdfVersion: false });

    const hydrated = await readJobMeta(jobDir);
    // Act on milestone 1 only. The sweep opportunistically tries to write
    // milestone 0's artifact too, fails, and must not take this mutation
    // down with it.
    const resynced = await updateJobMilestone({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 1,
      patch: { dueDate: "2026-06-01" },
    });

    // The requested mutation actually persisted.
    assert.equal(resynced.meta.milestoneInvoices[1].dueDate, "2026-06-01");

    // Milestone 0 is left correctly broken: no pdfIssuedAt (never
    // successfully written), but explicitly marked unrecoverable so the
    // read path still 410s it instead of rendering.
    const milestone0 = resynced.meta.milestoneInvoices[0];
    assert.ok(!milestone0.issuedRevision.pdfIssuedAt, "milestone 0 was never successfully stamped");
    assert.equal(milestone0.issuedRevision.artifactState, ARTIFACT_STATE.MISSING);
    assert.equal(existsSync(join(jobDir, "milestone-invoices", "EI-BROKEN-01-M1.pdf")), false);

    const { activity } = await readJobState(jobDir);
    const unrecoverableActivity = activity.find((entry) => entry.kind === "invoice.artifact_unrecoverable");
    assert.ok(unrecoverableActivity, "an invoice.artifact_unrecoverable activity event was recorded");
    assert.match(unrecoverableActivity.body, /EI-BROKEN-01-M1/);

    // Required test (3): the read path still 410s the unrecoverable invoice
    // rather than rendering a fabricated document under its number.
    const resolved = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir,
      documentType: "invoice",
      milestoneInvoice: milestone0,
    });
    assert.equal(resolved.gone, true);
    assert.equal(resolved.render, undefined);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("an explicit action targeting the unrecoverable invoice itself still fails loudly with a 410", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-unrecoverable-explicit-"));

  try {
    await seedJobWithBrokenLegacyMilestoneZero(jobDir, { pinPdfVersion: false });

    const hydrated = await readJobMeta(jobDir);
    await assert.rejects(
      () => updateJobMilestone({
        jobDir,
        meta: hydrated,
        config: {},
        milestoneIndex: 0,
        patch: { dueDate: "2026-06-01" },
      }),
      (err) => {
        assert.equal(err.statusCode, 410);
        return true;
      },
    );

    // The failed explicit action must not have persisted a partial/degraded
    // state — the previous meta.json is untouched.
    const stillHydrated = await readJobMeta(jobDir);
    assert.equal(stillHydrated.milestoneInvoices[0].dueDate ?? null, null);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("an ordinary reconstruction on an implicit (swept-in) target still succeeds and stamps, unaffected by isolating implicit targets", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-implicit-reconstruct-"));

  try {
    // Pinned quote version IS available — milestone 0's artifact can be
    // reconstructed.
    await seedJobWithBrokenLegacyMilestoneZero(jobDir, { pinPdfVersion: true });

    const hydrated = await readJobMeta(jobDir);
    // Act on milestone 1 only — milestone 0 is purely an implicit
    // (opportunistically swept-in) target for this call.
    const resynced = await updateJobMilestone({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 1,
      patch: { dueDate: "2026-06-01" },
    });

    const milestone0 = resynced.meta.milestoneInvoices[0];
    assert.ok(milestone0.issuedRevision.pdfIssuedAt, "the implicit target's PDF was reconstructed and stamped");
    assert.ok(milestone0.issuedRevision.pdfSha256, "a sha was recorded for the reconstructed bytes");
    assert.equal(milestone0.issuedRevision.artifactState, ARTIFACT_STATE.STORED);
    assert.ok(existsSync(join(jobDir, "milestone-invoices", "EI-BROKEN-01-M1.pdf")));

    const { activity } = await readJobState(jobDir);
    assert.ok(
      activity.some((entry) => entry.kind === "invoice.artifact_reconstructed"),
      "an invoice.artifact_reconstructed activity event was recorded",
    );
    assert.ok(
      !activity.some((entry) => entry.kind === "invoice.artifact_unrecoverable"),
      "no unrecoverable event was recorded for a successful reconstruction",
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// `reviseJobMilestoneInvoice` passes `writeAllArtifacts: true` — that used
// to reclassify EVERY milestone as an explicit (fail-loud)
// target, so revising milestone 0 would 410 over milestone 1's unrelated,
// unrecoverable artifact even though the operator never touched milestone
// 1 at all. Only `artifactMilestoneIndex` (the milestone actually being
// revised) is explicit now; `writeAllArtifacts` entries stay implicit.
test("revising one milestone succeeds while an unrelated milestone's artifact is unrecoverable", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-revise-unrelated-broken-"));

  try {
    const seeded = await seedLandedJobWithSentInvoice(jobDir, { id: "job-invoice-revise-unrelated-1" });

    // Milestone 1 is "issued" out-of-band with an artifact pinned to a
    // quote version that will not resolve: not archived, and root is about
    // to move past it via the approved variation below. `seedLandedJobWithSentInvoice`
    // (via generateJobMilestones' writeAllArtifacts sweep) already wrote a
    // draft-preview PDF at milestone 1's path — remove it so the file is
    // genuinely absent, not merely stray, before marking it broken.
    const hydratedBeforeBreak = await readJobMeta(jobDir);
    await rm(join(jobDir, hydratedBeforeBreak.milestoneInvoices[1].pdfPath), { force: true });
    const brokenMilestoneInvoices = hydratedBeforeBreak.milestoneInvoices.map((invoice) => (
      invoice.milestoneIndex === 1
        ? {
            ...invoice,
            status: "authorised",
            issuedAt: "2026-05-02T00:00:00.000Z",
            issuedRevision: {
              revisionNumber: 1,
              invoiceNumber: invoice.invoiceNumber,
              issuedAt: "2026-05-02T00:00:00.000Z",
              quoteVersion: seeded.quote.version,
              subtotal: invoice.subtotal,
              gst: invoice.gst,
              total: invoice.total,
              currency: invoice.currency,
              lineItems: invoice.lineItems,
              pdfPath: invoice.pdfPath,
              artifactState: ARTIFACT_STATE.ADOPT_PENDING,
            },
          }
        : invoice
    ));
    await writeJobMeta(jobDir, { ...hydratedBeforeBreak, milestoneInvoices: brokenMilestoneInvoices });

    await applyApprovedVariation(jobDir, seeded.quote);
    const hydrated = await readJobMeta(jobDir);

    const revised = await reviseJobMilestoneInvoice({
      jobDir,
      meta: hydrated,
      config: {},
      milestoneIndex: 0,
      reason: "Approved rock clause variation on the north bench",
      expectedRevisionNumber: 1,
      actor: { kind: "user", label: "Alex" },
    });

    // The requested revision on milestone 0 actually happened. Milestone 1
    // is genuinely issued (frozen at its original $110 claim) even though
    // its artifact is broken, so the full remainder of the $330 variation
    // total (330 - 110 frozen = 220) lands on milestone 0, the only other
    // milestone and the one being revised.
    assert.equal(revised.revision.revisionNumber, 2);
    assert.equal(revised.revision.total, 220);

    // Milestone 1 stayed correctly broken instead of aborting the call.
    const milestone1 = revised.meta.milestoneInvoices[1];
    assert.equal(milestone1.issuedRevision.artifactState, ARTIFACT_STATE.MISSING);
    assert.equal(existsSync(join(jobDir, milestone1.pdfPath)), false);

    const { activity } = await readJobState(jobDir);
    const unrecoverableActivity = activity.find((entry) => entry.kind === "invoice.artifact_unrecoverable");
    assert.ok(unrecoverableActivity, "milestone 1's degradation was recorded");
    assert.match(unrecoverableActivity.body, new RegExp(milestone1.invoiceNumber));
    assert.ok(
      activity.some((entry) => entry.kind === "invoice.revised"),
      "milestone 0's revision was recorded",
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("unsending an issued invoice leaves the previously stored PDF byte-identical", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-unsend-artifact-"));

  try {
    const meta = {
      id: "job-invoice-unsend-artifact-1",
      title: "Unsend artifact test",
      label: "Unsend artifact test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteVersion: 1,
      quoteNumber: "EQ-UNSEND-ARTIFACT",
      jobNumber: "JOB-UNSEND-ARTIFACT",
    };
    const quote = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-UNSEND-ARTIFACT" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: { milestones: [{ label: "Full payment", percentage: 100 }] },
    });
    const authorised = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
      actor: { kind: "user", label: "Alex" },
    });
    const issuedInvoice = authorised.meta.milestoneInvoices[0];
    assert.ok(issuedInvoice.issuedRevision?.pdfIssuedAt);
    const pdfPath = join(jobDir, issuedInvoice.issuedRevision.pdfPath);
    assert.ok(existsSync(pdfPath));
    const issuedBytes = await readFile(pdfPath);

    const unsent = await markJobMilestoneUnsent({
      jobDir,
      meta: authorised.meta,
      config: {},
      milestoneIndex: 0,
    });
    const draftInvoice = unsent.meta.milestoneInvoices[0];
    assert.equal(draftInvoice.status, "draft");
    assert.equal(draftInvoice.issuedRevision, null);
    // The issued number belongs to the issued document: the draft is back
    // under its provisional number, and the retired revision keeps its own.
    assert.match(issuedInvoice.invoiceNumber, SEQUENCE_NUMBER);
    assert.equal(draftInvoice.invoiceNumber, "EI-UNSEND-ARTIFACT-M1");
    assert.equal(draftInvoice.revisionHistory[0].invoiceNumber, issuedInvoice.invoiceNumber);
    assert.equal(join(jobDir, draftInvoice.revisionHistory[0].pdfPath), pdfPath);

    assert.deepEqual(await readFile(pdfPath), issuedBytes);

    // Issuing the same content again restores that invoice, under its
    // number and with its bytes, rather than issuing another.
    const reissued = await updateJobMilestone({
      jobDir,
      meta: unsent.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
    });
    assert.equal(reissued.meta.milestoneInvoices[0].invoiceNumber, issuedInvoice.invoiceNumber);
    assert.equal(reissued.meta.milestoneInvoices[0].issuedRevision.pdfSha256, issuedInvoice.issuedRevision.pdfSha256);
    assert.deepEqual(await readFile(pdfPath), issuedBytes);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a reissue after unsend with changed content records an actor and a reason", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-invoice-reissue-attribution-"));

  try {
    const meta = {
      id: "job-invoice-reissue-1",
      title: "Reissue attribution test",
      label: "Reissue attribution test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteVersion: 1,
      quoteNumber: "EQ-REISSUE-01",
      jobNumber: "JOB-REISSUE-01",
    };
    const quote = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-REISSUE-01" });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));

    const generated = await generateJobMilestones({
      jobDir,
      meta,
      config: {},
      paymentSchedule: { milestones: [{ label: "Full payment", percentage: 100 }] },
    });
    const authorised = await updateJobMilestone({
      jobDir,
      meta: generated.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
      actor: { kind: "user", label: "Alex" },
    });
    assert.equal(authorised.meta.milestoneInvoices[0].revisionNumber, 1);

    const unsent = await markJobMilestoneUnsent({
      jobDir,
      meta: authorised.meta,
      config: {},
      milestoneIndex: 0,
    });

    await applyApprovedVariation(jobDir, quote);

    const reissued = await updateJobMilestone({
      jobDir,
      meta: unsent.meta,
      config: {},
      milestoneIndex: 0,
      patch: { status: "authorised" },
      actor: { kind: "user", label: "Sam" },
    });

    const revised = reissued.meta.milestoneInvoices[0];
    assert.equal(revised.revisionNumber, 2);
    assert.equal(revised.issuedRevision.revisedBy, "Sam");
    assert.equal(revised.issuedRevision.revisionReason, "Reissued after the invoice was returned to draft");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// Every send records exactly what the customer was sent. These fail if
// a quote or invoice send writes no quote_snapshots row.
async function writeLandedJobForSnapshots(jobDir, id) {
  const meta = {
    id,
    title: "Snapshot test",
    label: "Snapshot test",
    outputMode: "quote",
    pipelineStage: "landed",
    deliveryStatus: "landed",
    quoteSentAt: "2026-03-26T01:00:00.000Z",
    landedAt: "2026-03-27T01:00:00.000Z",
    quoteVersion: 2,
    quoteNumber: `EQ-${id}`,
    jobNumber: `JOB-${id}`,
    paymentSchedule: { milestones: [{ label: "Full payment", percentage: 100 }] },
    milestoneInvoices: [],
  };
  const draft = {
    ...buildSendableQuoteFixture(meta, { version: 2, deliveryStatus: "draft" }),
    totals: { subtotal: 300, gst: 30, total: 330, currency: "AUD" },
    lineItems: [{
      code: "drainage",
      label: "Drainage installation",
      quantity: 1,
      unit: "lot",
      unitPrice: 300,
      totalPrice: 300,
      unitCost: 210,
      totalCost: 210,
      section: "Works",
      customerVisible: true,
    }],
    presentation: {
      scopeText: "Drainage.",
      scheduleItems: [{
        code: "drainage",
        label: "Drainage installation",
        quantity: 1,
        unit: "lot",
        unitPrice: 300,
        totalPrice: 300,
        sourceLineItemCodes: ["drainage"],
      }],
    },
  };
  await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  await writeFile(join(jobDir, "quote.json"), JSON.stringify(draft, null, 2));
  await writeQuoteVersionSnapshot(jobDir, {
    ...buildSendableQuoteFixture(meta, { version: 1, deliveryStatus: "final" }),
    delivery: { status: "final", finalizedAt: "2026-03-26T01:00:00.000Z" },
  });
  await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
    version: 1,
    currentQuoteVersion: 2,
    currentPipelineStage: "landed",
    currentLockStatus: "draft",
    sendCount: 1,
    lastSentAt: "2026-03-26T01:00:00.000Z",
    lastSentQuoteVersion: 1,
    lastSentTo: "client@example.com",
    landedAt: "2026-03-27T01:00:00.000Z",
  }, null, 2));
  return meta;
}

test("every quote and invoice send writes a quote snapshot of what was sent", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-snapshots-"));
  const snapshots = createQuoteSnapshotStore({ db: TEST_PRICE_CATALOG.db });
  const config = { quoteSnapshots: snapshots, priceCatalog: TEST_PRICE_CATALOG_DB };
  try {
    const meta = await writeLandedJobForSnapshots(jobDir, "job-snapshot-send-1");
    const quoteResult = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config,
      user: { id: "user-1", email: "estimator@example.invalid", name: "Estimator" },
      to: "customer@example.invalid",
      cc: ["office@example.invalid"],
      documentType: "quote",
      sendEmail: async () => ({ id: "msg-quote", threadId: "thread-quote", subject: "Quote", to: "customer@example.invalid" }),
    });
    const invoiceResult = await sendJobQuote({
      jobDir,
      meta: quoteResult.meta,
      dataDir: jobDir,
      config,
      to: "customer@example.invalid",
      documentType: "invoice",
      sendEmail: async () => ({ id: "msg-invoice", threadId: "thread-invoice", subject: "Invoice", to: "customer@example.invalid" }),
    });

    const rows = await snapshots.listForJob(meta.id);
    assert.equal(rows.length, 2, "one snapshot per send");
    const [quoteRow, invoiceRow] = rows;
    assert.equal(quoteRow.documentType, "quote");
    assert.equal(quoteRow.status, "sent");
    assert.equal(quoteRow.messageId, "msg-quote");
    assert.equal(quoteRow.issuanceId, quoteResult.issuance.issuanceId);
    assert.equal(quoteRow.quoteVersion, 2);
    assert.equal(quoteRow.total, 330);
    assert.equal(quoteRow.subtotal, 300);
    assert.equal(quoteRow.tax, 30);
    assert.deepEqual(quoteRow.recipients, { to: ["customer@example.invalid"], cc: ["office@example.invalid"], bcc: [] });
    assert.deepEqual(quoteRow.sentBy, { id: "user-1", email: "estimator@example.invalid", name: "Estimator" });
    assert.equal(quoteRow.lines.length, 1);
    assert.equal(quoteRow.lines[0].label, "Drainage installation");
    assert.equal(quoteRow.lines[0].totalPrice, 300);
    assert.equal(quoteRow.lines[0].lineItems[0].code, "drainage");
    assert.ok(quoteRow.lines[0].lineItems[0].catalog, "engine lines carry their catalogue reference");
    const ledger = await readQuoteIssuanceLedger(jobDir);
    const quoteIssuance = ledger.records.find((record) => record.issuanceId === quoteRow.issuanceId);
    assert.equal(quoteRow.pdfSha256, quoteIssuance.artifacts.quotePdf.sha256, "the snapshot names the exact PDF sent");

    assert.equal(invoiceRow.documentType, "invoice");
    assert.equal(invoiceRow.status, "sent");
    assert.equal(invoiceRow.messageId, "msg-invoice");
    assert.equal(invoiceRow.issuanceId, invoiceResult.issuance.issuanceId);
    assert.equal(invoiceRow.documentNumber, invoiceResult.milestoneInvoice.invoiceNumber);
    assert.equal(invoiceRow.total, 330);
    assert.ok(invoiceRow.lines.length > 0, "the invoice's own lines");
    assert.equal(invoiceRow.pricing.quote.lines[0].label, "Drainage installation", "and the quote lines behind it");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a send whose snapshot cannot be recorded sends nothing, and the retry records one", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-snapshots-fail-"));
  const working = createQuoteSnapshotStore({ db: TEST_PRICE_CATALOG.db });
  let sends = 0;
  const sendEmail = async () => {
    sends += 1;
    return { id: `msg-${sends}`, threadId: "thread", subject: "Quote", to: "customer@example.invalid" };
  };
  try {
    const meta = await writeLandedJobForSnapshots(jobDir, "job-snapshot-fail-1");
    await assert.rejects(
      sendJobQuote({
        jobDir,
        meta,
        dataDir: jobDir,
        config: {
          quoteSnapshots: {
            recordPrepared: async () => { throw new Error("database unreachable"); },
            recordSent: async () => { throw new Error("database unreachable"); },
          },
        },
        to: "customer@example.invalid",
        documentType: "quote",
        sendEmail,
      }),
      (error) => error.code === "QUOTE_SNAPSHOT_FAILED" && /nothing was sent/.test(error.message),
    );
    assert.equal(sends, 0, "no email without a snapshot");
    assert.equal((await readPendingQuoteDelivery(jobDir)).status, "failed", "the undispatched attempt is retired");

    await sendJobQuote({ jobDir, meta, dataDir: jobDir, config: { quoteSnapshots: working }, to: "customer@example.invalid", documentType: "quote", sendEmail });
    assert.equal(sends, 1);
    const rows = await working.listForJob(meta.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "sent");
    assert.equal(rows[0].messageId, "msg-1");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("catalogue changes: a sent quote is never changed, a draft organizer gets the diff applied unsaved", async (t) => {
  const catalog = await createTestPriceCatalog({ priceMaps: null, items: [
    { code: "TURF", name: "Turf", unit: "m2", buy_price: 9.05, sell_price: 14, catalog_type: "goods_service" },
  ], track: false });
  t.after(() => catalog.close());
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-catalog-sync-"));
  t.after(() => rm(jobDir, { recursive: true, force: true }));
  const config = { priceCatalog: catalog.store };
  const turf = await catalog.store.getCurrentPrice("TURF");
  const organizer = {
    root: ["manual:turf"],
    nodes: {
      "manual:turf": {
        kind: "source",
        origin: "manual",
        sourceCode: "manual-turf",
        labelOverride: "Turf",
        quantity: 40,
        unit: "m2",
        sellRate: 14,
        buyRate: 9.05,
        rateMode: "catalog-linked",
        catalogItemCode: "TURF",
        catalogItemUid: turf.itemUid,
        catalogPriceId: turf.priceId,
        catalogPriceKey: turf.priceKey,
        catalogSellRate: 14,
        catalogBuyRate: 9.05,
        catalogName: "Turf",
        catalogUnit: "m2",
      },
    },
  };
  const meta = await writeLandedJobForSnapshots(jobDir, "job-catalog-sync-1");
  // Version 2 is the latest and was sent: it is locked.
  await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({
    version: 1,
    currentQuoteVersion: 2,
    currentPipelineStage: "sent",
    sendCount: 2,
    lastSentQuoteVersion: 2,
  }, null, 2));
  await writeFile(join(jobDir, "quote-overrides.json"), JSON.stringify({ presentation: { organizer } }, null, 2));
  const sentMeta = { ...meta, pipelineStage: "sent", deliveryStatus: "sent" };

  await catalog.store.updateItem("TURF", { sell_price: 45 }, { author: "Estimator" });
  const changes = await readJobQuoteCatalogChanges({ jobDir, meta: sentMeta, config });
  assert.equal(changes.locked, true);
  assert.equal(changes.changedCount, 1);
  const quoteBefore = await readFile(join(jobDir, "quote.json"), "utf8");
  await assert.rejects(
    applyJobQuoteCatalogChanges({ jobDir, meta: sentMeta, config }),
    (error) => error.code === "QUOTE_LOCKED" && error.statusCode === 409,
  );
  assert.equal(await readFile(join(jobDir, "quote.json"), "utf8"), quoteBefore, "the sent quote is untouched");

  await assert.rejects(
    applyJobQuoteCatalogChanges({ jobDir, meta: sentMeta, config, organizer, expectedCatalogVersion: changes.catalogVersion - 1 }),
    (error) => error.code === "CATALOG_CHANGED",
  );
  const applied = await applyJobQuoteCatalogChanges({
    jobDir,
    meta: sentMeta,
    config,
    organizer,
    expectedCatalogVersion: changes.catalogVersion,
  });
  assert.equal(applied.saved, false, "an editor draft is returned, not saved");
  assert.deepEqual(applied.applied, ["manual:turf"]);
  assert.equal(applied.organizer.nodes["manual:turf"].sellRate, 45);
  assert.equal(applied.changes.changedCount, 0);
  assert.equal(await readFile(join(jobDir, "quote.json"), "utf8"), quoteBefore);

  // defaultOnly takes just the rows the banner ticks: never a negotiated rate.
  const negotiated = structuredClone(organizer);
  Object.assign(negotiated.nodes["manual:turf"], { rateMode: "manual", sellRate: 12 });
  const byDefault = await applyJobQuoteCatalogChanges({ jobDir, meta: sentMeta, config, organizer: negotiated, defaultOnly: true });
  assert.deepEqual(byDefault.applied, []);
  assert.equal(byDefault.organizer.nodes["manual:turf"].sellRate, 12);
  // An API caller with no review data never replaces the negotiated rate...
  const everything = await applyJobQuoteCatalogChanges({ jobDir, meta: sentMeta, config, organizer: negotiated });
  assert.deepEqual(everything.applied, []);
  assert.deepEqual(everything.skipped.map((entry) => entry.status), ["overridden"]);
  assert.equal(everything.organizer.nodes["manual:turf"].sellRate, 12);
  // ...nor does a review of the row before it was negotiated...
  const stale = await applyJobQuoteCatalogChanges({
    jobDir,
    meta: sentMeta,
    config,
    organizer: negotiated,
    nodeIds: ["manual:turf"],
    reviewed: { "manual:turf": changes.lines[0].reviewKey },
  });
  assert.deepEqual(stale.skipped.map((entry) => entry.status), ["changed_since_review"]);
  assert.equal(stale.organizer.nodes["manual:turf"].sellRate, 12);
  // ...unless it asks to replace edits.
  const forced = await applyJobQuoteCatalogChanges({ jobDir, meta: sentMeta, config, organizer: negotiated, replaceEdits: true });
  assert.deepEqual(forced.applied, ["manual:turf"]);
  assert.equal(forced.organizer.nodes["manual:turf"].sellRate, 45);
});

// A quote built only from catalogue rows (manual organizer rows with a
// catalogue link, no compiled line items) passes the send gate, and its send
// snapshot names the row's catalogue item and price.
test("a quote made only of catalogue-linked rows can be sent, and its snapshot names the row's item and price", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-catalogue-only-"));
  const snapshots = createQuoteSnapshotStore({ db: TEST_PRICE_CATALOG.db });
  try {
    const meta = {
      id: "job-catalogue-only-1",
      title: "Catalogue-only quote",
      label: "Catalogue-only quote",
      outputMode: "quote",
      pipelineStage: "draft",
      deliveryStatus: "draft",
      quoteVersion: 1,
      quoteNumber: "EQ-CAT-01",
      jobNumber: "JOB-CAT-01",
    };
    const base = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-CAT-01", jobNumber: "JOB-CAT-01", lineItems: [] });
    const unattested = {
      ...base,
      delivery: { status: "draft" },
      presentation: {
        scopeText: "Gravel base.",
        organizer: {
          root: ["manual:gravel"],
          nodes: {
            "manual:gravel": {
              kind: "source",
              sourceKind: "manual",
              origin: "manual",
              pricingMode: "manual",
              sourceCode: "manual-catalog-gravel-1",
              labelOverride: "20mm gravel",
              quantity: 8,
              unit: "tonne",
              sellRate: 110,
              buyRate: 83,
              rateMode: "catalog-linked",
              catalogItemCode: "GRAVEL-20MM",
              catalogItemUid: "itm_gravel",
              catalogPriceId: 41,
              catalogPriceKey: "pk_gravel",
              catalogSellRate: 110,
              catalogBuyRate: 83,
              catalogName: "20mm gravel",
              catalogUnit: "tonne",
            },
          },
        },
      },
      totals: { subtotal: 880, gst: 88, total: 968, currency: "AUD" },
    };
    delete unattested.pricing;
    const quote = attachQuotePricingAttestation({
      quote: unattested,
      attestation: buildQuotePricingAttestation({
        requestNonce: "req-catalogue-only",
        authorityStatus: { provider: "price_catalog", catalogRevision: "rev-1", snapshotDigest: "digest-1" },
        livePricingAvailable: true,
      }),
    });
    assert.deepEqual(validateQuoteCommercialArtifact(quote), [], "a catalogue row is its own lineage");
    assert.equal(quote.pricing.sendable, true);

    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2));
    const result = await sendJobQuote({
      jobDir,
      meta,
      dataDir: jobDir,
      config: { quoteSnapshots: snapshots, priceCatalog: TEST_PRICE_CATALOG_DB },
      to: "customer@example.invalid",
      documentType: "quote",
      sendEmail: async () => ({ id: "msg-cat", threadId: "thread-cat", subject: "Quote", to: "customer@example.invalid" }),
    });
    assert.equal(result.meta.pipelineStage, "sent");

    const [row] = await snapshots.listForJob(meta.id);
    assert.equal(row.status, "sent");
    assert.equal(row.total, 968);
    const gravel = row.lines.find((line) => line.nodeId === "manual:gravel");
    assert.equal(gravel.totalPrice, 880);
    assert.equal(gravel.catalog.itemUid, "itm_gravel");
    assert.equal(gravel.catalog.priceId, 41);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a schedule row with no lineage and no manual row behind it is still refused", () => {
  const quote = {
    lineItems: [],
    presentation: {
      scheduleItems: [{ code: "mystery", label: "Unexplained", quantity: 1, unit: "lot", unitPrice: 500, totalPrice: 500, sourceLineItemCodes: ["mystery"] }],
    },
  };
  assert.deepEqual(validateQuoteCommercialArtifact(quote).map((issue) => issue.code), ["incomplete-commercial-lineage"]);
});

// A quote saved before catalogue-linked rows could be sent carries the "not
// sendable" verdict worked out then. Reading it re-runs the commercial checks,
// so it can be sent without an edit; a quote that still fails them stays
// refused, in plain words.
test("a catalogue-row quote saved before catalogue rows were sendable can be sent without editing it", () => {
  const meta = { id: "job-stale-verdict", quoteVersion: 1, quoteNumber: "EQ-ST-01", jobNumber: "JOB-ST-01" };
  const base = createQuoteFixture(meta, { version: 1, quoteNumber: "EQ-ST-01", jobNumber: "JOB-ST-01", lineItems: [] });
  const unattested = {
    ...base,
    presentation: {
      organizer: {
        root: ["manual:gravel"],
        nodes: {
          "manual:gravel": {
            kind: "source", sourceKind: "manual", origin: "manual", pricingMode: "manual",
            sourceCode: "manual-catalog-gravel-1", labelOverride: "20mm gravel",
            quantity: 8, unit: "tonne", sellRate: 110, buyRate: 83,
          },
        },
      },
    },
    totals: { subtotal: 880, gst: 88, total: 968, currency: "AUD" },
  };
  delete unattested.pricing;
  const fresh = attachQuotePricingAttestation({
    quote: unattested,
    attestation: buildQuotePricingAttestation({
      requestNonce: "req-stale",
      authorityStatus: { provider: "price_catalog", catalogRevision: "rev-1", snapshotDigest: "digest-1" },
      livePricingAvailable: true,
    }),
  });
  const stale = {
    ...fresh,
    pricing: { ...fresh.pricing, sendable: false, ready: false, blockingReason: "Resolve commercial pricing issues before sending this quote." },
  };
  assert.equal(isQuotePricingSendable(stale), true);
  assert.equal(withCurrentPricingVerdict(stale).pricing.sendable, true);
  assert.equal(withCurrentPricingVerdict(stale).pricing.blockingReason, null);

  const emptied = {
    ...stale,
    presentation: { organizer: { root: [], nodes: {} } },
    totals: { subtotal: 0, gst: 0, total: 0, currency: "AUD" },
  };
  assert.equal(isQuotePricingSendable(emptied), false);
  assert.throws(() => assertQuotePricingDisplayable(emptied, "previewed", { current: true }), /Add at least one priced item/);
});
