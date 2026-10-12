// Item codes leave Field's outputs (#178 code retirement step 6). An item is
// its uid and its name; a code is only a legacy alias that every input still
// accepts (item_code_aliases). MCP catalogue tools no longer return codes.
// The HTTP catalogue API still includes them by default, marked deprecated,
// until the browser app stops reading them; a client that sends
// `Prefer: field-item-codes=omit` gets the same payloads without them now.

// The keys that hold an item's legacy code in catalogue payloads. Not
// tax_code, unit_code or supplier_code, which are other things.
const CODE_KEYS = new Set(["code", "item_code", "child_code", "parent_code", "itemCode", "childCode", "parentCode", "relatedCodes", "codes"]);

/**
 * `value` with every item code removed, recursively. A row that names
 * something only by code (a health issue for an item that does not exist)
 * keeps that text as `reference`, so it still says what is missing.
 */
export function omitItemCodes(value) {
  if (Array.isArray(value)) return value.map(omitItemCodes);
  if (!value || typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) return value;
  const out = {};
  const hasUid = value.uid != null || value.item_uid != null || value.itemUid != null;
  for (const [key, entry] of Object.entries(value)) {
    if (CODE_KEYS.has(key)) {
      if (key === "code" && !hasUid && typeof entry === "string" && entry) out.reference = entry;
      continue;
    }
    out[key] = omitItemCodes(entry);
  }
  return out;
}

export const OMIT_PREFERENCE = "field-item-codes=omit";

/** Whether a request asked for payloads without item codes. */
export function wantsCodesOmitted(req) {
  const prefer = String(req.headers?.prefer || "").toLowerCase();
  return prefer.split(",").some((part) => part.trim() === OMIT_PREFERENCE);
}

/**
 * Express middleware for the catalogue routes: with the preference, JSON
 * responses lose their item codes (and say so in Preference-Applied);
 * without it they keep them and say they are deprecated (Field-Item-Codes).
 */
export function itemCodePreference(req, res, next) {
  const omit = wantsCodesOmitted(req);
  res.setHeader("Vary", [res.getHeader("Vary"), "Prefer"].filter(Boolean).join(", "));
  if (!omit) {
    res.setHeader("Field-Item-Codes", "deprecated; send Prefer: field-item-codes=omit");
    return next();
  }
  res.setHeader("Preference-Applied", OMIT_PREFERENCE);
  const json = res.json.bind(res);
  res.json = (body) => json(omitItemCodes(body));
  return next();
}
