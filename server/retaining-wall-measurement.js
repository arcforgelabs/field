/**
 * Retaining Wall Measurement Adapter
 * ===================================
 * Takes Moasure CSV data and produces bay_heights — a simple array of
 * {bay_id, height_m} that the construction engine consumes.
 *
 * Separates data quality concerns (probe mapping, interpolation, overrides)
 * from construction logic (tiers, posts, pricing).
 */

/**
 * Extract bay heights from parsed Moasure points.
 *
 * @param {Object} opts
 * @param {Array<{path:string, x:number, y:number, z:number}>} opts.points - All CSV points
 * @param {number} opts.bayPitchM - Bay width in metres (default 2.01)
 * @param {Object} opts.heightOverrides - {bayId: {height_m, reason}} from design.json
 * @returns {{bayHeights: Array<{bay_id:number, height_m:number, source:string}>, perimeter_m:number, n_bays:number}}
 */
export function extractBayHeights({
  points,
  bayPitchM = 2.01,
  heightOverrides = {},
  minRemainderForExtraBayM = 0.5,
}) {
  // Separate perimeter (path 1) from probe (path 2) points
  const p1 = points
    .filter((p) => String(p.path).trim() === "1" && isFinite(p.x) && isFinite(p.y) && isFinite(p.z))
    .map((p) => ({ x: p.x, y: p.y, z: p.z }));

  const p2 = points
    .filter((p) => String(p.path).trim() === "2" && isFinite(p.x) && isFinite(p.y) && isFinite(p.z))
    .map((p) => ({ x: p.x, y: p.y, z: p.z }));

  if (p1.length < 2) {
    throw new Error("Need at least 2 perimeter (path 1) points");
  }

  // Compute cumulative distances along perimeter
  const dists = [0];
  for (let i = 1; i < p1.length; i++) {
    const dx = p1[i].x - p1[i - 1].x;
    const dy = p1[i].y - p1[i - 1].y;
    dists.push(dists[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const perimeter = dists[dists.length - 1];

  // Bay count
  const nBaysBase = Math.floor(perimeter / bayPitchM);
  const remainder = perimeter - nBaysBase * bayPitchM;
  const nBays = remainder >= minRemainderForExtraBayM ? nBaysBase + 1 : nBaysBase;

  // Map each probe to its nearest perimeter point → get height
  const rawHeights = {};  // bay_index -> max height
  for (const probe of p2) {
    // Find nearest perimeter point
    let minDist = Infinity;
    let nearestIdx = 0;
    for (let i = 0; i < p1.length; i++) {
      const dx = p1[i].x - probe.x;
      const dy = p1[i].y - probe.y;
      const d = dx * dx + dy * dy;
      if (d < minDist) {
        minDist = d;
        nearestIdx = i;
      }
    }

    const h = p1[nearestIdx].z - probe.z;
    if (h <= 0) continue;

    const perimDist = dists[nearestIdx];
    const bayIdx = Math.min(Math.floor(perimDist / bayPitchM), nBays - 1);
    rawHeights[bayIdx] = Math.max(rawHeights[bayIdx] || 0, h);
  }

  // Interpolate missing bays
  const knownBays = Object.keys(rawHeights).map(Number).sort((a, b) => a - b);
  for (let bi = 0; bi < nBays; bi++) {
    if (bi in rawHeights) continue;
    const prev = knownBays.filter((k) => k < bi).pop();
    const next = knownBays.find((k) => k > bi);
    if (prev != null && next != null) {
      const t = (bi - prev) / (next - prev);
      rawHeights[bi] = rawHeights[prev] + t * (rawHeights[next] - rawHeights[prev]);
    } else if (prev != null) {
      rawHeights[bi] = rawHeights[prev];
    } else if (next != null) {
      rawHeights[bi] = rawHeights[next];
    } else {
      rawHeights[bi] = 0;
    }
  }

  // Build bay heights with overrides
  const bayHeights = [];
  for (let bi = 0; bi < nBays; bi++) {
    const bayId = bi + 1;
    const overrideKey = String(bayId);
    if (heightOverrides[overrideKey]) {
      bayHeights.push({
        bay_id: bayId,
        height_m: heightOverrides[overrideKey].height_m,
        source: "override",
        reason: heightOverrides[overrideKey].reason || "",
      });
    } else {
      bayHeights.push({
        bay_id: bayId,
        height_m: Math.round((rawHeights[bi] || 0) * 1000) / 1000,
        source: bi in rawHeights ? "probe" : "interpolated",
      });
    }
  }

  // Perimeter geometry for each bay (for 3D rendering)
  const bayGeometry = [];
  for (let bi = 0; bi < nBays; bi++) {
    const dStart = bi * bayPitchM;
    const dEnd = Math.min((bi + 1) * bayPitchM, perimeter);
    const ptStart = interpPerimeter(p1, dists, dStart);
    const ptEnd = interpPerimeter(p1, dists, dEnd);
    bayGeometry.push({
      bay_id: bi + 1,
      x_start: ptStart.x, y_start: ptStart.y, z_start: ptStart.z,
      x_end: ptEnd.x, y_end: ptEnd.y, z_end: ptEnd.z,
    });
  }

  // Compute bend angles at each boundary
  const bendAngles = [];
  for (let bi = 0; bi < nBays - 1; bi++) {
    const a = interpPerimeter(p1, dists, bi * bayPitchM);
    const b = interpPerimeter(p1, dists, (bi + 1) * bayPitchM);
    const c = interpPerimeter(p1, dists, (bi + 2) * bayPitchM);
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const dot = v1x * v2x + v1y * v2y;
    const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
    const cosA = Math.max(-1, Math.min(1, dot / (mag1 * mag2 + 1e-9)));
    const angle = Math.abs(180 - Math.acos(cosA) * 180 / Math.PI);
    bendAngles.push({ boundary: bi + 1, angle: Math.round(angle * 10) / 10 });
  }

  return {
    bayHeights,
    bayGeometry,
    bendAngles,
    perimeter_m: Math.round(perimeter * 1000) / 1000,
    n_bays: nBays,
  };
}

function interpPerimeter(p1, dists, d) {
  d = Math.max(0, Math.min(d, dists[dists.length - 1]));
  let i = 0;
  for (let j = 1; j < dists.length; j++) {
    if (dists[j] >= d) { i = j - 1; break; }
    i = j - 1;
  }
  i = Math.min(i, p1.length - 2);
  const t = (d - dists[i]) / Math.max(dists[i + 1] - dists[i], 1e-9);
  return {
    x: p1[i].x + t * (p1[i + 1].x - p1[i].x),
    y: p1[i].y + t * (p1[i + 1].y - p1[i].y),
    z: p1[i].z + t * (p1[i + 1].z - p1[i].z),
  };
}
