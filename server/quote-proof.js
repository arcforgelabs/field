import { isQuotePricingSendable } from "./quote-pricing-attestation.js";

export function buildQuoteProofSummary({
  meta = null,
  transcript = null,
  evidencePack = null,
  quoteInputs = null,
  quoteBreakdownSource = null,
  quote = null,
  quoteLifecycle = null,
  hasQuotePdf = false,
}) {
  const runType = detectQuoteRunType({ meta, transcript, quoteLifecycle });
  const buildReason = normalizeString(quoteLifecycle?.lastBuildReason);
  const reviewStatus = normalizeString(quote?.review?.status || quote?.status);
  const hasTranscript = Boolean(transcript);
  const hasEvidencePack = Boolean(evidencePack);
  const hasQuoteInputs = Boolean(quoteInputs);
  const hasQuoteBreakdownSource = Boolean(quoteBreakdownSource);
  const hasQuote = Boolean(quote);
  const canSend =
    Boolean(quote)
    && isQuotePricingSendable(quote)
    && Array.isArray(quote?.missingInputs)
    && quote.missingInputs.length === 0
    && reviewStatus === "ready";
  const sendCount = Number(quoteLifecycle?.sendCount || 0);
  const commercialAuthorityProvider = normalizeString(
    quote?.commercialAuthority?.provider
    || quote?.quoteCatalog?.commercialAuthority?.provider
    || quote?.quoteCatalog?.commercialAuthorityProvider
  ) || "local";

  const verdict = deriveVerdict({
    runType,
    hasTranscript,
    hasEvidencePack,
    hasQuoteInputs,
    hasQuote,
    canSend,
    sendCount,
    reviewStatus,
  });

  return {
    version: 1,
    runType,
    buildReason,
    verdict,
    claim: buildClaim(runType, verdict),
    whatIsProven: buildWhatIsProven({
      runType,
      hasTranscript,
      hasEvidencePack,
      hasQuoteBreakdownSource,
      hasQuoteInputs,
      hasQuote,
      hasQuotePdf,
      canSend,
      sendCount,
      commercialAuthorityProvider,
    }),
    whatIsNotProven: buildWhatIsNotProven({
      runType,
      hasTranscript,
      hasEvidencePack,
      hasQuoteBreakdownSource,
      hasQuoteInputs,
      hasQuote,
      sendCount,
    }),
    recommendedFirstFiles: [
      "meta.json",
      "transcript.json",
      "evidence-pack.json",
      "quote-breakdown-source.json",
      "quote-inputs.json",
      "quote.json",
      "quote.pdf",
      "quote-lifecycle.json",
    ],
    artifacts: {
      transcript: hasTranscript,
      evidencePack: hasEvidencePack,
      quoteBreakdownSource: hasQuoteBreakdownSource,
      quoteInputs: hasQuoteInputs,
      quote: hasQuote,
      quotePdf: Boolean(hasQuotePdf),
      quoteLifecycle: Boolean(quoteLifecycle),
    },
    reviewStatus,
    canSend,
    sendCount,
    commercialAuthorityProvider,
  };
}

export function detectQuoteRunType({
  meta = null,
  transcript = null,
  quoteLifecycle = null,
}) {
  const buildReason = normalizeString(quoteLifecycle?.lastBuildReason);
  const transcriptModel = normalizeString(transcript?.model);
  const captureMode = normalizeString(meta?.captureMode);
  const hasAudio = Boolean(meta?.audioFiles?.length || meta?.audioFile);

  if (buildReason === "staging_seed_fixture" || transcriptModel === "seed-fixture") {
    return "seeded_fixture";
  }
  if (captureMode === "manual") {
    return "manual_entry";
  }
  if (hasAudio) {
    return "audio_capture";
  }
  if (captureMode === "recorded" || captureMode === "recording") {
    return "audio_capture";
  }
  return "unknown";
}

function deriveVerdict({
  runType,
  hasTranscript,
  hasEvidencePack,
  hasQuoteInputs,
  hasQuote,
  canSend,
  sendCount,
  reviewStatus,
}) {
  if (!hasQuote || !hasTranscript) {
    return "incomplete";
  }
  if (runType === "seeded_fixture") {
    return "structural_only";
  }
  if (sendCount > 0) {
    return "sent";
  }
  if (canSend) {
    return "review_ready";
  }
  if (reviewStatus === "manual_review") {
    return "manual_review";
  }
  if (hasEvidencePack || hasQuoteInputs) {
    return "built_not_validated";
  }
  return "incomplete";
}

function buildClaim(runType, verdict) {
  if (runType === "seeded_fixture") {
    return "This run proves grouped quote artifact generation from structured inputs on the live app path. It does not prove audio extraction.";
  }
  if (runType === "manual_entry") {
    return "This run proves manual quote assembly in the app. It does not prove audio extraction.";
  }
  if (runType === "audio_capture" && verdict === "sent") {
    return "This run proves the audio-backed quote path reached a sent quote.";
  }
  if (runType === "audio_capture") {
    return "This run proves the audio-backed quote path reached a draft quote. Human review is still part of the trust boundary.";
  }
  return "This run has quote artifacts, but the capture and extraction path is not classified clearly yet.";
}

function buildWhatIsProven({
  runType,
  hasTranscript,
  hasEvidencePack,
  hasQuoteBreakdownSource,
  hasQuoteInputs,
  hasQuote,
  hasQuotePdf,
  canSend,
  sendCount,
  commercialAuthorityProvider,
}) {
  const facts = [];
  if (hasTranscript) facts.push("The run has a transcript artifact.");
  if (hasEvidencePack) facts.push("The run has an evidence-pack extraction boundary.");
  if (hasQuoteBreakdownSource) facts.push("The run has a normalized quote breakdown source artifact.");
  if (hasQuoteInputs) facts.push("The run has structured quote inputs.");
  if (hasQuote) facts.push("The run has a deterministic quote payload.");
  if (commercialAuthorityProvider === "price_catalog") {
    facts.push("The quote is using price-catalog-backed commercial authority.");
  } else if (commercialAuthorityProvider === "price_catalog") {
    facts.push("The quote is using an external commercial authority.");
  }
  if (hasQuotePdf) facts.push("The run has a customer-facing PDF artifact.");
  if (runType === "seeded_fixture") {
    facts.push("The live app path can render seeded staging fixtures into reviewable quote artifacts.");
  }
  if (canSend) {
    facts.push("The current draft has no open missing inputs and is marked review-ready.");
  }
  if (sendCount > 0) {
    facts.push("The lifecycle shows the quote was sent at least once.");
  }
  return facts;
}

function buildWhatIsNotProven({
  runType,
  hasTranscript,
  hasEvidencePack,
  hasQuoteBreakdownSource,
  hasQuoteInputs,
  hasQuote,
  sendCount,
}) {
  const gaps = [];
  if (!hasTranscript) gaps.push("No transcript artifact is present.");
  if (!hasEvidencePack) gaps.push("No evidence-pack artifact is present.");
  if (!hasQuoteBreakdownSource) gaps.push("No normalized quote breakdown source artifact is present.");
  if (!hasQuoteInputs) gaps.push("No structured quote-input artifact is present.");
  if (!hasQuote) gaps.push("No quote payload is present.");
  if (runType === "seeded_fixture" || runType === "manual_entry" || runType === "unknown") {
    gaps.push("Sparse verbal extraction from raw audio is not proven by this run.");
  }
  if (sendCount < 1) {
    gaps.push("Customer delivery is not proven by this run.");
  }
  return gaps;
}

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
