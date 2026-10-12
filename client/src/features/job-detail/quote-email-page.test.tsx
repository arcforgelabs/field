import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailActivityPanel, EmailHeaderFields, SendControl } from "./quote-email-page";

function HeaderHarness() {
  const [toAddresses, setToAddresses] = useState(["client@example.com"]);
  const [toDraft, setToDraft] = useState("");
  const [ccAddresses, setCcAddresses] = useState<string[]>([]);
  const [ccDraft, setCcDraft] = useState("");
  const [bccAddresses, setBccAddresses] = useState<string[]>([]);
  const [bccDraft, setBccDraft] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("Job update");
  return (
    <EmailHeaderFields
      contacts={[
        { name: "Alice Client", email: "alice@example.com" },
        { name: "Bob Builder", email: "bob@example.com" },
      ]}
      to={{ addresses: toAddresses, draft: toDraft, setDraft: setToDraft, setAddresses: setToAddresses }}
      cc={{ addresses: ccAddresses, draft: ccDraft, setDraft: setCcDraft, setAddresses: setCcAddresses }}
      bcc={{ addresses: bccAddresses, draft: bccDraft, setDraft: setBccDraft, setAddresses: setBccAddresses }}
      showCc={showCc}
      showBcc={showBcc}
      onShowCc={() => setShowCc(true)}
      onShowBcc={() => setShowBcc(true)}
      onHideCc={() => setShowCc(false)}
      onHideBcc={() => setShowBcc(false)}
      subject={subject}
      onSubjectChange={setSubject}
    />
  );
}

function SendHarness({ onSend }: { onSend: (mode: "now" | "later") => void }) {
  const [mode, setMode] = useState<"now" | "later">("now");
  const [scheduledLocal, setScheduledLocal] = useState("2026-08-27T08:00");
  return (
    <SendControl
      canSend
      phase="compose"
      mode={mode}
      scheduledLocal={scheduledLocal}
      onModeChange={setMode}
      onScheduledLocalChange={setScheduledLocal}
      onSend={onSend}
    />
  );
}

describe("email composer controls", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps Cc and Bcc hidden until requested and commits recipient chips", () => {
    render(<HeaderHarness />);

    expect(screen.queryByPlaceholderText("cc@example.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cc" }));
    const cc = screen.getByPlaceholderText("cc@example.com");
    fireEvent.change(cc, { target: { value: "office@example.com" } });
    fireEvent.keyDown(cc, { key: "Enter" });

    const completedAddress = screen.getByText("office@example.com").closest(".quote-email-address-chip") as HTMLElement;
    expect(completedAddress.style.background).toBe("var(--t-accent-bg)");
    expect(completedAddress.style.border).toContain("var(--t-accent-brd)");
    expect(screen.getByRole("button", { name: "Bcc" })).toBeTruthy();
  });

  it("suggests Google Contacts by name and commits the selected email", () => {
    render(<HeaderHarness />);

    const to = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(to, { target: { value: "alice" } });

    expect(screen.getByRole("listbox", { name: "To Google Contacts suggestions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Alice Client/ }));
    expect(screen.getByText("alice@example.com")).toBeTruthy();
  });

  it("integrates schedule selection into the split send control", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0));
    const onSend = vi.fn();
    render(<SendHarness onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Open send options" }));
    const scheduleOptions = screen.getByRole("dialog", { name: "Schedule send" });
    expect(scheduleOptions.parentElement?.style.position).toBe("fixed");
    expect(scheduleOptions.parentElement?.style.placeItems).toBe("center");
    expect(scheduleOptions.style.background).toBe("var(--t-bg)");
    expect(scheduleOptions.style.borderRadius).toBe("var(--t-radius)");
    expect(screen.getByRole("button", { name: /Tomorrow morning/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tomorrow afternoon/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Monday morning/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select date and time" }));
    expect(screen.getByRole("dialog", { name: "Select date and time" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Schedule date" })).toBeTruthy();
    const time = screen.getByRole("combobox", { name: "Time" });
    expect((time as HTMLInputElement).value).toBe("8:00 am");
    fireEvent.focus(time);
    const suggestions = screen.getByRole("listbox", { name: "Suggested times" });
    expect(screen.getAllByRole("option")).toHaveLength(96);
    expect(screen.getByRole("option", { name: "12:00 am" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "11:45 pm" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "8:00 am" }).getAttribute("aria-selected")).toBe("true");
    expect(suggestions.style.top).toBe("calc(100% + 5px)");
    expect(suggestions.style.maxHeight).toBe("190px");
    expect(suggestions.style.overflowY).toBe("scroll");
    fireEvent.change(time, { target: { value: "830pm" } });
    fireEvent.blur(time);
    expect((time as HTMLInputElement).value).toBe("8:30 pm");
    expect(screen.getByText(/Thursday, 27 August 2026 at 8:30 pm/i)).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Use this schedule" });
    expect(cancel.className).toContain("h-10");
    expect(confirm.className).toContain("h-10");
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith("later");
  });

  it("arms a Gmail-style preset without sending immediately", () => {
    const onSend = vi.fn();
    render(<SendHarness onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Open send options" }));
    fireEvent.click(screen.getByRole("button", { name: /Tomorrow morning/ }));

    const send = screen.getByRole("button", { name: "Send" });
    const menu = screen.getByRole("button", { name: "Open send options" });
    expect(send.style.width).toBe("72px");
    expect(send.style.height).toBe("36px");
    expect(send.style.borderRadius).toBe("18px 0 0 18px");
    expect(menu.style.width).toBe("33px");
    expect(menu.style.height).toBe("36px");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders the activity drawer on an opaque surface", () => {
    render(
      <EmailActivityPanel
        items={[{
          id: "sent-1",
          jobId: "job-1",
          status: "sent",
          lifecycleStatus: "sent",
          scheduledAt: null,
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:00Z",
          sentAt: "2026-08-25T00:01:00Z",
          attemptCount: 1,
          documentType: "email",
          to: ["client@example.com"],
          cc: [],
          bcc: [],
          subject: "Job update",
          attachmentNames: [],
        }]}
        onEditDraft={vi.fn()}
        onEditScheduled={vi.fn()}
        onCancelSchedule={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View all activity" }));
    const drawer = screen.getByRole("dialog", { name: "Email activity" });
    expect(drawer.style.background).toBe("var(--t-bg)");
    expect(drawer.parentElement?.style.background).toContain("0.72");
    expect(screen.getByText("1 previous email").style.fontSize).toBe("12px");
  });

  it("previews a scheduled email and offers Gmail-style cancel send without editing", () => {
    const onEditScheduled = vi.fn();
    const onCancelSchedule = vi.fn();
    render(
      <EmailActivityPanel
        items={[{
          id: "scheduled-1",
          jobId: "job-1",
          status: "pending",
          lifecycleStatus: "scheduled",
          scheduledAt: "2026-09-18T13:38:00.000Z",
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:00Z",
          attemptCount: 0,
          documentType: "quote",
          to: ["client@example.com"],
          cc: ["office@example.com"],
          bcc: [],
          subject: "Your earthworks quote",
          attachmentNames: ["Quote EQ-104.pdf"],
          previewBodyHtml: "<p>Hi Alex,</p><p>Your quote is attached.</p>",
          previewThemeFontFamily: "Geist",
        }]}
        onEditDraft={vi.fn()}
        onEditScheduled={onEditScheduled}
        onCancelSchedule={onCancelSchedule}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("dialog", { name: "Scheduled email preview" });
    expect(preview.style.background).toBe("var(--t-bg)");
    expect(screen.getByText("Your earthworks quote")).toBeTruthy();
    expect(screen.getByText(/Send scheduled for/)).toBeTruthy();
    expect(screen.getByText(/Your quote is attached/)).toBeTruthy();
    expect(screen.getByText("Quote EQ-104.pdf")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel send" }));
    expect(onCancelSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "scheduled-1" }));
    expect(onEditScheduled).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Scheduled email preview" })).toBeNull();
  });
});
