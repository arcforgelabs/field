import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendJobLog, closeFieldDb, deleteJob, getEvidenceForJob, getFieldDb, getJobLog, getNotesForJob, insertEvidenceFile, insertNote, listJobsFromDb, rebaseJobDirs, replaceNote, upsertJob } from "./field-db.js";

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
