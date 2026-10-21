// Clerk's own account screens (profile, email, connected accounts, security,
// devices), opened from Settings. Loaded only with Clerk sign-in.
import { useClerk } from "@clerk/react";
import { UserRound } from "lucide-react";
import { fieldClerkAppearance } from "@/lib/clerk-appearance";

// Field routes with the URL hash (#/settings). An embedded <UserProfile>
// always gets Clerk's hash router (its mounted components honour only
// "path" routing; "virtual" falls back to hash), which reads #/settings as
// its own path, shows no page, and overwrites Field's route on every click.
// Clerk's modal uses its in-memory router and leaves the URL alone.
export default function ClerkAccount() {
  const clerk = useClerk();
  const open = () => {
    // Read the theme tokens at open time, so the modal matches the current
    // design system and mode.
    const appearance = fieldClerkAppearance({ embedded: true });
    clerk.openUserProfile({
      appearance: { ...appearance, elements: { ...appearance.elements, rootBox: undefined, cardBox: undefined } },
    });
  };
  return (
    <div>
      <button type="button" className="fx-btn" onClick={open}><UserRound aria-hidden />Manage your account</button>
    </div>
  );
}
