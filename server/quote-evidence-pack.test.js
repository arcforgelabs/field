import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeParsedArtifactJson } from "./evidence-index.js";
import {
  SYSTEM_REBUILD_NOTE_AUTHOR,
  SYSTEM_REBUILD_NOTE_TITLE,
} from "./clarification-notes.js";
import {
  closeFieldDb,
  getFieldDb,
  insertNote,
  upsertJob,
} from "./field-db.js";
import { registerRawFile } from "./ingestion-ledger.js";
import { buildAndWriteEvidencePack } from "./quote-evidence-pack.js";
import { detachFilesFromCurrentQuoteContext } from "./quote-version-context.js";

test("buildAndWriteEvidencePack injects normalized clarification note metadata and summary", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-evidence-db-"));
  const jobDir = await mkdtemp(join(tmpdir(), "field-evidence-job-"));
  const db = getFieldDb(dataDir);

  try {
    upsertJob(db, {
      id: "job-evidence-pack",
      dateDir: "2026-04-14",
      dir: jobDir,
      title: "Evidence Pack Test",
      createdAt: "2026-04-14T00:00:00.000Z",
      updatedAt: "2026-04-14T00:00:00.000Z",
    });
    insertNote(db, {
      id: "note-operator",
      jobId: "job-evidence-pack",
      text: "Please review the duplicated drainage scope and rebuild the maths.",
      title: "Drainage review",
      author: "Alex Operator",
      surface: "breakdown",
      layer: "L6",
      itemCode: "drainage",
      itemLabel: "Drainage",
      version: "2",
    });
    insertNote(db, {
      id: "note-system",
      jobId: "job-evidence-pack",
      text: "Previous rebuild summary",
      title: SYSTEM_REBUILD_NOTE_TITLE,
      author: SYSTEM_REBUILD_NOTE_AUTHOR,
      surface: "breakdown",
      layer: "L6",
      itemLabel: "Internal breakdown",
      version: "2",
    });

    const pack = await buildAndWriteEvidencePack({
      jobDir,
      jobId: "job-evidence-pack",
      meta: {
        id: "job-evidence-pack",
        title: "Evidence Pack Test",
        outputMode: "quote",
      },
      transcript: {
        fullText: "Test transcript",
        cleaned: {
          title: "Evidence Pack Test",
          cleanedText: "Test transcript",
          turns: [],
        },
        segments: [],
      },
      cleanedTranscript: {
        title: "Evidence Pack Test",
        cleanedText: "Test transcript",
        turns: [],
      },
      label: "Evidence Pack Test",
    });

    assert.equal(pack.evidence?.clarificationNotes?.length, 2);
    const operatorNote = pack.evidence?.clarificationNotes?.find((note) => note.author === "Alex Operator");
    assert.ok(operatorNote);
    assert.equal(operatorNote.source, "operator");
    assert.equal(operatorNote.signals?.reviewRequested, true);
    assert.equal(operatorNote.signals?.duplicationConcern, true);
    assert.equal(operatorNote.signals?.rebuildDirective, true);

    const systemNote = pack.evidence?.clarificationNotes?.find((note) => note.author === SYSTEM_REBUILD_NOTE_AUTHOR);
    assert.ok(systemNote);
    assert.equal(systemNote.source, "system");
    assert.equal(systemNote.actionable, false);

    assert.equal(pack.evidence?.clarificationNoteSummary?.total, 2);
    assert.equal(pack.evidence?.clarificationNoteSummary?.includedCount, 2);
    assert.equal(pack.evidence?.clarificationNoteSummary?.omittedCount, 0);
    assert.equal(pack.evidence?.clarificationNoteSummary?.operatorCount, 1);
    assert.equal(pack.evidence?.clarificationNoteSummary?.systemCount, 1);
    assert.equal(pack.evidence?.clarificationNoteSummary?.reviewRequestedCount, 1);
    assert.equal(pack.evidence?.clarificationNoteSummary?.duplicationConcernCount, 1);
    assert.deepEqual(pack.evidence?.clarificationNoteSummary?.referencedItemCodes, ["drainage"]);
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("buildAndWriteEvidencePack caps and dedupes clarification notes before extraction", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-evidence-db-"));
  const jobDir = await mkdtemp(join(tmpdir(), "field-evidence-job-"));
  const db = getFieldDb(dataDir);

  try {
    upsertJob(db, {
      id: "job-evidence-cap",
      dateDir: "2026-04-14",
      dir: jobDir,
      title: "Clarification Cap Test",
      createdAt: "2026-04-14T00:00:00.000Z",
      updatedAt: "2026-04-14T00:00:00.000Z",
    });

    for (let index = 0; index < 7; index += 1) {
      insertNote(db, {
        id: `note-operator-${index}`,
        jobId: "job-evidence-cap",
        text: `Drainage note ${index}`,
        title: "Drainage review",
        author: "Alex Operator",
        surface: "breakdown",
        layer: "L6",
        itemCode: "drainage",
        itemLabel: "Drainage",
        version: "2",
        createdAt: `2026-04-14T00:0${index}:00.000Z`,
      });
    }
    insertNote(db, {
      id: "note-operator-duplicate-a",
      jobId: "job-evidence-cap",
      text: "Drainage note duplicate",
      title: "Duplicate",
      author: "Alex Operator",
      surface: "breakdown",
      layer: "L6",
      itemCode: "drainage",
      itemLabel: "Drainage",
      version: "2",
      createdAt: "2026-04-14T00:10:00.000Z",
    });
    insertNote(db, {
      id: "note-operator-duplicate-b",
      jobId: "job-evidence-cap",
      text: "Drainage note duplicate",
      title: "Duplicate",
      author: "Alex Operator",
      surface: "breakdown",
      layer: "L6",
      itemCode: "drainage",
      itemLabel: "Drainage",
      version: "2",
      createdAt: "2026-04-14T00:11:00.000Z",
    });
    insertNote(db, {
      id: "note-system-a",
      jobId: "job-evidence-cap",
      text: "System summary A",
      title: SYSTEM_REBUILD_NOTE_TITLE,
      author: SYSTEM_REBUILD_NOTE_AUTHOR,
      surface: "breakdown",
      layer: "L6",
      itemLabel: "Internal breakdown",
      version: "2",
      createdAt: "2026-04-14T00:12:00.000Z",
    });
    insertNote(db, {
      id: "note-system-b",
      jobId: "job-evidence-cap",
      text: "System summary B",
      title: SYSTEM_REBUILD_NOTE_TITLE,
      author: SYSTEM_REBUILD_NOTE_AUTHOR,
      surface: "breakdown",
      layer: "L6",
      itemLabel: "Internal breakdown",
      version: "2",
      createdAt: "2026-04-14T00:13:00.000Z",
    });
    insertNote(db, {
      id: "note-system-c",
      jobId: "job-evidence-cap",
      text: "System summary C",
      title: SYSTEM_REBUILD_NOTE_TITLE,
      author: SYSTEM_REBUILD_NOTE_AUTHOR,
      surface: "breakdown",
      layer: "L6",
      itemLabel: "Internal breakdown",
      version: "2",
      createdAt: "2026-04-14T00:14:00.000Z",
    });

    const pack = await buildAndWriteEvidencePack({
      jobDir,
      jobId: "job-evidence-cap",
      meta: {
        id: "job-evidence-cap",
        title: "Clarification Cap Test",
        outputMode: "quote",
      },
      transcript: {
        fullText: "Test transcript",
        cleaned: {
          title: "Clarification Cap Test",
          cleanedText: "Test transcript",
          turns: [],
        },
        segments: [],
      },
      cleanedTranscript: {
        title: "Clarification Cap Test",
        cleanedText: "Test transcript",
        turns: [],
      },
      label: "Clarification Cap Test",
    });

    assert.equal(pack.evidence?.clarificationNoteSummary?.total, 12);
    assert.equal(pack.evidence?.clarificationNoteSummary?.includedCount, 7);
    assert.equal(pack.evidence?.clarificationNoteSummary?.omittedCount, 5);
    assert.equal(pack.evidence?.clarificationNoteSummary?.includedOperatorCount, 5);
    assert.equal(pack.evidence?.clarificationNoteSummary?.includedSystemCount, 2);
    assert.equal(pack.evidence?.clarificationNotes?.length, 7);
    assert.equal(
      pack.evidence?.clarificationNotes?.filter((note) => note.source === "system").length,
      2,
    );
    assert.equal(
      pack.evidence?.clarificationNotes?.filter((note) => note.text === "Drainage note duplicate").length,
      1,
    );
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("buildAndWriteEvidencePack includes baseline quote context and only visible structured notes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-evidence-db-"));
  const jobDir = await mkdtemp(join(tmpdir(), "field-evidence-job-"));
  const db = getFieldDb(dataDir);

  try {
    upsertJob(db, {
      id: "job-evidence-baseline",
      dateDir: "2026-04-14",
      dir: jobDir,
      title: "Baseline Context Test",
      createdAt: "2026-04-14T00:00:00.000Z",
      updatedAt: "2026-04-14T00:00:00.000Z",
    });

    const visibleFileId = await registerRawFile({
      jobDir,
      filePath: "raw/notes/site-note-visible.txt",
      fileName: "site-note-visible.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      uploadedBy: "test",
    });
    const hiddenFileId = await registerRawFile({
      jobDir,
      filePath: "raw/notes/site-note-hidden.txt",
      fileName: "site-note-hidden.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      uploadedBy: "test",
    });
    await detachFilesFromCurrentQuoteContext(jobDir, {
      quoteVersion: 5,
      fileIds: [hiddenFileId],
    });

    await writeParsedArtifactJson({
      jobDir,
      fileName: "structured-notes.json",
      payload: {
        version: 1,
        lastUpdatedAt: "2026-04-14T01:00:00.000Z",
        entries: [
          {
            entryId: "entry-visible",
            sourceFileId: visibleFileId,
            sourceFilePath: "raw/notes/site-note-visible.txt",
            classifiedAs: "structured_note",
            createdAt: "2026-04-14T01:00:00.000Z",
            content: {
              sourceKind: "text_note",
              summary: "Visible note summary",
              extractedText: "Keep the rear retaining wall and revisit drainage quantities.",
              sections: [
                {
                  heading: "Notes",
                  text: "Keep the rear retaining wall and revisit drainage quantities.",
                },
              ],
            },
          },
          {
            entryId: "entry-hidden",
            sourceFileId: hiddenFileId,
            sourceFilePath: "raw/notes/site-note-hidden.txt",
            classifiedAs: "structured_note",
            createdAt: "2026-04-14T01:05:00.000Z",
            content: {
              sourceKind: "text_note",
              summary: "Hidden note summary",
              extractedText: "This hidden note should not appear.",
              sections: [],
            },
          },
        ],
      },
      artifactId: "structured-notes.json",
      artifactType: "structured_notes",
      sourceFileIds: [visibleFileId, hiddenFileId],
    });

    const pack = await buildAndWriteEvidencePack({
      jobDir,
      jobId: "job-evidence-baseline",
      meta: {
        id: "job-evidence-baseline",
        title: "Baseline Context Test",
        outputMode: "quote",
        quoteVersion: 5,
      },
      transcript: {
        fullText: "Test transcript",
        cleaned: {
          title: "Baseline Context Test",
          cleanedText: "Test transcript",
          turns: [],
        },
        segments: [],
      },
      cleanedTranscript: {
        title: "Baseline Context Test",
        cleanedText: "Test transcript",
        turns: [],
      },
      label: "Baseline Context Test",
      baselineQuote: {
        version: 4,
        summary: "Retaining wall and drainage scope.",
        jobScope: {
          customerGoal: "Retain the rear fence line.",
          workSummary: "Build retaining wall and tidy drainage.",
          siteContext: "Rear yard.",
        },
        lineItems: [
          {
            code: "retaining-wall__section-rear-yard",
            label: "Rear retaining wall",
            section: "Rear yard",
            scopeSummary: "Rear retaining wall",
            quantity: 1,
            unit: "job",
            totalPrice: 32195,
            customerVisible: true,
          },
        ],
        assumptions: ["Drainage tie-in remains provisional."],
        missingInputs: ["stormwater_outlet"],
        review: {
          status: "manual_review",
          reasons: ["Check drainage outlet."],
        },
      },
    });

    assert.equal(pack.baselineQuoteContext?.version, 4);
    assert.equal(pack.baselineQuoteContext?.lineItems?.length, 1);
    assert.equal(pack.baselineQuoteContext?.lineItems?.[0]?.label, "Rear retaining wall");
    assert.equal(pack.evidence?.structuredNotes?.length, 1);
    assert.equal(pack.evidence?.structuredNotes?.[0]?.sourceFileId, visibleFileId);
    assert.equal(pack.evidence?.structuredNotes?.[0]?.sourceFilePath, "raw/notes/site-note-visible.txt");
  } finally {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
    await rm(jobDir, { recursive: true, force: true });
  }
});
