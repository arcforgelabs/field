import { existsSync } from "./storage/fs.js";
import { mkdir, readFile, writeFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { getEvidenceIndex } from "./evidence-index.js";
import { getLedger } from "./ingestion-ledger.js";
import { resolveActiveJobGeneration, resolveWritableJobGeneration } from "./job-generation.js";

const QUOTE_VERSIONS_DIR = "quote-versions";
const CONTEXT_SCHEMA_VERSION = 1;

export const QUOTE_VERSION_CONTEXT_FILE = "quote-context.json";

export const VERSIONED_CONTEXT_LOGICAL_FILES = Object.freeze([
  "transcript.json",
  "quote-inputs.json",
  "evidence-pack.json",
  "moasure-summary.json",
  "ingestion-ledger.json",
  "evidence-index.json",
  "quote-breakdown-source.json",
]);

const VERSIONED_CONTEXT_LOGICAL_FILE_SET = new Set(VERSIONED_CONTEXT_LOGICAL_FILES);

export function formatQuoteVersionLabel(version) {
  return `v${String(toPositiveInt(version) || 1).padStart(3, "0")}`;
}

export function getQuoteVersionDir(jobDir, version) {
  return join(jobDir, QUOTE_VERSIONS_DIR, formatQuoteVersionLabel(version));
}

export async function readCurrentQuoteContext(jobDir, { quoteVersion = null } = {}) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const stored = await readJsonIfExists(join(jobDir, QUOTE_VERSION_CONTEXT_FILE));
  return normalizeContext(stored, {
    quoteVersion,
    mode: "current",
  });
}

export async function writeCurrentQuoteContext(jobDir, {
  quoteVersion = null,
  hiddenFileIds = [],
} = {}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const context = normalizeContext({
    quoteVersion,
    hiddenFileIds,
  }, {
    quoteVersion,
    mode: "current",
  });
  await writeFile(join(jobDir, QUOTE_VERSION_CONTEXT_FILE), JSON.stringify(context, null, 2));
  return context;
}

export async function detachFilesFromCurrentQuoteContext(jobDir, {
  quoteVersion = null,
  fileIds = [],
} = {}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const current = await readCurrentQuoteContext(jobDir, { quoteVersion });
  const nextHiddenFileIds = normalizeFileIdList([
    ...current.hiddenFileIds,
    ...fileIds,
  ]);
  return await writeCurrentQuoteContext(jobDir, {
    quoteVersion: quoteVersion || current.quoteVersion,
    hiddenFileIds: nextHiddenFileIds,
  });
}

export async function readQuoteVersionSnapshotContext(jobDir, version) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const resolvedVersion = toPositiveInt(version);
  if (!resolvedVersion) return null;
  const stored = await readJsonIfExists(join(
    getQuoteVersionDir(jobDir, resolvedVersion),
    QUOTE_VERSION_CONTEXT_FILE,
  ));
  if (!stored) return null;
  return normalizeContext(stored, {
    quoteVersion: resolvedVersion,
    mode: "snapshot",
  });
}

export async function snapshotQuoteVersionContext(jobDir, {
  quoteVersion,
  transcript = null,
  quoteInputs = null,
  evidencePack = null,
  moasureSummary = null,
  ingestionLedger = null,
  evidenceIndex = null,
  visibleFileIds = [],
} = {}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const resolvedVersion = toPositiveInt(quoteVersion);
  if (!resolvedVersion) {
    throw new Error("quote version required for context snapshot");
  }

  const versionDir = getQuoteVersionDir(jobDir, resolvedVersion);
  await mkdir(versionDir, { recursive: true });

  const manifest = normalizeContext({
    quoteVersion: resolvedVersion,
    visibleFileIds,
  }, {
    quoteVersion: resolvedVersion,
    mode: "snapshot",
  });

  const writes = [
    writeFile(join(versionDir, QUOTE_VERSION_CONTEXT_FILE), JSON.stringify(manifest, null, 2)),
  ];

  if (transcript) {
    writes.push(writeFile(join(versionDir, "transcript.json"), JSON.stringify(transcript, null, 2)));
  }
  if (quoteInputs) {
    writes.push(writeFile(join(versionDir, "quote-inputs.json"), JSON.stringify(quoteInputs, null, 2)));
  }
  if (evidencePack) {
    writes.push(writeFile(join(versionDir, "evidence-pack.json"), JSON.stringify(evidencePack, null, 2)));
  }
  if (moasureSummary) {
    writes.push(writeFile(join(versionDir, "moasure-summary.json"), JSON.stringify(moasureSummary, null, 2)));
  }
  if (ingestionLedger) {
    writes.push(writeFile(join(versionDir, "ingestion-ledger.json"), JSON.stringify(ingestionLedger, null, 2)));
  }
  if (evidenceIndex) {
    writes.push(writeFile(join(versionDir, "evidence-index.json"), JSON.stringify(evidenceIndex, null, 2)));
  }

  await Promise.all(writes);
  return manifest;
}

export async function synchronizeCurrentQuoteContext(jobDir, {
  quoteVersion = null,
} = {}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const current = await readCurrentQuoteContext(jobDir, { quoteVersion });
  return await writeCurrentQuoteContext(jobDir, {
    quoteVersion: quoteVersion || current.quoteVersion,
    hiddenFileIds: current.hiddenFileIds,
  });
}

export async function readCurrentVisibleLedgerFiles({
  jobDir,
  ledger = null,
  quoteVersion = null,
  operationalJobDir = null,
  readOnly = false,
} = {}) {
  const operationalRoot = operationalJobDir || jobDir;
  const commercialRoot = await resolveActiveJobGeneration(jobDir);
  const resolvedLedger = ledger || await getLedger({ jobDir: operationalRoot, create: !readOnly });
  const context = await readCurrentQuoteContext(commercialRoot, { quoteVersion });
  const hiddenFileIdSet = new Set(context.hiddenFileIds);
  const visibleFiles = resolvedLedger.files.filter((file) => !hiddenFileIdSet.has(file.fileId));
  const visibleFileIds = new Set(visibleFiles.map((file) => file.fileId));

  return {
    ledger: resolvedLedger,
    context,
    hiddenFileIdSet,
    visibleFiles,
    visibleFileIds,
  };
}

export async function readSelectedQuoteVersionArtifacts({
  jobDir,
  selectedVersion = null,
  latestVersion = null,
  operationalJobDir = null,
} = {}) {
  const operationalRoot = operationalJobDir || jobDir;
  jobDir = await resolveActiveJobGeneration(jobDir);
  const resolvedLatestVersion = toPositiveInt(latestVersion);
  const resolvedSelectedVersion = toPositiveInt(selectedVersion) || resolvedLatestVersion || null;
  const selectedIsLatest = (
    !resolvedLatestVersion
    || !resolvedSelectedVersion
    || resolvedSelectedVersion === resolvedLatestVersion
  );

  if (selectedIsLatest) {
    const { ledger, context, visibleFiles, visibleFileIds } = await readCurrentVisibleLedgerFiles({
      jobDir,
      operationalJobDir: operationalRoot,
      quoteVersion: resolvedLatestVersion,
    });
    return {
      selectedVersion: resolvedSelectedVersion,
      selectedIsLatest: true,
      context,
      ledger,
      visibleFiles,
      visibleFileIds,
      transcript: await readLogicalArtifactJson(operationalRoot, "transcript.json"),
      quoteInputs: await readLogicalArtifactJson(jobDir, "quote-inputs.json"),
      evidencePack: await readLogicalArtifactJson(jobDir, "evidence-pack.json"),
      moasureSummary: await readLogicalArtifactJson(operationalRoot, "moasure-summary.json"),
      ingestionLedger: {
        ...ledger,
        files: visibleFiles,
      },
      evidenceIndex: filterEvidenceIndexByVisibleFileIds(
        await getEvidenceIndex({ jobDir: operationalRoot }),
        visibleFileIds,
      ),
    };
  }

  const snapshotContext = await readQuoteVersionSnapshotContext(jobDir, resolvedSelectedVersion);
  const snapshotLedger = await readJsonIfExists(join(
    getQuoteVersionDir(jobDir, resolvedSelectedVersion),
    "ingestion-ledger.json",
  ));
  const ledger = snapshotLedger || await getLedger({ jobDir: operationalRoot });
  const visibleFileIds = new Set(
    Array.isArray(snapshotContext?.visibleFileIds) && snapshotContext.visibleFileIds.length
      ? snapshotContext.visibleFileIds
      : ledger.files.map((file) => file.fileId),
  );
  const visibleFiles = ledger.files.filter((file) => visibleFileIds.has(file.fileId));

  return {
    selectedVersion: resolvedSelectedVersion,
    selectedIsLatest: false,
    context: snapshotContext || normalizeContext(null, {
      quoteVersion: resolvedSelectedVersion,
      mode: "snapshot",
    }),
    ledger,
    visibleFiles,
    visibleFileIds,
    transcript: await readVersionedArtifactJson(jobDir, resolvedSelectedVersion, "transcript.json", { fallbackToCurrent: false }),
    quoteInputs: await readVersionedArtifactJson(jobDir, resolvedSelectedVersion, "quote-inputs.json"),
    evidencePack: await readVersionedArtifactJson(jobDir, resolvedSelectedVersion, "evidence-pack.json"),
    moasureSummary: await readVersionedArtifactJson(jobDir, resolvedSelectedVersion, "moasure-summary.json", { fallbackToCurrent: false }),
    ingestionLedger: snapshotLedger || {
      ...ledger,
      files: visibleFiles,
    },
    evidenceIndex: filterEvidenceIndexByVisibleFileIds(
      await readVersionedArtifactJson(jobDir, resolvedSelectedVersion, "evidence-index.json", { fallbackToCurrent: false }),
      visibleFileIds,
    ),
  };
}

/**
 * Capture the operational inputs used by a commercial build before a staged
 * generation is created. Operational files stay at the job root; the quote
 * generation receives this immutable read so it never needs to copy or merge
 * chat, transcript, ledger, or evidence trees into its commercial directory.
 */
export async function readCurrentQuoteOperationalSnapshot({
  jobDir,
  commercialJobDir = null,
  quoteVersion = null,
} = {}) {
  if (!jobDir) throw new Error("jobDir required for quote operational snapshot");
  // A build inside a staged generation passes it as commercialJobDir: a
  // context change made earlier in the same transaction (a detached file) is
  // only visible there until publish.
  const visible = await readCurrentVisibleLedgerFiles({
    jobDir: commercialJobDir || jobDir,
    quoteVersion,
    operationalJobDir: jobDir,
    readOnly: true,
  });
  const [transcript, moasureSummary, evidenceIndex] = await Promise.all([
    readLogicalArtifactJson(jobDir, "transcript.json"),
    readLogicalArtifactJson(jobDir, "moasure-summary.json"),
    getEvidenceIndex({ jobDir, create: false }),
  ]);
  return {
    ledger: cloneJsonValue(visible.ledger),
    context: cloneJsonValue(visible.context),
    visibleFiles: cloneJsonValue(visible.visibleFiles),
    visibleFileIds: [...visible.visibleFileIds],
    transcript: cloneJsonValue(transcript),
    moasureSummary: cloneJsonValue(moasureSummary),
    evidenceIndex: cloneJsonValue(evidenceIndex),
    operationalJobDir: jobDir,
  };
}

export function filterEvidenceIndexByVisibleFileIds(index, visibleFileIds) {
  const visibleSet = visibleFileIds instanceof Set
    ? visibleFileIds
    : new Set(normalizeFileIdList(Array.isArray(visibleFileIds) ? visibleFileIds : []));
  const artifacts = Array.isArray(index?.artifacts) ? index.artifacts : [];

  return {
    version: Number(index?.version || 1) || 1,
    lastUpdatedAt: index?.lastUpdatedAt || null,
    artifacts: artifacts.filter((artifact) => {
      const sourceFileIds = normalizeFileIdList(artifact?.sourceFileIds);
      if (!sourceFileIds.length) return true;
      return sourceFileIds.some((fileId) => visibleSet.has(fileId));
    }),
  };
}

export function isVersionedContextLogicalFile(relativePath) {
  return VERSIONED_CONTEXT_LOGICAL_FILE_SET.has(normalizeRelativePath(relativePath));
}

export function resolveVersionedContextArtifactPath({
  jobDir,
  relativePath,
  selectedVersion = null,
  latestVersion = null,
} = {}) {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!isVersionedContextLogicalFile(normalizedPath)) {
    return join(jobDir, normalizedPath);
  }

  const resolvedSelectedVersion = toPositiveInt(selectedVersion);
  const resolvedLatestVersion = toPositiveInt(latestVersion);
  if (
    resolvedSelectedVersion
    && resolvedLatestVersion
    && resolvedSelectedVersion !== resolvedLatestVersion
  ) {
    const snapshotPath = join(getQuoteVersionDir(jobDir, resolvedSelectedVersion), normalizedPath);
    if (existsSync(snapshotPath)) return snapshotPath;
  }

  return getLogicalArtifactPath(jobDir, normalizedPath);
}

function getLogicalArtifactPath(jobDir, fileName) {
  switch (normalizeRelativePath(fileName)) {
    case "moasure-summary.json":
      return join(jobDir, "moasure", "parsed", "latest.json");
    case "evidence-index.json":
      return join(jobDir, "parsed", "evidence-index.json");
    default:
      return join(jobDir, normalizeRelativePath(fileName));
  }
}

async function readLogicalArtifactJson(jobDir, fileName) {
  return await readJsonIfExists(getLogicalArtifactPath(jobDir, fileName));
}

async function readVersionedArtifactJson(jobDir, version, fileName, { fallbackToCurrent = true } = {}) {
  const versionPath = join(getQuoteVersionDir(jobDir, version), normalizeRelativePath(fileName));
  if (existsSync(versionPath)) {
    return await readJsonIfExists(versionPath);
  }
  return fallbackToCurrent ? await readLogicalArtifactJson(jobDir, fileName) : null;
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeContext(raw, {
  quoteVersion = null,
  mode = "current",
} = {}) {
  const resolvedMode = mode === "snapshot" ? "snapshot" : "current";
  return {
    kind: "quote-version-context",
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    mode: resolvedMode,
    quoteVersion: toPositiveInt(raw?.quoteVersion) || toPositiveInt(quoteVersion) || null,
    createdAt: raw?.createdAt || new Date().toISOString(),
    hiddenFileIds: resolvedMode === "current"
      ? normalizeFileIdList(raw?.hiddenFileIds)
      : [],
    visibleFileIds: resolvedMode === "snapshot"
      ? normalizeFileIdList(raw?.visibleFileIds)
      : [],
  };
}

function normalizeFileIdList(list) {
  return [...new Set(
    (Array.isArray(list) ? list : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function normalizeRelativePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function toPositiveInt(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}
