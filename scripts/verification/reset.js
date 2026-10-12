#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, writeFile } from "../../server/storage/fs-promises.js";
import { existsSync } from "../../server/storage/fs.js";
import { basename, dirname, join, resolve } from "node:path";
import { exportQuoteProofBundle } from "../export-quote-proof-bundle.js";
import { buildAndPersistQuote } from "../../server/quote-workflow.js";
import { generateJobMilestones, markJobLanded, updateJobQuote } from "../../server/job-actions.js";
import { recordQuoteSent } from "../../server/quote-lifecycle.js";
import { recordIssuedQuoteDocuments } from "../../server/quote-issuance.js";
import { writeJobMeta } from "../../server/job-meta-store.js";
import { runAtomicJobGeneration } from "../../server/job-generation.js";
import { isReplitRuntime } from "../../server/runtime-config.js";
import { assertVerificationConfig, assertVerificationPaths, rejectForbiddenBoundary } from "./contract.js";
import { assertFixtureMarker, buildFixtureMarker, REVIEWED_SEMANTIC_MANIFEST, VERIFICATION_CATALOG_ITEMS, VERIFICATION_FIXTURES } from "./fixtures.js";
import { hashVerificationTree } from "./tree-hash.js";
import { closeDb, getDb, runMigrations } from "../../server/db-runtime/index.js";
import { resolveDeploymentOrg } from "../../server/db-runtime/tenancy.js";
import { openCatalogStore, replaceCatalogItems } from "../../server/catalog/index.js";
import { readQuoteArtifacts } from "../../server/quote-artifacts.js";

const CONTAINER_DATA_ROOT = "/var/lib/field-verification/data";
const CONTAINER_BACKUP_ROOT = "/var/lib/field-verification/backups";
const CONTAINER_SECRET_ROOT = "/run/field-verification-secrets";
const APP_ROOT = resolve(import.meta.dirname, "../..");
const args = new Set(process.argv.slice(2));

function requiredPath(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function assertContainerPath(path, expected, label) {
  if (path !== expected) throw new Error(`${label} must be ${expected}`);
  rejectForbiddenBoundary(path, label);
}

async function clearDirectoryChildren(directory) {
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory)) {
    await rm(join(directory, entry), { recursive: true, force: true });
  }
}

async function readConfig(configPath, allowTestRoots = false) {
  if (!existsSync(configPath)) throw new Error(`verification runtime config is missing: ${configPath}`);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assertVerificationConfig(config, { dataDir: CONTAINER_DATA_ROOT, allowTestRoots });
  return config;
}

export function fixtureJobDirectory(dataDir, fixture) {
  const slug = `${String(fixture.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)}--${fixture.id.slice(0, 8)}`;
  return join(dataDir, fixture.createdAt.slice(0, 10), slug);
}

function buildTranscript(fixture) {
  const speakers = [];
  const seen = new Set();
  const segments = [];
  const turns = [];
  let cursor = 0;
  for (const [index, turn] of fixture.transcriptTurns.entries()) {
    if (!seen.has(turn.speaker)) {
      seen.add(turn.speaker);
      speakers.push(turn.speaker);
    }
    const text = String(turn.text || "").trim();
    const duration = Math.max(2.4, text.split(/\s+/).filter(Boolean).length * 0.42);
    const start = Number(cursor.toFixed(2));
    const end = Number((cursor + duration).toFixed(2));
    segments.push({ segmentId: `S${String(index + 1).padStart(3, "0")}`, speaker: turn.speaker, text, start, end });
    turns.push({ speaker: turn.speaker, text });
    cursor = end + 0.45;
  }
  const fullText = turns.map((turn) => turn.text).join(" ");
  return {
    model: "field-verification-fixture",
    fullText,
    duration: segments.at(-1)?.end || 0,
    language: "en",
    speakers,
    segments,
    raw: { text: fullText, segments: segments.map((segment, index) => ({ ...segment, type: "transcript.text.segment", id: `verification-seg-${index}` })) },
    cleaned: { title: fixture.title, speakers: speakers.map((speaker) => ({ id: speaker, name: null, role: null })), turns, cleanedText: turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n\n") },
  };
}

async function writeFixture(jobDir, fixture, transcript, config) {
  await mkdir(jobDir, { recursive: true });
  const meta = {
    id: fixture.id,
    createdAt: fixture.createdAt,
    title: fixture.title,
    label: fixture.title,
    outputMode: "quote",
    quoteCatalogId: fixture.quoteCatalogId,
    status: "processing",
    captureMode: "verification-fixture",
    audioFile: null,
    mimeType: null,
    sizeBytes: 0,
    durationMs: Math.round((transcript.segments.at(-1)?.end || 0) * 1000),
    speakerCount: transcript.speakers.length,
    taskCount: null,
    qaDropped: 0,
    slug: basename(jobDir),
    siteAddress: fixture.siteAddress,
    contactName: fixture.contactName,
    contactPhone: null,
    contactEmail: null,
    quotedBy: "field-verification",
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
    buildReason: "field_verification_fixture",
  });
  await exportQuoteProofBundle({
    jobDir,
    outputDir: join(jobDir, "proof-bundle"),
    ...(process.env.FIELD_VERIFICATION_DETERMINISTIC === "1"
      ? { displaySourceRoot: config.dataDir, displayRoot: CONTAINER_DATA_ROOT }
      : {}),
  });
  return persisted;
}

/**
 * reset() replaces the catalogue in whatever database DATABASE_URL names, so it
 * refuses outright on Replit (workspace or deployment) where that database is
 * the live one.
 */
export function rejectReplitRuntime(env = process.env) {
  if (isReplitRuntime(env) || env.REPLIT_DEPLOYMENT || env.REPL_ID) {
    throw new Error("verification reset refuses to run on Replit: it would replace the live catalogue");
  }
}

export async function reset() {
  rejectReplitRuntime();
  const allowTestRoots = process.env.FIELD_VERIFICATION_TEST_MODE === "1";
  if (!allowTestRoots && process.env.FIELD_VERIFICATION_DETERMINISTIC !== "1") {
    throw new Error("verification reset requires the deterministic verification mode");
  }
  const configPath = requiredPath("FIELD_CONFIG", join(CONTAINER_SECRET_ROOT, "config.json"));
  const dataDir = requiredPath("FIELD_DATA", CONTAINER_DATA_ROOT);
  const backupRoot = requiredPath("FIELD_BACKUP_ROOT", CONTAINER_BACKUP_ROOT);
  const secretRoot = dirname(configPath);
  if (allowTestRoots) {
    for (const [label, value] of [["verification data root", dataDir], ["verification backup root", backupRoot], ["verification native secret root", secretRoot]]) {
      if (!value.startsWith("/tmp/")) throw new Error(`${label} test roots must remain below /tmp`);
    }
  } else {
    assertContainerPath(dataDir, CONTAINER_DATA_ROOT, "verification data root");
    assertContainerPath(backupRoot, CONTAINER_BACKUP_ROOT, "verification backup root");
    assertContainerPath(secretRoot, CONTAINER_SECRET_ROOT, "verification native secret root");
  }
  assertVerificationPaths({ dataRoot: dataDir, backupRoot, nativeSecretDir: secretRoot, allowTestRoots, scope: "container" });
  const config = await readConfig(configPath, allowTestRoots);
  const prebackupMode = process.env.FIELD_RESET_PREBACKUP || "";
  if (!["host", "container"].includes(prebackupMode)) {
    throw new Error("FIELD_RESET_PREBACKUP must be explicitly host or container");
  }
  const hostManagedBackup = prebackupMode === "host";
  const backupPath = hostManagedBackup
    ? "host-managed-pre-reset-backup"
    : join(backupRoot, `pre-reset-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (!hostManagedBackup) {
    await mkdir(backupRoot, { recursive: true });
    if (existsSync(dataDir)) {
      await rm(backupPath, { recursive: true, force: true });
      // The container-owned fallback is only for an explicitly selected test
      // contract. Host promotion/reset always selects FIELD_RESET_PREBACKUP=host
      // and snapshots outside the container before this process starts.
      const { cp } = await import("../../server/storage/fs-promises.js");
      await cp(dataDir, backupPath, { recursive: true, errorOnExist: true });
    }
  }
  // Never remove the bind-mount root. Removing it makes Docker recreate a
  // host directory with the wrong ownership and breaks the next invocation.
  await clearDirectoryChildren(dataDir);

  // Seed the sanitized field-verification price-catalog items via
  // the same supported path any catalogue item uses (the catalogue store's
  // createItem(), which the POST /items route and the /pricing UI both
  // call). This is required, not optional: once the price catalog has any
  // active item, Field's quote engine prices every rule from its matching
  // catalogue item instead of json5 unitPrice (see the comment on
  // VERIFICATION_CATALOG_ITEMS in fixtures.js), so every field-verification
  // rule — not only the three new disposal ones — needs a matching item or
  // the existing reviewed fixture totals would silently change.
  //
  // The catalogue lives in the verification installation's PostgreSQL, not
  // the data directory, so clearing the directory does not clear it: replace
  // its contents with exactly the reviewed fixture items.
  await runMigrations();
  // FIELD_ORG names the organisation whose catalogue is replaced (default embark).
  const catalog = await openCatalogStore({ dataDir, orgUid: (await resolveDeploymentOrg(getDb())).uid });
  await replaceCatalogItems(catalog, VERIFICATION_CATALOG_ITEMS, { author: "field-verification-reset" });

  // The verification contract is intentionally exact: do not add null legacy
  // integration keys because their presence would make the boundary ambiguous.
  const fixtureConfig = { ...config, priceCatalog: catalog };
  const seeded = [];
  for (const fixture of VERIFICATION_FIXTURES) {
    const transcript = buildTranscript(fixture);
    const persisted = await writeFixture(fixtureJobDirectory(dataDir, fixture), fixture, transcript, fixtureConfig);
    if (fixture.verificationRole === "invoice-fixture") {
      const jobDir = fixtureJobDirectory(dataDir, fixture);
      const locked = await updateJobQuote({
        jobDir,
        meta: persisted.meta,
        config: fixtureConfig,
        patch: { lockStatus: "final" },
        actor: { kind: "system", label: "Field verification" },
      });
      if (locked.quoteOverrides?.lockStatus !== REVIEWED_SEMANTIC_MANIFEST.customerFacingRevision.lockStatus) {
        throw new Error("verification invoice fixture did not retain the reviewed final quote lock");
      }
      // Assert the quote actually persisted to disk by the lock
      // step, not only the pre-lock in-memory `persisted` value captured below
      // from writeFixture(). Locking must not re-price — a regression that
      // reintroduces a rebuild-on-lock would leave this on-disk total wrong
      // while the pre-lock in-memory check below kept passing.
      const lockedExpectedTotal = Number(REVIEWED_SEMANTIC_MANIFEST.fixtureTotals[fixture.id]);
      const lockedArtifacts = await readQuoteArtifacts(jobDir);
      const lockedTotal = Number(lockedArtifacts?.quote?.totals?.total || 0);
      if (!Number.isFinite(lockedTotal) || lockedTotal !== lockedExpectedTotal) {
        throw new Error(
          `verification fixture ${fixture.id} persisted post-lock total ${lockedTotal} does not match reviewed total ${lockedExpectedTotal}`
        );
      }
      // Send, land, milestones and issuance are one staged generation: a
      // committed generation is never written in place, or it fails
      // validation and the fixture silently falls back to an older one.
      const sentAt = "2026-01-15T09:30:00.000Z";
      await runAtomicJobGeneration(jobDir, async (stagedJobDir) => {
        const sentMeta = await writeJobMeta(stagedJobDir, {
          ...locked.meta,
          pipelineStage: "sent",
          deliveryStatus: "sent",
          quoteSentAt: sentAt,
        });
        await recordQuoteSent({
          jobDir: stagedJobDir,
          meta: sentMeta,
          quoteVersion: sentMeta.quoteVersion,
          to: "verification.customer@example.invalid",
          sentAt,
        });
        const landed = await markJobLanded({
          jobDir: stagedJobDir,
          meta: sentMeta,
          dataDir,
          config: fixtureConfig,
          actor: { kind: "system", label: "Field verification" },
        });
        await generateJobMilestones({
          jobDir: stagedJobDir,
          meta: landed.meta,
          config: fixtureConfig,
          paymentSchedule: {
            milestones: [
              { label: "Verification deposit", percentage: 50 },
              { label: "Verification completion", percentage: 50 },
            ],
          },
          actor: { kind: "system", label: "Field verification" },
        });
        await recordIssuedQuoteDocuments({
          jobDir: stagedJobDir,
          quoteVersion: sentMeta.quoteVersion,
          documentType: "quote",
          quoteSnapshotDigest: lockedArtifacts.quote?.pricing?.attestation?.snapshotDigest || null,
          issuedAt: sentAt,
          deliveryResult: {
            messageId: "field-verification-synthetic-delivery",
            documentType: "quote",
            to: "verification.customer@example.invalid",
          },
          quoteMarkdown: lockedArtifacts.quoteMarkdown,
          reportMarkdown: lockedArtifacts.quoteMarkdown,
        });
      });
      // Assert the on-disk total once more after the full
      // lock -> send -> land -> milestone sequence, not only right after the
      // lock step above. No rebuild path is reachable from markJobLanded or
      // generateJobMilestones today, so this is expected to be a no-op check
      // — that's the point: it's the guard that keeps it a no-op if a future
      // change to either introduces one.
      const finalExpectedTotal = Number(REVIEWED_SEMANTIC_MANIFEST.fixtureTotals[fixture.id]);
      const finalArtifacts = await readQuoteArtifacts(jobDir);
      const finalTotal = Number(finalArtifacts?.quote?.totals?.total || 0);
      if (!Number.isFinite(finalTotal) || finalTotal !== finalExpectedTotal) {
        throw new Error(
          `verification fixture ${fixture.id} persisted total ${finalTotal} does not match reviewed total ${finalExpectedTotal} after the full lock/send/land/milestone sequence`
        );
      }
    }
    const total = Number(persisted.quote?.totals?.total || 0);
    const expectedTotal = Number(REVIEWED_SEMANTIC_MANIFEST.fixtureTotals[fixture.id]);
    if (!Number.isFinite(total) || total !== expectedTotal) {
      throw new Error(`verification fixture ${fixture.id} total ${total} does not match reviewed total ${expectedTotal}`);
    }
    seeded.push({ id: persisted.meta.id, title: persisted.meta.title, total });
  }
  const marker = buildFixtureMarker({ stateTreeSha256: await hashVerificationTree(dataDir) });
  await writeFile(join(dataDir, ".field-verification-fixture-marker.json"), JSON.stringify(marker, null, 2));
  const writtenMarker = JSON.parse(await readFile(join(dataDir, ".field-verification-fixture-marker.json"), "utf8"));
  assertFixtureMarker(writtenMarker);
  if (writtenMarker.stateTreeSha256 !== await hashVerificationTree(dataDir)) {
    throw new Error("verification fixture marker does not match the generated semantic state tree");
  }
  console.log(`[field-verification-reset] backed up prior data at ${backupPath}`);
  console.log(`[field-verification-reset] seeded ${seeded.length} synthetic fixtures with marker ${marker.marker}`);
  for (const item of seeded) console.log(`[field-verification-reset] ${item.id} ${item.title} total=${Number(item.total).toFixed(2)}`);
}

export async function verify({
  dataDir = requiredPath("FIELD_DATA", CONTAINER_DATA_ROOT),
  logger = console,
} = {}) {
  const markerPath = join(dataDir, ".field-verification-fixture-marker.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assertFixtureMarker(marker);
  if (marker.stateTreeSha256 !== await hashVerificationTree(dataDir)) {
    throw new Error("verification fixture marker state hash does not match the current tree");
  }
  logger.log(`[field-verification-reset] marker verified: ${marker.marker}`);
  return marker;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (args.has("--verify-only")) {
    await verify();
  } else if (!args.has("--apply")) {
    console.error("ERROR: verification reset requires --apply or --verify-only");
    process.exitCode = 1;
  } else {
    try {
      await reset();
    } catch (error) {
      console.error(`ERROR: verification reset refused: ${error.message}`);
      process.exitCode = 1;
    } finally {
      // The catalogue database connection would otherwise keep the CLI alive.
      await closeDb().catch(() => {});
    }
  }
}
