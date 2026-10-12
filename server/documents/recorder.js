// Dual-write from today's send path into the issued-document tables (#223).
//
// In this step the job files stay the source of truth. Everything here runs
// after today's code has done its own work, and never changes it: a failure
// is logged, counted and shown in GET /api/storage/status, and never thrown
// back to the caller. Without a database (plain local development with no
// FIELD_DB_URL, DATABASE_URL or PGlite) the recorder skips with a log line.
//
// The server installs one recorder for its deployment's organisation
// (installIssuedDocumentRecorder). Code that runs without one (unit tests that
// drive job-actions directly) records nothing.
//
//   recordDelivery(input)         a document that was just emailed: issue it
//                                 (or find it issued) and add an `emailed`
//                                 event with the Gmail message id
//   recordEmailFailure(input)     an `email_failed` event
//   recordInvoiceRevisions(dir)   every milestone's active issued invoice
//                                 revision, after the generation that issued
//                                 it commits
import { readJobMeta } from "../job-meta-store.js";
import { readQuoteArtifacts } from "../quote-artifacts.js";
import { IssuedDocumentConflictError } from "./issued-documents.js";
import {
  invoiceDocumentNumber,
  invoiceRevisionDetails,
  issuedInvoiceRevisions,
  partiesDetails,
  readInvoiceRevisionPdf,
} from "./job-sources.js";

const NOOP = Object.freeze({
  enabled: false,
  async recordDelivery() { return null; },
  async recordEmailFailure() { return null; },
  async recordInvoiceRevisions() { return null; },
  status() { return { enabled: false, reason: "not installed" }; },
});

let installed = null;

export function installIssuedDocumentRecorder(recorder) {
  installed = recorder || null;
  return installed;
}

export function issuedDocumentRecorder() {
  return installed || NOOP;
}

function actorLabel(user) {
  if (!user) return null;
  if (typeof user === "string") return user;
  return user.id || user.email || user.name || user.label || null;
}

function addresses(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function emailedEvent(email) {
  const messageId = email?.messageId || null;
  return {
    event: "emailed",
    at: email?.sentAt,
    by: actorLabel(email?.by),
    data: {
      messageId,
      threadId: email?.threadId || null,
      attemptId: email?.attemptId || null,
      issuanceId: email?.issuanceId || null,
      to: addresses(email?.to),
      cc: addresses(email?.cc),
      bcc: addresses(email?.bcc),
      subject: email?.subject || null,
    },
    idempotencyKey: messageId
      ? `emailed:${messageId}`
      : email?.attemptId ? `emailed:attempt:${email.attemptId}` : null,
  };
}

/**
 * The recorder for a server with a database. `service` is the issue service
 * (issued-documents.js) for the deployment's organisation.
 */
export function createIssuedDocumentRecorder({ service, logger = console }) {
  const state = {
    enabled: true,
    recorded: 0,
    unchanged: 0,
    emailed: 0,
    redelivered: 0,
    emailFailures: 0,
    failures: 0,
    lastError: null,
    lastRecordedAt: null,
  };

  function fail(what, error, context = {}) {
    state.failures += 1;
    state.lastError = {
      at: new Date().toISOString(),
      what,
      message: String(error?.message || error),
      code: error?.code || null,
      ...context,
    };
    logger.error(`[issued-documents] ${what} not recorded${context.jobId ? ` for job ${context.jobId}` : ""}${context.number ? ` (${context.number})` : ""}: ${error?.message || error}; the job files still hold it`);
    return null;
  }

  async function recordDelivery({
    jobId,
    documentType,
    number,
    quoteVersion = null,
    revision = null,
    pdfBytes,
    issuedAt,
    issuedBy = null,
    details = {},
    email = null,
  }) {
    try {
      const event = email ? emailedEvent({ sentAt: issuedAt, ...email }) : null;
      try {
        const result = await service.recordIssuedDocument({
          jobId,
          documentType,
          number,
          quoteVersion,
          revision,
          pdfBytes,
          issuedAt,
          issuedBy: actorLabel(issuedBy),
          createdBy: actorLabel(issuedBy),
          details,
          source: "live",
          events: event ? [event] : [],
        });
        if (result.created) state.recorded += 1;
        else state.unchanged += 1;
        if (event && result.events.at(-1)?.created) state.emailed += 1;
        state.lastRecordedAt = new Date().toISOString();
        return result;
      } catch (error) {
        if (!(error instanceof IssuedDocumentConflictError) || !event) throw error;
        // Delivered again under a number that was already issued, with bytes
        // rendered afresh (a resend). The issued document stays as it was; the
        // bytes the customer got this time are kept with the emailed event.
        const result = await service.recordRedelivery({
          issuedDocumentUid: error.existing.uid,
          pdfBytes,
          event,
        });
        state.redelivered += 1;
        if (result.created) state.emailed += 1;
        state.lastRecordedAt = new Date().toISOString();
        return { document: error.existing, created: false, redelivery: result };
      }
    } catch (error) {
      return fail(`${documentType} delivery`, error, { jobId, number });
    }
  }

  async function recordEmailFailure({ jobId, documentType, number = null, attemptId = null, outcome, error: sendError, at, by = null, to = [] }) {
    try {
      const existing = number ? await service.findIssuedDocument({ documentType, number }) : null;
      const result = await service.recordEvent({
        issuedDocumentUid: existing?.uid || null,
        jobId,
        documentType,
        event: "email_failed",
        at,
        by: actorLabel(by),
        data: { number, attemptId, outcome, error: String(sendError?.message || sendError || ""), to: addresses(to) },
        idempotencyKey: attemptId ? `email_failed:${attemptId}:${outcome}` : null,
      });
      state.emailFailures += 1;
      return result;
    } catch (error) {
      return fail(`${documentType} email failure`, error, { jobId, number });
    }
  }

  // After a generation that may have issued an invoice commits: record each
  // milestone's active issued revision, with the bytes its PDF was stored
  // with. An already-recorded revision is skipped before its bytes are sent.
  async function recordInvoiceRevisions(jobDir) {
    let jobId = null;
    try {
      const meta = await readJobMeta(jobDir);
      jobId = meta?.id || null;
      if (!jobId) return null;
      const quote = (await readQuoteArtifacts(jobDir).catch(() => null))?.quote || null;
      const results = [];
      for (const { milestone, revision, stored } of issuedInvoiceRevisions(meta)) {
        if (!stored) continue;
        const number = invoiceDocumentNumber({ meta, quote, milestoneInvoice: milestone, revision });
        const existing = await service.findIssuedDocument({ documentType: "invoice", number });
        if (existing && existing.pdfSha256 === revision.pdfSha256) continue;
        const pdf = await readInvoiceRevisionPdf(jobDir, revision);
        if (!pdf.ok) {
          fail("invoice revision", new Error(`its PDF ${pdf.reason}`), { jobId, number });
          continue;
        }
        results.push(await recordDelivery({
          jobId,
          documentType: "invoice",
          number,
          quoteVersion: revision.quoteVersion,
          revision: revision.revisionNumber,
          pdfBytes: pdf.bytes,
          issuedAt: revision.issuedAt || revision.pdfIssuedAt || new Date().toISOString(),
          issuedBy: revision.revisionNumber > 1 ? revision.revisedBy : null,
          details: { ...invoiceRevisionDetails(milestone, revision), ...partiesDetails({ meta, quote }) },
        }));
      }
      return results;
    } catch (error) {
      return fail("invoice revisions", error, { jobId });
    }
  }

  return {
    enabled: true,
    service,
    recordDelivery,
    recordEmailFailure,
    recordInvoiceRevisions,
    status() {
      return { ...state, lastError: state.lastError ? { ...state.lastError } : null };
    },
  };
}

/** A server with no database: every call is skipped, with one log line per kind. */
export function createUnavailableIssuedDocumentRecorder(reason, { logger = console } = {}) {
  const logged = new Set();
  const skipped = { delivery: 0, emailFailure: 0, invoiceRevisions: 0 };
  const skip = (kind) => {
    skipped[kind] += 1;
    if (logged.has(kind)) return null;
    logged.add(kind);
    logger.warn(`[issued-documents] ${reason}: issued ${kind === "invoiceRevisions" ? "invoice revisions" : kind === "emailFailure" ? "email failures" : "deliveries"} are not recorded in PostgreSQL (the job files still hold them)`);
    return null;
  };
  return {
    enabled: false,
    async recordDelivery() { return skip("delivery"); },
    async recordEmailFailure() { return skip("emailFailure"); },
    async recordInvoiceRevisions() { return skip("invoiceRevisions"); },
    status() { return { enabled: false, reason, skipped: { ...skipped } }; },
  };
}
