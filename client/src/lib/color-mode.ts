// Appearance: which design system (theme family), light or dark, and an
// optional accent colour. The families and their tokens live in
// shared/themes.js. The choice is per browser and is a convenience, so it
// lives in localStorage next to the other fr_settings. index.html runs the
// same family and mode resolution inline before first paint so there is no
// flash; keep the two in step.
import {
  accentOverrides,
  normalizeAccent,
  normalizeFamily,
  themeStylesheet,
  tokensFor,
  DEFAULT_FAMILY,
} from "../../../shared/themes.js";

export type ColorMode = "system" | "light" | "dark";
export type ResolvedMode = "light" | "dark";

const SETTINGS_KEY = "fr_settings";
const STYLESHEET_ID = "field-themes";

function readSettings(): Record<string, unknown> {
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return settings && typeof settings === "object" ? settings : {};
  } catch {
    return {};
  }
}

function writeSetting(update: (settings: Record<string, unknown>) => void) {
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    update(settings);
    delete settings.theme; // the pre-#161 seven-theme choice no longer applies
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* storage blocked: the choice lasts for this page only */ }
}

export function readColorMode(): ColorMode {
  const mode = readSettings().colorMode;
  return mode === "light" || mode === "dark" || mode === "system" ? mode : "system";
}

export function writeColorMode(mode: ColorMode) {
  writeSetting((settings) => { settings.colorMode = mode; });
}

export function readThemeFamily(): string {
  return normalizeFamily(readSettings().themeFamily);
}

export function writeThemeFamily(family: string) {
  writeSetting((settings) => {
    if (family === DEFAULT_FAMILY) delete settings.themeFamily;
    else settings.themeFamily = normalizeFamily(family);
  });
}

/** A preset id or #rrggbb; null keeps the family's own accent. */
export function readAccent(): string | null {
  const accent = readSettings().accent;
  return typeof accent === "string" && normalizeAccent(accent) ? accent : null;
}

export function writeAccent(accent: string | null) {
  writeSetting((settings) => {
    if (accent && normalizeAccent(accent)) settings.accent = accent;
    else delete settings.accent;
  });
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveColorMode(mode: ColorMode, prefersDark = systemPrefersDark()): ResolvedMode {
  if (mode === "light" || mode === "dark") return mode;
  return prefersDark ? "dark" : "light";
}

/** Every family's tokens, once, as a stylesheet keyed on data-theme and data-mode. */
export function ensureThemeStylesheet(doc: Document = document) {
  if (doc.getElementById(STYLESHEET_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLESHEET_ID;
  style.textContent = themeStylesheet();
  doc.head.prepend(style);
}

let appliedAccentKeys: string[] = [];

export interface Appearance {
  family: string;
  mode: ResolvedMode;
  accent?: string | null;
}

/** Put the appearance on <html>: data-theme and data-mode for the tokens, .dark for shadcn, accent as inline overrides. */
export function applyAppearance({ family, mode, accent = null }: Appearance, root: HTMLElement = document.documentElement) {
  const id = normalizeFamily(family);
  ensureThemeStylesheet(root.ownerDocument);
  root.setAttribute("data-theme", id);
  root.setAttribute("data-mode", mode);
  root.classList.toggle("dark", mode === "dark");
  for (const key of appliedAccentKeys) root.style.removeProperty(key);
  const overrides = accentOverrides(id, mode, accent);
  for (const [key, value] of Object.entries(overrides)) root.style.setProperty(key, value);
  appliedAccentKeys = Object.keys(overrides);
  // Styles that tune the family's own accent (e.g. a dark sidebar's logo
  // stripe) step aside when the person has chosen one.
  if (appliedAccentKeys.length) root.setAttribute("data-accent", String(accent));
  else root.removeAttribute("data-accent");
  const meta = root.ownerDocument.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", tokensFor(id, mode)["--t-bg"]);
}

