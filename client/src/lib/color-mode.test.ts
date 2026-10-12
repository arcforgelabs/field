import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAppearance,
  readAccent,
  readColorMode,
  readThemeFamily,
  resolveColorMode,
  writeAccent,
  writeColorMode,
  writeThemeFamily,
} from "./color-mode";
import { accentOverrides, contrast, THEME_FAMILIES, tokensFor } from "../../../shared/themes.js";

afterEach(() => {
  localStorage.clear();
  const root = document.documentElement;
  root.removeAttribute("data-mode");
  root.removeAttribute("data-theme");
  root.removeAttribute("style");
  root.classList.remove("dark");
  document.getElementById("field-themes")?.remove();
  vi.unstubAllGlobals();
});

describe("color mode", () => {
  it("defaults to following the system, and an explicit choice wins", () => {
    expect(readColorMode()).toBe("system");
    expect(resolveColorMode("system", true)).toBe("dark");
    expect(resolveColorMode("system", false)).toBe("light");
    expect(resolveColorMode("light", true)).toBe("light");
    expect(resolveColorMode("dark", false)).toBe("dark");
  });

  it("keeps the choice beside the other settings and drops the old theme pick", () => {
    localStorage.setItem("fr_settings", JSON.stringify({ theme: "gohub", other: 1 }));
    writeColorMode("dark");
    expect(JSON.parse(localStorage.getItem("fr_settings")!)).toEqual({ other: 1, colorMode: "dark" });
    expect(readColorMode()).toBe("dark");
    localStorage.setItem("fr_settings", "{not json");
    expect(readColorMode()).toBe("system");
  });

  it("puts the family and mode on <html> for the tokens and for shadcn's .dark", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
    applyAppearance({ family: "field", mode: "dark" });
    const root = document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("field");
    expect(root.getAttribute("data-mode")).toBe("dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(meta.content).toBe("#11110d");
    applyAppearance({ family: "tide", mode: "light" });
    expect(root.getAttribute("data-theme")).toBe("tide");
    expect(root.classList.contains("dark")).toBe(false);
    expect(meta.content).toBe("#f7f9fb");
    expect(document.getElementById("field-themes")?.textContent).toContain('[data-theme="tide"][data-mode="dark"]');
    meta.remove();
  });
});

describe("design systems", () => {
  it("remembers the family, and an unknown one falls back to Beacon", () => {
    expect(readThemeFamily()).toBe("beacon");
    writeThemeFamily("miami");
    expect(readThemeFamily()).toBe("miami");
    localStorage.setItem("fr_settings", JSON.stringify({ themeFamily: "nope" }));
    expect(readThemeFamily()).toBe("beacon");
    applyAppearance({ family: "nope", mode: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("beacon");
  });

  it("leads with the directions (Beacon first), then the other OpenClaw families, each with both modes", () => {
    expect(THEME_FAMILIES.map((f) => f.id)).toEqual([
      "beacon", "tide", "claw", "knot", "dash", "field", "absolutely", "phosphor", "crt", "manuscript", "rose", "miami",
    ]);
    for (const family of THEME_FAMILIES) {
      for (const mode of ["light", "dark"] as const) {
        const t = tokensFor(family.id, mode);
        expect(t["color-scheme"]).toBe(mode);
        // Body text and the text accent stay readable on every background.
        expect(contrast(t["--t-text"], t["--t-bg"]), `${family.id} ${mode} text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--t-accent"], t["--t-bg"]), `${family.id} ${mode} accent`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("accent colour", () => {
  it("stores a preset or a custom hex and clears back to the theme's", () => {
    writeAccent("teal");
    expect(readAccent()).toBe("teal");
    writeAccent("#123abc");
    expect(readAccent()).toBe("#123abc");
    writeAccent("not-a-colour");
    expect(readAccent()).toBeNull();
  });

  it("fills with the chosen colour and keeps accent text readable", () => {
    for (const family of THEME_FAMILIES) {
      for (const mode of ["light", "dark"] as const) {
        const o = accentOverrides(family.id, mode, "amber");
        expect(o["--t-brand"]).toBe("#f5b942");
        expect(contrast(o["--t-accent"], tokensFor(family.id, mode)["--t-bg"])).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Field light keeps ink buttons and puts the accent on their label.
    const fieldLight = accentOverrides("field", "light", "blue");
    expect(fieldLight["--t-primary"]).toBeUndefined();
    expect(contrast(fieldLight["--t-on-primary"], "#11110d")).toBeGreaterThanOrEqual(4.5);
  });

  it("applies and removes the overrides on <html>", () => {
    const root = document.documentElement;
    applyAppearance({ family: "field", mode: "dark", accent: "mint" });
    expect(root.style.getPropertyValue("--t-brand")).toBe("#52c99a");
    expect(document.documentElement.getAttribute("data-accent")).toBe("mint");
    applyAppearance({ family: "field", mode: "dark", accent: null });
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(root.style.getPropertyValue("--t-brand")).toBe("");
  });
});
