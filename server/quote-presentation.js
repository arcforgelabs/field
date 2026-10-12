import {
  buildRenderedPresentationScheduleItems,
  calculatePresentationScheduleTotals,
} from "../shared/quote-presentation-renderer.js";
import { resolvePresentationOrganizer } from "./quote-presentation-organizer.js";
import { WALL_RATE_CARD_ITEMS } from "./retaining-wall-items.js";

// Canonical origin check for rendered schedule items. New renderer output
// carries `origin` directly; persisted legacy data may only have the legacy
// `sourceKind` field.
function isGeneratedComponentItem(item) {
  if (item?.origin === "generated") return true;
  return item?.sourceKind === "generated_component";
}

const SMALL_SIZE_LIMITS = {
  siteDays: 2,
  personDays: 4,
};

const MEDIUM_SIZE_LIMITS = {
  siteDays: 5,
  personDays: 12,
};

const ZONE_PATTERNS = [
  /\byard\b/i,
  /\bfront\b/i,
  /\bback\b/i,
  /\bside\b/i,
  /\bsite\b/i,
  /\bfull site\b/i,
];

export function buildQuotePresentation({
  quoteInputs = null,
  lineItems = [],
  execution = null,
  internalPricing = null,
  overrides = null,
  defaultScopeText = null,
  preferDefaultScopeText = false,
}) {
  const sourceItems = buildBaseCustomerScheduleItems({
    lineItems,
    internalPricing,
  });
  const recommendation = recommendTemplate(sourceItems);
  const organizer = resolvePresentationOrganizer({
    sourceItems,
    organizer: overrides?.presentation?.organizer || null,
  });
  const renderedScheduleItems = buildRenderedPresentationScheduleItems({
    organizer,
    sourceItems,
  });
  const visibleSourceItems = renderedScheduleItems.filter((item) => (
    item.kind === "source" && !isGeneratedComponentItem(item)
  ));
  const sections = buildSections(renderedScheduleItems, recommendation.template);
  const scopeOfWorks = buildScopeOfWorks(visibleSourceItems);
  const derivedScopeText = scopeOfWorks.length ? scopeOfWorks.join("\n") : null;
  const scopeText = normalizeMultilineText(
    overrides?.presentation?.scopeText
      ?? (preferDefaultScopeText
        ? (defaultScopeText ?? derivedScopeText)
        : (derivedScopeText ?? defaultScopeText))
      ?? null
  ) || null;

  const validityDays = typeof overrides?.presentation?.validityDays === "number" && overrides.presentation.validityDays > 0
    ? overrides.presentation.validityDays
    : null;

  return {
    template: recommendation.template,
    recommendationReason: recommendation.reason,
    sections,
    organizer,
    sourceItems,
    scheduleItems: renderedScheduleItems,
    scopeOfWorks,
    scopeText,
    ...(validityDays ? { validityDays } : {}),
    classification: classifyQuote({
      execution,
      customerItems: sourceItems,
      quoteInputs,
    }),
  };
}

export function applyPresentationToQuote({
  quote,
  quoteInputs = null,
  overrides = null,
  defaultScopeText = null,
  preferDefaultScopeText = false,
}) {
  if (!quote || typeof quote !== "object") return quote;
  const presentation = buildQuotePresentation({
    quoteInputs,
    lineItems: quote.lineItems || [],
    execution: quote.execution || null,
    internalPricing: quote.internalPricing || null,
    overrides,
    defaultScopeText: defaultScopeText ?? quote.summary ?? null,
    preferDefaultScopeText,
  });
  return {
    ...quote,
    presentation,
    summary: presentation.scopeText || quote.summary || null,
  };
}

export function getCustomerScheduleItems(quote) {
  return getCustomerScheduleView(quote).items;
}

/**
 * The customer-facing schedule rows and the resolved organizer they came
 * from (null for a quote with neither). `includeCollapsedChildren` also
 * lists the rows under collapsed nodes (the quote snapshot records them).
 */
export function getCustomerScheduleView(quote, { includeCollapsedChildren = false } = {}) {
  const hasOrganizer = hasPresentationOrganizer(quote?.presentation?.organizer);
  const sourceItems = deriveCustomerSourceScheduleItems(quote, {
    excludeOrganizerOwnedManualItems: hasOrganizer,
  });
  if (sourceItems.length || hasOrganizer) {
    const organizer = resolvePresentationOrganizer({
      sourceItems,
      organizer: quote?.presentation?.organizer || null,
    });
    const renderedItems = buildRenderedPresentationScheduleItems({
      organizer,
      sourceItems,
      includeCollapsedChildren,
    });
    if (renderedItems.length || sourceItems.length) return { organizer, items: renderedItems };
  }
  if (Array.isArray(quote?.presentation?.scheduleItems) && quote.presentation.scheduleItems.length) {
    return { organizer: null, items: quote.presentation.scheduleItems };
  }
  return { organizer: null, items: [] };
}

export function getCustomerFacingTotal(quote) {
  const financials = getCustomerPresentationFinancials(quote);
  return financials.total;
}

export function getCustomerPresentationFinancials(quote) {
  const hasOrganizer = hasPresentationOrganizer(quote?.presentation?.organizer);
  const sourceItems = deriveCustomerSourceScheduleItems(quote, {
    excludeOrganizerOwnedManualItems: hasOrganizer,
  });
  const organizer = sourceItems.length || hasOrganizer
    ? resolvePresentationOrganizer({
        sourceItems,
        organizer: quote?.presentation?.organizer || null,
      })
    : null;
  const gstRate = Number(quote?.quoteCatalog?.gstRate || 0.1);
  const pricing = calculatePresentationScheduleTotals({
    organizer,
    sourceItems,
  });
  const subtotal = roundMoney(pricing.charge);
  const gst = Math.round(subtotal * gstRate * 100) / 100;
  return {
    charge: subtotal,
    cost: roundMoney(pricing.cost),
    subtotal,
    gst,
    total: Math.round((subtotal + gst) * 100) / 100,
  };
}

export function getCustomerSourceScheduleItems(quote) {
  const sourceItems = deriveCustomerSourceScheduleItems(quote);
  if (sourceItems.length) {
    return sourceItems;
  }
  if (Array.isArray(quote?.presentation?.sourceItems) && quote.presentation.sourceItems.length) {
    return quote.presentation.sourceItems;
  }
  if (Array.isArray(quote?.presentation?.scheduleItems) && quote.presentation.scheduleItems.length) {
    return quote.presentation.scheduleItems.filter((item) => (
      item?.kind === "source" && !isGeneratedComponentItem(item)
    ));
  }
  return [];
}

function hasPresentationOrganizer(organizer) {
  return !!organizer
    && typeof organizer === "object"
    && !Array.isArray(organizer)
    && organizer.nodes
    && typeof organizer.nodes === "object"
    && !Array.isArray(organizer.nodes);
}

function isManualPresentationItem(item) {
  if (item?.origin === "manual") return true;
  return item?.sourceKind === "manual";
}

function deriveCustomerSourceScheduleItems(quote, {
  excludeOrganizerOwnedManualItems = false,
} = {}) {
  const keepSourceItem = (item) => (
    !isGeneratedComponentItem(item)
    && (!excludeOrganizerOwnedManualItems || !isManualPresentationItem(item))
  );

  if (Array.isArray(quote?.lineItems) && quote.lineItems.length) {
    return buildBaseCustomerScheduleItems({
      lineItems: quote.lineItems,
      internalPricing: quote?.internalPricing || null,
    });
  }
  if (Array.isArray(quote?.presentation?.sourceItems) && quote.presentation.sourceItems.length) {
    return quote.presentation.sourceItems.filter((item) => (
      item?.kind !== "component"
      && item?.kind !== "group"
      && keepSourceItem(item)
    ));
  }
  if (Array.isArray(quote?.presentation?.scheduleItems) && quote.presentation.scheduleItems.length) {
    return quote.presentation.scheduleItems.filter((item) => (
      (item?.kind === "source" || !item?.kind)
      && keepSourceItem(item)
    ));
  }
  return [];
}

function buildBaseCustomerScheduleItems({
  lineItems = [],
  internalPricing = null,
}) {
  const customerItems = (lineItems || [])
    .filter((item) => item?.code)
    .map((item) => ({
      code: item.code,
      label: item.customerLabel || item.label,
      quantity: 1,
      unit: "lot",
      unitPrice: item.totalPrice,
      totalPrice: item.totalPrice,
      unitCost: item.unitCost ?? item.totalCost ?? null,
      totalCost: item.totalCost ?? null,
      section: item.section || null,
      workDomain: item.workDomain || null,
      scopeSummary: item.scopeSummary || item.customerLabel || item.label,
      sourceLineItemCodes: [item.code],
      componentLineItemCodes: [item.code],
      allocatedLineItemCodes: [],
      amountVisible: item.customerVisible !== false,
    }));
  return attachScheduleItemDetails(customerItems, lineItems, internalPricing);
}

function attachScheduleItemDetails(items, lineItems, internalPricing) {
  const itemIndex = new Map((lineItems || [])
    .filter((item) => item?.code)
    .map((item) => [item.code, item]));
  const breakdownIndex = new Map(
    (internalPricing?.lineItemBreakdowns || [])
      .filter((breakdown) => breakdown?.sourceLineItemCode)
      .map((breakdown) => [String(breakdown.sourceLineItemCode), breakdown])
  );

  return (items || []).map((item) => {
    const groupedComponents = buildCustomerPresentationComponents({
      item,
      breakdown: breakdownIndex.get(String(item.code || "")),
    });
    if (groupedComponents.length) {
      return {
        ...item,
        components: groupedComponents,
      };
    }

    const directCodes = dedupe(item.componentLineItemCodes?.length ? item.componentLineItemCodes : item.sourceLineItemCodes || []);
    const allocatedCodes = dedupe(item.allocatedLineItemCodes || []).filter((code) => !directCodes.includes(code));
    const components = [...directCodes, ...allocatedCodes]
      .map((code) => buildScheduleItemComponent({
        lineItem: itemIndex.get(code),
        kind: allocatedCodes.includes(code) ? "allocated_support" : "direct",
      }))
      .filter(Boolean);

    return {
      ...item,
      components,
    };
  });
}

function buildCustomerPresentationComponents({
  item,
  breakdown,
}) {
  const recipe = String(breakdown?.recipe || "");
  if (!/^retaining_wall_|^rock_wall_/.test(recipe)) {
    return [];
  }

  const grouped = groupCommercialLinesForCustomer(breakdown)
    .filter((group) => roundMoney(group.totalPrice) > 0)
    .filter((group) => !isTrivialGroupedComponent({ item, group }));
  if (grouped.length < 2) {
    return [];
  }

  return grouped.map((group) => ({
    code: group.code,
    label: group.label,
    quantity: 1,
    unit: "lot",
    unitPrice: group.totalPrice,
    totalPrice: group.totalPrice,
    unitCost: group.totalCost,
    totalCost: group.totalCost,
    kind: "direct",
    customerFacing: true,
    explanation: null,
    workDomain: item?.workDomain || null,
    scopeSummary: group.label,
    supportEntries: [],
  }));
}

function isTrivialGroupedComponent({
  item,
  group,
}) {
  if (!item || !group) return false;
  return normalizeText(group.label).toLowerCase() === normalizeText(item.label).toLowerCase()
    && roundMoney(group.totalPrice) === roundMoney(item.totalPrice);
}

function groupCommercialLinesForCustomer(breakdown) {
  const groups = new Map();
  const sourceLineItemCode = String(breakdown?.sourceLineItemCode || "line-item");

  for (const commercialLine of breakdown?.commercialLines || []) {
    const descriptor = resolveCustomerDetailDescriptor({ breakdown, commercialLine });
    const stableCode = `${sourceLineItemCode}::detail::${slugify(
      descriptor.groupKey || descriptor.label || commercialLine?.itemCode || commercialLine?.code || "detail"
    )}`;
    const existing = groups.get(stableCode);
    if (existing) {
      existing.totalPrice = roundMoney(existing.totalPrice + Number(commercialLine?.totalPrice || 0));
      existing.totalCost = roundMoney(existing.totalCost + Number(commercialLine?.totalCost || 0));
      existing.sourceCommercialLineCodes = dedupe([
        ...existing.sourceCommercialLineCodes,
        commercialLine?.code,
      ]);
      continue;
    }

    groups.set(stableCode, {
      code: stableCode,
      label: descriptor.label,
      groupKey: descriptor.groupKey,
      totalPrice: roundMoney(Number(commercialLine?.totalPrice || 0)),
      totalCost: roundMoney(Number(commercialLine?.totalCost || 0)),
      order: descriptor.order,
      sourceCommercialLineCodes: commercialLine?.code ? [commercialLine.code] : [],
    });
  }

  return [...groups.values()].sort((left, right) => (
    left.order - right.order
    || left.label.localeCompare(right.label)
  ));
}

function resolveCustomerDetailDescriptor({
  breakdown,
  commercialLine,
}) {
  const itemCode = String(commercialLine?.itemCode || "");
  const recipe = String(breakdown?.recipe || "");
  const description = String(commercialLine?.description || commercialLine?.label || itemCode);

  if (/^retaining_wall_|^rock_wall_/.test(recipe)) {
    if (itemCode === WALL_RATE_CARD_ITEMS.sleeper) {
      return { groupKey: "sleepers", label: "Concrete sleepers", order: 10 };
    }
    if (/^STEEL-(?:IBEAM|CCHANNEL)-/.test(itemCode) || /^STEEL-(?:IBEAM|CCHANNEL)$/.test(itemCode)) {
      return { groupKey: "steel", label: "Steel posts & channels", order: 20 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.concreteBag) {
      return { groupKey: "concrete", label: "Concrete & footings", order: 30 };
    }
    if ([WALL_RATE_CARD_ITEMS.agpipe, WALL_RATE_CARD_ITEMS.fortacon, WALL_RATE_CARD_ITEMS.gravel].includes(itemCode)) {
      return { groupKey: "drainage", label: "Drainage & backing", order: 40 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.bluestoneLarge || itemCode === WALL_RATE_CARD_ITEMS.bluestoneSmall) {
      return recipe === "rock_wall_estimate"
        ? { groupKey: "rock-supply", label: "Rock supply", order: 10 }
        : { groupKey: "stairs-rock", label: "Stairs & rock supply", order: 10 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.excavator) {
      return /^retaining_wall_ancillary$/.test(recipe)
        ? { groupKey: "earthworks", label: "Earthworks & machinery", order: 50 }
        : { groupKey: "excavation", label: "Excavation", order: 50 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.kanga) {
      return { groupKey: "rock-handling", label: "Rock handling", order: 55 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.labourer) {
      return { groupKey: "labour", label: "Labour", order: 60 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.welder) {
      return { groupKey: "welding", label: "Welding", order: 70 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.vehicleHour) {
      return { groupKey: "delivery", label: "Delivery & transport", order: 80 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.siteAllowance) {
      return { groupKey: "site-preliminaries", label: "Site preliminaries", order: 90 };
    }
    if (itemCode === WALL_RATE_CARD_ITEMS.adminFee) {
      return { groupKey: "admin", label: "Administration", order: 100 };
    }
    if (itemCode === "FIELD-ADJUSTMENT") {
      if (/rabbit/i.test(description)) {
        return { groupKey: "rabbit-proofing", label: "Rabbit proofing", order: 65 };
      }
      if (/fuel|delivery/i.test(description)) {
        return { groupKey: "delivery-fuel", label: "Delivery & fuel", order: 85 };
      }
      return { groupKey: "allowances", label: "Allowances", order: 95 };
    }
  }

  const category = normalizeText(commercialLine?.category || "");
  if (category === "materials") {
    return { groupKey: itemCode || "materials", label: commercialLine?.label || "Materials", order: 10 };
  }
  if (category === "machines") {
    return { groupKey: itemCode || "machines", label: commercialLine?.label || "Machinery", order: 20 };
  }
  if (category === "labour") {
    return { groupKey: itemCode || "labour", label: commercialLine?.label || "Labour", order: 30 };
  }
  if (category === "overhead") {
    return { groupKey: itemCode || "overhead", label: commercialLine?.label || "Overheads", order: 40 };
  }

  return {
    groupKey: itemCode || slugify(description),
    label: commercialLine?.label || description || "Quoted item",
    order: 50,
  };
}

function buildScheduleItemComponent({ lineItem, kind }) {
  if (!lineItem?.code) return null;
  return {
    code: lineItem.code,
    label: lineItem.label,
    quantity: Number(lineItem.quantity || 0),
    unit: lineItem.unit || "lot",
    unitPrice: Number(lineItem.unitPrice || 0),
    totalPrice: Number(lineItem.totalPrice || 0),
    unitCost: lineItem.unitCost ?? null,
    totalCost: lineItem.totalCost ?? null,
    kind,
    customerFacing: false,
    explanation: lineItem.rationale || null,
    workDomain: lineItem.workDomain || null,
    scopeSummary: lineItem.scopeSummary || null,
    supportEntries: buildComponentSupportEntries(lineItem),
  };
}

function buildComponentSupportEntries(lineItem) {
  const refs = {
    A: 0,
    C: 0,
    H: 0,
    M: 0,
  };
  const entries = [];

  for (const evidence of lineItem.evidence || []) {
    const ref = nextSupportRef(refs, "A");
    const titleBits = ["Transcript evidence"];
    if (evidence.segmentId) titleBits.push(evidence.segmentId);
    entries.push({
      id: `${lineItem.code}::${ref}`,
      ref,
      kind: "audio",
      label: "Audio",
      title: titleBits.join(" · "),
      summary: evidence.text || evidence.snippet || null,
      audio: {
        text: evidence.text || null,
        snippet: evidence.snippet || null,
        start: evidence.start ?? null,
        end: evidence.end ?? null,
        speaker: evidence.speaker || null,
      },
      meta: buildAudioMeta(evidence),
    });
  }

  for (const provenance of lineItem.provenance || []) {
    if (provenance.sourceType === "audio") continue;
    const prefix = provenance.sourceType === "measurement" ? "M" : "H";
    const ref = nextSupportRef(refs, prefix);
    entries.push({
      id: `${lineItem.code}::${ref}`,
      ref,
      kind: provenance.sourceType === "measurement" ? "measurement" : "activity",
      label: formatSupportLabelFromProvenance(provenance.sourceType),
      title: formatSupportTitleFromProvenance(provenance),
      summary: provenance.summary || null,
      sourceType: provenance.sourceType || null,
      actor: provenance.actor || null,
      createdAt: provenance.createdAt || null,
      meta: buildProvenanceMeta(provenance),
    });
  }

  if (lineItem.quoteCatalogEntry?.code || lineItem.quoteCatalogEntry?.label) {
    const ref = nextSupportRef(refs, "C");
    entries.push({
      id: `${lineItem.code}::${ref}`,
      ref,
      kind: "commercial",
      label: "Commercial",
      title: "Quote catalog reference",
      summary: [lineItem.quoteCatalogEntry.label, lineItem.quoteCatalogEntry.code].filter(Boolean).join(" · ") || null,
      reference: {
        code: lineItem.quoteCatalogEntry.code || null,
        label: lineItem.quoteCatalogEntry.label || null,
        url: null,
        quoteCatalogId: lineItem.quoteCatalogEntry.quoteCatalogId || null,
        appPath: lineItem.quoteCatalogEntry.quoteCatalogId && lineItem.quoteCatalogEntry.code
          ? `/pricing?quoteCatalogId=${encodeURIComponent(lineItem.quoteCatalogEntry.quoteCatalogId)}&itemCode=${encodeURIComponent(lineItem.quoteCatalogEntry.code)}`
          : null,
      },
      meta: buildCommercialMeta(lineItem.quoteCatalogEntry),
    });
  }

  return entries;
}

function nextSupportRef(counters, prefix) {
  counters[prefix] = (counters[prefix] || 0) + 1;
  return `${prefix}${counters[prefix]}`;
}

function formatSupportLabelFromProvenance(sourceType) {
  if (sourceType === "measurement") return "Measurement";
  if (sourceType === "manual") return "Manual";
  if (sourceType === "note") return "Note";
  if (sourceType === "chat") return "Chat";
  if (sourceType === "ai-generated") return "AI";
  return "Activity";
}

function formatSupportTitleFromProvenance(provenance) {
  const label = formatSupportLabelFromProvenance(provenance.sourceType);
  const actor = provenance.actor?.label ? ` · ${provenance.actor.label}` : "";
  return `${label}${actor}`;
}

function buildAudioMeta(evidence) {
  return [
    evidence.speaker ? { label: "Speaker", value: evidence.speaker } : null,
    typeof evidence.start === "number" || typeof evidence.end === "number"
      ? { label: "Clip", value: `${formatTime(evidence.start)} - ${formatTime(evidence.end)}` }
      : null,
  ].filter(Boolean);
}

function buildProvenanceMeta(provenance) {
  return [
    provenance.actor?.label ? { label: "Actor", value: provenance.actor.label } : null,
    provenance.createdAt ? { label: "Created", value: formatDisplayDate(provenance.createdAt) } : null,
  ].filter(Boolean);
}

function buildCommercialMeta(entry) {
  return [
    entry?.code ? { label: "Code", value: entry.code } : null,
    entry?.label ? { label: "Item", value: entry.label } : null,
  ].filter(Boolean);
}

function recommendTemplate(items) {
  const sectionLabels = dedupe(
    items.map((item) => normalizeText(item.section)).filter(Boolean)
  );

  if (!sectionLabels.length) {
    return {
      template: "simple_list",
      reason: "No stable customer-facing sections were extracted from the current scope.",
    };
  }

  if (sectionLabels.some((label) => ZONE_PATTERNS.some((pattern) => pattern.test(label)))) {
    return {
      template: "zone_first",
      reason: "Zone-style section labels were extracted from the quoted scope.",
    };
  }

  return {
    template: "system_first",
    reason: "The quoted scope is grouped more cleanly by work system than by site zone.",
  };
}

function buildSections(items, template) {
  if (template === "simple_list") {
    return [{
      label: null,
      items: items.map((item) => ({ ...item, section: null })),
    }];
  }

  const sections = [];
  const seen = new Map();
  for (const item of items) {
    const key = normalizeText(item.section) || "__ungrouped__";
    if (!seen.has(key)) {
      const section = {
        label: item.section || null,
        items: [],
      };
      seen.set(key, section);
      sections.push(section);
    }
    seen.get(key).items.push(item);
  }

  return sections;
}

function buildScopeOfWorks(items) {
  return dedupe(
    items.map((item) => {
      const text = String(item.scopeSummary || item.label || "").trim();
      if (!text) return null;
      const section = String(item.section || "").trim();
      if (section && !text.toLowerCase().startsWith(section.toLowerCase())) {
        return `• ${section} — ${text}`;
      }
      return `• ${text}`;
    })
  );
}

function classifyQuote({ execution, customerItems, quoteInputs }) {
  const workingDayHours = Number(execution?.workingDayHours || 8);
  const directLabourHours = Array.isArray(execution?.stages)
    ? execution.stages
      .filter((stage) => stage.code !== "overhead")
      .reduce((sum, stage) => sum + Number(stage.labourHours || 0), 0)
    : Number(execution?.totals?.labourHours || 0);
  const siteDays = Number(
    execution?.totals?.siteDays
    || Math.ceil(Number(execution?.totals?.durationHours || 0) / workingDayHours)
    || 0
  );
  const personDays = workingDayHours > 0
    ? roundToOneDecimal(directLabourHours / workingDayHours)
    : 0;
  const workDomainCount = new Set(customerItems.map((item) => item.workDomain).filter(Boolean)).size;
  const sectionCount = new Set(customerItems.map((item) => normalizeText(item.section)).filter(Boolean)).size;
  const assumptionCount = Number(quoteInputs?.assumptions?.length || 0);
  const missingInputCount = Number(quoteInputs?.missingInputs?.length || 0);

  let executionSize = "small";
  if (siteDays > MEDIUM_SIZE_LIMITS.siteDays || personDays > MEDIUM_SIZE_LIMITS.personDays) {
    executionSize = "large";
  } else if (siteDays > SMALL_SIZE_LIMITS.siteDays || personDays > SMALL_SIZE_LIMITS.personDays) {
    executionSize = "medium";
  }

  const complexityScore = [
    workDomainCount >= 3,
    sectionCount >= 3,
    assumptionCount + missingInputCount >= 3,
  ].filter(Boolean).length;

  const executionComplexity = complexityScore >= 3
    ? "high"
    : complexityScore >= 1
      ? "medium"
      : "low";

  return {
    executionSize,
    executionComplexity,
    siteDays,
    personDays,
    workDomainCount,
    sectionCount,
  };
}

function dedupe(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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

function roundToOneDecimal(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function sum(values) {
  return (values || []).reduce((total, value) => total + Number(value || 0), 0);
}

function resolveSingleValue(values) {
  const normalized = dedupe(values);
  return normalized.length === 1 ? normalized[0] : null;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function formatTime(value) {
  if (!Number.isFinite(Number(value))) return "00:00";
  const totalSeconds = Math.max(0, Math.floor(Number(value)));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDisplayDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
