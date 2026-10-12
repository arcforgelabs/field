// Clerk sign-in (server FIELD_AUTH=clerk). Clerk proves who someone is; Field's
// server decides what they may do (/api/auth/me: role and approval status from
// PostgreSQL). Loaded lazily by AuthProvider, only in Clerk mode.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ClerkProvider, useAuth as useClerkAuth, useClerk } from "@clerk/react";
import { api, setSessionTokenProvider } from "@/lib/api";
import type { UiConfig, UserProfile } from "@/lib/types";
import { AuthContext, DEFAULT_UI, createAuthSessionScope, type AccessState, type AuthState } from "./auth-context";

// The MCP OAuth approval page sends signed-out owners to /?return_to=/oauth/authorize?...
// Only that same-origin path is honoured.
export function safeReturnTo(search: string): string | null {
  const value = new URLSearchParams(search).get("return_to");
  if (!value || !value.startsWith("/oauth/authorize?") || value.startsWith("//")) return null;
  return value;
}

export default function ClerkAuthProvider({
  publishableKey,
  proxyUrl,
  children,
}: {
  publishableKey: string;
  proxyUrl: string | null;
  children: ReactNode;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey} proxyUrl={proxyUrl ?? undefined} afterSignOutUrl="/">
      <ClerkSessionBridge>{children}</ClerkSessionBridge>
    </ClerkProvider>
  );
}

export function clearStoredFieldToken() {
  try {
    localStorage.removeItem("fr_token");
    localStorage.removeItem("fr_user");
  } catch {
    /* storage unavailable: nothing stored to clear */
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function ClerkSessionBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useClerkAuth();
  const clerk = useClerk();
  const [access, setAccess] = useState<AccessState>("loading");
  const [accessMessage, setAccessMessage] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [uiConfig, setUiConfig] = useState<UiConfig>(DEFAULT_UI);
  const [attempt, setAttempt] = useState(0);
  const sessionScope = useMemo(() => createAuthSessionScope(userId || ""), [userId]);

  // Clerk mode never uses a stored Field token. One left over from password
  // sign-in would otherwise end up in PDF and preview URLs; drop it.
  useEffect(() => {
    clearStoredFieldToken();
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setSessionTokenProvider(null);
      setUser(null);
      setAccess("signed-out");
      setAccessMessage(null);
      return;
    }
    setSessionTokenProvider(() => getToken(), userId || "");
    let cancelled = false;
    setAccess("loading");
    api.me().then((res) => {
      if (cancelled) return;
      setUser(res.user);
      const status = res.user.status ?? "active";
      setAccess(status === "active" ? "active" : status);
      setAccessMessage(null);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setUser(null);
      setAccess(errorCode(error) === "email_unverified" ? "email-unverified" : "error");
      setAccessMessage(error instanceof Error ? error.message : "Field could not check your access.");
    });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, userId, getToken, attempt]);

  // Back to the MCP authorization page once the owner is signed in.
  useEffect(() => {
    if (access !== "active") return;
    const returnTo = safeReturnTo(window.location.search);
    if (returnTo) window.location.replace(returnTo);
  }, [access]);

  useEffect(() => {
    if (access !== "active") return;
    api.uiConfig().then((res) => {
      if (res.ui) setUiConfig(res.ui);
    }).catch(() => {});
  }, [access]);

  const logout = useCallback(() => {
    setSessionTokenProvider(null);
    clearStoredFieldToken();
    void signOut({ redirectUrl: "/" });
  }, [signOut]);

  const openAccount = useCallback(() => clerk.openUserProfile(), [clerk]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const value: AuthState = {
    token: "",
    sessionScope,
    authenticated: access === "active",
    uiConfig,
    user,
    loginWithEmail: async () => false,
    logout,
    mode: "clerk",
    access,
    accessMessage,
    isOwner: user?.fieldRole === "owner",
    openAccount,
    retry,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
