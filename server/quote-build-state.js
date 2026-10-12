import { readJobMeta, writeJobMeta } from "./job-meta-store.js";

const QUOTE_BUILD_STATE_VERSION = 1;
const QUOTE_BUILD_STATE_STALE_MS = 30 * 60 * 1000;

function normalizeTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  return timestamp.toISOString();
}

function normalizeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.trunc(count);
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  const warnings = [];
  for (const entry of value) {
    const warning = normalizeText(entry);
    if (!warning || warnings.includes(warning)) continue;
    warnings.push(warning);
  }
  return warnings;
}

export function normalizeQuoteBuildState(state = null, { now = Date.now() } = {}) {
  const startedAt = normalizeTimestamp(state?.startedAt);
  const updatedAt = normalizeTimestamp(state?.updatedAt) || startedAt;
  const lastCompletedAt = normalizeTimestamp(state?.lastCompletedAt);
  const failedAt = normalizeTimestamp(state?.failedAt);
  const lastCompletedQuoteGeneratedAt = normalizeTimestamp(state?.lastCompletedQuoteGeneratedAt);
  const normalized = {
    version: QUOTE_BUILD_STATE_VERSION,
    status: state?.status === "running" || state?.status === "failed" ? state.status : "idle",
    buildType: normalizeText(state?.buildType),
    buildReason: normalizeText(state?.buildReason),
    requestedBy: normalizeText(state?.requestedBy),
    startedAt,
    updatedAt,
    stageKey: normalizeText(state?.stageKey),
    stageLabel: normalizeText(state?.stageLabel),
    stageIndex: normalizeCount(state?.stageIndex),
    stageCount: normalizeCount(state?.stageCount),
    warnings: normalizeWarnings(state?.warnings),
    error: normalizeText(state?.error),
    failedAt,
    lastCompletedAt,
    lastCompletedQuoteVersion: normalizeCount(state?.lastCompletedQuoteVersion),
    lastCompletedQuoteGeneratedAt,
  };

  if (
    normalized.status === "running"
    && updatedAt
    && now - new Date(updatedAt).getTime() > QUOTE_BUILD_STATE_STALE_MS
  ) {
    return {
      ...normalized,
      status: "failed",
      stageKey: "stalled",
      stageLabel: "Build stalled",
      error: normalized.error || "Build status went stale before completion.",
      failedAt: updatedAt,
      updatedAt,
    };
  }

  return normalized;
}

export function startQuoteBuildState(existingState = null, {
  buildType = "reingest",
  buildReason = null,
  requestedBy = null,
  stageKey = "queued",
  stageLabel = "Queued",
  stageIndex = 0,
  stageCount = null,
  warnings = [],
} = {}) {
  const now = new Date().toISOString();
  const existing = normalizeQuoteBuildState(existingState);
  return normalizeQuoteBuildState({
    ...existing,
    status: "running",
    buildType,
    buildReason,
    requestedBy,
    startedAt: now,
    updatedAt: now,
    stageKey,
    stageLabel,
    stageIndex,
    stageCount,
    warnings,
    error: null,
    failedAt: null,
  });
}

export function advanceQuoteBuildState(existingState = null, {
  stageKey = null,
  stageLabel = null,
  stageIndex = null,
  stageCount = null,
  warnings = undefined,
} = {}) {
  const now = new Date().toISOString();
  const existing = normalizeQuoteBuildState(existingState);
  return normalizeQuoteBuildState({
    ...existing,
    status: "running",
    updatedAt: now,
    ...(stageKey ? { stageKey } : {}),
    ...(stageLabel ? { stageLabel } : {}),
    ...(stageIndex != null ? { stageIndex } : {}),
    ...(stageCount != null ? { stageCount } : {}),
    ...(warnings !== undefined ? { warnings } : {}),
    error: null,
    failedAt: null,
  });
}

export function completeQuoteBuildState(existingState = null, {
  quote = null,
  warnings = undefined,
} = {}) {
  const now = new Date().toISOString();
  const existing = normalizeQuoteBuildState(existingState);
  return normalizeQuoteBuildState({
    ...existing,
    status: "idle",
    updatedAt: now,
    stageKey: "complete",
    stageLabel: "Build complete",
    ...(warnings !== undefined ? { warnings } : {}),
    error: null,
    failedAt: null,
    lastCompletedAt: now,
    lastCompletedQuoteVersion: quote?.version ?? existing.lastCompletedQuoteVersion ?? null,
    lastCompletedQuoteGeneratedAt: quote?.generatedAt ?? quote?.updatedAt ?? now,
  });
}

export function failQuoteBuildState(existingState = null, {
  error = null,
  warnings = undefined,
} = {}) {
  const now = new Date().toISOString();
  const existing = normalizeQuoteBuildState(existingState);
  return normalizeQuoteBuildState({
    ...existing,
    status: "failed",
    updatedAt: now,
    stageKey: "failed",
    stageLabel: "Build failed",
    ...(warnings !== undefined ? { warnings } : {}),
    error: normalizeText(error) || existing.error || "unknown error",
    failedAt: now,
  });
}

export async function persistQuoteBuildState(jobDir, meta, quoteBuildState) {
  const currentMeta = meta && typeof meta === "object" ? meta : await readJobMeta(jobDir);
  if (!currentMeta || typeof currentMeta !== "object") return null;
  return await writeJobMeta(jobDir, {
    ...currentMeta,
    quoteBuild: normalizeQuoteBuildState(quoteBuildState),
  });
}
