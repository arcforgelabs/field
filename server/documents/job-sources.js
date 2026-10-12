// What today's job files say was issued, in the shape the issue service takes.
// Read-only: nothing here writes to a job directory. Used by the live
// dual-write (server/documents/recorder.js) and the backfill
// (server/documents/backfill.js).
import { readFile } from "../storage/fs-promises.js";
import { resolve, sep } from "node:path";
import { resolveActiveJobGeneration } from "../job-generation.js";
import { buildInvoiceDocumentNumber, buildReceiptDocumentNumber } from "../job-documents.js";
import { resolveDocumentBusiness } from "../quote-artifacts.js";
import { getCustomerPresentationFinancials } from "../quote-presentation.js";
import { artifactIsStored } from "../invoice-artifact-state.js";
import { sha256Hex } from "./blob-store.js";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

/** The reference printed on a quote PDF, plus its version: "EQ-2501-01 v1". */
export function quoteDocumentNumber({ quote = null, meta = null, version }) {
  const ref = text(quote?.quoteNumber) || text(meta?.quoteNumber) || text(meta?.id);
  const v = Number(version);
  if (!ref || !Number.isInteger(v) || v < 1) return null;
  return `${ref} v${v}`;
}

/** The number printed on an invoice PDF (a milestone revision's own number, e.g. EI-2601-01-M1-R2). */
export function invoiceDocumentNumber({ meta = null, quote = null, milestoneInvoice = null, revision = null }) {
  return text(revision?.invoiceNumber)
    || text(milestoneInvoice?.issuedRevision?.invoiceNumber)
    || text(buildInvoiceDocumentNumber({ meta, quote, milestoneInvoice }));
}

/** The number printed on a receipt PDF (ER-2601-01-M1). */
export function receiptDocumentNumber({ meta = null, quote = null, milestoneInvoice = null }) {
  return text(buildReceiptDocumentNumber({ meta, quote, milestoneInvoice }));
}

/**
 * The customer and business as the document printed them. Only meaningful
 * when `meta` and `quote` are the ones the PDF was rendered from (the live
 * send path); the backfill does not have those and leaves parties out.
 */
export function partiesDetails({ meta = null, quote = null }) {
  const business = resolveDocumentBusiness(quote);
  return {
    customer: compact({
      name: text(meta?.contactName) || text(meta?.customerName) || text(meta?.title),
      email: text(meta?.contactEmail),
      phone: text(meta?.contactPhone),
      siteAddress: text(meta?.siteAddress),
    }),
    business: compact({
      tradingName: text(business?.tradingName),
      legalName: text(business?.legalName),
      abn: text(business?.abn),
      address: text(business?.address),
      email: text(business?.email),
      phone: text(business?.phone),
    }),
  };
}

/** A quote's customer-facing totals (never its cost). */
export function quoteMoneyDetails(quote) {
  try {
    const financials = getCustomerPresentationFinancials(quote);
    return {
      currency: text(quote?.currency) || text(quote?.quoteCatalog?.currency) || "AUD",
      subtotal: financials.subtotal,
      gst: financials.gst,
      total: financials.total,
    };
  } catch {
    return {};
  }
}

/** An invoice revision's frozen money and identity, as recorded when it was issued. */
export function invoiceRevisionDetails(milestone, revision) {
  return compact({
    milestoneIndex: numberOrNull(milestone?.milestoneIndex),
    milestoneLabel: text(milestone?.milestoneLabel) || text(milestone?.label),
    currency: text(revision?.currency) || "AUD",
    subtotal: numberOrNull(revision?.subtotal),
    gst: numberOrNull(revision?.gst),
    total: numberOrNull(revision?.total),
    lineItems: Array.isArray(revision?.lineItems) ? revision.lineItems : undefined,
    quoteVersionInferred: revision?.quoteVersionInferred ? true : undefined,
    revisedAt: text(revision?.revisedAt),
    revisedBy: text(revision?.revisedBy),
    revisionReason: text(revision?.revisionReason),
    supersedesInvoiceNumber: text(revision?.supersedesInvoiceNumber),
    pdfPath: text(revision?.pdfPath),
  });
}

/**
 * Every issued invoice revision on a job's milestones: the active one of each
 * milestone and, with `includeHistory`, the superseded ones. Only revisions
 * whose PDF was stored (artifact state STORED, with a hash) are listed;
 * the rest are reported by the caller as missing.
 */
export function issuedInvoiceRevisions(meta, { includeHistory = false } = {}) {
  const out = [];
  for (const milestone of meta?.milestoneInvoices || []) {
    if (milestone?.issuedRevision) out.push({ milestone, revision: milestone.issuedRevision, active: true });
    if (includeHistory) {
      for (const revision of milestone?.revisionHistory || []) {
        if (revision?.pdfPath && revision.pdfPath === milestone?.issuedRevision?.pdfPath
          && revision.revisionNumber === milestone.issuedRevision.revisionNumber) continue;
        out.push({ milestone, revision, active: false });
      }
    }
  }
  return out.map((entry) => ({ ...entry, stored: artifactIsStored(entry.revision) && Boolean(text(entry.revision?.pdfSha256)) }));
}

/**
 * Read a file the job's committed generation holds at `relativePath`, refusing
 * a path outside it. Returns { ok, bytes, sha256 } or { ok: false, reason }.
 */
export async function readJobFile(jobDir, relativePath, { expectedSha256 = null } = {}) {
  if (!text(relativePath)) return { ok: false, reason: "no path recorded" };
  const activeDir = resolve(await resolveActiveJobGeneration(jobDir));
  const path = resolve(activeDir, relativePath);
  if (!path.startsWith(`${activeDir}${sep}`)) return { ok: false, reason: "path is outside the job" };
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    return { ok: false, reason: "file is missing", path: relativePath };
  }
  const sha256 = sha256Hex(bytes);
  if (expectedSha256 && sha256 !== String(expectedSha256).toLowerCase()) {
    return { ok: false, reason: "hash does not match the recorded hash", mismatch: true, path: relativePath, sha256, expectedSha256 };
  }
  return { ok: true, bytes, sha256, path: relativePath };
}

/** The bytes of an issued invoice revision, checked against its recorded hash. */
export function readInvoiceRevisionPdf(jobDir, revision) {
  return readJobFile(jobDir, revision?.pdfPath, { expectedSha256: revision?.pdfSha256 });
}
