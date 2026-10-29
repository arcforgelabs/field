import assert from "node:assert/strict";
import test from "node:test";
import { extractBayHeights } from "./retaining-wall-measurement.js";

const perimeter = [0, 2, 4, 6, 8, 10].map((x) => ({ path: "1", x, y: 0, z: 5 }));

test("probe heights use the nearest perimeter point and the greatest positive height in each bay", () => {
  const result = extractBayHeights({
    bayPitchM: 2,
    points: [
      ...perimeter,
      { path: "2", x: 2.1, y: 0, z: 4.4 },
      { path: "2", x: 2, y: 0, z: 4.8 },
      { path: "2", x: 6.1, y: 0, z: 3.6 },
      { path: "2", x: 4, y: 0, z: 5 },
      { path: "2", x: 4, y: 0, z: 6 },
      { path: "2", x: NaN, y: 0, z: 0 },
      { path: "3", x: 4, y: 0, z: 0 },
    ],
  });

  // Known heights are 0.6 and 1.4. The middle bay is halfway between them.
  // Bays outside the measured span keep the nearest known height.
  assert.deepEqual(result.bayHeights.map((bay) => [bay.bay_id, bay.height_m]), [
    [1, 0.6], [2, 0.6], [3, 1], [4, 1.4], [5, 1.4],
  ]);
});

test("a design height of zero overrides a measured bay without changing the other bays", () => {
  const result = extractBayHeights({
    bayPitchM: 2,
    points: [...perimeter, { path: "2", x: 4, y: 0, z: 4 }],
    heightOverrides: { "3": { height_m: 0, reason: "Design clearance" } },
  });

  assert.deepEqual(result.bayHeights.map((bay) => bay.height_m), [1, 1, 0, 1, 1]);
  assert.deepEqual(result.bayHeights[2], {
    bay_id: 3, height_m: 0, source: "override", reason: "Design clearance",
  });
});

test("an extra bay starts at the remainder limit and its geometry stops at the endpoint", () => {
  for (const [length, expectedBays, heights] of [
    [4.499, 2, [0.25, 0.75]],
    [4.5, 3, [0.25, 0.5, 0.75]],
  ]) {
    const result = extractBayHeights({
      bayPitchM: 2,
      minRemainderForExtraBayM: 0.5,
      points: [
        { path: "1", x: 0, y: 0, z: 1 },
        { path: "1", x: length, y: 0, z: 1 },
        { path: "2", x: 0, y: 0, z: 0.75 },
        { path: "2", x: length, y: 0, z: 0.25 },
      ],
    });

    assert.equal(result.n_bays, expectedBays, `perimeter ${length}`);
    assert.deepEqual(result.bayHeights.map((bay) => bay.height_m), heights);
    if (length === 4.5) {
      assert.deepEqual(result.bayGeometry[2], {
        bay_id: 3, x_start: 4, y_start: 0, z_start: 1,
        x_end: 4.5, y_end: 0, z_end: 1,
      });
    }
  }
});

test("fewer than two valid perimeter points are refused", () => {
  assert.throws(() => extractBayHeights({ points: [
    { path: "1", x: 0, y: 0, z: 0 },
    { path: "1", x: Infinity, y: 0, z: 0 },
    { path: "2", x: 2, y: 0, z: 0 },
  ] }), /Need at least 2 perimeter/);
});
