import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Clerk is mocked: no network, no real keys.
const clerkState = vi.hoisted(() => ({ openUserProfile: vi.fn(), userProfileRendered: false }));

vi.mock("@clerk/react", () => ({
  useClerk: () => ({ openUserProfile: clerkState.openUserProfile }),
  UserProfile: () => {
    clerkState.userProfileRendered = true;
    return null;
  },
}));

import ClerkAccount from "./clerk-account";

afterEach(() => {
  cleanup();
  clerkState.openUserProfile.mockReset();
  clerkState.userProfileRendered = false;
  window.location.hash = "";
});

describe("ClerkAccount", () => {
  // Issue #180: an embedded <UserProfile> gets Clerk's hash router, which reads
  // #/settings as its own path (empty pane) and clears Field's route on click.
  it("opens Clerk's account modal instead of embedding UserProfile under Field's hash route", () => {
    window.location.hash = "#/settings";
    render(<ClerkAccount />);
    expect(clerkState.userProfileRendered).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Manage your account" }));

    expect(clerkState.openUserProfile).toHaveBeenCalledTimes(1);
    const props = clerkState.openUserProfile.mock.calls[0][0];
    expect(props.routing).toBeUndefined();
    expect(props.path).toBeUndefined();
    expect(props.appearance.variables.colorPrimary).toBeTruthy();
    // The embedded full-width card styles don't apply inside a modal.
    expect(props.appearance.elements.cardBox).toBeUndefined();
    expect(props.appearance.elements.rootBox).toBeUndefined();
    expect(window.location.hash).toBe("#/settings");
  });
});
