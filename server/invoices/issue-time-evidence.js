// When an issued invoice's record holds no issue time, the time Field's other
// records give for it. The invoice backfill (#27) maps it from these instead
// of refusing the job; it never invents one.
//
// Which records lack one: from 2026-04-10 to 2026-08-05 Field derived a
// milestone's status from its amounts. A $0 milestone was "paid", and a later
// rebuild against the priced quote turned a stored "paid" into "authorised".
// No issue event ran, so no `issuedAt` was written, and sending an
// "authorised" invoice never set one. The legacy freeze (2026-08-05) then
// copied the missing time into the issued revision it synthesized.
//
// Sources, strongest first. The first that names the invoice wins:
//
//   older-field       a time the record holds under an older name. A
//                     one-milestone job's `invoiceSentAt`: before milestone
//                     invoices (2026-04-10) a job had one invoice, and that
//                     was its send time. With more milestones it names none
//   issued-document   the issued_documents row for the number on this job
//   issuance-ledger   an issuance ledger record (quote-issuance.json) of an
//                     invoice delivery whose PDF names the number: the first
//   sent-email        sent-emails.jsonl (from 2026-05-12): the first archived
//                     email naming the number in its subject or attachment
//   activity-log      job-state/activity.jsonl: the first `invoice.sent`
//                     event naming the number
//   stored-pdf-date   the date the stored PDF prints ("Issued: 14 April
//                     2026"), read from its text the way issued-totals.js
//                     reads its totals. A PDF naming another invoice says
//                     nothing. A date only: midnight in the business time
//                     zone, the process's TZ (Australia/Adelaide in
//                     production), with that date as the issue date
//
// Read-only. The result holds times and source codes only.
import { readJobFile } from "../documents/job-sources.js";
import { resolveActiveJobGeneration } from "../job-generation.js";
import { readJobState } from "../job-state.js";
import { readIssuedQuoteArtifact, readQuoteIssuanceLedger } from "../quote-issuance.js";
import { pdfTextRuns } from "../quotes/issued-totals.js";
import { extractInvoicePdfFacts } from "./issued-totals.js";
import { collectSentInvoiceCopies, namesInvoice } from "./sent-copies.js";

/** The sources, strongest first; ISSUE_TIME_SOURCE_LABELS (from-milestones.js) names each on a row's note. */
export const ISSUE_TIME_SOURCES = Object.freeze(["older-field", "issued-document", "issuance-ledger", "sent-email", "activity-log", "stored-pdf-date"]);

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function iso(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function earliest(times) {
  return times.map(iso).filter(Boolean).sort()[0] || null;
}

/** "Issued: 14 April 2026" (the date line every invoice PDF prints) -> "2026-04-14", else null. */
export function printedIssueDate(bytes) {
  let runs;
  try {
    runs = pdfTextRuns(bytes);
  } catch {
    return null;
  }
  for (const run of runs) {
    const match = /^Issued:\s*(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(run);
    if (!match) continue;
    const month = MONTHS.indexOf(match[2].toLowerCase()) + 1;
    const day = Number(match[1]);
    const year = Number(match[3]);
    if (!month || day < 1 || day > 31) continue;
    const at = new Date(year, month - 1, day);
    if (at.getMonth() !== month - 1) continue;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

/** "2026-04-14" -> that date's midnight in the process's time zone (TZ), as ISO. */
export function businessMidnight(dateOnly) {
  const [year, month, day] = String(dateOnly).split("-").map(Number);
  return new Date(year, month - 1, day).toISOString();
}

async function activityTimes(jobDir) {
  const out = [];
  const seen = new Set();
  for (const dir of [...new Set([jobDir, await resolveActiveJobGeneration(jobDir).catch(() => jobDir)])]) {
    let activity = [];
    try {
      ({ activity } = await readJobState(dir));
    } catch {
      continue;
    }
    for (const entry of activity || []) {
      const key = entry?.id || `${entry?.ts}:${entry?.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/** Every invoice delivery the issuance ledger holds, hash-checked: { number, at }, the number its PDF prints. */
async function ledgerDeliveries(jobDir) {
  const ledger = await readQuoteIssuanceLedger(jobDir).catch(() => ({ records: [] }));
  const out = [];
  for (const record of ledger.records || []) {
    const documentType = record?.documentType || record?.delivery?.documentType || "quote";
    if (documentType !== "invoice" || !record.delivery) continue;
    const artifact = await readIssuedQuoteArtifact(jobDir, record, "quotePdf").catch(() => null);
    if (!artifact?.available) continue;
    const number = extractInvoicePdfFacts(artifact.bytes)?.number || null;
    if (number) out.push({ number, at: record.issuedAt });
  }
  return out;
}

async function pdfDate(jobDir, { number, pdfPath, pdfSha256 }) {
  if (!text(pdfPath)) return null;
  const file = await readJobFile(jobDir, pdfPath, { expectedSha256: text(pdfSha256) });
  if (!file.ok) return null;
  const facts = extractInvoicePdfFacts(file.bytes);
  if (facts?.number && facts.number !== number) return null;
  return printedIssueDate(file.bytes);
}

/**
 * The issue time of each wanted invoice that the job's records give.
 *
 *   wanted            [{ number, milestone, pdfPath, pdfSha256 }]
 *   meta              the job's hydrated meta
 *   issuedDocuments   the issue service, or null
 *
 * Returns a Map: number -> { issuedAt, issuedOn, source }. `issuedOn` is set
 * only where the source is a date (stored-pdf-date). A number no record gives
 * a time for is left out.
 */
export async function findIssueTimes({ jobDir, jobId, meta, wanted, issuedDocuments = null }) {
  const found = new Map();
  const numbers = [...new Set((wanted || []).map((entry) => text(entry?.number)).filter(Boolean))];
  if (!numbers.length) return found;
  const take = (number, issuedAt, source, issuedOn = null) => {
    if (found.has(number) || !iso(issuedAt)) return;
    found.set(number, { issuedAt: iso(issuedAt), issuedOn, source });
  };

  // older-field
  const milestones = Array.isArray(meta?.milestoneInvoices) ? meta.milestoneInvoices : [];
  if (milestones.length === 1 && iso(meta?.invoiceSentAt)) {
    const only = milestones[0];
    for (const number of numbers) {
      if (number === text(only?.invoiceNumber) || number === text(only?.issuedRevision?.invoiceNumber)) take(number, meta.invoiceSentAt, "older-field");
    }
  }

  // issued-document
  if (issuedDocuments && jobId) {
    for (const number of numbers.filter((entry) => !found.has(entry))) {
      try {
        const document = await issuedDocuments.findIssuedDocument({ documentType: "invoice", number });
        if (document && document.jobId === jobId) take(number, document.issuedAt, "issued-document");
      } catch {
        // An unreadable store says nothing; the next source may.
      }
    }
  }

  // issuance-ledger
  if (numbers.some((number) => !found.has(number))) {
    const delivered = await ledgerDeliveries(jobDir);
    for (const number of numbers.filter((entry) => !found.has(entry))) {
      take(number, earliest(delivered.filter((delivery) => delivery.number === number).map((delivery) => delivery.at)), "issuance-ledger");
    }
  }

  // sent-email
  if (numbers.some((number) => !found.has(number))) {
    const collected = await collectSentInvoiceCopies({ jobDir, jobId, issuedDocuments: null }).catch(() => null);
    if (collected) {
      for (const number of numbers.filter((entry) => !found.has(entry))) {
        take(number, earliest(collected.sendsFor(number).map((send) => send.sentAt)), "sent-email");
      }
    }
  }

  // activity-log
  if (numbers.some((number) => !found.has(number))) {
    const sent = (await activityTimes(jobDir)).filter((entry) => entry?.kind === "invoice.sent");
    for (const number of numbers.filter((entry) => !found.has(entry))) {
      take(number, earliest(sent.filter((entry) => namesInvoice(entry.body, number)).map((entry) => entry.ts)), "activity-log");
    }
  }

  // stored-pdf-date
  for (const entry of wanted || []) {
    const number = text(entry?.number);
    if (!number || found.has(number)) continue;
    const printed = await pdfDate(jobDir, { number, pdfPath: entry.pdfPath, pdfSha256: entry.pdfSha256 });
    if (printed) take(number, businessMidnight(printed), "stored-pdf-date", printed);
  }
  return found;
}
