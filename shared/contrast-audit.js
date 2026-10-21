// The WCAG AA contrast audit for every design system (shared/themes.js).
// Each pair is a theme foreground on a surface it is drawn on: text, links,
// tinted badges, buttons, toasts, control edges, and Clerk's sign-in and
// account screens (client/src/lib/clerk-appearance.ts). Translucent tokens
// (rgba() and color-mix() toward transparent) are laid over the surface they
// sit on before the ratio is taken, the way a browser paints them.
// shared/theme-contrast.test.js runs it in CI. Ported from Arc Forge Labs'
// Flow (server/theme/contrast-audit.js), so a family passes in both apps.
import { contrast, over, parseColor } from "./color-contrast.js";

// WCAG 2.1: 4.5:1 for text (1.4.3), 3:1 for the edge or fill that shows a
// control or its state (1.4.11).
export const TEXT = 4.5;
export const UI = 3;

function withAlpha(color, alpha) {
  const [r, g, b, a] = parseColor(color);
  return `rgba(${r}, ${g}, ${b}, ${a * alpha})`;
}

// [id, what it is, minimum, (tokens) => [foreground, surface]]. A surface
// given as an array is laid bottom first, so a tinted badge on a card is
// [paper, tint].
const PAIRS = [
  ["text/bg", "Body text on the page", TEXT, (k) => [k["--t-text"], k["--t-bg"]]],
  ["text/paper", "Body text on a card", TEXT, (k) => [k["--t-text"], k["--t-paper"]]],
  ["strong/paper", "Headings and names on a card", TEXT, (k) => [k["--t-strong"], k["--t-paper"]]],
  ["strong/bg", "Page titles on the page", TEXT, (k) => [k["--t-strong"], k["--t-bg"]]],
  ["dim/bg", "Secondary text on the page", TEXT, (k) => [k["--t-dim"], k["--t-bg"]]],
  ["dim/paper", "Secondary text on a card (Clerk muted text)", TEXT, (k) => [k["--t-dim"], k["--t-paper"]]],
  ["dim/s1", "Table headings, Clerk side menu", TEXT, (k) => [k["--t-dim"], k["--t-s1"]]],
  ["dim/s2", "Segmented control labels", TEXT, (k) => [k["--t-dim"], k["--t-s2"]]],
  ["mute/paper", "Muted text on a card", TEXT, (k) => [k["--t-mute"], k["--t-paper"]]],
  ["accent/bg", "Links on the page", TEXT, (k) => [k["--t-accent"], k["--t-bg"]]],
  ["accent/paper", "Links on a card", TEXT, (k) => [k["--t-accent"], k["--t-paper"]]],
  ["accent/accent-bg", "Status and role badges", TEXT, (k) => [k["--t-accent"], [k["--t-paper"], k["--t-accent-bg"]]]],
  ["strong/accent-bg", "Current page in the menu", TEXT, (k) => [k["--t-strong"], [k["--t-bg"], k["--t-accent-bg"]]]],
  ["text/accent-bg", "Notices", TEXT, (k) => [k["--t-text"], [k["--t-paper"], k["--t-accent-bg"]]]],
  ["on-primary/primary", "Primary buttons", TEXT, (k) => [k["--t-on-primary"], k["--t-primary"]]],
  ["brand-ink/brand", "Text on the brand colour", TEXT, (k) => [k["--t-brand-ink"], k["--t-brand"]]],
  ["success/success-bg", "Success badges", TEXT, (k) => [k["--t-success"], [k["--t-paper"], k["--t-success-bg"]]]],
  ["warn/warn-bg", "Warning badges", TEXT, (k) => [k["--t-warn"], [k["--t-paper"], k["--t-warn-bg"]]]],
  ["danger/danger-bg", "Error notices", TEXT, (k) => [k["--t-danger"], [k["--t-paper"], k["--t-danger-bg"]]]],
  ["paper/danger", "Danger buttons and error toasts", TEXT, (k) => [k["--t-paper"], k["--t-danger"]]],
  ["bg/strong", "Toasts", TEXT, (k) => [k["--t-bg"], k["--t-strong"]]],
  // client/src/lib/clerk-appearance.ts: badge.
  ["clerk-badge", 'Clerk "Primary" badge by an email', TEXT, (k) => [k["--t-dim"], [k["--t-paper"], withAlpha(k["--t-text"], 0.05)]]],
  ["control/paper", "Input and outlined button edges", UI, (k) => [k["--t-control"], k["--t-paper"]]],
  ["ring/paper", "Focus ring", UI, (k) => [k["--t-ring"], k["--t-paper"]]],
  ["primary/paper", "Primary button edge on a card", UI, (k) => [k["--t-primary"], k["--t-paper"]]],
];

/** Every pair for one family and mode: { id, label, min, fg, bg, ratio, pass }. */
export function auditTokens(tokens) {
  return PAIRS.map(([id, label, min, pick]) => {
    const [fgRaw, surface] = pick(tokens);
    const layers = Array.isArray(surface) ? surface : [surface];
    const bg = layers.slice(1).reduce((under, top) => over(top, under), over(layers[0], "#ffffff"));
    const fg = over(fgRaw, bg);
    const ratio = contrast(fg, bg);
    return { id, label, min, fg, bg, ratio: Math.round(ratio * 100) / 100, pass: ratio >= min };
  });
}
