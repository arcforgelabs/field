// The Connect Xero wizard against a fake server behind fetch, with synthetic
// data. The key is made in this browser and never leaves it: no request body
// or address holds it, nor the console, browser storage, a Sentry click
// breadcrumb or the setup prompt; its element is under Sentry's replay block.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { htmlTreeAsString } from "@sentry/core";
import type { XeroIntegration } from "@/lib/types";
import { scrubBreadcrumb } from "../../../../shared/sentry-scrub.js";
import { SEALED_VALUE } from "../../../../shared/secrets-web.js";
import { XeroPanel } from "./xero-panel";
import { HostChoices } from "./secret-hosts";
import { resumeStep, SECRET_HOSTS, SECRET_ON_SCREEN } from "./xero-wizard-model";

vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast: () => {} }) }));

const PUBLIC_URL = "https://field.example.invalid";
const REDIRECT = `${PUBLIC_URL}/api/integrations/xero/callback`;
const ORG_UID = "org_01TESTFIELDORGANISATION00";
const CLIENT_ID = "0123456789ABCDEF0123456789ABCDEF";
const CLIENT_SECRET = "synthetic-client-secret-for-tests-only-000000000";

function integration(overrides: Partial<XeroIntegration> = {}): XeroIntegration {
  return {
    ok: true,
    redirectUri: REDIRECT,
    appUrl: PUBLIC_URL,
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
    setup: { orgUid: ORG_UID, step: null, pending: null, problem: null },
    ...overrides,
  };
}

type Call = { url: string; method: string; body: string | null };

/** A fake Field server: the Xero screen and the wizard's routes. */
function fakeServer(initial: XeroIntegration) {
  let state = initial;
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "", headers: new Headers({ "cache-control": "no-store" }), json: async () => body }) as unknown as Response;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    const body = typeof init.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    if (url === "/api/integrations/xero" && method === "GET") return json(state);
    if (url === "/api/integrations/xero/setup/step") {
      const step = JSON.parse(body || "{}").step;
      state = { ...state, setup: { ...state.setup!, step: step === "done" ? null : step } };
      return json({ ok: true, setup: state.setup });
    }
    if (url === "/api/integrations/secrets-key/generated") return json({ ok: true });
    if (url === "/api/integrations/xero/pending-credentials" && method === "PUT") {
      const sent = JSON.parse(body || "{}");
      state = { ...state, setup: { ...state.setup!, step: "key", pending: { keyId: sent.keyId, fields: ["client_id", "client_secret"], storedAt: "2026-10-13T00:00:00.000Z", storedBy: "Owner Person" } } };
      return json({ ok: true, setup: state.setup });
    }
    if (url === "/api/integrations/xero/pending-credentials" && method === "DELETE") {
      state = { ...state, setup: { ...state.setup!, step: "app", pending: null, problem: null } };
      return json({ ok: true, setup: state.setup });
    }
    if (url === "/api/integrations/xero/credentials" && method === "PUT") {
      state = { ...state, credentials: { ...state.credentials, source: "settings", problem: null } };
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  });
  return { calls, fetchMock, set: (next: XeroIntegration) => { state = next; } };
}

function show() {
  return render(<MemoryRouter initialEntries={["/settings?section=integrations"]}><XeroPanel /></MemoryRouter>);
}

let clipboard: string[];
let consoleLines: string[];

beforeEach(() => {
  clipboard = [];
  consoleLines = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (text: string) => { clipboard.push(text); }) } });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Connect Xero wizard", () => {
  it("without a key: the browser makes it, encrypts the credentials with it, and never sends or keeps it", async () => {
    const server = fakeServer(integration());
    vi.stubGlobal("fetch", server.fetchMock);
    show();

    // Step 1: every value to type into Xero, from publicUrl.
    const one = await screen.findByRole("region", { name: "1. Create your Xero app" });
    expect(within(one).getByText(REDIRECT)).toBeTruthy();
    expect(within(one).getByText(PUBLIC_URL)).toBeTruthy();
    expect(within(one).getByText("Web app")).toBeTruthy();
    fireEvent.click(within(one).getAllByRole("button", { name: /Copy/ })[2]);
    await waitFor(() => expect(clipboard).toContain(REDIRECT));
    fireEvent.click(within(one).getByRole("button", { name: "Next" }));

    // Step 2: the client id and secret, with format checks that do not block.
    const two = await screen.findByRole("region", { name: "2. Paste what Xero gave you" });
    fireEvent.change(within(two).getByLabelText(/Client id/), { target: { value: "SHORT-ID-0001" } });
    expect(within(two).getByText(/usually 32 letters and numbers/)).toBeTruthy();
    fireEvent.change(within(two).getByLabelText(/Client id/), { target: { value: "has a space" } });
    expect(within(two).getByText(/with no spaces/)).toBeTruthy();
    expect((within(two).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(two).getByLabelText(/Client id/), { target: { value: CLIENT_ID } });
    fireEvent.change(within(two).getByLabelText(/Client secret/), { target: { value: CLIENT_SECRET } });
    expect(within(two).queryByText(/usually/)).toBeNull();
    fireEvent.click(within(two).getByRole("button", { name: "Next" }));

    // Step 3: generate the key in this browser.
    const three = await screen.findByRole("region", { name: "3. Your encryption key" });
    fireEvent.click(within(three).getByRole("button", { name: /Generate key/ }));
    const field = await within(three).findByLabelText(/Your key/) as HTMLInputElement;
    const key = field.value;
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(key).toHaveLength(44);
    expect(Uint8Array.from(atob(key), (char) => char.charCodeAt(0))).toHaveLength(32);
    expect(field.readOnly).toBe(true);
    expect(document.documentElement.hasAttribute(SECRET_ON_SCREEN)).toBe(true);

    // Sentry replay blocks the whole key panel.
    const block = field.closest(".sentry-block") as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.hasAttribute("data-sentry-block")).toBe(true);
    const copyKey = within(block).getByRole("button", { name: /Copy/ });
    expect(block.contains(copyKey)).toBe(true);
    // No attribute but the input's own value holds the key: no aria-label, title or name.
    for (const element of Array.from(document.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        if (element === field && attribute.name === "value") continue;
        expect(attribute.value.includes(key), `${element.tagName} ${attribute.name}`).toBe(false);
      }
    }
    // A Sentry click breadcrumb for Copy names the element, never the key.
    fireEvent.click(copyKey);
    await waitFor(() => expect(clipboard).toContain(key));
    const crumb = { category: "ui.click", message: htmlTreeAsString(copyKey) };
    expect(crumb.message).not.toContain(key);
    expect(JSON.stringify(scrubBreadcrumb(crumb))).not.toContain(key);
    expect(JSON.stringify(scrubBreadcrumb({ category: "ui.click", message: htmlTreeAsString(field) }))).not.toContain(key);

    // Where does this go? Collapsed until opened; the setup prompt never holds the key.
    const where = within(three).getByText("Where does this go?").closest("details") as HTMLDetailsElement;
    expect(where.open).toBe(false);
    fireEvent.click(within(three).getByText("Where does this go?"));
    fireEvent.click(within(three).getByRole("button", { name: /Replit/ }));
    expect(within(three).getByText(/Production app secrets/, { selector: "li" })).toBeTruthy();
    fireEvent.click(within(three).getByRole("button", { name: /Copy setup prompt/ }));
    await waitFor(() => expect(clipboard.at(-1)).toMatch(/production deployment secret named FIELD_SECRETS_KEY/));
    fireEvent.click(within(three).getByRole("button", { name: /Other host/ }));
    expect(within(three).getByText(/wherever your Field server keeps its secrets, then restart Field/)).toBeTruthy();
    fireEvent.click(within(three).getByRole("button", { name: /Copy setup prompt/ }));
    await waitFor(() => expect(clipboard.at(-1)).toMatch(/environment variable named FIELD_SECRETS_KEY/));
    const prompts = clipboard.filter((text) => /FIELD_SECRETS_KEY/.test(text) && text.length > 40);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).not.toContain(key);
      expect(prompt).not.toMatch(/[A-Za-z0-9+/]{40}/);
    }

    // Done: the credentials go encrypted, the key stays here and is forgotten.
    const done = within(three).getByRole("button", { name: "Done" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(within(three).getByRole("checkbox"));
    fireEvent.click(done);
    await waitFor(() => expect(screen.getByText(/Waiting for the key/)).toBeTruthy());
    // Copy left the key on the clipboard; Done replaces it with nothing.
    await waitFor(() => expect(clipboard.at(-1)).toBe(""));
    const pending = server.calls.find((call) => call.url === "/api/integrations/xero/pending-credentials" && call.method === "PUT");
    const sent = JSON.parse(pending!.body!);
    expect(Object.keys(sent).sort()).toEqual(["clientId", "clientSecret", "keyId"]);
    expect(sent.clientId).toMatch(SEALED_VALUE);
    expect(sent.clientSecret).toMatch(SEALED_VALUE);
    expect(sent.clientId.split(".")[1]).toBe(sent.keyId);
    const generated = server.calls.find((call) => call.url === "/api/integrations/secrets-key/generated");
    expect(generated?.body ?? null).toBeNull();
    for (const call of server.calls) {
      expect(call.url).not.toContain(key);
      expect(call.body || "").not.toContain(key);
      expect(call.body || "").not.toContain(CLIENT_SECRET);
    }
    expect(document.body.innerHTML).not.toContain(key);
    expect(document.documentElement.hasAttribute(SECRET_ON_SCREEN)).toBe(false);
    expect(consoleLines.join("\n")).not.toContain(key);
    expect(JSON.stringify({ ...localStorage })).not.toContain(key);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(key);
    expect(window.location.href).not.toContain(key);
  });

  it("resumes at step 4 once the key is deployed and the pending credentials are stored", async () => {
    const server = fakeServer(integration({
      secretsKey: { configured: true, problem: null, keyId: "abc123def456", previousKeys: 0 },
      credentials: { ...integration().credentials, source: "settings", problem: null, settings: { clientId: { set: true, setAt: "2026-10-13T00:00:00.000Z", setBy: "Owner Person" }, clientSecret: { set: true, setAt: "2026-10-13T00:00:00.000Z", setBy: "Owner Person" } } },
      setup: { orgUid: ORG_UID, step: "connect", pending: null, problem: null },
    }));
    vi.stubGlobal("fetch", server.fetchMock);
    show();
    const four = await screen.findByRole("region", { name: "4. Connect" });
    expect((within(four).getByRole("button", { name: /Connect to Xero/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Your encryption key").closest("li")?.getAttribute("data-state")).toBe("skipped");
  });

  it("when Replit holds another key, says so plainly and starts again", async () => {
    const server = fakeServer(integration({
      secretsKey: { configured: true, problem: null, keyId: "abc123def456", previousKeys: 0 },
      setup: { orgUid: ORG_UID, step: "key", pending: { keyId: "0123456789ab", fields: ["client_id", "client_secret"], storedAt: null, storedBy: null }, problem: "PENDING_KEY_MISMATCH" },
    }));
    vi.stubGlobal("fetch", server.fetchMock);
    show();
    const alert = await screen.findByText("The key in Replit is not the one generated here; generate again or paste the right key.");
    expect(alert).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start again/ }));
    await waitFor(() => expect(server.calls.some((call) => call.url === "/api/integrations/xero/pending-credentials" && call.method === "DELETE")).toBe(true));
    expect(await screen.findByRole("region", { name: "2. Paste what Xero gave you" })).toBeTruthy();
  });

  it("with the key already set, skips step 3: the server encrypts the credentials", async () => {
    const server = fakeServer(integration({ secretsKey: { configured: true, problem: null, keyId: "abc123def456", previousKeys: 0 }, setup: { orgUid: ORG_UID, step: "app", pending: null, problem: null } }));
    vi.stubGlobal("fetch", server.fetchMock);
    show();
    const two = await screen.findByRole("region", { name: "2. Paste what Xero gave you" });
    fireEvent.change(within(two).getByLabelText(/Client id/), { target: { value: CLIENT_ID } });
    fireEvent.change(within(two).getByLabelText(/Client secret/), { target: { value: CLIENT_SECRET } });
    fireEvent.click(within(two).getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("region", { name: "4. Connect" })).toBeTruthy();
    expect(server.calls.some((call) => call.url === "/api/integrations/xero/credentials" && call.method === "PUT")).toBe(true);
    expect(server.calls.some((call) => call.url.includes("pending-credentials") || call.url.includes("secrets-key"))).toBe(false);
  });

  it("someone who is not an owner sees the status only, and no wizard or key", async () => {
    const server = fakeServer(integration({ canManage: false, setup: null }));
    vi.stubGlobal("fetch", server.fetchMock);
    show();
    expect(await screen.findByText("Not connected")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/FIELD_SECRETS_KEY|encryption key/i);
    expect(screen.queryByRole("button", { name: /Connect Xero|Generate key/ })).toBeNull();
  });

  it("a wrong FIELD_SECRETS_KEY_PREVIOUS: says to fix it, and offers no new key", async () => {
    const server = fakeServer(integration({
      secretsKey: { configured: false, problem: "SECRETS_KEY_PREVIOUS_INVALID", keyId: null, previousKeys: 0 },
      setup: { orgUid: ORG_UID, step: "credentials", pending: null, problem: null },
      credentials: { ...integration().credentials, source: null, problem: "SECRETS_KEY_PREVIOUS_INVALID", environmentOverride: true },
    }));
    vi.stubGlobal("fetch", server.fetchMock);
    show();
    const three = await screen.findByRole("region", { name: "3. Your encryption key" });
    expect(within(three).getByText("Your previous key setting is wrong: fix FIELD_SECRETS_KEY_PREVIOUS.")).toBeTruthy();
    expect(within(three).queryByRole("button", { name: /Generate key/ })).toBeNull();
  });

  it("an unusable FIELD_SECRETS_KEY: says so, and the key made here replaces it", async () => {
    const server = fakeServer(integration({
      secretsKey: { configured: false, problem: "SECRETS_KEY_INVALID", keyId: null, previousKeys: 0 },
      setup: { orgUid: ORG_UID, step: "app", pending: null, problem: null },
      credentials: { ...integration().credentials, environmentOverride: true },
    }));
    vi.stubGlobal("fetch", server.fetchMock);
    show();
    const three = await screen.findByRole("region", { name: "3. Your encryption key" });
    expect(within(three).getByText(/cannot be used: it is too short to be a key/)).toBeTruthy();
    expect(within(three).getByRole("button", { name: /Generate key/ })).toBeTruthy();
  });

  it("resumes where the server says", () => {
    const key = { configured: true, problem: null, keyId: "abc123def456", previousKeys: 0 };
    const set = { ...integration().credentials, source: "settings" as const, problem: null };
    expect(resumeStep(integration())).toBe(1);
    expect(resumeStep(integration({ setup: { orgUid: ORG_UID, step: "app", pending: null, problem: null } }))).toBe(2);
    expect(resumeStep(integration({ setup: { orgUid: ORG_UID, step: "key", pending: { keyId: "0123456789ab", fields: [], storedAt: null, storedBy: null }, problem: null } }))).toBe(3);
    expect(resumeStep(integration({ secretsKey: key, credentials: set }))).toBe(4);
    const override = { ...integration().credentials, source: "environment" as const, environmentOverride: true };
    expect(resumeStep(integration({ secretsKey: key, credentials: override, setup: { orgUid: ORG_UID, step: "app", pending: null, problem: null } }))).toBe(4);
    expect(resumeStep(integration({ credentials: override, setup: { orgUid: ORG_UID, step: "app", pending: null, problem: null } }))).toBe(3);
  });
});

describe("Where the key goes", () => {
  it("every host in the list renders its steps and a prompt without the key", async () => {
    for (const host of SECRET_HOSTS) {
      const copied: string[] = [];
      const { unmount } = render(<HostChoices onCopy={(text) => { copied.push(text); }} />);
      fireEvent.click(screen.getByText("Where does this go?"));
      fireEvent.click(screen.getByRole("button", { name: host.label }));
      expect(screen.getByRole("button", { name: host.label }).getAttribute("aria-pressed")).toBe("true");
      const steps = document.querySelector(`[data-host="${host.id}"]`) as HTMLElement;
      expect(steps).toBeTruthy();
      expect(steps.textContent).toContain("FIELD_SECRETS_KEY");
      fireEvent.click(within(steps).getByRole("button", { name: /Copy setup prompt/ }));
      expect(copied.at(-1)).toBe(host.prompt);
      expect(host.prompt).toContain("FIELD_SECRETS_KEY");
      expect(host.prompt).not.toMatch(/[A-Za-z0-9+/]{40}/);
      unmount();
    }
  });
});
