#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { chown, cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { exportQuoteProofBundle } from "./export-quote-proof-bundle.js";
import { buildAndPersistQuote } from "../server/quote-workflow.js";
import { STAGING_FIXTURES } from "./staging-fixtures.js";
import { DEMO_FIXTURES } from "./demo-fixtures.js";
import { buildPriceCatalogSnapshot } from "../server/price-catalog/catalog-snapshot.js";
import { closeDb, getDb, runMigrations } from "../server/db-runtime/index.js";
import { resolveDeploymentOrg } from "../server/db-runtime/tenancy.js";
import { openCatalogStore } from "../server/catalog/index.js";

const APP_ROOT = resolve(import.meta.dirname, "..");
const CONFIG_PATH = process.env.FIELD_CONFIG || join(APP_ROOT, "config.json");
const rawConfig = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
const dataDir = resolve(process.env.FIELD_DATA || rawConfig.dataDir || join(APP_ROOT, "data"));
const fixtureSet = String(process.env.FIELD_FIXTURE_SET || "staging").trim().toLowerCase();
const fixtures = fixtureSet === "demo" ? DEMO_FIXTURES : STAGING_FIXTURES;
const logPrefix = fixtureSet === "demo" ? "[demo-seed]" : "[staging-seed]";
const backupRoot = resolveBackupRoot(dataDir);
const usersPath = join(dataDir, "users.json");
const usersBackupPath = join(backupRoot, `.users-${timestampTag()}.json`);
const desiredOwner = await resolveDesiredOwner();

process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "";
process.env.GOOGLE_DRIVE_FOLDER_ID = "";
process.env.GOOGLE_OAUTH_CLIENT_ID = "";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "";
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "";
process.env.GOOGLE_CLOUD_QUOTA_PROJECT = "";

const config = {
  ...rawConfig,
  googleDriveFolderId: null,
  googleOAuth: null,
  googleServiceAccountKey: null,
};

// Validate the fixture authority before moving any customer/staging data. A
// failed preflight must leave the original data directory untouched. The
// catalogue lives in PostgreSQL, so moving the data directory leaves it be.
let catalog = null;
try {
  await runMigrations();
  catalog = await openCatalogStore({ dataDir, orgUid: (await resolveDeploymentOrg(getDb())).uid });
  const snapshot = buildPriceCatalogSnapshot(await catalog.getState());
  if (!snapshot.completeness?.baselineUsable) {
    throw new Error(`price catalog snapshot is incomplete: ${(snapshot.completeness?.missingPriceCodes || []).join(", ")}`);
  }
} catch (error) {
  await closeDb().catch(() => {});
  console.error(`${logPrefix} refusing destructive reset: ${error.message}`);
  process.exit(1);
}
config.priceCatalog = catalog;

await mkdir(backupRoot, { recursive: true });
await syncOwnershipRecursive(backupRoot, desiredOwner.uid, desiredOwner.gid);

if (existsSync(usersPath)) {
  await cp(usersPath, usersBackupPath);
}

let backupDir = null;
if (existsSync(dataDir)) {
  backupDir = join(backupRoot, `staging-reset-${timestampTag()}`);
  await rename(dataDir, backupDir);
  console.log(`${logPrefix} existing data moved to ${backupDir}`);
  await syncOwnershipRecursive(backupDir, desiredOwner.uid, desiredOwner.gid);
}

const seeded = [];
try {
await mkdir(dataDir, { recursive: true });
await syncOwnershipRecursive(dataDir, desiredOwner.uid, desiredOwner.gid);


if (existsSync(usersBackupPath)) {
  await cp(usersBackupPath, usersPath);
}

for (const fixture of fixtures) {
  const createdAt = new Date(Date.now() - fixture.createdAtOffsetMinutes * 60_000).toISOString();
  const slug = `${slugify(fixture.title)}--${fixture.id.slice(0, 8)}`;
  const jobDir = join(dataDir, createdAt.slice(0, 10), slug);
  await mkdir(jobDir, { recursive: true });

  const transcript = buildTranscript({
    title: fixture.title,
    turns: fixture.transcriptTurns,
  });

  const meta = {
    id: fixture.id,
    createdAt,
    title: fixture.title,
    label: fixture.title,
    outputMode: "quote",
    quoteCatalogId: fixture.quoteCatalogId || "embark-default",
    status: "processing",
    captureMode: "recording",
    audioFile: null,
    mimeType: null,
    sizeBytes: 0,
    durationMs: Math.round((transcript.segments.at(-1)?.end || 0) * 1000),
    speakerCount: transcript.speakers.length,
    taskCount: null,
    qaDropped: 0,
    slug,
    siteAddress: fixture.siteAddress,
    contactName: fixture.contactName,
    contactPhone: null,
    contactEmail: null,
    quotedBy: null,
    gps: null,
  };

  await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  await writeFile(join(jobDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  await writeFile(join(jobDir, "transcript-raw.json"), JSON.stringify(transcript.raw, null, 2));
  await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(fixture.quoteInputs, null, 2));

  const persisted = await buildAndPersistQuote({
    jobDir,
    meta,
    transcript,
    quoteInputs: fixture.quoteInputs,
    config,
    buildReason: "staging_seed_fixture",
  });

  const proofBundle = await exportQuoteProofBundle({
    jobDir,
    outputDir: join(jobDir, "proof-bundle"),
  });

  seeded.push({
    id: persisted.meta.id,
    title: persisted.meta.title,
    directory: jobDir,
    total: persisted.quote?.totals?.total || 0,
    proofBundle: proofBundle.outputDir,
  });
}
} catch (error) {
  await closeDb().catch(() => {});
  // Restore the moved tree if fixture generation fails after the destructive
  // move. The failed partial tree is retained as a diagnostic backup.
  const failedDir = join(backupRoot, `staging-reset-failed-${timestampTag()}`);
  if (existsSync(dataDir)) await rename(dataDir, failedDir);
  if (backupDir && existsSync(backupDir)) await rename(backupDir, dataDir);
  throw error;
}

await syncOwnershipRecursive(dataDir, desiredOwner.uid, desiredOwner.gid);
await closeDb();

console.log(`${logPrefix} seeded fixtures:`);
for (const item of seeded) {
  console.log(`- ${item.title} (${item.id}) -> ${item.directory} [$${item.total.toFixed(2)} inc GST]`);
  console.log(`  proof -> ${item.proofBundle}`);
}

function buildTranscript({ title, turns }) {
  const speakers = [];
  const seenSpeakers = new Set();
  const segments = [];
  const cleanedTurns = [];
  let cursor = 0;

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!seenSpeakers.has(turn.speaker)) {
      seenSpeakers.add(turn.speaker);
      speakers.push(turn.speaker);
    }
    const duration = Math.max(2.4, turn.text.split(/\s+/).filter(Boolean).length * 0.42);
    const start = Number(cursor.toFixed(2));
    const end = Number((cursor + duration).toFixed(2));
    const text = String(turn.text || "").trim();
    segments.push({
      segmentId: `S${String(index + 1).padStart(3, "0")}`,
      speaker: turn.speaker,
      text,
      start,
      end,
    });
    cleanedTurns.push({
      speaker: turn.speaker,
      text,
    });
    cursor = end + 0.45;
  }

  const fullText = cleanedTurns.map((turn) => turn.text).join(" ");
  return {
    model: "seed-fixture",
    fullText,
    duration: segments.at(-1)?.end || 0,
    language: "en",
    speakers,
    segments,
    raw: {
      text: fullText,
      segments: segments.map((segment, index) => ({
        type: "transcript.text.segment",
        text: segment.text,
        speaker: segment.speaker,
        start: segment.start,
        end: segment.end,
        id: `seed_seg_${index}`,
      })),
    },
    cleaned: {
      title,
      speakers: speakers.map((speaker) => ({ id: speaker, name: null, role: null })),
      turns: cleanedTurns,
      cleanedText: cleanedTurns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n\n"),
    },
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function timestampTag() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveBackupRoot(targetDataDir) {
  if (basename(targetDataDir) === "data") {
    const appDir = dirname(targetDataDir);
    return join(dirname(appDir), `${basename(appDir)}-data-backups`);
  }
  return join(dirname(targetDataDir), `${basename(targetDataDir)}-backups`);
}

async function resolveDesiredOwner() {
  const ownerSource = [APP_ROOT, dirname(dataDir), "/tmp"].find((path) => existsSync(path));
  return await stat(ownerSource);
}

async function syncOwnershipRecursive(path, uid, gid) {
  if (!existsSync(path)) return;
  const current = await stat(path);
  if (current.uid !== uid || current.gid !== gid) {
    await chown(path, uid, gid);
  }
  if (!current.isDirectory()) return;

  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    await syncOwnershipRecursive(join(path, entry.name), uid, gid);
  }
}
