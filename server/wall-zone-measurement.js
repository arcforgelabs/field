import { readFile } from "./storage/fs-promises.js";
import { extractBayHeights } from "./retaining-wall-measurement.js";

export async function readMoasureCsv(filePath) {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines
    .slice(1)
    .map((line) => {
      const values = parseCsvLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
      return {
        layer: row.Layer,
        path: row.Path,
        point: Number(row.Point),
        x: Number(row["X:m"]),
        y: Number(row["Y:m"]),
        z: Number(row["Z:m"]),
        pathType: row["Path-Type"] || "",
      };
    })
    .filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y) && Number.isFinite(row.z));
}

export function deriveWallZoneMeasurement({
  points,
  zone = {},
  design = {},
}) {
  const bayPitchM = Number(design?.construction_rules?.bay_pitch_mm || 2010) / 1000;
  const minRemainderForExtraBayM = Number(design?.construction_rules?.min_remainder_for_extra_bay_mm || 500) / 1000;
  const pointCounts = summarizePointCounts(points);
  const probeCandidates = points.filter((point) => {
    const path = String(point.path || "").trim();
    if (path === "1") return false;
    return /pointspath/i.test(String(point.pathType || "")) || path === "2" || path === "3";
  });

  if (probeCandidates.length > 0 && !zone?.profileSegment && !Number.isFinite(Number(zone?.expectedLengthM))) {
    const normalizedPoints = points.map((point) => ({
      path: String(point.path || "").trim() === "1" ? "1" : "2",
      x: point.x,
      y: point.y,
      z: point.z,
    }));
    return {
      ...extractBayHeights({
        points: normalizedPoints,
        bayPitchM,
        minRemainderForExtraBayM,
      }),
      sourceMode: "probe_path",
      pointCounts,
      selection: {
        strategy: "full_probe_path",
        path: "1",
      },
    };
  }

  const selection = selectProfilePath({
    points,
    zone,
    bayPitchM,
  });
  const profile = buildProfileFallbackMeasurement({
    points: selection.points,
    bayPitchM,
    minRemainderForExtraBayM,
  });

  return {
    ...profile,
    sourceMode: selection.strategy === "full_path" ? "path1_profile_from_origin" : "path1_profile_segment",
    pointCounts,
    selection: {
      strategy: selection.strategy,
      path: selection.path,
      fromPoint: selection.fromPoint,
      toPoint: selection.toPoint,
      expectedLengthM: selection.expectedLengthM,
      matchedLengthM: selection.matchedLengthM,
    },
  };
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function summarizePointCounts(points) {
  const pointCounts = {};
  for (const point of points) {
    const key = String(point.path || "");
    pointCounts[key] = (pointCounts[key] || 0) + 1;
  }
  return pointCounts;
}

function selectProfilePath({
  points,
  zone,
  bayPitchM,
}) {
  const requestedPath = String(zone?.profileSegment?.path || zone?.profilePath || "1").trim() || "1";
  const pathPoints = points
    .filter((point) => String(point.path || "").trim() === requestedPath)
    .sort((a, b) => {
      const pointA = Number.isFinite(a.point) ? a.point : 0;
      const pointB = Number.isFinite(b.point) ? b.point : 0;
      return pointA - pointB;
    });

  if (pathPoints.length < 2) {
    throw new Error(`zone render requires at least two path${requestedPath} points`);
  }

  const explicitFrom = normalizePositiveInteger(zone?.profileSegment?.fromPoint);
  const explicitTo = normalizePositiveInteger(zone?.profileSegment?.toPoint);
  if (explicitFrom != null && explicitTo != null) {
    const selected = slicePathPointsByPointRange({
      points: pathPoints,
      fromPoint: explicitFrom,
      toPoint: explicitTo,
    });
    return {
      strategy: "explicit_segment",
      path: requestedPath,
      fromPoint: explicitFrom,
      toPoint: explicitTo,
      expectedLengthM: normalizePositiveNumber(zone?.expectedLengthM),
      matchedLengthM: round3(polylineLength(selected)),
      points: dedupeConsecutivePoints(selected),
    };
  }

  const expectedLengthM = normalizePositiveNumber(zone?.expectedLengthM);
  if (expectedLengthM != null) {
    const match = findBestLengthMatchingSubsegment({
      points: pathPoints,
      expectedLengthM,
    });
    if (match) {
      return {
        strategy: "best_length_match",
        path: requestedPath,
        fromPoint: match.fromPoint,
        toPoint: match.toPoint,
        expectedLengthM,
        matchedLengthM: round3(match.lengthM),
        points: dedupeConsecutivePoints(match.points),
      };
    }
  }

  return {
    strategy: "full_path",
    path: requestedPath,
    fromPoint: Number.isFinite(pathPoints[0]?.point) ? pathPoints[0].point : 1,
    toPoint: Number.isFinite(pathPoints[pathPoints.length - 1]?.point)
      ? pathPoints[pathPoints.length - 1].point
      : pathPoints.length,
    expectedLengthM,
    matchedLengthM: round3(polylineLength(pathPoints)),
    points: dedupeConsecutivePoints(pathPoints),
  };
}

function slicePathPointsByPointRange({
  points,
  fromPoint,
  toPoint,
}) {
  const lower = Math.min(fromPoint, toPoint);
  const upper = Math.max(fromPoint, toPoint);
  const selected = points.filter((point) => {
    const pointNumber = Number.isFinite(point.point) ? point.point : null;
    return pointNumber != null && pointNumber >= lower && pointNumber <= upper;
  });
  if (selected.length < 2) {
    throw new Error(`profile segment ${lower}-${upper} does not contain at least two points`);
  }
  return selected;
}

function findBestLengthMatchingSubsegment({
  points,
  expectedLengthM,
}) {
  let best = null;
  for (let start = 0; start < points.length - 1; start += 1) {
    let lengthM = 0;
    for (let end = start + 1; end < points.length; end += 1) {
      lengthM += segmentLength(points[end - 1], points[end]);
      const diff = Math.abs(lengthM - expectedLengthM);
      const span = end - start;
      if (
        !best
        || diff < best.diff
        || (Math.abs(diff - best.diff) < 1e-9 && span < best.span)
      ) {
        best = {
          diff,
          span,
          lengthM,
          fromPoint: Number.isFinite(points[start].point) ? points[start].point : start + 1,
          toPoint: Number.isFinite(points[end].point) ? points[end].point : end + 1,
          points: points.slice(start, end + 1),
        };
      }
    }
  }
  return best;
}

function dedupeConsecutivePoints(points) {
  if (!Array.isArray(points) || !points.length) return [];
  const deduped = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const prev = deduped[deduped.length - 1];
    const current = points[index];
    if (Math.abs(prev.x - current.x) < 1e-9 && Math.abs(prev.y - current.y) < 1e-9) {
      deduped[deduped.length - 1] = current;
      continue;
    }
    deduped.push(current);
  }
  return deduped;
}

function buildProfileFallbackMeasurement({
  points,
  bayPitchM,
  minRemainderForExtraBayM,
}) {
  if (points.length < 2) {
    throw new Error("zone render requires at least two path points");
  }

  const dists = [0];
  for (let index = 1; index < points.length; index += 1) {
    dists.push(dists[index - 1] + segmentLength(points[index - 1], points[index]));
  }

  const perimeterM = dists[dists.length - 1];
  const nBase = Math.floor(perimeterM / bayPitchM);
  const remainder = perimeterM - (nBase * bayPitchM);
  const nBays = remainder >= minRemainderForExtraBayM ? nBase + 1 : nBase;
  const baseZ = points[0].z;

  const bayHeights = [];
  const bayGeometry = [];
  for (let bayIndex = 0; bayIndex < nBays; bayIndex += 1) {
    const dStart = bayIndex * bayPitchM;
    const dEnd = Math.min((bayIndex + 1) * bayPitchM, perimeterM);
    const dMid = (dStart + dEnd) / 2;
    const start = interpolateAlongPolyline({ points, dists, distance: dStart });
    const middle = interpolateAlongPolyline({ points, dists, distance: dMid });
    const end = interpolateAlongPolyline({ points, dists, distance: dEnd });
    const heightM = round3(Math.max(
      Math.abs(start.z - baseZ),
      Math.abs(middle.z - baseZ),
      Math.abs(end.z - baseZ),
    ));

    bayHeights.push({
      bay_id: bayIndex + 1,
      height_m: heightM,
      source: "path1_profile",
    });
    bayGeometry.push({
      bay_id: bayIndex + 1,
      x_start: start.x,
      y_start: start.y,
      z_start: start.z,
      x_end: end.x,
      y_end: end.y,
      z_end: end.z,
    });
  }

  const bendAngles = [];
  for (let bayIndex = 0; bayIndex < nBays - 1; bayIndex += 1) {
    const a = bayGeometry[bayIndex];
    const b = bayGeometry[bayIndex + 1];
    const prev = [a.x_end - a.x_start, a.y_end - a.y_start];
    const next = [b.x_end - b.x_start, b.y_end - b.y_start];
    const dot = (prev[0] * next[0]) + (prev[1] * next[1]);
    const mag = Math.sqrt((prev[0] ** 2 + prev[1] ** 2) * (next[0] ** 2 + next[1] ** 2)) + 1e-9;
    const angle = Math.abs(180 - (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI));
    bendAngles.push({
      boundary: bayIndex + 1,
      angle: round1(angle),
    });
  }

  return {
    bayHeights,
    bayGeometry,
    bendAngles,
    perimeter_m: round3(perimeterM),
    n_bays: nBays,
    profileBaseZ: baseZ,
  };
}

function interpolateAlongPolyline({ points, dists, distance }) {
  const target = Math.max(0, Math.min(distance, dists[dists.length - 1]));
  let index = 0;
  for (let cursor = 1; cursor < dists.length; cursor += 1) {
    if (dists[cursor] >= target) {
      index = cursor - 1;
      break;
    }
    index = cursor - 1;
  }
  index = Math.min(index, points.length - 2);
  const span = Math.max(dists[index + 1] - dists[index], 1e-9);
  const t = (target - dists[index]) / span;
  return {
    x: points[index].x + (t * (points[index + 1].x - points[index].x)),
    y: points[index].y + (t * (points[index + 1].y - points[index].y)),
    z: points[index].z + (t * (points[index + 1].z - points[index].z)),
  };
}

function segmentLength(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += segmentLength(points[index - 1], points[index]);
  }
  return total;
}

function normalizePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
