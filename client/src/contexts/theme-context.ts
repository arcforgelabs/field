import { createContext, useContext } from "react";
import type { ThemeId } from "@/lib/types";
import type { ColorMode, ResolvedMode } from "@/lib/color-mode";

// Appearance is a design system (`family`, shared/themes.js), a light or dark
// mode, and an optional accent colour. `colorMode` is the person's choice
// (system, light or dark); `mode` is what is showing. `theme` names the
// matching server-rendered theme (`<family>` or `<family>-dark`) for pages
// Field renders on the server, such as the retaining-wall view.
export interface ThemeState {
  theme: ThemeId;
  family: string;
  mode: ResolvedMode;
  colorMode: ColorMode;
  accent: string | null;
  setColorMode: (mode: ColorMode) => void;
  setFamily: (family: string) => void;
  setAccent: (accent: string | null) => void;
}

export const ThemeContext = createContext<ThemeState | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be inside ThemeProvider");
  return ctx;
}
