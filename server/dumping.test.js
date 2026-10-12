import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SOIL_DUMP,
  DEFAULT_SOIL_DUMPS,
  haversineDistanceKm,
  estimateDrivingDistanceKm,
  estimateDriveMinutes,
  sortDumpsByDistance,
} from "../shared/dumping.js";

test("dump sites carry only site facts — no rate, cost, charge, or markup fields", () => {
  for (const dump of DEFAULT_SOIL_DUMPS) {
    assert.equal("rate" in dump, false);
    assert.equal("disposalOptions" in dump, false);
    assert.equal(typeof dump.id, "string");
    assert.equal(typeof dump.name, "string");
    assert.equal(typeof dump.suburb, "string");
    assert.equal(typeof dump.addr, "string");
    assert.equal(typeof dump.dist, "number");
    assert.equal(typeof dump.drive, "number");
    assert.equal(typeof dump.lat, "number");
    assert.equal(typeof dump.lng, "number");
    assert.equal(typeof dump.hours, "string");
    assert.equal(typeof dump.open, "boolean");
    assert.equal(Array.isArray(dump.accepts), true);
  }
});

test("default soil dump points at the Wingfield Integrated Waste Services site", () => {
  assert.equal(DEFAULT_SOIL_DUMP.id, "integrated-waste-services-wingfield");
  assert.equal(DEFAULT_SOIL_DUMP.defaultForUnspecified, true);
  assert.deepEqual(DEFAULT_SOIL_DUMP.accepts, ["clean fill", "unclean fill", "concrete waste", "green waste"]);
});

test("haversineDistanceKm returns zero for identical points", () => {
  assert.equal(haversineDistanceKm(-34.9, 138.6, -34.9, 138.6), 0);
});

test("estimateDrivingDistanceKm applies the metro correction factor", () => {
  assert.equal(estimateDrivingDistanceKm(10), 13.5);
});

test("estimateDriveMinutes assumes ~50 km/h average", () => {
  assert.equal(estimateDriveMinutes(25), 30);
});

test("sortDumpsByDistance orders sites nearest first and recomputes dist/drive", () => {
  const sorted = sortDumpsByDistance(DEFAULT_SOIL_DUMPS, -34.9285, 138.6007);
  assert.equal(sorted.length, DEFAULT_SOIL_DUMPS.length);
  assert.equal(sorted[0].dist <= sorted[1].dist, true);
  for (const dump of sorted) {
    assert.equal(typeof dump.dist, "number");
    assert.equal(typeof dump.drive, "number");
  }
});
