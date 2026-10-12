import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClarificationNoteSummary,
  buildSystemRebuildNote,
  normalizeClarificationNotes,
  SYSTEM_REBUILD_NOTE_AUTHOR,
} from "./clarification-notes.js";

test("normalizeClarificationNotes classifies operator guidance without letting system notes become actionable", () => {
  const notes = normalizeClarificationNotes([
    {
      title: "Drainage review",
      text: "Please review the duplicate drainage line and rebuild the maths.",
      author: "Alex Operator",
      surface: "breakdown",
      layer: "L6",
      itemCode: "drainage",
    },
    {
      title: "System rebuild summary",
      text: "Previous rebuild summary",
      author: SYSTEM_REBUILD_NOTE_AUTHOR,
      surface: "breakdown",
      layer: "L6",
    },
  ]);

  assert.equal(notes.length, 2);
  assert.equal(notes[0].source, "operator");
  assert.equal(notes[0].actionable, true);
  assert.equal(notes[0].signals.reviewRequested, true);
  assert.equal(notes[0].signals.duplicationConcern, true);
  assert.equal(notes[0].signals.rebuildDirective, true);

  assert.equal(notes[1].source, "system");
  assert.equal(notes[1].actionable, false);
  assert.equal(notes[1].signals.reviewRequested, false);
  assert.equal(notes[1].signals.duplicationConcern, false);

  const summary = buildClarificationNoteSummary(notes);
  assert.equal(summary.total, 2);
  assert.equal(summary.operatorCount, 1);
  assert.equal(summary.systemCount, 1);
  assert.equal(summary.actionableCount, 1);
  assert.equal(summary.reviewRequestedCount, 1);
  assert.equal(summary.duplicationConcernCount, 1);
  assert.equal(summary.rebuildDirectiveCount, 1);
  assert.deepEqual(summary.referencedItemCodes, ["drainage"]);
});

test("buildSystemRebuildNote summarizes the rebuild outcome", () => {
  const note = buildSystemRebuildNote({
    quote: {
      version: 3,
      generatedAt: "2026-04-14T01:23:45.000Z",
      review: {
        status: "manual_review",
        reasons: ["Duplicate drainage scope still needs review."],
      },
      internalPricing: {
        ready: false,
        pricingIssues: [{ reason: "Buying rate missing for drainage." }],
      },
    },
    noteSummary: {
      total: 2,
      operatorCount: 1,
      systemCount: 1,
      actionableCount: 1,
      reviewRequestedCount: 1,
      duplicationConcernCount: 1,
      rebuildDirectiveCount: 1,
      referencedItemCodes: ["drainage"],
    },
    buildReason: "reingest",
  });

  assert.ok(note);
  assert.equal(note.author, SYSTEM_REBUILD_NOTE_AUTHOR);
  assert.equal(note.title, "System rebuild summary");
  assert.equal(note.version, "3");
  assert.match(note.text, /Quote v003 rebuilt 2026-04-14T01:23:45.000Z\./);
  assert.match(note.text, /Considered 2 clarification notes/);
  assert.match(note.text, /1 review request/);
  assert.match(note.text, /1 duplication concern/);
  assert.match(note.text, /Review status: manual review\./);
  assert.match(note.text, /Buying rate missing for drainage\./);
});
