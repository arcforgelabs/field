import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { JOB_GENERATIONS_DIR, resolveActiveJobGeneration, runAtomicJobGeneration } from "../server/job-generation.js";

const SCRIPT = resolve(import.meta.dirname, "find-quarantined-generations.js");

async function treeDigest(root) {
  const lines = [];
  const walk = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`d ${relative(root, path)}`);
        await walk(path);
      } else {
        const info = await stat(path);
        lines.push(`f ${relative(root, path)} ${info.mtimeMs} ${createHash("sha256").update(await readFile(path)).digest("hex")}`);
      }
    }
  };
  await walk(root);
  return lines.join("\n");
}

test("lists quarantined and missing committed generations without changing the data directory", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-find-quarantined-"));
  try {
    const jobDir = join(dataDir, "2026-10-12", "job-hit");
    await mkdir(jobDir, { recursive: true });
    const meta = { id: "job-hit", title: "Hit by #224", pipelineStage: "draft" };
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify(meta));
      await writeFile(join(stage, "quote.json"), JSON.stringify({ version: 1, totals: { total: 100 } }));
    });
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify({ ...meta, pipelineStage: "sent", quoteSentAt: "2026-10-12T01:00:00.000Z" }));
      await writeFile(join(stage, "quote.json"), JSON.stringify({ version: 1, totals: { total: 200 } }));
    });
    // What the archive route did before #224: meta written into the
    // committed generation, which the next read quarantines.
    const active = await resolveActiveJobGeneration(jobDir);
    await writeFile(join(active, "meta.json"), JSON.stringify({ ...meta, pipelineStage: "sent", archivedAt: "2026-10-12T02:00:00.000Z" }));
    await resolveActiveJobGeneration(jobDir);
    // A healthy job is not reported.
    const healthy = join(dataDir, "2026-10-12", "job-ok");
    await mkdir(healthy, { recursive: true });
    await runAtomicJobGeneration(healthy, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify({ id: "job-ok" }));
    });

    const before = await treeDigest(dataDir);
    const report = JSON.parse(execFileSync(process.execPath, [SCRIPT, dataDir, "--json"], { encoding: "utf8" }));
    assert.equal(await treeDigest(dataDir), before, "the diagnostic is read-only");

    assert.equal(report.jobsAffected, 1);
    const [job] = report.jobs;
    assert.equal(job.job, join("2026-10-12", "job-hit"));
    assert.equal(job.jobId, "job-hit");
    assert.equal(job.active, "g-000001");
    assert.equal(job.quarantined.length, 1);
    const [lost] = job.quarantined;
    assert.equal(lost.generationId, "g-000002");
    assert.deepEqual(lost.drift, { changed: ["meta.json"], added: [], removed: [] });
    assert.notEqual(lost.metaSha256.now, lost.metaSha256.committed);
    assert.equal(lost.quoteSha256.now, lost.quoteSha256.committed);
    assert.equal(lost.held.quoteTotal, 200);
    assert.equal(lost.held.archivedAt, "2026-10-12T02:00:00.000Z");
    assert.deepEqual(job.missingCommitted, []);

    // Durable storage never stores the quarantined directory: after a
    // restart only the commit history remembers the generation.
    const [quarantineDir] = (await readdir(join(jobDir, JOB_GENERATIONS_DIR))).filter((name) => name.startsWith(".quarantine-"));
    await rm(join(jobDir, JOB_GENERATIONS_DIR, quarantineDir), { recursive: true });
    const afterRestart = JSON.parse(execFileSync(process.execPath, [SCRIPT, dataDir, "--json"], { encoding: "utf8" }));
    assert.equal(afterRestart.jobsAffected, 1);
    assert.deepEqual(afterRestart.jobs[0].quarantined, []);
    assert.deepEqual(afterRestart.jobs[0].missingCommitted.map((entry) => entry.generationId), ["g-000002"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
