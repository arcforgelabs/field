// WCAG 2.1 contrast helpers for theme tokens (shared/themes.js,
// shared/contrast-audit.js and scripts/port-openclaw-themes.mjs).
// Colours are #rrggbb, except where parseColor reads a translucent one.

export const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex) {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on the fill. */
export function inkOn(fill) {
  return luminance(fill) > 0.179 ? "#000000" : "#ffffff";
}

/** The colour, darkened or lightened just enough to read as text on `bg`. */
export function readableOn(color, bg, target = 4.5) {
  if (!HEX.test(color) || !HEX.test(bg)) return color;
  const toward = luminance(bg) > 0.179 ? [0, 0, 0] : [255, 255, 255];
  const from = rgb(color);
  for (let pct = 0; pct <= 100; pct += 2) {
    const mixed = `#${from.map((c, i) => Math.round(c + (toward[i] - c) * pct / 100).toString(16).padStart(2, "0")).join("")}`;
    if (contrast(mixed, bg) >= target) return mixed;
  }
  return toward[0] ? "#ffffff" : "#000000";
}

/** readableOn for every surface in turn, until the colour reads on all of them. */
export function readableOnEvery(color, surfaces, target = 4.5) {
  let out = color;
  for (let pass = 0; pass < 3; pass += 1) {
    for (const bg of surfaces) out = readableOn(out, bg, target);
    if (surfaces.every((bg) => !HEX.test(out) || !HEX.test(bg) || contrast(out, bg) >= target)) break;
  }
  return out;
}

/**
 * A boundary colour for controls on `bg` (an input's or an outlined button's
 * edge): `bg` mixed toward `ink` just enough to stand out at `target`
 * (WCAG 1.4.11 asks 3:1 for the parts that show where a control is).
 */
export function boundaryOn(bg, ink, target = 3) {
  if (!HEX.test(bg) || !HEX.test(ink)) return ink;
  const from = rgb(bg);
  const toward = rgb(ink);
  for (let pct = 0; pct <= 100; pct += 2) {
    const mixed = `#${from.map((c, i) => Math.round(c + (toward[i] - c) * pct / 100).toString(16).padStart(2, "0")).join("")}`;
    if (contrast(mixed, bg) >= target) return mixed;
  }
  return ink;
}

/** [r, g, b, a] (0-255, alpha 0-1) for #rrggbb, rgb()/rgba() or color-mix(in srgb, X N%, transparent). */
export function parseColor(value) {
  const v = String(value).trim();
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  m = v.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/i);
  if (m) {
    const [r, g, b, a] = parseColor(m[1]);
    return [r, g, b, a * Number(m[2]) / 100];
  }
  throw new Error(`contrast audit cannot read colour "${value}"`);
}

/** `top` painted over `under` (each a colour string), as an opaque #rrggbb. */
export function over(top, under) {
  const [r, g, b, a] = parseColor(top);
  const base = parseColor(under);
  if (base[3] < 1) throw new Error(`contrast audit needs an opaque surface, got "${under}"`);
  return `#${[r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
}
