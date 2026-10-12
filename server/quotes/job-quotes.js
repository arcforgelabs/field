// What a job's files say about its quote versions, in the shape the quote
// service takes (#241). Read-only: nothing here writes to a job directory.
// Used by the dual-write (recorder.js) and the backfill (backfill.js).
//
// Versions: the current quote (quote.json at the job's root) and every
// archived `quote-versions/vNNN`. For the current version the root is used,
// as Field shows it; for the others, the archive.
//
// Status, from the same evidence the rest of Field uses:
//
//   delivered    the issuance ledger has a quote delivery for the version,
//                or (before the ledger) the send fields say it was sent
//                (isIssuedQuoteVersion)
//   customer's   the newest delivered version, else the version moved to
//   version      Sent by hand (markedSentQuoteVersion)
//
//   customer's version   accepted when the job is landed, declined when lost,
//                        else sent (draft when it was only marked sent: that
//                        is not a send, see ARCHITECTURE.md)
//   other delivered      superseded
//   older, not sent      superseded
//   newest, not sent     draft
import { createHash } from "node:crypto";
import { readJobMeta } from "../job-meta-store.js";
import { listQuoteVersions, readQuoteArtifacts } from "../quote-artifacts.js";
import { readQuoteLifecycle } from "../quote-lifecycle.js";
import { readQuoteIssuanceLedger } from "../quote-issuance.js";
import { isIssuedQuoteVersion } from "../quote-pricing-attestation.js";
import { normalizePipelineStage } from "../pipeline.js";
import { quoteDocumentNumber } from "../documents/job-sources.js";

/** Bumped when the mapping changes, so draft rows mapped the old way are rewritten. */
export const QUOTE_ROW_MAPPING_VERSION = 1;

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** The ledger's quote deliveries by version: the first record's time and every record. */
function ledgerQuoteDeliveries(ledger) {
  const byVersion = new Map();
  for (const record of ledger?.records || []) {
    const documentType = record?.documentType || record?.delivery?.documentType || "quote";
    if (documentType !== "quote") continue;
    const version = positiveInt(record.quoteVersion);
    if (!version) continue;
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(record);
  }
  return byVersion;
}

/**
 * The hash a version's rows are mapped from: the quote artifact, the job's
 * title and the customer. The same digest means the same rows.
 */
export function quoteSourceDigest({ quote, meta, customer = null }) {
  return createHash("sha256").update(JSON.stringify({
    mapping: QUOTE_ROW_MAPPING_VERSION,
    quote,
    title: meta?.title ?? null,
    customer: customer ?? {
      contactName: meta?.contactName ?? null,
      customerName: meta?.customerName ?? null,
      contactEmail: meta?.contactEmail ?? null,
      contactPhone: meta?.contactPhone ?? null,
      siteAddress: meta?.siteAddress ?? null,
    },
  })).digest("hex");
}

/**
 * A job's quote versions. Returns { jobId, meta, versions } with each version
 * { version, quote, isCurrent, delivered, markedSent, status, sentAt,
 * acceptedAt, documentNumber, ledgerRecords }, oldest first; jobId is null
 * for a directory that is not a job.
 */
export async function collectJobQuoteVersions(jobDir) {
  const meta = await readJobMeta(jobDir);
  const jobId = text(meta?.id ? String(meta.id) : null);
  if (!jobId) return { jobId: null, meta, versions: [] };
  const current = await readQuoteArtifacts(jobDir).catch(() => null);
  const currentVersion = positiveInt(current?.quote?.version);
  const entries = await listQuoteVersions(jobDir).catch(() => []);
  const lifecycle = await readQuoteLifecycle(jobDir).catch(() => null);
  const ledger = await readQuoteIssuanceLedger(jobDir).catch(() => ({ records: [] }));
  const deliveries = ledgerQuoteDeliveries(ledger);

  const versions = [];
  for (const entry of entries) {
    const version = positiveInt(entry?.version);
    if (!version) continue;
    const artifacts = version === currentVersion
      ? current
      : await readQuoteArtifacts(jobDir, version).catch(() => null);
    const quote = artifacts?.quote || null;
    if (!quote) continue;
    const records = deliveries.get(version) || [];
    const delivered = records.length > 0 || isIssuedQuoteVersion({ quote, quoteLifecycle: lifecycle, version, meta });
    versions.push({
      version,
      quote,
      quoteMarkdown: artifacts?.quoteMarkdown || null,
      quotePdfPath: artifacts?.quotePdfPath || null,
      isCurrent: version === currentVersion,
      delivered,
      markedSent: positiveInt(lifecycle?.markedSentQuoteVersion) === version,
      ledgerRecords: records,
      documentNumber: quoteDocumentNumber({ quote, meta, version }),
    });
  }
  versions.sort((a, b) => a.version - b.version);

  const stage = normalizePipelineStage(meta?.pipelineStage || lifecycle?.currentPipelineStage);
  const latest = versions.at(-1)?.version || null;
  const newestDelivered = [...versions].reverse().find((entry) => entry.delivered)?.version || null;
  const customerVersion = newestDelivered || versions.find((entry) => entry.markedSent)?.version || null;
  const landedAt = text(lifecycle?.landedAt) || text(meta?.landedAt);

  for (const entry of versions) {
    const isCustomers = entry.version === customerVersion;
    if (isCustomers && stage === "landed") entry.status = "accepted";
    else if (isCustomers && stage === "lost") entry.status = "declined";
    else if (entry.delivered) entry.status = isCustomers ? "sent" : "superseded";
    else entry.status = entry.version < latest ? "superseded" : "draft";
    entry.sentAt = entry.delivered
      ? text(entry.ledgerRecords[0]?.issuedAt)
        || text(entry.quote?.quoteSentAt)
        || (positiveInt(lifecycle?.lastSentQuoteVersion) === entry.version ? text(lifecycle?.lastSentAt) : null)
        || (positiveInt(meta?.lastSentQuoteVersion) === entry.version ? text(meta?.quoteSentAt) : null)
      : null;
    entry.acceptedAt = entry.status === "accepted" ? landedAt : null;
  }
  return { jobId, meta, versions };
}
