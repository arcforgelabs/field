import { resolveQuoteCatalogRule } from "./quote-catalogs.js";
import { findBulkRemovalPlanForSection } from "./quote-breakdown-source.js";
import { normalizeStructuredTrace } from "./quote-trace.js";
import { DEFAULT_SOIL_DUMP, DEFAULT_SOIL_DUMPS, haversineDistanceKm, estimateDrivingDistanceKm, estimateDriveMinutes } from "../shared/dumping.js";
import { formatCatalogUnitText } from "../shared/catalog-units.js";
import { resolveDisposalBilledQuantity } from "../shared/disposal-basis.js";
import { evaluateAssembly } from "./catalog/assemblies.js";

/** Resolve the dump for a job, computing distance from job GPS if available */
function resolveDumpForJob(details) {
  const dump = details?.soilDump || DEFAULT_SOIL_DUMP || DEFAULT_SOIL_DUMPS[0] || null;
  if (!dump) return null;
  const gps = details?.gps;
  if (gps?.lat && gps?.lng && dump.lat && dump.lng) {
    const straight = haversineDistanceKm(gps.lat, gps.lng, dump.lat, dump.lng);
    const dist = estimateDrivingDistanceKm(straight);
    const drive = estimateDriveMinutes(dist);
    return { ...dump, dist, drive };
  }
  return dump;
}

const DEFAULT_MATERIAL_ITEM_GROUPS = new Set([
  "Raw Material",
  "Construction Materials",
]);

export function applyQuoteCatalogQuantityRules({
  groups,
  quoteCatalog,
  moasureSummary = null,
  measurements = null,
  details = null,
  breakdownSource = null,
  groupUtils,
}) {
  for (const rule of getQuantityRules(quoteCatalog, "candidate_groups")) {
    switch (rule.mode) {
      case "soil_dump_plan":
        applySoilDumpPlanRule({
          groups,
          quoteCatalog,
          moasureSummary,
          details,
          breakdownSource,
          rule,
          groupUtils,
        });
        break;
      case "volume_from_section":
        applyVolumeFromSectionRule({
          groups,
          quoteCatalog,
          measurements,
          breakdownSource,
          rule,
          groupUtils,
        });
        break;
      case "concrete_removal_plan":
        applyConcreteRemovalPlanRule({
          groups,
          quoteCatalog,
          details,
          rule,
          groupUtils,
        });
        break;
      default:
        break;
    }
  }
}

export function resolveQuoteQuantityDemand({
  lineItem,
  quote,
  quoteCatalog = null,
  resolved = null,
  details = null,
}) {
  const baseRuleCode = extractBaseRuleCode(
    lineItem?.quoteCatalogItemCode
    || lineItem?.quoteCatalogEntry?.code
    || lineItem?.code
  );
  const result = {
    recipe: null,
    materialOrders: [],
  };
  const configuredRules = getQuantityRules(quoteCatalog, "line_item");
  const lineItemRules = [
    ...configuredRules,
    ...getFallbackLineItemRules({
      lineItem,
      baseRuleCode,
      configuredRules,
      quoteCatalog,
    }),
  ];

  for (const rule of lineItemRules) {
    const contribution = resolveQuantityRuleContribution({
      lineItem,
      quote,
      quoteCatalog,
      resolved,
      details,
      baseRuleCode,
      rule,
    });
    if (!contribution) continue;
    if (!result.recipe && contribution.recipe) {
      result.recipe = contribution.recipe;
    }
    result.materialOrders.push(...(contribution.materialOrders || []));
  }

  result.materialOrders = dedupeBy(result.materialOrders, (order) => order.code);
  return result.recipe || result.materialOrders.length ? result : null;
}

export function buildMaterialOrdersFromLines({
  lineItem = null,
  lines = [],
  source = "exact_recipe",
  sourceLineItemCode = null,
  section = null,
}) {
  return dedupeBy(
    (lines || [])
      .filter((line) => isMaterialLine(line))
      .map((line) => buildMaterialOrder({
        itemCode: line.itemCode,
        label: line.label || line.itemMeta?.itemName || line.itemCode,
        description: line.description || line.label || line.itemCode,
        quantity: Number(line.quantity || 0),
        unit: line.unit || line.itemMeta?.stockUom || "Nos",
        sourceLineItemCode: sourceLineItemCode || lineItem?.code || line.sourceLineItemCode || null,
        section: section || lineItem?.section || line.section || null,
        itemMeta: buildMaterialItemMeta(line),
        unitCost: line.unitCost ?? null,
        unitPrice: line.unitPrice ?? line.unitRate ?? null,
        calculation: null,
        source,
        scope: line.scope || null,
      }))
      .filter((order) => order.quantity > 0),
    (order) => order.code,
  );
}

function resolveQuantityRuleContribution({
  lineItem,
  quote,
  quoteCatalog,
  resolved,
  details,
  baseRuleCode,
  rule,
}) {
  switch (rule.mode) {
    case "lawn_bundle":
      return resolveLawnBundleDemand({ lineItem, quote, resolved, baseRuleCode, rule });
    case "irrigation_bundle":
      return resolveIrrigationBundleDemand({ lineItem, quote, resolved, baseRuleCode, rule });
    case "drainage_bundle":
      return resolveDrainageBundleDemand({ lineItem, quote, resolved, baseRuleCode, rule });
    case "volume_excavation":
      return resolveVolumeExcavationDemand({ lineItem, quote, quoteCatalog, baseRuleCode, rule });
    case "bulk_loading_disposal":
      return resolveBulkLoadingDisposalDemand({ lineItem, quoteCatalog, baseRuleCode, rule });
    case "haulage_trip":
      return resolveHaulageTripDemand({ lineItem, quoteCatalog, details, baseRuleCode, rule });
    case "concrete_surface_demolition":
      return resolveConcreteSurfaceDemolitionDemand({ lineItem, quote, quoteCatalog, baseRuleCode, rule });
    case "concrete_structure_demolition":
      return resolveConcreteStructureDemolitionDemand({ lineItem, quote, quoteCatalog, baseRuleCode, rule });
    case "direct_material_order":
      return resolveDirectMaterialOrderDemand({ lineItem, quoteCatalog, baseRuleCode, rule });
    case "supply_install_bundle":
      return resolveSupplyInstallBundleDemand({ lineItem, quoteCatalog, resolved, baseRuleCode, rule });
    default:
      return null;
  }
}

const PRICING_BASIS_UNIT_LABELS = {
  per_tonne: "tonne",
  per_load: "load",
  per_m3: "m3",
};

/**
 * Density, load capacity, and the per_m3 identity factor are owned by the
 * price-catalogue item behind a disposal rule (pricing_basis /
 * pricing_basis_factor) — not by the quote-catalog quantity rule. This is
 * the single place quote-quantity-rules.js reads that factor from; do not
 * reintroduce a hardcoded fallback density elsewhere (DEL-46).
 */
function resolveDisposalPricingBasis(disposalRule) {
  const basis = disposalRule?.priceCatalog?.pricingBasis
    ?? disposalRule?.authorityPricing?.pricingBasis
    ?? null;
  const factorRaw = disposalRule?.priceCatalog?.pricingBasisFactor
    ?? disposalRule?.authorityPricing?.pricingBasisFactor
    ?? null;
  const factor = Number.isFinite(Number(factorRaw)) && Number(factorRaw) > 0 ? Number(factorRaw) : null;
  return { basis: basis || null, factor };
}

/**
 * Resolve the density (t/m3) used for physical truck-capacity logistics
 * (loads, loading hours) for the same disposal item a bulk-disposal recipe
 * bills against. The disposal item's own pricing_basis_factor is the only
 * source: a json5 quantity-rule fallback was removed here (DEL-46 round 2)
 * because it was a second, independently-editable owner of the same number
 * the catalogue's price build-up (catalog-recipes.js /
 * resolveRecipeChildQuantity) already treats as sole-owned — keeping it
 * would let logistics and billing silently diverge during exactly the
 * commercial-authority outage it was meant to degrade gracefully through.
 * Returns 0 when the item's basis isn't per_tonne or can't be resolved, so
 * downstream loading math fails closed with the disposal billing line
 * instead of pricing loader hours off a stale substitute.
 */
function resolveDisposalDensityTonnesPerM3({ quoteCatalog, disposalRuleCode }) {
  const disposalRule = resolveQuoteCatalogRule(quoteCatalog, disposalRuleCode);
  const { basis, factor } = resolveDisposalPricingBasis(disposalRule);
  return basis === "per_tonne" && factor ? factor : 0;
}

/**
 * Compute the quantity actually billed against a disposal item, in the unit
 * its own costing basis bills in. The conversion arithmetic itself (per_m3
 * identity, per_tonne × density, per_load ÷ load capacity rounded up to
 * whole loads) lives solely in shared/disposal-basis.js — resolved here from
 * the rule and packaged with the quote-engine-specific unit label. Returns
 * null when the basis/factor can't be resolved so the caller fails closed
 * (not-quoteable) instead of guessing (DEL-46).
 */
function resolveDisposalBillableQuantity({ disposalRule, volumeM3 }) {
  const { basis, factor } = resolveDisposalPricingBasis(disposalRule);
  if (!basis) return null;
  const quantity = resolveDisposalBilledQuantity({ pricingBasis: basis, pricingBasisFactor: factor, volumeM3 });
  if (quantity == null) return null;
  return { basis, factor: basis === "per_m3" ? null : factor, quantity, unit: PRICING_BASIS_UNIT_LABELS[basis] };
}

function describeDisposalBasisExpression({ basis, factor, volumeM3, quantity, unit }) {
  if (basis === "per_tonne") {
    return `${formatQty(volumeM3)} m3 × ${formatQty(factor)} t/m3 = ${formatQty(quantity)} t (basis: per_tonne).`;
  }
  if (basis === "per_load") {
    return `${formatQty(volumeM3)} m3 ÷ ${formatQty(factor)} m3/load = ${formatQty(quantity)} loads, rounded up (basis: per_load).`;
  }
  if (basis === "per_m3") {
    return `${formatQty(volumeM3)} m3 billed at basis per_m3 = ${formatQty(quantity)} m3.`;
  }
  return `${formatQty(volumeM3)} m3 (basis: ${basis || "unresolved"}${unit ? `, ${unit}` : ""}).`;
}

function applySoilDumpPlanRule({
  groups,
  quoteCatalog,
  moasureSummary,
  details,
  breakdownSource,
  rule,
  groupUtils,
}) {
  const soilRuleCode = rule.soilRuleCode || null;
  const haulageRuleCode = rule.haulageRuleCode || null;
  const defaultMeasurementDepthMetres = Number(rule.defaultMeasurementDepthMetres || 0.1);
  const multiSectionHaulageSection = rule.multiSectionHaulageSection || "Soil haulage";
  const dump = resolveDumpForJob(details);
  const truckMassCapacityTonnes = Number(rule.truckMassCapacityTonnes || 3.5);
  const truckVolumeCapacityM3 = Number(rule.truckVolumeCapacityM3 || 2.1875);
  const loadingHoursPerLoad = Number(rule.loadingHoursPerLoad || 0.5);
  const loaderRuleCode = rule.loaderRuleCode || null;
  const disposalRuleCode = rule.disposalRuleCode || null;
  const densityTonnesPerM3 = resolveDisposalDensityTonnesPerM3({ quoteCatalog, disposalRuleCode });
  const vehicleHourRuleCode = rule.vehicleHourRuleCode || null;
  const vehicleKmRuleCode = rule.vehicleKmRuleCode || null;

  let measurementGrossCutVolumeM3 = 0;
  let measurementFillVolumeM3 = 0;
  let measurementHasExplicitFillPlan = false;
  if (moasureSummary?.imports?.length) {
    // Use only the largest-area import to avoid double-counting overlapping zones.
    // Sub-zones (edging, rose garden, etc.) are contained within the total boundary.
    const largestImport = [...moasureSummary.imports].sort((a, b) => (b.area || 0) - (a.area || 0))[0];
    const imports = largestImport ? [largestImport] : moasureSummary.imports;
    const measurementPlan = imports.reduce((acc, item) => {
      // Use explicit volume if available; otherwise estimate with pyramid approximation
      const importedGrossCutVolumeM3 = item.volume != null
        ? Number(item.volume)
        : (Number(item.area || 0) * Number(item.elevationRange || defaultMeasurementDepthMetres) / 3);
      const itemPlan = resolveBulkRemovalPlan({
        source: item,
        fallbackGrossCutVolumeM3: importedGrossCutVolumeM3,
      });
      acc.grossCutVolumeM3 += itemPlan.grossCutVolumeM3;
      if (itemPlan.hasVolumeAdjustments) {
        acc.fillVolumeM3 += itemPlan.fillVolumeM3;
        acc.hasVolumeAdjustments = true;
      }
      return acc;
    }, {
      grossCutVolumeM3: 0,
      fillVolumeM3: 0,
      hasVolumeAdjustments: false,
    });
    measurementGrossCutVolumeM3 = roundQuantity(measurementPlan.grossCutVolumeM3);
    if (measurementPlan.hasVolumeAdjustments) {
      measurementFillVolumeM3 = roundQuantity(measurementPlan.fillVolumeM3);
      measurementHasExplicitFillPlan = true;
    }
  }

  const soilGroupKeys = groupUtils.findGroupKeysByRuleCode(groups, soilRuleCode);
  const soilSection = groupUtils.resolveDerivedSectionLabel({ groups, groupKeys: soilGroupKeys });
  const soilGroups = soilGroupKeys.map((groupKey) => {
    const entries = groups.get(groupKey) || [];
    const volumePlan = entries.reduce((acc, { candidate }) => {
      const candidateVolumeM3 = Number.isFinite(candidate.quantity) ? candidate.quantity : 0;
      const candidatePlan = resolveBulkRemovalPlan({
        source: candidate,
        fallbackGrossCutVolumeM3: candidateVolumeM3,
      });
      acc.volume += candidateVolumeM3;
      if (candidatePlan.hasVolumeAdjustments) {
        acc.explicitFillVolumeM3 += candidatePlan.fillVolumeM3;
        acc.hasVolumeAdjustments = true;
      }
      return acc;
    }, {
      volume: 0,
      explicitFillVolumeM3: 0,
      hasVolumeAdjustments: false,
    });
    return {
      groupKey,
      entries,
      section: groupUtils.normalizeSectionLabel(
        entries.find(({ candidate }) => candidate.section)?.candidate?.section
        || groupUtils.extractSectionLabelFromGroupKey(groupKey)
        || null
      ),
      volume: roundQuantity(volumePlan.volume),
      explicitFillVolumeM3: roundQuantity(volumePlan.explicitFillVolumeM3),
      hasVolumeAdjustments: volumePlan.hasVolumeAdjustments,
    };
  });
  const breakdownSourcePlanByGroupKey = new Map(
    soilGroups.map((group) => ([
      group.groupKey,
      findBulkRemovalPlanForSection({ breakdownSource, section: group.section }),
    ]))
  );
  const breakdownSourceMeasurementPlan = aggregateBulkRemovalPlanMeasurements(
    [...breakdownSourcePlanByGroupKey.values()].filter(Boolean)
  );
  if (breakdownSourceMeasurementPlan?.grossCutVolumeM3 > 0) {
    measurementGrossCutVolumeM3 = breakdownSourceMeasurementPlan.grossCutVolumeM3;
    measurementFillVolumeM3 = breakdownSourceMeasurementPlan.fillVolumeM3 || 0;
    measurementHasExplicitFillPlan = Number.isFinite(Number(breakdownSourceMeasurementPlan.fillVolumeM3));
  }

  const explicitGrossCutVolumeM3 = roundQuantity(soilGroups.reduce((sum, group) => sum + group.volume, 0));
  const hasExplicitSoilVolume = explicitGrossCutVolumeM3 > 0;

  let grossCutVolumeM3 = hasExplicitSoilVolume
    ? explicitGrossCutVolumeM3
    : measurementGrossCutVolumeM3;
  let fillVolumeM3 = 0;

  if (!hasExplicitSoilVolume && measurementHasExplicitFillPlan) {
    fillVolumeM3 = measurementFillVolumeM3;
  }
  if (grossCutVolumeM3 === 0 && soilGroups.length) {
    grossCutVolumeM3 = explicitGrossCutVolumeM3;
  }
  if (soilGroups.some((group) => group.hasVolumeAdjustments)) {
    fillVolumeM3 = roundQuantity(soilGroups.reduce((sum, group) => sum + group.explicitFillVolumeM3, 0));
  }
  if (!(grossCutVolumeM3 > 0)) return;

  const distance = dump?.dist || 0;
  const measurementDerived = !hasExplicitSoilVolume && moasureSummary?.imports?.length > 0;
  fillVolumeM3 = roundQuantity(Math.max(0, Number(fillVolumeM3 || 0)));
  const noteFillImportRequired = fillVolumeM3 > grossCutVolumeM3;
  const allocatedGroupFillVolumes = soilGroups.length > 1 && fillVolumeM3 > 0
    ? allocateBulkRemovalFillVolumes({
        groups: soilGroups.filter((group) => !group.hasVolumeAdjustments && group.volume > 0),
        totalFillVolumeM3: roundQuantity(Math.max(
          0,
          fillVolumeM3 - soilGroups.reduce((sum, group) => (
            group.hasVolumeAdjustments
              ? sum + group.explicitFillVolumeM3
              : sum
          ), 0)
        )),
      })
    : new Map();
  const resolvedSoilGroups = soilGroups.map((group) => {
    const breakdownSourcePlan = breakdownSourcePlanByGroupKey.get(group.groupKey) || null;
    const breakdownSourceInputs = normalizeBulkRemovalBreakdownSourceInputs(breakdownSourcePlan);
    const groupGrossCutVolumeM3 = group.volume > 0 ? group.volume : grossCutVolumeM3;
    const groupFillVolumeM3 = soilGroups.length === 1
      ? (group.hasVolumeAdjustments ? group.explicitFillVolumeM3 : fillVolumeM3)
      : (group.hasVolumeAdjustments
        ? group.explicitFillVolumeM3
        : (allocatedGroupFillVolumes.get(group.groupKey) || 0));
    const groupDisposalVolumeM3 = roundQuantity(Math.max(0, groupGrossCutVolumeM3 - groupFillVolumeM3));
    const groupFillVolumeAllocated = soilGroups.length > 1
      && !group.hasVolumeAdjustments
      && allocatedGroupFillVolumes.has(group.groupKey);
    return {
      ...group,
      breakdownSourcePlan,
      breakdownSourceInputs,
      groupGrossCutVolumeM3,
      groupFillVolumeM3,
      groupDisposalVolumeM3,
      groupFillVolumeAllocated,
    };
  });
  if (resolvedSoilGroups.length) {
    grossCutVolumeM3 = roundQuantity(sum(resolvedSoilGroups.map((group) => group.groupGrossCutVolumeM3)));
    fillVolumeM3 = roundQuantity(sum(resolvedSoilGroups.map((group) => group.groupFillVolumeM3)));
  }
  const useBreakdownSourceMeasurementPlanForDisposal = !resolvedSoilGroups.some((group) => group.hasVolumeAdjustments);
  const resolvedGroupDisposalVolumeM3 = roundQuantity(sum(
    resolvedSoilGroups.map((group) => group.groupDisposalVolumeM3)
  ));
  const disposalVolumeM3 = roundQuantity(firstFinite([
    useBreakdownSourceMeasurementPlanForDisposal ? breakdownSourceMeasurementPlan?.netExportVolumeM3 : null,
    resolvedGroupDisposalVolumeM3,
    Math.max(0, grossCutVolumeM3 - fillVolumeM3),
  ]) || 0);
  // Null (not 0) when the disposal item isn't billed per_tonne — see the
  // matching comment on resolveDisposalDensityTonnesPerM3 (DEL-46).
  const disposalTonnes = densityTonnesPerM3 > 0 ? roundQuantity(disposalVolumeM3 * densityTonnesPerM3) : null;

  const soilRule = resolveQuoteCatalogRule(quoteCatalog, soilRuleCode);
  if (soilRule) {
    if (!soilGroups.length) {
      const pricing = buildBulkRemovalPricing({
        quoteCatalog,
        volumeM3: grossCutVolumeM3,
        disposalVolumeM3,
        densityTonnesPerM3,
        truckMassCapacityTonnes,
        truckVolumeCapacityM3,
        loadingHoursPerLoad,
        loaderRuleCode,
        disposalRuleCode,
      });
      groups.set(groupUtils.buildLineItemGroupKey({ ruleCode: soilRule.code, section: soilSection }), [{
        rule: soilRule,
        candidate: {
          label: soilRule.label,
          description: buildBulkRemovalDescription({
            grossCutVolumeM3,
            fillVolumeM3,
            disposalVolumeM3,
            disposalTonnes: pricing?.disposalTonnes ?? disposalTonnes,
            dump,
            disposalRuleCode,
            noteFillImportRequired,
          }),
          quoteCatalogItemCode: soilRule.code,
          quantity: grossCutVolumeM3,
          unit: soilRule.unit,
          confidence: 0.95,
          rationale: buildBulkRemovalRationale({
            grossCutVolumeM3,
            fillVolumeM3,
            disposalVolumeM3,
            disposalTonnes: pricing?.disposalTonnes ?? disposalTonnes,
            densityTonnesPerM3,
            truckMassCapacityTonnes,
            truckVolumeCapacityM3,
            loadingHoursPerLoad,
            dump,
            disposalRuleCode,
            noteFillImportRequired,
          }),
          evidence: [],
          section: soilSection,
          unitPrice: pricing?.unitPrice ?? null,
          totalPrice: pricing?.totalPrice ?? null,
          unitCost: pricing?.unitCost ?? null,
          totalCost: pricing?.totalCost ?? null,
          bulkRemovalInputs: {
            grossCutVolumeM3,
            fillVolumeM3,
            netVolumeM3: disposalVolumeM3,
            disposalVolumeM3,
            ...(noteFillImportRequired ? { noteFillImportRequired: true } : {}),
          },
          _measurementDerived: measurementDerived,
          // DEL-46 (P0, round 4): propagate an unresolvable disposal basis
          // into the existing not-quoteable mechanism (see the haulage
          // section below and server/generate-evidence-quote.js:1103-1110)
          // instead of letting the line quietly price from the loader
          // component alone.
          _requiresDerivedPricing: Boolean(pricing?.pricingIssueReason),
          _pricingIssueCode: pricing?.pricingIssueReason ? (pricing.pricingIssueCode || disposalRuleCode) : null,
          _pricingIssueReason: pricing?.pricingIssueReason || null,
        },
      }]);
    } else {
      for (const group of resolvedSoilGroups) {
        const pricing = buildBulkRemovalPricing({
          quoteCatalog,
          volumeM3: group.groupGrossCutVolumeM3,
          disposalVolumeM3: group.groupDisposalVolumeM3,
          densityTonnesPerM3,
          truckMassCapacityTonnes,
          truckVolumeCapacityM3,
          loadingHoursPerLoad,
          loaderRuleCode,
          disposalRuleCode,
        });
        groups.set(group.groupKey, group.entries.map(({ candidate }) => ({
          rule: soilRule,
          candidate: {
            ...candidate,
            label: candidate.label || soilRule.label,
            description: buildBulkRemovalDescription({
              grossCutVolumeM3: group.groupGrossCutVolumeM3,
              fillVolumeM3: group.groupFillVolumeM3,
              disposalVolumeM3: group.groupDisposalVolumeM3,
              disposalTonnes: pricing?.disposalTonnes ?? (densityTonnesPerM3 > 0 ? roundQuantity(group.groupDisposalVolumeM3 * densityTonnesPerM3) : null),
              dump,
              disposalRuleCode,
              noteFillImportRequired,
            }),
            quoteCatalogItemCode: soilRule.code,
            quantity: group.groupGrossCutVolumeM3,
            unit: soilRule.unit,
            confidence: Math.max(Number(candidate.confidence || 0), 0.95),
            rationale: buildBulkRemovalRationale({
              grossCutVolumeM3: group.groupGrossCutVolumeM3,
              fillVolumeM3: group.groupFillVolumeM3,
              disposalVolumeM3: group.groupDisposalVolumeM3,
              disposalTonnes: pricing?.disposalTonnes ?? (densityTonnesPerM3 > 0 ? roundQuantity(group.groupDisposalVolumeM3 * densityTonnesPerM3) : null),
              densityTonnesPerM3,
              truckMassCapacityTonnes,
              truckVolumeCapacityM3,
              loadingHoursPerLoad,
              dump,
              disposalRuleCode,
              noteFillImportRequired,
              fillVolumeAllocated: group.groupFillVolumeAllocated,
            }),
            section: group.section,
            // DEL-46 (P0, round 4): when the disposal basis is unresolvable,
            // pricing.pricingIssueReason is set and pricing.unitPrice/unitCost
            // are already null — do not let the pre-existing candidate-price
            // fallback (used for other, unrelated computation failures) mask
            // that with a stale AI-extracted rate.
            unitPrice: pricing?.pricingIssueReason ? null : (pricing?.unitPrice ?? candidate.unitPrice ?? null),
            totalPrice: pricing?.totalPrice ?? null,
            unitCost: pricing?.pricingIssueReason ? null : (pricing?.unitCost ?? candidate.unitCost ?? null),
            totalCost: pricing?.totalCost ?? null,
            _requiresDerivedPricing: Boolean(pricing?.pricingIssueReason),
            _pricingIssueCode: pricing?.pricingIssueReason ? (pricing.pricingIssueCode || disposalRuleCode) : null,
            _pricingIssueReason: pricing?.pricingIssueReason || null,
            bulkRemovalInputs: group.hasVolumeAdjustments
              ? {
                  grossCutVolumeM3: group.groupGrossCutVolumeM3,
                  fillVolumeM3: group.groupFillVolumeM3,
                  netVolumeM3: group.groupDisposalVolumeM3,
                  disposalVolumeM3: group.groupDisposalVolumeM3,
                  ...(noteFillImportRequired ? { noteFillImportRequired: true } : {}),
                }
              : group.breakdownSourceInputs
              ? {
                  ...group.breakdownSourceInputs,
                  ...(noteFillImportRequired ? { noteFillImportRequired: true } : {}),
                }
              : {
                  grossCutVolumeM3: group.groupGrossCutVolumeM3,
                  fillVolumeM3: group.groupFillVolumeM3,
                  netVolumeM3: group.groupDisposalVolumeM3,
                  disposalVolumeM3: group.groupDisposalVolumeM3,
                  ...(noteFillImportRequired ? { noteFillImportRequired: true } : {}),
                },
            breakdownSourcePlan: buildBreakdownSourcePlanPreview(group.breakdownSourcePlan),
            _measurementReferenced: group.breakdownSourcePlan != null || candidate._measurementReferenced === true,
            _measurementDerived: measurementDerived || candidate._measurementDerived === true,
          },
        })));
      }
    }
  }

  const haulageGroupKeys = groupUtils.findGroupKeysByRuleCode(groups, haulageRuleCode);
  const hasExplicitHaulageQuantity = haulageGroupKeys.some((groupKey) => (
    (groups.get(groupKey) || []).some(({ candidate }) => Number.isFinite(Number(candidate.quantity)) && Number(candidate.quantity) > 0)
  ));
  if (hasExplicitHaulageQuantity) return;
  for (const key of haulageGroupKeys) groups.delete(key);
  const haulageRule = resolveQuoteCatalogRule(quoteCatalog, haulageRuleCode);
  if (!haulageRule || !dump || !(disposalVolumeM3 > 0)) return;
  const haulageLoads = calculateTripCount({
    volumeM3: disposalVolumeM3,
    densityTonnesPerM3,
    truckMassCapacityTonnes,
    truckVolumeCapacityM3,
  });
  const haulagePricing = buildHaulagePricing({
    quoteCatalog,
    loads: haulageLoads,
    dump,
    vehicleHourRuleCode,
    vehicleKmRuleCode,
  });
  if (!haulagePricing) return;
  const haulageSection = groupUtils.resolveDerivedSectionLabel({ groups, groupKeys: haulageGroupKeys })
    || (soilGroups.length > 1 ? multiSectionHaulageSection : soilSection);
  groups.set(groupUtils.buildLineItemGroupKey({ ruleCode: haulageRule.code, section: haulageSection }), [{
    rule: haulageRule,
    candidate: {
      label: haulageRule.label,
      description: `Haulage to ${dump.name} (${distance} km return trip).`,
      quoteCatalogItemCode: haulageRule.code,
      quantity: haulagePricing.loads,
      unit: haulageRule.unit,
      confidence: 0.95,
      rationale: buildSoilHaulageRationale({
        loads: haulagePricing.loads,
        grossCutVolumeM3,
        fillVolumeM3,
        disposalVolumeM3,
        disposalTonnes,
        returnTripDistanceKm: haulagePricing.returnTripDistanceKm,
        returnTripDriveHours: haulagePricing.returnTripDriveHours,
      }),
      evidence: [],
      section: haulageSection,
      unitPrice: haulagePricing.unitPrice,
      totalPrice: haulagePricing.totalPrice,
      unitCost: haulagePricing.unitCost,
      totalCost: haulagePricing.totalCost,
      _measurementDerived: measurementDerived,
      _requiresDerivedPricing: true,
      _pricingIssueCode: haulageRule.code,
      _pricingIssueReason: haulagePricing.pricingIssueReason || null,
    },
  }]);
}

function applyVolumeFromSectionRule({
  groups,
  quoteCatalog,
  measurements,
  breakdownSource,
  rule,
  groupUtils,
}) {
  const sourceRuleCode = rule.sourceRuleCode || null;
  const outputRuleCode = rule.outputRuleCode || null;
  if (!sourceRuleCode || !outputRuleCode) return;

  const outputRule = resolveQuoteCatalogRule(quoteCatalog, outputRuleCode);
  if (!outputRule) return;

  const sectionMatcher = buildSectionMatcher(rule.sourceSectionPattern);
  const sourceGroupKeys = groupUtils.findGroupKeysByRuleCode(groups, sourceRuleCode);
  for (const sourceGroupKey of sourceGroupKeys) {
    const entries = groups.get(sourceGroupKey) || [];
    const section = groupUtils.normalizeSectionLabel(
      entries.find(({ candidate }) => candidate.section)?.candidate?.section
      || groupUtils.extractSectionLabelFromGroupKey(sourceGroupKey)
      || null
    );
    if (sectionMatcher && !sectionMatcher.test(String(section || ""))) continue;
    const volumeM3 = roundQuantity(entries.reduce((sum, { candidate }) => sum + Number(candidate.quantity || 0), 0));
    if (!(volumeM3 > 0)) continue;
    const earthworkInputs = collectEarthworkInputs(entries);
    const earthworkPlan = resolveEarthworkPlan({
      lineItem: {
        section,
        quantity: volumeM3,
        unit: "m3",
        earthworkInputs,
      },
      measurements,
      rule,
    });
    if (!earthworkPlan) continue;
    const pricing = buildVolumeExcavationPricing({
      quoteCatalog,
      earthworkPlan,
      targetRuleCode: outputRule.code,
    });
    const targetSection = section || outputRule.presentation?.defaultSection || rule.outputSection || null;
    const breakdownSourcePlan = findBulkRemovalPlanForSection({ breakdownSource, section });
    groups.set(groupUtils.buildLineItemGroupKey({ ruleCode: outputRule.code, section: targetSection }), [{
      rule: outputRule,
      candidate: {
        label: outputRule.label,
        description: buildEarthworkPlanDescription(earthworkPlan),
        quoteCatalogItemCode: outputRule.code,
        quantity: earthworkPlan.outputQuantityM3,
        unit: outputRule.unit,
        confidence: 0.95,
        rationale: buildEarthworkPlanRationale(earthworkPlan),
        evidence: [],
        section: targetSection,
        unitPrice: pricing?.unitPrice ?? null,
        totalPrice: pricing?.totalPrice ?? null,
        unitCost: pricing?.unitCost ?? null,
        totalCost: pricing?.totalCost ?? null,
        earthworkInputs,
        breakdownSourcePlan: buildBreakdownSourcePlanPreview(breakdownSourcePlan),
        _measurementReferenced: breakdownSourcePlan != null,
        _measurementDerived: entries.some(({ candidate }) => candidate._measurementDerived === true),
      },
    }]);
  }
}

function applyConcreteRemovalPlanRule({
  groups,
  quoteCatalog,
  details,
  rule,
  groupUtils,
}) {
  const outputRuleCode = rule.outputRuleCode || null;
  const haulageRuleCode = rule.haulageRuleCode || null;
  const outputRule = resolveQuoteCatalogRule(quoteCatalog, outputRuleCode);
  const haulageRule = resolveQuoteCatalogRule(quoteCatalog, haulageRuleCode);
  if (!outputRule || !haulageRule) return;

  const surfaceAreasM2 = sumGroupQuantities({
    groups,
    groupKeys: groupUtils.findGroupKeysByRuleCode(groups, rule.surfaceRuleCode || null),
  });
  const structureAreasM2 = sumGroupQuantities({
    groups,
    groupKeys: groupUtils.findGroupKeysByRuleCode(groups, rule.structureRuleCode || null),
  });
  const volumeM3 = roundQuantity(
    (surfaceAreasM2 * (Number(rule.surfaceDepthMm || 100) / 1000))
    + (structureAreasM2 * (Number(rule.structureDepthMm || 300) / 1000))
  );
  if (!(volumeM3 > 0)) return;

  const disposalRuleCode = rule.disposalRuleCode || null;
  const densityTonnesPerM3 = resolveDisposalDensityTonnesPerM3({ quoteCatalog, disposalRuleCode });
  const removalPricing = buildBulkRemovalPricing({
    quoteCatalog,
    volumeM3,
    densityTonnesPerM3,
    truckMassCapacityTonnes: Number(rule.truckMassCapacityTonnes || 3),
    truckVolumeCapacityM3: Number(rule.truckVolumeCapacityM3 || 1.15),
    loadingHoursPerLoad: Number(rule.loadingHoursPerLoad || 1),
    loaderRuleCode: rule.loaderRuleCode || null,
    disposalRuleCode,
  });
  const outputSection = rule.outputSection || "Concrete removal";
  groups.set(groupUtils.buildLineItemGroupKey({ ruleCode: outputRule.code, section: outputSection }), [{
    rule: outputRule,
    candidate: {
      label: outputRule.label,
      description: `Load out and dispose of ${formatQty(volumeM3)} m3 of demolished concrete.`,
      quoteCatalogItemCode: outputRule.code,
      quantity: volumeM3,
      unit: outputRule.unit,
      confidence: 0.95,
      rationale: `${formatQty(surfaceAreasM2)} m2 surface demolition at ${formatQty(Number(rule.surfaceDepthMm || 100))} mm plus ${formatQty(structureAreasM2)} m2 structure demolition at ${formatQty(Number(rule.structureDepthMm || 300))} mm gives ${formatQty(volumeM3)} m3 total concrete to remove.`,
      evidence: [],
      section: outputSection,
      unitPrice: removalPricing?.unitPrice ?? null,
      totalPrice: removalPricing?.totalPrice ?? null,
      unitCost: removalPricing?.unitCost ?? null,
      totalCost: removalPricing?.totalCost ?? null,
      // DEL-46 (P0, round 4): see applySoilDumpPlanRule for why this must
      // propagate into the existing not-quoteable mechanism.
      _requiresDerivedPricing: Boolean(removalPricing?.pricingIssueReason),
      _pricingIssueCode: removalPricing?.pricingIssueReason ? (removalPricing.pricingIssueCode || disposalRuleCode) : null,
      _pricingIssueReason: removalPricing?.pricingIssueReason || null,
    },
  }]);

  const dump = details?.soilDump || DEFAULT_SOIL_DUMP || DEFAULT_SOIL_DUMPS[0] || null;
  if (!dump) return;
  const haulagePricing = buildHaulagePricing({
    quoteCatalog,
    loads: calculateTripCount({
      volumeM3,
      densityTonnesPerM3,
      truckMassCapacityTonnes: Number(rule.truckMassCapacityTonnes || 3),
      truckVolumeCapacityM3: Number(rule.truckVolumeCapacityM3 || 1.15),
    }),
    dump,
    vehicleHourRuleCode: rule.vehicleHourRuleCode || null,
    vehicleKmRuleCode: rule.vehicleKmRuleCode || null,
  });
  const haulageSection = rule.haulageSection || "Concrete haulage";
  groups.set(groupUtils.buildLineItemGroupKey({ ruleCode: haulageRule.code, section: haulageSection }), [{
    rule: haulageRule,
    candidate: {
      label: haulageRule.label,
      description: `Haulage of demolished concrete to ${dump.name}.`,
      quoteCatalogItemCode: haulageRule.code,
      quantity: haulagePricing.loads,
      unit: haulageRule.unit,
      confidence: 0.95,
      rationale: `${haulagePricing.loads} return trips required for ${formatQty(volumeM3)} m3 of concrete waste to ${dump.name}.`,
      evidence: [],
      section: haulageSection,
      unitPrice: haulagePricing.unitPrice,
      totalPrice: haulagePricing.totalPrice,
      unitCost: haulagePricing.unitCost,
      totalCost: haulagePricing.totalCost,
      _requiresDerivedPricing: true,
      _pricingIssueCode: haulageRule.code,
      _pricingIssueReason: haulagePricing.pricingIssueReason || null,
    },
  }]);
}

/**
 * The priced assembly a recipe rule names (quote-catalog data, priced from
 * the catalogue by server/price-catalog/recipe-pricing.js), or null when the
 * quote catalog has none of that mode.
 */
function resolveRecipeAssembly(resolved, rule, mode) {
  const code = rule?.assembly || rule?.code;
  const entry = code ? resolved?.assemblies?.[code] : null;
  return entry && entry.mode === mode ? entry : null;
}

/**
 * A recipe that cannot be priced: no lines, and the problems naming each
 * catalogue item, so the compile fails the line closed instead of guessing.
 */
function unpricedRecipe(code, assembly, problems) {
  return {
    recipe: { code, lines: [], pricingProblems: problems, assembly: { code: assembly.code, version: assembly.version } },
    materialOrders: [],
  };
}

/**
 * The assembly's pricing problems for the components this evaluation uses
 * and charges for. A material-order component (the loam to order) is not
 * priced into the line, so its item's problem does not fail the line: the
 * order carries no rate and the health page reports the item, as before.
 */
function usedComponentProblems(assembly, evaluation) {
  const roles = new Map((assembly?.definition?.components || []).map((component) => [component.key, component.role]));
  return (assembly?.problems || [])
    .filter((problem) => evaluation.byKey[problem.key])
    .filter((problem) => roles.get(problem.key) !== "material_order");
}

function componentRates(assembly, key) {
  const component = assembly?.components?.[key] || null;
  return {
    itemCode: component?.itemCode || null,
    label: component?.label || null,
    unitCost: component?.cost ?? null,
    unitPrice: component?.sell ?? null,
  };
}

function assemblyLineMeta(assembly, key, evaluation) {
  const definition = assembly.definition.components.find((component) => component.key === key);
  const evaluated = evaluation.byKey[key];
  return {
    itemName: evaluated?.label || definition?.label || evaluated?.itemCode,
    itemGroup: null,
    isStockItem: definition?.stock === true,
    stockUom: evaluated?.unit || definition?.unit || "Nos",
  };
}

/** One recipe line for an assembly component, priced from the catalogue. */
function assemblyLine({ assembly, evaluation, key, description, trace, quantity = undefined }) {
  const component = evaluation.byKey[key];
  const rates = componentRates(assembly, key);
  return exactLine({
    itemCode: rates.itemCode || component.itemCode,
    label: component.label,
    description,
    quantity: quantity === undefined ? component.quantity : quantity,
    unit: component.unit,
    unitCost: rates.unitCost,
    unitPrice: rates.unitPrice,
    itemMeta: assemblyLineMeta(assembly, key, evaluation),
    trace,
  });
}

/** The quote rule an assembly decomposes (its first), for traces. */
function assemblyRuleCode(assembly) {
  return assembly?.definition?.appliesToRuleCodes?.[0] || assembly?.code || null;
}

function recipeTraceEngine(recipe, ruleCode) {
  return {
    id: "quote-quantity-rules",
    label: "Quantity Rule Engine",
    module: "apps/field/server/quote-quantity-rules.js",
    recipe,
    ruleCode,
  };
}

function resolveLawnBundleDemand({
  lineItem,
  quote,
  resolved,
  baseRuleCode,
  rule,
}) {
  if (!matchesRuleCode(rule, baseRuleCode) && !isLawnOption(lineItem)) return null;
  const areaM2 = resolveLineAreaSquareMetres({ lineItem, quote });
  const assembly = resolveRecipeAssembly(resolved, rule, "lawn_bundle");
  if (!(areaM2 > 0) || !assembly) return null;

  const loamDepthMetres = resolveLoamDepthMetres({ lineItem, quote });
  const evaluation = evaluateAssembly(assembly.definition, {
    area_m2: areaM2,
    ...(loamDepthMetres != null ? { loam_depth_m: loamDepthMetres } : {}),
  });
  const problems = usedComponentProblems(assembly, evaluation);
  if (problems.length && isLawnOption(lineItem)) return unpricedRecipe("lawn_option", assembly, problems);
  const recipeLines = problems.length ? [] : buildLawnRecipeLines({ lineItem, areaM2, assembly, evaluation });
  const materialOrders = [
    ...buildMaterialOrdersFromLines({
      lineItem,
      lines: recipeLines,
      source: "quantity_rule_recipe",
    }),
    buildLoamMaterialOrder({
      lineItem,
      areaM2,
      assembly,
      evaluation,
    }),
  ].filter(Boolean);

  return {
    recipe: isLawnOption(lineItem)
      ? {
          code: "lawn_option",
          lines: recipeLines,
          pricingProblems: usedComponentProblems(assembly, evaluation),
          assembly: { code: assembly.code, version: assembly.version },
        }
      : null,
    materialOrders,
  };
}

function resolveDrainageBundleDemand({
  lineItem,
  quote,
  resolved,
  baseRuleCode,
  rule,
}) {
  if (!matchesRuleCode(rule, baseRuleCode) && !isDrainageLineItem(lineItem, baseRuleCode, rule)) {
    return null;
  }
  const assembly = resolveRecipeAssembly(resolved, rule, "drainage_bundle");
  if (!assembly) return null;

  const lengthM = resolveLineLengthMetres({ lineItem, quote });
  if (!(lengthM > 0)) return null;

  const statedPits = resolveStatedPitCount(lineItem);
  const evaluation = evaluateAssembly(assembly.definition, {
    length_m: lengthM,
    explicit_pits: statedPits != null ? 1 : 0,
    stated_pit_count: statedPits ?? 0,
  });
  const problems = usedComponentProblems(assembly, evaluation);
  if (problems.length) return unpricedRecipe("drainage_bundle", assembly, problems);
  const { vars, byKey } = evaluation;
  const pitCount = byKey.pit.quantity;
  const lineCharge = (key) => computeRoundedLineTotal(byKey[key].quantity, componentRates(assembly, key).unitPrice);
  const adminCharge = componentRates(assembly, "admin").unitPrice;
  const vehicleRates = componentRates(assembly, "delivery");
  const vehicleCharge = vehicleRates.unitPrice;

  const residualDeliveryCharge = roundMoney(
    Number(lineItem.totalPrice || 0)
      - lineCharge("pipe")
      - lineCharge("pit")
      - lineCharge("gravel")
      - lineCharge("disposal")
      - lineCharge("excavator")
      - lineCharge("labour")
      - adminCharge
  );
  if (residualDeliveryCharge < 0) return null;
  const deliveryHours = vehicleCharge > 0 ? residualDeliveryCharge / vehicleCharge : 0;

  const traceEngine = { ...recipeTraceEngine("drainage_bundle", baseRuleCode), assembly: assembly.code, assemblyVersion: assembly.version };
  const line = (key, description, trace, quantity) => assemblyLine({ assembly, evaluation, key, description, trace, quantity });

  const recipeLines = [
    line("pipe", `PVC drainage pipe supply for ${formatQty(lengthM)} m trench.`, {
      engine: traceEngine,
      formulas: [
        {
          label: "Pipe quantity",
          expression: `${formatQty(lengthM)} m trench × 1 = ${formatQty(byKey.pipe.quantity)} m pipe.`,
        },
      ],
      inputs: [{ label: "Trench length", value: lengthM, unit: "m" }],
    }),
    line("pit", `${pitCount} stormwater/junction pit${pitCount === 1 ? "" : "s"} for drainage run.`, {
      engine: traceEngine,
      formulas: [
        {
          label: "Pit count",
          expression: `${formatQty(lengthM)} m ÷ ${formatQty(vars.pit_spacing_m)} m per pit (min 1) = ${pitCount} pit(s).`,
        },
      ],
      inputs: [
        { label: "Trench length", value: lengthM, unit: "m" },
        { label: "Pit spacing", value: vars.pit_spacing_m, unit: "m" },
      ],
    }),
    line("gravel", `Drainage gravel backfill for ${formatQty(lengthM)} m trench.`, {
      engine: traceEngine,
      formulas: [
        {
          label: "Gravel quantity",
          expression: `${formatQty(lengthM)} m trench × 1 = ${formatQty(byKey.gravel.quantity)} m gravel backfill.`,
        },
      ],
    }),
    line("disposal", `Trench spoil disposal allowance for ${formatQty(lengthM)} m drainage run.`, {
      engine: traceEngine,
      formulas: [
        {
          label: "Disposal allowance",
          expression: `${formatQty(lengthM)} m trench × spoil disposal rate.`,
        },
      ],
    }),
    line("excavator", `Trench excavation at ${formatQty(vars.excavator_hours_per_m)} hr/m.`, {
      engine: traceEngine,
      formulas: [
        {
          label: "Excavator hours",
          expression: `${formatQty(lengthM)} m × ${formatQty(vars.excavator_hours_per_m)} hr/m = ${formatQty(byKey.excavator.quantity)} hours.`,
        },
      ],
    }),
    line("labour", `Drainage install labour for ${formatQty(lengthM)} m run and ${pitCount} pit${pitCount === 1 ? "" : "s"}.`, {
      engine: traceEngine,
      formulas: [
        {
          label: "Install labour",
          expression: `${formatQty(lengthM)} m × ${formatQty(vars.labour_hours_per_m)} hr/m = ${formatQty(byKey.labour.quantity)} hours.`,
        },
      ],
    }),
    line("delivery", "Delivery, travel, and supplier run allowance for drainage materials.", {
      engine: traceEngine,
      formulas: [
        {
          label: "Delivery vehicle hours",
          expression: `${formatMoney(residualDeliveryCharge)} residual delivery allowance ÷ ${formatMoney(vehicleCharge)} / hr = ${formatQty(deliveryHours)} vehicle hours.`,
        },
      ],
      inputs: [
        { label: "Residual delivery allowance", value: residualDeliveryCharge, format: "money" },
        { label: "Vehicle charge / hour", value: vehicleCharge, format: "money" },
      ],
    }, roundQuantity(deliveryHours)),
    line("admin", "Office, scheduling, and admin overhead allowance for drainage works.", {
      engine: traceEngine,
      formulas: [
        {
          label: "Admin allocation",
          expression: `Standard per-line admin allocation applied to drainage bundle.`,
        },
      ],
    }),
  ];

  return {
    recipe: {
      code: "drainage_bundle",
      lines: recipeLines,
      pricingProblems: usedComponentProblems(assembly, evaluation),
      assembly: { code: assembly.code, version: assembly.version },
    },
    materialOrders: buildMaterialOrdersFromLines({
      lineItem,
      lines: recipeLines,
      source: "quantity_rule_recipe",
    }),
  };
}

function resolveIrrigationBundleDemand({
  lineItem,
  quote,
  resolved,
  baseRuleCode,
  rule,
}) {
  if (!matchesRuleCode(rule, baseRuleCode) && !isIrrigationOption(lineItem)) return null;
  const assembly = resolveRecipeAssembly(resolved, rule, "irrigation_bundle");
  const components = buildIrrigationBundleComponents({ lineItem, quote, assembly });
  if (!components) return null;

  return {
    recipe: isIrrigationOption(lineItem)
      ? {
          code: "irrigation_option",
          lines: components.recipeLines,
          pricingProblems: components.pricingProblems,
          assembly: { code: assembly.code, version: assembly.version },
        }
      : null,
    materialOrders: buildMaterialOrdersFromLines({
      lineItem,
      lines: components.recipeLines,
      source: "quantity_rule_recipe",
    }),
  };
}

function resolveVolumeExcavationDemand({
  lineItem,
  quote,
  quoteCatalog,
  baseRuleCode,
  rule,
}) {
  if (!matchesRuleCode(rule, baseRuleCode)) return null;
  const volumeM3 = resolveVolumeCubicMetres(lineItem);
  if (!(volumeM3 > 0)) return null;

  const earthworkPlan = resolveEarthworkPlan({
    lineItem,
    measurements: quote?.measurements,
    rule,
  });
  if (!earthworkPlan) return null;

  const recipeLines = buildVolumeExcavationRecipeLines({
    quoteCatalog,
    earthworkPlan,
    recipeCode: "volume_excavation",
    targetRuleCode: baseRuleCode,
    scopeLabel: "site levelling and cut",
  });
  if (!recipeLines.length) return null;

  return {
    recipe: {
      code: "volume_excavation",
      lines: recipeLines,
    },
    materialOrders: [],
  };
}

function resolveBulkLoadingDisposalDemand({
  lineItem,
  quoteCatalog,
  baseRuleCode,
  rule,
}) {
  if (!matchesRuleCode(rule, baseRuleCode)) return null;
  const volumeM3 = resolveVolumeCubicMetres(lineItem);
  if (!(volumeM3 > 0)) return null;

  const bulkRemovalPlan = resolveBulkRemovalPlan({
    source: lineItem,
    fallbackGrossCutVolumeM3: volumeM3,
  });
  const disposalRuleCode = rule.disposalRuleCode || null;
  const disposalRule = resolveQuoteCatalogRule(quoteCatalog, disposalRuleCode);
  const densityTonnesPerM3 = resolveDisposalDensityTonnesPerM3({ quoteCatalog, disposalRuleCode });
  const loadingMetrics = resolveBulkRemovalMetrics({
    volumeM3: bulkRemovalPlan.grossCutVolumeM3,
    densityTonnesPerM3,
    truckMassCapacityTonnes: Number(rule.truckMassCapacityTonnes || 0),
    truckVolumeCapacityM3: Number(rule.truckVolumeCapacityM3 || 0),
    loadingHoursPerLoad: Number(rule.loadingHoursPerLoad || 0),
  });
  if (!loadingMetrics) return null;

  const loaderRule = resolveQuoteCatalogRule(quoteCatalog, rule.loaderRuleCode || null);
  const disposalBillable = resolveDisposalBillableQuantity({
    disposalRule,
    volumeM3: bulkRemovalPlan.disposalVolumeM3,
  });
  const loadingLine = buildBulkLoadingLine({
    quoteCatalog,
    componentRule: loaderRule,
    componentRuleCode: rule.loaderRuleCode || null,
    targetRuleCode: baseRuleCode,
    recipeCode: "bulk_loading_disposal",
    hours: loadingMetrics.loadingHours,
    volumeM3: bulkRemovalPlan.grossCutVolumeM3,
    tonnes: loadingMetrics.tonnes,
  });
  const disposalLine = bulkRemovalPlan.disposalVolumeM3 > 0
    ? buildBulkDisposalLine({
        quoteCatalog,
        componentRule: disposalRule,
        componentRuleCode: disposalRuleCode,
        targetRuleCode: baseRuleCode,
        recipeCode: "bulk_loading_disposal",
        billable: disposalBillable,
        volumeM3: bulkRemovalPlan.disposalVolumeM3,
      })
    : null;
  // DEL-46 (P0, round 4): an unresolvable disposal basis must not leave the
  // internal cost breakdown looking complete with only the loader line —
  // that misreports internal cost the same way the customer-facing path
  // would misreport price. Report no recipe at all; the caller
  // (compileLineItemBreakdown) then falls through to the direct pass-through
  // pricer, which independently detects the missing rate and records a
  // pricing issue through the existing mechanism (buildDirectPricingIssue).
  if (bulkRemovalPlan.disposalVolumeM3 > 0 && !disposalLine) {
    // DEL-46 (round 6): see the matching comment in buildBulkRemovalPricing
    // — distinguish "basis/factor unresolved" from "basis is fine but there
    // is no positive sell price" so the operator-facing message points at
    // the actual gap.
    const pricingIssueReason = disposalBillable
      ? `Missing disposal pricing for ${disposalRule?.code || disposalRuleCode}: the disposal item has a valid costing basis but no positive sell price.`
      : `Missing disposal pricing for ${disposalRule?.code || disposalRuleCode}: the disposal item's costing basis (pricing_basis / pricing_basis_factor) is missing, incomplete, or unresolved.`;
    console.warn(`[quote-quantity-rules] ${pricingIssueReason}`);
    return {
      recipe: null,
      materialOrders: [],
      pricingIssueReason,
      pricingIssueCode: disposalRule?.code || disposalRuleCode,
    };
  }

  const recipeLines = [loadingLine, disposalLine].filter(Boolean);
  if (!recipeLines.length) return null;

  return {
    recipe: {
      code: "bulk_loading_disposal",
      lines: recipeLines,
    },
    materialOrders: [],
  };
}

function resolveHaulageTripDemand({
  lineItem,
  quoteCatalog,
  details,
  baseRuleCode,
  rule,
}) {
  if (!matchesRuleCode(rule, baseRuleCode)) return null;
  const loads = roundQuantity(Number(lineItem?.quantity || 0));
  if (!(loads > 0)) return null;
  const dump = resolveDumpForJob(details);
  if (!dump) return null;

  const vehicleHourRule = resolveQuoteCatalogRule(quoteCatalog, rule.vehicleHourRuleCode || null);
  const vehicleKmRule = resolveQuoteCatalogRule(quoteCatalog, rule.vehicleKmRuleCode || null);
  const returnTripDriveHours = roundQuantity((Number(dump.drive || 0) * 2) / 60);
  const returnTripDistanceKm = roundQuantity(Number(dump.dist || 0) * 2);
  const recipeLines = [
    buildHaulageVehicleHourLine({
      componentRule: vehicleHourRule,
      componentRuleCode: rule.vehicleHourRuleCode || null,
      targetRuleCode: baseRuleCode,
      loads,
      returnTripDriveHours,
      dump,
    }),
    buildHaulageVehicleKmLine({
      componentRule: vehicleKmRule,
      componentRuleCode: rule.vehicleKmRuleCode || null,
      targetRuleCode: baseRuleCode,
      loads,
      returnTripDistanceKm,
      dump,
    }),
  ].filter(Boolean);
  if (!recipeLines.length) return null;

  return {
    recipe: {
      code: "haulage_trip",
      lines: recipeLines,
    },
    materialOrders: [],
  };
}

function resolveDirectMaterialOrderDemand({
  lineItem,
  quoteCatalog,
  baseRuleCode,
  rule,
}) {
  if (!matchesRuleCode(rule, baseRuleCode)) return null;
  const inputQuantity = Number(lineItem?.quantity || 0);
  const quantityMultiplier = Number(rule.quantityMultiplier || 1);
  const outputQuantity = roundQuantity(inputQuantity * quantityMultiplier);
  if (!(outputQuantity > 0)) return null;

  const baseRule = resolveQuoteCatalogRule(quoteCatalog, baseRuleCode);
  const itemMeta = baseRule?.authorityPricing?.itemCode
    ? {
        itemName: baseRule.authorityPricing.itemName || rule.outputLabel || lineItem.label || baseRuleCode,
        itemGroup: baseRule.authorityPricing.itemGroup || null,
        isStockItem: Boolean(baseRule.authorityPricing.isStockItem),
        stockUom: baseRule.authorityPricing.stockUom || rule.outputUnit || lineItem.unit || "Nos",
      }
    : {
        itemName: rule.outputLabel || lineItem.label || baseRuleCode,
        itemGroup: null,
        isStockItem: false,
        stockUom: rule.outputUnit || lineItem.unit || "Nos",
      };

  return {
    recipe: null,
    materialOrders: [
      buildMaterialOrder({
        itemCode: rule.outputItemCode || baseRuleCode,
        label: rule.outputLabel || lineItem.label || baseRuleCode,
        description: renderTemplate(rule.descriptionTemplate, {
          quantity: formatQty(outputQuantity),
          inputQuantity: formatQty(inputQuantity),
        }) || lineItem.rationale || lineItem.scopeSummary || lineItem.label || "Derived material demand.",
        quantity: outputQuantity,
        unit: rule.outputUnit || lineItem.unit || itemMeta.stockUom || "Nos",
        sourceLineItemCode: lineItem.code || null,
        section: lineItem.section || null,
        itemMeta,
        unitCost: baseRule?.authorityPricing?.buyingRate ?? null,
        unitPrice: baseRule?.authorityPricing?.sellingRate ?? null,
        calculation: {
          inputQuantity,
          quantityMultiplier,
          quantity: outputQuantity,
        },
        source: "quantity_rule_direct",
      }),
    ],
  };
}

function resolveSupplyInstallBundleDemand({
  lineItem,
  quoteCatalog,
  resolved,
  baseRuleCode,
  rule,
}) {
  if (!matchesRuleCode(rule, baseRuleCode)) return null;
  const quantity = Number(lineItem?.quantity || 0);
  if (!(quantity > 0)) return null;

  const parentRule = resolveQuoteCatalogRule(quoteCatalog, baseRuleCode);
  const execution = parentRule?.execution || {};
  const labourHoursPerUnit = Number(execution.labourHoursPerUnit || 0);
  const machineHoursPerUnit = Number(execution.machineHoursPerUnit || 0);

  // The labour (and optional machine) rule is named by the quantity rule;
  // there is no default rule code.
  const labourRuleCode = rule.labourRuleCode || null;
  const labourRule = labourRuleCode ? resolveQuoteCatalogRule(quoteCatalog, labourRuleCode) : null;
  if (!labourRule) return null;
  const labourRates = resolveRuleRates(labourRule);

  const machineRuleCode = rule.machineRuleCode || null;
  const machineRule = machineRuleCode ? resolveQuoteCatalogRule(quoteCatalog, machineRuleCode) : null;
  const machineRates = machineRule ? resolveRuleRates(machineRule) : null;

  const parentSellingRate = parentRule?.authorityPricing?.sellingRate != null
    ? Number(parentRule.authorityPricing.sellingRate)
    : null;
  if (parentSellingRate == null) return null;

  // A missing labour or machine rate leaves the split unpriced (fail closed),
  // never zero.
  const labourChargePerUnit = labourRates.unitPrice != null ? labourHoursPerUnit * labourRates.unitPrice : null;
  const machineChargePerUnit = machineHoursPerUnit > 0 && machineRates
    ? (machineRates.unitPrice != null ? machineHoursPerUnit * machineRates.unitPrice : null)
    : 0;
  const materialChargePerUnit = labourChargePerUnit == null || machineChargePerUnit == null
    ? null
    : roundMoney(parentSellingRate - labourChargePerUnit - machineChargePerUnit);

  // The materials' cost is the catalogue's own stock-materials item when it
  // has one, else the balance of the parent item's catalogue cost after its
  // labour and machine cost (the same balance the catalogue roll-up gives
  // its recipe kits, server/catalog/rollup.js). Never a guessed share of the
  // charge: with neither, the line is unpriced and fails closed.
  const stockMaterialsCode = `${baseRuleCode}__stock-materials`;
  const stockMaterialsRule = resolveQuoteCatalogRule(quoteCatalog, stockMaterialsCode);
  const parentBuyingRate = parentRule?.authorityPricing?.buyingRate != null
    ? Number(parentRule.authorityPricing.buyingRate)
    : null;
  const labourCostPerUnit = labourRates.unitCost != null ? labourHoursPerUnit * labourRates.unitCost : null;
  const machineCostPerUnit = machineHoursPerUnit > 0 && machineRates
    ? (machineRates.unitCost != null ? machineHoursPerUnit * machineRates.unitCost : null)
    : 0;
  const materialCostPerUnit = stockMaterialsRule?.authorityPricing?.buyingRate != null
    ? roundMoney(Number(stockMaterialsRule.authorityPricing.buyingRate))
    : parentBuyingRate != null && labourCostPerUnit != null && machineCostPerUnit != null
      ? roundMoney(Math.max(0, parentBuyingRate - labourCostPerUnit - machineCostPerUnit))
      : null;

  if (materialChargePerUnit != null && materialChargePerUnit <= 0) return null;

  const materialItemCode = stockMaterialsRule?.authorityPricing?.itemCode || stockMaterialsCode;
  const materialLabel = stockMaterialsRule?.label
    || parentRule?.label
    || lineItem?.label
    || baseRuleCode;
  const parentUnit = parentRule?.unit || lineItem?.unit || "unit";

  const recipeLines = [
    exactLine({
      itemCode: materialItemCode,
      label: materialLabel,
      description: `Material supply for ${formatQty(quantity)} ${parentUnit}.`,
      quantity,
      unit: parentUnit,
      unitCost: materialCostPerUnit,
      unitPrice: materialChargePerUnit,
      trace: {
        engine: {
          id: "quote-quantity-rules",
          label: "Quantity Rule Engine",
          module: "apps/field/server/quote-quantity-rules.js",
          recipe: "supply_install_bundle",
          ruleCode: baseRuleCode,
        },
        formulas: [{
          label: "Material (residual)",
          expression: `${formatMoney(parentSellingRate)}/unit − ${formatMoney(labourChargePerUnit)} labour − ${formatMoney(machineChargePerUnit)} machine = ${formatMoney(materialChargePerUnit)}/unit material charge.`,
        }],
        inputs: [
          { label: "Quantity", value: quantity, unit: parentUnit },
          { label: "Parent sell rate", value: parentSellingRate, unit: "$/unit" },
        ],
      },
    }),
    exactLine({
      itemCode: resolveAuthorityItemCode(labourRule, labourRuleCode),
      label: labourRule.label,
      description: `Installation labour for ${formatQty(quantity)} ${parentUnit}.`,
      quantity: quantity * labourHoursPerUnit,
      unit: "hour",
      unitCost: labourRates.unitCost,
      unitPrice: labourRates.unitPrice,
      trace: {
        engine: {
          id: "quote-quantity-rules",
          label: "Quantity Rule Engine",
          module: "apps/field/server/quote-quantity-rules.js",
          recipe: "supply_install_bundle",
          ruleCode: baseRuleCode,
        },
        formulas: [{
          label: "Installation labour",
          expression: `${formatQty(quantity)} × ${formatQty(labourHoursPerUnit)} hr/unit = ${formatQty(quantity * labourHoursPerUnit)} hours.`,
        }],
        inputs: [
          { label: "Quantity", value: quantity, unit: parentUnit },
          { label: "Labour rate", value: labourHoursPerUnit, unit: "hr/unit" },
        ],
      },
    }),
    ...(machineHoursPerUnit > 0 && machineRates && machineRule
      ? [
          exactLine({
            itemCode: resolveAuthorityItemCode(machineRule, machineRuleCode),
            label: machineRule?.label || machineRuleCode,
            description: `Machine time for ${formatQty(quantity)} ${parentUnit}.`,
            quantity: quantity * machineHoursPerUnit,
            unit: "hour",
            unitCost: machineRates.unitCost,
            unitPrice: machineRates.unitPrice,
            trace: {
              engine: {
                id: "quote-quantity-rules",
                label: "Quantity Rule Engine",
                module: "apps/field/server/quote-quantity-rules.js",
                recipe: "supply_install_bundle",
                ruleCode: baseRuleCode,
              },
              formulas: [{
                label: "Machine hours",
                expression: `${formatQty(quantity)} × ${formatQty(machineHoursPerUnit)} hr/unit = ${formatQty(quantity * machineHoursPerUnit)} hours.`,
              }],
              inputs: [
                { label: "Quantity", value: quantity, unit: parentUnit },
                { label: "Machine rate", value: machineHoursPerUnit, unit: "hr/unit" },
              ],
            },
          }),
        ]
      : []),
  ];

  return {
    recipe: {
      code: "supply_install_bundle",
      lines: recipeLines,
    },
    materialOrders: [
      buildMaterialOrder({
        itemCode: materialItemCode,
        label: materialLabel,
        description: `Material supply for ${formatQty(quantity)} ${parentUnit}.`,
        quantity,
        unit: parentUnit,
        sourceLineItemCode: lineItem.code || null,
        section: lineItem.section || null,
        itemMeta: {
          itemName: stockMaterialsRule?.authorityPricing?.itemName || materialLabel,
          itemGroup: stockMaterialsRule?.authorityPricing?.itemGroup || "Raw Material",
          isStockItem: true,
          stockUom: stockMaterialsRule?.authorityPricing?.stockUom || parentUnit,
        },
        unitCost: materialCostPerUnit,
        unitPrice: materialChargePerUnit,
        calculation: {
          parentSellingRate,
          labourChargePerUnit,
          machineChargePerUnit,
          materialChargePerUnit,
        },
        source: "quantity_rule_recipe",
      }),
    ],
  };
}

function resolveConcreteSurfaceDemolitionDemand({
  lineItem,
  quote,
  quoteCatalog,
  baseRuleCode,
  rule,
}) {
  return resolveConcreteDemolitionDemand({
    lineItem,
    quote,
    quoteCatalog,
    baseRuleCode,
    rule,
    recipeCode: "concrete_surface_demolition",
    scopeLabel: "concrete surface demolition",
    thicknessLabel: "depth",
  });
}

function resolveConcreteStructureDemolitionDemand({
  lineItem,
  quote,
  quoteCatalog,
  baseRuleCode,
  rule,
}) {
  return resolveConcreteDemolitionDemand({
    lineItem,
    quote,
    quoteCatalog,
    baseRuleCode,
    rule,
    recipeCode: "concrete_structure_demolition",
    scopeLabel: "concrete structure demolition",
    thicknessLabel: "thickness",
  });
}

function resolveConcreteDemolitionDemand({
  lineItem,
  quote,
  quoteCatalog,
  baseRuleCode,
  rule,
  recipeCode,
  scopeLabel,
  thicknessLabel,
}) {
  if (!matchesRuleCode(rule, baseRuleCode)) return null;
  const areaM2 = resolveLineAreaSquareMetres({ lineItem, quote });
  const areaPerHour = Number(rule.areaPerHour || 15);
  if (!(areaM2 > 0) || !(areaPerHour > 0)) return null;

  // The machine rules are named by the quantity rule (no default codes).
  const componentRuleCodes = Array.isArray(rule.componentRuleCodes) ? rule.componentRuleCodes : [];
  if (!componentRuleCodes.length) return null;
  const hours = roundQuantity(areaM2 / areaPerHour);
  const maxDepthMm = Number(rule.maxDepthMm || 100);
  const recipeLines = componentRuleCodes
    .map((componentRuleCode) => buildConcreteDemolitionLine({
      lineItem,
      quoteCatalog,
      areaM2,
      areaPerHour,
      hours,
      maxDepthMm,
      componentRuleCode,
      targetRuleCode: baseRuleCode,
      recipeCode,
      scopeLabel,
      thicknessLabel,
    }))
    .filter(Boolean);

  if (!recipeLines.length) return null;

  return {
    recipe: {
      code: recipeCode,
      lines: recipeLines,
    },
    materialOrders: [],
  };
}

function buildConcreteDemolitionLine({
  lineItem,
  quoteCatalog,
  areaM2,
  areaPerHour,
  hours,
  maxDepthMm,
  componentRuleCode,
  targetRuleCode,
  recipeCode,
  scopeLabel,
  thicknessLabel,
}) {
  const componentRule = resolveQuoteCatalogRule(quoteCatalog, componentRuleCode);
  const rates = resolveRuleRates(componentRule);
  if (rates.unitPrice == null || rates.unitCost == null) return null;

  return exactLine({
    itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
    label: componentRule?.label || componentRuleCode,
    description: `${componentRule?.label || componentRuleCode} allowance for ${scopeLabel} up to ${Math.round(maxDepthMm)} mm ${thicknessLabel}.`,
    quantity: hours,
    unit: componentRule?.unit || componentRule?.authorityPricing?.stockUom || "hour",
    unitCost: rates.unitCost,
    unitPrice: rates.unitPrice,
    trace: {
      engine: {
        id: "quote-quantity-rules",
        label: "Quantity Rule Engine",
        module: "apps/field/server/quote-quantity-rules.js",
        recipe: recipeCode,
        ruleCode: targetRuleCode,
        itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
      },
      formulas: [
        {
          label: `${componentRule?.label || componentRuleCode} hours`,
          expression: `${formatQty(areaM2)} m2 demolition area ÷ ${formatQty(areaPerHour)} m2/hr = ${formatQty(hours)} hours.`,
        },
      ],
      inputs: [
        { label: "Demolition area", value: areaM2, unit: "m2" },
        { label: "Productivity", value: areaPerHour, unit: "m2/hr" },
        { label: `Maximum ${thicknessLabel}`, value: maxDepthMm, unit: "mm" },
      ],
    },
  });
}

function buildVolumeExcavationRecipeLines({
  quoteCatalog,
  earthworkPlan,
  recipeCode,
  targetRuleCode,
  scopeLabel,
}) {
  return (earthworkPlan?.steps || []).map((step) => {
    const componentRuleCode = step.ruleCode;
    const componentRule = resolveQuoteCatalogRule(quoteCatalog, componentRuleCode);
    const rates = resolveRuleRates(componentRule);
    if (rates.unitPrice == null || rates.unitCost == null) return null;
    const hours = roundQuantity(step.volumeM3 / Math.max(step.volumePerHour, 0.0001));
    return exactLine({
      itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
      label: componentRule?.label || componentRuleCode,
      description: `${componentRule?.label || componentRuleCode} allowance for ${step.scopeLabel || scopeLabel}.`,
      quantity: hours,
      unit: componentRule?.unit || componentRule?.authorityPricing?.stockUom || "hour",
      unitCost: rates.unitCost,
      unitPrice: rates.unitPrice,
      trace: {
        engine: {
          id: "quote-quantity-rules",
          label: "Quantity Rule Engine",
          module: "apps/field/server/quote-quantity-rules.js",
          recipe: recipeCode,
          ruleCode: targetRuleCode,
          itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
        },
        formulas: [
          {
            label: `${componentRule?.label || componentRuleCode} hours`,
            expression: `${formatQty(step.volumeM3)} m3 ÷ ${formatQty(step.volumePerHour)} m3/hr = ${formatQty(hours)} hours.`,
          },
        ],
        inputs: [
          { label: `${capitalize(step.kind)} volume`, value: step.volumeM3, unit: "m3" },
          { label: "Production rate", value: step.volumePerHour, unit: "m3/hr" },
        ],
      },
    });
  }).filter(Boolean);
}

function buildBulkLoadingLine({
  componentRule,
  componentRuleCode,
  targetRuleCode,
  recipeCode,
  hours,
  volumeM3,
  tonnes,
}) {
  const rates = resolveRuleRates(componentRule);
  if (rates.unitPrice == null || rates.unitCost == null) return null;
  // Mass (tonnes) is only meaningful for a per_tonne disposal basis; per_load
  // and per_m3 items never resolve a tonnage (resolveBulkRemovalMetrics
  // returns tonnes: null for them). Omit the mass clause entirely rather
  // than printing formatQty(null) as a literal "0 t", which would state a
  // false physical fact on a customer-facing document (DEL-46).
  const hasTonnes = tonnes != null;
  return exactLine({
    itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
    label: componentRule?.label || componentRuleCode,
    description: hasTonnes
      ? `${componentRule?.label || componentRuleCode} allowance to load ${formatQty(volumeM3)} m3 (${formatQty(tonnes)} t).`
      : `${componentRule?.label || componentRuleCode} allowance to load ${formatQty(volumeM3)} m3.`,
    quantity: hours,
    unit: componentRule?.unit || componentRule?.authorityPricing?.stockUom || "hour",
    unitCost: rates.unitCost,
    unitPrice: rates.unitPrice,
    trace: {
      engine: {
        id: "quote-quantity-rules",
        label: "Quantity Rule Engine",
        module: "apps/field/server/quote-quantity-rules.js",
        recipe: recipeCode,
        ruleCode: targetRuleCode,
        itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
      },
      formulas: [
        {
          label: `${componentRule?.label || componentRuleCode} hours`,
          expression: hasTonnes
            ? `Loading allowance = ${formatQty(hours)} hours for ${formatQty(volumeM3)} m3 / ${formatQty(tonnes)} t.`
            : `Loading allowance = ${formatQty(hours)} hours for ${formatQty(volumeM3)} m3.`,
        },
      ],
      inputs: [
        { label: "Removal volume", value: volumeM3, unit: "m3" },
        hasTonnes ? { label: "Removal mass", value: tonnes, unit: "tonne" } : null,
      ].filter(Boolean),
    },
  });
}

/**
 * Bills the disposal item in its own costing basis unit — per_tonne, per_load,
 * or per_m3 — resolved by `billable` (see resolveDisposalBillableQuantity).
 * `billable` is null when the disposal item's basis/factor can't be resolved
 * (missing item, missing authority data, or an inconsistent catalogue entry);
 * this returns null in that case rather than guessing a quantity or unit, so
 * the line falls back to the existing not-quoteable pricing status (DEL-46).
 */
function buildBulkDisposalLine({
  componentRule,
  componentRuleCode,
  targetRuleCode,
  recipeCode,
  billable,
  volumeM3,
}) {
  if (!billable) return null;
  const rates = resolveRuleRates(componentRule);
  // A disposal item can have a valid basis/factor (billable resolves) but no
  // sell price set — mirror isRuleQuoteable's > 0 threshold, not just a
  // null check, so a resolved-but-zero rate is also treated as unresolved.
  // A bare `== null` check alone would still let a real $0 disposal line
  // through undetected (DEL-46, round 6).
  if (rates.unitPrice == null || !(rates.unitPrice > 0) || rates.unitCost == null) return null;
  const { basis, factor, quantity, unit } = billable;
  const unitLabel = unit === "tonne" ? "t" : unit;
  return exactLine({
    itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
    label: componentRule?.label || componentRuleCode,
    description: `${componentRule?.label || componentRuleCode} for ${formatQty(quantity)} ${unitLabel} of waste.`,
    quantity,
    unit,
    unitCost: rates.unitCost,
    unitPrice: rates.unitPrice,
    trace: {
      engine: {
        id: "quote-quantity-rules",
        label: "Quantity Rule Engine",
        module: "apps/field/server/quote-quantity-rules.js",
        recipe: recipeCode,
        ruleCode: targetRuleCode,
        itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
      },
      formulas: [
        {
          label: "Disposal billable quantity",
          expression: describeDisposalBasisExpression({ basis, factor, volumeM3, quantity, unit }),
        },
      ],
      inputs: [
        { label: "Removal volume", value: volumeM3, unit: "m3" },
        basis === "per_tonne" ? { label: "Density", value: factor, unit: "t/m3" } : null,
        basis === "per_load" ? { label: "Load capacity", value: factor, unit: "m3/load" } : null,
      ].filter(Boolean),
    },
  });
}

function buildHaulageVehicleHourLine({
  componentRule,
  componentRuleCode,
  targetRuleCode,
  loads,
  returnTripDriveHours,
  dump,
}) {
  const rates = resolveRuleRates(componentRule);
  if (rates.unitPrice == null || rates.unitCost == null) return null;
  const quantity = roundQuantity(loads * returnTripDriveHours);
  return exactLine({
    itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
    label: componentRule?.label || componentRuleCode,
    description: `Truck driving time for ${loads} return trips to ${dump?.name || "the dump"}.`,
    quantity,
    unit: componentRule?.unit || componentRule?.authorityPricing?.stockUom || "hour",
    unitCost: rates.unitCost,
    unitPrice: rates.unitPrice,
    trace: {
      engine: {
        id: "quote-quantity-rules",
        label: "Quantity Rule Engine",
        module: "apps/field/server/quote-quantity-rules.js",
        recipe: "haulage_trip",
        ruleCode: targetRuleCode,
        itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
      },
      formulas: [
        {
          label: `${componentRule?.label || componentRuleCode} hours`,
          expression: `${formatQty(loads)} loads × ${formatQty(returnTripDriveHours)} hr return drive/load = ${formatQty(quantity)} hours.`,
        },
      ],
      inputs: [
        { label: "Loads", value: loads, unit: "load" },
        { label: "Return drive per load", value: returnTripDriveHours, unit: "hour" },
      ],
    },
  });
}

function buildHaulageVehicleKmLine({
  componentRule,
  componentRuleCode,
  targetRuleCode,
  loads,
  returnTripDistanceKm,
  dump,
}) {
  const rates = resolveRuleRates(componentRule);
  if (rates.unitPrice == null || rates.unitCost == null) return null;
  const quantity = roundQuantity(loads * returnTripDistanceKm);
  return exactLine({
    itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
    label: componentRule?.label || componentRuleCode,
    description: `Truck distance for ${loads} return trips to ${dump?.name || "the dump"}.`,
    quantity,
    unit: componentRule?.unit || componentRule?.authorityPricing?.stockUom || "km",
    unitCost: rates.unitCost,
    unitPrice: rates.unitPrice,
    trace: {
      engine: {
        id: "quote-quantity-rules",
        label: "Quantity Rule Engine",
        module: "apps/field/server/quote-quantity-rules.js",
        recipe: "haulage_trip",
        ruleCode: targetRuleCode,
        itemCode: resolveAuthorityItemCode(componentRule, componentRuleCode),
      },
      formulas: [
        {
          label: `${componentRule?.label || componentRuleCode} distance`,
          expression: `${formatQty(loads)} loads × ${formatQty(returnTripDistanceKm)} km return/load = ${formatQty(quantity)} km.`,
        },
      ],
      inputs: [
        { label: "Loads", value: loads, unit: "load" },
        { label: "Return distance per load", value: returnTripDistanceKm, unit: "km" },
      ],
    },
  });
}

function buildVolumeExcavationPricing({
  quoteCatalog,
  earthworkPlan,
  targetRuleCode,
}) {
  const lines = buildVolumeExcavationRecipeLines({
    quoteCatalog,
    earthworkPlan,
    recipeCode: "volume_excavation",
    targetRuleCode,
    scopeLabel: "site levelling and cut",
  });
  const pricing = summarizeRecipePricing(lines, earthworkPlan?.outputQuantityM3 || 0);
  return pricing ? {
    ...pricing,
    earthworkPlan,
  } : null;
}

function collectEarthworkInputs(entries) {
  const pickFirstFinite = (field) => {
    for (const { candidate } of entries || []) {
      const directValue = candidate?.[field];
      if (Number.isFinite(Number(directValue))) return Number(directValue);
      const nestedValue = candidate?.earthworkInputs?.[field];
      if (Number.isFinite(Number(nestedValue))) return Number(nestedValue);
    }
    return null;
  };

  const earthworkInputs = {
    sectionAreaM2: pickFirstFinite("sectionAreaM2"),
    cutAreaM2: pickFirstFinite("cutAreaM2"),
    fillAreaM2: pickFirstFinite("fillAreaM2"),
    cutDepthMm: pickFirstFinite("cutDepthMm"),
    fillDepthMm: pickFirstFinite("fillDepthMm"),
    cutVolumeM3: pickFirstFinite("cutVolumeM3"),
    fillVolumeM3: pickFirstFinite("fillVolumeM3"),
    levelMm: pickFirstFinite("levelMm"),
  };

  return Object.values(earthworkInputs).some((value) => Number.isFinite(value))
    ? earthworkInputs
    : null;
}

function resolveEarthworkPlan({
  lineItem,
  measurements,
  rule,
}) {
  const inputVolumeM3 = resolveVolumeCubicMetres(lineItem);
  if (!(inputVolumeM3 > 0)) return null;

  const explicitInputs = normalizeEarthworkInputs(lineItem?.earthworkInputs || lineItem);
  const measurementInputs = resolveSectionEarthworkMeasurementInputs({
    measurements,
    section: lineItem?.section,
  });

  let source = "default_ratio";
  let cutVolumeM3 = null;
  let fillVolumeM3 = null;

  if (Number.isFinite(explicitInputs.cutVolumeM3) || Number.isFinite(explicitInputs.fillVolumeM3)) {
    source = "explicit_volume";
    cutVolumeM3 = Math.max(0, Number(explicitInputs.cutVolumeM3 || 0));
    fillVolumeM3 = Math.max(0, Number(explicitInputs.fillVolumeM3 || 0));
  } else if (Number.isFinite(measurementInputs.cutVolumeM3) && Number.isFinite(measurementInputs.fillVolumeM3)) {
    source = "moasure_cut_fill";
    cutVolumeM3 = Math.max(0, Number(measurementInputs.cutVolumeM3 || 0));
    fillVolumeM3 = Math.max(0, Number(measurementInputs.fillVolumeM3 || 0));
  } else {
    const areaM2 = firstFinite([
      explicitInputs.sectionAreaM2,
      measurementInputs.areaM2,
    ]);
    const cutAreaM2 = firstFinite([explicitInputs.cutAreaM2, areaM2]);
    const fillAreaM2 = firstFinite([explicitInputs.fillAreaM2, areaM2]);
    const cutDepthMm = explicitInputs.cutDepthMm;
    const fillDepthMm = explicitInputs.fillDepthMm;

    if ((Number.isFinite(cutDepthMm) && cutDepthMm > 0 && Number.isFinite(cutAreaM2) && cutAreaM2 > 0)
      || (Number.isFinite(fillDepthMm) && fillDepthMm > 0 && Number.isFinite(fillAreaM2) && fillAreaM2 > 0)) {
      source = "depth_override";
      cutVolumeM3 = Number.isFinite(cutDepthMm) && cutDepthMm > 0 && Number.isFinite(cutAreaM2) && cutAreaM2 > 0
        ? roundQuantity(cutAreaM2 * (cutDepthMm / 1000))
        : null;
      fillVolumeM3 = Number.isFinite(fillDepthMm) && fillDepthMm > 0 && Number.isFinite(fillAreaM2) && fillAreaM2 > 0
        ? roundQuantity(fillAreaM2 * (fillDepthMm / 1000))
        : null;
      if (!Number.isFinite(cutVolumeM3) && Number.isFinite(fillVolumeM3)) {
        cutVolumeM3 = roundQuantity(Math.max(inputVolumeM3 - fillVolumeM3, 0));
      }
      if (!Number.isFinite(fillVolumeM3) && Number.isFinite(cutVolumeM3)) {
        fillVolumeM3 = roundQuantity(Math.max(inputVolumeM3 - cutVolumeM3, 0));
      }
    }
  }

  if (!Number.isFinite(cutVolumeM3) && !Number.isFinite(fillVolumeM3)) {
    const hasExplicitRatios = Number(rule.cutRatio || 0) > 0 || Number(rule.fillRatio || 0) > 0;
    const cutRatio = hasExplicitRatios ? Number(rule.cutRatio || 0) : 0.75;
    const fillRatio = hasExplicitRatios ? Number(rule.fillRatio || 0) : 0.25;
    const ratioTotal = Math.max(cutRatio + fillRatio, 0.0001);
    cutVolumeM3 = roundQuantity(inputVolumeM3 * (cutRatio / ratioTotal));
    fillVolumeM3 = roundQuantity(inputVolumeM3 * (fillRatio / ratioTotal));
    source = "default_ratio";
  }

  cutVolumeM3 = roundQuantity(Math.max(0, Number(cutVolumeM3 || 0)));
  fillVolumeM3 = roundQuantity(Math.max(0, Number(fillVolumeM3 || 0)));
  const outputQuantityM3 = roundQuantity(
    source === "default_ratio"
      ? inputVolumeM3
      : (cutVolumeM3 + fillVolumeM3)
  );
  if (!(outputQuantityM3 > 0)) return null;

  const cutVolumePerHour = Number(rule.cutVolumePerHour || rule.volumePerHour || 2);
  const fillVolumePerHour = Number(rule.fillVolumePerHour || rule.volumePerHour || cutVolumePerHour || 2);
  const cutRuleCode = rule.cutRuleCode
    || (Array.isArray(rule.componentRuleCodes) ? rule.componentRuleCodes[0] : null)
    || null;
  const fillRuleCode = rule.fillRuleCode
    || (Array.isArray(rule.componentRuleCodes) ? rule.componentRuleCodes[1] : null)
    || null;

  const steps = [
    cutVolumeM3 > 0
      ? {
          kind: "cut",
          ruleCode: cutRuleCode,
          volumeM3: cutVolumeM3,
          volumePerHour: cutVolumePerHour,
          scopeLabel: "site cut",
        }
      : null,
    fillVolumeM3 > 0
      ? {
          kind: "fill",
          ruleCode: fillRuleCode,
          volumeM3: fillVolumeM3,
          volumePerHour: fillVolumePerHour,
          scopeLabel: "site fill",
        }
      : null,
  ].filter(Boolean);
  if (!steps.length) return null;

  return {
    source,
    inputVolumeM3,
    outputQuantityM3,
    cutVolumeM3,
    fillVolumeM3,
    cutRatio: roundQuantity(cutVolumeM3 / Math.max(outputQuantityM3, 0.0001)),
    fillRatio: roundQuantity(fillVolumeM3 / Math.max(outputQuantityM3, 0.0001)),
    areaM2: firstFinite([explicitInputs.sectionAreaM2, measurementInputs.areaM2]),
    cutAreaM2: firstFinite([explicitInputs.cutAreaM2, measurementInputs.areaM2]),
    fillAreaM2: firstFinite([explicitInputs.fillAreaM2, measurementInputs.areaM2]),
    cutDepthMm: explicitInputs.cutDepthMm,
    fillDepthMm: explicitInputs.fillDepthMm,
    levelMm: firstFinite([explicitInputs.levelMm, measurementInputs.levelMm]),
    steps,
  };
}

function buildEarthworkPlanDescription(earthworkPlan) {
  if (!earthworkPlan) return "Cut and level to the nominated set level.";
  if (earthworkPlan.source === "moasure_cut_fill" || earthworkPlan.source === "explicit_volume") {
    return `Cut ${formatQty(earthworkPlan.cutVolumeM3)} m3 and fill ${formatQty(earthworkPlan.fillVolumeM3)} m3 to the nominated set level.`;
  }
  return `Cut and level ${formatQty(earthworkPlan.outputQuantityM3)} m3 to the nominated set level.`;
}

function buildEarthworkPlanRationale(earthworkPlan) {
  if (!earthworkPlan) return null;
  switch (earthworkPlan.source) {
    case "explicit_volume":
      return `Explicit cut/fill override applied: ${formatQty(earthworkPlan.cutVolumeM3)} m3 cut and ${formatQty(earthworkPlan.fillVolumeM3)} m3 fill.`;
    case "moasure_cut_fill":
      return `Moasure cut/fill volumes applied: ${formatQty(earthworkPlan.cutVolumeM3)} m3 cut and ${formatQty(earthworkPlan.fillVolumeM3)} m3 fill${Number.isFinite(earthworkPlan.levelMm) ? ` at level ${formatQty(earthworkPlan.levelMm)} mm.` : "."}`;
    case "depth_override": {
      const areaLabel = Number.isFinite(earthworkPlan.areaM2) ? ` over ${formatQty(earthworkPlan.areaM2)} m2` : "";
      const cutLabel = Number.isFinite(earthworkPlan.cutDepthMm) ? `${formatQty(earthworkPlan.cutDepthMm)} mm cut depth` : null;
      const fillLabel = Number.isFinite(earthworkPlan.fillDepthMm) ? `${formatQty(earthworkPlan.fillDepthMm)} mm fill height` : null;
      return `Earthworks priced from depth override${areaLabel}: ${[cutLabel, fillLabel].filter(Boolean).join(" and ")} resulting in ${formatQty(earthworkPlan.cutVolumeM3)} m3 cut and ${formatQty(earthworkPlan.fillVolumeM3)} m3 fill.`;
    }
    default:
      return `${formatQty(earthworkPlan.outputQuantityM3)} m3 earthworks priced at ${formatQty(earthworkPlan.cutRatio * 100)}% cut / ${formatQty(earthworkPlan.fillRatio * 100)}% fill, both at 2 m3/hr using the default excavator and mini loader.`;
  }
}

function normalizeEarthworkInputs(source) {
  return {
    sectionAreaM2: toFiniteNumber(source?.sectionAreaM2),
    cutAreaM2: toFiniteNumber(source?.cutAreaM2),
    fillAreaM2: toFiniteNumber(source?.fillAreaM2),
    cutDepthMm: toFiniteNumber(source?.cutDepthMm),
    fillDepthMm: toFiniteNumber(source?.fillDepthMm),
    cutVolumeM3: toFiniteNumber(source?.cutVolumeM3),
    fillVolumeM3: toFiniteNumber(source?.fillVolumeM3),
    levelMm: toFiniteNumber(source?.levelMm),
  };
}

function resolveSectionEarthworkMeasurementInputs({
  measurements,
  section,
}) {
  return {
    areaM2: resolveSectionMeasurementValue({
      measurements,
      section,
      unit: "m2",
      tokens: ["area"],
    }),
    cutVolumeM3: resolveSectionMeasurementValue({
      measurements,
      section,
      unit: "m3",
      tokens: ["cut", "volume"],
    }),
    fillVolumeM3: resolveSectionMeasurementValue({
      measurements,
      section,
      unit: "m3",
      tokens: ["fill", "volume"],
    }),
    levelMm: resolveSectionMeasurementValue({
      measurements,
      section,
      unit: "mm",
      tokens: ["level"],
    }),
  };
}

function resolveSectionMeasurementValue({
  measurements,
  section,
  unit,
  tokens,
}) {
  const normalizedUnit = normalizeMeasurementUnit(unit);
  const matches = findSectionMeasurements({
    measurements,
    section,
    unit: normalizedUnit,
    tokens,
  });
  if (matches.length === 1) return roundQuantity(Number(matches[0].value || 0));
  return null;
}

function findSectionMeasurements({
  measurements,
  section,
  unit,
  tokens,
}) {
  const normalizedSection = slugify(section);
  const normalizedTokens = (tokens || []).map((token) => slugify(token)).filter(Boolean);
  const allMatches = (measurements || []).filter((entry) => {
    if (!Number.isFinite(Number(entry?.value))) return false;
    if (unit && normalizeMeasurementUnit(entry?.unit) !== unit) return false;
    const label = slugify(entry?.label || entry?.name || "");
    if (!normalizedTokens.every((token) => label.includes(token))) return false;
    return true;
  });
  if (!normalizedSection) return allMatches;
  const sectionMatches = allMatches.filter((entry) => slugify(entry?.label || entry?.name || "").includes(normalizedSection));
  return sectionMatches.length ? sectionMatches : allMatches;
}

function normalizeMeasurementUnit(value) {
  const unit = String(value || "").trim().toLowerCase();
  if (!unit) return null;
  if (["m2", "sqm"].includes(unit)) return "m2";
  if (["m3", "cum"].includes(unit)) return "m3";
  if (["mm"].includes(unit)) return "mm";
  return unit;
}

function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function firstFinite(values) {
  for (const value of values || []) {
    const numeric = toFiniteNumber(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function pickBulkRemovalFinite(source, field) {
  const directValue = toFiniteNumber(source?.[field]);
  if (Number.isFinite(directValue)) return directValue;
  return toFiniteNumber(source?.bulkRemovalInputs?.[field]);
}

function resolveBulkRemovalPlan({
  source,
  fallbackGrossCutVolumeM3 = null,
}) {
  const grossCutVolumeM3 = roundQuantity(Math.max(0, Number(firstFinite([
    pickBulkRemovalFinite(source, "grossCutVolumeM3"),
    pickBulkRemovalFinite(source, "cutVolumeM3"),
    fallbackGrossCutVolumeM3,
  ]) || 0)));
  const explicitFillVolumeM3 = pickBulkRemovalFinite(source, "fillVolumeM3");
  const explicitDisposalVolumeM3 = firstFinite([
    pickBulkRemovalFinite(source, "disposalVolumeM3"),
    pickBulkRemovalFinite(source, "netVolumeM3"),
  ]);

  let fillVolumeM3 = explicitFillVolumeM3;
  let disposalVolumeM3 = Number.isFinite(explicitFillVolumeM3)
    ? grossCutVolumeM3 - explicitFillVolumeM3
    : explicitDisposalVolumeM3;

  if (!Number.isFinite(fillVolumeM3) && Number.isFinite(disposalVolumeM3)) {
    fillVolumeM3 = grossCutVolumeM3 - disposalVolumeM3;
  }
  if (!Number.isFinite(disposalVolumeM3) && Number.isFinite(fillVolumeM3)) {
    disposalVolumeM3 = grossCutVolumeM3 - fillVolumeM3;
  }

  fillVolumeM3 = roundQuantity(Math.max(0, Number(fillVolumeM3 || 0)));
  disposalVolumeM3 = roundQuantity(Math.min(
    grossCutVolumeM3,
    Math.max(0, Number(disposalVolumeM3 != null ? disposalVolumeM3 : (grossCutVolumeM3 - fillVolumeM3)))
  ));

  return {
    grossCutVolumeM3,
    fillVolumeM3,
    disposalVolumeM3,
    noteFillImportRequired:
      source?.noteFillImportRequired === true
      || source?.bulkRemovalInputs?.noteFillImportRequired === true
      || fillVolumeM3 > grossCutVolumeM3,
    hasVolumeAdjustments:
      Number.isFinite(explicitFillVolumeM3)
      || Number.isFinite(explicitDisposalVolumeM3)
      || source?.noteFillImportRequired === true
      || source?.bulkRemovalInputs?.noteFillImportRequired === true,
  };
}

function aggregateBulkRemovalPlanMeasurements(plans) {
  if (!Array.isArray(plans) || !plans.length) return null;
  const grossCutVolumeM3 = roundQuantity(sum(
    plans.map((plan) => Number(plan?.measurements?.grossCutVolumeM3 || 0))
  ));
  const fillVolumeM3 = roundQuantity(sum(
    plans.map((plan) => Number(plan?.measurements?.fillVolumeM3 || 0))
  ));
  const netExportVolumeM3 = roundQuantity(Math.max(0, grossCutVolumeM3 - fillVolumeM3));
  if (!(grossCutVolumeM3 > 0) && !(netExportVolumeM3 > 0)) return null;
  return {
    grossCutVolumeM3,
    fillVolumeM3,
    netExportVolumeM3,
  };
}

function normalizeBulkRemovalBreakdownSourceInputs(plan) {
  if (!plan?.measurements) return null;
  return {
    grossCutVolumeM3: roundQuantity(Math.max(0, Number(plan.measurements.grossCutVolumeM3 || 0))),
    fillVolumeM3: roundQuantity(Math.max(0, Number(plan.measurements.fillVolumeM3 || 0))),
    netVolumeM3: roundQuantity(Math.max(0, Number(plan.measurements.netExportVolumeM3 || 0))),
    disposalVolumeM3: roundQuantity(Math.max(0, Number(plan.measurements.netExportVolumeM3 || 0))),
  };
}

function buildBreakdownSourcePlanPreview(plan) {
  if (!plan || typeof plan !== "object") return null;
  return {
    id: plan.id || null,
    soilSection: plan.soilSection || null,
    haulageSection: plan.haulageSection || null,
    measurements: plan.measurements || null,
    explicit: plan.explicit || null,
    chosen: plan.chosen || null,
  };
}

function allocateBulkRemovalFillVolumes({
  groups,
  totalFillVolumeM3,
}) {
  const eligibleGroups = (groups || []).filter((group) => group?.groupKey && Number(group.volume || 0) > 0);
  const allocations = new Map();
  if (!(totalFillVolumeM3 > 0) || !eligibleGroups.length) return allocations;

  const totalVolumeM3 = eligibleGroups.reduce((sum, group) => sum + Number(group.volume || 0), 0);
  if (!(totalVolumeM3 > 0)) return allocations;

  let remainingFillVolumeM3 = roundQuantity(totalFillVolumeM3);
  for (const [index, group] of eligibleGroups.entries()) {
    const rawAllocation = index === eligibleGroups.length - 1
      ? remainingFillVolumeM3
      : roundQuantity(totalFillVolumeM3 * (Number(group.volume || 0) / totalVolumeM3));
    const allocatedFillVolumeM3 = roundQuantity(Math.min(
      Number(group.volume || 0),
      Math.max(0, rawAllocation)
    ));
    allocations.set(group.groupKey, allocatedFillVolumeM3);
    remainingFillVolumeM3 = roundQuantity(Math.max(0, remainingFillVolumeM3 - allocatedFillVolumeM3));
  }

  if (remainingFillVolumeM3 > 0) {
    for (const group of eligibleGroups) {
      const currentAllocation = Number(allocations.get(group.groupKey) || 0);
      const remainingCapacity = roundQuantity(Math.max(0, Number(group.volume || 0) - currentAllocation));
      if (!(remainingCapacity > 0)) continue;
      const extraAllocation = roundQuantity(Math.min(remainingCapacity, remainingFillVolumeM3));
      allocations.set(group.groupKey, roundQuantity(currentAllocation + extraAllocation));
      remainingFillVolumeM3 = roundQuantity(Math.max(0, remainingFillVolumeM3 - extraAllocation));
      if (!(remainingFillVolumeM3 > 0)) break;
    }
  }

  return allocations;
}

function buildBulkRemovalPricing({
  quoteCatalog,
  volumeM3,
  disposalVolumeM3 = volumeM3,
  densityTonnesPerM3,
  truckMassCapacityTonnes,
  truckVolumeCapacityM3,
  loadingHoursPerLoad,
  loaderRuleCode,
  disposalRuleCode,
}) {
  const loadingMetrics = resolveBulkRemovalMetrics({
    volumeM3,
    densityTonnesPerM3,
    truckMassCapacityTonnes,
    truckVolumeCapacityM3,
    loadingHoursPerLoad,
  });
  if (!loadingMetrics) return null;

  const loaderRule = resolveQuoteCatalogRule(quoteCatalog, loaderRuleCode);
  const disposalRule = resolveQuoteCatalogRule(quoteCatalog, disposalRuleCode);
  const normalizedDisposalVolumeM3 = roundQuantity(Math.max(0, Number(disposalVolumeM3 || 0)));
  // Mirrors resolveBulkRemovalMetrics's `tonnes`: density is 0 (not an error)
  // for a per_load/per_m3 disposal item, so disposalTonnes must be null
  // rather than a computed 0 — a real tonnage of zero and "this item isn't
  // billed by weight" are different facts, and printing formatQty(0) as
  // "(0 t)" in a customer-facing description states the wrong one (DEL-46).
  const disposalTonnes = loadingMetrics.densityTonnesPerM3 > 0
    ? roundQuantity(normalizedDisposalVolumeM3 * loadingMetrics.densityTonnesPerM3)
    : null;
  const disposalBillable = resolveDisposalBillableQuantity({
    disposalRule,
    volumeM3: normalizedDisposalVolumeM3,
  });
  const disposalLine = normalizedDisposalVolumeM3 > 0
    ? buildBulkDisposalLine({
        componentRule: disposalRule,
        componentRuleCode: disposalRuleCode,
        targetRuleCode: disposalRuleCode,
        recipeCode: "bulk_loading_disposal",
        billable: disposalBillable,
        volumeM3: normalizedDisposalVolumeM3,
      })
    : null;
  // DEL-46 (P0, round 4): a disposal item with an unresolvable basis must not
  // let the quote silently price from the loader line alone — that produces
  // a cheaper-than-real customer quote with no pricing issue recorded.
  // Fail closed the same way buildHaulagePricing() already does for a
  // missing haulage component: return an unpriced result with a reason
  // string, never a partial price.
  if (normalizedDisposalVolumeM3 > 0 && !disposalLine) {
    // DEL-46 (round 6): distinguish "basis/factor unresolved" (billable is
    // null) from "basis is fine but there's no positive sell rate" (billable
    // resolved, but resolveRuleRates/buildBulkDisposalLine's rate check
    // failed) — these are different operator-facing problems with different
    // fixes, and a generic "costing basis... unresolved" message would send
    // someone to check pricing_basis/pricing_basis_factor when the real gap
    // is a missing or zero sell price.
    const pricingIssueReason = disposalBillable
      ? `Missing disposal pricing for ${disposalRule?.code || disposalRuleCode}: the disposal item has a valid costing basis but no positive sell price.`
      : `Missing disposal pricing for ${disposalRule?.code || disposalRuleCode}: the disposal item's costing basis (pricing_basis / pricing_basis_factor) is missing, incomplete, or unresolved.`;
    console.warn(`[quote-quantity-rules] ${pricingIssueReason}`);
    return {
      unitCost: null,
      totalCost: null,
      unitPrice: null,
      totalPrice: null,
      tonnes: loadingMetrics.tonnes,
      disposalTonnes,
      loads: loadingMetrics.loads,
      loadingHours: loadingMetrics.loadingHours,
      pricingIssueReason,
      pricingIssueCode: disposalRule?.code || disposalRuleCode,
    };
  }
  const lines = [
    buildBulkLoadingLine({
      componentRule: loaderRule,
      componentRuleCode: loaderRuleCode,
      targetRuleCode: loaderRuleCode,
      recipeCode: "bulk_loading_disposal",
      hours: loadingMetrics.loadingHours,
      volumeM3,
      tonnes: loadingMetrics.tonnes,
    }),
    disposalLine,
  ].filter(Boolean);
  const pricing = summarizeRecipePricing(lines, volumeM3);
  return {
    unitCost: pricing?.unitCost ?? null,
    totalCost: pricing?.totalCost ?? null,
    unitPrice: pricing?.unitPrice ?? null,
    totalPrice: pricing?.totalPrice ?? null,
    tonnes: loadingMetrics.tonnes,
    disposalTonnes,
    loads: loadingMetrics.loads,
    loadingHours: loadingMetrics.loadingHours,
    pricingIssueReason: null,
    pricingIssueCode: null,
  };
}

function buildHaulagePricing({
  quoteCatalog,
  loads,
  dump,
  vehicleHourRuleCode,
  vehicleKmRuleCode,
}) {
  if (!(loads > 0) || !dump) return null;
  const vehicleHourRule = resolveQuoteCatalogRule(quoteCatalog, vehicleHourRuleCode);
  const vehicleKmRule = resolveQuoteCatalogRule(quoteCatalog, vehicleKmRuleCode);
  const returnTripDriveHours = roundQuantity((Number(dump.drive || 0) * 2) / 60);
  const returnTripDistanceKm = roundQuantity(Number(dump.dist || 0) * 2);
  const vehicleHourLine = buildHaulageVehicleHourLine({
    componentRule: vehicleHourRule,
    componentRuleCode: vehicleHourRuleCode,
    targetRuleCode: vehicleHourRuleCode,
    loads,
    returnTripDriveHours,
    dump,
  });
  const vehicleKmLine = buildHaulageVehicleKmLine({
    componentRule: vehicleKmRule,
    componentRuleCode: vehicleKmRuleCode,
    targetRuleCode: vehicleKmRuleCode,
    loads,
    returnTripDistanceKm,
    dump,
  });
  const lines = [vehicleHourLine, vehicleKmLine].filter(Boolean);
  const unresolvedComponents = [
    vehicleHourLine ? null : (vehicleHourRule?.code || vehicleHourRuleCode),
    vehicleKmLine ? null : (vehicleKmRule?.code || vehicleKmRuleCode),
  ].filter(Boolean);
  if (unresolvedComponents.length) {
    const pricingIssueReason = `Missing haulage component pricing for ${unresolvedComponents.join(" and ")}.`;
    console.warn(`[quote-quantity-rules] ${pricingIssueReason}`);
    return {
      unitCost: null,
      totalCost: null,
      unitPrice: null,
      totalPrice: null,
      loads,
      returnTripDriveHours,
      returnTripDistanceKm,
      pricingIssueReason,
    };
  }
  const pricing = summarizeRecipePricing(lines, loads);
  return {
    unitCost: pricing?.unitCost ?? null,
    totalCost: pricing?.totalCost ?? null,
    unitPrice: pricing?.unitPrice ?? null,
    totalPrice: pricing?.totalPrice ?? null,
    loads,
    returnTripDriveHours,
    returnTripDistanceKm,
  };
}

function summarizeRecipePricing(lines, quantity) {
  if (!Array.isArray(lines) || !lines.length || !(quantity > 0)) return null;
  const hasCompleteMoney = lines.every((line) => (
    Number.isFinite(Number(line?.quantity))
    && Number.isFinite(Number(line?.unitCost))
    && Number.isFinite(Number(line?.unitPrice))
  ));
  if (!hasCompleteMoney) return null;
  const totalCost = roundMoney(lines.reduce((total, line) => total + Number(line.quantity) * Number(line.unitCost), 0));
  const totalPrice = roundMoney(lines.reduce((total, line) => total + Number(line.quantity) * Number(line.unitPrice), 0));
  if (totalCost == null || totalPrice == null) return null;
  return {
    unitCost: roundMoney(totalCost / quantity),
    totalCost,
    unitPrice: roundMoney(totalPrice / quantity),
    totalPrice,
  };
}

function resolveBulkRemovalMetrics({
  volumeM3,
  densityTonnesPerM3,
  truckMassCapacityTonnes,
  truckVolumeCapacityM3,
  loadingHoursPerLoad,
}) {
  if (!(volumeM3 > 0)) return null;
  // Density (t/m3) is the disposal item's own per_tonne pricing_basis_factor
  // (see resolveDisposalDensityTonnesPerM3) — it is 0 for a per_load/per_m3
  // disposal item, which is not an error. It is only load-bearing here when
  // the truck's volume capacity has to be derived from its mass capacity;
  // when truckVolumeCapacityM3 is given directly, loading hours and trip
  // counts don't need a density at all (DEL-46).
  const effectiveVolumeCapacityM3 = truckVolumeCapacityM3 > 0
    ? truckVolumeCapacityM3
    : (truckMassCapacityTonnes > 0 && densityTonnesPerM3 > 0 ? truckMassCapacityTonnes / densityTonnesPerM3 : 0);
  if (!(effectiveVolumeCapacityM3 > 0) || !(loadingHoursPerLoad > 0)) return null;
  const tonnes = densityTonnesPerM3 > 0 ? roundQuantity(volumeM3 * densityTonnesPerM3) : null;
  const loads = calculateTripCount({
    volumeM3,
    densityTonnesPerM3,
    truckMassCapacityTonnes,
    truckVolumeCapacityM3: effectiveVolumeCapacityM3,
  });
  const loadingHours = roundQuantity((volumeM3 / effectiveVolumeCapacityM3) * loadingHoursPerLoad);
  return {
    tonnes,
    loads,
    loadingHours,
    densityTonnesPerM3,
    effectiveVolumeCapacityM3,
  };
}

function calculateTripCount({
  volumeM3,
  densityTonnesPerM3,
  truckMassCapacityTonnes,
  truckVolumeCapacityM3,
}) {
  const tonnes = Number(volumeM3 || 0) * Number(densityTonnesPerM3 || 0);
  const byMass = truckMassCapacityTonnes > 0
    ? tonnes / truckMassCapacityTonnes
    : 0;
  const byVolume = truckVolumeCapacityM3 > 0
    ? Number(volumeM3 || 0) / truckVolumeCapacityM3
    : 0;
  return Math.max(1, Math.ceil(Math.max(byMass, byVolume)));
}

function buildBulkRemovalDescription({
  grossCutVolumeM3,
  fillVolumeM3 = 0,
  disposalVolumeM3 = grossCutVolumeM3,
  disposalTonnes,
  dump,
  disposalRuleCode,
  noteFillImportRequired = false,
}) {
  const wasteLabel = humanizeWasteCode(disposalRuleCode);
  const dumpText = dump?.name && disposalVolumeM3 > 0 ? ` Disposal at ${dump.name}.` : "";
  // Mass is only meaningful for a per_tonne disposal basis (disposalTonnes is
  // null for per_load/per_m3 items). Omit the "(x t)" parenthetical entirely
  // rather than print formatQty(null) as a literal "(0 t)", which would state
  // a false physical fact on a customer-facing document (DEL-46).
  const massClause = disposalTonnes != null ? ` (${formatQty(disposalTonnes)} t)` : "";
  if (!(fillVolumeM3 > 0) && !noteFillImportRequired) {
    return `${formatQty(grossCutVolumeM3)} m3${massClause} removal and ${wasteLabel}.${dumpText}`;
  }
  if (noteFillImportRequired) {
    if (disposalVolumeM3 > 0) {
      return `${formatQty(grossCutVolumeM3)} m3 cut, ${formatQty(fillVolumeM3)} m3 fill demand, and ${formatQty(disposalVolumeM3)} m3${massClause} ${wasteLabel} removed from site.${dumpText} Additional fill import may be required.`;
    }
    return `${formatQty(grossCutVolumeM3)} m3 cut with ${formatQty(fillVolumeM3)} m3 fill demand retained on-site. No off-site ${wasteLabel} required. Additional fill import may be required.`;
  }
  if (!(disposalVolumeM3 > 0)) {
    return `${formatQty(grossCutVolumeM3)} m3 cut with ${formatQty(fillVolumeM3)} m3 retained on-site as fill. No off-site ${wasteLabel} required.`;
  }
  return `${formatQty(grossCutVolumeM3)} m3 cut, ${formatQty(fillVolumeM3)} m3 retained on-site as fill, ${formatQty(disposalVolumeM3)} m3${massClause} removal and ${wasteLabel}.${dumpText}`;
}

function buildBulkRemovalRationale({
  grossCutVolumeM3,
  fillVolumeM3 = 0,
  disposalVolumeM3 = grossCutVolumeM3,
  disposalTonnes,
  densityTonnesPerM3,
  truckMassCapacityTonnes,
  truckVolumeCapacityM3,
  loadingHoursPerLoad,
  dump,
  disposalRuleCode,
  noteFillImportRequired = false,
  fillVolumeAllocated = false,
}) {
  const dumpText = dump?.name ? ` to ${dump.name}` : "";
  const wasteLabel = humanizeWasteCode(disposalRuleCode);
  // Mass conversion (× density) only applies to a per_tonne disposal basis;
  // disposalTonnes/densityTonnesPerM3 are null/0 for per_load/per_m3 items,
  // and this line must not print a false "= 0 t" mass conversion in that
  // case (DEL-46).
  const massConversionText = disposalTonnes != null
    ? ` × ${formatQty(densityTonnesPerM3)} t/m3 = ${formatQty(disposalTonnes)} t`
    : "";
  if (!(fillVolumeM3 > 0) && !noteFillImportRequired) {
    return `${formatQty(grossCutVolumeM3)} m3${massConversionText}. Loading allowance uses ${formatQty(truckMassCapacityTonnes)} t / ${formatQty(truckVolumeCapacityM3)} m3 per load at ${formatQty(loadingHoursPerLoad)} hr per load. Disposal classified as ${wasteLabel}${dumpText}.`;
  }

  const loadingText = `Loading allowance uses ${formatQty(grossCutVolumeM3)} m3 gross cut with ${formatQty(truckMassCapacityTonnes)} t / ${formatQty(truckVolumeCapacityM3)} m3 per load at ${formatQty(loadingHoursPerLoad)} hr per load.`;
  const disposalText = disposalVolumeM3 > 0
    ? `${formatQty(disposalVolumeM3)} m3 disposal${massConversionText}.`
    : `Disposal volume floors at 0 m3, so no off-site ${wasteLabel} is required.`;
  const allocationText = fillVolumeAllocated
    ? " Section disposal was apportioned from the site-wide fill allowance because section-level fill volumes were not supplied."
    : "";

  if (noteFillImportRequired) {
    return `${formatQty(grossCutVolumeM3)} m3 cut and ${formatQty(fillVolumeM3)} m3 fill demand recorded. ${disposalText} ${loadingText}${disposalVolumeM3 > 0 ? ` Disposal classified as ${wasteLabel}${dumpText}.` : ""} Additional imported fill may be required.${allocationText}`;
  }
  return `${formatQty(grossCutVolumeM3)} m3 cut, ${formatQty(fillVolumeM3)} m3 used as fill on-site, ${formatQty(disposalVolumeM3)} m3 removed from site. ${disposalText} ${loadingText} Disposal classified as ${wasteLabel}${dumpText}.${allocationText}`;
}

function buildSoilHaulageRationale({
  loads,
  grossCutVolumeM3,
  fillVolumeM3 = 0,
  disposalVolumeM3,
  disposalTonnes,
  returnTripDistanceKm,
  returnTripDriveHours,
}) {
  // Mass is only meaningful for a per_tonne disposal basis — see the matching
  // comment in buildBulkRemovalDescription (DEL-46).
  if (!(fillVolumeM3 > 0)) {
    const massText = disposalTonnes != null ? ` and ${formatQty(disposalTonnes)} t of unclean fill` : " of unclean fill";
    return `${loads} return trips calculated from ${formatQty(disposalVolumeM3)} m3${massText}. Return trip distance ${formatQty(returnTripDistanceKm)} km and return drive ${formatQty(returnTripDriveHours)} hr per load.`;
  }
  const massClause = disposalTonnes != null ? ` (${formatQty(disposalTonnes)} t)` : "";
  return `${loads} return trips calculated from ${formatQty(disposalVolumeM3)} m3 disposal volume${massClause} after ${formatQty(fillVolumeM3)} m3 used as fill on-site from ${formatQty(grossCutVolumeM3)} m3 cut. Return trip distance ${formatQty(returnTripDistanceKm)} km and return drive ${formatQty(returnTripDriveHours)} hr per load.`;
}

function humanizeWasteCode(code) {
  return String(code || "")
    .replace(/-disposal$/i, "")
    .replace(/-/g, " ")
    .trim();
}

function sumGroupQuantities({ groups, groupKeys }) {
  return roundQuantity((groupKeys || []).reduce((sum, groupKey) => {
    const entries = groups.get(groupKey) || [];
    return sum + entries.reduce((groupSum, { candidate }) => groupSum + Number(candidate.quantity || 0), 0);
  }, 0));
}

function buildSectionMatcher(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch (err) {
    console.warn(`[quote-quantity-rules] invalid section matcher pattern "${pattern}": ${err.message}`);
    return null;
  }
}

function buildIrrigationBundleComponents({ lineItem, quote, assembly }) {
  if (!assembly) return null;
  const areaM2 = resolveLineAreaSquareMetres({ lineItem, quote });
  if (!(areaM2 > 0)) return null;
  if (!hasIrrigationComponentSignal(lineItem)) return null;

  const option = resolveIrrigationOption(lineItem);
  const evaluation = evaluateAssembly(assembly.definition, { area_m2: areaM2, controller: option });
  const problems = usedComponentProblems(assembly, evaluation);
  if (problems.length) return { recipeLines: [], pricingProblems: problems };
  const { vars, byKey } = evaluation;
  const controllerKey = byKey.battery_controller ? "battery_controller" : "mains_controller";
  const controllerCharge = componentRates(assembly, controllerKey).unitPrice;
  const labourLineCharge = (key) => (byKey[key]
    ? computeRoundedLineTotal(byKey[key].quantity, componentRates(assembly, key).unitPrice)
    : 0);
  const adminCharge = componentRates(assembly, "admin").unitPrice;
  const adminCost = componentRates(assembly, "admin").unitCost;
  const vehicleCharge = componentRates(assembly, "delivery").unitPrice;
  const residualDeliveryCharge = roundMoney(
    Number(lineItem.totalPrice || 0)
      - controllerCharge
      - computeRoundedLineTotal(byKey.pipe_fixings.quantity, componentRates(assembly, "pipe_fixings").unitPrice)
      - labourLineCharge("conduit_labour")
      - labourLineCharge("pipe_labour")
      - labourLineCharge("wiring_labour")
      - adminCharge
  );
  if (residualDeliveryCharge < 0) return null;
  const deliveryHours = vehicleCharge > 0
    ? residualDeliveryCharge / vehicleCharge
    : 0;
  const engine = {
    ...recipeTraceEngine("irrigation_bundle", assemblyRuleCode(assembly)),
    assembly: assembly.code,
    assemblyVersion: assembly.version,
  };
  const line = (key, description, trace, quantity) => assemblyLine({ assembly, evaluation, key, description, trace, quantity });

  return {
    pricingProblems: usedComponentProblems(assembly, evaluation),
    recipeLines: [
      line(controllerKey, option === "battery"
        ? "Supply of all-in-one battery irrigation controller."
        : "Supply of mains irrigation controller and solenoid setup.", {
        engine,
        formulas: [
          {
            label: "Controller quantity",
            expression: `Selected ${option === "battery" ? "battery" : "mains"} controller option uses 1 controller set.`,
          },
        ],
        inputs: [
          { label: "Controller option", value: option },
          { label: "Quantity", value: 1, unit: "job" },
        ],
      }),
      line("pipe_fixings", `Pipework, fittings, and sundry irrigation materials for ${formatQty(areaM2)} m2.`, {
        engine,
        formulas: [
          {
            label: "Pipework quantity",
            expression: `${formatQty(areaM2)} m2 irrigated area × 1 = ${formatQty(areaM2)} m2 pipe and fixings allowance.`,
          },
        ],
        inputs: [
          { label: "Irrigated area", value: areaM2, unit: "m2" },
        ],
      }),
      line("conduit_labour", "Conduit install labour for the irrigation control system.", {
        engine,
        formulas: [
          {
            label: "Conduit labour",
            expression: `Fixed conduit allowance = ${formatQty(vars.conduit_hours)} hours.`,
          },
        ],
      }),
      line("pipe_labour", `Pipe install labour at ${formatQty(areaM2)} m2.`, {
        engine,
        formulas: [
          {
            label: "Pipe install labour",
            expression: `${formatQty(areaM2)} m2 × ${formatQty(vars.pipe_install_hours_per_m2)} hr/m2 = ${formatQty(byKey.pipe_labour.quantity)} hours.`,
          },
        ],
        inputs: [
          { label: "Irrigated area", value: areaM2, unit: "m2" },
          { label: "Install rate", value: vars.pipe_install_hours_per_m2, unit: "hr/m2" },
        ],
      }),
      ...(byKey.wiring_labour
        ? [line("wiring_labour", "Extra mains control unit install and wiring labour.", {
            engine,
            formulas: [
              {
                label: "Mains wiring labour",
                expression: `Selected mains controller option adds ${formatQty(byKey.wiring_labour.quantity)} wiring hours.`,
              },
            ],
          })]
        : []),
      line("delivery", "Delivery, travel, and supplier run allowance for irrigation materials.", {
        engine,
        formulas: [
          {
            label: "Delivery vehicle hours",
            expression: `${formatMoney(residualDeliveryCharge)} residual delivery allowance ÷ ${formatMoney(vehicleCharge)} / hr = ${formatQty(deliveryHours)} vehicle hours.`,
          },
        ],
        inputs: [
          { label: "Residual delivery allowance", value: residualDeliveryCharge, format: "money" },
          { label: "Vehicle charge / hour", value: vehicleCharge, format: "money" },
        ],
      }, deliveryHours),
      line("admin", "Allocated admin share for this irrigation option.", {
        engine,
        formulas: [
          {
            label: "Admin allocation",
            expression: `Fixed admin share = ${formatMoney(adminCharge)} charge (${formatMoney(adminCost)} cost).`,
          },
        ],
      }),
    ],
  };
}

function buildLawnRecipeLines({ lineItem, areaM2, assembly, evaluation }) {
  const { vars, byKey } = evaluation;
  const lineCharge = (key) => computeRoundedLineTotal(byKey[key].quantity, componentRates(assembly, key).unitPrice);
  const adminCharge = componentRates(assembly, "admin").unitPrice;
  const adminCost = componentRates(assembly, "admin").unitCost;
  const vehicleCharge = componentRates(assembly, "delivery").unitPrice;
  const residualDeliveryCharge = roundMoney(
    Number(lineItem.totalPrice || 0)
      - lineCharge("turf")
      - lineCharge("install_labour")
      - lineCharge("reprep_labour")
      - adminCharge
  );
  if (residualDeliveryCharge < 0) return [];
  const deliveryHours = vehicleCharge > 0
    ? residualDeliveryCharge / vehicleCharge
    : 0;
  const engine = {
    ...recipeTraceEngine("lawn_bundle", assemblyRuleCode(assembly)),
    assembly: assembly.code,
    assemblyVersion: assembly.version,
  };
  const line = (key, description, trace, quantity) => assemblyLine({ assembly, evaluation, key, description, trace, quantity });

  return [
    line("turf", buildTurfDescription(lineItem, areaM2), {
      engine,
      formulas: [
        {
          label: "Turf area",
          expression: `${formatQty(areaM2)} m2 lawn area × 1 = ${formatQty(byKey.turf.quantity)} m2 turf supply.`,
        },
      ],
      inputs: [
        { label: "Lawn area", value: areaM2, unit: "m2" },
      ],
    }),
    line("install_labour", "Lawn installation labour.", {
      engine,
      formulas: [
        {
          label: "Turf install labour",
          expression: `${formatQty(areaM2)} m2 × ${formatQty(vars.install_hours_per_m2)} hr/m2 = ${formatQty(byKey.install_labour.quantity)} hours.`,
        },
      ],
      inputs: [
        { label: "Lawn area", value: areaM2, unit: "m2" },
        { label: "Install rate", value: vars.install_hours_per_m2, unit: "hr/m2" },
      ],
    }),
    line("reprep_labour", "Site re-prep, re-level, and redrag before turf lay.", {
      engine,
      formulas: [
        {
          label: "Re-prep labour",
          expression: `${formatQty(areaM2)} m2 × ${formatQty(vars.reprep_hours_per_m2)} hr/m2 = ${formatQty(byKey.reprep_labour.quantity)} hours.`,
        },
      ],
    }),
    line("delivery", "Supplier pickup and delivery allowance for the selected turf.", {
      engine,
      formulas: [
        {
          label: "Delivery vehicle hours",
          expression: `${formatMoney(residualDeliveryCharge)} residual delivery allowance ÷ ${formatMoney(vehicleCharge)} / hr = ${formatQty(deliveryHours)} vehicle hours.`,
        },
      ],
    }, deliveryHours),
    line("admin", "Allocated admin share for this lawn option.", {
      engine,
      formulas: [
        {
          label: "Admin allocation",
          expression: `Fixed admin share = ${formatMoney(adminCharge)} charge (${formatMoney(adminCost)} cost).`,
        },
      ],
    }),
  ];
}

function buildLoamMaterialOrder({
  lineItem,
  areaM2,
  assembly,
  evaluation,
}) {
  const { params, vars, byKey } = evaluation;
  const depthMetres = params.loam_depth_m;
  const baseVolumeM3 = vars.loam_base_m3;
  const allowanceMultiplier = vars.loam_allowance;
  const orderVolumeM3 = byKey.loam.quantity;
  const rates = componentRates(assembly, "loam");

  return buildMaterialOrder({
    itemCode: rates.itemCode || byKey.loam.itemCode,
    label: byKey.loam.label,
    description: buildLoamDescription({
      areaM2,
      depthMetres,
      baseVolumeM3,
      orderVolumeM3,
      upliftMultiplier: allowanceMultiplier,
    }),
    quantity: orderVolumeM3,
    unit: byKey.loam.unit,
    sourceLineItemCode: lineItem.code || null,
    section: lineItem.section || null,
    itemMeta: assemblyLineMeta(assembly, "loam", evaluation),
    unitCost: rates.unitCost,
    unitPrice: rates.unitPrice,
    calculation: {
      areaM2,
      depthMetres,
      baseVolumeM3,
      allowanceMultiplier,
      orderVolumeM3,
    },
    source: "quantity_rule_derived",
  });
}

export function buildMaterialOrder({
  itemCode,
  label,
  description,
  quantity,
  unit,
  sourceLineItemCode = null,
  section = null,
  itemMeta = null,
  unitCost = null,
  unitPrice = null,
  calculation = null,
  source = "quantity_rule",
  scope = null,
}) {
  const normalizedQuantity = roundQuantity(quantity);
  const normalizedUnitCost = unitCost == null ? null : roundMoney(unitCost);
  const normalizedUnitPrice = unitPrice == null ? null : roundMoney(unitPrice);
  return {
    code: `${slugify(String(sourceLineItemCode || source || "line-item"))}::${slugify(String(itemCode || "material"))}-order`,
    itemCode,
    label,
    description: formatCatalogUnitText(description),
    quantity: normalizedQuantity,
    unit,
    sourceLineItemCode,
    section,
    itemMeta: itemMeta || buildFallbackItemMeta({ itemCode, label, unit }),
    calculation: formatCatalogUnitText(calculation),
    unitCost: normalizedUnitCost,
    totalCost: normalizedUnitCost == null ? null : roundMoney(normalizedQuantity * normalizedUnitCost),
    unitPrice: normalizedUnitPrice,
    totalPrice: normalizedUnitPrice == null ? null : roundMoney(normalizedQuantity * normalizedUnitPrice),
    source,
    scope,
  };
}

function exactLine({
  itemCode,
  label,
  description,
  quantity,
  unit,
  unitCost,
  unitPrice,
  itemMeta = null,
  trace = null,
}) {
  return {
    itemCode,
    label,
    description: formatCatalogUnitText(description),
    quantity: roundQuantity(quantity),
    unit,
    unitCost: unitCost == null ? null : roundMoney(unitCost),
    unitPrice: unitPrice == null ? null : roundMoney(unitPrice),
    itemMeta: itemMeta || buildFallbackItemMeta({ itemCode, label, unit }),
    ...(trace ? { trace: normalizeStructuredTrace(trace) } : {}),
  };
}

function buildMaterialItemMeta(line) {
  const itemMeta = line.itemMeta || null;
  if (itemMeta) return {
    itemName: itemMeta.itemName || itemMeta.label || line.label || line.itemCode,
    itemGroup: itemMeta.itemGroup || null,
    isStockItem: itemMeta.isStockItem === true,
    stockUom: itemMeta.stockUom || itemMeta.unit || line.unit || "Nos",
  };
  return buildFallbackItemMeta({
    itemCode: line.itemCode,
    label: line.label,
    unit: line.unit,
    itemGroup: line.category === "materials" ? "Construction Materials" : null,
    isStockItem: line.category === "materials",
  });
}

// Line metadata from the line itself (names, groups and units belong to the
// price catalogue, not to a table here). Assembly lines say which of their
// components are stock materials.
function buildFallbackItemMeta({ itemCode, label, unit, itemGroup = null, isStockItem = null }) {
  return {
    itemName: label || itemCode,
    itemGroup: itemGroup || null,
    isStockItem: isStockItem === true,
    stockUom: unit || "Nos",
  };
}

function getQuantityRules(quoteCatalog, stage) {
  return (quoteCatalog?.quantityRules || []).filter((rule) => rule.stage === stage);
}

/**
 * Recipes the quote catalog defines as assemblies but does not list as a
 * quantity rule: the drainage buildup, and lawn or irrigation options sold as
 * "Select one" alternatives. Each is offered only when its mode's detector
 * matches the line (an explicit trench/pit scope for drainage).
 */
function getFallbackLineItemRules({ lineItem, baseRuleCode, configuredRules, quoteCatalog }) {
  return (quoteCatalog?.assemblies || [])
    .filter((assembly) => assembly.mode && !configuredRules.some((candidate) => candidate.mode === assembly.mode))
    .map((assembly) => ({
      code: assembly.code,
      stage: "line_item",
      mode: assembly.mode,
      assembly: assembly.code,
      appliesToRuleCodes: assembly.appliesToRuleCodes || [],
    }))
    .filter((rule) => {
      if (rule.mode === "lawn_bundle") return isLawnOption(lineItem) || matchesRuleCode(rule, baseRuleCode);
      if (rule.mode === "irrigation_bundle") return isIrrigationOption(lineItem) || matchesRuleCode(rule, baseRuleCode);
      if (rule.mode === "drainage_bundle") return isDrainageLineItem(lineItem, baseRuleCode, rule);
      return false;
    });
}

function matchesRuleCode(rule, baseRuleCode) {
  return Array.isArray(rule?.appliesToRuleCodes)
    && rule.appliesToRuleCodes.includes(baseRuleCode);
}

function isMaterialLine(line) {
  const meta = line?.itemMeta || {};
  if (meta.isStockItem === true) return true;
  if (DEFAULT_MATERIAL_ITEM_GROUPS.has(String(meta.itemGroup || ""))) return true;
  return line?.category === "materials";
}

function hasIrrigationComponentSignal(lineItem) {
  const text = joinLineItemText(lineItem);
  return /(battery|mains|control unit|controller|solenoid|sprinkler)/i.test(text);
}

function isDrainageLineItem(lineItem, baseRuleCode, rule = null) {
  // The drainage bundle is a buildup recipe (trench + pipe + gravel + pit +
  // labour + excavator). It only fires when the line item has explicit
  // trench/pit scope — otherwise direct pass-through from the catalog rate
  // is preferred so single-line "Drainage installation" quotes stay flat.
  const text = joinLineItemText(lineItem);
  const hasBuildupSignal = /\btrench\b|\bpits?\b|\bjunctions?\b|stormwater pit|drainage pit|\bsoakwells?\b|\bsoak\s*well\b|\bagi(?:\s+pipe)?\b|\bag\s+pipe\b|slotted pipe|gravel backfill/i.test(text);
  if (!hasBuildupSignal) return false;
  if (matchesRuleCode(rule, baseRuleCode)) return true;
  return /drainage|stormwater|drain\b/i.test(text);
}

function resolveLineLengthMetres({ lineItem, quote }) {
  const unit = String(lineItem?.unit || "").trim().toLowerCase();
  const quantity = Number(lineItem?.quantity || 0);
  if ((unit === "m" || unit === "lm" || unit === "metre" || unit === "metres") && quantity > 0) {
    return roundQuantity(quantity);
  }

  const candidates = [
    lineItem?.rationale,
    lineItem?.description,
    lineItem?.scopeSummary,
    lineItem?.label,
    quote?.summary,
  ];
  for (const candidate of candidates) {
    const parsed = parseLinearMetres(candidate);
    if (parsed > 0) return parsed;
  }
  return null;
}

function parseLinearMetres(value) {
  const text = String(value || "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:lm|m\b)/i);
  return match?.[1] ? roundQuantity(Number(match[1])) : null;
}

/**
 * A pit count stated in the line's scope ("3 pits", "2 junctions"), or null.
 * The drainage assembly turns it (or, without one, its pit spacing) into the
 * pit quantity.
 */
function resolveStatedPitCount(lineItem) {
  const text = joinLineItemText(lineItem);
  const explicit = text.match(/(\d+)\s*(?:pit|pits|junction|junctions)/i);
  return explicit?.[1] ? Number(explicit[1]) : null;
}

function isIrrigationOption(lineItem) {
  const text = joinLineItemText(lineItem);
  return /irrigation-option-/i.test(String(lineItem?.code || ""))
    || (
      /irrigation/i.test(String(lineItem?.section || ""))
      && /(battery|mains|control unit|controller|solenoid)/i.test(text)
    );
}

function isLawnOption(lineItem) {
  const text = joinLineItemText(lineItem);
  return /lawn-option-/i.test(String(lineItem?.code || ""))
    || (
      /lawn/i.test(String(lineItem?.section || ""))
      && /(buffalo|kikuyu|turf)/i.test(text)
    );
}

function resolveIrrigationOption(lineItem) {
  const text = joinLineItemText(lineItem);
  if (/no control unit install|customer handles control unit wiring/i.test(text)) {
    return "mains_no_install";
  }
  if (/mains|solenoid/i.test(text)) return "mains";
  return "battery";
}

function resolveLineAreaSquareMetres({ lineItem, quote }) {
  if (String(lineItem?.unit || "").trim().toLowerCase() === "m2" && Number(lineItem?.quantity || 0) > 0) {
    return roundQuantity(Number(lineItem.quantity));
  }

  const candidates = [
    lineItem?.rationale,
    lineItem?.description,
    lineItem?.scopeSummary,
    lineItem?.label,
    quote?.summary,
  ];
  for (const candidate of candidates) {
    const parsed = parseSquareMetres(candidate);
    if (parsed > 0) return parsed;
  }

  const siblingAreas = dedupeNumbers(
    (quote?.lineItems || [])
      .map((item) => parseSquareMetres(joinLineItemText(item)))
      .filter((value) => value > 0)
  );
  return siblingAreas.length === 1 ? siblingAreas[0] : null;
}

function resolveVolumeCubicMetres(lineItem) {
  if (String(lineItem?.unit || "").trim().toLowerCase() === "m3" && Number(lineItem?.quantity || 0) > 0) {
    return roundQuantity(Number(lineItem.quantity));
  }

  const candidates = [
    lineItem?.rationale,
    lineItem?.description,
    lineItem?.scopeSummary,
    lineItem?.label,
  ];
  for (const candidate of candidates) {
    const parsed = parseCubicMetres(candidate);
    if (parsed > 0) return parsed;
  }

  return null;
}

// A rule's rates are its price catalogue item's (the overlay), or null. No
// quote-catalog rate and no markup-derived cost: a missing rate fails closed.
function resolveRuleRates(rule) {
  return {
    unitCost: rule?.authorityPricing?.buyingRate != null ? roundMoney(Number(rule.authorityPricing.buyingRate)) : null,
    unitPrice: rule?.authorityPricing?.sellingRate != null ? roundMoney(Number(rule.authorityPricing.sellingRate)) : null,
  };
}

function resolveAuthorityItemCode(rule, fallback) {
  return String(
    rule?.priceCatalog?.code
    || rule?.authorityItemCode
    || rule?.authorityPricing?.itemCode
    || rule?.authorityItemCode
    || fallback
    || ""
  ).trim();
}

function buildTurfDescription(lineItem, areaM2) {
  const variety = String(lineItem?.label || "")
    .replace(/^option\s+\d+:\s*/i, "")
    .trim();
  if (variety) return `${variety} turf supply for ${formatQty(areaM2)} m2.`;
  return `Turf supply for ${formatQty(areaM2)} m2.`;
}

function buildLoamDescription({
  areaM2,
  depthMetres,
  baseVolumeM3,
  orderVolumeM3,
  upliftMultiplier,
}) {
  const depthMm = Math.round(Number(depthMetres || 0) * 1000);
  const upliftPercent = Math.round((Number(upliftMultiplier || 1) - 1) * 100);
  return `Sandy loam supply for ${formatQty(areaM2)} m2 at ${depthMm} mm depth. Base volume ${formatQty(baseVolumeM3)} m3; order allowance ${upliftPercent}% = ${formatQty(orderVolumeM3)} m3.`;
}

function joinLineItemText(lineItem) {
  return [
    lineItem?.section,
    lineItem?.label,
    lineItem?.description,
    lineItem?.rationale,
  ].filter(Boolean).join(" ");
}

/** A loam depth stated in the scope, or null (the assembly's default applies). */
function resolveLoamDepthMetres({ lineItem, quote }) {
  const candidates = [
    lineItem?.rationale,
    lineItem?.description,
    lineItem?.scopeSummary,
    lineItem?.label,
    ...(quote?.assumptionInputs || []).flatMap((item) => [item?.field, item?.value, item?.quoteNote]),
    quote?.summary,
  ];
  for (const candidate of candidates) {
    const parsed = parseLoamDepthMetres(candidate);
    if (parsed > 0) return parsed;
  }
  return null;
}

function parseLoamDepthMetres(value) {
  const text = String(value || "");
  if (!/(loam|topsoil)/i.test(text)) return null;
  const mmMatch = text.match(/(\d+(?:\.\d+)?)\s*mm/i);
  if (mmMatch?.[1]) return roundQuantity(Number(mmMatch[1]) / 1000);
  const cmMatch = text.match(/(\d+(?:\.\d+)?)\s*cm/i);
  if (cmMatch?.[1]) return roundQuantity(Number(cmMatch[1]) / 100);
  return null;
}

function parseSquareMetres(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*m(?:²|2)/i);
  return match?.[1] ? roundQuantity(Number(match[1])) : null;
}

function parseCubicMetres(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*m(?:³|3)/i);
  return match?.[1] ? roundQuantity(Number(match[1])) : null;
}

function renderTemplate(template, values) {
  if (!template) return null;
  let output = String(template);
  for (const [key, value] of Object.entries(values || {})) {
    output = output.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return output;
}

function extractBaseRuleCode(value) {
  return String(value || "").split("__")[0] || String(value || "");
}

function computeRoundedLineTotal(quantity, unitPrice) {
  if (unitPrice == null || !Number.isFinite(Number(unitPrice))) return null;
  return roundMoney(roundQuantity(quantity) * roundMoney(unitPrice));
}

function roundMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100) / 100;
}

function roundQuantity(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function formatMoney(value) {
  const rounded = roundMoney(value);
  if (rounded == null) return "unavailable";
  return `$${rounded.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatQty(value) {
  const numeric = Number(value || 0);
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(2).replace(/\.?0+$/, "");
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function dedupeBy(values, toKey) {
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

function dedupeNumbers(values) {
  return [...new Set((values || []).filter((value) => Number.isFinite(Number(value)) && Number(value) > 0))];
}

function sum(values) {
  return (values || []).reduce((total, value) => total + Number(value || 0), 0);
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
