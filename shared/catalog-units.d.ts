export const COMMON_QUOTE_UNITS: readonly string[];

export const CATALOG_UNIT_ALIASES: Readonly<Record<string, string>>;

export const CATALOG_UNIT_DEFINITIONS: ReadonlyArray<{
  readonly code: string;
  readonly label: string;
  readonly dimension: "count" | "length" | "area" | "volume" | "mass" | "time" | "lot" | "other";
  readonly toBase: string | null;
}>;

export function normalizeCatalogUnit(value: unknown, fallback?: string): string;

export function formatCatalogUnit(value: unknown, fallback?: string): string;

export function formatCatalogUnitText(value: unknown): string;

export function buildQuoteUnitOptions(
  currentUnit?: unknown,
  catalogUnits?: readonly unknown[]
): string[];

export function getCatalogEntryUnitOptions(
  canonicalUnit?: unknown
): Array<{ value: string; label: string }>;

export function getDefaultCatalogEntryUnit(
  canonicalUnit?: unknown,
  quantity?: unknown
): string;

export function canConvertCatalogQuantity(
  fromUnit?: unknown,
  toUnit?: unknown
): boolean;

export function convertCatalogQuantity(
  value: unknown,
  fromUnit?: unknown,
  toUnit?: unknown
): number | null;
