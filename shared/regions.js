// Where an address is: an ISO 3166-1 country code and a state or province
// code, read from the address text. Milestone rules (#29) are entered per
// region, and the business timezone (#55) can default from the same answer.
//
// Only what the text says plainly is read: an Australian state or territory
// (its abbreviation, as in "Exampleton SA 5000", or its full name), and a
// country named at the end. Anything else is unknown (null), never a guess.

export const AU_REGIONS = Object.freeze([
  { code: "ACT", name: "Australian Capital Territory" },
  { code: "NSW", name: "New South Wales" },
  { code: "NT", name: "Northern Territory" },
  { code: "QLD", name: "Queensland" },
  { code: "SA", name: "South Australia" },
  { code: "TAS", name: "Tasmania" },
  { code: "VIC", name: "Victoria" },
  { code: "WA", name: "Western Australia" },
]);

/** The regions Field can name for a country: today, Australia's states and territories. */
export const KNOWN_REGIONS = Object.freeze({ AU: AU_REGIONS });

const COUNTRY_NAMES = Object.freeze([
  ["AU", /\baustralia\b/i],
  ["NZ", /\bnew zealand\b/i],
  ["GB", /\b(united kingdom|england|scotland|wales)\b/i],
  ["US", /\b(united states|usa)\b/i],
  ["CA", /\bcanada\b/i],
]);

const AU_CODES = AU_REGIONS.map((region) => region.code).join("|");
// An abbreviation in capitals, or in any case when a postcode follows it.
const AU_ABBREVIATION = new RegExp(`(?:^|[\\s,])(${AU_CODES})(?=$|[\\s,.])`);
const AU_ABBREVIATION_WITH_POSTCODE = new RegExp(`(?:^|[\\s,])(${AU_CODES})\\.?\\s*,?\\s*\\d{4}\\b`, "i");

function lastMatch(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  let found = null;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) found = match;
  return found;
}

/**
 * { country, region } for an address, each null when the address does not
 * say. `region` is only set with a country.
 */
export function regionFromAddress(address) {
  const text = typeof address === "string" ? address.trim() : "";
  if (!text) return { country: null, region: null };
  const withPostcode = lastMatch(text, AU_ABBREVIATION_WITH_POSTCODE);
  const abbreviation = withPostcode || lastMatch(text, AU_ABBREVIATION);
  if (abbreviation) return { country: "AU", region: abbreviation[1].toUpperCase() };
  // Longest names first, so "Western Australia" is not read as "Australia".
  const byName = [...AU_REGIONS].sort((a, b) => b.name.length - a.name.length)
    .find((region) => new RegExp(`\\b${region.name}\\b`, "i").test(text));
  if (byName) return { country: "AU", region: byName.code };
  const country = COUNTRY_NAMES.find(([, pattern]) => pattern.test(text));
  return { country: country ? country[0] : null, region: null };
}

/** A country code as stored: two capital letters, or null. */
export function normalizeCountryCode(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

/** A region code as stored: one to three capitals or digits, or null. */
export function normalizeRegionCode(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9]{1,3}$/.test(text) ? text : null;
}

/** "South Australia, AU", "AU", or "every region". */
export function describeRegion({ country = null, region = null } = {}) {
  if (!country) return "every region";
  const known = (KNOWN_REGIONS[country] || []).find((entry) => entry.code === region);
  if (region) return known ? `${known.name}, ${country}` : `${region}, ${country}`;
  return country;
}
