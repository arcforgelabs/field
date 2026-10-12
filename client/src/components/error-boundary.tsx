import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import * as Sentry from "@sentry/react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

const RELOAD_GUARD_KEY = "field:chunk-reload-at";
const RELOAD_GUARD_WINDOW_MS = 10_000;

// Detects a stale-chunk load failure. When a deploy publishes a new bundle,
// already-open tabs still hold references to content-hashed chunks that no
// longer exist on the server. The SPA fallback serves index.html, the browser
// parses HTML as JS, and the lazy() import rejects. Vite, webpack, and Safari
// each surface this with different error shapes.
function isChunkLoadError(error: Error | null | undefined): boolean {
  if (!error) return false;
  const message = error.message || "";
  const name = error.name || "";
  if (name === "ChunkLoadError") return true;
  if (/Loading chunk .* failed/i.test(message)) return true;
  if (/Failed to fetch dynamically imported module/i.test(message)) return true;
  if (/Importing a module script failed/i.test(message)) return true;
  if (/error loading dynamically imported module/i.test(message)) return true;
  if (name === "SyntaxError" && /Unexpected token '<'|expected expression, got '<'/i.test(message)) return true;
  return false;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
    if (!isChunkLoadError(error)) Sentry.captureException(error);
    if (isChunkLoadError(error)) {
      let last = 0;
      try {
        last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
      } catch {
        // sessionStorage can throw in private mode — fall through to reload anyway
      }
      const now = Date.now();
      if (now - last > RELOAD_GUARD_WINDOW_MS) {
        try {
          sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
        } catch {
          // ignore
        }
        console.warn("[ErrorBoundary] chunk load error detected, auto-reloading to fetch fresh assets");
        window.location.reload();
      } else {
        console.warn("[ErrorBoundary] chunk load error detected but a reload already occurred recently — surfacing error UI");
      }
    }
  }

  render() {
    if (this.state.error) {
      const chunkError = isChunkLoadError(this.state.error);
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100dvh",
            padding: 24,
            background: "var(--t-bg)",
            color: "var(--t-text)",
            fontFamily: "var(--t-body)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            {chunkError ? "App update available" : "Something went wrong"}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--t-dim)",
              marginBottom: 16,
              maxWidth: 320,
              wordBreak: "break-word",
            }}
          >
            {chunkError
              ? "A newer version is deployed but your browser is still holding the old one. Reload to get the latest."
              : this.state.error.message}
          </div>
          <button
            onClick={() => {
              try {
                sessionStorage.removeItem(RELOAD_GUARD_KEY);
              } catch {
                // ignore
              }
              this.setState({ error: null });
              window.location.reload();
            }}
            style={{
              padding: "8px 20px",
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "var(--t-body)",
              background: "var(--t-accent)",
              color: "var(--t-bg)",
              border: "none",
              borderRadius: "var(--t-radius)",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
