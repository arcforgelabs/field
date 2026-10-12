// Boots the real server and drives the job delete routes end to end: a fresh
// job can be deleted (and leaves no row in field.db), a sent job and a job
// someone wrote a note on are refused with their reasons, and bulk delete deletes only the jobs
// that may be deleted. The jobs are seeded on disk as the New Job sheet leaves
// them (an empty v1 quote plus the automatic system note), because building a
// quote through the API needs a priced catalogue this test does not have.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { SYSTEM_REBUILD_NOTE_AUTHOR, SYSTEM_REBUILD_NOTE_TITLE } from "./clarification-notes.js";
import { closeFieldDb, getFieldDb, insertNote, replaceNote, upsertJob } from "./field-db.js";

const ROOT = resolve(import.meta.dirname, "..");

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

const DATE_DIR = "2026-10-11";
// Distinct first eight characters: findJob also matches on an id prefix.
const JOBS = {
  fresh: "1a5f1a10-0000-4000-8000-000000000001",
  noted: "2b5f1a10-0000-4000-8000-000000000002",
  bulkFresh: "3c5f1a10-0000-4000-8000-000000000003",
  sent: "4d5f1a10-0000-4000-8000-000000000004",
};

async function seedJobs(dataDir) {
  const db = getFieldDb(dataDir);
  try {
    for (const [name, id] of Object.entries(JOBS)) {
      const jobDir = join(dataDir, DATE_DIR, id);
      await mkdir(jobDir, { recursive: true });
      const sent = name === "sent";
      const meta = {
        id,
        createdAt: `${DATE_DIR}T00:00:00.000Z`,
        title: `General Site Works — ${name}`,
        siteAddress: `1 ${name} St, Adelaide SA 5000`,
        outputMode: "quote",
        captureMode: "manual",
        status: "complete",
        audioFile: null,
        audioFiles: [],
        pipelineStage: sent ? "sent" : "draft",
        quoteVersion: 1,
        quoteLineItemCount: sent ? 1 : 0,
        ...(sent ? { quoteSentAt: `${DATE_DIR}T01:00:00.000Z`, lastSentQuoteVersion: 1 } : {}),
      };
      await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
      await writeFile(join(jobDir, "quote.json"), JSON.stringify({
        version: 1,
        currency: "AUD",
        lineItems: sent ? [{ code: "EX-01", label: "Excavation", quantity: 1 }] : [],
        totals: { subtotal: 0, gst: 0, total: 0 },
      }, null, 2));
      upsertJob(db, { id, dateDir: DATE_DIR, dir: jobDir, title: meta.title, siteAddress: meta.siteAddress, createdAt: meta.createdAt });
      replaceNote(db, {
        jobId: id,
        text: "Quote v001 rebuilt.",
        title: SYSTEM_REBUILD_NOTE_TITLE,
        author: SYSTEM_REBUILD_NOTE_AUTHOR,
        surface: "breakdown",
        layer: "L6",
        version: "1",
      });
      if (name === "noted") {
        // A note someone wrote, stored the way POST /api/jobs/:id/notes stores it.
        insertNote(db, { id: `note-${id}`, jobId: id, text: "Customer wants the driveway widened", author: "Sam" });
      }
    }
  } finally {
    closeFieldDb();
  }
}

async function bootServer(t) {
  const dir = await mkdtemp(join(tmpdir(), "field-job-delete-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    authToken: "job-delete-test-service-key-0001",
    bootstrapUsers: [{ email: "owner@example.invalid", name: "Delete Owner", password: "delete-test-password" }],
  }));
  const port = await freePort();
  const output = [];
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  await seedJobs(dataDir);
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FIELD_CONFIG: configPath,
      FIELD_DATA: dataDir,
      FIELD_PORT: String(port),
      FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output.join("")}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${output.join("")}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.invalid", password: "delete-test-password" }),
  });
  const { token } = await login.json();
  assert.ok(token, `sign-in failed:\n${output.join("")}`);
  const api = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { api, dataDir, output };
}

function jobRowIds(dataDir) {
  const db = new Database(join(dataDir, "field.db"), { readonly: true });
  try {
    return db.prepare("SELECT id FROM jobs").all().map((row) => row.id);
  } finally {
    db.close();
  }
}

test("only untouched jobs can be deleted; the rest are kept with reasons", async (t) => {
  const { api, dataDir } = await bootServer(t);

  const { fresh: freshId, noted: notedId, bulkFresh: bulkFreshId, sent: sentId } = JOBS;

  // A fresh job (title, address and the automatic system note only) is
  // deletable; a sent job is not.
  const listed = await api("/api/jobs");
  assert.equal(listed.status, 200);
  const byId = new Map(listed.body.map((job) => [job.id, job]));
  for (const id of [freshId, bulkFreshId]) assert.equal(byId.get(id)?.deletable, true, id);
  for (const id of [notedId, sentId]) assert.equal(byId.get(id)?.deletable, false, id);
  const freshDetail = await api(`/api/jobs/${freshId}`);
  assert.equal(freshDetail.status, 200, JSON.stringify(freshDetail.body));
  assert.deepEqual(freshDetail.body.deletion, { deletable: true, reasons: [], codes: [] });

  const sentRefused = await api(`/api/jobs/${sentId}`, { method: "DELETE" });
  assert.equal(sentRefused.status, 409);
  assert.deepEqual(sentRefused.body.reasons, [
    "It is marked Sent, not Draft.",
    "A quote was sent to the customer.",
    "The quote has 1 line item.",
  ]);

  // A note someone wrote keeps the job.
  const refused = await api(`/api/jobs/${notedId}`, { method: "DELETE" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Archive it instead/);
  assert.deepEqual(refused.body.reasons, ["It has 1 note written by someone."]);
  assert.equal((await api(`/api/jobs/${notedId}`)).status, 200, "a refused job is kept");

  // The fresh job deletes, and its field.db row goes with it.
  const deleted = await api(`/api/jobs/${freshId}`, { method: "DELETE" });
  assert.deepEqual(deleted, { status: 200, body: { ok: true } });
  assert.equal((await api(`/api/jobs/${freshId}`)).status, 404);
  assert.ok(!jobRowIds(dataDir).includes(freshId), "deleted job row removed from field.db");

  // Bulk delete deletes the deletable job and reports the kept one.
  const bulk = await api("/api/jobs/bulk-delete", { method: "POST", body: { ids: [bulkFreshId, notedId, "no-such-job"] } });
  assert.equal(bulk.status, 200);
  assert.deepEqual(bulk.body.results[0], { id: bulkFreshId, ok: true });
  assert.equal(bulk.body.results[1].id, notedId);
  assert.equal(bulk.body.results[1].ok, false);
  assert.deepEqual(bulk.body.results[1].reasons, ["It has 1 note written by someone."]);
  assert.deepEqual(bulk.body.results[2], { id: "no-such-job", ok: false, error: "not found" });

  const remaining = (await api("/api/jobs")).body.map((job) => job.id).sort();
  assert.deepEqual(remaining, [notedId, sentId]);
  assert.deepEqual(jobRowIds(dataDir).sort(), [notedId, sentId]);
});
