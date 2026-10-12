// Boots the real server and archives jobs whose quote was sent in their
// latest committed generation. Archive used to write meta.json and
// quote-lifecycle.json straight into that committed generation; the next read
// found it no longer matched its commit marker, quarantined it, and the job
// fell back to the previous generation: the sent quote read as a draft again.
// Both POST /api/jobs/:id/archive and POST /api/jobs/bulk-archive must keep
// the latest generation and add the archive stamp in a new one.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeFieldDb, getFieldDb, upsertJob } from "./field-db.js";
import { JOB_GENERATION_POINTER, JOB_GENERATIONS_DIR, runAtomicJobGeneration } from "./job-generation.js";

const ROOT = resolve(import.meta.dirname, "..");
const DATE_DIR = "2026-10-12";
const SENT_AT = `${DATE_DIR}T01:00:00.000Z`;
// Distinct first eight characters: findJob also matches on an id prefix.
const JOBS = {
  single: "5e1a2c00-0000-4000-8000-000000000001",
  bulk: "6f2b3d00-0000-4000-8000-000000000002",
};

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

function quoteJson(total) {
  return JSON.stringify({
    version: 1,
    currency: "AUD",
    lineItems: [{ code: "EX-01", label: "Excavation", quantity: 1 }],
    totals: { subtotal: total, gst: 0, total },
  }, null, 2);
}

// Two committed generations: g-000001 a draft quote for 100, g-000002 the
// same quote repriced to 200 and sent.
async function seedJobs(dataDir) {
  const db = getFieldDb(dataDir);
  try {
    for (const [name, id] of Object.entries(JOBS)) {
      const jobDir = join(dataDir, DATE_DIR, id);
      await mkdir(jobDir, { recursive: true });
      const meta = {
        id,
        createdAt: `${DATE_DIR}T00:00:00.000Z`,
        title: `Archive route — ${name}`,
        siteAddress: `1 ${name} St, Adelaide SA 5000`,
        outputMode: "quote",
        captureMode: "manual",
        status: "complete",
        audioFile: null,
        audioFiles: [],
        pipelineStage: "draft",
        quoteVersion: 1,
        quoteLineItemCount: 1,
      };
      await runAtomicJobGeneration(jobDir, async (stage) => {
        await writeFile(join(stage, "meta.json"), JSON.stringify(meta, null, 2));
        await writeFile(join(stage, "quote.json"), quoteJson(100));
      });
      await runAtomicJobGeneration(jobDir, async (stage) => {
        await writeFile(join(stage, "meta.json"), JSON.stringify({
          ...meta,
          pipelineStage: "sent",
          deliveryStatus: "sent",
          quoteSentAt: SENT_AT,
          lastSentQuoteVersion: 1,
        }, null, 2));
        await writeFile(join(stage, "quote.json"), quoteJson(200));
        await writeFile(join(stage, "quote-lifecycle.json"), JSON.stringify({
          version: 1,
          currentQuoteVersion: 1,
          currentPipelineStage: "sent",
          sendCount: 1,
          lastSentAt: SENT_AT,
          lastSentQuoteVersion: 1,
          buildReasons: {},
        }, null, 2));
      });
      upsertJob(db, { id, dateDir: DATE_DIR, dir: jobDir, title: meta.title, siteAddress: meta.siteAddress, createdAt: meta.createdAt });
    }
  } finally {
    closeFieldDb();
  }
}

async function bootServer(t) {
  const dir = await mkdtemp(join(tmpdir(), "field-job-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    authToken: "job-archive-test-service-key-0001",
    bootstrapUsers: [{ email: "owner@example.invalid", name: "Archive Owner", password: "archive-test-password" }],
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
    body: JSON.stringify({ email: "owner@example.invalid", password: "archive-test-password" }),
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

async function assertArchivedAndSent(api, dataDir, id, reason) {
  const detail = await api(`/api/jobs/${id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const { meta, quoteLifecycle } = detail.body;
  assert.ok(meta.archivedAt, `${id} reads as archived`);
  assert.equal(meta.archivedReason, reason);
  // The latest generation's content survived: still the sent quote.
  assert.equal(meta.pipelineStage, "sent", `${id} still sent`);
  assert.equal(meta.quoteSentAt, SENT_AT);
  assert.equal(quoteLifecycle.sendCount, 1);
  assert.ok(quoteLifecycle.archivedAt, `${id} lifecycle records the archive`);
  assert.equal(quoteLifecycle.archivedBeforeSend, false);
  // Nothing quarantined: the archive is a third generation on top of the
  // sent one, and it carries the repriced 200 quote. (The client view hides
  // this unattested test quote, so it is read from the generation itself.)
  const jobDir = join(dataDir, DATE_DIR, id);
  const generations = (await readdir(join(jobDir, JOB_GENERATIONS_DIR))).sort();
  assert.deepEqual(generations, ["g-000001", "g-000002", "g-000003"], `${id} generations: ${generations.join(" ")}`);
  const pointer = JSON.parse(await readFile(join(jobDir, JOB_GENERATION_POINTER), "utf8"));
  assert.equal(pointer.generationId, "g-000003");
  const quote = JSON.parse(await readFile(join(jobDir, JOB_GENERATIONS_DIR, "g-000003", "quote.json"), "utf8"));
  assert.equal(quote.totals.total, 200, `${id} keeps the latest quote`);
}

test("archiving a sent job keeps its latest generation and reads as archived", async (t) => {
  const { api, dataDir, output } = await bootServer(t);

  const archived = await api(`/api/jobs/${JOBS.single}/archive`, { method: "POST", body: { reason: "Customer went elsewhere" } });
  assert.equal(archived.status, 200, `${JSON.stringify(archived.body)}\n${output.join("")}`);
  assert.ok(archived.body.detail.meta.archivedAt);
  assert.equal(archived.body.detail.meta.pipelineStage, "sent");
  await assertArchivedAndSent(api, dataDir, JOBS.single, "Customer went elsewhere");

  const bulk = await api("/api/jobs/bulk-archive", { method: "POST", body: { ids: [JOBS.bulk], reason: "Season closed" } });
  assert.deepEqual(bulk, { status: 200, body: { ok: true, results: [{ id: JOBS.bulk, ok: true }] } });
  await assertArchivedAndSent(api, dataDir, JOBS.bulk, "Season closed");

  // A second read still sees the same generation: nothing was left invalid.
  await assertArchivedAndSent(api, dataDir, JOBS.single, "Customer went elsewhere");
});
