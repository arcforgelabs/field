// Deleting a job is permanent: its folder is removed and its Drive folder is
// trashed. Only a job nobody has put anything into may be deleted. Anything a
// customer was sent, or anything someone entered, keeps the job, which is
// archived (or marked Lost) instead.
//
// A freshly created job already has a title, site address and contact from the
// New Job form, plus the automatic "System rebuild summary" note. None of that
// counts as data: a new job left untouched can still be deleted.
import { join } from "node:path";
import { inferClarificationNoteSource } from "./clarification-notes.js";
import { getLedger } from "./ingestion-ledger.js";
import { isMilestoneInvoiceIssued } from "./job-documents.js";
import { resolveActiveJobGeneration } from "./job-generation.js";
import { readJobState } from "./job-state.js";
import { readMoasureSummary } from "./moasure.js";
import { normalizePipelineStage } from "./pipeline.js";
import { listQuoteVersions, readQuoteArtifacts } from "./quote-artifacts.js";
import { findIssuedQuoteVersion, readQuoteIssuanceLedger } from "./quote-issuance.js";
import { readQuoteLifecycle } from "./quote-lifecycle.js";
import { isIssuedQuoteVersion } from "./quote-pricing-attestation.js";
import { readSentEmailArchive } from "./sent-email-archive.js";
import { existsSync } from "./storage/fs.js";
import { readFile } from "./storage/fs-promises.js";

export const JOB_NOT_DELETABLE_ERROR = "This job can't be deleted because it has been sent or has work in it. Archive it instead, or mark it Lost.";

const STAGE_LABELS = { sent: "Sent", landed: "Landed", lost: "Lost" };

async function readCurrentQuoteInputs(jobDir) {
  const path = join(await resolveActiveJobGeneration(jobDir), "quote-inputs.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

const defaultReaders = {
  readQuoteArtifacts: (jobDir) => readQuoteArtifacts(jobDir),
  readQuoteInputs: (jobDir) => readCurrentQuoteInputs(jobDir),
  readQuoteLifecycle: (jobDir) => readQuoteLifecycle(jobDir),
  readQuoteIssuanceLedger: (jobDir) => readQuoteIssuanceLedger(jobDir),
  listQuoteVersions: (jobDir) => listQuoteVersions(jobDir),
  readSentEmailArchive: (jobDir) => readSentEmailArchive(jobDir),
  readIngestionLedger: (jobDir) => getLedger({ jobDir, create: false }),
  readMoasureSummary: (jobDir) => readMoasureSummary(jobDir),
  readJobState: (jobDir) => readJobState(jobDir),
  resolveActiveJobGeneration: (jobDir) => resolveActiveJobGeneration(jobDir),
  // Supplied by the caller: notes live in field.db and scheduled emails in the
  // data root, neither of which this module owns.
  getNotes: async () => [],
  listScheduledEmails: async () => [],
};

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}


class Blockers {
  constructor() {
    this.byCode = new Map();
  }

  add(code, reason) {
    if (!this.byCode.has(code)) this.byCode.set(code, reason);
  }

  has(code) {
    return this.byCode.has(code);
  }

  get size() {
    return this.byCode.size;
  }

  result() {
    return {
      deletable: this.byCode.size === 0,
      reasons: [...this.byCode.values()],
      codes: [...this.byCode.keys()],
    };
  }
}

// Reasons that can be read straight off the job's meta. They are checked first
// so the job list can stop at the first one without touching more files.
function assessMeta(meta, blockers) {
  const stage = normalizePipelineStage(meta.pipelineStage || meta.deliveryStatus || meta.quoteDeliveryStatus);
  if (stage !== "draft") blockers.add("pipeline_stage", `It is marked ${STAGE_LABELS[stage] || stage}, not Draft.`);
  if (meta.archivedAt || meta.archived === true) blockers.add("archived", "It is already archived.");
  if (meta.quoteSentAt || positiveNumber(meta.lastSentQuoteVersion)) blockers.add("quote_sent", "A quote was sent to the customer.");
  const milestoneInvoices = Array.isArray(meta.milestoneInvoices) ? meta.milestoneInvoices : [];
  const issuedInvoices = milestoneInvoices.filter((invoice) => isMilestoneInvoiceIssued(invoice)).length;
  if (issuedInvoices) {
    blockers.add("invoice_issued", `${plural(issuedInvoices, "invoice was", "invoices were")} issued.`);
  } else if (meta.invoiceSentAt) {
    blockers.add("invoice_issued", "An invoice was sent.");
  }
  const lineItemCount = positiveNumber(meta.quoteLineItemCount);
  if (lineItemCount) blockers.add("line_items", `The quote has ${plural(lineItemCount, "line item")}.`);
  const quoteVersion = positiveNumber(meta.quoteVersion);
  if (quoteVersion > 1) blockers.add("quote_versions", `The quote has ${plural(quoteVersion, "version")}.`);
  const audioFiles = Array.isArray(meta.audioFiles) ? meta.audioFiles.filter(Boolean).length : 0;
  if (audioFiles || meta.audioFile) blockers.add("recording", "It has a recording.");
  const moasureBatches = positiveNumber(meta.moasureBatchCount);
  if (moasureBatches) {
    blockers.add("moasure", `It has ${plural(moasureBatches, "Moasure measurement batch", "Moasure measurement batches")}.`);
  }
}

function isHumanNote(note) {
  return inferClarificationNoteSource(note) === "operator";
}

/**
 * Decide whether a job may be permanently deleted.
 *
 * @param {{ dir: string, meta: object }} job  the job as returned by findJob
 * @param {object} deps  readers; `getNotes(jobId)` and `listScheduledEmails(jobId)`
 *   come from the server, the rest default to the real file readers
 * @param {{ quick?: boolean }} options  quick stops as soon as one reason is
 *   found (the job list only needs a yes/no)
 * @returns {Promise<{ deletable: boolean, reasons: string[], codes: string[] }>}
 */
export async function assessJobDeletion(job, deps = {}, { quick = false } = {}) {
  const read = { ...defaultReaders, ...deps };
  const meta = job?.meta || {};
  const jobId = meta.id || null;
  const jobDir = job?.dir;
  const blockers = new Blockers();
  // A record that exists but cannot be read keeps the job: deletion fails closed.
  const safely = async (readRecord, fallback, label) => {
    try {
      return (await readRecord()) ?? fallback;
    } catch {
      blockers.add(`unreadable:${label}`, `Field could not read its ${label}, so it is kept to be safe.`);
      return fallback;
    }
  };

  assessMeta(meta, blockers);
  if (quick && blockers.size) return blockers.result();
  if (!jobDir) {
    blockers.add("missing_files", "Its files could not be found.");
    return blockers.result();
  }

  const [artifacts, quoteInputs, lifecycle, issuance, versions, sentEmails, scheduledEmails, notes] = await Promise.all([
    safely(() => read.readQuoteArtifacts(jobDir), null, "quote"),
    safely(() => read.readQuoteInputs(jobDir), null, "quote inputs"),
    safely(() => read.readQuoteLifecycle(jobDir), null, "quote history"),
    safely(() => read.readQuoteIssuanceLedger(jobDir), null, "sent quote record"),
    safely(() => read.listQuoteVersions(jobDir), [], "quote versions"),
    safely(() => read.readSentEmailArchive(jobDir), [], "sent emails"),
    safely(() => read.listScheduledEmails(jobId), [], "scheduled emails"),
    safely(() => read.getNotes(jobId), [], "notes"),
  ]);

  // 1. Never sent. Any delivery keeps the job, but a quote delivery and an
  // invoice or receipt delivery are reported as what they were.
  const quote = artifacts?.quote || null;
  const issuanceRecords = Array.isArray(issuance?.records) ? issuance.records : [];
  const recordDocumentType = (record) => String(record?.documentType || record?.delivery?.documentType || "quote").toLowerCase();
  const nonQuoteDeliveries = issuanceRecords.filter((record) => recordDocumentType(record) !== "quote");
  // issuedVersions lists the version of every delivery, whatever its type. A
  // listed version with no record is from a ledger that predates records, when
  // only quotes were recorded.
  const recordedVersions = new Set(issuanceRecords.map((record) => Number(record?.quoteVersion)));
  const issuedVersions = [
    ...(Array.isArray(issuance?.issuedVersions) ? issuance.issuedVersions : [])
      .filter((version) => !recordedVersions.has(Number(version))),
    ...issuanceRecords.filter((record) => recordDocumentType(record) === "quote").map((record) => record?.quoteVersion),
  ].map(Number).filter((version) => version > 0);
  const versionNumbers = new Set([
    ...(Array.isArray(versions) ? versions : []).map((entry) => Number(entry?.version)),
    Number(quote?.version || meta.quoteVersion || 1),
  ].filter((version) => version > 0));
  const anyVersionIssued = [...versionNumbers].some((version) => isIssuedQuoteVersion({
    quote: Number(quote?.version || 1) === version ? quote : null,
    quoteLifecycle: lifecycle,
    version,
    meta,
    issuanceRecord: findIssuedQuoteVersion(issuance, version, "quote"),
  }));
  if (
    anyVersionIssued
    || issuedVersions.length
    || quote?.quoteSentAt
    || positiveNumber(lifecycle?.lastSentQuoteVersion)
    || positiveNumber(lifecycle?.sendCount)
    || lifecycle?.lastSentAt
  ) {
    blockers.add("quote_sent", "A quote was sent to the customer.");
  }
  if (nonQuoteDeliveries.length) {
    blockers.add("invoice_issued", "An invoice or receipt was sent.");
  }
  if (!blockers.has("quote_sent") && positiveNumber(lifecycle?.markedSentQuoteVersion)) {
    // Moved to Sent by hand: no delivery is on record, but the customer may
    // have the quote.
    blockers.add("quote_sent", "The quote was marked as sent to the customer.");
  }
  const sentEmailCount = Array.isArray(sentEmails) ? sentEmails.length : 0;
  if (sentEmailCount) {
    blockers.add("emails_sent", `${plural(sentEmailCount, "email has", "emails have")} been sent from it.`);
  }
  const liveScheduled = (Array.isArray(scheduledEmails) ? scheduledEmails : [])
    .filter((email) => email && email.status !== "cancelled").length;
  if (liveScheduled) {
    blockers.add("scheduled_emails", `It has ${plural(liveScheduled, "scheduled or draft email")}.`);
  }

  // 2. Still a draft that has not been archived (stage comes from meta above).
  if (lifecycle?.archivedAt) blockers.add("archived", "It is already archived.");

  // 3. Nothing entered.
  const lineItems = Array.isArray(quote?.lineItems) ? quote.lineItems.length : 0;
  if (lineItems) blockers.add("line_items", `The quote has ${plural(lineItems, "line item")}.`);
  // Scope handed in through PUT /api/jobs/:id/quote-inputs (or an agent) is
  // entered data even when it has not priced into line items yet.
  const candidates = Array.isArray(quoteInputs?.lineItemCandidates) ? quoteInputs.lineItemCandidates.length : 0;
  const measurements = Array.isArray(quoteInputs?.measurements) ? quoteInputs.measurements.length : 0;
  if (candidates || measurements) {
    blockers.add("quote_inputs", `Quote inputs were entered (${[
      candidates ? plural(candidates, "line item candidate") : null,
      measurements ? plural(measurements, "measurement") : null,
    ].filter(Boolean).join(", ")}).`);
  }
  const highestVersion = Math.max(0, ...versionNumbers);
  if (versionNumbers.size > 1 || highestVersion > 1) {
    blockers.add("quote_versions", `The quote has ${plural(Math.max(versionNumbers.size, highestVersion), "version")}.`);
  }
  const humanNotes = (Array.isArray(notes) ? notes : []).filter(isHumanNote).length;
  if (quick && blockers.size) return blockers.result();

  const activeDir = await safely(() => read.resolveActiveJobGeneration(jobDir), jobDir, "files");
  const [ledger, moasure, baseState, activeState] = await Promise.all([
    safely(() => read.readIngestionLedger(jobDir), null, "uploaded files"),
    safely(() => read.readMoasureSummary(jobDir), null, "Moasure measurements"),
    safely(() => read.readJobState(jobDir), null, "activity"),
    activeDir !== jobDir ? safely(() => read.readJobState(activeDir), null, "activity") : null,
  ]);
  const files = Array.isArray(ledger?.files) ? ledger.files.length : 0;
  if (files) blockers.add("files", `It has ${plural(files, "uploaded file")}.`);
  const batches = positiveNumber(moasure?.batchCount)
    || (Array.isArray(moasure?.imports) ? moasure.imports.length : 0);
  if (batches) {
    blockers.add("moasure", `It has ${plural(batches, "Moasure measurement batch", "Moasure measurement batches")}.`);
  }
  if (baseState?.details?.archivedAt || activeState?.details?.archivedAt) blockers.add("archived", "It is already archived.");

  // Notes live in field.db; the activity log keeps a copy of each manual note
  // in case the database was unavailable when it was written.
  const manualActivityNotes = Math.max(0, ...[baseState, activeState].map((state) => (
    (Array.isArray(state?.activity) ? state.activity : [])
      .filter((entry) => entry?.kind === "note.manual" && isHumanNote({ author: entry?.actor?.label || entry?.actor?.kind }))
      .length
  )));
  const noteCount = Math.max(humanNotes, manualActivityNotes);
  if (noteCount) blockers.add("notes", `It has ${plural(noteCount, "note")} written by someone.`);

  return blockers.result();
}
