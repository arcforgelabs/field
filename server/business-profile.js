// The business a document is issued by, as configured for this installation.
//
// The quote catalogue (quote-catalogs/*.json5) carries a `businessProfile`, but
// the committed catalogue is a sample. An installation sets its own identity
// and payment details in config instead, as `businessProfile` in
// FIELD_CONFIG_JSON (or config.json), so they live in its secret store and
// never in the repository. When set, it is merged over the catalogue's profile
// everywhere a profile is read: the catalogue served to quote builds (and so
// every new quote's snapshot), PDFs, issued-document records and email.
//
// Shape (every field optional; a field left out keeps the catalogue's value,
// an empty string clears it):
//   {
//     "tradingName": "...", "legalName": "...", "abn": "...", "address": "...",
//     "phone": "...", "email": "...",
//     "paymentMethods": { "bankTransfer": {
//       "accountName": "...", "bsb": "...", "accountNumber": "...", "bank": "..."
//     } }
//   }
// Unset, nothing changes: the catalogue's profile is used exactly as before.

const PROFILE_FIELDS = Object.freeze(["tradingName", "legalName", "abn", "address", "phone", "email"]);
const BANK_FIELDS = Object.freeze(["accountName", "bsb", "accountNumber", "bank"]);

let override = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickStrings(source, fields, label) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!fields.includes(key)) {
      throw new Error(`${label} has an unknown field "${key}" (allowed: ${fields.join(", ")})`);
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
    out[key] = value.trim();
  }
  return out;
}

/**
 * Validates a configured `businessProfile`. Returns null when it is unset or
 * empty; throws a message naming the bad field otherwise (never its value).
 */
export function normalizeBusinessProfileConfig(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw new Error("businessProfile must be an object");
  const { paymentMethods, ...rest } = raw;
  const fields = pickStrings(rest, PROFILE_FIELDS, "businessProfile");
  let bankTransfer = null;
  if (paymentMethods !== undefined && paymentMethods !== null) {
    if (!isPlainObject(paymentMethods)) throw new Error("businessProfile.paymentMethods must be an object");
    const { bankTransfer: bank, ...otherMethods } = paymentMethods;
    const unknown = Object.keys(otherMethods);
    if (unknown.length) throw new Error(`businessProfile.paymentMethods has an unknown field "${unknown[0]}" (allowed: bankTransfer)`);
    if (bank !== undefined && bank !== null) {
      if (!isPlainObject(bank)) throw new Error("businessProfile.paymentMethods.bankTransfer must be an object");
      bankTransfer = pickStrings(bank, BANK_FIELDS, "businessProfile.paymentMethods.bankTransfer");
      if (!Object.keys(bankTransfer).length) bankTransfer = null;
    }
  }
  if (!Object.keys(fields).length && !bankTransfer) return null;
  return Object.freeze({ fields: Object.freeze(fields), bankTransfer: bankTransfer ? Object.freeze(bankTransfer) : null });
}

/** Sets (or, with null, clears) this process's configured profile. */
export function setBusinessProfileOverride(raw) {
  override = normalizeBusinessProfileConfig(raw);
  return override;
}

export function hasBusinessProfileOverride() {
  return override !== null;
}

/** The configured trading name, or null. */
export function configuredTradingName() {
  return override?.fields.tradingName || null;
}

/**
 * `profile` with the configured fields merged over it. Returns `profile`
 * itself (same object) when nothing is configured, so output is unchanged.
 */
export function applyBusinessProfileOverride(profile) {
  if (!override) return profile;
  const base = isPlainObject(profile) ? profile : {};
  const merged = { ...base, ...override.fields };
  if (override.bankTransfer) {
    const methods = isPlainObject(base.paymentMethods) ? base.paymentMethods : {};
    const bank = isPlainObject(methods.bankTransfer) ? methods.bankTransfer : {};
    merged.paymentMethods = { ...methods, bankTransfer: { ...bank, ...override.bankTransfer } };
  }
  return merged;
}
