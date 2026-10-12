import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeParsedArtifactJson } from "./evidence-index.js";
import { registerRawFile } from "./ingestion-ledger.js";
import {
  detachFilesFromCurrentQuoteContext,
  readCurrentQuoteContext,
  readSelectedQuoteVersionArtifacts,
} from "./quote-version-context.js";

test("readSelectedQuoteVersionArtifacts hides detached draft files and their derived artifacts", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-version-context-"));

  try {
    await writeFile(join(jobDir, "visible.txt"), "visible");
    await writeFile(join(jobDir, "hidden.txt"), "hidden");

    const visibleFileId = await registerRawFile({
      jobDir,
      filePath: "visible.txt",
      fileName: "visible.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
      uploadedBy: "test",
    });
    const hiddenFileId = await registerRawFile({
      jobDir,
      filePath: "hidden.txt",
      fileName: "hidden.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      uploadedBy: "test",
    });

    await writeParsedArtifactJson({
      jobDir,
      fileName: "visible-artifact.json",
      payload: { ok: true },
      artifactId: "visible-artifact",
      artifactType: "test",
      sourceFileIds: [visibleFileId],
    });
    await writeParsedArtifactJson({
      jobDir,
      fileName: "hidden-artifact.json",
      payload: { ok: true },
      artifactId: "hidden-artifact",
      artifactType: "test",
      sourceFileIds: [hiddenFileId],
    });
    await writeParsedArtifactJson({
      jobDir,
      fileName: "shared-artifact.json",
      payload: { ok: true },
      artifactId: "shared-artifact",
      artifactType: "test",
      sourceFileIds: [visibleFileId, hiddenFileId],
    });
    await writeParsedArtifactJson({
      jobDir,
      fileName: "source-free-artifact.json",
      payload: { ok: true },
      artifactId: "source-free-artifact",
      artifactType: "test",
      sourceFileIds: [],
    });

    await detachFilesFromCurrentQuoteContext(jobDir, {
      quoteVersion: 1,
      fileIds: [hiddenFileId],
    });

    const context = await readCurrentQuoteContext(jobDir, { quoteVersion: 1 });
    assert.deepEqual(context.hiddenFileIds, [hiddenFileId]);

    const detail = await readSelectedQuoteVersionArtifacts({
      jobDir,
      selectedVersion: 1,
      latestVersion: 1,
    });

    assert.deepEqual(
      detail.ingestionLedger.files.map((file) => file.fileId),
      [visibleFileId],
    );
    assert.deepEqual(
      detail.evidenceIndex.artifacts.map((artifact) => artifact.artifactId).sort(),
      ["shared-artifact", "source-free-artifact", "visible-artifact"],
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
