export const COMMON_QUOTE_UNITS = Object.freeze([
  "job",
  "lot",
  "each",
  "hour",
  "min",
  "day",
  "m",
  "mm",
  "m2",
  "m3",
  "tonne",
  "load",
  "km",
  "bag",
  "bay",
]);

const UNIT_ALIASES = Object.freeze({
  ea: "each",
  eaches: "each",
  no: "each",
  nos: "each",
  number: "each",
  numbers: "each",
  pc: "each",
  pcs: "each",
  piece: "each",
  pieces: "each",
  units: "each",

  hrs: "hour",
  hr: "hour",
  hours: "hour",
  minute: "min",
  minutes: "min",
  mins: "min",

  days: "day",
  bags: "bag",
  bays: "bay",
  loads: "load",
  plant: "each",
  plants: "each",
  tree: "each",
  trees: "each",

  kilometre: "km",
  kilometres: "km",
  kilometer: "km",
  kilometers: "km",
  kms: "km",

  lm: "m",
  m: "m",
  metre: "m",
  metres: "m",
  meter: "m",
  meters: "m",

  "linear metre": "m",
  "linear metres": "m",
  "linear meter": "m",
  "linear meters": "m",
  "linear m": "m",
  "lineal metre": "m",
  "lineal metres": "m",
  "lineal meter": "m",
  "lineal meters": "m",
  "lineal m": "m",
  "lin metre": "m",
  "lin meter": "m",
  "lin m": "m",
  "l/m": "m",

  mm: "mm",
  millimetre: "mm",
  millimetres: "mm",
  millimeter: "mm",
  millimeters: "mm",

  "m²": "m2",
  "sqm": "m2",
  "sq m": "m2",
  "square metre": "m2",
  "square metres": "m2",
  "square meter": "m2",
  "square meters": "m2",

  "m³": "m3",
  "cum": "m3",
  "cu m": "m3",
  "cubic metre": "m3",
  "cubic metres": "m3",
  "cubic meter": "m3",
  "cubic meters": "m3",

  t: "tonne",
  ton: "tonne",
  tons: "tonne",
  tonne: "tonne",
  tonnes: "tonne",
});

// Every alias above, by canonical unit. Seeded into the catalogue's
// unit_aliases table (server/catalog/reference-data.js).
export const CATALOG_UNIT_ALIASES = UNIT_ALIASES;

// The dimension of each common unit and its factor to that dimension's base
// unit (time: minute, length: millimetre). `toBase: null` means the unit is
// only ever equal to itself: a bag, a bay, a load or a day has no fixed size.
// Seeded into the catalogue's units table; conversions the catalogue
// enforces (server/catalog/units.js) are the same groups as below.
export const CATALOG_UNIT_DEFINITIONS = Object.freeze([
  Object.freeze({ code: "job", label: "job", dimension: "lot", toBase: null }),
  Object.freeze({ code: "lot", label: "lot", dimension: "lot", toBase: null }),
  Object.freeze({ code: "each", label: "each", dimension: "count", toBase: null }),
  Object.freeze({ code: "hour", label: "hour", dimension: "time", toBase: "60" }),
  Object.freeze({ code: "min", label: "min", dimension: "time", toBase: "1" }),
  Object.freeze({ code: "day", label: "day", dimension: "time", toBase: null }),
  Object.freeze({ code: "m", label: "m", dimension: "length", toBase: "1000" }),
  Object.freeze({ code: "mm", label: "mm", dimension: "length", toBase: "1" }),
  Object.freeze({ code: "m2", label: "m²", dimension: "area", toBase: null }),
  Object.freeze({ code: "m3", label: "m³", dimension: "volume", toBase: null }),
  Object.freeze({ code: "tonne", label: "tonne", dimension: "mass", toBase: null }),
  Object.freeze({ code: "load", label: "load", dimension: "count", toBase: null }),
  Object.freeze({ code: "km", label: "km", dimension: "length", toBase: null }),
  Object.freeze({ code: "bag", label: "bag", dimension: "count", toBase: null }),
  Object.freeze({ code: "bay", label: "bay", dimension: "count", toBase: null }),
]);

const UNIT_DISPLAY_LABELS = Object.freeze({
  m2: "m²",
  m3: "m³",
});

const UNIT_CONVERSION_GROUPS = Object.freeze([
  Object.freeze({ hour: 1, min: 1 / 60 }),
  Object.freeze({ m: 1, mm: 0.001 }),
]);

function normalizeUnitKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function normalizeCatalogUnit(value, fallback = "") {
  const key = normalizeUnitKey(value);
  if (!key) return fallback;
  return UNIT_ALIASES[key] || key;
}

export function formatCatalogUnit(value, fallback = "") {
  const normalized = normalizeCatalogUnit(value, fallback);
  if (!normalized) return fallback;
  return formatCatalogUnitText(normalized);
}

export function formatCatalogUnitText(value) {
  return String(value ?? "")
    .replace(/\bm2\b/gi, UNIT_DISPLAY_LABELS.m2)
    .replace(/\bm3\b/gi, UNIT_DISPLAY_LABELS.m3);
}

export function buildQuoteUnitOptions(currentUnit, catalogUnits = []) {
  const options = [];
  const seen = new Set();
  const add = (unit) => {
    const normalized = normalizeCatalogUnit(unit);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    options.push(normalized);
  };

  add(currentUnit || "lot");
  for (const unit of catalogUnits || []) add(unit);
  for (const unit of COMMON_QUOTE_UNITS) add(unit);

  const order = new Map(COMMON_QUOTE_UNITS.map((unit, index) => [unit, index]));
  return options.sort((a, b) => {
    const aRank = order.has(a) ? order.get(a) : Number.MAX_SAFE_INTEGER;
    const bRank = order.has(b) ? order.get(b) : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
}

export function getCatalogEntryUnitOptions(canonicalUnit) {
  const normalized = normalizeCatalogUnit(canonicalUnit);
  if (!normalized) return [];
  const group = UNIT_CONVERSION_GROUPS.find((candidate) => normalized in candidate);
  const units = group ? Object.keys(group) : [normalized];
  return units.map((unit) => ({ value: unit, label: formatCatalogUnit(unit) }));
}

export function getDefaultCatalogEntryUnit(canonicalUnit, quantity = null) {
  const normalized = normalizeCatalogUnit(canonicalUnit);
  if (normalized === "hour") return "min";
  if (normalized === "m" && Number(quantity) > 0 && Number(quantity) < 1) return "mm";
  return normalized;
}

export function canConvertCatalogQuantity(fromUnit, toUnit) {
  const from = normalizeCatalogUnit(fromUnit);
  const to = normalizeCatalogUnit(toUnit);
  if (!from || !to) return false;
  if (from === to) return true;
  return UNIT_CONVERSION_GROUPS.some((group) => from in group && to in group);
}

export function convertCatalogQuantity(value, fromUnit, toUnit) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const from = normalizeCatalogUnit(fromUnit);
  const to = normalizeCatalogUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return parsed;
  const group = UNIT_CONVERSION_GROUPS.find((candidate) => from in candidate && to in candidate);
  if (!group) return null;
  return parsed * group[from] / group[to];
}
