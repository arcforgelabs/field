// Each design system's faces, loaded only when that family is chosen. Field
// Crew's Inter and Geist Mono are bundled up front in index.css; the ported
// OpenClaw families use their upstream faces (shared/theme-palettes.js), with
// JetBrains Mono for data.
const LOADERS: Record<string, () => Promise<unknown>[]> = {
  claw: () => [import("@fontsource-variable/instrument-sans/index.css")],
  knot: () => [import("@fontsource-variable/geist/index.css")],
  dash: () => [import("@fontsource-variable/dm-sans/index.css")],
  absolutely: () => [import("@fontsource-variable/space-grotesk/index.css")],
  tide: () => [import("@fontsource-variable/ibm-plex-sans/index.css")],
  beacon: () => [import("@fontsource-variable/atkinson-hyperlegible-next/index.css")],
  phosphor: () => [],
  crt: () => [],
  manuscript: () => [import("@fontsource-variable/lora/index.css")],
  rose: () => [import("@fontsource-variable/dm-sans/index.css")],
  miami: () => [import("@fontsource-variable/space-grotesk/index.css")],
};

const loaded = new Set<string>();

export function loadThemeFonts(family: string): Promise<unknown> {
  const load = LOADERS[family];
  if (!load || loaded.has(family)) return Promise.resolve();
  loaded.add(family);
  // A failed font leaves the stack's system fallback painting the text.
  return Promise.all([import("@fontsource-variable/jetbrains-mono/index.css"), ...load()]).catch(() => loaded.delete(family));
}
