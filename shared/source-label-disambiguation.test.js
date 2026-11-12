import assert from "node:assert/strict";
import test from "node:test";
import { buildDisambiguatedSourceLabels } from "./source-label-disambiguation.js";

test("repeated source labels use their section, with explicit sections before scoped codes", () => {
  const labels = buildDisambiguatedSourceLabels([
    { sourceLineItemLabel: "  Excavation  ", sourceSection: " Front ", sourceLineItemCode: "dig__section-ignored" },
    { label: "Excavation", code: "dig__section-rear_garden" },
    { label: "Drainage", section: "Front" },
  ]);

  assert.deepEqual(labels, [
    { baseLabel: "Excavation", sectionLabel: "Front", disambiguationSuffix: "Front", displayLabel: "Excavation — Front" },
    { baseLabel: "Excavation", sectionLabel: "Rear garden", disambiguationSuffix: "Rear garden", displayLabel: "Excavation — Rear garden" },
    { baseLabel: "Drainage", sectionLabel: "Front", disambiguationSuffix: null, displayLabel: "Drainage" },
  ]);
});

test("numbering stays within each repeated label and section, including rows without a section", () => {
  const labels = buildDisambiguatedSourceLabels([
    { label: "Excavation", section: "Front" },
    { label: "Excavation" },
    { label: "Excavation", section: "front" },
    { label: "Excavation", section: "Rear" },
    { label: "Excavation" },
    { label: "Drainage", section: "Front" },
    { label: "Drainage", section: "Front" },
  ]);

  assert.deepEqual(labels.map((entry) => entry.displayLabel), [
    "Excavation — Front (1)",
    "Excavation (1)",
    "Excavation — front (2)",
    "Excavation — Rear",
    "Excavation (2)",
    "Drainage — Front (1)",
    "Drainage — Front (2)",
  ]);
});

test("missing labels fall back to a trimmed source code, then the supplied fallback", () => {
  const labels = buildDisambiguatedSourceLabels([
    { sourceLineItemLabel: " ", sourceLineItemCode: "  line-7  " },
    { sourceLineItemCode: "line-7" },
    {},
    { label: 42, code: " " },
  ], { fallbackLabel: "Unlabelled source" });

  assert.deepEqual(labels.map((entry) => entry.displayLabel), [
    "line-7 (1)",
    "line-7 (2)",
    "Unlabelled source (1)",
    "Unlabelled source (2)",
  ]);
});
