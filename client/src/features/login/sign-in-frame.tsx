// The sign-in layout, used by the Clerk and the password sign-in screens: the
// Field logo, a heading and the form, on the active design system's canvas.
import type { ReactNode } from "react";
import { FieldLogo } from "@/components/field";

export function SignInFrame({ title, subtitle, children }: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        minHeight: "100dvh",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        background: "var(--t-bg)",
        color: "var(--t-text)",
        fontFamily: "var(--t-body)",
      }}
    >
      <main style={{ width: "100%", maxWidth: 400, display: "flex", flexDirection: "column" }}>
        <FieldLogo size={26} />
        <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 6 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--t-display)", fontSize: 26, fontWeight: 650, letterSpacing: "-.02em", lineHeight: 1.15 }}>{title}</h1>
          {subtitle ? <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--t-dim)" }}>{subtitle}</p> : null}
        </div>
        <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
      </main>
    </div>
  );
}
