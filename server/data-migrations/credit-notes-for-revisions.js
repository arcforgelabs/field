// Step 4b (#28): credit notes for invoices revised in place before credit
// notes existed.
//
// Until step 4b an approved change revised an issued invoice in place: the
// new revision took the next number (EI-…-M<n>-R<k>) and the old one stayed in
// the job's revision history, superseded. An issued invoice is now corrected
// by a credit note against it plus a new invoice. For every revision that was
// superseded in place, this migration records that correction in PostgreSQL:
//
//   - a credit note against the superseded invoice, crediting it in full,
//     naming the invoice that replaced it, with the reason and who revised it
//     (origin `revision-migration`, number CN-<the invoice's number>: it was
//     never issued to the customer as a document, so it takes no number from
//     the sequence and has no PDF);
//   - every active payment the superseded invoice held moved to its
//     replacement, as a payment allocation.
//
// The job files are only read. Each job goes through the invoice-row sync
// (server/invoices/sync.js) with `verifyIssued`: before anything is written
// for a job, every issued invoice on it, the superseded one and its
// replacement among them, must equal its stored revision and, to the cent,
// the totals its stored PDF printed; the credit note credits exactly what the
// superseded invoice charged. A job that fails is written nothing and is
// listed with both numbers. Jobs whose invoice rows were never written
// (the invoice-row backfill has not run for them) are written in full by the
// same verified sync.
//
// A job that is refused stays refused until its files are fixed: the
// migration is then not recorded, so it runs again at the next boot; the
// dual-write also records the credit note on the job's next committed change.
// `npm run data:migrate -- --dry-run` reports what it would record.
import { listJobDirs } from "../quote-files.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { createInvoiceRowService } from "../invoices/invoice-rows.js";
import { collectJobInvoices, syncJobInvoiceRows } from "../invoices/sync.js";
import { createQuoteRowService } from "../quotes/quote-rows.js";
import { withOrg } from "../db-runtime/tenancy.js";
import { recordDataMigrationLedger } from "./ledger.js";

const ID = "2026-10-12-credit-notes-for-revisions";
const ACTOR = "data-migration";

function services({ db, orgUid }) {
  return {
    service: createInvoiceRowService({ db, orgUid }),
    issuedDocuments: createIssuedDocumentService({ db, orgUid }),
    quoteRows: createQuoteRowService({ db, orgUid }),
  };
}

function describeFailures(failures) {
  return failures.slice(0, 5).map((failure) => (failure.rows !== undefined
    ? `${failure.number ? `${failure.number} ` : ""}${failure.field} rows ${failure.rows} vs ${failure.against || failure.kind} ${failure.shown}`
    : failure.reason || failure.kind)).join("; ");
}

async function plan(context) {
  const { service, issuedDocuments, quoteRows } = services(context);
  const jobs = [];
  for (const jobDir of listJobDirs(context.dataDir)) {
    const { jobId, mapped } = await collectJobInvoices(jobDir);
    const notes = (mapped?.creditNotes || []).filter((note) => note.origin === "revision-migration");
    if (!jobId || !notes.length) continue;
    const result = await syncJobInvoiceRows({ jobDir, service, quoteRows, issuedDocuments, verifyIssued: true, dryRun: true, actor: ACTOR });
    jobs.push({
      jobDir,
      jobId,
      ok: result.ok,
      failures: result.failures,
      creditNotes: notes.map((note) => ({ number: note.number, invoice: note.invoiceKey, replacement: note.replacementKey, total: note.total, reason: note.reason })),
      wouldWrite: {
        creditNotes: result.summary?.creditNotes?.created || 0,
        allocations: result.summary?.allocations?.created || 0,
        invoices: result.summary?.invoices?.created || 0,
      },
      verified: result.invoices.filter((invoice) => invoice.status !== "draft").map((invoice) => ({ number: invoice.number, rows: invoice.rows, printed: invoice.issued.map((copy) => copy.totals) })),
    });
  }
  const pending = jobs.filter((job) => job.ok && (job.wouldWrite.creditNotes || job.wouldWrite.allocations || job.wouldWrite.invoices));
  const refused = jobs.filter((job) => !job.ok);
  const planned = {
    jobs,
    pending,
    refused,
    changes: pending.flatMap((job) => job.creditNotes.map((note) => ({ jobId: job.jobId, ...note }))),
  };
  if (!pending.length && refused.length) {
    planned.deferred = true;
    planned.deferredReason = `${refused.length} job(s) with invoices revised in place do not match their PDFs or files and were not written: ${refused.map((job) => `${job.jobId} (${describeFailures(job.failures)})`).join("; ")}`;
  }
  return planned;
}

// The sync's dry run above is the verification: every issued invoice on each
// job against its stored revision and its PDF, to the cent. A job that failed
// it is listed and never written.
async function verify(context, planned) {
  for (const job of planned.refused) {
    context.logger?.warn?.(`[data-migrations] ${ID}: job ${job.jobId} not written: ${describeFailures(job.failures)}`);
  }
  return { ok: true, refused: planned.refused.length };
}

async function apply(context, planned, { appliedAt, summary }) {
  const { service, issuedDocuments, quoteRows } = services(context);
  const written = [];
  const refused = planned.refused.map((job) => ({ jobId: job.jobId, failures: job.failures }));
  for (const job of planned.pending) {
    const result = await syncJobInvoiceRows({ jobDir: job.jobDir, service, quoteRows, issuedDocuments, verifyIssued: true, actor: ACTOR });
    if (!result.ok) {
      refused.push({ jobId: job.jobId, failures: result.failures });
      continue;
    }
    written.push({ jobId: job.jobId, creditNotes: result.summary?.creditNotes?.created || 0, allocations: result.summary?.allocations?.created || 0 });
  }
  // Recorded once every job is done; with a job refused it runs again at
  // the next boot (a second run of a written job writes nothing).
  if (!refused.length) {
    await withOrg(context.db, context.orgUid, (tx) => recordDataMigrationLedger(tx, { id: ID, summary, appliedAt }));
  }
  return { recorded: true, report: { written, refused } };
}

function summarize(planned) {
  const sum = (field) => planned.pending.reduce((total, job) => total + job.wouldWrite[field], 0);
  return {
    changed: planned.pending.length,
    jobsWithRevisions: planned.jobs.length,
    jobs: planned.pending.length,
    creditNotes: sum("creditNotes"),
    allocations: sum("allocations"),
    invoicesBackfilled: sum("invoices"),
    refused: planned.refused.length,
  };
}

function describe(summary) {
  return `${summary.creditNotes} credit note(s) and ${summary.allocations} payment allocation(s) recorded for invoices revised in place, across ${summary.jobs} job(s)${summary.refused ? `; ${summary.refused} job(s) refused, so the migration runs again at the next boot` : ""}`;
}

export const creditNotesForRevisions = Object.freeze({
  id: ID,
  title: "Credit notes for invoices revised in place before credit notes",
  plan,
  verify,
  apply,
  summarize,
  describe,
});
