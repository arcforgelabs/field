import { useCallback, useEffect, useState, type ReactNode } from "react";
import { updateFavicon } from "@/lib/favicon";
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
} from "@/lib/color-mode";
import { loadThemeFonts } from "@/lib/theme-fonts";
import { normalizeFamily, themeId } from "../../../shared/themes.js";
import { ThemeContext } from "./theme-context";

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
