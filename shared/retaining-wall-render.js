import { themeCSS, DEFAULT_THEME } from "./themes.js";

const TIER_COLORS = {
  1: "#2e7d32",
  2: "#e65100",
  3: "#b71c1c",
};

const TIER_LABELS = {
  1: "Single tier",
  2: "Two tiers",
  3: "Three tiers",
};

export function normalizeWallSourceMode(value) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === "probe" || lower === "probe_path") {
    return {
      id: "probe",
      detail: raw || "probe",
      label: "Probe measurement",
    };
  }
  if (
    lower === "profile_fallback"
    || lower === "path1_profile_from_origin"
    || lower === "path1_profile_segment"
    || lower.includes("profile")
  ) {
    return {
      id: "profile_fallback",
      detail: raw || "path1_profile_from_origin",
      label: "Profile fallback",
    };
  }
  return {
    id: raw || "unknown",
    detail: raw || "unknown",
    label: raw || "Unknown",
  };
}

export function buildRetainingWallRenderPayload({
  zone = {},
  model,
  sourceMode = null,
  renderConfig = {},
  pricing = null,
  measurementOverlay = null,
}) {
  const normalizedSourceMode = normalizeWallSourceMode(sourceMode || zone.sourceMode || null);
  const modelMetrics = summarizeRenderMetrics(model);
  const normalizedPricing = normalizeRenderPricing({ pricing, modelMetrics });
  const notes = buildRenderNotes({
    zoneNotes: Array.isArray(zone.notes) ? zone.notes : [],
    pricing: normalizedPricing,
  });
  const metrics = {
    ...modelMetrics,
    customerPrice: normalizedPricing.customerPrice,
    totalCharge: normalizedPricing.charge,
    totalCost: normalizedPricing.cost,
  };

  return {
    kind: "wall-render",
    version: 1,
    zoneId: zone.id || "primary-wall",
    title: zone.title || "Retaining wall",
    subtitle: zone.subtitle || null,
    sourceMode: normalizedSourceMode.id,
    sourceModeDetail: normalizedSourceMode.detail,
    sourceModeLabel: normalizedSourceMode.label,
    notes,
    metrics,
    pricing: normalizedPricing,
    model,
    measurementOverlay,
    plot: buildPlotDefinition({
      model,
      renderConfig,
      title: zone.title || "Retaining wall",
      subtitle: zone.subtitle || "",
      measurementOverlay,
    }),
  };
}

export function renderRetainingWallStandaloneHtml({
  payload,
  eyebrow = "Retaining Wall · 3D Preview",
  theme = null,
}) {
  const pricing = payload?.pricing || {};
  const infoRows = [
    ["Source mode", payload?.sourceModeLabel || payload?.sourceMode || "Unknown"],
    ["Perimeter", `${round2(payload?.metrics?.perimeterM)} m`],
    ["Bay count", String(payload?.metrics?.totalActiveBays || 0)],
    ["Max height", `${round2(payload?.metrics?.maxHeightM)} m`],
    ["Tier counts", JSON.stringify(payload?.metrics?.tierCounts || {})],
    ...(pricing?.customerPrice != null ? [["Customer price", formatMoney(pricing.customerPrice)]] : []),
    [pricing?.source === "model_estimate" ? "Indicative charge" : "Charge", formatMoney(pricing?.charge ?? payload?.metrics?.totalCharge ?? 0)],
    [pricing?.source === "model_estimate" ? "Indicative cost" : "Cost", formatMoney(pricing?.cost ?? payload?.metrics?.totalCost ?? 0)],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(payload?.title || "Retaining wall")} · 3D render</title>
  <script src="https://cdn.plot.ly/plotly-3.4.0.min.js"></script>
  <style>
    ${themeCSS(theme || DEFAULT_THEME)}
    :root {
      color-scheme: dark;
      --bg: var(--t-bg);
      --panel: color-mix(in srgb, var(--t-s1) 72%, var(--t-bg));
      --panel-2: color-mix(in srgb, var(--t-s2) 78%, var(--t-bg));
      --text: var(--t-text);
      --muted: var(--t-dim);
      --line: var(--t-brd);
      --accent: var(--t-accent);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--t-body);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--t-accent) 10%, transparent) 0, transparent 34%),
        linear-gradient(180deg, color-mix(in srgb, var(--t-s1) 35%, var(--t-bg)) 0%, var(--bg) 100%);
      color: var(--text);
    }
    .wrap {
      width: min(1400px, 100%);
      margin: 0 auto;
      padding: 24px;
    }
    .header {
      display: grid;
      gap: 8px;
      margin-bottom: 18px;
    }
    .eyebrow {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--accent);
      font-family: var(--t-data);
      font-weight: 700;
    }
    h1 {
      margin: 0;
      font-size: clamp(24px, 3vw, 38px);
      line-height: 1.1;
    }
    .subtitle {
      color: var(--muted);
      max-width: 80ch;
      line-height: 1.5;
      margin: 0;
    }
    .grid {
      display: grid;
      gap: 16px;
      grid-template-columns: 320px minmax(0, 1fr);
      align-items: start;
    }
    .panel {
      background: linear-gradient(180deg, color-mix(in srgb, var(--panel) 92%, transparent), color-mix(in srgb, var(--panel-2) 84%, transparent));
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
    }
    .meta-list {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .meta-list li {
      display: grid;
      gap: 4px;
      padding-bottom: 10px;
      border-bottom: 1px solid rgba(159,176,199,0.12);
    }
    .meta-list li:last-child { border-bottom: 0; padding-bottom: 0; }
    .meta-key {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-family: var(--t-data);
      font-weight: 700;
    }
    .meta-value {
      font-size: 15px;
      line-height: 1.35;
    }
    .notes {
      margin-top: 18px;
    }
    .notes h2 {
      margin: 0 0 10px;
      font-size: 15px;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-family: var(--t-data);
    }
    .notes ul {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
      line-height: 1.45;
    }
    #plot {
      width: 100%;
      height: 840px;
      border-radius: 18px;
      overflow: hidden;
    }
    .controls {
      margin-top: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    @media (max-width: 980px) {
      .grid {
        grid-template-columns: 1fr;
      }
      #plot {
        height: 680px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="header">
      <div class="eyebrow">${escapeHtml(eyebrow)}</div>
      <h1>${escapeHtml(payload?.title || "Retaining wall")}</h1>
      <p class="subtitle">${escapeHtml(payload?.subtitle || "")}</p>
    </section>
    <section class="grid">
      <aside class="panel">
        <ul class="meta-list">
          ${infoRows.map(([key, value]) => `
            <li>
              <span class="meta-key">${escapeHtml(key)}</span>
              <span class="meta-value">${escapeHtml(value)}</span>
            </li>
          `).join("")}
        </ul>
        <div class="notes">
          <h2>Notes</h2>
          <ul>
            ${(payload?.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
          </ul>
        </div>
      </aside>
      <section class="panel">
        <div id="plot"></div>
        <div class="controls">Controls: left drag = rotate, scroll = zoom, right drag = pan.</div>
      </section>
    </section>
  </div>
  <script>
    const plot = ${JSON.stringify(payload?.plot || { data: [], layout: {} })};
    plot.layout = plot.layout || {};
    plot.layout.paper_bgcolor = "transparent";
    plot.layout.plot_bgcolor = "transparent";
    Plotly.newPlot("plot", plot.data, plot.layout, {
      scrollZoom: true,
      displayModeBar: true,
      responsive: true
    });
  </script>
</body>
</html>`;
}

function summarizeRenderMetrics(model = {}) {
  const activeBays = Array.isArray(model?.bays)
    ? model.bays.filter((bay) => bay?.is_active)
    : [];
  const heights = activeBays.map((bay) => Number(bay?.max_height_m || 0)).filter((value) => value > 0);
  return {
    perimeterM: round3(model?.perimeter_m || 0),
    totalActiveBays: Number(model?.total_active_bays || activeBays.length || 0),
    totalSleepers: Number(model?.total_sleepers || 0),
    totalHoles: Number(model?.total_holes || 0),
    maxHeightM: heights.length ? round3(Math.max(...heights)) : 0,
    minHeightM: heights.length ? round3(Math.min(...heights)) : 0,
    tierCounts: model?.tier_counts || {},
    totalCharge: round2(
      model?.total_charge
      ?? ((Number(model?.wall_charge || 0) + Number(model?.ancillaries_charge || 0)))
    ),
    totalCost: round2(model?.total_cost || 0),
  };
}

function normalizeRenderPricing({ pricing, modelMetrics }) {
  if (!pricing || typeof pricing !== "object") {
    return {
      source: "model_estimate",
      label: "Model estimate",
      charge: round2(modelMetrics.totalCharge || 0),
      cost: round2(modelMetrics.totalCost || 0),
      customerPrice: null,
      modelCharge: round2(modelMetrics.totalCharge || 0),
      modelCost: round2(modelMetrics.totalCost || 0),
      sourceLineItemCode: null,
      sourceSection: null,
    };
  }

  return {
    source: String(pricing.source || "quote_breakdown"),
    label: String(pricing.label || "Live quote section"),
    charge: round2(pricing.charge ?? modelMetrics.totalCharge ?? 0),
    cost: round2(pricing.cost ?? modelMetrics.totalCost ?? 0),
    customerPrice: pricing.customerPrice == null ? null : round2(pricing.customerPrice),
    modelCharge: round2(pricing.modelCharge ?? modelMetrics.totalCharge ?? 0),
    modelCost: round2(pricing.modelCost ?? modelMetrics.totalCost ?? 0),
    sourceLineItemCode: pricing.sourceLineItemCode ? String(pricing.sourceLineItemCode) : null,
    sourceSection: pricing.sourceSection ? String(pricing.sourceSection) : null,
  };
}

function buildRenderNotes({ zoneNotes = [], pricing }) {
  const notes = [...zoneNotes];
  if (!pricing || pricing.source === "model_estimate") {
    return notes;
  }

  const scopeLabel = pricing.sourceSection || pricing.sourceLineItemCode || "the matched quote section";
  notes.unshift(`Pricing cards use the live quote totals for ${scopeLabel}.`);

  if (
    Math.abs(Number(pricing.modelCharge || 0) - Number(pricing.charge || 0)) > 1
    || Math.abs(Number(pricing.modelCost || 0) - Number(pricing.cost || 0)) > 1
  ) {
    notes.unshift(
      `Model estimate differs from the live quote: charge ${formatMoney(pricing.modelCharge)} and cost ${formatMoney(pricing.modelCost)}.`,
    );
  }
  return notes;
}

function buildPlotDefinition({ model, renderConfig, title, subtitle, measurementOverlay = null }) {
  const meshDepthM = Number(renderConfig?.meshDepthM || 0.08);
  const showPostLines = renderConfig?.showPostLines !== false;
  const traces = [];
  const overlay = measurementOverlay && typeof measurementOverlay === "object"
    ? measurementOverlay
    : null;
  const path1Points = Array.isArray(overlay?.path1) ? overlay.path1 : [];
  const path2Points = Array.isArray(overlay?.path2) ? overlay.path2 : [];

  const perimeterPoints = [];
  for (const bay of model?.bays || []) {
    if (!bay?.geometry) continue;
    if (!perimeterPoints.length) {
      perimeterPoints.push([bay.geometry.x_start, bay.geometry.y_start, bay.geometry.z_start]);
    }
    perimeterPoints.push([bay.geometry.x_end, bay.geometry.y_end, bay.geometry.z_end]);
  }

  if (perimeterPoints.length >= 2) {
    traces.push({
      type: "scatter3d",
      mode: "lines+markers",
      name: "Engine perimeter profile",
      x: perimeterPoints.map((point) => point[0]),
      y: perimeterPoints.map((point) => point[1]),
      z: perimeterPoints.map((point) => point[2]),
      line: {
        color: "#ffffff",
        width: 5,
      },
      marker: {
        size: 4,
        color: "#ffffff",
      },
    });
  }

  if (path1Points.length >= 2) {
    traces.push({
      type: "scatter3d",
      mode: "lines+markers",
      name: "Moasure boundary (path 1)",
      x: path1Points.map((point) => point.x),
      y: path1Points.map((point) => point.y),
      z: path1Points.map((point) => point.z),
      line: {
        color: "#ffffff",
        width: 3,
        dash: "dash",
      },
      marker: {
        size: 3,
        color: "#ffffff",
        opacity: 0.9,
      },
      hovertemplate: path1Points.map((point) => (
        `Path 1 point ${escapePlotText(point.pointLabel || point.point || "")}`
      )),
      hoverinfo: "text",
    });
  }

  if (path2Points.length > 0) {
    traces.push({
      type: "scatter3d",
      mode: "markers",
      name: "Moasure probes (path 2)",
      x: path2Points.map((point) => point.x),
      y: path2Points.map((point) => point.y),
      z: path2Points.map((point) => point.z),
      marker: {
        size: 4,
        color: "#4caf50",
        opacity: 0.82,
        symbol: "diamond",
      },
      text: path2Points.map((point) => buildProbeHover(point)),
      hovertemplate: "%{text}<extra></extra>",
    });
  }

  const centroid = computeCentroid(model?.bays || []);
  const labelPoints = [];
  const dividerLine = {
    x: [],
    y: [],
    z: [],
  };

  for (const tierClass of [1, 2, 3]) {
    const mesh = buildTierMesh({
      model,
      tierClass,
      centroid,
      meshDepthM,
      showPostLines,
      dividerLine,
      labelPoints,
    });
    if (mesh) traces.push(mesh);
  }

  if (showPostLines && dividerLine.x.length > 0) {
    traces.push({
      type: "scatter3d",
      mode: "lines",
      name: "Posts / bay boundaries",
      x: dividerLine.x,
      y: dividerLine.y,
      z: dividerLine.z,
      line: {
        color: "rgba(255,255,255,0.55)",
        width: 2,
      },
    });
  }

  if (labelPoints.length > 0) {
    traces.push({
      type: "scatter3d",
      mode: "text",
      name: "Bay labels",
      x: labelPoints.map((point) => point.x),
      y: labelPoints.map((point) => point.y),
      z: labelPoints.map((point) => point.z),
      text: labelPoints.map((point) => point.text),
      textfont: {
        size: 10,
        color: "#f5f5f5",
        family: "IBM Plex Mono, ui-monospace, monospace",
      },
      textposition: "top center",
    });
  }

  const layout = {
    paper_bgcolor: "#090b12",
    plot_bgcolor: "#090b12",
    margin: { l: 0, r: 0, t: 24, b: 0 },
    showlegend: true,
    legend: {
      bgcolor: "rgba(18,24,34,0.85)",
      font: { color: "#eaeef7", size: 11 },
      x: 0.01,
      y: 0.99,
    },
    scene: {
      bgcolor: "#090b12",
      aspectmode: "data",
      camera: {
        eye: { x: -1.45, y: -1.65, z: 0.85 },
        up: { x: 0, y: 0, z: 1 },
      },
      xaxis: {
        title: "X (m)",
        color: "#b6c2d4",
        gridcolor: "#1f2937",
        zerolinecolor: "#1f2937",
        showbackground: false,
      },
      yaxis: {
        title: "Y (m)",
        color: "#b6c2d4",
        gridcolor: "#1f2937",
        zerolinecolor: "#1f2937",
        showbackground: false,
      },
      zaxis: {
        title: "Elevation (m)",
        color: "#b6c2d4",
        gridcolor: "#1f2937",
        zerolinecolor: "#1f2937",
        showbackground: false,
      },
    },
    title: {
      text: `${title}<br><span style="font-size:12px;color:#9fb0c7;">${subtitle || ""}</span>`,
      x: 0.5,
      font: {
        color: "#f5f7fb",
        size: 16,
      },
    },
  };

  return {
    data: traces,
    layout,
  };
}

function buildProbeHover(point) {
  const rows = [
    `<b>Probe ${escapePlotText(point.pointLabel || point.point || "")}</b>`,
    `XYZ: ${round3(point.x)}, ${round3(point.y)}, ${round3(point.z)} m`,
  ];
  if (point.nearestBayId != null) {
    rows.push(`Nearest bay: B${escapePlotText(point.nearestBayId)}`);
  }
  if (Number.isFinite(point.heightToNearestBayM)) {
    rows.push(`Bay height: ${round3(point.heightToNearestBayM)} m`);
  }
  if (Number.isFinite(point.measuredDropM)) {
    rows.push(`Probe drop to path 1: ${round3(point.measuredDropM)} m`);
  }
  return rows.join("<br>");
}

function escapePlotText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildTierMesh({
  model,
  tierClass,
  centroid,
  meshDepthM,
  showPostLines,
  dividerLine,
  labelPoints,
}) {
  const x = [];
  const y = [];
  const z = [];
  const i = [];
  const j = [];
  const k = [];
  const edgeMap = new Map();
  let offset = 0;

  for (const bay of model?.bays || []) {
    if (!bay?.is_active || !bay?.geometry) continue;
    if (Number(bay?.tier_count || 0) !== tierClass) continue;

    const geometry = bay.geometry;
    const start = [geometry.x_start, geometry.y_start, geometry.z_start];
    const end = [geometry.x_end, geometry.y_end, geometry.z_end];
    const normal = resolveInwardNormal({ start, end, centroid });
    labelPoints.push({
      x: round3((start[0] + end[0]) / 2),
      y: round3((start[1] + end[1]) / 2),
      z: round3(Math.max(start[2], end[2]) + 0.2 + Number(bay?.max_height_m || 0)),
      text: `B${bay?.bay_id}<br>${round2(Number(bay?.max_height_m || 0))}m`,
    });

    let stepBack = 0;
    let zTopOffset = Number(model?.design?.construction_rules?.protrusion_mm || 100) / 1000;

    for (let tierIndex = 0; tierIndex < (bay?.walls || []).length; tierIndex += 1) {
      const wall = bay.walls[tierIndex];
      const wallHeightM = Number(wall?.wall_height_m || 0);
      const zTop = zTopOffset;
      const zBot = zTopOffset - wallHeightM;
      zTopOffset = zBot - 0.05;

      const startOffset = offsetPoint(start, normal, stepBack);
      const endOffset = offsetPoint(end, normal, stepBack);
      const mesh = buildBoxMesh({
        start: startOffset,
        end: endOffset,
        zBot,
        zTop,
        normal,
        depth: meshDepthM,
      });

      mesh.vertices.forEach((vertex) => {
        x.push(vertex[0]);
        y.push(vertex[1]);
        z.push(vertex[2]);
      });
      mesh.triangles.forEach((triangle) => {
        i.push(offset + triangle[0]);
        j.push(offset + triangle[1]);
        k.push(offset + triangle[2]);
      });
      offset += mesh.vertices.length;

      if (showPostLines) {
        edgeMap.set(`${bay?.bay_id}:left:${tierIndex}`, {
          x: startOffset[0],
          y: startOffset[1],
          zTop: startOffset[2] + zTop,
          zBot: startOffset[2] + zBot,
        });
        edgeMap.set(`${bay?.bay_id}:right:${tierIndex}`, {
          x: endOffset[0],
          y: endOffset[1],
          zTop: endOffset[2] + zTop,
          zBot: endOffset[2] + zBot,
        });
      }

      stepBack += 0.6;
    }

    if (showPostLines) {
      for (const edge of edgeMap.values()) {
        dividerLine.x.push(edge.x, edge.x, null);
        dividerLine.y.push(edge.y, edge.y, null);
        dividerLine.z.push(edge.zBot, edge.zTop, null);
      }
    }
  }

  if (!x.length) return null;
  return {
    type: "mesh3d",
    name: `Wall: ${TIER_LABELS[tierClass]}`,
    x,
    y,
    z,
    i,
    j,
    k,
    color: TIER_COLORS[tierClass],
    opacity: 0.88,
    flatshading: true,
    lighting: {
      ambient: 0.55,
      diffuse: 0.8,
      specular: 0.25,
      roughness: 0.5,
    },
    lightposition: {
      x: 100,
      y: 100,
      z: 180,
    },
  };
}

function computeCentroid(bays) {
  const points = [];
  for (const bay of bays || []) {
    if (!bay?.geometry) continue;
    points.push([bay.geometry.x_start, bay.geometry.y_start]);
    points.push([bay.geometry.x_end, bay.geometry.y_end]);
  }
  if (!points.length) return [0, 0];
  const x = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const y = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return [x, y];
}

function resolveInwardNormal({ start, end, centroid }) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  let normal = [-dy / length, dx / length, 0];
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const toCentroid = [centroid[0] - mid[0], centroid[1] - mid[1]];
  if ((normal[0] * toCentroid[0]) + (normal[1] * toCentroid[1]) > 0) {
    normal = [-normal[0], -normal[1], 0];
  }
  return normal;
}

function offsetPoint(point, normal, distance) {
  return [
    point[0] + (normal[0] * distance),
    point[1] + (normal[1] * distance),
    point[2],
  ];
}

function buildBoxMesh({ start, end, zBot, zTop, normal, depth }) {
  const depthVector = [normal[0] * depth, normal[1] * depth, 0];
  const a = [start[0], start[1], start[2] + zBot];
  const b = [start[0], start[1], start[2] + zTop];
  const c = [end[0], end[1], end[2] + zTop];
  const d = [end[0], end[1], end[2] + zBot];
  const e = [a[0] + depthVector[0], a[1] + depthVector[1], a[2]];
  const f = [b[0] + depthVector[0], b[1] + depthVector[1], b[2]];
  const g = [c[0] + depthVector[0], c[1] + depthVector[1], c[2]];
  const h = [d[0] + depthVector[0], d[1] + depthVector[1], d[2]];

  return {
    vertices: [a, b, c, d, e, f, g, h],
    triangles: [
      [0, 1, 2], [0, 2, 3],
      [4, 6, 5], [4, 7, 6],
      [1, 5, 6], [1, 6, 2],
      [0, 3, 7], [0, 7, 4],
      [0, 4, 5], [0, 5, 1],
      [3, 2, 6], [3, 6, 7],
    ],
  };
}

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
