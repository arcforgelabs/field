import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getArtifactsByType, getEvidenceIndex, registerArtifact } from "./evidence-index.js";

test("evidence index registers artifacts with content hashes and type filters", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-evidence-index-"));
  t.after(async () => {
    await rm(jobDir, { recursive: true, force: true });
  });

  await mkdir(join(jobDir, "parsed"), { recursive: true });
  await writeFile(join(jobDir, "parsed", "transcript.json"), JSON.stringify({ ok: true }, null, 2));

  const artifact = await registerArtifact({
    jobDir,
    artifactId: "transcript.json",
    artifactType: "transcript",
    path: "parsed/transcript.json",
    sourceFileIds: ["f-audio"],
    producedBy: {
      agentTool: "codex",
      llmEngine: "gpt-4o-transcribe",
    },
  });

  assert.equal(artifact.artifactId, "transcript.json");
  assert.match(artifact.contentHash || "", /^sha256:/);

  const index = await getEvidenceIndex({ jobDir });
  assert.equal(index.artifacts.length, 1);
  assert.equal(index.artifacts[0].path, "parsed/transcript.json");

  const transcripts = await getArtifactsByType({ jobDir, type: "transcript" });
  assert.equal(transcripts.length, 1);
});
