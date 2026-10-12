// Clerk's widgets (sign-in, the account screens in Settings) in Field's
// active design system: colours, type and corners are read from the --t-*
// tokens at render time, so Clerk changes with the theme and mode.

function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function fieldClerkAppearance({ embedded = false }: { embedded?: boolean } = {}) {
  const text = token("--t-text", "#333c45");
  const line = `color-mix(in srgb, ${text} 12%, transparent)`;
  const shadow = "0 1px 2px rgba(16, 24, 40, .06)";
  return {
    variables: {
      colorPrimary: token("--t-primary", "#1f6f8f"),
      colorPrimaryForeground: token("--t-on-primary", "#ffffff"),
      colorBackground: token("--t-paper", "#ffffff"),
      colorForeground: text,
      colorMutedForeground: token("--t-dim", "#5b6773"),
      colorMuted: token("--t-bg", "#f7f9fb"),
      colorInput: token("--t-paper", "#ffffff"),
      colorInputForeground: text,
      colorDanger: token("--t-danger", "#b8442a"),
      colorSuccess: token("--t-success", "#3f6b2a"),
      colorNeutral: text,
      colorBorder: line,
      fontFamily: token("--t-body", "ui-sans-serif, system-ui, sans-serif"),
      fontSize: "13px",
      borderRadius: token("--t-radius", "6px"),
    },
    elements: {
      header: embedded ? undefined : { display: "none" },
      // An installation is for one business's people; there's no self-serve
      // sign-up. (Clerk can still create a user on a first Google sign-in;
      // Field holds them as pending until an owner approves.)
      footerAction: embedded ? undefined : { display: "none" },
      card: { boxShadow: embedded ? "none" : shadow, border: `1px solid ${line}` },
      rootBox: embedded ? { width: "100%" } : undefined,
      cardBox: embedded ? { width: "100%", maxWidth: "none", boxShadow: "none", border: `1px solid ${line}`, borderRadius: token("--t-radius-lg", "10px") } : undefined,
      navbar: embedded ? { background: token("--t-bg", "#f7f9fb"), borderRight: `1px solid ${line}` } : undefined,
      scrollBox: embedded ? { borderRadius: 0 } : undefined,
      formFieldInput: { boxShadow: shadow },
      formButtonPrimary: { boxShadow: shadow, textTransform: "none" as const, fontWeight: 600 },
      socialButtonsBlockButton: { boxShadow: shadow },
      footer: embedded ? { display: "none" } : undefined,
    },
  };
}
