#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalizeQuoteOverrides } from "../server/quote-commercial-adjustments.js";
import { generateEvidenceQuoteMarkdown } from "../server/generate-evidence-quote.js";
import { applyQuoteIdentity } from "../server/quote-identity.js";
import {
  deriveCurrentQuoteLockStatus,
  inferLastSentQuoteVersion,
} from "../server/quote-edit-policy.js";
import {
  parseQuoteVersion,
  readQuoteArtifacts,
  writeQuoteArtifacts,
  writeQuoteVersionSnapshot,
} from "../server/quote-artifacts.js";
import { getCustomerPresentationFinancials } from "../server/quote-presentation.js";
import { isPipelineSent, normalizePipelineStage } from "../server/pipeline.js";

const QUOTE_LIFECYCLE_FILE = "quote-lifecycle.json";

export async function migrateQuoteLockSystem(dataDir, { dryRun = false } = {}) {
  if (!dataDir) {
    throw new Error("data directory required");
  }
  if (!existsSync(dataDir)) {
    throw new Error(`data directory not found: ${dataDir}`);
  }

  const stats = {
    scanned: 0,
    jobsWithQuotes: 0,
    migratedJobs: 0,
    rewrittenCurrentArtifacts: 0,
    rewrittenHistoricalArtifacts: 0,
    wroteLifecycle: 0,
    inferredDraftBoundaries: 0,
    missingHistoricalArtifacts: 0,
    skippedWithoutQuotes: 0,
    errors: [],
  };

  for (const jobDir of await collectRecordingDirs(dataDir)) {
    stats.scanned += 1;
    const label = relativeJobLabel(dataDir, jobDir);
    try {
      const result = await migrateRecording(jobDir, { dryRun });
      if (!result) {
        stats.skippedWithoutQuotes += 1;
        continue;
      }
      stats.jobsWithQuotes += 1;
      if (result.changed) stats.migratedJobs += 1;
      stats.rewrittenCurrentArtifacts += result.rewrittenCurrentArtifacts ? 1 : 0;
      stats.rewrittenHistoricalArtifacts += result.rewrittenHistoricalArtifacts;
      stats.wroteLifecycle += result.wroteLifecycle ? 1 : 0;
      stats.inferredDraftBoundaries += result.inferredDraftBoundary ? 1 : 0;
      stats.missingHistoricalArtifacts += result.missingHistoricalArtifacts ? 1 : 0;

      if (result.changed || dryRun) {
        console.log(`\n[${label}]`);
        for (const note of result.notes) console.log(`  ${note}`);
      }
    } catch (error) {
      stats.errors.push(`${label}: ${error.message}`);
    }
  }

  return stats;
}

async function migrateRecording(jobDir, { dryRun }) {
  const metaPath = join(jobDir, "meta.json");
  if (!existsSync(metaPath)) return null;

  const rawMeta = JSON.parse(await readFile(metaPath, "utf8"));
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  if (!currentArtifacts?.quote) return null;

  const rawLifecycle = await readJsonIfExists(join(jobDir, QUOTE_LIFECYCLE_FILE), null);
  const archivedVersionNumbers = await listArchivedVersionNumbers(jobDir);
  const currentQuoteVersion = toPositiveInt(
    currentArtifacts.quote?.version
    || rawMeta?.quoteVersion
    || 1
  ) || 1;
  const pipelineStage = normalizePipelineStage(
    rawMeta?.pipelineStage
    || rawMeta?.deliveryStatus
    || rawMeta?.quoteDeliveryStatus
    || "draft"
  );
  const lastSentQuoteVersion = inferLegacyLastSentQuoteVersion({
    meta: rawMeta,
    quoteLifecycle: rawLifecycle,
    pipelineStage,
    currentQuoteVersion,
  });
  const inferredDraftBoundary = (
    !toPositiveInt(rawLifecycle?.lastSentQuoteVersion)
    && pipelineStage === "draft"
    && lastSentQuoteVersion != null
    && lastSentQuoteVersion < currentQuoteVersion
  );
  const missingHistoricalArtifacts = Boolean(
    inferredDraftBoundary
    && !archivedVersionNumbers.includes(lastSentQuoteVersion)
  );

  let identityMeta = {
    ...rawMeta,
    pipelineStage,
    deliveryStatus: pipelineStage,
    quoteVersion: currentQuoteVersion,
  };
  const notes = [];
  let rewrittenHistoricalArtifacts = 0;

  for (const version of archivedVersionNumbers) {
    const snapshotArtifacts = await readQuoteArtifacts(jobDir, version);
    if (!snapshotArtifacts?.quote) continue;

    const finalizedAt = inferHistoricalFinalizedAt({
      meta: rawMeta,
      quote: snapshotArtifacts.quote,
      overrides: snapshotArtifacts.quoteOverrides,
    });
    const normalized = normalizeQuoteArtifacts({
      meta: identityMeta,
      quote: snapshotArtifacts.quote,
      quoteOverrides: snapshotArtifacts.quoteOverrides,
      version,
      lockStatus: "final",
      finalizedAt,
    });

    const snapshotChanged = hasQuoteArtifactChanged({
      originalQuote: snapshotArtifacts.quote,
      originalOverrides: canonicalizeQuoteOverrides(snapshotArtifacts.quoteOverrides) || null,
      nextQuote: normalized.quote,
      nextOverrides: normalized.quoteOverrides,
    });
    identityMeta = normalized.meta;

    if (snapshotChanged) {
      rewrittenHistoricalArtifacts += 1;
      notes.push(`rewrote historical v${String(version).padStart(3, "0")} as locked snapshot`);
      if (!dryRun) {
        await writeQuoteVersionSnapshot({
          jobDir,
          meta: normalized.meta,
          quote: normalized.quote,
          quoteMarkdown: generateEvidenceQuoteMarkdown({
            meta: normalized.meta,
            quote: normalized.quote,
          }),
          quoteOverrides: normalized.quoteOverrides,
          quoteBreakdownSource: snapshotArtifacts.quoteBreakdownSource ?? null,
          allowExistingRewrite: true,
        });
      }
    }
  }

  const currentLockStatus = deriveCurrentQuoteLockStatus({
    currentQuoteVersion,
    lastSentQuoteVersion,
  });
  const currentFinalizedAt = currentLockStatus === "final"
    ? inferHistoricalFinalizedAt({
        meta: rawMeta,
        quote: currentArtifacts.quote,
        overrides: currentArtifacts.quoteOverrides,
      })
    : null;
  const normalizedCurrent = normalizeQuoteArtifacts({
    meta: identityMeta,
    quote: currentArtifacts.quote,
    quoteOverrides: currentArtifacts.quoteOverrides,
    version: currentQuoteVersion,
    lockStatus: currentLockStatus,
    finalizedAt: currentFinalizedAt,
  });
  const currentTotals = getCustomerPresentationFinancials(normalizedCurrent.quote);
  const normalizedMeta = {
    ...normalizedCurrent.meta,
    pipelineStage,
    deliveryStatus: pipelineStage,
    quoteVersion: currentQuoteVersion,
    quoteReviewStatus: normalizedCurrent.quote.review?.status || normalizedCurrent.quote.status || rawMeta?.quoteReviewStatus || null,
    quoteStatus: "complete",
    quoteLineItemCount: normalizedCurrent.quote.lineItems?.length || 0,
    quoteSubtotal: currentTotals.subtotal || 0,
    quoteTotal: currentTotals.total || normalizedCurrent.quote.totals?.total || 0,
  };
  const nextLifecycle = buildQuoteLifecycleRecord({
    existing: rawLifecycle,
    meta: normalizedMeta,
    quote: normalizedCurrent.quote,
    currentQuoteVersion,
    pipelineStage,
    lastSentQuoteVersion,
    now: new Date().toISOString(),
  });

  const metaChanged = hasJsonChanged(rawMeta, normalizedMeta);
  const lifecycleChanged = hasJsonChanged(rawLifecycle || null, nextLifecycle);
  const currentArtifactsChanged = hasQuoteArtifactChanged({
    originalQuote: currentArtifacts.quote,
    originalOverrides: canonicalizeQuoteOverrides(currentArtifacts.quoteOverrides) || null,
    nextQuote: normalizedCurrent.quote,
    nextOverrides: normalizedCurrent.quoteOverrides,
  }) || hasJsonChanged(rawMeta?.quoteIdentity || null, normalizedMeta.quoteIdentity || null);

  if (currentArtifactsChanged) {
    notes.push(`rewrote current quote v${String(currentQuoteVersion).padStart(3, "0")} with ${currentLockStatus} lock state`);
  }
  if (lifecycleChanged) {
    notes.push(`backfilled ${QUOTE_LIFECYCLE_FILE} with sent boundary ${formatVersionLabel(lastSentQuoteVersion) || "none"}`);
  }
  if (metaChanged && !currentArtifactsChanged) {
    notes.push("aligned meta quote totals, stage, and active revision metadata");
  }
  if (inferredDraftBoundary) {
    notes.push(`inferred sent boundary at ${formatVersionLabel(lastSentQuoteVersion)} because current stage is draft on v${String(currentQuoteVersion).padStart(3, "0")}`);
  }
  if (missingHistoricalArtifacts) {
    notes.push(`did not invent missing historical artifacts for ${formatVersionLabel(lastSentQuoteVersion)}; current lock policy still backfilled`);
  }

  if (!dryRun) {
    if (currentArtifactsChanged) {
      await writeQuoteArtifacts({
        jobDir,
        meta: normalizedMeta,
        quote: normalizedCurrent.quote,
        quoteMarkdown: generateEvidenceQuoteMarkdown({
          meta: normalizedMeta,
          quote: normalizedCurrent.quote,
        }),
        quoteOverrides: normalizedCurrent.quoteOverrides,
        quoteBreakdownSource: currentArtifacts.quoteBreakdownSource ?? null,
      });
    }
    if (metaChanged) {
      await writeFile(metaPath, JSON.stringify(normalizedMeta, null, 2));
    }
    if (lifecycleChanged) {
      await writeFile(join(jobDir, QUOTE_LIFECYCLE_FILE), JSON.stringify(nextLifecycle, null, 2));
    }
  }

  return {
    changed: Boolean(currentArtifactsChanged || metaChanged || lifecycleChanged || rewrittenHistoricalArtifacts),
    rewrittenCurrentArtifacts: currentArtifactsChanged,
    rewrittenHistoricalArtifacts,
    wroteLifecycle: lifecycleChanged,
    inferredDraftBoundary,
    missingHistoricalArtifacts,
    notes,
  };
}

function normalizeQuoteArtifacts({
  meta,
  quote,
  quoteOverrides,
  version,
  lockStatus,
  finalizedAt,
}) {
  const normalizedOverrides = canonicalizeQuoteOverrides(quoteOverrides) || {};
  const nextOverrides = canonicalizeQuoteOverrides({
    ...normalizedOverrides,
    lockStatus,
    finalizedAt: lockStatus === "final" ? finalizedAt : null,
  }) || {
    lockStatus,
    finalizedAt: lockStatus === "final" ? finalizedAt : null,
  };
  const nextQuote = {
    ...quote,
    version,
    jobId: quote?.jobId || meta?.id || null,
    quoteNumber: quote?.quoteNumber || meta?.quoteNumber || null,
    jobNumber: quote?.jobNumber || meta?.jobNumber || null,
    title: quote?.title || meta?.title || meta?.label || "Untitled job",
    updatedAt: quote?.updatedAt || quote?.generatedAt || new Date().toISOString(),
    delivery: {
      ...(quote?.delivery || {}),
      status: lockStatus === "final" ? "final" : "draft",
      finalizedAt: lockStatus === "final" ? finalizedAt : null,
    },
  };
  const identityApplied = applyQuoteIdentity({
    meta: {
      ...meta,
      quoteVersion: version,
      quoteNumber: nextQuote.quoteNumber || meta?.quoteNumber || null,
      jobNumber: nextQuote.jobNumber || meta?.jobNumber || null,
    },
    quote: nextQuote,
    overrides: nextOverrides,
  });

  return {
    meta: identityApplied.meta,
    quote: identityApplied.quote,
    quoteOverrides: nextOverrides,
  };
}

function inferLegacyLastSentQuoteVersion({
  meta,
  quoteLifecycle,
  pipelineStage,
  currentQuoteVersion,
}) {
  const lifecycleVersion = toPositiveInt(quoteLifecycle?.lastSentQuoteVersion);
  if (lifecycleVersion) return lifecycleVersion;

  const fallback = inferLastSentQuoteVersion({
    meta: {
      ...(meta || {}),
      pipelineStage,
      deliveryStatus: pipelineStage,
    },
    quoteLifecycle,
    currentQuoteVersion,
  });

  if (pipelineStage === "draft" && fallback && currentQuoteVersion > fallback) {
    return currentQuoteVersion - 1;
  }
  if (
    pipelineStage === "draft"
    && currentQuoteVersion > 1
    && Boolean(meta?.quoteSentAt || meta?.landedAt || meta?.lostAt || quoteLifecycle?.sendCount)
  ) {
    return currentQuoteVersion - 1;
  }
  return fallback;
}

function inferHistoricalFinalizedAt({ meta, quote, overrides }) {
  return (
    normalizeText(quote?.delivery?.finalizedAt)
    || normalizeText(overrides?.finalizedAt)
    || normalizeText(meta?.quoteSentAt)
    || normalizeText(meta?.landedAt)
    || normalizeText(meta?.lostAt)
    || normalizeText(quote?.updatedAt)
    || normalizeText(quote?.generatedAt)
    || new Date().toISOString()
  );
}

function buildQuoteLifecycleRecord({
  existing = null,
  meta,
  quote,
  currentQuoteVersion,
  pipelineStage,
  lastSentQuoteVersion,
  now,
}) {
  const historicalCustomerSeen = lastSentQuoteVersion != null || isPipelineSent(pipelineStage);
  const sendTimestamp = historicalCustomerSeen
    ? (
        normalizeText(existing?.lastSentAt)
        || normalizeText(meta?.quoteSentAt)
        || normalizeText(meta?.landedAt)
        || normalizeText(meta?.lostAt)
        || normalizeText(quote?.delivery?.finalizedAt)
        || normalizeText(quote?.updatedAt)
        || normalizeText(quote?.generatedAt)
        || now
      )
    : null;

  return {
    version: 1,
    createdAt: normalizeText(existing?.createdAt) || normalizeText(meta?.createdAt) || normalizeText(quote?.generatedAt) || now,
    updatedAt: now,
    firstBuiltAt: normalizeText(existing?.firstBuiltAt) || normalizeText(quote?.generatedAt) || normalizeText(quote?.updatedAt) || now,
    lastBuiltAt: normalizeText(existing?.lastBuiltAt) || normalizeText(quote?.updatedAt) || normalizeText(quote?.generatedAt) || now,
    buildCount: Math.max(Number(existing?.buildCount) || 0, 1),
    buildReasons: existing?.buildReasons && typeof existing.buildReasons === "object" ? existing.buildReasons : {},
    lastBuildReason: existing?.lastBuildReason || null,
    currentQuoteVersion,
    currentPipelineStage: pipelineStage,
    currentLockStatus: deriveCurrentQuoteLockStatus({
      currentQuoteVersion,
      lastSentQuoteVersion,
    }),
    correctionCount: Number(existing?.correctionCount) || 0,
    lineItemCorrectionCount: Number(existing?.lineItemCorrectionCount) || 0,
    assumptionCorrectionCount: Number(existing?.assumptionCorrectionCount) || 0,
    lastCorrectedAt: normalizeText(existing?.lastCorrectedAt) || null,
    lastCorrectionActor: existing?.lastCorrectionActor || null,
    lockStatusChangeCount: Number(existing?.lockStatusChangeCount) || 0,
    lastLockStatusChangeAt: normalizeText(existing?.lastLockStatusChangeAt) || null,
    sendCount: historicalCustomerSeen ? Math.max(Number(existing?.sendCount) || 0, 1) : Number(existing?.sendCount) || 0,
    lastSentAt: historicalCustomerSeen ? sendTimestamp : (normalizeText(existing?.lastSentAt) || null),
    lastSentQuoteVersion: lastSentQuoteVersion || null,
    lastSentTo: normalizeText(existing?.lastSentTo) || null,
    landedAt: normalizeText(meta?.landedAt) || normalizeText(existing?.landedAt) || null,
    lostAt: normalizeText(meta?.lostAt) || normalizeText(existing?.lostAt) || null,
    archivedAt: normalizeText(meta?.archivedAt) || normalizeText(existing?.archivedAt) || null,
    archivedReason: normalizeText(meta?.archivedReason) || normalizeText(existing?.archivedReason) || null,
    archivedBeforeSend: existing?.archivedBeforeSend === true || Boolean(meta?.archivedAt && !historicalCustomerSeen),
    abandonedAt: normalizeText(existing?.abandonedAt) || (meta?.archivedAt && !historicalCustomerSeen ? normalizeText(meta.archivedAt) : null),
  };
}

function hasQuoteArtifactChanged({
  originalQuote,
  originalOverrides,
  nextQuote,
  nextOverrides,
}) {
  return hasJsonChanged(originalQuote, nextQuote) || hasJsonChanged(originalOverrides || null, nextOverrides || null);
}

function hasJsonChanged(current, next) {
  return JSON.stringify(current || null) !== JSON.stringify(next || null);
}

async function collectRecordingDirs(dataDir) {
  const dirs = [];
  const entries = await readdir(dataDir);
  for (const entry of entries) {
    const dir = join(dataDir, entry);
    const entryStat = await stat(dir).catch(() => null);
    if (!entryStat?.isDirectory()) continue;

    if (existsSync(join(dir, "meta.json"))) {
      dirs.push(dir);
      continue;
    }

    for (const nested of await readdir(dir).catch(() => [])) {
      const nestedDir = join(dir, nested);
      const nestedStat = await stat(nestedDir).catch(() => null);
      if (!nestedStat?.isDirectory()) continue;
      if (existsSync(join(nestedDir, "meta.json"))) {
        dirs.push(nestedDir);
      }
    }
  }
  return dirs.sort();
}

async function listArchivedVersionNumbers(jobDir) {
  const versionsDir = join(jobDir, "quote-versions");
  if (!existsSync(versionsDir)) return [];

  const entries = await readdir(versionsDir);
  return entries
    .map((entry) => parseQuoteVersion(entry))
    .filter(Boolean)
    .sort((a, b) => a - b);
}

async function readJsonIfExists(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function relativeJobLabel(dataDir, jobDir) {
  return jobDir.startsWith(`${dataDir}/`) ? jobDir.slice(dataDir.length + 1) : jobDir;
}

function toPositiveInt(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeText(value) {
  const trimmed = String(value || "").trim();
  return trimmed || null;
}

function formatVersionLabel(version) {
  return toPositiveInt(version) ? `v${String(version).padStart(3, "0")}` : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dataDir = args.find((arg) => !arg.startsWith("--"));

  if (!dataDir) {
    console.error("Usage: node scripts/migrate-quote-lock-system.js <data-dir> [--dry-run]");
    process.exit(1);
  }

  const stats = await migrateQuoteLockSystem(dataDir, { dryRun });
  console.log("\n--- Summary ---");
  console.log(`Scanned: ${stats.scanned} recordings`);
  console.log(`With quotes: ${stats.jobsWithQuotes}`);
  console.log(`Migrated jobs: ${stats.migratedJobs}`);
  console.log(`Current artifacts rewritten: ${stats.rewrittenCurrentArtifacts}`);
  console.log(`Historical artifacts rewritten: ${stats.rewrittenHistoricalArtifacts}`);
  console.log(`Lifecycle files written: ${stats.wroteLifecycle}`);
  console.log(`Inferred draft boundaries: ${stats.inferredDraftBoundaries}`);
  console.log(`Missing historical artifacts left uninvented: ${stats.missingHistoricalArtifacts}`);
  console.log(`Skipped without quotes: ${stats.skippedWithoutQuotes}`);
  if (stats.errors.length) {
    console.log(`Errors: ${stats.errors.length}`);
    for (const error of stats.errors) console.log(`  ${error}`);
    process.exitCode = 1;
  }
  if (dryRun) {
    console.log("\nNo files were modified (dry run).");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
