export type ThemeMode = "light" | "dark";
export type ThemeTokens = Record<string, string>;

export interface ThemeFamilySummary {
  id: string;
  label: string;
  description: string;
  source: "field" | "openclaw";
  swatches: Record<ThemeMode, { bg: string; surface: string; text: string; accent: string; primary: string }>;
}

export interface AccentPreset {
  id: string;
  label: string;
  hex: string | null;
}

export const DEFAULT_FAMILY: string;
export const DEFAULT_THEME: string;
export const THEME_FAMILIES: ThemeFamilySummary[];
export const THEMES: Record<string, ThemeTokens>;
export const ACCENT_PRESETS: AccentPreset[];

export function isThemeFamily(id: unknown): boolean;
export function normalizeFamily(id: unknown): string;
export function tokensFor(familyId: string, mode: ThemeMode): ThemeTokens;
export function themeId(familyId: string, mode: ThemeMode): string;
export function parseThemeId(id: unknown): { family: string; mode: ThemeMode };
export function themeCSS(id: string | null | undefined): string;
export function themeStylesheet(): string;
export function normalizeAccent(value: unknown): string | null;
export function contrast(a: string, b: string): number;
export function inkOn(fill: string): "#000000" | "#ffffff";
export function readableOn(color: string, bg: string, target?: number): string;
export function accentOverrides(familyId: string, mode: ThemeMode, accent: string | null | undefined): ThemeTokens;
