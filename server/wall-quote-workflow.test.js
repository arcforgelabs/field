import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWallQuoteMeta } from "./wall-quote-workflow.js";
import { sendJobQuote } from "./job-actions.js";
import { buildQuotePricingAttestation } from "./quote-pricing-attestation.js";

function wallQuoteFixture({ version, quoteNumber, jobNumber }) {
  return {
    kind: "quote",
    version,
    status: "ready",
    generatedAt: "2026-03-27T00:00:00.000Z",
    updatedAt: "2026-03-27T00:00:00.000Z",
    quoteNumber,
    jobNumber,
    title: "Retaining wall test",
    recordingIntent: "job-scope",
    summary: "Retaining wall build",
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
    lineItems: [
      {
        code: "wall",
        label: "Retaining wall",
        quantity: 1,
        unit: "lot",
        unitPrice: 500,
        totalPrice: 500,
        unitCost: 350,
        totalCost: 350,
        section: "Works",
        customerVisible: true,
      },
    ],
    presentation: {
      scopeText: "Retaining wall build",
      scheduleItems: [
        {
          code: "wall",
          label: "Retaining wall",
          quantity: 1,
          unit: "lot",
          unitPrice: 500,
          totalPrice: 500,
          sourceLineItemCodes: ["wall"],
        },
      ],
    },
    totals: {
      subtotal: 500,
      gst: 50,
      total: 550,
      currency: "AUD",
    },
    review: { status: "ready" },
    pricing: {
      authorityProvider: "price_catalog",
      ready: true,
      displayable: true,
      sendable: true,
      blockingReason: null,
      attestation: buildQuotePricingAttestation({
        requestNonce: "wall-fixture-pricing-nonce",
        authorityStatus: { provider: "price_catalog", mode: "active" },
        livePricingAvailable: true,
        createdAt: "2026-03-27T00:00:00.000Z",
      }),
    },
    missingInputs: [],
  };
}

// POST /api/jobs/:id/wall-build (server/index.js) is a
// hand-rolled sibling of buildAndPersistQuote's rebuild pipeline and had
// the identical bug — delivery state keyed on "did THIS call fork" instead
// of "is this job already past draft". Traced failure: a landed
// retaining-wall job at v1 = lastSent gets its quote revised (forks to v2,
// landed correctly preserved), then wall-build runs again — the fork
// decision for THAT call is "no" (v2 is already past the last-sent
// version), which pre-fix was misread as "never sent" and reset the job to
// draft, nulling landedAt and silently blocking invoice sends
// (job-actions.js:1190 gates payment-document sends on pipelineStage ===
// "landed").
test("buildWallQuoteMeta preserves landed delivery state on an already-forked rebuild, and the resulting meta still passes sendJobQuote's landed gate", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-wall-quote-workflow-landed-"));

  try {
    const landedAt = "2026-03-28T00:00:00.000Z";
    const quoteSentAt = "2026-03-27T00:00:00.000Z";

    // jobMeta reflects state AFTER the job was already forked to v2 by an
    // earlier "revise the landed quote" call — mirroring what
    // ensureEditableQuoteVersionForContextMutation's force-fork leaves
    // behind for the audio path, and what an equivalent wall-quote revise
    // would leave behind here. shouldForkQuoteMutation would say "no fork
    // needed" for a second wall-build call against this exact meta, since
    // quoteVersion (2) is already past the last-sent version (1) — that's
    // the non-forking rebuild this test exercises.
    const jobMeta = {
      id: "wall-job-landed-preserve",
      title: "Wall Landed Preservation Test",
      label: "Wall Landed Preservation Test",
      outputMode: "quote",
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteSentAt,
      landedAt,
      quoteVersion: 2,
      quoteNumber: "EQ-WALL-01",
      jobNumber: "JOB-WALL-01",
      invoiceSentAt: null,
      invoicePaidAmount: 0,
      paymentSchedule: {
        milestones: [{ label: "Full payment", percentage: 100 }],
      },
    };
    const metaWithQuoteIdentity = {
      ...jobMeta,
      quoteIdentity: { quoteNumber: "EQ-WALL-01", jobNumber: "JOB-WALL-01" },
    };
    const quoteFromModel = wallQuoteFixture({
      version: 2,
      quoteNumber: "EQ-WALL-01",
      jobNumber: "JOB-WALL-01",
    });

    const nextMeta = buildWallQuoteMeta({
      metaWithQuoteIdentity,
      quoteFromModel,
      jobMeta,
    });

    assert.equal(nextMeta.quoteVersion, 2);
    assert.equal(nextMeta.pipelineStage, "landed", "wall-build must not reset a landed job to draft");
    assert.equal(nextMeta.deliveryStatus, "landed");
    assert.equal(nextMeta.landedAt, landedAt, "landedAt must survive the rebuild");
    assert.equal(nextMeta.quoteSentAt, quoteSentAt);

    // Prove the fix closes the actual traced failure, not just that the
    // field looks right in isolation: hand nextMeta to the real invoice-send
    // gate and confirm it now succeeds where it silently failed pre-fix.
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(nextMeta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(quoteFromModel, null, 2));

    const sent = await sendJobQuote({
      jobDir,
      meta: nextMeta,
      dataDir: jobDir,
      config: {},
      to: "customer@example.com",
      documentType: "invoice",
      invoicePaidAmount: 80,
      sendEmail: async () => ({
        id: "msg-1",
        threadId: "thread-1",
        subject: "Invoice — Wall Landed Preservation Test",
        to: "customer@example.com",
      }),
    });

    assert.equal(sent.meta.pipelineStage, "landed");
    assert.equal(sent.meta.invoicePaidAmount, 80);
    assert.ok(sent.meta.invoiceSentAt);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("buildWallQuoteMeta preserves invoiceSentAt and invoicePaidAmount across a non-forking rebuild", async () => {
  const jobMeta = {
    id: "wall-job-invoice-progress",
    pipelineStage: "landed",
    deliveryStatus: "landed",
    quoteSentAt: "2026-03-27T00:00:00.000Z",
    landedAt: "2026-03-28T00:00:00.000Z",
    quoteVersion: 2,
    invoiceSentAt: "2026-03-29T00:00:00.000Z",
    invoicePaidAmount: 150,
  };
  const metaWithQuoteIdentity = { ...jobMeta, quoteIdentity: {} };
  const quoteFromModel = wallQuoteFixture({ version: 2, quoteNumber: "EQ-WALL-02", jobNumber: "JOB-WALL-02" });

  const nextMeta = buildWallQuoteMeta({ metaWithQuoteIdentity, quoteFromModel, jobMeta });

  assert.equal(nextMeta.invoiceSentAt, "2026-03-29T00:00:00.000Z");
  assert.equal(nextMeta.invoicePaidAmount, 150);
});

test("buildWallQuoteMeta still lands a genuinely draft wall job's rebuild on draft", async () => {
  const jobMeta = {
    id: "wall-job-draft-stays-draft",
    pipelineStage: "draft",
    quoteVersion: 1,
  };
  const metaWithQuoteIdentity = { ...jobMeta, quoteIdentity: {} };
  const quoteFromModel = wallQuoteFixture({ version: 1, quoteNumber: "EQ-WALL-03", jobNumber: "JOB-WALL-03" });

  const nextMeta = buildWallQuoteMeta({ metaWithQuoteIdentity, quoteFromModel, jobMeta });

  assert.equal(nextMeta.pipelineStage, "draft");
  assert.equal(nextMeta.deliveryStatus, "draft");
  assert.equal(nextMeta.quoteSentAt, null);
  assert.equal(nextMeta.landedAt, null);
  assert.equal(nextMeta.lostAt, null);
  assert.equal(nextMeta.invoiceSentAt, null);
  assert.equal(nextMeta.invoicePaidAmount, 0);
});
