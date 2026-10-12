// Backfill of issued documents from today's job files (#223).
//
// Walks every job in a data directory and records into issued_documents what
// the files say a customer was issued, with the original bytes:
//
//   quote, invoice, receipt   the issuance ledger (quote-issuance.json and
//                             issued-documents/), source ledger-backfill, with
//                             an `emailed` event per ledger record
//   invoice                   every issued milestone invoice revision,
//                             superseded ones included (milestone-invoices/
//                             state.json, pdfPath and pdfSha256), source
//                             invoice-revision-backfill
//   quote                     quotes sent before the ledger
//                             (legacy-sent-quote.js), source
//                             legacy-sent-attachment or legacy-stored-version
//
// Every file is hashed and compared with the hash its record holds; a
// mismatch is reported and skipped, never "fixed". Recording is idempotent
// (the issue service), so running it again records nothing new. It never
// writes to a job directory. With `dryRun` it writes nothing anywhere and
// reports what it would record.
import { readdir, stat } from "../storage/fs-promises.js";
import { existsSync } from "../storage/fs.js";
import { join } from "node:path";
import { resolveActiveJobGeneration } from "../job-generation.js";
import { readJobMeta } from "../job-meta-store.js";
import { listQuoteVersions, readQuoteArtifacts } from "../quote-artifacts.js";
import { readQuoteLifecycle } from "../quote-lifecycle.js";
import { readQuoteIssuanceLedger } from "../quote-issuance.js";
import { readLegacySentQuotePdf } from "../legacy-sent-quote.js";
import { isIssuedQuoteVersion } from "../quote-pricing-attestation.js";
import { sha256Hex } from "./blob-store.js";
import { IssuedDocumentConflictError } from "./issued-documents.js";
import {
  invoiceDocumentNumber,
  invoiceRevisionDetails,
  issuedInvoiceRevisions,
  quoteDocumentNumber,
  readInvoiceRevisionPdf,
  readJobFile,
  receiptDocumentNumber,
} from "./job-sources.js";

const LEGACY_SOURCES = { "sent-attachment": "legacy-sent-attachment", "stored-version": "legacy-stored-version" };

function emptyReport() {
  return {
    jobs: 0,
    jobsWithDocuments: 0,
    found: {},
    recorded: {},
    alreadyRecorded: 0,
    emailedEvents: 0,
    mismatches: [],
    missing: [],
    conflicts: [],
    ambiguous: [],
    errors: [],
  };
}

// The number as a whole word in a subject: milestone 1's number must not
// match inside its -R2 revision's number or milestone 10's.
function mentions(subject, number) {
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`).test(subject);
}

// An invoice is issued as a milestone revision; the ledger then records its
// delivery. Record revisions first so the ledger adds emails to them.
const ORIGIN_ORDER = { "invoice-revision": 0, ledger: 1, legacy: 2 };

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/** Every job directory under a data directory: <dataDir>/<dateDir>/<jobDir> with a meta.json. */
export async function listJobDirs(dataDir) {
  const dirs = [];
  let dateDirs = [];
  try {
    dateDirs = (await readdir(dataDir)).sort();
  } catch {
    return dirs;
  }
  for (const dateDir of dateDirs) {
    if (dateDir.startsWith(".")) continue;
    const datePath = join(dataDir, dateDir);
    const info = await stat(datePath).catch(() => null);
    if (!info?.isDirectory()) continue;
    const children = (await readdir(datePath).catch(() => [])).sort();
    for (const child of children) {
      const jobDir = join(datePath, child);
      if (!(await stat(jobDir).catch(() => null))?.isDirectory()) continue;
      if (existsSync(join(jobDir, "meta.json"))) {
        dirs.push(jobDir);
        continue;
      }
      const active = await resolveActiveJobGeneration(jobDir).catch(() => jobDir);
      if (active !== jobDir && existsSync(join(active, "meta.json"))) dirs.push(jobDir);
    }
  }
  return dirs;
}

/**
 * What one job's files say was issued, as issue-service inputs, plus the
 * problems found (each { kind, jobId, number?, path?, reason }).
 */
export async function collectJobDocuments(jobDir) {
  const candidates = [];
  const problems = [];
  const meta = await readJobMeta(jobDir);
  const jobId = meta?.id ? String(meta.id) : null;
  if (!jobId) return { jobId: null, candidates, problems };
  const currentArtifacts = await readQuoteArtifacts(jobDir).catch(() => null);
  const currentQuote = currentArtifacts?.quote || null;

  // 1. The issuance ledger: exact bytes of every successful delivery.
  const ledger = await readQuoteIssuanceLedger(jobDir);
  const ledgerQuoteVersions = new Set();
  for (const record of ledger.records) {
    const artifact = record?.artifacts?.quotePdf;
    const documentType = record.documentType || record.delivery?.documentType || "quote";
    const version = Number(record.quoteVersion);
    if (documentType === "quote") ledgerQuoteVersions.add(version);
    let number = null;
    if (documentType === "quote") {
      const versionQuote = (await readQuoteArtifacts(jobDir, version).catch(() => null))?.quote || currentQuote;
      number = quoteDocumentNumber({ quote: versionQuote, meta, version });
    } else {
      // The ledger does not name the milestone. Its delivery subject and the
      // sent-email archive do; match by the PDF's hash instead, below.
      number = null;
    }
    if (!artifact?.path) {
      problems.push({ kind: "missing", jobId, documentType, number, reason: "ledger record has no PDF", issuanceId: record.issuanceId });
      continue;
    }
    const pdf = await readJobFile(jobDir, artifact.path, { expectedSha256: artifact.sha256 });
    if (!pdf.ok) {
      problems.push({ kind: pdf.mismatch ? "mismatch" : "missing", jobId, documentType, number, path: artifact.path, reason: pdf.reason, issuanceId: record.issuanceId, recordedSha256: artifact.sha256, actualSha256: pdf.sha256 || null });
      continue;
    }
    candidates.push({
      origin: "ledger",
      record,
      input: {
        jobId,
        documentType,
        number,
        quoteVersion: Number.isInteger(version) && version > 0 ? version : null,
        revision: null,
        pdfBytes: pdf.bytes,
        issuedAt: record.issuedAt,
        issuedBy: null,
        source: "ledger-backfill",
        details: {
          issuanceId: record.issuanceId,
          ledgerPath: artifact.path,
          quoteSnapshotDigest: record.quoteSnapshotDigest || undefined,
        },
      },
      email: record.delivery?.messageId || record.issuanceId ? {
        sentAt: record.issuedAt,
        messageId: record.delivery?.messageId || null,
        threadId: record.delivery?.threadId || null,
        to: record.delivery?.to || [],
        subject: record.delivery?.subject || null,
        issuanceId: record.issuanceId,
      } : null,
    });
  }

  // 2. Issued invoice revisions, superseded ones included.
  for (const { milestone, revision, active, stored } of issuedInvoiceRevisions(meta, { includeHistory: true })) {
    const number = invoiceDocumentNumber({ meta, quote: currentQuote, milestoneInvoice: milestone, revision });
    if (!stored) {
      problems.push({ kind: "missing", jobId, documentType: "invoice", number, path: revision?.pdfPath || null, reason: `revision PDF is ${revision?.artifactState || "not stored"}` });
      continue;
    }
    const pdf = await readInvoiceRevisionPdf(jobDir, revision);
    if (!pdf.ok) {
      problems.push({ kind: pdf.mismatch ? "mismatch" : "missing", jobId, documentType: "invoice", number, path: revision.pdfPath, reason: pdf.reason, recordedSha256: revision.pdfSha256, actualSha256: pdf.sha256 || null });
      continue;
    }
    candidates.push({
      origin: "invoice-revision",
      input: {
        jobId,
        documentType: "invoice",
        number,
        quoteVersion: revision.quoteVersion,
        revision: revision.revisionNumber,
        pdfBytes: pdf.bytes,
        issuedAt: revision.issuedAt || revision.pdfIssuedAt || milestone.issuedAt,
        issuedBy: revision.revisionNumber > 1 ? revision.revisedBy : null,
        source: "invoice-revision-backfill",
        details: { ...invoiceRevisionDetails(milestone, revision), superseded: !active },
      },
    });
  }

  // Ledger invoices and receipts: name them by the milestone document whose
  // bytes they carry (an invoice revision with the same hash), else by the
  // receipt or invoice number the delivery's subject or milestone gives.
  const invoiceBySha = new Map(candidates.filter((c) => c.origin === "invoice-revision").map((c) => [sha256Hex(c.input.pdfBytes), c.input]));
  for (const candidate of candidates.filter((c) => c.origin === "ledger" && !c.input.number)) {
    const sha = sha256Hex(candidate.input.pdfBytes);
    if (candidate.input.documentType === "invoice" && invoiceBySha.has(sha)) {
      const revision = invoiceBySha.get(sha);
      Object.assign(candidate.input, { number: revision.number, revision: revision.revision });
      continue;
    }
    const subject = String(candidate.record?.delivery?.subject || "");
    const milestones = meta?.milestoneInvoices || [];
    const named = milestones.map((milestone) => ({
      milestone,
      number: candidate.input.documentType === "receipt"
        ? receiptDocumentNumber({ meta, quote: currentQuote, milestoneInvoice: milestone })
        : invoiceDocumentNumber({ meta, quote: currentQuote, milestoneInvoice: milestone }),
    })).filter((entry) => entry.number && mentions(subject, entry.number));
    if (named.length === 1) {
      candidate.input.number = named[0].number;
    } else {
      problems.push({ kind: "ambiguous", jobId, documentType: candidate.input.documentType, reason: named.length ? "the delivery subject names more than one milestone" : "no milestone document matches this ledger record", issuanceId: candidate.record?.issuanceId, subject: subject || null });
      candidate.skip = true;
    }
  }

  // 3. Quotes sent before the ledger.
  const lifecycle = await readQuoteLifecycle(jobDir).catch(() => null);
  const versions = await listQuoteVersions(jobDir).catch(() => []);
  const legacy = [];
  for (const entry of versions) {
    const version = Number(entry.version);
    if (!Number.isInteger(version) || version < 1 || ledgerQuoteVersions.has(version)) continue;
    const artifacts = (await readQuoteArtifacts(jobDir, version).catch(() => null))
      || (Number(currentQuote?.version) === version ? currentArtifacts : null);
    const quote = artifacts?.quote || null;
    if (!isIssuedQuoteVersion({ quote, quoteLifecycle: lifecycle, version, meta })) continue;
    const number = quoteDocumentNumber({ quote, meta, version });
    const copy = await readLegacySentQuotePdf(jobDir, version, artifacts?.quotePdfPath || null);
    if (!copy.available) {
      problems.push({ kind: "missing", jobId, documentType: "quote", number, reason: "sent before the issuance ledger and no copy of the sent PDF was found" });
      continue;
    }
    legacy.push({
      origin: "legacy",
      input: {
        jobId,
        documentType: "quote",
        number,
        quoteVersion: version,
        revision: null,
        pdfBytes: copy.bytes,
        issuedAt: copy.sentAt || quote?.quoteSentAt || meta?.quoteSentAt || lifecycle?.lastSentAt || meta?.createdAt,
        issuedBy: null,
        source: LEGACY_SOURCES[copy.source] || "legacy-stored-version",
        details: { legacyFileName: copy.fileName || null },
      },
    });
  }
  // The same bytes attributed to more than one version means the archive
  // could not tell which version was sent: report rather than guess.
  const legacyBySha = new Map();
  for (const candidate of legacy) {
    const sha = sha256Hex(candidate.input.pdfBytes);
    legacyBySha.set(sha, [...(legacyBySha.get(sha) || []), candidate]);
  }
  for (const [sha, group] of legacyBySha) {
    if (group.length > 1) {
      problems.push({ kind: "ambiguous", jobId, documentType: "quote", reason: `one legacy PDF (${sha.slice(0, 12)}…) is the only copy found for versions ${group.map((c) => c.input.quoteVersion).join(", ")}`, numbers: group.map((c) => c.input.number) });
      for (const candidate of group) candidate.skip = true;
    }
  }
  candidates.push(...legacy);
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => (ORIGIN_ORDER[a.candidate.origin] - ORIGIN_ORDER[b.candidate.origin]) || (a.index - b.index))
    .map(({ candidate }) => candidate);
  return { jobId, candidates: ordered.filter((c) => !c.skip), problems };
}

/**
 * Backfill one job. `service` is the issue service for the organisation the
 * data directory belongs to. Adds to `report`.
 */
export async function backfillJob({ jobDir, service, dryRun = false, report = emptyReport() }) {
  let collected;
  try {
    collected = await collectJobDocuments(jobDir);
  } catch (error) {
    report.errors.push({ jobDir, reason: error.message });
    return report;
  }
  const { jobId, candidates, problems } = collected;
  if (!jobId) return report;
  report.jobs += 1;
  if (candidates.length) report.jobsWithDocuments += 1;
  for (const problem of problems) {
    const bucket = problem.kind === "mismatch" ? report.mismatches : problem.kind === "ambiguous" ? report.ambiguous : report.missing;
    bucket.push(problem);
  }
  const planned = new Map();
  for (const candidate of candidates) {
    const { input } = candidate;
    bump(report.found, `${input.documentType}/${input.source}`);
    if (dryRun) {
      // Read-only: say what a real run would do, when there is a database to ask.
      if (!service) continue;
      try {
        const key = `${input.documentType}|${input.number}`;
        const existing = planned.get(key) || await service.findIssuedDocument({ documentType: input.documentType, number: input.number });
        if (!existing) planned.set(key, { uid: null, source: input.source, pdfSha256: sha256Hex(input.pdfBytes) });
        if (!existing) bump(report.recorded, `${input.documentType}/${input.source}`);
        else if (existing.pdfSha256 === sha256Hex(input.pdfBytes)) report.alreadyRecorded += 1;
        else if (candidate.origin !== "ledger") report.conflicts.push({ jobId, documentType: input.documentType, number: input.number, source: input.source, existing: { uid: existing.uid, source: existing.source, pdfSha256: existing.pdfSha256 }, pdfSha256: sha256Hex(input.pdfBytes) });
      } catch (error) {
        report.errors.push({ jobId, number: input.number, reason: error.message });
      }
      continue;
    }
    try {
      const event = candidate.email ? {
        event: "emailed",
        at: candidate.email.sentAt,
        data: {
          messageId: candidate.email.messageId,
          threadId: candidate.email.threadId,
          issuanceId: candidate.email.issuanceId,
          to: Array.isArray(candidate.email.to) ? candidate.email.to : [candidate.email.to].filter(Boolean),
          subject: candidate.email.subject,
          backfilled: true,
        },
        idempotencyKey: candidate.email.messageId ? `emailed:${candidate.email.messageId}` : `emailed:ledger:${candidate.email.issuanceId}`,
      } : null;
      let result;
      try {
        result = await service.recordIssuedDocument({ ...input, events: event ? [event] : [] });
      } catch (error) {
        if (!(error instanceof IssuedDocumentConflictError)) throw error;
        if (candidate.origin === "ledger" && event) {
          // A resend under an already-issued number: keep the bytes with the email.
          await service.recordRedelivery({ issuedDocumentUid: error.existing.uid, pdfBytes: input.pdfBytes, event });
          report.emailedEvents += 1;
          continue;
        }
        report.conflicts.push({ jobId, documentType: input.documentType, number: input.number, source: input.source, existing: { uid: error.existing.uid, source: error.existing.source, pdfSha256: error.existing.pdfSha256 }, pdfSha256: sha256Hex(input.pdfBytes) });
        continue;
      }
      if (result.created) bump(report.recorded, `${input.documentType}/${input.source}`);
      else report.alreadyRecorded += 1;
      if (event && result.events.at(-1)?.created) report.emailedEvents += 1;
    } catch (error) {
      report.errors.push({ jobId, number: input.number, reason: error.message });
    }
  }
  return report;
}

/** Backfill every job under `dataDir`. Returns the report. */
export async function backfillIssuedDocuments({ dataDir, service, dryRun = false, onJob = null }) {
  const report = { dryRun, ...emptyReport() };
  for (const jobDir of await listJobDirs(dataDir)) {
    await backfillJob({ jobDir, service, dryRun, report });
    onJob?.(jobDir, report);
  }
  return report;
}
