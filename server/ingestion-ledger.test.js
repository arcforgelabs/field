import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getLedger,
  getUningestedFiles,
  markIngested,
  registerRawFile,
  storeRawFile,
} from "./ingestion-ledger.js";

test("ingestion ledger registers files, tracks ingestion state, and discovers legacy audio", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-ingestion-ledger-"));
  t.after(async () => {
    await rm(jobDir, { recursive: true, force: true });
  });

  await writeFile(join(jobDir, "meta.json"), JSON.stringify({
    id: "legacy-audio-job",
    createdAt: "2026-03-30T00:00:00.000Z",
    audioFile: "audio.ogg",
    audioFiles: ["audio.ogg"],
    mimeType: "audio/ogg",
  }, null, 2));
  await writeFile(join(jobDir, "audio.ogg"), Buffer.from("legacy-audio"));

  const stored = await storeRawFile({
    jobDir,
    category: "images",
    fileName: "site photo.jpg",
    buffer: Buffer.from("image-bytes"),
  });
  const fileId = await registerRawFile({
    jobDir,
    filePath: stored.relativePath,
    fileName: stored.fileName,
    mimeType: "image/jpeg",
    sizeBytes: 11,
    uploadedBy: "admin@example.com",
    uploadedAt: "2026-03-30T01:00:00.000Z",
  });

  const before = await getLedger({ jobDir });
  assert.equal(before.files.some((file) => file.filePath === "audio.ogg"), true);
  assert.equal(before.files.some((file) => file.fileId === fileId && file.ingested === false), true);

  await markIngested({
    jobDir,
    fileId,
    agentTool: "codex",
    llmEngine: "gpt-5.5",
    classifiedAs: "site_photo",
    artifactIds: ["site-conditions.json#entry-1"],
  });

  const after = await getLedger({ jobDir });
  const registered = after.files.find((file) => file.fileId === fileId);
  assert.ok(registered);
  assert.equal(registered.ingested, true);
  assert.deepEqual(registered.ingestions[0].artifactIds, ["site-conditions.json#entry-1"]);

  const unprocessed = await getUningestedFiles({ jobDir });
  assert.equal(unprocessed.some((file) => file.fileId === fileId), false);
});
