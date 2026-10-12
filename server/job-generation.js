import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "./storage/fs-promises.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "./storage/fs.js";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { flushDurableStorageQuietly } from "./storage/durable-hooks.js";

export const JOB_GENERATIONS_DIR = ".field-generations";
export const JOB_GENERATION_POINTER = ".field-generation-pointer.json";
export const JOB_GENERATION_HISTORY = ".field-generation-history.json";
export const JOB_GENERATION_COMMIT_MARKER = ".field-generation-commit.json";
export const JOB_GENERATION_LOCK = ".field-generation-lock";
const GENERATION_MANIFEST_VERSION = 2;

const MAX_POINTER_HISTORY = 64;
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

// Operational writers (chat/activity/callback/evidence) must not be copied
// into a commercial generation. A small post-commit queue lets legacy
// callers invoked from a staged build retain their observable activity event
// without making the root tree part of the generation or mutating it before
// the commercial publish succeeds.
const STAGED_POST_COMMIT = new Map();

export function queueStagedPostCommit(stagedJobDir, callback) {
  const state = STAGED_POST_COMMIT.get(stagedJobDir);
  if (!state) return false;
  state.callbacks.push(callback);
  return true;
}

async function flushStagedPostCommit(stagedJobDir, jobDir) {
  const state = STAGED_POST_COMMIT.get(stagedJobDir);
  STAGED_POST_COMMIT.delete(stagedJobDir);
  if (!state) return;
  for (const callback of state.callbacks) {
    try {
      await callback(jobDir);
    } catch (error) {
      console.warn(`[job-generation] post-commit operational write failed: ${error.message}`);
    }
  }
}

// These trees are job-operational truth, not commercial artifacts. They are
// intentionally excluded from commercial generations: their own atomic/CAS
// writers own their consistency and a quote build must never copy, merge, or
// project them.
const ROOT_AUTHORITATIVE_ENTRIES = Object.freeze(new Set([
  "job-workspace",
  "agent-chat",
  "job-state",
  "evidence",
  "raw",
  "parsed",
  "moasure",
  "ingestion-ledger.json",
  "attachments",
  "source",
  "sources",
  "photos",
  "images",
  "_dispatch",
  "transcript.json",
  "transcript-raw.json",
  "callbacks",
  "callback",
  "chat",
  "gaps.json",
  "activity.json",
  "activity.jsonl",
]));

// Only these top-level entries are eligible for a commercial generation. The
// allowlist is deliberately shared by staging, manifest validation, and the
// legacy compatibility projection. Anything outside it is either operational
// root truth (above) or a generation corruption signal.
const COMMERCIAL_ARTIFACT_ENTRIES = Object.freeze(new Set([
  "meta.json",
  "quote.json",
  "quote.md",
  "quote.pdf",
  "report.md",
  "quote-inputs.json",
  "quote-context.json",
  "moasure-summary.json",
  "quote-overrides.json",
  "quote-breakdown-source.json",
  "quote-lifecycle.json",
  "quote-issuance.json",
  "quote-delivery-outbox.json",
  "evidence-pack.json",
  "evidence-index.json",
  "tasks.json",
  "bay-model.json",
  "bay-heights.json",
  "wall-design.json",
  "wall-zones.json",
  "site-sketch-features.json",
  "quote-versions",
  "issued-documents",
  "milestone-invoices",
  "milestone-receipts",
  "generated",
  "visualizations",
  "proof-bundle",
]));

const GENERATION_INTERNAL_ENTRIES = new Set([
  JOB_GENERATIONS_DIR,
  JOB_GENERATION_POINTER,
  JOB_GENERATION_HISTORY,
  JOB_GENERATION_LOCK,
  JOB_GENERATION_COMMIT_MARKER,
]);

function isCommercialArtifactEntry(name) {
  const normalizedName = String(name || "");
  // Quote/invoice PDF filenames may contain customer and scope text, but are
  // still generated commercial artifacts. The extension is the allowlisted
  // class; arbitrary non-PDF root files remain corruption signals.
  return COMMERCIAL_ARTIFACT_ENTRIES.has(normalizedName)
    || normalizedName.toLowerCase().endsWith(".pdf");
}

function isAllowedGenerationEntry(name) {
  return isCommercialArtifactEntry(name);
}

function assertNoFollowTreeSync(path, root = path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    throw new Error(`symbolic links are not allowed in job generation inputs: ${relative(root, path) || "."}`);
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error(`special nodes are not allowed in job generation inputs: ${relative(root, path) || "."}`);
  }
  if (info.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (GENERATION_INTERNAL_ENTRIES.has(entry.name) && path === root) continue;
      assertNoFollowTreeSync(join(path, entry.name), root);
    }
  }
}

function pointerPath(jobDir) {
  return join(jobDir, JOB_GENERATION_POINTER);
}

function historyPath(jobDir) {
  return join(jobDir, JOB_GENERATION_HISTORY);
}

function generationRoot(jobDir) {
  return join(jobDir, JOB_GENERATIONS_DIR);
}

function commitMarkerPath(generationDir) {
  return join(generationDir, JOB_GENERATION_COMMIT_MARKER);
}

function isSafeGenerationId(value) {
  return /^g-\d{6,}$/.test(String(value || ""));
}

function resolveGenerationPath(jobDir, generationId) {
  if (!isSafeGenerationId(generationId)) return null;
  const root = resolve(generationRoot(jobDir));
  const candidate = resolve(root, generationId);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || rel.includes("/..")) return null;
  return candidate;
}

function readJsonSync(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readPointerSync(jobDir) {
  return readJsonSync(pointerPath(jobDir));
}

async function readPointer(jobDir) {
  return readJson(pointerPath(jobDir));
}

function readHistorySync(jobDir) {
  const raw = readJsonSync(historyPath(jobDir), []);
  return Array.isArray(raw) ? raw : [];
}

async function readHistory(jobDir) {
  const raw = await readJson(historyPath(jobDir), []);
  return Array.isArray(raw) ? raw : [];
}

function isValidManifestEntry(entry) {
  return Boolean(
    entry
    && typeof entry.path === "string"
    && entry.path.length > 0
    && !entry.path.startsWith("/")
    && !entry.path.split("/").includes("..")
    && entry.path !== JOB_GENERATION_COMMIT_MARKER
    && entry.path !== JOB_GENERATION_LOCK
    && /^[a-f0-9]{64}$/i.test(String(entry.sha256 || ""))
    && Number.isSafeInteger(entry.size)
    && entry.size >= 0,
  );
}

function isValidCommitMarker(marker, generationId = null) {
  if (!(
    marker
    && (marker.version === 1 || marker.version === GENERATION_MANIFEST_VERSION)
    && isSafeGenerationId(marker.generationId)
    && (!generationId || marker.generationId === generationId)
    && typeof marker.commitId === "string"
    && marker.commitId.length > 0
    && typeof marker.manifestDigest === "string"
    && /^[a-f0-9]{64}$/i.test(marker.manifestDigest)
    && Array.isArray(marker.files)
    && marker.files.every(isValidManifestEntry)
  )) return false;
  return createHash("sha256").update(JSON.stringify(marker.files)).digest("hex") === String(marker.manifestDigest).toLowerCase();
}

function manifestPathIsSafe(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.startsWith("/")) return false;
  const candidate = resolve(root, relativePath);
  const relativeCandidate = relative(root, candidate);
  return relativeCandidate === relativePath
    || relativeCandidate === relativePath.replaceAll("\\", "/");
}

function listFilesSync(dir, root = dir, isRoot = true, allowLegacyOperational = false) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isRoot && GENERATION_INTERNAL_ENTRIES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (isRoot && !isAllowedGenerationEntry(entry.name)
      && !(allowLegacyOperational && ROOT_AUTHORITATIVE_ENTRIES.has(entry.name))) {
      throw new Error(`unexpected generation entry: ${entry.name}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in job generations: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) files.push(...listFilesSync(path, root, false, allowLegacyOperational));
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      files.push({
        path: relative(root, path).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      });
    } else {
      throw new Error(`special nodes are not allowed in job generations: ${relative(root, path)}`);
    }
  }
  return files;
}

function hasValidManifestContentsSync(generationDir, marker) {
  try {
    const actual = listFilesSync(generationDir, generationDir, true, marker.version === 1);
    const expected = marker.files.map((entry) => ({ ...entry, path: entry.path.replaceAll("\\", "/") }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    return expected.every((entry) => {
      if (!manifestPathIsSafe(generationDir, entry.path)) return false;
      const bytes = readFileSync(join(generationDir, entry.path));
      return bytes.length === entry.size
        && createHash("sha256").update(bytes).digest("hex") === String(entry.sha256).toLowerCase();
    });
  } catch {
    return false;
  }
}

async function hasValidManifestContents(generationDir, marker) {
  try {
    const actual = await listFiles(generationDir, generationDir, marker.version === 1);
    const expected = marker.files.map((entry) => ({ ...entry, path: entry.path.replaceAll("\\", "/") }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    for (const entry of expected) {
      if (!manifestPathIsSafe(generationDir, entry.path)) return false;
      const bytes = await readFile(join(generationDir, entry.path));
      if (bytes.length !== entry.size) return false;
      if (createHash("sha256").update(bytes).digest("hex") !== String(entry.sha256).toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasValidCommitMarkerSync(generationDir, generationId = null) {
  const marker = readJsonSync(commitMarkerPath(generationDir));
  return isValidCommitMarker(marker, generationId) && hasValidManifestContentsSync(generationDir, marker);
}

async function hasValidCommitMarker(generationDir, generationId = null) {
  const marker = await readJson(commitMarkerPath(generationDir));
  return isValidCommitMarker(marker, generationId) && await hasValidManifestContents(generationDir, marker);
}

function readProcessStartIdentity(pid = process.pid) {
  try {
    const fields = readFileSync(`/proc/${Number(pid)}/stat`, "utf8").trim().split(" ");
    // Linux proc stat field 22 is process start time; the executable name can
    // contain spaces, but Field's node process name does not. Keep the
    // fallback below for unusual proc implementations.
    return fields[21] || null;
  } catch {
    return null;
  }
}

function readBootIdentity() {
  try {
    return readFileSync(BOOT_ID_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function getJobGenerationProcessIdentity(pid = process.pid) {
  return {
    pid: Number(pid),
    bootId: readBootIdentity(),
    processStart: readProcessStartIdentity(pid),
  };
}

function ownerPayload() {
  return JSON.stringify({
    ...getJobGenerationProcessIdentity(),
    acquiredAt: new Date().toISOString(),
  });
}

function isProcessIdentityAlive(owner) {
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const current = getJobGenerationProcessIdentity(pid);
  if (owner.bootId && current.bootId && owner.bootId !== current.bootId) return false;
  if (owner.processStart && current.processStart && owner.processStart !== current.processStart) return false;
  return true;
}

async function readLockOwner(lockPath) {
  return readJson(join(lockPath, "owner.json"));
}

function isReclaimableLockOwner(owner) {
  // A malformed owner is never safe to treat as live. This matters after a
  // process dies between mkdir(lock) and writing owner.json.
  return !owner
    || !Number.isInteger(Number(owner.pid))
    || typeof owner.bootId !== "string"
    || typeof owner.processStart !== "string"
    || !isProcessIdentityAlive(owner);
}

function pointerRecordFor(generationId, marker) {
  return {
    version: 1,
    generationId,
    commitId: marker.commitId,
    manifestDigest: marker.manifestDigest,
    committedAt: marker.committedAt,
  };
}

function writeAtomicSync(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

async function writeAtomic(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

function writePointerSync(jobDir, record) {
  mkdirSync(generationRoot(jobDir), { recursive: true });
  writeAtomicSync(pointerPath(jobDir), JSON.stringify({
    ...record,
    publishedAt: new Date().toISOString(),
  }, null, 2));
}

async function writePointer(jobDir, record) {
  await mkdir(generationRoot(jobDir), { recursive: true });
  await writeAtomic(pointerPath(jobDir), JSON.stringify({
    ...record,
    publishedAt: new Date().toISOString(),
  }, null, 2));
}

function writeHistorySync(jobDir, record) {
  const history = [...readHistorySync(jobDir), record]
    .filter((entry, index, list) => list.findIndex((candidate) => candidate.generationId === entry.generationId) === index)
    .slice(-MAX_POINTER_HISTORY);
  writeAtomicSync(historyPath(jobDir), JSON.stringify(history, null, 2));
}

async function writeHistory(jobDir, record) {
  const history = [...await readHistory(jobDir), record]
    .filter((entry, index, list) => list.findIndex((candidate) => candidate.generationId === entry.generationId) === index)
    .slice(-MAX_POINTER_HISTORY);
  await writeAtomic(historyPath(jobDir), JSON.stringify(history, null, 2));
}

function readCommittedRecordSync(jobDir, generationId) {
  const generationDir = resolveGenerationPath(jobDir, generationId);
  if (!generationDir || !existsSync(generationDir) || !hasValidCommitMarkerSync(generationDir, generationId)) return null;
  const marker = readJsonSync(commitMarkerPath(generationDir));
  return pointerRecordFor(generationId, marker);
}

async function readCommittedRecord(jobDir, generationId) {
  const generationDir = resolveGenerationPath(jobDir, generationId);
  if (!generationDir || !(await stat(generationDir).catch(() => null)) || !(await hasValidCommitMarker(generationDir, generationId))) return null;
  const marker = await readJson(commitMarkerPath(generationDir));
  return pointerRecordFor(generationId, marker);
}

function repairFromHistorySync(jobDir, pointer) {
  const candidates = [];
  if (pointer?.generationId) candidates.push(pointer.generationId);
  for (const record of readHistorySync(jobDir).slice().reverse()) candidates.push(record.generationId);
  for (const generationId of candidates) {
    const record = readCommittedRecordSync(jobDir, generationId);
    if (!record) continue;
    try {
      writePointerSync(jobDir, record);
    } catch {
      // Readers can still use a committed generation on read-only media.
    }
    return resolveGenerationPath(jobDir, generationId);
  }
  return null;
}

function latestCommittedHistorySync(jobDir) {
  for (const record of readHistorySync(jobDir).slice().reverse()) {
    const committed = readCommittedRecordSync(jobDir, record?.generationId);
    if (committed) return committed;
  }
  return null;
}

async function repairFromHistory(jobDir, pointer) {
  const candidates = [];
  if (pointer?.generationId) candidates.push(pointer.generationId);
  for (const record of (await readHistory(jobDir)).slice().reverse()) candidates.push(record.generationId);
  for (const generationId of candidates) {
    const record = await readCommittedRecord(jobDir, generationId);
    if (!record) continue;
    try {
      await writePointer(jobDir, record);
    } catch {
      // Readers can still use a committed generation on read-only media.
    }
    return resolveGenerationPath(jobDir, generationId);
  }
  return null;
}

async function latestCommittedHistory(jobDir) {
  for (const record of (await readHistory(jobDir)).slice().reverse()) {
    const committed = await readCommittedRecord(jobDir, record?.generationId);
    if (committed) return committed;
  }
  return null;
}

function quarantineUncommittedGenerationsSync(jobDir) {
  let entries;
  try {
    entries = readdirSync(generationRoot(jobDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeGenerationId(entry.name)) continue;
    const dir = resolveGenerationPath(jobDir, entry.name);
    if (hasValidCommitMarkerSync(dir, entry.name)) continue;
    try {
      renameSync(dir, join(generationRoot(jobDir), `.quarantine-${entry.name}-${randomUUID()}`));
    } catch {
      // Another process may be publishing or quarantining this directory.
    }
  }
}

async function quarantineUncommittedGenerations(jobDir) {
  const entries = await readdir(generationRoot(jobDir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeGenerationId(entry.name)) continue;
    const dir = resolveGenerationPath(jobDir, entry.name);
    if (await hasValidCommitMarker(dir, entry.name)) continue;
    await rename(dir, join(generationRoot(jobDir), `.quarantine-${entry.name}-${randomUUID()}`)).catch(() => {});
  }
}

/** Resolve only a pointer/history-committed generation; never pick newest. */
export function resolveActiveJobGenerationSync(jobDir) {
  quarantineUncommittedGenerationsSync(jobDir);
  const pointer = readPointerSync(jobDir);
  const pointed = pointer?.generationId && resolveGenerationPath(jobDir, pointer.generationId);
  const pointedIsValid = pointed && hasValidCommitMarkerSync(pointed, pointer.generationId);
  const historyLatest = latestCommittedHistorySync(jobDir);
  if (pointedIsValid && (!historyLatest || historyLatest.generationId === pointer.generationId)) return pointed;
  if (historyLatest) {
    try {
      writePointerSync(jobDir, historyLatest);
    } catch {
      // Readers can still use the committed generation on read-only media.
    }
    return resolveGenerationPath(jobDir, historyLatest.generationId) || jobDir;
  }
  return repairFromHistorySync(jobDir, pointer) || jobDir;
}

export async function resolveActiveJobGeneration(jobDir) {
  await quarantineUncommittedGenerations(jobDir);
  const pointer = await readPointer(jobDir);
  const pointed = pointer?.generationId && resolveGenerationPath(jobDir, pointer.generationId);
  const pointedIsValid = pointed && await hasValidCommitMarker(pointed, pointer.generationId);
  const historyLatest = await latestCommittedHistory(jobDir);
  if (pointedIsValid && (!historyLatest || historyLatest.generationId === pointer.generationId)) return pointed;
  if (historyLatest) {
    try {
      await writePointer(jobDir, historyLatest);
    } catch {
      // Readers can still use the committed generation on read-only media.
    }
    return resolveGenerationPath(jobDir, historyLatest.generationId) || jobDir;
  }
  return await repairFromHistory(jobDir, pointer) || jobDir;
}

/**
 * A committed generation is immutable: every read re-hashes it against its
 * commit marker, and one whose files changed is quarantined, so the job
 * silently falls back to the previous generation and the write is lost.
 * Commercial writers resolve their target through this instead of
 * resolveActiveJobGeneration: a staged generation (from runAtomicJobGeneration)
 * or a job that has no generation yet resolves to itself and is writable; a
 * job root that resolves to a committed generation throws, so a caller that
 * forgot to stage fails loudly instead of rolling the job back.
 */
export function assertWritableJobDir(dir, requestedDir = dir) {
  if (!existsSync(commitMarkerPath(dir))) return dir;
  const error = new Error(
    `refusing to write into committed job generation ${basename(dir)} of ${requestedDir}: `
    + "commercial writes must run inside runAtomicJobGeneration",
  );
  error.code = "FIELD_COMMITTED_GENERATION_WRITE";
  error.statusCode = 500;
  throw error;
}

export async function resolveWritableJobGeneration(jobDir) {
  return assertWritableJobDir(await resolveActiveJobGeneration(jobDir), jobDir);
}

async function listFiles(dir, root = dir, allowLegacyOperational = false) {
  const isRoot = dir === root;
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isRoot && GENERATION_INTERNAL_ENTRIES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (isRoot && !isAllowedGenerationEntry(entry.name)
      && !(allowLegacyOperational && ROOT_AUTHORITATIVE_ENTRIES.has(entry.name))) {
      throw new Error(`unexpected generation entry: ${entry.name}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in job generations: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) files.push(...await listFiles(path, root, allowLegacyOperational));
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({
        path: relative(root, path).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      });
    } else {
      throw new Error(`special nodes are not allowed in job generations: ${relative(root, path)}`);
    }
  }
  return files;
}

async function writeCommitMarker(stagedJobDir, generationId) {
  const files = await listFiles(stagedJobDir);
  const manifestDigest = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  const marker = {
    version: GENERATION_MANIFEST_VERSION,
    generationId,
    commitId: randomUUID(),
    committedAt: new Date().toISOString(),
    manifestDigest,
    files,
  };
  await writeFile(commitMarkerPath(stagedJobDir), JSON.stringify(marker, null, 2));
  return marker;
}

export async function createStagedJobGeneration(jobDir) {
  const activeDir = await resolveActiveJobGeneration(jobDir);
  const stageDir = await mkdtemp(join(dirname(jobDir), `.field-generation-stage-${basename(jobDir)}-`));
  const activeRoot = resolve(activeDir);
  for (const entry of readdirSync(activeRoot, { withFileTypes: true })) {
    if (GENERATION_INTERNAL_ENTRIES.has(entry.name)) continue;
    assertNoFollowTreeSync(join(activeRoot, entry.name), activeRoot);
  }
  const excludedRootEntries = new Set([
    JOB_GENERATIONS_DIR,
    JOB_GENERATION_POINTER,
    JOB_GENERATION_HISTORY,
    JOB_GENERATION_LOCK,
  ]);
  await cp(activeDir, stageDir, {
    recursive: true,
    force: true,
    filter(source) {
      const relativeSource = relative(activeRoot, resolve(source));
      if (!relativeSource) return true;
      const firstEntry = relativeSource.split(/[\\/]/)[0];
      if (excludedRootEntries.has(firstEntry)) return false;
      const sourceInfo = lstatSync(source);
      if (sourceInfo.isSymbolicLink()) {
        throw new Error(`symbolic links are not allowed in job generations: ${relativeSource}`);
      }
      if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) {
        throw new Error(`special nodes are not allowed in job generations: ${relativeSource}`);
      }
      if (!isCommercialArtifactEntry(firstEntry)) return false;
      return true;
    },
  });
  await rm(commitMarkerPath(stageDir), { force: true }).catch(() => {});
  await rm(join(stageDir, JOB_GENERATION_LOCK), { recursive: true, force: true }).catch(() => {});
  return stageDir;
}

async function nextGenerationId(jobDir) {
  const history = await readHistory(jobDir);
  const numbers = history
    .map((entry) => /^g-(\d+)$/.exec(String(entry?.generationId || "")))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter(Number.isSafeInteger);
  const entries = await readdir(generationRoot(jobDir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const match = /^g-(\d+)$/.exec(entry.name);
    if (match) numbers.push(Number(match[1]));
  }
  let sequence = (numbers.length ? Math.max(...numbers) : 0) + 1;
  while (existsSync(join(generationRoot(jobDir), `g-${String(sequence).padStart(6, "0")}`))) sequence += 1;
  return `g-${String(sequence).padStart(6, "0")}`;
}

async function projectGenerationToLegacyRoot(jobDir, generationDir) {
  // Compatibility projection only. Every reader resolves the pointer first;
  // failures here cannot undo a committed generation and are intentionally
  // reported as post-commit diagnostics rather than transaction failures.
  const entries = await readdir(generationDir, { withFileTypes: true });
  for (const entry of entries) {
    if (GENERATION_INTERNAL_ENTRIES.has(entry.name)) continue;
    if (!isCommercialArtifactEntry(entry.name)) {
      throw new Error(`unexpected commercial projection entry: ${entry.name}`);
    }
    const destination = join(jobDir, entry.name);
    const temporary = `${destination}.${randomUUID()}.projection`;
    await cp(join(generationDir, entry.name), temporary, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    await rename(temporary, destination);
  }
}

export async function publishStagedJobGeneration({ jobDir, stagedJobDir, flush = true }) {
  if (!jobDir || !stagedJobDir) throw new Error("jobDir and stagedJobDir are required");
  await rm(join(stagedJobDir, JOB_GENERATION_LOCK), { recursive: true, force: true });
  const generationId = await nextGenerationId(jobDir);
  const marker = await writeCommitMarker(stagedJobDir, generationId);
  const targetDir = join(generationRoot(jobDir), generationId);
  await mkdir(generationRoot(jobDir), { recursive: true });
  const record = pointerRecordFor(generationId, marker);
  // Write the durable commit journal before the directory exchange. If the
  // process dies before rename, recovery ignores this journal entry because
  // its marker is not present at the target; after rename, history is enough
  // to recover even if pointer replacement is interrupted. No generation is
  // inferred from directory order.
  await writeHistory(jobDir, record);
  await rename(stagedJobDir, targetDir);
  try {
    await writePointer(jobDir, record);
  } catch (error) {
    // The generation is already committed and journaled. Keep the previous
    // pointer authoritative; readers will repair it from history on the next
    // access, and this post-commit diagnostic must not turn a successful
    // publication into a reported failed transaction.
    console.warn(`[job-generation] committed ${generationId} but pointer replacement failed: ${error.message}`);
  }
  try {
    await projectGenerationToLegacyRoot(jobDir, targetDir);
  } catch (error) {
    console.warn(`[job-generation] committed ${generationId} but compatibility projection failed: ${error.message}`);
  }
  // Commit point for durable storage: the published generation is
  // stored now, not only when the request ends. A failure is logged and
  // retried; a request still answers 503 if its writes cannot be stored.
  // `flush: false` is for a caller that stores many jobs' generations in one
  // flush of its own (a boot data migration: all of them or none).
  if (flush) await flushDurableStorageQuietly({ reason: `job generation ${generationId}` });
  return targetDir;
}

export async function withJobGenerationLock(jobDir, operation, { timeoutMs = 30_000, retryMs = 25 } = {}) {
  await mkdir(jobDir, { recursive: true });
  const lockPath = join(jobDir, JOB_GENERATION_LOCK);
  const started = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), ownerPayload(), { flag: "wx" });
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockPath);
      if (isReclaimableLockOwner(owner)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`job generation lock is busy: ${jobDir}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

// One listener told about every committed generation, after its post-commit
// callbacks and still under the job's generation lock, so it reads exactly
// what was committed. The server installs the quote-row dual-write here
// (server/quotes/recorder.js, #6). A listener failure is logged and never
// turns a committed change into a failed one.
let generationCommitListener = null;

export function installJobGenerationCommitListener(listener) {
  generationCommitListener = typeof listener === "function" ? listener : null;
}

async function notifyGenerationCommitted(jobDir) {
  if (!generationCommitListener) return;
  try {
    await generationCommitListener(jobDir);
  } catch (error) {
    console.warn(`[job-generation] commit listener failed for ${jobDir}: ${error.message}`);
  }
}

export async function runAtomicJobGeneration(jobDir, operation, options = {}) {
  const { flush = true, ...lockOptions } = options;
  return withJobGenerationLock(jobDir, async () => {
    const stagedJobDir = await createStagedJobGeneration(jobDir);
    STAGED_POST_COMMIT.set(stagedJobDir, { callbacks: [] });
    try {
      const result = await operation(stagedJobDir);
      await publishStagedJobGeneration({ jobDir, stagedJobDir, flush });
      await flushStagedPostCommit(stagedJobDir, jobDir);
      await notifyGenerationCommitted(jobDir);
      return result;
    } catch (error) {
      STAGED_POST_COMMIT.delete(stagedJobDir);
      await rm(stagedJobDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }, lockOptions);
}
