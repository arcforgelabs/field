// Boots the real server over a data directory whose field.db job index
// disagrees with the job folders, and checks GET /api/jobs lists every job
// (#32): a job whose meta.json lives only in a committed generation and was
// never indexed, an archived job that was never indexed, and a job whose
// folder was renamed after it was indexed. A folder renamed while the server
// runs is listed too, and a deleted job stays gone, across a restart as well.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { closeFieldDb, getFieldDb, upsertJob } from "./field-db.js";
import { runAtomicJobGeneration } from "./job-generation.js";

const ROOT = resolve(import.meta.dirname, "..");
const DATE_DIR = "2026-04-14";
// Distinct first eight characters: findJob also matches on an id prefix.
const JOBS = {
  indexed: "1e0a0001-0000-4000-8000-000000000001",
  generationOnly: "2e0a0002-0000-4000-8000-000000000002",
  archived: "3e0a0003-0000-4000-8000-000000000003",
  renamed: "4e0a0004-0000-4000-8000-000000000004",
  fresh: "5e0a0005-0000-4000-8000-000000000005",
};
const RENAMED_FOLDER = `driveway-retaining-wall--${JOBS.renamed.slice(0, 8)}`;

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

function jobMeta(name, id) {
  return {
    id,
    createdAt: `${DATE_DIR}T00:00:00.000Z`,
    title: `General Site Works — ${name}`,
    siteAddress: `1 ${name} St, Adelaide SA 5000`,
    outputMode: "quote",
    captureMode: "manual",
    status: "complete",
    audioFile: null,
    audioFiles: [],
    pipelineStage: "draft",
    quoteVersion: 1,
    quoteLineItemCount: 0,
    ...(name === "archived" ? { archivedAt: `${DATE_DIR}T02:00:00.000Z`, archivedReason: "Customer went elsewhere" } : {}),
  };
}

const EMPTY_QUOTE = JSON.stringify({ version: 1, currency: "AUD", lineItems: [], totals: { subtotal: 0, gst: 0, total: 0 } }, null, 2);

async function seedJobs(dataDir) {
  const day = join(dataDir, DATE_DIR);
  const db = getFieldDb(dataDir);
  try {
    for (const [name, id] of Object.entries(JOBS)) {
      const meta = jobMeta(name, id);
      const jobDir = join(day, name === "renamed" ? RENAMED_FOLDER : id);
      await mkdir(jobDir, { recursive: true });
      if (name === "generationOnly") {
        await runAtomicJobGeneration(jobDir, async (stage) => {
          await writeFile(join(stage, "meta.json"), JSON.stringify(meta, null, 2));
          await writeFile(join(stage, "quote.json"), EMPTY_QUOTE);
        }, { flush: false });
        // Only the committed generation holds the job's meta.json.
        await rm(join(jobDir, "meta.json"));
        await rm(join(jobDir, "quote.json"));
      } else {
        await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
        await writeFile(join(jobDir, "quote.json"), EMPTY_QUOTE);
      }
      // The index knows three jobs; "renamed" under the folder it was created
      // in, before the folder was renamed. The other two were never indexed.
      if (name === "generationOnly" || name === "archived") continue;
      upsertJob(db, { id, dateDir: DATE_DIR, dir: join(day, id), title: meta.title, siteAddress: meta.siteAddress, createdAt: meta.createdAt });
    }
  } finally {
    closeFieldDb();
  }
}

async function bootServer(t, dir) {
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    authToken: "job-list-index-test-service-key-0001",
    bootstrapUsers: [{ email: "owner@example.invalid", name: "Index Owner", password: "index-test-password" }],
  }));
  const port = await freePort();
  const output = [];
  const dataDir = join(dir, "data");
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
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  };
  t.after(stop);
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
    body: JSON.stringify({ email: "owner@example.invalid", password: "index-test-password" }),
  });
  const { token } = await login.json();
  assert.ok(token, `sign-in failed:\n${output.join("")}`);
  const api = async (path, { method = "GET" } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { api, dataDir, output, stop };
}

function jobRows(dataDir) {
  const db = new Database(join(dataDir, "field.db"), { readonly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT id, dir FROM jobs").all().map((row) => [row.id, row.dir]));
  } finally {
    db.close();
  }
}

async function listedIds(api) {
  const listed = await api("/api/jobs");
  assert.equal(listed.status, 200);
  return listed.body.map((job) => job.id).sort();
}

test("the job list shows every job on disk, whatever the index held, and never a deleted one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "field-job-list-index-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "data"), { recursive: true });
  await seedJobs(join(dir, "data"));

  const first = await bootServer(t, dir);
  const { api, dataDir } = first;
  const day = join(dataDir, DATE_DIR);
  assert.deepEqual(await listedIds(api), Object.values(JOBS).sort(), first.output.join(""));
  const listed = new Map((await api("/api/jobs")).body.map((job) => [job.id, job]));
  assert.equal(listed.get(JOBS.archived).archivedAt, `${DATE_DIR}T02:00:00.000Z`, "an archived job is listed as archived, as before");
  assert.equal(listed.get(JOBS.generationOnly).title, "General Site Works — generationOnly");
  const rows = jobRows(dataDir);
  assert.equal(rows[JOBS.renamed], join(day, RENAMED_FOLDER), "boot repointed the renamed folder");
  assert.equal(rows[JOBS.generationOnly], join(day, JOBS.generationOnly));

  // A folder that moves while the server runs: the list notices the row's
  // folder is gone, reconciles, and still lists the job.
  const movedFolder = join(day, `site-cleanup--${JOBS.indexed.slice(0, 8)}`);
  await rename(join(day, JOBS.indexed), movedFolder);
  assert.deepEqual(await listedIds(api), Object.values(JOBS).sort());
  assert.equal(jobRows(dataDir)[JOBS.indexed], movedFolder);

  // A deleted job leaves the list and the index, and stays gone.
  assert.deepEqual(await api(`/api/jobs/${JOBS.fresh}`, { method: "DELETE" }), { status: 200, body: { ok: true } });
  const remaining = Object.values(JOBS).filter((id) => id !== JOBS.fresh).sort();
  assert.deepEqual(await listedIds(api), remaining);
  assert.ok(!(JOBS.fresh in jobRows(dataDir)));
  assert.equal((await api(`/api/jobs/${JOBS.fresh}`)).status, 404);

  // A restart reconciles again and changes nothing.
  await first.stop();
  const second = await bootServer(t, dir);
  assert.deepEqual(await listedIds(second.api), remaining, second.output.join(""));
  assert.ok(!(JOBS.fresh in jobRows(dataDir)));
});
