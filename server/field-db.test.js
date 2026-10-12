import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendJobLog, closeFieldDb, deleteJob, getEvidenceForJob, getFieldDb, getJobLog, getNotesForJob, insertEvidenceFile, insertNote, listJobsFromDb, rebaseJobDirs, reconcileJobIndex, replaceNote, upsertJob } from "./field-db.js";
import { JOB_GENERATIONS_DIR, runAtomicJobGeneration } from "./job-generation.js";
import { readJobMeta } from "./job-meta-store.js";

test("replaceNote keeps a single latest note for the same note key", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-db-"));
  const db = getFieldDb(dataDir);

  try {
    upsertJob(db, {
      id: "job-field-db",
      dateDir: "2026-04-14",
      dir: dataDir,
      title: "Field DB Test",
      createdAt: "2026-04-14T00:00:00.000Z",
      updatedAt: "2026-04-14T00:00:00.000Z",
    });

    replaceNote(db, {
      jobId: "job-field-db",
      text: "First rebuild summary",
      title: "System rebuild summary",
      author: "Field System",
      surface: "breakdown",
      layer: "L6",
      version: "2",
    });
    replaceNote(db, {
      jobId: "job-field-db",
      text: "Second rebuild summary",
      title: "System rebuild summary",
      author: "Field System",
      surface: "breakdown",
      layer: "L6",
      version: "2",
    });

    const notes = getNotesForJob(db, "job-field-db");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, "Second rebuild summary");
    assert.equal(notes[0].title, "System rebuild summary");
    assert.equal(notes[0].author, "Field System");
    assert.equal(notes[0].version, "2");
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("rebaseJobDirs points jobs from a moved data folder at the current one", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-db-"));
  const db = getFieldDb(dataDir);

  try {
    upsertJob(db, {
      id: "cd18e516-0000-4000-8000-000000000001",
      dateDir: "2026-03-12",
      dir: "/opt/apps/field/data/2026-03-12/cd18e516-0000-4000-8000-000000000001",
      createdAt: "2026-03-12T00:00:00.000Z",
    });
    upsertJob(db, {
      id: "already-here",
      dateDir: "2026-03-23",
      dir: join(dataDir, "2026-03-23", "already-here"),
      createdAt: "2026-03-23T00:00:00.000Z",
    });

    assert.deepEqual(rebaseJobDirs(db, dataDir), { rebased: 1, total: 2 });
    const dirs = Object.fromEntries(listJobsFromDb(db).map((row) => [row.id, row.dir]));
    assert.equal(dirs["cd18e516-0000-4000-8000-000000000001"], join(dataDir, "2026-03-12", "cd18e516-0000-4000-8000-000000000001"));
    assert.equal(dirs["already-here"], join(dataDir, "2026-03-23", "already-here"));
    assert.deepEqual(rebaseJobDirs(db, dataDir), { rebased: 0, total: 2 }, "second run changes nothing");
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("deleteJob removes the job row with its notes and evidence, and leaves other jobs alone", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-db-"));
  const db = getFieldDb(dataDir);

  try {
    for (const id of ["job-to-delete", "job-to-keep"]) {
      upsertJob(db, {
        id,
        dateDir: "2026-10-11",
        dir: join(dataDir, "2026-10-11", id),
        title: id,
        createdAt: "2026-10-11T00:00:00.000Z",
        updatedAt: "2026-10-11T00:00:00.000Z",
      });
      insertNote(db, { id: `note-${id}`, jobId: id, text: "A note", author: "Field System" });
      insertEvidenceFile(db, { id: `file-${id}`, jobId: id, filePath: "raw/images/a.jpg", fileName: "a.jpg" });
    }

    assert.deepEqual(deleteJob(db, "job-to-delete"), { notes: 1, log: 0, evidence: 1, jobs: 1 });
    assert.deepEqual(listJobsFromDb(db).map((row) => row.id), ["job-to-keep"]);
    assert.equal(getNotesForJob(db, "job-to-delete").length, 0);
    assert.equal(getEvidenceForJob(db, "job-to-delete").length, 0);
    assert.equal(getNotesForJob(db, "job-to-keep").length, 1);
    assert.equal(getEvidenceForJob(db, "job-to-keep").length, 1);
    // A prefix of a real id is never treated as a match.
    assert.deepEqual(deleteJob(db, "job-to"), { notes: 0, log: 0, evidence: 0, jobs: 0 });
    assert.deepEqual(deleteJob(db, ""), { jobs: 0, notes: 0, log: 0, evidence: 0 });
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("system notes move to the job log on start, and the team's notes stay notes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-db-"));
  try {
    let db = getFieldDb(dataDir);
    upsertJob(db, { id: "job-log", dateDir: "2026-10-12", dir: dataDir, title: "Job log", createdAt: "2026-10-12T00:00:00.000Z" });
    insertNote(db, { id: "note-system", jobId: "job-log", text: "Quote v001 rebuilt.", title: "System rebuild summary", author: "Field System", version: "1" });
    insertNote(db, { id: "note-team", jobId: "job-log", text: "Gate code 1234", author: "Alex Operator" });
    closeFieldDb();

    db = getFieldDb(dataDir);
    assert.deepEqual(getNotesForJob(db, "job-log").map((note) => note.id), ["note-team"]);
    assert.deepEqual(getJobLog(db, "job-log").map((entry) => [entry.id, entry.kind, entry.text]), [["note-system", "quote.rebuilt", "Quote v001 rebuilt."]]);

    // Rebuilds run on every save; the log keeps the latest per version.
    appendJobLog(db, { jobId: "job-log", kind: "quote.rebuilt", text: "Quote v001 rebuilt again.", version: "1", latestOnly: true });
    appendJobLog(db, { jobId: "job-log", kind: "quote.rebuilt", text: "Quote v002 rebuilt.", version: "2", latestOnly: true });
    assert.deepEqual(getJobLog(db, "job-log").map((entry) => entry.text).sort(), ["Quote v001 rebuilt again.", "Quote v002 rebuilt."]);
    assert.equal(deleteJob(db, "job-log").log, 2);
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ─── reconcileJobIndex (#32) ───────────────────────────────────
// The job list reads the index, so a job folder the index does not point at
// never appears on the board, although the job opens by its link.

async function writeJobFolder(dir, meta) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

test("reconcileJobIndex indexes a job whose meta.json lives only in a committed generation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-db-"));
  try {
    const id = "a1c00001-0000-4000-8000-000000000001";
    const jobDir = join(dataDir, "2026-04-14", id);
    await mkdir(jobDir, { recursive: true });
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify({ id, title: "Generation only", createdAt: "2026-04-14T00:00:00.000Z" }));
    }, { flush: false });
    // The job root's copy is only a best-effort projection of the generation.
    await rm(join(jobDir, "meta.json"));
    assert.ok(existsSync(join(jobDir, JOB_GENERATIONS_DIR)));

    const db = getFieldDb(dataDir);
    assert.deepEqual(await reconcileJobIndex(db, dataDir), { added: 1, moved: 0, total: 1 });
    const [row] = listJobsFromDb(db);
    assert.equal(row.id, id);
    assert.equal(row.dir, jobDir);
    assert.equal(row.title, "Generation only");
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reconcileJobIndex adds a job missing from a non-empty index and repoints a renamed folder", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-db-"));
  try {
    const db = getFieldDb(dataDir);
    const indexed = { id: "b1c00001-0000-4000-8000-000000000001", createdAt: "2026-04-01T00:00:00.000Z", title: "Indexed" };
    const missing = { id: "b2c00002-0000-4000-8000-000000000002", createdAt: "2026-04-02T00:00:00.000Z", title: "Never indexed", archivedAt: "2026-05-01T00:00:00.000Z" };
    const renamed = { id: "b3c00003-0000-4000-8000-000000000003", createdAt: "2026-04-03T00:00:00.000Z", title: "Renamed" };
    await writeJobFolder(join(dataDir, "2026-04-01", indexed.id), indexed);
    await writeJobFolder(join(dataDir, "2026-04-02", missing.id), missing);
    // Indexed under its id, then its folder was renamed to a slug (recorded
    // jobs did this in April 2026), so the row points at a folder that is gone.
    const renamedDir = join(dataDir, "2026-04-03", "driveway-retaining-wall--b3c00003");
    await writeJobFolder(renamedDir, renamed);
    upsertJob(db, { id: indexed.id, dateDir: "2026-04-01", dir: join(dataDir, "2026-04-01", indexed.id), createdAt: indexed.createdAt });
    upsertJob(db, { id: renamed.id, dateDir: "2026-04-03", dir: join(dataDir, "2026-04-03", renamed.id), createdAt: renamed.createdAt });
    insertNote(db, { id: "note-renamed", jobId: renamed.id, text: "Gate code", author: "Alex Operator" });
    // A generation stage holds a copy of a job's meta.json; it is not a job.
    await writeJobFolder(join(dataDir, "2026-04-01", `.field-generation-stage-${indexed.id}-x`), indexed);

    assert.deepEqual(await reconcileJobIndex(db, dataDir), { added: 1, moved: 1, total: 3 });
    const rows = Object.fromEntries(listJobsFromDb(db).map((row) => [row.id, row]));
    assert.equal(rows[indexed.id].dir, join(dataDir, "2026-04-01", indexed.id));
    assert.equal(rows[missing.id].dir, join(dataDir, "2026-04-02", missing.id));
    assert.equal(rows[missing.id].status, "archived", "an archived job is indexed as archived");
    assert.equal(rows[renamed.id].dir, renamedDir);
    assert.equal(getNotesForJob(db, renamed.id).length, 1, "a repointed job keeps its notes");
    assert.deepEqual(await reconcileJobIndex(db, dataDir), { added: 0, moved: 0, total: 3 }, "a second run changes nothing");
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reconcileJobIndex never brings back a deleted job", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-db-"));
  try {
    const db = getFieldDb(dataDir);
    const kept = { id: "c1c00001-0000-4000-8000-000000000001", createdAt: "2026-04-01T00:00:00.000Z" };
    const deleted = { id: "c2c00002-0000-4000-8000-000000000002", createdAt: "2026-04-02T00:00:00.000Z" };
    for (const meta of [kept, deleted]) {
      const dir = join(dataDir, meta.createdAt.slice(0, 10), meta.id);
      await writeJobFolder(dir, meta);
      upsertJob(db, { id: meta.id, dateDir: meta.createdAt.slice(0, 10), dir, createdAt: meta.createdAt });
    }
    // As the delete route does it: the folder, then the row.
    await rm(join(dataDir, "2026-04-02", deleted.id), { recursive: true, force: true });
    deleteJob(db, deleted.id);

    assert.deepEqual(await reconcileJobIndex(db, dataDir), { added: 0, moved: 0, total: 1 });
    assert.deepEqual(listJobsFromDb(db).map((row) => row.id), [kept.id]);

    // A folder deleted while a reconcile is reading it is not added either.
    const racing = { id: "c3c00003-0000-4000-8000-000000000003", createdAt: "2026-04-03T00:00:00.000Z" };
    const racingDir = join(dataDir, "2026-04-03", racing.id);
    await writeJobFolder(racingDir, racing);
    const result = await reconcileJobIndex(db, dataDir, {
      readMeta: async (dir) => {
        const meta = await readJobMeta(dir);
        if (dir === racingDir) await rm(racingDir, { recursive: true, force: true });
        return meta;
      },
    });
    assert.deepEqual(result, { added: 0, moved: 0, total: 1 });
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("upsertJob records the folder a job is in now", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-db-"));
  try {
    const db = getFieldDb(dataDir);
    const id = "d1c00001-0000-4000-8000-000000000001";
    upsertJob(db, { id, dateDir: "2026-04-03", dir: join(dataDir, "2026-04-03", id), createdAt: "2026-04-03T00:00:00.000Z" });
    upsertJob(db, { id, dateDir: "2026-04-03", dir: join(dataDir, "2026-04-03", "slug--d1c00001"), createdAt: "2026-04-03T00:00:00.000Z" });
    assert.equal(listJobsFromDb(db)[0].dir, join(dataDir, "2026-04-03", "slug--d1c00001"));
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});
