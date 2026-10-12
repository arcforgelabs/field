// Tax on a subtotal, in whole cents, rounded half away from zero.
//
// `Math.round(subtotal * rate * 100) / 100` is a cent low whenever the tax
// lands on exactly half a cent and binary floating point stores it just under
// (21.15 × 0.1 = 2.1149999999999998, so $2.11 instead of $2.12; #2). Here the
// subtotal becomes integer cents and the rate integer hundredths of a basis
// point, so the multiplication and the rounding are exact integer arithmetic.
const RATE_SCALE = 1_000_000;

export function taxOnSubtotal(subtotal, rate) {
  if (subtotal == null || rate == null) return null;
  const subtotalNumber = Number(subtotal);
  const rateNumber = Number(rate);
  if (!Number.isFinite(subtotalNumber) || !Number.isFinite(rateNumber)) return null;
  const subtotalCents = BigInt(Math.round(subtotalNumber * 100));
  const scaledRate = BigInt(Math.round(rateNumber * RATE_SCALE));
  const product = subtotalCents * scaledRate;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const scale = BigInt(RATE_SCALE);
  const cents = (magnitude * 2n + scale) / (scale * 2n);
  return Number(negative ? -cents : cents) / 100;
}
