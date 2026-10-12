import { createHash } from "node:crypto";
import { existsSync } from "./storage/fs.js";
import { mkdir, readFile, writeFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { getParsedEvidenceDir, resolveJobFilePath } from "./ingestion-ledger.js";

const EVIDENCE_INDEX_FILE = "evidence-index.json";

export function getEvidenceIndexPath(jobDir) {
  return join(getParsedEvidenceDir(jobDir), EVIDENCE_INDEX_FILE);
}

export async function registerArtifact({
  jobDir,
  artifactId,
  artifactType,
  path,
  sourceFileIds,
  producedBy,
}) {
  const index = await readIndex(jobDir);
  const now = new Date().toISOString();
  const relativePath = normalizeRelativePath(path);
  const contentHash = await computeContentHash(jobDir, relativePath);

  const nextArtifact = {
    artifactId: String(artifactId || relativePath).trim() || relativePath,
    artifactType: String(artifactType || "unknown").trim() || "unknown",
    path: relativePath,
    sourceFileIds: Array.isArray(sourceFileIds) ? [...new Set(sourceFileIds.filter(Boolean))] : [],
    producedBy: normalizeProducedBy(producedBy),
    createdAt: now,
    lastUpdatedAt: now,
    contentHash,
  };

  const existingIndex = index.artifacts.findIndex((artifact) => artifact.artifactId === nextArtifact.artifactId);
  if (existingIndex >= 0) {
    nextArtifact.createdAt = index.artifacts[existingIndex].createdAt || now;
    index.artifacts[existingIndex] = nextArtifact;
  } else {
    index.artifacts.push(nextArtifact);
  }

  index.lastUpdatedAt = now;
  await writeIndex(jobDir, index);
  return nextArtifact;
}

export async function writeParsedArtifactJson({
  jobDir,
  fileName,
  payload,
  artifactId = null,
  artifactType,
  sourceFileIds = [],
  producedBy = null,
}) {
  const parsedDir = getParsedEvidenceDir(jobDir);
  await mkdir(parsedDir, { recursive: true });

  const sanitizedFileName = String(fileName || "").replace(/^\/+/, "").trim();
  const relativePath = `parsed/${sanitizedFileName}`;
  await writeFile(join(parsedDir, sanitizedFileName), JSON.stringify(payload, null, 2));

  const artifact = await registerArtifact({
    jobDir,
    artifactId: artifactId || sanitizedFileName,
    artifactType,
    path: relativePath,
    sourceFileIds,
    producedBy,
  });

  return {
    artifact,
    path: relativePath,
  };
}

export async function appendParsedArtifactEntry({
  jobDir,
  fileName,
  entry,
}) {
  const parsedDir = getParsedEvidenceDir(jobDir);
  await mkdir(parsedDir, { recursive: true });

  const artifactPath = join(parsedDir, fileName);
  const existing = existsSync(artifactPath)
    ? JSON.parse(await readFile(artifactPath, "utf8"))
    : { version: 1, lastUpdatedAt: null, entries: [] };

  const nextEntry = {
    entryId: `entry-${(existing.entries?.length || 0) + 1}`,
    ...entry,
  };

  const payload = {
    version: 1,
    lastUpdatedAt: new Date().toISOString(),
    entries: [...(existing.entries || []), nextEntry],
  };

  await writeFile(artifactPath, JSON.stringify(payload, null, 2));
  return nextEntry;
}

export async function getEvidenceIndex({ jobDir, create = true }) {
  return await readIndex(jobDir, { create });
}

export async function getArtifactsByType({ jobDir, type }) {
  const index = await readIndex(jobDir);
  return index.artifacts.filter((artifact) => artifact.artifactType === type);
}

async function readIndex(jobDir, { create = true } = {}) {
  const parsedDir = getParsedEvidenceDir(jobDir);
  if (create) await mkdir(parsedDir, { recursive: true });

  const indexPath = getEvidenceIndexPath(jobDir);
  if (!existsSync(indexPath)) {
    return {
      version: 1,
      lastUpdatedAt: null,
      artifacts: [],
    };
  }

  const raw = JSON.parse(await readFile(indexPath, "utf8"));
  return {
    version: 1,
    lastUpdatedAt: raw?.lastUpdatedAt || null,
    artifacts: Array.isArray(raw?.artifacts)
      ? raw.artifacts.map((artifact) => ({
          artifactId: String(artifact?.artifactId || "").trim(),
          artifactType: String(artifact?.artifactType || "unknown").trim() || "unknown",
          path: normalizeRelativePath(artifact?.path || ""),
          sourceFileIds: Array.isArray(artifact?.sourceFileIds) ? artifact.sourceFileIds.filter(Boolean) : [],
          producedBy: normalizeProducedBy(artifact?.producedBy),
          createdAt: artifact?.createdAt || null,
          lastUpdatedAt: artifact?.lastUpdatedAt || artifact?.createdAt || null,
          contentHash: artifact?.contentHash || null,
        }))
      : [],
  };
}

async function writeIndex(jobDir, index) {
  await mkdir(getParsedEvidenceDir(jobDir), { recursive: true });
  await writeFile(getEvidenceIndexPath(jobDir), JSON.stringify(index, null, 2));
}

async function computeContentHash(jobDir, relativePath) {
  if (!relativePath) return null;
  const absolutePath = resolveJobFilePath(jobDir, relativePath);
  if (!existsSync(absolutePath)) return null;
  const content = await readFile(absolutePath);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function normalizeProducedBy(producedBy) {
  return {
    agentTool: String(producedBy?.agentTool || "unknown").trim() || "unknown",
    llmEngine: String(producedBy?.llmEngine || "unknown").trim() || "unknown",
    agentSessionId: String(producedBy?.agentSessionId || "").trim() || null,
  };
}

function normalizeRelativePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}
