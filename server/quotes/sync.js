// One job's quote versions, from its files into quote rows (#241), with the
// checks that prove the rows equal what Field shows and sent:
//
//   shown        quoteTotals(rows) equals the totals Field shows for the
//                version today (the renderer's subtotal, GST and total, which
//                the PDF prints), to the cent
//   lines        each line's total is the amount it printed; where qty x rate
//                does not give it, it is kept as printed with the reason and
//                listed as a warning (not a failure: decided 2026-10-12)
//   issued       for a sent version, quoteTotals(rows) equals the totals
//                printed on the PDF the customer was sent: the issued
//                document (#230) when there is a database, the issuance
//                ledger's PDF (or, when the PDF cannot be read, the quote
//                markdown stored with it), or for a quote sent before the
//                ledger the copy legacy-sent-quote.js finds
//
// Used two ways:
//
//   dual-write   recorder.js after every committed change: per version, a
//                version that passes is written, one that does not is
//                reported and its draft rows removed (rows never disagree
//                with Field); the issued-PDF check is the backfill's
//   backfill     backfill.js: `atomic`, so a job with any failing version
//                writes nothing at all
//
// Nothing here writes to a job directory.
import { sha256Hex } from "../documents/blob-store.js";
import { readJobFile } from "../documents/job-sources.js";
import { readLegacySentQuotePdf } from "../legacy-sent-quote.js";
import { compareTotals, mapQuoteArtifact } from "./from-artifact.js";
import { extractQuoteMarkdownTotals, extractQuotePdfTotals } from "./issued-totals.js";
import { collectJobQuoteVersions, quoteSourceDigest } from "./job-quotes.js";
import { contentFingerprint, isFrozenQuote } from "./quote-rows.js";

function nonEmptyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length ? value : null;
}

/**
 * What was issued for a sent version: the issued document's uid and the
 * customer it recorded and, with `verify`, the totals printed on every copy
 * of the sent PDF that can be found (each { source, sha256, totals }).
 */
async function issuedEvidence({ jobDir, jobId, entry, issuedDocuments, verify }) {
  const evidence = { issuedDocumentUid: null, customer: null, copies: [] };
  const seen = new Set();
  const addPdf = (source, bytes, extra = {}) => {
    const sha256 = sha256Hex(bytes);
    if (seen.has(sha256)) return;
    seen.add(sha256);
    evidence.copies.push({ source, sha256, totals: extractQuotePdfTotals(bytes), ...extra });
  };
  if (issuedDocuments && entry.documentNumber) {
    const document = await issuedDocuments.findIssuedDocument({ documentType: "quote", number: entry.documentNumber });
    if (document && document.jobId === jobId) {
      evidence.issuedDocumentUid = document.uid;
      evidence.customer = nonEmptyObject(document.details?.customer);
      if (verify) {
        const read = await issuedDocuments.readIssuedDocument(document.uid);
        if (read?.bytes) addPdf("issued-document", read.bytes, { reference: document.uid });
      }
    }
  }
  if (!verify) return evidence;
  for (const record of entry.ledgerRecords) {
    const artifact = record?.artifacts?.quotePdf;
    if (artifact?.path) {
      const pdf = await readJobFile(jobDir, artifact.path, { expectedSha256: artifact.sha256 });
      if (pdf.ok) addPdf("ledger-pdf", pdf.bytes, { reference: artifact.path });
      else evidence.copies.push({ source: "ledger-pdf", reference: artifact.path, totals: null, unreadable: pdf.reason });
    }
    const markdown = record?.artifacts?.quoteMarkdown;
    if (markdown?.path && !evidence.copies.some((copy) => copy.totals)) {
      const file = await readJobFile(jobDir, markdown.path, { expectedSha256: markdown.sha256 });
      if (file.ok) evidence.copies.push({ source: "ledger-markdown", reference: markdown.path, sha256: file.sha256, totals: extractQuoteMarkdownTotals(file.bytes.toString("utf8")) });
    }
  }
  if (!entry.ledgerRecords.length) {
    const legacy = await readLegacySentQuotePdf(jobDir, entry.version, entry.quotePdfPath);
    if (legacy.available) addPdf(`legacy-${legacy.source}`, legacy.bytes, { reference: legacy.fileName || null });
  }
  return evidence;
}

function emptyJobResult(jobId) {
  return { jobId, ok: true, versions: [], written: [], removed: [], skipped: false };
}

/**
 * Plan, check and (unless `dryRun`) write one job's quote rows.
 *
 *   service           the quote service (quote-rows.js), or null to only check
 *   issuedDocuments   the issue service (#230), or null
 *   verifyIssued      check sent versions against the sent PDF
 *   atomic            write nothing for the job when any version fails
 *   skipUnchanged     do not map a version whose rows were written from the
 *                     same source and whose status is already right (the
 *                     dual-write, which runs after every commit)
 *
 * Returns { jobId, ok, versions, written, removed, skipped } where each
 * version is { version, number, status, sentAt, rows, shown, issued,
 * failures, warnings, ok, action }.
 */
export async function syncJobQuoteRows({
  jobDir,
  service = null,
  issuedDocuments = null,
  verifyIssued = false,
  atomic = false,
  dryRun = false,
  actor = null,
  skipUnchanged = false,
}) {
  const { jobId, meta, versions } = await collectJobQuoteVersions(jobDir);
  if (!jobId) return null;
  const existingDigests = skipUnchanged && service
    ? new Map((await service.listJobQuotes(jobId)).map((row) => [row.version, row]))
    : null;
  const result = emptyJobResult(jobId);
  const plans = [];
  for (const entry of versions) {
    // A sent version's copies are always read: what its PDF printed decides
    // whether a half-cent GST is kept as printed (from-artifact.js).
    const evidence = entry.delivered
      ? await issuedEvidence({ jobDir, jobId, entry, issuedDocuments, verify: true })
      : { issuedDocumentUid: null, customer: null, copies: [] };
    const sourceDigest = quoteSourceDigest({ quote: entry.quote, meta, customer: evidence.customer });
    const existingDigest = existingDigests?.get(entry.version);
    // The dual-write's shortcut: a version whose source is unchanged and whose
    // status is already right needs no mapping.
    if (existingDigest && existingDigest.sourceDigest === sourceDigest && existingDigest.status === entry.status
      && (!evidence.issuedDocumentUid || existingDigest.issuedDocumentUid === evidence.issuedDocumentUid)) {
      result.versions.push({ version: entry.version, status: entry.status, ok: true, action: "unchanged", failures: [], warnings: [] });
      continue;
    }
    const printed = evidence.copies.find((copy) => copy.totals)?.totals || null;
    const mapped = mapQuoteArtifact({ quote: entry.quote, meta, customer: evidence.customer, printed });
    const failures = [];
    const warnings = [];
    // Field now shows a half-cent GST rounded exactly (#2); a version whose
    // sent PDF printed it a cent low keeps that GST, so only its subtotal is
    // held to what Field shows.
    const shownDifferences = compareTotals(mapped.totals, mapped.shown)
      .filter((difference) => mapped.header.taxTotalSource !== "printed" || difference.field === "subtotal");
    for (const difference of shownDifferences) {
      failures.push({ kind: "totals", against: "shown", ...difference });
    }
    // The rows must also print what the files print (#245): documents are
    // rendered from them. A quote with no organizer (pre-organizer legacy)
    // keeps printing from its files; its rows hold the money only.
    if (!mapped.legacy && !mapped.printable) {
      failures.push({ kind: "print", reason: "the rows would not print the schedule the files print", differences: mapped.printDifferences.slice(0, 5) });
    }
    if (mapped.printedLines.length) {
      warnings.push({ kind: "line-total-printed", count: mapped.printedLines.length, lines: mapped.printedLines, reason: "line totals kept as printed, where quantity x rate does not give them" });
    }
    if (mapped.header.taxTotalSource === "printed") warnings.push({ kind: "tax-total-printed", reason: mapped.header.taxTotalReason });
    const issued = [];
    if (entry.delivered && verifyIssued) {
      const readable = evidence.copies.filter((copy) => copy.totals);
      if (!readable.length) {
        warnings.push({
          kind: "issued-unverified",
          reason: evidence.copies.length
            ? `the sent copies could not be read (${evidence.copies.map((copy) => `${copy.source}: ${copy.unreadable || "no totals box found"}`).join("; ")})`
            : "sent, but no copy of the sent PDF was found",
        });
      }
      for (const copy of evidence.copies) {
        issued.push({ source: copy.source, reference: copy.reference || null, totals: copy.totals, unreadable: copy.unreadable || null });
        if (!copy.totals) continue;
        for (const difference of compareTotals(mapped.totals, copy.totals)) {
          failures.push({ kind: "totals", against: copy.source, reference: copy.reference || null, ...difference });
        }
      }
    }
    if (mapped.excludedRows) warnings.push({ kind: "excluded-rows", count: mapped.excludedRows, reason: "rows excluded from the price are not printed and are left out" });
    plans.push({ entry, mapped, sourceDigest, evidence, failures, warnings, issued });
    result.versions.push({
      version: entry.version,
      number: mapped.header.number,
      documentNumber: entry.documentNumber,
      status: entry.status,
      sentAt: entry.sentAt,
      issuedDocumentUid: evidence.issuedDocumentUid,
      rows: mapped.totals,
      shown: mapped.shown,
      issued,
      lines: mapped.lines.length,
      sections: mapped.sections.length,
      failures,
      warnings,
      ok: failures.length === 0,
      action: null,
    });
  }
  result.ok = result.versions.every((version) => version.ok);
  if (!service) return result;
  const report = new Map(result.versions.map((version) => [version.version, version]));
  if (dryRun) {
    const existing = new Map((await service.listJobQuotes(jobId)).map((row) => [row.version, row]));
    for (const plan of plans) {
      const row = existing.get(plan.entry.version);
      const entry = report.get(plan.entry.version);
      if (!entry.ok) entry.action = "refused";
      else if (!row) entry.action = "would-create";
      else if (row.sourceDigest === plan.sourceDigest) entry.action = row.status === plan.entry.status ? "unchanged" : "would-update-status";
      else if (!isFrozenQuote(row)) entry.action = "would-replace";
      else {
        const stored = await service.getQuoteVersion(jobId, plan.entry.version);
        if (contentFingerprint(stored) !== contentFingerprint(plan.mapped)) entry.action = "conflict";
        else entry.action = row.status === plan.entry.status ? "unchanged" : "would-update-status";
      }
    }
    return result;
  }
  if (atomic && !result.ok) {
    result.skipped = true;
    for (const version of result.versions) version.action = "refused";
    return result;
  }
  for (const plan of plans) {
    const entry = report.get(plan.entry.version);
    if (!entry.ok) {
      const removed = await service.deleteDraftVersion(jobId, plan.entry.version);
      entry.action = removed.deleted ? "removed-stale-draft" : "refused";
      continue;
    }
    const written = await service.writeVersion({
      jobId,
      version: plan.entry.version,
      mapped: plan.mapped,
      status: plan.entry.status,
      sentAt: plan.entry.sentAt,
      acceptedAt: plan.entry.acceptedAt,
      issuedDocumentUid: plan.evidence.issuedDocumentUid,
      sourceDigest: plan.sourceDigest,
      actor,
    });
    entry.action = written.action === "frozen-kept" ? "conflict" : written.action;
    if (written.action === "frozen-kept") {
      entry.ok = false;
      entry.failures.push({ kind: "sent-rows-differ", reason: "this sent version's rows were written earlier and the files now map to different rows; the rows were kept as sent" });
      result.ok = false;
    }
    result.written.push({ version: plan.entry.version, action: written.action, uid: written.quote.uid });
  }
  // Draft rows of versions that no longer exist (a deleted draft version).
  const present = new Set(versions.map((entry) => entry.version));
  for (const row of await service.listJobQuotes(jobId)) {
    if (present.has(row.version)) continue;
    const removed = await service.deleteDraftVersion(jobId, row.version);
    if (removed.deleted) result.removed.push(row.version);
  }
  return result;
}
