import { existsSync } from "./storage/fs.js";
import { readFile, writeFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { getFieldDbHandle, getNotesForJob } from "./field-db.js";
import { readQuoteArtifacts } from "./quote-artifacts.js";
import { readCurrentVisibleLedgerFiles } from "./quote-version-context.js";
import {
  buildClarificationNoteSummary,
  normalizeClarificationNotes,
  selectClarificationNotesForExtraction,
} from "./clarification-notes.js";
import {
  DEFAULT_QUOTE_CATALOG_ID,
  getQuoteCatalog,
  serializeQuoteCatalog,
} from "./quote-catalogs.js";
import { resolveQuoteCatalogIdFromMeta } from "./quote-catalog-ids.js";

export const QUOTE_EVIDENCE_PACK_FILE = "evidence-pack.json";
export const QUOTE_EVIDENCE_PACK_VERSION = 1;

const QUOTE_EXTRACTION_POLICY = {
  version: "quote-facts-v1",
  intentCategories: [
    "job-scope",
    "process-reference",
    "pricing-reference",
    "mixed",
  ],
  allowedUnits: [
    "hour",
    "m3",
    "m",
    "m2",
    "each",
    "job",
    "load",
    "day",
    "mm",
    null,
  ],
  rules: [
    "Use only evidence in this pack.",
    "Never invent prices.",
    "Never use a quoteCatalogItemCode not present in quoteCatalog.rules[].code.",
    "Every extracted item should cite 1-3 segment IDs when timestamped segments exist.",
    "If uncertain, lower confidence and emit missingInputs or assumptions instead of pretending certainty.",
    "If the recording is mainly process-reference or pricing-reference, keep lineItemCandidates empty unless concrete quoted scope is explicitly present.",
    "When the client language clearly groups work into customer-facing areas like front yard, back yard, irrigation, full site, or site 1, set lineItemCandidates[].section to that label.",
  ],
  outputShape: {
    recordingIntent: "job-scope | process-reference | pricing-reference | mixed",
    summary: "1-3 sentence summary",
    jobScope: {
      customerGoal: "string | null",
      workSummary: "string | null",
      siteContext: "string | null",
    },
    reviewStatus: "ready | manual_review",
    lineItemCandidates: [
      {
        label: "string",
        description: "string",
        quoteCatalogItemCode: "allowed quote-catalog rule code",
        quantity: "number | null",
        unit: "allowed unit | null",
        confidence: "0.0 - 1.0",
        rationale: "string | null",
        section: "customer-facing grouping label | null",
        segmentIds: ["S001"],
      },
    ],
    processReferences: [
      {
        label: "string",
        detail: "string",
        kind: "workflow | constraint | assumption | pricing-method",
        segmentIds: ["S001"],
      },
    ],
    measurements: [
      {
        label: "string",
        value: "number",
        unit: "allowed unit",
        segmentIds: ["S001"],
      },
    ],
    siteConstraints: [
      {
        label: "string",
        detail: "string",
        segmentIds: ["S001"],
      },
    ],
    missingInputs: [
      {
        field: "string",
        reason: "string",
        segmentIds: ["S001"],
      },
    ],
    assumptions: [
      {
        statement: "string",
        segmentIds: ["S001"],
      },
    ],
  },
};

export function buildQuoteEvidencePack({
  meta = null,
  transcript,
  cleanedTranscript = null,
  label = null,
  quoteCatalogId = DEFAULT_QUOTE_CATALOG_ID,
  quoteCatalog = null,
  baselineQuoteContext = null,
  structuredNotes = [],
}) {
  const resolvedQuoteCatalogId = quoteCatalog?.id || quoteCatalogId
    || resolveQuoteCatalogIdFromMeta(meta, DEFAULT_QUOTE_CATALOG_ID);
  const resolvedQuoteCatalog = quoteCatalog || getQuoteCatalog(resolvedQuoteCatalogId);
  const cleaned = cleanedTranscript || transcript?.cleaned || null;
  const segments = buildPackSegments(transcript);

  const pack = {
    kind: "quote-evidence-pack",
    version: QUOTE_EVIDENCE_PACK_VERSION,
    generatedAt: new Date().toISOString(),
    recording: {
      id: meta?.id || null,
      createdAt: meta?.createdAt || null,
      title: meta?.title || cleaned?.title || label || meta?.label || null,
      label: label || meta?.label || meta?.title || cleaned?.title || null,
      outputMode: meta?.outputMode || "quote",
      captureMode: meta?.captureMode || ((meta?.audioFiles?.length || meta?.audioFile) ? "recorded" : "manual"),
      quoteCatalogId: resolvedQuoteCatalog.id,
    },
    evidence: {
      cleanedTranscript: cleaned?.cleanedText || formatTranscriptFallback(transcript),
      cleanedTurns: Array.isArray(cleaned?.turns)
        ? cleaned.turns.map((turn) => ({
            speaker: turn?.speaker || "Unknown",
            text: turn?.text || "",
          }))
        : [],
      segments,
      hasTimestampedSegments: segments.length > 0,
      segmentCount: segments.length,
    },
    extraction: QUOTE_EXTRACTION_POLICY,
    quoteCatalog: serializeQuoteCatalog(resolvedQuoteCatalog),
  };

  if (baselineQuoteContext) {
    return {
      ...pack,
      baselineQuoteContext,
      evidence: {
        ...pack.evidence,
        ...(structuredNotes.length ? { structuredNotes } : {}),
      },
    };
  }

  if (structuredNotes.length) {
    pack.evidence.structuredNotes = structuredNotes;
  }

  return pack;
}

/**
 * Single entry point for building, enriching, and persisting an evidence pack.
 * Always injects clarification notes from the ledger. Always preserves prior enrichments.
 */
const BASELINE_QUOTE_UNSET = Symbol("baselineQuote.unset");

export async function buildAndWriteEvidencePack({
  jobDir,
  jobId,
  meta,
  transcript,
  cleanedTranscript,
  label,
  quoteCatalogId,
  quoteCatalog = null,
  baselineQuote = BASELINE_QUOTE_UNSET,
  operationalJobDir = null,
}) {
  const effectiveBaselineQuote = baselineQuote === BASELINE_QUOTE_UNSET
    ? (await readQuoteArtifacts(jobDir))?.quote || null
    : baselineQuote;
  const structuredNotes = await readStructuredNotesForCurrentContext({
    jobDir,
    operationalJobDir,
    quoteVersion: meta?.quoteVersion || null,
  });
  const pack = buildQuoteEvidencePack({
    meta,
    transcript,
    cleanedTranscript,
    label,
    quoteCatalogId,
    quoteCatalog,
    baselineQuoteContext: summarizeBaselineQuoteContext(effectiveBaselineQuote),
    structuredNotes,
  });

  // Inject clarification notes from the notes ledger
  const db = getFieldDbHandle();
  if (db && jobId) {
    const jobNotes = getNotesForJob(db, jobId);
    if (jobNotes.length > 0) {
      const normalizedNotes = normalizeClarificationNotes(jobNotes);
      const curated = selectClarificationNotesForExtraction(normalizedNotes);
      pack.evidence.clarificationNotes = curated.notes;
      pack.evidence.clarificationNoteSummary = curated.summary
        || buildClarificationNoteSummary(normalizedNotes, {
          includedNotes: curated.notes,
        });
    }
  }

  await writeFile(join(jobDir, QUOTE_EVIDENCE_PACK_FILE), JSON.stringify(pack, null, 2));
  return pack;
}

export async function readQuoteEvidencePack(jobDir) {
  const filePath = join(jobDir, QUOTE_EVIDENCE_PACK_FILE);
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function buildPackSegments(transcript) {
  if (!Array.isArray(transcript?.segments)) return [];
  return transcript.segments.map((segment, index) => ({
    id: segment?.segmentId || `S${String(index + 1).padStart(3, "0")}`,
    speaker: segment?.speaker || "Unknown",
    start: Number.isFinite(Number(segment?.start)) ? Number(segment.start) : null,
    end: Number.isFinite(Number(segment?.end)) ? Number(segment.end) : null,
    text: segment?.text || "",
  }));
}

function formatTranscriptFallback(transcript) {
  return transcript?.fullText || transcript?.cleaned?.cleanedText || "(empty transcript)";
}

function summarizeBaselineQuoteContext(quote = null) {
  if (!quote || typeof quote !== "object") return null;

  const lineItems = Array.isArray(quote?.lineItems)
    ? quote.lineItems
      .map((item) => ({
        code: item?.code || null,
        quoteCatalogItemCode: item?.quoteCatalogItemCode || null,
        label: item?.label || null,
        section: item?.section || null,
        scopeSummary: item?.scopeSummary || null,
        quantity: Number.isFinite(Number(item?.quantity)) ? Number(item.quantity) : null,
        unit: item?.unit || null,
        totalPrice: Number.isFinite(Number(item?.totalPrice)) ? Number(item.totalPrice) : null,
        customerVisible: item?.customerVisible !== false,
        manualOverride: Boolean(item?.manualOverride),
      }))
      .filter((item) => item.label || item.code)
    : [];
  const assumptions = Array.isArray(quote?.assumptions)
    ? quote.assumptions.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const missingInputs = Array.isArray(quote?.missingInputs)
    ? quote.missingInputs.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const reviewReasons = Array.isArray(quote?.review?.reasons)
    ? quote.review.reasons.filter((entry) => typeof entry === "string" && entry.trim())
    : [];

  if (!lineItems.length && !assumptions.length && !missingInputs.length && !reviewReasons.length && !quote?.summary) {
    return null;
  }

  return {
    version: Number(quote?.version || 1),
    summary: quote?.summary || null,
    jobScope: quote?.jobScope || null,
    lineItems,
    assumptions,
    missingInputs,
    review: {
      status: quote?.review?.status || quote?.status || null,
      reasons: reviewReasons,
    },
  };
}

// Filters structured notes against the *current* quote-context.json only.
// Callers rebuilding a snapshot version in place must resolve visibility
// themselves — this helper intentionally does not accept snapshot context.
async function readStructuredNotesForCurrentContext({
  jobDir,
  operationalJobDir = null,
  quoteVersion = null,
} = {}) {
  const operationalRoot = operationalJobDir || jobDir;
  const structuredNotesPath = join(operationalRoot, "parsed", "structured-notes.json");
  if (!existsSync(structuredNotesPath)) return [];

  const payload = JSON.parse(await readFile(structuredNotesPath, "utf8"));
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (!entries.length) return [];

  const { visibleFileIds } = await readCurrentVisibleLedgerFiles({
    jobDir,
    operationalJobDir: operationalRoot,
    quoteVersion,
  });

  return entries
    .map((entry) => normalizeStructuredNoteEntry(entry))
    .filter((entry) => entry && (!entry.sourceFileId || visibleFileIds.has(entry.sourceFileId)));
}

function normalizeStructuredNoteEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const content = entry.content && typeof entry.content === "object"
    ? entry.content
    : {};
  const extractedText = String(content.extractedText || "").trim();
  const sections = Array.isArray(content.sections)
    ? content.sections
      .map((section) => ({
        heading: String(section?.heading || "").trim() || "Notes",
        text: String(section?.text || "").trim(),
      }))
      .filter((section) => section.text)
    : [];

  if (!extractedText && !sections.length) return null;

  return {
    entryId: String(entry.entryId || "").trim() || null,
    sourceFileId: String(entry.sourceFileId || "").trim() || null,
    sourceFilePath: String(entry.sourceFilePath || "").trim() || null,
    sourceKind: String(content.sourceKind || entry.classifiedAs || "text_note").trim() || "text_note",
    summary: String(content.summary || "").trim() || null,
    extractedText: extractedText || sections.map((section) => `${section.heading}\n${section.text}`).join("\n\n"),
    sections,
    createdAt: String(entry.createdAt || "").trim() || null,
  };
}
