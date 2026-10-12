import { createHash, randomUUID } from "node:crypto";
import { isPipelineSent } from "./pipeline.js";
import { getCustomerScheduleView, getCustomerPresentationFinancials } from "./quote-presentation.js";

function normalizeText(value) {
  const trimmed = String(value || "").trim();
  return trimmed || null;
}

const MONETARY_KEY = /(?:amount|charge|cost|discount|gst|markup|price|quantity|rate|subtotal|tax|total|buying|selling|sell|unit)/i;

function projectMonetaryOutput(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => projectMonetaryOutput(entry, key));
  if (!value || typeof value !== "object") {
    return MONETARY_KEY.test(key) && (typeof value === "number" || typeof value === "string" || value == null)
      ? value
      : undefined;
  }
  const output = {};
  for (const childKey of Object.keys(value).sort()) {
    // Attestation metadata proves the authority snapshot; it is not itself a
    // monetary output and including it would make an otherwise identical
    // quote digest change on every request nonce/attestedAt update.
    if (childKey === "attestation" || childKey === "issues" || childKey === "blockingReason") continue;
    const projected = projectMonetaryOutput(value[childKey], childKey);
    if (projected !== undefined) output[childKey] = projected;
  }
  return Object.keys(output).length ? output : undefined;
}

export function buildQuotePricingOutputDigest(quote) {
  const projected = projectMonetaryOutput(quote);
  return createHash("sha256").update(JSON.stringify(projected ?? null)).digest("hex");
}

export function createQuotePricingRequestNonce() {
  return randomUUID();
}

export function buildQuotePricingAttestation({
  requestNonce = createQuotePricingRequestNonce(),
  authorityStatus = null,
  livePricingAvailable = false,
  reason = null,
  createdAt = null,
} = {}) {
  const resolvedRequestNonce = normalizeText(requestNonce) || createQuotePricingRequestNonce();
  const provider = normalizeText(authorityStatus?.provider) || "catalog";
  const verified = provider === "price_catalog" && livePricingAvailable === true;
  const attestedAt = normalizeText(createdAt) || new Date().toISOString();
  const blockingReason = verified
    ? null
    : normalizeText(reason) || deriveLivePricingFailureReason({
      authorityStatus,
      provider,
    });

  return {
    // Snapshot-bound attestations are version 2. Legacy isolated fixtures and
    // historical records without a catalogue digest retain v1 semantics;
    // real live quote/wall builds always provide both fields.
    version: normalizeText(authorityStatus?.catalogRevision) && normalizeText(authorityStatus?.snapshotDigest)
      ? 2
      : 1,
    requestNonce: resolvedRequestNonce,
    verifiedNonce: verified ? resolvedRequestNonce : null,
    status: verified ? "verified" : "unverified",
    provider,
    mode: normalizeText(authorityStatus?.mode) || null,
    baseUrl: normalizeText(authorityStatus?.publicBaseUrl) || null,
    buyingPriceList: normalizeText(authorityStatus?.buyingPriceList) || null,
    sellingPriceList: normalizeText(authorityStatus?.sellingPriceList) || null,
    authorityRefreshedAt: normalizeText(authorityStatus?.refreshedAt) || normalizeText(authorityStatus?.syncedAt) || null,
    catalogRevision: normalizeText(authorityStatus?.catalogRevision) || null,
    snapshotDigest: normalizeText(authorityStatus?.snapshotDigest) || null,
    attestedAt,
    blockingReason,
  };
}

export function attachQuotePricingAttestation({
  quote,
  attestation,
}) {
  if (!quote || typeof quote !== "object") return quote;
  let normalizedAttestation = attestation && typeof attestation === "object"
    ? { ...attestation }
    : buildQuotePricingAttestation();
  if (isPricingAttestationVerified(normalizedAttestation) && !normalizedAttestation.outputDigest) {
    normalizedAttestation = {
      ...normalizedAttestation,
      outputDigest: buildQuotePricingOutputDigest(quote),
    };
  }
  const pricing = quote.pricing && typeof quote.pricing === "object" ? quote.pricing : {};
  const commercialIssues = validateQuoteCommercialArtifact(quote);
  const issues = dedupeIssues([
    ...(Array.isArray(pricing.issues) ? pricing.issues : []),
    ...commercialIssues,
  ]);
  const verified = isPricingAttestationVerified(normalizedAttestation);
  const sendable = verified && issues.length === 0;
  const ready = sendable && pricing.ready !== false;
  const blockingReason = sendable
    ? null
    : normalizedAttestation.blockingReason
      || (issues.length
        ? describeCommercialIssues(issues)
        : "Fresh commercial pricing could not be verified for this quote build.");

  return {
    ...quote,
    quoteCatalog: quote.quoteCatalog && typeof quote.quoteCatalog === "object"
      ? {
          ...quote.quoteCatalog,
          commercialAuthority: quote.quoteCatalog.commercialAuthority
            ? {
                ...quote.quoteCatalog.commercialAuthority,
                attestation: normalizedAttestation,
              }
            : quote.quoteCatalog.commercialAuthority,
        }
      : quote.quoteCatalog,
    commercialAuthority: quote.commercialAuthority && typeof quote.commercialAuthority === "object"
      ? {
          ...quote.commercialAuthority,
          attestation: normalizedAttestation,
        }
      : quote.commercialAuthority,
    pricing: {
      ...pricing,
      authorityProvider: normalizedAttestation.provider || pricing.authorityProvider || "catalog",
      ready,
      displayable: verified,
      sendable,
      blockingReason,
      requestNonce: normalizedAttestation.requestNonce,
      attestation: normalizedAttestation,
    },
  };
}

/** What an operator has to do about a quote's commercial issues, in their words. */
export function describeCommercialIssues(issues) {
  const codes = new Set((Array.isArray(issues) ? issues : []).map((issue) => issue?.code));
  if (codes.has("empty-commercial-artifact") || codes.has("empty-commercial-total")) {
    return "Add at least one priced item to the quote.";
  }
  if (codes.has("incomplete-commercial-lineage")) {
    return "Some prices aren't linked to a catalogue item or a priced line. Add those items again from the catalogue, or as one-off lines.";
  }
  if (codes.has("nonfinite-commercial-total")) {
    return "The quote total couldn't be worked out. Check each line's quantity and rate.";
  }
  return "Resolve commercial pricing issues before sending this quote.";
}

/**
 * The quote with its send verdict worked out again from what it holds now.
 * The verdict stored with a quote dates from its last save, so a quote saved
 * before a check changed would otherwise stay blocked until edited.
 * Only the commercial checks are re-run: a quote whose pricing attestation no
 * longer verifies, or predates the commercial checks, keeps its stored verdict.
 */
export function withCurrentPricingVerdict(quote) {
  const pricing = quote?.pricing;
  if (!pricing || typeof pricing !== "object" || !requiresCommercialArtifactValidation(quote)) return quote;
  if (!isPricingAttestationVerified(pricing.attestation, quote)) return quote;
  const issues = dedupeIssues([
    ...(Array.isArray(pricing.issues) ? pricing.issues : []),
    ...validateQuoteCommercialArtifact(quote),
  ]);
  const sendable = issues.length === 0;
  if (sendable === (pricing.sendable === true) && (sendable || pricing.blockingReason === describeCommercialIssues(issues))) return quote;
  return {
    ...quote,
    pricing: {
      ...pricing,
      sendable,
      ready: sendable,
      blockingReason: sendable ? null : describeCommercialIssues(issues),
    },
  };
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue?.code || ""}:${issue?.reason || issue?.message || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A verified quote must have a real customer schedule, finite money, and a
 * traceable source line for every customer-visible amount. A quote with only
 * empty/default totals is not a commercial artifact and cannot be displayed
 * as verified or sent.
 */
/**
 * Source codes of the organizer's manual rows: rows the operator priced
 * themselves, typed in or added from the price catalogue (catalogue-linked
 * rows also carry the item uid and price id a send snapshots). Their price is
 * the row's own quantity and rates, so the row is its own lineage.
 */
function manualOrganizerSourceCodes(organizer) {
  const codes = new Set();
  for (const node of Object.values(organizer?.nodes || {})) {
    if (node?.kind !== "source") continue;
    const manual = node.origin === "manual" || (!node.origin && node.sourceKind === "manual");
    const code = String(node.sourceCode || "").trim();
    if (manual && code) codes.add(code);
  }
  return codes;
}

export function validateQuoteCommercialArtifact(quote) {
  const issues = [];
  const { organizer, items: scheduleItems } = getCustomerScheduleView(quote);
  const lineItems = Array.isArray(quote?.lineItems) ? quote.lineItems : [];
  const lineCodes = new Set(lineItems.map((item) => String(item?.code || "").trim()).filter(Boolean));
  for (const code of manualOrganizerSourceCodes(organizer)) lineCodes.add(code);
  const included = scheduleItems.filter((item) => (
    item
    && item.amountVisible !== false
    && item.excludedFromPrice !== true
    && Number.isFinite(Number(item.totalPrice))
    && Number(item.totalPrice) > 0
  ));
  if (!included.length) {
    issues.push({
      code: "empty-commercial-artifact",
      reason: "At least one included customer monetary schedule item is required.",
    });
  }
  for (const item of included) {
    const lineage = Array.isArray(item.sourceLineItemCodes)
      ? item.sourceLineItemCodes.map((code) => String(code || "").trim()).filter(Boolean)
      : [];
    if (!lineage.length || lineage.some((code) => !lineCodes.has(code))) {
      issues.push({
        code: "incomplete-commercial-lineage",
        reason: `Customer schedule item ${item.code || "(unnamed)"} has no complete source lineage.`,
      });
    }
  }
  const financials = getCustomerPresentationFinancials(quote);
  const totals = [financials.subtotal, financials.gst, financials.total];
  if (totals.some((value) => !Number.isFinite(Number(value)))) {
    issues.push({
      code: "nonfinite-commercial-total",
      reason: "Commercial subtotal, tax, and total must be finite.",
    });
  }
  if (included.length && !(Number(financials.total) > 0)) {
    issues.push({
      code: "empty-commercial-total",
      reason: "A priced customer schedule must have a positive total.",
    });
  }
  return dedupeIssues(issues);
}

export function isPricingAttestationVerified(attestation, quote = null) {
  const digestRequired = Boolean(quote) && Number(attestation?.version || 1) >= 2;
  const outputDigestMatches = (!digestRequired && !attestation?.outputDigest)
    || Boolean(attestation?.outputDigest && (!quote || attestation.outputDigest === buildQuotePricingOutputDigest(quote)));
  return Boolean(
    attestation
    && attestation.status === "verified"
    && normalizeText(attestation.requestNonce)
    && attestation.verifiedNonce === attestation.requestNonce
    && (Number(attestation.version || 1) < 2
      || (normalizeText(attestation.catalogRevision) && normalizeText(attestation.snapshotDigest)))
    && outputDigestMatches
  );
}

export function isQuotePricingDisplayable(
  quote,
  { pipelineStage, historical = false, issuedVersion = false, current = false } = {},
) {
  // A sent/landed/lost version is immutable history, but a job-level stage is
  // not enough to classify the current quote: a rebuild deliberately preserves
  // delivery state while making a new draft (preserveQuoteDeliveryState in
  // pipeline.js). Callers serving a selected
  // historical artifact must provide explicit issuance evidence. The
  // no-options branch remains only for legacy internal callers; all external
  // serializers pass `current` or `historical` explicitly.
  if (quote && issuedVersion) return true;
  if (quote && !historical && !current && isPipelineSent(pipelineStage)) return true;

  if (requiresCommercialArtifactValidation(quote) && validateQuoteCommercialArtifact(quote).length) return false;

  if (!quote?.pricing || typeof quote.pricing !== "object") return false;
  if (!quote.pricing.attestation) {
    // Legacy `pricing.ready`/displayable flags are advisory and cannot prove
    // which authority produced the money. They are not sufficient for a
    // current display or send decision.
    return false;
  }
  return Boolean(
    quote?.pricing?.displayable === true
    && isPricingAttestationVerified(quote?.pricing?.attestation, quote)
  );
}

export function isQuotePricingSendable(storedQuote) {
  const quote = withCurrentPricingVerdict(storedQuote);
  if (!quote?.pricing || typeof quote.pricing !== "object") return false;
  if (!quote.pricing.attestation) return false;
  if (requiresCommercialArtifactValidation(quote) && validateQuoteCommercialArtifact(quote).length) return false;
  return Boolean(
    isQuotePricingDisplayable(quote)
    && quote?.pricing?.sendable === true
    && quote?.pricing?.ready !== false
  );
}

function requiresCommercialArtifactValidation(quote) {
  const attestation = quote?.pricing?.attestation;
  return Number(attestation?.version || 1) >= 2 || Boolean(attestation?.snapshotDigest);
}

/** Explicit evidence that a selected version was actually issued. */
export function isIssuedQuoteVersion({
  quote = null,
  quoteLifecycle = null,
  version = null,
  meta = null,
  issuanceRecord = null,
} = {}) {
  const versionNumber = Number(version || quote?.version || meta?.quoteVersion || 0);
  if (issuanceRecord?.issuedAt && Number(issuanceRecord.quoteVersion) === versionNumber) return true;
  // These fields are written by the successful-send lifecycle transition and
  // remain useful for legacy jobs that predate quote-issuance.json. A locked,
  // finalized, landed, or lost draft is not issuance evidence by itself.
  if (quote?.quoteSentAt) return true;
  if (versionNumber > 0 && Number(quoteLifecycle?.lastSentQuoteVersion) === versionNumber) return true;
  if (versionNumber > 0 && Number(meta?.lastSentQuoteVersion) === versionNumber) return true;
  return false;
}

export function assertQuotePricingDisplayable(
  quote,
  action = "display",
  { pipelineStage, historical = false, issuedVersion = false, current = false } = {},
) {
  if (isQuotePricingDisplayable(quote, { pipelineStage, historical, issuedVersion, current })) return;
  const commercialIssues = requiresCommercialArtifactValidation(quote) ? validateQuoteCommercialArtifact(quote) : [];
  const err = new Error(
    (commercialIssues.length ? describeCommercialIssues(commercialIssues) : null)
    || normalizeText(withCurrentPricingVerdict(quote)?.pricing?.blockingReason)
    || `Fresh commercial pricing verification is required before this quote can be ${action}.`
  );
  err.statusCode = 409;
  throw err;
}

export function assertQuotePricingSendable(storedQuote) {
  if (isQuotePricingSendable(storedQuote)) return;
  const quote = withCurrentPricingVerdict(storedQuote);
  const err = new Error(
    normalizeText(quote?.pricing?.blockingReason)
    || "Fresh commercial pricing verification is required before this quote can be sent."
  );
  err.statusCode = 409;
  throw err;
}

export function listLineItemsMissingCost(quote) {
  if (!quote || !Array.isArray(quote.lineItems)) return [];
  return quote.lineItems
    .filter((item) => {
      const price = Number(item?.totalPrice);
      if (!Number.isFinite(price) || price <= 0) return false;
      const cost = Number(item?.totalCost);
      return !Number.isFinite(cost) || cost <= 0;
    })
    .map((item) => ({
      code: item.code || null,
      label: item.customerLabel || item.label || item.code || "(unlabelled line)",
      totalPrice: Number(item.totalPrice) || 0,
    }));
}

export function assertQuoteLineItemCostsComplete(quote) {
  const missing = listLineItemsMissingCost(quote);
  if (!missing.length) return;
  const labels = missing.map((entry) => entry.label).join(", ");
  const err = new Error(
    `Cannot send quote: missing cost on ${missing.length} line item${missing.length === 1 ? "" : "s"} — ${labels}. Open the quote editor and set a cost before sending.`
  );
  err.statusCode = 409;
  err.details = { missing };
  throw err;
}

function deriveLivePricingFailureReason({
  authorityStatus,
  provider,
}) {
  if (provider === "price_catalog_unavailable") {
    return `Fresh commercial pricing could not be verified: ${normalizeText(authorityStatus?.error) || "price catalog is unavailable."}`;
  }
  if (provider === "disabled" || provider === "catalog" || provider === "price_catalog") {
    return "Fresh commercial pricing could not be verified for this build.";
  }
  return "Fresh commercial pricing could not be verified for this build.";
}
