import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useAuth } from "@/contexts/auth-context";
import { LoginPage } from "@/features/login/login-page";
import { AppShell } from "@/components/shell/app-shell";

// Lazy-load every protected route so each feature becomes its own chunk.
// Login stays eager because it is the first paint after boot and keeping
// it in the main bundle avoids a Suspense flash on the landing screen.
const JobsPage = lazy(() => import("@/features/jobs/jobs-page").then((m) => ({ default: m.JobsPage })));
const JobPage = lazy(() => import("@/features/job/job-page").then((m) => ({ default: m.JobPage })));
const InvoicesPage = lazy(() => import("@/features/invoices/invoices-page").then((m) => ({ default: m.InvoicesPage })));
const EmailComposerPage = lazy(() => import("@/features/job-detail/email-composer-page").then((m) => ({ default: m.EmailComposerPage })));
const CataloguePage = lazy(() => import("@/features/catalogue/catalogue-page").then((m) => ({ default: m.CataloguePage })));
const SupplierImportPage = lazy(() => import("@/features/pricing/supplier-import-page").then((m) => ({ default: m.SupplierImportPage })));
const SettingsPage = lazy(() => import("@/features/settings/settings-page").then((m) => ({ default: m.SettingsPage })));
// Clerk sign-in (server FIELD_AUTH=clerk) only; password deployments never load it.
const ClerkSignInShell = lazy(() => import("@/features/login/clerk-sign-in"));

function RouteFallback() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--t-body)",
        color: "var(--t-dim)",
        fontSize: 13,
      }}
    >
      Loading…
    </div>
  );
}

function ProtectedRoute({ children, bare = false }: { children: React.ReactNode; bare?: boolean }) {
  const { authenticated } = useAuth();
  if (!authenticated) return <Navigate to="/" replace />;
  if (bare) return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
  return (
    <AppShell>
      <Suspense fallback={<div className="fx-loading">Loading…</div>}>{children}</Suspense>
    </AppShell>
  );
}

// The quote editor used to be its own screen; it is the job page now.
function QuotePresentationRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={`/jobs/${id}`} replace />;
}

export function App() {
  const { mode, authenticated } = useAuth();

  // With Clerk sign-in, nothing but the sign-in screen renders until the
  // person has Field access (Clerk's own steps use the URL hash meanwhile).
  if (mode === "clerk" && !authenticated) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <ClerkSignInShell />
      </Suspense>
    );
  }

  return (
    <div
      className="min-h-dvh"
      style={{
        background: "var(--t-bg)",
        color: "var(--t-text)",
        fontFamily: "var(--t-body)",
      }}
    >
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route
          path="/jobs"
          element={
            <ProtectedRoute>
              <JobsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/jobs/:id/email-editor"
          element={
            <ProtectedRoute>
              <EmailComposerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/jobs/:id/quote-presentation"
          element={
            <QuotePresentationRedirect />
          }
        />
        <Route
          path="/jobs/:id"
          element={
            <ProtectedRoute>
              <JobPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/invoices"
          element={
            <ProtectedRoute>
              <InvoicesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pricing"
          element={
            <ProtectedRoute>
              <CataloguePage />
            </ProtectedRoute>
          }
        />
        <Route path="/pricing/categories" element={<Navigate to="/pricing?manage=categories" replace />} />
        <Route path="/pricing/health" element={<Navigate to="/pricing?health=1&status=all" replace />} />
        <Route
          path="/pricing/import"
          element={
            <ProtectedRoute>
              <SupplierImportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pricing/import/:importUid"
          element={
            <ProtectedRoute>
              <SupplierImportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        {mode === "clerk" && <Route path="*" element={<Navigate to="/jobs" replace />} />}
      </Routes>
    </div>
  );
}
