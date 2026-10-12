import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerArtifact } from "./evidence-index.js";
import { markIngested, registerRawFile } from "./ingestion-ledger.js";
import { detectStaleEvidence } from "./stale-detection.js";

test("stale detection reports uningested files and newer raw-file revisions", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-stale-detection-"));
  t.after(async () => {
    await rm(jobDir, { recursive: true, force: true });
  });

  await mkdir(join(jobDir, "parsed"), { recursive: true });
  await writeFile(join(jobDir, "parsed", "site-conditions.json"), JSON.stringify({ version: 1, entries: [] }, null, 2));

  const firstFileId = await registerRawFile({
    jobDir,
    filePath: "raw/images/site.jpg",
    fileName: "site.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 12,
    uploadedBy: "samuel",
    uploadedAt: "2026-03-30T10:00:00.000Z",
  });

  let detected = await detectStaleEvidence({ jobDir });
  assert.equal(detected.uningestedFiles.length, 1);
  assert.equal(detected.needsReorchestration, true);

  await markIngested({
    jobDir,
    fileId: firstFileId,
    agentTool: "codex",
    llmEngine: "gpt-4o",
    classifiedAs: "site_photo",
    artifactIds: ["site-conditions.json#entry-1"],
    ingestedAt: "2026-03-30T10:01:00.000Z",
  });
  await registerArtifact({
    jobDir,
    artifactId: "site-conditions.json#entry-1",
    artifactType: "site_conditions",
    path: "parsed/site-conditions.json",
    sourceFileIds: [firstFileId],
    producedBy: {
      agentTool: "codex",
      llmEngine: "gpt-4o",
    },
  });

  await registerRawFile({
    jobDir,
    filePath: "raw/images/site.jpg",
    fileName: "site.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 18,
    uploadedBy: "samuel",
    uploadedAt: "2099-03-30T11:00:00.000Z",
  });

  detected = await detectStaleEvidence({ jobDir });
  assert.equal(detected.uningestedFiles.length, 1);
  assert.equal(detected.staleArtifacts.length, 1);
  assert.equal(detected.staleArtifacts[0].artifactId, "site-conditions.json#entry-1");
});
