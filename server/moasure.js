import { execFile } from "node:child_process";
import { existsSync } from "./storage/fs.js";
import { mkdir, readdir, readFile, stat, writeFile } from "./storage/fs-promises.js";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { writeParsedArtifactJson } from "./evidence-index.js";
import { getLedger, markIngested, registerRawFile } from "./ingestion-ledger.js";
import {
  detachFilesFromCurrentQuoteContext,
  readCurrentVisibleLedgerFiles,
} from "./quote-version-context.js";
import { formatCatalogUnit } from "../shared/catalog-units.js";

const MOASURE_DIR = "moasure";
const execFileAsync = promisify(execFile);

export function getMoasurePaths(jobDir) {
  const rootDir = join(jobDir, MOASURE_DIR);
  return {
    rootDir,
    rawDir: join(rootDir, "raw"),
    parsedDir: join(rootDir, "parsed"),
    latestJsonPath: join(rootDir, "parsed", "latest.json"),
    latestMarkdownPath: join(rootDir, "parsed", "latest.md"),
  };
}

export async function ensureMoasureDirs(jobDir) {
  const paths = getMoasurePaths(jobDir);
  await mkdir(paths.rawDir, { recursive: true });
  await mkdir(paths.parsedDir, { recursive: true });
  return paths;
}

export function createMoasureBatchId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function storeMoasureUpload({ jobDir, files, uploadedBy = "unknown" }) {
  const paths = await ensureMoasureDirs(jobDir);
  const batchId = createMoasureBatchId();
  const batchDir = join(paths.rawDir, batchId);
  await mkdir(batchDir, { recursive: true });

  const savedFiles = [];
  for (const file of files || []) {
    const targetPath = join(batchDir, sanitizeFileName(file.originalname || file.filename || "upload.bin"));
    await writeFile(targetPath, file.buffer);
    const relativePath = `moasure/raw/${batchId}/${basename(targetPath)}`;
    const fileId = await registerRawFile({
      jobDir,
      filePath: relativePath,
      fileName: basename(targetPath),
      mimeType: file.mimetype || "application/octet-stream",
      sizeBytes: file.size || file.buffer?.length || 0,
      uploadedBy: file.uploadedBy || uploadedBy,
    });
    savedFiles.push({
      fileId,
      name: basename(targetPath),
      path: targetPath,
      relativePath,
      mimeType: file.mimetype || "application/octet-stream",
      sizeBytes: file.size || file.buffer?.length || 0,
    });
  }

  return {
    batchId,
    batchDir,
    savedFiles,
    locationHints: buildLocationHints(jobDir),
  };
}

export async function readMoasureSummary(jobDir) {
  const { latestJsonPath } = getMoasurePaths(jobDir);
  if (!existsSync(latestJsonPath)) return null;
  return JSON.parse(await readFile(latestJsonPath, "utf8"));
}

// jobDir is the job root, which owns the raw files, the ledger and the parsed
// summary. A caller inside a commercial generation passes that staged
// directory as commercialJobDir so visibility follows its quote context.
export async function scanMoasure(jobDir, options = {}) {
  const paths = await ensureMoasureDirs(jobDir);
  const entries = await readdir(paths.rawDir).catch(() => []);
  const { visibleFiles } = await readCurrentVisibleLedgerFiles({
    jobDir: options.commercialJobDir || jobDir,
    operationalJobDir: jobDir,
  });
  const visibleRelativePaths = new Set(
    visibleFiles
      .filter((file) => String(file.filePath || "").startsWith("moasure/raw/"))
      .map((file) => String(file.filePath || "").trim())
      .filter(Boolean),
  );
  const batches = [];

  for (const entry of entries.sort()) {
    const batchDir = join(paths.rawDir, entry);
    const batchStat = await stat(batchDir).catch(() => null);
    if (!batchStat?.isDirectory()) continue;
    const batch = await summarizeMoasureBatch(batchDir, entry, { visibleRelativePaths });
    if (batch.fileCount > 0 || batch.imports.length > 0) {
      batches.push(batch);
    }
  }

  const imports = batches.flatMap((batch) => batch.imports);
  const summary = {
    kind: "moasure-summary",
    status: imports.length ? "parsed" : (batches.length ? "attached" : "not_attached"),
    scannedAt: new Date().toISOString(),
    batchCount: batches.length,
    latestBatchId: batches.length ? batches[batches.length - 1].batchId : null,
    locationHints: buildLocationHints(jobDir),
    imports,
    batches,
  };

  await writeFile(paths.latestJsonPath, JSON.stringify(summary, null, 2));
  await writeFile(paths.latestMarkdownPath, renderMoasureSummaryMarkdown(summary));
  await writeMoasureSummaryArtifacts({
    jobDir,
    summary,
    provenance: options.provenance || null,
  });

  return summary;
}

export async function removeMoasureFile({ jobDir, commercialJobDir = null, batchId, fileName }) {
  const paths = await ensureMoasureDirs(jobDir);
  const batchDir = join(paths.rawDir, String(batchId || "").trim());
  const batchStat = await stat(batchDir).catch(() => null);
  if (!batchStat?.isDirectory()) {
    const err = new Error("moasure batch not found");
    err.statusCode = 404;
    throw err;
  }

  const targetPath = resolve(batchDir, String(fileName || "").trim());
  const resolvedBatchDir = resolve(batchDir);
  if (!targetPath.startsWith(`${resolvedBatchDir}/`) && targetPath !== resolvedBatchDir) {
    const err = new Error("invalid moasure file path");
    err.statusCode = 400;
    throw err;
  }

  const targetStat = await stat(targetPath).catch(() => null);
  if (!targetStat?.isFile()) {
    const err = new Error("moasure file not found");
    err.statusCode = 404;
    throw err;
  }

  const relativePath = `moasure/raw/${String(batchId || "").trim()}/${basename(targetPath)}`;
  const ledger = await getLedger({ jobDir });
  const visible = await readCurrentVisibleLedgerFiles({
    jobDir: commercialJobDir || jobDir,
    operationalJobDir: jobDir,
    ledger,
  });
  const file = ledger.files.find((entry) => entry.filePath === relativePath);
  if (!file || !visible.visibleFileIds.has(file.fileId)) {
    const err = new Error("moasure file not available in the current draft");
    err.statusCode = 404;
    throw err;
  }

  await detachFilesFromCurrentQuoteContext(commercialJobDir || jobDir, {
    fileIds: [file.fileId],
  });

  return {
    batchId,
    fileName: basename(targetPath),
    fileId: file.fileId,
    detached: true,
  };
}

async function summarizeMoasureBatch(batchDir, batchId, { visibleRelativePaths = null } = {}) {
  const files = await readdir(batchDir).catch(() => []);
  const csvFiles = [];
  const pdfFiles = [];
  const mfiles = [];
  const otherFiles = [];
  const fileEntries = [];

  for (const fileName of files.sort()) {
    const relativePath = `moasure/raw/${batchId}/${fileName}`;
    if (visibleRelativePaths instanceof Set && !visibleRelativePaths.has(relativePath)) {
      continue;
    }
    const kind = classifyMoasureFile(fileName);
    fileEntries.push({ name: fileName, kind });
    if (kind === "csv") csvFiles.push(fileName);
    else if (kind === "pdf") pdfFiles.push(fileName);
    else if (kind === "mfile") mfiles.push(fileName);
    else otherFiles.push(fileName);
  }

  const pdfSummaries = await Promise.all(pdfFiles.map(async (pdfFile) => (
    await summarizeMoasurePdf(join(batchDir, pdfFile), { batchId })
  )));
  const pdfSummaryByFile = new Map(
    pdfSummaries
      .filter((summary) => summary?.pdfFile)
      .map((summary) => [summary.pdfFile, summary])
  );

  const imports = [];
  for (const csvFile of csvFiles) {
    const relatedPdfFiles = findRelatedFilesForCsv(csvFile, pdfFiles);
    imports.push(await summarizeMoasureCsv(join(batchDir, csvFile), {
      batchId,
      pdfFiles: relatedPdfFiles,
      mfiles: findRelatedFilesForCsv(csvFile, mfiles),
      pdfSummaries: relatedPdfFiles
        .map((fileName) => pdfSummaryByFile.get(fileName))
        .filter(Boolean),
    }));
  }

  return {
    batchId,
    fileCount: fileEntries.length,
    files: fileEntries,
    csvFiles,
    pdfFiles,
    mfiles,
    otherFiles,
    imports,
  };
}

async function summarizeMoasureCsv(filePath, relatedFiles) {
  const text = await readFile(filePath, "utf8");
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const headers = parseQuotedCsvLine(headerLine);
  const index = Object.fromEntries(headers.map((header, offset) => [header, offset]));
  const rows = lines
    .map((line) => parseQuotedCsvLine(line))
    .filter((row) => row.length >= headers.length - 1);

  const points = rows.map((row) => ({
    path: row[index.Path] || null,
    point: toNumber(row[index.Point]),
    x: toNumber(row[index["X:m"]]),
    y: toNumber(row[index["Y:m"]]),
    z: toNumber(row[index["Z:m"]]),
    pathType: row[index["Path-Type"]] || null,
    area: row[index["Area:m²"]] ? toNumber(row[index["Area:m²"]]) : null,
  }));

  const boundary = points.filter((point) => point.path === "1" && Number.isFinite(point.x) && Number.isFinite(point.y));
  const closedBoundary = boundary.length > 2 && samePoint(boundary[0], boundary[boundary.length - 1])
    ? boundary.slice(0, -1)
    : boundary;
  const perimeter = computePerimeter(closedBoundary);
  const areas = points.map((point) => point.area).filter((value) => Number.isFinite(value));
  const xValues = points.map((point) => point.x).filter((value) => Number.isFinite(value));
  const yValues = points.map((point) => point.y).filter((value) => Number.isFinite(value));
  const zValues = points.map((point) => point.z).filter((value) => Number.isFinite(value));

  return {
    label: basename(filePath, ".csv"),
    csvFile: basename(filePath),
    relatedPdfFiles: relatedFiles.pdfFiles || [],
    relatedMfiles: relatedFiles.mfiles || [],
    relatedPdfSummaries: (relatedFiles.pdfSummaries || []).map(compactPdfSummaryForImport),
    cutFillSummary: compactCutFillSummaryForImport(
      (relatedFiles.pdfSummaries || []).find((summary) => summary?.cutFill)?.cutFill || null
    ),
    boundaryPointCount: closedBoundary.length,
    totalPointCount: points.length,
    pathTypes: [...new Set(points.map((point) => point.pathType).filter(Boolean))],
    perimeter,
    area: areas.length ? roundNumber(areas[0]) : computePolygonArea(closedBoundary),
    bounds: {
      minX: xValues.length ? roundNumber(Math.min(...xValues)) : null,
      maxX: xValues.length ? roundNumber(Math.max(...xValues)) : null,
      minY: yValues.length ? roundNumber(Math.min(...yValues)) : null,
      maxY: yValues.length ? roundNumber(Math.max(...yValues)) : null,
      minZ: zValues.length ? roundNumber(Math.min(...zValues)) : null,
      maxZ: zValues.length ? roundNumber(Math.max(...zValues)) : null,
    },
    elevationRange: zValues.length ? roundNumber(Math.max(...zValues) - Math.min(...zValues)) : null,
    batchId: relatedFiles.batchId,
  };
}

async function summarizeMoasurePdf(filePath, { batchId }) {
  const pdfFile = basename(filePath);
  let text = "";
  let parseError = null;

  try {
    const result = await execFileAsync("pdftotext", ["-layout", filePath, "-"], {
      maxBuffer: 10 * 1024 * 1024,
    });
    text = String(result.stdout || "");
  } catch (error) {
    parseError = error?.message || "pdftotext failed";
  }

  const pages = text
    ? text.split("\f").map((pageText, index) => parseMoasurePdfPage({
        pageNumber: index + 1,
        rawText: pageText,
      })).filter((page) => page && (page.title || page.viewType || page.cutFill))
    : [];
  const cutFillPage = pages.find((page) => page?.cutFill);

  return {
    pdfFile,
    batchId,
    parsedWith: text ? "pdftotext" : null,
    title: pages.find((page) => page?.title)?.title || basename(filePath, ".pdf"),
    pageCount: pages.length,
    pages,
    cutFill: cutFillPage?.cutFill || null,
    ...(parseError ? { parseError } : {}),
  };
}

function parseMoasurePdfPage({ pageNumber, rawText }) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  const title = lines[0] || null;
  const viewType = inferMoasurePdfViewType(title);
  const areaVolumeMatch = text.match(/([-+]?\d+(?:\.\d+)?)m²\s*\(([-+]?\d+(?:\.\d+)?)m³\)/i);
  const cutFillMatch = text.match(
    /SURFACE AREA\s+CUT VOLUME\s+FILL VOLUME\s+NET VOLUME\s+([-+]?\d+(?:\.\d+)?)m²\s+([-+]?\d+(?:\.\d+)?)m³\s+([-+]?\d+(?:\.\d+)?)m³\s+([-+]?\d+(?:\.\d+)?)m³/i
  );
  const selectedLevelMatch = text.match(/selected level of\s+([+-]?\d+(?:\.\d+)?)mm/i);

  return {
    pageNumber,
    title,
    viewType,
    surfaceAreaM2: areaVolumeMatch ? toNumber(areaVolumeMatch[1]) : null,
    surfaceVolumeM3: areaVolumeMatch ? toNumber(areaVolumeMatch[2]) : null,
    cutFill: cutFillMatch ? {
      pageNumber,
      title,
      surfaceAreaM2: toNumber(cutFillMatch[1]),
      cutVolumeM3: toNumber(cutFillMatch[2]),
      fillVolumeM3: toNumber(cutFillMatch[3]),
      netVolumeM3: toNumber(cutFillMatch[4]),
      selectedLevelMm: selectedLevelMatch ? toNumber(selectedLevelMatch[1]) : null,
    } : null,
  };
}

function inferMoasurePdfViewType(title) {
  const text = String(title || "").toUpperCase();
  if (text.includes("CUT/FILL VIEW")) return "cut_fill";
  if (text.includes("CONTOUR VIEW")) return "contour";
  if (text.includes("SURFACE VIEW")) return "surface";
  if (text.includes("PLAN VIEW") && text.includes("EDGES")) return "plan_edges";
  if (text.includes("PLAN VIEW")) return "plan";
  if (text.includes("3D VIEW") && text.includes("EDGES")) return "3d_edges";
  if (text.includes("3D VIEW")) return "3d";
  return null;
}

function compactPdfSummaryForImport(summary) {
  if (!summary) return null;
  return {
    pdfFile: summary.pdfFile,
    title: summary.title,
    pageCount: summary.pageCount,
    pages: (summary.pages || []).map((page) => ({
      pageNumber: page.pageNumber,
      title: page.title,
      viewType: page.viewType,
      surfaceAreaM2: page.surfaceAreaM2,
      surfaceVolumeM3: page.surfaceVolumeM3,
      cutFill: compactCutFillSummaryForImport(page.cutFill),
    })),
    cutFill: compactCutFillSummaryForImport(summary.cutFill),
    ...(summary.parseError ? { parseError: summary.parseError } : {}),
  };
}

function compactCutFillSummaryForImport(cutFill) {
  if (!cutFill) return null;
  return {
    pageNumber: cutFill.pageNumber,
    title: cutFill.title,
    surfaceAreaM2: cutFill.surfaceAreaM2,
    cutVolumeM3: cutFill.cutVolumeM3,
    fillVolumeM3: cutFill.fillVolumeM3,
    netVolumeM3: cutFill.netVolumeM3,
    selectedLevelMm: cutFill.selectedLevelMm,
  };
}

function renderMoasureSummaryMarkdown(summary) {
  const lines = [
    "# Moasure Summary",
    "",
    `- Status: ${summary.status}`,
    `- Scanned: ${summary.scannedAt}`,
    `- Batches: ${summary.batchCount}`,
    summary.latestBatchId ? `- Latest batch: ${summary.latestBatchId}` : null,
    "",
  ].filter(Boolean);

  if (summary.imports.length) {
    lines.push("## Imports", "");
    for (const item of summary.imports) {
      lines.push(`### ${item.label}`, "");
      lines.push(`- Batch: ${item.batchId}`);
      lines.push(`- CSV: ${item.csvFile}`);
      if (item.relatedPdfFiles.length) lines.push(`- PDFs: ${item.relatedPdfFiles.join(", ")}`);
      if (item.relatedMfiles.length) lines.push(`- Mfiles: ${item.relatedMfiles.join(", ")}`);
      lines.push(`- Boundary points: ${item.boundaryPointCount}`);
      lines.push(`- Total points: ${item.totalPointCount}`);
      lines.push(`- Path types: ${item.pathTypes.join(", ") || "unknown"}`);
      lines.push(`- Perimeter: ${formatMeasurement(item.perimeter, "m")}`);
      if (item.area != null) lines.push(`- Area: ${formatMeasurement(item.area, "m2")}`);
      if (item.elevationRange != null) lines.push(`- Elevation range: ${formatMeasurement(item.elevationRange, "m")}`);
      if (item.cutFillSummary) {
        lines.push(`- PDF Cut: ${formatMeasurement(item.cutFillSummary.cutVolumeM3, "m3")}`);
        lines.push(`- PDF Fill: ${formatMeasurement(item.cutFillSummary.fillVolumeM3, "m3")}`);
        lines.push(`- PDF Net: ${formatMeasurement(item.cutFillSummary.netVolumeM3, "m3")}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function writeMoasureSummaryArtifacts({ jobDir, summary, provenance = null }) {
  const ledger = await getLedger({ jobDir });
  const sourceFileIds = [];

  for (const batch of summary.batches || []) {
    for (const file of batch.files || []) {
      const relativePath = `moasure/raw/${batch.batchId}/${file.name}`;
      const sourceFile = ledger.files.find((entry) => entry.filePath === relativePath);
      if (sourceFile) {
        sourceFileIds.push(sourceFile.fileId);
      }
    }
  }

  const producedBy = {
    agentTool: String(provenance?.agentTool || "moasure-parser").trim() || "moasure-parser",
    llmEngine: String(provenance?.llmEngine || "deterministic").trim() || "deterministic",
    agentSessionId: String(provenance?.agentSessionId || "").trim() || null,
  };

  await writeParsedArtifactJson({
    jobDir,
    fileName: "moasure-summary.json",
    payload: summary,
    artifactId: "moasure-summary.json",
    artifactType: "measurement_summary",
    sourceFileIds,
    producedBy,
  });

  for (const fileId of sourceFileIds) {
    const sourceFile = ledger.files.find((entry) => entry.fileId === fileId);
    if (!sourceFile || sourceFile.ingested === true) continue;
    await markIngested({
      jobDir,
      fileId,
      agentTool: producedBy.agentTool,
      agentSessionId: producedBy.agentSessionId,
      llmEngine: producedBy.llmEngine,
      classifiedAs: "moasure_batch",
      artifactIds: ["moasure-summary.json"],
    });
  }
}

function buildLocationHints(jobDir) {
  const paths = getMoasurePaths(jobDir);
  return {
    rawDir: paths.rawDir,
    parsedJson: paths.latestJsonPath,
    parsedMarkdown: paths.latestMarkdownPath,
  };
}

function parseQuotedCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
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

  return cells.map((cell) => String(cell || "").replace(/^\uFEFF/, "").trim());
}

function samePoint(a, b) {
  return roundNumber(a.x) === roundNumber(b.x) && roundNumber(a.y) === roundNumber(b.y);
}

function computePerimeter(points) {
  if (points.length < 2) return null;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += Math.sqrt(((next.x - current.x) ** 2) + ((next.y - current.y) ** 2));
  }
  return roundNumber(total);
}

function computePolygonArea(points) {
  if (points.length < 3) return null;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += (current.x * next.y) - (next.x * current.y);
  }
  return roundNumber(Math.abs(area) / 2);
}

function roundNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeFileName(name) {
  return String(name || "upload.bin")
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 180);
}

function findRelatedFilesForCsv(csvFileName, relatedFiles) {
  const stem = basename(csvFileName, extname(csvFileName));
  return (relatedFiles || []).filter((fileName) => basename(fileName, extname(fileName)) === stem);
}

function classifyMoasureFile(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".mfile")) return "mfile";
  return "other";
}

function formatMeasurement(value, unit) {
  if (value == null) return "unknown";
  return `${value} ${formatCatalogUnit(unit)}`;
}
