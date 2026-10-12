export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  tone = "accent",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  tone?: "accent" | "danger";
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  if (!open) return null;

  const confirmBackground = tone === "danger" ? "var(--t-danger)" : "var(--t-accent)";

  return (
    <div
      onClick={() => { if (!busy) onCancel(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10002,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        padding: 20,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 420,
          background: "var(--t-s1)",
          border: "1px solid var(--t-brd)",
          borderRadius: "var(--t-radius)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "20px 22px 14px", borderBottom: "1px solid var(--t-brd)" }}>
          <div
            style={{
              fontFamily: "var(--t-data)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              color: "var(--t-mute)",
              marginBottom: 6,
            }}
          >
            Confirm Action
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--t-text)", marginBottom: 8 }}>
            {title}
          </div>
          <div style={{ fontSize: 14, color: "var(--t-dim)", lineHeight: 1.6 }}>
            {description}
          </div>
        </div>

        <div style={{ padding: "14px 16px 16px", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "10px 14px",
              borderRadius: "var(--t-radius)",
              border: "1px solid var(--t-brd)",
              background: "none",
              color: "var(--t-text)",
              fontFamily: "var(--t-body)",
              fontSize: 13,
              fontWeight: 700,
              opacity: busy ? 0.5 : 1,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy}
            style={{
              padding: "10px 18px",
              borderRadius: "var(--t-radius)",
              border: "none",
              background: busy
                ? "color-mix(in srgb, var(--t-accent) 30%, transparent)"
                : confirmBackground,
              color: "var(--t-bg)",
              fontFamily: "var(--t-body)",
              fontSize: 13,
              fontWeight: 700,
              cursor: busy ? "progress" : "pointer",
            }}
          >
            {busy ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
