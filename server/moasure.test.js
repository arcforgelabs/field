import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEvidenceIndex } from "./evidence-index.js";
import { getLedger } from "./ingestion-ledger.js";
import { removeMoasureFile, scanMoasure, storeMoasureUpload } from "./moasure.js";
import { readCurrentQuoteContext } from "./quote-version-context.js";

const SAMPLE_CSV = [
  '"Path","Point","X:m","Y:m","Z:m","Path-Type","Area:m²"',
  '"1","1","0","0","0","Boundary","12.5"',
  '"1","2","5","0","0.1","Boundary","12.5"',
  '"1","3","5","2.5","0.2","Boundary","12.5"',
  '"1","4","0","2.5","0.1","Boundary","12.5"',
  '"1","5","0","0","0","Boundary","12.5"',
].join("\n");

test("moasure files can be listed and removed from a job-scoped batch", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-moasure-"));
  t.after(async () => {
    await rm(jobDir, { recursive: true, force: true });
  });

  await storeMoasureUpload({
    jobDir,
    files: [
      {
        originalname: "Front yard.csv",
        filename: "Front yard.csv",
        buffer: Buffer.from(SAMPLE_CSV),
        mimetype: "text/csv",
        size: Buffer.byteLength(SAMPLE_CSV),
      },
      {
        originalname: "Front yard.pdf",
        filename: "Front yard.pdf",
        buffer: Buffer.from("%PDF-1.4 sample"),
        mimetype: "application/pdf",
        size: 15,
      },
    ],
  });

  let summary = await scanMoasure(jobDir);
  assert.equal(summary.status, "parsed");
  assert.equal(summary.batchCount, 1);
  assert.equal(summary.imports.length, 1);
  assert.deepEqual(summary.batches[0].files, [
    { name: "Front yard.csv", kind: "csv" },
    { name: "Front yard.pdf", kind: "pdf" },
  ]);

  const ledger = await getLedger({ jobDir });
  assert.equal(ledger.files.length, 2);
  assert.equal(ledger.files.every((file) => file.ingested === true), true);

  const evidenceIndex = await getEvidenceIndex({ jobDir });
  assert.equal(evidenceIndex.artifacts.some((artifact) => artifact.artifactId === "moasure-summary.json"), true);

  const batchId = summary.latestBatchId;
  await removeMoasureFile({
    jobDir,
    batchId,
    fileName: "Front yard.csv",
  });

  assert.equal(existsSync(join(jobDir, "moasure", "raw", batchId, "Front yard.csv")), true);
  const currentContext = await readCurrentQuoteContext(jobDir);
  assert.equal(currentContext.hiddenFileIds.length, 1);

  summary = await scanMoasure(jobDir);
  assert.equal(summary.status, "attached");
  assert.equal(summary.imports.length, 0);
  assert.deepEqual(summary.batches[0].files, [
    { name: "Front yard.pdf", kind: "pdf" },
  ]);

  await removeMoasureFile({
    jobDir,
    batchId,
    fileName: "Front yard.pdf",
  });

  summary = await scanMoasure(jobDir);
  assert.equal(summary.status, "not_attached");
  assert.equal(summary.batchCount, 0);
  assert.equal(summary.latestBatchId, null);
});
