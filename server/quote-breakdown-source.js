import { existsSync } from "./storage/fs.js";
import { readFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { buildClarificationNoteSummary } from "./clarification-notes.js";
import { formatCatalogUnitText } from "../shared/catalog-units.js";

export const QUOTE_BREAKDOWN_SOURCE_FILE = "quote-breakdown-source.json";

export async function readQuoteBreakdownSource(jobDir) {
  const filePath = join(jobDir, QUOTE_BREAKDOWN_SOURCE_FILE);
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function buildQuoteBreakdownSource({
  meta = null,
  evidencePack = null,
  quoteInputs = null,
  moasureSummary = null,
  details = null,
}) {
  const lineItemCandidates = asArray(quoteInputs?.lineItemCandidates);
  const measurements = asArray(quoteInputs?.measurements);
  const processReferences = asArray(quoteInputs?.processReferences);
  const siteConstraints = asArray(quoteInputs?.siteConstraints);
  const moasureImports = dedupeMoasureMeasurementImports(asArray(moasureSummary?.imports));
  const clarificationNoteSummary = buildClarificationNoteSummary(
    asArray(evidencePack?.evidence?.clarificationNotes)
  );
  const bulkRemovalPlans = buildBulkRemovalPlans({
    lineItemCandidates,
    measurements,
    moasureImports,
    soilDump: details?.soilDump || null,
  });

  return {
    kind: "quote-breakdown-source",
    version: 1,
    generatedAt: new Date().toISOString(),
    jobId: meta?.id || null,
    evidence: {
      transcriptSegmentCount: Number(evidencePack?.evidence?.segmentCount || 0),
      hasTimestampedSegments: evidencePack?.evidence?.hasTimestampedSegments === true,
      lineItemCandidateCount: lineItemCandidates.length,
      measurementCount: measurements.length,
      processReferenceCount: processReferences.length,
      siteConstraintCount: siteConstraints.length,
      moasureImportCount: moasureImports.length,
      moasurePdfCutFillCount: moasureImports.filter((item) => item?.measurement?.source === "pdf_cut_fill").length,
      clarificationNoteCount: clarificationNoteSummary.total,
      operatorClarificationNoteCount: clarificationNoteSummary.operatorCount,
      actionableClarificationNoteCount: clarificationNoteSummary.actionableCount,
      reviewRequestedNoteCount: clarificationNoteSummary.reviewRequestedCount,
      duplicationConcernNoteCount: clarificationNoteSummary.duplicationConcernCount,
    },
    sections: buildSections({
      lineItemCandidates,
      measurements,
      processReferences,
      siteConstraints,
      moasureImports,
      bulkRemovalPlans,
    }),
    quantityPlans: {
      bulkRemoval: bulkRemovalPlans,
    },
  };
}

export function findBulkRemovalPlanForSection({ breakdownSource, section }) {
  const plans = asArray(breakdownSource?.quantityPlans?.bulkRemoval);
  if (!plans.length) return null;

  const normalizedSection = normalizeSectionLabel(section);
  if (normalizedSection) {
    const exact = plans.find((plan) => normalizeSectionLabel(plan?.soilSection) === normalizedSection);
    if (exact) return exact;
  }

  return plans.length === 1 ? plans[0] : null;
}

function buildSections({
  lineItemCandidates,
  measurements,
  processReferences,
  siteConstraints,
  moasureImports,
  bulkRemovalPlans,
}) {
  const sectionMap = new Map();

  for (const candidate of lineItemCandidates) {
    const section = normalizeSectionLabel(candidate?.section) || "Ungrouped";
    if (!sectionMap.has(section)) {
      sectionMap.set(section, {
        section,
        quoteInputItems: [],
        measurements: [],
        processReferences: [],
        siteConstraints: [],
        moasureImports: [],
        quantityPlans: [],
      });
    }
    sectionMap.get(section).quoteInputItems.push(summarizeQuoteInputCandidate(candidate));
  }

  for (const measurement of measurements) {
    const sectionKey = resolveBestSectionKey({
      sectionMap,
      label: measurement?.label,
      fallback: "General measurements",
    });
    if (!sectionMap.has(sectionKey)) {
      sectionMap.set(sectionKey, {
        section: sectionKey,
        quoteInputItems: [],
        measurements: [],
        processReferences: [],
        siteConstraints: [],
        moasureImports: [],
        quantityPlans: [],
      });
    }
    sectionMap.get(sectionKey).measurements.push(summarizeMeasurement(measurement));
  }

  for (const reference of processReferences) {
    const sectionKey = resolveBestSectionKey({
      sectionMap,
      label: reference?.label || reference?.detail,
      fallback: "Process references",
    });
    if (!sectionMap.has(sectionKey)) {
      sectionMap.set(sectionKey, {
        section: sectionKey,
        quoteInputItems: [],
        measurements: [],
        processReferences: [],
        siteConstraints: [],
        moasureImports: [],
        quantityPlans: [],
      });
    }
    sectionMap.get(sectionKey).processReferences.push({
      label: reference?.label || null,
      detail: reference?.detail || null,
      kind: reference?.kind || null,
      segmentIds: asArray(reference?.segmentIds),
    });
  }

  for (const constraint of siteConstraints) {
    const sectionKey = resolveBestSectionKey({
      sectionMap,
      label: constraint?.label || constraint?.detail,
      fallback: "Site constraints",
    });
    if (!sectionMap.has(sectionKey)) {
      sectionMap.set(sectionKey, {
        section: sectionKey,
        quoteInputItems: [],
        measurements: [],
        processReferences: [],
        siteConstraints: [],
        moasureImports: [],
        quantityPlans: [],
      });
    }
    sectionMap.get(sectionKey).siteConstraints.push({
      label: constraint?.label || null,
      detail: constraint?.detail || null,
      segmentIds: asArray(constraint?.segmentIds),
    });
  }

  for (const plan of bulkRemovalPlans) {
    const sectionKey = normalizeSectionLabel(plan?.soilSection) || "Earthworks";
    if (!sectionMap.has(sectionKey)) {
      sectionMap.set(sectionKey, {
        section: sectionKey,
        quoteInputItems: [],
        measurements: [],
        processReferences: [],
        siteConstraints: [],
        moasureImports: [],
        quantityPlans: [],
      });
    }
    sectionMap.get(sectionKey).quantityPlans.push(plan);
    sectionMap.get(sectionKey).moasureImports.push(...asArray(plan?.rawEvidence?.matchedImports));
  }

  for (const section of sectionMap.values()) {
    section.moasureImports = dedupeBy(section.moasureImports, (item) => (
      `${slugifySection(item?.label)}::${item?.measurement?.signature || item?.measurement?.source || ""}`
    ));
  }

  return [...sectionMap.values()].sort((a, b) => String(a.section).localeCompare(String(b.section)));
}

function buildBulkRemovalPlans({
  lineItemCandidates,
  measurements,
  moasureImports,
  soilDump,
}) {
  const soilCandidates = lineItemCandidates.filter((candidate) => resolveCandidateCode(candidate) === "soil-removal");
  if (!soilCandidates.length) return [];

  const haulageCandidates = lineItemCandidates.filter((candidate) => resolveCandidateCode(candidate) === "tip-truck");
  const soilGroups = groupCandidatesBySection(soilCandidates);

  return soilGroups.map(({ section, candidates }) => {
    const matchedImports = matchMoasureImportsForSoilSection({
      section,
      candidates,
      soilGroupCount: soilGroups.length,
      moasureImports,
    });
    const measurementPlan = aggregateMoasureMeasurementPlan(matchedImports);
    const relevantHaulageCandidates = resolveRelevantHaulageCandidates({
      haulageCandidates,
      soilSection: section,
    });
    const explicitSoilQuantityM3 = roundQuantity(sumFinite(candidates.map((candidate) => candidate?.quantity)));
    const explicitHaulageLoads = roundQuantity(sumFinite(relevantHaulageCandidates.map((candidate) => candidate?.quantity)));

    return {
      id: `bulk-removal:${slugifySection(section || "soil-removal")}`,
      soilSection: section || null,
      haulageSection: normalizeSectionLabel(relevantHaulageCandidates[0]?.section) || null,
      rawEvidence: {
        matchedImports: matchedImports.map((item) => ({
          label: item.label,
          batchId: item.batchId,
          csvFile: item.csvFile,
          pdfFile: item.measurement?.pdfFile || null,
          measurement: {
            source: item.measurement?.source || null,
            surfaceAreaM2: item.measurement?.surfaceAreaM2 ?? null,
            surfaceVolumeM3: item.measurement?.surfaceVolumeM3 ?? null,
            grossCutVolumeM3: item.measurement?.grossCutVolumeM3 ?? null,
            fillVolumeM3: item.measurement?.fillVolumeM3 ?? null,
            netExportVolumeM3: item.measurement?.netExportVolumeM3 ?? null,
            signature: item.measurement?.signature || null,
          },
          duplicateCount: item.duplicateCount || 1,
        })),
        quoteMeasurements: measurements.map(summarizeMeasurement),
        ...(soilDump ? {
          soilDump: {
            id: soilDump.id || null,
            name: soilDump.name || null,
            drive: soilDump.drive ?? null,
            dist: soilDump.dist ?? null,
          },
        } : {}),
      },
      measurements: measurementPlan,
      explicit: {
        soilRemovalQuantityM3: explicitSoilQuantityM3 > 0 ? explicitSoilQuantityM3 : null,
        haulageLoads: explicitHaulageLoads > 0 ? explicitHaulageLoads : null,
      },
      chosen: {
        soilRemovalQuantityM3: explicitSoilQuantityM3 > 0
          ? explicitSoilQuantityM3
          : (measurementPlan?.grossCutVolumeM3 ?? null),
        haulageLoads: explicitHaulageLoads > 0 ? explicitHaulageLoads : null,
        soilRemovalSource: explicitSoilQuantityM3 > 0
          ? "quote_input"
          : (measurementPlan ? measurementPlan.source : null),
        haulageSource: explicitHaulageLoads > 0 ? "quote_input" : null,
      },
    };
  });
}

function matchMoasureImportsForSoilSection({
  section,
  candidates,
  soilGroupCount,
  moasureImports,
}) {
  if (!moasureImports.length) return [];
  if (soilGroupCount === 1) return moasureImports;

  const hints = [
    section,
    ...candidates.map((candidate) => candidate?.label),
    ...candidates.map((candidate) => candidate?.description),
    ...candidates.map((candidate) => candidate?.rationale),
  ].filter(Boolean);
  const sectionTokens = tokenizeText(hints.join(" "));
  const scored = moasureImports.map((item) => ({
    item,
    score: overlapScore(sectionTokens, tokenizeText(item?.label)),
  }));
  const matched = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  return matched.length ? matched.map((entry) => entry.item) : moasureImports;
}

function resolveRelevantHaulageCandidates({ haulageCandidates, soilSection }) {
  if (haulageCandidates.length <= 1) return haulageCandidates;
  const soilTokens = tokenizeText(soilSection);
  const matched = haulageCandidates.filter((candidate) => (
    overlapScore(soilTokens, tokenizeText(candidate?.section || candidate?.label || candidate?.description)) > 0
  ));
  return matched.length ? matched : haulageCandidates;
}

function aggregateMoasureMeasurementPlan(imports) {
  if (!imports.length) return null;

  let grossCutVolumeM3 = 0;
  let fillVolumeM3 = 0;
  let surfaceAreaM2 = 0;
  let usedPdfCutFill = false;

  for (const item of imports) {
    const measurement = item?.measurement || null;
    if (!measurement) continue;
    grossCutVolumeM3 += Number(measurement.grossCutVolumeM3 || 0);
    fillVolumeM3 += Number(measurement.fillVolumeM3 || 0);
    surfaceAreaM2 += Number(measurement.surfaceAreaM2 || 0);
    if (measurement.source === "pdf_cut_fill") usedPdfCutFill = true;
  }

  const roundedGrossCutVolumeM3 = roundQuantity(Math.max(0, grossCutVolumeM3));
  const roundedFillVolumeM3 = roundQuantity(Math.max(0, fillVolumeM3));

  return {
    source: usedPdfCutFill ? "pdf_cut_fill" : "csv_contour_fallback",
    importCount: imports.length,
    surfaceAreaM2: roundQuantity(surfaceAreaM2),
    grossCutVolumeM3: roundedGrossCutVolumeM3,
    fillVolumeM3: roundedFillVolumeM3,
    netExportVolumeM3: roundQuantity(Math.max(0, roundedGrossCutVolumeM3 - roundedFillVolumeM3)),
  };
}

function dedupeMoasureMeasurementImports(imports) {
  const deduped = new Map();
  for (const item of imports) {
    const measurement = extractMeasurementFromImport(item);
    if (!measurement) continue;
    const signature = `${resolveMeasurementIdentity(item, measurement)}::${measurement.signature}`;
    if (deduped.has(signature)) {
      deduped.get(signature).duplicateCount += 1;
      continue;
    }
    deduped.set(signature, {
      ...item,
      measurement,
      duplicateCount: 1,
    });
  }
  return [...deduped.values()];
}

function extractMeasurementFromImport(item) {
  if (!item) return null;
  const cutFill = item.cutFillSummary
    || asArray(item.relatedPdfSummaries)
      .map((summary) => summary?.cutFill)
      .find(Boolean)
    || null;
  if (cutFill) {
    const grossCutVolumeM3 = roundQuantity(Math.max(0, Number(cutFill.cutVolumeM3 || 0)));
    const fillVolumeM3 = roundQuantity(Math.max(0, Number(cutFill.fillVolumeM3 || 0)));
    // Moasure cut/fill exports can contain negative fill figures on narrow retaining-only
    // slices. For bulk removal planning we only trust positive cut/fill volumes and derive
    // net export from those clamped values so we do not invent spoil from signed display quirks.
    const netExportVolumeM3 = roundQuantity(Math.max(0, grossCutVolumeM3 - fillVolumeM3));
    return {
      source: "pdf_cut_fill",
      pdfFile: asArray(item.relatedPdfSummaries).find((summary) => summary?.cutFill)?.pdfFile || null,
      title: cutFill.title || item.label || null,
      surfaceAreaM2: firstFinite([cutFill.surfaceAreaM2, item.area]),
      surfaceVolumeM3: asArray(item.relatedPdfSummaries)
        .flatMap((summary) => asArray(summary?.pages))
        .find((page) => page?.cutFill)?.surfaceVolumeM3
        ?? null,
      grossCutVolumeM3,
      fillVolumeM3,
      netExportVolumeM3,
      selectedLevelMm: cutFill.selectedLevelMm ?? null,
      signature: [
        roundQuantity(grossCutVolumeM3),
        roundQuantity(fillVolumeM3),
        roundQuantity(netExportVolumeM3),
        roundQuantity(firstFinite([cutFill.surfaceAreaM2, item.area]) || 0),
      ].join(":"),
    };
  }

  // If the item has an explicit volume from the CSV, use it directly
  if (Number.isFinite(Number(item.volume)) && Number(item.volume) > 0) {
    const vol = roundQuantity(Number(item.volume));
    return {
      source: "csv_contour_fallback",
      pdfFile: null,
      title: item.label || null,
      surfaceAreaM2: firstFinite([item.area]),
      surfaceVolumeM3: null,
      grossCutVolumeM3: vol,
      fillVolumeM3: 0,
      netExportVolumeM3: vol,
      selectedLevelMm: null,
      calculationWorking: formatCatalogUnitText(`CSV provided explicit volume: ${vol} m3`),
      signature: [vol, roundQuantity(firstFinite([item.area]) || 0)].join(":"),
    };
  }

  // No volume data — return area-only measurement so the system can flag it as a gap
  const area = firstFinite([item.area]);
  const elevRange = firstFinite([item.elevationRange]);
  if (!(area > 0)) return null;

  // Estimate using average depth = elevationRange / 3 (pyramid approximation, not full-box)
  // This is explicitly an estimate — always show working
  const avgDepthM = elevRange > 0 ? roundQuantity(elevRange / 3) : 0;
  const estimatedVolumeM3 = roundQuantity(area * avgDepthM);

  return {
    source: "csv_contour_estimate",
    pdfFile: null,
    title: item.label || null,
    surfaceAreaM2: area,
    surfaceVolumeM3: null,
    grossCutVolumeM3: estimatedVolumeM3,
    fillVolumeM3: 0,
    netExportVolumeM3: estimatedVolumeM3,
    selectedLevelMm: null,
    isEstimate: true,
    calculationWorking: formatCatalogUnitText([
      `No cut/fill survey — estimated from CSV contour data:`,
      `Area: ${area} m2 (from "${item.label || "unknown"}" CSV)`,
      `Elevation range: ${elevRange || 0} m (highest - lowest survey point)`,
      `Average depth: ${avgDepthM} m (elevRange / 3 — pyramid approximation)`,
      `Volume: ${area} m2 × ${avgDepthM} m = ${estimatedVolumeM3} m3`,
      `⚠ This is an estimate. For accurate volume, provide a cut/fill PDF or operator measurement.`,
    ].join("\n")),
    signature: [estimatedVolumeM3, area, elevRange || 0].join(":"),
  };
}

function resolveMeasurementIdentity(item, measurement) {
  return slugifySection(
    measurement?.title
    || item?.pdfFile
    || item?.csvFile
    || item?.label
    || ""
  );
}

function summarizeQuoteInputCandidate(candidate) {
  return {
    itemCode: resolveCandidateCode(candidate),
    label: candidate?.label || null,
    description: candidate?.description || null,
    quantity: firstFinite([candidate?.quantity]),
    unit: candidate?.unit || null,
    rationale: candidate?.rationale || null,
    confidence: firstFinite([candidate?.confidence]),
    segmentIds: collectSegmentIds(candidate),
  };
}

function summarizeMeasurement(measurement) {
  return {
    label: measurement?.label || null,
    value: measurement?.value ?? null,
    unit: measurement?.unit || null,
    source: measurement?.source || null,
    segmentIds: asArray(measurement?.segmentIds),
  };
}

function collectSegmentIds(candidate) {
  const evidenceSegmentIds = asArray(candidate?.evidence)
    .map((entry) => entry?.segmentId)
    .filter(Boolean);
  return dedupeBy(
    [...evidenceSegmentIds, ...asArray(candidate?.segmentIds)],
    (value) => String(value || "")
  );
}

function groupCandidatesBySection(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const section = normalizeSectionLabel(candidate?.section) || candidate?.label || "Ungrouped";
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(candidate);
  }
  return [...groups.entries()].map(([section, groupedCandidates]) => ({
    section,
    candidates: groupedCandidates,
  }));
}

function resolveBestSectionKey({ sectionMap, label, fallback }) {
  const sections = [...sectionMap.keys()];
  if (!sections.length) return fallback;
  const labelTokens = tokenizeText(label);
  let bestSection = null;
  let bestScore = 0;
  for (const section of sections) {
    const score = overlapScore(labelTokens, tokenizeText(section));
    if (score > bestScore) {
      bestScore = score;
      bestSection = section;
    }
  }
  return bestScore > 0 ? bestSection : fallback;
}

function resolveCandidateCode(candidate) {
  return String(
    candidate?.quoteCatalogItemCode
    || candidate?.priceListItemCode
    || candidate?.pricingReferenceId
    || candidate?.code
    || ""
  ).trim();
}

function normalizeSectionLabel(value) {
  const text = String(value || "").trim();
  return text || null;
}

function slugifySection(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokenizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function overlapScore(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  return left.reduce((score, token) => score + (rightSet.has(token) ? 1 : 0), 0);
}

function dedupeBy(values, toKey) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = toKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function firstFinite(values) {
  for (const value of values || []) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function sumFinite(values) {
  return (values || []).reduce((sum, value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? sum + numeric : sum;
  }, 0);
}

function roundQuantity(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 10000) / 10000;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
