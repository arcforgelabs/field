import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogueApi, loadAllRows } from "./catalogue-api";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.setItem("fr_token", "catalogue-api-test-token");
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const conflict = () => ({
  ok: false,
  status: 409,
  json: async () => ({
    error: 'An active catalog item named "Widget Pro" already exists.',
    code: "name_conflict",
    conflict: { uid: "cat_a", name: "Widget Pro" },
  }),
});

describe("catalogue writes", () => {
  it("creates an item without a code and keeps the 409 name-conflict body on the error", async () => {
    fetchMock.mockImplementation(async () => conflict());
    await expect(catalogueApi.create({ name: "Widget Pro", unit: "each" })).rejects.toMatchObject({
      message: 'An active catalog item named "Widget Pro" already exists.',
      code: "name_conflict",
      conflict: { uid: "cat_a", name: "Widget Pro" },
      status: 409,
    });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/price-catalog/items");
    expect(JSON.parse(String(request.body))).toEqual({ name: "Widget Pro", unit: "each" });
  });

  it("sends the version an edit was based on, by uid", async () => {
    fetchMock.mockImplementation(async () => conflict());
    await expect(catalogueApi.update("cat_b", { name: "Widget Pro" }, 4)).rejects.toMatchObject({ code: "name_conflict" });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/price-catalog/items/cat_b");
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(String(request.body))).toEqual({ name: "Widget Pro", expectedVersion: 4 });
  });

  it("adds kit components by the child's uid", async () => {
    await catalogueApi.addComponent("kit_1", "cat_9", { quantity: 0.5, entry_quantity: 30, entry_unit: "min", application_mode: "proportional", pricing_contribution: "included" });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/price-catalog/items/kit_1/children");
    expect(JSON.parse(String(request.body))).toMatchObject({ child_code: "cat_9", quantity: 0.5, entry_unit: "min" });
  });
});

describe("loading the table", () => {
  it("reads every page of the grid, all statuses", async () => {
    const page = (offset: number, count: number) => ({
      rows: Array.from({ length: count }, (_, i) => ({ uid: `u${offset + i}` })),
      total: 700,
      catalogVersion: 12,
    });
    fetchMock
      .mockImplementationOnce(async () => ({ ok: true, json: async () => page(0, 500) }))
      .mockImplementationOnce(async () => ({ ok: true, json: async () => page(500, 200) }));
    const result = await loadAllRows();
    expect(result.rows).toHaveLength(700);
    expect(result.version).toBe(12);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/price-catalog/grid?status=all&sort=name&dir=asc&offset=0&limit=500",
      "/api/price-catalog/grid?status=all&sort=name&dir=asc&offset=500&limit=500",
    ]);
  });
});
