// Number formats for Field's tables and drawers.
const moneyFormat = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Money for tables: always two decimals ($1,654.56, never $1,654.5632). Null shows an en dash. */
export function formatMoney(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "–" : moneyFormat.format(value);
}

/** A percentage to one decimal ("32.5%"). Null shows an en dash. */
export function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "–" : `${percentFormat.format(value)}%`;
}
