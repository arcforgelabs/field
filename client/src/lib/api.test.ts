import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceCatalogItem } from "./types";
import { api } from "./api";

function catalogItem(overrides: Partial<PriceCatalogItem> = {}): PriceCatalogItem {
  return {
    uid: "catalog-default",
    code: "default-item",
    name: "Default item",
    unit: "each",
    buy_price: 1,
    sell_price: 2,
    buy_price_mode: "manual",
    sell_price_mode: "manual",
    category: "Drainage",
    status: "active",
    ...overrides,
  };
}

const partialDrainItems = Array.from({ length: 12 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return catalogItem({
    uid: `catalog-drain-${number}`,
    code: `drain-${number}`,
    name: `Drain ${number}`,
  });
}).reverse();

const catalogItems = [
  ...partialDrainItems,
  catalogItem({ uid: "catalog-exact", code: "drain", name: "Stormwater work" }),
  catalogItem({
    uid: "catalog-archived",
    code: "drain-archived",
    name: "Archived drain",
    status: "archived",
  }),
  catalogItem({
    uid: "catalog-other-category",
    code: "drain-other",
    name: "Other category drain",
    category: "Other",
  }),
  catalogItem({ uid: "catalog-unrelated", code: "other", name: "Pump", category: "Other" }),
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("fr_token", "catalog-api-test-token");
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => catalogItems,
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("api.priceCatalogItems", () => {
  it("filters the unfiltered API response through the shared deterministic search contract", async () => {
    const filters = { status: "active", category: "Drainage", search: "drain" };
    const results = await api.priceCatalogItems(filters);
    const repeatedResults = await api.priceCatalogItems(filters);

    expect(results).toHaveLength(13);
    expect(results.map((item) => item.code)).toEqual([
      "drain",
      "drain-01",
      "drain-02",
      "drain-03",
      "drain-04",
      "drain-05",
      "drain-06",
      "drain-07",
      "drain-08",
      "drain-09",
      "drain-10",
      "drain-11",
      "drain-12",
    ]);
    expect(repeatedResults.map((item) => item.code)).toEqual(results.map((item) => item.code));
    expect(results.some((item) => item.code === "drain-archived")).toBe(false);
    expect(results.some((item) => item.code === "drain-other")).toBe(false);
    expect(results.some((item) => item.code === "other")).toBe(false);

    const otherCategoryResults = await api.priceCatalogItems({
      status: "active",
      category: "Other",
      search: "drain",
    });
    const archivedResults = await api.priceCatalogItems({
      status: "archived",
      category: "Drainage",
      search: "drain",
    });

    expect(otherCategoryResults.map((item) => item.code)).toEqual(["drain-other"]);
    expect(archivedResults.map((item) => item.code)).toEqual(["drain-archived"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/price-catalog/items");
  });
});

describe("api scheduled email payloads", () => {
  it("keeps the existing immediate document-send payload unchanged", async () => {
    await api.emailQuote("job-1", ["client@example.com"], "<p>Hello</p>", {
      subject: "Quote",
      documentType: "quote",
      version: "7",
    });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      to: ["client@example.com"],
      subject: "Quote",
      cc: [],
      bcc: [],
      customBody: "<p>Hello</p>",
      documentType: "quote",
      version: "7",
    });
  });

  it("adds the chosen ISO time without losing the exact quote version", async () => {
    await api.emailQuote("job-1", ["client@example.com"], "<p>Hello</p>", {
      subject: "Quote",
      documentType: "quote",
      version: "7",
      scheduledAt: "2026-08-26T08:00:00.000+09:30",
    });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      documentType: "quote",
      version: "7",
      scheduledAt: "2026-08-26T08:00:00.000+09:30",
    });
  });

  it("supports scheduling a general job email", async () => {
    await api.emailJob("job-2", ["client@example.com"], "Update", "<p>Done</p>", {
      scheduledAt: "2026-08-26T09:00:00.000+09:30",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/jobs/job-2/email");
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      subject: "Update",
      scheduledAt: "2026-08-26T09:00:00.000+09:30",
    });
  });

  it("reuses a durable draft when it is scheduled again", async () => {
    await api.emailJob("job-2", ["client@example.com"], "Edited", "<p>Updated</p>", {
      scheduledAt: "2026-08-26T09:00:00.000+09:30",
      draftId: "draft-1",
    });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      subject: "Edited",
      draftId: "draft-1",
      scheduledAt: "2026-08-26T09:00:00.000+09:30",
    });
  });
});

describe("quote saves carry the quote rows' version (If-Match)", () => {
  it("sends back the version the job detail and the last save reported, and nothing before one", async () => {
    const respond = (tag: string | null, body: unknown = { ok: true }) => ({
      ok: true,
      headers: { get: (name: string) => (name === "X-Field-Quote-Rows-Version" ? tag : null) },
      json: async () => body,
    });
    const lastHeaders = () => (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).headers as Record<string, string>;
    fetchMock.mockImplementation(async () => respond(null));
    await api.quoteUpdate("job-1", { presentation: {} });
    expect(lastHeaders()).not.toHaveProperty("If-Match");

    fetchMock.mockImplementationOnce(async () => respond('"q1-3"', { meta: { id: "job-1" } }));
    await api.recording("job-1");
    fetchMock.mockImplementationOnce(async () => respond('"q1-4"'));
    await api.quoteUpdate("job-1", { presentation: {} });
    expect(lastHeaders()).toMatchObject({ "If-Match": '"q1-3"' });

    // The save's own reply moved it on; a save that reports nothing keeps it.
    fetchMock.mockImplementationOnce(async () => respond(null));
    await api.quoteUpdate("job-1", { presentation: {} });
    expect(lastHeaders()).toMatchObject({ "If-Match": '"q1-4"' });

    // Another job's version is its own.
    await api.quoteUpdate("job-2", { presentation: {} });
    expect(lastHeaders()).not.toHaveProperty("If-Match");
  });
});

describe("a rate-limited answer (429)", () => {
  it("keeps the session and shows the server's plain message", async () => {
    window.location.hash = "#/jobs";
    const body = { error: "Too many requests. Try again in 45 seconds.", code: "rate_limited", retryAfter: 45, budget: "caller" };
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "Retry-After": "45" }),
      json: async () => body,
    }));
    await expect(api.me()).rejects.toMatchObject({ message: body.error, code: "rate_limited", status: 429 });
    await expect(api.quotePdfPreview("job-1", null)).rejects.toThrow(body.error);
    expect(localStorage.getItem("fr_token")).toBe("catalog-api-test-token");
    expect(window.location.hash).toBe("#/jobs");
  });
});
