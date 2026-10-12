import assert from "node:assert/strict";
import test from "node:test";

import { nameKey } from "./catalog-name-key.js";

const NBSP = " ";

test("nameKey folds case", () => {
  assert.equal(nameKey("Widget Pro"), "widget pro");
  assert.equal(nameKey("WIDGET PRO"), "widget pro");
  assert.equal(nameKey("widget pro"), "widget pro");
});

test("nameKey trims leading and trailing whitespace", () => {
  assert.equal(nameKey("  Widget Pro  "), "widget pro");
  assert.equal(nameKey("\n\tWidget Pro\t\n"), "widget pro");
});

test("nameKey collapses internal whitespace runs, including tabs", () => {
  assert.equal(nameKey("Widget    Pro"), "widget pro");
  assert.equal(nameKey("Widget\tPro"), "widget pro");
  assert.equal(nameKey("Widget \t  Pro"), "widget pro");
});

test("nameKey trims and collapses internal NBSP (U+00A0) runs", () => {
  assert.equal(nameKey(`Widget${NBSP}Pro`), "widget pro");
  assert.equal(nameKey(`${NBSP}Widget${NBSP}Pro${NBSP}`), "widget pro");
  assert.equal(nameKey(`Widget${NBSP}${NBSP}Pro`), "widget pro");
  assert.equal(nameKey(`Widget ${NBSP}\tPro`), "widget pro");
});

test("nameKey normalizes NFD to the same key as NFC", () => {
  const nfc = "Café Blend"; // é as a single precomposed codepoint (U+00E9)
  const nfd = "Café Blend"; // e (U+0065) + combining acute accent (U+0301)
  assert.notEqual(nfc, nfd);
  assert.equal(nameKey(nfc), nameKey(nfd));
  assert.equal(nameKey(nfc), "café blend");
});

test("nameKey case-folds non-ASCII characters", () => {
  assert.equal(nameKey("CAFÉ BLEND"), nameKey("café blend"));
  assert.equal(nameKey("MÜLLER"), nameKey("müller"));
});

test("nameKey reduces whitespace-only input to an empty string", () => {
  assert.equal(nameKey("   "), "");
  assert.equal(nameKey(`\t\n${NBSP}`), "");
});

test("nameKey handles null, undefined, and non-string input defensively", () => {
  assert.equal(nameKey(null), "");
  assert.equal(nameKey(undefined), "");
  assert.equal(nameKey(42), "42");
});
