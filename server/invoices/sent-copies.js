// What a customer was sent for an issued invoice, from the records Field kept
// when it emailed it. The bytes Field sent are the source of truth for an
// issued invoice; the milestone record's amounts are derived from them.
//
// Precedence, strongest first:
//
//   1. issued-document-emailed   an issued_documents row for the invoice
//                                number with an `emailed` event: the bytes
//                                stored with the delivery, hash-checked by
//                                the document store
//   2. ledger-emailed            an issuance ledger record (quote-issuance.json)
//                                of an invoice delivery: the bytes staged for
//                                the email, checked against the hash the
//                                ledger recorded when it was sent. The PDF
//                                names the invoice it is
//   3. sent-email archive        sent-emails.jsonl: when an invoice was
//                                emailed, the attachment's file name and the
//                                quote version it was built against. Before
//                                the issuance ledger it kept no hash and no
//                                copy, so it can say which version was sent
//                                but cannot prove which bytes were
//   4. the stored revision PDF   milestone-invoices/<number>.pdf: what Field
//                                holds now. Before invoice revisions were
//                                frozen (2026-08-05) Field re-rendered it on
//                                later actions, so it is not proof of what
//                                was sent
//   5. the milestone record      milestone-invoices/state.json: derived. Before
//                                the freeze every milestone action
//                                re-allocated it from the quote version then
//                                current, issued invoices included
//
// Only 1 and 2 verify bytes as sent. Read-only: nothing here writes anywhere.
import { readSentEmailArchive } from "../sent-email-archive.js";
import { readIssuedQuoteArtifact, readQuoteIssuanceLedger } from "../quote-issuance.js";
import { listQuoteVersions, readQuoteArtifacts } from "../quote-artifacts.js";
import { getCustomerPresentationFinancials } from "../quote-presentation.js";
import { resolveActiveJobGeneration } from "../job-generation.js";
import { sha256Hex } from "../documents/blob-store.js";
import { fixed, toCents } from "../quotes/totals.js";
import { extractInvoicePdfFacts } from "./issued-totals.js";

export const VERIFIED_SENT_SOURCES = Object.freeze(["issued-document-emailed", "ledger-emailed"]);

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The number as a whole word in a file name or subject: M1 must not match inside M1-R2 or M10. */
export function namesInvoice(value, number) {
  if (!value || !number) return false;
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`).test(String(value));
}

/** True when two { subtotal, taxTotal, total } sets are equal to the cent. */
export function sameTotals(a, b) {
  if (!a || !b) return false;
  return ["subtotal", "taxTotal", "total"].every((field) => toCents(a[field]) === toCents(b[field]));
}

function copyFrom({ source, reference, bytes, sentAt, number = null }) {
  const facts = extractInvoicePdfFacts(bytes);
  return {
    source,
    reference,
    sha256: sha256Hex(bytes),
    sentAt: sentAt || null,
    number: number || facts?.number || null,
    totals: facts?.totals || null,
    contractValue: facts?.contractValue || null,
    // The bytes themselves, for adopting a missing legacy PDF; never reported.
    bytes,
  };
}

/**
 * Every verified sent copy of an invoice on one job, and every archived
 * invoice email. Returns { copiesFor(number), sendsFor(number), problems }:
 * copiesFor gives the hash-verified copies of that number, strongest source
 * first, one per distinct hash; sendsFor gives the archived emails that name
 * it ({ sentAt, quoteVersion, milestoneIndex, issuanceId, hashed }).
 */
export async function collectSentInvoiceCopies({ jobDir, jobId, issuedDocuments = null }) {
  const copies = [];
  const problems = [];

  if (issuedDocuments && jobId) {
    let listed = { documents: [] };
    try {
      listed = await issuedDocuments.listJobDocuments(jobId);
    } catch (error) {
      problems.push({ source: "issued-document-emailed", reason: error.message });
    }
    for (const document of listed.documents || []) {
      if (document.documentType !== "invoice") continue;
      const emailed = (document.events || []).filter((event) => event.event === "emailed");
      if (!emailed.length) continue;
      try {
        const read = await issuedDocuments.readIssuedDocument(document.uid);
        if (read?.bytes) {
          copies.push(copyFrom({ source: "issued-document-emailed", reference: document.uid, bytes: read.bytes, sentAt: emailed[0].at, number: document.number }));
        }
      } catch (error) {
        problems.push({ source: "issued-document-emailed", reference: document.uid, number: document.number, reason: error.message });
      }
    }
  }

  const ledger = await readQuoteIssuanceLedger(jobDir).catch(() => ({ records: [] }));
  for (const record of ledger.records || []) {
    const documentType = record?.documentType || record?.delivery?.documentType || "quote";
    if (documentType !== "invoice" || !record.delivery) continue;
    const artifact = await readIssuedQuoteArtifact(jobDir, record, "quotePdf");
    if (!artifact.available) {
      problems.push({ source: "ledger-emailed", reference: record.issuanceId, reason: artifact.reason });
      continue;
    }
    copies.push(copyFrom({ source: "ledger-emailed", reference: record.issuanceId, bytes: artifact.bytes, sentAt: record.issuedAt }));
  }

  // The archive is appended to the job's root folder after a generation
  // commits; read both in case `jobDir` is a staged generation.
  const sends = [];
  const seenSends = new Set();
  for (const dir of [...new Set([jobDir, await resolveActiveJobGeneration(jobDir).catch(() => jobDir)])]) {
    for (const entry of await readSentEmailArchive(dir).catch(() => [])) {
      if (entry.documentType !== "invoice" && entry.kind !== "invoice.sent") continue;
      const key = entry.id || `${entry.ts}:${entry.messageId}`;
      if (seenSends.has(key)) continue;
      seenSends.add(key);
      sends.push({
        sentAt: entry.ts || null,
        quoteVersion: Number(entry.quoteVersion) > 0 ? Number(entry.quoteVersion) : null,
        milestoneIndex: Number.isInteger(entry.milestoneIndex) ? entry.milestoneIndex : null,
        issuanceId: text(entry.issuedDocumentId),
        names: [...(entry.attachments || []).map((attachment) => attachment?.filename), entry.subject].filter(Boolean),
      });
    }
  }
  const hashedIssuances = new Set(copies.filter((copy) => copy.source === "ledger-emailed").map((copy) => copy.reference));

  return {
    problems,
    copiesFor(number) {
      const seen = new Set();
      return copies
        .filter((copy) => copy.number === number)
        .sort((a, b) => VERIFIED_SENT_SOURCES.indexOf(a.source) - VERIFIED_SENT_SOURCES.indexOf(b.source))
        .filter((copy) => (seen.has(copy.sha256) ? false : seen.add(copy.sha256)));
    },
    sendsFor(number) {
      return sends
        .filter((send) => send.names.some((name) => namesInvoice(name, number)))
        .map(({ names: _names, ...send }) => ({ ...send, hashed: Boolean(send.issuanceId && hashedIssuances.has(send.issuanceId)) }))
        .sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
    },
  };
}

/**
 * What the verified sent copies of one invoice say: { totals, copy } when
 * every copy that can be read claims the same amounts, { conflict: copies }
 * when they differ, or null when there is none.
 */
export function agreedSentTotals(copies) {
  const readable = copies.filter((copy) => copy.totals);
  if (!readable.length) return null;
  if (readable.some((copy) => !sameTotals(copy.totals, readable[0].totals))) return { conflict: readable };
  return { totals: readable[0].totals, copy: readable[0] };
}

/**
 * Each quote version's customer total (inc GST) on a job, as { version:
 * "1234.50" }. Its non-enumerable `printed` holds, per version, every total a
 * PDF drawn from that version may print as its contract value.
 */
export async function quoteVersionTotals(jobDir) {
  const out = {};
  const printed = {};
  for (const entry of await listQuoteVersions(jobDir).catch(() => [])) {
    const version = Number(entry.version);
    if (!Number.isInteger(version) || version < 1) continue;
    const artifacts = (await readQuoteArtifacts(jobDir, version).catch(() => null)) || null;
    let quote = artifacts?.quote || null;
    if (!quote) {
      const root = await readQuoteArtifacts(jobDir).catch(() => null);
      if (Number(root?.quote?.version) === version) quote = root.quote;
    }
    if (!quote) continue;
    const candidates = new Set();
    try {
      candidates.add(fixed(getCustomerPresentationFinancials(quote).total, 2));
    } catch {
      // A quote that cannot be priced for presentation says nothing here.
    }
    if (Number.isFinite(Number(quote?.totals?.total))) candidates.add(fixed(quote.totals.total, 2));
    if (!candidates.size) continue;
    out[version] = [...candidates][0];
    printed[version] = [...candidates];
  }
  Object.defineProperty(out, "printed", { value: printed, enumerable: false });
  return out;
}

/** The quote versions whose customer total equals a PDF's printed contract value. */
export function versionsWithTotal(versionTotals, contractValue) {
  if (contractValue == null) return [];
  const printed = versionTotals?.printed || {};
  return Object.entries(versionTotals || {})
    .filter(([version, total]) => (printed[version] || [total]).some((candidate) => toCents(candidate) === toCents(contractValue)))
    .map(([version]) => Number(version));
}
