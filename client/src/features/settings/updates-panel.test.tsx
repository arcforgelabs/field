import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/lib/api";
import type { InvoicingSettings, UpdateStatus } from "@/lib/types";
import { UpdateNotice, UpdatesPanel } from "./updates-panel";
import { resetUpdateStatus } from "./use-update-status";

const auth = { isOwner: true };
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast: () => {} }) }));

const status = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
  ok: true,
  enabled: true,
  channel: "stable",
  current: "v2026.10.15",
  latest: "v2026.10.16",
  updateAvailable: true,
  checkedAt: "2026-10-15T00:00:00.000Z",
  error: null,
  releaseUrl: "https://github.com/arcforgelabs/field/releases/tag/v2026.10.16",
  upgradeUrl: "https://github.com/arcforgelabs/field/blob/main/docs/REPLIT.md#following-stable-releases",
  ...overrides,
});

beforeEach(() => { auth.isOwner = true; resetUpdateStatus(); });
afterEach(() => vi.restoreAllMocks());

describe("UpdateNotice", () => {
  it("names the newer release and links its notes and the upgrade guide", () => {
    render(<UpdateNotice status={status()} />);
    expect(screen.getByRole("status").textContent).toContain("Update available: field 2026.10.16 (you run field 2026.10.15).");
    expect(screen.getByRole("link", { name: "See what's new" }).getAttribute("href")).toBe("https://github.com/arcforgelabs/field/releases/tag/v2026.10.16");
    expect(screen.getByRole("link", { name: "How to update" }).getAttribute("href")).toContain("docs/REPLIT.md#following-stable-releases");
  });

  it("shows nothing when there is no update", () => {
    const { container } = render(<UpdateNotice status={status({ updateAvailable: false, releaseUrl: null })} />);
    expect(container.textContent).toBe("");
    expect(render(<UpdateNotice status={null} />).container.textContent).toBe("");
  });
});

describe("UpdatesPanel", () => {
  it("shows the running release and turns the check off, then asks the server again", async () => {
    const updates = vi.spyOn(api, "updates")
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ enabled: false, latest: null, updateAvailable: false, releaseUrl: null }));
    const save = vi.spyOn(api, "updateInvoicingSettings").mockResolvedValue({ ok: true, updateCheck: false } as InvoicingSettings);
    render(<UpdatesPanel />);
    const checkbox = await screen.findByRole("checkbox", { name: /Check for new Field releases/ }) as HTMLInputElement;
    expect(screen.getByText(/runs field 2026.10.15 on the stable channel/)).toBeTruthy();
    expect(screen.getByText(/It sends nothing about this installation/)).toBeTruthy();
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ updateCheck: false }));
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(updates).toHaveBeenCalledTimes(2);
  });

  it("says so when the installation is not running a release", async () => {
    vi.spyOn(api, "updates").mockResolvedValue(status({ current: null, latest: null, updateAvailable: false, releaseUrl: null }));
    render(<UpdatesPanel />);
    expect(await screen.findByText(/not running a published release/)).toBeTruthy();
  });

  it("asks nothing and shows nothing for someone who is not an owner", async () => {
    auth.isOwner = false;
    const updates = vi.spyOn(api, "updates").mockResolvedValue(status());
    const { container } = render(<UpdatesPanel />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});
