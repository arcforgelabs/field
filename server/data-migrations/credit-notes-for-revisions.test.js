// Credit notes for invoices revised in place (#28, step 4b): the data
// migration records a credit note against every revision superseded in place,
// naming its replacement, verified against the stored PDFs to the cent; moves
// the payments the superseded invoice held; reports exactly what it would do
// in a dry run; and writes nothing for a job whose files disagree with its
// PDFs, running again until that job is fixed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { runAtomicJobGeneration } from "../job-generation.js";
import { createInvoiceRowService } from "../invoices/invoice-rows.js";
import { collectJobInvoices } from "../invoices/sync.js";
import { scenarios } from "../invoices/test-fixtures.js";
import { creditNotesForRevisions } from "./credit-notes-for-revisions.js";
import { readDataMigrationLedger, runDataMigrations } from "./index.js";

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

async function editState(jobDir, edit) {
  await runAtomicJobGeneration(jobDir, async (staged) => {
    const path = join(staged, "milestone-invoices/state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    edit(state);
    await writeFile(path, JSON.stringify(state, null, 2));
  });
}

describe("credit notes for invoices revised in place", () => {
  let t;
  let rows;
  let dataDir;
  const dirs = {};

  const migrate = (mode, directory = dataDir) => runDataMigrations({ db: t.db, orgUid: DEFAULT_ORG_UID, dataDir: directory, mode, migrations: [creditNotesForRevisions], logger: quiet });

  before(async () => {
    t = await createTestDb();
    rows = createInvoiceRowService({ db: t.db, orgUid: DEFAULT_ORG_UID });
    dataDir = mkdtempSync(join(tmpdir(), "field-credit-migration-"));
    for (const name of ["paid", "revised", "revisedPaid"]) dirs[name] = await scenarios[name](dataDir);
    // As step 4a wrote them: the rows, without credit notes or allocations.
    for (const name of ["paid", "revised", "revisedPaid"]) {
      const { jobId, mapped } = await collectJobInvoices(dirs[name]);
      await rows.writeJob({ jobId, mapped: { ...mapped, creditNotes: [] } });
    }
  });
  after(async () => {
    await t.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a dry run says what it would record and writes nothing", async () => {
    const [report] = await migrate("dry-run");
    assert.equal(report.status, "would-apply");
    assert.deepEqual(report.summary, { changed: 2, jobsWithRevisions: 2, jobs: 2, creditNotes: 2, allocations: 1, invoicesBackfilled: 0, refused: 0 });
    assert.deepEqual(report.changes.map((change) => [change.jobId, change.number, change.invoice, change.replacement, change.total]), [
      ["job-revised", "CN-EI-2605-04-M1", "EI-2605-04-M1", "EI-2605-04-M1-R2", "110.00"],
      ["job-revised-paid", "CN-EI-2605-07-M1", "EI-2605-07-M1", "EI-2605-07-M1-R2", "110.00"],
    ]);
    assert.deepEqual((await rows.readJob("job-revised")).creditNotes, []);
    assert.deepEqual((await rows.readJob("job-revised-paid")).allocations, []);
    assert.equal((await readDataMigrationLedger(t.db, DEFAULT_ORG_UID)).size, 0);
  });

  test("applied: each superseded invoice is credited in full, naming its replacement; its payment moves; recorded once", async () => {
    const [report] = await migrate("apply");
    assert.equal(report.status, "applied");
    assert.deepEqual(report.applied.refused, []);
    const revised = await rows.readJob("job-revised");
    const byNumber = Object.fromEntries(revised.invoices.map((invoice) => [invoice.number, invoice]));
    assert.deepEqual(revised.creditNotes.map((note) => [note.number, note.status, note.origin, note.invoiceUid, note.replacementInvoiceUid, note.subtotal, note.taxTotal, note.total, note.reason, note.createdBy, note.issuedDocumentUid]), [
      ["CN-EI-2605-04-M1", "issued", "revision-migration", byNumber["EI-2605-04-M1"].uid, byNumber["EI-2605-04-M1-R2"].uid, "100.00", "10.00", "110.00", "Approved variation", "Test Operator", null],
    ]);
    // Verified to the cent against the PDFs: the credit equals what the
    // superseded invoice's PDF charged, and the replacement equals its own.
    assert.deepEqual([byNumber["EI-2605-04-M1"].total, byNumber["EI-2605-04-M1-R2"].total], ["110.00", "165.00"]);

    const paid = await rows.readJob("job-revised-paid");
    const credited = paid.invoices.find((invoice) => invoice.number === "EI-2605-07-M1");
    const replacement = paid.invoices.find((invoice) => invoice.number === "EI-2605-07-M1-R2");
    assert.deepEqual(paid.allocations.map((allocation) => [allocation.fromInvoiceUid, allocation.toInvoiceUid, allocation.amount]), [[credited.uid, replacement.uid, "50.00"]]);
    assert.deepEqual([credited.amountPaid, replacement.amountPaid], ["0.00", "50.00"]);
    assert.equal((await rows.readJob("job-paid")).creditNotes.length, 0, "a job with no revisions is not touched");

    const ledger = await readDataMigrationLedger(t.db, DEFAULT_ORG_UID);
    assert.ok(ledger.has("2026-10-12-credit-notes-for-revisions"));
    const [again] = await migrate("apply");
    assert.equal(again.status, "already-applied");
  });

  test("a job whose files disagree with its PDFs is written nothing, and the migration waits for it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "field-credit-migration-bad-"));
    const db = await createTestDb();
    try {
      const jobDir = await scenarios.revised(directory);
      // The superseded revision's record no longer matches the PDF it was issued as.
      await editState(jobDir, (state) => {
        const superseded = state.milestoneInvoices[0].revisionHistory[0];
        Object.assign(superseded, { subtotal: 90, gst: 9, total: 99 });
      });
      const run = (mode) => runDataMigrations({ db: db.db, orgUid: DEFAULT_ORG_UID, dataDir: directory, mode, migrations: [creditNotesForRevisions], logger: quiet });
      const [report] = await run("apply");
      assert.equal(report.status, "deferred");
      assert.match(report.reason, /job-revised .*EI-2605-04-M1 total rows 99\.00 vs revision-pdf 110\.00/);
      const read = await createInvoiceRowService({ db: db.db, orgUid: DEFAULT_ORG_UID }).readJob("job-revised");
      assert.deepEqual([read.invoices.length, read.creditNotes.length], [0, 0]);
      assert.equal((await readDataMigrationLedger(db.db, DEFAULT_ORG_UID)).size, 0, "not recorded: it runs again at the next boot");
    } finally {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
