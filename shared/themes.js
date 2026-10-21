/**
 * Field's design systems: the theme families people choose in Settings, each
 * with a light and a dark palette, plus accent colour overrides.
 *
 * This module is the one source of the --t-* tokens. The client injects
 * themeStylesheet() at startup (client/src/lib/theme.ts) and server-rendered
 * pages call themeCSS(id). Field Crew (`field`) is hand-authored here; the other
 * families are ported from OpenClaw's Control UI by
 * scripts/port-openclaw-themes.mjs into ./theme-palettes.js (DESIGN.md).
 */
import { boundaryOn, contrast, HEX, inkOn, over, readableOn, readableOnEvery } from "./color-contrast.js";
import { OPENCLAW_FAMILIES } from "./theme-palettes.js";

export { boundaryOn, contrast, inkOn, readableOn } from "./color-contrast.js";

// Field Crew: warm paper, near-black ink, the logo's yellow,
// square corners, 2px ink strokes and spaced uppercase labels. Yellow is too
// light to read on paper, so in light mode --t-accent is ink and the yellow
// lives in --t-brand; on near-black yellow reads well, so dark mode's
// --t-accent is yellow.
const FIELD_SHAPE = {
  "--t-body": "'Inter Variable', 'Inter', system-ui, sans-serif",
  "--t-display": "'Inter Variable', 'Inter', system-ui, sans-serif",
  "--t-data": "'Geist Mono Variable', 'JetBrains Mono', monospace",
  "--t-radius": "0px",
  "--t-radius-lg": "0px",
  "--t-stroke": "2px",
  "--t-label-size": "11px",
  "--t-label-weight": "700",
  "--t-label-spacing": ".12em",
  "--t-label-case": "uppercase",
  "--t-display-weight": "800",
  "--t-shadow": "none",
  "--t-mark-yellow": "#fdc901",
};

const FIELD = {
  label: "Site",
  description: "Paper, ink & yellow",
  source: "field",
  light: {
    "--t-bg": "#f5f3eb", "--t-s1": "#ebe9df", "--t-s2": "#dedbd0", "--t-paper": "#fbfaf5",
    "--t-brd": "rgba(17,17,13,.18)", "--t-brd-hi": "#11110d", "--t-stroke-color": "#11110d",
    "--t-text": "#11110d", "--t-strong": "#11110d", "--t-dim": "#616059", "--t-mute": "#706e66",
    "--t-accent": "#11110d", "--t-accent-bg": "rgba(244,197,24,.24)", "--t-accent-brd": "#d9ad0c",
    "--t-brand": "#f4c518", "--t-brand-ink": "#11110d",
    "--t-primary": "#11110d", "--t-on-primary": "#f4c518", "--t-ring": "#a88711",
    "--t-mark-ink": "#202328",
    "--t-warn": "#8a5a00", "--t-warn-bg": "rgba(138,90,0,.10)", "--t-warn-brd": "rgba(138,90,0,.30)",
    "--t-danger": "#b44329", "--t-danger-bg": "rgba(184,68,42,.10)", "--t-danger-brd": "rgba(184,68,42,.40)",
    "--t-success": "#3f6b2a", "--t-success-bg": "rgba(63,107,42,.10)",
    "--t-frame-bg": "#ebe9df", "--t-frame-brd": "rgba(17,17,13,.12)",
    "--t-time": "#11110d88", "--t-hi-bar": "rgba(17,17,13,.16)",
    "--t-paper-line": "rgba(17,17,13,.06)", "--t-paper-margin": "rgba(244,197,24,.30)",
    "--t-paper-text": "#11110d", "--t-paper-dim": "#616059",
    ...FIELD_SHAPE,
    "color-scheme": "light",
  },
  dark: {
    "--t-bg": "#11110d", "--t-s1": "#1e1e18", "--t-s2": "#2b2b24", "--t-paper": "#181813",
    "--t-brd": "rgba(245,243,235,.16)", "--t-brd-hi": "#f5f3eb", "--t-stroke-color": "#f5f3eb",
    "--t-text": "#f5f3eb", "--t-strong": "#f5f3eb", "--t-dim": "#b8b7ae", "--t-mute": "#9c9a90",
    "--t-accent": "#f4c518", "--t-accent-bg": "rgba(244,197,24,.14)", "--t-accent-brd": "rgba(244,197,24,.50)",
    "--t-brand": "#f4c518", "--t-brand-ink": "#11110d",
    "--t-primary": "#f4c518", "--t-on-primary": "#11110d", "--t-ring": "#f4c518",
    "--t-mark-ink": "#f5f3eb",
    "--t-warn": "#e0a43a", "--t-warn-bg": "rgba(224,164,58,.12)", "--t-warn-brd": "rgba(224,164,58,.32)",
    "--t-danger": "#e36a4d", "--t-danger-bg": "rgba(227,106,77,.12)", "--t-danger-brd": "rgba(227,106,77,.45)",
    "--t-success": "#8fbf6a", "--t-success-bg": "rgba(143,191,106,.12)",
    "--t-frame-bg": "#0b0b08", "--t-frame-brd": "rgba(245,243,235,.10)",
    "--t-time": "#f5f3eb88", "--t-hi-bar": "rgba(245,243,235,.18)",
    "--t-paper-line": "rgba(245,243,235,.06)", "--t-paper-margin": "rgba(244,197,24,.18)",
    "--t-paper-text": "#f5f3eb", "--t-paper-dim": "#b8b7ae",
    ...FIELD_SHAPE,
    "color-scheme": "dark",
  },
};

// Picker order: the design directions lead (Beacon is the default, Claw is
// OpenClaw's own, Site is Field's original paper and ink), then the other families.
const { beacon, tide, claw, knot, dash, ...otherOpenclaw } = OPENCLAW_FAMILIES;
const FAMILIES = { beacon, tide, claw, knot, dash, field: FIELD, ...otherOpenclaw };

// Every family keeps WCAG AA (shared/theme-contrast.test.js). A ported palette
// that misses it on a surface Field uses is nudged here, just far enough:
// secondary text on every surface, accent text on the page, cards and its own
// tint, and the ink on the brand colour. Field Crew already passes.
// --t-control: the edge of an input or an outlined button on --t-paper, the
// text colour faded toward the paper only as far as it still reads at 3:1.
for (const family of Object.values(FAMILIES)) {
  for (const mode of ["light", "dark"]) {
    const tokens = family[mode];
    const { "--t-bg": bg, "--t-paper": paper, "--t-s1": s1, "--t-s2": s2 } = tokens;
    tokens["--t-dim"] = readableOnEvery(tokens["--t-dim"], [bg, paper, s1, s2]);
    tokens["--t-accent"] = readableOnEvery(tokens["--t-accent"], [bg, paper, over(tokens["--t-accent-bg"], paper)]);
    if (contrast(tokens["--t-brand-ink"], tokens["--t-brand"]) < 4.5) tokens["--t-brand-ink"] = inkOn(tokens["--t-brand"]);
    tokens["--t-control"] = boundaryOn(paper, tokens["--t-text"]);
  }
}

/** The design system a browser starts on until someone picks another in Settings. */
export const DEFAULT_FAMILY = "beacon";
/**
 * Server-rendered pages name a theme as `<family>` (light) or `<family>-dark`.
 * They keep Field Crew so rendered documents do not change with the app's look.
 */
export const DEFAULT_THEME = "field";

/** The families in picker order: id, label, description and a preview swatch per mode. */
export const THEME_FAMILIES = Object.entries(FAMILIES).map(([id, family]) => ({
  id,
  label: family.label,
  description: family.description,
  source: family.source,
  swatches: {
    light: swatchesOf(family.light),
    dark: swatchesOf(family.dark),
  },
}));

function swatchesOf(tokens) {
  return { bg: tokens["--t-bg"], surface: tokens["--t-s1"], text: tokens["--t-text"], accent: tokens["--t-brand"], primary: tokens["--t-primary"] };
}

export function isThemeFamily(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(FAMILIES, id);
}

export function normalizeFamily(id) {
  return isThemeFamily(id) ? id : DEFAULT_FAMILY;
}

/** The --t-* tokens (and color-scheme) for a family in a resolved mode. */
export function tokensFor(familyId, mode) {
  const family = FAMILIES[normalizeFamily(familyId)];
  return family[mode === "dark" ? "dark" : "light"];
}

export function themeId(familyId, mode) {
  return `${normalizeFamily(familyId)}${mode === "dark" ? "-dark" : ""}`;
}

export function parseThemeId(id) {
  const value = typeof id === "string" ? id : "";
  const dark = value.endsWith("-dark");
  const family = dark ? value.slice(0, -5) : value;
  return isThemeFamily(family) ? { family, mode: dark ? "dark" : "light" } : { family: DEFAULT_THEME, mode: "light" };
}

/** Every server theme id, `<family>` and `<family>-dark`, to its tokens. */
export const THEMES = Object.fromEntries(
  Object.keys(FAMILIES).flatMap((id) => [
    [id, FAMILIES[id].light],
    [`${id}-dark`, FAMILIES[id].dark],
  ]),
);

function declarations(tokens, indent) {
  return Object.entries(tokens).map(([k, v]) => `${indent}${k}: ${v};`).join("\n");
}

/**
 * Returns a CSS :root block with --t-* variables for the given theme id.
 * Falls back to DEFAULT_THEME if the theme ID is unknown.
 */
export function themeCSS(id) {
  const { family, mode } = parseThemeId(id);
  return `:root {\n${declarations(tokensFor(family, mode), "    ")}\n  }`;
}

/** Every family and mode as `[data-theme][data-mode]` rules, for the client. */
export function themeStylesheet() {
  return Object.keys(FAMILIES).flatMap((id) => ["light", "dark"].map((mode) =>
    `[data-theme="${id}"][data-mode="${mode}"] {\n${declarations(FAMILIES[id][mode], "  ")}\n}`,
  )).join("\n");
}

// ── Accent colours ──────────────────────────────────────────────────────────
// Upstream's accent presets, with Field's own yellow first. "theme" keeps the
// family's accent. A custom colour is any #rrggbb.
export const ACCENT_PRESETS = [
  { id: "theme", label: "Theme default", hex: null },
  { id: "field", label: "Field yellow", hex: "#f4c518" },
  { id: "claw", label: "Claw red", hex: "#ff5c5c" },
  { id: "coral", label: "Coral", hex: "#ff8066" },
  { id: "amber", label: "Amber", hex: "#f5b942" },
  { id: "mint", label: "Mint", hex: "#52c99a" },
  { id: "teal", label: "Teal", hex: "#35b9b0" },
  { id: "blue", label: "Blue", hex: "#5b9cf6" },
  { id: "violet", label: "Violet", hex: "#a78bfa" },
  { id: "pink", label: "Pink", hex: "#f472b6" },
  { id: "slate", label: "Slate", hex: "#8795a8" },
];

export function normalizeAccent(value) {
  if (typeof value !== "string") return null;
  const preset = ACCENT_PRESETS.find((p) => p.id === value);
  if (preset) return preset.hex;
  return HEX.test(value) ? value.toLowerCase() : null;
}

/**
 * Token overrides that put an accent colour on a family's palette. The colour
 * fills brand surfaces and focus rings as chosen; --t-accent, which is text,
 * is shifted until it reads at 4.5:1 on the background.
 */
export function accentOverrides(familyId, mode, accent) {
  const hex = normalizeAccent(accent);
  if (!hex) return {};
  const base = tokensFor(familyId, mode);
  const tint = (pct) => `color-mix(in srgb, ${hex} ${pct}%, transparent)`;
  const out = {
    "--t-brand": hex,
    "--t-brand-ink": inkOn(hex),
    "--t-ring": hex,
    "--t-accent": readableOn(hex, base["--t-bg"]),
    "--t-accent-bg": tint(mode === "dark" ? 16 : 14),
    "--t-accent-brd": hex,
    "--t-paper-margin": tint(mode === "dark" ? 18 : 30),
  };
  if (base["--t-primary"] === base["--t-brand"]) {
    out["--t-primary"] = hex;
    out["--t-on-primary"] = inkOn(hex);
  } else if (base["--t-on-primary"] === base["--t-brand"]) {
    out["--t-on-primary"] = readableOn(hex, base["--t-primary"]);
  }
  return out;
}
