// WCAG 2.1 contrast helpers for theme tokens (shared/themes.js and
// scripts/port-openclaw-themes.mjs). Colours are #rrggbb.

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
