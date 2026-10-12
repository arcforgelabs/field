import { isQuotePricingDisplayable } from "./quote-pricing-attestation.js";
import { getCustomerPresentationFinancials } from "./quote-presentation.js";

const EXPLICIT_MONETARY_FIELD_KEYS = new Set([
  "authorityUnitPrice",
  "charge",
  "cost",
  "gst",
  "sourceTotalPrice",
  "subtotal",
  "total",
  "totalCost",
  "totalPrice",
  "unitCost",
  "unitPrice",
]);

export function getDisplayableQuoteMarkdown(
  quote,
  quoteMarkdown,
  pipelineStage = null,
  { historical = false, issuedVersion = false, current = false } = {},
) {
  return isQuotePricingDisplayable(quote, { pipelineStage, historical, issuedVersion, current })
    ? (quoteMarkdown || null)
    : null;
}

export function getDisplayableJobReport({
  meta = null,
  quote = null,
  report = null,
  historical = false,
  issuedVersion = false,
  current = false,
} = {}) {
  if ((meta?.outputMode || "report") !== "quote") return report ?? null;
  return getDisplayableQuoteMarkdown(quote, report, meta?.pipelineStage || null, { historical, issuedVersion, current });
}

export function sanitizeQuoteDocumentSurfaces(detail, { historical = false, issuedVersion = false, current = true } = {}) {
  if (!detail || typeof detail !== "object") return detail;
  return {
    ...detail,
    quoteMarkdown: getDisplayableQuoteMarkdown(
      detail.quote,
      detail.quoteMarkdown,
      detail.meta?.pipelineStage || null,
      { historical, issuedVersion, current },
    ),
    report: getDisplayableJobReport({
      meta: detail.meta,
      quote: detail.quote,
      report: detail.report,
      historical,
      issuedVersion,
      current,
    }),
  };
}

export function sanitizeQuoteForPricingDisplay(
  quote,
  pipelineStage = null,
  { historical = false, issuedVersion = false, current = false } = {},
) {
  if (!quote || typeof quote !== "object") return quote;
  if (isQuotePricingDisplayable(quote, { pipelineStage, historical, issuedVersion, current })) return quote;

  const sanitized = sanitizeMonetaryFields(quote);
  return {
    ...sanitized,
    presentation: hideQuotePresentationPricing(quote.presentation),
    commercialLines: [],
    budgetLines: [],
    materialOrders: [],
    internalPricing: null,
  };
}

/**
 * Single client-facing serializer for job detail and quote document aliases.
 * `historical` is supplied only when the selected bytes are an immutable
 * issued version; current drafts are always evaluated against attestation.
 */
export function serializeClientJobDetail(detail, { historical = false, issuedVersion = false } = {}) {
  if (!detail || typeof detail !== "object") return detail;
  const current = !historical;
  const pipelineStage = detail.meta?.pipelineStage || null;
  const visibleMeta = sanitizeClientJobMeta(detail.meta, detail.quote, {
    historical,
    issuedVersion,
    current,
  });
  const quote = sanitizeQuoteForPricingDisplay(detail.quote, pipelineStage, { historical, issuedVersion, current });
  return {
    ...detail,
    meta: visibleMeta,
    quote,
    quoteMarkdown: getDisplayableQuoteMarkdown(
      detail.quote,
      detail.quoteMarkdown,
      pipelineStage,
      { historical, issuedVersion, current },
    ),
    report: getDisplayableJobReport({
      meta: detail.meta,
      quote: detail.quote,
      report: detail.report,
      historical,
      issuedVersion,
      current,
    }),
  };
}

/** Keep quote-derived summary fields truthful on every client response. */
export function sanitizeClientJobMeta(
  meta,
  quote,
  { historical = false, issuedVersion = false, current = true } = {},
) {
  if (!meta || typeof meta !== "object") return meta;
  if (isQuotePricingDisplayable(quote, {
    pipelineStage: meta.pipelineStage || meta.deliveryStatus,
    historical,
    issuedVersion,
    current,
  })) {
    // Financial summary fields belong to the selected quote version, not to
    // the job's mutable current meta projection. This keeps an issued v1
    // response from displaying v2 totals when a newer draft is current.
    // They are the customer-facing totals the PDF prints. `quote.totals` is
    // only the pricing engine's compiled lines, which is $0 for a quote built
    // in the editor.
    const totals = quote ? getCustomerPresentationFinancials(quote) : {};
    return {
      ...meta,
      quoteVersion: quote?.version ?? meta.quoteVersion ?? null,
      quoteSubtotal: Number.isFinite(Number(totals.subtotal)) ? Number(totals.subtotal) : null,
      quoteGst: Number.isFinite(Number(totals.gst)) ? Number(totals.gst) : null,
      quoteTotal: Number.isFinite(Number(totals.total)) ? Number(totals.total) : null,
      quoteNumber: quote?.quoteNumber ?? meta.quoteNumber ?? null,
      jobNumber: quote?.jobNumber ?? meta.jobNumber ?? null,
    };
  }
  return sanitizeMonetaryFields(meta);
}

/** Sanitize a non-quote pricing payload such as a wall model. */
export function sanitizePricingSurface(value, { displayable = false } = {}) {
  return displayable ? value : sanitizeMonetaryFields(value);
}

function sanitizeMonetaryFields(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMonetaryFields(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isMonetaryFieldKey(key)) {
      result[key] = entry == null ? entry : null;
      continue;
    }
    result[key] = sanitizeMonetaryFields(entry);
  }
  return result;
}

function hideQuotePresentationPricing(presentation) {
  if (!presentation || typeof presentation !== "object") return presentation || null;
  return {
    ...sanitizeMonetaryFields(presentation),
    sourceItems: Array.isArray(presentation.sourceItems)
      ? presentation.sourceItems.map((item) => hidePresentationItemAmount(item))
      : presentation.sourceItems,
    scheduleItems: Array.isArray(presentation.scheduleItems)
      ? presentation.scheduleItems.map((item) => hidePresentationItemAmount(item))
      : presentation.scheduleItems,
    sections: Array.isArray(presentation.sections)
      ? presentation.sections.map((section) => ({
          ...sanitizeMonetaryFields(section),
          items: Array.isArray(section?.items)
            ? section.items.map((item) => hidePresentationItemAmount(item))
            : [],
        }))
      : presentation.sections,
  };
}

function hidePresentationItemAmount(item) {
  if (!item || typeof item !== "object") return item;
  return {
    ...sanitizeMonetaryFields(item),
    amountVisible: false,
    amountBlank: false,
    components: Array.isArray(item.components)
      ? item.components.map((component) => ({
          ...sanitizeMonetaryFields(component),
          amountVisible: false,
          amountBlank: false,
        }))
      : item.components,
  };
}

function isMonetaryFieldKey(key) {
  const normalized = String(key || "").trim();
  if (!normalized) return false;
  if (EXPLICIT_MONETARY_FIELD_KEYS.has(normalized)) return true;
  return /(?:^|[_-])(amount|price|cost|charge|rate|subtotal|total)(?:$|[_-])/i.test(normalized)
    || /(?:amount|price|cost|charge|rate|subtotal|total)[A-Z]/.test(normalized)
    || /(?:Amount|Price|Cost|Charge|Rate|Subtotal|Total)/.test(normalized);
}
