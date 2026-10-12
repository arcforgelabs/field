// Shared inline styles for the price book screens: the workbench look from
// DESIGN.md (4px controls, square data rows, mono numbers, token colours).
import type { CSSProperties } from "react";

export const controlStyle: CSSProperties = {
  height: 32,
  padding: "0 10px",
  borderRadius: 4,
  border: "1px solid var(--t-brd)",
  background: "var(--t-s1)",
  color: "var(--t-text)",
  fontFamily: "var(--t-body)",
  fontSize: 13,
  outline: "none",
  minWidth: 0,
};

export const dataControlStyle: CSSProperties = { ...controlStyle, fontFamily: "var(--t-data)" };

export const iconButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 4,
  border: "1px solid var(--t-brd)",
  background: "transparent",
  color: "var(--t-dim)",
  cursor: "pointer",
  flexShrink: 0,
};

export function chipStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 26,
    padding: "0 9px",
    borderRadius: 4,
    border: `1px solid ${active ? "var(--t-accent-brd)" : "var(--t-brd)"}`,
    background: active ? "var(--t-accent-bg)" : "transparent",
    color: active ? "var(--t-accent)" : "var(--t-dim)",
    fontFamily: "var(--t-body)",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
    cursor: "pointer",
  };
}

export const thStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--t-bg)",
  borderBottom: "1px solid var(--t-brd-hi)",
  padding: "8px 8px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 650,
  letterSpacing: ".04em",
  color: "var(--t-dim)",
  whiteSpace: "nowrap",
};

export const tdStyle: CSSProperties = {
  borderBottom: "1px solid var(--t-brd)",
  padding: "0 4px",
  height: 36,
  fontSize: 13,
  verticalAlign: "middle",
};

export const numberCell: CSSProperties = { fontFamily: "var(--t-data)", textAlign: "right", whiteSpace: "nowrap" };

export const panelStyle: CSSProperties = {
  border: "1px solid var(--t-brd)",
  borderRadius: 8,
  background: "var(--t-s1)",
  overflow: "hidden",
};

export function noticeStyle(tone: "danger" | "warn" | "success" | "info"): CSSProperties {
  const color = tone === "danger" ? "var(--t-danger)" : tone === "warn" ? "var(--t-warn)" : tone === "success" ? "var(--t-success)" : "var(--t-dim)";
  const background = tone === "danger" ? "var(--t-danger-bg)" : tone === "warn" ? "var(--t-warn-bg)" : tone === "success" ? "var(--t-success-bg)" : "var(--t-s1)";
  return {
    padding: "8px 12px",
    borderRadius: 4,
    border: `1px solid ${color}`,
    background,
    color,
    fontSize: 12,
    lineHeight: 1.4,
  };
}

export const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 650,
  letterSpacing: ".04em",
  color: "var(--t-dim)",
};

export const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 10001,
  background: "rgba(0,0,0,.5)",
  display: "flex",
};
