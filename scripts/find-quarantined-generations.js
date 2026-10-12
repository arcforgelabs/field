#!/usr/bin/env node
// Read-only diagnostic: which jobs lost a committed job generation?
//
//   node scripts/find-quarantined-generations.js <dataDir> [--json]
//
// Until archiving was fixed to write a new generation, archiving a job (and a
// few other paths) wrote meta.json and quote-lifecycle.json straight into the
// job's committed generation. The next read found the generation no longer
// matched its commit marker, renamed it to
// .field-generations/.quarantine-g-NNNNNN-<uuid>, and the job silently fell
// back to the previous generation. This script lists, per job:
//
//   - quarantined: every .quarantine-g-* directory still on disk, with its
//     generation id, its commit marker (commitId, committedAt), which files no
//     longer match the marker (the archive signature is meta.json and/or
//     quote-lifecycle.json), sha256 of meta.json and quote.json as they are now
//     and as committed, and the quote/sent state the generation held;
//   - missingCommitted: generations the job's commit history records as
//     committed whose directory is gone. With FIELD_STORAGE=postgres the
//     quarantined directory is never stored and its rows are deleted from
//     field_files, so after a restart or republish only this record remains;
//   - active: the generation the pointer names now.
//
// It never writes: no pointer repair, no quarantine, no storage flush. It uses
// plain node:fs, not Field's storage shim, and loads no server module.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";

const GENERATIONS_DIR = ".field-generations";
const POINTER = ".field-generation-pointer.json";
const HISTORY = ".field-generation-history.json";
const COMMIT_MARKER = ".field-generation-commit.json";
const QUARANTINE = /^\.quarantine-(g-\d{6,})-(.+)$/;
const SKIP_DIRS = new Set(["node_modules", "pglite", ".git", GENERATIONS_DIR]);
const MAX_DEPTH = 6;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sha256File(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function listFiles(dir, root = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path, root));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files;
}

// Files whose bytes differ from the commit marker, plus files added or removed.
function manifestDrift(generationDir, marker) {
  if (!Array.isArray(marker?.files)) return null;
  const expected = new Map(marker.files.map((entry) => [entry.path, entry.sha256]));
  const actual = listFiles(generationDir).filter((path) => path !== COMMIT_MARKER);
  const changed = [];
  const added = [];
  for (const path of actual) {
    if (!expected.has(path)) added.push(path);
    else if (sha256File(join(generationDir, path)) !== String(expected.get(path)).toLowerCase()) changed.push(path);
  }
  const removed = [...expected.keys()].filter((path) => !actual.includes(path));
  return { changed, added, removed };
}

function quoteState(generationDir) {
  const meta = readJson(join(generationDir, "meta.json"));
  const quote = readJson(join(generationDir, "quote.json"));
  const lifecycle = readJson(join(generationDir, "quote-lifecycle.json"));
  return {
    pipelineStage: meta?.pipelineStage ?? null,
    quoteSentAt: meta?.quoteSentAt ?? null,
    archivedAt: meta?.archivedAt ?? null,
    quoteVersion: quote?.version ?? meta?.quoteVersion ?? null,
    quoteTotal: quote?.totals?.total ?? null,
    lifecycleSendCount: lifecycle?.sendCount ?? null,
    issuedDocuments: existsSync(join(generationDir, "issued-documents")),
  };
}

function describeQuarantined(jobDir, name) {
  const [, generationId, suffix] = QUARANTINE.exec(name);
  const dir = join(jobDir, GENERATIONS_DIR, name);
  const marker = readJson(join(dir, COMMIT_MARKER));
  const committedHash = (path) => marker?.files?.find((entry) => entry.path === path)?.sha256 || null;
  return {
    directory: name,
    generationId,
    quarantineId: suffix,
    quarantinedAt: statSync(dir).ctime.toISOString(),
    commitId: marker?.commitId ?? null,
    committedAt: marker?.committedAt ?? null,
    drift: manifestDrift(dir, marker),
    metaSha256: { now: sha256File(join(dir, "meta.json")), committed: committedHash("meta.json") },
    quoteSha256: { now: sha256File(join(dir, "quote.json")), committed: committedHash("quote.json") },
    held: quoteState(dir),
  };
}

function inspectJob(jobDir, dataDir) {
  const generationsDir = join(jobDir, GENERATIONS_DIR);
  const entries = readdirSync(generationsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const present = new Set(entries.map((entry) => entry.name));
  const quarantined = entries.filter((entry) => QUARANTINE.test(entry.name))
    .map((entry) => describeQuarantined(jobDir, entry.name))
    .sort((a, b) => a.generationId.localeCompare(b.generationId));
  const quarantinedIds = new Set(quarantined.map((entry) => entry.generationId));
  const history = readJson(join(jobDir, HISTORY));
  const missingCommitted = (Array.isArray(history) ? history : [])
    .filter((record) => /^g-\d{6,}$/.test(String(record?.generationId || ""))
      && !present.has(record.generationId)
      && !quarantinedIds.has(record.generationId))
    .map((record) => ({ generationId: record.generationId, commitId: record.commitId ?? null, committedAt: record.committedAt ?? null }));
  if (!quarantined.length && !missingCommitted.length) return null;
  const pointer = readJson(join(jobDir, POINTER));
  const activeDir = pointer?.generationId ? join(generationsDir, pointer.generationId) : null;
  const activeMeta = (activeDir ? readJson(join(activeDir, "meta.json")) : null)
    || readJson(join(jobDir, "meta.json"));
  return {
    job: relative(dataDir, jobDir),
    jobId: activeMeta?.id ?? null,
    title: activeMeta?.title ?? null,
    active: pointer?.generationId ?? null,
    activeHeld: activeDir && existsSync(activeDir) ? quoteState(activeDir) : null,
    quarantined,
    missingCommitted,
  };
}

function findJobDirs(dir, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  if (entries.some((entry) => entry.isDirectory() && entry.name === GENERATIONS_DIR)) found.push(dir);
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    findJobDirs(join(dir, entry.name), depth + 1, found);
  }
  return found;
}

function main(argv) {
  const args = argv.filter((arg) => arg !== "--json");
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    console.error("usage: node scripts/find-quarantined-generations.js <dataDir> [--json]");
    return 2;
  }
  const dataDir = resolve(args[0]);
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
    console.error(`not a directory: ${dataDir}`);
    return 2;
  }
  const jobs = findJobDirs(dataDir).map((jobDir) => inspectJob(jobDir, dataDir)).filter(Boolean);
  const report = {
    dataDir,
    jobsAffected: jobs.length,
    quarantinedGenerations: jobs.reduce((sum, job) => sum + job.quarantined.length, 0),
    missingCommittedGenerations: jobs.reduce((sum, job) => sum + job.missingCommitted.length, 0),
    jobs,
  };
  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`${report.jobsAffected} job(s) with lost generations under ${dataDir}`);
  for (const job of jobs) {
    console.log(`\n${job.job}${job.title ? `  (${job.title})` : ""}`);
    console.log(`  active ${job.active || "none"}: stage=${job.activeHeld?.pipelineStage ?? "-"} sentAt=${job.activeHeld?.quoteSentAt ?? "-"} quote v${job.activeHeld?.quoteVersion ?? "-"} total=${job.activeHeld?.quoteTotal ?? "-"}`);
    for (const entry of job.quarantined) {
      const drift = entry.drift ? [...entry.drift.changed, ...entry.drift.added.map((p) => `+${p}`), ...entry.drift.removed.map((p) => `-${p}`)].join(", ") : "no commit marker";
      console.log(`  quarantined ${entry.generationId} (${entry.directory}) committed ${entry.committedAt ?? "?"}, quarantined ${entry.quarantinedAt}`);
      console.log(`    holds now: stage=${entry.held.pipelineStage ?? "-"} sentAt=${entry.held.quoteSentAt ?? "-"} archivedAt=${entry.held.archivedAt ?? "-"} quote v${entry.held.quoteVersion ?? "-"} total=${entry.held.quoteTotal ?? "-"} sendCount=${entry.held.lifecycleSendCount ?? "-"}`);
      console.log(`    changed since commit: ${drift || "nothing"}`);
      console.log(`    meta.json sha256 now ${entry.metaSha256.now ?? "-"} committed ${entry.metaSha256.committed ?? "-"}`);
      console.log(`    quote.json sha256 now ${entry.quoteSha256.now ?? "-"} committed ${entry.quoteSha256.committed ?? "-"}`);
    }
    for (const entry of job.missingCommitted) {
      console.log(`  missing ${entry.generationId}: recorded as committed ${entry.committedAt ?? "?"} (commit ${entry.commitId ?? "?"}) but no directory on disk`);
    }
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
