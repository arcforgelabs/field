import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "./storage/fs.js";
import { mkdir, readFile, rename, rm, writeFile } from "./storage/fs-promises.js";
import { join, resolve } from "node:path";
import { resolveActiveJobGeneration, resolveWritableJobGeneration } from "./job-generation.js";

/**
 * The issuance ledger is the only durable evidence that a quote version was
 * actually delivered.  Pipeline position, a finalized flag, or a locked
 * draft are deliberately not issuance evidence.
 */
export const QUOTE_ISSUANCE_LEDGER_FILE = "quote-issuance.json";
export const ISSUED_DOCUMENTS_DIR = "issued-documents";

const LEDGER_VERSION = 1;

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

function normalizeDocumentType(value) {
  const documentType = String(value || "quote").trim().toLowerCase();
  return ["quote", "invoice", "receipt"].includes(documentType) ? documentType : "quote";
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeLedger(value) {
  if (!value || typeof value !== "object") {
    return { version: LEDGER_VERSION, issuedVersions: [], records: [] };
  }
  const records = Array.isArray(value.records)
    ? value.records.filter((record) => normalizeVersion(record?.quoteVersion))
    : [];
  const issuedVersions = [...new Set([
    ...(Array.isArray(value.issuedVersions) ? value.issuedVersions : []),
    ...records.map((record) => Number(record.quoteVersion)),
  ])].filter((version) => Number.isInteger(Number(version)) && Number(version) > 0)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    version: LEDGER_VERSION,
    issuedVersions,
    records,
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

export async function readQuoteIssuanceLedger(jobDir) {
  const activeDir = await resolveActiveJobGeneration(jobDir);
  return normalizeLedger(await readJson(join(activeDir, QUOTE_ISSUANCE_LEDGER_FILE)));
}

export function findIssuedQuoteVersion(ledger, version, documentType = null) {
  const requestedVersion = normalizeVersion(version);
  if (!requestedVersion) return null;
  const requestedDocumentType = documentType == null ? null : normalizeDocumentType(documentType);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  // The last successful delivery is the current exact artifact for a version;
  // earlier records remain in the ledger for auditability.
  return records
    .filter((record) => Number(record?.quoteVersion) === requestedVersion)
    .filter((record) => {
      if (!requestedDocumentType) return true;
      // Pre-ledger records did not carry a document type and represented quote
      // delivery. Keep them readable only through the quote surface; invoice
      // and receipt routes must never mistake those bytes for their document.
      return normalizeDocumentType(record?.documentType || record?.delivery?.documentType) === requestedDocumentType
        && (record?.documentType || record?.delivery?.documentType || requestedDocumentType === "quote");
    })
    .at(-1) || null;
}

function normalizeArtifactInput(value, fallbackMimeType) {
  if (value == null) return null;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return { bytes, mimeType: fallbackMimeType };
}

/**
 * Stage exact bytes prepared for a successful delivery and append their
 * hashes to the version-keyed issuance ledger.  This function intentionally
 * does not send mail or infer issuance from a status field.
 */
export async function recordIssuedQuoteDocuments({
  jobDir,
  quoteVersion,
  documentType = "quote",
  quoteSnapshotDigest = null,
  issuedAt = new Date().toISOString(),
  deliveryResult = null,
  quoteMarkdown = null,
  reportMarkdown = null,
  quotePdf = null,
} = {}) {
  const version = normalizeVersion(quoteVersion);
  if (!version) throw new Error("recordIssuedQuoteDocuments requires a positive quoteVersion");
  const resolvedDocumentType = normalizeDocumentType(documentType);
  const activeDir = await resolveWritableJobGeneration(jobDir);
  const issuanceId = randomUUID();
  const relativeRoot = join(ISSUED_DOCUMENTS_DIR, `v${String(version).padStart(3, "0")}`, issuanceId);
  const documentRoot = join(activeDir, relativeRoot);
  await mkdir(documentRoot, { recursive: true });

  const candidates = [
    ["quoteMarkdown", quoteMarkdown, "text/markdown", "quote.md"],
    ["reportMarkdown", reportMarkdown, "text/markdown", "report.md"],
    ["quotePdf", quotePdf, "application/pdf", "quote.pdf"],
  ];
  const artifacts = {};
  for (const [key, value, mimeType, fileName] of candidates) {
    const normalized = normalizeArtifactInput(value, mimeType);
    if (!normalized) continue;
    const path = join(documentRoot, fileName);
    await writeFile(path, normalized.bytes, { flag: "wx" });
    artifacts[key] = {
      path: join(relativeRoot, fileName).replaceAll("\\", "/"),
      sha256: hashBytes(normalized.bytes),
      byteLength: normalized.bytes.length,
      mimeType: normalized.mimeType,
    };
  }
  if (Object.keys(artifacts).length === 0) {
    await rm(documentRoot, { recursive: true, force: true });
    throw new Error("recordIssuedQuoteDocuments requires at least one prepared document");
  }

  const ledgerPath = join(activeDir, QUOTE_ISSUANCE_LEDGER_FILE);
  const ledger = normalizeLedger(await readJson(ledgerPath));
  const record = {
    issuanceId,
    quoteVersion: version,
    documentType: resolvedDocumentType,
    issuedAt,
    quoteSnapshotDigest: quoteSnapshotDigest || null,
    delivery: deliveryResult || null,
    artifacts,
  };
  ledger.records.push(record);
  ledger.issuedVersions = [...new Set([...ledger.issuedVersions, version])].sort((a, b) => a - b);
  await writeJsonAtomically(ledgerPath, ledger);
  return record;
}

/** Read and hash-check one exact issued artifact. */
export async function readIssuedQuoteArtifact(jobDir, record, artifactKey) {
  const artifact = record?.artifacts?.[artifactKey];
  if (!artifact?.path || !/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ""))) {
    return { available: false, reason: "issued artifact bytes are unavailable" };
  }
  const activeDir = await resolveActiveJobGeneration(jobDir);
  const path = resolve(activeDir, artifact.path);
  if (!path.startsWith(`${resolve(activeDir)}\/`)) {
    return { available: false, reason: "issued artifact path is invalid" };
  }
  try {
    const bytes = await readFile(path);
    if (hashBytes(bytes) !== String(artifact.sha256).toLowerCase()) {
      return { available: false, reason: "issued artifact hash does not match its issuance ledger" };
    }
    return { available: true, bytes, mimeType: artifact.mimeType || "application/octet-stream" };
  } catch {
    return { available: false, reason: "issued artifact bytes are unavailable" };
  }
}

export async function readIssuedQuoteDocument(jobDir, version, artifactKey, documentType = null) {
  const ledger = await readQuoteIssuanceLedger(jobDir);
  const record = findIssuedQuoteVersion(ledger, version, documentType);
  if (!record) return { available: false, record: null, reason: "quote version has no successful delivery record" };
  const artifact = await readIssuedQuoteArtifact(jobDir, record, artifactKey);
  return { ...artifact, record };
}

/** Whether the quote itself (not an invoice or receipt) was delivered for this version. */
export function hasIssuedQuoteVersion(ledger, version) {
  return Boolean(findIssuedQuoteVersion(ledger, version, "quote"));
}

/**
 * The newest delivery of any document type (quote, invoice or receipt) priced
 * from this version. For guards that protect a version's files: an invoice or
 * receipt sent from a version makes it evidence even if the quote never was.
 * Never use it to decide that a quote was sent.
 */
export function findAnyIssuedDocument(ledger, version) {
  return findIssuedQuoteVersion(ledger, version, null);
}

export function quoteIssuanceLedgerExists(jobDir) {
  return existsSync(join(jobDir, QUOTE_ISSUANCE_LEDGER_FILE));
}
