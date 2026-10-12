// Issued documents by uid.
//
//   GET /api/documents/:uid/pdf   the exact bytes that were issued
//   GET /api/jobs/:id/documents   a job's issued documents and their events
//
// Both run in the signed-in caller's organisation (row-level security): a
// document of another organisation is indistinguishable from one that does
// not exist. The PDF route serves stored bytes only and never renders.
//
//   200  the document's bytes (application/pdf), ETag = its SHA-256
//   404  no such document in the caller's organisation (or a malformed uid)
//   410  the document exists but its bytes are missing or fail their hash
//        check; they are never re-rendered
//   503  this server has no database
//
// The older job routes (/api/jobs/:id/quote-pdf, /milestones/:index/pdf) are
// unchanged; they move to read from here in a follow-up.
import { createIssuedDocumentService } from "./issued-documents.js";
import { isDocumentUid } from "./uid.js";

function unavailable(res, error) {
  return res.status(503).json({ error: "issued documents need the database, which this server does not have", code: "ISSUED_DOCUMENTS_UNAVAILABLE", detail: error?.message || null });
}

function pdfFileName(document) {
  const slug = String(document.number || document.uid).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || document.uid;
  return `${slug}.pdf`;
}

function emailedSummary(events) {
  return events
    .filter((event) => event.event === "emailed" || event.event === "email_failed")
    .map((event) => ({
      uid: event.uid,
      event: event.event,
      at: event.at,
      by: event.by,
      messageId: event.data?.messageId || null,
      to: event.data?.to || [],
      ...(event.data?.bytesMatchIssued === false ? { pdfSha256: event.data.pdfSha256, bytesMatchIssued: false } : {}),
      ...(event.event === "email_failed" ? { outcome: event.data?.outcome || null } : {}),
    }));
}

/**
 * `getDb()` is the server's database (throws when there is none);
 * `requestOrgUid(req)` the caller's organisation; `findJob(id)` the job store
 * lookup. `blobs` replaces the byte store (tests).
 */
export function registerIssuedDocumentRoutes(app, { requireAuth, getDb, requestOrgUid, findJob, blobs = undefined }) {
  function serviceFor(req) {
    return createIssuedDocumentService({ db: getDb(), orgUid: requestOrgUid(req), ...(blobs ? { blobs } : {}) });
  }

  app.get("/api/documents/:uid/pdf", requireAuth, async (req, res) => {
    const uid = String(req.params.uid || "");
    if (!isDocumentUid(uid)) return res.status(404).json({ error: "document not found" });
    let service;
    try {
      service = serviceFor(req);
    } catch (error) {
      if (error?.code === "FIELD_NO_DATABASE") return unavailable(res, error);
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
    try {
      const found = await service.readIssuedDocument(uid);
      if (!found) return res.status(404).json({ error: "document not found" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${pdfFileName(found.document)}"`);
      res.setHeader("ETag", `"${found.document.pdfSha256}"`);
      res.setHeader("X-Field-Document-Sha256", found.document.pdfSha256);
      return res.end(found.bytes);
    } catch (error) {
      if (error?.name === "DocumentBytesError") {
        return res.status(410).json({ error: "the issued bytes of this document are unavailable", code: error.code });
      }
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get("/api/jobs/:id/documents", requireAuth, async (req, res) => {
    const job = await findJob(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    let service;
    try {
      service = serviceFor(req);
    } catch (error) {
      if (error?.code === "FIELD_NO_DATABASE") return unavailable(res, error);
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
    try {
      const { documents, unattachedEvents } = await service.listJobDocuments(job.meta.id);
      res.json({
        ok: true,
        jobId: job.meta.id,
        documents: documents.map((document) => ({
          uid: document.uid,
          documentType: document.documentType,
          number: document.number,
          quoteVersion: document.quoteVersion,
          revision: document.revision,
          issuedAt: document.issuedAt,
          issuedBy: document.issuedBy,
          source: document.source,
          pdfSha256: document.pdfSha256,
          pdfUrl: `/api/documents/${document.uid}/pdf`,
          emailed: emailedSummary(document.events),
          events: document.events,
          details: document.details,
        })),
        unattachedEvents,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });
}
