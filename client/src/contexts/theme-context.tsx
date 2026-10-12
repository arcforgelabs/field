import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { updateFavicon } from "@/lib/favicon";
import type { ThemeId } from "@/lib/types";
import {
  applyAppearance,
  readAccent,
  readColorMode,
  readThemeFamily,
  resolveColorMode,
  systemPrefersDark,
  writeAccent,
  writeColorMode,
  writeThemeFamily,
  type ColorMode,
  type ResolvedMode,
} from "@/lib/color-mode";
import { loadThemeFonts } from "@/lib/theme-fonts";
import { normalizeFamily, themeId } from "../../../shared/themes.js";

// Appearance is a design system (`family`, shared/themes.js), a light or dark
// mode, and an optional accent colour. `colorMode` is the person's choice
// (system, light or dark); `mode` is what is showing. `theme` names the
// matching server-rendered theme (`<family>` or `<family>-dark`) for pages
// Field renders on the server, such as the retaining-wall view.
interface ThemeState {
  theme: ThemeId;
  family: string;
  mode: ResolvedMode;
  colorMode: ColorMode;
  accent: string | null;
  setColorMode: (mode: ColorMode) => void;
  setFamily: (family: string) => void;
  setAccent: (accent: string | null) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [colorMode, setColorModeState] = useState<ColorMode>(readColorMode);
  const [family, setFamilyState] = useState<string>(readThemeFamily);
  const [accent, setAccentState] = useState<string | null>(readAccent);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const mode = resolveColorMode(colorMode, prefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setPrefersDark(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    void loadThemeFonts(family);
    applyAppearance({ family, mode, accent });
    updateFavicon();
  }, [family, mode, accent]);

  const setColorMode = useCallback((next: ColorMode) => {
    setColorModeState(next);
    writeColorMode(next);
  }, []);

  const setFamily = useCallback((next: string) => {
    const id = normalizeFamily(next);
    setFamilyState(id);
    writeThemeFamily(id);
  }, []);

  const setAccent = useCallback((next: string | null) => {
    setAccentState(next);
    writeAccent(next);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme: themeId(family, mode), family, mode, colorMode, accent, setColorMode, setFamily, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be inside ThemeProvider");
  return ctx;
}
