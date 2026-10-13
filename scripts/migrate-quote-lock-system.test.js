import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateQuoteLockSystem } from "./migrate-quote-lock-system.js";

function buildLegacyQuoteFixture(meta, {
  version = 1,
  deliveryStatus = "draft",
  finalizedAt = null,
  amount = 100,
} = {}) {
  const gst = Math.round(amount * 0.1 * 100) / 100;
  const total = Math.round((amount + gst) * 100) / 100;

  return {
    kind: "quote",
    version,
    status: "ready",
    generatedAt: `2026-04-0${Math.min(version, 9)}T00:00:00.000Z`,
    updatedAt: `2026-04-0${Math.min(version, 9)}T00:00:00.000Z`,
    jobId: meta.id,
    quoteNumber: meta.quoteNumber,
    jobNumber: meta.jobNumber,
    title: meta.title || meta.label || "Legacy migration test quote",
    recordingIntent: "job-scope",
    summary: "Install drainage and retaining works.",
    quoteCatalog: {
      id: "default",
      name: "Sample Catalogue",
      currency: "AUD",
      gstRate: 0.1,
    },
    lineItems: [
      {
        code: `item-${version}`,
        label: `Legacy item ${version}`,
        quantity: 1,
        unit: "lot",
        unitPrice: amount,
        totalPrice: amount,
        section: "Works",
        customerVisible: true,
      },
    ],
    presentation: {
      scopeText: "Install drainage and retaining works.",
      scheduleItems: [
        {
          code: `item-${version}`,
          label: `Legacy item ${version}`,
          quantity: 1,
          unit: "lot",
          unitPrice: amount,
          totalPrice: amount,
          sourceLineItemCodes: [`item-${version}`],
        },
      ],
    },
    totals: {
      subtotal: amount,
      gst,
      total,
      currency: "AUD",
    },
    review: {
      status: "ready",
      reasons: [],
    },
    delivery: {
      status: deliveryStatus,
      finalizedAt,
    },
    assumptions: [],
    assumptionInputs: [],
    missingInputs: [],
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

test("quote lock migration finalizes legacy sent quotes and backfills lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-migrate-quote-lock-final-"));
  const jobDir = join(root, "job-final-1");

  try {
    const meta = {
      id: "job-final-1",
      title: "Legacy sent quote",
      label: "Legacy sent quote",
      outputMode: "quote",
      pipelineStage: "sent",
      quoteVersion: 1,
      quoteSentAt: "2026-04-05T01:00:00.000Z",
      quoteNumber: "EQ-LEGACY-001",
      jobNumber: "JOB-LEGACY-001",
    };
    const quote = buildLegacyQuoteFixture(meta, {
      version: 1,
      deliveryStatus: "draft",
      amount: 125,
    });

    await mkdir(jobDir, { recursive: true });
    await writeJson(join(jobDir, "meta.json"), meta);
    await writeJson(join(jobDir, "quote.json"), quote);

    const stats = await migrateQuoteLockSystem(root);

    const savedMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    const savedQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    const savedOverrides = JSON.parse(await readFile(join(jobDir, "quote-overrides.json"), "utf8"));
    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));

    assert.equal(stats.jobsWithQuotes, 1);
    assert.equal(stats.migratedJobs, 1);
    assert.equal(savedMeta.pipelineStage, "sent");
    assert.equal(savedMeta.quoteVersion, 1);
    assert.equal(savedQuote.delivery.status, "final");
    assert.equal(savedQuote.delivery.finalizedAt, meta.quoteSentAt);
    assert.equal(savedOverrides.lockStatus, "final");
    assert.equal(savedOverrides.finalizedAt, meta.quoteSentAt);
    assert.equal(lifecycle.lastSentQuoteVersion, 1);
    assert.equal(lifecycle.currentLockStatus, "final");
    assert.equal(lifecycle.currentPipelineStage, "sent");
    assert.ok(savedQuote.identity?.quoteRevisionUid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quote lock migration infers the prior sent boundary when a legacy draft revision already exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-migrate-quote-lock-draft-"));
  const jobDir = join(root, "job-draft-1");
  const versionDir = join(jobDir, "quote-versions", "v001");

  try {
    const meta = {
      id: "job-draft-1",
      title: "Legacy sent then revised quote",
      label: "Legacy sent then revised quote",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 2,
      quoteSentAt: "2026-04-05T01:00:00.000Z",
      quoteNumber: "EQ-LEGACY-002",
      jobNumber: "JOB-LEGACY-002",
    };
    const historicalQuote = buildLegacyQuoteFixture(meta, {
      version: 1,
      deliveryStatus: "draft",
      amount: 140,
    });
    const currentQuote = buildLegacyQuoteFixture(meta, {
      version: 2,
      deliveryStatus: "draft",
      amount: 165,
    });

    await mkdir(versionDir, { recursive: true });
    await writeJson(join(jobDir, "meta.json"), meta);
    await writeJson(join(jobDir, "quote.json"), currentQuote);
    await writeJson(join(versionDir, "quote.json"), historicalQuote);

    const stats = await migrateQuoteLockSystem(root);

    const savedCurrentQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    const savedCurrentOverrides = JSON.parse(await readFile(join(jobDir, "quote-overrides.json"), "utf8"));
    const savedHistoricalQuote = JSON.parse(await readFile(join(versionDir, "quote.json"), "utf8"));
    const savedHistoricalOverrides = JSON.parse(await readFile(join(versionDir, "quote-overrides.json"), "utf8"));
    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));

    assert.equal(stats.inferredDraftBoundaries, 1);
    assert.equal(stats.rewrittenHistoricalArtifacts, 1);
    assert.equal(savedCurrentQuote.version, 2);
    assert.equal(savedCurrentQuote.delivery.status, "draft");
    assert.equal(savedCurrentOverrides.lockStatus, "draft");
    assert.equal(savedHistoricalQuote.version, 1);
    assert.equal(savedHistoricalQuote.delivery.status, "final");
    assert.equal(savedHistoricalOverrides.lockStatus, "final");
    assert.equal(savedHistoricalOverrides.finalizedAt, meta.quoteSentAt);
    assert.equal(lifecycle.lastSentQuoteVersion, 1);
    assert.equal(lifecycle.currentQuoteVersion, 2);
    assert.equal(lifecycle.currentLockStatus, "draft");
    assert.equal(lifecycle.currentPipelineStage, "draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quote lock migration backfills legacy sent boundaries without inventing missing historical snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-migrate-quote-lock-missing-"));
  const jobDir = join(root, "job-missing-history-1");

  try {
    const meta = {
      id: "job-missing-history-1",
      title: "Legacy missing history",
      label: "Legacy missing history",
      outputMode: "quote",
      pipelineStage: "draft",
      quoteVersion: 2,
      quoteSentAt: "2026-04-05T01:00:00.000Z",
      quoteNumber: "EQ-LEGACY-003",
      jobNumber: "JOB-LEGACY-003",
    };
    const currentQuote = buildLegacyQuoteFixture(meta, {
      version: 2,
      deliveryStatus: "draft",
      amount: 180,
    });

    await mkdir(jobDir, { recursive: true });
    await writeJson(join(jobDir, "meta.json"), meta);
    await writeJson(join(jobDir, "quote.json"), currentQuote);

    const stats = await migrateQuoteLockSystem(root);

    const savedCurrentQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
    const savedCurrentOverrides = JSON.parse(await readFile(join(jobDir, "quote-overrides.json"), "utf8"));
    const lifecycle = JSON.parse(await readFile(join(jobDir, "quote-lifecycle.json"), "utf8"));

    assert.equal(stats.inferredDraftBoundaries, 1);
    assert.equal(stats.missingHistoricalArtifacts, 1);
    assert.equal(savedCurrentQuote.delivery.status, "draft");
    assert.equal(savedCurrentOverrides.lockStatus, "draft");
    assert.equal(lifecycle.lastSentQuoteVersion, 1);
    assert.equal(lifecycle.currentLockStatus, "draft");
    assert.equal(existsSync(join(jobDir, "quote-versions", "v001")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
