#!/usr/bin/env node
/**
 * One-time migration: rename delivery status fields to canonical names.
 *
 * meta.json:
 *   deliveryStatus / quoteDeliveryStatus  →  pipelineStage
 *   "delivered" → "landed"
 *   Removes legacy keys: quoteDeliveryStatus, deliveryStatus
 *
 * quote-overrides.json:
 *   deliveryStatus  →  lockStatus
 *
 * quote-lifecycle.json:
 *   currentDeliveryStatus         →  currentPipelineStage
 *   deliveryStatusChangeCount     →  lockStatusChangeCount
 *   lastDeliveryStatusChangeAt    →  lastLockStatusChangeAt
 *
 * Usage:
 *   node migrate-pipeline-stage.js <data-dir> [--dry-run]
 *
 * Examples:
 *   node scripts/migrate-pipeline-stage.js ./data --dry-run
 *   node scripts/migrate-pipeline-stage.js ./data
 *   ssh field-staging 'cd /opt/field && node scripts/migrate-pipeline-stage.js ./data'
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const LEGACY_STAGE_MAP = { delivered: "landed", final: "sent" };
const VALID_STAGES = new Set(["draft", "sent", "landed", "lost"]);

function normalizePipelineStage(raw) {
  const v = String(raw || "").trim().toLowerCase();
  const mapped = LEGACY_STAGE_MAP[v] || v;
  return VALID_STAGES.has(mapped) ? mapped : "draft";
}

async function migrateFile(filePath, transform, { dryRun, stats }) {
  if (!existsSync(filePath)) return;
  const raw = await readFile(filePath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    stats.errors.push(`${filePath}: invalid JSON`);
    return;
  }
  const result = transform(data);
  if (!result.changed) return;
  stats.migrated++;
  if (dryRun) {
    console.log(`  [dry-run] would update ${filePath}`);
    for (const note of result.notes) console.log(`    ${note}`);
  } else {
    await writeFile(filePath, JSON.stringify(result.data, null, 2));
    for (const note of result.notes) console.log(`    ${note}`);
  }
}

function migrateMeta(data) {
  const notes = [];
  let changed = false;
  const raw = data.pipelineStage || data.deliveryStatus || data.quoteDeliveryStatus || null;
  const stage = raw ? normalizePipelineStage(raw) : null;

  if (stage && !data.pipelineStage) {
    data.pipelineStage = stage;
    notes.push(`pipelineStage = "${stage}"`);
    changed = true;
  }
  if (raw !== stage && data.pipelineStage) {
    data.pipelineStage = stage;
    notes.push(`pipelineStage normalized to "${stage}"`);
    changed = true;
  }
  if ("deliveryStatus" in data) {
    delete data.deliveryStatus;
    notes.push("removed deliveryStatus");
    changed = true;
  }
  if ("quoteDeliveryStatus" in data) {
    delete data.quoteDeliveryStatus;
    notes.push("removed quoteDeliveryStatus");
    changed = true;
  }
  return { data, changed, notes };
}

function migrateOverrides(data) {
  const notes = [];
  let changed = false;
  if ("deliveryStatus" in data && !("lockStatus" in data)) {
    data.lockStatus = data.deliveryStatus;
    notes.push(`lockStatus = "${data.lockStatus}"`);
    changed = true;
  }
  if ("deliveryStatus" in data) {
    delete data.deliveryStatus;
    notes.push("removed deliveryStatus");
    changed = true;
  }
  return { data, changed, notes };
}

function migrateLifecycle(data) {
  const notes = [];
  let changed = false;

  if ("currentDeliveryStatus" in data) {
    const raw = data.currentDeliveryStatus;
    const stage = normalizePipelineStage(raw);
    data.currentPipelineStage = stage;
    // Also set currentLockStatus from the old field if it was draft/final
    if (raw === "draft" || raw === "final") {
      data.currentLockStatus = raw;
    }
    if (!("currentLockStatus" in data)) {
      data.currentLockStatus = "draft";
    }
    delete data.currentDeliveryStatus;
    notes.push(`currentPipelineStage = "${stage}", removed currentDeliveryStatus`);
    changed = true;
  }
  if ("deliveryStatusChangeCount" in data) {
    data.lockStatusChangeCount = data.deliveryStatusChangeCount;
    delete data.deliveryStatusChangeCount;
    notes.push(`lockStatusChangeCount = ${data.lockStatusChangeCount}`);
    changed = true;
  }
  if ("lastDeliveryStatusChangeAt" in data) {
    data.lastLockStatusChangeAt = data.lastDeliveryStatusChangeAt;
    delete data.lastDeliveryStatusChangeAt;
    notes.push("renamed lastDeliveryStatusChangeAt → lastLockStatusChangeAt");
    changed = true;
  }
  return { data, changed, notes };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dataDir = args.find((a) => !a.startsWith("--"));

  if (!dataDir) {
    console.error("Usage: node migrate-pipeline-stage.js <data-dir> [--dry-run]");
    process.exit(1);
  }
  if (!existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  console.log(`${dryRun ? "[DRY RUN] " : ""}Migrating recordings in: ${dataDir}`);
  const stats = { scanned: 0, migrated: 0, errors: [] };

  async function migrateRecording(dir, label) {
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) return;

    stats.scanned++;
    console.log(`\n[${label}]`);

    await migrateFile(metaPath, migrateMeta, { dryRun, stats });
    await migrateFile(join(dir, "quote-overrides.json"), migrateOverrides, { dryRun, stats });
    await migrateFile(join(dir, "quote-lifecycle.json"), migrateLifecycle, { dryRun, stats });

    // Also migrate versioned snapshots
    const versionsDir = join(dir, "quote-versions");
    if (existsSync(versionsDir)) {
      const versionEntries = await readdir(versionsDir);
      for (const vEntry of versionEntries) {
        const vDir = join(versionsDir, vEntry);
        const vs = await stat(vDir).catch(() => null);
        if (!vs?.isDirectory()) continue;
        await migrateFile(join(vDir, "quote-overrides.json"), migrateOverrides, { dryRun, stats });
      }
    }
  }

  // Support both flat (dataDir/<id>/) and nested (dataDir/<dateDir>/<id>/) layouts
  const entries = await readdir(dataDir);
  for (const entry of entries) {
    const dir = join(dataDir, entry);
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) continue;

    if (existsSync(join(dir, "meta.json"))) {
      // Flat layout — entry is a recording dir
      await migrateRecording(dir, entry);
    } else {
      // Nested layout — entry is a date dir containing recording dirs
      const subEntries = await readdir(dir).catch(() => []);
      for (const sub of subEntries) {
        const subDir = join(dir, sub);
        const ss = await stat(subDir).catch(() => null);
        if (!ss?.isDirectory()) continue;
        await migrateRecording(subDir, `${entry}/${sub}`);
      }
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Scanned: ${stats.scanned} recordings`);
  console.log(`Migrated: ${stats.migrated} files`);
  if (stats.errors.length) {
    console.log(`Errors: ${stats.errors.length}`);
    for (const e of stats.errors) console.log(`  ${e}`);
  }
  if (dryRun) console.log("\nNo files were modified (dry run).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
