import { randomUUID } from "node:crypto";
import { existsSync } from "./storage/fs.js";
import { mkdir, readdir, readFile, stat, writeFile } from "./storage/fs-promises.js";
import { basename, extname, join, relative, resolve } from "node:path";
import { resolveActiveJobGenerationSync } from "./job-generation.js";

const ROOT_AUTHORITATIVE_PATHS = new Set([
  "raw",
  "parsed",
  "moasure",
  "ingestion-ledger.json",
  "attachments",
  "source",
  "sources",
  "photos",
  "images",
  "evidence",
]);

const INGESTION_LEDGER_FILE = "ingestion-ledger.json";
const RAW_ROOT_DIR = "raw";
const PARSED_ROOT_DIR = "parsed";

const RAW_CATEGORIES = Object.freeze({
  recording: "recording",
  images: "images",
  moasure: "moasure",
  notes: "notes",
  documents: "documents",
});

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif"]);

export function getRawEvidenceRoot(jobDir) {
  return join(jobDir, RAW_ROOT_DIR);
}

export function getParsedEvidenceDir(jobDir) {
  return join(jobDir, PARSED_ROOT_DIR);
}

export function getRawEvidenceDir(jobDir, category) {
  return join(getRawEvidenceRoot(jobDir), String(category || "").trim());
}

export function getIngestionLedgerPath(jobDir) {
  return join(jobDir, INGESTION_LEDGER_FILE);
}

export async function ensureEvidenceDirectories(jobDir) {
  await Promise.all([
    mkdir(getRawEvidenceDir(jobDir, RAW_CATEGORIES.recording), { recursive: true }),
    mkdir(getRawEvidenceDir(jobDir, RAW_CATEGORIES.images), { recursive: true }),
    mkdir(getRawEvidenceDir(jobDir, RAW_CATEGORIES.moasure), { recursive: true }),
    mkdir(getRawEvidenceDir(jobDir, RAW_CATEGORIES.notes), { recursive: true }),
    mkdir(getRawEvidenceDir(jobDir, RAW_CATEGORIES.documents), { recursive: true }),
    mkdir(getParsedEvidenceDir(jobDir), { recursive: true }),
  ]);
}

export async function storeRawFile({
  jobDir,
  category,
  fileName,
  buffer,
  subdir = null,
}) {
  const targetDir = subdir
    ? join(getRawEvidenceDir(jobDir, category), sanitizePathSegment(subdir))
    : getRawEvidenceDir(jobDir, category);
  await mkdir(targetDir, { recursive: true });

  const safeName = await allocateSafeFileName({
    dir: targetDir,
    fileName,
  });
  const absolutePath = join(targetDir, safeName);
  await writeFile(absolutePath, buffer);

  return {
    absolutePath,
    relativePath: normalizeRelativePath(relative(jobDir, absolutePath)),
    fileName: safeName,
  };
}

export function resolveJobFilePath(jobDir, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const firstEntry = normalized.split("/")[0];
  const canonicalJobDir = ROOT_AUTHORITATIVE_PATHS.has(firstEntry)
    ? resolve(jobDir)
    : resolveActiveJobGenerationSync(jobDir);
  const resolvedJobDir = resolve(canonicalJobDir);
  const absolutePath = resolve(canonicalJobDir, normalized);
  if (absolutePath !== resolvedJobDir && !absolutePath.startsWith(`${resolvedJobDir}/`)) {
    const error = new Error("invalid job file path");
    error.statusCode = 400;
    throw error;
  }
  return absolutePath;
}

export async function registerRawFile({
  jobDir,
  filePath,
  fileName,
  mimeType,
  sizeBytes,
  uploadedBy,
  uploadedAt = new Date().toISOString(),
}) {
  const ledger = await readLedger(jobDir);
  const normalizedPath = normalizeRelativePath(filePath);
  const existing = ledger.files.find((file) => (
    file.filePath === normalizedPath
    && file.ingested !== true
    && (file.sizeBytes || 0) === (Number.isFinite(sizeBytes) ? sizeBytes : 0)
    && (file.uploadedBy === "legacy-import" || !file.ingestions?.length)
  ));

  if (existing) {
    existing.fileName = String(fileName || basename(filePath || "") || "upload.bin").trim();
    existing.mimeType = String(mimeType || inferMimeTypeFromPath(filePath)).trim() || "application/octet-stream";
    existing.sizeBytes = Number.isFinite(sizeBytes) ? sizeBytes : 0;
    existing.uploadedAt = coerceIso(uploadedAt);
    existing.uploadedBy = String(uploadedBy || "unknown").trim() || "unknown";
    await writeLedger(jobDir, ledger);
    return existing.fileId;
  }

  const entry = {
    fileId: buildFileId(),
    filePath: normalizedPath,
    fileName: String(fileName || basename(filePath || "") || "upload.bin").trim(),
    mimeType: String(mimeType || inferMimeTypeFromPath(filePath)).trim() || "application/octet-stream",
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
    uploadedAt: coerceIso(uploadedAt),
    uploadedBy: String(uploadedBy || "unknown").trim() || "unknown",
    ingested: false,
    ingestions: [],
  };
  ledger.files.push(entry);
  await writeLedger(jobDir, ledger);
  return entry.fileId;
}

export async function markIngested({
  jobDir,
  fileId,
  agentTool,
  agentSessionId = null,
  llmEngine,
  classifiedAs = null,
  artifactIds = [],
  ingestVersion = 1,
  ingestedAt = new Date().toISOString(),
}) {
  const ledger = await readLedger(jobDir);
  const entry = ledger.files.find((item) => item.fileId === fileId);
  if (!entry) {
    const error = new Error(`unknown ledger file: ${fileId}`);
    error.statusCode = 404;
    throw error;
  }

  entry.ingested = true;
  entry.ingestions = Array.isArray(entry.ingestions) ? entry.ingestions : [];
  entry.ingestions.push({
    ingestedAt: coerceIso(ingestedAt),
    agentTool: normalizeField(agentTool),
    agentSessionId: normalizeOptionalField(agentSessionId),
    llmEngine: normalizeField(llmEngine),
    classifiedAs: normalizeOptionalField(classifiedAs),
    artifactIds: Array.isArray(artifactIds) ? artifactIds.filter(Boolean) : [],
    ingestVersion: Number.isFinite(ingestVersion) ? ingestVersion : 1,
  });

  await writeLedger(jobDir, ledger);
  return entry;
}

export async function getUningestedFiles({ jobDir }) {
  const ledger = await readLedger(jobDir);
  return ledger.files.filter((file) => file.ingested !== true);
}

export async function getLedger({ jobDir, create = true }) {
  return await readLedger(jobDir, { create });
}

async function readLedger(jobDir, { create = true } = {}) {
  if (create) await ensureEvidenceDirectories(jobDir);
  const ledgerPath = getIngestionLedgerPath(jobDir);
  let ledger = { version: 1, files: [] };

  if (existsSync(ledgerPath)) {
    const raw = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger = normalizeLedger(raw);
  }

  const hydrated = await registerDiscoveredFiles(jobDir, ledger);
  if (hydrated.changed) {
    if (create) await writeLedger(jobDir, hydrated.ledger);
    else return hydrated.ledger;
  }
  return hydrated.ledger;
}

async function writeLedger(jobDir, ledger) {
  await ensureEvidenceDirectories(jobDir);
  await writeFile(
    getIngestionLedgerPath(jobDir),
    JSON.stringify(normalizeLedger(ledger), null, 2),
  );
}

async function registerDiscoveredFiles(jobDir, ledger) {
  const filesByPath = new Set((ledger.files || []).map((file) => normalizeRelativePath(file.filePath)));
  const discovered = [];

  const meta = await readJsonIfExists(join(jobDir, "meta.json"));
  const audioFiles = meta?.audioFiles || (meta?.audioFile ? [meta.audioFile] : []);
  for (const audioFile of audioFiles) {
    const normalizedPath = normalizeRelativePath(audioFile);
    const absolutePath = resolve(jobDir, normalizedPath);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile() || filesByPath.has(normalizedPath)) continue;
    discovered.push({
      filePath: normalizedPath,
      fileName: basename(normalizedPath),
      mimeType: meta?.mimeType || inferMimeTypeFromPath(normalizedPath),
      sizeBytes: fileStat.size,
      uploadedAt: meta?.createdAt || fileStat.mtime.toISOString(),
      uploadedBy: "legacy-import",
    });
    filesByPath.add(normalizedPath);
  }

  for (const category of Object.values(RAW_CATEGORIES)) {
    const categoryDir = getRawEvidenceDir(jobDir, category);
    for (const file of await discoverFilesUnder(jobDir, categoryDir)) {
      if (filesByPath.has(file.filePath)) continue;
      discovered.push(file);
      filesByPath.add(file.filePath);
    }
  }

  for (const legacyDir of [join(jobDir, "moasure", "raw")]) {
    for (const file of await discoverFilesUnder(jobDir, legacyDir)) {
      if (filesByPath.has(file.filePath)) continue;
      discovered.push(file);
      filesByPath.add(file.filePath);
    }
  }

  // Legacy photo paths: scan any directory that may have received images outside the raw/ tree
  for (const legacyPhotoDir of [join(jobDir, "photos"), join(jobDir, "images")]) {
    for (const file of await discoverFilesUnder(jobDir, legacyPhotoDir)) {
      if (filesByPath.has(file.filePath)) continue;
      discovered.push(file);
      filesByPath.add(file.filePath);
    }
  }

  // Job root: pick up any image file sitting directly in the job directory (stray uploads)
  for (const file of await discoverImageFilesInDir(jobDir, jobDir)) {
    if (filesByPath.has(file.filePath)) continue;
    discovered.push(file);
    filesByPath.add(file.filePath);
  }

  if (!discovered.length) {
    return { changed: false, ledger };
  }

  ledger.files.push(...discovered.map((file) => ({
    fileId: buildFileId(),
    filePath: file.filePath,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    uploadedAt: file.uploadedAt,
    uploadedBy: file.uploadedBy,
    ingested: false,
    ingestions: [],
  })));

  return { changed: true, ledger: normalizeLedger(ledger) };
}

// Non-recursive: pick up stray image files sitting directly in a directory (e.g. job root)
async function discoverImageFilesInDir(jobDir, absoluteDir) {
  const dirStat = await stat(absoluteDir).catch(() => null);
  if (!dirStat?.isDirectory()) return [];

  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const discovered = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const absolutePath = join(absoluteDir, entry.name);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const relativePath = normalizeRelativePath(relative(jobDir, absolutePath));
    discovered.push({
      filePath: relativePath,
      fileName: entry.name,
      mimeType: inferMimeTypeFromPath(entry.name),
      sizeBytes: fileStat.size,
      uploadedAt: fileStat.mtime.toISOString(),
      uploadedBy: "legacy-import",
    });
  }

  return discovered;
}

async function discoverFilesUnder(jobDir, absoluteDir) {
  const dirStat = await stat(absoluteDir).catch(() => null);
  if (!dirStat?.isDirectory()) return [];

  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const discovered = [];

  for (const entry of entries) {
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...await discoverFilesUnder(jobDir, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const relativePath = normalizeRelativePath(relative(jobDir, absolutePath));
    discovered.push({
      filePath: relativePath,
      fileName: basename(relativePath),
      mimeType: inferMimeTypeFromPath(relativePath),
      sizeBytes: fileStat.size,
      uploadedAt: fileStat.mtime.toISOString(),
      uploadedBy: "legacy-import",
    });
  }

  return discovered;
}

async function allocateSafeFileName({ dir, fileName }) {
  const ext = extname(String(fileName || "").trim());
  const stem = sanitizePathSegment(basename(String(fileName || "upload.bin").trim(), ext));
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();

  let attempt = 0;
  while (attempt < 1000) {
    const suffix = attempt === 0 ? "" : `-${String(attempt).padStart(2, "0")}`;
    const candidate = `${stem || "upload"}${suffix}${safeExt}`;
    const candidatePath = join(dir, candidate);
    if (!existsSync(candidatePath)) return candidate;
    attempt += 1;
  }

  return `${stem || "upload"}-${randomUUID().slice(0, 8)}${safeExt}`;
}

function normalizeLedger(ledger) {
  return {
    version: 1,
    files: Array.isArray(ledger?.files)
      ? ledger.files.map((file) => ({
          fileId: normalizeField(file?.fileId || buildFileId()),
          filePath: normalizeRelativePath(file?.filePath || ""),
          fileName: String(file?.fileName || basename(String(file?.filePath || "")) || "upload.bin").trim(),
          mimeType: normalizeField(file?.mimeType || inferMimeTypeFromPath(file?.filePath || "")),
          sizeBytes: Number.isFinite(file?.sizeBytes) ? file.sizeBytes : 0,
          uploadedAt: coerceIso(file?.uploadedAt),
          uploadedBy: normalizeField(file?.uploadedBy),
          ingested: file?.ingested === true,
          ingestions: Array.isArray(file?.ingestions)
            ? file.ingestions.map((ingestion) => ({
                ingestedAt: coerceIso(ingestion?.ingestedAt),
                agentTool: normalizeField(ingestion?.agentTool),
                agentSessionId: normalizeOptionalField(ingestion?.agentSessionId),
                llmEngine: normalizeField(ingestion?.llmEngine),
                classifiedAs: normalizeOptionalField(ingestion?.classifiedAs),
                artifactIds: Array.isArray(ingestion?.artifactIds) ? ingestion.artifactIds.filter(Boolean) : [],
                ingestVersion: Number.isFinite(ingestion?.ingestVersion) ? ingestion.ingestVersion : 1,
              }))
            : [],
        }))
      : [],
  };
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

function buildFileId() {
  return `f-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function normalizeRelativePath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function sanitizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function inferMimeTypeFromPath(filePath) {
  const ext = extname(String(filePath || "")).slice(1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "heic") return "image/heic";
  if (ext === "pdf") return "application/pdf";
  if (ext === "csv") return "text/csv";
  if (ext === "txt" || ext === "log") return "text/plain";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "json") return "application/json";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "ogg" || ext === "oga") return "audio/ogg";
  if (ext === "webm") return "audio/webm";
  if (ext === "mp4") return "audio/mp4";
  if (ext === "m4a") return "audio/x-m4a";
  return "application/octet-stream";
}

function normalizeField(value) {
  return String(value || "unknown").trim() || "unknown";
}

function normalizeOptionalField(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function coerceIso(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export { RAW_CATEGORIES };
