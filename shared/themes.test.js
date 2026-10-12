import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, parseThemeId, themeCSS, themeId, THEME_FAMILIES, THEMES, tokensFor } from "./themes.js";

test("server theme ids name a family and an optional -dark", () => {
  assert.deepEqual(parseThemeId("field"), { family: "field", mode: "light" });
  assert.deepEqual(parseThemeId("field-dark"), { family: "field", mode: "dark" });
  assert.deepEqual(parseThemeId("tide-dark"), { family: "tide", mode: "dark" });
  assert.deepEqual(parseThemeId("gohub"), { family: "field", mode: "light" });
  assert.equal(themeId("miami", "dark"), "miami-dark");
  assert.equal(themeId("nope", "light"), "beacon");
});

test("themeCSS keeps the field and field-dark contract and serves every family", () => {
  assert.match(themeCSS("field"), /--t-bg: #f5f3eb;/);
  assert.match(themeCSS("field-dark"), /--t-bg: #11110d;/);
  assert.match(themeCSS("unknown"), /--t-bg: #f5f3eb;/);
  assert.match(themeCSS("tide-dark"), /--t-bg: #10151b;/);
  assert.equal(Object.keys(THEMES).length, THEME_FAMILIES.length * 2);
});

test("every family defines the same tokens in both modes, with readable text", () => {
  const keys = Object.keys(tokensFor("field", "light")).sort();
  for (const { id } of THEME_FAMILIES) {
    for (const mode of ["light", "dark"]) {
      const t = tokensFor(id, mode);
      assert.deepEqual(Object.keys(t).sort(), keys, `${id} ${mode} token set`);
      assert.ok(contrast(t["--t-text"], t["--t-bg"]) >= 4.5, `${id} ${mode} text`);
      assert.ok(contrast(t["--t-accent"], t["--t-bg"]) >= 4.5, `${id} ${mode} accent`);
    }
  }
});
