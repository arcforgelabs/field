// Cases for the assembly golden fixture (see assembly-golden.capture.mjs).
// Synthetic prices: each code's [buy, sell] per the unit the recipe uses it in.
export const GOLDEN_PRICES = Object.freeze({
  "LABOURER-HOUR": [50, 85],
  "VEHICLE-HOUR": [55, 95],
  "EXCAVATOR-HOUR": [180, 310],
  "ADMIN-FEE": [220, 330],
  "TURF-SUPPLY-M2": [18.4, 23.75],
  "SANDY-LOAM-M3": [66.75, 92.5],
  "IRRIGATION-CONTROLLER-BATTERY": [512, 640],
  "IRRIGATION-CONTROLLER-MAINS": [615, 745],
  "IRRIGATION-PIPE-FIXINGS-M2": [8.75, 10.6],
  "DRAIN-PIPE-M": [14.2, 22.4],
  "DRAIN-PIT": [96, 147.5],
  "DRAIN-GRAVEL-M": [11.1, 18.3],
  "clean-fill-disposal": [9.25, 14.5],
});

// The unit each item is sold in, for the catalogue the current engine reads.
export const GOLDEN_UNITS = Object.freeze({
  "LABOURER-HOUR": "hour",
  "VEHICLE-HOUR": "hour",
  "EXCAVATOR-HOUR": "hour",
  "ADMIN-FEE": "each",
  "TURF-SUPPLY-M2": "m2",
  "SANDY-LOAM-M3": "m3",
  "IRRIGATION-CONTROLLER-BATTERY": "each",
  "IRRIGATION-CONTROLLER-MAINS": "each",
  "IRRIGATION-PIPE-FIXINGS-M2": "m2",
  "DRAIN-PIPE-M": "m",
  "DRAIN-PIT": "each",
  "DRAIN-GRAVEL-M": "m",
  // Per metre of trench here so the recipe's per-metre disposal allowance
  // prices; a per-tonne disposal item is refused (UNIT_MISMATCH), tested
  // separately.
  "clean-fill-disposal": "m",
});

const lawnOption = (area, { loam = null } = {}) => ({
  section: "Lawn Supply & Install — Select One Variety",
  code: "lawn-option-1",
  label: "Option 1: Prestige Buffalo",
  quantity: 1,
  unit: "lot",
  unitPrice: Math.round(100 * area + 500),
  totalPrice: Math.round(100 * area + 500),
  rationale: `${area} m² Prestige Buffalo turf${loam ? `, ${loam}` : ""}.`,
});

const lawnRule = (area, { loam = null } = {}) => ({
  code: "lawn-supply-prep-install",
  quoteCatalogItemCode: "lawn-supply-prep-install",
  label: "Lawn supply, preparation and install",
  section: "Lawn",
  quantity: area,
  unit: "m2",
  unitPrice: 60,
  totalPrice: Math.round(60 * area * 100) / 100,
  ...(loam ? { rationale: loam } : {}),
});

const irrigationOption = (area, option) => ({
  section: "Irrigation Supply & Install — Select One",
  code: `irrigation-option-${option}`,
  label: {
    battery: "Option 1: Battery System",
    mains: "Option 2: Mains System with solenoid",
    mains_no_install: "Option 3: Mains controller, no control unit install",
  }[option],
  quantity: 1,
  unit: "lot",
  unitPrice: Math.round(60 * area + 2500),
  totalPrice: Math.round(60 * area + 2500),
  rationale: `Controller + fixings & pipe (${area} m²)${option === "mains_no_install" ? "; customer handles control unit wiring" : ""}.`,
});

const irrigationRule = (area) => ({
  code: "irrigation-system-install",
  quoteCatalogItemCode: "irrigation-system-install",
  label: "Irrigation system",
  section: "Irrigation",
  quantity: area,
  unit: "m2",
  unitPrice: 70,
  totalPrice: Math.round(70 * area + 2500),
  description: "Battery controller with sprinkler pipework.",
});

const drainage = (length, { pits = null, text = "trench" } = {}) => ({
  code: "drainage",
  quoteCatalogItemCode: "drainage",
  label: "Drainage installation",
  section: "Drainage",
  quantity: length,
  unit: "m",
  unitPrice: 150,
  totalPrice: Math.round(150 * length + 1500),
  description: `Stormwater ${text} drainage run${pits != null ? ` with ${pits} pits` : ""}.`,
});

export const GOLDEN_CASES = Object.freeze([
  { name: "lawn option 12.5 m2", lineItem: lawnOption(12.5) },
  { name: "lawn option 23 m2", lineItem: lawnOption(23) },
  { name: "lawn option 80 m2 at 150mm loam", lineItem: lawnOption(80, { loam: "150mm sandy loam base" }) },
  { name: "lawn option 233.3 m2 at 7.5 cm loam", lineItem: lawnOption(233.3, { loam: "7.5 cm loam" }) },
  { name: "lawn rule 45 m2", lineItem: lawnRule(45) },
  { name: "lawn rule 61.25 m2 at 120 mm topsoil", lineItem: lawnRule(61.25, { loam: "120 mm topsoil" }) },
  { name: "irrigation battery 10 m2", lineItem: irrigationOption(10, "battery") },
  { name: "irrigation mains 23 m2", lineItem: irrigationOption(23, "mains") },
  { name: "irrigation mains without install 150 m2", lineItem: irrigationOption(150, "mains_no_install") },
  { name: "irrigation rule 37.5 m2", lineItem: irrigationRule(37.5) },
  { name: "drainage 3 m trench", lineItem: drainage(3) },
  { name: "drainage 10 m trench", lineItem: drainage(10) },
  { name: "drainage 25.5 m trench", lineItem: drainage(25.5) },
  { name: "drainage 41 m trench with 2 pits", lineItem: drainage(41, { pits: 2 }) },
  { name: "drainage 17 m ag pipe with 4 pits", lineItem: drainage(17, { pits: 4, text: "ag pipe" }) },
]);

const round = (value, digits) => (value == null ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits);

/** The part of a compiled line item the port must reproduce exactly. */
export function projectBreakdown(breakdown) {
  const recipe = breakdown?.recipe || null;
  const line = (entry) => ({
    itemCode: entry.itemCode,
    quantity: round(entry.quantity, 4),
    unit: entry.unit,
    unitPrice: round(entry.unitPrice ?? entry.unitRate, 2),
    unitCost: round(entry.unitCost, 2),
  });
  return {
    recipe,
    lines: recipe && recipe !== "direct_pass_through" ? (breakdown.commercialLines || []).map(line) : [],
    materialOrders: (breakdown?.materialOrders || []).map(line),
  };
}
