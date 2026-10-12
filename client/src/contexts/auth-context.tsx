import { createContext, lazy, Suspense, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { api, type AuthConfig } from "@/lib/api";
import type { UiConfig, UserProfile } from "@/lib/types";

/** How people sign in: decided by the server (FIELD_AUTH), read at runtime. */
export type AuthMode = "password" | "clerk";

/**
 * Where the signed-in person stands. Password sign-in only uses "active" and
 * "signed-out"; Clerk sign-in adds Field's own approval states.
 */
export type AccessState = "loading" | "signed-out" | "active" | "pending" | "disabled" | "email-unverified" | "error";

export interface AuthState {
  token: string;
  sessionScope: object;
  authenticated: boolean;
  uiConfig: UiConfig;
  user: UserProfile | null;
  loginWithEmail: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  mode: AuthMode;
  access: AccessState;
  accessMessage: string | null;
  /** Owner (Clerk) or admin (password): may see the people screens. */
  isOwner: boolean;
  /** Clerk sign-in only: opens the account screen (profile, connected accounts). */
  openAccount: (() => void) | null;
  /** Clerk sign-in only: ask the server again (after an approval or an error). */
  retry: (() => void) | null;
}

export const DEFAULT_UI: UiConfig = {
  deploymentTheme: "gohub",
  workerDisplayName: "Agent",
  assistantDisplayName: "",
  businessName: "",
};

export function createAuthSessionScope(_token: string): object {
  // The token is only a regeneration key; never retain it in the scope.
  void _token;
  return {};
}

export const AuthContext = createContext<AuthState | null>(null);

function loadStoredUser(): UserProfile | null {
  try {
    const raw = localStorage.getItem("fr_user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Clerk is loaded only when the server asks for it, so password deployments
// never download it.
const ClerkAuthProvider = lazy(() => import("./clerk-auth-provider"));

function AuthLoading() {
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
        background: "var(--t-bg)",
      }}
    >
      Loading…
    </div>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.authConfig().then((next) => {
      if (!cancelled) setConfig(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!config) return <AuthLoading />;
  if (config.mode === "clerk") {
    return (
      <Suspense fallback={<AuthLoading />}>
        <ClerkAuthProvider publishableKey={config.clerk.publishableKey} proxyUrl={config.clerk.proxyUrl}>
          {children}
        </ClerkAuthProvider>
      </Suspense>
    );
  }
  return <PasswordAuthProvider>{children}</PasswordAuthProvider>;
}

// Password sign-in (FIELD_AUTH unset): unchanged — the server mints a per-user
// token that the client keeps in localStorage.
function PasswordAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => localStorage.getItem("fr_token") || "");
  const [authenticated, setAuthenticated] = useState(!!token);
  const [uiConfig, setUiConfig] = useState<UiConfig>(DEFAULT_UI);
  const [user, setUser] = useState<UserProfile | null>(loadStoredUser);
  const sessionScope = useMemo(() => createAuthSessionScope(token), [token]);

  // Email/password login — the server mints a per-user token.
  const loginWithEmail = useCallback(async (email: string, password: string) => {
    try {
      const res = await api.login(email, password);
      localStorage.setItem("fr_token", res.token);
      localStorage.setItem("fr_user", JSON.stringify(res.user));
      setToken(res.token);
      setUser(res.user);
      setAuthenticated(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    api.logout().catch(() => {});
    localStorage.removeItem("fr_token");
    localStorage.removeItem("fr_user");
    setToken("");
    setUser(null);
    setAuthenticated(false);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    api.uiConfig().then((res) => {
      if (res.ui) setUiConfig(res.ui);
    }).catch(() => {});
  }, [authenticated]);

  const value: AuthState = {
    token,
    sessionScope,
    authenticated,
    uiConfig,
    user,
    loginWithEmail,
    logout,
    mode: "password",
    access: authenticated ? "active" : "signed-out",
    accessMessage: null,
    isOwner: user?.role === "admin",
    openAccount: null,
    retry: null,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
