import "./instrument";
import { reactErrorHandler } from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { AuthProvider } from "@/contexts/auth-provider";
import { ThemeProvider } from "@/contexts/theme-provider";
import { ErrorBoundary } from "@/components/error-boundary";
import { App } from "@/app";
import "./index.css";
import { ensureThemeStylesheet } from "@/lib/color-mode";

// Every design system's tokens before the first render; index.html has already
// put the chosen family and mode on <html>.
ensureThemeStylesheet();

// Errors the ErrorBoundary catches are reported there (it skips stale-chunk
// errors after a deploy), so onCaughtError would report each one twice.
createRoot(document.getElementById("root")!, {
  onUncaughtError: reactErrorHandler(),
  onRecoverableError: reactErrorHandler(),
}).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <ThemeProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ThemeProvider>
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>
);
