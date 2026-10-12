import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("pipeline-stage migration preserves lost jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-migrate-stage-"));
  const jobDir = join(root, "2026-04-09", "job-lost-1");

  try {
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, "meta.json"),
      JSON.stringify(
        {
          id: "job-lost-1",
          deliveryStatus: "lost",
          status: "complete",
          outputMode: "quote",
        },
        null,
        2
      )
    );

    await execFileAsync(process.execPath, ["scripts/migrate-pipeline-stage.js", root], {
      cwd: repoRoot,
    });

    const migrated = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal(migrated.pipelineStage, "lost");
    assert.equal("deliveryStatus" in migrated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
