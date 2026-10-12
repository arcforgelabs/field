import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("verification server has no native secret lookup and bypasses generic runtime catalog provisioning", async () => {
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  const catalogRuntimeSource = await readFile(new URL("./price-catalog/catalog-runtime.js", import.meta.url), "utf8");
  const verificationStartSource = await readFile(new URL("../scripts/verification/start.js", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  // Field no longer resolves any model credential, so no runtime (verification
  // or product) reaches the native secret backend from server startup.
  assert.doesNotMatch(source, /obao-fetch-secret/);
  assert.doesNotMatch(source, /node:child_process/);
  assert.match(source, /FIELD_ENV === \"field-verification\"/);
  assert.match(source, /return null;/);
  assert.match(source, /initializePriceCatalogRuntime/);
  assert.match(source, /isVerificationRuntime: IS_VERIFICATION_RUNTIME/);
  // Boot opens the PostgreSQL catalogue and never provisions items into it.
  assert.match(catalogRuntimeSource, /await openCatalogStore\(\)/);
  assert.match(catalogRuntimeSource, /Boot never provisions catalogue items/);
  assert.doesNotMatch(catalogRuntimeSource, /migrateFromLedger|createItem|importLegacyCatalog/);
  assert.match(dockerfile, /CMD \["node", "server\/index\.js"\]/);
  assert.match(source, /import \{ ensureVerificationFixtureState \}/);
  assert.match(source, /await ensureVerificationFixtureState\(\)/);
  assert.match(verificationStartSource, /env\.FIELD_ENV !== VERIFICATION_ENV/);
  assert.match(verificationStartSource, /await resetState\(\)/);
  assert.match(verificationStartSource, /FIELD_RESET_PREBACKUP = "host"/);
  assert.match(source, /assertVerificationConfig\(config/);
  assert.match(source, /FIELD_IMAGE_DIGEST/);
  assert.match(source, /\/api\/verification\/identity/);
  assert.match(source, /fixtureMarker/);
  assert.match(source, /X-Field-Verification-Identity/);
  assert.match(source, /X-Field-Verification-Image-Digest/);
  assert.match(source, /X-Field-Verification-Field-Revision/);
  assert.match(source, /FIELD_REVISION/);
  assert.match(source, /DATA_DIR !== VERIFICATION_DATA_DIR/);
});
