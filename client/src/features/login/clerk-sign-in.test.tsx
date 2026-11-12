import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/contexts/auth-context";
import { AuthProvider } from "@/contexts/auth-provider";
import { safeReturnTo } from "@/contexts/return-to";
import { api, setSessionTokenProvider } from "@/lib/api";
import { App } from "@/app";
import { PeopleSection } from "@/features/settings/people-section";

// Clerk is mocked: no network, no real keys.
const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: false,
  userId: null as string | null,
  providerProps: [] as Array<Record<string, unknown>>,
  signInProps: [] as Array<Record<string, unknown>>,
  signOut: vi.fn(async () => {}),
  openUserProfile: vi.fn(),
  getToken: vi.fn(async () => "clerk-session-jwt"),
}));

vi.mock("@clerk/react", () => ({
  ClerkProvider: (props: { children: ReactNode } & Record<string, unknown>) => {
    clerkState.providerProps.push(props);
    return <>{props.children}</>;
  },
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    userId: clerkState.userId,
    getToken: clerkState.getToken,
    signOut: clerkState.signOut,
  }),
  useClerk: () => ({ openUserProfile: clerkState.openUserProfile }),
  SignIn: (props: Record<string, unknown>) => {
    clerkState.signInProps.push(props);
    return <div data-testid="clerk-sign-in" />;
  },
}));

type Route = (init?: RequestInit) => { status?: number; body: unknown };
let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body };
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "#/";
  clerkState.isLoaded = true;
  clerkState.isSignedIn = false;
  clerkState.userId = null;
  clerkState.providerProps = [];
  clerkState.signInProps = [];
  clerkState.getToken.mockClear();
  routes = {
    "/api/auth/config": () => ({
      body: { ok: true, mode: "clerk", clerk: { publishableKey: "pk_test_ZmllbGQuZXhhbXBsZSQ", proxyUrl: null } },
    }),
    "/api/ui-config": () => ({ body: { ok: true, ui: {} } }),
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0];
    const route = routes[path];
    if (!route) return respond(404, { error: `no route for ${path}` });
    const { status = 200, body } = route(init);
    return respond(status, body);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  setSessionTokenProvider(null);
  vi.unstubAllGlobals();
});

function renderApp() {
  return render(
    <AuthProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </AuthProvider>,
  );
}

function headerOf(path: string): string | undefined {
  const call = fetchMock.mock.calls.find(([input]) => String(input).startsWith(path));
  const headers = (call?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe("sign-in shell", () => {
  it("keeps the password form when the server has no Clerk sign-in (FIELD_AUTH unset)", async () => {
    routes["/api/auth/config"] = () => ({ body: { ok: true, mode: "password" } });
    renderApp();
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(clerkState.providerProps).toHaveLength(0);
    expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
  });

  it("falls back to the password form when the server predates /api/auth/config", async () => {
    delete routes["/api/auth/config"];
    renderApp();
    expect(await screen.findByLabelText("Password")).toBeTruthy();
  });

  it("shows Field's branded Clerk sign-in, with no password form, when signed out", async () => {
    renderApp();
    expect(await screen.findByTestId("clerk-sign-in")).toBeTruthy();
    expect(screen.getByText("Use your work account.")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(clerkState.providerProps[0].publishableKey).toBe("pk_test_ZmllbGQuZXhhbXBsZSQ");
    const props = clerkState.signInProps.at(-1)!;
    expect(props.routing).toBe("hash");
    expect(String(props.forceRedirectUrl)).toMatch(/#\/jobs$/);
    const appearance = props.appearance as { variables: Record<string, string> };
    expect(appearance.variables.colorPrimary).toBeTruthy();
  });

  it("tells a signed-in person who is not approved yet that they are waiting, using the Clerk session token", async () => {
    clerkState.isSignedIn = true;
    clerkState.userId = "user_new";
    routes["/api/auth/me"] = () => ({
      body: { ok: true, user: { id: "u1", email: "new@example.com", name: "New", status: "pending", fieldRole: "staff" } },
    });
    renderApp();
    expect(await screen.findByText("Waiting for approval")).toBeTruthy();
    expect(screen.getByText(/new@example\.com/)).toBeTruthy();
    expect(headerOf("/api/auth/me")).toBe("Bearer clerk-session-jwt");
    expect(screen.queryByTestId("clerk-sign-in")).toBeNull();

    // Approved meanwhile: "Check again" lets them in.
    routes["/api/auth/me"] = () => ({
      body: { ok: true, user: { id: "u1", email: "new@example.com", name: "New", status: "active", fieldRole: "staff" } },
    });
    fireEvent.click(screen.getByText("Check again"));
    await waitFor(() => expect(screen.queryByText("Waiting for approval")).toBeNull());
  });

  it("explains an unverified email instead of signing them in", async () => {
    clerkState.isSignedIn = true;
    clerkState.userId = "user_x";
    routes["/api/auth/me"] = () => ({ status: 403, body: { error: "verify", code: "email_unverified" } });
    renderApp();
    expect(await screen.findByText("Verify your email")).toBeTruthy();
    fireEvent.click(screen.getByText("Manage account"));
    expect(clerkState.openUserProfile).toHaveBeenCalled();
  });

  it("gives an approved owner access and reports their role", async () => {
    clerkState.isSignedIn = true;
    clerkState.userId = "user_owner";
    routes["/api/auth/me"] = () => ({
      body: { ok: true, user: { id: "o1", email: "owner@example.com", name: "Owner", status: "active", fieldRole: "owner", mfaVerified: true } },
    });
    function Probe() {
      const auth = useAuth();
      return <div data-testid="probe">{`${auth.mode}:${auth.access}:${auth.isOwner}`}</div>;
    }
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("clerk:active:true"));
  });
  it("asks the server again when the same person signs in again, without the earlier answer", async () => {
    clerkState.isSignedIn = true;
    clerkState.userId = "user_owner";
    routes["/api/auth/me"] = () => ({
      body: { ok: true, user: { id: "o1", email: "owner@example.com", name: "Owner", status: "active", fieldRole: "owner" } },
    });
    const seen: string[] = [];
    function Probe() {
      const auth = useAuth();
      seen.push(auth.access);
      return <div data-testid="probe">{auth.access}</div>;
    }
    const view = render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("active"));

    // Signed out in another tab, then disabled, then signed in again here.
    clerkState.isSignedIn = false;
    view.rerender(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("signed-out"));
    routes["/api/auth/me"] = () => ({
      body: { ok: true, user: { id: "o1", email: "owner@example.com", name: "Owner", status: "disabled", fieldRole: "owner" } },
    });
    seen.length = 0;
    clerkState.isSignedIn = true;
    view.rerender(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("disabled"));
    expect(seen).not.toContain("active");
  });
});

describe("no stale Field token in Clerk mode", () => {
  it("drops a password-era fr_token and fr_user as soon as Clerk sign-in mounts", async () => {
    localStorage.setItem("fr_token", "field_stale-password-era-token");
    localStorage.setItem("fr_user", JSON.stringify({ id: "old" }));
    renderApp();
    expect(await screen.findByTestId("clerk-sign-in")).toBeTruthy();
    // The lazy provider clears storage in a passive effect, after rendering.
    await waitFor(() => {
      expect(localStorage.getItem("fr_token")).toBeNull();
      expect(localStorage.getItem("fr_user")).toBeNull();
    });
  });

  it("puts no token in PDF or wall-render URLs while a Clerk session provides tokens", () => {
    localStorage.setItem("fr_token", "field_stale-password-era-token");
    setSessionTokenProvider(async () => "clerk-session-jwt", "owner");
    const pdf = new URL(api.quotePdfUrl("job-1", "v2", 1, "invoice"), "http://field.test");
    const wall = new URL(api.wallRenderUrl("job-1", "zone a", "v2", "dark"), "http://field.test");
    expect(pdf.searchParams.has("token")).toBe(false);
    expect(pdf.searchParams.get("version")).toBe("v2");
    expect(wall.searchParams.has("token")).toBe(false);
    expect(wall.searchParams.get("format")).toBe("html");
  });

  it("puts no Field token in those URLs with password sign-in either: it goes in the Authorization header", async () => {
    localStorage.setItem("fr_token", "field_password-mode-token");
    setSessionTokenProvider(null);
    const pdfUrl = api.quotePdfUrl("job-1");
    expect(new URL(pdfUrl, "http://field.test").searchParams.has("token")).toBe(false);
    expect(new URL(api.wallRenderUrl("job-1", "z"), "http://field.test").searchParams.has("token")).toBe(false);
    const fetchMock = vi.fn(async () => new Response(new Blob(["%PDF"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await api.documentPdf(pdfUrl);
    } finally {
      vi.unstubAllGlobals();
      localStorage.removeItem("fr_token");
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer field_password-mode-token");
  });
});

describe("return to the MCP authorization page", () => {
  it("only honours a same-origin /oauth/authorize path", () => {
    expect(safeReturnTo("?return_to=%2Foauth%2Fauthorize%3Fclient_id%3Dx")).toBe("/oauth/authorize?client_id=x");
    expect(safeReturnTo("?return_to=https%3A%2F%2Fevil.example%2Foauth%2Fauthorize%3F")).toBeNull();
    expect(safeReturnTo("?return_to=%2F%2Fevil.example%2Foauth%2Fauthorize%3F")).toBeNull();
    expect(safeReturnTo("?return_to=%2Fapi%2Fusers")).toBeNull();
    expect(safeReturnTo("")).toBeNull();
  });
});

describe("people (owner screen)", () => {
  it("lists people waiting for approval and approves one", async () => {
    setSessionTokenProvider(async () => "clerk-session-jwt", "owner");
    let approvedBody: unknown = null;
    routes["/api/users"] = () => ({
      body: {
        ok: true,
        users: [
          { id: "p1", email: "new@example.com", name: "New Person", role: "staff", status: "pending", linked: true, createdAt: null, updatedAt: null },
          { id: "o1", email: "owner@example.com", name: "Owner", role: "owner", status: "active", linked: true, createdAt: null, updatedAt: null },
        ],
      },
    });
    routes["/api/users/p1/approve"] = (init) => {
      approvedBody = JSON.parse(String(init?.body));
      return { body: { ok: true, user: {} } };
    };
    render(<PeopleSection selfId="o1" />);
    expect(await screen.findByText("New Person")).toBeTruthy();
    expect(screen.getByText("Owner (you)")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve as staff"));
    await waitFor(() => expect(approvedBody).toEqual({ role: "staff" }));
    expect(headerOf("/api/users/p1/approve")).toBe("Bearer clerk-session-jwt");
  });

  it("shows the server's refusal, e.g. when the owner sign-in is not verified", async () => {
    routes["/api/users"] = () => ({ status: 403, body: { error: "Owner actions need a verified owner sign-in. Sign out, then sign in with Google using your work account.", code: "owner_mfa_required" } });
    render(<PeopleSection selfId="o1" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/verified owner sign-in/);
  });
});
