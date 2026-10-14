import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "@/lib/api";
import type { AccessToken, FieldUser, McpInstallation, ServiceAccount } from "@/lib/types";
import { AccessSection } from "./access-section";

const toast = vi.fn();
const logout = vi.fn();
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast }) }));
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => ({ logout }) }));

// Synthetic people, service account, tokens and agent.
const OWNER: FieldUser = { id: "usr_owner", email: "owner@example.test", name: "Olive Owner", role: "owner", status: "active", linked: true, createdAt: null, updatedAt: null };
const STAFF: FieldUser = { id: "usr_staff", email: "staff@example.test", name: "Sam Staff", role: "staff", status: "active", linked: true, createdAt: null, updatedAt: null };
const SERVICE: ServiceAccount = { id: "svc_retired", email: "retired-agent@example.test", name: "Retired Agent", kind: "service", role: "admin", createdAt: null };
const OLD_TOKEN: AccessToken = { id: "tok_old", label: "retired agent field token", createdAt: "2026-09-01T12:00:00.000Z", lastUsedAt: "2026-10-01T12:00:00.000Z", current: false };
const SPARE_TOKEN: AccessToken = { id: "tok_spare", label: "spare", createdAt: "2026-09-02T12:00:00.000Z", lastUsedAt: null, current: false };
const OWNER_CLI: AccessToken = { id: "tok_owner", label: "owner laptop CLI", createdAt: "2026-09-03T12:00:00.000Z", lastUsedAt: null, current: false };
const AGENT: McpInstallation = { id: "grant_1", subject: "usr_owner", clientId: "field_client_1", clientName: "Synthetic Desktop Agent", scopes: ["quote.read", "quote.write"], createdAt: "2026-10-02T12:00:00.000Z", lastUsedAt: "2026-10-13T12:00:00.000Z", revokedAt: null };

function stubApi({ tokens = { [OWNER.id]: [OWNER_CLI], [STAFF.id]: [], [SERVICE.id]: [OLD_TOKEN, SPARE_TOKEN] } as Record<string, AccessToken[]>, agents = [AGENT] as McpInstallation[] | null } = {}) {
  vi.spyOn(api, "listFieldUsers").mockResolvedValue({ ok: true, users: [OWNER, STAFF], serviceAccounts: [SERVICE] });
  vi.spyOn(api, "listUserTokens").mockImplementation(async (id: string) => ({ ok: true, tokens: tokens[id] ?? [] }));
  vi.spyOn(api, "listMcpInstallations").mockImplementation(async () => {
    if (agents === null) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { ok: true, installations: agents };
  });
  vi.spyOn(api, "accessEvents").mockResolvedValue({ ok: true, events: [] });
}

beforeEach(() => {
  toast.mockReset();
  logout.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Settings › Team › Access", () => {
  it("lists one compact row per holder with counts, and only those holding something", async () => {
    stubApi();
    render(<AccessSection selfId={OWNER.id} />);
    const list = await screen.findByRole("list", { name: "Who holds tokens and connected agents" });
    const rows = within(list).getAllByRole("button", { expanded: false });
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Olive Owner (you)");
    expect(rows[0].textContent).toContain("1 command-line token · 1 connected agent");
    expect(rows[1].textContent).toContain("Retired Agent");
    expect(rows[1].textContent).toContain("Service account");
    expect(rows[1].textContent).toContain("2 command-line tokens");
    expect(screen.queryByText(/Sam Staff/)).toBeNull();
    expect(screen.getByText(/Everyone else on the team holds no tokens/)).toBeTruthy();
    // Collapsed: no details yet.
    expect(screen.queryByText("retired agent field token")).toBeNull();
  });

  it("expands a row to its tokens and agents: name, created, last used, scope; never a value", async () => {
    stubApi();
    render(<AccessSection selfId={OWNER.id} />);
    const row = await screen.findByRole("button", { name: /Retired Agent/ });
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const tokens = screen.getByRole("region", { name: "Retired Agent's command-line tokens" });
    expect(within(tokens).getByText("retired agent field token")).toBeTruthy();
    expect(within(tokens).getAllByText(/Created 1 Sep 2026/)).toHaveLength(1);
    expect(within(tokens).getByText(/Never used/)).toBeTruthy();
    expect(within(tokens).getAllByText(/Acts as Retired Agent \(owner\), except owner-only actions/)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Olive Owner/ }));
    const agents = screen.getByRole("region", { name: "Agents Olive Owner connected" });
    expect(within(agents).getByText("Synthetic Desktop Agent")).toBeTruthy();
    expect(within(agents).getByText(/Approved by Olive Owner on 2 Oct 2026/)).toBeTruthy();
    expect(within(agents).getByText("quote.write")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/field_[A-Za-z0-9_-]{20,}/);
  });

  it("Revoke asks first, naming the token and its holder, then calls DELETE /api/users/:id/tokens/:tokenId", async () => {
    stubApi();
    const revoke = vi.spyOn(api, "revokeUserToken").mockResolvedValue({ ok: true, audited: true, signedOut: false });
    render(<AccessSection selfId={OWNER.id} />);
    fireEvent.click(await screen.findByRole("button", { name: /Retired Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke retired agent field token" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Revoke “retired agent field token”?")).toBeTruthy();
    expect(dialog.textContent).toContain("belongs to Retired Agent");

    // Cancel does nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Revoke retired agent field token" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(SERVICE.id, OLD_TOKEN.id, { current: false }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Token “retired agent field token” revoked."));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });

  it("an owner's own token: the confirm says the CLI stops and their sign-in here does not", async () => {
    stubApi();
    render(<AccessSection selfId={OWNER.id} />);
    fireEvent.click(await screen.findByRole("button", { name: /Olive Owner/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke owner laptop CLI" }));
    expect(screen.getByRole("alertdialog").textContent).toMatch(/This is your own token\. The field command that uses it stops working/);
  });

  it("the token this browser signed in with: an explicit warning, then revoke with confirm=current and sign out", async () => {
    stubApi({ tokens: { [OWNER.id]: [{ ...OWNER_CLI, label: "session", current: true }] } });
    const revoke = vi.spyOn(api, "revokeUserToken").mockResolvedValue({ ok: true, audited: true, signedOut: true });
    render(<AccessSection selfId={OWNER.id} />);
    fireEvent.click(await screen.findByRole("button", { name: /Olive Owner/ }));
    expect(screen.getByText("This session")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke session" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Revoking it signs you out");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke and sign out" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(OWNER.id, OWNER_CLI.id, { current: true }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  it("Disconnect asks first, naming the agent and who approved it, then calls DELETE /api/mcp/installations/:id", async () => {
    stubApi();
    const disconnect = vi.spyOn(api, "disconnectMcpInstallation").mockResolvedValue({ ok: true, audited: true });
    render(<AccessSection selfId={OWNER.id} />);
    fireEvent.click(await screen.findByRole("button", { name: /Olive Owner/ }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Synthetic Desktop Agent" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Disconnect “Synthetic Desktop Agent”?")).toBeTruthy();
    expect(dialog.textContent).toContain("Olive Owner approved this agent on 2 Oct 2026");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect agent" }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith(AGENT.id));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("“Synthetic Desktop Agent” disconnected."));
  });

  it("finds a token by its name or its holder's name", async () => {
    stubApi();
    render(<AccessSection selfId={OWNER.id} />);
    const search = await screen.findByRole("searchbox", { name: "Find a token, agent or person" });
    fireEvent.change(search, { target: { value: "retired agent field" } });
    expect(screen.getByText("retired agent field token")).toBeTruthy();
    expect(screen.queryByText("spare")).toBeNull();
    expect(screen.queryByRole("button", { name: /Olive Owner/ })).toBeNull();
    fireEvent.change(search, { target: { value: "olive" } });
    expect(screen.getByText("owner laptop CLI")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nobody" } });
    expect(screen.getByText(/Nothing matches “nobody”/)).toBeTruthy();
  });

  it("empty state: nobody holds a token or agent", async () => {
    stubApi({ tokens: {}, agents: [] });
    render(<AccessSection selfId={OWNER.id} />);
    expect(await screen.findByText("No command-line tokens or connected agents")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Who holds tokens and connected agents" })).toBeNull();
  });

  it("empty state says when connected agents are off on this installation", async () => {
    stubApi({ tokens: {}, agents: null });
    render(<AccessSection selfId={OWNER.id} />);
    expect(await screen.findByText(/Connected agents \(MCP\) are off on this installation/)).toBeTruthy();
  });

  it("a server refusal shows as an alert", async () => {
    vi.spyOn(api, "listFieldUsers").mockRejectedValue(new Error("Owner actions need an owner signed in to Field."));
    render(<AccessSection selfId={OWNER.id} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Owner actions need an owner signed in");
  });
});
