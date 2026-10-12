import { createHash, randomUUID } from "node:crypto";

export const QUOTE_IDENTITY_SCHEMA_VERSION = 1;
export const DEFAULT_QUOTE_THREAD_KIND = "base";

export function ensureQuoteIdentityMeta({
  meta,
  version,
  now = new Date().toISOString(),
}) {
  const currentMeta = meta && typeof meta === "object" ? meta : {};
  const currentIdentity = normalizeQuoteIdentityState(currentMeta.quoteIdentity);
  const revisionNumber = normalizeRevisionNumber(version)
    || normalizeRevisionNumber(currentIdentity.activeRevisionNumber)
    || normalizeRevisionNumber(currentMeta.quoteVersion)
    || 1;
  const jobUid = normalizeText(currentIdentity.jobUid) || normalizeText(currentMeta.id) || createMachineId("JOB");
  const activeThreadUid = normalizeText(currentIdentity.activeThreadUid) || createMachineId("QT");
  const activeThreadKind = normalizeQuoteThreadKind(currentIdentity.activeThreadKind || DEFAULT_QUOTE_THREAD_KIND);
  const parentThreadUid = normalizeText(currentIdentity.parentThreadUid) || null;
  const revisions = normalizeRevisionHistory(currentIdentity.revisions);
  const currentRevision = findRevisionForVersion(revisions, {
    revisionNumber,
    quoteThreadUid: activeThreadUid,
    activeRevisionUid: currentIdentity.activeRevisionUid,
  });
  const previousRevision = findLatestPreviousRevision(revisions, {
    revisionNumber,
    quoteThreadUid: activeThreadUid,
  });
  const activeRevisionUid = normalizeText(currentRevision?.quoteRevisionUid) || createMachineId("QR");
  const supersedesQuoteRevisionUid = normalizeText(currentRevision?.supersedesQuoteRevisionUid)
    || normalizeText(previousRevision?.quoteRevisionUid)
    || null;
  const nextRevision = {
    jobUid,
    quoteThreadUid: activeThreadUid,
    quoteThreadKind: activeThreadKind,
    parentQuoteThreadUid: parentThreadUid,
    quoteRevisionUid: activeRevisionUid,
    revisionNumber,
    revisionLabel: formatQuoteRevisionLabel(revisionNumber),
    quoteKind: activeThreadKind,
    supersedesQuoteRevisionUid,
    quoteNumber: normalizeText(currentMeta.quoteNumber) || normalizeText(currentRevision?.quoteNumber) || null,
    jobNumber: normalizeText(currentMeta.jobNumber) || normalizeText(currentRevision?.jobNumber) || null,
    firstBuiltAt: currentRevision?.firstBuiltAt || now,
    lastBuiltAt: now,
    scopeFingerprint: normalizeText(currentRevision?.scopeFingerprint) || null,
  };

  return {
    ...currentMeta,
    quoteIdentity: {
      schemaVersion: QUOTE_IDENTITY_SCHEMA_VERSION,
      jobUid,
      activeThreadUid,
      activeThreadKind,
      parentThreadUid,
      activeRevisionUid,
      activeRevisionNumber: revisionNumber,
      activeRevisionLabel: formatQuoteRevisionLabel(revisionNumber),
      supersedesQuoteRevisionUid,
      scopeFingerprint: nextRevision.scopeFingerprint,
      revisions: upsertRevisionHistory(revisions, nextRevision),
    },
  };
}

export function applyQuoteIdentity({
  meta,
  quote,
  quoteInputs = null,
  overrides = null,
  now = new Date().toISOString(),
}) {
  const preparedMeta = ensureQuoteIdentityMeta({
    meta,
    version: quote?.version,
    now,
  });
  const currentIdentity = normalizeQuoteIdentityState(preparedMeta.quoteIdentity);
  const scopeFingerprint = buildQuoteScopeFingerprint({
    quote,
    quoteInputs,
    overrides,
  });
  const currentRevision = {
    jobUid: currentIdentity.jobUid,
    quoteThreadUid: currentIdentity.activeThreadUid,
    quoteThreadKind: currentIdentity.activeThreadKind,
    parentQuoteThreadUid: currentIdentity.parentThreadUid,
    quoteRevisionUid: currentIdentity.activeRevisionUid,
    revisionNumber: currentIdentity.activeRevisionNumber,
    revisionLabel: currentIdentity.activeRevisionLabel,
    quoteKind: currentIdentity.activeThreadKind,
    supersedesQuoteRevisionUid: currentIdentity.supersedesQuoteRevisionUid || null,
    quoteNumber: normalizeText(quote?.quoteNumber) || normalizeText(preparedMeta.quoteNumber) || null,
    jobNumber: normalizeText(quote?.jobNumber) || normalizeText(preparedMeta.jobNumber) || null,
    firstBuiltAt:
      findRevisionByUid(currentIdentity.revisions, currentIdentity.activeRevisionUid)?.firstBuiltAt
      || now,
    lastBuiltAt: now,
    scopeFingerprint,
  };
  const nextMeta = {
    ...preparedMeta,
    quoteIdentity: {
      ...currentIdentity,
      scopeFingerprint,
      revisions: upsertRevisionHistory(currentIdentity.revisions, currentRevision),
    },
  };

  return {
    meta: nextMeta,
    quote: {
      ...quote,
      identity: buildQuoteIdentitySnapshot(nextMeta, quote, scopeFingerprint),
    },
  };
}

export function buildQuoteIdentitySnapshot(meta, quote, scopeFingerprint = null) {
  const identity = normalizeQuoteIdentityState(meta?.quoteIdentity);
  const quoteNumber = normalizeText(quote?.quoteNumber) || normalizeText(meta?.quoteNumber) || null;
  const jobNumber = normalizeText(quote?.jobNumber) || normalizeText(meta?.jobNumber) || null;

  return {
    schemaVersion: QUOTE_IDENTITY_SCHEMA_VERSION,
    jobUid: identity.jobUid,
    quoteThreadUid: identity.activeThreadUid,
    quoteThreadKind: identity.activeThreadKind,
    parentQuoteThreadUid: identity.parentThreadUid,
    quoteRevisionUid: identity.activeRevisionUid,
    revisionNumber: identity.activeRevisionNumber,
    revisionLabel: identity.activeRevisionLabel,
    quoteKind: identity.activeThreadKind,
    supersedesQuoteRevisionUid: identity.supersedesQuoteRevisionUid || null,
    scopeFingerprint: scopeFingerprint || identity.scopeFingerprint || null,
    quoteNumber,
    jobNumber,
  };
}

export function extractQuoteIdentity({ meta, quote }) {
  const identity = quote?.identity && typeof quote.identity === "object"
    ? quote.identity
    : buildQuoteIdentitySnapshot(meta, quote, meta?.quoteIdentity?.scopeFingerprint || null);

  return {
    schemaVersion: Number(identity.schemaVersion || QUOTE_IDENTITY_SCHEMA_VERSION),
    jobUid: normalizeText(identity.jobUid) || normalizeText(meta?.id) || null,
    quoteThreadUid: normalizeText(identity.quoteThreadUid) || null,
    quoteThreadKind: normalizeQuoteThreadKind(identity.quoteThreadKind || identity.quoteKind || DEFAULT_QUOTE_THREAD_KIND),
    parentQuoteThreadUid: normalizeText(identity.parentQuoteThreadUid) || null,
    quoteRevisionUid: normalizeText(identity.quoteRevisionUid) || null,
    revisionNumber: normalizeRevisionNumber(identity.revisionNumber) || normalizeRevisionNumber(quote?.version) || normalizeRevisionNumber(meta?.quoteVersion) || 1,
    revisionLabel: normalizeText(identity.revisionLabel) || formatQuoteRevisionLabel(
      normalizeRevisionNumber(identity.revisionNumber) || normalizeRevisionNumber(quote?.version) || normalizeRevisionNumber(meta?.quoteVersion) || 1
    ),
    quoteKind: normalizeQuoteThreadKind(identity.quoteKind || identity.quoteThreadKind || DEFAULT_QUOTE_THREAD_KIND),
    supersedesQuoteRevisionUid: normalizeText(identity.supersedesQuoteRevisionUid) || null,
    scopeFingerprint: normalizeText(identity.scopeFingerprint) || normalizeText(meta?.quoteIdentity?.scopeFingerprint) || null,
    quoteNumber: normalizeText(identity.quoteNumber) || normalizeText(quote?.quoteNumber) || normalizeText(meta?.quoteNumber) || null,
    jobNumber: normalizeText(identity.jobNumber) || normalizeText(quote?.jobNumber) || normalizeText(meta?.jobNumber) || null,
  };
}

export function formatQuoteRevisionLabel(value) {
  const revisionNumber = normalizeRevisionNumber(value) || 1;
  return `v${String(revisionNumber).padStart(3, "0")}`;
}

export function buildQuoteScopeFingerprint({
  quote,
  quoteInputs = null,
  overrides = null,
}) {
  const payload = {
    kind: String(quote?.kind || "quote"),
    title: String(quote?.title || ""),
    summary: String(quote?.summary || ""),
    review: {
      status: String(quote?.review?.status || quote?.status || ""),
      reasons: Array.isArray(quote?.review?.reasons) ? quote.review.reasons.map((value) => String(value || "")) : [],
    },
    delivery: {
      status: String(quote?.delivery?.status || ""),
      finalizedAt: String(quote?.delivery?.finalizedAt || ""),
    },
    totals: {
      subtotal: Number(quote?.totals?.subtotal || 0),
      gst: Number(quote?.totals?.gst || 0),
      total: Number(quote?.totals?.total || 0),
      currency: String(quote?.totals?.currency || "AUD"),
    },
    lineItems: (quote?.lineItems || []).map((item) => ({
      code: String(item?.code || ""),
      label: String(item?.label || ""),
      description: String(item?.description || ""),
      customerLabel: String(item?.customerLabel || ""),
      quantity: Number(item?.quantity || 0),
      unit: String(item?.unit || ""),
      unitPrice: Number(item?.unitPrice || 0),
      totalPrice: Number(item?.totalPrice || 0),
      section: String(item?.section || ""),
      customerVisible: item?.customerVisible !== false,
    })),
    scheduleItems: (quote?.presentation?.scheduleItems || []).map((item) => ({
      code: String(item?.code || ""),
      label: String(item?.label || ""),
      quantity: Number(item?.quantity || 0),
      unit: String(item?.unit || ""),
      unitPrice: Number(item?.unitPrice || 0),
      totalPrice: Number(item?.totalPrice || 0),
      section: String(item?.section || ""),
      sourceLineItemCodes: Array.isArray(item?.sourceLineItemCodes) ? item.sourceLineItemCodes.map((value) => String(value || "")) : [],
    })),
    assumptions: Array.isArray(quote?.assumptions) ? quote.assumptions.map((value) => String(value || "")) : [],
    assumptionInputs: (quote?.assumptionInputs || []).map((item) => ({
      field: String(item?.field || ""),
      value: String(item?.value || item?.defaultValue || ""),
      source: String(item?.source || ""),
      affectsPricing: Boolean(item?.affectsPricing),
    })),
    missingInputs: Array.isArray(quote?.missingInputs) ? quote.missingInputs.map((value) => String(value || "")) : [],
    execution: quote?.execution ? {
      totals: {
        labourHours: Number(quote.execution?.totals?.labourHours || 0),
        machineHours: Number(quote.execution?.totals?.machineHours || 0),
        durationHours: Number(quote.execution?.totals?.durationHours || 0),
        workingDays: Number(quote.execution?.totals?.workingDays || 0),
      },
      accessProfile: String(quote.execution?.accessProfile?.code || ""),
      dumpDriveMinutes: Number(quote.execution?.parameters?.dumpDriveMinutes || 0),
      travelHoursPerDay: Number(quote.execution?.parameters?.travelHoursPerDay || 0),
    } : null,
    recordingIntent: String(quoteInputs?.recordingIntent || quote?.recordingIntent || ""),
    quoteOverrides: sanitizeOverridesForFingerprint(overrides),
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function sanitizeOverridesForFingerprint(overrides) {
  if (!overrides || typeof overrides !== "object") return null;
  return {
    lineItems: sanitizeOverrideEntries(overrides.lineItems),
    commercialAdjustments: Array.isArray(overrides.commercialAdjustments)
      ? overrides.commercialAdjustments
        .map((entry) => ({
          id: normalizeText(entry?.id) || null,
          kind: normalizeText(entry?.kind) || null,
          target: {
            lineItemCode: normalizeText(entry?.target?.lineItemCode) || null,
            quoteCatalogItemCode: normalizeText(entry?.target?.quoteCatalogItemCode) || null,
            section: normalizeText(entry?.target?.section) || null,
          },
          unitPrice: numberOrNull(entry?.unitPrice),
          notes: normalizeText(entry?.notes) || null,
        }))
        .sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")))
      : [],
    assumptions: sanitizeOverrideEntries(overrides.assumptions),
    presentation: overrides.presentation && typeof overrides.presentation === "object"
      ? {
          scopeText: normalizeText(overrides.presentation.scopeText) || null,
          organizer: overrides.presentation.organizer && typeof overrides.presentation.organizer === "object"
            ? {
                root: Array.isArray(overrides.presentation.organizer.root)
                  ? overrides.presentation.organizer.root
                    .map((value) => normalizeText(value))
                    .filter(Boolean)
                  : [],
                nodes: overrides.presentation.organizer.nodes && typeof overrides.presentation.organizer.nodes === "object"
                  ? Object.fromEntries(
                      Object.entries(overrides.presentation.organizer.nodes)
                        .filter(([key]) => normalizeText(key))
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([key, value]) => {
                          if (!value || typeof value !== "object" || Array.isArray(value)) {
                            return [normalizeText(key), null];
                          }
                          if (value.kind === "group") {
                            return [
                              normalizeText(key),
                              {
                                kind: "group",
                                label: normalizeText(value.label) || null,
                                collapsed: value.collapsed === true,
                                amountVisible: value.amountVisible !== false,
                                children: Array.isArray(value.children)
                                  ? value.children.map((child) => normalizeText(child)).filter(Boolean)
                                  : [],
                              },
                            ];
                          }
                          return [
                            normalizeText(key),
                            {
                              kind: "source",
                              sourceKind: normalizeText(value.sourceKind) || "customer_schedule_item",
                              sourceCode: normalizeText(value.sourceCode) || null,
                              labelOverride: normalizeText(value.labelOverride) || null,
                              amountVisible: value.amountVisible !== false,
                            },
                          ];
                        })
                        .filter(([, value]) => value)
                    )
                  : {},
              }
            : null,
        }
      : null,
    optionSelections: sanitizeOverrideEntries(overrides.optionSelections),
    acceptedOptionSelections: sanitizeOverrideEntries(overrides.acceptedOptionSelections),
    execution: overrides.execution && typeof overrides.execution === "object"
      ? {
          accessProfile: normalizeText(overrides.execution.accessProfile) || null,
          labourHours: numberOrNull(overrides.execution.labourHours),
          machineHours: numberOrNull(overrides.execution.machineHours),
          dumpDriveMinutes: numberOrNull(overrides.execution.dumpDriveMinutes),
          travelHoursPerDay: numberOrNull(overrides.execution.travelHoursPerDay),
          note: normalizeText(overrides.execution.note) || null,
        }
      : null,
    lockStatus: normalizeText(overrides.lockStatus) || null,
  };
}

function sanitizeOverrideEntries(entries) {
  if (!entries || typeof entries !== "object") return {};
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value])
  );
}

function upsertRevisionHistory(revisions, nextRevision) {
  const normalized = normalizeRevisionHistory(revisions);
  const others = normalized.filter((entry) => entry.quoteRevisionUid !== nextRevision.quoteRevisionUid);
  return [...others, nextRevision]
    .sort((a, b) => {
      if (a.revisionNumber !== b.revisionNumber) return a.revisionNumber - b.revisionNumber;
      return String(a.quoteRevisionUid || "").localeCompare(String(b.quoteRevisionUid || ""));
    });
}

function normalizeRevisionHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeRevisionEntry)
    .filter((entry) => Boolean(entry.quoteRevisionUid));
}

function normalizeRevisionEntry(entry) {
  const revisionNumber = normalizeRevisionNumber(entry?.revisionNumber) || 1;
  return {
    jobUid: normalizeText(entry?.jobUid) || null,
    quoteThreadUid: normalizeText(entry?.quoteThreadUid) || null,
    quoteThreadKind: normalizeQuoteThreadKind(entry?.quoteThreadKind || entry?.quoteKind || DEFAULT_QUOTE_THREAD_KIND),
    parentQuoteThreadUid: normalizeText(entry?.parentQuoteThreadUid) || null,
    quoteRevisionUid: normalizeText(entry?.quoteRevisionUid) || null,
    revisionNumber,
    revisionLabel: normalizeText(entry?.revisionLabel) || formatQuoteRevisionLabel(revisionNumber),
    quoteKind: normalizeQuoteThreadKind(entry?.quoteKind || entry?.quoteThreadKind || DEFAULT_QUOTE_THREAD_KIND),
    supersedesQuoteRevisionUid: normalizeText(entry?.supersedesQuoteRevisionUid) || null,
    quoteNumber: normalizeText(entry?.quoteNumber) || null,
    jobNumber: normalizeText(entry?.jobNumber) || null,
    firstBuiltAt: normalizeText(entry?.firstBuiltAt) || null,
    lastBuiltAt: normalizeText(entry?.lastBuiltAt) || null,
    scopeFingerprint: normalizeText(entry?.scopeFingerprint) || null,
  };
}

function normalizeQuoteIdentityState(value) {
  const current = value && typeof value === "object" ? value : {};
  const activeRevisionNumber = normalizeRevisionNumber(current.activeRevisionNumber) || 1;
  return {
    schemaVersion: Number(current.schemaVersion || QUOTE_IDENTITY_SCHEMA_VERSION),
    jobUid: normalizeText(current.jobUid) || null,
    activeThreadUid: normalizeText(current.activeThreadUid) || null,
    activeThreadKind: normalizeQuoteThreadKind(current.activeThreadKind || DEFAULT_QUOTE_THREAD_KIND),
    parentThreadUid: normalizeText(current.parentThreadUid) || null,
    activeRevisionUid: normalizeText(current.activeRevisionUid) || null,
    activeRevisionNumber,
    activeRevisionLabel: normalizeText(current.activeRevisionLabel) || formatQuoteRevisionLabel(activeRevisionNumber),
    supersedesQuoteRevisionUid: normalizeText(current.supersedesQuoteRevisionUid) || null,
    scopeFingerprint: normalizeText(current.scopeFingerprint) || null,
    revisions: normalizeRevisionHistory(current.revisions),
  };
}

function findRevisionForVersion(revisions, {
  revisionNumber,
  quoteThreadUid,
  activeRevisionUid = null,
}) {
  const normalizedActiveRevisionUid = normalizeText(activeRevisionUid) || null;
  if (normalizedActiveRevisionUid) {
    const active = findRevisionByUid(revisions, normalizedActiveRevisionUid);
    if (active && active.revisionNumber === revisionNumber) return active;
  }
  return revisions.find((entry) => (
    entry.revisionNumber === revisionNumber
    && entry.quoteThreadUid === quoteThreadUid
  )) || null;
}

function findLatestPreviousRevision(revisions, {
  revisionNumber,
  quoteThreadUid,
}) {
  return revisions
    .filter((entry) => entry.quoteThreadUid === quoteThreadUid && entry.revisionNumber < revisionNumber)
    .sort((a, b) => b.revisionNumber - a.revisionNumber)[0] || null;
}

function findRevisionByUid(revisions, revisionUid) {
  const normalizedRevisionUid = normalizeText(revisionUid) || null;
  if (!normalizedRevisionUid) return null;
  return revisions.find((entry) => entry.quoteRevisionUid === normalizedRevisionUid) || null;
}

function normalizeQuoteThreadKind(value) {
  const normalized = String(value || DEFAULT_QUOTE_THREAD_KIND).trim().toLowerCase();
  return normalized === "variation" ? "variation" : DEFAULT_QUOTE_THREAD_KIND;
}

function normalizeRevisionNumber(value) {
  const numeric = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function createMachineId(prefix) {
  return `${String(prefix || "ID").toUpperCase()}-${randomUUID().replace(/-/g, "").toUpperCase()}`;
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}
