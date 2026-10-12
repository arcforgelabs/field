import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportRow, PriceImport } from "./price-book-api";

const api = vi.hoisted(() => ({ applyImport: vi.fn(), discardImport: vi.fn() }));

vi.mock("./price-book-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./price-book-api")>();
  return { ...actual, priceBookApi: { ...actual.priceBookApi, ...api } };
});

const { ImportReview } = await import("./import-review");

function importRow(overrides: Partial<ImportRow>): ImportRow {
  return {
    row_no: 1,
    supplier_code: null,
    match: "changed",
    decision: "apply",
    allowed_decisions: ["apply", "skip"],
    item_uid: null,
    item: null,
    name: null,
    unit: null,
    matched_by: "supplier_code",
    old_cost: null,
    new_cost: null,
    old_sell: null,
    new_sell: null,
    delta_pct: null,
    old_margin_pct: null,
    new_margin_pct: null,
    issues: [],
    flags: [],
    candidates: [],
    ...overrides,
  };
}

const staged: PriceImport = {
  uid: "imp_1",
  supplier_uid: "sup_1",
  supplier_name: "Quarry Co",
  file_name: "quarry.csv",
  column_map: { supplier_code: "SKU", cost: "Price" },
  effective_from: "2026-10-11T00:00:00.000Z",
  status: "staged",
  summary: { counts: { changed: 2, unchanged: 0, new: 1, missing: 1, ambiguous: 0, invalid: 1 } },
  created_by: "Estimator",
  created_at: "2026-10-11T00:00:00.000Z",
  applied_at: null,
  rows: [
    importRow({ row_no: 1, supplier_code: "G20", item_uid: "cat_g", item: { uid: "cat_g", code: "gravel", name: "Gravel 20mm", unit: "m3", status: "active" }, old_cost: 50, new_cost: 55, old_sell: 80, new_sell: 80, delta_pct: 10, new_margin_pct: 31.25 }),
    importRow({ row_no: 2, supplier_code: "P100", item_uid: "cat_p", item: { uid: "cat_p", code: "pipe", name: "Pipe 100mm", unit: "m", status: "active" }, old_cost: 10, new_cost: 13, delta_pct: 30, flags: [{ code: "large_change", message: "Cost moves +30%" }] }),
    importRow({ row_no: 3, supplier_code: "NEW1", match: "new", decision: "skip", allowed_decisions: ["skip", "create"], name: "Geofabric", unit: "m2", new_cost: 4.5, matched_by: null }),
    importRow({ row_no: 4, supplier_code: "BAD", match: "invalid", decision: "skip", allowed_decisions: ["skip"], issues: [{ code: "bad_cost", message: "Cost \"call us\" is not a number" }] }),
    importRow({ row_no: 5, supplier_code: "OLD9", match: "missing", decision: "skip", allowed_decisions: ["skip", "archive"], item: { uid: "cat_o", code: "old-item", name: "Old item", unit: "each", status: "active" }, old_cost: 5, matched_by: "supplier_link" }),
  ],
};

describe("ImportReview", () => {
  beforeEach(() => {
    api.applyImport.mockReset();
    api.discardImport.mockReset();
  });

  it("shows the changed rows biggest change first, with old → new cost and the delta", () => {
    render(<ImportReview record={staged} onChanged={() => undefined} />);
    const table = screen.getByRole("table", { name: "Import changes" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Pipe 100mm")).toBeTruthy();
    expect(within(rows[0]).getByText("+30%")).toBeTruthy();
    expect(within(rows[0]).getByText("Cost moves +30%")).toBeTruthy();
    expect(within(rows[1]).getByText("Gravel 20mm")).toBeTruthy();
    expect(within(rows[1]).getByText("$50.00")).toBeTruthy();
    expect(within(rows[1]).getByText("$55.00")).toBeTruthy();
    expect(within(rows[1]).getByText("+10%")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Ambiguous \/ invalid/ }).textContent).toContain("1");
  });

  it("keeps missing items unless told otherwise and applies the chosen decisions", async () => {
    api.applyImport.mockResolvedValue({ ...staged, status: "applied", summary: { result: { applied: 1, created: 1, archived: 0, skipped: 3 } } });
    const onChanged = vi.fn();
    render(<ImportReview record={staged} onChanged={onChanged} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Decision for row 2" }), { target: { value: "skip" } });
    fireEvent.click(screen.getByRole("tab", { name: /New/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Decision for row 3" }), { target: { value: "create" } });
    fireEvent.click(screen.getByRole("tab", { name: /Missing from file/ }));
    expect(screen.getByText(/nothing is ever deleted/)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Decision for row 5" }) as HTMLSelectElement).value).toBe("skip");

    fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.applyImport).toHaveBeenCalledWith("imp_1", { 1: "apply", 2: "skip", 3: "create", 5: "skip" }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("explains a conflict instead of applying half the file", async () => {
    api.applyImport.mockRejectedValue(Object.assign(new Error("Gravel 20mm (gravel) was re-priced after this file was staged; stage the file again"), { code: "VERSION_CONFLICT" }));
    render(<ImportReview record={staged} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/re-priced after this file was staged.*Upload the file again/)).toBeTruthy();
  });

  it("shows an applied import read-only", () => {
    render(<ImportReview record={{ ...staged, status: "applied", summary: { result: { applied: 2, created: 0, archived: 0, skipped: 3 } } }} onChanged={() => undefined} />);
    expect(screen.getByText(/Applied: 2 prices/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Decision for row 1" })).toBeNull();
  });
});
