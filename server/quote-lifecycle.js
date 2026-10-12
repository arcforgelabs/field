import { existsSync } from "./storage/fs.js";
import { readFile, writeFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { isPipelineSent, normalizePipelineStage } from "./pipeline.js";
import { deriveCurrentQuoteLockStatus } from "./quote-edit-policy.js";
import { resolveActiveJobGeneration, resolveWritableJobGeneration } from "./job-generation.js";

export const QUOTE_LIFECYCLE_FILE = "quote-lifecycle.json";

export async function readQuoteLifecycle(jobDir) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const filePath = join(jobDir, QUOTE_LIFECYCLE_FILE);
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function markQuoteBuilt({
  jobDir,
  meta,
  quote,
  reason = "quote_build",
}) {
  const ts = quote?.updatedAt || quote?.generatedAt || new Date().toISOString();
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    draft.firstBuiltAt ||= ts;
    draft.lastBuiltAt = ts;
    draft.buildCount += 1;
    draft.lastBuildReason = reason;
    draft.buildReasons[reason] = (draft.buildReasons[reason] || 0) + 1;
    draft.currentQuoteVersion = Number(quote?.version || meta?.quoteVersion || draft.currentQuoteVersion || 1);
    draft.currentPipelineStage = normalizePipelineStage(meta?.pipelineStage || draft.currentPipelineStage);
    return draft;
  });
}

export async function recordQuoteCorrections({
  jobDir,
  lineItemCount = 0,
  assumptionCount = 0,
  actor = null,
}) {
  const correctionDelta = Number(lineItemCount) + Number(assumptionCount);
  if (!correctionDelta) {
    return await readQuoteLifecycle(jobDir);
  }
  const ts = new Date().toISOString();
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    draft.correctionCount += 1;
    draft.lineItemCorrectionCount += Number(lineItemCount);
    draft.assumptionCorrectionCount += Number(assumptionCount);
    draft.lastCorrectedAt = ts;
    draft.lastCorrectionActor = actor || null;
    return draft;
  });
}

export async function recordQuoteLockStatusChange({
  jobDir,
  lockStatus,
}) {
  const nextStatus = String(lockStatus || "draft").trim().toLowerCase() === "final" ? "final" : "draft";
  const ts = new Date().toISOString();
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    if (draft.currentLockStatus !== nextStatus) {
      draft.lockStatusChangeCount += 1;
      draft.lastLockStatusChangeAt = ts;
    }
    draft.currentLockStatus = nextStatus;
    return draft;
  });
}

export async function recordQuoteSent({
  jobDir,
  meta,
  quoteVersion,
  to,
  sentAt = null,
  preserveCurrentQuoteVersion = false,
  currentQuoteVersion = null,
  currentPipelineStage = null,
}) {
  const ts = sentAt || meta?.quoteSentAt || new Date().toISOString();
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    draft.sendCount += 1;
    draft.lastSentAt = ts;
    draft.lastSentQuoteVersion = Number(quoteVersion || meta?.quoteVersion || draft.currentQuoteVersion || 1);
    draft.lastSentTo = to || null;
    draft.currentQuoteVersion = preserveCurrentQuoteVersion
      ? Number(currentQuoteVersion || meta?.quoteVersion || draft.currentQuoteVersion || draft.lastSentQuoteVersion || 1)
      : draft.lastSentQuoteVersion;
    draft.currentPipelineStage = preserveCurrentQuoteVersion
      ? normalizePipelineStage(currentPipelineStage || meta?.pipelineStage || draft.currentPipelineStage || "sent")
      : "sent";
    return draft;
  });
}

// sendCount / lastSentAt / lastSentQuoteVersion are issuance evidence: the
// issued-copy routes treat lastSentQuoteVersion as "the customer was sent this
// version" (isIssuedQuoteVersion). Only a successful delivery (recordQuoteSent)
// writes them, plus a backfill for jobs sent before this file existed, whose
// meta carries the send time (quoteSentAt). A job stage on its own is not
// evidence: moving a quote to Sent, Landed or Lost by hand records a mark
// (markedSent*) that keeps the version locked but never reads as issued.
function hasLegacySendEvidence(draft, meta) {
  return !draft.sendCount && Boolean(meta?.quoteSentAt);
}

function backfillLegacySend(draft, meta) {
  draft.sendCount = 1;
  draft.lastSentAt = draft.lastSentAt || meta?.quoteSentAt || null;
  draft.lastSentQuoteVersion = draft.lastSentQuoteVersion || Number(meta?.quoteVersion || draft.currentQuoteVersion || 1);
}

function markSentByHand(draft, { meta = null, at = null, actor = null } = {}) {
  const version = Number(meta?.quoteVersion || draft.currentQuoteVersion || 1);
  if (Number(draft.markedSentQuoteVersion) === version) return;
  draft.markedSentQuoteVersion = version;
  draft.markedSentAt = at || new Date().toISOString();
  draft.markedSentBy = actor?.label || actor?.email || actor?.id || null;
}

export async function recordQuoteLanded({
  jobDir,
  meta = null,
  landedAt = null,
}) {
  const ts = landedAt || meta?.landedAt || new Date().toISOString();
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    if (hasLegacySendEvidence(draft, meta)) {
      backfillLegacySend(draft, meta);
    } else if (!draft.sendCount && !draft.markedSentQuoteVersion && isPipelineSent(meta?.pipelineStage)) {
      markSentByHand(draft, { meta, at: ts });
    }
    draft.landedAt = ts;
    draft.currentPipelineStage = "landed";
    draft.currentQuoteVersion = Number(
      meta?.quoteVersion
      || draft.currentQuoteVersion
      || draft.lastSentQuoteVersion
      || 1
    );
    return draft;
  });
}

export async function recordQuotePipelineStageChange({
  jobDir,
  meta = null,
  stage,
  previousStage = null,
  changedAt = null,
  actor = null,
}) {
  const nextStage = normalizePipelineStage(stage);
  const ts = changedAt || new Date().toISOString();
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    if (isPipelineSent(nextStage) && !draft.sendCount) {
      if (hasLegacySendEvidence(draft, meta)) backfillLegacySend(draft, meta);
      else markSentByHand(draft, { meta, at: ts, actor });
    } else if (
      previousStage
      && isPipelineSent(previousStage)
      && !draft.sendCount
      && !meta?.quoteSentAt
      && !draft.markedSentQuoteVersion
    ) {
      // Leaving a hand-set Sent stage: the customer may have the version, so
      // keep it locked (a rebuild forks) without calling it issued.
      markSentByHand(draft, { meta, at: ts, actor });
    }
    if (nextStage === "landed") {
      draft.landedAt = draft.landedAt || meta?.landedAt || ts;
    }
    if (nextStage === "lost") {
      draft.lostAt = draft.lostAt || meta?.lostAt || ts;
    }
    draft.currentPipelineStage = nextStage;
    draft.currentQuoteVersion = Number(
      meta?.quoteVersion
      || draft.currentQuoteVersion
      || draft.lastSentQuoteVersion
      || 1
    );
    return draft;
  });
}

export async function recordQuoteVersionPromoted({
  jobDir,
  quoteVersion,
}) {
  const nextVersion = Number(quoteVersion || 0);
  if (!nextVersion) return await readQuoteLifecycle(jobDir);
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    draft.currentQuoteVersion = nextVersion;
    return draft;
  });
}

export async function recordQuoteCustomerVersionAccepted({
  jobDir,
  meta = null,
  quoteVersion,
  acceptedAt = null,
}) {
  const acceptedVersion = Number(quoteVersion || meta?.quoteVersion || 0);
  if (!acceptedVersion) return await readQuoteLifecycle(jobDir);
  const ts = acceptedAt || meta?.landedAt || new Date().toISOString();
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    if (!draft.sendCount) draft.sendCount = 1;
    draft.lastSentAt = meta?.quoteSentAt || draft.lastSentAt || ts;
    draft.lastSentQuoteVersion = acceptedVersion;
    draft.currentQuoteVersion = acceptedVersion;
    draft.currentPipelineStage = normalizePipelineStage(meta?.pipelineStage || draft.currentPipelineStage || "landed");
    if (draft.currentPipelineStage === "landed") {
      draft.landedAt = draft.landedAt || meta?.landedAt || ts;
    }
    return draft;
  });
}

export async function recordQuoteArchived({
  jobDir,
  meta = null,
  archivedAt = null,
  archivedReason = null,
}) {
  const ts = archivedAt || new Date().toISOString();
  return await mutateQuoteLifecycle(jobDir, (draft) => {
    const wasSentAlready =
      draft.sendCount > 0
      || Boolean(meta?.quoteSentAt)
      || Boolean(draft.markedSentQuoteVersion)
      || isPipelineSent(meta?.pipelineStage);
    if (hasLegacySendEvidence(draft, meta)) backfillLegacySend(draft, meta);
    draft.archivedAt = ts;
    draft.archivedReason = archivedReason || null;
    draft.archivedBeforeSend = !wasSentAlready;
    draft.abandonedAt = !wasSentAlready ? ts : null;
    return draft;
  });
}

async function mutateQuoteLifecycle(jobDir, mutate) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const filePath = join(jobDir, QUOTE_LIFECYCLE_FILE);
  const current = existsSync(filePath)
    ? JSON.parse(await readFile(filePath, "utf8"))
    : buildDefaultQuoteLifecycle();
  const draft = mutate({
    ...buildDefaultQuoteLifecycle(),
    ...current,
    buildReasons: { ...(current.buildReasons || {}) },
  }) || current;
  const createdAt = current.createdAt || draft.firstBuiltAt || draft.lastBuiltAt || new Date().toISOString();
  const next = {
    ...draft,
    createdAt,
    currentLockStatus: deriveCurrentQuoteLockStatus({
      currentQuoteVersion: draft.currentQuoteVersion,
      lastSentQuoteVersion: Math.max(
        Number(draft.lastSentQuoteVersion) || 0,
        Number(draft.markedSentQuoteVersion) || 0,
      ) || null,
    }),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(next, null, 2));
  return next;
}

function buildDefaultQuoteLifecycle() {
  return {
    version: 1,
    createdAt: null,
    updatedAt: null,
    firstBuiltAt: null,
    lastBuiltAt: null,
    buildCount: 0,
    buildReasons: {},
    lastBuildReason: null,
    currentQuoteVersion: null,
    currentPipelineStage: "draft",
    currentLockStatus: "draft",
    correctionCount: 0,
    lineItemCorrectionCount: 0,
    assumptionCorrectionCount: 0,
    lastCorrectedAt: null,
    lastCorrectionActor: null,
    lockStatusChangeCount: 0,
    lastLockStatusChangeAt: null,
    sendCount: 0,
    lastSentAt: null,
    lastSentQuoteVersion: null,
    lastSentTo: null,
    markedSentQuoteVersion: null,
    markedSentAt: null,
    markedSentBy: null,
    landedAt: null,
    lostAt: null,
    archivedAt: null,
    archivedReason: null,
    archivedBeforeSend: false,
    abandonedAt: null,
  };
}
