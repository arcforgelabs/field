import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ShellContext } from "@/components/shell/shell-context";
import type { PriceBookRow } from "@/features/pricing/price-book-api";

function row(uid: string, name: string): PriceBookRow {
  return {
    uid, code: uid, name, description: null, category: "Construction Materials", tags: [], unit: "tonne", unit_code: "t",
    kind: null, catalog_type: "material", status: "active", version: 1, tax_code: "GST", cost_mode: "manual", sell_mode: "fixed",
    cost: 10, sell: 15, markup_pct: null, margin_pct: 33.3, warnings: [], price_id: 1, price_effective_from: null, price_source: "manual",
    pending_price: null, variant_of_uid: null, variant_of_code: null, variant_of_name: null, child_count: 0, problems: [], suppliers: [],
    supplier_name: null, supplier_code: null, updated_at: null,
  };
}

const rows = [row("u1", "20mm gravel"), row("u2", "Drainage gravel"), row("u3", "Administration fee")];

vi.mock("./catalogue-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalogue-api")>();
  return {
    ...actual,
    loadAllRows: async () => ({ rows, version: 1 }),
    catalogueApi: {
      ...actual.catalogueApi,
      categories: async () => [],
      suppliers: async () => [],
      health: async () => { throw new Error("no health in this test"); },
    },
  };
});

const { CataloguePage } = await import("./catalogue-page");

describe("CataloguePage selection", () => {
  it("keeps only the shown rows selected when a search hides some", async () => {
    render(
      <ShellContext.Provider value={{ newQuote: () => {}, toast: () => {} }}>
        <MemoryRouter initialEntries={["/pricing"]}>
          <Routes><Route path="/pricing" element={<CataloguePage />} /></Routes>
        </MemoryRouter>
      </ShellContext.Provider>,
    );
    await screen.findByText("Administration fee");

    for (const name of ["20mm gravel", "Administration fee"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(name) }));
    }
    expect(screen.getByText("2 selected")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/Search items/), { target: { value: "gravel" } });
    await waitFor(() => expect(screen.queryByText("Administration fee")).toBeNull());
    expect(screen.getByText("1 selected")).toBeTruthy();
  });
});
