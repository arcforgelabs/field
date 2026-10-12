// Capture the golden quantities of the hardcoded lawn, irrigation and
// drainage recipes, to prove the assembly port reproduces them.
//
//   node server/catalog/fixtures/assembly-golden.capture.mjs <legacy checkout> > server/catalog/fixtures/assembly-golden.json
//
// <legacy checkout> must be a Field checkout from before the recipes became
// assembly data (52fc3e9 or earlier: DEFAULT_RECIPE in
// server/quote-commercial-compiler.js, rates passed as `landscapeRates`). The
// cases and catalogue prices are in assembly-golden.cases.mjs; the test
// (server/catalog/assembly-golden.test.js) runs the same cases through the
// current engine with those prices in a real catalogue.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GOLDEN_CASES, GOLDEN_PRICES, projectBreakdown } from "./assembly-golden.cases.mjs";

const [repoRoot] = process.argv.slice(2);
if (!repoRoot) throw new Error("usage: assembly-golden.capture.mjs <legacy checkout>");
const load = (rel) => import(pathToFileURL(join(repoRoot, rel)).href);
const { compileQuoteCommercialBreakdown } = await load("server/quote-commercial-compiler.js");
const { getQuoteCatalog } = await load("server/quote-catalogs.js");

const buy = (code) => GOLDEN_PRICES[code][0];
const sell = (code) => GOLDEN_PRICES[code][1];
// The legacy compiler's input: the landscape rates projected from the price
// maps (server/local-pricing.js buildLandscapeRatesFromPriceMaps at 52fc3e9).
const landscapeRates = {
  _source: "price_catalog",
  labourCostPerHour: buy("LABOURER-HOUR"),
  labourChargePerHour: sell("LABOURER-HOUR"),
  adminCost: buy("ADMIN-FEE"),
  adminCharge: sell("ADMIN-FEE"),
  vehicle: { costPerHour: buy("VEHICLE-HOUR"), chargePerHour: sell("VEHICLE-HOUR"), costPerKm: null, chargePerKm: null },
  excavator: { costPerHour: buy("EXCAVATOR-HOUR"), chargePerHour: sell("EXCAVATOR-HOUR") },
  irrigation: {
    batteryControllerCost: buy("IRRIGATION-CONTROLLER-BATTERY"),
    batteryControllerCharge: sell("IRRIGATION-CONTROLLER-BATTERY"),
    mainsControllerCost: buy("IRRIGATION-CONTROLLER-MAINS"),
    mainsControllerCharge: sell("IRRIGATION-CONTROLLER-MAINS"),
    pipeFixingsCostPerM2: buy("IRRIGATION-PIPE-FIXINGS-M2"),
    pipeFixingsChargePerM2: sell("IRRIGATION-PIPE-FIXINGS-M2"),
  },
  lawn: {
    turfCostPerM2: buy("TURF-SUPPLY-M2"),
    turfChargePerM2: sell("TURF-SUPPLY-M2"),
    loamCostPerM3: buy("SANDY-LOAM-M3"),
    loamChargePerM3: sell("SANDY-LOAM-M3"),
  },
  drainage: {
    pipeCostPerM: buy("DRAIN-PIPE-M"),
    pipeChargePerM: sell("DRAIN-PIPE-M"),
    pitCostEach: buy("DRAIN-PIT"),
    pitChargeEach: sell("DRAIN-PIT"),
    gravelCostPerM: buy("DRAIN-GRAVEL-M"),
    gravelChargePerM: sell("DRAIN-GRAVEL-M"),
    disposalCostPerM: buy("clean-fill-disposal"),
    disposalChargePerM: sell("clean-fill-disposal"),
  },
};

const quoteCatalog = getQuoteCatalog("embark-default");
const golden = GOLDEN_CASES.map((testCase) => {
  const result = compileQuoteCommercialBreakdown({
    quote: { lineItems: [testCase.lineItem], summary: testCase.summary || null },
    quoteCatalog,
    landscapeRates,
  });
  return { name: testCase.name, ...projectBreakdown(result.lineItemBreakdowns[0]) };
});
process.stdout.write(`${JSON.stringify({ capturedFrom: "hardcoded recipes (52fc3e9)", cases: golden }, null, 2)}\n`);
