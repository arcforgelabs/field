// scripts/backfill-db.js: mapping synthetic job folders to the legacy
// migrations/0001_initial.sql schema, applied to an in-process PGlite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const SCRIPT = fileURLToPath(new URL("./backfill-db.js", import.meta.url));

const dirs = [];
function tempDir() {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), "field-backfill-db-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) nodeFs.rmSync(dir, { recursive: true, force: true });
});

function write(root, rel, value) {
  const path = join(root, ...rel.split("/"));
  nodeFs.mkdirSync(join(path, ".."), { recursive: true });
  nodeFs.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

// Two synthetic jobs: a quote job with a gap, activity and two quote versions,
// and a report job with only meta.json.
function writeSyntheticData(root) {
  write(root, "jobs/job-a/meta.json", {
    id: "job-a",
    title: "Synthetic driveway",
    outputMode: "quote",
    status: "quoted",
    jobNumber: "T-0001",
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  write(root, "jobs/job-a/quote.json", { version: 2, generatedAt: "2026-01-03T00:00:00.000Z", total: 1100 });
  write(root, "jobs/job-a/quote-versions/v1/quote.json", { version: 1, generatedAt: "2026-01-02T05:00:00.000Z", total: 1000 });
  write(root, "jobs/job-a/quote-versions/v2/quote.json", { version: 2, generatedAt: "2026-01-03T00:00:00.000Z", total: 1100 });
  write(root, "jobs/job-a/job-state/details.json", {
    siteAddress: "1 Example Street",
    customer: { name: "Example Customer" },
  });
  write(root, "jobs/job-a/job-state/gaps.json", [{ id: "g1", key: "site-access", title: "Site access", status: "open" }]);
  write(root, "jobs/job-a/job-state/activity.jsonl", `${JSON.stringify({ type: "job.created", at: "2026-01-02T03:04:05.000Z" })}\n`);
  write(root, "jobs/job-b/meta.json", { id: "job-b", title: "Synthetic report", createdAt: "2026-02-01T00:00:00.000Z" });
}

function runScript(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function count(db, table) {
  const { rows } = await db.query(`select count(*)::int as n from ${table}`);
  return rows[0].n;
}

test("backfill-db prints a summary of the mapped job folders", () => {
  const root = tempDir();
  writeSyntheticData(root);

  const stdout = runScript(["--source-root", root]);

  assert.match(stdout, /Recordings mapped: 2/);
  assert.match(stdout, /- jobs: 2/);
  assert.match(stdout, /- quote_versions: 2/);
  assert.match(stdout, /- gaps: 1/);
});

test("backfill-db SQL with --include-schema applies to an empty database, and again without duplicating rows", async () => {
  const root = tempDir();
  writeSyntheticData(root);
  const sqlPath = join(tempDir(), "backfill.sql");

  runScript(["--source-root", root, "--include-schema", "--seed-backup-jobs", "--emit-sql", sqlPath]);
  const sql = nodeFs.readFileSync(sqlPath, "utf8");

  const db = await PGlite.create({ extensions: { pgcrypto } });
  try {
    await db.exec(sql);
    const first = {
      jobs: await count(db, "jobs"),
      job_details: await count(db, "job_details"),
      captures: await count(db, "captures"),
      quotes: await count(db, "quotes"),
      quote_versions: await count(db, "quote_versions"),
      gaps: await count(db, "gaps"),
      timeline_events: await count(db, "timeline_events"),
      storage_objects: await count(db, "storage_objects"),
      backup_jobs: await count(db, "backup_jobs"),
    };
    assert.equal(first.jobs, 2);
    assert.equal(first.job_details, 2);
    assert.equal(first.captures, 2);
    assert.equal(first.quotes, 1);
    assert.equal(first.quote_versions, 2);
    assert.equal(first.gaps, 1);
    assert.ok(first.timeline_events >= 1);
    assert.ok(first.storage_objects >= 1);
    assert.ok(first.backup_jobs >= 1 && first.backup_jobs <= first.storage_objects);

    const { rows } = await db.query("select legacy_recording_id, output_mode, job_number from jobs order by legacy_recording_id");
    assert.deepEqual(rows, [
      { legacy_recording_id: "job-a", output_mode: "quote", job_number: "T-0001" },
      { legacy_recording_id: "job-b", output_mode: "report", job_number: null },
    ]);

    // Upserts on stable keys: a second import changes no row counts.
    await db.exec(sql);
    for (const [table, n] of Object.entries(first)) {
      assert.equal(await count(db, table), n, table);
    }
  } finally {
    await db.close();
  }
});
