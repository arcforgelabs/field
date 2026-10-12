import { formatCatalogUnit, formatCatalogUnitText } from "../shared/catalog-units.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeAuthorityBaseUrl(value) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

export function normalizeCommercialAuthorityProvider(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  return normalized || "catalog";
}

export function isExternalAuthorityProvider(provider) {
  const normalized = normalizeCommercialAuthorityProvider(provider);
  return normalized === "external_authority" || normalized.startsWith("external_");
}

export function isPriceCatalogAuthorityProvider(provider) {
  return normalizeCommercialAuthorityProvider(provider) === "price_catalog";
}

export function buildCommercialItemReference({ itemCode, provider }) {
  if (!itemCode) return null;
  if (isPriceCatalogAuthorityProvider(provider)) {
    return {
      type: "price_catalog_item",
      label: "Price catalog",
      itemCode,
      title: `${itemCode} — buy and sell pricing`,
    };
  }
  if (isExternalAuthorityProvider(provider)) {
    return {
      type: "authority_item",
      label: "External authority item",
      itemCode,
      title: `External authority item ${itemCode}`,
    };
  }
  return {
    type: "catalog_item",
    label: "Catalog item",
    itemCode,
    title: `Catalog item ${itemCode}`,
  };
}

export function buildCommercialPriceReferences({
  authority = null,
  itemCode,
  provider = null,
  buyingPriceRecordName = null,
  sellingPriceRecordName = null,
}) {
  if (!itemCode) return [];
  const resolvedProvider = normalizeCommercialAuthorityProvider(provider || authority?.provider);
  if (isPriceCatalogAuthorityProvider(resolvedProvider)) {
    // Merged into a single reference — the item reference from buildCommercialItemReference
    // already covers the price catalog item. No separate buy/sell references needed.
    return [];
  }

  const authorityBaseUrl = normalizeAuthorityBaseUrl(authority?.publicBaseUrl || authority?.baseUrl);
  if (!isExternalAuthorityProvider(resolvedProvider) || !authorityBaseUrl) return [];

  const refs = [];
  if (authority?.buyingPriceList) {
    refs.push({
      type: "authority_price_record",
      label: "External authority cost price",
      itemCode,
      priceList: authority.buyingPriceList,
      priceRecordName: buyingPriceRecordName || null,
      title: `External authority cost price for ${itemCode} in ${authority.buyingPriceList}`,
    });
  }
  if (authority?.sellingPriceList) {
    refs.push({
      type: "authority_price_record",
      label: "External authority selling price",
      itemCode,
      priceList: authority.sellingPriceList,
      priceRecordName: sellingPriceRecordName || null,
      title: `External authority selling price for ${itemCode} in ${authority.sellingPriceList}`,
    });
  }
  return refs;
}

export function dedupeBy(values, toKey) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const key = toKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function entryKey(entry) {
  return [
    entry?.label || "",
    entry?.expression || "",
    entry?.value || "",
    entry?.result || "",
    entry?.note || "",
  ].join("::");
}

export function referenceKey(reference) {
  return [
    reference?.type || "",
    reference?.path || "",
    reference?.itemCode || "",
    reference?.priceList || "",
    reference?.start ?? "",
    reference?.end ?? "",
    reference?.index ?? "",
    reference?.label || "",
  ].join("::");
}

export function formatTraceMoney(value) {
  const rounded = Math.round(Number(value || 0) * 100) / 100;
  return `$${rounded.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatTraceQuantity(value) {
  return (Math.round(Number(value || 0) * 10000) / 10000).toLocaleString("en-AU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

export function formatTraceValue(value, format = null, unit = null) {
  if (value == null || value === "") return "";
  if (format === "money") return formatTraceMoney(value);
  if (typeof value === "number") {
    const quantity = formatTraceQuantity(value);
    return unit ? `${quantity} ${formatCatalogUnit(unit)}` : quantity;
  }
  return formatCatalogUnitText(value);
}

export function normalizeTraceReferences(references) {
  return asArray(references)
    .filter(Boolean)
    .map((entry) => ({
      type: entry.type || "reference",
      label: entry.label || "Reference",
      title: entry.title || null,
      path: entry.path || null,
      itemCode: entry.itemCode || null,
      priceList: entry.priceList || null,
      priceRecordName: entry.priceRecordName || null,
      summary: entry.summary || null,
      start: entry.start ?? null,
      end: entry.end ?? null,
      index: entry.index ?? null,
    }))
    .filter((entry) => entry.label || entry.path || entry.itemCode || entry.summary);
}

export function buildTraceEntry(label, expression, {
  result = null,
  note = null,
  references = [],
} = {}) {
  if (expression == null || expression === "") return null;
  return {
    label: label || "Step",
    expression: formatCatalogUnitText(expression),
    result,
    note: note == null ? note : formatCatalogUnitText(note),
    references: normalizeTraceReferences(references),
  };
}

export function buildTraceInput(label, value, unit = null, format = null, references = []) {
  if (value == null || value === "") return null;
  return {
    label: label || "Input",
    value: formatTraceValue(value, format, unit),
    unit: unit || null,
    references: normalizeTraceReferences(references),
  };
}

export function normalizeTraceEntries(entries, fallbackLabel = "Step") {
  return asArray(entries)
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === "string") {
        return buildTraceEntry(fallbackLabel, entry);
      }
      const expression = entry.expression ?? entry.formula ?? entry.value ?? entry.note ?? "";
      if (!expression) return null;
      return {
        label: entry.label || fallbackLabel,
        expression: String(expression),
        result: entry.result ?? null,
        note: entry.note ?? null,
        references: normalizeTraceReferences(entry.references || entry.sources),
      };
    })
    .filter((entry) => entry?.expression);
}

export function normalizeTraceInputs(inputs) {
  return asArray(inputs)
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === "string") {
        return buildTraceInput("Input", entry);
      }
      const value = entry.value ?? entry.expression ?? entry.note ?? "";
      if (value == null || value === "") return null;
      return {
        label: entry.label || "Input",
        value: formatTraceValue(value, entry.format, entry.unit),
        unit: entry.unit || null,
        references: normalizeTraceReferences(entry.references || entry.sources),
      };
    })
    .filter((entry) => entry?.value);
}

export function normalizeTraceNotes(notes) {
  return dedupeBy(
    asArray(notes).filter(Boolean).map((entry) => String(entry)),
    (entry) => entry,
  );
}

function mergeEngine(defaultEngine = {}, rawEngine = {}) {
  const merged = { ...defaultEngine };
  for (const [key, value] of Object.entries(rawEngine || {})) {
    if (value == null || value === "") {
      if (!(key in merged)) merged[key] = value;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function isLegacyPricingEntry(entry) {
  const label = String(entry?.label || "").trim().toLowerCase();
  return label === "charge total"
    || label === "cost total"
    || label === "aggregated charge"
    || label === "aggregated cost";
}

function normalizeTraceComponent(component) {
  const normalized = normalizeStructuredTrace(component);
  return {
    ...(normalized.title ? { title: normalized.title } : {}),
    ...(normalized.context && typeof normalized.context === "object" ? { context: normalized.context } : {}),
    quantityDerivation: normalized.quantityDerivation,
    pricingDerivation: normalized.pricingDerivation,
    inputs: normalized.inputs,
    references: normalized.references,
    notes: normalized.notes,
    formulas: normalized.formulas,
  };
}

export function normalizeStructuredTrace(rawTrace, {
  defaultEngine = {},
  fallbackQuantityDerivation = [],
  fallbackPricingDerivation = [],
  fallbackInputs = [],
  fallbackReferences = [],
  fallbackNotes = [],
} = {}) {
  const trace = rawTrace && typeof rawTrace === "object" ? rawTrace : {};
  const legacyEntries = normalizeTraceEntries(trace.formulas, "Formula");
  const quantityDerivation = dedupeBy([
    ...normalizeTraceEntries(trace.quantityDerivation, "Step"),
    ...(trace.quantityDerivation ? [] : legacyEntries.filter((entry) => !isLegacyPricingEntry(entry))),
    ...normalizeTraceEntries(fallbackQuantityDerivation, "Step"),
  ], entryKey);
  const pricingDerivation = dedupeBy([
    ...normalizeTraceEntries(trace.pricingDerivation, "Step"),
    ...(trace.pricingDerivation ? [] : legacyEntries.filter((entry) => isLegacyPricingEntry(entry))),
    ...normalizeTraceEntries(fallbackPricingDerivation, "Step"),
  ], entryKey);
  const inputs = dedupeBy([
    ...normalizeTraceInputs(trace.inputs || trace.consumedInputs),
    ...normalizeTraceInputs(fallbackInputs),
  ], (entry) => `${entry.label}::${entry.value}`);
  const notes = normalizeTraceNotes([
    ...normalizeTraceNotes(trace.notes),
    ...normalizeTraceNotes(fallbackNotes),
  ]);
  const components = asArray(trace.components).map(normalizeTraceComponent);
  const references = dedupeBy([
    ...normalizeTraceReferences(trace.references),
    ...normalizeTraceReferences(fallbackReferences),
    ...quantityDerivation.flatMap((entry) => normalizeTraceReferences(entry.references)),
    ...pricingDerivation.flatMap((entry) => normalizeTraceReferences(entry.references)),
    ...inputs.flatMap((entry) => normalizeTraceReferences(entry.references)),
    ...components.flatMap((component) => component.references || []),
  ], referenceKey);

  return {
    ...(trace.title ? { title: trace.title } : {}),
    ...(trace.context && typeof trace.context === "object" ? { context: trace.context } : {}),
    engine: mergeEngine(defaultEngine, trace.engine || {}),
    quantityDerivation,
    pricingDerivation,
    inputs,
    references,
    notes,
    components,
    formulas: dedupeBy([
      ...quantityDerivation,
      ...pricingDerivation,
    ], entryKey),
  };
}

export function buildStructuredTrace({
  title = null,
  context = null,
  engine = {},
  quantityDerivation = [],
  pricingDerivation = [],
  inputs = [],
  references = [],
  notes = [],
  components = [],
  formulas = [],
} = {}) {
  return normalizeStructuredTrace({
    ...(title ? { title } : {}),
    ...(context && typeof context === "object" ? { context } : {}),
    engine,
    quantityDerivation,
    pricingDerivation,
    inputs,
    references,
    notes,
    components,
    formulas,
  });
}
