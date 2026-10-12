import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { assertFixtureMarker, FIXTURE_MARKER, VERIFICATION_FIXTURES } from "./fixtures.js";
import { fixtureJobDirectory, reset } from "./reset.js";
import { ensureVerificationFixtureState } from "./start.js";
import { hashVerificationTree } from "./tree-hash.js";
import { closeDb, createTestDb } from "../../server/db-runtime/index.js";
import { openCatalogStore } from "../../server/catalog/index.js";
import { initializePriceCatalogRuntime, resolvePriceCatalogStartupPolicy } from "../../server/price-catalog/catalog-runtime.js";
import { refreshQuoteCatalogAuthority } from "../../server/quote-catalogs.js";
import { findIssuedQuoteVersion, readIssuedQuoteArtifact, readQuoteIssuanceLedger } from "../../server/quote-issuance.js";

const execFile = promisify(execFileCallback);
const SYNTHETIC_CREDENTIAL_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  kind: "generated-synthetic-credential",
  installationId: "field-verification",
  domain: "example.invalid",
  identityEmail: "field-verification@example.invalid",
  generated: true,
});

async function readTree(root) {
  const result = {};
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) await walk(path, relative);
      else result[relative] = await readFile(path, "utf8");
    }
  }
  await walk(root);
  return result;
}

async function readBinaryFiles(root) {
  const result = {};
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) await walk(path, relative);
      else result[relative] = await readFile(path);
    }
  }
  await walk(root);
  return result;
}

function configFor(dataDir) {
  return {
    dataDir,
    authToken: "verification-token-fixture",
    fieldVerification: {
      enabled: true,
      installationId: "field-verification",
      publicUrl: "https://field-verification.example.invalid",
      catalogId: "field-verification",
      deploymentTheme: "field-verification",
      nativeSecretLookup: "disabled",
    },
    deploymentTheme: "field-verification",
    workerDisplayName: "Field Verification",
    quoteCatalogId: "field-verification",
    bootstrapUsers: [{ email: "field-verification@example.invalid", password: "verification-password-fixture", role: "admin" }],
    syntheticCredentialProvenance: SYNTHETIC_CREDENTIAL_PROVENANCE,
  };
}

test("verification reset backs up first, seeds only deterministic fixtures, and is repeatable", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-verification-reset-test-"));
  const configDir = join(root, "secrets");
  const dataDir = join(root, "data");
  const backupDir = join(root, "backups");
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "old-state.txt"), "pre-reset", "utf8");
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    dataDir,
    authToken: "verification-token-fixture",
    fieldVerification: {
      enabled: true,
      installationId: "field-verification",
      publicUrl: "https://field-verification.example.invalid",
      catalogId: "field-verification",
      deploymentTheme: "field-verification",
      nativeSecretLookup: "disabled",
    },
    deploymentTheme: "field-verification",
    workerDisplayName: "Field Verification",
    quoteCatalogId: "field-verification",
    bootstrapUsers: [{ email: "field-verification@example.invalid", password: "verification-password-fixture", role: "admin" }],
    syntheticCredentialProvenance: SYNTHETIC_CREDENTIAL_PROVENANCE,
  }), "utf8");
  process.env.FIELD_ENV = "field-verification";
  process.env.FIELD_CONFIG = join(configDir, "config.json");
  process.env.FIELD_DATA = dataDir;
  process.env.FIELD_BACKUP_ROOT = backupDir;
  process.env.FIELD_VERIFICATION_TEST_MODE = "1";
  process.env.FIELD_RESET_PREBACKUP = "container";
  // The catalogue lives in PostgreSQL: an in-memory PGlite this process's
  // getDb() returns for the whole test.
  await createTestDb({ install: true });
  try {
    await reset();
    const marker = JSON.parse(await readFile(join(dataDir, ".field-verification-fixture-marker.json"), "utf8"));
    assertFixtureMarker(marker);
    assert.equal(marker.marker, FIXTURE_MARKER);
    assert.deepEqual(marker.fixtureIds, VERIFICATION_FIXTURES.map((fixture) => fixture.id));
    assert.equal(marker.customerFacingRevision.locked, true);
    const invoiceFixture = VERIFICATION_FIXTURES.find((fixture) => fixture.id === marker.invoiceFixtureId);
    const invoiceJobDir = fixtureJobDirectory(dataDir, invoiceFixture);
    const issuanceRecord = findIssuedQuoteVersion(await readQuoteIssuanceLedger(invoiceJobDir), 1, "quote");
    assert.ok(issuanceRecord, "verification reset must record exact issued quote bytes");
    const issuedMarkdown = await readIssuedQuoteArtifact(invoiceJobDir, issuanceRecord, "quoteMarkdown");
    assert.equal(issuedMarkdown.available, true);
    assert.match(issuedMarkdown.bytes.toString("utf8"), /Synthetic/);
    const canonicalBeforeVolatileState = await hashVerificationTree(dataDir);
    await writeFile(join(dataDir, "users.json"), JSON.stringify({ tokens: [{ token: "volatile" }] }), "utf8");
    await mkdir(join(dataDir, ".sessions", "volatile-session"), { recursive: true });
    await writeFile(join(dataDir, ".sessions", "volatile-session", "session.json"), "volatile", "utf8");
    assert.equal(await hashVerificationTree(dataDir), canonicalBeforeVolatileState, "volatile startup/session state must not change the canonical fixture hash");
    for (const [entry, bytes] of Object.entries(await readBinaryFiles(dataDir))) {
      assert.equal(bytes.includes(Buffer.from("Your Business")), false, `synthetic fixture leaked a legacy identity in ${entry}`);
      if (!String(entry).endsWith(".json")) continue;
      assert.doesNotMatch(bytes.toString("utf8"), /Your Business|quotes@example\.com/i, `synthetic fixture leaked a legacy identity in ${entry}`);
    }
    const firstBackups = await readdir(backupDir);
    assert.equal(firstBackups.length, 1);
    await reset();
    const secondBackups = await readdir(backupDir);
    assert.equal(secondBackups.length, 2);

    // The candidate starts from the retained verification state, so a catalog-
    // only image change must invalidate and rebuild that state before the
    // fail-closed server imports. Simulate the stale pre-DEL-71 marker here.
    const staleMarkerPath = join(dataDir, ".field-verification-fixture-marker.json");
    const staleMarker = JSON.parse(await readFile(staleMarkerPath, "utf8"));
    staleMarker.catalogManifestSha256 = "0".repeat(64);
    await writeFile(staleMarkerPath, JSON.stringify(staleMarker, null, 2));
    const bootstrap = await ensureVerificationFixtureState({
      logger: { warn() {} },
    });
    assert.equal(bootstrap.reset, true);
    assert.equal(process.env.FIELD_RESET_PREBACKUP, "container");
    assertFixtureMarker(JSON.parse(await readFile(staleMarkerPath, "utf8")));
    assert.equal((await readdir(backupDir)).length, 2, "host-snapshotted startup rebuild must not create a duplicate container backup");

    // Reproduce the real post-reset boot contract. DEL-71 originally checked
    // the default customer catalogue instead of this configured synthetic one
    // and also omitted one required rate-card dependency, so reset succeeded
    // and the candidate exited 1 at startup before it could be promoted.
    const runtimeConfig = { quoteCatalogId: "field-verification" };
    const runtime = await initializePriceCatalogRuntime({
      config: runtimeConfig,
      policy: resolvePriceCatalogStartupPolicy({ env: {}, isVerificationRuntime: true }),
      isVerificationRuntime: true,
      openCatalogStore: () => openCatalogStore({ dataDir, catalogId: "field-verification" }),
      refreshQuoteCatalogAuthority,
    });
    assert.ok(runtime.priceCatalog);
    assert.equal(runtime.priceCatalogFailure, null);
    assert.equal(runtimeConfig.priceCatalogStartupSnapshot?.quoteCatalog?.id, "field-verification");
    assert.equal(runtimeConfig.priceCatalogStartupSnapshot?.completeness?.baselineUsable, true);
    assert.deepEqual(runtimeConfig.priceCatalogStartupSnapshot?.completeness?.missingPriceCodes, []);
    // Reset is repeatable against the same database: the catalogue holds
    // exactly the fixture items, not two copies.
    const state = await runtime.priceCatalog.getState({ fresh: true });
    assert.equal(state.items.size, (await import("./fixtures.js")).VERIFICATION_CATALOG_ITEMS.length);
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
  } finally {
    await closeDb();
    delete process.env.FIELD_ENV;
    delete process.env.FIELD_CONFIG;
    delete process.env.FIELD_DATA;
    delete process.env.FIELD_BACKUP_ROOT;
    delete process.env.FIELD_VERIFICATION_TEST_MODE;
    delete process.env.FIELD_RESET_PREBACKUP;
    await rm(root, { recursive: true, force: true });
  }
});

test("container verification reset produces byte-equal independent state trees", async () => {
  const roots = await Promise.all([0, 1].map(async (index) => {
    const root = await mkdtemp(join(tmpdir(), `field-verification-equality-${index}-`));
    const configDir = join(root, "secrets");
    const dataDir = join(root, "data");
    const backupDir = join(root, "backups");
    await mkdir(configDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify(configFor(dataDir)), "utf8");
    await execFile(process.execPath, [
      "--require", "./scripts/verification/deterministic-preload.cjs",
      "./scripts/verification/reset.js", "--apply",
    ], {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...process.env,
        FIELD_CONFIG: join(configDir, "config.json"),
        FIELD_DATA: dataDir,
        FIELD_BACKUP_ROOT: backupDir,
        FIELD_VERIFICATION_TEST_MODE: "1",
        FIELD_VERIFICATION_DETERMINISTIC: "1",
        FIELD_RESET_PREBACKUP: "container",
        // Each seed gets its own throwaway catalogue database.
        FIELD_PGLITE_DIR: "memory://",
      },
    });
    return { root, dataDir };
  }));
  try {
    const first = await readTree(roots[0].dataDir);
    const second = await readTree(roots[1].dataDir);
    // Name the differing file before asserting. A bare deepEqual reports only
    // "Values have same structure but are not reference-equal", which says
    // nothing about which file drifted -- DEL-58 went unexplained for days on
    // that message alone. Every failure of this test means some value came
    // from a clock or source the deterministic preload cannot freeze, such as
    // a database's own clock (SQLite datetime('now'), PostgreSQL now()) rather
    // than the JS Date/crypto globals the preload stubs.
    const drifted = [...new Set([...Object.keys(first), ...Object.keys(second)])]
      .filter((name) => first[name] !== second[name]);
    assert.deepEqual(
      drifted,
      [],
      `verification reset is not byte-reproducible; these files differ between two independent seeds: ${drifted.join(", ")}. `
      + "Look for a timestamp written by a database's own wall clock (SQLite datetime('now'), PostgreSQL now()) rather than the freezable JS clock.",
    );
    assert.deepEqual(second, first);
    const marker = JSON.parse(first[".field-verification-fixture-marker.json"]);
    assert.match(marker.stateTreeSha256, /^[0-9a-f]{64}$/);
  } finally {
    await Promise.all(roots.map(({ root }) => rm(root, { recursive: true, force: true })));
  }
});
