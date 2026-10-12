// One job's milestone state, from its files into invoice rows (#27), with the
// checks that prove the rows equal what was issued and what Field shows:
//
//   snapshot    each issued invoice's subtotal, GST and total equal its
//               stored issued revision (the frozen money document)
//   issued      with `verifyIssued`, each issued invoice's totals equal the
//               totals printed on its PDF: the issued document's bytes, else
//               the revision's stored PDF (hash-checked). Read from the PDF's
//               own text (issued-totals.js), never re-rendered. Where they
//               disagree, what was emailed decides (#60, sent-copies.js):
//               a hash-verified sent copy gives the rows its amounts (a
//               warning), an owner's settlement is kept, and otherwise the
//               job is refused
//   payments    per milestone, the active payments add up to the amount paid
//               Field shows
//   reconcile   the milestones' current invoices add up to the total of the
//               quote Field invoices against
//
// A job that fails any check is reported with both numbers and nothing is
// written for it (the rows keep what they had). Used by the dual-write
// (recorder.js, after every committed milestone change) and the backfill
// (backfill.js). Nothing here writes to a job directory.
import { readDocumentQuoteArtifacts } from "../job-document-context.js";
import { readJobMeta } from "../job-meta-store.js";
import { getCustomerPresentationFinancials } from "../quote-presentation.js";
import { readJobFile } from "../documents/job-sources.js";
import { sha256Hex } from "../documents/blob-store.js";
import { quoteTaxRatePercent } from "../quotes/from-artifact.js";
import { centsToText, fixed, toCents } from "../quotes/totals.js";
import { claimMoney, mapMilestoneState } from "./from-milestones.js";
import { extractInvoicePdfFacts } from "./issued-totals.js";
import { agreedSentTotals, collectSentInvoiceCopies, quoteVersionTotals, sameTotals, versionsWithTotal } from "./sent-copies.js";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compare(rows, against) {
  const differences = [];
  for (const field of ["subtotal", "taxTotal", "total"]) {
    if (toCents(rows[field]) !== toCents(against[field])) differences.push({ field, rows: fixed(rows[field], 2), shown: fixed(against[field], 2) });
  }
  return differences;
}

/**
 * What the job's files say about its invoices: { jobId, meta, basis, mapped }.
 * `basis` is the quote Field invoices against ({ version, number, total,
 * taxRate }), or null when the job has no quote.
 */
export async function collectJobInvoices(jobDir) {
  const meta = await readJobMeta(jobDir);
  const jobId = text(meta?.id ? String(meta.id) : null);
  if (!jobId) return { jobId: null, meta, basis: null, mapped: null };
  let basis = null;
  if ((meta?.milestoneInvoices || []).length) {
    try {
      const document = await readDocumentQuoteArtifacts({ jobDir, meta, documentType: "invoice" });
      const quote = document.selectedQuoteArtifacts?.quote || null;
      if (quote) {
        basis = {
          version: Number(document.selectedVersion) || Number(quote.version) || null,
          number: text(quote.quoteNumber) || text(meta?.quoteNumber),
          jobNumber: text(quote.jobNumber),
          total: fixed(getCustomerPresentationFinancials(quote).total, 2),
          taxRate: quoteTaxRatePercent(quote),
        };
      }
    } catch {
      basis = null;
    }
  }
  const mapped = mapMilestoneState({ meta, basis, jobNumber: basis?.jobNumber || text(meta?.jobNumber) });
  return { jobId, meta, basis, mapped };
}

/** Copies of an issued invoice's PDF: the issued document's bytes, and the revision's stored file. */
async function issuedCopies({ jobDir, invoice, document, issuedDocuments }) {
  const copies = [];
  const seen = new Set();
  const add = (source, bytes, reference) => {
    const sha256 = sha256Hex(bytes);
    if (seen.has(sha256)) return;
    seen.add(sha256);
    const facts = extractInvoicePdfFacts(bytes);
    copies.push({ source, reference, sha256, totals: facts?.totals || null, contractValue: facts?.contractValue || null });
  };
  if (document && issuedDocuments) {
    try {
      const read = await issuedDocuments.readIssuedDocument(document.uid);
      if (read?.bytes) add("issued-document", read.bytes, document.uid);
    } catch (error) {
      copies.push({ source: "issued-document", reference: document.uid, totals: null, unreadable: error.message });
    }
  }
  if (invoice.pdfPath) {
    const file = await readJobFile(jobDir, invoice.pdfPath, { expectedSha256: invoice.pdfSha256 });
    if (file.ok) add("revision-pdf", file.bytes, invoice.pdfPath);
    else copies.push({ source: "revision-pdf", reference: invoice.pdfPath, totals: null, unreadable: file.reason });
  }
  return copies;
}

function versionLabel(versions) {
  return versions.length ? ` (quote v${versions.join(" or v")})` : "";
}

/**
 * An issued invoice whose rows disagree with one of its PDFs. What the
 * customer was sent decides (sent-copies.js):
 *
 *   - an owner already settled it: a copy the owner saw when deciding is
 *     expected to differ (a warning); any other is a failure.
 *   - hash-verified sent copies that agree: the rows take the amounts sent,
 *     marked printed with the version mismatch as the reason (a warning), and
 *     a stored PDF that differs from them is reported as not the copy sent.
 *   - otherwise the job is refused with both numbers, and the entry carries
 *     the archived emails of the invoice for the owner to settle it.
 */
async function resolveAgainstSent({ jobDir, invoice, entry, readable, differing, result, evidence }) {
  const failAll = () => {
    for (const copy of differing) {
      for (const difference of compare(entry.rows, copy.totals)) {
        result.failures.push({ kind: "totals", against: copy.source, reference: copy.reference, number: invoice.number, ...difference });
      }
    }
  };

  if (invoice.settlement) {
    const seen = new Set([invoice.settlement.storedPdfSha256, invoice.settlement.sentSha256].filter(Boolean));
    const unexpected = differing.filter((copy) => !seen.has(copy.sha256));
    for (const copy of differing.filter((candidate) => seen.has(candidate.sha256))) {
      result.warnings.push({ kind: "settled-copy-differs", number: invoice.number, against: copy.source, rows: entry.rows.total, shown: copy.totals.total, reason: `the owner settled ${invoice.number} at ${entry.rows.total}; this copy prints ${copy.totals.total} and was not what was sent` });
    }
    if (unexpected.length) {
      for (const copy of unexpected) {
        for (const difference of compare(entry.rows, copy.totals)) {
          result.failures.push({ kind: "totals", against: copy.source, reference: copy.reference, number: invoice.number, ...difference });
        }
      }
    }
    return;
  }

  const collected = await evidence.copies();
  const sent = agreedSentTotals(collected.copiesFor(invoice.number));
  entry.sends = collected.sendsFor(invoice.number).map(({ sentAt, quoteVersion, hashed }) => ({ sentAt, quoteVersion, hashed }));
  if (!sent) {
    failAll();
    return;
  }
  if (sent.conflict) {
    result.failures.push({ kind: "sent-copies-differ", number: invoice.number, reason: `the emailed copies of ${invoice.number} claim different amounts: ${sent.conflict.map((copy) => copy.totals.total).join(", ")}` });
    failAll();
    return;
  }

  const totals = await evidence.versionTotals();
  if (!sameTotals(entry.rows, sent.totals)) {
    const line = invoice.lines[0];
    const recorded = { ...entry.rows };
    const sentVersions = versionsWithTotal(totals, sent.copy.contractValue);
    const reason = `Amounts as sent: the PDF Field emailed (${sent.copy.source}, sha256 ${sent.copy.sha256.slice(0, 12)}) claims ${sent.totals.total}${versionLabel(sentVersions)}; `
      + `the milestone record holds ${recorded.total}${invoice.quoteVersion ? ` (quote v${invoice.quoteVersion}${invoice.quoteVersionInferred ? ", inferred" : ""})` : ""}, `
      + "taken from a different quote version than the invoice sent.";
    const money = claimMoney({ subtotal: sent.totals.subtotal, gst: sent.totals.taxTotal, total: sent.totals.total, taxRate: line.taxRate, milestoneKey: line.milestoneKey, name: line.name, description: line.description });
    if (money.failure) {
      result.failures.push({ ...money.failure, kind: "sent-copy", number: invoice.number });
      return;
    }
    Object.assign(invoice, {
      lines: money.lines,
      ...money.totals,
      computedTaxTotal: money.computedTaxTotal,
      taxTotalSource: "printed",
      taxTotalReason: reason,
    });
    entry.rows = { subtotal: money.totals.subtotal, taxTotal: money.totals.taxTotal, total: money.totals.total };
    entry.taxTotalSource = "printed";
    entry.rowsFrom = sent.copy.source;
    result.warnings.push({ kind: "rows-from-sent-copy", number: invoice.number, rows: recorded.total, shown: sent.totals.total, reason });
  }
  for (const copy of readable.filter((candidate) => !sameTotals(candidate.totals, sent.totals))) {
    const versions = versionsWithTotal(totals, copy.contractValue);
    result.warnings.push({ kind: "stored-copy-not-sent", number: invoice.number, against: copy.source, rows: copy.totals.total, shown: sent.totals.total, reason: `${copy.source} prints ${copy.totals.total}${versionLabel(versions)}, not the ${sent.totals.total} Field emailed` });
  }
}

/**
 * Plan, check and (unless `dryRun`, or no `service`) write one job's invoice
 * rows.
 *
 *   service           the invoice row service (invoice-rows.js), or null to only check
 *   quoteRows         the quote row service, to link invoices to quote versions
 *   issuedDocuments   the issue service, to link and (with verifyIssued) read issued PDFs
 *   verifyIssued      check issued invoices against their PDFs
 *
 * Returns null for a directory that is not a job, else { jobId, ok,
 * failures, warnings, invoices, milestones, payments, receipts, action,
 * summary }.
 */
export async function syncJobInvoiceRows({
  jobDir,
  service = null,
  quoteRows = null,
  issuedDocuments = null,
  verifyIssued = false,
  dryRun = false,
  actor = null,
}) {
  const { jobId, basis, mapped } = await collectJobInvoices(jobDir);
  if (!jobId) return null;
  const result = {
    jobId,
    ok: true,
    failures: [...mapped.failures],
    warnings: [...mapped.warnings],
    milestones: mapped.milestones.length,
    invoices: [],
    payments: mapped.payments.length,
    receipts: mapped.receipts.length,
    quoteTotal: basis?.total ?? null,
    action: null,
    summary: null,
  };
  if (!mapped.milestones.length && !mapped.failures.length) {
    // No milestone state: nothing to write, unless rows were written before.
    if (!service || !(await service.hasRows(jobId))) {
      result.action = "none";
      return result;
    }
  }

  // Links: quote versions and issued documents.
  const quoteUidByVersion = new Map();
  if (quoteRows) {
    for (const row of await quoteRows.listJobQuotes(jobId)) quoteUidByVersion.set(row.version, row.uid);
  }
  for (const milestone of mapped.milestones) milestone.quoteUid = quoteUidByVersion.get(milestone.quoteVersion) || null;
  const findDocument = async (documentType, number) => {
    if (!issuedDocuments || !number) return null;
    const document = await issuedDocuments.findIssuedDocument({ documentType, number });
    return document && document.jobId === jobId ? document : null;
  };

  // What the customer was sent, read only when an issued invoice disagrees
  // with one of its PDFs (sent-copies.js).
  let sentCopies = null;
  let versionTotals = null;
  const sentEvidence = {
    copies: async () => (sentCopies ??= await collectSentInvoiceCopies({ jobDir, jobId, issuedDocuments })),
    versionTotals: async () => (versionTotals ??= await quoteVersionTotals(jobDir)),
  };

  for (const invoice of mapped.invoices) {
    invoice.quoteUid = quoteUidByVersion.get(invoice.quoteVersion) || null;
    const document = invoice.status !== "draft" ? await findDocument("invoice", invoice.number) : null;
    invoice.issuedDocumentUid = document?.uid || null;
    const entry = {
      number: invoice.number,
      milestone: Number(invoice.milestoneKey),
      status: invoice.status,
      rows: { subtotal: invoice.subtotal, taxTotal: invoice.taxTotal, total: invoice.total },
      taxTotalSource: invoice.taxTotalSource,
      snapshot: invoice.snapshot,
      issuedDocumentUid: invoice.issuedDocumentUid,
      issued: [],
    };
    result.invoices.push(entry);
    if (invoice.taxTotalSource === "printed") {
      result.warnings.push({ kind: "tax-total-printed", number: invoice.number, reason: invoice.taxTotalReason });
    }
    if (invoice.status === "draft") continue;
    for (const difference of compare(entry.rows, invoice.snapshot)) {
      result.failures.push({ kind: "totals", against: "snapshot", number: invoice.number, ...difference });
    }
    if (!verifyIssued) continue;
    const copies = await issuedCopies({ jobDir, invoice, document, issuedDocuments });
    entry.issued = copies.map((copy) => ({ source: copy.source, reference: copy.reference, totals: copy.totals, unreadable: copy.unreadable || null }));
    const readable = copies.filter((copy) => copy.totals);
    if (!readable.length) {
      result.warnings.push({
        kind: "issued-unverified",
        number: invoice.number,
        reason: copies.length
          ? `the issued PDFs could not be read (${copies.map((copy) => `${copy.source}: ${copy.unreadable || "no claim box found"}`).join("; ")})`
          : "issued, but no copy of its PDF was found",
      });
    }
    const differing = readable.filter((copy) => compare(entry.rows, copy.totals).length);
    if (!differing.length) continue;
    await resolveAgainstSent({ jobDir, invoice, entry, readable, differing, result, evidence: sentEvidence });
  }
  for (const receipt of mapped.receipts) {
    receipt.issuedDocumentUid = (await findDocument("receipt", receipt.number))?.uid || null;
  }

  // Payments add up, per milestone.
  for (const milestone of mapped.milestones) {
    const shown = milestone.shown;
    if (toCents(shown.activePayments) !== toCents(shown.amountPaid)) {
      result.failures.push({ kind: "payments", milestone: milestone.sortOrder, field: "amountPaid", rows: shown.activePayments, shown: shown.amountPaid, reason: "the active payments do not add up to the amount paid Field shows" });
    }
  }

  // The current invoices add up to the quote. Issued invoices that claim
  // more than the quote are a failure. Otherwise a difference means the
  // drafts were built against an earlier quote: Field rebuilds them on the
  // next milestone action, and the rows mirror the files meanwhile.
  if (mapped.milestones.length) {
    const current = mapped.invoices.filter((invoice) => mapped.milestones.some((milestone) => milestone.shown.currentNumber === invoice.number));
    const claimed = mapped.milestones.reduce((sum, milestone) => sum + toCents(milestone.shown.currentTotal ?? milestone.shown.total), 0n);
    const issued = current.filter((invoice) => invoice.status !== "draft" && invoice.status !== "void").reduce((sum, invoice) => sum + toCents(invoice.total), 0n);
    if (!basis) {
      result.warnings.push({ kind: "reconcile-unchecked", reason: "the job's quote could not be read, so its invoices were not reconciled with it" });
    } else if (issued > toCents(basis.total)) {
      result.failures.push({ kind: "reconcile", field: "total", rows: centsToText(issued), shown: basis.total, reason: `the issued invoices claim ${centsToText(issued)}, more than the quote (v${basis.version}) total of ${basis.total}` });
    } else if (claimed !== toCents(basis.total)) {
      result.warnings.push({ kind: "reconcile-stale", field: "total", rows: centsToText(claimed), shown: basis.total, reason: `the milestones' invoices add up to ${centsToText(claimed)}, the quote (v${basis.version}) to ${basis.total}: the drafts were built against an earlier quote, and Field rebuilds them on the next milestone action` });
    }
  }

  result.ok = result.failures.length === 0;
  if (!service) return result;
  if (!result.ok) {
    result.action = "refused";
    return result;
  }
  const summary = await service.writeJob({ jobId, mapped, actor, dryRun });
  result.summary = summary;
  if (summary.conflicts.length) {
    result.ok = false;
    for (const conflict of summary.conflicts) result.failures.push({ ...conflict, kind: "conflict", conflict: conflict.kind });
  }
  const wrote = ["milestones", "invoices", "creditNotes", "payments", "allocations", "receipts"].some((table) => Object.entries(summary[table] || {})
    .some(([action, count]) => action !== "unchanged" && action !== "kept" && count > 0));
  result.action = wrote ? (dryRun ? "would-write" : "written") : "unchanged";
  return result;
}
