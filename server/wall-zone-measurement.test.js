import assert from "node:assert/strict";
import test from "node:test";

import { deriveWallZoneMeasurement } from "./wall-zone-measurement.js";

const DESIGN = {
  construction_rules: {
    bay_pitch_mm: 2010,
    min_remainder_for_extra_bay_mm: 500,
  },
};

test("deriveWallZoneMeasurement clips explicit fallback segments instead of pricing the full path", () => {
  const points = [
    { path: "1", point: 1, x: 0, y: 0, z: 0, pathType: "Dot2Dot" },
    { path: "1", point: 2, x: 7.029, y: 0, z: -0.402, pathType: "Dot2Dot" },
    { path: "1", point: 3, x: 6.95, y: 7.766, z: 0.135, pathType: "Dot2Dot" },
  ];

  const measurement = deriveWallZoneMeasurement({
    points,
    zone: {
      expectedLengthM: 7.03,
      profileSegment: {
        path: 1,
        fromPoint: 1,
        toPoint: 2,
      },
    },
    design: DESIGN,
  });

  assert.equal(measurement.sourceMode, "path1_profile_segment");
  assert.equal(measurement.selection?.strategy, "explicit_segment");
  assert.equal(measurement.perimeter_m, 7.029);
  assert.equal(measurement.n_bays, 4);
});

test("deriveWallZoneMeasurement picks the best matching fallback subsegment when a target length is supplied", () => {
  const points = [
    { path: "1", point: 1, x: 0, y: 0, z: 0, pathType: "Dot2Dot" },
    { path: "1", point: 2, x: 6.358, y: 0, z: -0.354, pathType: "Dot2Dot" },
    { path: "1", point: 3, x: 6.358, y: 0, z: -0.355, pathType: "Dot2Dot" },
    { path: "1", point: 4, x: 7.82, y: 8.866, z: 0.223, pathType: "Dot2Dot" },
  ];

  const measurement = deriveWallZoneMeasurement({
    points,
    zone: {
      expectedLengthM: 6.36,
    },
    design: DESIGN,
  });

  assert.equal(measurement.sourceMode, "path1_profile_segment");
  assert.equal(measurement.selection?.strategy, "best_length_match");
  assert.equal(measurement.selection?.fromPoint, 1);
  assert.equal(measurement.selection?.toPoint, 2);
  assert.equal(measurement.perimeter_m, 6.358);
  assert.equal(measurement.n_bays, 3);
});

test("deriveWallZoneMeasurement keeps full-path fallback when no clip hints exist", () => {
  const points = [
    { path: "1", point: 1, x: 0, y: 0, z: 0, pathType: "Dot2Dot" },
    { path: "1", point: 2, x: 7.029, y: 0, z: -0.402, pathType: "Dot2Dot" },
    { path: "1", point: 3, x: 6.95, y: 7.766, z: 0.135, pathType: "Dot2Dot" },
  ];

  const measurement = deriveWallZoneMeasurement({
    points,
    zone: {},
    design: DESIGN,
  });

  assert.equal(measurement.sourceMode, "path1_profile_from_origin");
  assert.equal(measurement.selection?.strategy, "full_path");
  assert.equal(measurement.perimeter_m, 14.795);
  assert.equal(measurement.n_bays, 8);
});
