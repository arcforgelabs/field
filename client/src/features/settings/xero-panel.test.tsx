import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/lib/api";
import type { XeroIntegration } from "@/lib/types";
import { XeroPanel } from "./xero-panel";

vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast: () => {} }) }));

const REDIRECT = "https://field.example.invalid/api/integrations/xero/callback";

function integration(overrides: Partial<XeroIntegration> = {}): XeroIntegration {
  return {
    ok: true,
    redirectUri: REDIRECT,
    publicUrlConfigured: true,
    secrets: { clientIdSet: true, clientSecretSet: true },
    scopes: ["offline_access", "accounting.invoices", "accounting.contacts", "accounting.attachments", "accounting.settings.read"],
    connection: { status: "disconnected", tenantName: null, connectedAt: null, connectedBy: null, reconnectReason: null, reconnectMessage: null, organisations: [] },
    settings: { createMode: "draft", salesAccountCode: "200", taxType: "OUTPUT", invoiceNumbering: "field", autoFrom: null },
    choices: {
      createMode: [
        { value: "off", label: "Off", description: "Field creates nothing in Xero." },
        { value: "draft", label: "Draft invoice", description: "A draft in Xero." },
        { value: "authorised", label: "Approved invoice", description: "An approved invoice in Xero." },
      ],
    },
    ...overrides,
  };
}

function show(initial = "/settings?section=integrations") {
  return render(<MemoryRouter initialEntries={[initial]}><XeroPanel /></MemoryRouter>);
}

afterEach(() => vi.restoreAllMocks());

describe("XeroPanel", () => {
  it("shows the install steps with this installation's redirect address and whether each secret is set, never a value", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration({ secrets: { clientIdSet: true, clientSecretSet: false } }));
    show();
    await waitFor(() => expect(screen.getByText(REDIRECT)).toBeTruthy());
    const secrets = screen.getByText("XERO_CLIENT_ID").closest("ul") as HTMLElement;
    expect(within(secrets).getByText("Set")).toBeTruthy();
    expect(within(secrets).getByText("Not set")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Connect to Xero/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByText(/Email from Xero is coming later/)).toBeTruthy();
  });

  it("without publicUrl: says to set it, shows no address, and Connect stays off", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration({ publicUrlConfigured: false, redirectUri: null }));
    show();
    await waitFor(() => expect(screen.getByRole("note").textContent).toMatch(/Connect stays off until it is set/));
    expect(screen.queryByText(REDIRECT)).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
    expect((screen.getByRole("button", { name: /Connect to Xero/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Connect sends the owner to Xero's sign-in address", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration());
    const connect = vi.spyOn(api, "connectXero").mockResolvedValue({ ok: true, url: "https://login.example.invalid/authorize" });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Connect to Xero/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://login.example.invalid/authorize"));
    expect(connect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("connected: shows the organisation, saves Create in Xero and the codes, and asks before disconnecting", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration({
      connection: { status: "connected", tenantName: "Synthetic Earthworks Pty Ltd", connectedAt: "2026-10-13T00:00:00.000Z", connectedBy: "owner@example.invalid", reconnectReason: null, reconnectMessage: null, organisations: [] },
    }));
    vi.spyOn(api, "xeroCodes").mockResolvedValue({
      ok: true,
      available: true,
      accounts: [{ code: "200", name: "Sales" }, { code: "4000", name: "Earthworks income" }],
      taxRates: [{ taxType: "OUTPUT", name: "GST on Income", rate: 10 }, { taxType: "EXEMPTOUTPUT", name: "GST Free Income", rate: 0 }],
    });
    const update = vi.spyOn(api, "updateXeroSettings").mockResolvedValue({ ok: true, settings: { createMode: "authorised", salesAccountCode: "4000", taxType: "OUTPUT", invoiceNumbering: "field", autoFrom: null } });
    const disconnect = vi.spyOn(api, "disconnectXero").mockResolvedValue({ ok: true, status: "disconnected" });
    show();
    await waitFor(() => expect(screen.getByText("Synthetic Earthworks Pty Ltd")).toBeTruthy());
    expect(screen.getByText("Connected")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Draft invoice/ }) as HTMLInputElement).checked).toBe(true);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Approved invoice/ }));
    const accounts = await screen.findByRole("combobox", { name: /Sales account/ });
    expect([...(accounts as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["200 · Sales", "4000 · Earthworks income"]);
    expect([...(screen.getByRole("combobox", { name: /GST tax type/ }) as HTMLSelectElement).options].map((option) => option.value)).toEqual(["OUTPUT", "EXEMPTOUTPUT"]);
    fireEvent.change(accounts, { target: { value: "4000" } });
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ createMode: "authorised", salesAccountCode: "4000", taxType: "OUTPUT" }));

    fireEvent.click(screen.getByRole("button", { name: /Disconnect/ }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Xero?" });
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnect).toHaveBeenCalled());
  });

  it("when Xero's accounts cannot be read, the codes are typed, and the screen says why", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration({
      connection: { status: "connected", tenantName: "Synthetic Earthworks Pty Ltd", connectedAt: "2026-10-13T00:00:00.000Z", connectedBy: "Owner", reconnectReason: null, reconnectMessage: null, organisations: [] },
    }));
    vi.spyOn(api, "xeroCodes").mockResolvedValue({ ok: true, available: false, code: "XERO_UNAVAILABLE", accounts: [], taxRates: [] });
    show();
    await waitFor(() => expect(screen.getByText(/could not read your accounts and tax rates from Xero \(XERO_UNAVAILABLE\)/)).toBeTruthy());
    expect((screen.getByRole("textbox", { name: /Sales account/ }) as HTMLInputElement).value).toBe("200");
    expect(screen.queryByRole("combobox", { name: /Sales account/ })).toBeNull();
  });

  it("a saved code Field could not check is saved with a warning", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration({
      connection: { status: "connected", tenantName: "Synthetic Earthworks Pty Ltd", connectedAt: "2026-10-13T00:00:00.000Z", connectedBy: "Owner", reconnectReason: null, reconnectMessage: null, organisations: [] },
    }));
    vi.spyOn(api, "xeroCodes").mockResolvedValue({ ok: true, available: false, code: "XERO_UNAVAILABLE", accounts: [], taxRates: [] });
    vi.spyOn(api, "updateXeroSettings").mockResolvedValue({ ok: true, settings: { createMode: "draft", salesAccountCode: "4100", taxType: "OUTPUT", invoiceNumbering: "field", autoFrom: null, warning: "Saved, but Field could not check these codes with Xero (XERO_UNAVAILABLE). Check them in Xero." } });
    show();
    fireEvent.change(await screen.findByRole("textbox", { name: /Sales account/ }), { target: { value: "4100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/could not check these codes with Xero/));
  });

  it("several organisations: the owner chooses one", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration({
      connection: { status: "choose_organisation", tenantName: null, connectedAt: null, connectedBy: null, reconnectReason: null, reconnectMessage: null, organisations: [{ tenantId: "t-1", tenantName: "Synthetic Holdings" }, { tenantId: "t-2", tenantName: "Synthetic Earthworks" }] },
    }));
    const choose = vi.spyOn(api, "chooseXeroOrganisation").mockResolvedValue({ ok: true, status: "connected" });
    show();
    fireEvent.click(await screen.findByRole("radio", { name: "Synthetic Earthworks" }));
    fireEvent.click(screen.getByRole("button", { name: /Use this organisation/ }));
    await waitFor(() => expect(choose).toHaveBeenCalledWith("t-2"));
  });

  it("says why the owner must connect again", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration({
      connection: { status: "needs_reconnect", tenantName: "Synthetic Earthworks Pty Ltd", connectedAt: null, connectedBy: null, reconnectReason: "XERO_REFRESH_REJECTED", reconnectMessage: "Xero no longer accepts Field's sign-in: it expired or was revoked. Connect again.", organisations: [] },
    }));
    show();
    await waitFor(() => expect(screen.getByText(/no longer accepts Field's sign-in/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Connect again/ })).toBeTruthy();
  });

  it("reports how the callback went, from the address it came back to", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(integration());
    show("/settings?section=integrations&xero=error&code=XERO_STATE_INVALID");
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Press Connect again/));
  });
});
