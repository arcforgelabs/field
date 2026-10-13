import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/lib/api";
import type { MilestoneRulesResponse } from "@/lib/types";
import { MilestoneRulesPanel } from "./milestone-rules-panel";

const auth = { isOwner: true };
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ toast: () => {} }) }));
afterEach(() => vi.restoreAllMocks());

const response: MilestoneRulesResponse = {
  ok: true,
  version: "1:2026-10-13T00:00:00.000Z",
  businessRegion: { country: "AU", region: "SA", from: "business-address" },
  rules: [{
    uid: "mrl_01JAAAAAAAAAAAAAAAAAAAAAAA", name: "SA domestic, under $20,000", country: "AU", region: "SA", minValue: 0, maxValue: 20000, valueBasis: "inc-gst", note: null,
    milestones: [], caps: [{ kind: "deposit", mode: "hard", maxPercent: null, maxAmount: 1000 }],
  }],
  options: { valueBases: ["inc-gst", "ex-gst"], capModes: ["hard", "soft"], capKinds: ["deposit", "progress", "final", "variation"], regions: { AU: [{ code: "SA", name: "South Australia" }, { code: "VIC", name: "Victoria" }] } },
};

describe("MilestoneRulesPanel", () => {
  it("an owner edits a cap and saves the rules with the version read", async () => {
    auth.isOwner = true;
    vi.spyOn(api, "milestoneRules").mockResolvedValue(response);
    const save = vi.spyOn(api, "saveMilestoneRules").mockResolvedValue(response);
    render(<MilestoneRulesPanel />);
    await waitFor(() => expect((screen.getByLabelText("Rule name") as HTMLInputElement).value).toBe("SA domestic, under $20,000"));
    expect(screen.getByText(/read from the business address/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Hard or soft cap"), { target: { value: "soft" } });
    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [rules, version] = save.mock.calls[0];
    expect(version).toBe(response.version);
    expect(rules[0]).toMatchObject({ uid: response.rules[0].uid, country: "AU", region: "SA", maxValue: 20000, caps: [{ kind: "deposit", mode: "soft", maxAmount: 1000, maxPercent: null }] });
  });

  it("anyone else reads them and cannot change them", async () => {
    auth.isOwner = false;
    vi.spyOn(api, "milestoneRules").mockResolvedValue(response);
    render(<MilestoneRulesPanel />);
    await waitFor(() => expect(screen.getByText("Only an owner changes these rules.")).toBeTruthy());
    expect((screen.getByLabelText("Rule name") as HTMLInputElement).closest("fieldset")?.disabled).toBe(true);
  });
});
