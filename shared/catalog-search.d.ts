export interface CatalogSearchItem {
  code?: string | null;
  uid?: string | null;
  name?: string | null;
  unit?: string | null;
  category?: string | null;
  catalog_type?: string | null;
  status?: string | null;
}

export interface CatalogSearchOptions<TItem extends CatalogSearchItem = CatalogSearchItem> {
  getKindLabel?: (item: TItem) => string | null | undefined;
}

export interface CatalogSearchFilters {
  status?: string | null;
  category?: string | null;
  search?: string | null;
}

export interface CatalogQuickSearchModel<TItem extends CatalogSearchItem> {
  results: TItem[];
}

export type CatalogSearchDirection = "next" | "previous";

export function normalizeCatalogSearchText(value: unknown): string;

export function tokenizeCatalogSearchQuery(query: unknown): string[];

export function searchCatalogItems<TItem extends CatalogSearchItem>(
  items: readonly TItem[] | null | undefined,
  query: unknown,
  options?: CatalogSearchOptions<TItem>,
): TItem[];

export function buildCatalogQuickSearchModel<TItem extends CatalogSearchItem>(
  items: readonly TItem[] | null | undefined,
  query: unknown,
  options?: CatalogSearchOptions<TItem>,
): CatalogQuickSearchModel<TItem>;

export function clampCatalogSearchSelection(
  selectedIndex: number,
  resultCount: number,
): number;

export function moveCatalogSearchSelection(
  selectedIndex: number,
  resultCount: number,
  direction: CatalogSearchDirection,
): number;

export function getSelectedCatalogSearchItem<TItem>(
  items: readonly TItem[],
  selectedIndex: number,
): TItem | null;

export function getCatalogSearchResultId<TItem extends CatalogSearchItem>(item: TItem): string;

export function filterCatalogItems<TItem extends CatalogSearchItem>(
  items: readonly TItem[] | null | undefined,
  filters?: CatalogSearchFilters,
  options?: CatalogSearchOptions<TItem>,
): TItem[];
