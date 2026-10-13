// Settings > Integrations: the catalogue renders from its data, searches,
// switches tabs, and opens the wizard or the detail view; nothing on the
// home page shows a key, a credential or a status label.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/lib/api";
import type { XeroIntegration } from "@/lib/types";
import { IntegrationsPage } from "./integrations-page";
import type { IntegrationEntry } from "./integrations-list";
import { MonogramMark } from "./integration-marks";

vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast: () => {} }) }));

function xero(overrides: Partial<XeroIntegration> = {}): XeroIntegration {
  return {
    ok: true,
    redirectUri: "https://field.example.invalid/api/integrations/xero/callback",
    appUrl: "https://field.example.invalid",
    publicUrlConfigured: true,
    canManage: true,
    secretsKey: { configured: false, problem: "SECRETS_KEY_MISSING", keyId: null, previousKeys: 0 },
    credentials: {
      source: null,
      problem: "SECRETS_KEY_MISSING",
      environment: { clientIdSet: false, clientSecretSet: false },
      environmentOverride: false,
      settings: { clientId: { set: false, setAt: null, setBy: null }, clientSecret: { set: false, setAt: null, setBy: null } },
    },
    history: [],
    scopes: ["offline_access", "accounting.invoices"],
    connection: { status: "disconnected", tenantName: null, connectedAt: null, connectedBy: null, reconnectReason: null, reconnectMessage: null, organisations: [] },
    settings: { createMode: "draft", salesAccountCode: "200", taxType: "OUTPUT", invoiceNumbering: "field", autoFrom: null },
    choices: { createMode: [{ value: "off", label: "Off", description: "Nothing." }, { value: "draft", label: "Draft invoice", description: "A draft." }, { value: "authorised", label: "Approved invoice", description: "Approved." }] },
    setup: { orgUid: "org_01TESTFIELDORGANISATION00", step: null, pending: null, problem: null },
    ...overrides,
  };
}

const CONNECTED: XeroIntegration["connection"] = { status: "connected", tenantName: "Synthetic Earthworks Pty Ltd", connectedAt: "2026-10-13T00:00:00.000Z", connectedBy: "Owner Person", reconnectReason: null, reconnectMessage: null, organisations: [] };
const KEY_SET = { configured: true, problem: null, keyId: "abc123def456", previousKeys: 0 };

function entry(id: string, name: string, description: string, connected: boolean, canManage = true): IntegrationEntry {
  return {
    id,
    name,
    description,
    Logo: () => <MonogramMark letter={name[0]} label={name} />,
    loadStatus: async () => ({ connected, canManage }),
    View: ({ onBack }) => <div role="region" aria-label={`${name} view`}><button type="button" onClick={onBack}>Back</button></div>,
  };
}

function show(entries?: IntegrationEntry[], initial = "/settings?section=integrations") {
  return render(<MemoryRouter initialEntries={[initial]}><IntegrationsPage entries={entries} /></MemoryRouter>);
}

afterEach(() => vi.restoreAllMocks());

describe("Integrations catalogue", () => {
  it("renders a card for every entry in the list, with a logo, a name and one line", async () => {
    const entries = [entry("ledger", "Synthetic Ledger", "Send invoices to a ledger.", false), entry("crm", "Synthetic CRM", "Keep customers in step.", true)];
    show(entries);
    const cards = await screen.findAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole("img", { name: "Synthetic Ledger logo" })).toBeTruthy();
    expect(within(cards[0]).getByText("Send invoices to a ledger.")).toBeTruthy();
    expect(await within(cards[0]).findByRole("button", { name: "Connect Synthetic Ledger" })).toBeTruthy();
    expect(await within(cards[1]).findByRole("img", { name: "Synthetic CRM is connected" })).toBeTruthy();
    expect(within(cards[1]).queryByRole("button", { name: /^Connect/ })).toBeNull();
  });

  it("search filters by name and description, and says when nothing matches", async () => {
    show([entry("ledger", "Synthetic Ledger", "Send invoices to a ledger.", false), entry("crm", "Synthetic CRM", "Keep customers in step.", true)]);
    const search = await screen.findByRole("searchbox", { name: "Search integrations" });
    fireEvent.change(search, { target: { value: "customers" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Synthetic CRM")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(/No integration matches/)).toBeTruthy();
  });

  it("the Connected tab shows only connected integrations; Browse shows them all", async () => {
    show([entry("ledger", "Synthetic Ledger", "Send invoices to a ledger.", false), entry("crm", "Synthetic CRM", "Keep customers in step.", true)]);
    const connectedTab = screen.getByRole("tab", { name: /Connected/ });
    await waitFor(() => expect(connectedTab.textContent).toMatch(/1/));
    fireEvent.click(connectedTab);
    expect(connectedTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Synthetic CRM")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Browse" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("an entry's card opens its view, and Back returns to the catalogue", async () => {
    show([entry("ledger", "Synthetic Ledger", "Send invoices to a ledger.", false)]);
    fireEvent.click(await screen.findByRole("button", { name: /Synthetic Ledger: Send invoices/ }));
    expect(screen.getByRole("region", { name: "Synthetic Ledger view" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("searchbox", { name: "Search integrations" })).toBeTruthy();
  });

  it("Xero is the first card; not connected, its + opens the Connect wizard", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(xero());
    show();
    const first = (await screen.findAllByRole("listitem"))[0];
    expect(within(first).getByText("Xero")).toBeTruthy();
    fireEvent.click(await within(first).findByRole("button", { name: "Connect Xero" }));
    expect(await screen.findByRole("region", { name: "1. Create your Xero app" })).toBeTruthy();
  });

  it("Xero connected: a check on the card; the card opens 'Connected to' with Configure, and Advanced stays hidden", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(xero({ connection: CONNECTED, secretsKey: KEY_SET, credentials: { ...xero().credentials, source: "settings", problem: null } }));
    vi.spyOn(api, "xeroCodes").mockResolvedValue({ ok: true, available: false, code: "XERO_UNAVAILABLE", accounts: [], taxRates: [] });
    show();
    expect(await screen.findByRole("img", { name: "Xero is connected" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Xero: / }));
    expect(await screen.findByText("Connected to Synthetic Earthworks Pty Ltd")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Configure/ }));
    expect(screen.getByRole("radio", { name: /Approved invoice/ })).toBeTruthy();
    expect((screen.getByText("Advanced").closest("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("someone who is not an owner sees the catalogue without +, and Xero read-only", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(xero({ canManage: false, setup: null, connection: CONNECTED }));
    show();
    expect(await screen.findByRole("img", { name: "Xero is connected" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Xero" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Xero: / }));
    expect(await screen.findByText("Connected to Synthetic Earthworks Pty Ltd")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Configure/ })).toBeNull();
  });

  it("the home page shows no key, credential or status label, even with the key missing", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(xero());
    show();
    await screen.findByRole("button", { name: "Connect Xero" });
    const text = document.body.textContent || "";
    expect(text).not.toMatch(/FIELD_SECRETS_KEY|encryption key|client secret|client id|credential|not connected|not set/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Xero's sign-in coming back opens Xero", async () => {
    vi.spyOn(api, "xeroIntegration").mockResolvedValue(xero({ connection: CONNECTED, secretsKey: KEY_SET, credentials: { ...xero().credentials, source: "settings", problem: null }, setup: { orgUid: "org_01TESTFIELDORGANISATION00", step: "connect", pending: null, problem: null } }));
    show(undefined, "/settings?section=integrations&xero=connected");
    expect(await screen.findByText(/Connected to Synthetic Earthworks Pty Ltd/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "4. Connect" })).toBeTruthy();
  });
});
