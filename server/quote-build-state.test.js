import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceQuoteBuildState,
  completeQuoteBuildState,
  failQuoteBuildState,
  normalizeQuoteBuildState,
  startQuoteBuildState,
} from "./quote-build-state.js";

test("quote build state tracks running progress and completion metadata", () => {
  const started = startQuoteBuildState(null, {
    buildType: "reingest",
    requestedBy: "Alex Operator",
    stageKey: "queued",
    stageLabel: "Queued",
    stageIndex: 0,
    stageCount: 4,
    warnings: ["No audio file found. Reused the existing transcript for this rebuild."],
  });

  assert.equal(started.status, "running");
  assert.equal(started.requestedBy, "Alex Operator");
  assert.equal(started.stageCount, 4);
  assert.deepEqual(started.warnings, ["No audio file found. Reused the existing transcript for this rebuild."]);

  const staged = advanceQuoteBuildState(started, {
    stageKey: "rebuild_quote",
    stageLabel: "Rebuilding quote",
    stageIndex: 4,
  });
  assert.equal(staged.status, "running");
  assert.equal(staged.stageLabel, "Rebuilding quote");
  assert.equal(staged.stageIndex, 4);

  const completed = completeQuoteBuildState(staged, {
    quote: {
      version: 7,
      generatedAt: "2026-04-14T02:00:00.000Z",
    },
  });
  assert.equal(completed.status, "idle");
  assert.equal(completed.lastCompletedQuoteVersion, 7);
  assert.equal(completed.lastCompletedQuoteGeneratedAt, "2026-04-14T02:00:00.000Z");
  assert.equal(completed.stageKey, "complete");
  assert.deepEqual(completed.warnings, ["No audio file found. Reused the existing transcript for this rebuild."]);
});

test("quote build state reports failures and expires stale running states", () => {
  const started = startQuoteBuildState(null, {
    stageKey: "extract_quote_inputs",
    stageLabel: "Re-extracting quote inputs",
  });
  const failed = failQuoteBuildState(started, { error: "model timeout" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "model timeout");

  const stale = normalizeQuoteBuildState({
    ...started,
    updatedAt: "2026-04-14T00:00:00.000Z",
  }, {
    now: Date.parse("2026-04-14T01:00:00.000Z"),
  });
  assert.equal(stale.status, "failed");
  assert.equal(stale.stageKey, "stalled");
});
