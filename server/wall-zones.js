import { existsSync } from "./storage/fs.js";
import { readFile } from "./storage/fs-promises.js";
import { join, resolve } from "node:path";
import { buildRetainingWallCommercialBreakdown } from "./retaining-wall-commercial.js";
import { buildBayModel } from "./retaining-wall-engine.js";
import { deriveWallZoneMeasurement, readMoasureCsv } from "./wall-zone-measurement.js";
import { buildRetainingWallRenderPayload, normalizeWallSourceMode } from "../shared/retaining-wall-render.js";
import { resolveActiveJobGeneration } from "./job-generation.js";

export const WALL_ZONES_FILE = "wall-zones.json";

export async function readWallZones(jobDir) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const configPath = join(jobDir, WALL_ZONES_FILE);
  if (existsSync(configPath)) {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    return normalizeWallZonesConfig(raw);
  }

  const fallbackZone = await buildSingleWallFallbackZone(jobDir);
  if (!fallbackZone) return null;
  return {
    kind: "wall-zones",
    version: 1,
    source: "single_wall_fallback",
    zones: [fallbackZone],
  };
}

export async function buildWallZoneRenderPayloadForJob({
  jobDir,
  operationalJobDir = null,
  zoneId,
  quote = null,
  moasureSummary = null,
  rateCard = null,
}) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const wallZones = await readWallZones(jobDir);
  const zone = wallZones?.zones?.find((entry) => entry.id === zoneId);
  if (!zone) return null;

  const artifact = await readWallZoneArtifact({ jobDir, operationalJobDir, zone, rateCard });
  if (!artifact?.model) return null;
  const measurementOverlay = await loadWallZoneMeasurementOverlay({
    jobDir,
    operationalJobDir,
    zone,
    measurement: artifact.measurement || null,
    moasureSummary,
  });
  const modelPricing = buildWallZoneModelPricing({ model: artifact.model });
  const lengthValidation = validateWallZoneLength({ zone, artifact });
  const notes = Array.isArray(zone.notes) && zone.notes.length ? zone.notes : (artifact.notes || []);
  const validationNotes = lengthValidation.ok ? [] : [lengthValidation.message];

  return buildRetainingWallRenderPayload({
    zone: {
      ...zone,
      notes: [...notes, ...validationNotes],
    },
    model: artifact.model,
    sourceMode: artifact.sourceMode || zone.sourceMode || null,
    pricing: resolveWallZonePricing({ zone, quote, fallbackPricing: modelPricing }),
    measurementOverlay,
  });
}

export async function buildRetainingWallQuoteContextForJob({
  jobDir,
  operationalJobDir = null,
  rateCard = null,
}) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  if (!rateCard || typeof rateCard !== "object") return null;

  const wallZones = await readWallZones(jobDir);
  const zones = Array.isArray(wallZones?.zones) ? wallZones.zones : [];
  if (!zones.length) return null;

  const exactZones = [];
  for (const zone of zones) {
    const artifact = await readWallZoneArtifact({ jobDir, operationalJobDir, zone, rateCard });
    if (!artifact?.model) continue;
    const lengthValidation = validateWallZoneLength({ zone, artifact });
    if (!lengthValidation.ok) {
      console.warn(`[wall-zones] skipping exact retaining-wall pricing for ${zone.id}: ${lengthValidation.message}`);
      continue;
    }

    let commercial;
    try {
      commercial = buildRetainingWallCommercialBreakdown({
        model: artifact.model,
        design: artifact.design || {},
        rateCard,
      });
    } catch (error) {
      console.warn(`[wall-zones] exact retaining-wall pricing failed for ${zone.id}: ${error.message}`);
      continue;
    }

    const wallTotals = commercial?.totals?.byScope?.wall || {
      chargeTotal: buildWallZoneModelPricing({ model: artifact.model }).charge,
      costTotal: buildWallZoneModelPricing({ model: artifact.model }).cost,
    };
    const ancillaryTotals = commercial?.totals?.byScope?.ancillary || { chargeTotal: 0, costTotal: 0 };
    const ancillaryNote = ancillaryTotals.chargeTotal > 0 || ancillaryTotals.costTotal > 0
      ? `Ancillary wall-engine scope remains priced outside this section: ${formatMoney(ancillaryTotals.chargeTotal)} charge / ${formatMoney(ancillaryTotals.costTotal)} cost.`
      : null;

    exactZones.push({
      ...zone,
      sourceMode: artifact.sourceMode || zone.sourceMode || null,
      model: artifact.model,
      measurement: artifact.measurement || null,
      modelPricing: buildWallZoneModelPricing({
        model: artifact.model,
        wallTotals,
      }),
      exactWallBreakdown: {
        recipe: "retaining_wall_exact",
        note: ancillaryNote,
        commercialLines: (commercial?.commercialLines || []).filter((line) => line?.scope === "wall"),
        budgetLines: (commercial?.budgetLines || []).filter((line) => line?.scope === "wall"),
        materialOrders: (commercial?.materialOrders || []).filter((order) => order?.sourceLineItemCode === "cs-wall"),
        totals: {
          charge: roundMoney(wallTotals.chargeTotal),
          cost: roundMoney(wallTotals.costTotal),
        },
        modelPricing: buildWallZoneModelPricing({
          model: artifact.model,
          wallTotals,
        }),
      },
    });
  }

  if (!exactZones.length) return null;
  return {
    kind: "retaining_wall_quote_context",
    version: 1,
    zones: exactZones,
  };
}

export function findWallZonesForBreakdown({ breakdown, wallZones }) {
  const zones = Array.isArray(wallZones?.zones) ? wallZones.zones : [];
  if (!zones.length || !isRetainingWallBreakdown(breakdown)) return [];

  const matches = findMatchingWallZones({
    sourceCode: breakdown?.sourceLineItemCode,
    sourceSection: breakdown?.sourceSection || breakdown?.section,
    sourceLabel: breakdown?.sourceLineItemLabel || breakdown?.label,
    sourceQuantity: breakdown?.sourceQuantity,
    wallZones,
  });

  if (matches.length) return matches;
  if (zones.length === 1 && !/_ancillary$/.test(String(breakdown?.recipe || ""))) return zones;
  return [];
}

export function findRetainingWallZoneForLineItem({ lineItem, retainingWallContext }) {
  if (!isRetainingWallLineItem(lineItem)) return null;
  const matches = findMatchingWallZones({
    sourceCode: lineItem?.code,
    sourceSection: lineItem?.section,
    sourceLabel: lineItem?.label,
    sourceQuantity: lineItem?.quantity,
    wallZones: retainingWallContext,
  });
  return matches[0] || null;
}

function isRetainingWallBreakdown(breakdown) {
  const recipe = String(breakdown?.recipe || "");
  if (/^retaining_wall_|^rock_wall_/.test(recipe)) return true;

  const sourceCode = String(breakdown?.sourceLineItemCode || "").trim().toLowerCase();
  if (
    sourceCode === "cs-wall"
    || sourceCode === "rock-wall"
    || sourceCode.startsWith("retaining-wall__")
    || sourceCode.startsWith("rock-wall__")
  ) {
    return true;
  }

  const section = String(breakdown?.sourceSection || breakdown?.section || "").trim().toLowerCase();
  const label = String(breakdown?.sourceLineItemLabel || breakdown?.label || "").trim().toLowerCase();
  return section.includes("retaining wall") || label.includes("retaining wall") || label.includes("rock wall");
}

function isRetainingWallLineItem(lineItem) {
  const code = String(lineItem?.code || "").trim().toLowerCase();
  const quoteCatalogItemCode = String(lineItem?.quoteCatalogItemCode || "").trim().toLowerCase();
  if (
    quoteCatalogItemCode === "retaining-wall"
    || quoteCatalogItemCode === "rock-wall"
    || code === "cs-wall"
    || code === "rock-wall"
    || code.startsWith("retaining-wall__")
    || code.startsWith("rock-wall__")
  ) {
    return true;
  }

  const section = String(lineItem?.section || "").trim().toLowerCase();
  const label = String(lineItem?.label || "").trim().toLowerCase();
  return section.includes("retaining wall") || label.includes("retaining wall") || label.includes("rock wall");
}

async function buildSingleWallFallbackZone(jobDir) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const bayModelPath = join(jobDir, "bay-model.json");
  if (!existsSync(bayModelPath)) return null;

  const heightsPath = join(jobDir, "bay-heights.json");
  const designPath = join(jobDir, "wall-design.json");
  const design = existsSync(designPath)
    ? JSON.parse(await readFile(designPath, "utf8"))
    : null;
  const heights = existsSync(heightsPath)
    ? JSON.parse(await readFile(heightsPath, "utf8"))
    : null;
  const sourceMode = normalizeWallSourceMode(heights?.sourceMode || "probe");

  return normalizeZone({
    id: "primary-wall",
    title: design?.title || design?._description || "Primary retaining wall",
    subtitle: design?._address || null,
    lineItemCodes: ["cs-wall", "rock-wall"],
    sections: [
      "Option 1: Concrete Sleeper Retaining Wall",
      "Option 2: Mixed Rock Wall",
    ],
    sourceMode: sourceMode.id,
    sourceModeDetail: sourceMode.detail,
    notes: sourceMode.id === "probe"
      ? ["Rendered from the stored production bay model for this wall job."]
      : ["Rendered from a stored fallback bay model for this wall job."],
    wallDesignPath: existsSync(designPath) ? "wall-design.json" : null,
    bayHeightsPath: existsSync(heightsPath) ? "bay-heights.json" : null,
    bayModelPath: "bay-model.json",
  });
}

async function readWallZoneArtifact({ jobDir, operationalJobDir = null, zone, rateCard = null }) {
  const dynamicArtifact = await buildDynamicWallZoneArtifact({ jobDir, operationalJobDir, zone, rateCard });
  if (dynamicArtifact?.model) return dynamicArtifact;

  const modelPath = resolveJobPath(jobDir, zone.bayModelPath);
  if (!modelPath || !existsSync(modelPath)) return null;
  const parsed = JSON.parse(await readFile(modelPath, "utf8"));
  const designPath = resolveJobPath(jobDir, zone.wallDesignPath);
  const design = designPath && existsSync(designPath)
    ? JSON.parse(await readFile(designPath, "utf8"))
    : null;

  if (parsed?.model && typeof parsed.model === "object") {
    const measurement = parsed.measurement && typeof parsed.measurement === "object"
      ? parsed.measurement
      : null;
    return {
      model: parsed.model,
      design,
      notes: Array.isArray(parsed?.zone?.notes) ? parsed.zone.notes : [],
      sourceMode: measurement?.sourceMode || zone.sourceMode || null,
      measurement,
    };
  }

  const heightsPath = resolveJobPath(jobDir, zone.bayHeightsPath);
  const heights = heightsPath && existsSync(heightsPath)
    ? JSON.parse(await readFile(heightsPath, "utf8"))
    : null;

  return {
    model: parsed,
    design,
    notes: zone.notes || [],
    sourceMode: heights?.sourceMode || zone.sourceMode || null,
    measurement: heights || null,
  };
}

async function buildDynamicWallZoneArtifact({
  jobDir,
  operationalJobDir = null,
  zone,
  rateCard = null,
}) {
  // Without a live catalogue rate card there is no dynamic model: the caller
  // falls through to stored immutable geometry, and money is never
  // recreated from code defaults (there are none).
  if (!rateCard || typeof rateCard !== "object") return null;
  const csvPath = resolveMeasurementCsvPath({ jobDir, operationalJobDir, relativePath: zone.sourceCsvPath });
  if (!csvPath || !existsSync(csvPath)) return null;

  const designPath = resolveJobPath(jobDir, zone.wallDesignPath || "wall-design.json");
  const design = designPath && existsSync(designPath)
    ? JSON.parse(await readFile(designPath, "utf8"))
    : (zone.design && typeof zone.design === "object" ? zone.design : null);
  if (!design || typeof design !== "object") return null;

  const points = await readMoasureCsv(csvPath);
  const measurement = deriveWallZoneMeasurement({
    points,
    zone,
    design,
  });
  const model = buildBayModel({
    bayHeights: measurement.bayHeights,
    bayGeometry: measurement.bayGeometry,
    bendAngles: measurement.bendAngles,
    design,
    rateCard,
  });
  model.perimeter_m = measurement.perimeter_m;

  return {
    model,
    design,
    notes: zone.notes || [],
    sourceMode: measurement.sourceMode || zone.sourceMode || null,
    measurement,
  };
}

function normalizeWallZonesConfig(raw) {
  const defaultDesign = raw?.defaultDesign && typeof raw.defaultDesign === "object"
    ? raw.defaultDesign
    : (raw?.baseDesign && typeof raw.baseDesign === "object" ? raw.baseDesign : null);
  const zones = Array.isArray(raw?.zones)
    ? raw.zones.map((zone) => normalizeZone(zone, { defaultDesign })).filter(Boolean)
    : [];
  return {
    kind: "wall-zones",
    version: Number(raw?.version || 1),
    source: "job_file",
    zones,
  };
}

function normalizeZone(zone, {
  defaultDesign = null,
} = {}) {
  if (!zone || typeof zone !== "object") return null;
  const id = String(zone.id || "").trim();
  const bayModelPath = String(zone.bayModelPath || zone.outputJson || "").trim();
  const sourceCsvPath = String(zone.sourceCsvPath || zone.csv || "").trim();
  if (!id || (!bayModelPath && !sourceCsvPath)) return null;

  const normalizedSourceMode = normalizeWallSourceMode(
    zone.sourceMode
    || zone.sourceModeDetail
    || zone.heightSourceFallback
    || null
  );

  return {
    id,
    title: String(zone.title || id).trim(),
    subtitle: zone.subtitle ? String(zone.subtitle).trim() : null,
    lineItemCodes: normalizeStringList(zone.lineItemCodes),
    sections: normalizeStringList(zone.sections),
    sourceMode: normalizedSourceMode.id,
    sourceModeDetail: normalizedSourceMode.detail,
    notes: normalizeStringList(zone.notes),
    design: zone.design && typeof zone.design === "object" ? zone.design : defaultDesign,
    expectedLengthM: normalizePositiveNumber(zone.expectedLengthM),
    maxLengthDriftM: normalizePositiveNumber(zone.maxLengthDriftM),
    maxLengthDriftRatio: normalizePositiveNumber(zone.maxLengthDriftRatio),
    profileSegment: normalizeProfileSegment(zone.profileSegment),
    sourceCsvPath,
    sourcePdfPath: zone.sourcePdfPath ? String(zone.sourcePdfPath).trim() : (zone.pdf ? String(zone.pdf).trim() : null),
    wallDesignPath: zone.wallDesignPath ? String(zone.wallDesignPath).trim() : null,
    bayHeightsPath: zone.bayHeightsPath ? String(zone.bayHeightsPath).trim() : null,
    bayModelPath: bayModelPath || null,
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

async function loadWallZoneMeasurementOverlay({
  jobDir,
  operationalJobDir = null,
  zone,
  measurement = null,
  moasureSummary = null,
}) {
  const points = await readWallZoneOverlayPoints({ jobDir, operationalJobDir, zone, moasureSummary });
  if (!points?.length) return null;

  const path1 = points
    .filter((point) => String(point.path || "").trim() === "1")
    .map((point) => ({
      x: Number(point.x),
      y: Number(point.y),
      z: Number(point.z),
      point: point.point,
      pointLabel: Number.isFinite(Number(point.point)) ? Number(point.point) : null,
    }));

  const probeCandidates = points.filter((point) => String(point.path || "").trim() !== "1");
  const bayGeometry = Array.isArray(measurement?.bayGeometry) ? measurement.bayGeometry : [];
  const bayHeightLookup = new Map(
    (Array.isArray(measurement?.bayHeights) ? measurement.bayHeights : [])
      .filter((entry) => entry?.bay_id != null)
      .map((entry) => [Number(entry.bay_id), Number(entry.height_m || 0)])
  );

  const path2 = probeCandidates.map((point) => {
    const nearestPath1 = findNearestPath1Point(point, path1);
    const nearestBay = findNearestBayGeometry(point, bayGeometry);
    return {
      x: Number(point.x),
      y: Number(point.y),
      z: Number(point.z),
      point: point.point,
      pointLabel: Number.isFinite(Number(point.point)) ? Number(point.point) : null,
      nearestBayId: nearestBay?.bayId ?? null,
      heightToNearestBayM: nearestBay?.bayId != null
        ? roundMeasurementValue(bayHeightLookup.get(nearestBay.bayId))
        : null,
      measuredDropM: nearestPath1
        ? roundMeasurementValue(Number(nearestPath1.z) - Number(point.z))
        : null,
    };
  });

  if (!path1.length && !path2.length) return null;
  return {
    path1,
    path2,
  };
}

async function readWallZoneOverlayPoints({ jobDir, operationalJobDir = null, zone, moasureSummary = null }) {
  const explicitCsvPath = resolveMeasurementCsvPath({ jobDir, operationalJobDir, relativePath: zone?.sourceCsvPath });
  if (explicitCsvPath && existsSync(explicitCsvPath)) {
    return readMoasureCsv(explicitCsvPath);
  }

  const imports = Array.isArray(moasureSummary?.imports) ? moasureSummary.imports : [];
  const matchedImport = findBestWallZoneSourceMatch({
    zone,
    items: imports,
    getSource: (entry) => ({
      sourceCode: entry?.csvFile,
      sourceSection: entry?.label,
      sourceLabel: entry?.label || entry?.csvFile,
      sourceQuantity: entry?.perimeter,
    }),
  });

  if (matchedImport?.batchId && matchedImport?.csvFile) {
    const importCsvPath = resolveMeasurementCsvPath({
      jobDir,
      operationalJobDir,
      relativePath: `moasure/raw/${matchedImport.batchId}/${matchedImport.csvFile}`,
    });
    if (importCsvPath && existsSync(importCsvPath)) {
      return readMoasureCsv(importCsvPath);
    }
  }

  return [];
}

function findNearestPath1Point(point, path1Points) {
  if (!Array.isArray(path1Points) || !path1Points.length) return null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const candidate of path1Points) {
    const dx = Number(candidate.x) - Number(point.x);
    const dy = Number(candidate.y) - Number(point.y);
    const dist = (dx * dx) + (dy * dy);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = candidate;
    }
  }
  return nearest;
}

function findNearestBayGeometry(point, bayGeometry) {
  if (!Array.isArray(bayGeometry) || !bayGeometry.length) return null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const bay of bayGeometry) {
    if (
      bay?.x_start == null
      || bay?.y_start == null
      || bay?.x_end == null
      || bay?.y_end == null
    ) continue;
    const dist = squaredDistanceToSegment2d({
      px: Number(point.x),
      py: Number(point.y),
      ax: Number(bay.x_start),
      ay: Number(bay.y_start),
      bx: Number(bay.x_end),
      by: Number(bay.y_end),
    });
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = { bayId: Number(bay.bay_id) };
    }
  }
  return nearest;
}

function squaredDistanceToSegment2d({ px, py, ax, ay, bx, by }) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = (abx * abx) + (aby * aby);
  if (abLenSq <= 1e-9) {
    const dx = px - ax;
    const dy = py - ay;
    return (dx * dx) + (dy * dy);
  }
  const t = Math.max(0, Math.min(1, ((apx * abx) + (apy * aby)) / abLenSq));
  const cx = ax + (abx * t);
  const cy = ay + (aby * t);
  const dx = px - cx;
  const dy = py - cy;
  return (dx * dx) + (dy * dy);
}

function roundMeasurementValue(value) {
  return Number.isFinite(Number(value))
    ? Math.round(Number(value) * 1000) / 1000
    : null;
}

function resolveWallZonePricing({ zone, quote, fallbackPricing = null }) {
  if (!quote || typeof quote !== "object") return fallbackPricing;

  const lineItems = (Array.isArray(quote?.lineItems) ? quote.lineItems : [])
    .filter(isRetainingWallLineItem);
  const breakdowns = (Array.isArray(quote?.internalPricing?.lineItemBreakdowns)
    ? quote.internalPricing.lineItemBreakdowns
    : [])
    .filter(isRetainingWallBreakdown);

  const breakdown = findBestWallZoneSourceMatch({
    zone,
    items: breakdowns,
    getSource: (entry) => ({
      sourceCode: entry?.sourceLineItemCode,
      sourceSection: entry?.sourceSection || entry?.section,
      sourceLabel: entry?.sourceLineItemLabel || entry?.label,
      sourceQuantity: entry?.sourceQuantity,
    }),
  });

  const lineItem = findBestWallZoneSourceMatch({
    zone,
    items: lineItems,
    getSource: (entry) => ({
      sourceCode: entry?.code,
      sourceSection: entry?.section,
      sourceLabel: entry?.label,
      sourceQuantity: entry?.quantity,
    }),
  });

  if (!breakdown && !lineItem) return fallbackPricing;

  return {
    ...(fallbackPricing || {}),
    source: breakdown ? "quote_breakdown" : "quote_line_item",
    label: "Live quote section",
    customerPrice: lineItem?.totalPrice ?? breakdown?.sourceTotalPrice ?? breakdown?.totals?.charge ?? null,
    charge: breakdown?.totals?.charge ?? lineItem?.totalPrice ?? null,
    cost: breakdown?.totals?.cost ?? lineItem?.totalCost ?? null,
    sourceLineItemCode: breakdown?.sourceLineItemCode ?? lineItem?.code ?? null,
    sourceSection: breakdown?.section ?? lineItem?.section ?? null,
  };
}

// Measurement CSVs are Moasure evidence (moasure/raw/...) owned by the job
// root; a commercial generation never contains them. Prefer a copy beside the
// wall zones, then fall back to the operational root.
function resolveMeasurementCsvPath({ jobDir, operationalJobDir = null, relativePath }) {
  const commercialPath = resolveJobPath(jobDir, relativePath);
  if (!commercialPath || existsSync(commercialPath) || !operationalJobDir) return commercialPath;
  return resolveJobPath(operationalJobDir, relativePath);
}

function resolveJobPath(jobDir, relativePath) {
  const normalized = String(relativePath || "").replace(/^\/+/, "").trim();
  if (!normalized) return null;
  const resolvedJobDir = resolve(jobDir);
  const resolvedPath = resolve(jobDir, normalized);
  if (!resolvedPath.startsWith(`${resolvedJobDir}/`) && resolvedPath !== resolvedJobDir) {
    throw new Error(`invalid wall zone path: ${relativePath}`);
  }
  return resolvedPath;
}

function findMatchingWallZones({
  sourceCode,
  sourceSection,
  sourceLabel,
  sourceQuantity,
  wallZones,
}) {
  const zones = Array.isArray(wallZones?.zones) ? wallZones.zones : [];
  if (!zones.length) return [];
  const exactMatches = zones.filter((zone) => {
    const score = scoreWallZoneMatch(zone, {
      sourceCode,
      sourceSection,
      sourceLabel,
      sourceQuantity,
    }, { exactOnly: true });
    return score > 0;
  });
  if (exactMatches.length) return exactMatches;

  const fuzzyMatches = zones
    .map((zone) => ({
      zone,
      score: scoreWallZoneMatch(zone, {
        sourceCode,
        sourceSection,
        sourceLabel,
        sourceQuantity,
      }),
    }))
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score);

  if (!fuzzyMatches.length) return [];
  const topScore = fuzzyMatches[0].score;
  return fuzzyMatches
    .filter((entry) => entry.score === topScore)
    .map((entry) => entry.zone);
}

function findBestWallZoneSourceMatch({
  zone,
  items,
  getSource,
}) {
  const scored = (items || [])
    .map((item) => ({
      item,
      score: scoreWallZoneMatch(zone, getSource(item) || {}),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.item || null;
}

function scoreWallZoneMatch(zone, {
  sourceCode,
  sourceSection,
  sourceLabel,
  sourceQuantity,
}, {
  exactOnly = false,
} = {}) {
  const normalizedCode = String(sourceCode || "").trim();
  const normalizedSection = String(sourceSection || "").trim().toLowerCase();
  const normalizedLabel = String(sourceLabel || "").trim().toLowerCase();

  let exactScore = 0;
  const codeMatch = Array.isArray(zone?.lineItemCodes)
    && zone.lineItemCodes.some((code) => String(code || "").trim() === normalizedCode);
  if (codeMatch) exactScore += 10;

  const sectionMatch = Array.isArray(zone?.sections)
    && zone.sections.some((section) => String(section || "").trim().toLowerCase() === normalizedSection);
  if (sectionMatch) exactScore += 8;

  const titleMatch = normalizedLabel
    && String(zone?.title || "").trim().toLowerCase() === normalizedLabel;
  if (titleMatch) exactScore += 8;

  if (exactOnly || exactScore > 0) return exactScore;

  const sourceTokens = tokenizeWallZoneText([
    sourceCode,
    sourceSection,
    sourceLabel,
  ]);
  const zoneTokens = tokenizeWallZoneText([
    zone?.id,
    zone?.title,
    ...(Array.isArray(zone?.sections) ? zone.sections : []),
  ]);
  const sharedTokens = intersectTokenSets(sourceTokens, zoneTokens);
  const tokenScore = sharedTokens.size;
  if (!tokenScore) return 0;

  let quantityScore = 0;
  const expectedLengthM = normalizePositiveNumber(zone?.expectedLengthM);
  const actualLengthM = normalizePositiveNumber(sourceQuantity);
  if (expectedLengthM != null && actualLengthM != null) {
    const driftM = Math.abs(expectedLengthM - actualLengthM);
    const driftRatio = expectedLengthM > 0 ? driftM / expectedLengthM : 1;
    if (driftM <= 1 || driftRatio <= 0.15) quantityScore = 2;
  }

  return tokenScore + quantityScore;
}

function tokenizeWallZoneText(values) {
  const text = (values || [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  return new Set(
    text
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token && !WALL_ZONE_STOPWORDS.has(token))
  );
}

function intersectTokenSets(left, right) {
  const out = new Set();
  for (const token of left || []) {
    if (right?.has(token)) out.add(token);
  }
  return out;
}

function buildWallZoneModelPricing({
  model,
  wallTotals = null,
}) {
  const charge = wallTotals?.chargeTotal ?? model?.wall_charge ?? model?.total_charge ?? null;
  const cost = wallTotals?.costTotal
    ?? model?.wall_cost
    ?? (
      model?.total_cost != null
        ? Number(model.total_cost) - Number(model?.ancillaries_cost || 0)
        : model?.total_cost
    )
    ?? null;

  return {
    source: "model_estimate",
    label: "Wall section model",
    customerPrice: null,
    charge: roundMoney(charge),
    cost: roundMoney(cost),
    modelCharge: roundMoney(charge),
    modelCost: roundMoney(cost),
    sourceLineItemCode: null,
    sourceSection: null,
  };
}

function validateWallZoneLength({
  zone,
  artifact,
}) {
  const normalizedSourceMode = normalizeWallSourceMode(artifact?.sourceMode || zone?.sourceMode || null);
  const expectedLengthM = normalizePositiveNumber(zone?.expectedLengthM);
  if (normalizedSourceMode.id !== "profile_fallback" || expectedLengthM == null) {
    return { ok: true };
  }

  const actualLengthM = normalizePositiveNumber(
    artifact?.measurement?.perimeterM
    ?? artifact?.measurement?.perimeter_m
    ?? artifact?.model?.perimeter_m
    ?? null
  );
  if (actualLengthM == null) {
    return {
      ok: false,
      message: `Profile fallback zone has no measured perimeter to validate against the expected ${formatLength(expectedLengthM)} run.`,
    };
  }

  const driftM = Math.abs(actualLengthM - expectedLengthM);
  const driftRatio = expectedLengthM > 0 ? driftM / expectedLengthM : 0;
  const maxDriftM = normalizePositiveNumber(zone?.maxLengthDriftM) ?? 1;
  const maxDriftRatio = normalizePositiveNumber(zone?.maxLengthDriftRatio) ?? 0.2;
  if (driftM > maxDriftM && driftRatio > maxDriftRatio) {
    return {
      ok: false,
      message: `Profile fallback perimeter ${formatLength(actualLengthM)} drifts from the scoped ${formatLength(expectedLengthM)} wall run. Exact pricing is blocked until the zone is clipped or probe data is supplied.`,
    };
  }

  return {
    ok: true,
    actualLengthM,
    expectedLengthM,
  };
}

function normalizeProfileSegment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fromPoint = normalizePositiveInteger(raw.fromPoint);
  const toPoint = normalizePositiveInteger(raw.toPoint);
  if (fromPoint == null || toPoint == null) return null;
  return {
    path: String(raw.path || "1").trim() || "1",
    fromPoint,
    toPoint,
  };
}

function normalizePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function roundMoney(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : null;
}

function formatLength(value) {
  return `${roundMoney(value).toFixed(2)} m`;
}

const WALL_ZONE_STOPWORDS = new Set([
  "retaining",
  "wall",
  "construction",
  "concrete",
  "sleeper",
  "section",
  "run",
  "approx",
  "lm",
]);

function formatMoney(value) {
  return `$${roundMoney(value).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
