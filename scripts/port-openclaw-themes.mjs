#!/usr/bin/env node
// Ports OpenClaw's Control UI theme families into Field's --t-* tokens.
//
//   node scripts/port-openclaw-themes.mjs <openclaw-checkout> [<upstream-commit>]
//
// Reads ui/src/styles/base.css (the Claw base, dark and light) and
// ui/public/themes/<family>.css, resolves each family's light and dark palette
// the way the Control UI cascade does, maps it onto Field's tokens and writes
// shared/theme-palettes.js. Field's own family (Field Crew) is hand-authored in
// shared/themes.js and is not touched. See DESIGN.md.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readableOn } from "../shared/color-contrast.js";

const root = resolve(process.argv[2] || "");
const commit = process.argv[3] || "unknown";
if (!process.argv[2]) {
  console.error("usage: port-openclaw-themes.mjs <openclaw-checkout> [<upstream-commit>]");
  process.exit(2);
}

// Order, labels and descriptions follow upstream's theme picker (en-settings.ts).
const FAMILIES = [
  ["claw", "Claw", "Chroma family"],
  ["knot", "Knot", "Black & red"],
  ["dash", "Dash", "Chocolate blueprint"],
  ["absolutely", "Absolutely", "Clay on graphite"],
  ["tide", "Tide", "Slate & steel"],
  ["beacon", "Beacon", "Maximum contrast"],
  ["phosphor", "Phosphor", "Green on glass"],
  ["crt", "CRT", "Console mono"],
  ["manuscript", "Manuscript", "Ink on paper"],
  ["rose", "Rosé", "Plum & rose"],
  ["miami", "Miami", "Magenta & cyan"],
];

// Upstream ships its faces as plain families; Field bundles the fontsource
// variable builds, whose family names carry a " Variable" suffix.
const FONT_ALIASES = {
  "Instrument Sans": "Instrument Sans Variable",
  "Geist": "Geist Variable",
  "DM Sans": "DM Sans Variable",
  "Space Grotesk": "Space Grotesk Variable",
  "IBM Plex Sans": "IBM Plex Sans Variable",
  "Atkinson Hyperlegible Next": "Atkinson Hyperlegible Next Variable",
  "Lora": "Lora Variable",
  "JetBrains Mono": "JetBrains Mono Variable",
};

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Top-level rules only; at-rules (@media, @supports) are skipped whole.
function parseRules(css) {
  const text = stripComments(css);
  const rules = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (!prelude.startsWith("@") && !body.includes("{")) {
      const decls = {};
      for (const part of body.split(";")) {
        const m = part.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i);
        if (m) decls[m[1]] = m[2].replace(/\s+/g, " ");
      }
      rules.push({ selectors: prelude.split(",").map((s) => s.trim()), decls });
    }
    i = j;
  }
  return rules;
}

function merged(rules, selector) {
  const out = {};
  for (const rule of rules) if (rule.selectors.includes(selector)) Object.assign(out, rule.decls);
  return out;
}

// Replace var(--x[, fallback]) with the resolved value, recursively.
function resolveVars(value, vars, depth = 0) {
  if (depth > 20) throw new Error(`var() cycle near ${value}`);
  let out = "";
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf("var(", i);
    if (start < 0) { out += value.slice(i); break; }
    out += value.slice(i, start);
    let depthParen = 1;
    let j = start + 4;
    while (j < value.length && depthParen > 0) {
      if (value[j] === "(") depthParen += 1;
      else if (value[j] === ")") depthParen -= 1;
      j += 1;
    }
    const inner = value.slice(start + 4, j - 1);
    const comma = inner.indexOf(",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim();
    const raw = vars[name] ?? fallback;
    if (raw == null) throw new Error(`unresolved ${name}`);
    out += resolveVars(raw, vars, depth + 1);
    i = j;
  }
  return out;
}

function fieldFont(stack) {
  return stack.replace(/"([^"]+)"/g, (_match, family) =>
    FONT_ALIASES[family] ? `'${FONT_ALIASES[family]}', '${family}'` : `'${family}'`);
}

const mix = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

// Upstream token -> Field token. Field's own semantics (DESIGN.md) decide the
// mapping: --t-accent must be readable as text, --t-brand is the fill colour.
function toField(v, mode, shape) {
  const get = (name) => resolveVars(`var(${name})`, v);
  return {
    "--t-bg": get("--bg"),
    "--t-s1": get("--bg-accent"),
    "--t-s2": get("--bg-hover"),
    "--t-paper": get("--card"),
    "--t-brd": get("--border"),
    "--t-brd-hi": get("--border-hover"),
    "--t-stroke-color": get("--border-strong"),
    "--t-text": get("--text"),
    "--t-strong": get("--text-strong"),
    "--t-dim": get("--muted"),
    "--t-mute": get("--muted"),
    // Field's --t-accent is text; a few upstream accents sit just under 4.5:1.
    "--t-accent": readableOn(get("--accent"), get("--bg")),
    "--t-accent-bg": get("--accent-subtle"),
    "--t-accent-brd": get("--accent"),
    "--t-brand": get("--accent"),
    "--t-brand-ink": get("--accent-foreground"),
    "--t-primary": get("--primary"),
    "--t-on-primary": get("--primary-foreground"),
    "--t-ring": get("--ring"),
    "--t-mark-ink": get("--text-strong"),
    "--t-mark-yellow": "#fdc901",
    "--t-warn": get("--warn"),
    "--t-warn-bg": get("--warn-subtle"),
    "--t-warn-brd": mix(get("--warn"), 32),
    "--t-danger": get("--danger"),
    "--t-danger-bg": get("--danger-subtle"),
    "--t-danger-brd": mix(get("--danger"), 45),
    "--t-success": get("--ok"),
    "--t-success-bg": get("--ok-subtle"),
    "--t-frame-bg": get("--bg-accent"),
    "--t-frame-brd": get("--border"),
    "--t-time": mix(get("--text"), 53),
    "--t-hi-bar": mix(get("--text"), 16),
    "--t-paper-line": mix(get("--text"), 6),
    "--t-paper-margin": get("--accent-subtle"),
    "--t-paper-text": get("--text"),
    "--t-paper-dim": get("--muted"),
    "--t-body": fieldFont(get("--font-body")),
    "--t-display": fieldFont(get("--font-display")),
    "--t-data": fieldFont(get("--mono")),
    "--t-radius": shape.radius,
    "--t-radius-lg": shape.radiusLg,
    "--t-stroke": "1px",
    "--t-label-size": "11px",
    "--t-label-weight": "600",
    "--t-label-spacing": ".06em",
    "--t-label-case": "uppercase",
    "--t-display-weight": "700",
    "--t-shadow": get("--shadow-md"),
    "color-scheme": mode,
  };
}

const ui = join(root, "ui");
const base = parseRules(readFileSync(join(ui, "src/styles/base.css"), "utf8"));
const baseDark = merged(base, ":root");
const baseLight = { ...baseDark, ...merged(base, ':root:where([data-theme-mode="light"])') };

const families = {};
for (const [id, label, description] of FAMILIES) {
  let dark;
  let light;
  if (id === "claw") {
    dark = { ...baseDark, ...merged(base, ':root[data-theme="dark"]') };
    light = { ...baseLight, ...merged(base, ':root[data-theme="light"]') };
  } else {
    const rules = parseRules(readFileSync(join(ui, "public/themes", `${id}.css`), "utf8"));
    const selectorId = id === "knot" ? "openknot" : id;
    dark = { ...baseDark, ...merged(rules, `:root[data-theme="${selectorId}"]`) };
    light = { ...baseLight, ...merged(rules, `:root[data-theme="${selectorId}-light"]`) };
  }
  // Upstream's --radius-sm suits Field's dense controls; CRT flattens it.
  const shape = {
    radius: resolveVars("var(--radius-sm)", dark),
    radiusLg: resolveVars("var(--radius-md)", dark),
  };
  families[id] = {
    label,
    description,
    source: "openclaw",
    light: toField(light, "light", shape),
    dark: toField(dark, "dark", shape),
  };
}

const out = `// Generated by scripts/port-openclaw-themes.mjs from openclaw/openclaw
// ${commit} (MIT, Copyright (c) 2026 OpenClaw Foundation). Do not edit by
// hand: change the converter or re-run it against a newer upstream checkout.
// Field's own family lives in shared/themes.js.

export const OPENCLAW_UPSTREAM_COMMIT = ${JSON.stringify(commit)};

export const OPENCLAW_FAMILIES = ${JSON.stringify(families, null, 2)};
`;
const target = join(fileURLToPath(new URL("..", import.meta.url)), "shared/theme-palettes.js");
writeFileSync(target, out);
console.log(`wrote ${Object.keys(families).length} families to ${target}`);
