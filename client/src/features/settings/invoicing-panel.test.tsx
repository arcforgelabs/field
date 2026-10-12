import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/lib/api";
import type { InvoicingSettings } from "@/lib/types";
import { InvoicingPanel } from "./invoicing-panel";

vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast: () => {} }) }));

const settings: InvoicingSettings = {
  ok: true,
  creditNoteOnReissue: "when-emailed",
  updatedAt: null,
  updatedBy: null,
  choices: [
    { value: "when-emailed", label: "Only if it was emailed", description: "Credits it when Field emailed it." },
    { value: "always", label: "Always", description: "Credits it every time." },
    { value: "never", label: "Never", description: "Never credits it." },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("InvoicingPanel", () => {
  it("shows the three choices with their sentences and saves the one picked", async () => {
    vi.spyOn(api, "invoicingSettings").mockResolvedValue(settings);
    const update = vi.spyOn(api, "updateInvoicingSettings").mockResolvedValue({ ...settings, creditNoteOnReissue: "never" });
    render(<InvoicingPanel />);
    await waitFor(() => expect(screen.getByText("Credits it when Field emailed it.")).toBeTruthy());
    expect(screen.getByText("Credits it every time.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Only if it was emailed/ }) as HTMLInputElement).checked).toBe(true);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Never/ }));
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ creditNoteOnReissue: "never" }));
  });
});
