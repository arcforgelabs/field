// Supplier price lists arrive as CSV (or semicolon/tab separated) exports.
// A small RFC 4180 reader: quoted fields, doubled quotes, CR/LF/CRLF line
// ends, a UTF-8 byte-order mark, and the delimiter detected from the header
// line. No dependency: the format is simple and the files are small.
import { CatalogError } from "./errors.js";

export const PRICE_LIST_MAX_BYTES = 10 * 1024 * 1024;
export const PRICE_LIST_MAX_ROWS = 20000;

/** The fields a column map can fill. `cost` is required, plus one way to identify the item. */
export const PRICE_LIST_FIELDS = Object.freeze(["supplier_code", "item_code", "name", "unit", "cost", "sell"]);
export const PRICE_LIST_IDENTITY_FIELDS = Object.freeze(["supplier_code", "item_code", "name"]);

const DELIMITERS = [",", ";", "\t", "|"];

function detectDelimiter(text) {
  let firstLine = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    firstLine += ch;
  }
  let best = ",";
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === delimiter) count += 1;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** Decode upload bytes as UTF-8 (dropping a BOM); refuse binary files such as .xlsx. */
export function decodePriceListBytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  if (buffer.length > PRICE_LIST_MAX_BYTES) {
    throw new CatalogError("INVALID", `The price list is larger than ${PRICE_LIST_MAX_BYTES / (1024 * 1024)} MB`, { path: "file" });
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    throw new CatalogError("INVALID", "This looks like an Excel workbook; save it as CSV and upload that", { path: "file" });
  }
  if (buffer.includes(0)) throw new CatalogError("INVALID", "The price list is not a text (CSV) file", { path: "file" });
  return buffer.toString("utf8").replace(/^﻿/, "");
}

/**
 * Parse CSV text into { delimiter, headers, rows } where rows are arrays of
 * strings (trimmed). Blank lines are dropped. Header names are trimmed and
 * made unique ("Price", "Price (2)").
 */
export function parseCsv(text, { delimiter = null } = {}) {
  const source = String(text ?? "").replace(/^﻿/, "");
  const sep = delimiter || detectDelimiter(source);
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => { record.push(field); field = ""; };
  const pushRecord = () => {
    pushField();
    if (record.some((value) => value.trim() !== "")) records.push(record.map((value) => value.trim()));
    record = [];
  };
  while (i < source.length) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.trim() === "") { field = ""; inQuotes = true; i += 1; continue; }
    if (ch === sep) { pushField(); i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      pushRecord();
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) throw new CatalogError("INVALID", "The price list has an unclosed quoted field", { path: "file" });
  if (field !== "" || record.length) pushRecord();
  if (!records.length) throw new CatalogError("INVALID", "The price list is empty", { path: "file" });
  const seen = new Map();
  const headers = records[0].map((raw, index) => {
    const base = raw || `Column ${index + 1}`;
    const count = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
  const rows = records.slice(1);
  if (rows.length > PRICE_LIST_MAX_ROWS) {
    throw new CatalogError("INVALID", `The price list has ${rows.length} rows; at most ${PRICE_LIST_MAX_ROWS} can be imported at once`, { path: "file" });
  }
  return { delimiter: sep, headers, rows };
}

/**
 * A money or quantity cell as a number: "$1,234.50", "1234.5". By default a
 * comma is a thousands separator; with decimalComma (a ;-separated file)
 * "12,75" and "1.234,50" read the comma as the decimal point and an
 * ambiguous "1,275" is NaN. Blank is null; anything else unreadable is NaN.
 */
export function parseMoney(value, { decimalComma = false } = {}) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text.replace(/^[^\d-]*/, ""));
  let cleaned = text.replace(/[()]/g, "").replace(/^[A-Za-z]{0,3}\s*\$?/, "").replace(/\$/g, "").replace(/\s+/g, "").replace(/^-/, "");
  if (decimalComma && cleaned.includes(",")) {
    // 12,75 and 1.234,50 read the comma as the decimal point; 1,234.50 keeps
    // the comma as a thousands separator. Anything else (1,275) could be
    // either, so it is not a number rather than a guess.
    if (/^\d+,\d{1,2}$/.test(cleaned) || /^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(cleaned)) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(cleaned)) cleaned = cleaned.replace(/,/g, "");
    else return Number.NaN;
  } else {
    cleaned = cleaned.replace(/,/g, "");
  }
  if (!/^\d*\.?\d+$/.test(cleaned)) return Number.NaN;
  const n = Number(cleaned);
  return negative ? -n : n;
}

const GUESSES = [
  ["supplier_code", /^(supplier[\s_-]*(code|sku|part|item)|sku|part[\s_-]*(no|number|#)?|product[\s_-]*code|stock[\s_-]*code|item[\s_-]*number|catalogue[\s_-]*(no|number))$/i],
  ["item_code", /^(field[\s_-]*code|item[\s_-]*code|our[\s_-]*code|code)$/i],
  ["name", /^(name|description|item|product|item[\s_-]*(name|description)|product[\s_-]*(name|description))$/i],
  ["unit", /^(unit|uom|unit[\s_-]*of[\s_-]*measure|per|sell[\s_-]*unit)$/i],
  ["cost", /^(cost|price|buy([\s_-]*price)?|unit[\s_-]*(cost|price)|cost[\s_-]*(price|ex[\s_-]*gst)?|trade([\s_-]*price)?|net([\s_-]*price)?|price[\s_-]*ex[\s_-]*gst)$/i],
  ["sell", /^(sell|sell[\s_-]*price|rrp|retail([\s_-]*price)?|list[\s_-]*price)$/i],
];

/** A best guess at which header holds which field; each header is used once. */
export function guessColumnMap(headers) {
  const map = {};
  const used = new Set();
  for (const [field, pattern] of GUESSES) {
    const header = headers.find((candidate) => !used.has(candidate) && pattern.test(candidate.trim()));
    if (header) {
      map[field] = header;
      used.add(header);
    }
  }
  return map;
}

/**
 * Validate a column map against the file's headers: values must be header
 * names, `cost` is required and at least one identity field must be mapped.
 */
export function validateColumnMap(columnMap, headers) {
  const map = {};
  const input = columnMap && typeof columnMap === "object" ? columnMap : {};
  for (const [field, header] of Object.entries(input)) {
    if (!PRICE_LIST_FIELDS.includes(field)) {
      throw new CatalogError("INVALID", `Unknown column map field "${field}" (expected ${PRICE_LIST_FIELDS.join(", ")})`, { path: `columnMap.${field}` });
    }
    if (header === null || header === undefined || header === "") continue;
    if (!headers.includes(header)) {
      throw new CatalogError("INVALID", `Column "${header}" for ${field} is not in the file (columns: ${headers.join(", ")})`, { path: `columnMap.${field}` });
    }
    map[field] = header;
  }
  if (!map.cost) throw new CatalogError("INVALID", "Map a column to cost", { path: "columnMap.cost" });
  if (!PRICE_LIST_IDENTITY_FIELDS.some((field) => map[field])) {
    throw new CatalogError("INVALID", "Map a supplier code, item code or name column so rows can be matched to items", { path: "columnMap" });
  }
  return map;
}
