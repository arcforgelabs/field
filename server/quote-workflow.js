import { existsSync } from "./storage/fs.js";
import { readFile, readdir, writeFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createQuotePricingRequestNonce, buildQuotePricingAttestation, attachQuotePricingAttestation } from "./quote-pricing-attestation.js";
import { normalizePipelineStage, preserveQuoteDeliveryState } from "./pipeline.js";
import { generateEvidenceQuote, generateEvidenceQuoteMarkdown } from "./generate-evidence-quote.js";
import {
  getNextQuoteVersion,
  listQuoteVersions,
  readQuoteArtifacts,
  writeQuoteArtifacts,
  writeQuoteVersionSnapshot,
} from "./quote-artifacts.js";
// Drive sync removed — legacy
import { readMoasureSummary, scanMoasure } from "./moasure.js";
import { ensureJobState, readJobState } from "./job-state.js";
import { projectQuoteForReviewState } from "./quote-review-projection.js";
import { buildAndWriteEvidencePack } from "./quote-evidence-pack.js";
import { markQuoteBuilt, readQuoteLifecycle, recordQuotePipelineStageChange } from "./quote-lifecycle.js";
import { buildRateCardFromPriceMaps } from "./retaining-wall-rate-card.js";
import { quoteRowsFromArtifact } from "./quotes/read-model.js";
import { applyQuoteIdentity, ensureQuoteIdentityMeta } from "./quote-identity.js";
import { canonicalizeQuoteOverrides } from "./quote-commercial-adjustments.js";
import { resolveQuoteCatalogIdFromMeta } from "./quote-catalog-ids.js";
import { buildQuoteBreakdownSource } from "./quote-breakdown-source.js";
import { appendParsedArtifactEntry, getEvidenceIndex, writeParsedArtifactJson } from "./evidence-index.js";
import { detectStaleEvidence } from "./stale-detection.js";
import { markIngested, resolveJobFilePath } from "./ingestion-ledger.js";
import {
  assertPriceCatalogSnapshotComplete,
  buildPriceCatalogSnapshot,
  isPriceCatalogSnapshotUsable,
  resolveQuoteCatalogPricingDependencies,
} from "./price-catalog/catalog-snapshot.js";
import { RETAINING_WALL_REQUIRED_PRICE_CODES } from "./price-catalog/wall-rate-card.js";
import { buildRetainingWallQuoteContextForJob } from "./wall-zones.js";
import { inferLastSentQuoteVersion, shouldForkQuoteMutation } from "./quote-edit-policy.js";
import { hydrateJobMeta, readJobMeta, writeJobMeta } from "./job-meta-store.js";
import { appendJobLog, getFieldDbHandle } from "./field-db.js";
import { buildSystemRebuildNote } from "./clarification-notes.js";
import {
  filterEvidenceIndexByVisibleFileIds,
  readCurrentQuoteOperationalSnapshot,
  readCurrentVisibleLedgerFiles,
  snapshotQuoteVersionContext,
  synchronizeCurrentQuoteContext,
} from "./quote-version-context.js";
import { reconcileBaselineScope } from "./reconcile-baseline-scope.js";
import { runAtomicJobGeneration } from "./job-generation.js";

export async function readQuoteOverrides(jobDir) {
  const overridesPath = join(jobDir, "quote-overrides.json");
  if (!existsSync(overridesPath)) return null;
  return canonicalizeQuoteOverrides(JSON.parse(await readFile(overridesPath, "utf8")));
}

export async function resolveBaselineQuoteForRebuild({
  jobDir,
  currentArtifacts,
  currentVersion,
  historicalCustomerSeenVersion,
}) {
  // Prefer the last customer-seen snapshot as the rebuild anchor so that a
  // degraded draft sitting at the root jobDir cannot cascade into further
  // rebuilds. Fall back to the current root quote when no distinct historical
  // version exists.
  if (
    historicalCustomerSeenVersion
    && historicalCustomerSeenVersion !== currentVersion
  ) {
    try {
      const snapshot = await readQuoteArtifacts(jobDir, historicalCustomerSeenVersion);
      if (snapshot?.quote) return snapshot.quote;
    } catch (error) {
      console.warn(
        `[quote-workflow] could not read baseline snapshot v${historicalCustomerSeenVersion} (${error.message}); falling back to current quote`
      );
    }
  }
  return currentArtifacts?.quote || null;
}

function createPricingUnavailableError({ authorityStatus = null, cause = null } = {}) {
  const reason = authorityStatus?.reason
    || authorityStatus?.error
    || cause?.message
    || "Fresh price catalog pricing could not be verified for this build.";
  const error = new Error(
    `Cannot build quote while commercial pricing is unavailable: ${reason}`
  );
  error.code = "FIELD_PRICE_CATALOG_UNAVAILABLE";
  error.statusCode = 503;
  if (cause) error.cause = cause;
  return error;
}

export async function preflightQuotePricingAuthority({
  priceCatalog = null,
  quoteCatalogId = null,
  pricingSnapshot = null,
  quoteInputs = null,
  overrides = null,
} = {}) {
  if (pricingSnapshot) {
    if (!isPriceCatalogSnapshotUsable(pricingSnapshot)) {
      throw createPricingUnavailableError({
        cause: new Error("price catalog snapshot is incomplete or unusable"),
      });
    }
    const requiredCodes = resolveQuoteInputPricingDependencies({ pricingSnapshot, quoteInputs, overrides });
    try {
      assertPriceCatalogSnapshotComplete(pricingSnapshot, { requiredCodes });
    } catch (error) {
      throw createPricingUnavailableError({ cause: error });
    }
    return pricingSnapshot;
  }
  if (!priceCatalog) {
    throw createPricingUnavailableError({
      cause: new Error("price catalog database is unavailable"),
    });
  }

  let snapshot;
  try {
    snapshot = buildPriceCatalogSnapshot(await priceCatalog.getState(), {
      quoteCatalogId,
      // Quote demand is narrowed below to the recipe/dependency closure of
      // the intended inputs. The generic rate-card endpoint/startup uses the
      // complete rate-card universe; a small quote need not require unrelated
      // optional wall/material rates.
      includeRateCard: false,
    });
  } catch (error) {
    throw createPricingUnavailableError({ cause: error });
  }
  if (!isPriceCatalogSnapshotUsable(snapshot)) {
    throw createPricingUnavailableError({ authorityStatus: snapshot.authorityStatus });
  }

  // The catalog overlay is part of this same immutable snapshot. Resolve the
  // recipe's actual money dependencies from it before allowing a command to
  // generate anything; checking only the set of active DB rows would miss a
  // rule whose authority item is absent altogether.
  const requiredCodes = resolveQuoteInputPricingDependencies({ pricingSnapshot: snapshot, quoteInputs, overrides });
  try {
    assertPriceCatalogSnapshotComplete(snapshot, { requiredCodes });
  } catch (error) {
    throw createPricingUnavailableError({ cause: error });
  }

  return Object.freeze({
    ...snapshot,
    authorityStatus: Object.freeze({ ...(snapshot.authorityStatus || {}) }),
  });
}

function resolveQuoteInputPricingDependencies({ pricingSnapshot = null, quoteInputs = null, overrides = null } = {}) {
  const candidates = [
    ...(Array.isArray(quoteInputs?.lineItemCandidates) ? quoteInputs.lineItemCandidates : []),
    ...(Array.isArray(quoteInputs?.lineItems) ? quoteInputs.lineItems : []),
  ];
  const overrideCodes = [
    ...Object.keys(overrides?.lineItems || {}),
    ...(Array.isArray(overrides?.commercialAdjustments)
      ? overrides.commercialAdjustments.flatMap((entry) => [entry?.lineItemCode, entry?.quoteCatalogItemCode])
      : []),
  ]
    .map((code) => String(code || "").split("__")[0].trim())
    .filter(Boolean);
  if (!candidates.length && !overrideCodes.length) return [];
  const rules = pricingSnapshot?.quoteCatalog?.rules || [];
  const quantityRules = pricingSnapshot?.quoteCatalog?.quantityRules || [];
  const dependencies = new Set();
  // An assembly (recipe) the candidate maps to, by rule or by its scope
  // text, needs every one of its component items priced. The assemblies and
  // their match patterns are quote-catalog data (server/catalog/assemblies.js).
  const assemblies = pricingSnapshot?.quoteCatalog?.assemblies || [];
  const generatedRecipeDependencies = (candidate, baseCode) => {
    const text = [
      candidate?.section,
      candidate?.label,
      candidate?.description,
      candidate?.rationale,
      baseCode,
    ].filter(Boolean).join(" ").toLowerCase();
    return assemblies
      .filter((assembly) => (
        (assembly.appliesToRuleCodes || []).some((code) => String(code).toLowerCase() === String(baseCode).toLowerCase())
        || (assembly.match && new RegExp(assembly.match, "i").test(text))
      ))
      .flatMap((assembly) => (assembly.components || []).map((component) => component.itemCode));
  };
  const findRuleByReference = (reference) => rules.find((entry) => (
    String(entry.code || "").toLowerCase() === String(reference || "").toLowerCase()
      || String(entry.authorityItemCode || "").toLowerCase() === String(reference || "").toLowerCase()
  ));
  const addRuleDependencies = (rule, seen = new Set()) => {
    if (!rule) return;
    const key = String(rule.code || rule.authorityItemCode || "").toLowerCase();
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    if (rule.authorityItemCode) dependencies.add(String(rule.authorityItemCode).trim());
    for (const dependency of [
      ...(rule.pricingDependencies || []),
      ...(rule.components || []).map((component) => component?.itemCode || component?.ruleCode),
    ]) {
      const referencedRule = findRuleByReference(dependency);
      if (referencedRule) addRuleDependencies(referencedRule, seen);
      else if (dependency) dependencies.add(String(dependency).trim());
    }
  };
  for (const candidate of candidates) {
    const code = String(
      candidate?.quoteCatalogItemCode
      || candidate?.quoteCatalogEntry?.code
      || candidate?.pricingReferenceId
      || candidate?.priceListItemCode
      || candidate?.code
      || candidate?.itemCode
      || ""
    ).trim();
    if (!code) continue;
    const baseCode = code.split("__")[0] || code;
    for (const dependency of generatedRecipeDependencies(candidate, baseCode)) dependencies.add(dependency);
    const rule = rules.find((entry) => (
      entry.code === code
      || entry.authorityItemCode === code
      || String(entry.code || "").toLowerCase() === code.toLowerCase()
      || String(entry.authorityItemCode || "").toLowerCase() === code.toLowerCase()
      || String(entry.code || "").toLowerCase() === baseCode.toLowerCase()
      || String(entry.authorityItemCode || "").toLowerCase() === baseCode.toLowerCase()
    ));
    const ruleCode = rule?.code || baseCode;
    const matchingQuantityRules = quantityRules.filter((quantityRule) => (
      (quantityRule.appliesToRuleCodes || []).some((appliesTo) => (
        String(appliesTo).toLowerCase() === String(ruleCode).toLowerCase()
        || String(appliesTo).toLowerCase() === baseCode.toLowerCase()
      ))
    ));
    const candidateStageRules = quantityRules.filter((quantityRule) => (
      [
        quantityRule.soilRuleCode,
        quantityRule.sourceRuleCode,
        quantityRule.surfaceRuleCode,
        quantityRule.structureRuleCode,
        quantityRule.outputRuleCode,
        quantityRule.outputItemCode,
        ...(quantityRule.componentRuleCodes || []),
      ].some((reference) => String(reference || "").toLowerCase() === String(ruleCode).toLowerCase())
    ));
    for (const quantityRule of [...matchingQuantityRules, ...candidateStageRules]) {
      for (const dependency of quantityRule.pricingDependencies || []) {
        dependencies.add(String(dependency).trim());
      }
      const assembly = quantityRule.assembly
        ? assemblies.find((entry) => entry.code === quantityRule.assembly)
        : null;
      for (const component of assembly?.components || []) dependencies.add(component.itemCode);
      for (const reference of [
        quantityRule.soilRuleCode,
        quantityRule.haulageRuleCode,
        quantityRule.loaderRuleCode,
        quantityRule.disposalRuleCode,
        quantityRule.vehicleHourRuleCode,
        quantityRule.vehicleKmRuleCode,
        quantityRule.surfaceRuleCode,
        quantityRule.structureRuleCode,
        quantityRule.outputRuleCode,
        quantityRule.sourceRuleCode,
        quantityRule.cutRuleCode,
        quantityRule.fillRuleCode,
        ...(quantityRule.componentRuleCodes || []),
      ]) {
        const referencedRule = findRuleByReference(reference);
        if (referencedRule) addRuleDependencies(referencedRule);
        else if (reference) dependencies.add(String(reference).trim());
      }
    }
    addRuleDependencies(rule);
    const directDependency = candidate?.authorityItemCode
      || rule?.authorityItemCode
      || rule?.priceCatalog?.code;
    if (directDependency) dependencies.add(String(directDependency).trim());
  }
  // The quote catalog's support rules are generated by
  // ensureCommercialSupportLineItems whenever the quote has real scoped work.
  // They are part of the intended commercial output even though they are not
  // present in the recorder's candidate list.
  if (candidates.length) {
    for (const code of pricingSnapshot?.quoteCatalog?.supportRuleCodes || []) {
      const supportRule = findRuleByReference(code);
      if (supportRule) addRuleDependencies(supportRule);
      else dependencies.add(code);
    }
  }
  for (const code of overrideCodes) {
    const rule = findRuleByReference(code);
    if (rule) addRuleDependencies(rule);
    else dependencies.add(code);
  }
  const candidateText = candidates.map((candidate) => [
    candidate?.code,
    candidate?.label,
    candidate?.description,
    candidate?.section,
    candidate?.rationale,
  ].filter(Boolean).join(" ")).join(" ").toLowerCase();
  if (/retaining wall|sleeper|i[- ]?beam|c[- ]?channel/.test(candidateText)) {
    for (const code of RETAINING_WALL_REQUIRED_PRICE_CODES) dependencies.add(code);
  }
  const closure = resolveQuoteCatalogPricingDependencies(pricingSnapshot?.quoteCatalog, {
    includeRateCard: false,
    includeCatalogRules: false,
  });
  return [...new Set([...dependencies, ...closure])].filter(Boolean);
}

async function buildAndPersistQuoteInPlace({
  jobDir,
  meta,
  transcript,
  quoteInputs,
  config,
  provenance = null,
  overrides = null,
  forkSentQuote = null,
  buildReason = "quote_build",
  pricingSnapshot = null,
  persistSystemNote = true,
  contextSnapshot = null,
  moasureSummaryOverride = undefined,
  operationalSnapshot = null,
}) {
  const effectiveProvenance = normalizeProducedBy(provenance);
  // Commercial authority is a command precondition. Keep this before stale
  // evidence ingestion or any quote-context writes so an emergency/degraded
  // runtime cannot replace an issued quote with locally-derived pricing.
  const {
    authorityStatus: pricingAuthorityStatus,
    recipePricing,
    quoteCatalog: pricingQuoteCatalog,
    buyMap: pricingBuyMap,
    sellMap: pricingSellMap,
    fetchedAt: pricingFetchedAt,
  } =
    await preflightQuotePricingAuthority({
      priceCatalog: config?.priceCatalog || null,
      quoteCatalogId: resolveQuoteCatalogIdFromMeta(meta),
      pricingSnapshot,
      quoteInputs,
      overrides,
    });

  // A staged commercial generation intentionally contains no raw/parsed or
  // transcript trees. The caller must provide the immutable operational
  // snapshot captured from the job root; only the legacy direct seam performs
  // the old in-place stale-evidence pass.
  if (!operationalSnapshot) {
    try {
      const staleStatus = await detectStaleEvidence({ jobDir });
      if (staleStatus.uningestedFiles.length) {
        await ingestPendingEvidence({
          jobDir,
          files: staleStatus.uningestedFiles,
          provenance: effectiveProvenance,
        });
      }
    } catch (ingestionErr) {
      console.warn(`[quote-workflow] ingestion of pending evidence failed (non-fatal): ${ingestionErr.message}`);
    }
  }

  const canonicalOverrides = canonicalizeQuoteOverrides(overrides);
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  const currentQuoteLifecycle = await readQuoteLifecycle(jobDir);
  const currentVersion = Number(
    currentArtifacts?.quote?.version
    || meta.quoteVersion
    || 1
  );
  const {
    ledger: currentLedger,
    visibleFiles: currentVisibleFiles,
    visibleFileIds: currentVisibleFileIds,
  } = operationalSnapshot || await readCurrentVisibleLedgerFiles({
    jobDir,
    quoteVersion: currentVersion,
  });
  const currentEvidenceIndex = operationalSnapshot?.evidenceIndex
    || await getEvidenceIndex({ jobDir });
  const historicalCustomerSeenVersion = inferLastSentQuoteVersion({
    meta,
    quoteLifecycle: currentQuoteLifecycle,
    currentQuoteVersion: currentVersion,
  });
  const shouldForkSentQuote =
    Boolean(currentArtifacts?.quote)
    && (
      typeof forkSentQuote === "boolean"
        ? forkSentQuote
        : shouldForkQuoteMutation({
            meta,
            quoteLifecycle: currentQuoteLifecycle,
            currentQuoteVersion: currentVersion,
          })
    );
  // Version IDs are append-only across promotions and forks. The current root
  // can legitimately be older than a retained archive, so current + 1 is not
  // a safe allocator.
  const version = shouldForkSentQuote ? await getNextQuoteVersion(jobDir) : currentVersion;
  const identifiedMeta = ensureQuoteIdentityMeta({
    meta: await ensureQuoteIdentity(meta, jobDir),
    version,
  });
  const pricingRequestNonce = createQuotePricingRequestNonce();
  const moasureSummary = moasureSummaryOverride !== undefined
    ? moasureSummaryOverride
    : contextSnapshot && Object.prototype.hasOwnProperty.call(contextSnapshot, "moasureSummary")
    ? contextSnapshot.moasureSummary
    : operationalSnapshot?.moasureSummary
    || await readMoasureSummary(jobDir);
  const existingJobState = operationalSnapshot?.jobState || await readJobState(jobDir);
  // Resolve operator configuration as part of the staged compilation even
  // when the root job-state snapshot is reused. This keeps configuration
  // failures inside the atomic command boundary.
  const operatorName = config.operatorName || null;
  const transcriptSourceFileIds = collectAudioSourceFileIds(currentVisibleFiles, meta);
  const breakdownSourceFileIds = collectEvidenceSourceFileIds(currentVisibleFiles);
  const baselineQuote = await resolveBaselineQuoteForRebuild({
    jobDir,
    currentArtifacts,
    currentVersion,
    historicalCustomerSeenVersion,
  });
  const evidencePack = await buildAndWriteEvidencePack({
    jobDir,
    jobId: identifiedMeta.id,
    meta: identifiedMeta,
    transcript,
    cleanedTranscript: transcript?.cleaned || null,
    label: identifiedMeta.label || identifiedMeta.title || null,
    quoteCatalogId: resolveQuoteCatalogIdFromMeta(identifiedMeta),
    quoteCatalog: pricingQuoteCatalog,
    baselineQuote,
    operationalJobDir: operationalSnapshot?.operationalJobDir || null,
  });
  const reconciledQuoteInputs = reconcileBaselineScope({
    quoteInputs,
    baselineQuote,
    clarificationNotes: evidencePack?.evidence?.clarificationNotes || [],
  });
  await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(reconciledQuoteInputs, null, 2));
  const breakdownSource = buildQuoteBreakdownSource({
    meta: identifiedMeta,
    evidencePack,
    quoteInputs: reconciledQuoteInputs,
    moasureSummary,
    details: existingJobState?.details || null,
  });
  await writeFile(join(jobDir, "quote-breakdown-source.json"), JSON.stringify(breakdownSource, null, 2));
  // `parsed/` is root-authoritative operational state. A commercial
  // generation must never materialize it and then project it back on commit;
  // the generated evidence pack and breakdown source above are the
  // version-bound commercial copies.
  const pricingAttestationReason = null;
  const retainingWallRateCard = await resolveRetainingWallRateCard({
    pricingSnapshot: {
      source: "price_catalog",
      buyMap: pricingBuyMap,
      sellMap: pricingSellMap,
      fetchedAt: pricingFetchedAt,
      recipePricing,
    },
  });
  const retainingWallContext = await buildRetainingWallQuoteContextForJob({
    jobDir,
    operationalJobDir: operationalSnapshot?.operationalJobDir || null,
    rateCard: retainingWallRateCard,
  });
  const baseQuote = generateEvidenceQuote({
    meta: identifiedMeta,
    transcript,
    quoteInputs: reconciledQuoteInputs,
    quoteCatalogId: resolveQuoteCatalogIdFromMeta(identifiedMeta),
    quoteCatalog: pricingQuoteCatalog,
    overrides: canonicalOverrides,
    version,
    moasureSummary,
    details: existingJobState?.details || null,
    breakdownSource,
    recipePricing,
    retainingWallContext,
  });
  const jobState = operationalSnapshot?.jobState || await ensureJobState({
        jobDir,
        meta: identifiedMeta,
        transcript,
        quoteInputs: reconciledQuoteInputs,
        quote: baseQuote,
        defaults: {
          operatorName,
        },
      });
  const projectedQuote = projectQuoteForReviewState({
    quote: baseQuote,
    gaps: jobState?.gaps || [],
  });
  const identityApplied = applyQuoteIdentity({
    meta: identifiedMeta,
    quote: projectedQuote,
    quoteInputs: reconciledQuoteInputs,
    overrides: canonicalOverrides,
  });
  let quote = identityApplied.quote;
  const pricingAttestation = buildQuotePricingAttestation({
    requestNonce: pricingRequestNonce,
    authorityStatus: pricingAuthorityStatus,
    // A live database handle alone is not sufficient. A partial catalogue can
    // still produce a customer-looking top-level rate while its commercial
    // breakdown has unresolved monetary inputs; that result is unverified and
    // must remain behind the pricing presentation boundary.
    livePricingAvailable: Boolean(
      recipePricing
      && recipePricing.unavailable !== true
      && baseQuote?.pricing?.ready !== false
      && baseQuote?.internalPricing?.ready !== false,
    ),
    reason: pricingAttestationReason,
  });
  quote = attachQuotePricingAttestation({
    quote,
    attestation: pricingAttestation,
  });
  const identifiedMetaWithQuoteIdentity = identityApplied.meta;
  // Scope/presentation generation is allowed to change labels and organizer
  // shape, but the attestation must bind to the final canonical monetary
  // output that is about to be persisted. Re-attach after that last
  // presentation step so later monetary mutations invalidate it.
  quote = attachQuotePricingAttestation({
    quote,
    attestation: pricingAttestation,
  });

  const quoteMarkdown = generateEvidenceQuoteMarkdown({ meta: identifiedMetaWithQuoteIdentity, quote });
  if (shouldForkSentQuote && currentArtifacts?.quote) {
    await snapshotQuoteVersionContext(jobDir, {
      quoteVersion: currentVersion,
      transcript: contextSnapshot?.transcript ?? transcript,
      quoteInputs: contextSnapshot?.quoteInputs ?? reconciledQuoteInputs,
      evidencePack: contextSnapshot?.evidencePack ?? evidencePack,
      moasureSummary: contextSnapshot?.moasureSummary ?? moasureSummary,
      ingestionLedger: contextSnapshot?.ingestionLedger ?? {
        ...(currentLedger || {}),
        files: currentVisibleFiles,
      },
      evidenceIndex: contextSnapshot?.evidenceIndex ?? filterEvidenceIndexByVisibleFileIds(
          currentEvidenceIndex,
          currentVisibleFileIds,
        ),
      visibleFileIds: contextSnapshot?.visibleFileIds ?? [...currentVisibleFileIds],
    });
    await writeQuoteVersionSnapshot({
      jobDir,
      meta: identifiedMetaWithQuoteIdentity,
      quote: currentArtifacts.quote,
      quoteMarkdown:
        currentArtifacts.quoteMarkdown
        || generateEvidenceQuoteMarkdown({ meta: identifiedMetaWithQuoteIdentity, quote: currentArtifacts.quote }),
      quoteOverrides: currentArtifacts.quoteOverrides,
      quoteBreakdownSource: currentArtifacts.quoteBreakdownSource,
    });
  }
  const { pdfBuffer } = await writeQuoteArtifacts({
    jobDir,
    meta: identifiedMetaWithQuoteIdentity,
    quote,
    quoteMarkdown,
    quoteOverrides: canonicalOverrides,
    quoteBreakdownSource: breakdownSource,
  });

  const updatedMeta = {
    ...identifiedMetaWithQuoteIdentity,
    status: "complete",
    recordingIntent: reconciledQuoteInputs.recordingIntent,
    quoteReviewStatus: quote.review?.status || quote.status,
    quoteStatus: "complete",
    quoteLineItemCount: quote.lineItems?.length || 0,
    // The job's cached totals (the job list) come from the quote's rows (#10).
    quoteSubtotal: quoteRowsFromArtifact({ quote, meta: identifiedMetaWithQuoteIdentity }).financials.subtotal || 0,
    quoteTotal: quoteRowsFromArtifact({ quote, meta: identifiedMetaWithQuoteIdentity }).financials.total || quote.totals?.total || 0,
    quoteVersion: quote.version,
    // See preserveQuoteDeliveryState in pipeline.js for why this is
    // unconditional rather than gated on shouldForkSentQuote.
    ...preserveQuoteDeliveryState(meta),
    quoteCatalogId: quote.quoteCatalog?.id || quote.quoteCatalog?.id || resolveQuoteCatalogIdFromMeta(identifiedMetaWithQuoteIdentity),
    quoteNumber: quote.quoteNumber || identifiedMetaWithQuoteIdentity.quoteNumber,
    jobNumber: quote.jobNumber || identifiedMetaWithQuoteIdentity.jobNumber,
    moasureStatus: moasureSummary?.status || "not_attached",
    moasureBatchCount: moasureSummary?.batchCount || 0,
    moasureLatestBatchId: moasureSummary?.latestBatchId || null,
    quoteIdentity: identifiedMetaWithQuoteIdentity.quoteIdentity,
  };

  const persistedMeta = await writeJobMeta(jobDir, updatedMeta);
  await synchronizeCurrentQuoteContext(jobDir, {
    quoteVersion: quote.version,
  });
  const quoteLifecycle = await markQuoteBuilt({
    jobDir,
    meta: persistedMeta,
    quote,
    reason: buildReason,
  });
  const stabilizedQuoteLifecycle = (
    shouldForkSentQuote
    && historicalCustomerSeenVersion
    && !quoteLifecycle?.lastSentQuoteVersion
  )
    ? await recordQuotePipelineStageChange({
        jobDir,
        meta: {
          ...persistedMeta,
          quoteVersion: historicalCustomerSeenVersion,
        },
        stage: normalizePipelineStage(meta?.pipelineStage || meta?.deliveryStatus),
        changedAt:
          meta?.quoteSentAt
          || meta?.landedAt
          || meta?.lostAt
          || quote.generatedAt
          || quote.updatedAt
          || new Date().toISOString(),
      })
    : quoteLifecycle;
  if (persistSystemNote) {
    await syncSystemRebuildNote({
      meta: persistedMeta,
      quote,
      evidencePack,
      buildReason,
    });
  }

  return {
    meta: persistedMeta,
    quote,
    quoteInputs: reconciledQuoteInputs,
    quoteBreakdownSource: breakdownSource,
    quoteMarkdown,
    quotePdfBuffer: pdfBuffer,
    quoteVersions: await listQuoteVersions(jobDir),
    quoteLifecycle: stabilizedQuoteLifecycle,
    evidencePack,
  };
}

/**
 * Build one quote against one immutable authority snapshot, then publish the
 * complete replacement directory. All context, lifecycle, and artifact writes
 * happen in the staging directory; a later failure cannot fork or partially
 * replace an issued quote.
 */
export async function buildAndPersistQuote(args = {}) {
  const jobDir = args.jobDir;
  if (!jobDir) throw new Error("buildAndPersistQuote requires jobDir");
  const result = await runAtomicJobGeneration(jobDir, async (stagedJobDir) => {
    // Resolve authority only after the generation lock is held. The immutable
    // snapshot used below is therefore the one command snapshot for this
    // staged replacement, with no preflight/mutate/re-preflight window.
    const stagedMeta = args.meta || await readJobMetaFromGeneration(stagedJobDir, null);
    const pricingSnapshot = await preflightQuotePricingAuthority({
      priceCatalog: args.config?.priceCatalog || null,
      quoteCatalogId: resolveQuoteCatalogIdFromMeta(stagedMeta),
      quoteInputs: args.quoteInputs,
      overrides: args.overrides,
    });
    const operationalSnapshot = args.operationalSnapshot
      || await captureOperationalSnapshot({
        jobDir,
        commercialJobDir: stagedJobDir,
        meta: stagedMeta,
        provenance: args.provenance,
      });
    const result = await buildAndPersistQuoteInPlace({
      ...args,
      jobDir: stagedJobDir,
      meta: stagedMeta,
      pricingSnapshot,
      persistSystemNote: false,
      contextSnapshot: args.contextSnapshot || null,
      moasureSummaryOverride: args.moasureSummaryOverride,
      operationalSnapshot,
    });
    return result;
  });
  try {
    await syncSystemRebuildNote({
      meta: result.meta,
      quote: result.quote,
      evidencePack: result.evidencePack,
      buildReason: args.buildReason || "quote_build",
    });
  } catch (error) {
    // The field DB note is an informational projection; it must not turn a
    // successful atomic artifact publish into a misleading failed rebuild.
    console.warn(`[quote-workflow] system rebuild note sync failed: ${error.message}`);
  }
  return {
    ...result,
    quoteVersions: await listQuoteVersions(jobDir),
  };
}

async function readJobMetaFromGeneration(jobDir, fallback = null) {
  try {
    const raw = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    return raw && typeof raw === "object" ? await hydrateJobMeta(jobDir, raw) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build against a directory that is already the caller's locked generation.
 * Maintenance tools such as quote:recording use this seam to keep reads,
 * snapshot resolution, version/context writes, PDF generation, and publish
 * inside one outer runAtomicJobGeneration transaction instead of nesting a
 * second command transaction.
 */
export async function buildQuoteInStagedGeneration(args = {}) {
  if (!args.jobDir) throw new Error("buildQuoteInStagedGeneration requires jobDir");
  // The staged directory holds no raw/, parsed/ or job-state/. Without the
  // job root the build would ingest evidence and seed job-state inside the
  // generation, which publish then rejects.
  if (!args.operationalJobDir && !args.operationalSnapshot) {
    throw new Error("buildQuoteInStagedGeneration requires operationalJobDir or operationalSnapshot");
  }
  const pricingSnapshot = await preflightQuotePricingAuthority({
    priceCatalog: args.config?.priceCatalog || null,
    quoteCatalogId: resolveQuoteCatalogIdFromMeta(args.meta),
    quoteInputs: args.quoteInputs,
    overrides: args.overrides,
  });
  return buildAndPersistQuoteInPlace({
    ...args,
    pricingSnapshot,
    persistSystemNote: false,
    contextSnapshot: args.contextSnapshot || null,
    moasureSummaryOverride: args.moasureSummaryOverride,
    operationalSnapshot: args.operationalSnapshot
      || (args.operationalJobDir
        ? await captureOperationalSnapshot({
            jobDir: args.operationalJobDir,
            commercialJobDir: args.jobDir,
            meta: args.meta,
            provenance: args.provenance,
          })
        : null),
  });
}

async function captureOperationalSnapshot({
  jobDir,
  commercialJobDir = null,
  meta,
  provenance = null,
} = {}) {
  // Root operational writers remain the owners of ingestion/parsed state. A
  // build may refresh pending evidence while holding the job generation lock,
  // then captures the resulting root state exactly once for the commercial
  // compilation.
  try {
    const staleStatus = await detectStaleEvidence({ jobDir, readOnly: true });
    if (staleStatus.uningestedFiles.length) {
      await ingestPendingEvidence({
        jobDir,
        commercialJobDir,
        files: staleStatus.uningestedFiles,
        provenance: normalizeProducedBy(provenance),
      });
    }
  } catch (ingestionErr) {
    console.warn(`[quote-workflow] ingestion of pending evidence failed (non-fatal): ${ingestionErr.message}`);
  }

  const snapshot = await readCurrentQuoteOperationalSnapshot({
    jobDir,
    commercialJobDir,
    quoteVersion: meta?.quoteVersion || null,
  });
  snapshot.jobState = await readJobState(jobDir);
  return snapshot;
}

async function syncSystemRebuildNote({
  meta,
  quote,
  evidencePack,
  buildReason,
}) {
  const db = getFieldDbHandle();
  if (!db || !meta?.id || !quote) return;

  const note = buildSystemRebuildNote({
    quote,
    noteSummary: evidencePack?.evidence?.clarificationNoteSummary || null,
    buildReason,
  });
  if (!note) return;

  // The rebuild summary is engine output: it goes to the job's log, not its notes.
  appendJobLog(db, {
    jobId: meta.id,
    kind: "quote.rebuilt",
    title: note.title,
    text: note.text,
    version: note.version,
    latestOnly: true,
  });
}

async function resolveRetainingWallRateCard({
  pricingSnapshot = null,
}) {
  if (pricingSnapshot?.buyMap && pricingSnapshot?.sellMap) {
    try {
      assertPriceCatalogSnapshotComplete(pricingSnapshot, {
        requiredCodes: RETAINING_WALL_REQUIRED_PRICE_CODES,
      });
      return buildRateCardFromPriceMaps({
        buyMap: pricingSnapshot.buyMap,
        sellMap: pricingSnapshot.sellMap,
        _fetchedAt: pricingSnapshot.fetchedAt,
        _source: "price_catalog",
      });
    } catch (error) {
      console.warn(`[quote-workflow] retaining wall rate card from price catalog failed (${error.message}); pricing remains blocked`);
    }
  }
  return null;
}

const INGESTIBLE_MIME_PREFIXES = [
  "image/",
  "audio/",
  "text/",
  "application/json",
  "application/pdf",
];
const MAX_INGESTIBLE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

function isIngestibleFile(file) {
  const mime = String(file.mimeType || "").toLowerCase();
  if (!INGESTIBLE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return false;
  if (file.sizeBytes > MAX_INGESTIBLE_SIZE_BYTES) return false;
  return true;
}

async function ingestPendingEvidence({
  jobDir,
  commercialJobDir = null,
  files,
  provenance,
}) {
  for (const file of files || []) {
    const filePath = String(file.filePath || "");
    if (!filePath) continue;

    // Allowlist gate — skip unrecognized or oversized files
    if (!isIngestibleFile(file) && !filePath.startsWith("moasure/raw/")) {
      await markIngested({
        jobDir,
        fileId: file.fileId,
        agentTool: provenance.agentTool || "quote-workflow",
        classifiedAs: "unsupported",
        artifactIds: [],
      });
      continue;
    }

    // Photo classification and audio transcription were removed with field
    // capture. Photos and voice notes stay registered but are not
    // interpreted, exactly as when no model key was configured.
    if (file.mimeType?.startsWith("image/") || file.mimeType?.startsWith("audio/")) {
      continue;
    }

    if (filePath.startsWith("moasure/raw/")) {
      await scanMoasure(jobDir, { provenance, commercialJobDir });
      continue;
    }

    if (file.mimeType?.startsWith("text/") || file.mimeType === "application/json") {
      await ingestTextNoteFile({
        jobDir,
        file,
        provenance,
      });
      continue;
    }
  }
}

async function ingestTextNoteFile({ jobDir, file, provenance }) {
  const absolutePath = resolveJobFilePath(jobDir, file.filePath);
  if (!existsSync(absolutePath)) return;

  const sourceText = await readFile(absolutePath, "utf8");
  const normalizedText = String(sourceText || "").replace(/\r\n/g, "\n").trim();
  if (!normalizedText) return;

  const content = {
    summary: summarizeText(normalizedText),
    extractedText: normalizedText,
    sections: splitTextSections(normalizedText),
    sourceKind: file.mimeType?.startsWith("audio/") ? "voice_note" : "text_note",
  };

  const entry = await appendParsedArtifactEntry({
    jobDir,
    fileName: "structured-notes.json",
    entry: {
      sourceFileId: file.fileId,
      sourceFilePath: file.filePath,
      classifiedAs: "structured_note",
      producedBy: provenance,
      createdAt: new Date().toISOString(),
      content,
    },
  });

  const artifactId = `structured-notes.json#${entry.entryId}`;
  await writeParsedArtifactJson({
    jobDir,
    fileName: "structured-notes.json",
    payload: JSON.parse(await readFile(join(jobDir, "parsed", "structured-notes.json"), "utf8")),
    artifactId,
    artifactType: "structured_notes",
    sourceFileIds: [file.fileId],
    producedBy: provenance,
  });
  await markIngested({
    jobDir,
    fileId: file.fileId,
    agentTool: provenance.agentTool,
    agentSessionId: provenance.agentSessionId,
    llmEngine: provenance.llmEngine,
    classifiedAs: "structured_note",
    artifactIds: [artifactId],
  });
}

function collectAudioSourceFileIds(visibleFiles, meta) {
  const audioFiles = meta?.audioFiles || (meta?.audioFile ? [meta.audioFile] : []);
  return audioFiles
    .map((filePath) => visibleFiles.find((entry) => entry.filePath === filePath)?.fileId || null)
    .filter(Boolean);
}

function collectEvidenceSourceFileIds(visibleFiles) {
  return visibleFiles
    .filter((file) => file.ingested === true || file.filePath.startsWith("moasure/raw/"))
    .map((file) => file.fileId);
}

function splitTextSections(text) {
  const sections = [];
  let current = { heading: "Notes", lines: [] };

  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s+/.test(trimmed)) {
      if (current.lines.length) {
        sections.push({
          heading: current.heading,
          text: current.lines.join("\n"),
        });
      }
      current = {
        heading: trimmed.replace(/^#{1,6}\s+/, "").trim() || "Notes",
        lines: [],
      };
      continue;
    }
    current.lines.push(trimmed);
  }

  if (current.lines.length) {
    sections.push({
      heading: current.heading,
      text: current.lines.join("\n"),
    });
  }

  if (!sections.length && String(text || "").trim()) {
    sections.push({
      heading: "Notes",
      text: String(text || "").trim(),
    });
  }

  return sections;
}

function summarizeText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function normalizeProducedBy(provenance) {
  return {
    agentTool: String(provenance?.agentTool || "unknown").trim() || "unknown",
    llmEngine: String(provenance?.llmEngine || "unknown").trim() || "unknown",
    agentSessionId: String(provenance?.agentSessionId || "").trim() || null,
  };
}

async function ensureQuoteIdentity(meta, jobDir) {
  const quoteCatalogId = resolveQuoteCatalogIdFromMeta(meta);
  const quoteNumber = meta.quoteNumber || await allocateQuoteNumber(jobDir, meta.createdAt, { jobId: meta.id });
  const jobNumber = meta.jobNumber || (() => {
    const m = quoteNumber?.match(/(\d{4}-\d+)/);
    return m ? m[1] : null;
  })();
  return {
    ...meta,
    quoteCatalogId,
    jobNumber,
    quoteNumber,
  };
}

// Quote numbers are allocated one at a time per process. A number is handed
// out well before the build that asked for it writes meta.json, so every
// number handed out is also reserved (number -> job id) for the life of the
// process: a concurrent build cannot be given it, and the same job retrying a
// failed build gets it back instead of burning a new one. Across processes,
// durable storage admits one writer per database (the storage advisory lock in
// ./storage/durable-store.js), so this process is the only allocator there.
let quoteNumberAllocationTail = Promise.resolve();
const reservedQuoteNumbers = new Map();

function withQuoteNumberAllocationLock(operation) {
  const run = quoteNumberAllocationTail.then(operation, operation);
  quoteNumberAllocationTail = run.catch(() => {});
  return run;
}

function parseQuoteNumberSequence(quoteNumber, prefix) {
  const value = typeof quoteNumber === "string" ? quoteNumber.trim() : "";
  if (!value.startsWith(prefix)) return null;
  const seq = Number.parseInt(value.slice(prefix.length), 10);
  return Number.isFinite(seq) ? seq : null;
}

// Every quote number with this prefix already held by a job, mapped to the job
// that holds it. Reads each job's active generation (the root meta.json is
// only a post-commit projection and can lag it), the root copy, and the
// field.db job index.
async function collectUsedQuoteNumbers({ dataDir, yearMonth, prefix }) {
  const used = new Map();
  const note = (quoteNumber, jobId) => {
    if (parseQuoteNumberSequence(quoteNumber, prefix) === null) return;
    const key = quoteNumber.trim();
    if (!used.has(key)) used.set(key, jobId || null);
  };

  const dateDirs = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  for (const dateDir of dateDirs) {
    if (!dateDir.isDirectory() || !dateDir.name.startsWith(yearMonth)) continue;
    const dayDir = join(dataDir, dateDir.name);
    const jobDirs = await readdir(dayDir, { withFileTypes: true }).catch(() => []);
    for (const jobEntry of jobDirs) {
      // Dot folders are staged generations and quarantine; an in-flight
      // build's number is already reserved in this process.
      if (!jobEntry.isDirectory() || jobEntry.name.startsWith(".")) continue;
      const candidateDir = join(dayDir, jobEntry.name);
      try {
        const active = await readJobMeta(candidateDir);
        if (active) note(active.quoteNumber, active.id || jobEntry.name);
      } catch {
        // Skip unreadable meta files while allocating the next quote number.
      }
      try {
        const rootMeta = JSON.parse(await readFile(join(candidateDir, "meta.json"), "utf8"));
        note(rootMeta?.quoteNumber, rootMeta?.id || jobEntry.name);
      } catch {
        // No root copy, or unreadable.
      }
    }
  }

  const db = getFieldDbHandle();
  if (db) {
    try {
      const rows = db.prepare("SELECT id, quote_number FROM jobs WHERE quote_number LIKE ?").all(`${prefix}%`);
      for (const row of rows) note(row.quote_number, row.id);
    } catch (error) {
      console.warn(`[quote-workflow] field.db quote number lookup failed: ${error.message}`);
    }
  }
  return used;
}

export async function allocateQuoteNumber(jobDir, createdAt, { jobId = null } = {}) {
  const created = String(createdAt || new Date().toISOString());
  const yearMonth = created.slice(0, 7);
  const prefix = `EQ-${created.slice(2, 4)}${created.slice(5, 7)}-`;
  // jobDir is a job folder, or a staged generation beside it, inside its date
  // folder: <data>/<YYYY-MM-DD>/<job>.
  const dataDir = join(jobDir, "..", "..");

  return withQuoteNumberAllocationLock(async () => {
    const used = await collectUsedQuoteNumbers({ dataDir, yearMonth, prefix });
    const heldByAnotherJob = (quoteNumber) => {
      const holder = used.get(quoteNumber);
      const reservedFor = reservedQuoteNumbers.get(quoteNumber);
      const takenOnDisk = used.has(quoteNumber) && !(jobId && holder === jobId);
      const takenInProcess = reservedQuoteNumbers.has(quoteNumber) && !(jobId && reservedFor === jobId);
      return takenOnDisk || takenInProcess;
    };

    if (jobId) {
      for (const [reserved, reservedFor] of reservedQuoteNumbers) {
        if (reservedFor === jobId && reserved.startsWith(prefix) && !heldByAnotherJob(reserved)) {
          return reserved;
        }
      }
    }

    let maxSeq = 0;
    for (const quoteNumber of [...used.keys(), ...reservedQuoteNumbers.keys()]) {
      const seq = parseQuoteNumberSequence(quoteNumber, prefix);
      if (seq !== null && seq > maxSeq) maxSeq = seq;
    }
    let candidate;
    do {
      maxSeq += 1;
      candidate = `${prefix}${String(maxSeq).padStart(2, "0")}`;
    } while (heldByAnotherJob(candidate));
    reservedQuoteNumbers.set(candidate, jobId || `unassigned:${randomUUID()}`);
    return candidate;
  });
}
