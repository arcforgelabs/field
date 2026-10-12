// The one totals function for quote rows (#241; docs/PRICING_ENGINE.md
// "Numbers, money and rounding" and "quote_lines"). Decided by the owner on
// 2026-10-12 (#178):
//
//   line total  the line's amount. A line whose total is `computed` is
//               round(quantity x unit sell, 2); a line whose total is
//               `printed` (frozen from a document already issued, where
//               quantity x rate did not give the amount it printed) carries
//               that amount as stored
//   subtotal    sum of the counted lines' totals
//   tax total   per tax rate: round(sum of that rate's line totals x rate, 2),
//               once, not per line (every sent PDF did it this way)
//   total       subtotal + tax total
//
// Amounts exclude GST. Only `item` and `custom` lines that are selected and
// priced count: a `component` line is shown under the line that carries its
// price, a `note` has no money, an optional line that is not selected is
// listed but not charged, and a line with no unit sell is unpriced (listed in
// `unpriced`, never counted as zero).
//
// Arithmetic is exact: values are parsed as decimals into integers (cents,
// ten-thousandths, thousandths of a percent), multiplied as BigInt and
// rounded half away from zero, as PostgreSQL's round(numeric) does. Results
// are decimal strings ("1234.50"), the way both database drivers return
// numeric columns. Pure: no I/O, no clock.

export const COUNTED_LINE_TYPES = Object.freeze(["item", "custom"]);
export const LINE_TOTAL_SOURCES = Object.freeze(["computed", "printed"]);

export class QuoteMoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuoteMoneyError";
    this.code = "QUOTE_MONEY_INVALID";
  }
}

function decimalText(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new QuoteMoneyError(`not a finite number: ${value}`);
    const text = String(value);
    // 1e-7 and 1e21 style: expand without losing the digits JavaScript kept.
    return /e/i.test(text) ? value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "") : text;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new QuoteMoneyError(`not a decimal: ${JSON.stringify(value)}`);
}

/**
 * Parse a decimal into an integer of `scale` decimal places. Returns
 * { scaled, exact }: `exact` is false when digits beyond `scale` were rounded
 * away (half away from zero).
 */
export function toScaled(value, scale) {
  const text = decimalText(value);
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) throw new QuoteMoneyError(`not a decimal: ${JSON.stringify(value)}`);
  const negative = match[1] === "-";
  const whole = match[2] || "0";
  const fraction = match[3] || "";
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  const dropped = fraction.slice(scale);
  let scaled = BigInt(whole + kept);
  if (dropped && dropped[0] >= "5") scaled += 1n;
  const exact = !/[1-9]/.test(dropped);
  return { scaled: negative ? -scaled : scaled, exact };
}

/** round(numerator / denominator), half away from zero; denominator > 0. */
function divRound(numerator, denominator) {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (magnitude * 2n + denominator) / (denominator * 2n);
  return negative ? -quotient : quotient;
}

/** An integer of `scale` decimal places as a decimal string: (12345n, 2) -> "123.45". */
export function scaledToText(scaled, scale) {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return negative ? `-${text}` : text;
}

/** Whole cents of a money value, rounded half away from zero. */
export function toCents(value) {
  return toScaled(value, 2).scaled;
}

export function centsToText(cents) {
  return scaledToText(cents, 2);
}

/** Round a money value to cents: "33.335" -> "33.34". */
export function roundMoney(value) {
  return centsToText(toCents(value));
}

/** A decimal with exactly `scale` places: (12.5, 4) -> "12.5000". */
export function fixed(value, scale) {
  return scaledToText(toScaled(value, scale).scaled, scale);
}

/** round(quantity x unit sell, 2), as cents. Quantity and unit sell have up to 4 decimals. */
export function lineTotalCents(quantity, unitSell) {
  const qty = toScaled(quantity, 4).scaled;
  const sell = toScaled(unitSell, 4).scaled;
  // 4 + 4 decimal places in the product; cents keep 2.
  return divRound(qty * sell, 1000000n);
}

/**
 * A unit sell as a new line takes it: rounded to whole cents, so that
 * quantity x rate always gives the line's total (decided 2026-10-12).
 */
export function newLineUnitSell(value) {
  return fixed(roundMoney(value), 4);
}

/**
 * The whole-cent unit sell at which `quantity` costs exactly `total`
 * (round(quantity x unit sell, 2) = total), or null when there is none
 * ($100 over 3 units has no such rate).
 */
export function unitSellForTotal(quantity, total) {
  const qty = toScaled(quantity, 4).scaled;
  const target = toCents(total);
  if (qty <= 0n) return null;
  const candidate = divRound(target * 10000n, qty);
  return lineTotalCents(quantity, centsToText(candidate)) === target ? centsToText(candidate) : null;
}

/** round(base x rate / 100, 2), as cents. The rate is a percent with 3 decimals (10 = 10 %). */
export function taxCents(base, taxRatePercent) {
  const amount = typeof base === "bigint" ? base : toCents(base);
  const rate = toScaled(taxRatePercent, 3).scaled;
  return divRound(amount * rate, 100000n);
}

/**
 * Whether tax on `base` at `taxRatePercent` falls exactly on half a cent: the
 * one case where the renderer before #2 (binary floating point) and exact
 * rounding could print GST a cent apart ($21.15 at 10 %: a PDF printed $2.11).
 */
export function isHalfCentTax(base, taxRatePercent) {
  const amount = typeof base === "bigint" ? base : toCents(base);
  const rate = toScaled(taxRatePercent, 3).scaled;
  const product = amount * rate;
  return (product < 0n ? -product : product) % 100000n === 50000n;
}

/** Whether a line counts toward the quote's totals. */
export function isCountedLine(line) {
  return COUNTED_LINE_TYPES.includes(line?.lineType)
    && line?.isSelected !== false
    && line?.unitSell !== null && line?.unitSell !== undefined && line?.unitSell !== "";
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

/**
 * A line's total: the stored amount when it is `printed`, else
 * round(quantity x unit sell, 2). Null for a line with no unit sell.
 */
export function resolveLineTotal(line) {
  if (line?.lineTotalSource === "printed") {
    if (!hasValue(line.lineTotal)) throw new QuoteMoneyError("a line whose total is printed needs its total");
    return toCents(line.lineTotal);
  }
  if (!hasValue(line?.unitSell)) return null;
  return lineTotalCents(line.quantity ?? 1, line.unitSell);
}

/**
 * The quote's totals from its lines. Each line is { lineType, quantity,
 * unitSell, lineTotal?, lineTotalSource?, taxRate, isSelected? }.
 *
 * Returns { subtotal, taxTotal, total, taxGroups, lines, unpriced,
 * inconsistent }: `lines` has, in input order, each line's { lineTotal,
 * counted } (null for an unpriced line, "0.00" for a note); `taxGroups` one
 * { taxRate, base, tax } per rate; `unpriced` the indexes of counted-type
 * lines with no unit sell; `inconsistent` the indexes of `computed` lines
 * that carry a lineTotal other than round(quantity x unit sell, 2).
 */
export function quoteTotals(lines) {
  if (!Array.isArray(lines)) throw new QuoteMoneyError("quoteTotals takes an array of lines");
  let subtotal = 0n;
  const bases = new Map();
  const unpriced = [];
  const inconsistent = [];
  const perLine = lines.map((line, index) => {
    if (line?.lineType === "note") return { lineTotal: "0.00", counted: false };
    const total = resolveLineTotal(line);
    if (total === null) {
      if (COUNTED_LINE_TYPES.includes(line?.lineType) && line?.isSelected !== false) unpriced.push(index);
      return { lineTotal: null, counted: false };
    }
    if (line?.lineTotalSource !== "printed" && hasValue(line?.lineTotal) && toCents(line.lineTotal) !== total) inconsistent.push(index);
    const counted = isCountedLine(line);
    if (counted) {
      subtotal += total;
      const rate = fixed(line.taxRate ?? 0, 3);
      bases.set(rate, (bases.get(rate) || 0n) + total);
    }
    return { lineTotal: centsToText(total), counted };
  });
  let taxTotal = 0n;
  const taxGroups = [...bases].sort(([a], [b]) => (Number(a) - Number(b))).map(([taxRate, base]) => {
    const tax = taxCents(base, taxRate);
    taxTotal += tax;
    return { taxRate, base: centsToText(base), tax: centsToText(tax) };
  });
  return {
    subtotal: centsToText(subtotal),
    taxTotal: centsToText(taxTotal),
    total: centsToText(subtotal + taxTotal),
    taxGroups,
    lines: perLine,
    unpriced,
    inconsistent,
  };
}
