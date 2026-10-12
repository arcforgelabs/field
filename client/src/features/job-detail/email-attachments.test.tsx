import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { JobDocument } from "@/lib/api";
import { AttachmentPicker, AttachmentTray, attachmentTotals } from "./email-attachments";

const KB = 1024;
const MB = 1024 * KB;

function doc(overrides: Partial<JobDocument>): JobDocument {
  return {
    uid: "doc_01JB8Z00000000000000000001",
    documentType: "quote",
    number: "EQ-2609-14 v2",
    quoteVersion: 2,
    revision: null,
    issuedAt: "2026-09-18T06:40:00.000Z",
    pdfSha256: "a".repeat(64),
    pdfUrl: "/api/documents/doc_01JB8Z00000000000000000001/pdf",
    byteLength: 212 * KB,
    status: "accepted",
    emailed: [{ event: "emailed", at: "2026-09-18T06:40:00.000Z", messageId: "m-1", to: ["dana@example.invalid"] }],
    ...overrides,
  };
}

const quote = doc({});
const invoice = doc({ uid: "doc_01JB8Z00000000000000000002", documentType: "invoice", number: "INV-2026-10-2", status: "issued", byteLength: 187 * KB, emailed: [] });
const note = doc({ uid: "doc_01JB8Z00000000000000000003", documentType: "credit_note", number: "CN-2026-10-1", status: "issued", byteLength: 94 * KB, emailed: [] });

describe("attachment tray", () => {
  it("lists the email's own document locked, the Field documents and uploads, with the total against 18 MB", () => {
    const onRemoveDocument = vi.fn();
    const photo = new File([new Uint8Array(3 * MB)], "site-photo.jpg", { type: "image/jpeg" });
    render(
      <AttachmentTray
        main={{ filename: "INV-2026-10-2.pdf", documentType: "invoice", byteLength: 187 * KB, issued: true }}
        documents={[note]}
        uploads={[photo]}
        pickerAvailable
        onAdd={() => {}}
        onRemoveDocument={onRemoveDocument}
        onRemoveUpload={() => {}}
      />,
    );
    const tray = screen.getByRole("region", { name: "Attachments" });
    expect(within(tray).getByText("INV-2026-10-2.pdf")).toBeTruthy();
    expect(within(tray).getByLabelText("Locked")).toBeTruthy();
    expect(within(tray).queryByRole("button", { name: "Remove INV-2026-10-2" })).toBeNull();
    expect(within(tray).getByText("CN-2026-10-1.pdf")).toBeTruthy();
    expect(within(tray).getByText("3.3 MB of 18 MB")).toBeTruthy();
    fireEvent.click(within(tray).getByRole("button", { name: "Remove CN-2026-10-1" }));
    expect(onRemoveDocument).toHaveBeenCalledWith(note.uid);
    expect(within(tray).getByRole("button", { name: /Add/ })).toBeTruthy();
  });

  it("says why an email over the limits cannot be sent", () => {
    const big = (name: string, size: number) => new File([new Uint8Array(size)], name);
    expect(attachmentTotals({ main: null, documents: [], uploads: [big("plan.pdf", 11 * MB)] }).problem).toMatch(/plan\.pdf is 11\.0 MB\. Each upload can be at most 10 MB/);
    expect(attachmentTotals({ main: null, documents: [], uploads: [big("a", 9 * MB), big("b", 9 * MB + 1)] }).problem).toMatch(/at most 18 MB/);
    expect(attachmentTotals({ main: null, documents: [], uploads: Array.from({ length: 11 }, (_, index) => big(`f${index}`, 1)) }).problem).toMatch(/at most 10 attachments/);
    expect(attachmentTotals({ main: null, documents: [quote], uploads: [] }).problem).toBeNull();
  });

  it("offers no picker without the issued-document store", () => {
    render(<AttachmentTray main={null} documents={[]} uploads={[]} pickerAvailable={false} onAdd={() => {}} onRemoveDocument={() => {}} onRemoveUpload={() => {}} />);
    expect(screen.queryByRole("button", { name: /Add/ })).toBeNull();
  });
});

describe("attachment picker", () => {
  it("lists issued documents with status and size, locks the email's own one, and disables drafts with where to issue them", () => {
    const onAttach = vi.fn();
    render(
      <MemoryRouter>
        <AttachmentPicker
          jobId="job-1"
          documents={[quote, invoice, note]}
          notIssued={[{ documentType: "invoice", milestoneIndex: 2, label: "Final claim", total: 4400, reason: "Draft." }]}
          selected={[]}
          mainNumber="INV-2026-10-2"
          onCancel={() => {}}
          onAttach={onAttach}
          onUpload={() => {}}
        />
      </MemoryRouter>,
    );
    const dialog = screen.getByRole("dialog", { name: "Attach from this job" });
    const own = within(dialog).getByRole("checkbox", { name: /INV-2026-10-2/ }) as HTMLInputElement;
    expect(own.checked).toBe(true);
    expect(own.disabled).toBe(true);
    expect(within(dialog).getByText("This email's document")).toBeTruthy();
    expect(within(dialog).getByText("Accepted")).toBeTruthy();
    expect(within(dialog).getByText("212 KB")).toBeTruthy();
    const draft = within(dialog).getByRole("checkbox", { name: "Final claim: draft, cannot be attached" }) as HTMLInputElement;
    expect(draft.disabled).toBe(true);
    expect(within(dialog).getByRole("link", { name: "Issue it from Invoices" }).getAttribute("href")).toBe("/jobs/job-1");

    const attach = within(dialog).getByRole("button", { name: "Attach" }) as HTMLButtonElement;
    expect(attach.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /CN-2026-10-1/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /EQ-2609-14 v2/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Attach 2" }));
    expect(onAttach).toHaveBeenCalledWith([note.uid, quote.uid]);
  });

  it("searches by number or type", () => {
    render(
      <MemoryRouter>
        <AttachmentPicker jobId="job-1" documents={[quote, invoice, note]} notIssued={[]} selected={[]} mainNumber={null} onCancel={() => {}} onAttach={() => {}} onUpload={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "adjustment" } });
    expect(screen.getByText("CN-2026-10-1")).toBeTruthy();
    expect(screen.queryByText("EQ-2609-14 v2")).toBeNull();
  });
});
