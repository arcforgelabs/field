import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SYSTEM_REBUILD_NOTE_AUTHOR, SYSTEM_REBUILD_NOTE_TITLE } from "./clarification-notes.js";
import { assessJobDeletion } from "./job-deletion.js";

const SYSTEM_NOTE = {
  id: "note-system",
  title: SYSTEM_REBUILD_NOTE_TITLE,
  text: "Quote v001 rebuilt.",
  author: SYSTEM_REBUILD_NOTE_AUTHOR,
  surface: "breakdown",
  layer: "L6",
};

// A job straight out of the New Job sheet: title, site address and contact
// were entered at creation, the quote shell is empty, and the only note is the
// automatic rebuild summary.
function freshJob(meta = {}) {
  return {
    dir: "/field-data/2026-10-11/job-fresh",
    meta: {
      id: "job-fresh",
      title: "General Site Works — 1 Example St, Adelaide",
      siteAddress: "1 Example St, Adelaide SA 5000",
      contactName: "Pat Customer",
      outputMode: "quote",
      captureMode: "manual",
      status: "complete",
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteLineItemCount: 0,
      audioFile: null,
      audioFiles: [],
      milestoneInvoices: [],
      invoiceSentAt: null,
      ...meta,
    },
  };
}

function freshDeps(overrides = {}) {
  return {
    readQuoteArtifacts: async () => ({ quote: { version: 1, lineItems: [] } }),
    readQuoteInputs: async () => ({ recordingIntent: "job-scope", lineItemCandidates: [], measurements: [], assumptions: [{ statement: "Manual draft" }] }),
    readQuoteLifecycle: async () => ({ buildCount: 1, sendCount: 0, currentQuoteVersion: 1, currentPipelineStage: "draft" }),
    readQuoteIssuanceLedger: async () => ({ version: 1, issuedVersions: [], records: [] }),
    listQuoteVersions: async () => [{ version: 1, label: "v001" }],
    readSentEmailArchive: async () => [],
    listScheduledEmails: async () => [],
    getNotes: async () => [SYSTEM_NOTE],
    readIngestionLedger: async () => ({ version: 1, files: [] }),
    readMoasureSummary: async () => null,
    readJobState: async () => ({ details: { archivedAt: null }, gaps: [], activity: [] }),
    resolveActiveJobGeneration: async (jobDir) => jobDir,
    ...overrides,
  };
}

async function assess(meta = {}, deps = {}, options = {}) {
  return await assessJobDeletion(freshJob(meta), freshDeps(deps), options);
}

function assertRefused(result, code, reasonPattern) {
  assert.equal(result.deletable, false);
  assert.ok(result.codes.includes(code), `expected ${code} in ${JSON.stringify(result.codes)}`);
  assert.equal(result.reasons.length, result.codes.length);
  assert.ok(result.reasons.some((reason) => reasonPattern.test(reason)), `expected ${reasonPattern} in ${JSON.stringify(result.reasons)}`);
}

test("a freshly created job with nothing added can be deleted", async () => {
  assert.deepEqual(await assess(), { deletable: true, reasons: [], codes: [] });
});

test("the automatic system rebuild note does not count as entered data", async () => {
  const result = await assess({}, {
    getNotes: async () => [SYSTEM_NOTE, { ...SYSTEM_NOTE, id: "note-system-2", author: "system" }],
  });
  assert.equal(result.deletable, true);
});

test("a note written by a person keeps the job", async () => {
  assertRefused(
    await assess({}, { getNotes: async () => [SYSTEM_NOTE, { id: "note-1", text: "Customer wants a gate", author: "Sam" }] }),
    "notes",
    /1 note written by someone/,
  );
});

test("a manual note in the activity log keeps the job even if the notes database missed it", async () => {
  assertRefused(
    await assess({}, {
      readJobState: async () => ({
        details: {},
        activity: [{ kind: "note.manual", actor: { kind: "user", label: "Sam" }, body: "Check access" }],
      }),
    }),
    "notes",
    /note written by someone/,
  );
});

test("anything that shows the quote was sent keeps the job", async () => {
  const cases = [
    [{ quoteSentAt: "2026-10-01T00:00:00.000Z" }, {}],
    [{ lastSentQuoteVersion: 1 }, {}],
    [{}, { readQuoteLifecycle: async () => ({ sendCount: 1, lastSentQuoteVersion: 1, lastSentAt: "2026-10-01T00:00:00.000Z" }) }],
    [{}, { readQuoteIssuanceLedger: async () => ({ issuedVersions: [1], records: [{ quoteVersion: 1, issuedAt: "2026-10-01T00:00:00.000Z" }] }) }],
    [{}, { readQuoteArtifacts: async () => ({ quote: { version: 1, lineItems: [], quoteSentAt: "2026-10-01T00:00:00.000Z" } }) }],
  ];
  for (const [meta, deps] of cases) {
    assertRefused(await assess(meta, deps), "quote_sent", /A quote was sent to the customer/);
  }
});

test("a quote moved to Sent by hand and back to Draft keeps the job", async () => {
  assertRefused(
    await assess({}, {
      readQuoteLifecycle: async () => ({
        sendCount: 0,
        lastSentQuoteVersion: null,
        markedSentQuoteVersion: 1,
        markedSentAt: "2026-10-01T00:00:00.000Z",
        currentPipelineStage: "draft",
      }),
    }),
    "quote_sent",
    /marked as sent/,
  );
});

test("an invoice or receipt delivery keeps the job as an invoice, not as a sent quote", async () => {
  for (const documentType of ["invoice", "receipt"]) {
    const result = await assess({}, {
      readQuoteIssuanceLedger: async () => ({
        issuedVersions: [1],
        records: [{ quoteVersion: 1, documentType, issuedAt: "2026-10-01T00:00:00.000Z" }],
      }),
    });
    assertRefused(result, "invoice_issued", /invoice or receipt was sent/);
    assert.equal(result.codes.includes("quote_sent"), false, `${documentType} delivery reported as a sent quote`);
  }
});

test("sent emails keep the job", async () => {
  assertRefused(
    await assess({}, { readSentEmailArchive: async () => [{ id: "sent-1", kind: "email.sent" }, { id: "sent-2", kind: "email.sent" }] }),
    "emails_sent",
    /2 emails have been sent from it/,
  );
});

test("scheduled or draft emails keep the job, cancelled ones do not", async () => {
  assertRefused(
    await assess({}, { listScheduledEmails: async () => [{ id: "e1", status: "pending" }, { id: "e2", status: "cancelled" }] }),
    "scheduled_emails",
    /1 scheduled or draft email/,
  );
  assertRefused(
    await assess({}, { listScheduledEmails: async () => [{ id: "e3", status: "sent" }] }),
    "scheduled_emails",
    /scheduled or draft email/,
  );
  assert.equal((await assess({}, { listScheduledEmails: async () => [{ id: "e4", status: "cancelled" }] })).deletable, true);
});

test("issued invoices keep the job; an unissued draft invoice alone does not", async () => {
  assertRefused(
    await assess({ milestoneInvoices: [{ status: "authorised", issuedAt: "2026-10-01T00:00:00.000Z" }] }),
    "invoice_issued",
    /1 invoice was issued/,
  );
  assertRefused(await assess({ invoiceSentAt: "2026-10-01T00:00:00.000Z" }), "invoice_issued", /An invoice was sent/);
  assert.equal((await assess({ milestoneInvoices: [{ status: "draft", issuedAt: null }] })).deletable, true);
});

test("a job that has left Draft keeps the job", async () => {
  for (const [stage, label] of [["sent", "Sent"], ["landed", "Landed"], ["lost", "Lost"], ["delivered", "Landed"]]) {
    assertRefused(await assess({ pipelineStage: stage }), "pipeline_stage", new RegExp(`marked ${label}, not Draft`));
  }
});

test("an archived job is not deleted", async () => {
  assertRefused(await assess({ archivedAt: "2026-10-01T00:00:00.000Z" }), "archived", /already archived/);
  assertRefused(
    await assess({}, { readJobState: async () => ({ details: { archivedAt: "2026-10-01T00:00:00.000Z" }, activity: [] }) }),
    "archived",
    /already archived/,
  );
});

test("quote line items keep the job", async () => {
  assertRefused(await assess({ quoteLineItemCount: 3 }), "line_items", /The quote has 3 line items/);
  assertRefused(
    await assess({}, { readQuoteArtifacts: async () => ({ quote: { version: 1, lineItems: [{ code: "EX-01" }] } }) }),
    "line_items",
    /The quote has 1 line item\./,
  );
});

test("quote inputs that have not priced into line items yet keep the job", async () => {
  assertRefused(
    await assess({}, { readQuoteInputs: async () => ({ lineItemCandidates: [{ label: "Trenching" }], measurements: [{ value: 12 }, { value: 4 }] }) }),
    "quote_inputs",
    /Quote inputs were entered \(1 line item candidate, 2 measurements\)/,
  );
});

test("quote versions beyond v1 keep the job", async () => {
  assertRefused(await assess({ quoteVersion: 2 }), "quote_versions", /The quote has 2 versions/);
  assertRefused(
    await assess({}, { listQuoteVersions: async () => [{ version: 2 }, { version: 1 }] }),
    "quote_versions",
    /The quote has 2 versions/,
  );
});

test("uploaded files, recordings and Moasure batches keep the job", async () => {
  assertRefused(
    await assess({}, { readIngestionLedger: async () => ({ files: [{ fileId: "f1", filePath: "raw/images/site.jpg" }] }) }),
    "files",
    /1 uploaded file/,
  );
  assertRefused(await assess({ audioFiles: ["recording/a.webm"] }), "recording", /It has a recording/);
  assertRefused(await assess({ moasureBatchCount: 2 }), "moasure", /2 Moasure measurement batches/);
  assertRefused(
    await assess({}, { readMoasureSummary: async () => ({ batchCount: 1, imports: [{ batchId: "b1" }] }) }),
    "moasure",
    /1 Moasure measurement batch\./,
  );
});

test("every reason is reported together", async () => {
  const result = await assess(
    { pipelineStage: "landed", quoteSentAt: "2026-10-01T00:00:00.000Z", quoteLineItemCount: 4 },
    { getNotes: async () => [{ id: "n1", text: "Gate code 1234", author: "Sam" }] },
  );
  assert.equal(result.deletable, false);
  assert.deepEqual(result.codes, ["pipeline_stage", "quote_sent", "line_items", "notes"]);
});

test("a record that cannot be read keeps the job", async () => {
  assertRefused(
    await assess({}, { readQuoteLifecycle: async () => { throw new SyntaxError("Unexpected token"); } }),
    "unreadable:quote history",
    /could not read its quote history/,
  );
});

test("quick mode stops at the first meta reason without reading files", async () => {
  const explode = async () => { throw new Error("should not be read"); };
  const deps = Object.fromEntries(Object.keys(freshDeps()).map((key) => [key, explode]));
  const result = await assessJobDeletion(freshJob({ pipelineStage: "sent" }), deps, { quick: true });
  assert.deepEqual(result.codes, ["pipeline_stage"]);
});

test("real job files: a fresh job is deletable and a sent email keeps it", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-deletion-"));
  try {
    const job = freshJob();
    job.dir = jobDir;
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(job.meta, null, 2));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify({ version: 1, lineItems: [] }, null, 2));
    // The quote-inputs shell the New Job sheet writes: placeholders, no scope.
    await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify({
      recordingIntent: "job-scope",
      lineItemCandidates: [],
      measurements: [],
      missingInputs: [{ field: "manual scope review" }],
      assumptions: [{ statement: "This draft was created manually without captured audio evidence." }],
    }, null, 2));
    const deps = { getNotes: async () => [SYSTEM_NOTE] };

    assert.deepEqual(await assessJobDeletion(job, deps), { deletable: true, reasons: [], codes: [] });

    await appendFile(join(jobDir, "sent-emails.jsonl"), `${JSON.stringify({ id: "sent-1", kind: "email.sent" })}\n`);
    assertRefused(await assessJobDeletion(job, deps), "emails_sent", /1 email has been sent from it/);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
