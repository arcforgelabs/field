import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOB_GENERATION_POINTER,
  JOB_GENERATIONS_DIR,
  JOB_GENERATION_LOCK,
  resolveActiveJobGeneration,
  runAtomicJobGeneration,
  withJobGenerationLock,
} from "./job-generation.js";
import { storeRawFile } from "./ingestion-ledger.js";

test("atomic job generations publish one pointer and readers recover an interrupted pointer", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-generation-"));
  try {
    await writeFile(join(jobDir, "meta.json"), JSON.stringify({ version: 1 }));
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify({ version: 2 }));
    });
    const active = await resolveActiveJobGeneration(jobDir);
    assert.equal(JSON.parse(await readFile(join(active, "meta.json"))).version, 2);
    assert.equal(existsSync(join(jobDir, JOB_GENERATION_POINTER)), true);

    await writeFile(join(jobDir, JOB_GENERATION_POINTER), JSON.stringify({ version: 1, generationId: "missing" }));
    const recovered = await resolveActiveJobGeneration(jobDir);
    assert.equal(JSON.parse(await readFile(join(recovered, "meta.json"))).version, 2);
    assert.equal(JSON.parse(await readFile(join(jobDir, JOB_GENERATION_POINTER))).generationId, recovered.split("/").pop());
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("late staged generation failure leaves the prior generation and pointer untouched", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-generation-failure-"));
  try {
    await writeFile(join(jobDir, "quote.json"), "issued-bytes");
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "quote.json"), "new-bytes");
    });
    const pointerBefore = await readFile(join(jobDir, JOB_GENERATION_POINTER), "utf8");
    const quoteBefore = await readFile(join(await resolveActiveJobGeneration(jobDir), "quote.json"), "utf8");
    await assert.rejects(
      runAtomicJobGeneration(jobDir, async (stage) => {
        await writeFile(join(stage, "quote.json"), "mutated-but-unpublished");
        throw new Error("late wall publish failure");
      }),
      /late wall publish failure/,
    );
    assert.equal(await readFile(join(jobDir, JOB_GENERATION_POINTER), "utf8"), pointerBefore);
    assert.equal(await readFile(join(await resolveActiveJobGeneration(jobDir), "quote.json"), "utf8"), quoteBefore);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("readers ignore and quarantine an uncommitted generation instead of choosing it by name", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-generation-quarantine-"));
  try {
    await writeFile(join(jobDir, "meta.json"), JSON.stringify({ version: 1 }));
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify({ version: 2 }));
    });
    const forgedDir = join(jobDir, JOB_GENERATIONS_DIR, "g-999999");
    await mkdir(forgedDir, { recursive: true });
    await writeFile(join(forgedDir, "meta.json"), JSON.stringify({ version: 999 }));

    const active = await resolveActiveJobGeneration(jobDir);
    assert.equal(JSON.parse(await readFile(join(active, "meta.json"))).version, 2);
    const generationEntries = await readdir(join(jobDir, JOB_GENERATIONS_DIR));
    assert.equal(generationEntries.some((entry) => entry === "g-999999"), false);
    assert.equal(generationEntries.some((entry) => entry.startsWith(".quarantine-g-999999-")), true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("readers quarantine a committed generation whose critical bytes were modified, deleted, or added", async () => {
  for (const mutation of ["modified", "deleted", "extra"]) {
    const jobDir = await mkdtemp(join(tmpdir(), `field-generation-manifest-${mutation}-`));
    try {
      await writeFile(join(jobDir, "meta.json"), JSON.stringify({ version: 1 }));
      await runAtomicJobGeneration(jobDir, async () => {});
      await runAtomicJobGeneration(jobDir, async (stage) => {
        await writeFile(join(stage, "meta.json"), JSON.stringify({ version: 2 }));
      });
      const active = await resolveActiveJobGeneration(jobDir);
      if (mutation === "modified") await writeFile(join(active, "meta.json"), JSON.stringify({ version: 99 }));
      if (mutation === "deleted") await rm(join(active, "meta.json"));
      if (mutation === "extra") await writeFile(join(active, "unexpected-critical.txt"), "unexpected");

      const recovered = await resolveActiveJobGeneration(jobDir);
      assert.notEqual(recovered, active);
      assert.equal(JSON.parse(await readFile(join(recovered, "meta.json"))).version, 1);
      const entries = await readdir(join(jobDir, JOB_GENERATIONS_DIR));
      assert.equal(entries.some((entry) => entry.startsWith(".quarantine-g-")), true);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  }
});

test("commercial publication preserves root-authoritative chat, gaps, callbacks, and evidence interleavings", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-generation-protected-root-"));
  try {
    await mkdir(join(jobDir, "job-workspace", "chat"), { recursive: true });
    await mkdir(join(jobDir, "job-state"), { recursive: true });
    await mkdir(join(jobDir, "callbacks"), { recursive: true });
    await mkdir(join(jobDir, "evidence"), { recursive: true });
    await mkdir(join(jobDir, "raw", "images"), { recursive: true });
    await writeFile(join(jobDir, "job-workspace", "chat", "events.jsonl"), "before-chat\n");
    await writeFile(join(jobDir, "job-state", "gaps.json"), "before-gaps\n");
    await writeFile(join(jobDir, "callbacks", "events.jsonl"), "before-callback\n");
    await writeFile(join(jobDir, "evidence", "index.json"), "before-evidence\n");
    await writeFile(join(jobDir, "meta.json"), JSON.stringify({ version: 1 }));

    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify({ version: 2 }));
      await writeFile(join(jobDir, "job-workspace", "chat", "events.jsonl"), "after-chat\n");
      await writeFile(join(jobDir, "job-state", "gaps.json"), "after-gaps\n");
      await writeFile(join(jobDir, "callbacks", "events.jsonl"), "after-callback\n");
      await writeFile(join(jobDir, "evidence", "index.json"), "after-evidence\n");
      await storeRawFile({
        jobDir,
        category: "images",
        fileName: "during-build.jpg",
        buffer: Buffer.from("attachment-bytes"),
      });
    });

    assert.equal(await readFile(join(jobDir, "job-workspace", "chat", "events.jsonl"), "utf8"), "after-chat\n");
    assert.equal(await readFile(join(jobDir, "job-state", "gaps.json"), "utf8"), "after-gaps\n");
    assert.equal(await readFile(join(jobDir, "callbacks", "events.jsonl"), "utf8"), "after-callback\n");
    assert.equal(await readFile(join(jobDir, "evidence", "index.json"), "utf8"), "after-evidence\n");
    assert.equal(await readFile(join(jobDir, "raw", "images", "during-build.jpg"), "utf8"), "attachment-bytes");
    const active = await resolveActiveJobGeneration(jobDir);
    assert.equal(existsSync(join(active, "job-workspace")), false);
    assert.equal(existsSync(join(active, "raw")), false);
    assert.equal(JSON.parse(await readFile(join(active, "meta.json"))).version, 2);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("history repairs a pointer that lagged after a committed publication", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-generation-history-"));
  try {
    await writeFile(join(jobDir, "meta.json"), JSON.stringify({ version: 1 }));
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify({ version: 2 }));
    });
    const firstPointer = await readFile(join(jobDir, JOB_GENERATION_POINTER), "utf8");
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeFile(join(stage, "meta.json"), JSON.stringify({ version: 3 }));
    });
    await writeFile(join(jobDir, JOB_GENERATION_POINTER), firstPointer);

    const active = await resolveActiveJobGeneration(jobDir);
    assert.equal(JSON.parse(await readFile(join(active, "meta.json"))).version, 3);
    assert.equal(JSON.parse(await readFile(join(jobDir, JOB_GENERATION_POINTER))).generationId, active.split("/").pop());
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("generation lock reclaims an owner with a mismatched process identity", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-generation-lock-reclaim-"));
  try {
    const lockDir = join(jobDir, JOB_GENERATION_LOCK);
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({
      pid: process.pid,
      bootId: "foreign-boot",
      processStart: "foreign-process",
    }));
    const result = await withJobGenerationLock(jobDir, async () => "reclaimed");
    assert.equal(result, "reclaimed");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("generation staging rejects root and nested symlinks without following them", async () => {
  const rootLinkJob = await mkdtemp(join(tmpdir(), "field-generation-root-link-"));
  const nestedLinkJob = await mkdtemp(join(tmpdir(), "field-generation-nested-link-"));
  try {
    const outside = await mkdtemp(join(tmpdir(), "field-generation-link-target-"));
    await writeFile(join(outside, "secret.txt"), "must-not-follow");
    await symlink(outside, join(rootLinkJob, "raw"));
    await assert.rejects(
      runAtomicJobGeneration(rootLinkJob, async () => {}),
      /symbolic links are not allowed/i,
    );

    await writeFile(join(nestedLinkJob, "meta.json"), "{}\n");
    await runAtomicJobGeneration(nestedLinkJob, async () => {});
    const active = await resolveActiveJobGeneration(nestedLinkJob);
    await symlink(outside, join(active, "quote-versions"));
    const recovered = await resolveActiveJobGeneration(nestedLinkJob);
    assert.notEqual(recovered, active);
    const entries = await readdir(join(nestedLinkJob, JOB_GENERATIONS_DIR));
    assert.ok(entries.some((entry) => entry.startsWith(".quarantine-g-")));
  } finally {
    await rm(rootLinkJob, { recursive: true, force: true });
    await rm(nestedLinkJob, { recursive: true, force: true });
  }
});
