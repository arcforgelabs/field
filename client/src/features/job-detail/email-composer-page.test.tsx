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
  sentEmails: vi.fn(),
  saveEmailDraft: vi.fn(),
  discardEmailDraft: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const { EmailComposerPage, SubjectField, composeTemplateBody, plainSendError, undoWindowMs } = await import("./email-composer-page");
const { EmailRows, SentEmailSheet, emailRows } = await import("./email-record");

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
  api.sentEmails.mockResolvedValue({ ok: true, sentEmails: [] });
  api.saveEmailDraft.mockImplementation(async (_id: string, draft: { subject: string }) => ({ ok: true, scheduledEmail: { id: "draft-1", status: "draft", subject: draft.subject, to: [], cc: [], bcc: [], attachmentNames: [], attachments: [], documentType: "email" } }));
  api.unscheduleEmail.mockResolvedValue({ ok: true, scheduledEmail: { id: "q1", status: "draft" } });
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

describe("undo, drafts and the sent record", () => {
  it("holds a send for ten seconds with Undo, and Undo cancels it", async () => {
    api.emailJob.mockResolvedValue({ ok: true, scheduled: true, held: true, scheduledEmail: { id: "q1", status: "pending", held: true } });
    const toast = vi.fn();
    renderComposer(toast);
    await screen.findByRole("heading", { name: "Send email" });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "To" }), { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [message, undo, options] = toast.mock.calls[0];
    expect(message).toBe("Sending email to Dana Whitfield…");
    // Until the hold ends: at most 10 seconds, counted from the request.
    expect(options.durationMs).toBeLessThanOrEqual(10_000);
    expect(options.durationMs).toBeGreaterThan(9_000);
    await act(async () => { undo(); });
    expect(api.unscheduleEmail).toHaveBeenCalledWith("job-1", "q1");
  });

  it("saves the email as a draft on the server as the operator writes", async () => {
    renderComposer();
    await screen.findByRole("heading", { name: "Send email" });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Gate code for Monday" } });
    await waitFor(() => expect(api.saveEmailDraft).toHaveBeenCalled(), { timeout: 4000 });
    const [jobId, draft] = api.saveEmailDraft.mock.calls.at(-1) ?? [];
    expect(jobId).toBe("job-1");
    expect(draft.subject).toBe("Gate code for Monday");
    expect(draft.to).toEqual(["dana@whitfield.example.invalid"]);
    expect(await screen.findByText(/^Draft saved /)).toBeTruthy();
  });

  it("sends a test to the signed-in person from the send menu", async () => {
    api.emailJob.mockResolvedValue({ ok: true, test: true, result: { to: ["jess@harlow.example.invalid"] } });
    const toast = vi.fn();
    renderComposer(toast);
    await screen.findByRole("heading", { name: "Send email" });
    fireEvent.click(screen.getAllByRole("button", { name: "Schedule send" })[0]);
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: /Send a test to me/ }));
    });
    await waitFor(() => expect(api.emailJob).toHaveBeenCalled());
    expect(api.emailJob.mock.calls[0][4].test).toBe(true);
    expect(toast).toHaveBeenCalledWith("Test sent to jess@harlow.example.invalid. Nothing was issued or recorded.");
  });

  it("says why a send failed in words an operator can act on", () => {
    const failure = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);
    expect(plainSendError(failure("a previous quote delivery has an unknown outcome", { code: "DELIVERY_OUTCOME_UNKNOWN", status: 409 }))).toMatch(/lost contact with Gmail/);
    expect(plainSendError(failure("the attachments add up to 19.0 MB", { status: 413 }))).toBe("the attachments add up to 19.0 MB");
    // A time-out, a reset or a 5xx may have sent it: not confirmed, never "not sent".
    expect(plainSendError(failure("socket hang up", { status: 500, deliveryOutcome: "unknown" }))).toMatch(/^Not confirmed: .*Check Sent Mail/);
    expect(plainSendError(failure("sendJobEmail exceeded the 45000ms send ceiling", { status: 500 }))).toMatch(/^Not confirmed/);
    expect(plainSendError(failure("Invalid To header", { status: 502, deliveryOutcome: "rejected" }))).toBe("Gmail did not accept the email: Invalid To header");
  });

  it("labels a failed email Not sent only when it was rejected before Gmail took it", () => {
    const base = { jobId: "job-1", to: ["dana@whitfield.example.invalid"], cc: [], bcc: [], attachmentNames: [], updatedAt: "2026-10-13T00:13:00.000Z", createdAt: "2026-10-13T00:13:00.000Z" };
    const rows = emailRows([{ id: "sent_r", ts: "2026-10-13T00:20:00.000Z", kind: "email.sent", documentType: "email", messageId: "m", from: null, fromName: null, to: [], cc: [], bcc: [], subject: "Found again", attachments: [], reconciled: true } as never], [
      { ...base, id: "t", status: "failed", subject: "Timed out", lastError: "sendJobEmail exceeded the 45000ms send ceiling", deliveryOutcome: "unknown", resend: "checks-sent-mail", deliveryMailbox: "alice@harlow.example.invalid", resendAfter: new Date(Date.now() + 4 * 60_000).toISOString() } as never,
      { ...base, id: "r", status: "failed", subject: "Rejected", lastError: "Invalid To header", deliveryOutcome: "rejected", resend: "allowed" } as never,
      { ...base, id: "o", status: "failed", subject: "Older", lastError: "socket hang up", deliveryOutcome: "unknown", resend: "blocked" } as never,
    ]);
    const onEdit = vi.fn();
    render(<EmailRows rows={rows} onOpen={() => {}} onEdit={onEdit} />);
    const item = (subject: string) => screen.getByText(subject).closest("li") as HTMLElement;
    expect(within(item("Timed out")).getByText("Not confirmed")).toBeTruthy();
    expect(within(item("Timed out")).getByText(/Check the Sent Mail of alice@harlow\.example\.invalid\. If you send it again after .+, Field looks for it there first and does not send it twice/)).toBeTruthy();
    expect(within(item("Found again")).getByText(/found in Sent Mail; later edits were not sent/)).toBeTruthy();
    expect(within(item("Timed out")).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(item("Rejected")).getByText("Not sent")).toBeTruthy();
    expect(within(item("Rejected")).getByText("Gmail did not accept it: Invalid To header")).toBeTruthy();
    expect(within(item("Older")).getByText("Not confirmed")).toBeTruthy();
    expect(within(item("Older")).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("counts Undo down from the server's hold, not from the response", () => {
    const requestedAt = Date.parse("2026-10-13T00:00:00.000Z");
    // The response came 3 seconds after the request: 7 seconds are left.
    expect(undoWindowMs("2026-10-13T00:00:10.000Z", requestedAt, requestedAt + 3_000)).toBe(7_000);
    // A server clock behind: never longer than the hold since the request.
    expect(undoWindowMs("2026-10-13T00:00:20.000Z", requestedAt, requestedAt + 1_000)).toBe(9_000);
    // Already over.
    expect(undoWindowMs("2026-10-13T00:00:05.000Z", requestedAt, requestedAt + 6_000)).toBe(0);
  });

  it("a send during an autosave uses the draft the autosave made, and leaves no second draft", async () => {
    let finishSave: () => void = () => {};
    api.saveEmailDraft.mockImplementation((_id: string, draft: { subject: string; draftId: string | null }) => new Promise((resolve) => {
      finishSave = () => resolve({ ok: true, scheduledEmail: { id: "draft-1", status: "draft", subject: draft.subject, to: [], cc: [], bcc: [], attachmentNames: [], attachments: [], documentType: "email" } });
    }));
    api.emailJob.mockResolvedValue({ ok: true, scheduled: true, held: true, scheduledEmail: { id: "draft-1", status: "pending", held: true, scheduledAt: new Date(Date.now() + 10_000).toISOString() } });
    renderComposer();
    await screen.findByRole("heading", { name: "Send email" });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Gate code for Monday" } });
    await waitFor(() => expect(api.saveEmailDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(api.saveEmailDraft.mock.calls[0][1].draftId).toBeNull();
    // Send while the autosave is still in flight.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "To" }), { key: "Enter", ctrlKey: true });
    });
    await act(async () => { finishSave(); });
    await waitFor(() => expect(api.emailJob).toHaveBeenCalledTimes(1));
    expect(api.emailJob.mock.calls[0][4].draftId).toBe("draft-1");
    expect(api.saveEmailDraft).toHaveBeenCalledTimes(1);
  });

  it("opens a sent email exactly as it went out, Bcc included", () => {
    const record = {
      id: "sent-1", ts: "2026-10-13T00:12:00.000Z", kind: "invoice.sent", documentType: "invoice", messageId: "m1",
      from: "jess@harlow.example.invalid", fromName: "Jess Harlow", to: ["dana@whitfield.example.invalid"], cc: [], bcc: ["accounts@harlow.example.invalid"],
      subject: "Invoice INV-2026-10-2", bodyText: "Hi", htmlBody: "<p>Hi Dana</p>",
      attachments: [{ filename: "INV-2026-10-2.pdf" }, { filename: "site-photo.jpg", source: "upload" as const, byteLength: 2048, sha256: "a".repeat(64) }],
      mainDocument: { documentType: "invoice", number: "INV-2026-10-2" },
    };
    render(<SentEmailSheet record={record} documents={[{ uid: "doc_01JB8Z00000000000000000002", documentType: "invoice", number: "INV-2026-10-2" } as never]} onClose={() => {}} />);
    expect(screen.getByText("accounts@harlow.example.invalid")).toBeTruthy();
    expect(screen.getByRole("link", { name: "INV-2026-10-2.pdf" }).getAttribute("href")).toBe("/api/documents/doc_01JB8Z00000000000000000002/pdf");
    expect(screen.getByText(/Upload · 2 KB · SHA-256 aaaaaaaaaaaa/)).toBeTruthy();
    expect(screen.getByTitle("The email as sent").getAttribute("sandbox")).toBe("");
    const rows = emailRows([record], [{ id: "q", status: "pending", held: true, to: [], cc: [], bcc: [], attachmentNames: [], updatedAt: "2026-10-13T00:13:00.000Z", createdAt: "2026-10-13T00:13:00.000Z" } as never]);
    expect(rows.map((row) => row.kind)).toEqual(["queued", "sent"]);
  });
});

describe("replacement invoices and threading", () => {
  const QUOTE = { uid: "doc_01JB8Z0000000000000000000Q", documentType: "quote", number: "EQ-2609-14 v2", quoteVersion: 2, revision: null, issuedAt: "2026-09-18T06:40:00.000Z", pdfSha256: "a".repeat(64), pdfUrl: "", byteLength: 212 * 1024, status: "accepted", emailed: [] };
  const NOTE = { ...QUOTE, uid: "doc_01JB8Z0000000000000000000C", documentType: "credit_note", number: "CN-2026-10-1", quoteVersion: null, status: "issued", byteLength: 94 * 1024 };
  const NEW_INVOICE = { ...QUOTE, uid: "doc_01JB8Z0000000000000000000I", documentType: "invoice", number: "INV-2026-10-2", quoteVersion: null, status: "issued", byteLength: 187 * 1024 };
  const REPLACEMENT_CONTEXT = {
    ...CONTEXT,
    documentType: "invoice",
    milestoneIndex: 0,
    defaultSubject: "Invoice — INV-2026-10-2 — Progress claim",
    templates: [{ id: "replacement", name: "Replacement invoice", description: "", subject: "Replacement invoice {{documentNumber}} · {{jobTitle}}", html: "<p>{{greeting}}</p><p>{{documentNumber}} replaces {{replacesNumber}}.</p>" }],
    mergeValues: { ...CONTEXT.mergeValues, documentNumber: "INV-2026-10-2", replacesNumber: "INV-2026-10-1", creditNoteNumber: "CN-2026-10-1" },
    sendType: "replacement-invoice",
    suggestions: [
      { uid: NOTE.uid, number: NOTE.number, documentType: "credit_note", ticked: true, reason: "Adjustment note · cancels the invoice this one replaces" },
      { uid: QUOTE.uid, number: QUOTE.number, documentType: "quote", ticked: false, reason: "The accepted quote · suggested" },
    ],
    replacement: { creditNoteNumber: "CN-2026-10-1", creditNoteUid: NOTE.uid, replacesNumber: "INV-2026-10-1", replacesTotal: 8250, total: 7920 },
    thread: { id: "sent_1", subject: "Invoice INV-2026-10-1 · 14 Copperleaf Rise", sentAt: "2026-10-02T05:42:00.000Z", to: [], threadId: "t-1", headers: true, replySubject: "Re: Invoice INV-2026-10-1 · 14 Copperleaf Rise" },
  };

  function renderReplacement(toast = vi.fn()) {
    api.recording.mockResolvedValue({ meta: { id: "job-1", title: "14 Copperleaf Rise", contactEmail: "dana@whitfield.example.invalid", contactName: "Dana Whitfield", milestoneInvoices: [{ milestoneIndex: 0, milestoneLabel: "Progress claim", status: "authorised", invoiceNumber: "INV-2026-10-2", amountPaid: 0, issuedRevision: { invoiceNumber: "INV-2026-10-2", creditNoteNumber: "CN-2026-10-1" } }] }, quote: null });
    api.jobDocuments.mockResolvedValue({ ok: true, jobId: "job-1", documents: [QUOTE, NOTE, NEW_INVOICE], notIssued: [] });
    api.emailContext.mockResolvedValue(REPLACEMENT_CONTEXT);
    api.emailQuote.mockResolvedValue({ ok: true });
    return render(
      <ShellContext.Provider value={{ newQuote: () => {}, toast }}>
        <MemoryRouter initialEntries={["/jobs/job-1/email-editor?documentType=invoice&milestoneIndex=0"]}>
          <Routes>
            <Route path="/jobs/:id/email-editor" element={<EmailComposerPage />} />
            <Route path="/jobs/:id" element={<div>Job page</div>} />
          </Routes>
        </MemoryRouter>
      </ShellContext.Provider>,
    );
  }

  it("ticks the adjustment note, offers the accepted quote, and goes into the replaced invoice's conversation", async () => {
    renderReplacement();
    await screen.findByText(/INV-2026-10-2 \(\$7,920.00\) replaces INV-2026-10-1 \(\$8,250.00\), which adjustment note CN-2026-10-1 credits in full/);
    const tray = screen.getByRole("region", { name: "Attachments" });
    expect(within(tray).getByText("CN-2026-10-1.pdf")).toBeTruthy();
    expect(within(tray).getByText("2 of 3 ticked")).toBeTruthy();
    const offered = within(tray).getByRole("checkbox", { name: "Attach EQ-2609-14 v2" }) as HTMLInputElement;
    expect(offered.checked).toBe(false);
    expect(screen.queryByText(/Also attach the adjustment note/)).toBeNull();
    const toggle = screen.getByRole("checkbox", { name: /Send in the conversation of/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Re: Invoice INV-2026-10-1 · 14 Copperleaf Rise");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "To" }), { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(api.emailQuote).toHaveBeenCalled());
    const options = api.emailQuote.mock.calls[0][3];
    expect(options.documents).toEqual([{ uid: NOTE.uid }]);
    expect(options.inReplyTo).toBe("sent_1");
    expect(options.subject).toBe("Re: Invoice INV-2026-10-1 · 14 Copperleaf Rise");
  });

  it("unticking the adjustment note leaves it out; turning the conversation off restores the subject", async () => {
    renderReplacement();
    const tray = await screen.findByRole("region", { name: "Attachments" });
    await within(tray).findByText("CN-2026-10-1.pdf");
    fireEvent.click(within(tray).getByRole("button", { name: "Remove CN-2026-10-1" }));
    expect((within(tray).getByRole("checkbox", { name: "Attach CN-2026-10-1" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /Send in the conversation of/ }));
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Replacement invoice INV-2026-10-2 · 14 Copperleaf Rise");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "To" }), { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(api.emailQuote).toHaveBeenCalled());
    const options = api.emailQuote.mock.calls[0][3];
    expect(options.documents).toEqual([]);
    expect(options.inReplyTo).toBeNull();
  });

  it("previews an adjustment note on its own with the note's number", async () => {
    api.emailContext.mockResolvedValue({ ...CONTEXT, mergeValues: { ...CONTEXT.mergeValues, creditNoteNumber: "CN-2026-10-1" } });
    render(
      <ShellContext.Provider value={{ newQuote: () => {}, toast: vi.fn() }}>
        <MemoryRouter initialEntries={["/jobs/job-1/email-editor?purpose=adjustment-note&creditNote=CN-2026-10-1"]}>
          <Routes>
            <Route path="/jobs/:id/email-editor" element={<EmailComposerPage />} />
          </Routes>
        </MemoryRouter>
      </ShellContext.Provider>,
    );
    await screen.findByRole("heading", { name: "Send adjustment note CN-2026-10-1" });
    await waitFor(() => expect(api.emailPreview).toHaveBeenCalled(), { timeout: 2000 });
    expect(api.emailPreview.mock.calls.at(-1)?.[1].adjustmentNote).toBe("CN-2026-10-1");
  });
});

describe("composer", () => {
  it("shows a merge field in the subject as a readable chip, and the raw field while it is edited", () => {
    render(<SubjectField value="Invoice {{documentNumber}} · {{jobTitle}}" onChange={() => {}} values={{ documentNumber: null, jobTitle: "14 Copperleaf Rise" }} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.className).toContain("fx-composer__subject--masked");
    const mirror = document.querySelector(".fx-subject__mirror") as HTMLElement;
    expect(mirror.textContent).toBe("Invoice Document number · 14 Copperleaf Rise");
    expect(mirror.querySelector('[data-merge="documentNumber"]')?.textContent).toBe("Document number");
    fireEvent.focus(input);
    expect(document.querySelector(".fx-subject__mirror")).toBeNull();
    expect(input.value).toBe("Invoice {{documentNumber}} · {{jobTitle}}");
  });

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
    const [jobId, recipients, subject, body, options] = api.emailJob.mock.calls[0];
    expect(options.holdSeconds).toBe(10);
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
