// GET /api/admin/data-migrations/dry-run (#36).
//
// The handler: one dry run at a time (409), a time limit that stops the run
// at its next job (504), a failed verification answered as ok: false.
//
// The real server, on a fixture data directory (synthetic jobs built by the
// milestone actions) and a seeded PGlite database, booted with
// FIELD_DATA_MIGRATIONS_HOLD=all: the route refuses callers without a token
// (401) and non-admins (403); for an admin it reports what every pending
// migration would do, with ids and numbers only, and writes nothing (no rows,
// no ledger, every job file byte-identical). Then a boot without the hold
// backfills the jobs, logging one line per migration, and the route reports
// them as applied.
//
// A refused invoice shows its unmappable code (no-issue-time) and number, and
// issue times taken from evidence show as counts by source.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import express from "express";
import { sql } from "drizzle-orm";
import { closeDb, createTestDb, getDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createAprilMilestoneJob, scenarios } from "../invoices/test-fixtures.js";
import { createDataMigrationDryRunHandler, DRY_RUN_PATH } from "./dry-run-route.js";
import { DataMigrationError } from "./errors.js";
import { runDataMigrations } from "./index.js";
import { INVOICE_ROWS_BACKFILL_ID, invoiceRowsBackfill, QUOTE_ROWS_BACKFILL_ID, quoteRowsBackfill } from "./row-backfills.js";

const ROOT = resolve(import.meta.dirname, "../..");
const quiet = { log() {}, warn() {}, error() {} };

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function serve(t, handler) {
  const app = express();
  app.get(DRY_RUN_PATH, handler);
  const server = await new Promise((resolveServer) => { const s = app.listen(0, "127.0.0.1", () => resolveServer(s)); });
  t.after(() => new Promise((done) => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}${DRY_RUN_PATH}`;
  return async () => {
    const response = await fetch(url);
    return { status: response.status, body: await response.json() };
  };
}

test("one dry run at a time; a second caller gets 409 until the first ends", async (t) => {
  let release = null;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const call = await serve(t, createDataMigrationDryRunHandler({
    run: async () => { await gate; return [{ id: "m1", status: "would-apply", summary: { changed: 2 } }]; },
    logger: quiet,
  }));
  const first = call();
  await new Promise((wake) => setTimeout(wake, 50));
  const second = await call();
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "DATA_MIGRATION_DRY_RUN_RUNNING");
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.migrations, [{ id: "m1", status: "would-apply", summary: { changed: 2 } }]);
  assert.equal((await call()).status, 200, "the next one may run once it has ended");
});

test("a run past its time limit answers 504, is told to stop, and frees the route once it has", async (t) => {
  let stopped = null;
  const call = await serve(t, createDataMigrationDryRunHandler({
    timeoutMs: 50,
    run: ({ signal }) => new Promise((_, reject) => {
      // Stands in for a migration that checks the signal between jobs.
      const tick = setInterval(() => {
        if (signal.aborted) {
          clearInterval(tick);
          stopped = Date.now();
          reject(new Error("stopped"));
        }
      }, 10);
    }),
    logger: quiet,
  }));
  const late = await call();
  assert.equal(late.status, 504);
  assert.equal(late.body.code, "DATA_MIGRATION_DRY_RUN_TIMEOUT");
  assert.equal(late.body.wroteNothing, true);
  await new Promise((wake) => setTimeout(wake, 50));
  assert.ok(stopped, "the run was aborted");
  assert.equal((await call()).status, 504, "a new run could start");
});

test("a failed verification is ok: false with the migration and a count, never the failures' text", async (t) => {
  const call = await serve(t, createDataMigrationDryRunHandler({
    run: async () => { throw new DataMigrationError("2026-10-12-quote-rows-by-uid: verification failed, nothing written: 2026-01-15/job/quote.json: ...", { details: { failures: ["a", "b"] } }); },
    logger: quiet,
  }));
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.deepEqual(body.verificationFailed, { migration: "2026-10-12-quote-rows-by-uid", failures: 2 });
  assert.equal(body.ok, false);
});

test("a refused invoice shows its code and number; one mapped from evidence shows the source's count; never the reason's text", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "field-dry-run-codes-"));
  const handle = await createTestDb();
  t.after(async () => {
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await createAprilMilestoneJob(dataDir, { id: "job-april-none", number: "2604-83", withPdf: false });
  await createAprilMilestoneJob(dataDir, { id: "job-april-pdf", number: "2604-84" });
  const call = await serve(t, createDataMigrationDryRunHandler({
    run: ({ signal }) => runDataMigrations({ db: handle.db, orgUid: DEFAULT_ORG_UID, dataDir, migrations: [quoteRowsBackfill, invoiceRowsBackfill], mode: "dry-run", logger: quiet, signal }),
    logger: quiet,
  }));
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  const invoices = body.migrations.find((entry) => entry.id === INVOICE_ROWS_BACKFILL_ID);
  assert.equal(invoices.status, "would-refuse");
  assert.deepEqual(invoices.refused, [{
    jobId: "job-april-none",
    mismatches: [0, 1, 2].map((milestone) => ({ kind: "unmappable", code: "no-issue-time", number: `EI-2604-83-M${milestone + 1}`, milestone })),
  }]);
  assert.deepEqual(invoices.summary.issueTimesFromEvidence, { "stored-pdf-date": 3 });
  assert.equal(JSON.stringify(body).includes("has no issue time"), false, "no reason text");
});

function jobFileHashes(dataDir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[relative(dataDir, abs)] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(join(dataDir, "2026-05-01"));
  return out;
}

async function startField(t, { dir, env, output }) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...env, FIELD_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  t.after(stop);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output.join("")}`);
    try {
      if ((await fetch(`${base}/health`)).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${output.join("")}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
  const login = async (email, password) => {
    const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const { token } = await response.json();
    assert.ok(token, `sign-in failed for ${email}:\n${output.join("")}`);
    return token;
  };
  const dryRun = async (token) => {
    const response = await fetch(`${base}${DRY_RUN_PATH}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  return { login, dryRun, stop, dir };
}

async function rowsAndLedger(pgliteDir) {
  try {
    const db = getDb({ env: { FIELD_PGLITE_DIR: pgliteDir } });
    const [counts] = await withOrg(db, DEFAULT_ORG_UID, (tx) => queryRows(sql`
      select (select count(*) from quotes)::int as quotes,
             (select count(*) from invoices)::int as invoices,
             (select count(*) from payments)::int as payments,
             (select count(*) from data_migrations)::int as recorded`, tx));
    return counts;
  } finally {
    await closeDb();
  }
}

test("the route in the real server: admins only, ids and numbers only, writes nothing; boot then backfills", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "field-dry-run-route-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "data");
  const pgliteDir = join(dir, "pglite");
  const configPath = join(dir, "config.json");
  const env = { PATH: process.env.PATH, HOME: dir, FIELD_CONFIG: configPath, FIELD_DATA: dataDir, FIELD_PGLITE_DIR: pgliteDir };
  execFileSync(process.execPath, ["scripts/quote-invoice-proof/seed.mjs", ROOT, dataDir], { cwd: ROOT, env, stdio: "ignore" });
  for (const name of Object.keys(scenarios)) await scenarios[name](dataDir);
  writeFileSync(configPath, JSON.stringify({
    authToken: "dry-run-route-installation-token",
    quoteCatalogId: "field-verification",
    bootstrapUsers: [
      { email: "owner@example.invalid", name: "Route Owner", password: "route-owner-password", role: "admin" },
      { email: "crew@example.invalid", name: "Route Crew", password: "route-crew-password", role: "user" },
    ],
  }));
  const filesBefore = jobFileHashes(dataDir);

  // Published with the hold on: nothing ran at boot.
  const heldOutput = [];
  const held = await startField(t, { dir, env: { ...env, FIELD_DATA_MIGRATIONS_HOLD: "all" }, output: heldOutput });
  assert.match(heldOutput.join(""), new RegExp(`${QUOTE_ROWS_BACKFILL_ID} held by FIELD_DATA_MIGRATIONS_HOLD`));
  const owner = await held.login("owner@example.invalid", "route-owner-password");
  const crew = await held.login("crew@example.invalid", "route-crew-password");
  assert.equal((await held.dryRun(null)).status, 401);
  const refused = await held.dryRun(crew);
  assert.equal(refused.status, 403, "a signed-in non-admin is refused");

  const { status, body, text } = await held.dryRun(owner);
  assert.equal(status, 200, text);
  assert.equal(body.ok, true);
  assert.equal(body.wroteNothing, true);
  const byId = Object.fromEntries(body.migrations.map((entry) => [entry.id, entry]));
  assert.deepEqual(body.migrations.map((entry) => entry.id), ["2026-10-12-quote-rows-by-uid", "2026-10-12-price-book-cleanup", QUOTE_ROWS_BACKFILL_ID, INVOICE_ROWS_BACKFILL_ID]);
  assert.equal(byId[QUOTE_ROWS_BACKFILL_ID].status, "would-apply");
  assert.equal(byId[QUOTE_ROWS_BACKFILL_ID].summary.jobs, 7);
  assert.equal(byId[QUOTE_ROWS_BACKFILL_ID].summary.refusedJobs, 0);
  assert.equal(byId[INVOICE_ROWS_BACKFILL_ID].status, "would-apply");
  assert.deepEqual([byId[INVOICE_ROWS_BACKFILL_ID].summary.jobsWithMilestones, byId[INVOICE_ROWS_BACKFILL_ID].summary.written], [7, 7]);
  assert.deepEqual(byId[INVOICE_ROWS_BACKFILL_ID].waitingFor, [QUOTE_ROWS_BACKFILL_ID]);
  for (const customerText of ["Sam Customer", "Synthetic job", "customer@example.invalid", "Driveway", "Retaining wall"]) {
    assert.equal(text.includes(customerText), false, `no customer text in the answer (${customerText})`);
  }
  assert.equal((await held.dryRun(owner)).status, 200, "it can run again");
  await held.stop();
  assert.deepEqual(await rowsAndLedger(pgliteDir), { quotes: 0, invoices: 0, payments: 0, recorded: 0 }, "the dry run wrote no rows and recorded nothing");
  assert.deepEqual(jobFileHashes(dataDir), filesBefore, "and no job file changed");

  // The hold removed: boot backfills, one log line per migration.
  const bootOutput = [];
  const released = await startField(t, { dir, env, output: bootOutput });
  const log = bootOutput.join("");
  assert.match(log, new RegExp(`\\[data-migrations\\] ${QUOTE_ROWS_BACKFILL_ID}: applied \\(7 job\\(s\\), \\d+ quote version\\(s\\): \\d+ written, 0 already present, 0 job\\(s\\) refused; \\d+ warning\\(s\\)\\); recorded`));
  assert.match(log, new RegExp(`\\[data-migrations\\] ${INVOICE_ROWS_BACKFILL_ID}: applied \\(7 job\\(s\\) with milestones, 14 invoice\\(s\\): 7 job\\(s\\) written, 0 already present, 0 job\\(s\\) refused; \\d+ warning\\(s\\)\\); recorded`));
  const after = await released.dryRun(await released.login("owner@example.invalid", "route-owner-password"));
  assert.equal(after.status, 200, after.text);
  const statuses = Object.fromEntries(after.body.migrations.map((entry) => [entry.id, entry.status]));
  assert.equal(statuses[QUOTE_ROWS_BACKFILL_ID], "already-applied");
  assert.equal(statuses[INVOICE_ROWS_BACKFILL_ID], "already-applied");
  await released.stop();
  const counts = await rowsAndLedger(pgliteDir);
  assert.equal(counts.invoices, 14);
  assert.ok(counts.quotes >= 6);
  assert.deepEqual(jobFileHashes(dataDir), filesBefore, "the backfills wrote rows only");
});
