import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRegion, normalizeCountryCode, normalizeRegionCode, regionFromAddress } from "./regions.js";

test("reads an Australian state from its abbreviation and postcode", () => {
  assert.deepEqual(regionFromAddress("1 Example Street, Exampleton SA 5000"), { country: "AU", region: "SA" });
  assert.deepEqual(regionFromAddress("2 Sample Rd, Testville, nsw 2000"), { country: "AU", region: "NSW" });
  assert.deepEqual(regionFromAddress("Unit 3, 4 Fake Ave, Placeholder VIC"), { country: "AU", region: "VIC" });
  assert.deepEqual(regionFromAddress("5 Demo Lane, Hobart TAS. 7000"), { country: "AU", region: "TAS" });
});

test("reads a state from its full name, the longest name first", () => {
  assert.deepEqual(regionFromAddress("10 Somewhere St, Perth, Western Australia"), { country: "AU", region: "WA" });
  assert.deepEqual(regionFromAddress("Lot 9, South Australia"), { country: "AU", region: "SA" });
});

test("a lowercase word is not a state unless a postcode follows it", () => {
  assert.deepEqual(regionFromAddress("the wa shed"), { country: null, region: null });
});

test("a country alone, or nothing", () => {
  assert.deepEqual(regionFromAddress("12 Example Road, Auckland, New Zealand"), { country: "NZ", region: null });
  assert.deepEqual(regionFromAddress("Somewhere, Australia"), { country: "AU", region: null });
  assert.deepEqual(regionFromAddress(""), { country: null, region: null });
  assert.deepEqual(regionFromAddress(null), { country: null, region: null });
});

test("codes are normalized or refused", () => {
  assert.equal(normalizeCountryCode(" au "), "AU");
  assert.equal(normalizeCountryCode("AUS"), null);
  assert.equal(normalizeRegionCode("sa"), "SA");
  assert.equal(normalizeRegionCode("TOO-LONG"), null);
  assert.equal(describeRegion({ country: "AU", region: "SA" }), "South Australia, AU");
  assert.equal(describeRegion({ country: "NZ", region: null }), "NZ");
  assert.equal(describeRegion({}), "every region");
});
