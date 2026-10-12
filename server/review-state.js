import { isQuotePricingSendable } from "./quote-pricing-attestation.js";

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isCurrentGap(gap) {
  return gap?.presentInCurrentContext !== false;
}

function isOpenGap(gap) {
  return gap?.status === "open" || gap?.status === "in_progress";
}

function activitySourceRef(entry) {
  if (!entry?.id) return null;
  return {
    kind: "activity",
    activityId: entry.id,
    label: entry.title || "Activity",
  };
}

function sourceTypeForActor(actor) {
  if (actor?.kind === "user") return "manual";
  if (actor?.kind === "ai") return "chat";
  return "ai-generated";
}

function findGapResolutionActivity(jobState, gap, status) {
  return (jobState?.activity || []).find((entry) =>
    entry?.kind === "gap.state_changed"
    && entry?.gapId === gap?.id
    && entry?.gapStatus === status
  ) || null;
}

function findReviewItemActivity(jobState, itemId, action) {
  return (jobState?.activity || []).find((entry) =>
    entry?.kind === "review.item_decision"
    && entry?.reviewItemId === itemId
    && entry?.reviewAction === action
  ) || null;
}

export function restoreStatusForResolvedGap(jobState, gap) {
  if (!gap?.id) return "open";
  const confirmedAt = gap?.resolution?.at ? new Date(gap.resolution.at).getTime() : null;
  const priorTransition = (jobState?.activity || [])
    .filter((entry) =>
      entry?.kind === "gap.state_changed"
      && entry?.gapId === gap.id
      && entry?.gapStatus
      && entry.gapStatus !== "confirmed"
    )
    .filter((entry) => {
      if (confirmedAt == null) return true;
      const entryTime = new Date(entry?.ts || "").getTime();
      return Number.isFinite(entryTime) && entryTime < confirmedAt;
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))[0] || null;

  if (priorTransition?.gapStatus === "accepted") return "accepted";
  if (priorTransition?.gapStatus === "in_progress") return "in_progress";
  return "open";
}

function buildDecisionProvenance({ by, at, summary, activity }) {
  if (!by) return [];
  return [{
    sourceType: sourceTypeForActor(by),
    actor: by,
    createdAt: at || undefined,
    summary,
    sourceRef: activitySourceRef(activity),
  }];
}

function toAssumedItemFromGap(gap, jobState = null) {
  const value =
    gap?.resolution?.note
    || gap?.assumption?.value
    || gap?.assumption?.defaultValue
    || "Accepted assumption";
  const originTone = gap?.resolution?.by?.kind === "user" ? "operator" : "system";
  const activity = findGapResolutionActivity(jobState, gap, "accepted");
  return {
    id: gap.id,
    field: gap.field,
    value,
    summary: value,
    detail: gap.resolution?.reason || gap.reason || gap.description || "Accepted for this quote.",
    gapId: gap.id,
    originLabel: originTone === "operator" ? "Operator assumption" : "System assumption",
    originTone,
    canConfirm: true,
    allowedActions: ["confirm", "edit", "reject"],
    evidenceSummary: (gap.evidence || []).map((entry) => entry.text).filter(Boolean).slice(0, 3),
    alternatives: [],
    relatedLineItems: [],
    provenance: buildDecisionProvenance({
      by: gap?.resolution?.by,
      at: gap?.resolution?.at,
      summary: gap?.resolution?.by ? `Accepted by ${gap.resolution.by.label}` : null,
      activity,
    }),
  };
}

function toAssumedItemFromQuote(input, linkedGap = null) {
  const originTone = input?.source === "user" ? "operator" : "system";
  const summary = input?.value || input?.defaultValue || "Quoted with standard assumption";
  const evidenceSummary = [
    ...(input?.evidenceSummary || []),
    ...((input?.evidence || []).map((entry) => entry.text || entry.snippet || "").filter(Boolean)),
  ].slice(0, 3);
  const canConfirm = Boolean(linkedGap?.id);

  return {
    id: linkedGap?.id || `assumption:${normalizeKey(input?.field)}`,
    field: input?.field || "Assumption",
    value: summary,
    summary,
    detail: input?.quoteNote || input?.reason || "Quoted with an accepted assumption.",
    gapId: linkedGap?.id || null,
    originLabel: originTone === "operator" ? "Operator assumption" : "System default",
    originTone,
    canConfirm,
    allowedActions: canConfirm ? ["confirm", "edit", "reject"] : ["edit", "reject"],
    evidenceSummary,
    alternatives: Array.isArray(input?.alternatives) ? input.alternatives : [],
    relatedLineItems: input?.relatedLineItems || [],
    provenance: [{
      sourceType: input?.source === "user" ? "manual" : "ai-generated",
      actor: {
        kind: input?.source === "user" ? "user" : "system",
        label: input?.source === "user" ? "User" : "Field",
      },
      summary:
        input?.source === "user"
          ? "User-provided value"
          : input?.source === "derived"
            ? "Derived from scoped work"
            : "Default pricing assumption",
    }],
  };
}

function buildConfirmedLineItem(item) {
  return {
    id: `line-item:${item.code || item.label}`,
    code: item.code || item.quoteCatalogItemCode || null,
    label: item.label,
    detail: item.description || item.rationale || "Quoted scope item",
    kind: "line_item",
    price: item.totalPrice ?? null,
    evidenceCount: item.evidence?.length || 0,
    evidence: (item.evidence || []).map((entry, index) => ({
      id: `${item.code || item.label}:audio:${index}`,
      kind: "audio",
      text: entry.snippet || entry.text || "Audio evidence",
      segmentId: entry.segmentId,
      speaker: entry.speaker,
      start: typeof entry.start === "number" ? entry.start : undefined,
      end: typeof entry.end === "number" ? entry.end : undefined,
    })),
    evidenceSummary: item.evidenceSummary || [],
    provenance: item.provenance,
    allowedActions: item.code ? ["reject"] : [],
  };
}

function buildResolvedGapItem(gap, jobState = null) {
  const activity = findGapResolutionActivity(jobState, gap, "confirmed");
  return {
    id: `resolved-gap:${gap.id}`,
    label: gap.field,
    detail: gap.resolution?.reason || gap.reason || gap.description || "Resolved during review.",
    kind: "resolved_gap",
    price: null,
    evidenceCount: gap.evidence?.length || 0,
    evidence: (gap.evidence || []).map((entry, index) => ({
      id: `${gap.id}:text:${index}`,
      kind: "text",
      text: entry.text || "Supporting gap evidence",
    })),
    evidenceSummary: [],
    provenance: buildDecisionProvenance({
      by: gap?.resolution?.by,
      at: gap?.resolution?.at,
      summary: gap?.resolution?.by ? `Confirmed by ${gap.resolution.by.label}` : null,
      activity,
    }),
    allowedActions: ["reopen"],
  };
}

function getRejectedAssumptionOverrides(quoteOverrides) {
  return Object.entries(quoteOverrides?.assumptions || {}).filter(([, override]) => override?.reviewState?.excluded);
}

function getRejectedLineItemOverrides(quoteOverrides) {
  return Object.entries(quoteOverrides?.lineItems || {}).filter(([, override]) => override?.reviewState?.excluded);
}

function buildRejectedAssumptionItem({ field, override, linkedGap = null, jobState = null }) {
  const itemId = linkedGap?.id || `assumption:${normalizeKey(field)}`;
  const activity = findReviewItemActivity(jobState, itemId, "reject");
  const value =
    override?.value
    || linkedGap?.resolution?.note
    || linkedGap?.assumption?.value
    || linkedGap?.assumption?.defaultValue
    || "Removed assumption";
  const relatedLineItems = override?.reviewState?.relatedLineItems || [];
  return {
    id: itemId,
    label: field || "Assumption",
    detail: `Was assumed as ${value}`,
    kind: "assumption",
    originCategory: override?.reviewState?.originCategory || "assumed",
    gapId: linkedGap?.id || null,
    reason: override?.reviewState?.reason || linkedGap?.resolution?.reason || "Marked as not needed for this quote.",
    impactSummary: relatedLineItems.length
      ? `Removed ${relatedLineItems.length} linked quote item${relatedLineItems.length === 1 ? "" : "s"}.`
      : "Removed from the current quote.",
    relatedLineItems,
    allowedActions: ["reopen"],
    provenance: buildDecisionProvenance({
      by: override?.reviewState?.by,
      at: override?.reviewState?.at,
      summary: override?.reviewState?.by ? `Rejected by ${override.reviewState.by.label}` : null,
      activity,
    }),
  };
}

function humanizeCode(code) {
  const text = String(code || "").trim();
  if (!text) return "Removed line item";
  return text
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildRejectedLineItem({ code, override, jobState = null }) {
  const itemId = `line-item:${code}`;
  const activity = findReviewItemActivity(jobState, itemId, "reject");
  return {
    id: itemId,
    label: override?.label || humanizeCode(code),
    detail: override?.reviewState?.detail || "Removed from the quoted scope.",
    kind: "line_item",
    originCategory: override?.reviewState?.originCategory || "confirmed",
    gapId: null,
    reason: override?.reviewState?.reason || "Removed during quote review.",
    impactSummary: "Removed from the current quote.",
    relatedLineItems: [],
    allowedActions: ["reopen"],
    provenance: buildDecisionProvenance({
      by: override?.reviewState?.by,
      at: override?.reviewState?.at,
      summary: override?.reviewState?.by ? `Removed by ${override.reviewState.by.label}` : null,
      activity,
    }),
  };
}

function buildRejectedGapItem(gap, jobState = null) {
  const activity = findGapResolutionActivity(jobState, gap, "rejected");
  return {
    id: gap.id,
    label: gap.field,
    detail: gap.description || gap.reason || "Rejected during review.",
    kind: "gap",
    originCategory: "gaps",
    gapId: gap.id,
    reason: gap.resolution?.reason || "Marked as not needed for this quote.",
    impactSummary: "No quote change was applied.",
    relatedLineItems: [],
    allowedActions: ["reopen"],
    provenance: buildDecisionProvenance({
      by: gap?.resolution?.by,
      at: gap?.resolution?.at,
      summary: gap?.resolution?.by ? `Rejected by ${gap.resolution.by.label}` : null,
      activity,
    }),
  };
}

export function buildReviewState({ quote, jobState, quoteOverrides = null }) {
  const pricingSendable = quote?.pricing ? isQuotePricingSendable(quote) : true;
  const currentGaps = (jobState?.gaps || []).filter(isCurrentGap);
  const openGaps = currentGaps.filter(isOpenGap);
  const acceptedGaps = currentGaps.filter((gap) => gap.status === "accepted");
  const confirmedGaps = currentGaps.filter((gap) => gap.status === "confirmed");
  const triagedGaps = currentGaps.filter(
    (gap) => gap.status === "accepted" || gap.status === "confirmed" || gap.status === "rejected"
  );
  const rejectedAssumptionOverrides = getRejectedAssumptionOverrides(quoteOverrides);
  const rejectedLineItemOverrides = getRejectedLineItemOverrides(quoteOverrides);
  const rejectedAssumptionKeys = new Set(
    rejectedAssumptionOverrides
      .map(([field]) => normalizeKey(field))
      .filter(Boolean)
  );

  const quoteLineItems = quote?.lineItems || [];
  const quoteAssumptions = quote?.assumptionInputs || [];

  const openGapKeys = new Set(openGaps.map((gap) => normalizeKey(gap.field)));
  const gapByKey = new Map(currentGaps.map((gap) => [normalizeKey(gap.field), gap]));
  const assumedItemsByKey = new Map();

  for (const gap of acceptedGaps) {
    const key = normalizeKey(gap.field);
    if (rejectedAssumptionKeys.has(key)) continue;
    assumedItemsByKey.set(key, toAssumedItemFromGap(gap, jobState));
  }

  for (const input of quoteAssumptions) {
    const key = normalizeKey(input?.field);
    if (!key || openGapKeys.has(key) || assumedItemsByKey.has(key) || rejectedAssumptionKeys.has(key)) continue;
    assumedItemsByKey.set(key, toAssumedItemFromQuote(input, gapByKey.get(key) || null));
  }

  const assumedFieldKeys = new Set(assumedItemsByKey.keys());
  const confirmedItems = [
    ...quoteLineItems
      .filter((item) => {
        const requiredKeys = (item.requiredInputs || []).map((entry) => normalizeKey(entry));
        if (requiredKeys.some((key) => openGapKeys.has(key) || assumedFieldKeys.has(key))) {
          return false;
        }
        return item.usedDefaultQuantity !== true;
      })
      .map(buildConfirmedLineItem),
    ...confirmedGaps.map((gap) => buildResolvedGapItem(gap, jobState)),
  ];

  const rejectedItems = [
    ...rejectedAssumptionOverrides.map(([field, override]) =>
      buildRejectedAssumptionItem({
        field,
        override,
        linkedGap: gapByKey.get(normalizeKey(field)) || null,
        jobState,
      })
    ),
    ...rejectedLineItemOverrides.map(([code, override]) =>
      buildRejectedLineItem({ code, override, jobState })
    ),
    ...currentGaps
      .filter((gap) => gap.status === "rejected" && !rejectedAssumptionKeys.has(normalizeKey(gap.field)))
      .map((gap) => buildRejectedGapItem(gap, jobState)),
  ];

  return {
    counts: {
      confirmed: confirmedItems.length,
      assumed: assumedItemsByKey.size,
      gap: openGaps.length,
    },
    openGaps,
    acceptedGaps,
    triagedGaps,
    assumedItems: [...assumedItemsByKey.values()],
    confirmedItems,
    rejectedItems,
    canSend: openGaps.length === 0 && pricingSendable,
    blockingReason: openGaps.length > 0
      ? "Resolve all gaps before sending this quote."
      : (!pricingSendable
        ? (quote?.pricing?.blockingReason || "Fresh commercial pricing verification is required before sending this quote.")
        : null),
  };
}

export function findReviewItem(review, itemId) {
  if (!review || !itemId) return null;
  const assumed = review.assumedItems?.find((item) => item.id === itemId);
  if (assumed) return { category: "assumed", item: assumed };
  const confirmed = review.confirmedItems?.find((item) => item.id === itemId);
  if (confirmed) return { category: "confirmed", item: confirmed };
  const rejected = review.rejectedItems?.find((item) => item.id === itemId);
  if (rejected) return { category: "rejected", item: rejected };
  return null;
}
