function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function extractSectionFromScopedLineItemCode(code) {
  const normalizedCode = normalizeText(code);
  if (!normalizedCode) return null;

  const marker = "__section-";
  const markerIndex = normalizedCode.indexOf(marker);
  if (markerIndex < 0) return null;

  const rawSlug = normalizedCode.slice(markerIndex + marker.length).trim();
  if (!rawSlug) return null;

  const section = rawSlug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!section) return null;
  return section.charAt(0).toUpperCase() + section.slice(1);
}

function resolveSectionLabel(section, code) {
  const explicitSection = normalizeText(section);
  if (explicitSection) return explicitSection;
  return extractSectionFromScopedLineItemCode(code);
}

export function buildDisambiguatedSourceLabels(
  items = [],
  {
    getLabel = (item) => item?.sourceLineItemLabel ?? item?.label ?? null,
    getSection = (item) => item?.sourceSection ?? item?.section ?? null,
    getCode = (item) => item?.sourceLineItemCode ?? item?.sourceCode ?? item?.code ?? null,
    fallbackLabel = "Quoted line item",
  } = {},
) {
  const prepared = items.map((item) => {
    const baseLabel = normalizeText(getLabel(item)) || normalizeText(getCode(item)) || fallbackLabel;
    const sectionLabel = resolveSectionLabel(getSection(item), getCode(item));
    return {
      baseLabel,
      sectionLabel,
    };
  });

  const labelCounts = new Map();
  for (const entry of prepared) {
    labelCounts.set(entry.baseLabel, (labelCounts.get(entry.baseLabel) || 0) + 1);
  }

  const contextualCounts = new Map();
  for (const entry of prepared) {
    if ((labelCounts.get(entry.baseLabel) || 0) < 2) continue;
    const contextKey = `${entry.baseLabel}\u0000${normalizeText(entry.sectionLabel).toLowerCase() || "__missing__"}`;
    contextualCounts.set(contextKey, (contextualCounts.get(contextKey) || 0) + 1);
  }

  const seenContextCounts = new Map();
  return prepared.map((entry) => {
    if ((labelCounts.get(entry.baseLabel) || 0) < 2) {
      return {
        ...entry,
        disambiguationSuffix: null,
        displayLabel: entry.baseLabel,
      };
    }

    const contextKey = `${entry.baseLabel}\u0000${normalizeText(entry.sectionLabel).toLowerCase() || "__missing__"}`;
    const contextCount = contextualCounts.get(contextKey) || 0;
    const sequence = contextCount > 1
      ? (seenContextCounts.get(contextKey) || 0) + 1
      : null;

    if (sequence != null) {
      seenContextCounts.set(contextKey, sequence);
    }

    if (entry.sectionLabel) {
      const disambiguationSuffix = sequence != null
        ? `${entry.sectionLabel} (${sequence})`
        : entry.sectionLabel;
      return {
        ...entry,
        disambiguationSuffix,
        displayLabel: `${entry.baseLabel} — ${disambiguationSuffix}`,
      };
    }

    if (sequence != null) {
      const disambiguationSuffix = `(${sequence})`;
      return {
        ...entry,
        disambiguationSuffix,
        displayLabel: `${entry.baseLabel} ${disambiguationSuffix}`,
      };
    }

    return {
      ...entry,
      disambiguationSuffix: null,
      displayLabel: entry.baseLabel,
    };
  });
}
