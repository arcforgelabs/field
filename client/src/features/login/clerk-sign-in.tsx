// The Field sign-in screen with Clerk (FIELD_AUTH=clerk). Shown for every route
// until the person has Field access, so Clerk's own steps (second factor,
// verification codes) can use the URL hash without fighting the app router.
import type { ReactNode } from "react";
import { SignIn } from "@clerk/react";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/field";
import { SignInFrame } from "./sign-in-frame";
import { fieldClerkAppearance } from "@/lib/clerk-appearance";

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        width: "100%",
        padding: "14px 16px",
        background: "var(--t-paper)",
        border: "var(--t-stroke, 2px) solid var(--t-stroke-color, var(--t-text))",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--t-dim)" }}>{children}</div>
    </div>
  );
}

export function ClerkSignInShell() {
  const { access, accessMessage, user, logout, openAccount, retry } = useAuth();

  if (access === "loading") {
    return (
      <SignInFrame title="Sign in" subtitle="Loading…">
        {null}
      </SignInFrame>
    );
  }

  if (access === "signed-out") {
    // After sign-in, land on the jobs list (keeping ?return_to= for the MCP
    // authorization page).
    const landing = `${window.location.pathname}${window.location.search}#/jobs`;
    return (
      <SignInFrame title="Sign in" subtitle="Use your work account.">
        <SignIn routing="hash" forceRedirectUrl={landing} signUpForceRedirectUrl={landing} appearance={fieldClerkAppearance()} />
      </SignInFrame>
    );
  }

  const signOut = (
    <Button block onClick={logout}>
      Sign out
    </Button>
  );

  let notice: ReactNode;
  let action: ReactNode = null;
  if (access === "pending") {
    notice = (
      <Notice title="Waiting for approval">
        You're signed in as {user?.email ?? "a new user"}, but a Field owner still needs to approve your access.
        Ask them to approve you under Settings › People, then check again.
      </Notice>
    );
    action = retry && (
      <Button variant="primary" block onClick={retry}>
        Check again
      </Button>
    );
  } else if (access === "disabled") {
    notice = (
      <Notice title="Access turned off">
        Your Field access has been turned off. Ask a Field owner if this is a mistake.
      </Notice>
    );
  } else if (access === "email-unverified") {
    notice = (
      <Notice title="Verify your email">
        Field recognises people by a verified email address. Verify your primary email in your account, then check again.
      </Notice>
    );
    action = (
      <>
        {openAccount && (
          <Button variant="primary" block onClick={openAccount}>
            Manage account
          </Button>
        )}
        {retry && (
          <Button block onClick={retry}>
            Check again
          </Button>
        )}
      </>
    );
  } else {
    notice = (
      <Notice title="Field couldn't check your access">
        {accessMessage || "Try again in a moment."}
      </Notice>
    );
    action = retry && (
      <Button variant="primary" block onClick={retry}>
        Try again
      </Button>
    );
  }

  return (
    <SignInFrame title="Your access">
      {notice}
      {action}
      {signOut}
    </SignInFrame>
  );
}

export default ClerkSignInShell;
