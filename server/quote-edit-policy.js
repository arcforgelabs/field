import { isPipelineSent, normalizePipelineStage } from "./pipeline.js";

function toPositiveInt(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function inferLastSentQuoteVersion({
  meta = null,
  quoteLifecycle = null,
  currentQuoteVersion = null,
} = {}) {
  // The newest version the customer may have: one Field delivered, or one an
  // operator moved to Sent by hand. Either locks it; only a delivery is
  // issuance evidence (quote-lifecycle.js).
  const lifecycleVersion = Math.max(
    toPositiveInt(quoteLifecycle?.lastSentQuoteVersion) || 0,
    toPositiveInt(quoteLifecycle?.markedSentQuoteVersion) || 0,
  ) || null;
  if (lifecycleVersion) return lifecycleVersion;

  const historicalCustomerSeen = Boolean(
    meta?.quoteSentAt
    || meta?.landedAt
    || meta?.lostAt
    || quoteLifecycle?.sendCount
    || isPipelineSent(meta?.pipelineStage || meta?.deliveryStatus)
  );
  if (!historicalCustomerSeen) return null;

  const fallbackVersion = (
    toPositiveInt(meta?.quoteVersion)
    || toPositiveInt(currentQuoteVersion)
    || null
  );
  if (!fallbackVersion) return null;

  // Legacy jobs and restored backups may be missing quote-lifecycle.json.
  // If the pipeline is currently draft with historical send signals, the
  // current draft itself cannot be what the customer saw — cap the fallback
  // at the previous revision so policy does not mistake the new draft for
  // the locked customer-seen revision.
  const businessStage = normalizePipelineStage(
    meta?.pipelineStage
    || meta?.deliveryStatus
    || quoteLifecycle?.currentPipelineStage
  );
  if (businessStage === "draft") {
    return fallbackVersion > 1 ? fallbackVersion - 1 : null;
  }
  return fallbackVersion;
}

export function isQuoteVersionLockedByHistory({
  quoteVersion = null,
  lastSentQuoteVersion = null,
} = {}) {
  const currentVersion = toPositiveInt(quoteVersion);
  const sentVersion = toPositiveInt(lastSentQuoteVersion);
  if (!currentVersion || !sentVersion) return false;
  return currentVersion <= sentVersion;
}

export function deriveCurrentQuoteLockStatus({
  currentQuoteVersion = null,
  lastSentQuoteVersion = null,
} = {}) {
  return isQuoteVersionLockedByHistory({
    quoteVersion: currentQuoteVersion,
    lastSentQuoteVersion,
  }) ? "final" : "draft";
}

export function buildQuoteEditPolicy({
  meta = null,
  quoteLifecycle = null,
  latestVersion = null,
  selectedVersion = null,
} = {}) {
  const latestQuoteVersion = (
    toPositiveInt(latestVersion)
    || toPositiveInt(quoteLifecycle?.currentQuoteVersion)
    || toPositiveInt(meta?.quoteVersion)
    || null
  );
  const selectedQuoteVersion = toPositiveInt(selectedVersion) || latestQuoteVersion;
  const lastSentQuoteVersion = inferLastSentQuoteVersion({
    meta,
    quoteLifecycle,
    currentQuoteVersion: latestQuoteVersion,
  });
  const businessStage = normalizePipelineStage(meta?.pipelineStage || meta?.deliveryStatus);
  const existingDraftVersion = (
    latestQuoteVersion
    && lastSentQuoteVersion
    && latestQuoteVersion > lastSentQuoteVersion
  ) ? latestQuoteVersion : null;
  const selectedIsLatest = (
    latestQuoteVersion != null
    && selectedQuoteVersion != null
    && latestQuoteVersion === selectedQuoteVersion
  );
  // Draft stage: the operator explicitly set the job back to work-in-progress,
  // so the latest version is always editable regardless of send history.
  const draftUnlock = businessStage === "draft";
  const selectedVersionLocked = (
    !selectedIsLatest
    || (!draftUnlock && isQuoteVersionLockedByHistory({
      quoteVersion: selectedQuoteVersion,
      lastSentQuoteVersion,
    }))
  );
  const latestVersionLocked = !draftUnlock && isQuoteVersionLockedByHistory({
    quoteVersion: latestQuoteVersion,
    lastSentQuoteVersion,
  });
  const selectedVersionStage = (
    selectedQuoteVersion
    && lastSentQuoteVersion
    && selectedQuoteVersion > lastSentQuoteVersion
  ) ? "draft" : businessStage;
  const latestVersionStage = existingDraftVersion ? "draft" : businessStage;

  let lockReason = null;
  if (!selectedIsLatest) {
    lockReason = "Historical versions are read-only.";
  } else if (selectedVersionLocked) {
    lockReason = existingDraftVersion
      ? `This customer-seen version is locked. Edit draft v${String(existingDraftVersion).padStart(3, "0")} instead.`
      : "This customer-seen version is locked. Create a new draft revision to make changes.";
  }

  return {
    businessStage,
    latestVersion: latestQuoteVersion,
    selectedVersion: selectedQuoteVersion,
    lastSentQuoteVersion,
    existingDraftVersion,
    selectedIsLatest,
    selectedVersionStage,
    latestVersionStage,
    selectedVersionLocked,
    latestVersionLocked,
    canEditSelectedVersion: Boolean(selectedIsLatest && !selectedVersionLocked),
    requiresDraftRevision: Boolean(selectedVersionLocked && !existingDraftVersion),
    lockReason,
  };
}

export function resolveDefaultSelectedQuoteVersion({
  requestedVersion = null,
  meta = null,
  quoteLifecycle = null,
  latestVersion = null,
} = {}) {
  const explicitVersion = toPositiveInt(requestedVersion);
  if (explicitVersion) return explicitVersion;

  const resolvedLatestVersion = (
    toPositiveInt(latestVersion)
    || toPositiveInt(quoteLifecycle?.currentQuoteVersion)
    || toPositiveInt(meta?.quoteVersion)
    || null
  );
  if (!resolvedLatestVersion) return null;

  const businessStage = normalizePipelineStage(
    meta?.pipelineStage
    || quoteLifecycle?.currentPipelineStage
    || meta?.deliveryStatus
  );
  const lastSentQuoteVersion = inferLastSentQuoteVersion({
    meta,
    quoteLifecycle,
    currentQuoteVersion: resolvedLatestVersion,
  });

  if (
    businessStage !== "draft"
    && lastSentQuoteVersion
    && resolvedLatestVersion > lastSentQuoteVersion
  ) {
    return lastSentQuoteVersion;
  }

  return resolvedLatestVersion;
}

// DEL-30 defect B: `resolveDefaultSelectedQuoteVersion` above answers "what
// should the operator see by default" — the locked customer-seen revision,
// deliberately, so an in-progress draft edit never gets mistaken for what
// the customer actually has. Sending a document is the opposite question:
// "what should the customer be given right now." Conflating the two through
// one resolver meant sending with no explicit version silently re-sent the
// stale locked revision instead of the freshly revised one, and never
// advanced lastSentQuoteVersion. This resolver answers the delivery
// question: absent an explicit version, deliver the latest revision.
export function resolveCustomerDeliveryQuoteVersion({
  requestedVersion = null,
  meta = null,
  quoteLifecycle = null,
  latestVersion = null,
} = {}) {
  const explicitVersion = toPositiveInt(requestedVersion);
  if (explicitVersion) return explicitVersion;

  return (
    toPositiveInt(latestVersion)
    || toPositiveInt(quoteLifecycle?.currentQuoteVersion)
    || toPositiveInt(meta?.quoteVersion)
    || null
  );
}

export function shouldForkQuoteMutation({
  meta = null,
  quoteLifecycle = null,
  currentQuoteVersion = null,
} = {}) {
  const resolvedCurrentVersion = toPositiveInt(currentQuoteVersion)
    || toPositiveInt(meta?.quoteVersion)
    || toPositiveInt(quoteLifecycle?.currentQuoteVersion)
    || null;
  const lastSentQuoteVersion = inferLastSentQuoteVersion({
    meta,
    quoteLifecycle,
    currentQuoteVersion: resolvedCurrentVersion,
  });
  const historicalCustomerSeen = Boolean(
    meta?.quoteSentAt
    || meta?.landedAt
    || meta?.lostAt
    || quoteLifecycle?.sendCount
    || lastSentQuoteVersion
    || isPipelineSent(meta?.pipelineStage || meta?.deliveryStatus)
  );
  const businessStage = normalizePipelineStage(
    meta?.pipelineStage
    || meta?.deliveryStatus
    || quoteLifecycle?.currentPipelineStage
  );
  if (
    resolvedCurrentVersion
    && lastSentQuoteVersion
    && resolvedCurrentVersion <= lastSentQuoteVersion
  ) {
    return true;
  }
  if (
    businessStage === "draft"
    && historicalCustomerSeen
    && resolvedCurrentVersion
    && (!lastSentQuoteVersion || resolvedCurrentVersion <= lastSentQuoteVersion)
  ) {
    return true;
  }
  const policy = buildQuoteEditPolicy({
    meta,
    quoteLifecycle,
    latestVersion: resolvedCurrentVersion,
    selectedVersion: resolvedCurrentVersion,
  });
  return policy.latestVersionLocked;
}
