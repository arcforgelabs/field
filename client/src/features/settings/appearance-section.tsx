import { useEffect, useRef, type KeyboardEvent } from "react";
import { SegmentedControl } from "@/components/field";
import { useTheme } from "@/contexts/theme-context";
import type { ColorMode } from "@/lib/color-mode";
import { ACCENT_PRESETS, normalizeAccent, THEME_FAMILIES, tokensFor } from "../../../../shared/themes.js";
import { loadThemeFonts } from "@/lib/theme-fonts";
import { DIRECTIONS } from "@/lib/directions";

// Arrow keys move the choice through a radiogroup, as SegmentedControl does.
function useRovingRadio<T>(items: T[], selectedIndex: number, onSelect: (item: T) => void) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = items.length - 1;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    onSelect(items[next]);
    refs.current[next]?.focus();
  }
  const props = (index: number) => ({
    ref: (node: HTMLButtonElement | null) => { refs.current[index] = node; },
    role: "radio" as const,
    "aria-checked": index === selectedIndex,
    tabIndex: index === selectedIndex || (selectedIndex < 0 && index === 0) ? 0 : -1,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => onKeyDown(event, index),
  });
  return props;
}

export function AppearanceSection() {
  const { colorMode, setColorMode, family, setFamily, mode, accent, setAccent } = useTheme();
  const familyIndex = THEME_FAMILIES.findIndex((f) => f.id === family);
  // Each card is set in its own family's faces, so load them all here.
  useEffect(() => { THEME_FAMILIES.forEach((f) => { void loadThemeFonts(f.id); }); }, []);
  const familyRadio = useRovingRadio(THEME_FAMILIES, familyIndex, (f) => setFamily(f.id));

  const presetIndex = accent ? ACCENT_PRESETS.findIndex((p) => p.id === accent) : 0;
  const customHex = accent && presetIndex < 0 ? normalizeAccent(accent) : null;
  const accentRadio = useRovingRadio(ACCENT_PRESETS, presetIndex, (p) => setAccent(p.hex ? p.id : null));
  const activeFamily = THEME_FAMILIES[Math.max(familyIndex, 0)];
  const activeAccentLabel = customHex
    ? `Custom ${customHex}`
    : presetIndex > 0 ? ACCENT_PRESETS[presetIndex].label : `${activeFamily.label}'s own`;

  return (
    <>
      <div className="appearance__group">
        <span className="appearance__heading" id="appearance-mode">Mode</span>
        <SegmentedControl<ColorMode>
          label="Mode"
          value={colorMode}
          onChange={setColorMode}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "system", label: "Auto" },
          ]}
        />
        <p className="settings__hint">Auto follows this device's light or dark setting.</p>
      </div>

      <div className="appearance__group">
        <span className="appearance__heading" id="appearance-theme">Design system</span>
        <div role="radiogroup" aria-labelledby="appearance-theme" className="appearance__themes">
          {THEME_FAMILIES.map((f, index) => {
            const s = f.swatches[mode];
            return (
              <button key={f.id} type="button" className="appearance__theme" data-theme-card={f.id} {...familyRadio(index)} onClick={() => setFamily(f.id)}>
                {(() => {
                  // The card shows the family as it is, not the active theme:
                  // its colours, its corner and its own typeface.
                  const t = tokensFor(f.id, mode);
                  const side = DIRECTIONS.find((d) => d.family === f.id)?.swatch[0];
                  return (
                    <>
                      <span className="appearance__preview" aria-hidden="true" style={{ background: s.bg, color: s.text, borderRadius: t["--t-radius"], fontFamily: t["--t-body"], paddingLeft: side ? 18 : undefined }}>
                        {side && <span className="appearance__preview-side" style={{ background: side }} />}
                        <span className="appearance__preview-bar" style={{ background: s.surface }} />
                        <span className="appearance__preview-type" style={{ fontFamily: t["--t-display"], fontWeight: Number(t["--t-display-weight"]) || 700 }}>Aa</span>
                        <span className="appearance__preview-chips">
                          <span style={{ background: s.primary, borderRadius: t["--t-radius"] }} />
                          <span style={{ background: s.accent, borderRadius: t["--t-radius"] }} />
                        </span>
                      </span>
                      <span className="appearance__theme-name" style={{ fontFamily: t["--t-display"] }}>{f.label}</span>
                    </>
                  );
                })()}
              </button>
            );
          })}
        </div>
        <p className="settings__hint">
          Each design system brings its own colours, type, corners and layout details, in light and dark. The first six are Field's directions: Beacon (the default, maximum contrast), Tide, Claw (OpenClaw's own look), Knot, Dash and Site, Field's original paper, ink and yellow. The rest are OpenClaw's themes.
        </p>
      </div>

      <div className="appearance__group">
        <span className="appearance__heading" id="appearance-accent">Accent colour</span>
        <div className="appearance__accents">
          <div role="radiogroup" aria-labelledby="appearance-accent" className="appearance__accent-row">
            {ACCENT_PRESETS.map((p, index) => (
              <button
                key={p.id}
                type="button"
                className={p.hex ? "appearance__accent" : "appearance__accent appearance__accent--default"}
                data-accent-preset={p.id}
                title={p.hex ? p.label : `${activeFamily.label}'s own`}
                aria-label={p.hex ? p.label : `${activeFamily.label}'s own accent`}
                {...accentRadio(index)}
                onClick={() => setAccent(p.hex ? p.id : null)}
                style={p.hex ? { background: p.hex } : undefined}
              >
                {!p.hex && (
                  // The family's own colours, never the current override, so
                  // this always shows what choosing it goes back to.
                  <span
                    className="appearance__accent-default"
                    aria-hidden="true"
                    style={{ background: `linear-gradient(135deg, ${activeFamily.swatches[mode].primary} 50%, ${activeFamily.swatches[mode].accent} 50%)` }}
                  />
                )}
                {!p.hex && <span className="appearance__accent-default-label">Default</span>}
                {!p.hex && index === 0 && (
                  <span className="appearance__accent-divider" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          <label className="appearance__custom">
            <input
              type="color"
              aria-label="Custom accent colour"
              value={customHex ?? "#f4c518"}
              onChange={(event) => setAccent(event.target.value)}
            />
            <span>Custom</span>
          </label>
        </div>
        <p className="settings__hint" aria-live="polite">
          Using {activeAccentLabel}. Buttons, highlights and focus rings take the accent; text in the accent is adjusted until it reads clearly.
        </p>
      </div>
    </>
  );
}
