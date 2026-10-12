// The catalogue screen's calls. Grid rows, bulk edits and supplier links go
// through the price book API (server/catalog/price-book-http.js); items, kit
// components and categories through /api/price-catalog (catalog-api.js).
// Every write drops the cached catalogue so quote screens re-read prices.
import { api, apiRequest, invalidatePriceCatalogCache } from "@/lib/api";
import { priceBookApi, type PriceBookRow } from "@/features/pricing/price-book-api";
import type { PriceCatalogHealthReport } from "@/lib/types";
import type { ComponentBody } from "./catalogue-model";

const base = "/api/price-catalog";
const enc = encodeURIComponent;

export type ItemComponent = {
  uid: string;
  code: string | null;
  name: string | null;
  quantity: number | null;
  entry_quantity: number | null;
  entry_unit: string | null;
  application_mode: "proportional" | "fixed";
  pricing_contribution: "included" | "listed_only";
  unit: string | null;
  status: string;
  source: "db" | "recipe";
  effective_buy_price?: number | null;
  effective_sell_price?: number | null;
  buy_price: number | null;
  sell_price: number | null;
  synthetic?: boolean;
  balance?: boolean;
};

export type ItemDetail = {
  uid: string;
  code: string;
  name: string;
  unit: string;
  unit_code: string;
  description: string | null;
  price_reference: string | null;
  catalog_type: "goods_service" | "component";
  category: string | null;
  tags: string[];
  status: "active" | "draft" | "archived";
  version: number;
  cost_mode: "manual" | "rollup";
  sell_mode: "fixed" | "markup" | "rollup";
  markup_pct: number | null;
  buy_price: number | null;
  sell_price: number | null;
  effective_buy_price: number | null;
  effective_sell_price: number | null;
  pricing_basis: "per_tonne" | "per_load" | "per_m3" | null;
  pricing_basis_factor: number | null;
  price_effective_from: string | null;
  children: ItemComponent[];
  used_in?: Array<{ uid: string; name: string; status: string; unit: string; quantity: number | null }>;
  updated_at: string | null;
};

export type ManagedCategory = { id: number; name: string; sort_order: number };

const write = async <T>(promise: Promise<T>): Promise<T> => {
  const result = await promise;
  invalidatePriceCatalogCache();
  return result;
};

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** Every row in the catalogue, all statuses, a page at a time. */
export async function loadAllRows(): Promise<{ rows: PriceBookRow[]; version: number }> {
  const rows: PriceBookRow[] = [];
  let offset = 0;
  let version = 0;
  for (;;) {
    const page = await priceBookApi.grid({ status: "all", sort: "name", dir: "asc", offset, limit: 500 });
    rows.push(...page.rows);
    version = page.catalogVersion;
    offset += page.rows.length;
    if (!page.rows.length || offset >= page.total) break;
  }
  return { rows, version };
}

export const catalogueApi = {
  item(uidOrCode: string) {
    return apiRequest<ItemDetail>(`${base}/items/${enc(uidOrCode)}`, { cache: "no-store" });
  },
  create(body: Record<string, unknown>) {
    return write(apiRequest<ItemDetail>(`${base}/items`, json("POST", body)));
  },
  update(uid: string, patch: Record<string, unknown>, expectedVersion: number) {
    return write(apiRequest<ItemDetail>(`${base}/items/${enc(uid)}`, json("PATCH", { ...patch, expectedVersion })));
  },
  duplicate(uid: string) {
    return write(apiRequest<ItemDetail>(`${base}/items/${enc(uid)}/duplicate`, json("POST", {})));
  },
  remove(uid: string) {
    return write(apiRequest<unknown>(`${base}/items/${enc(uid)}`, { method: "DELETE" }));
  },
  addComponent(kitUid: string, childUid: string, body: ComponentBody) {
    return write(apiRequest<unknown>(`${base}/items/${enc(kitUid)}/children`, json("POST", { child_code: childUid, ...body })));
  },
  updateComponent(kitUid: string, childUid: string, body: ComponentBody) {
    return write(apiRequest<unknown>(`${base}/items/${enc(kitUid)}/children/${enc(childUid)}`, json("PATCH", body)));
  },
  removeComponent(kitUid: string, childUid: string) {
    return write(apiRequest<unknown>(`${base}/items/${enc(kitUid)}/children/${enc(childUid)}`, { method: "DELETE" }));
  },
  categories() {
    return apiRequest<ManagedCategory[]>(`${base}/categories`);
  },
  createCategory(name: string) {
    return write(apiRequest<ManagedCategory>(`${base}/categories`, json("POST", { name })));
  },
  renameCategory(id: number, name: string) {
    return write(apiRequest<ManagedCategory>(`${base}/categories/${id}`, json("PATCH", { name })));
  },
  deleteCategory(id: number) {
    return write(apiRequest<{ ok: boolean }>(`${base}/categories/${id}`, { method: "DELETE" }));
  },
  reorderCategories(ids: number[]) {
    return write(apiRequest<ManagedCategory[]>(`${base}/categories/reorder`, json("POST", { ids })));
  },
  suppliers() {
    return apiRequest<import("@/features/pricing/price-book-api").Supplier[]>(`${base}/suppliers?status=all`);
  },
  createSupplier(name: string) {
    return priceBookApi.createSupplier({ name });
  },
  updateSupplier(uid: string, patch: { name?: string; status?: "active" | "archived" }) {
    return apiRequest<unknown>(`${base}/suppliers/${enc(uid)}`, json("PATCH", patch));
  },
  health(): Promise<PriceCatalogHealthReport> {
    return api.priceCatalogHealth();
  },
};
