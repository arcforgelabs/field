// The price book's HTTP calls (server/catalog/price-book-http.js). Writes drop
// the cached catalogue items so quote screens re-read current prices.
import { apiRequest, apiRequestForm, invalidatePriceCatalogCache } from "@/lib/api";

export type PriceBookSupplierLink = {
  id: number;
  supplier_uid: string | null;
  supplier_name: string | null;
  supplier_code: string | null;
  pack_qty: number;
  is_default: boolean;
};

export type PendingPrice = {
  price_id: number;
  effective_from: string;
  cost: number | null;
  sell: number | null;
  markup_pct: number | null;
  source: string;
  source_ref: string | null;
};

export type PriceBookRow = {
  uid: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  unit: string;
  unit_code: string;
  kind: string | null;
  catalog_type: string;
  status: "active" | "draft" | "archived";
  version: number;
  tax_code: string;
  cost_mode: "manual" | "rollup";
  sell_mode: "fixed" | "markup" | "rollup";
  cost: number | null;
  sell: number | null;
  markup_pct: number | null;
  margin_pct: number | null;
  warnings: string[];
  price_id: number | null;
  price_effective_from: string | null;
  price_source: string | null;
  pending_price: PendingPrice | null;
  variant_of_uid: string | null;
  variant_of_code: string | null;
  variant_of_name: string | null;
  child_count: number;
  problems: Array<{ kind: string; childCode?: string | null }>;
  suppliers: PriceBookSupplierLink[];
  supplier_name: string | null;
  supplier_code: string | null;
  updated_at: string | null;
};

export type PriceBookPage = {
  rows: PriceBookRow[];
  total: number;
  offset: number;
  limit: number;
  sort: string;
  dir: "asc" | "desc";
  catalogVersion: number;
  etag: string;
  facets: {
    categories: Array<{ name: string; count: number }>;
    tags: Array<{ name: string; count: number }>;
  };
};

export type PriceBookQuery = {
  q?: string;
  status?: string;
  category?: string | null;
  tag?: string | null;
  supplier?: string | null;
  sort?: string;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
};

export type BulkOp =
  | { setMarkupPct: number }
  | { adjustCostPct: number }
  | { adjustSellPct: number }
  | { setCategory: string | null }
  | { archive: true };

export type BulkSide = {
  cost: number | null;
  sell: number | null;
  markup_pct: number | null;
  sell_mode: string;
  category: string | null;
  status: string;
  margin_pct: number | null;
};

export type BulkRow = {
  uid: string;
  code: string | null;
  name: string | null;
  version?: number;
  action: "update" | "skip";
  reason: string | null;
  before: BulkSide | null;
  after: BulkSide | null;
  warnings: Array<{ code: string; message: string }>;
};

export type BulkResult = {
  op: BulkOp;
  bulkId?: string;
  catalogVersion?: number;
  summary: { selected: number; updated: number; skipped: number; warnings: number };
  rows: BulkRow[];
};

export type Supplier = {
  id: number;
  uid: string;
  name: string;
  account_number: string | null;
  email_inbox: string | null;
  default_markup_pct: number | null;
  import_profile: { columnMap?: ColumnMap } | null;
  status: "active" | "archived";
  item_count?: number;
};

export type ColumnField = "supplier_code" | "item_code" | "name" | "unit" | "cost" | "sell";
export type ColumnMap = Partial<Record<ColumnField, string>>;

export type InspectResult = {
  delimiter: string;
  headers: string[];
  rowCount: number;
  sampleRows: string[][];
  columnMap: ColumnMap;
  columnMapSource: "supplier" | "guess";
};

export type ImportMatch = "changed" | "unchanged" | "new" | "missing" | "ambiguous" | "invalid";
export type ImportDecision = "apply" | "skip" | "create" | "archive";
export type ImportNote = { code: string; message: string };

export type ImportRow = {
  row_no: number;
  supplier_code: string | null;
  match: ImportMatch;
  decision: ImportDecision | null;
  allowed_decisions: ImportDecision[];
  item_uid: string | null;
  item: { uid: string; code: string; name: string; unit: string; status: string } | null;
  name: string | null;
  unit: string | null;
  matched_by: string | null;
  old_cost: number | null;
  new_cost: number | null;
  old_sell: number | null;
  new_sell: number | null;
  delta_pct: number | null;
  old_margin_pct: number | null;
  new_margin_pct: number | null;
  issues: ImportNote[];
  flags: ImportNote[];
  candidates: Array<{ uid: string; code: string; name: string } | null>;
};

export type PriceImport = {
  uid: string;
  supplier_uid: string | null;
  supplier_name: string | null;
  file_name: string | null;
  column_map: ColumnMap | null;
  effective_from: string | null;
  status: "staged" | "applied" | "discarded";
  summary: { counts?: Record<ImportMatch, number>; rowCount?: number; result?: Record<string, number> } | null;
  created_by: string;
  created_at: string | null;
  applied_at: string | null;
  rows?: ImportRow[];
  result?: Record<string, number>;
};

export type PriceHistoryRow = {
  price_id: number;
  cost_per_unit: number | null;
  markup_pct: number | null;
  sell_price: number | null;
  effective_from: string | null;
  source: string;
  source_ref: string | null;
  changed_by: string;
  reason: string | null;
  current: boolean;
};

export type FieldHistoryRow = {
  id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  reason: string | null;
  changed_at: string | null;
};

const base = "/api/price-catalog";

function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

function query(params: PriceBookQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (key !== "category" && value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function write<T>(promise: Promise<T>): Promise<T> {
  const result = await promise;
  invalidatePriceCatalogCache();
  return result;
}

export const priceBookApi = {
  grid(params: PriceBookQuery) {
    return apiRequest<PriceBookPage>(`${base}/grid${query(params)}`);
  },
  updateItem(uid: string, patch: Record<string, unknown>, expectedVersion: number) {
    return write(apiRequest<{ uid: string; version: number }>(`${base}/items/${encodeURIComponent(uid)}`, json("PATCH", { ...patch, expectedVersion })));
  },
  priceHistory(uid: string) {
    return apiRequest<PriceHistoryRow[]>(`${base}/items/${encodeURIComponent(uid)}/prices`);
  },
  fieldHistory(uid: string) {
    return apiRequest<FieldHistoryRow[]>(`${base}/items/${encodeURIComponent(uid)}/history?limit=50`);
  },
  itemSuppliers(uid: string) {
    return apiRequest<PriceBookSupplierLink[]>(`${base}/items/${encodeURIComponent(uid)}/suppliers`);
  },
  linkSupplier(uid: string, body: { supplier_uid: string; supplier_code?: string | null; pack_qty?: number; is_default?: boolean }) {
    return write(apiRequest<PriceBookSupplierLink[]>(`${base}/items/${encodeURIComponent(uid)}/suppliers`, json("POST", body)));
  },
  unlinkSupplier(uid: string, linkId: number) {
    return write(apiRequest<PriceBookSupplierLink[]>(`${base}/items/${encodeURIComponent(uid)}/suppliers/${linkId}`, { method: "DELETE" }));
  },
  bulkPreview(uids: string[], op: BulkOp) {
    return apiRequest<BulkResult>(`${base}/bulk/preview`, json("POST", { uids, op }));
  },
  bulkApply(uids: string[], op: BulkOp, expectedVersions: Record<string, number>) {
    return write(apiRequest<BulkResult>(`${base}/bulk/apply`, json("POST", { uids, op, expectedVersions })));
  },
  suppliers() {
    return apiRequest<Supplier[]>(`${base}/suppliers`);
  },
  createSupplier(body: { name: string; account_number?: string | null; default_markup_pct?: number | null }) {
    return apiRequest<Supplier>(`${base}/suppliers`, json("POST", body));
  },
  inspect(file: File, supplierUid: string | null) {
    const form = new FormData();
    form.append("file", file, file.name);
    if (supplierUid) form.append("supplier_uid", supplierUid);
    return apiRequestForm<InspectResult>(`${base}/imports/inspect`, { method: "POST", body: form });
  },
  stage(file: File, supplierUid: string, columnMap: ColumnMap, effectiveFrom: string | null) {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("supplier_uid", supplierUid);
    form.append("column_map", JSON.stringify(columnMap));
    if (effectiveFrom) form.append("effective_from", effectiveFrom);
    return apiRequestForm<PriceImport>(`${base}/imports`, { method: "POST", body: form });
  },
  imports() {
    return apiRequest<PriceImport[]>(`${base}/imports`);
  },
  getImport(uid: string) {
    return apiRequest<PriceImport>(`${base}/imports/${encodeURIComponent(uid)}`);
  },
  applyImport(uid: string, decisions: Record<number, ImportDecision>) {
    return write(apiRequest<PriceImport>(`${base}/imports/${encodeURIComponent(uid)}/apply`, json("POST", { decisions })));
  },
  discardImport(uid: string) {
    return apiRequest<PriceImport>(`${base}/imports/${encodeURIComponent(uid)}/discard`, json("POST", {}));
  },
};

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `$${value.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

export function pct(value: number | null | undefined, { signed = false } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}
