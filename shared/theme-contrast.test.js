import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { auditTokens } from "./contrast-audit.js";
import { over, parseColor } from "./color-contrast.js";
import { THEME_FAMILIES, tokensFor } from "./themes.js";

// WCAG AA for every design system in both modes: every pair in
// shared/contrast-audit.js, so a palette change, a new family or a new
// Clerk mapping that leaves text or a control too faint fails CI.

describe("theme contrast (WCAG AA)", () => {
  for (const { id } of THEME_FAMILIES) {
    for (const mode of ["light", "dark"]) {
      test(`${id} ${mode}`, () => {
        const failing = auditTokens(tokensFor(id, mode)).filter((r) => !r.pass)
          .map((r) => `${r.id} ${r.ratio}:1 < ${r.min}:1 (${r.fg} on ${r.bg}, ${r.label})`);
        assert.deepEqual(failing, []);
      });
    }
  }

  test("a translucent colour is laid over its surface before the ratio is taken", () => {
    assert.deepEqual(parseColor("rgba(13, 78, 95, 0.5)"), [13, 78, 95, 0.5]);
    assert.deepEqual(parseColor("color-mix(in srgb, #ffffff 12%, transparent)"), [255, 255, 255, 0.12]);
    assert.equal(over("rgba(0, 0, 0, 0.5)", "#ffffff"), "#808080");
    assert.equal(over("#123456", "#ffffff"), "#123456");
    assert.throws(() => over("#000000", "rgba(0, 0, 0, 0.5)"), /opaque surface/);
  });

  test("a faint pair fails the audit", () => {
    // The Harbour dark "Primary" badge before the fix: text at 12% x 62%.
    const tokens = { ...tokensFor("harbour", "dark"), "--t-dim": "color-mix(in srgb, #d9e8ea 7.44%, transparent)" };
    const badge = auditTokens(tokens).find((r) => r.id === "clerk-badge");
    assert.equal(badge.pass, false);
    assert.ok(badge.ratio < 1.5, `${badge.ratio}`);
  });
});
