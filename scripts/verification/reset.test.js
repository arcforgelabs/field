import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFixtureMarker,
  buildFixtureMarker,
  CATALOG_MANIFEST_SHA256,
  FIXTURE_MANIFEST_SHA256,
  FIXTURE_MARKER,
  VERIFICATION_FIXTURES,
} from "./fixtures.js";
import { rejectReplitRuntime } from "./reset.js";

test("verification reset refuses to run on Replit, where DATABASE_URL is the live catalogue", () => {
  for (const env of [{ FIELD_RUNTIME: "replit" }, { REPLIT_DEPLOYMENT: "1" }, { REPL_ID: "x" }]) {
    assert.throws(() => rejectReplitRuntime(env), /refuses to run on Replit/);
  }
  assert.doesNotThrow(() => rejectReplitRuntime({ FIELD_VERIFICATION_DETERMINISTIC: "1" }));
});

test("verification fixture marker is cryptographically tied to the reviewed fixture and catalog manifests", () => {
  const marker = buildFixtureMarker();
  assert.equal(marker.marker, FIXTURE_MARKER);
  assert.equal(marker.marker, `field-verification-fixtures-v1:${FIXTURE_MANIFEST_SHA256}`);
  assert.equal(marker.fixtureManifestSha256.length, 64);
  assert.equal(marker.catalogManifestSha256, CATALOG_MANIFEST_SHA256);
  assert.equal(marker.catalogManifestSha256.length, 64);
  assert.deepEqual(marker.fixtureIds, VERIFICATION_FIXTURES.map((fixture) => fixture.id));
  assert.equal(marker.customerFacingRevision.locked, true);
  assert.doesNotThrow(() => assertFixtureMarker(marker));
});

test("verification fixture marker rejects missing or foreign fixture IDs", () => {
  const marker = buildFixtureMarker();
  assert.throws(() => assertFixtureMarker({ ...marker, marker: "wrong" }), /marker/i);
  assert.throws(() => assertFixtureMarker({ ...marker, catalogManifestSha256: "0".repeat(64) }), /catalog manifests/i);
  assert.throws(() => assertFixtureMarker({ ...marker, fixtureIds: ["customer-job"] }), /IDs/i);
});
