import { existsSync } from "./storage/fs.js";
import { readFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { parseQuoteVersion, readMilestoneInvoiceRevisionArtifact, readQuoteArtifacts } from "./quote-artifacts.js";
import { findMilestoneInvoiceRevision, prepareRequestedJobDocument, resolveJobDocumentType } from "./job-documents.js";
import { resolveCustomerDeliveryQuoteVersion, resolveDefaultSelectedQuoteVersion } from "./quote-edit-policy.js";
import { readQuoteLifecycle } from "./quote-lifecycle.js";
import { hydrateJobMeta } from "./job-meta-store.js";
import { artifactIsGenuinelyIssued } from "./invoice-artifact-state.js";
import { isIssuedQuoteVersion } from "./quote-pricing-attestation.js";
import { findIssuedQuoteVersion, readIssuedQuoteArtifact, readQuoteIssuanceLedger } from "./quote-issuance.js";
import { resolveActiveJobGeneration } from "./job-generation.js";
import { generateEvidenceQuoteMarkdown } from "./generate-evidence-quote.js";
import { readLegacySentQuotePdf } from "./legacy-sent-quote.js";

function createDocumentError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function readDocumentQuoteArtifacts({
  jobDir,
  meta,
  documentType = null,
  requestedVersion = null,
  // "view" (default): resolve to what the customer last saw — the locked
  // customer-seen revision — for operator read/edit surfaces. "delivery":
  // resolve to the latest revision — what the customer is being given right
  // now — for the send/PDF-attachment path (DEL-30 defect B). Only affects
  // documentType "quote"; invoice/receipt always pin to the customer-seen
  // quote basis regardless of intent (requestedVersion is forced null for
  // them below), matching existing behaviour.
  intent = "view",
} = {}) {
  const hydratedMeta = await hydrateJobMeta(jobDir, meta);
  const currentQuoteArtifacts = await readQuoteArtifacts(jobDir);
  if (!currentQuoteArtifacts?.quote) {
    throw createDocumentError("quote not generated", 404);
  }

  const quoteLifecycle = await readQuoteLifecycle(jobDir);
  const latestVersion = Number(
    currentQuoteArtifacts?.quote?.version
    || hydratedMeta?.quoteVersion
    || quoteLifecycle?.currentQuoteVersion
    || 1
  );
  const resolvedDocumentType = resolveJobDocumentType({
    meta: hydratedMeta,
    documentType,
  });
  const wantsLatest = (
    resolvedDocumentType === "quote"
    && typeof requestedVersion === "string"
    && requestedVersion.trim().toLowerCase() === "latest"
  );
  const explicitQuoteVersion = (
    resolvedDocumentType === "quote"
    && parseQuoteVersion(requestedVersion)
  );
  const resolveSelectedVersion = (
    intent === "delivery" && resolvedDocumentType === "quote"
  ) ? resolveCustomerDeliveryQuoteVersion : resolveDefaultSelectedQuoteVersion;
  const selectedVersion = wantsLatest
    ? latestVersion
    : resolveSelectedVersion({
        requestedVersion:
          resolvedDocumentType !== "quote"
            ? null
            : parseQuoteVersion(requestedVersion),
        meta: hydratedMeta,
        quoteLifecycle,
        latestVersion,
      });
  const selectedQuoteArtifacts = (
    selectedVersion
    && selectedVersion !== currentQuoteArtifacts?.version
  )
    ? await readQuoteArtifacts(jobDir, selectedVersion)
    : currentQuoteArtifacts;

  if (!selectedQuoteArtifacts?.quote) {
    if (!explicitQuoteVersion && selectedVersion !== latestVersion) {
      return {
        meta: hydratedMeta,
        quoteLifecycle,
        currentQuoteArtifacts,
        selectedQuoteArtifacts: currentQuoteArtifacts,
        latestVersion,
        selectedVersion: currentQuoteArtifacts?.version || latestVersion,
        resolvedDocumentType,
      };
    }
    throw createDocumentError("quote version not found", 404);
  }

  return {
    meta: hydratedMeta,
    quoteLifecycle,
    currentQuoteArtifacts,
    selectedQuoteArtifacts,
    latestVersion,
    selectedVersion: selectedQuoteArtifacts?.version || selectedVersion || latestVersion,
    resolvedDocumentType,
  };
}

export async function readPreparedJobDocument({
  jobDir,
  meta,
  documentType = null,
  requestedVersion = null,
  milestoneIndex = null,
  quote = null,
  intent = "view",
} = {}) {
  const resolved = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType,
    requestedVersion,
    intent,
  });
  const prepared = prepareRequestedJobDocument({
    meta: resolved.meta,
    quote: quote || resolved.selectedQuoteArtifacts?.quote || resolved.currentQuoteArtifacts?.quote || null,
    documentType: resolved.resolvedDocumentType,
    milestoneIndex,
  });

  return {
    ...resolved,
    preparedMeta: prepared.meta,
    preparedQuote: prepared.quote,
    preparedDocumentType: prepared.documentType,
    preparedMilestoneInvoice: prepared.milestoneInvoice,
  };
}

/**
 * Resolve the report bytes using the same customer/document selection policy
 * as quote and PDF reads. A historical quote report is version-bound (or an
 * exact issuance artifact); it never falls back to the current root alias.
 */
export async function readSelectedReportMarkdown({
  jobDir,
  meta,
  documentType = "quote",
  requestedVersion = null,
  intent = "view",
} = {}) {
  if (String(documentType || "").trim().toLowerCase() !== "quote"
    && (meta?.outputMode || "report") !== "quote") {
    const activeDir = await resolveActiveJobGeneration(jobDir);
    const path = join(activeDir, "report.md");
    return {
      meta,
      resolvedDocumentType: "report",
      report: existsSync(path) ? await readFile(path, "utf8") : null,
      issuanceRecord: null,
      unavailable: false,
    };
  }
  const resolved = await readDocumentQuoteArtifacts({
    jobDir,
    meta,
    documentType,
    requestedVersion,
    intent,
  });
  const activeDir = await resolveActiveJobGeneration(jobDir);
  if (resolved.resolvedDocumentType !== "quote") {
    const path = join(activeDir, "report.md");
    return {
      ...resolved,
      report: existsSync(path) ? await readFile(path, "utf8") : null,
      issuanceRecord: null,
      unavailable: false,
    };
  }

  const selectedVersion = Number(resolved.selectedVersion || 0) || null;
  const issuanceRecord = findIssuedQuoteVersion(
    await readQuoteIssuanceLedger(jobDir),
    selectedVersion,
    "quote",
  );
  if (issuanceRecord) {
    const exact = await readIssuedQuoteArtifact(jobDir, issuanceRecord, "reportMarkdown");
    return {
      ...resolved,
      report: exact.available ? exact.bytes.toString("utf8") : null,
      issuanceRecord,
      unavailable: !exact.available,
      unavailableReason: exact.reason || null,
    };
  }

  const selectedReport = resolved.selectedQuoteArtifacts?.reportMarkdown;
  if (selectedReport != null) {
    return {
      ...resolved,
      report: selectedReport,
      issuanceRecord: null,
      unavailable: false,
    };
  }

  // Before report.md was versioned, quote.md was the exact customer-facing
  // report alias for quote jobs. It is still safe for historical selection
  // because it comes from the selected immutable version, never the root.
  const legacySelectedQuoteMarkdown = resolved.selectedQuoteArtifacts?.quoteMarkdown;
  if (legacySelectedQuoteMarkdown != null) {
    return {
      ...resolved,
      report: legacySelectedQuoteMarkdown,
      issuanceRecord: null,
      unavailable: false,
      legacyAlias: true,
    };
  }

  // Legacy snapshots may predate the report alias. Only the selected version
  // path is eligible here; current root bytes are never used for history.
  const selectedVersionDir = selectedVersion
    ? join(activeDir, "quote-versions", `v${String(selectedVersion).padStart(3, "0")}`)
    : activeDir;
  const reportPath = join(selectedVersionDir, "report.md");
  const report = existsSync(reportPath) ? await readFile(reportPath, "utf8") : null;
  const legacyIssued = isIssuedQuoteVersion({
    quote: resolved.selectedQuoteArtifacts?.quote || null,
    quoteLifecycle: resolved.quoteLifecycle,
    version: selectedVersion,
    meta: resolved.meta,
  });
  if (legacyIssued) {
    return {
      ...resolved,
      report: null,
      issuanceRecord: null,
      unavailable: true,
      unavailableReason: "legacy issued report bytes are unavailable",
    };
  }
  if (report == null && resolved.selectedQuoteArtifacts?.quote && !issuanceRecord) {
    // Pre-ledger snapshots stored only quote.json. Reconstruct the report
    // from that selected immutable version rather than ever reading the
    // mutable current root alias. A ledger-backed historical version without
    // exact bytes remains unavailable above.
    return {
      ...resolved,
      report: generateEvidenceQuoteMarkdown({
        meta: resolved.meta,
        quote: resolved.selectedQuoteArtifacts.quote,
      }),
      issuanceRecord: null,
      unavailable: false,
      legacyReconstructed: true,
    };
  }
  return {
    ...resolved,
    report,
    issuanceRecord: null,
    unavailable: report == null,
    unavailableReason: report == null ? "selected report bytes are unavailable" : null,
  };
}

// Shared resolver for "should this quote PDF route serve the issued copy
// instead of rendering?" (the primary quote-pdf route and the preview route).
// Only a quote request is answered from the quote's issued copy. An invoice or
// receipt on a job whose quote was sent is a different document: it is served
// by resolveIssuedMilestoneInvoiceArtifact or rendered, never refused because
// the quote it was built from was issued.
//
// Returns one of:
//   - { bytes, source }   — serve these bytes; source is "issuance-ledger"
//                           or the legacy copy's source (legacy-sent-quote.js).
//   - { gone: true }      — the quote version was issued but no exact copy
//                           can be found (caller should 410).
//   - { render: true }    — not an issued quote; caller renders as today.
export async function resolveIssuedQuotePdf({
  jobDir,
  documentType,
  issuanceRecord = null,
  issuedVersion = false,
  selectedVersion = null,
  storedPdfPath = null,
} = {}) {
  if (documentType !== "quote") return { render: true };
  if (issuanceRecord) {
    const issued = await readIssuedQuoteArtifact(jobDir, issuanceRecord, "quotePdf");
    return issued.available ? { bytes: issued.bytes, source: "issuance-ledger" } : { gone: true };
  }
  if (!issuedVersion) return { render: true };
  const legacy = await readLegacySentQuotePdf(jobDir, selectedVersion, storedPdfPath);
  return legacy.available ? { bytes: legacy.bytes, source: legacy.source } : { gone: true };
}

// Shared resolver for "should this invoice route serve stored bytes instead
// of rendering?" Every invoice download/preview path (the milestone PDF
// route, the primary quote-pdf route, and the preview route) must answer
// this the same way so a sent invoice never gets silently reinterpreted
// under its already-issued number.
//
// Given a prepared milestone invoice and an optional requested revision,
// returns one of:
//   - { storedArtifact, revision } — serve these bytes for this revision.
//   - { notFound: true }           — an explicitly requested revision does
//                                     not exist (caller should 404).
//   - { gone: true }               — the requested/resolved revision is
//                                     genuinely issued (superseded, or any
//                                     artifactState other than UNWRITTEN —
//                                     see invoice-artifact-state.js) but its
//                                     stored file is missing (caller should
//                                     410; DEL-30 P2-C / P1-C).
//   - { render: true }             — not an issued invoice document (draft,
//                                     legacy invoice with no issuedRevision,
//                                     receipt, quote); caller renders as today.
export async function resolveIssuedMilestoneInvoiceArtifact({
  jobDir,
  documentType,
  milestoneInvoice = null,
  requestedRevision = null,
} = {}) {
  if (documentType !== "invoice" || !milestoneInvoice) {
    return { render: true };
  }

  const hasRequestedRevision = requestedRevision != null && String(requestedRevision).trim() !== "";
  const revision = hasRequestedRevision
    ? findMilestoneInvoiceRevision(milestoneInvoice, requestedRevision)
    : (milestoneInvoice.issuedRevision || null);
  if (hasRequestedRevision && !revision) {
    return { notFound: true };
  }

  const storedArtifact = revision
    ? await readMilestoneInvoiceRevisionArtifact({ jobDir, revision })
    : null;
  if (storedArtifact) {
    return { storedArtifact, revision };
  }

  // A missing file for a revision that is genuinely issued must 410, never
  // fall through to a silent render of whatever quote this request happens
  // to resolve — that would serve a fabricated document under a number the
  // customer already holds (DEL-30 P2-C). `artifactIsGenuinelyIssued`
  // dispatches on the single owned `artifactState` (DEL-30 round-4
  // architecture correction) rather than this file recombining
  // `pdfIssuedAt` / `legacyOrigin` / `pdfUnrecoverable` its own way — the
  // exact duplication that made P1-1 and P2-2 possible in the first place.
  // `supersededAt` is checked independently: a superseded revision proves
  // it was once a real money document by having been retired at all (it
  // only enters history via retirement), even in the rare case its own
  // artifact was never actually written before it was retired.
  //
  // This is a read (GET) path: it must never write or reconstruct a file.
  // Recovery is the operator-triggered write path built for DEL-30 P2-B.
  const isGenuinelyIssued = Boolean(
    revision && (revision.supersededAt || artifactIsGenuinelyIssued(revision))
  );
  if (isGenuinelyIssued) {
    return { gone: true };
  }
  return { render: true };
}
