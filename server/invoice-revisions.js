// Invoice revision identity and issue-freeze primitives.
//
// A milestone invoice becomes a money document the moment it is issued. From
// that point its financial content is frozen into an issued-revision snapshot
// and its PDF is written once. An approved job change never rewrites that
// snapshot: it mints the next revision under a new number, and the superseded
// revision is retained with its own number, snapshot and PDF.
//
// This module owns identity, snapshot normalization and the revision state
// machine only. Allocation, status derivation and persistence stay in
// `job-documents.js` / `job-actions.js`. Artifact (PDF) state — a distinct
// concern from revision/money state — is owned by `invoice-artifact-state.js`;
// this module defers to it for that single field.

import { deriveArtifactState } from "./invoice-artifact-state.js";

const REVISION_SUFFIX_PATTERN = /-R(\d+)$/i;

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function cleanText(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeIsoTimestamp(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function normalizeRevisionNumber(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

export function stripInvoiceRevisionSuffix(invoiceNumber) {
  const cleaned = cleanText(invoiceNumber);
  if (!cleaned) return null;
  return cleaned.replace(REVISION_SUFFIX_PATTERN, "");
}

export function parseInvoiceRevisionSuffix(invoiceNumber) {
  const cleaned = cleanText(invoiceNumber);
  if (!cleaned) return 1;
  const match = cleaned.match(REVISION_SUFFIX_PATTERN);
  return match ? normalizeRevisionNumber(match[1]) : 1;
}

// Revision 1 keeps the historical number so already-issued invoices, stored
// PDFs and accounting references stay exactly as the customer received them.
export function buildInvoiceRevisionNumber(baseInvoiceNumber, revisionNumber) {
  const base = stripInvoiceRevisionSuffix(baseInvoiceNumber);
  if (!base) return null;
  const revision = normalizeRevisionNumber(revisionNumber);
  return revision <= 1 ? base : `${base}-R${revision}`;
}

export function normalizeActorLabel(actor) {
  if (!actor) return null;
  if (typeof actor === "string") return cleanText(actor);
  return cleanText(actor.label || actor.name || actor.email || actor.id || actor.kind);
}

function normalizeSnapshotLineItems(lineItems = []) {
  return (Array.isArray(lineItems) ? lineItems : []).map((item) => ({
    description: cleanText(item?.description) || cleanText(item?.label) || "Line item",
    quantity: Number.isFinite(Number(item?.quantity)) ? Number(item.quantity) : 1,
    unit: cleanText(item?.unit) || "lot",
    unitPrice: roundMoney(item?.unitPrice),
    totalPrice: roundMoney(item?.totalPrice),
    accountCode: cleanText(item?.accountCode),
    sourceCode: cleanText(item?.sourceCode),
  }));
}

// The fingerprint is what "did this money document actually change?" means.
// It deliberately covers only customer-visible financial content plus the
// quote revision that produced it.
export function buildInvoiceRevisionFingerprint({
  subtotal = 0,
  gst = 0,
  total = 0,
  currency = "AUD",
  lineItems = [],
  quoteVersion = null,
} = {}) {
  return JSON.stringify({
    subtotal: roundMoney(subtotal),
    gst: roundMoney(gst),
    total: roundMoney(total),
    currency: cleanText(currency) || "AUD",
    quoteVersion: Number.isFinite(Number(quoteVersion)) && Number(quoteVersion) > 0
      ? Number(quoteVersion)
      : null,
    lineItems: normalizeSnapshotLineItems(lineItems).map((item) => [
      item.description,
      item.quantity,
      item.unit,
      item.unitPrice,
      item.totalPrice,
      item.sourceCode,
    ]),
  });
}

export function normalizeInvoiceRevision(entry = null) {
  if (!entry || typeof entry !== "object") return null;
  const invoiceNumber = cleanText(entry.invoiceNumber);
  if (!invoiceNumber) return null;
  const revisionNumber = normalizeRevisionNumber(
    entry.revisionNumber ?? parseInvoiceRevisionSuffix(invoiceNumber)
  );
  const subtotal = roundMoney(entry.subtotal);
  const total = roundMoney(entry.total);
  return {
    revisionNumber,
    invoiceNumber,
    quoteVersion: Number.isFinite(Number(entry.quoteVersion)) && Number(entry.quoteVersion) > 0
      ? Number(entry.quoteVersion)
      : null,
    // True when `quoteVersion` above is not a historically-accurate record
    // of what this revision was actually rendered from, but the best
    // available substitute: a legacy revision predates
    // per-revision quote-version tracking, so its `quoteVersion` is pinned
    // to whatever was live at the moment it was FIRST synthesized during a
    // rebuild, not the version the customer's document actually reflects.
    // Callers building audit trails or provenance text must
    // word it accordingly rather than presenting it as a known fact.
    quoteVersionInferred: Boolean(entry.quoteVersionInferred),
    issuedAt: normalizeIsoTimestamp(entry.issuedAt),
    // Set when a retired revision is restored by reissuing identical
    // content. `issuedAt` stays the original issue event so restoring never
    // erodes the audit trail.
    reissuedAt: normalizeIsoTimestamp(entry.reissuedAt),
    subtotal,
    gst: roundMoney(entry.gst != null ? entry.gst : Math.max(total - subtotal, 0)),
    total,
    currency: cleanText(entry.currency) || "AUD",
    lineItems: normalizeSnapshotLineItems(entry.lineItems),
    pdfPath: cleanText(entry.pdfPath),
    pdfIssuedAt: normalizeIsoTimestamp(entry.pdfIssuedAt),
    pdfSha256: cleanText(entry.pdfSha256),
    // The single source of truth for "is this revision's PDF real, present
    // and safe to serve?". Derived
    // here so every caller — however the revision arrived (fresh mint,
    // legacy synthesis, or a round trip through disk) — sees the same
    // canonical value instead of recombining `pdfIssuedAt` /
    // `pdfUnrecoverable` / `legacyOrigin` a different way each time. See
    // `invoice-artifact-state.js` for the state machine and the backward-
    // compatibility inference from pre-refactor stored shapes.
    artifactState: deriveArtifactState(entry),
    // Operator-facing detail only (why the last reconstruction attempt
    // failed) — never dispatched on. Superseded by `artifactState`.
    pdfUnrecoverableReason: cleanText(entry.pdfUnrecoverableReason),
    // Revision event — who changed what, when and why. Only revisions above
    // the first can carry one, because the first issue supersedes nothing.
    revisedAt: normalizeIsoTimestamp(entry.revisedAt),
    revisedBy: normalizeActorLabel(entry.revisedBy),
    revisionReason: cleanText(entry.revisionReason),
    supersedesInvoiceNumber: cleanText(entry.supersedesInvoiceNumber),
    supersedesRevisionNumber: entry.supersedesRevisionNumber != null
      ? normalizeRevisionNumber(entry.supersedesRevisionNumber)
      : null,
    supersededTotal: entry.supersededTotal != null ? roundMoney(entry.supersededTotal) : null,
    supersededQuoteVersion: Number.isFinite(Number(entry.supersededQuoteVersion))
      && Number(entry.supersededQuoteVersion) > 0
      ? Number(entry.supersededQuoteVersion)
      : null,
    // Set when this revision stops being the current one.
    supersededAt: normalizeIsoTimestamp(entry.supersededAt),
    supersededByRevisionNumber: entry.supersededByRevisionNumber != null
      ? normalizeRevisionNumber(entry.supersededByRevisionNumber)
      : null,
  };
}

export function normalizeInvoiceRevisionHistory(history = []) {
  const normalized = (Array.isArray(history) ? history : [])
    .map((entry) => normalizeInvoiceRevision(entry))
    .filter(Boolean);
  const byRevisionNumber = new Map();
  for (const entry of normalized) {
    byRevisionNumber.set(entry.revisionNumber, entry);
  }
  return [...byRevisionNumber.values()].sort((a, b) => a.revisionNumber - b.revisionNumber);
}

export function highestRevisionNumber({ issuedRevision = null, revisionHistory = [] } = {}) {
  const candidates = normalizeInvoiceRevisionHistory(revisionHistory).map((entry) => entry.revisionNumber);
  const active = normalizeInvoiceRevision(issuedRevision);
  if (active) candidates.push(active.revisionNumber);
  return candidates.length ? Math.max(...candidates) : 0;
}

export function listInvoiceRevisions({
  issuedRevision = null,
  revisionHistory = [],
} = {}) {
  const history = normalizeInvoiceRevisionHistory(revisionHistory);
  const active = normalizeInvoiceRevision(issuedRevision);
  const combined = active
    ? [...history.filter((entry) => entry.revisionNumber !== active.revisionNumber), active]
    : history;
  return combined
    .map((entry) => ({
      ...entry,
      current: Boolean(active && entry.revisionNumber === active.revisionNumber),
    }))
    .sort((a, b) => a.revisionNumber - b.revisionNumber);
}

export function findInvoiceRevision({
  issuedRevision = null,
  revisionHistory = [],
  revisionNumber = null,
} = {}) {
  const requested = Number.parseInt(String(revisionNumber ?? ""), 10);
  if (!Number.isFinite(requested) || requested < 1) return null;
  return listInvoiceRevisions({ issuedRevision, revisionHistory })
    .find((entry) => entry.revisionNumber === requested) || null;
}

function retireRevision(revision, { supersededAt, supersededByRevisionNumber }) {
  return {
    ...revision,
    supersededAt: normalizeIsoTimestamp(supersededAt) || new Date().toISOString(),
    supersededByRevisionNumber: supersededByRevisionNumber != null
      ? normalizeRevisionNumber(supersededByRevisionNumber)
      : null,
  };
}

/**
 * Resolve the revision identity of a milestone invoice for the values it
 * currently carries.
 *
 * - An issued revision is frozen: it is returned untouched unless the caller
 *   passes an explicit `authorization`, which is what an approved change must
 *   supply to mint the next revision.
 * - Un-issuing (mark unsent / unpaid / migration reset) retires the current
 *   revision into history rather than deleting it.
 * - Re-issuing identical content restores the retired revision instead of
 *   burning a number, so an accidental unsend does not inflate revisions.
 */
export function resolveMilestoneRevisionState({
  issuedRevision = null,
  revisionHistory = [],
  storedRevisionNumber = null,
  baseInvoiceNumber = null,
  isIssued = false,
  issuedAt = null,
  quoteVersion = null,
  financials = null,
  authorization = null,
  actor = null,
  defaultRevisionReason = null,
  now = null,
} = {}) {
  const at = normalizeIsoTimestamp(now) || new Date().toISOString();
  let history = normalizeInvoiceRevisionHistory(revisionHistory);
  let active = normalizeInvoiceRevision(issuedRevision);
  const fingerprint = buildInvoiceRevisionFingerprint({ ...(financials || {}), quoteVersion });

  const buildNumber = (revision) => buildInvoiceRevisionNumber(baseInvoiceNumber, revision)
    || `invoice-R${revision}`;

  // An authorized revision, or dropping out of issued state, retires the
  // current snapshot into immutable history.
  const authorized = Boolean(authorization);
  // Carried through so the mint below can attribute `supersedes` to the
  // revision that was actually just retired, not merely the highest
  // revision number in history — after a restore-below-max those can
  // diverge.
  let retiredActive = null;
  if (active && (authorized || !isIssued)) {
    retiredActive = active;
    history = normalizeInvoiceRevisionHistory([
      ...history,
      retireRevision(active, {
        supersededAt: authorization?.at || at,
        // The true successor number is not known until the mint below
        // resolves it — a restore-below-max can leave `active.revisionNumber`
        // behind the actual next number. Patched to the real value once
        // minted.
        supersededByRevisionNumber: null,
      }),
    ]);
    active = null;
  }

  if (!isIssued) {
    const reusable = history.find((entry) => (
      buildInvoiceRevisionFingerprint(entry) === fingerprint
    ));
    const nextRevisionNumber = reusable
      ? reusable.revisionNumber
      : Math.max(highestRevisionNumber({ revisionHistory: history }) + 1, 1);
    return {
      revisionNumber: nextRevisionNumber,
      invoiceNumber: buildNumber(nextRevisionNumber),
      issuedRevision: null,
      revisionHistory: history,
    };
  }

  if (active) {
    return {
      revisionNumber: active.revisionNumber,
      invoiceNumber: active.invoiceNumber,
      issuedRevision: active,
      revisionHistory: history,
    };
  }

  // A money document is only ever born from an explicit issue event: an
  // operator authorizing/sending it (which supplies `issuedAt`), or an
  // approved-change revision (which supplies `authorization`). A rebuild
  // that derives `isIssued: true` from state alone — with no prior issued
  // revision, no issue timestamp, and no authorization — has no such event
  // to mint from, so it must not fabricate one.
  if (!history.length && !authorized && !normalizeIsoTimestamp(issuedAt)) {
    const unmintedRevisionNumber = Math.max(
      highestRevisionNumber({ revisionHistory: history }) + 1,
      normalizeRevisionNumber(storedRevisionNumber, 1),
      1,
    );
    return {
      revisionNumber: unmintedRevisionNumber,
      invoiceNumber: buildNumber(unmintedRevisionNumber),
      issuedRevision: null,
      revisionHistory: history,
    };
  }

  // Re-issuing content identical to a retired revision restores that revision
  // rather than minting a new number for the same money document.
  const reusable = history.find((entry) => buildInvoiceRevisionFingerprint(entry) === fingerprint);
  if (reusable && !authorized) {
    const restored = {
      ...reusable,
      // The original issue event's timestamp is part of the audit trail —
      // restoring a retired revision must never overwrite it. The re-issue
      // gets its own, separate timestamp.
      issuedAt: reusable.issuedAt || normalizeIsoTimestamp(issuedAt) || at,
      reissuedAt: normalizeIsoTimestamp(issuedAt) || at,
      supersededAt: null,
      supersededByRevisionNumber: null,
    };
    return {
      revisionNumber: restored.revisionNumber,
      invoiceNumber: restored.invoiceNumber,
      issuedRevision: restored,
      revisionHistory: history.filter((entry) => entry.revisionNumber !== restored.revisionNumber),
      restored: true,
    };
  }

  // The revision this mint actually supersedes is the one just retired
  // above, not necessarily the highest revision number in history — a
  // restore-below-max can leave a higher-numbered retired revision in
  // history than the one that was active immediately before this mint.
  const previous = retiredActive || (history.length ? history[history.length - 1] : null);
  const revisionNumber = Math.max(
    highestRevisionNumber({ revisionHistory: history }) + 1,
    normalizeRevisionNumber(storedRevisionNumber, 1),
    1,
  );
  if (retiredActive && authorized) {
    history = history.map((entry) => (
      entry.revisionNumber === retiredActive.revisionNumber
        ? { ...entry, supersededByRevisionNumber: revisionNumber }
        : entry
    ));
  }
  const minted = normalizeInvoiceRevision({
    revisionNumber,
    invoiceNumber: buildNumber(revisionNumber),
    quoteVersion,
    // An authorized revision is issued when it is authorized, not when the
    // superseded revision was.
    issuedAt: (authorized && authorization?.at) || normalizeIsoTimestamp(issuedAt) || at,
    subtotal: financials?.subtotal,
    gst: financials?.gst,
    total: financials?.total,
    currency: financials?.currency,
    lineItems: financials?.lineItems,
    ...(revisionNumber > 1
      ? {
          revisedAt: authorization?.at || at,
          // The explicit revise path always supplies `authorization`. A
          // mint that instead falls out of the update/send path (e.g.
          // re-authorising after an unsend changed the content) has no
          // authorization to read from, but "who changed what, when and
          // why" still applies — fall back to the acting user and a clear
          // default reason rather than leaving the event unattributed.
          revisedBy: normalizeActorLabel(authorization?.actor) || normalizeActorLabel(actor) || null,
          revisionReason: authorization?.reason || defaultRevisionReason || null,
          supersedesInvoiceNumber: previous?.invoiceNumber || null,
          supersedesRevisionNumber: previous?.revisionNumber ?? null,
          supersededTotal: previous?.total ?? null,
          supersededQuoteVersion: previous?.quoteVersion ?? null,
        }
      : {}),
  });

  return {
    revisionNumber: minted.revisionNumber,
    invoiceNumber: minted.invoiceNumber,
    issuedRevision: minted,
    revisionHistory: history,
    minted: true,
  };
}

export function describeInvoiceRevisionChange({ previous = null, next = null } = {}) {
  const from = normalizeInvoiceRevision(previous);
  const to = normalizeInvoiceRevision(next);
  if (!to) return null;
  return {
    invoiceNumber: to.invoiceNumber,
    revisionNumber: to.revisionNumber,
    supersedesInvoiceNumber: from?.invoiceNumber || to.supersedesInvoiceNumber || null,
    supersedesRevisionNumber: from?.revisionNumber ?? to.supersedesRevisionNumber ?? null,
    quoteVersion: to.quoteVersion,
    supersededQuoteVersion: from?.quoteVersion ?? to.supersededQuoteVersion ?? null,
    // Surfaced so audit text can distinguish a known quote version from a
    // legacy-inferred one — the superseded side is what
    // matters for the "quote vN → vM" line, since `to` is always freshly
    // minted against a real, known version.
    supersededQuoteVersionInferred: Boolean(from?.quoteVersionInferred),
    total: to.total,
    supersededTotal: from?.total ?? to.supersededTotal ?? null,
    totalDelta: roundMoney(Number(to.total || 0) - Number(from?.total ?? to.supersededTotal ?? 0)),
    revisedAt: to.revisedAt,
    revisedBy: to.revisedBy,
    revisionReason: to.revisionReason,
  };
}
