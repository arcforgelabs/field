import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureJobState,
  listOpenGaps,
  listOpenHandoffBlockingGaps,
  listOpenSendBlockingGaps,
  previewJobState,
  readJobState,
} from "./job-state.js";

test("option selection gaps block handoff but not quote sending", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-state-"));

  try {
    const state = await ensureJobState({
      jobDir,
      meta: {
        id: "job-option-gap",
        createdAt: "2026-03-25T10:00:00.000Z",
        title: "Wayne option quote",
      },
      quoteInputs: {
        missingInputs: [],
      },
      quote: {
        selectionState: {
          hasOptionFamilies: true,
          handoffReady: false,
          optionFamilies: [
            {
              id: "option-family-irrigation-supply-install-1",
              label: "Irrigation Supply & Install",
              defaultOptionCode: "irrigation-option-2",
              displayOptionCode: "irrigation-option-2",
              acceptedOptionCode: null,
              options: [
                {
                  sourceLineItemCode: "irrigation-option-1",
                  sourceLineItemLabel: "Option 1: Battery System",
                },
                {
                  sourceLineItemCode: "irrigation-option-2",
                  sourceLineItemLabel: "Option 2: Mains System",
                },
              ],
            },
          ],
        },
      },
    });

    assert.equal(listOpenGaps(state.gaps).length, 1);
    assert.equal(listOpenSendBlockingGaps(state.gaps).length, 0);
    assert.equal(listOpenHandoffBlockingGaps(state.gaps).length, 1);
    assert.equal(state.gaps[0].kind, "option_selection_pending");
    assert.equal(state.gaps[0].assumption.defaultValue, "Option 2: Mains System");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("missing-input gaps still block sending", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-state-"));

  try {
    const state = await ensureJobState({
      jobDir,
      meta: {
        id: "job-send-gap",
        createdAt: "2026-03-25T10:00:00.000Z",
        title: "Missing measurement quote",
      },
      quoteInputs: {
        missingInputs: [
          {
            field: "wall height",
            reason: "Needs site confirmation.",
          },
        ],
      },
      quote: {
        missingInputs: ["wall height"],
        assumptionInputs: [
          {
            field: "wall height",
            value: "Assume 600 mm until confirmed",
            defaultValue: "Assume 600 mm until confirmed",
          },
        ],
      },
    });

    assert.equal(listOpenSendBlockingGaps(state.gaps).length, 1);
    assert.equal(listOpenHandoffBlockingGaps(state.gaps).length, 1);
    assert.equal(state.gaps[0].kind, "missing_input");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("previewJobState does not mutate stored gap state when inspecting a historical version", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-state-preview-"));

  try {
    await ensureJobState({
      jobDir,
      meta: {
        id: "job-preview-gap",
        createdAt: "2026-03-25T10:00:00.000Z",
        title: "Preview gap test",
      },
      quoteInputs: {
        missingInputs: [],
      },
      quote: {
        missingInputs: [],
      },
    });

    const preview = await previewJobState({
      jobDir,
      meta: {
        id: "job-preview-gap",
        createdAt: "2026-03-25T10:00:00.000Z",
        title: "Preview gap test",
      },
      quoteInputs: {
        missingInputs: [
          {
            field: "retaining wall height",
            reason: "Only present in the older revision.",
          },
        ],
      },
      quote: {
        missingInputs: ["retaining wall height"],
      },
    });

    assert.equal(preview.gaps.length, 1);
    assert.equal(preview.gaps[0].field, "retaining wall height");

    const stored = await readJobState(jobDir);
    assert.equal(stored.gaps.length, 0);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
