import assert from "node:assert/strict";
import test from "node:test";
import { getQuoteCatalog } from "../../server/quote-catalogs.js";

import {
  assertDigest,
  assertVerificationConfig,
  assertVerificationHost,
  assertVerificationPaths,
  assertVerificationUrl,
  imageReference,
  VERIFICATION_CONTRACT,
} from "./contract.js";

test("verification contract locks the verification host and roots", () => {
  assert.equal(assertVerificationHost(VERIFICATION_CONTRACT.hostAlias), VERIFICATION_CONTRACT.hostAlias);
  assert.deepEqual(assertVerificationPaths({
    dataRoot: VERIFICATION_CONTRACT.dataRoot,
    backupRoot: VERIFICATION_CONTRACT.backupRoot,
    nativeSecretDir: VERIFICATION_CONTRACT.nativeSecretDir,
  }), {
    dataRoot: VERIFICATION_CONTRACT.dataRoot,
    backupRoot: VERIFICATION_CONTRACT.backupRoot,
    nativeSecretDir: VERIFICATION_CONTRACT.nativeSecretDir,
  });
  assert.equal(imageReference(`sha256:${"a".repeat(64)}`), `${VERIFICATION_CONTRACT.imageRepository}@sha256:${"a".repeat(64)}`);
  assert.deepEqual(assertVerificationPaths({
    dataRoot: VERIFICATION_CONTRACT.containerDataRoot,
    backupRoot: VERIFICATION_CONTRACT.containerBackupRoot,
    nativeSecretDir: VERIFICATION_CONTRACT.containerNativeSecretDir,
    scope: "container",
  }), {
    dataRoot: VERIFICATION_CONTRACT.containerDataRoot,
    backupRoot: VERIFICATION_CONTRACT.containerBackupRoot,
    nativeSecretDir: VERIFICATION_CONTRACT.containerNativeSecretDir,
  });
  assert.throws(() => assertVerificationPaths({
    dataRoot: VERIFICATION_CONTRACT.dataRoot,
    backupRoot: VERIFICATION_CONTRACT.backupRoot,
    nativeSecretDir: VERIFICATION_CONTRACT.nativeSecretDir,
    scope: "container",
  }), /locked runtime contract/i);
});

test("verification contract rejects mutable images, wrong hosts, and unsafe endpoints", () => {
  assert.throws(() => assertDigest("latest"), /digest/i);
  assert.throws(() => assertVerificationHost("other-host"), /host/i);
  assert.throws(() => assertVerificationUrl("https://field.customer.example"), /forbidden|outside/i);
  assert.equal(assertVerificationUrl("http://127.0.0.1:19220", { allowLocalTest: true }), "http://127.0.0.1:19220");
});

test("verification config requires an independent runtime identity", () => {
  const config = {
    dataDir: "/var/lib/field-verification/data",
    authToken: "runtime-supplied-token",
    fieldVerification: {
      enabled: true,
      installationId: "field-verification",
      publicUrl: VERIFICATION_CONTRACT.publicUrl,
      catalogId: "field-verification",
      deploymentTheme: "field-verification",
      nativeSecretLookup: "disabled",
    },
    deploymentTheme: "field-verification",
    workerDisplayName: "Field Verification",
    quoteCatalogId: "field-verification",
    bootstrapUsers: [{ email: "field-verification@example.invalid", password: "runtime-supplied-password" }],
    syntheticCredentialProvenance: {
      schemaVersion: 1,
      kind: "generated-synthetic-credential",
      installationId: "field-verification",
      domain: "example.invalid",
      identityEmail: "field-verification@example.invalid",
      generated: true,
    },
  };
  assert.doesNotThrow(() => assertVerificationConfig(config, { dataDir: "/var/lib/field-verification/data" }));
  assert.throws(() => assertVerificationConfig({ ...config, workerDisplayName: "Google OAuth service account" }, { dataDir: config.dataDir }), /forbidden/i);
  assert.throws(() => assertVerificationConfig({ ...config, fieldVerification: { ...config.fieldVerification, installationId: "customer" } }, { dataDir: config.dataDir }), /identity|forbidden/i);
  assert.throws(() => assertVerificationConfig({ ...config, googleOAuth: { clientSecret: "forbidden" } }, { dataDir: config.dataDir }), /unknown|forbidden/i);
  assert.throws(() => assertVerificationConfig({ ...config, deploymentTheme: "customer-theme" }, { dataDir: config.dataDir }), /forbidden|catalog|theme/i);
  assert.throws(() => assertVerificationConfig({ ...config, syntheticCredentialProvenance: { ...config.syntheticCredentialProvenance, generated: false } }, { dataDir: config.dataDir }), /provenance/i);
});

test("verification catalog is synthetic and covers the fixture pricing paths", () => {
  const catalog = getQuoteCatalog("field-verification");
  assert.equal(catalog.id, "field-verification");
  assert.equal(catalog.businessProfile.email, "field-verification@example.invalid");
  for (const code of [
    "concrete-surface-demolition",
    "tip-truck",
    "imported-fill",
    "block-edging-supply-install",
    "plant-supply-install",
    "irrigation-system-install",
    "retaining-wall",
    "drainage",
    "site-establishment",
    "cleanup",
  ]) {
    assert.ok(catalog.rules.some((rule) => rule.code === code), `missing verification rule ${code}`);
  }
  assert.notEqual(catalog.businessProfile.email, getQuoteCatalog("default").businessProfile.email, "verification never shares the sample catalogue identity");
});
