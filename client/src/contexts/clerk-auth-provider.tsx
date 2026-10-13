// Clerk sign-in (server FIELD_AUTH=clerk). Clerk proves who someone is; Field's
// server decides what they may do (/api/auth/me: role and approval status from
// PostgreSQL). Loaded lazily by AuthProvider, only in Clerk mode.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ClerkProvider, useAuth as useClerkAuth, useClerk } from "@clerk/react";
import { api, setSessionTokenProvider } from "@/lib/api";
import type { UiConfig, UserProfile } from "@/lib/types";
import { AuthContext, DEFAULT_UI, createAuthSessionScope, type AccessState, type AuthState } from "./auth-context";
import { safeReturnTo } from "./return-to";

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

function clearStoredFieldToken() {
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

type AccessCheck = {
  userId: string | null | undefined;
  getToken: unknown;
  attempt: number;
  user: UserProfile | null;
  access: AccessState;
  message: string | null;
};

function ClerkSessionBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useClerkAuth();
  const clerk = useClerk();
  // The server's answer for one signed-in session. It is the session's answer
  // only while the user, the token source and the attempt it asked with are
  // still the current ones; until then access is "loading".
  const [check, setCheck] = useState<AccessCheck | null>(null);
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
      return;
    }
    setSessionTokenProvider(() => getToken(), userId || "");
    let cancelled = false;
    const asked = { userId, getToken, attempt };
    api.me().then((res) => {
      if (cancelled) return;
      const status = res.user.status ?? "active";
      setCheck({ ...asked, user: res.user, access: status === "active" ? "active" : status, message: null });
    }).catch((error: unknown) => {
      if (cancelled) return;
      setCheck({
        ...asked,
        user: null,
        access: errorCode(error) === "email_unverified" ? "email-unverified" : "error",
        message: error instanceof Error ? error.message : "Field could not check your access.",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, userId, getToken, attempt]);

  // Signed out: forget the answer, so a later sign-in waits for a new one.
  if (isLoaded && !isSignedIn && check) setCheck(null);
  const current = isLoaded && isSignedIn && check
    && check.userId === userId && check.getToken === getToken && check.attempt === attempt
    ? check
    : null;
  const access: AccessState = !isLoaded ? "loading" : !isSignedIn ? "signed-out" : current?.access ?? "loading";
  const accessMessage = current?.message ?? null;
  const user = current?.user ?? null;

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
