// Prefixed ULIDs for quote rows (docs/PRICING_ENGINE.md "Identity"): `qte_` a
// quote version, `qsc_` a section, `qln_` a line. Drawn from Web Crypto like
// server/documents/uid.js, so the quote/invoice proof's seeded random source
// is never touched.
import { ulid } from "../documents/uid.js";

export const QUOTE_UID_PREFIX = "qte_";
export const QUOTE_SECTION_UID_PREFIX = "qsc_";
export const QUOTE_LINE_UID_PREFIX = "qln_";

export const newQuoteUid = (now) => `${QUOTE_UID_PREFIX}${ulid(now)}`;
export const newQuoteSectionUid = (now) => `${QUOTE_SECTION_UID_PREFIX}${ulid(now)}`;
export const newQuoteLineUid = (now) => `${QUOTE_LINE_UID_PREFIX}${ulid(now)}`;

export function isQuoteUid(value) {
  return typeof value === "string" && /^qte_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
