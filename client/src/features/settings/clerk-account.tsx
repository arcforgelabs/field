// Clerk's own account screens (profile, email, connected accounts, security,
// devices) inside Settings. Loaded only with Clerk sign-in.
import { UserProfile } from "@clerk/react";
import { useTheme } from "@/contexts/theme-context";
import { fieldClerkAppearance } from "@/lib/clerk-appearance";

// Field routes with the URL hash (#/settings), so Clerk's own steps can't use
// hash or path routing here. Clerk's runtime also supports "virtual" routing
// (its modals and extension SDK use it); its public types omit it.
const VIRTUAL_ROUTING = { routing: "virtual" } as unknown as { routing: "hash" };

export default function ClerkAccount() {
  // Re-read the tokens whenever the design system or mode changes.
  const { theme, accent } = useTheme();
  return <UserProfile key={`${theme}:${accent ?? ""}`} {...VIRTUAL_ROUTING} appearance={fieldClerkAppearance({ embedded: true })} />;
}
