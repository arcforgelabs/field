import { createContext, useContext } from "react";
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

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
