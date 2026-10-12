// Legacy invoices whose milestone record and PDFs disagree (#60): for each
// issued invoice on a job, the amounts each document Field holds says it was
// issued for, which of them is proof of what was sent, and the choices an
// owner has to settle it.
//
// Before invoice revisions were frozen (2026-08-05), every milestone action
// re-allocated every milestone's amounts, issued ones included, from the
// quote version that was then the invoice basis, and re-rendered the PDF of
// only the milestone the action targeted. So an issued milestone's record and
// its stored PDF could each come from a different quote version. The freeze
// adopted both as they stood. This module finds them; it never decides.
//
// Read-only. The report (`listInvoiceAmountDisagreements`) holds ids,
// numbers, versions, dates and amounts only: never a name, an address or a
// line label.
import { isMilestoneInvoiceIssued, isMilestonePaymentVoided } from "../job-documents.js";
import { readJobMeta } from "../job-meta-store.js";
import { listJobDirs } from "../documents/backfill.js";
import { readJobFile } from "../documents/job-sources.js";
import { fixed, toCents } from "../quotes/totals.js";
import { extractInvoicePdfFacts } from "./issued-totals.js";
import {
  agreedSentTotals,
  collectSentInvoiceCopies,
  quoteVersionTotals,
  sameTotals,
  versionsWithTotal,
} from "./sent-copies.js";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function money(value) {
  return fixed(Number.isFinite(Number(value)) ? Number(value) : 0, 2);
}

function totalsOf(record) {
  return { subtotal: money(record.subtotal), taxTotal: money(record.gst), total: money(record.total) };
}

/** Every issued invoice on a job: active and superseded revisions, and legacy records never frozen. */
function issuedInvoices(meta) {
  const out = [];
  for (const milestone of meta?.milestoneInvoices || []) {
    if (!milestone) continue;
    const active = milestone.issuedRevision || null;
    if (active) {
      out.push({ milestone, revision: active, current: true });
    } else if (isMilestoneInvoiceIssued(milestone) && text(milestone.invoiceNumber)) {
      // Issued before revisions were frozen and not touched since: the
      // record is what the next milestone action freezes.
      out.push({
        milestone,
        revision: {
          invoiceNumber: milestone.invoiceNumber,
          revisionNumber: milestone.revisionNumber || 1,
          subtotal: milestone.subtotal,
          gst: milestone.gst,
          total: milestone.total,
          pdfPath: milestone.pdfPath,
          pdfSha256: null,
          quoteVersion: null,
          quoteVersionInferred: true,
          issuedAt: milestone.issuedAt,
          notFrozen: true,
        },
        current: true,
      });
    }
    for (const revision of milestone.revisionHistory || []) {
      if (!revision?.invoiceNumber || revision.invoiceNumber === active?.invoiceNumber) continue;
      out.push({ milestone, revision, current: false });
    }
  }
  return out;
}

function paidAgainst(milestone, number, current) {
  return (milestone.payments || [])
    .filter((payment) => !isMilestonePaymentVoided(payment))
    .filter((payment) => (text(payment.sourceInvoiceNumber) ? payment.sourceInvoiceNumber === number : current))
    .reduce((sum, payment) => sum + toCents(money(payment.amount)), 0n);
}

/**
 * The amounts each document says one job's issued invoices were issued for.
 * `meta` is the hydrated job meta (read when omitted). Returns { jobId,
 * versionTotals, invoices: [entry] }; each entry:
 *
 *   number, milestoneIndex, revisionNumber, current, status, issuedAt
 *   quoteVersion, quoteVersionInferred     what the record says it came from
 *   recorded       { subtotal, taxTotal, total } the milestone record holds
 *   storedPdf      { sha256, totals, contractValue, versions } or { unreadable }
 *   sent           the hash-verified copy Field emailed, or null
 *   sends          archived emails of it: { sentAt, quoteVersion, hashed }
 *   paid           active payments recorded against it
 *   settlement     the owner's decision, once made
 *   options        the sets an owner may choose: { choose, subtotal, taxTotal, total }
 *   state          agrees | recorded-matches-sent | sent-differs-from-recorded
 *                  | needs-owner-decision | sent-copies-differ | settled
 */
export async function invoiceAmountEvidence({ jobDir, meta = null, issuedDocuments = null }) {
  const hydrated = meta || await readJobMeta(jobDir);
  const jobId = text(hydrated?.id ? String(hydrated.id) : null);
  const invoices = issuedInvoices(hydrated);
  if (!jobId || !invoices.length) return { jobId, versionTotals: {}, invoices: [] };
  const collected = await collectSentInvoiceCopies({ jobDir, jobId, issuedDocuments });
  const versionTotals = await quoteVersionTotals(jobDir);

  const out = [];
  for (const { milestone, revision, current } of invoices) {
    const number = revision.invoiceNumber;
    const recorded = totalsOf(revision);
    let storedPdf = null;
    if (text(revision.pdfPath)) {
      const file = await readJobFile(jobDir, revision.pdfPath, { expectedSha256: revision.pdfSha256 });
      if (file.ok) {
        const facts = extractInvoicePdfFacts(file.bytes);
        storedPdf = {
          sha256: file.sha256,
          totals: facts?.totals || null,
          contractValue: facts?.contractValue || null,
          versions: versionsWithTotal(versionTotals, facts?.contractValue),
        };
      } else {
        storedPdf = { unreadable: file.reason };
      }
    }
    const sentCopies = collected.copiesFor(number);
    const agreed = agreedSentTotals(sentCopies);
    const sent = agreed?.totals
      ? {
          source: agreed.copy.source,
          sha256: agreed.copy.sha256,
          sentAt: agreed.copy.sentAt,
          totals: agreed.totals,
          contractValue: agreed.copy.contractValue,
          versions: versionsWithTotal(versionTotals, agreed.copy.contractValue),
        }
      : null;
    const settlement = revision.amountsSettlement || null;
    const options = [{ choose: "milestone-record", ...recorded }];
    if (storedPdf?.totals) options.push({ choose: "stored-pdf", ...storedPdf.totals });
    if (sent) options.push({ choose: "sent-copy", ...sent.totals });
    const distinct = options.filter((option, index) => options.findIndex((other) => sameTotals(other, option)) === index);

    let state;
    if (settlement) state = "settled";
    else if (agreed?.conflict) state = "sent-copies-differ";
    else if (distinct.length <= 1) state = "agrees";
    else if (sent) state = sameTotals(recorded, sent.totals) ? "recorded-matches-sent" : "sent-differs-from-recorded";
    else state = "needs-owner-decision";

    out.push({
      number,
      milestoneIndex: milestone.milestoneIndex,
      revisionNumber: revision.revisionNumber || 1,
      current,
      status: current ? milestone.status : "superseded",
      issuedAt: revision.issuedAt || null,
      notFrozen: Boolean(revision.notFrozen),
      quoteVersion: revision.quoteVersion || null,
      quoteVersionInferred: Boolean(revision.quoteVersionInferred),
      recorded,
      storedPdf,
      sent,
      sends: collected.sendsFor(number).map(({ sentAt, quoteVersion, hashed }) => ({ sentAt, quoteVersion, hashed })),
      paid: fixed(Number(paidAgainst(milestone, number, current)) / 100, 2),
      settlement,
      options: state === "agrees" || state === "settled" ? [] : distinct,
      state,
    });
  }
  return { jobId, versionTotals, invoices: out };
}

/** One report entry: ids, numbers, versions, dates and amounts only. */
function publicEntry(jobId, entry, versionTotals) {
  return {
    jobId,
    invoiceNumber: entry.number,
    milestone: entry.milestoneIndex + 1,
    revision: entry.revisionNumber,
    status: entry.status,
    state: entry.state,
    issuedAt: entry.issuedAt,
    recorded: { ...entry.recorded, quoteVersion: entry.quoteVersion, quoteVersionInferred: entry.quoteVersionInferred, frozen: !entry.notFrozen },
    storedPdf: entry.storedPdf
      ? (entry.storedPdf.unreadable
        ? { unreadable: entry.storedPdf.unreadable }
        : { ...(entry.storedPdf.totals || { unreadable: "no claim box found" }), contractValue: entry.storedPdf.contractValue, drawnFromVersions: entry.storedPdf.versions, sha256: entry.storedPdf.sha256 })
      : null,
    sentCopy: entry.sent
      ? { ...entry.sent.totals, source: entry.sent.source, sentAt: entry.sent.sentAt, contractValue: entry.sent.contractValue, drawnFromVersions: entry.sent.versions, sha256: entry.sent.sha256 }
      : null,
    emails: entry.sends,
    quoteVersionTotals: versionTotals,
    paid: entry.paid,
    settlement: entry.settlement
      ? { source: entry.settlement.source, total: money(entry.settlement.total), recordedTotal: entry.settlement.recorded ? money(entry.settlement.recorded.total) : null, decidedAt: entry.settlement.decidedAt }
      : null,
    options: entry.options,
  };
}

/**
 * Every issued invoice, on every job under `dataDir`, whose milestone record
 * disagrees with its stored PDF or with the copy Field emailed, settled ones
 * included. Returns { summary, invoices }. `onJob` runs after each job (the
 * route's time limit stops between jobs).
 */
export async function listInvoiceAmountDisagreements({ dataDir, issuedDocuments = null, onJob = null }) {
  const summary = {
    jobs: 0,
    issuedInvoices: 0,
    disagreeing: 0,
    byState: {},
    settledBySentCopyAvailable: 0,
    emailedBeforeHashes: 0,
    errors: 0,
  };
  const invoices = [];
  for (const jobDir of await listJobDirs(dataDir)) {
    try {
      const evidence = await invoiceAmountEvidence({ jobDir, issuedDocuments });
      if (evidence.jobId) summary.jobs += 1;
      for (const entry of evidence.invoices) {
        summary.issuedInvoices += 1;
        if (entry.state === "agrees") continue;
        summary.disagreeing += 1;
        summary.byState[entry.state] = (summary.byState[entry.state] || 0) + 1;
        if (entry.sent) summary.settledBySentCopyAvailable += 1;
        if (!entry.sent && entry.sends.length && entry.sends.every((send) => !send.hashed)) summary.emailedBeforeHashes += 1;
        invoices.push(publicEntry(evidence.jobId, entry, evidence.versionTotals));
      }
    } catch {
      summary.errors += 1;
    }
    onJob?.(jobDir);
  }
  return { summary, invoices };
}
