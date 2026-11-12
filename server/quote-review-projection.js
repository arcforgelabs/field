import { attachQuotePricingAttestation, isPricingAttestationVerified } from "./quote-pricing-attestation.js";

export function projectQuoteForReviewState({ quote, gaps = [] }) {
  if (!quote || typeof quote !== "object") return quote;

  const nextQuote = structuredClone(quote);
  const currentGaps = (gaps || []).filter((gap) => gap.presentInCurrentContext !== false);
  const openKeys = new Set(
    currentGaps
      .filter((gap) => gap.status === "open" || gap.status === "in_progress")
      .map((gap) => normalizeFieldKey(gap.field))
      .filter(Boolean)
  );
  const acceptedByKey = new Map(
    currentGaps
      .filter((gap) => gap.status === "accepted")
      .map((gap) => [normalizeFieldKey(gap.field), gap])
      .filter(([key]) => Boolean(key))
  );
  const closedNonAssumedKeys = new Set(
    currentGaps
      .filter((gap) => gap.status === "confirmed" || gap.status === "rejected" || gap.status === "cleared")
      .map((gap) => normalizeFieldKey(gap.field))
      .filter(Boolean)
  );
  const resolvedKeys = new Set([
    ...acceptedByKey.keys(),
    ...closedNonAssumedKeys,
  ]);

  if (Array.isArray(nextQuote.assumptionInputs)) {
    nextQuote.assumptionInputs = nextQuote.assumptionInputs
      .filter((item) => {
        const key = normalizeFieldKey(item.field);
        if (!key || openKeys.has(key) || closedNonAssumedKeys.has(key)) return false;
        return acceptedByKey.has(key) || !resolvedKeys.has(key);
      })
      .map((item) => {
        const key = normalizeFieldKey(item.field);
        const acceptedGap = acceptedByKey.get(key);
        if (!acceptedGap) return item;
        return {
          ...item,
          value:
            acceptedGap.resolution?.note
            || acceptedGap.assumption?.value
            || acceptedGap.assumption?.defaultValue
            || item.value,
        };
      });
  }

  if (Array.isArray(nextQuote.missingInputs)) {
    nextQuote.missingInputs = nextQuote.missingInputs.filter(
      (field) => !resolvedKeys.has(normalizeFieldKey(field))
    );
  }

  if (Array.isArray(nextQuote.assumptions)) {
    const stableAssumptions = nextQuote.assumptions.filter(
      (entry) => !/^(?:Updated input|Default assumption|Derived assumption) for .+?:/.test(String(entry || ""))
    );
    const projectedAssumptions = (nextQuote.assumptionInputs || [])
      .map((item) => {
        const value = item.value || item.defaultValue || "";
        if (!item.field || !value) return null;
        return `${describeAssumptionSource(item.source)} for ${item.field}: ${value}`;
      })
      .filter(Boolean);
    nextQuote.assumptions = [...stableAssumptions, ...projectedAssumptions];
  }

  nextQuote.review = projectReviewFlags(nextQuote);
  nextQuote.status = nextQuote.review.status;

  // Review changes only annotations, but removing a missing-input array entry
  // changes the legacy output digest. Carry verified authority across this
  // trusted projection only; never repair a source whose money was changed.
  if (isPricingAttestationVerified(quote.pricing?.attestation, quote)) {
    return attachQuotePricingAttestation({
      quote: nextQuote,
      attestation: { ...quote.pricing.attestation, outputDigest: undefined },
    });
  }
  return nextQuote;
}

function projectReviewFlags(quote) {
  const reviewReasons = Array.isArray(quote.review?.reasons) ? quote.review.reasons : [];
  const activeMissingKeys = new Set(
    (quote.missingInputs || [])
      .map((field) => normalizeFieldKey(field))
      .filter(Boolean)
  );
  const activeDefaultAssumptionKeys = new Set(
    (quote.assumptionInputs || [])
      .filter((item) => (item.source === "default" || item.source === "derived") && item.affectsPricing)
      .map((item) => normalizeFieldKey(item.field))
      .filter(Boolean)
  );
  const nextReasons = reviewReasons.filter((reason) => {
    const missingMatch = /^Missing input priced with assumption:\s*(.+)$/.exec(String(reason || ""));
    if (missingMatch) {
      return activeMissingKeys.has(normalizeFieldKey(missingMatch[1]));
    }

    const defaultAssumptionMatch = /^Default pricing assumption used for\s*(.+?)\.$/.exec(String(reason || ""));
    if (defaultAssumptionMatch) {
      return activeDefaultAssumptionKeys.has(normalizeFieldKey(defaultAssumptionMatch[1]));
    }

    const derivedAssumptionMatch = /^Derived pricing assumption used for\s*(.+?)\.$/.exec(String(reason || ""));
    if (derivedAssumptionMatch) {
      return activeDefaultAssumptionKeys.has(normalizeFieldKey(derivedAssumptionMatch[1]));
    }

    return true;
  });

  return {
    ...(quote.review || {}),
    status: nextReasons.length > 0 ? "manual_review" : "ready",
    reasons: nextReasons,
  };
}

function normalizeFieldKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function describeAssumptionSource(source) {
  if (source === "user") return "Updated input";
  if (source === "derived") return "Derived assumption";
  return "Default assumption";
}
