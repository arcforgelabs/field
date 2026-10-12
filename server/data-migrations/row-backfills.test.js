// The quote-row and invoice-row backfills as boot data migrations (#36),
// through the runner, on a fixture data directory of jobs built by the real
// milestone actions (synthetic data only). On PGlite always, and on a real
// PostgreSQL migrated by a non-superuser table owner (as Replit runs it) when
// FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1 is set.
//
//   - both apply, are recorded with their summaries, and write rows only
//     (every job file byte-identical); invoices link the quote versions the
//     quote backfill wrote; a second boot is a no-op;
//   - a planted mismatch: every other job is written, the refused job is
//     logged by id with both numbers (no customer text), the invoice backfill
//     stays unrecorded; the retry writes nothing new; once the job verifies,
//     the next boot writes it and records the backfill;
//   - FIELD_DATA_MIGRATIONS_HOLD skips them; holding the quote backfill
//     leaves the invoice backfill unrecorded (it waits for it);
//   - a dry run writes nothing.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createTestDb, migratePostgresDatabase, queryRows, schema } from "../db-runtime/index.js";
import { startTestPostgres, testPostgresMode } from "../db-runtime/test-postgres.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createInvoiceRowService } from "../invoices/invoice-rows.js";
import { scenarios } from "../invoices/test-fixtures.js";
import { runAtomicJobGeneration } from "../job-generation.js";
import { createQuoteRowService } from "../quotes/quote-rows.js";
import { runDataMigrations } from "./index.js";
import { INVOICE_ROWS_BACKFILL_ID, invoiceRowsBackfill, QUOTE_ROWS_BACKFILL_ID, quoteRowsBackfill } from "./row-backfills.js";

const MIGRATIONS = [quoteRowsBackfill, invoiceRowsBackfill];
const postgresEnabled = testPostgresMode().kind !== "none";

async function buildDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), "field-row-backfills-"));
  const dirs = {};
  for (const name of Object.keys(scenarios)) dirs[name] = await scenarios[name](dataDir);
  return { dataDir, dirs };
}

/** Every file under the data directory with its SHA-256. */
function treeHashes(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[relative(dir, abs)] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function editState(jobDir, edit) {
  await runAtomicJobGeneration(jobDir, async (staged) => {
    const path = join(staged, "milestone-invoices/state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    edit(state);
    await writeFile(path, JSON.stringify(state, null, 2));
  });
}

function capture() {
  const lines = [];
  return { lines, logger: { log: (line) => lines.push(line), warn: (line) => lines.push(line) } };
}

async function rowCounts(db) {
  const [counts] = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`
    select (select count(*) from quotes)::int as quotes,
           (select count(*) from quote_lines)::int as quote_lines,
           (select count(*) from payment_milestones)::int as milestones,
           (select count(*) from invoices)::int as invoices,
           (select count(*) from payments)::int as payments,
           (select count(*) from receipts)::int as receipts`, tx));
  return counts;
}

async function ledger(db) {
  const rows = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select id, summary from data_migrations order by id`, tx));
  return Object.fromEntries(rows.map((row) => [row.id, typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary]));
}

// The databases the tests run on: PGlite, and a real PostgreSQL when enabled.
const backends = [
  { name: "PGlite", skip: false, open: async () => { const handle = await createTestDb(); return { db: handle.db, close: () => handle.close() }; } },
  {
    name: "PostgreSQL",
    skip: !postgresEnabled && "set FIELD_DB_TEST_DOCKER=1 or FIELD_DB_TEST_DATABASE_URL",
    open: async (server) => {
      const admin = postgres(server.url, { max: 1, onnotice: () => {} });
      const suffix = randomBytes(4).toString("hex");
      const role = `owner_${suffix}`;
      const database = `field_backfills_${suffix}`;
      await admin.unsafe(`create role ${role} login nosuperuser nobypassrls nocreaterole`);
      await admin.unsafe(`create database ${database} owner ${role}`);
      const url = new URL(server.url);
      url.username = role;
      url.pathname = `/${database}`;
      const client = postgres(url.toString(), { max: 3, onnotice: () => {}, connection: { TimeZone: "UTC" } });
      const db = drizzle(client, { schema });
      await migratePostgresDatabase(db);
      return {
        db,
        close: async () => {
          await client.end({ timeout: 5 });
          await admin.unsafe(`drop database if exists ${database} with (force)`);
          await admin.unsafe(`drop role if exists ${role}`);
          await admin.end({ timeout: 5 });
        },
      };
    },
  },
];

for (const backend of backends) {
  describe(`row backfills as boot data migrations (${backend.name})`, { skip: backend.skip }, () => {
    let server = null;
    before(async () => {
      if (backend.name === "PostgreSQL") server = await startTestPostgres();
    });
    after(async () => {
      await server?.stop();
    });

    async function setup(t) {
      const { dataDir, dirs } = await buildDataDir();
      const database = await backend.open(server);
      t.after(async () => {
        await database.close();
        rmSync(dataDir, { recursive: true, force: true });
      });
      const boot = async (options = {}) => {
        const { lines, logger } = capture();
        const report = await runDataMigrations({ db: database.db, orgUid: DEFAULT_ORG_UID, dataDir, migrations: MIGRATIONS, logger, ...options });
        return { report, lines, byId: Object.fromEntries(report.map((entry) => [entry.id, entry])) };
      };
      return { db: database.db, dataDir, dirs, boot };
    }

    test("both apply and are recorded, write rows only, link invoices to quotes; a second boot is a no-op", async (t) => {
      const { db, dataDir, boot } = await setup(t);
      const filesBefore = treeHashes(dataDir);

      const first = await boot();
      assert.deepEqual(first.report.map((entry) => [entry.id, entry.status]), [
        [QUOTE_ROWS_BACKFILL_ID, "applied"],
        [INVOICE_ROWS_BACKFILL_ID, "applied"],
      ]);
      const quotes = first.byId[QUOTE_ROWS_BACKFILL_ID].summary;
      assert.deepEqual([quotes.jobs, quotes.refusedJobs, quotes.alreadyPresent], [6, 0, 0]);
      assert.equal(quotes.written, quotes.versions, "every quote version written");
      assert.ok(quotes.versions >= 6, "every job's quote");
      const invoices = first.byId[INVOICE_ROWS_BACKFILL_ID].summary;
      assert.deepEqual([invoices.jobsWithMilestones, invoices.written, invoices.alreadyPresent, invoices.refusedJobs, invoices.invoices], [6, 6, 0, 0, 11]);
      assert.deepEqual(first.lines, [
        `[data-migrations] ${QUOTE_ROWS_BACKFILL_ID}: applied (6 job(s), ${quotes.versions} quote version(s): ${quotes.versions} written, 0 already present, 0 job(s) refused; ${quotes.warnings} warning(s)); recorded`,
        `[data-migrations] ${INVOICE_ROWS_BACKFILL_ID}: applied (6 job(s) with milestones, 11 invoice(s): 6 job(s) written, 0 already present, 0 job(s) refused; 0 warning(s)); recorded`,
      ], "one line per migration, with the counts");

      const recorded = await ledger(db);
      assert.deepEqual(Object.keys(recorded), [INVOICE_ROWS_BACKFILL_ID, QUOTE_ROWS_BACKFILL_ID]);
      assert.equal(recorded[QUOTE_ROWS_BACKFILL_ID].written, quotes.versions);
      assert.equal(recorded[INVOICE_ROWS_BACKFILL_ID].written, 6);
      assert.deepEqual(treeHashes(dataDir), filesBefore, "no job file was written");

      const invoiceRows = createInvoiceRowService({ db, orgUid: DEFAULT_ORG_UID });
      const quoteRows = createQuoteRowService({ db, orgUid: DEFAULT_ORG_UID });
      const paid = await invoiceRows.readJob("job-paid");
      assert.equal(paid.invoices.length, 2);
      const [paidQuote] = await quoteRows.listJobQuotes("job-paid");
      assert.ok(paidQuote?.uid, "the quote rows exist");
      assert.ok(paid.invoices.every((invoice) => invoice.quoteUid === paidQuote.uid), "invoices link the quote version they bill");

      const counts = await rowCounts(db);
      const second = await boot();
      assert.deepEqual(second.report.map((entry) => entry.status), ["already-applied", "already-applied"]);
      assert.deepEqual(second.lines, [], "a recorded migration never runs again");
      assert.deepEqual(await rowCounts(db), counts);
    });

    test("a planted mismatch: the other jobs are written, the refused job is logged by id with both numbers, and the backfill retries until it verifies", async (t) => {
      const { db, dirs, boot } = await setup(t);
      // job-deposit: its deposit's stored revision no longer matches its PDF.
      let original = null;
      await editState(dirs.depositCompletion, (state) => {
        const deposit = state.milestoneInvoices[0];
        original = { subtotal: deposit.subtotal, gst: deposit.gst, total: deposit.total };
        for (const target of [deposit, deposit.issuedRevision]) Object.assign(target, { subtotal: 900, gst: 90, total: 990 });
      });

      const first = await boot();
      assert.deepEqual(first.report.map((entry) => entry.status), ["applied", "incomplete"]);
      const invoices = first.byId[INVOICE_ROWS_BACKFILL_ID];
      assert.deepEqual([invoices.summary.written, invoices.summary.refusedJobs], [5, 1]);
      assert.deepEqual(invoices.refused, [{
        jobId: "job-deposit",
        mismatches: [
          { kind: "totals", against: "revision-pdf", number: "EI-2605-02-M1", field: "subtotal", rows: "900.00", shown: "925.50" },
          { kind: "totals", against: "revision-pdf", number: "EI-2605-02-M1", field: "taxTotal", rows: "90.00", shown: "92.55" },
          { kind: "totals", against: "revision-pdf", number: "EI-2605-02-M1", field: "total", rows: "990.00", shown: "1018.05" },
        ],
      }]);
      assert.deepEqual(first.lines.slice(1), [
        `[data-migrations] ${INVOICE_ROWS_BACKFILL_ID}: incomplete (6 job(s) with milestones, 11 invoice(s): 5 job(s) written, 0 already present, 1 job(s) refused; ${invoices.summary.warnings} warning(s)); not recorded (1 job(s) refused), runs again at next boot`,
        `[data-migrations] ${INVOICE_ROWS_BACKFILL_ID}: refused job job-deposit: EI-2605-02-M1 totals: subtotal rows 900.00 vs revision-pdf 925.50; EI-2605-02-M1 totals: taxTotal rows 90.00 vs revision-pdf 92.55; EI-2605-02-M1 totals: total rows 990.00 vs revision-pdf 1018.05`,
      ]);
      const logged = first.lines.join("\n");
      for (const text of ["Sam Customer", "Synthetic job", "customer@example.invalid", "Retaining wall"]) {
        assert.equal(logged.includes(text), false, `the log holds no customer text (${text})`);
      }
      assert.deepEqual(Object.keys(await ledger(db)), [QUOTE_ROWS_BACKFILL_ID], "the invoice backfill is not recorded");
      const invoiceRows = createInvoiceRowService({ db, orgUid: DEFAULT_ORG_UID });
      assert.deepEqual((await invoiceRows.readJob("job-deposit")).invoices, [], "nothing written for the refused job");
      assert.equal((await invoiceRows.readJob("job-paid")).invoices.length, 2, "the jobs that verify are written");

      // The next boot retries: one pass, nothing new written.
      const counts = await rowCounts(db);
      const retry = await boot();
      assert.deepEqual(retry.report.map((entry) => entry.status), ["already-applied", "incomplete"]);
      assert.deepEqual([retry.byId[INVOICE_ROWS_BACKFILL_ID].summary.written, retry.byId[INVOICE_ROWS_BACKFILL_ID].summary.alreadyPresent], [0, 5]);
      assert.deepEqual(await rowCounts(db), counts, "the retry is idempotent");

      // Once the job verifies, the next boot writes it and records the backfill.
      await editState(dirs.depositCompletion, (state) => {
        const deposit = state.milestoneInvoices[0];
        for (const target of [deposit, deposit.issuedRevision]) Object.assign(target, original);
      });
      const fixed = await boot();
      assert.deepEqual(fixed.report.map((entry) => entry.status), ["already-applied", "applied"]);
      assert.deepEqual([fixed.byId[INVOICE_ROWS_BACKFILL_ID].summary.written, fixed.byId[INVOICE_ROWS_BACKFILL_ID].summary.alreadyPresent], [1, 5]);
      assert.equal((await invoiceRows.readJob("job-deposit")).invoices.length, 2);
      assert.deepEqual(Object.keys(await ledger(db)), [INVOICE_ROWS_BACKFILL_ID, QUOTE_ROWS_BACKFILL_ID]);
    });

    test("FIELD_DATA_MIGRATIONS_HOLD skips them; the invoice backfill waits for a held quote backfill", async (t) => {
      const { db, boot } = await setup(t);
      const held = await boot({ hold: ["all"] });
      assert.deepEqual(held.report.map((entry) => entry.status), ["held", "held"]);
      assert.deepEqual(held.lines, [
        `[data-migrations] ${QUOTE_ROWS_BACKFILL_ID} held by FIELD_DATA_MIGRATIONS_HOLD; not run`,
        `[data-migrations] ${INVOICE_ROWS_BACKFILL_ID} held by FIELD_DATA_MIGRATIONS_HOLD; not run`,
      ]);
      assert.deepEqual(await rowCounts(db), { quotes: 0, quote_lines: 0, milestones: 0, invoices: 0, payments: 0, receipts: 0 });
      assert.deepEqual(await ledger(db), {});

      const quoteHeld = await boot({ hold: [QUOTE_ROWS_BACKFILL_ID] });
      assert.deepEqual(quoteHeld.report.map((entry) => entry.status), ["held", "incomplete"]);
      assert.deepEqual(quoteHeld.byId[INVOICE_ROWS_BACKFILL_ID].waitingFor, [QUOTE_ROWS_BACKFILL_ID]);
      assert.match(quoteHeld.lines[1], /incomplete \(.*\); not recorded \(waits for 2026-10-13-quote-rows-backfill\), runs again at next boot$/);
      assert.deepEqual(await ledger(db), {});

      const released = await boot();
      assert.deepEqual(released.report.map((entry) => entry.status), ["applied", "applied"]);
      const invoiceRows = createInvoiceRowService({ db, orgUid: DEFAULT_ORG_UID });
      const [quote] = await createQuoteRowService({ db, orgUid: DEFAULT_ORG_UID }).listJobQuotes("job-paid");
      assert.ok((await invoiceRows.readJob("job-paid")).invoices.every((invoice) => invoice.quoteUid === quote.uid), "the links filled in once the quote rows existed");
    });

    test("a dry run writes nothing and says what a boot would do", async (t) => {
      const { db, dataDir, boot } = await setup(t);
      const filesBefore = treeHashes(dataDir);
      const dry = await boot({ mode: "dry-run" });
      assert.deepEqual(dry.report.map((entry) => entry.status), ["would-apply", "would-apply"]);
      assert.equal(dry.byId[INVOICE_ROWS_BACKFILL_ID].summary.written, 6);
      assert.deepEqual(dry.byId[INVOICE_ROWS_BACKFILL_ID].waitingFor, [QUOTE_ROWS_BACKFILL_ID]);
      assert.deepEqual(dry.lines, []);
      assert.deepEqual(await rowCounts(db), { quotes: 0, quote_lines: 0, milestones: 0, invoices: 0, payments: 0, receipts: 0 });
      assert.deepEqual(await ledger(db), {});
      assert.deepEqual(treeHashes(dataDir), filesBefore);
    });
  });
}
