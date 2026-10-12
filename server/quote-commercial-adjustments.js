import { normalizePresentationOrganizer } from "./quote-presentation-organizer.js";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMultilineText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function normalizeSectionKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeLineItemCode(value) {
  const code = normalizeText(value);
  return code || null;
}

function normalizeQuoteCatalogItemCode(value) {
  const code = normalizeText(value);
  return code || null;
}

function extractBaseRuleCode(lineItemCode) {
  const code = normalizeText(lineItemCode);
  if (!code) return null;
  const marker = "__section-";
  const idx = code.indexOf(marker);
  return idx >= 0 ? code.slice(0, idx) : code;
}

function extractSectionFromLineItemCode(lineItemCode) {
  const code = normalizeText(lineItemCode);
  if (!code) return null;
  const marker = "__section-";
  const idx = code.indexOf(marker);
  if (idx < 0) return null;
  const slug = code.slice(idx + marker.length).trim();
  if (!slug) return null;
  return slug.replace(/-/g, " ");
}

export function buildCommercialAdjustmentKey(target = {}) {
  const lineItemCode = normalizeLineItemCode(target.lineItemCode);
  if (lineItemCode) return `line:${lineItemCode}`;

  const quoteCatalogItemCode = normalizeQuoteCatalogItemCode(target.quoteCatalogItemCode);
  if (!quoteCatalogItemCode) return null;

  const sectionKey = normalizeSectionKey(target.section);
  return sectionKey
    ? `rule:${quoteCatalogItemCode}::section:${sectionKey}`
    : `rule:${quoteCatalogItemCode}`;
}

export function normalizeCommercialAdjustmentTarget(target = {}) {
  const lineItemCode = normalizeLineItemCode(target.lineItemCode || target.code);
  const quoteCatalogItemCode = normalizeQuoteCatalogItemCode(
    target.quoteCatalogItemCode || target.baseRuleCode || extractBaseRuleCode(lineItemCode)
  );
  const section = normalizeText(target.section || extractSectionFromLineItemCode(lineItemCode)) || null;

  if (!lineItemCode && !quoteCatalogItemCode) return null;

  return {
    lineItemCode,
    quoteCatalogItemCode,
    section,
  };
}

export function normalizeCommercialAdjustments(value) {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .map(normalizeCommercialAdjustment)
    .filter(Boolean);

  return normalized.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
}

function normalizeCommercialAdjustment(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const target = normalizeCommercialAdjustmentTarget(entry.target || entry);
  if (!target) return null;

  const remove = entry.remove === true;
  const unitPrice = Number.isFinite(Number(entry.unitPrice)) && Number(entry.unitPrice) > 0
    ? Number(entry.unitPrice)
    : null;
  const unitCost = entry.unitCost != null
    && Number.isFinite(Number(entry.unitCost))
    && Number(entry.unitCost) >= 0
    ? Number(entry.unitCost)
    : null;

  if (!remove && unitPrice == null && unitCost == null) return null;

  return {
    id: normalizeText(entry.id) || buildCommercialAdjustmentKey(target),
    kind: "set_unit_price",
    target,
    unitPrice,
    unitCost,
    notes: normalizeText(entry.notes || entry.note) || null,
    source: normalizeText(entry.source) || null,
    createdAt: normalizeText(entry.createdAt) || null,
    updatedAt: normalizeText(entry.updatedAt) || null,
    remove,
  };
}

export function mergeCommercialAdjustments(existing = [], incoming = []) {
  const merged = new Map();

  for (const adjustment of normalizeCommercialAdjustments(existing)) {
    merged.set(adjustment.id, {
      ...adjustment,
      remove: false,
    });
  }

  const now = new Date().toISOString();
  for (const adjustment of normalizeCommercialAdjustments(incoming)) {
    if (adjustment.remove) {
      merged.delete(adjustment.id);
      continue;
    }

    const previous = merged.get(adjustment.id);
    merged.set(adjustment.id, {
      ...(previous || {}),
      ...adjustment,
      // Preserve previous unitPrice/unitCost when the incoming patch did not provide one.
      // This lets an operator edit cost without clobbering an existing price override
      // (and vice versa). To clear a field, remove the adjustment and re-add.
      unitPrice: adjustment.unitPrice != null ? adjustment.unitPrice : (previous?.unitPrice ?? null),
      unitCost: adjustment.unitCost != null ? adjustment.unitCost : (previous?.unitCost ?? null),
      createdAt: previous?.createdAt || adjustment.createdAt || now,
      updatedAt: adjustment.updatedAt || now,
      remove: false,
    });
  }

  return [...merged.values()].sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
}

export function liftLegacyLineItemRateAdjustments(lineItems = {}) {
  if (!lineItems || typeof lineItems !== "object") return [];

  return Object.entries(lineItems)
    .map(([lineItemCode, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const unitPrice = Number.isFinite(Number(value.unitPrice)) && Number(value.unitPrice) > 0
        ? Number(value.unitPrice)
        : null;
      const unitCost = value.unitCost != null
        && Number.isFinite(Number(value.unitCost))
        && Number(value.unitCost) >= 0
        ? Number(value.unitCost)
        : null;
      if (unitPrice == null && unitCost == null) return null;

      const target = normalizeCommercialAdjustmentTarget({
        lineItemCode,
        quoteCatalogItemCode: extractBaseRuleCode(lineItemCode),
        section: extractSectionFromLineItemCode(lineItemCode),
      });

      return {
        id: buildCommercialAdjustmentKey(target),
        kind: "set_unit_price",
        target,
        unitPrice,
        unitCost,
        notes: normalizeText(value.notes) || null,
        source: "legacy_line_item_override",
        createdAt: null,
        updatedAt: null,
      };
    })
    .filter(Boolean);
}

export function removeLegacyLineItemRateFields(lineItems = {}) {
  if (!lineItems || typeof lineItems !== "object") return {};

  return Object.fromEntries(
    Object.entries(lineItems).map(([lineItemCode, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [lineItemCode, value];
      }

      const { unitPrice, unitCost, ...rest } = value;
      return [lineItemCode, rest];
    })
  );
}

export function canonicalizeQuoteOverrides(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return overrides || null;

  const next = {
    ...overrides,
    lineItems: removeLegacyLineItemRateFields(overrides.lineItems),
  };

  const commercialAdjustments = mergeCommercialAdjustments(
    liftLegacyLineItemRateAdjustments(overrides.lineItems),
    overrides.commercialAdjustments
  );

  if (commercialAdjustments.length) {
    next.commercialAdjustments = commercialAdjustments;
  } else {
    delete next.commercialAdjustments;
  }

  const presentation = normalizePresentationOverrides(overrides.presentation);
  if (presentation) {
    next.presentation = presentation;
  } else {
    delete next.presentation;
  }

  return next;
}

export function normalizePresentationOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const normalized = {};
  const hasScopeText = Object.prototype.hasOwnProperty.call(value, "scopeText")
    || Object.prototype.hasOwnProperty.call(value, "scope");
  if (hasScopeText) {
    normalized.scopeText = normalizeMultilineText(value.scopeText ?? value.scope) || null;
  }

  if (Object.prototype.hasOwnProperty.call(value, "organizer")) {
    normalized.organizer = normalizePresentationOrganizer(value.organizer);
  }

  if (Object.prototype.hasOwnProperty.call(value, "validityDays")) {
    const days = Number(value.validityDays);
    if (Number.isFinite(days) && days > 0) normalized.validityDays = days;
  }

  return Object.keys(normalized).length ? normalized : null;
}

export function mergePresentationOverrides(existing = null, incoming = null) {
  const normalizedExisting = normalizePresentationOverrides(existing) || {};
  const normalizedIncoming = normalizePresentationOverrides(incoming) || {};
  const merged = {
    ...normalizedExisting,
  };

  if (Object.prototype.hasOwnProperty.call(normalizedIncoming, "scopeText")) {
    merged.scopeText = normalizedIncoming.scopeText;
  }

  if (Object.prototype.hasOwnProperty.call(normalizedIncoming, "organizer")) {
    merged.organizer = normalizedIncoming.organizer;
  }

  if (!Object.prototype.hasOwnProperty.call(normalizedIncoming, "organizer")
    && Object.prototype.hasOwnProperty.call(normalizedExisting, "organizer")) {
    merged.organizer = normalizedExisting.organizer;
  }

  if (Object.prototype.hasOwnProperty.call(normalizedIncoming, "validityDays")) {
    merged.validityDays = normalizedIncoming.validityDays;
  } else if (Object.prototype.hasOwnProperty.call(normalizedExisting, "validityDays")) {
    merged.validityDays = normalizedExisting.validityDays;
  }

  return Object.values(merged).some((value) => value != null) ? merged : null;
}

export function findCommercialAdjustmentForLineItem(
  adjustments,
  { lineItemCode = null, quoteCatalogItemCode = null, section = null } = {}
) {
  const normalized = normalizeCommercialAdjustments(adjustments);
  const normalizedLineItemCode = normalizeLineItemCode(lineItemCode);
  const normalizedQuoteCatalogItemCode = normalizeQuoteCatalogItemCode(quoteCatalogItemCode);
  const normalizedSection = normalizeSectionKey(section);

  if (normalizedLineItemCode) {
    const exact = normalized.find((adjustment) => adjustment.target.lineItemCode === normalizedLineItemCode);
    if (exact) return exact;
  }

  if (!normalizedQuoteCatalogItemCode) return null;

  const sectionMatch = normalized.find((adjustment) =>
    adjustment.target.lineItemCode == null
    && adjustment.target.quoteCatalogItemCode === normalizedQuoteCatalogItemCode
    && normalizeSectionKey(adjustment.target.section) === normalizedSection
  );
  if (sectionMatch) return sectionMatch;

  return normalized.find((adjustment) =>
    adjustment.target.lineItemCode == null
    && adjustment.target.quoteCatalogItemCode === normalizedQuoteCatalogItemCode
    && !normalizeSectionKey(adjustment.target.section)
  ) || null;
}
