import { readdirSync, readFileSync } from "./storage/fs.js";
import { join } from "node:path";
import JSON5 from "json5";
import {
  buildPriceCatalogAuthoritySnapshot,
} from "./price-catalog/catalog-pricing.js";
import {
  DEFAULT_QUOTE_CATALOG_ID,
  resolveQuoteCatalogId,
} from "./quote-catalog-ids.js";
import { loadAssemblies } from "./catalog/assemblies.js";
import {
  applyBusinessProfileOverride,
  configuredTradingName,
  hasBusinessProfileOverride,
  setBusinessProfileOverride,
} from "./business-profile.js";
import { assertAssemblyModeContract } from "./assembly-modes.js";
import { CATALOG_UNIT_DEFINITIONS, normalizeCatalogUnit } from "../shared/catalog-units.js";

const QUOTE_CATALOG_ROOT = join(import.meta.dirname, "../quote-catalogs");
const LEGACY_QUOTE_CATALOG_RULE_ALIASES = Object.freeze({
  "excavator-operator": "excavator-hour",
  "ground-labour": "labourer-hour",
  "ground-labor": "labourer-hour",
});

export { DEFAULT_QUOTE_CATALOG_ID };

// The dimension each quantitySource measures, so a rule cannot say "area"
// and count in metres.
const QUANTITY_SOURCE_DIMENSIONS = Object.freeze({
  area: "area",
  volume: "volume",
  length: "length",
  count: "count",
  hoursOrDays: "time",
});

const LOCAL_QUOTE_CATALOGS = loadQuoteCatalogs();
let QUOTE_CATALOGS = cloneQuoteCatalogs(LOCAL_QUOTE_CATALOGS);
let COMMERCIAL_AUTHORITY_STATUS = {
  provider: "catalog",
  mode: "disabled",
  refreshedAt: new Date().toISOString(),
};

/**
 * Sets this installation's configured business profile (config
 * `businessProfile`, server/business-profile.js) and re-applies it to every
 * quote catalogue, so quote builds and new quote snapshots carry it. The next
 * authority refresh re-projects the price catalogue over the updated base.
 */
export function configureBusinessProfile(raw) {
  const configured = setBusinessProfileOverride(raw);
  QUOTE_CATALOGS = cloneQuoteCatalogs(LOCAL_QUOTE_CATALOGS);
  if (COMMERCIAL_AUTHORITY_STATUS?.catalogEtag) {
    COMMERCIAL_AUTHORITY_STATUS = { ...COMMERCIAL_AUTHORITY_STATUS, catalogEtag: null };
  }
  return configured;
}

export function listQuoteCatalogs() {
  return Object.values(QUOTE_CATALOGS).map((quoteCatalog) => ({
    id: quoteCatalog.id,
    name: quoteCatalog.name,
    label: quoteCatalog.name,
    sourceNote: quoteCatalog.sourceNote,
    status: quoteCatalog.status || "active",
    provider: quoteCatalog.commercialAuthority?.provider || "catalog",
    url: `/api/quote-catalogs/${quoteCatalog.id}`,
    referenceUrl: `/api/quote-catalogs/${quoteCatalog.id}/reference`,
  }));
}

export function hasQuoteCatalog(quoteCatalogId) {
  return Boolean(QUOTE_CATALOGS[resolveQuoteCatalogId(quoteCatalogId)]);
}

export function getQuoteCatalog(quoteCatalogId = DEFAULT_QUOTE_CATALOG_ID) {
  return QUOTE_CATALOGS[resolveQuoteCatalogId(quoteCatalogId)] || QUOTE_CATALOGS[DEFAULT_QUOTE_CATALOG_ID] || null;
}

/**
 * Return an isolated local catalog base for a command-scoped authority
 * snapshot.  Quote builds must never mutate the process-wide overlay while a
 * concurrent build is reading it.
 */
export function getQuoteCatalogsForAuthoritySnapshot() {
  return cloneQuoteCatalogs(LOCAL_QUOTE_CATALOGS);
}

export function serializeQuoteCatalog(quoteCatalogOrId = DEFAULT_QUOTE_CATALOG_ID) {
  const quoteCatalog = typeof quoteCatalogOrId === "string"
    ? getQuoteCatalog(quoteCatalogOrId)
    : quoteCatalogOrId;

  if (!quoteCatalog) return null;
  const authorityProvider = quoteCatalog.commercialAuthority?.provider || COMMERCIAL_AUTHORITY_STATUS.provider || "catalog";

  return {
    id: quoteCatalog.id,
    name: quoteCatalog.name,
    label: quoteCatalog.name,
    status: quoteCatalog.status || "active",
    currency: quoteCatalog.currency,
    gstRate: quoteCatalog.gstRate,
    hoursPerDay: quoteCatalog.hoursPerDay,
    businessProfile: quoteCatalog.businessProfile ? { ...(quoteCatalog.businessProfile || {}) } : null,
    executionProfile: {
      ...(quoteCatalog.executionProfile || {}),
    },
    sourceNote: quoteCatalog.sourceNote,
    quantityRules: (quoteCatalog.quantityRules || []).map((rule) => ({ ...rule })),
    sourceFile: `apps/field/quote-catalogs/${quoteCatalog.id}.json5`,
    url: `/api/quote-catalogs/${quoteCatalog.id}`,
    referenceUrl: `/api/quote-catalogs/${quoteCatalog.id}/reference`,
    commercialAuthority: quoteCatalog.commercialAuthority ? { ...quoteCatalog.commercialAuthority } : null,
    deliveryDefaults: { ...(quoteCatalog.deliveryDefaults || {}) },
    missingInputDefaults: Object.entries(quoteCatalog.missingInputDefaults || {}).map(([field, spec]) => ({
      field,
      inputType: spec.inputType || "text",
      defaultValue: spec.defaultValue || "",
      quoteNote: spec.quoteNote || "",
      affectsPricing: Boolean(spec.affectsPricing),
      alternatives: Array.isArray(spec.alternatives)
        ? spec.alternatives.map((alt) => ({ value: alt.value, label: alt.label }))
        : [],
    })),
    lineItems: quoteCatalog.rules.map((rule) => ({
      code: rule.code,
      label: rule.label,
      unit: rule.unit,
      quantityUnit: rule.quantityUnit || rule.unit,
      unitPrice: resolveRuleSellRate({ rule, authorityProvider }),
      sellRate: resolveRuleSellRate({ rule, authorityProvider }),
      buyingRate: resolveRuleBuyingRate(rule),
      defaultQuantity: rule.defaultQuantity || 1,
      authorityItemCode: resolveRuleAuthorityItemCode(rule),
      pricingStatus: resolveRulePricingStatus({ rule, authorityProvider }),
      pricingIssues: buildRulePricingIssues({ rule, authorityProvider }),
      quoteable: isRuleQuoteable({ rule, authorityProvider }),
      workDomain: rule.workDomain || null,
      quantitySource: rule.quantitySource || null,
      requiredInputs: [...(rule.requiredInputs || [])],
      pricingDependencies: [...(rule.pricingDependencies || [])],
      useWhen: rule.useWhen || null,
      keywords: [...(rule.keywords || [])],
      execution: rule.execution ? { ...rule.execution } : null,
      presentation: rule.presentation ? { ...rule.presentation } : null,
      fallback: Boolean(rule.isFallback),
    })),
  };
}

export async function readQuoteCatalogReference(quoteCatalogId = DEFAULT_QUOTE_CATALOG_ID) {
  const quoteCatalog = serializeQuoteCatalog(quoteCatalogId);
  if (!quoteCatalog) return null;

  return {
    id: quoteCatalog.id,
    title: `${quoteCatalog.name} Quote Catalog`,
    url: `/api/quote-catalogs/${quoteCatalog.id}/reference`,
    body: renderQuoteCatalogReferenceMarkdown(quoteCatalog),
  };
}

export function updateQuoteCatalogItem(quoteCatalogId, code, patch) {
  const error = new Error(
    `Local price edits are disabled. Update ${code} in the active commercial authority and refresh the Field catalog instead.`
  );
  error.statusCode = 410;
  throw error;
}

export function addQuoteCatalogAlternative(quoteCatalogId, field, alternative) {
  const resolvedQuoteCatalogId = resolveQuoteCatalogId(quoteCatalogId);
  const quoteCatalog = QUOTE_CATALOGS[resolvedQuoteCatalogId];
  if (!quoteCatalog) throw new Error(`Quote catalog ${quoteCatalogId} not found`);
  const normalizedField = field.trim().toLowerCase();
  const entry = Object.entries(quoteCatalog.missingInputDefaults || {}).find(
    ([key]) => key.trim().toLowerCase() === normalizedField
  );
  if (!entry) throw new Error(`Missing input field "${field}" not found in quote catalog ${quoteCatalogId}`);
  const spec = entry[1];
  if (!Array.isArray(spec.alternatives)) spec.alternatives = [];
  if (spec.alternatives.some((alt) => alt.value === alternative.value)) {
    throw new Error(`Alternative with this value already exists for "${field}"`);
  }
  spec.alternatives.push({ value: alternative.value, label: alternative.label });
  return spec.alternatives;
}

export function addQuoteCatalogItem(quoteCatalogId, item) {
  const error = new Error(
    `Local catalog writes are disabled. Create the item in the active commercial authority first, then add only the metadata mapping in apps/field/quote-catalogs/${resolveQuoteCatalogId(quoteCatalogId)}.json5 if it is still needed.`
  );
  error.statusCode = 410;
  throw error;
}

/**
 * Re-project the served quote catalogs from the price catalogue
 * (`priceCatalog`: the catalogue store). Cheap when nothing changed: the
 * overlay is rebuilt only when the catalogue version (ETag) moved.
 */
export async function refreshQuoteCatalogAuthority({
  priceCatalog = null,
  required = false,
  force = true,
} = {}) {
  let state = null;
  try {
    state = priceCatalog ? await priceCatalog.getState() : null;
  } catch (err) {
    state = null;
    COMMERCIAL_AUTHORITY_STATUS = {
      provider: "price_catalog",
      mode: "error",
      refreshedAt: new Date().toISOString(),
      error: err.message,
    };
    console.error(`[quote-catalogs] Price catalog read failed: ${err.message}`);
    if (required) {
      const wrapped = new Error(`Fresh price catalog pricing could not be verified: ${err.message}`);
      wrapped.statusCode = 503;
      wrapped.cause = err;
      throw wrapped;
    }
    return COMMERCIAL_AUTHORITY_STATUS;
  }
  if (!force && state && COMMERCIAL_AUTHORITY_STATUS?.catalogEtag === state.etag) {
    return COMMERCIAL_AUTHORITY_STATUS;
  }
  QUOTE_CATALOGS = cloneQuoteCatalogs(LOCAL_QUOTE_CATALOGS);
  COMMERCIAL_AUTHORITY_STATUS = {
    provider: "price_catalog",
    mode: priceCatalog ? "empty" : "unavailable",
    refreshedAt: new Date().toISOString(),
    reason: priceCatalog
      ? "Price catalog has no active items."
      : "Price catalog database is unavailable.",
  };

  if (state) {
    try {
      const itemCount = [...state.items.values()].filter((item) => item.status === "active").length;
      if (itemCount > 0) {
        const authority = buildPriceCatalogAuthoritySnapshot(
          state,
          { quoteCatalogs: getQuoteCatalogsForAuthoritySnapshot() },
        );
        QUOTE_CATALOGS = authority.quoteCatalogs;
        COMMERCIAL_AUTHORITY_STATUS = {
          ...authority.status,
          catalogRevision: authority.catalogRevision,
          snapshotDigest: authority.snapshotDigest,
          catalogVersion: state.version,
          catalogEtag: state.etag,
        };
        return COMMERCIAL_AUTHORITY_STATUS;
      }
    } catch (err) {
      console.error(`[quote-catalogs] Price catalog overlay failed: ${err.message}`);
      COMMERCIAL_AUTHORITY_STATUS = {
        provider: "price_catalog",
        mode: "error",
        refreshedAt: new Date().toISOString(),
        error: err.message,
      };
      if (required) {
        const wrapped = new Error(`Fresh price catalog pricing could not be verified: ${err.message}`);
        wrapped.statusCode = 503;
        wrapped.cause = err;
        throw wrapped;
      }
    }
  }

  if (required) {
    const wrapped = new Error(COMMERCIAL_AUTHORITY_STATUS.reason || "Fresh price catalog pricing could not be verified.");
    wrapped.statusCode = 503;
    throw wrapped;
  }
  return COMMERCIAL_AUTHORITY_STATUS;
}

export function getCommercialAuthorityStatus() {
  return { ...(COMMERCIAL_AUTHORITY_STATUS || {}) };
}

function loadQuoteCatalogs() {
  const entries = readdirSync(QUOTE_CATALOG_ROOT)
    .filter((file) => file.endsWith(".json5"))
    .sort();

  const quoteCatalogs = Object.fromEntries(entries.map((file) => {
    const raw = JSON5.parse(readFileSync(join(QUOTE_CATALOG_ROOT, file), "utf8"));
    const normalized = normalizeQuoteCatalog(raw);
    return [normalized.id, normalized];
  }));

  if (!quoteCatalogs[DEFAULT_QUOTE_CATALOG_ID]) {
    throw new Error(`Default quote catalog ${DEFAULT_QUOTE_CATALOG_ID} is missing from ${QUOTE_CATALOG_ROOT}`);
  }

  return quoteCatalogs;
}

function cloneQuoteCatalogs(quoteCatalogs) {
  return Object.fromEntries(
    Object.entries(quoteCatalogs || {}).map(([id, quoteCatalog]) => [id, withConfiguredBusinessProfile(structuredClone(quoteCatalog))])
  );
}

// The configured business profile over the catalogue's (a no-op when none is
// configured). Its trading name is also the issuer printed on documents.
function withConfiguredBusinessProfile(quoteCatalog) {
  if (!hasBusinessProfileOverride()) return quoteCatalog;
  quoteCatalog.businessProfile = applyBusinessProfileOverride(quoteCatalog.businessProfile || null);
  const tradingName = configuredTradingName();
  if (tradingName) quoteCatalog.deliveryDefaults = { ...(quoteCatalog.deliveryDefaults || {}), issuerName: tradingName };
  return quoteCatalog;
}

function normalizeQuoteCatalog(raw) {
  if (!raw?.id) throw new Error("Quote catalog is missing required field: id");
  if (!raw?.name) throw new Error(`Quote catalog ${raw.id} is missing required field: name`);
  if (!Array.isArray(raw?.rules) || raw.rules.length === 0) {
    throw new Error(`Quote catalog ${raw.id} must define at least one rule`);
  }

  return {
    id: raw.id,
    name: raw.name,
    status: raw.status || "active",
    currency: raw.currency || "AUD",
    gstRate: Number(raw.gstRate ?? 0.1),
    hoursPerDay: Number(raw.hoursPerDay ?? 7),
    businessProfile: raw.businessProfile ? { ...raw.businessProfile } : null,
    executionProfile: normalizeExecutionProfile(raw.executionProfile, Number(raw.hoursPerDay ?? 7)),
    deliveryDefaults: { ...(raw.deliveryDefaults || {}) },
    sourceNote: raw.sourceNote || "",
    quantityRules: Array.isArray(raw.quantityRules) ? raw.quantityRules.map(normalizeQuantityRule) : [],
    assemblies: loadAssemblies(raw.assemblies, { source: `quote catalog ${raw.id}` })
      .map((definition) => {
        assertAssemblyModeContract(definition);
        return definition;
      }),
    // Rules added to every quote with scoped work (site establishment,
    // cleanup), priced from their catalogue items.
    supportRuleCodes: Array.isArray(raw.supportRuleCodes)
      ? raw.supportRuleCodes.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    missingInputDefaults: { ...(raw.missingInputDefaults || {}) },
    rules: raw.rules.map(normalizeQuoteCatalogRule),
  };
}

// Exported for tests; quote catalogs are only loaded from quote-catalogs/*.json5.
export function normalizeQuoteCatalogRule(rule) {
  if (!rule?.code) throw new Error("Quote-catalog rule is missing required field: code");
  if (!rule?.label) throw new Error(`Quote-catalog rule ${rule.code} is missing required field: label`);
  // The price catalogue is the only source of a rule's price and the unit
  // its item is sold in: a quote catalog that still carries either is
  // refused rather than quietly becoming a second authority.
  for (const field of ["unitPrice", "unit", "buyPrice", "sellPrice"]) {
    if (Object.prototype.hasOwnProperty.call(rule, field)) {
      throw new Error(`Quote-catalog rule ${rule.code} carries "${field}"; prices and sold units come only from the price catalogue item ${rule.authorityItemCode || rule.code} (declare the rule's own measure as quantityUnit)`);
    }
  }
  const quantityUnit = normalizeRuleQuantityUnit(rule);

  return {
    code: rule.code,
    label: rule.label,
    // The unit the rule measures its quantity in: structure, not price. The
    // catalogue item's price is converted to it when the catalog is overlaid
    // (server/price-catalog/catalog-pricing.js), or the rule fails closed.
    quantityUnit,
    unit: quantityUnit,
    defaultQuantity: Number(rule.defaultQuantity || 1),
    authorityItemCode: resolveRawAuthorityItemCode(rule),
    // The production item's uid (#178 step 4); the code above is the
    // fallback for a catalogue that lacks it. Present only when set.
    ...optionalCode(rule, "authorityItemUid"),
    workDomain: typeof rule.workDomain === "string" ? rule.workDomain.trim() || null : null,
    useWhen: rule.useWhen || null,
    keywords: Array.isArray(rule.keywords) ? rule.keywords : [],
    pricingDependencies: Array.isArray(rule.pricingDependencies)
      ? rule.pricingDependencies.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    quantitySource: rule.quantitySource || null,
    requiredInputs: Array.isArray(rule.requiredInputs) ? rule.requiredInputs : [],
    execution: normalizeRuleExecution(rule.execution),
    presentation: normalizeRulePresentation(rule.presentation),
    isFallback: Boolean(rule.fallback),
  };
}

function normalizeRuleQuantityUnit(rule) {
  const raw = typeof rule.quantityUnit === "string" ? rule.quantityUnit.trim() : "";
  if (!raw) {
    throw new Error(`Quote-catalog rule ${rule.code} is missing required field: quantityUnit (the unit its quantity is measured in)`);
  }
  const unit = normalizeCatalogUnit(raw);
  const definition = CATALOG_UNIT_DEFINITIONS.find((entry) => entry.code === unit);
  if (!definition) {
    throw new Error(`Quote-catalog rule ${rule.code} has quantityUnit "${raw}", which is not a known unit (known: ${CATALOG_UNIT_DEFINITIONS.map((entry) => entry.code).join(", ")})`);
  }
  const expected = QUANTITY_SOURCE_DIMENSIONS[rule.quantitySource];
  if (expected && definition.dimension !== expected) {
    throw new Error(`Quote-catalog rule ${rule.code} measures ${rule.quantitySource} but its quantityUnit "${unit}" is a ${definition.dimension} unit`);
  }
  return unit;
}

function optionalCode(rule, field) {
  const value = typeof rule?.[field] === "string" ? rule[field].trim() : "";
  return value ? { [field]: value } : {};
}

function normalizeQuantityRule(rule) {
  if (!rule?.code) throw new Error("Quote-catalog quantity rule is missing required field: code");
  if (!rule?.mode) throw new Error(`Quote-catalog quantity rule ${rule.code} is missing required field: mode`);

  return {
    code: String(rule.code).trim(),
    stage: String(rule.stage || "line_item").trim(),
    mode: String(rule.mode).trim(),
    appliesToRuleCodes: Array.isArray(rule.appliesToRuleCodes)
      ? rule.appliesToRuleCodes.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    pricingDependencies: Array.isArray(rule.pricingDependencies)
      ? rule.pricingDependencies.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    sourceRuleCode: typeof rule.sourceRuleCode === "string" ? rule.sourceRuleCode.trim() || null : null,
    sourceSectionPattern: typeof rule.sourceSectionPattern === "string" ? rule.sourceSectionPattern.trim() || null : null,
    outputRuleCode: typeof rule.outputRuleCode === "string" ? rule.outputRuleCode.trim() || null : null,
    outputSection: typeof rule.outputSection === "string" ? rule.outputSection.trim() || null : null,
    surfaceRuleCode: typeof rule.surfaceRuleCode === "string" ? rule.surfaceRuleCode.trim() || null : null,
    structureRuleCode: typeof rule.structureRuleCode === "string" ? rule.structureRuleCode.trim() || null : null,
    soilRuleCode: typeof rule.soilRuleCode === "string" ? rule.soilRuleCode.trim() || null : null,
    haulageRuleCode: typeof rule.haulageRuleCode === "string" ? rule.haulageRuleCode.trim() || null : null,
    haulageSection: typeof rule.haulageSection === "string" ? rule.haulageSection.trim() || null : null,
    loaderRuleCode: typeof rule.loaderRuleCode === "string" ? rule.loaderRuleCode.trim() || null : null,
    disposalRuleCode: typeof rule.disposalRuleCode === "string" ? rule.disposalRuleCode.trim() || null : null,
    vehicleHourRuleCode: typeof rule.vehicleHourRuleCode === "string" ? rule.vehicleHourRuleCode.trim() || null : null,
    vehicleKmRuleCode: typeof rule.vehicleKmRuleCode === "string" ? rule.vehicleKmRuleCode.trim() || null : null,
    // Present only when the quote catalog sets them.
    ...optionalCode(rule, "assembly"),
    ...optionalCode(rule, "labourRuleCode"),
    ...optionalCode(rule, "machineRuleCode"),
    outputItemCode: typeof rule.outputItemCode === "string" ? rule.outputItemCode.trim() || null : null,
    ...optionalCode(rule, "outputItemUid"),
    outputLabel: typeof rule.outputLabel === "string" ? rule.outputLabel.trim() || null : null,
    outputUnit: typeof rule.outputUnit === "string" ? rule.outputUnit.trim() || null : null,
    descriptionTemplate: typeof rule.descriptionTemplate === "string" ? rule.descriptionTemplate.trim() || null : null,
    truckCapacity: Number(rule.truckCapacity ?? 0),
    truckMassCapacityTonnes: Number(rule.truckMassCapacityTonnes ?? 0),
    truckVolumeCapacityM3: Number(rule.truckVolumeCapacityM3 ?? 0),
    loadingHoursPerLoad: Number(rule.loadingHoursPerLoad ?? 0),
    quantityMultiplier: Number(rule.quantityMultiplier ?? 1),
    defaultMeasurementDepthMetres: Number(rule.defaultMeasurementDepthMetres ?? 0),
    areaPerHour: Number(rule.areaPerHour ?? 0),
    volumePerHour: Number(rule.volumePerHour ?? 0),
    cutRatio: Number(rule.cutRatio ?? 0),
    fillRatio: Number(rule.fillRatio ?? 0),
    cutVolumePerHour: Number(rule.cutVolumePerHour ?? 0),
    fillVolumePerHour: Number(rule.fillVolumePerHour ?? 0),
    cutRuleCode: typeof rule.cutRuleCode === "string" ? rule.cutRuleCode.trim() || null : null,
    fillRuleCode: typeof rule.fillRuleCode === "string" ? rule.fillRuleCode.trim() || null : null,
    maxDepthMm: Number(rule.maxDepthMm ?? 0),
    surfaceDepthMm: Number(rule.surfaceDepthMm ?? 0),
    structureDepthMm: Number(rule.structureDepthMm ?? 0),
    componentRuleCodes: Array.isArray(rule.componentRuleCodes)
      ? rule.componentRuleCodes.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    multiSectionHaulageSection:
      typeof rule.multiSectionHaulageSection === "string"
        ? rule.multiSectionHaulageSection.trim() || null
        : null,
  };
}

function renderQuoteCatalogReferenceMarkdown(quoteCatalog) {
  const lines = [];

  lines.push(`# ${quoteCatalog.name} Quote Catalog`);
  lines.push("");
  lines.push(`Quote catalog ID: \`${quoteCatalog.id}\``);
  lines.push(`Status: ${quoteCatalog.status}`);
  lines.push(`Currency: \`${quoteCatalog.currency}\``);
  lines.push(`GST rate: ${(Number(quoteCatalog.gstRate || 0) * 100).toFixed(0)}%`);
  lines.push(`Productive day assumption: \`${quoteCatalog.hoursPerDay} hours/day\``);
  lines.push("");

  if (quoteCatalog.sourceNote) {
    lines.push(`Source note: ${quoteCatalog.sourceNote}`);
    lines.push("");
  }

  const authority = quoteCatalog.commercialAuthority || null;
  const authorityProvider = authority?.provider || "catalog";
  if (authorityProvider === "price_catalog") {
    lines.push("Commercial authority: Price catalog");
    if (authority.syncedAt) lines.push(`Last synced: ${authority.syncedAt}`);
    if (authority.overlaidRuleCount != null) lines.push(`Rules overlaid: ${authority.overlaidRuleCount}`);
    lines.push("");
  } else {
    lines.push("Commercial authority: local quote-catalog metadata only");
    lines.push("Pricing shown here is not authoritative until the local price catalog is available.");
    lines.push("");
  }

  lines.push("This document is generated from the structured quote catalog used by the live quote engine.");
  lines.push("");
  if (quoteCatalog.executionProfile) {
    lines.push("## Execution Assumptions");
    lines.push("");
    lines.push(`- Working day: ${quoteCatalog.executionProfile.hoursPerDay || quoteCatalog.hoursPerDay} hours`);
    lines.push(`- Daily travel/loading/break allowance: ${formatQty(quoteCatalog.executionProfile.travelHoursPerDay || 0)} hours`);
    if (quoteCatalog.executionProfile.defaultDumpDriveMinutesOneWay != null) {
      lines.push(`- Default dump drive: ${formatQty(quoteCatalog.executionProfile.defaultDumpDriveMinutesOneWay)} minutes one way`);
    }
    if (quoteCatalog.executionProfile.accessProfiles) {
      lines.push("- Access multipliers:");
      for (const [code, profile] of Object.entries(quoteCatalog.executionProfile.accessProfiles)) {
        lines.push(`  - ${profile.label || code}: labour x${formatQty(profile.labourMultiplier)} · machine x${formatQty(profile.machineMultiplier)} · duration x${formatQty(profile.durationMultiplier)}`);
      }
    }
    lines.push("");
  }

  if (quoteCatalog.quantityRules?.length) {
    lines.push("## Quantity Rules");
    lines.push("");
    lines.push("| Code | Stage | Mode | Applies To |");
    lines.push("| --- | --- | --- | --- |");
    for (const rule of quoteCatalog.quantityRules) {
      const appliesTo = rule.appliesToRuleCodes?.length
        ? rule.appliesToRuleCodes.join(", ")
        : [rule.soilRuleCode, rule.haulageRuleCode].filter(Boolean).join(" + ");
      lines.push(`| ${rule.code} | ${rule.stage} | ${rule.mode} | ${escapeCell(appliesTo || "-")} |`);
    }
    lines.push("");
  }

  lines.push("## Line Items");
  lines.push("");
  lines.push("| Code | Item | Authority Item | Status | Sell | Buy | Default Qty | Use When |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | --- |");
  for (const rule of quoteCatalog.lineItems) {
    lines.push(`| ${rule.code} | ${rule.label} (${rule.unit}) | ${rule.authorityItemCode || "-"} | ${rule.pricingStatus} | ${formatMaybeMoney(rule.sellRate, quoteCatalog.currency)} | ${formatMaybeMoney(rule.buyingRate, quoteCatalog.currency)} | ${formatQty(rule.defaultQuantity)} | ${escapeCell(rule.useWhen || "")} |`);
  }
  lines.push("");

  if (quoteCatalog.missingInputDefaults?.length) {
    lines.push("## Default Assumptions");
    lines.push("");
    lines.push("| Field | Default | Pricing Effect |");
    lines.push("| --- | --- | --- |");
    for (const item of quoteCatalog.missingInputDefaults) {
      lines.push(`| ${item.field} | ${escapeCell(item.defaultValue)} | ${item.affectsPricing ? "Affects pricing" : "Informational"} |`);
    }
    lines.push("");
  }

  lines.push("## Editing Rule");
  lines.push("");
  lines.push(`Update prices in the active commercial authority. Edit \`${quoteCatalog.sourceFile}\` only for metadata such as keywords, presentation, quantity policy, and execution heuristics.`);
  lines.push("");

  return lines.join("\n");
}

export function resolveQuoteCatalogRule(quoteCatalog, code) {
  if (!quoteCatalog?.rules?.length) return null;
  const normalized = canonicalizeQuoteCatalogRuleCode(code);
  if (!normalized) return null;
  return quoteCatalog.rules.find((rule) => {
    return normalizeRuleCode(rule.code) === normalized
      || normalizeRuleCode(rule.authorityItemCode) === normalized
      || normalizeRuleCode(rule.authorityItemCode) === normalized;
  }) || null;
}

export function resolveQuoteCatalogRuleCode(quoteCatalog, code) {
  return resolveQuoteCatalogRule(quoteCatalog, code)?.code || canonicalizeQuoteCatalogRuleCode(code) || null;
}

function normalizeExecutionProfile(raw, hoursPerDay) {
  if (!raw || typeof raw !== "object") {
    return {
      hoursPerDay,
    };
  }
  return {
    hoursPerDay: Number(raw.hoursPerDay ?? hoursPerDay),
    travelHoursPerDay: Number(raw.travelHoursPerDay ?? 0),
    tipTruckLoadMinutes: Number(raw.tipTruckLoadMinutes ?? 0),
    tipTruckDumpMinutes: Number(raw.tipTruckDumpMinutes ?? 0),
    defaultDumpDriveMinutesOneWay: Number(raw.defaultDumpDriveMinutesOneWay ?? 0),
    accessProfiles: normalizeAccessProfiles(raw.accessProfiles),
  };
}

function normalizeAccessProfiles(raw) {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw).map(([code, profile]) => [
      code,
      {
        label: profile?.label || code,
        labourMultiplier: Number(profile?.labourMultiplier ?? 1),
        machineMultiplier: Number(profile?.machineMultiplier ?? 1),
        durationMultiplier: Number(profile?.durationMultiplier ?? 1),
        overheadMultiplier: Number(profile?.overheadMultiplier ?? 1),
      },
    ])
  );
}

function normalizeRuleExecution(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    stage: raw.stage || null,
    labourHoursPerUnit: Number(raw.labourHoursPerUnit ?? 0),
    machineHoursPerUnit: Number(raw.machineHoursPerUnit ?? 0),
    supportHoursPerUnit: Number(raw.supportHoursPerUnit ?? 0),
    billableLabourHoursPerUnit: Number(raw.billableLabourHoursPerUnit ?? raw.labourHoursPerUnit ?? 0),
    billableMachineHoursPerUnit: Number(raw.billableMachineHoursPerUnit ?? raw.machineHoursPerUnit ?? 0),
    supportHoursMode: raw.supportHoursMode || null,
  };
}

function normalizeRulePresentation(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    bundled: raw.bundled === true,
    customerVisible: raw.customerVisible !== false,
    scheduleLabel: typeof raw.scheduleLabel === "string" ? raw.scheduleLabel.trim() || null : null,
    summaryLabel: typeof raw.summaryLabel === "string" ? raw.summaryLabel.trim() || null : null,
    quantityLabelMode: raw.quantityLabelMode || null,
    quantityLabelUnitSingular:
      typeof raw.quantityLabelUnitSingular === "string"
        ? raw.quantityLabelUnitSingular.trim() || null
        : null,
    quantityLabelUnitPlural:
      typeof raw.quantityLabelUnitPlural === "string"
        ? raw.quantityLabelUnitPlural.trim() || null
        : null,
    defaultSection: typeof raw.defaultSection === "string" ? raw.defaultSection.trim() || null : null,
  };
}

function describeExecution(execution) {
  if (!execution) return "-";
  const parts = [];
  if (execution.stage) parts.push(`stage ${execution.stage}`);
  if (execution.labourHoursPerUnit) parts.push(`labour ${formatQty(execution.labourHoursPerUnit)}h/unit`);
  if (execution.machineHoursPerUnit) parts.push(`machine ${formatQty(execution.machineHoursPerUnit)}h/unit`);
  if (execution.supportHoursMode === "tip-truck-cycle") {
    parts.push("duration from tip-truck cycle");
  } else if (execution.supportHoursPerUnit) {
    parts.push(`support ${formatQty(execution.supportHoursPerUnit)}h/unit`);
  }
  if (execution.billableLabourHoursPerUnit === 0 && execution.labourHoursPerUnit > 0) {
    parts.push("fixed-price labour");
  }
  if (execution.billableMachineHoursPerUnit === 0 && execution.machineHoursPerUnit > 0) {
    parts.push("fixed-price machine");
  }
  return parts.join(" · ") || "-";
}

function formatMoney(value, currency) {
  // `|| 0` here is only ever reached with an already-validated finite number
  // — formatMaybeMoney is the sole caller and gates on Number.isFinite(value)
  // first, so this never has to absorb a null/undefined itself. Left as a
  // narrow defensive fallback rather than removed; do not treat this as a
  // green light to call formatMoney directly with an unvalidated rate
  // elsewhere (DEL-46, round 7).
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(value || 0);
}

function formatMaybeMoney(value, currency) {
  // value is already null-or-number by the time it reaches here (it comes
  // from resolveRuleSellRate/resolveRuleBuyingRate, both already fixed to
  // return a real null rather than a coerced 0 — DEL-46, round 6). Checking
  // Number.isFinite(Number(value)) instead of Number.isFinite(value) would
  // silently reintroduce the exact bug those fixes exist to prevent:
  // Number(null) is 0, which is finite, so a null rate would take the money
  // branch and formatMoney would render it as "$0.00" instead of "-"
  // (DEL-46, round 7).
  return Number.isFinite(value) ? formatMoney(value, currency) : "-";
}

function formatQty(value) {
  if (Number.isInteger(value)) return String(value);
  return Number(value || 0).toFixed(2).replace(/\.00$/, "");
}

function escapeCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function normalizeRuleCode(value) {
  return String(value || "").trim();
}

function canonicalizeQuoteCatalogRuleCode(value) {
  const normalized = normalizeRuleCode(value);
  return LEGACY_QUOTE_CATALOG_RULE_ALIASES[normalized] || normalized || null;
}

function resolveRuleAuthorityItemCode(rule) {
  return String(rule?.priceCatalog?.code || rule?.authorityItemCode || rule?.authorityPricing?.itemCode || rule?.code || "").trim() || null;
}

function resolveRawAuthorityItemCode(rule) {
  if (typeof rule?.authorityItemCode === "string" && rule.authorityItemCode.trim()) {
    return rule.authorityItemCode.trim();
  }
  return rule?.code || null;
}

// Prices come only from the price catalogue overlay; without it a rule has
// no rate (never a quote-catalog default).
function resolveRuleSellRate({ rule }) {
  if (rule?.priceCatalog?.sellPrice != null) return Number(rule.priceCatalog.sellPrice);
  if (rule?.authorityPricing?.sellingRate != null) return Number(rule.authorityPricing.sellingRate);
  return null;
}

function resolveRuleBuyingRate(rule) {
  if (rule?.priceCatalog?.buyPrice != null) return Number(rule.priceCatalog.buyPrice);
  return rule?.authorityPricing?.buyingRate != null ? Number(rule.authorityPricing.buyingRate) : null;
}

function resolveRulePricingStatus({ rule, authorityProvider }) {
  const itemCode = resolveRuleAuthorityItemCode(rule);
  if (authorityProvider === "catalog") return "authority_unavailable";
  if (authorityProvider === "price_catalog" && rule?.priceCatalog?.status) {
    if (rule.priceCatalog.unitMismatch) return "unit_mismatch";
    if (rule.priceCatalog.sellPrice == null) return "missing_selling_rate";
    if (rule.priceCatalog.buyPrice == null) return "selling_only";
    return "authority_ready";
  }
  if (authorityProvider === "price_catalog") return "authority_unavailable";
  if (!itemCode) return "missing_mapping";
  if (rule?.authorityPricing?.missingItem) return "missing_item";
  if (rule?.authorityPricing?.sellingRate == null) return "missing_selling_rate";
  if (rule?.authorityPricing?.buyingRate == null) return "selling_only";
  return "authority_ready";
}

function buildRulePricingIssues({ rule, authorityProvider }) {
  if (authorityProvider === "catalog") return ["Price catalog is unavailable, so this rule has no rate."];
  const issues = [];
  if (authorityProvider === "price_catalog" && !rule?.priceCatalog) {
    issues.push("Price catalog item is missing or unavailable.");
    return issues;
  }
  if (!resolveRuleAuthorityItemCode(rule)) issues.push("Missing authority item mapping.");
  if (authorityProvider === "price_catalog") {
    if (rule?.priceCatalog?.unitMismatch) {
      issues.push(rule.priceCatalog.unitMismatch.message);
      return issues;
    }
    if (rule?.priceCatalog?.sellPrice == null) issues.push("Price catalog selling rate is missing.");
    if (rule?.priceCatalog?.buyPrice == null) issues.push("Price catalog buying rate is missing.");
    return issues;
  }
  if (rule?.authorityPricing?.missingItem) issues.push("Authority item is missing or disabled.");
  if (rule?.authorityPricing?.sellingRate == null) issues.push("Authority selling rate is missing.");
  if (rule?.authorityPricing?.buyingRate == null) issues.push("Authority buying rate is missing.");
  return issues;
}

function isRuleQuoteable({ rule, authorityProvider }) {
  if (authorityProvider === "catalog") return false;
  // DEL-46 (round 7): both of these used a plain `!= null` check, unlike the
  // catalog branch above — an authored sell_price/sellingRate of exactly 0
  // (which the price-catalog API permits: "zero or greater") would report
  // quoteable: true here while generate-evidence-quote.js's matching
  // authorityUnitPrice computation (fixed the same round) now rejects it,
  // and buildBulkDisposalLine/the manual commercial-adjustment path both
  // already reject an authored zero too. Apply the same `> 0` threshold so
  // this reference-table signal doesn't disagree with what the quote engine
  // actually does.
  if (authorityProvider === "price_catalog") {
    return rule?.priceCatalog?.sellPrice != null && rule.priceCatalog.sellPrice > 0;
  }
  return rule?.authorityPricing?.sellingRate != null && rule.authorityPricing.sellingRate > 0;
}
