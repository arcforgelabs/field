import { existsSync } from "./storage/fs.js";
import { readFile, writeFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { canTransitionPipelineStage, isPipelineSent, normalizePipelineStage, PIPELINE_STAGES } from "./pipeline.js";
import {
  applyMilestoneInvoiceCompatFields,
  assertMilestoneScheduleWithinQuoteTotal,
  buildMilestoneInvoices,
  findMilestoneInvoice,
  getJobDocumentLabel,
  isMilestoneInvoiceIssued,
  markMilestoneInvoiceUnsent,
  markMilestoneInvoiceUnpaid,
  normalizePaymentSchedule,
  normalizeStoredMilestoneInvoices,
  prepareRequestedJobDocument,
  recordMilestoneInvoicePayment,
  resolveJobDocumentType,
  resolveRequestedMilestoneInvoice,
  sumActiveMilestonePayments,
  updateMilestoneInvoice,
  validateInvoicePaidAmount,
  voidMilestoneInvoicePayment,
} from "./job-documents.js";
import { buildAndPersistQuote, buildQuoteInStagedGeneration, readQuoteOverrides } from "./quote-workflow.js";
import { findSentMessageByDeliveryAttempt, sendQuoteEmail } from "./send-quote-email.js";
import { appendSentEmailArchive } from "./sent-email-archive.js";
import { appendJobActivity, listOpenSendBlockingGaps, readJobState } from "./job-state.js";
import { generateEvidenceQuoteMarkdown } from "./generate-evidence-quote.js";
import {
  buildQuotePdfFilename,
  deleteMilestoneReceiptArtifact,
  generateQuotePdfBuffer,
  listQuoteVersions,
  parseQuoteVersion,
  readQuoteArtifacts,
  writeMilestoneInvoiceArtifact,
  writeMilestoneReceiptArtifact,
  writeQuoteArtifacts,
} from "./quote-artifacts.js";
import { projectQuoteForReviewState } from "./quote-review-projection.js";
import { applyPresentationToQuote, getCustomerPresentationFinancials } from "./quote-presentation.js";
import { applyQuoteIdentity } from "./quote-identity.js";
import { assertQuoteLineItemCostsComplete, assertQuotePricingSendable } from "./quote-pricing-attestation.js";
import { canonicalizeQuoteOverrides, mergeCommercialAdjustments, mergePresentationOverrides } from "./quote-commercial-adjustments.js";
import { buildQuoteEditPolicy, shouldForkQuoteMutation } from "./quote-edit-policy.js";
import { queueStagedPostCommit, runAtomicJobGeneration } from "./job-generation.js";
import { recordIssuedQuoteDocuments } from "./quote-issuance.js";
import { buildQuoteSnapshotRecord } from "./quote-snapshots.js";
import { recordDeliveredDocument, recordFailedDelivery } from "./documents/delivery.js";
import { quoteRowRecorder } from "./quotes/recorder.js";
import { quoteRowsFromArtifact } from "./quotes/read-model.js";
import { issuedDocumentRecorder } from "./documents/recorder.js";
import { applyQuoteCatalogChanges, computeQuoteCatalogChanges, upgradeOrganizerCatalogLinks } from "./quote-catalog-sync.js";
import {
  buildQuoteDeliveryAttempt,
  claimPendingQuoteDelivery,
  decodeQuoteDeliveryArtifacts,
  persistPendingQuoteDelivery,
  readPendingQuoteDelivery,
  updatePendingQuoteDelivery,
  QUOTE_DELIVERY_OUTBOX_FILE,
} from "./quote-delivery-outbox.js";
import {
  recordQuoteLanded,
  recordQuoteCustomerVersionAccepted,
  recordQuotePipelineStageChange,
  readQuoteLifecycle,
  recordQuoteCorrections,
  recordQuoteLockStatusChange,
  recordQuoteSent,
} from "./quote-lifecycle.js";
import { readDocumentQuoteArtifacts, readSelectedReportMarkdown } from "./job-document-context.js";
import { hydrateJobMeta, writeJobMeta } from "./job-meta-store.js";
import {
  buildInvoiceRevisionFingerprint,
  describeInvoiceRevisionChange,
} from "./invoice-revisions.js";
import {
  ARTIFACT_STATE,
  artifactIsStored,
  deriveArtifactState,
  transitionArtifactState,
} from "./invoice-artifact-state.js";

export async function updateJobQuote({
  jobDir,
  meta,
  config,
  provenance = null,
  patch = {},
  actor = null,
  buildReason = "quote_update",
  forceForkSentQuote = null,
  forceRebuild = false,
}) {
  const existingOverrides = canonicalizeQuoteOverrides(await readQuoteOverrides(jobDir)) || {};
  const historicalQuoteLifecycle = await readQuoteLifecycle(jobDir);
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  const nextPaymentSchedule = patch.paymentSchedule != null
    ? normalizePaymentSchedule(patch.paymentSchedule)
    : null;
  // Authoring-time guard (DEL-30 P2-3): this is operator INPUT arriving
  // through a quote-update patch, not a rebuild — reject a schedule whose
  // fixed dollar amounts already exceed the (pre-patch) quote total outright
  // rather than letting the rebuild pro-rate it silently. Approximate when
  // line items change in the very same patch (the total used here predates
  // that change), but the common case this closes is an operator typing
  // fixed amounts that already exceed the quote as it stands.
  if (nextPaymentSchedule && currentArtifacts?.quote) {
    assertMilestoneScheduleWithinQuoteTotal({
      paymentSchedule: nextPaymentSchedule,
      quoteTotal: getCustomerPresentationFinancials(currentArtifacts.quote).total,
    });
  }
  assertMilestoneScheduleMutationAllowed({ meta, paymentSchedule: nextPaymentSchedule });
  patch = await upgradePatchCatalogLinks(patch, config);
  const normalizedPatch = canonicalizeQuoteOverrides({
    lineItems: patch.lineItems,
    commercialAdjustments: patch.commercialAdjustments,
    assumptions: patch.assumptions,
    presentation: patch.presentation,
    optionSelections: patch.optionSelections,
    acceptedOptionSelections: patch.acceptedOptionSelections,
    execution: patch.execution,
    lockStatus: patch.lockStatus,
    finalizedAt: patch.finalizedAt,
  }) || {};

  const nextExecution = mergeExecutionOverrides(existingOverrides?.execution, patch.execution);
  const nextCommercialAdjustments = mergeCommercialAdjustments(
    existingOverrides?.commercialAdjustments,
    normalizedPatch?.commercialAdjustments
  );
  const nextPresentation = mergePresentationOverrides(
    existingOverrides?.presentation,
    normalizedPatch?.presentation
  );
  const nextLockStatus = patch.lockStatus === "final"
    ? "final"
    : patch.lockStatus === "draft"
      ? "draft"
      : (existingOverrides?.lockStatus || existingOverrides?.deliveryStatus || "draft");
  let nextOverrides = {
    ...(existingOverrides || {}),
    lineItems: mergeOverrideEntries(existingOverrides?.lineItems, normalizedPatch?.lineItems),
    assumptions: mergeOverrideEntries(existingOverrides?.assumptions, patch.assumptions),
    commercialAdjustments: nextCommercialAdjustments,
    presentation: nextPresentation,
    optionSelections: mergeOptionSelectionOverrides(existingOverrides?.optionSelections, patch.optionSelections),
    acceptedOptionSelections: mergeOptionSelectionOverrides(existingOverrides?.acceptedOptionSelections, patch.acceptedOptionSelections),
    execution: nextExecution,
    lockStatus: nextLockStatus,
    finalizedAt: nextLockStatus === "final"
      ? (existingOverrides?.finalizedAt || new Date().toISOString())
      : null,
  };
  const currentQuoteVersion = Number(
    currentArtifacts?.quote?.version
    || meta?.quoteVersion
    || 1
  );
  const mutationTouchesQuote =
    patch.lockStatus === "draft"
    || Boolean(patch.lineItems && Object.keys(patch.lineItems).length)
    || Boolean(normalizedPatch?.commercialAdjustments?.length)
    || Boolean(patch.assumptions && Object.keys(patch.assumptions).length)
    || Boolean(patch.presentation && Object.keys(patch.presentation).length)
    || Boolean(patch.optionSelections && Object.keys(patch.optionSelections).length)
    || Boolean(patch.acceptedOptionSelections && Object.keys(patch.acceptedOptionSelections).length)
    || Boolean(patch.execution && Object.keys(patch.execution).length)
    || Boolean(nextPaymentSchedule);
  const forkSentQuote =
    typeof forceForkSentQuote === "boolean"
      ? forceForkSentQuote
      : (mutationTouchesQuote && shouldForkQuoteMutation({
          meta,
          quoteLifecycle: historicalQuoteLifecycle,
          currentQuoteVersion,
        }));

  if (forkSentQuote) {
    nextOverrides = {
      ...nextOverrides,
      lockStatus: "draft",
      finalizedAt: null,
    };
  }

  if (!nextOverrides.presentation) delete nextOverrides.presentation;

  // DEL-30 (P0-1/P2-2): a patch whose only quote-relevant content is
  // lockStatus is a delivery-state change, not a re-price — route it through
  // persistCurrentQuoteLockArtifacts (below), which flips the lock flag and
  // rewrites artifacts WITHOUT re-running buildAndPersistQuote's pricing
  // pipeline. But only when it does not need to fork: unlocking a quote that
  // has already been sent to the customer must still fork a new draft
  // version via the general rebuild path below (mirroring master), or
  // unlocking would rewrite the customer-seen version's artifacts in place
  // and destroy the record of what they were actually sent. forkSentQuote
  // above already carries that decision (mutationTouchesQuote treats
  // lockStatus "draft" as touching the quote, same as master).
  // forceRebuild separately opts out for regenerateRecordingQuote, which
  // feeds back the existing overrides as patch content specifically to force
  // a full rebuild against possibly-changed transcript/evidence even when
  // that content is empty — shape alone can't distinguish that intent from a
  // genuine lock-only patch.
  if (!forceRebuild && !forkSentQuote && isLockStatusOnlyPatch(patch, normalizedPatch, nextPaymentSchedule)) {
    return await updateQuoteLockStatusOnly({
      jobDir,
      meta,
      actor,
      lockStatus: nextLockStatus,
    });
  }

  const hasRebuildInputs = existsSync(join(jobDir, "transcript.json")) && existsSync(join(jobDir, "quote-inputs.json"));
  if (isPresentationOnlyPatch(patch, normalizedPatch, nextPaymentSchedule) && !forkSentQuote && !hasRebuildInputs) {
    if (presentationPatchTouchesMonetaryOutput(normalizedPatch?.presentation)) {
      throw createJobActionError(
        "fresh quote inputs are required before changing monetary presentation or payment terms",
        409,
      );
    }
    return await updateQuotePresentationOnly({
      jobDir,
      meta,
      actor,
      nextOverrides,
      paymentSchedule: nextPaymentSchedule,
      changedPresentation: Boolean(normalizedPatch?.presentation),
      changedPaymentSchedule: Boolean(nextPaymentSchedule),
    });
  }

  const transcriptPath = join(jobDir, "transcript.json");
  const quoteInputsPath = join(jobDir, "quote-inputs.json");
  if (!existsSync(transcriptPath) || !existsSync(quoteInputsPath)) {
    throw new Error("quote inputs not generated");
  }

  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  const quoteInputs = JSON.parse(await readFile(quoteInputsPath, "utf8"));

  const persisted = await buildAndPersistQuote({
    jobDir,
    meta: nextPaymentSchedule ? { ...meta, paymentSchedule: nextPaymentSchedule } : meta,
    transcript,
    quoteInputs,
    config,
    provenance,
    overrides: nextOverrides,
    forkSentQuote,
    buildReason,
  });
  const lineItemCorrectionCount = (patch.lineItems ? Object.keys(patch.lineItems).length : 0)
    + (normalizedPatch?.commercialAdjustments?.length || 0);
  const assumptionCorrectionCount = patch.assumptions ? Object.keys(patch.assumptions).length : 0;

  const changes = [];
  if (patch.lockStatus) changes.push(`lock status set to ${patch.lockStatus}`);
  if (patch.lineItems && Object.keys(patch.lineItems).length) changes.push(`${Object.keys(patch.lineItems).length} line item(s) updated`);
  if (normalizedPatch?.commercialAdjustments?.length) changes.push(`${normalizedPatch.commercialAdjustments.length} commercial adjustment(s) updated`);
  if (patch.assumptions && Object.keys(patch.assumptions).length) changes.push(`${Object.keys(patch.assumptions).length} assumption(s) updated`);
  if (patch.presentation && Object.keys(patch.presentation).length) changes.push("customer-facing presentation updated");
  if (nextPaymentSchedule) changes.push("payment schedule updated");
  if (patch.optionSelections && Object.keys(patch.optionSelections).length) changes.push(`${Object.keys(patch.optionSelections).length} option selection(s) updated`);
  if (patch.acceptedOptionSelections && Object.keys(patch.acceptedOptionSelections).length) changes.push(`${Object.keys(patch.acceptedOptionSelections).length} accepted option selection(s) updated`);
  if (patch.execution && typeof patch.execution === "object") changes.push("execution overrides updated");

  const quoteLifecycle = await runAtomicJobGeneration(jobDir, async (stagedJobDir) => {
    let nextLifecycle = persisted.quoteLifecycle || null;
    if (lineItemCorrectionCount || assumptionCorrectionCount) {
      nextLifecycle = await recordQuoteCorrections({
        jobDir: stagedJobDir,
        lineItemCount: lineItemCorrectionCount,
        assumptionCount: assumptionCorrectionCount,
        actor,
      });
    }
    if (patch.lockStatus) {
      nextLifecycle = await recordQuoteLockStatusChange({
        jobDir: stagedJobDir,
        lockStatus: patch.lockStatus,
      });
    }
    if (actor) {
      await appendJobActivity({
      jobDir: stagedJobDir,
      activity: {
        kind: "quote.updated",
        ts: new Date().toISOString(),
        actor,
        title: "Quote updated",
        body: changes.join(", ") || "Quote regenerated",
      },
      });
    }
    return nextLifecycle;
  });

  return {
    ...persisted,
    quoteOverrides: nextOverrides,
    quoteLifecycle: quoteLifecycle || await readQuoteLifecycle(jobDir),
  };
}

// Rows linked to the catalogue by code only (saved before uids) get the
// item's uid recorded the next time the organizer is saved (#148), so a later
// code edit in the catalogue cannot break their link. Nothing else changes.
async function upgradePatchCatalogLinks(patch, config) {
  const organizer = patch?.presentation?.organizer;
  if (!organizer || !config?.priceCatalog?.getState) return patch;
  let state;
  try {
    state = await config.priceCatalog.getState();
  } catch {
    return patch;
  }
  const upgraded = upgradeOrganizerCatalogLinks({ state, organizer });
  if (!upgraded.upgraded) return patch;
  return { ...patch, presentation: { ...patch.presentation, organizer: upgraded.organizer } };
}

function requireQuoteCatalogStore(config) {
  if (config?.priceCatalog?.getState) return config.priceCatalog;
  throw createJobActionError("the price catalogue is unavailable, so catalogue changes cannot be checked", 503);
}

async function readJobQuoteCatalogContext({ jobDir, meta }) {
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  if (!currentArtifacts?.quote) throw createJobActionError("quote not generated", 404);
  const overrides = canonicalizeQuoteOverrides(await readQuoteOverrides(jobDir)) || {};
  const policy = buildQuoteEditPolicy({
    meta,
    quoteLifecycle: await readQuoteLifecycle(jobDir),
    latestVersion: currentArtifacts.quote.version || meta?.quoteVersion || null,
  });
  return {
    quoteVersion: currentArtifacts.quote.version || meta?.quoteVersion || null,
    organizer: overrides?.presentation?.organizer || null,
    locked: Boolean(policy.latestVersionLocked),
    lockReason: policy.latestVersionLocked
      ? "This quote has been sent and is locked; its prices never change. Catalogue changes apply to a new draft revision."
      : null,
  };
}

/**
 * What changed in the catalogue for a job's quote rows (#148): for the
 * organizer the caller is editing (`organizer`), else the saved one. A sent
 * (locked) quote is reported with `locked: true`; its rows are never changed.
 */
export async function readJobQuoteCatalogChanges({ jobDir, meta, config, organizer = null }) {
  const store = requireQuoteCatalogStore(config);
  const context = await readJobQuoteCatalogContext({ jobDir, meta });
  const state = await store.getState();
  const target = organizer || context.organizer || { root: [], nodes: {} };
  const changes = computeQuoteCatalogChanges({ state, organizer: target });
  return {
    ...changes,
    source: organizer ? "draft" : "saved",
    quoteVersion: context.quoteVersion,
    locked: context.locked,
    lockReason: context.lockReason,
  };
}

function quoteLockedError(message) {
  const error = createJobActionError(message, 409);
  error.code = "QUOTE_LOCKED";
  return error;
}

/**
 * Apply catalogue changes to quote rows (`nodeIds`, or every applicable row).
 *
 * With `organizer` (the editor's unsaved draft) the result is returned and
 * nothing is saved; the editor saves it like any other edit. Without it, the
 * saved organizer is changed and saved as a quote update, which a sent
 * (locked) quote refuses with QUOTE_LOCKED: sent quotes never change.
 * `expectedCatalogVersion` (the version the operator reviewed) is refused
 * with CATALOG_CHANGED when the catalogue has moved since. `reviewed` (row id
 * → the `reviewKey` the operator's check listed it with) skips any row edited
 * since that check; without it an overridden row is skipped unless
 * `replaceEdits` is true (see applyQuoteCatalogChanges).
 */
export async function applyJobQuoteCatalogChanges({
  jobDir,
  meta,
  config,
  organizer = null,
  nodeIds = null,
  defaultOnly = false,
  reviewed = null,
  replaceEdits = false,
  expectedCatalogVersion = null,
  provenance = null,
  actor = null,
}) {
  const store = requireQuoteCatalogStore(config);
  const context = await readJobQuoteCatalogContext({ jobDir, meta });
  if (!organizer && context.locked) {
    throw quoteLockedError(context.lockReason);
  }
  const state = await store.getState();
  if (expectedCatalogVersion != null && Number(expectedCatalogVersion) !== Number(state.version)) {
    const error = createJobActionError(
      `the catalogue changed since these changes were listed (version ${expectedCatalogVersion}, now ${state.version}); review them again`,
      409,
    );
    error.code = "CATALOG_CHANGED";
    throw error;
  }
  const target = organizer || context.organizer || { root: [], nodes: {} };
  const result = applyQuoteCatalogChanges({ state, organizer: target, nodeIds, defaultOnly, reviewed, replaceEdits });
  const remaining = computeQuoteCatalogChanges({ state, organizer: result.organizer });
  if (organizer) {
    return { ...result, changes: remaining, saved: false, quoteVersion: context.quoteVersion, locked: context.locked };
  }
  if (!result.applied.length) {
    return { ...result, changes: remaining, saved: false, quoteVersion: context.quoteVersion, locked: false };
  }
  const persisted = await updateJobQuote({
    jobDir,
    meta,
    config,
    provenance,
    actor,
    patch: { presentation: { organizer: result.organizer } },
    buildReason: "quote_catalog_refresh",
  });
  return {
    ...result,
    changes: remaining,
    saved: true,
    quoteVersion: persisted?.quote?.version || context.quoteVersion,
    locked: false,
    persisted,
  };
}

async function updateQuotePresentationOnly({
  jobDir,
  meta = null,
  actor = null,
  nextOverrides = null,
  paymentSchedule = null,
  changedPresentation = false,
  changedPaymentSchedule = false,
}) {
  return runAtomicJobGeneration(jobDir, (stagedJobDir) => updateQuotePresentationOnlyInPlace({
    jobDir: stagedJobDir,
    meta,
    actor,
    nextOverrides,
    paymentSchedule,
    changedPresentation,
    changedPaymentSchedule,
  }));
}

async function updateQuotePresentationOnlyInPlace({
  jobDir,
  meta,
  actor = null,
  nextOverrides = null,
  paymentSchedule = null,
  changedPresentation = false,
  changedPaymentSchedule = false,
}) {
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  if (!currentArtifacts?.quote) {
    // DEL-30 (P3-2): use the shared 404 helper (readPersistedQuote below
    // already does) instead of a bare Error, which surfaces as a 500.
    throw createJobActionError("quote not generated", 404);
  }
  assertMilestoneScheduleMutationAllowed({ meta, paymentSchedule });

  const presentationApplied = applyPresentationToQuote({
    quote: currentArtifacts.quote,
    overrides: nextOverrides,
    defaultScopeText: currentArtifacts.quote.summary || null,
    preferDefaultScopeText: true,
  });
  const identityApplied = applyQuoteIdentity({
    meta,
    quote: presentationApplied,
    overrides: nextOverrides,
  });
  const nextQuote = identityApplied.quote;
  const currentPipelineStage = normalizePipelineStage(meta?.pipelineStage || meta?.deliveryStatus);
  const nextMeta = {
    ...meta,
    ...(paymentSchedule ? { paymentSchedule } : {}),
    pipelineStage: currentPipelineStage,
    quoteReviewStatus: nextQuote.review?.status || nextQuote.status,
    quoteStatus: "complete",
    quoteLineItemCount: nextQuote.lineItems?.length || 0,
    // The job's cached totals (the job list) come from the quote's rows (#245).
    quoteSubtotal: quoteRowsFromArtifact({ quote: nextQuote, meta }).financials.subtotal || 0,
    quoteTotal: quoteRowsFromArtifact({ quote: nextQuote, meta }).financials.total || nextQuote.totals?.total || 0,
    quoteVersion: nextQuote.version || meta.quoteVersion || currentArtifacts.version || 1,
    deliveryStatus: currentPipelineStage,
    quoteIdentity: identityApplied.meta.quoteIdentity,
  };
  const quoteMarkdown = generateEvidenceQuoteMarkdown({
    meta: nextMeta,
    quote: nextQuote,
  });

  await writeQuoteArtifacts({
    jobDir,
    meta: nextMeta,
    quote: nextQuote,
    quoteMarkdown,
    quoteOverrides: nextOverrides,
    quoteBreakdownSource: currentArtifacts.quoteBreakdownSource ?? null,
  });
  const persistedMeta = await writePersistedMeta(jobDir, nextMeta);

  if (actor) {
    await appendJobActivity({
      jobDir,
      activity: {
        kind: "quote.updated",
        ts: new Date().toISOString(),
        actor,
        title: "Quote updated",
        body: buildPresentationOnlyActivityBody({ changedPresentation, changedPaymentSchedule }),
      },
    });
  }

  return {
    meta: persistedMeta,
    quote: nextQuote,
    quoteMarkdown,
    quoteVersions: await listQuoteVersions(jobDir),
    quoteOverrides: nextOverrides,
    quoteLifecycle: await readQuoteLifecycle(jobDir),
  };
}

async function persistCurrentQuoteLockArtifacts({
  jobDir,
  meta,
  quote = null,
  lockStatus,
  finalizedAt = null,
}) {
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  const baseQuote = quote || currentArtifacts?.quote || null;
  if (!baseQuote) {
    return {
      meta,
      quote: null,
      quoteMarkdown: null,
      quoteOverrides: canonicalizeQuoteOverrides(await readQuoteOverrides(jobDir)) || null,
    };
  }

  const existingOverrides = canonicalizeQuoteOverrides(
    currentArtifacts.quoteOverrides || await readQuoteOverrides(jobDir)
  ) || {};
  const nextFinalizedAt = lockStatus === "final"
    ? (finalizedAt || existingOverrides?.finalizedAt || currentArtifacts.quote?.delivery?.finalizedAt || new Date().toISOString())
    : null;
  const nextOverrides = {
    ...(existingOverrides || {}),
    lockStatus,
    finalizedAt: nextFinalizedAt,
  };
  if (!nextOverrides.presentation) delete nextOverrides.presentation;

  const nextQuote = {
    ...baseQuote,
    delivery: {
      ...(baseQuote.delivery || {}),
      status: lockStatus === "final" ? "final" : "draft",
      finalizedAt: nextFinalizedAt,
    },
  };
  const identityApplied = applyQuoteIdentity({
    meta,
    quote: nextQuote,
    overrides: nextOverrides,
  });
  const nextMeta = {
    ...meta,
    quoteReviewStatus: identityApplied.quote.review?.status || identityApplied.quote.status || meta?.quoteReviewStatus || null,
    quoteStatus: "complete",
    quoteLineItemCount: identityApplied.quote.lineItems?.length || 0,
    quoteSubtotal: quoteRowsFromArtifact({ quote: identityApplied.quote, meta }).financials.subtotal || 0,
    quoteTotal: quoteRowsFromArtifact({ quote: identityApplied.quote, meta }).financials.total || identityApplied.quote.totals?.total || 0,
    quoteVersion: identityApplied.quote.version || meta?.quoteVersion || currentArtifacts?.version || 1,
    quoteIdentity: identityApplied.meta.quoteIdentity,
  };
  const quoteMarkdown = generateEvidenceQuoteMarkdown({
    meta: nextMeta,
    quote: identityApplied.quote,
  });

  await writeQuoteArtifacts({
    jobDir,
    meta: nextMeta,
    quote: identityApplied.quote,
    quoteMarkdown,
    quoteOverrides: nextOverrides,
    quoteBreakdownSource: currentArtifacts.quoteBreakdownSource ?? null,
  });

  return {
    meta: nextMeta,
    quote: identityApplied.quote,
    quoteMarkdown,
    quoteOverrides: nextOverrides,
  };
}

function isPresentationOnlyPatch(patch = {}, normalizedPatch = {}, normalizedPaymentSchedule = null) {
  return (Boolean(normalizedPatch?.presentation) || Boolean(normalizedPaymentSchedule))
    && !Object.keys(normalizedPatch?.lineItems || {}).length
    && !(normalizedPatch?.commercialAdjustments || []).length
    && !Object.keys(normalizedPatch?.assumptions || {}).length
    && !Object.keys(normalizedPatch?.optionSelections || {}).length
    && !Object.keys(normalizedPatch?.acceptedOptionSelections || {}).length
    && !normalizedPatch?.execution
    && !patch?.lockStatus
    && !patch?.deliveryStatus;
}

function presentationPatchTouchesMonetaryOutput(value, key = "") {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((entry) => presentationPatchTouchesMonetaryOutput(entry, key));
  if (typeof value !== "object") return /(?:charge|cost|discount|gst|markup|price|quantity|rate|subtotal|tax|total|buying|selling|sell|unitCost|totalCost|unitPrice|totalPrice|priceOverride|costOverride)/i.test(key);
  return Object.entries(value).some(([childKey, childValue]) => (
    /(?:charge|cost|discount|gst|markup|price|quantity|rate|subtotal|tax|total|buying|selling|sell|unitCost|totalCost|unitPrice|totalPrice|priceOverride|costOverride)/i.test(childKey)
      || presentationPatchTouchesMonetaryOutput(childValue, childKey)
  ));
}

// DEL-30 (P0-1): true only when the patch's sole quote-relevant content is
// lockStatus — no line items, commercial adjustments, assumptions,
// presentation, option selections, execution overrides, or payment schedule.
// A patch that mixes lockStatus with any real quote edit must still take the
// normal rebuild/fork path so those edits are actually applied.
function isLockStatusOnlyPatch(patch = {}, normalizedPatch = {}, normalizedPaymentSchedule = null) {
  return Boolean(patch?.lockStatus)
    && !Object.keys(normalizedPatch?.lineItems || {}).length
    && !(normalizedPatch?.commercialAdjustments || []).length
    && !Object.keys(normalizedPatch?.assumptions || {}).length
    && !normalizedPatch?.presentation
    && !Object.keys(normalizedPatch?.optionSelections || {}).length
    && !Object.keys(normalizedPatch?.acceptedOptionSelections || {}).length
    && !normalizedPatch?.execution
    && !normalizedPaymentSchedule;
}

async function updateQuoteLockStatusOnly({
  jobDir,
  meta = null,
  actor = null,
  lockStatus,
}) {
  return runAtomicJobGeneration(jobDir, (stagedJobDir) => updateQuoteLockStatusOnlyInPlace({
    jobDir: stagedJobDir,
    meta,
    actor,
    lockStatus,
  }));
}

async function updateQuoteLockStatusOnlyInPlace({
  jobDir,
  meta,
  actor = null,
  lockStatus,
}) {
  // DEL-30 (P3-1): fail cleanly before any write when there is nothing to
  // lock, mirroring updateQuotePresentationOnly's own precondition above.
  // Without this, persistCurrentQuoteLockArtifacts's no-quote early return
  // (quote: null) let this function carry on writing a lock-lifecycle
  // record and activity entry for a quote that doesn't exist, only to have
  // the caller crash later dereferencing a null quote — a half-succeeded
  // mutation followed by a 500, instead of a clean rejection.
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  if (!currentArtifacts?.quote) {
    // DEL-30 (P3-2): the shared 404 helper, not a bare Error (-> 500).
    throw createJobActionError("quote not generated", 404);
  }
  const finalizedArtifacts = await persistCurrentQuoteLockArtifacts({
    jobDir,
    meta,
    lockStatus,
  });
  const persistedMeta = await writePersistedMeta(jobDir, finalizedArtifacts.meta);
  const quoteLifecycle = await recordQuoteLockStatusChange({
    jobDir,
    lockStatus,
  });

  if (actor) {
    await appendJobActivity({
      jobDir,
      activity: {
        kind: "quote.updated",
        ts: new Date().toISOString(),
        actor,
        title: "Quote updated",
        body: `lock status set to ${lockStatus}`,
      },
    });
  }

  return {
    meta: persistedMeta,
    quote: finalizedArtifacts.quote,
    quoteMarkdown: finalizedArtifacts.quoteMarkdown,
    quoteVersions: await listQuoteVersions(jobDir),
    quoteOverrides: finalizedArtifacts.quoteOverrides,
    quoteLifecycle,
  };
}

function buildPresentationOnlyActivityBody({
  changedPresentation = false,
  changedPaymentSchedule = false,
} = {}) {
  if (changedPresentation && changedPaymentSchedule) {
    return "Customer-facing presentation and payment schedule updated";
  }
  if (changedPaymentSchedule) return "Payment schedule updated";
  return "Customer-facing presentation updated";
}

export async function regenerateRecordingQuote({
  jobDir,
  meta,
  config,
  provenance = null,
  actor = null,
  buildReason = "quote_regenerate",
  forceForkSentQuote = null,
  inExistingGeneration = false,
  transcript: suppliedTranscript = null,
  quoteInputs: suppliedQuoteInputs = null,
  contextSnapshot = null,
  moasureSummary = undefined,
  operationalJobDir = null,
}) {
  const existingOverrides = await readQuoteOverrides(jobDir);
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  const currentQuoteLifecycle = await readQuoteLifecycle(jobDir);
  const currentQuoteVersion = Number(
    currentArtifacts?.quote?.version
    || meta?.quoteVersion
    || 1
  );
  const shouldForkHistoricallySentQuote =
    typeof forceForkSentQuote === "boolean"
      ? forceForkSentQuote
      : shouldForkQuoteMutation({
          meta,
          quoteLifecycle: currentQuoteLifecycle,
          currentQuoteVersion,
  });
  if (inExistingGeneration) {
    const transcriptPath = join(jobDir, "transcript.json");
    const quoteInputsPath = join(jobDir, "quote-inputs.json");
    if ((!suppliedTranscript && !existsSync(transcriptPath)) || (!suppliedQuoteInputs && !existsSync(quoteInputsPath))) {
      throw createJobActionError("quote inputs not generated", 409);
    }
    return buildQuoteInStagedGeneration({
      jobDir,
      operationalJobDir,
      meta,
      transcript: suppliedTranscript || JSON.parse(await readFile(transcriptPath, "utf8")),
      quoteInputs: suppliedQuoteInputs || JSON.parse(await readFile(quoteInputsPath, "utf8")),
      config,
      provenance,
      overrides: {
        ...existingOverrides,
        lockStatus: shouldForkHistoricallySentQuote
          ? "draft"
          : ((existingOverrides?.lockStatus || existingOverrides?.deliveryStatus) === "final" ? "final" : "draft"),
      },
      forkSentQuote: shouldForkHistoricallySentQuote,
      buildReason,
      contextSnapshot,
      moasureSummaryOverride: moasureSummary,
    });
  }
  return await updateJobQuote({
    jobDir,
    meta,
    config,
    provenance,
    buildReason,
    forceForkSentQuote: shouldForkHistoricallySentQuote,
    forceRebuild: true,
    patch: {
      lineItems: existingOverrides?.lineItems || {},
      assumptions: existingOverrides?.assumptions || {},
      lockStatus: shouldForkHistoricallySentQuote
        ? "draft"
        : ((existingOverrides?.lockStatus || existingOverrides?.deliveryStatus) === "final" ? "final" : "draft"),
    },
    actor,
  });
}

function createJobActionError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

async function readPersistedQuote(jobDir, versionRef = null) {
  const artifacts = await readQuoteArtifacts(jobDir, versionRef);
  if (!artifacts?.quote) {
    throw createJobActionError("quote not generated", 404);
  }
  return artifacts.quote;
}

function hasMilestoneInvoiceActivity(milestoneInvoices = []) {
  return (Array.isArray(milestoneInvoices) ? milestoneInvoices : []).some((milestoneInvoice) => (
    Boolean(milestoneInvoice?.issuedAt)
    || Number(milestoneInvoice?.amountPaid || 0) > 0
    || Number(milestoneInvoice?.amountDue || 0) <= 0
    || Array.isArray(milestoneInvoice?.payments) && milestoneInvoice.payments.length > 0
    || milestoneInvoice?.status === "authorised"
    || milestoneInvoice?.status === "paid"
  ));
}

function normalizeCurrentMilestoneSchedule(meta = null) {
  if (meta?.paymentSchedule) {
    return normalizePaymentSchedule(meta.paymentSchedule);
  }
  const milestoneInvoices = normalizeStoredMilestoneInvoices(meta?.milestoneInvoices || []);
  if (!milestoneInvoices.length) return null;
  return {
    milestones: milestoneInvoices.map((milestoneInvoice, index) => ({
      label: milestoneInvoice.milestoneLabel || `Milestone ${index + 1}`,
      percentage: roundMoney(milestoneInvoice.percentage),
      ...(Number(milestoneInvoice.fixedTotal || 0) > 0 ? { fixedTotal: roundMoney(milestoneInvoice.fixedTotal) } : {}),
    })),
  };
}

function normalizeScheduleForComparison(schedule) {
  if (!schedule) return null;
  return JSON.stringify(normalizePaymentSchedule(schedule));
}

function assertMilestoneScheduleMutationAllowed({
  meta,
  paymentSchedule = null,
}) {
  if (!paymentSchedule) return;
  const milestoneInvoices = normalizeStoredMilestoneInvoices(meta?.milestoneInvoices || []);
  if (!milestoneInvoices.length || !hasMilestoneInvoiceActivity(milestoneInvoices)) return;

  const currentScheduleSnapshot = normalizeCurrentMilestoneSchedule(meta);
  const currentSchedule = normalizeScheduleForComparison(currentScheduleSnapshot);
  const nextScheduleSnapshot = normalizePaymentSchedule(paymentSchedule);
  const nextSchedule = JSON.stringify(nextScheduleSnapshot);
  if (currentSchedule === nextSchedule) return;

  let lockedPrefixCount = 0;
  while (lockedPrefixCount < milestoneInvoices.length && hasMilestoneInvoiceActivity([milestoneInvoices[lockedPrefixCount]])) {
    lockedPrefixCount += 1;
  }
  const hasLockedMilestoneOutsidePrefix = milestoneInvoices
    .slice(lockedPrefixCount)
    .some((milestoneInvoice) => hasMilestoneInvoiceActivity([milestoneInvoice]));
  if (hasLockedMilestoneOutsidePrefix) {
    throw createJobActionError(
      "cannot reshape the payment schedule once a later milestone invoice has already been sent or paid",
      409,
    );
  }

  const currentMilestones = currentScheduleSnapshot?.milestones || [];
  const nextMilestones = nextScheduleSnapshot?.milestones || [];
  for (let index = 0; index < lockedPrefixCount; index += 1) {
    const currentMilestone = currentMilestones[index] || null;
    const nextMilestone = nextMilestones[index] || null;
    if (
      !currentMilestone
      || !nextMilestone
      || currentMilestone.label !== nextMilestone.label
      || roundMoney(currentMilestone.percentage) !== roundMoney(nextMilestone.percentage)
      || roundMoney(currentMilestone.fixedTotal || 0) !== roundMoney(nextMilestone.fixedTotal || 0)
      || (currentMilestone.dueDays ?? null) !== (nextMilestone.dueDays ?? null)
    ) {
      throw createJobActionError(
        "locked milestone invoices must keep their existing labels and percentages",
        409,
      );
    }
  }
  return;
}

async function writePersistedMeta(jobDir, meta) {
  return await writeJobMeta(jobDir, meta);
}

async function persistMilestoneInvoiceState({
  jobDir,
  meta,
  quote,
  paymentSchedule = null,
  milestoneInvoices = [],
  artifactMilestoneIndex = null,
  // Requests every milestone's artifact captured this pass, including a
  // draft's preview render — a sweep convenience, e.g. previewing every
  // milestone up front right after generating a schedule. It used to ALSO
  // broaden the *explicit* (fail-loud) target set to every milestone; that
  // was the wrong signal (DEL-30 P2-2). The caller's actual intent is
  // `artifactMilestoneIndex` — every `writeAllArtifacts` entry is implicit
  // regardless, same as the unconditional not-yet-stored sweep below.
  writeAllArtifacts = false,
} = {}) {
  let nextMeta = applyMilestoneInvoiceCompatFields({
    ...meta,
    ...(paymentSchedule ? { paymentSchedule } : {}),
    milestoneInvoices,
  });

  let milestoneInvoice = artifactMilestoneIndex == null
    ? null
    : resolveRequestedMilestoneInvoice({
        meta: nextMeta,
        milestoneIndex: artifactMilestoneIndex,
      });
  let milestoneArtifact = null;
  let milestoneReceiptArtifact = null;
  // The caller's own request — the milestone it actually acted on. A
  // failure writing this one must fail loudly: this is the explicit
  // artifact write DEL-30 P2-B's 410 is meant to protect. Everything else
  // that gets swept in below (including every milestone when
  // `writeAllArtifacts` is set) is opportunistic and must never be able to
  // abort a mutation the caller did not target (DEL-30 P2-2).
  const explicitTargetIndexes = new Set(milestoneInvoice ? [milestoneInvoice.milestoneIndex] : []);
  const artifactTargetsByIndex = new Map(
    milestoneInvoice ? [[milestoneInvoice.milestoneIndex, milestoneInvoice]] : [],
  );
  // `writeAllArtifacts` requests every milestone's artifact captured this
  // pass — including a draft's preview render, not only issued ones (e.g.
  // schedule generation previewing every milestone up front). That is still
  // a legitimate request; what DEL-30 P2-2 corrects is only that it must
  // NOT make every milestone an EXPLICIT (fail-loud) target — these stay
  // implicit regardless, same as the sweep below.
  if (writeAllArtifacts) {
    for (const entry of nextMeta.milestoneInvoices || []) {
      if (!artifactTargetsByIndex.has(entry.milestoneIndex)) {
        artifactTargetsByIndex.set(entry.milestoneIndex, entry);
      }
    }
  }
  // Issuing a revision must capture its bytes regardless of which target the
  // caller happened to request: any milestone invoice that now carries an
  // issued revision with no PDF written yet gets its artifact written here,
  // so a superseded revision is never left unretrievable. Deduplicated by
  // milestoneIndex so nothing is written twice in one call.
  for (const entry of nextMeta.milestoneInvoices || []) {
    if (entry.issuedRevision && !artifactIsStored(entry.issuedRevision) && !artifactTargetsByIndex.has(entry.milestoneIndex)) {
      artifactTargetsByIndex.set(entry.milestoneIndex, entry);
    }
  }
  const artifactTargets = [...artifactTargetsByIndex.values()];
  // The single unified record of every artifact-state transition this call
  // produces, applied in one pass below via `transitionArtifactState` — the
  // one function that owns the actual mutation (DEL-30 round-4 architecture
  // correction). Replaces three separately hand-rolled maps/patch blocks.
  const artifactTransitionsByIndex = new Map();
  // `applyMilestoneInvoiceCompatFields` above re-normalizes every milestone
  // invoice through `normalizeInvoiceRevision`, which is also where
  // `artifactState` gets (re-)derived — legacy `ADOPT_PENDING` synthesis set
  // directly on the raw entry survives that round trip because it is a
  // known, persisted field now, unlike the old transient `legacyOrigin`
  // marker. Artifacts are still written from the *raw* (pre-compat-
  // normalization) entries when available, falling back to the normalized
  // one, purely to avoid any redundant re-derivation.
  const rawMilestoneInvoicesByIndex = new Map(
    (milestoneInvoices || []).map((entry) => [entry.milestoneIndex, entry]),
  );

  for (const entry of artifactTargets) {
    const isExplicitTarget = explicitTargetIndexes.has(entry.milestoneIndex);
    const priorState = deriveArtifactState(entry.issuedRevision);
    let invoiceArtifact = null;
    let transition = null;
    try {
      invoiceArtifact = await writeMilestoneInvoiceArtifact({
        jobDir,
        meta: nextMeta,
        quote,
        milestoneInvoice: rawMilestoneInvoicesByIndex.get(entry.milestoneIndex) || entry,
      });
      transition = invoiceArtifact.artifactTransition;
    } catch (err) {
      // Explicit target: the caller acted on this milestone directly — fail
      // loudly. This is the exact 410 DEL-30 P2-B intends: an unrecoverable
      // issued artifact must stop the action that targets it.
      if (isExplicitTarget) throw err;
      // Implicit target: this milestone was swept in opportunistically —
      // "capture any not-yet-stored issued revision while we're here" — not
      // because the caller acted on it. An opportunistic background repair
      // must never be able to abort an unrelated explicit mutation
      // (DEL-30 P1-C): leave this revision in its MISSING state, and
      // continue persisting the rest of this call.
      transition = err.artifactTransition || {
        pdfPath: entry.pdfPath || null,
        toState: ARTIFACT_STATE.MISSING,
        reason: err.message,
      };
    }

    if (transition) {
      artifactTransitionsByIndex.set(entry.milestoneIndex, {
        ...transition,
        priorState,
        invoiceNumber: entry.invoiceNumber,
        revisionNumber: entry.issuedRevision?.revisionNumber ?? null,
        reconstructed: Boolean(invoiceArtifact?.reconstructed),
        quoteVersionInferred: Boolean(invoiceArtifact?.quoteVersionInferred),
      });
    }

    if (artifactMilestoneIndex != null && entry.milestoneIndex === artifactMilestoneIndex) {
      milestoneArtifact = invoiceArtifact;
    }

    // Receipt maintenance runs regardless of the invoice write's outcome —
    // whether the invoice artifact was captured, adopted, reconstructed, or
    // left unrecoverable is a distinct concern from whether a stale receipt
    // PDF needs cleaning up for a no-longer-paid milestone, or a paid one
    // needs its receipt written (DEL-30 P3-3). The same explicit/implicit
    // policy applies: an I/O failure on an explicit target's receipt still
    // fails loudly; on an implicit one it is swallowed rather than aborting
    // an unrelated mutation.
    try {
      if (entry.status === "paid" || Number(entry.amountDue || 0) <= 0) {
        const receiptArtifact = await writeMilestoneReceiptArtifact({
          jobDir,
          meta: nextMeta,
          quote,
          milestoneInvoice: entry,
        });
        if (artifactMilestoneIndex != null && entry.milestoneIndex === artifactMilestoneIndex) {
          milestoneReceiptArtifact = receiptArtifact;
        }
      } else {
        await deleteMilestoneReceiptArtifact({
          jobDir,
          milestoneInvoice: entry,
        });
      }
    } catch (err) {
      if (isExplicitTarget) throw err;
    }
  }

  if (artifactTransitionsByIndex.size) {
    nextMeta = {
      ...nextMeta,
      milestoneInvoices: (nextMeta.milestoneInvoices || []).map((entry) => {
        const info = artifactTransitionsByIndex.get(entry.milestoneIndex);
        if (!info) return entry;
        if (entry.issuedRevision?.pdfPath === info.pdfPath) {
          return {
            ...entry,
            issuedRevision: transitionArtifactState(entry.issuedRevision, {
              toState: info.toState,
              pdfSha256: info.pdfSha256,
              // A mint stamps "now"; an adopt/reconstruct preserves the
              // record's own issue time; a MISSING transition carries none.
              pdfIssuedAt: info.toState === ARTIFACT_STATE.STORED
                ? (info.pdfIssuedAt || entry.issuedRevision.pdfIssuedAt || new Date().toISOString())
                : undefined,
              reason: info.reason,
            }),
          };
        }
        if (Array.isArray(entry.revisionHistory) && entry.revisionHistory.some((rev) => rev.pdfPath === info.pdfPath)) {
          return {
            ...entry,
            revisionHistory: entry.revisionHistory.map((rev) => (
              rev.pdfPath === info.pdfPath
                ? transitionArtifactState(rev, {
                    toState: info.toState,
                    pdfSha256: info.pdfSha256,
                    pdfIssuedAt: info.toState === ARTIFACT_STATE.STORED
                      ? (info.pdfIssuedAt || rev.pdfIssuedAt || new Date().toISOString())
                      : undefined,
                    reason: info.reason,
                  })
                : rev
            )),
          };
        }
        return entry;
      }),
    };
  }

  nextMeta = applyMilestoneInvoiceCompatFields(nextMeta);
  nextMeta = await writePersistedMeta(jobDir, nextMeta);
  await recordIssuedInvoiceRevisionsAfterCommit(jobDir, nextMeta);

  for (const [milestoneIndex, info] of artifactTransitionsByIndex) {
    if (info.toState === ARTIFACT_STATE.STORED && info.reconstructed) {
      await appendJobActivity({
        jobDir,
        activity: {
          kind: "invoice.artifact_reconstructed",
          ts: new Date().toISOString(),
          actor: { kind: "system", label: "Field" },
          title: "Invoice PDF reconstructed",
          body: `The stored PDF for ${info.invoiceNumber || `milestone ${milestoneIndex + 1}`}${info.revisionNumber ? ` (revision ${info.revisionNumber})` : ""} was missing and has been reconstructed from ${info.quoteVersionInferred ? "the best available quote version — inferred, not necessarily the version it was originally rendered from, because this is a pre-DEL-30 legacy invoice" : "the quote version it was originally issued against"}.`,
        },
      });
      continue;
    }
    // One event per affected invoice per DEGRADATION, not per sweep attempt
    // that finds it still degraded — a job stays mutable, but a degraded
    // invoice must be visible rather than merely not-crashing (DEL-30
    // P1-C). Bounded to the actual state transition (DEL-30 round-4 minor
    // note): if it was already MISSING before this attempt, it is not a new
    // fact worth re-announcing on every future mutation.
    if (info.toState === ARTIFACT_STATE.MISSING && info.priorState !== ARTIFACT_STATE.MISSING) {
      await appendJobActivity({
        jobDir,
        activity: {
          kind: "invoice.artifact_unrecoverable",
          ts: new Date().toISOString(),
          actor: { kind: "system", label: "Field" },
          title: "Invoice PDF unrecoverable",
          body: `The stored PDF for ${info.invoiceNumber || `milestone ${milestoneIndex + 1}`}${info.revisionNumber ? ` (revision ${info.revisionNumber})` : ""} is missing and could not be reconstructed (${info.reason}). Downloads and previews of this invoice will fail until it is resolved; other actions on this job are unaffected.`,
        },
      });
    }
  }

  if (artifactMilestoneIndex != null) {
    milestoneInvoice = resolveRequestedMilestoneInvoice({
      meta: nextMeta,
      milestoneIndex: artifactMilestoneIndex,
    });
  }

  return {
    meta: nextMeta,
    milestoneInvoice,
    milestoneArtifact,
    milestoneReceiptArtifact,
  };
}

// Issued documents (#223): once the generation that issued an invoice
// revision commits, record the revision's stored PDF in PostgreSQL. Queued
// after the commit so a generation that is thrown away records nothing; run
// at once when this is not a staged generation. The recorder never throws.
const invoiceRevisionsQueued = new Set();

async function recordIssuedInvoiceRevisionsAfterCommit(jobDir, meta) {
  const recorder = issuedDocumentRecorder();
  if (!recorder.enabled) return;
  const issued = (meta?.milestoneInvoices || []).some((entry) => entry?.issuedRevision && artifactIsStored(entry.issuedRevision));
  if (!issued || invoiceRevisionsQueued.has(jobDir)) return;
  const queued = queueStagedPostCommit(jobDir, (committedJobDir) => {
    invoiceRevisionsQueued.delete(jobDir);
    return recorder.recordInvoiceRevisions(committedJobDir);
  });
  if (queued) {
    invoiceRevisionsQueued.add(jobDir);
    return;
  }
  await recorder.recordInvoiceRevisions(jobDir);
}

async function synchronizeMilestoneInvoices({
  jobDir,
  meta,
  quote,
  config,
  paymentSchedule = null,
  writeAllArtifacts = false,
  revisionAuthorizations = null,
}) {
  const generated = buildMilestoneInvoices({
    meta,
    quote,
    paymentSchedule,
    config,
    existingMilestoneInvoices: meta?.milestoneInvoices || [],
    revisionAuthorizations,
  });
  const persisted = await persistMilestoneInvoiceState({
    jobDir,
    meta,
    quote,
    paymentSchedule: generated.paymentSchedule,
    milestoneInvoices: generated.milestoneInvoices,
    writeAllArtifacts,
  });
  return {
    ...persisted,
    quote,
    paymentSchedule: generated.paymentSchedule,
    milestoneInvoices: persisted.meta.milestoneInvoices || [],
  };
}

function buildMilestonePaidAmountQuote(milestoneInvoice) {
  return {
    totals: {
      total: milestoneInvoice?.total || 0,
      currency: milestoneInvoice?.currency || "AUD",
    },
  };
}

function normalizeMilestoneIndex(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildMigrationPercentages(fixedTotals = [], quoteTotal = 0) {
  const total = Number(quoteTotal || 0);
  if (!(total > 0) || !fixedTotals.length) return [];
  const percentages = fixedTotals.map((amount) => roundMoney((Number(amount || 0) / total) * 100));
  const difference = roundMoney(100 - percentages.reduce((sum, value) => sum + Number(value || 0), 0));
  if (percentages.length && difference) {
    percentages[percentages.length - 1] = roundMoney(percentages[percentages.length - 1] + difference);
  }
  return percentages;
}

function buildMigratedPaymentSchedule({
  currentSchedule = null,
  currentInvoices = [],
  quoteTotal = 0,
  carriedForwardAmount = 0,
  carryMilestoneIndex = 0,
  adjustmentMilestoneIndex = 1,
  sourceQuoteVersion = null,
} = {}) {
  const invoices = normalizeStoredMilestoneInvoices(currentInvoices);
  if (!invoices.length) {
    throw createJobActionError("milestone invoices must exist before migration", 409);
  }
  const total = roundMoney(quoteTotal);
  const carriedAmount = roundMoney(carriedForwardAmount);
  if (!(total > 0)) throw createJobActionError("target quote total is required for invoice migration", 400);
  if (!(carriedAmount > 0)) throw createJobActionError("carried-forward amount must be greater than zero", 400);
  if (carriedAmount > total) throw createJobActionError("carried-forward amount cannot exceed the target quote total", 400);

  const carryIndex = normalizeMilestoneIndex(carryMilestoneIndex, 0);
  const adjustmentIndex = normalizeMilestoneIndex(adjustmentMilestoneIndex, Math.min(1, invoices.length - 1));
  if (!invoices[carryIndex]) throw createJobActionError("carry milestone not found", 404);
  if (!invoices[adjustmentIndex]) throw createJobActionError("adjustment milestone not found", 404);
  if (adjustmentIndex === carryIndex && invoices.length > 1) {
    throw createJobActionError("adjustment milestone must be separate from the carried deposit milestone", 400);
  }

  const fixedTotals = invoices.map((invoice) => roundMoney(invoice.total));
  fixedTotals[carryIndex] = carriedAmount;
  const preservedTotal = fixedTotals.reduce((sum, amount, index) => (
    index === adjustmentIndex ? sum : roundMoney(sum + Number(amount || 0))
  ), 0);
  fixedTotals[adjustmentIndex] = roundMoney(total - preservedTotal);
  if (!(fixedTotals[adjustmentIndex] > 0)) {
    throw createJobActionError("migration would leave the adjustment milestone with no amount due", 409);
  }
  const fixedTotalSum = roundMoney(fixedTotals.reduce((sum, amount) => sum + Number(amount || 0), 0));
  if (fixedTotalSum !== total) {
    fixedTotals[adjustmentIndex] = roundMoney(fixedTotals[adjustmentIndex] + (total - fixedTotalSum));
  }

  const currentMilestones = currentSchedule?.milestones || [];
  const percentages = buildMigrationPercentages(fixedTotals, total);
  const sourceLabel = sourceQuoteVersion ? `v${String(sourceQuoteVersion).padStart(3, "0")}` : "prior quote";
  return {
    milestones: invoices.map((invoice, index) => ({
      label: index === carryIndex
        ? `Imported ${sourceLabel} deposit credit`
        : (currentMilestones[index]?.label || invoice.milestoneLabel || `Milestone ${index + 1}`),
      percentage: percentages[index] || 0,
      fixedTotal: fixedTotals[index],
      ...(currentMilestones[index]?.dueDays ? { dueDays: currentMilestones[index].dueDays } : {}),
    })),
  };
}

function annotateCarriedForwardPayment({
  invoice = null,
  carriedForwardAmount = 0,
  sourceQuoteVersion = null,
  sourceInvoiceNumber = null,
  migrationId = null,
  paymentDate = null,
} = {}) {
  const activePayments = (invoice?.payments || []).filter((payment) => !payment?.voidedAt);
  const activeTotal = sumActiveMilestonePayments(activePayments);
  const carriedAmount = roundMoney(carriedForwardAmount);
  if (activeTotal > carriedAmount) {
    throw createJobActionError("active payments exceed the carried-forward amount; void the accidental payments first", 409);
  }

  let payments = invoice.payments || [];
  if (activeTotal < carriedAmount) {
    const addedAmount = roundMoney(carriedAmount - activeTotal);
    payments = [
      ...payments,
      {
        id: `${migrationId || "migration"}-carried-payment`,
        date: paymentDate || new Date().toISOString().slice(0, 10),
        amount: addedAmount,
        reference: "carried-forward-deposit",
        method: "migration",
        recordedAt: new Date().toISOString(),
        ...(sourceQuoteVersion ? { sourceQuoteVersion: Number(sourceQuoteVersion) } : {}),
        ...(sourceInvoiceNumber ? { sourceInvoiceNumber } : {}),
        ...(migrationId ? { migrationId } : {}),
        note: "Carried forward from a superseded accepted quote.",
      },
    ];
  }

  payments = payments.map((payment) => {
    if (payment?.voidedAt) return payment;
    return {
      ...payment,
      ...(sourceQuoteVersion ? { sourceQuoteVersion: Number(sourceQuoteVersion) } : {}),
      ...(sourceInvoiceNumber ? { sourceInvoiceNumber } : {}),
      ...(migrationId ? { migrationId } : {}),
      note: payment.note || "Carried forward from a superseded accepted quote.",
    };
  });

  return {
    ...invoice,
    payments,
    amountPaid: sumActiveMilestonePayments(payments),
  };
}

function sanitizeAttachmentFilename(filename) {
  const raw = String(filename || "").trim();
  if (!raw) return null;
  const withoutExtension = raw.replace(/\.pdf$/i, "");
  const cleaned = withoutExtension
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (!cleaned) return null;
  return `${cleaned}.pdf`;
}

function buildMilestoneInvoiceActivityBody({
  milestoneInvoice,
  to,
}) {
  if (!milestoneInvoice) return `Invoice emailed to ${to}.`;
  return `${milestoneInvoice.invoiceNumber}${milestoneInvoice.milestoneLabel ? ` (${milestoneInvoice.milestoneLabel})` : ""} emailed to ${to}.`;
}

/**
 * Prepare one immutable delivery attempt inside the caller's staged
 * generation. Payment schedule/state and the exact outbox bytes are published
 * together; no invoice/receipt helper writes a committed generation before
 * dispatch begins.
 */
// Quote snapshots (#151). `config.quoteSnapshots` is the snapshot store the
// server installs (server/quote-snapshots.js); a caller without one (unit
// tests driving sendJobQuote directly) records nothing.
async function readCatalogStateForSnapshot(config) {
  if (!config?.priceCatalog?.getState) return null;
  try {
    return await config.priceCatalog.getState();
  } catch (error) {
    console.warn(`[quote-snapshot] catalogue unavailable for catalogue references: ${error.message}`);
    return null;
  }
}

async function buildDeliverySnapshot(config, {
  attemptId,
  documentType,
  quoteVersion,
  preparedQuote,
  preparedMeta,
  preparedMilestoneInvoice,
  to,
  cc,
  bcc,
  user,
  pdfSha256,
  preparedAt,
}) {
  return buildQuoteSnapshotRecord({
    attemptId,
    documentType,
    quoteVersion,
    quote: preparedQuote,
    meta: preparedMeta,
    milestoneInvoice: preparedMilestoneInvoice || null,
    to,
    cc,
    bcc,
    sentBy: user || null,
    pdfSha256,
    preparedAt,
    catalogState: await readCatalogStateForSnapshot(config),
  });
}

function deliverySnapshotInput(attempt, user) {
  return {
    attemptId: attempt.attemptId,
    documentType: attempt.documentType || "quote",
    quoteVersion: attempt.selectedVersion || attempt.quoteVersion || attempt.preparedQuote?.version || null,
    preparedQuote: attempt.preparedQuote,
    preparedMeta: attempt.preparedMeta,
    preparedMilestoneInvoice: attempt.preparedMilestoneInvoice || null,
    to: attempt.to,
    cc: attempt.cc || [],
    bcc: attempt.bcc || [],
    user,
    pdfSha256: attempt.artifacts?.quotePdf?.sha256 || null,
    preparedAt: attempt.createdAt || new Date().toISOString(),
  };
}

// Before an email is dispatched: record what is about to be sent. If that
// fails nothing is sent, and the prepared attempt is retired (it was provably
// never dispatched) so the next send prepares afresh.
async function recordPreparedDeliverySnapshot({ jobDir, config, attempt, user }) {
  const store = config?.quoteSnapshots;
  if (!store) return;
  try {
    await store.recordPrepared(await buildDeliverySnapshot(config, deliverySnapshotInput(attempt, user)));
  } catch (error) {
    await updatePendingQuoteDelivery(jobDir, attempt.attemptId, {
      status: "failed",
      error: `quote snapshot not recorded: ${String(error?.message || error)}`,
    }).catch(() => {});
    const refused = createJobActionError(
      `Field could not record what is being sent, so nothing was sent: ${error?.message || error}`,
      error?.statusCode || 503,
    );
    refused.code = "QUOTE_SNAPSHOT_FAILED";
    throw refused;
  }
}

// After the delivery is committed: mark the attempt's snapshot sent. The
// email has gone; a failure here is logged, never reported as a failed send
// (the prepared row already holds what was sent).
async function recordSentDeliverySnapshot({ config, finalization, issuance }) {
  const store = config?.quoteSnapshots;
  if (!store || !finalization?.pendingAttemptId) return;
  try {
    const result = finalization.result || {};
    const record = await buildDeliverySnapshot(config, {
      attemptId: finalization.pendingAttemptId,
      documentType: finalization.resolvedDocumentType || "quote",
      quoteVersion: finalization.selectedVersion || finalization.preparedQuote?.version || null,
      preparedQuote: finalization.preparedQuote,
      preparedMeta: finalization.preparedMeta,
      preparedMilestoneInvoice: finalization.preparedMilestoneInvoice || null,
      to: result.to || finalization.to,
      cc: result.cc || [],
      bcc: result.bcc || [],
      user: finalization.user || null,
      pdfSha256: issuance?.artifacts?.quotePdf?.sha256 || null,
      preparedAt: finalization.quoteSentAt,
    });
    await store.recordSent(record, {
      sentAt: issuance?.issuedAt || finalization.quoteSentAt || new Date().toISOString(),
      messageId: result.id || null,
      threadId: result.threadId || null,
      issuanceId: issuance?.issuanceId || null,
    });
  } catch (error) {
    console.error(`[quote-snapshot] attempt ${finalization.pendingAttemptId} was sent but its snapshot could not be marked sent: ${error.message}`);
  }
}

async function prepareQuoteDeliveryAttempt({
  jobDir,
  resolvedMeta,
  deliveryQuote,
  config,
  user,
  resolvedDocumentType,
  selectedVersion,
  latestVersion,
  quoteVersion,
  milestoneIndex,
  invoicePaidAmount,
  attachmentFilename,
  to,
  cc,
  bcc,
  customBody,
  subjectOverride,
  resendLockedQuoteVersion,
  sendPolicy,
  scheduledEmailId,
  scheduledAt,
}) {
  let preparedMeta = resolvedMeta;
  let preparedQuote = deliveryQuote;
  let preparedMilestoneInvoice = null;
  let validatedInvoicePaidAmount = null;
  let quotePdfBuffer = null;

  if (resolvedDocumentType === "invoice") {
    const synchronized = await synchronizeMilestoneInvoices({
      jobDir,
      meta: resolvedMeta,
      quote: deliveryQuote,
      config,
      writeAllArtifacts: false,
    });
    let milestoneInvoices = synchronized.milestoneInvoices;
    preparedMeta = synchronized.meta;
    preparedMilestoneInvoice = resolveRequestedMilestoneInvoice({
      meta: preparedMeta,
      milestoneIndex,
    });

    if (preparedMilestoneInvoice) {
      if (preparedMilestoneInvoice.status === "draft") {
        const updated = updateMilestoneInvoice({
          milestoneInvoices,
          milestoneIndex: preparedMilestoneInvoice.milestoneIndex,
          patch: { status: "authorised" },
          quoteVersion: deliveryQuote?.version || preparedMeta?.quoteVersion || null,
          actor: user,
        });
        milestoneInvoices = updated.milestoneInvoices;
        preparedMilestoneInvoice = updated.milestoneInvoice;
      }

      if (invoicePaidAmount != null && invoicePaidAmount !== "") {
        validatedInvoicePaidAmount = validateInvoicePaidAmount({
          quote: buildMilestonePaidAmountQuote(preparedMilestoneInvoice),
          invoicePaidAmount,
        });
        if (validatedInvoicePaidAmount < preparedMilestoneInvoice.amountPaid) {
          throw createJobActionError("invoice paid amount cannot be less than the milestone amount already recorded as paid", 400);
        }
        const additionalPaidAmount = roundMoney(validatedInvoicePaidAmount - preparedMilestoneInvoice.amountPaid);
        if (additionalPaidAmount > 0) {
          const recorded = recordMilestoneInvoicePayment({
            milestoneInvoices,
            milestoneIndex: preparedMilestoneInvoice.milestoneIndex,
            payment: {
              amount: additionalPaidAmount,
              date: new Date().toISOString().slice(0, 10),
              reference: "compat-send-invoice",
              method: null,
            },
          });
          milestoneInvoices = recorded.milestoneInvoices;
          preparedMilestoneInvoice = recorded.milestoneInvoice;
        }
      } else {
        validatedInvoicePaidAmount = preparedMilestoneInvoice.amountPaid;
      }

      const persisted = await persistMilestoneInvoiceState({
        jobDir,
        meta: preparedMeta,
        quote: deliveryQuote,
        paymentSchedule: preparedMeta.paymentSchedule || null,
        milestoneInvoices,
        artifactMilestoneIndex: preparedMilestoneInvoice.milestoneIndex,
      });
      preparedMeta = persisted.meta;
      preparedMilestoneInvoice = persisted.milestoneInvoice;
      quotePdfBuffer = persisted.milestoneArtifact?.pdfBuffer || null;

      const document = prepareRequestedJobDocument({
        meta: preparedMeta,
        quote: deliveryQuote,
        documentType: resolvedDocumentType,
        milestoneIndex: preparedMilestoneInvoice?.milestoneIndex,
      });
      preparedMeta = document.meta;
      preparedQuote = document.quote;
    } else {
      validatedInvoicePaidAmount = validateInvoicePaidAmount({ quote: deliveryQuote, invoicePaidAmount });
    }
  } else if (resolvedDocumentType === "receipt") {
    const synchronized = await synchronizeMilestoneInvoices({
      jobDir,
      meta: resolvedMeta,
      quote: deliveryQuote,
      config,
      writeAllArtifacts: false,
    });
    preparedMeta = synchronized.meta;
    const document = prepareRequestedJobDocument({
      meta: preparedMeta,
      quote: deliveryQuote,
      documentType: resolvedDocumentType,
      milestoneIndex,
    });
    preparedMeta = document.meta;
    preparedQuote = document.quote;
    preparedMilestoneInvoice = document.milestoneInvoice;
    validatedInvoicePaidAmount = preparedMilestoneInvoice?.amountPaid || 0;
    const receiptArtifact = await writeMilestoneReceiptArtifact({
      jobDir,
      meta: synchronized.meta,
      quote: deliveryQuote,
      milestoneInvoice: preparedMilestoneInvoice,
    });
    quotePdfBuffer = receiptArtifact.pdfBuffer;
  }

  if (!quotePdfBuffer) {
    quotePdfBuffer = await generateQuotePdfBuffer({
      meta: preparedMeta,
      quote: preparedQuote,
      documentType: resolvedDocumentType,
      invoicePaidAmount: validatedInvoicePaidAmount,
    });
  }

  const quotePdfFilename = sanitizeAttachmentFilename(attachmentFilename)
    || buildQuotePdfFilename(preparedMeta, preparedQuote, resolvedDocumentType);
  const preparedQuoteMarkdown = generateEvidenceQuoteMarkdown({ meta: preparedMeta, quote: preparedQuote });
  const selectedReport = await readSelectedReportMarkdown({
    jobDir,
    meta: resolvedMeta,
    documentType: resolvedDocumentType === "quote" ? "quote" : "report",
    requestedVersion: quoteVersion,
    intent: "delivery",
  });
  const selectedHistorical = Boolean(
    selectedVersion && latestVersion && Number(selectedVersion) !== Number(latestVersion),
  );
  if (selectedReport.unavailable && selectedHistorical) {
    throw createJobActionError(
      selectedReport.issuanceRecord
        ? "the exact issued report bytes are unavailable"
        : "historical quote report bytes are unavailable",
      selectedReport.issuanceRecord ? 410 : 409,
    );
  }
  const preparedReportMarkdown = selectedReport.report || preparedQuoteMarkdown;
  const pendingAttempt = buildQuoteDeliveryAttempt({
    quoteVersion: selectedVersion || preparedQuote.version || preparedMeta.quoteVersion,
    documentType: resolvedDocumentType,
    to,
    cc,
    subject: subjectOverride || null,
    quoteMarkdown: preparedQuoteMarkdown,
    reportMarkdown: preparedReportMarkdown,
    quotePdf: quotePdfBuffer,
    preparedQuote,
    preparedMeta,
  });
  Object.assign(pendingAttempt, {
    bcc: Array.isArray(bcc) ? bcc : [],
    customBody: customBody || null,
    validatedInvoicePaidAmount,
    selectedVersion,
    preparedMilestoneInvoice,
    milestoneIndex,
    resolvedMeta,
    deliveryQuote,
    resendLockedQuoteVersion,
    sendPolicy,
    latestVersion,
    quotePdfFilename,
    scheduledEmailId,
    scheduledAt,
  });
  await persistPendingQuoteDelivery(jobDir, pendingAttempt, { inExistingGeneration: true });
  return {
    preparedMeta,
    preparedQuote,
    preparedMilestoneInvoice,
    validatedInvoicePaidAmount,
    quotePdfBuffer,
    preparedQuoteMarkdown,
    preparedReportMarkdown,
    pendingAttempt,
  };
}

export async function sendJobQuote({
  jobDir,
  meta,
  dataDir,
  config,
  user = null,
  to,
  cc = [],
  bcc = [],
  customBody = null,
  documentType = null,
  invoicePaidAmount = null,
  milestoneIndex = null,
  quoteVersion = null,
  themeFontFamily = null,
  subjectOverride = null,
  attachmentFilename = null,
  additionalAttachments = [],
  scheduledEmailId = null,
  scheduledAt = null,
  sendEmail = sendQuoteEmail,
  reconcileSentDelivery = null,
}) {
  // Reconcile an existing attempt before reading mutable current quote state.
  // The outbox embeds the exact prepared quote/meta/bytes; retrying from the
  // current draft could deliver a different document under the old Message-ID.
  const pendingDelivery = await readPendingQuoteDelivery(jobDir);
  if (pendingDelivery && pendingDelivery.status !== "failed") {
    if (pendingDelivery.status === "pending") {
      return dispatchPendingQuoteDelivery({
        jobDir,
        pendingDelivery,
        config,
        user,
        to,
        sendEmail,
        themeFontFamily,
        additionalAttachments,
      });
    }
    let reconciled = null;
    try {
      reconciled = await (reconcileSentDelivery
        ? reconcileSentDelivery(pendingDelivery)
        : findSentMessageByDeliveryAttempt({
            config,
            user,
            messageId: pendingDelivery.messageId,
          }));
    } catch {
      reconciled = null;
    }
    if (!reconciled) {
      const pendingError = new Error(
        "a previous quote delivery has an unknown outcome; reconcile its stable Gmail message identity before retrying",
      );
      pendingError.statusCode = 409;
      throw pendingError;
    }
    if (!pendingDelivery.preparedQuote || !pendingDelivery.preparedMeta) {
      const pendingError = new Error("pending quote delivery is missing its immutable prepared state");
      pendingError.statusCode = 409;
      throw pendingError;
    }
    const pendingArtifacts = decodeQuoteDeliveryArtifacts(pendingDelivery);
    const pendingDocumentType = pendingDelivery.documentType || "quote";
    return finalizeAndProjectDelivery({
      jobDir,
      config,
      finalization: {
      result: { ...reconciled, subject: pendingDelivery.subject || reconciled.subject || null },
      resolvedDocumentType: pendingDocumentType,
      documentLabel: getJobDocumentLabel(pendingDocumentType),
      selectedVersion: pendingDelivery.selectedVersion || pendingDelivery.quoteVersion || pendingDelivery.preparedQuote.version,
      preparedQuote: pendingDelivery.preparedQuote,
      preparedMeta: pendingDelivery.preparedMeta,
      preparedMilestoneInvoice: pendingDelivery.preparedMilestoneInvoice || null,
      milestoneIndex: pendingDelivery.milestoneIndex ?? null,
      user,
      to: pendingDelivery.to || to,
      quotePdfBuffer: pendingArtifacts.quotePdf,
      quoteSentAt: pendingDelivery.createdAt || new Date().toISOString(),
      resolvedMeta: pendingDelivery.resolvedMeta || pendingDelivery.preparedMeta,
      deliveryQuote: pendingDelivery.deliveryQuote || pendingDelivery.preparedQuote,
      resendLockedQuoteVersion: pendingDelivery.resendLockedQuoteVersion === true,
      sendPolicy: pendingDelivery.sendPolicy || { businessStage: normalizePipelineStage(pendingDelivery.preparedMeta?.pipelineStage), selectedVersionLocked: false },
      latestVersion: pendingDelivery.latestVersion || pendingDelivery.preparedQuote.version,
      pendingAttemptId: pendingDelivery.attemptId,
      pendingArtifacts,
      scheduledEmailId: pendingDelivery.scheduledEmailId || null,
      scheduledAt: pendingDelivery.scheduledAt || null,
      expectedPreparedVersion: pendingDocumentType === "quote"
        && pendingDelivery.resendLockedQuoteVersion !== true
        && Number(pendingDelivery.quoteVersion || pendingDelivery.preparedQuote.version)
          === Number(pendingDelivery.latestVersion || pendingDelivery.quoteVersion || pendingDelivery.preparedQuote.version)
        ? (pendingDelivery.quoteVersion || pendingDelivery.preparedQuote.version)
        : null,
      },
    });
  }

  const {
    meta: resolvedMeta,
    quoteLifecycle: existingQuoteLifecycle,
    selectedQuoteArtifacts,
    latestVersion,
    selectedVersion,
    resolvedDocumentType,
  } = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType,
    requestedVersion: quoteVersion,
    // DEL-30 defect B: sending is a delivery, not a view. Absent an explicit
    // version, give the customer the latest revision, not the last one they
    // already saw — otherwise a revised quote can never actually be sent.
    intent: "delivery",
  });

  const jobState = await readJobState(jobDir);
  const openGaps = listOpenSendBlockingGaps(jobState?.gaps || []);
  if (openGaps.length) {
    const err = new Error(`resolve ${openGaps.length} ${openGaps.length === 1 ? "gap" : "gaps"} before sending this quote`);
    err.statusCode = 409;
    throw err;
  }

  const quoteSentAt = new Date().toISOString();
  const quote = {
    ...selectedQuoteArtifacts.quote,
    delivery: {
      ...(selectedQuoteArtifacts.quote.delivery || {}),
      status: "final",
      finalizedAt: quoteSentAt,
    },
  };
  const deliveryQuote = projectQuoteForReviewState({
    quote,
    gaps: jobState?.gaps || [],
  });
  assertQuotePricingSendable(deliveryQuote);
  if (resolvedDocumentType === "quote") {
    assertQuoteLineItemCostsComplete(deliveryQuote);
  }
  if (deliveryQuote.missingInputs?.length) {
    const err = new Error("resolve all gaps before sending this quote");
    err.statusCode = 409;
    throw err;
  }
  const documentLabel = getJobDocumentLabel(resolvedDocumentType);
  const isPaymentDocument = resolvedDocumentType === "invoice" || resolvedDocumentType === "receipt";
  if (isPaymentDocument && normalizePipelineStage(resolvedMeta?.pipelineStage) !== "landed") {
    const err = new Error(`only landed jobs can send a ${resolvedDocumentType}`);
    err.statusCode = 409;
    throw err;
  }
  const sendPolicy = buildQuoteEditPolicy({
    meta: resolvedMeta,
    quoteLifecycle: existingQuoteLifecycle,
    latestVersion,
    selectedVersion,
  });
  if (
    resolvedDocumentType === "quote"
    && sendPolicy.businessStage === "draft"
    && sendPolicy.selectedVersionLocked
  ) {
    throw createJobActionError("load the latest draft revision before sending a quote", 409);
  }
  const resendLockedQuoteVersion = (
    resolvedDocumentType === "quote"
    && sendPolicy.businessStage !== "draft"
    && sendPolicy.selectedVersionLocked
    && !sendPolicy.selectedIsLatest
  );

  const prepared = await runAtomicJobGeneration(jobDir, async (stagedJobDir) => (
    prepareQuoteDeliveryAttempt({
      jobDir: stagedJobDir,
      resolvedMeta,
      deliveryQuote,
      config,
      user,
      resolvedDocumentType,
      selectedVersion,
      latestVersion,
      quoteVersion,
      milestoneIndex,
      invoicePaidAmount,
      attachmentFilename,
      to,
      cc,
      bcc,
      customBody,
      subjectOverride,
      resendLockedQuoteVersion,
      sendPolicy,
      scheduledEmailId,
      scheduledAt,
    })
  ));
  let {
    preparedMeta,
    preparedQuote,
    preparedMilestoneInvoice,
    validatedInvoicePaidAmount,
    quotePdfBuffer,
    preparedQuoteMarkdown,
    preparedReportMarkdown,
    pendingAttempt,
  } = prepared;
  await recordPreparedDeliverySnapshot({ jobDir, config, attempt: pendingAttempt, user });
  const claim = await claimPendingQuoteDelivery(jobDir, {
    attemptId: pendingAttempt.attemptId,
    expectedRevision: pendingAttempt.revision || 0,
  });
  if (!claim.claimed) {
    const err = createJobActionError("another delivery attempt already owns this prepared document; reconcile its stable message identity before retrying", 409);
    throw err;
  }
  pendingAttempt = claim.attempt;
  const quotePdfFilename = pendingAttempt.quotePdfFilename
    || sanitizeAttachmentFilename(attachmentFilename)
    || buildQuotePdfFilename(preparedMeta, preparedQuote, resolvedDocumentType);
  const expectedPreparedVersion = Number(pendingAttempt.quoteVersion || preparedQuote.version || preparedMeta.quoteVersion) || null;

  let result;
  try {
    result = await sendEmail({
    config,
    user,
    meta: preparedMeta,
    quote: preparedQuote,
    quotePdfBuffer,
    quotePdfFilename,
    to,
    cc,
    bcc,
    customBody,
    documentType: resolvedDocumentType,
    invoicePaidAmount: validatedInvoicePaidAmount,
    themeFontFamily,
    subjectOverride,
    additionalAttachments,
      deliveryAttemptId: pendingAttempt.attemptId,
    });
  } catch (error) {
    // A timeout or process interruption may have happened after Gmail accepted
    // the message. Keep the exact prepared bytes and mark the durable attempt
    // unknown; the next call must reconcile instead of blindly retrying.
    const outcomeUnknown = !isProvablyRejectedDeliveryError(error);
    await updatePendingQuoteDelivery(jobDir, pendingAttempt.attemptId, {
      status: outcomeUnknown ? "unknown" : "failed",
      error: String(error?.message || error),
    }).catch(() => {});
    await recordFailedDelivery({ attempt: pendingAttempt, documentType: resolvedDocumentType, error, outcome: outcomeUnknown ? "unknown" : "failed", user });
    throw error;
  }
  try {
    return await finalizeAndProjectDelivery({
      jobDir,
      config,
      finalization: {
    result,
    resolvedDocumentType,
    documentLabel,
    selectedVersion,
    preparedQuote,
    preparedMeta,
    preparedMilestoneInvoice,
    milestoneIndex,
    user,
    to,
    quotePdfBuffer,
    quoteSentAt,
    resolvedMeta,
    deliveryQuote,
    resendLockedQuoteVersion,
    sendPolicy,
    latestVersion,
    pendingAttemptId: pendingAttempt.attemptId,
    scheduledEmailId,
    scheduledAt,
    expectedPreparedVersion: resolvedDocumentType === "quote" && !resendLockedQuoteVersion
      ? expectedPreparedVersion
      : null,
    pendingArtifacts: {
      quoteMarkdown: preparedQuoteMarkdown,
      reportMarkdown: preparedReportMarkdown,
      quotePdf: quotePdfBuffer,
    },
      },
    });
  } catch (error) {
    // A revision can land after dispatch but before finalization. Keep the
    // immutable outbox pending/unknown rather than applying v1 delivery state
    // to the newer current generation.
    await updatePendingQuoteDelivery(jobDir, pendingAttempt.attemptId, {
      status: "unknown",
      error: String(error?.message || error),
    }).catch(() => {});
    throw error;
  }
}

/**
 * Dispatch a prepared-but-not-yet-claimed attempt without resolving the
 * mutable current quote. The outbox is the command input here: it carries the
 * exact prepared quote/meta/document bytes and its CAS revision.
 */
async function dispatchPendingQuoteDelivery({
  jobDir,
  pendingDelivery,
  config,
  user,
  to,
  sendEmail,
  themeFontFamily,
  additionalAttachments,
}) {
  if (!pendingDelivery.preparedQuote || !pendingDelivery.preparedMeta) {
    const pendingError = new Error("pending quote delivery is missing its immutable prepared state");
    pendingError.statusCode = 409;
    throw pendingError;
  }
  await recordPreparedDeliverySnapshot({ jobDir, config, attempt: pendingDelivery, user });
  const claim = await claimPendingQuoteDelivery(jobDir, {
    attemptId: pendingDelivery.attemptId,
    expectedRevision: pendingDelivery.revision || 0,
  });
  if (!claim.claimed) {
    const pendingError = new Error(
      "another delivery attempt already owns this prepared document; reconcile its stable message identity before retrying",
    );
    pendingError.statusCode = 409;
    throw pendingError;
  }
  const attempt = claim.attempt;
  const artifacts = decodeQuoteDeliveryArtifacts(attempt);
  const documentType = attempt.documentType || "quote";
  const quotePdfFilename = attempt.quotePdfFilename
    || buildQuotePdfFilename(attempt.preparedMeta, attempt.preparedQuote, documentType);
  let result;
  try {
    result = await sendEmail({
      config,
      user,
      meta: attempt.preparedMeta,
      quote: attempt.preparedQuote,
      quotePdfBuffer: artifacts.quotePdf,
      quotePdfFilename,
      to: attempt.to?.length ? attempt.to : to,
      cc: attempt.cc || [],
      bcc: attempt.bcc || [],
      customBody: attempt.customBody || null,
      documentType,
      invoicePaidAmount: attempt.validatedInvoicePaidAmount ?? null,
      themeFontFamily,
      subjectOverride: attempt.subject || null,
      additionalAttachments,
      deliveryAttemptId: attempt.attemptId,
    });
  } catch (error) {
    const outcomeUnknown = !isProvablyRejectedDeliveryError(error);
    await updatePendingQuoteDelivery(jobDir, attempt.attemptId, {
      status: outcomeUnknown ? "unknown" : "failed",
      error: String(error?.message || error),
    }, {
      expectedRevision: attempt.revision,
      expectedStatus: "claimed",
    }).catch(() => {});
    await recordFailedDelivery({ attempt, documentType, error, outcome: outcomeUnknown ? "unknown" : "failed", user });
    throw error;
  }

  return finalizeAndProjectDelivery({
    jobDir,
    config,
    finalization: {
      result,
      resolvedDocumentType: documentType,
      documentLabel: getJobDocumentLabel(documentType),
      selectedVersion: attempt.selectedVersion || attempt.quoteVersion || attempt.preparedQuote.version,
      preparedQuote: attempt.preparedQuote,
      preparedMeta: attempt.preparedMeta,
      preparedMilestoneInvoice: attempt.preparedMilestoneInvoice || null,
      milestoneIndex: attempt.milestoneIndex ?? null,
      user,
      to: attempt.to?.[0] || to,
      quotePdfBuffer: artifacts.quotePdf,
      quoteSentAt: new Date().toISOString(),
      resolvedMeta: attempt.resolvedMeta || attempt.preparedMeta,
      deliveryQuote: attempt.deliveryQuote || attempt.preparedQuote,
      resendLockedQuoteVersion: attempt.resendLockedQuoteVersion === true,
      sendPolicy: attempt.sendPolicy || {
        businessStage: normalizePipelineStage(attempt.preparedMeta?.pipelineStage),
        selectedVersionLocked: false,
      },
      latestVersion: attempt.latestVersion || attempt.preparedQuote.version,
      pendingAttemptId: attempt.attemptId,
      pendingArtifacts: artifacts,
      scheduledEmailId: attempt.scheduledEmailId || null,
      scheduledAt: attempt.scheduledAt || null,
      expectedPreparedVersion: documentType === "quote"
        && attempt.resendLockedQuoteVersion !== true
        && Number(attempt.quoteVersion || attempt.preparedQuote.version)
          === Number(attempt.latestVersion || attempt.quoteVersion || attempt.preparedQuote.version)
        ? (attempt.quoteVersion || attempt.preparedQuote.version)
        : null,
    },
  });
}

async function finalizeAndProjectDelivery({ jobDir, finalization, config = null }) {
  const finalized = await runAtomicJobGeneration(jobDir, async (stagedJobDir) => (
    finalizeSuccessfulDelivery({
      ...finalization,
      jobDir: stagedJobDir,
    })
  ));
  await recordSentDeliverySnapshot({ config, finalization, issuance: finalized?.issuance || null });
  await recordDeliveredDocument({ finalization, issuance: finalized?.issuance || null });
  // Quote rows (#241): the commit above already marked the version sent; now
  // that its issued document exists, link it. Never throws.
  if ((finalization.resolvedDocumentType || "quote") === "quote") {
    await quoteRowRecorder().syncJob(jobDir, { reason: "quote sent" });
  }
  const postCommit = finalized?.postCommit;
  if (postCommit?.sentEmailRecord) {
    try {
      await appendSentEmailArchive({ jobDir, record: postCommit.sentEmailRecord });
    } catch (error) {
      // The commercial generation and issuance ledger are already committed;
      // an operational archive failure is a post-commit diagnostic and must
      // not make a successful customer delivery look like a failed rebuild.
      console.warn(`[quote-delivery] sent-email archive append failed: ${error.message}`);
    }
  }
  if (postCommit?.activity) {
    try {
      await appendJobActivity({ jobDir, activity: postCommit.activity });
    } catch (error) {
      console.warn(`[quote-delivery] activity append failed after commit: ${error.message}`);
    }
  }
  if (!postCommit) return finalized;
  const { postCommit: _postCommit, ...result } = finalized;
  return result;
}

function isProvablyRejectedDeliveryError(error) {
  const status = Number(error?.response?.status || error?.statusCode || error?.status);
  // A provider 4xx response is an explicit rejection. Network resets,
  // connection failures, and every 5xx/timeout remain ambiguous after
  // dispatch starts and must be reconciled by Message-ID.
  if (Number.isInteger(status)) return status >= 400 && status < 500;
  // Plain application/test rejections occur before a transport dispatch and
  // are not enough evidence once this command has entered the transport
  // boundary. A caller must explicitly classify a pre-dispatch rejection;
  // every plain Error, reset, timeout, and 5xx is unknown and reconciled by
  // Message-ID before another send.
  return error?.deliveryOutcome === "rejected_before_dispatch";
}

async function finalizeSuccessfulDelivery({
  jobDir,
  result,
  resolvedDocumentType,
  documentLabel,
  selectedVersion,
  preparedQuote,
  preparedMeta,
  preparedMilestoneInvoice,
  milestoneIndex,
  user,
  to,
  quotePdfBuffer,
  quoteSentAt,
  resolvedMeta,
  deliveryQuote,
  resendLockedQuoteVersion,
  sendPolicy,
  latestVersion,
  pendingAttemptId = null,
  pendingArtifacts = null,
  expectedPreparedVersion = null,
  scheduledEmailId = null,
  scheduledAt = null,
}) {
  if (expectedPreparedVersion != null) {
    const currentQuote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8").catch(() => "null"));
    const currentVersion = Number(currentQuote?.version || 0) || null;
    if (currentVersion !== Number(expectedPreparedVersion)) {
      const error = new Error(
        `prepared delivery version ${expectedPreparedVersion} is stale; current quote version is ${currentVersion || "unknown"}`,
      );
      error.code = "FIELD_DELIVERY_STALE_PREPARED_VERSION";
      error.statusCode = 409;
      throw error;
    }
  }
  const issuedVersion = selectedVersion || preparedQuote.version || preparedMeta.quoteVersion || null;
  const issuedMarkdown = generateEvidenceQuoteMarkdown({ meta: preparedMeta, quote: preparedQuote });
  const issuedReport = await readFile(join(jobDir, "report.md"), "utf8").catch(() => issuedMarkdown);
  const issuance = await recordIssuedQuoteDocuments({
    jobDir,
    quoteVersion: issuedVersion,
    documentType: resolvedDocumentType,
    quoteSnapshotDigest: preparedQuote?.pricing?.attestation?.snapshotDigest || null,
    issuedAt: quoteSentAt,
    deliveryResult: {
      messageId: result.id || null,
      threadId: result.threadId || null,
      documentType: resolvedDocumentType,
      to,
      subject: result.subject || null,
    },
    quoteMarkdown: pendingArtifacts?.quoteMarkdown || issuedMarkdown,
    reportMarkdown: pendingArtifacts?.reportMarkdown || issuedReport,
    quotePdf: pendingArtifacts?.quotePdf || quotePdfBuffer,
  });

  // The email archive is operational history, not a commercial artifact. It
  // must be appended to the root after the staged generation commits so a
  // quote build cannot copy/replace concurrent chat, evidence, or delivery
  // history.
  const sentEmailRecord = {
    kind: `${resolvedDocumentType}.sent`,
    documentType: resolvedDocumentType,
    messageId: result.id,
    threadId: result.threadId,
    authMode: result.authMode,
    gmailUser: result.gmailUser,
    from: result.from,
    fromName: result.fromName,
    replyTo: result.replyTo,
    to: result.to,
    cc: result.cc,
    bcc: result.bcc,
    subject: result.subject,
    bodyText: result.bodyText,
    htmlBody: result.htmlBody,
    attachments: result.attachments,
    quoteVersion: issuedVersion,
    milestoneIndex: preparedMilestoneInvoice?.milestoneIndex ?? milestoneIndex ?? null,
    issuedDocumentId: issuance.issuanceId,
    scheduledEmailId,
    scheduledAt,
    sentBy: user ? { id: user.id, email: user.email, name: user.name } : null,
  };

  if (pendingAttemptId) {
    const outboxPath = join(jobDir, QUOTE_DELIVERY_OUTBOX_FILE);
    const pending = JSON.parse(await readFile(outboxPath, "utf8").catch(() => "null"));
    if (pending?.attemptId === pendingAttemptId) {
      await writeFile(outboxPath, JSON.stringify({
        ...pending,
        status: "completed",
        completedAt: new Date().toISOString(),
        deliveryResult: result,
      }, null, 2));
    }
  }

  if (resolvedDocumentType === "invoice" || resolvedDocumentType === "receipt") {
    const nextMeta = await writePersistedMeta(jobDir, applyMilestoneInvoiceCompatFields({
      ...preparedMeta,
      deliveryStatus: normalizePipelineStage(preparedMeta?.pipelineStage || preparedMeta?.deliveryStatus),
    }));
    const activity = {
      kind: `${resolvedDocumentType}.sent`,
      ts: preparedMilestoneInvoice?.issuedAt || preparedMilestoneInvoice?.paidAt || new Date().toISOString(),
      actor: { kind: "system", label: "Field" },
      title: `${documentLabel} sent`,
      body: resolvedDocumentType === "invoice"
        ? buildMilestoneInvoiceActivityBody({ milestoneInvoice: preparedMilestoneInvoice, to })
        : `${preparedMilestoneInvoice?.receiptNumber || preparedMilestoneInvoice?.invoiceNumber || "Receipt"} emailed to ${to}.`,
    };
    return {
      ...result,
      meta: nextMeta,
      milestoneInvoice: preparedMilestoneInvoice,
      quoteLifecycle: await readQuoteLifecycle(jobDir),
      issuance,
      postCommit: { sentEmailRecord, activity },
    };
  }

  if (resendLockedQuoteVersion) {
    const resendQuoteLifecycle = await recordQuoteSent({
      jobDir,
      meta: resolvedMeta,
      quoteVersion: selectedVersion || deliveryQuote.version || resolvedMeta?.quoteVersion || latestVersion || 1,
      to,
      sentAt: quoteSentAt,
      preserveCurrentQuoteVersion: true,
      currentQuoteVersion: latestVersion,
      currentPipelineStage: sendPolicy.businessStage,
    });
    return {
      ...result,
      meta: resolvedMeta,
      quoteLifecycle: resendQuoteLifecycle,
      issuance,
      postCommit: {
        sentEmailRecord,
        activity: {
          kind: "quote.sent",
          ts: quoteSentAt,
          actor: { kind: "system", label: "Field" },
          title: `${documentLabel} sent`,
          body: `${documentLabel} emailed to ${to}.`,
        },
      },
    };
  }

  const preservedBusinessStage = sendPolicy.businessStage === "landed" ? "landed" : "sent";
  const baseMeta = {
    ...resolvedMeta,
    quoteVersion: deliveryQuote.version || resolvedMeta.quoteVersion || 1,
    pipelineStage: preservedBusinessStage,
    deliveryStatus: preservedBusinessStage,
    quoteSentAt,
  };
  const finalizedArtifacts = await persistCurrentQuoteLockArtifacts({
    jobDir,
    meta: baseMeta,
    quote: deliveryQuote,
    lockStatus: "final",
    finalizedAt: quoteSentAt,
  });
  const finalizedMeta = await writePersistedMeta(jobDir, finalizedArtifacts.meta);
  const updatedQuoteLifecycle = await recordQuoteSent({
    jobDir,
    meta: finalizedMeta,
    quoteVersion: deliveryQuote.version || resolvedMeta.quoteVersion || 1,
    to,
    sentAt: quoteSentAt,
    preserveCurrentQuoteVersion: true,
    currentQuoteVersion: deliveryQuote.version || resolvedMeta.quoteVersion || 1,
    currentPipelineStage: preservedBusinessStage,
  });
  return {
    ...result,
    meta: finalizedMeta,
    quoteLifecycle: updatedQuoteLifecycle,
    issuance,
    postCommit: {
      sentEmailRecord,
      activity: {
        kind: "quote.sent",
        ts: quoteSentAt,
        actor: { kind: "system", label: "Field" },
        title: `${documentLabel} sent`,
        body: `${documentLabel} emailed to ${to}.`,
      },
    },
  };
}

export async function markJobLanded({
  jobDir,
  meta,
  dataDir,
  config,
  actor = null,
}) {
  if ((meta?.outputMode || "report") !== "quote") {
    const err = new Error("only quote jobs can be marked landed");
    err.statusCode = 409;
    throw err;
  }
  const hydratedMeta = await hydrateJobMeta(jobDir, meta);
  const currentStage = normalizePipelineStage(hydratedMeta?.pipelineStage);
  if (currentStage === "draft") {
    const err = new Error("send this quote before marking it landed");
    err.statusCode = 409;
    throw err;
  }
  if (currentStage === "landed") {
    return {
      meta: hydratedMeta,
      quoteLifecycle: await readQuoteLifecycle(jobDir),
    };
  }
  const {
    meta: resolvedMeta,
    quoteLifecycle,
    currentQuoteArtifacts,
    selectedQuoteArtifacts,
    latestVersion,
    selectedVersion,
  } = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType: "invoice",
  });

  const landedAt = new Date().toISOString();
  const landedMeta = {
    ...resolvedMeta,
    pipelineStage: "landed",
    deliveryStatus: "landed",
    landedAt,
    invoiceSentAt: resolvedMeta?.invoiceSentAt || null,
    invoicePaidAmount: Number.isFinite(Number(resolvedMeta?.invoicePaidAmount))
      ? Number(resolvedMeta.invoicePaidAmount)
      : 0,
  };
  let finalMeta = landedMeta;
  let milestoneQuote = selectedQuoteArtifacts?.quote || currentQuoteArtifacts?.quote || null;
  const selectedIsLatest = (
    selectedVersion != null
    && latestVersion != null
    && selectedVersion === latestVersion
  );
  if (selectedIsLatest) {
    const finalizedArtifacts = await persistCurrentQuoteLockArtifacts({
      jobDir,
      meta: landedMeta,
      quote: milestoneQuote,
      lockStatus: "final",
      finalizedAt: landedMeta.quoteSentAt || landedAt,
    });
    finalMeta = finalizedArtifacts.meta;
    milestoneQuote = finalizedArtifacts.quote || milestoneQuote;
  }
  const quote = milestoneQuote || await readPersistedQuote(jobDir);
  const synchronized = await synchronizeMilestoneInvoices({
    jobDir,
    meta: finalMeta,
    quote,
    config,
    writeAllArtifacts: true,
  });
  finalMeta = synchronized.meta;
  await appendJobActivity({
    jobDir,
    activity: {
      kind: "quote.landed",
      ts: landedAt,
      actor: actor || { kind: "system", label: "Field" },
      title: "Job landed",
      body: `Quote marked as landed. ${finalMeta.milestoneInvoices?.length || 0} milestone invoice(s) prepared.`,
    },
  });
  const updatedQuoteLifecycle = await recordQuoteLanded({
    jobDir,
    meta: finalMeta,
    landedAt,
  });

  return {
    meta: finalMeta,
    quoteLifecycle: updatedQuoteLifecycle,
  };
}

export async function generateJobMilestones({
  jobDir,
  meta,
  config,
  paymentSchedule = null,
  actor = null,
}) {
  const {
    meta: resolvedMeta,
    selectedQuoteArtifacts,
  } = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType: "invoice",
  });
  assertMilestoneScheduleMutationAllowed({ meta: resolvedMeta, paymentSchedule });
  const quote = selectedQuoteArtifacts?.quote || await readPersistedQuote(jobDir);
  // Authoring-time guard (DEL-30 P2-3): this is operator INPUT, not a
  // rebuild — reject a schedule whose fixed dollar amounts already exceed
  // the quote total outright, rather than letting the rebuild pro-rate it
  // silently on the very next touch.
  if (paymentSchedule) {
    assertMilestoneScheduleWithinQuoteTotal({
      paymentSchedule: normalizePaymentSchedule(paymentSchedule),
      quoteTotal: getCustomerPresentationFinancials(quote).total,
    });
  }
  const synchronized = await synchronizeMilestoneInvoices({
    jobDir,
    meta: resolvedMeta,
    quote,
    config,
    paymentSchedule,
    writeAllArtifacts: true,
  });

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "invoice.milestones_generated",
      ts: new Date().toISOString(),
      actor: actor || { kind: "system", label: "Field" },
      title: "Milestone invoices generated",
      body: `${synchronized.meta.milestoneInvoices?.length || 0} milestone invoice(s) generated.`,
    },
  });

  return synchronized;
}

export async function migrateJobMilestoneInvoices({
  jobDir,
  meta,
  config,
  sourceQuoteVersion = null,
  targetQuoteVersion = null,
  carriedForwardAmount = null,
  carryMilestoneIndex = 0,
  adjustmentMilestoneIndex = 1,
  voidPayments = [],
  resetChangedUnpaidInvoices = true,
  actor = null,
  dryRun = false,
}) {
  const targetVersion = targetQuoteVersion || null;
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  const currentVersionForMigrateGuard = Number(currentArtifacts?.quote?.version || currentArtifacts?.version || 0) || null;
  const targetArtifacts = (
    targetVersion
    && Number(targetVersion) !== Number(currentArtifacts?.version || currentArtifacts?.quote?.version || 0)
  )
    ? await readQuoteArtifacts(jobDir, targetVersion)
    : currentArtifacts;
  if (!targetArtifacts?.quote) {
    throw createJobActionError("target quote version not found", 404);
  }
  const resolvedMigrateTargetVersion = Number(targetArtifacts.quote.version || targetArtifacts.version || 0) || null;
  // Identical guard to reviseJobMilestoneInvoice (DEL-30 P2-1, round 6):
  // this writes targetArtifacts.quote straight over root via
  // persistCurrentQuoteLockArtifacts below, with no archive of the
  // displaced content (root artifacts are only ever archived on fork).
  // Migrating against any version other than the current root — in EITHER
  // direction — would destroy whatever root currently holds and leave a
  // colliding archive dir behind. The UI always requests the latest/current
  // version; this only blocks a caller (API/CLI) naming something else.
  if (
    resolvedMigrateTargetVersion
    && currentVersionForMigrateGuard
    && resolvedMigrateTargetVersion !== currentVersionForMigrateGuard
  ) {
    throw createJobActionError(
      `quote v${resolvedMigrateTargetVersion} is not the current quote (v${currentVersionForMigrateGuard}); promote it to the current version before migrating against it`,
      409,
    );
  }

  const hydratedMeta = await hydrateJobMeta(jobDir, meta);
  const targetFinancials = getCustomerPresentationFinancials(targetArtifacts.quote);
  const migrationId = `invoice-migration-${Date.now()}`;
  const synchronized = await synchronizeMilestoneInvoices({
    jobDir,
    meta: {
      ...hydratedMeta,
      quoteVersion: targetArtifacts.quote.version || hydratedMeta?.quoteVersion || null,
    },
    quote: targetArtifacts.quote,
    config,
  });
  let workingInvoices = synchronized.milestoneInvoices;
  const carryIndex = normalizeMilestoneIndex(carryMilestoneIndex, 0);
  const adjustmentIndex = normalizeMilestoneIndex(adjustmentMilestoneIndex, Math.min(1, workingInvoices.length - 1));
  const carriedAmount = roundMoney(carriedForwardAmount);

  for (const voidRequest of Array.isArray(voidPayments) ? voidPayments : []) {
    const paymentId = voidRequest?.paymentId || voidRequest?.id || null;
    if (!paymentId) continue;
    const voided = voidMilestoneInvoicePayment({
      milestoneInvoices: workingInvoices,
      milestoneIndex: voidRequest?.milestoneIndex ?? carryIndex,
      paymentId,
      reason: voidRequest?.reason || "Voided during invoice migration",
      actor,
    });
    workingInvoices = voided.milestoneInvoices;
  }

  const carryInvoice = workingInvoices.find((invoice) => invoice.milestoneIndex === carryIndex);
  if (!carryInvoice) {
    throw createJobActionError("carry milestone not found", 404);
  }

  const nextPaymentSchedule = buildMigratedPaymentSchedule({
    currentSchedule: synchronized.paymentSchedule,
    currentInvoices: workingInvoices,
    quoteTotal: targetFinancials.total,
    carriedForwardAmount: carriedAmount,
    carryMilestoneIndex: carryIndex,
    adjustmentMilestoneIndex: adjustmentIndex,
    sourceQuoteVersion,
  });

  const fixedByIndex = new Map(
    nextPaymentSchedule.milestones.map((milestone, index) => [index, roundMoney(milestone.fixedTotal)])
  );
  workingInvoices = workingInvoices.map((invoice) => {
    const nextTotal = fixedByIndex.get(invoice.milestoneIndex);
    const totalChanged = nextTotal != null && roundMoney(nextTotal) !== roundMoney(invoice.total);
    if (!totalChanged) return invoice;

    const activePaid = sumActiveMilestonePayments(invoice.payments || []);
    if (invoice.milestoneIndex !== carryIndex && activePaid > 0) {
      throw createJobActionError("cannot migrate invoice totals after a later milestone has payments", 409);
    }
    if (
      invoice.milestoneIndex !== carryIndex
      && resetChangedUnpaidInvoices
      && (invoice.status === "authorised" || invoice.issuedAt)
    ) {
      return {
        ...invoice,
        status: "draft",
        issuedAt: null,
        dueDate: null,
        paidAt: null,
      };
    }
    return invoice;
  });

  // Migration is an approved change: any invoice that is already issued and
  // whose claim actually moves is re-issued as an audited new revision rather
  // than rewritten under the number the customer already holds.
  const migrationRevisionAuthorizations = workingInvoices
    .filter((invoice) => {
      // Invoices the reset above already returned to draft retire their
      // revision on their own; they are not being re-issued.
      if (!invoice.issuedRevision || !invoice.issuedAt) return false;
      const nextTotal = fixedByIndex.get(invoice.milestoneIndex);
      return nextTotal != null && roundMoney(nextTotal) !== roundMoney(invoice.issuedRevision.total);
    })
    .map((invoice) => ({
      milestoneIndex: invoice.milestoneIndex,
      reason: `Invoice migration from quote v${sourceQuoteVersion || "prior"} to v${targetArtifacts.quote.version || targetArtifacts.version || "current"}`,
      actor,
    }));

  // First reshape the invoice claim to the carried amount while the deposit
  // is still open. Adding the payment before this build can mark a smaller
  // draft deposit as paid and freeze that old total, which hides the excess
  // behind amountPaid's safety cap until an operator issues a second revision.
  const scheduledMigration = buildMilestoneInvoices({
    meta: {
      ...synchronized.meta,
      paymentSchedule: nextPaymentSchedule,
      milestoneInvoices: workingInvoices,
    },
    quote: targetArtifacts.quote,
    paymentSchedule: nextPaymentSchedule,
    config,
    existingMilestoneInvoices: workingInvoices,
    revisionAuthorizations: migrationRevisionAuthorizations,
  });
  const paymentAnnotatedInvoices = scheduledMigration.milestoneInvoices.map((invoice) => (
    invoice.milestoneIndex === carryIndex
      ? annotateCarriedForwardPayment({
          invoice,
          carriedForwardAmount: carriedAmount,
          sourceQuoteVersion,
          sourceInvoiceNumber: carryInvoice.invoiceNumber,
          migrationId,
          paymentDate: carryInvoice.payments?.find((payment) => !payment?.voidedAt)?.date || null,
        })
      : invoice
  ));
  // Rebuild once more so a newly-paid deposit freezes the already-correct
  // claim and financial snapshot in its first issued revision.
  const migrated = buildMilestoneInvoices({
    meta: {
      ...synchronized.meta,
      paymentSchedule: nextPaymentSchedule,
      milestoneInvoices: paymentAnnotatedInvoices,
    },
    quote: targetArtifacts.quote,
    paymentSchedule: nextPaymentSchedule,
    config,
    existingMilestoneInvoices: paymentAnnotatedInvoices,
  });
  const plan = {
    migrationId,
    sourceQuoteVersion: Number(sourceQuoteVersion || 0) || null,
    targetQuoteVersion: targetArtifacts.quote.version || targetArtifacts.version || null,
    carriedForwardAmount: carriedAmount,
    voidedPaymentCount: (Array.isArray(voidPayments) ? voidPayments : []).filter((entry) => entry?.paymentId || entry?.id).length,
    resetChangedUnpaidInvoices,
    milestones: migrated.milestoneInvoices.map((invoice) => ({
      milestoneIndex: invoice.milestoneIndex,
      milestoneLabel: invoice.milestoneLabel,
      invoiceNumber: invoice.invoiceNumber,
      percentage: invoice.percentage,
      fixedTotal: invoice.fixedTotal || null,
      total: invoice.total,
      amountPaid: invoice.amountPaid,
      amountDue: invoice.amountDue,
      status: invoice.status,
      issuedAt: invoice.issuedAt,
    })),
  };

  if (dryRun) {
    return {
      meta: synchronized.meta,
      quote: targetArtifacts.quote,
      paymentSchedule: nextPaymentSchedule,
      milestoneInvoices: migrated.milestoneInvoices,
      migrationPlan: plan,
      quoteLifecycle: await readQuoteLifecycle(jobDir),
    };
  }

  const finalizedArtifacts = await persistCurrentQuoteLockArtifacts({
    jobDir,
    meta: {
      ...synchronized.meta,
      quoteVersion: targetArtifacts.quote.version || synchronized.meta?.quoteVersion || 1,
      pipelineStage: "landed",
      deliveryStatus: "landed",
    },
    quote: targetArtifacts.quote,
    lockStatus: "final",
    finalizedAt: synchronized.meta?.landedAt || new Date().toISOString(),
  });
  const persisted = await persistMilestoneInvoiceState({
    jobDir,
    meta: {
      ...finalizedArtifacts.meta,
      pipelineStage: "landed",
      deliveryStatus: "landed",
      paymentSchedule: nextPaymentSchedule,
    },
    quote: finalizedArtifacts.quote || targetArtifacts.quote,
    paymentSchedule: nextPaymentSchedule,
    milestoneInvoices: migrated.milestoneInvoices,
    writeAllArtifacts: true,
  });
  const quoteLifecycle = await recordQuoteCustomerVersionAccepted({
    jobDir,
    meta: persisted.meta,
    quoteVersion: targetArtifacts.quote.version || targetArtifacts.version || persisted.meta?.quoteVersion,
    acceptedAt: persisted.meta?.landedAt || new Date().toISOString(),
  });

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "invoice.milestones_migrated",
      ts: new Date().toISOString(),
      actor: actor || { kind: "system", label: "Field" },
      title: "Invoice milestones migrated",
      body: `Carried ${carriedAmount} from quote v${sourceQuoteVersion || "prior"} into v${targetArtifacts.quote.version || targetArtifacts.version || "current"} and rebuilt the remaining milestone invoices.`,
    },
  });

  return {
    ...persisted,
    quote: finalizedArtifacts.quote || targetArtifacts.quote,
    paymentSchedule: nextPaymentSchedule,
    milestoneInvoices: persisted.meta.milestoneInvoices || [],
    migrationPlan: plan,
    quoteLifecycle,
  };
}

/**
 * Issue an audited revised invoice for a milestone after an approved job
 * change (DEL-30).
 *
 * The sent invoice and its PDF are never touched. The approved quote revision
 * becomes the customer-facing basis, the superseded revision is retained in
 * full, and the milestone gains a new numbered invoice reflecting the approved
 * current values.
 */
export async function reviseJobMilestoneInvoice({
  jobDir,
  meta,
  config,
  milestoneIndex,
  reason = null,
  quoteVersion = null,
  expectedRevisionNumber = null,
  actor = null,
}) {
  const revisionReason = String(reason ?? "").trim();
  if (!revisionReason) {
    throw createJobActionError("a revision reason is required to reissue an invoice", 400);
  }

  const hydratedMeta = await hydrateJobMeta(jobDir, meta);
  if (normalizePipelineStage(hydratedMeta?.pipelineStage || hydratedMeta?.deliveryStatus) !== "landed") {
    throw createJobActionError("only landed jobs can issue a revised invoice", 409);
  }

  const currentInvoice = findMilestoneInvoice(hydratedMeta?.milestoneInvoices || [], milestoneIndex);
  if (!isMilestoneInvoiceIssued(currentInvoice)) {
    throw createJobActionError(
      "only an invoice that has already been issued can be revised; regenerate the draft instead",
      409,
    );
  }
  if (expectedRevisionNumber != null && expectedRevisionNumber !== "") {
    const expected = Number.parseInt(String(expectedRevisionNumber), 10);
    if (!Number.isFinite(expected) || expected !== Number(currentInvoice.revisionNumber)) {
      throw createJobActionError(
        `invoice ${currentInvoice.invoiceNumber} is already at revision ${currentInvoice.revisionNumber}; reload before revising`,
        409,
      );
    }
  }

  const currentArtifacts = await readQuoteArtifacts(jobDir);
  const currentVersion = Number(currentArtifacts?.quote?.version || currentArtifacts?.version || 0) || null;
  const requestedVersion = parseQuoteVersion(quoteVersion);
  const targetArtifacts = (requestedVersion && requestedVersion !== currentVersion)
    ? await readQuoteArtifacts(jobDir, requestedVersion)
    : currentArtifacts;
  if (!targetArtifacts?.quote) {
    throw createJobActionError("target quote version not found", 404);
  }
  const targetVersion = Number(targetArtifacts.quote.version || targetArtifacts.version || 0) || null;
  // More specific first: a version older than what this invoice was
  // actually issued against is never valid, regardless of where root is.
  // Worded so following it cannot itself cause the destructive path below:
  // after promoteQuoteVersion (which archives the displaced root at ITS OWN
  // number and REMOVES the promoted target's archive dir), an archive can
  // exist with a version NUMBER HIGHER than the current root — e.g. root v1
  // with quote-versions/v002 present, if v2 was promoted back down to v1.
  // If this pin (v2) is stale relative to what actually happened, telling
  // the operator to "pass --version v2" would have them request EXACTLY
  // that archive and overwrite root(v1) with it — irrecoverably, since v1's
  // own archive no longer exists (round 6 finding). Direct them to promote
  // instead of naming a version explicitly.
  const supersededVersion = currentInvoice.issuedRevision?.quoteVersion || null;
  if (supersededVersion && targetVersion && targetVersion < supersededVersion) {
    throw createJobActionError(
      `invoice ${currentInvoice.invoiceNumber} is pinned to quote v${supersededVersion}, which is newer than v${targetVersion}; if v${supersededVersion} is not already the current quote, promote it to current before revising — do not request that version number directly`,
      409,
    );
  }
  // Revising against ANY archived version other than the current root quote
  // — older OR newer — would write that archived content straight over
  // root with no archive of the displaced current version (root artifacts
  // are only ever archived on fork, forkCurrentQuoteVersion): irrecoverably
  // destroying whatever the current quote holds, and leaving the
  // promoted-from archive dir in place so root's version number now
  // collides with an existing quote-versions/vNNN dir, 409-bricking the
  // next fork. The "newer than current" direction is reachable via
  // promoteQuoteVersion, which can leave an archive dir numbered HIGHER
  // than the (older) content it promoted back to root (DEL-30 P2-1, round
  // 6 — the round 5 fix only closed the "older" direction). Reject
  // outright; the operator must promote that version to current first if
  // that is genuinely what they want.
  if (targetVersion && currentVersion && targetVersion !== currentVersion) {
    throw createJobActionError(
      `quote v${targetVersion} is not the current quote (v${currentVersion}); promote it to the current version before revising against it`,
      409,
    );
  }

  const revisedAt = new Date().toISOString();
  const authorization = {
    milestoneIndex: currentInvoice.milestoneIndex,
    reason: revisionReason,
    actor: actor || { kind: "system", label: "Field" },
    at: revisedAt,
  };
  const generated = buildMilestoneInvoices({
    meta: hydratedMeta,
    quote: targetArtifacts.quote,
    paymentSchedule: hydratedMeta?.paymentSchedule || null,
    config,
    existingMilestoneInvoices: hydratedMeta?.milestoneInvoices || [],
    revisionAuthorizations: [authorization],
    now: revisedAt,
  });
  const nextInvoice = generated.milestoneInvoices
    .find((invoice) => invoice.milestoneIndex === currentInvoice.milestoneIndex);
  if (!nextInvoice?.issuedRevision) {
    throw createJobActionError("the revised invoice could not be issued", 500);
  }

  const change = describeInvoiceRevisionChange({
    previous: currentInvoice.issuedRevision,
    next: nextInvoice.issuedRevision,
  });
  // (Removed, DEL-30 P3-2, round 5: a
  // `nextInvoice.revisionNumber === currentInvoice.revisionNumber` guard
  // used to sit here. It can never fire — an authorization always retires
  // the current revision and mints max(history)+1 (invoice-revisions.js's
  // resolveMilestoneRevisionState), which is strictly greater than the
  // revision number being retired, for both native and — since DEL-30 P2-1
  // fixed legacy synthesis to always populate `active` for any issued
  // index — legacy invoices too. This is the exact guard that produced the
  // original P1-B's misleading "the approved values are unchanged" error
  // when legacy synthesis was broken; keeping unreachable code with a
  // misleading message is worse than removing it. The fingerprint check
  // immediately below is the real, correct idempotency gate.)
  // A repeated request lands here: the previous revision already carries the
  // approved values, so no second identical invoice is minted. `currentInvoice.issuedRevision`
  // is null for a never-synchronized pre-DEL-30 invoice (the legacy
  // synthesis and this authorization happen in the same buildMilestoneInvoices
  // call above, so `currentInvoice` — read before that call — still reflects
  // the raw stored record with no issuedRevision at all). That does NOT mean
  // there is nothing for such a request to already match, though (DEL-30
  // P3-2, round 6 — corrects a round-5 comment that claimed otherwise):
  // legacy synthesis inside buildMilestoneInvoices fabricates a snapshot of
  // the invoice's pre-DEL-30 stored content and immediately retires it as
  // part of this same authorized mint (resolveMilestoneRevisionState always
  // mints under an explicit authorization, never silently restores). That
  // retired snapshot is exactly the entry `nextInvoice.issuedRevision.supersedesRevisionNumber`
  // names, sitting in `nextInvoice.revisionHistory` right now. Compare
  // against that instead so a revise whose reallocated values are identical
  // to the legacy content still 409s, rather than burning a number and
  // minting a duplicate-content -R2.
  const legacySupersededRevision = (
    !currentInvoice.issuedRevision
    && nextInvoice.issuedRevision?.supersedesRevisionNumber != null
  )
    ? (nextInvoice.revisionHistory || []).find(
        (entry) => entry.revisionNumber === nextInvoice.issuedRevision.supersedesRevisionNumber,
      ) || null
    : null;
  const priorRevisionToCompare = currentInvoice.issuedRevision || legacySupersededRevision;
  if (
    priorRevisionToCompare
    && buildInvoiceRevisionFingerprint(priorRevisionToCompare)
      === buildInvoiceRevisionFingerprint(nextInvoice.issuedRevision)
  ) {
    throw createJobActionError(
      `invoice ${currentInvoice.invoiceNumber} already reflects the approved values; there is nothing to revise`,
      409,
    );
  }
  if (roundMoney(nextInvoice.total) < roundMoney(currentInvoice.amountPaid)) {
    throw createJobActionError(
      "a revised invoice cannot be lower than the amount already paid; void the payment first",
      409,
    );
  }

  const finalizedArtifacts = await persistCurrentQuoteLockArtifacts({
    jobDir,
    meta: {
      ...hydratedMeta,
      quoteVersion: targetVersion || hydratedMeta?.quoteVersion || 1,
      pipelineStage: "landed",
      deliveryStatus: "landed",
    },
    quote: targetArtifacts.quote,
    lockStatus: "final",
    finalizedAt: hydratedMeta?.landedAt || revisedAt,
  });
  const persisted = await persistMilestoneInvoiceState({
    jobDir,
    meta: {
      ...finalizedArtifacts.meta,
      pipelineStage: "landed",
      deliveryStatus: "landed",
    },
    quote: finalizedArtifacts.quote || targetArtifacts.quote,
    paymentSchedule: generated.paymentSchedule,
    milestoneInvoices: generated.milestoneInvoices,
    artifactMilestoneIndex: currentInvoice.milestoneIndex,
    writeAllArtifacts: true,
  });
  const quoteLifecycle = await recordQuoteCustomerVersionAccepted({
    jobDir,
    meta: persisted.meta,
    quoteVersion: targetVersion || persisted.meta?.quoteVersion,
    acceptedAt: revisedAt,
  });

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "invoice.revised",
      ts: revisedAt,
      actor: actor || { kind: "system", label: "Field" },
      title: "Revised invoice issued",
      body: [
        `${change.invoiceNumber} (revision ${change.revisionNumber}) supersedes ${change.supersedesInvoiceNumber}`,
        `total ${change.supersededTotal} → ${change.total}`,
        change.supersededQuoteVersion || change.quoteVersion
          // A legacy-synthesized predecessor's quote version is pinned to
          // whatever was live at rebuild time, not a historically-accurate
          // record of what the customer's document actually reflected — say
          // so rather than presenting it as known (DEL-30 P3-1).
          ? `quote v${change.supersededQuoteVersion || "?"}${change.supersededQuoteVersionInferred ? " (inferred)" : ""} → v${change.quoteVersion || "?"}`
          : null,
        `Reason: ${revisionReason}`,
      ].filter(Boolean).join(". ") + ".",
    },
  });

  return {
    ...persisted,
    quote: finalizedArtifacts.quote || targetArtifacts.quote,
    paymentSchedule: generated.paymentSchedule,
    milestoneInvoices: persisted.meta.milestoneInvoices || [],
    revision: change,
    quoteLifecycle,
  };
}

export async function updateJobMilestone({
  jobDir,
  meta,
  config,
  milestoneIndex,
  patch = {},
  actor = null,
}) {
  const {
    meta: resolvedMeta,
    selectedQuoteArtifacts,
  } = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType: "invoice",
  });
  const quote = selectedQuoteArtifacts?.quote || await readPersistedQuote(jobDir);
  const synchronized = await synchronizeMilestoneInvoices({
    jobDir,
    meta: resolvedMeta,
    quote,
    config,
  });
  const updated = updateMilestoneInvoice({
    milestoneInvoices: synchronized.milestoneInvoices,
    milestoneIndex,
    patch,
    quoteVersion: quote?.version || synchronized.meta?.quoteVersion || null,
    actor,
  });
  const persisted = await persistMilestoneInvoiceState({
    jobDir,
    meta: synchronized.meta,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: updated.milestoneInvoices,
    artifactMilestoneIndex: updated.milestoneInvoice.milestoneIndex,
  });

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "invoice.milestone_updated",
      ts: new Date().toISOString(),
      actor: actor || { kind: "system", label: "Field" },
      title: "Milestone updated",
      body: `${updated.milestoneInvoice.invoiceNumber} updated.${updated.milestoneInvoice.dueDate ? ` Due ${updated.milestoneInvoice.dueDate}.` : ""} Status ${updated.milestoneInvoice.status}.`,
    },
  });

  return {
    ...persisted,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: persisted.meta.milestoneInvoices || [],
  };
}

export async function recordJobMilestonePayment({
  jobDir,
  meta,
  config,
  milestoneIndex,
  payment = {},
  actor = null,
}) {
  const {
    meta: resolvedMeta,
    selectedQuoteArtifacts,
  } = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType: "invoice",
  });
  const quote = selectedQuoteArtifacts?.quote || await readPersistedQuote(jobDir);
  const synchronized = await synchronizeMilestoneInvoices({
    jobDir,
    meta: resolvedMeta,
    quote,
    config,
  });
  const recorded = recordMilestoneInvoicePayment({
    milestoneInvoices: synchronized.milestoneInvoices,
    milestoneIndex,
    payment,
  });
  const persisted = await persistMilestoneInvoiceState({
    jobDir,
    meta: synchronized.meta,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: recorded.milestoneInvoices,
    artifactMilestoneIndex: recorded.milestoneInvoice.milestoneIndex,
  });

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "invoice.payment_recorded",
      ts: recorded.payment.recordedAt,
      actor: actor || { kind: "system", label: "Field" },
      title: "Milestone payment recorded",
      body: `${recorded.milestoneInvoice.invoiceNumber}: ${recorded.payment.amount} recorded on ${recorded.payment.date}.`,
    },
  });

  return {
    ...persisted,
    payment: recorded.payment,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: persisted.meta.milestoneInvoices || [],
  };
}

export async function voidJobMilestonePayment({
  jobDir,
  meta,
  config,
  milestoneIndex,
  paymentId,
  reason = null,
  actor = null,
}) {
  const {
    meta: resolvedMeta,
    selectedQuoteArtifacts,
  } = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType: "invoice",
  });
  const quote = selectedQuoteArtifacts?.quote || await readPersistedQuote(jobDir);
  const synchronized = await synchronizeMilestoneInvoices({
    jobDir,
    meta: resolvedMeta,
    quote,
    config,
  });
  const voided = voidMilestoneInvoicePayment({
    milestoneInvoices: synchronized.milestoneInvoices,
    milestoneIndex,
    paymentId,
    reason,
    actor,
  });
  const persisted = await persistMilestoneInvoiceState({
    jobDir,
    meta: synchronized.meta,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: voided.milestoneInvoices,
    artifactMilestoneIndex: voided.milestoneInvoice.milestoneIndex,
  });

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "invoice.payment_voided",
      ts: voided.payment.voidedAt,
      actor: actor || { kind: "system", label: "Field" },
      title: "Milestone payment voided",
      body: `${voided.milestoneInvoice.invoiceNumber}: ${voided.payment.amount} voided. ${voided.payment.voidReason || ""}`.trim(),
    },
  });

  return {
    ...persisted,
    payment: voided.payment,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: persisted.meta.milestoneInvoices || [],
  };
}

export async function markJobMilestoneUnpaid({
  jobDir,
  meta,
  config,
  milestoneIndex,
  actor = null,
}) {
  const {
    meta: resolvedMeta,
    selectedQuoteArtifacts,
  } = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType: "invoice",
  });
  const quote = selectedQuoteArtifacts?.quote || await readPersistedQuote(jobDir);
  const synchronized = await synchronizeMilestoneInvoices({
    jobDir,
    meta: resolvedMeta,
    quote,
    config,
  });
  const updated = markMilestoneInvoiceUnpaid({
    milestoneInvoices: synchronized.milestoneInvoices,
    milestoneIndex,
  });
  const persisted = await persistMilestoneInvoiceState({
    jobDir,
    meta: synchronized.meta,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: updated.milestoneInvoices,
    artifactMilestoneIndex: updated.milestoneInvoice.milestoneIndex,
  });

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "invoice.marked_unpaid",
      ts: new Date().toISOString(),
      actor: actor || { kind: "system", label: "Field" },
      title: "Milestone reset to unpaid",
      body: `${updated.milestoneInvoice.invoiceNumber} reset to unpaid. Receipt artifact removed.`,
    },
  });

  return {
    ...persisted,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: persisted.meta.milestoneInvoices || [],
  };
}

export async function markJobMilestoneUnsent({
  jobDir,
  meta,
  config,
  milestoneIndex,
  actor = null,
}) {
  const {
    meta: resolvedMeta,
    selectedQuoteArtifacts,
  } = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType: "invoice",
  });
  const quote = selectedQuoteArtifacts?.quote || await readPersistedQuote(jobDir);
  const synchronized = await synchronizeMilestoneInvoices({
    jobDir,
    meta: resolvedMeta,
    quote,
    config,
  });
  const updated = markMilestoneInvoiceUnsent({
    milestoneInvoices: synchronized.milestoneInvoices,
    milestoneIndex,
  });
  const persisted = await persistMilestoneInvoiceState({
    jobDir,
    meta: synchronized.meta,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: updated.milestoneInvoices,
    artifactMilestoneIndex: updated.milestoneInvoice.milestoneIndex,
  });

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "invoice.marked_unsent",
      ts: new Date().toISOString(),
      actor: actor || { kind: "system", label: "Field" },
      title: "Milestone reset to draft",
      body: `${updated.milestoneInvoice.invoiceNumber} reset to draft. Milestone locks released.`,
    },
  });

  return {
    ...persisted,
    quote,
    paymentSchedule: synchronized.paymentSchedule,
    milestoneInvoices: persisted.meta.milestoneInvoices || [],
  };
}

export async function setJobPipelineStage({
  jobDir,
  meta,
  dataDir = null,
  config = null,
  stage,
  actor = null,
}) {
  if ((meta?.outputMode || "report") !== "quote") {
    const err = new Error("only quote jobs can change quote status");
    err.statusCode = 409;
    throw err;
  }

  const rawStage = String(stage || "").trim().toLowerCase();
  if (!PIPELINE_STAGES.includes(rawStage)) {
    const err = new Error("valid quote status required");
    err.statusCode = 400;
    throw err;
  }
  const nextStage = normalizePipelineStage(stage);
  const currentStage = normalizePipelineStage(meta?.pipelineStage);
  if (currentStage === nextStage) {
    return {
      meta,
      quoteLifecycle: await readQuoteLifecycle(jobDir),
    };
  }
  if (!canTransitionPipelineStage(currentStage, nextStage)) {
    const err = new Error(`cannot move quote status from ${currentStage} to ${nextStage}`);
    err.statusCode = 409;
    throw err;
  }
  if (isPipelineSent(nextStage) && !isPipelineSent(currentStage)) {
    const sentArtifacts = await readQuoteArtifacts(jobDir);
    if (sentArtifacts?.quote) {
      assertQuoteLineItemCostsComplete(sentArtifacts.quote);
    }
  }
  if (nextStage === "landed") {
    return await markJobLanded({
      jobDir,
      meta,
      dataDir,
      config,
      actor,
    });
  }

  const ts = new Date().toISOString();
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  const currentQuoteLifecycle = await readQuoteLifecycle(jobDir);
  const currentQuoteVersion = Number(
    currentArtifacts?.quote?.version
    || meta?.quoteVersion
    || 1
  );
  const currentPolicy = buildQuoteEditPolicy({
    meta,
    quoteLifecycle: currentQuoteLifecycle,
    latestVersion: currentQuoteVersion,
    selectedVersion: currentQuoteVersion,
  });
  const nextMeta = {
    ...meta,
    pipelineStage: nextStage,
    deliveryStatus: nextStage,
    // Only a delivery records a send time. Moving the stage by hand is
    // recorded in the quote lifecycle (markedSent*) and the activity log.
    quoteSentAt: meta?.quoteSentAt || null,
    landedAt: (nextStage === "landed" || currentStage === "landed" || meta?.landedAt)
      ? (meta?.landedAt || ts)
      : null,
    lostAt: (nextStage === "lost" || currentStage === "lost" || meta?.lostAt)
      ? (meta?.lostAt || ts)
      : null,
    invoicePaidAmount: (nextStage === "landed" || currentStage === "landed")
      ? (Number.isFinite(Number(meta?.invoicePaidAmount)) ? Number(meta.invoicePaidAmount) : 0)
      : meta?.invoicePaidAmount ?? null,
    invoiceSentAt: (nextStage === "landed" || currentStage === "landed")
      ? (meta?.invoiceSentAt || null)
      : meta?.invoiceSentAt ?? null,
  };
  const shouldFinalizeCurrentQuote =
    nextStage !== "draft"
    && (currentStage === "draft" || currentPolicy.latestVersionLocked);
  let finalMeta = nextMeta;
  if (shouldFinalizeCurrentQuote) {
    const finalizedArtifacts = await persistCurrentQuoteLockArtifacts({
      jobDir,
      meta: nextMeta,
      lockStatus: "final",
      finalizedAt: nextMeta.quoteSentAt || ts,
    });
    finalMeta = finalizedArtifacts.meta;
  }
  finalMeta = await writePersistedMeta(jobDir, finalMeta);

  await appendJobActivity({
    jobDir,
    activity: {
      kind: "quote.status_updated",
      ts,
      actor: actor || { kind: "system", label: "Field" },
      title: "Quote status updated",
      body: `Quote status changed from ${currentStage} to ${nextStage}.`,
    },
  });

  const quoteLifecycle = await recordQuotePipelineStageChange({
    jobDir,
    meta: finalMeta,
    stage: nextStage,
    previousStage: currentStage,
    changedAt: ts,
    actor,
  });

  return {
    meta: finalMeta,
    quoteLifecycle,
  };
}

function mergeOverrideEntries(existing = {}, incoming = {}) {
  const merged = { ...(existing || {}) };
  for (const [key, nextValue] of Object.entries(incoming || {})) {
    if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)) {
      merged[key] = nextValue;
      continue;
    }
    const previousValue = merged[key];
    const nextEntry = {
      ...(previousValue && typeof previousValue === "object" && !Array.isArray(previousValue) ? previousValue : {}),
      ...nextValue,
    };
    if (Object.prototype.hasOwnProperty.call(nextValue, "reviewState")) {
      nextEntry.reviewState = nextValue.reviewState && typeof nextValue.reviewState === "object"
        ? {
            ...(previousValue?.reviewState && typeof previousValue.reviewState === "object" ? previousValue.reviewState : {}),
            ...nextValue.reviewState,
          }
        : null;
    }
    merged[key] = nextEntry;
  }
  return merged;
}

function mergeExecutionOverrides(existing = null, incoming = null) {
  if (!incoming || typeof incoming !== "object") {
    return compactExecutionOverrides(existing);
  }

  return compactExecutionOverrides({
    ...(existing && typeof existing === "object" ? existing : {}),
    ...incoming,
  });
}

function mergeOptionSelectionOverrides(existing = {}, incoming = {}) {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    const nextKey = String(key || "").trim();
    const nextValue = String(value || "").trim();
    if (!nextKey || !nextValue) continue;
    merged[nextKey] = nextValue;
  }
  return merged;
}

function compactExecutionOverrides(value) {
  if (!value || typeof value !== "object") return null;

  const next = {};

  if (typeof value.accessProfile === "string" && value.accessProfile.trim()) {
    next.accessProfile = value.accessProfile.trim();
  }
  if (Number.isFinite(Number(value.labourHours))) {
    next.labourHours = Number(value.labourHours);
  }
  if (Number.isFinite(Number(value.machineHours))) {
    next.machineHours = Number(value.machineHours);
  }
  if (Number.isFinite(Number(value.dumpDriveMinutes))) {
    next.dumpDriveMinutes = Number(value.dumpDriveMinutes);
  }
  if (Number.isFinite(Number(value.travelHoursPerDay))) {
    next.travelHoursPerDay = Number(value.travelHoursPerDay);
  }
  if (typeof value.note === "string" && value.note.trim()) {
    next.note = value.note.trim();
  }

  return Object.keys(next).length ? next : null;
}
