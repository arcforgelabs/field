import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "@/components/shell/shell-context";
import { RecipientField, recipientProblem, suggestRecipients, type ContactSuggestion, type Recipient } from "./recipient-field";

const api = vi.hoisted(() => ({
  recording: vi.fn(),
  googleContacts: vi.fn(),
  jobDocuments: vi.fn(),
  scheduledEmails: vi.fn(),
  emailContext: vi.fn(),
  emailPreview: vi.fn(),
  emailJob: vi.fn(),
  emailQuote: vi.fn(),
  unscheduleEmail: vi.fn(),
  gmailAuthUrl: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const { EmailComposerPage, composeTemplateBody } = await import("./email-composer-page");

const CONTEXT = {
  ok: true,
  jobId: "job-1",
  documentType: null,
  milestoneIndex: null,
  from: { name: "Jess Harlow", email: "jess@harlow.example.invalid" },
  defaultSubject: "Job update — 14 Copperleaf Rise",
  templates: [
    { id: "standard", name: "Standard email", description: "", subject: "{{defaultSubject}}", html: "<p>{{greeting}}</p><p>An update{{jobTitleFor}}.</p>" },
    { id: "follow-up", name: "Follow-up", description: "", subject: "Following up - {{jobTitle}}", html: "<p>{{greeting}}</p><p>Following up.</p>" },
  ],
  mergeValues: { clientName: "Dana Whitfield", jobTitle: "14 Copperleaf Rise", senderName: "Jess Harlow", businessName: "Harlow Earthworks", defaultSubject: "Job update — 14 Copperleaf Rise" },
  mergeFields: [{ key: "clientName", label: "Customer name", value: "Dana Whitfield" }],
  signature: { html: "<p>Regards,<br/>{{senderName}}<br/>{{businessName}}</p>", isDefault: true },
  jobContacts: [{ email: "dana@whitfield.example.invalid", name: "Dana Whitfield", source: "job" }],
  deliveryPolicy: { mode: "live" },
};

function renderComposer(toast = vi.fn()) {
  return render(
    <ShellContext.Provider value={{ newQuote: () => {}, toast }}>
      <MemoryRouter initialEntries={["/jobs/job-1/email-editor"]}>
        <Routes>
          <Route path="/jobs/:id/email-editor" element={<EmailComposerPage />} />
          <Route path="/jobs/:id" element={<div>Job page</div>} />
        </Routes>
      </MemoryRouter>
    </ShellContext.Provider>,
  );
}

beforeEach(() => {
  api.recording.mockResolvedValue({ meta: { id: "job-1", title: "14 Copperleaf Rise", siteAddress: "14 Copperleaf Rise", contactEmail: "dana@whitfield.example.invalid", contactName: "Dana Whitfield", milestoneInvoices: [] }, quote: null });
  api.googleContacts.mockResolvedValue({ contacts: [{ name: "Accounts", email: "accounts@whitfield.example.invalid" }] });
  api.jobDocuments.mockResolvedValue({ ok: true, jobId: "job-1", documents: [], notIssued: [] });
  api.scheduledEmails.mockResolvedValue({ ok: true, scheduledEmails: [] });
  api.emailContext.mockResolvedValue(CONTEXT);
  api.emailPreview.mockResolvedValue({ ok: true, subject: "Job update — 14 Copperleaf Rise", html: "<p>Hi</p>", text: "Hi", from: CONTEXT.from, to: [], cc: [], bcc: [], attachments: [], pending: [] });
  api.emailJob.mockResolvedValue({ ok: true });
});
afterEach(() => vi.clearAllMocks());

describe("recipients", () => {
  function Harness({ initial = [] as Recipient[], contacts = [] as ContactSuggestion[] }) {
    const [recipients, setRecipients] = useState<Recipient[]>(initial);
    return <RecipientField label="To" recipients={recipients} onChange={setRecipients} contacts={contacts} />;
  }

  it("keeps an incomplete address as a red chip with the reason, and clicking it puts it back to fix", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, { target: { value: "accounts@whitfieldbuild" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const chip = screen.getByRole("button", { name: "accounts@whitfieldbuild" });
    expect(chip.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("accounts@whitfieldbuild is not a complete address. Fix it or remove it before sending.");
    expect(document.getElementById(chip.getAttribute("aria-describedby") || "")).toBeTruthy();
    fireEvent.click(chip);
    expect((input as HTMLInputElement).value).toBe("accounts@whitfieldbuild");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("makes one chip per pasted address, merges duplicates and removes the last with Backspace", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.paste(input, { clipboardData: { getData: () => "Dana Whitfield <dana@whitfield.example.invalid>, accounts@whitfield.example.invalid; dana@whitfield.example.invalid" } });
    expect(screen.getByRole("button", { name: "Remove Dana Whitfield" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
  });

  it("suggests the job's people before Google Contacts", () => {
    const contacts: ContactSuggestion[] = [
      { email: "accounts@whitfield.example.invalid", name: "Accounts", source: "google" },
      { email: "dana@whitfield.example.invalid", name: "Dana Whitfield", source: "job" },
      { email: "site@whitfield.example.invalid", name: "Site office", source: "sent" },
    ];
    expect(suggestRecipients(contacts, "", []).map((entry) => entry.source)).toEqual(["job", "sent", "google"]);
    expect(suggestRecipients(contacts, "", ["dana@whitfield.example.invalid"]).map((entry) => entry.name)).toEqual(["Site office", "Accounts"]);
    render(<Harness contacts={contacts} />);
    fireEvent.focus(screen.getByRole("combobox", { name: "To" }));
    const options = within(screen.getByRole("listbox", { name: "To suggestions" })).getAllByRole("option");
    expect(options[0].textContent).toContain("this job's contact");
  });

  it("checks the installation's recipient policy on the chip", () => {
    expect(recipientProblem("dana@whitfield.example.invalid", { mode: "allowlist", allowedRecipients: ["test@example.invalid"] })).toMatch(/only sends to test@example\.invalid/);
    expect(recipientProblem("dana@whitfield.example.invalid", { mode: "live" })).toBeNull();
  });
});

describe("composer", () => {
  it("fills the template and signature from the server's values, the merge fields marked", () => {
    const html = composeTemplateBody(CONTEXT.templates[0], CONTEXT);
    expect(html).toContain('<span data-merge="clientName">Dana Whitfield</span>');
    expect(html).toContain('Regards,<br/><span data-merge="senderName">Jess Harlow</span><br/><span data-merge="businessName">Harlow Earthworks</span>');
    // A template that signs off itself is not signed twice.
    expect(composeTemplateBody({ html: "<p>Hi</p><p>Regards,<br/>Jess</p>" }, CONTEXT)).toBe("<p>Hi</p><p>Regards,<br/>Jess</p>");
  });

  it("sends with the keyboard alone: chips, then Ctrl Enter", async () => {
    const toast = vi.fn();
    renderComposer(toast);
    await screen.findByRole("heading", { name: "Send email" });
    // The job's contact is already in To; add Accounts by keyboard.
    expect(screen.getByRole("button", { name: "Remove Dana Whitfield" })).toBeTruthy();
    const to = screen.getByRole("combobox", { name: "To" });
    to.focus();
    fireEvent.change(to, { target: { value: "accounts@whitfield.example.invalid" } });
    fireEvent.keyDown(to, { key: "Enter" });
    // Ctrl Shift C opens Cc.
    fireEvent.keyDown(to, { key: "C", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Cc" })).toBeTruthy());
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Job update — 14 Copperleaf Rise");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Cc" }), { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(api.emailJob).toHaveBeenCalledTimes(1));
    const [jobId, recipients, subject, body] = api.emailJob.mock.calls[0];
    expect(jobId).toBe("job-1");
    expect(recipients).toEqual(["dana@whitfield.example.invalid", "accounts@whitfield.example.invalid"]);
    expect(subject).toBe("Job update — 14 Copperleaf Rise");
    expect(body).toContain('data-merge="clientName"');
    await waitFor(() => expect(screen.getByText("Job page")).toBeTruthy());
    expect(toast).toHaveBeenCalledWith("Email sent to Dana Whitfield, Accounts");
  });

  it("will not send with an incomplete address, and says why", async () => {
    renderComposer();
    await screen.findByRole("heading", { name: "Send email" });
    const to = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(to, { target: { value: "accounts@whitfieldbuild" } });
    fireEvent.keyDown(to, { key: "Enter" });
    for (const send of screen.getAllByRole("button", { name: "Send" })) expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Fix 1 address")).toBeTruthy();
    fireEvent.keyDown(to, { key: "Enter", ctrlKey: true });
    expect(api.emailJob).not.toHaveBeenCalled();
  });

  it("shows the server's preview, and has no automated accessibility violations", async () => {
    const { container } = renderComposer();
    await screen.findByRole("heading", { name: "Send email" });
    await waitFor(() => expect(api.emailPreview).toHaveBeenCalled(), { timeout: 2000 });
    expect(await screen.findByTitle("Email preview")).toBeTruthy();
    const results = await axe.run(container, {
      // The preview is a sandboxed frame of the customer's email.
      iframes: false,
      // jsdom has no layout: contrast is checked in the browser runs instead.
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});
