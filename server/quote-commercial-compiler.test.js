import assert from "node:assert/strict";
import test from "node:test";
import {
  applyQuoteCommercialBreakdownToQuote,
  compileQuoteCommercialBreakdown,
  quoteHasMutuallyExclusiveSections,
} from "./quote-commercial-compiler.js";
import { resolveDisposalBilledQuantity } from "../shared/disposal-basis.js";
import { getQuoteCatalog } from "./quote-catalogs.js";
import { buildTestRecipePricing } from "./test-pricing-fixtures.js";

// Recipes are the embark-default quote catalog's assemblies, priced from
// fixture catalogue rates (Field's code holds no prices).
const SAMPLE = getQuoteCatalog("embark-default");
const recipePricing = buildTestRecipePricing();

test("commercial compilation blocks all pricing when the price catalog is unavailable", () => {
  const result = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          code: "drainage__section-drainage",
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          unitPrice: 210,
          totalPrice: 2520,
          section: "Drainage",
        },
      ],
    },
    recipePricing: {
      unavailable: true,
      _source: "price_catalog_unavailable",
      reason: "Price catalog database is unavailable.",
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.mode, "pricing_unavailable");
  assert.deepEqual(result.commercialLines, []);
  assert.deepEqual(result.budgetLines, []);
  assert.equal(result.lineItemBreakdowns[0].recipe, "pricing_unavailable");
  assert.match(result.pricingIssues[0].message, /price catalog database is unavailable/i);
});

test("option bundles compile into per-option internal breakdowns with a default active scenario", () => {
  const quote = applyQuoteCommercialBreakdownToQuote({
    quote: {
      lineItems: [
        {
          section: "Irrigation Supply & Install — Select One",
          code: "irrigation-option-1",
          label: "Option 1: Battery System",
          quantity: 1,
          unit: "lot",
          unitPrice: 1646,
          totalPrice: 1646,
          rationale: "Battery controller (~$500 cost, 20% markup = $600) + fixings & pipe (23 m² at $10/m² = $230).",
        },
        {
          section: "Lawn Supply & Install — Select One Variety",
          code: "lawn-option-2",
          label: "Option 2: Sapphire Buffalo",
          quantity: 1,
          unit: "lot",
          unitPrice: 1647,
          totalPrice: 1647,
          rationale: "23 m² Sapphire Buffalo ($18/m² supply, charged at $22.50/m²) + install labour.",
        },
      ],
      totals: {
        subtotal: 3293,
      },
    },
    quoteCatalog: SAMPLE,
    recipePricing,
  });

  assert.equal(quoteHasMutuallyExclusiveSections(quote), true);
  assert.equal(Array.isArray(quote.commercialLines), true);
  assert.equal(quote.internalPricing.mode, "option_matrix");
  assert.equal(quote.internalPricing.lineItemBreakdowns.length, 2);
  assert.equal(quote.selectionState.hasOptionFamilies, true);
  assert.equal(quote.selectionState.handoffReady, false);
  assert.equal(quote.selectionState.optionFamilyCount, 2);
  assert.match(quote.totals._note, /default selections/i);

  const irrigation = quote.internalPricing.lineItemBreakdowns[0];
  const lawn = quote.internalPricing.lineItemBreakdowns[1];

  assert.equal(irrigation.totals.charge, 1646);
  assert.deepEqual(
    irrigation.commercialLines.map((line) => line.itemCode),
    [
      "IRRIGATION-CONTROLLER-BATTERY",
      "IRRIGATION-PIPE-FIXINGS-M2",
      "LABOURER-HOUR",
      "LABOURER-HOUR",
      "VEHICLE-HOUR",
      "ADMIN-FEE",
    ]
  );
  assert.equal(lawn.totals.charge, 1647);
  assert.deepEqual(
    lawn.commercialLines.map((line) => line.itemCode),
    [
      "TURF-SUPPLY-M2",
      "LABOURER-HOUR",
      "LABOURER-HOUR",
      "VEHICLE-HOUR",
      "ADMIN-FEE",
    ]
  );
  assert.deepEqual(
    lawn.materialOrders.map((order) => order.itemCode),
    ["TURF-SUPPLY-M2", "SANDY-LOAM-M3"]
  );
  assert.equal(lawn.materialOrders.find((order) => order.itemCode === "SANDY-LOAM-M3")?.quantity, 2.76);
  assert.equal(quote.commercialLines.length, 11);
  assert.equal(quote.materialOrders.length, 4);
  assert.deepEqual(
    quote.materialOrders.map((order) => order.itemCode),
    [
      "IRRIGATION-CONTROLLER-BATTERY",
      "IRRIGATION-PIPE-FIXINGS-M2",
      "TURF-SUPPLY-M2",
      "SANDY-LOAM-M3",
    ]
  );
});

test("flat quotes compile pass-through commercial and budget lines for external authority compatibility", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      quoteCatalog: {
        commercialAuthority: {
          provider: "external_authority",
          baseUrl: "https://authority.example.test",
          buyingPriceList: "Standard Buying",
          sellingPriceList: "Standard Selling",
        },
      },
      lineItems: [
        {
          section: "Drainage",
          code: "drainage",
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          unitCost: null,
          unitPrice: 145,
          totalPrice: 1740,
          rationale: "Drainage run required.",
        },
      ],
    },
    quoteCatalog: {
      rules: [
        {
          code: "drainage",
          label: "Drainage installation",
          unit: "lm",
          authorityPricing: {
            buyingRate: 102,
            sellingRate: 145,
            itemCode: "drainage",
            itemName: "Drainage installation",
            stockUom: "lm",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.mode, "flat_quote");
  assert.equal(breakdown.commercialLines.length, 1);
  assert.equal(breakdown.budgetLines.length, 1);
  assert.equal(breakdown.commercialLines[0].itemCode, "drainage");
  assert.equal(breakdown.commercialLines[0].totalPrice, 1740);
  assert.equal(breakdown.budgetLines[0].unitPrice, 102);
  assert.equal(breakdown.totals.charge, 1740);
  assert.equal(breakdown.totals.cost, 1224);
  assert.ok(breakdown.commercialLines[0].trace);
  assert.ok(breakdown.commercialLines[0].trace.quantityDerivation.some((entry) => /12 m/i.test(entry.expression)));
  assert.ok(breakdown.commercialLines[0].trace.pricingDerivation.some((entry) => /Authority buying rate/i.test(entry.expression)));
  assert.ok(breakdown.commercialLines[0].trace.references.some((entry) => entry.type === "authority_item"));
  assert.ok(breakdown.commercialLines[0].trace.references.some((entry) => entry.type === "authority_price_record"));
  assert.ok(breakdown.commercialLines[0].trace.quantityDerivation.every((entry) => (
    entry.references || []
  ).every((reference) => reference.label !== "Field pricing record")));
  const priceRefs = breakdown.commercialLines[0].trace.references
    .filter((entry) => entry.type === "authority_price_record");
  assert.equal(priceRefs.length, 2);
  assert.equal(priceRefs[0].itemCode, "drainage");
  assert.equal(priceRefs[0].priceList, "Standard Buying");
  assert.equal(priceRefs[1].priceList, "Standard Selling");
});

test("flat quotes emit price catalog trace references when price catalog is the authority", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      quoteCatalog: {
        commercialAuthority: {
          provider: "price_catalog",
        },
      },
      lineItems: [
        {
          section: "Drainage",
          code: "drainage",
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          unitCost: null,
          unitPrice: 145,
          totalPrice: 1740,
          rationale: "Drainage run required.",
        },
      ],
    },
    quoteCatalog: {
      rules: [
        {
          code: "drainage",
          label: "Drainage installation",
          unit: "lm",
          authorityPricing: {
            itemCode: "drainage",
            buyingRate: 102,
            sellingRate: 145,
          },
        },
      ],
      commercialAuthority: {
        provider: "price_catalog",
      },
    },
  });

  assert.equal(breakdown.commercialLines[0].pricingSource, "price_catalog_buying_rate");
  assert.ok(breakdown.commercialLines[0].trace.pricingDerivation.some((entry) => /Price catalog buying rate/i.test(entry.expression)));
  assert.ok(breakdown.commercialLines[0].trace.references.some((entry) => entry.type === "price_catalog_item"));
  assert.equal(breakdown.commercialLines[0].trace.references.some((entry) => entry.type === "authority_item"), false);
});

test("commercial trace references prefer authority publicBaseUrl for operator links", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      quoteCatalog: {
        commercialAuthority: {
          provider: "external_authority",
          baseUrl: "http://authority.internal.test:8080",
          publicBaseUrl: "https://authority.example.test",
          buyingPriceList: "Standard Buying",
          sellingPriceList: "Standard Selling",
        },
      },
      lineItems: [
        {
          section: "Drainage",
          code: "drainage",
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          unitCost: null,
          unitPrice: 145,
          totalPrice: 1740,
          rationale: "Drainage run required.",
        },
      ],
    },
    quoteCatalog: {
      rules: [
        {
          code: "drainage",
          label: "Drainage installation",
          unit: "lm",
          authorityPricing: {
            buyingRate: 102,
            sellingRate: 145,
            itemCode: "drainage",
            itemName: "Drainage installation",
            stockUom: "lm",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
      ],
    },
  });

  const priceRefs = breakdown.commercialLines[0].trace.references
    .filter((entry) => entry.type === "authority_price_record");
  assert.equal(priceRefs.length, 2);
  assert.equal(priceRefs[0].itemCode, "drainage");
  assert.equal(priceRefs[0].priceList, "Standard Buying");
  assert.equal(priceRefs[1].priceList, "Standard Selling");
  // Verify no internal Docker URL leaks into serialized references
  const serialized = JSON.stringify(priceRefs);
  assert.ok(!serialized.includes("authority.internal.test"), "internal authority URL should not appear in price references");
});

test("price-catalog direct pass-through lines fail closed when buying rate is missing", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Drainage",
          code: "drainage",
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          unitCost: null,
          unitPrice: 145,
          totalPrice: 1740,
          rationale: "Drainage run required.",
        },
      ],
    },
    quoteCatalog: {
      commercialAuthority: {
        provider: "price_catalog",
      },
      rules: [
        {
          code: "drainage",
          label: "Drainage installation",
          unit: "lm",
          authorityPricing: {
            buyingRate: null,
            sellingRate: 145,
            itemCode: "DRAINAGE-INSTALL",
            itemName: "Drainage installation",
            stockUom: "lm",
            itemGroup: "Services",
            isStockItem: false,
            missingItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.ready, false);
  assert.equal(breakdown.commercialLines.length, 0);
  assert.equal(breakdown.budgetLines.length, 0);
  assert.equal(breakdown.pricingIssues.length, 1);
  assert.match(breakdown.pricingIssues[0].reason, /buying rate/i);
});

test("direct lawn bundle stays pass-through but records Sandy Loam order volume with allowance", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Front Yard",
          code: "front-lawn",
          quoteCatalogItemCode: "lawn-supply-prep-install",
          label: "Front lawn",
          quantity: 77,
          unit: "m2",
          unitPrice: 53.5,
          totalPrice: 4119.5,
          rationale: "Front lawn with sandy loam at 100 mm depth, preparation, and turf.",
        },
      ],
    },
    recipePricing,
    quoteCatalog: {
      quantityRules: SAMPLE.quantityRules,
      assemblies: SAMPLE.assemblies,
      rules: [
        {
          code: "lawn-supply-prep-install",
          label: "Lawn supply, prep, and install",
          unit: "m2",
          authorityPricing: {
            buyingRate: 44.58,
            sellingRate: 53.5,
            itemCode: "lawn-supply-prep-install",
            itemName: "Lawn supply, prep, and install",
            stockUom: "m2",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.commercialLines.length, 1);
  assert.equal(breakdown.commercialLines[0].itemCode, "lawn-supply-prep-install");
  assert.equal(breakdown.materialOrders.length, 2);
  assert.deepEqual(
    breakdown.materialOrders.map((order) => order.itemCode),
    ["TURF-SUPPLY-M2", "SANDY-LOAM-M3"]
  );
  assert.equal(breakdown.materialOrders.find((order) => order.itemCode === "TURF-SUPPLY-M2")?.quantity, 77);
  const loamOrder = breakdown.materialOrders.find((order) => order.itemCode === "SANDY-LOAM-M3");
  assert.equal(loamOrder?.quantity, 9.24);
  assert.equal(loamOrder?.unitCost, 66.75);
  assert.equal(loamOrder?.unitPrice, 90);
  assert.match(loamOrder?.description || "", /order allowance 20%/i);
});

test("drainage bundle compiles trench+pit buildup when the line item scope mentions pits", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Drainage",
          code: "drainage",
          quoteCatalogItemCode: "drainage",
          label: "Drainage run with stormwater pits",
          quantity: 24,
          unit: "lm",
          unitPrice: 150,
          totalPrice: 3600,
          rationale: "24 lm drainage trench with 3 stormwater pits and gravel backfill.",
        },
      ],
    },
    quoteCatalog: SAMPLE,
    recipePricing,
  });

  assert.equal(breakdown.commercialLines.length, 8);
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    [
      "DRAIN-PIPE-M",
      "DRAIN-PIT",
      "DRAIN-GRAVEL-M",
      "clean-fill-disposal",
      "EXCAVATOR-HOUR",
      "LABOURER-HOUR",
      "VEHICLE-HOUR",
      "ADMIN-FEE",
    ]
  );
  const pipe = breakdown.commercialLines.find((line) => line.itemCode === "DRAIN-PIPE-M");
  assert.equal(pipe.quantity, 24);
  assert.equal(pipe.unitCost, 14);
  assert.equal(pipe.unitPrice, 22);
  const pit = breakdown.commercialLines.find((line) => line.itemCode === "DRAIN-PIT");
  assert.equal(pit.quantity, 3);
  assert.equal(pit.unitCost, 95);
  assert.equal(pit.unitPrice, 145);
  const excavator = breakdown.commercialLines.find((line) => line.itemCode === "EXCAVATOR-HOUR");
  assert.ok(excavator.quantity > 0);
  const labour = breakdown.commercialLines.find((line) => line.itemCode === "LABOURER-HOUR");
  assert.ok(labour.quantity > 0);
  assert.equal(breakdown.commercialLines.find((line) => line.itemCode === "ADMIN-FEE")?.unitPrice, 300);
  assert.deepEqual(
    breakdown.materialOrders.map((order) => order.itemCode).sort(),
    ["DRAIN-GRAVEL-M", "DRAIN-PIPE-M", "DRAIN-PIT"]
  );
  // Residual delivery vehicle hours absorb the rest of the line price so the
  // commercial breakdown always sums back to the source line total.
  assert.equal(breakdown.commercialLines[0].customerVisible, false);
});

test("drainage without trench+pit scope still falls through to direct pass-through", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      quoteCatalog: {
        commercialAuthority: {
          provider: "price_catalog",
          baseUrl: "https://authority.example.test",
        },
      },
      lineItems: [
        {
          section: "Drainage",
          code: "drainage",
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          unitPrice: 145,
          totalPrice: 1740,
          rationale: "Drainage run scoped on site.",
        },
      ],
    },
    quoteCatalog: {
      rules: [
        {
          code: "drainage",
          label: "Drainage installation",
          unit: "lm",
          authorityPricing: {
            buyingRate: 102,
            sellingRate: 145,
            itemCode: "drainage",
            itemName: "Drainage installation",
            stockUom: "lm",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.commercialLines.length, 1);
  assert.equal(breakdown.commercialLines[0].itemCode, "drainage");
  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "direct_pass_through");
});

test("drainage bundle also fires for explicit soakwell and ag-pipe scope text", () => {
  for (const rationale of [
    "Install 2 soakwells on 24m stormwater run.",
    "24 lm ag pipe with gravel backfill.",
  ]) {
    const breakdown = compileQuoteCommercialBreakdown({
      quote: {
        lineItems: [
          {
            section: "Drainage",
            code: "drainage",
            quoteCatalogItemCode: "drainage",
            label: "Explicit drainage scope",
            quantity: 24,
            unit: "lm",
            unitPrice: 150,
            totalPrice: 3600,
            rationale,
          },
        ],
      },
      quoteCatalog: SAMPLE,
      recipePricing,
    });

    assert.equal(breakdown.lineItemBreakdowns[0].recipe, "drainage_bundle");
    assert.deepEqual(
      breakdown.commercialLines.map((line) => line.itemCode),
      [
        "DRAIN-PIPE-M",
        "DRAIN-PIT",
        "DRAIN-GRAVEL-M",
        "clean-fill-disposal",
        "EXCAVATOR-HOUR",
        "LABOURER-HOUR",
        "VEHICLE-HOUR",
        "ADMIN-FEE",
      ]
    );
  }
});

test("imported fill direct lines emit a material order without changing the sales line", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Back Yard",
          code: "fill-back-yard",
          quoteCatalogItemCode: "imported-fill",
          label: "Imported fill",
          quantity: 12,
          unit: "m3",
          unitPrice: 120,
          totalPrice: 1440,
          rationale: "Import 12 cubic metres of topping soil.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "imported-fill-demand",
          stage: "line_item",
          mode: "direct_material_order",
          appliesToRuleCodes: ["imported-fill"],
          outputItemCode: "imported-fill",
          outputLabel: "Imported Fill",
          outputUnit: "m3",
        },
      ],
      rules: [
        {
          code: "imported-fill",
          label: "Imported fill / topping",
          unit: "m3",
          authorityPricing: {
            buyingRate: 100,
            sellingRate: 120,
            itemCode: "imported-fill",
            itemName: "Imported fill / topping",
            stockUom: "m3",
            itemGroup: "Raw Material",
            isStockItem: true,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.commercialLines.length, 1);
  assert.equal(breakdown.commercialLines[0].itemCode, "imported-fill");
  assert.equal(breakdown.materialOrders.length, 1);
  assert.equal(breakdown.materialOrders[0].itemCode, "imported-fill");
  assert.equal(breakdown.materialOrders[0].quantity, 12);
});

test("concrete surface demolition compiles into excavator and jackhammer recipe lines", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Concrete demolition",
          code: "shed-slab-demo",
          quoteCatalogItemCode: "concrete-surface-demolition",
          label: "Shed slab surface demolition",
          quantity: 18.7,
          unit: "m2",
          unitPrice: 36.67,
          totalPrice: 685.73,
          rationale: "3.4 m x 5.5 m shed slab. Concrete surface demolition up to 100 mm depth at 15 m2/hour using excavator and jackhammer.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "concrete-surface-demolition-recipe",
          stage: "line_item",
          mode: "concrete_surface_demolition",
          appliesToRuleCodes: ["concrete-surface-demolition"],
          areaPerHour: 15,
          maxDepthMm: 100,
          componentRuleCodes: ["excavator-hour", "jackhammer-hour"],
        },
      ],
      rules: [
        {
          code: "concrete-surface-demolition",
          label: "Concrete surface demolition",
          unit: "m2",
          authorityPricing: {
            buyingRate: 22,
            sellingRate: 36.67,
            itemCode: "concrete-surface-demolition",
            itemName: "Concrete Surface Demolition",
            stockUom: "m2",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "excavator-hour",
          label: "Excavator hour (incl. operator)",
          unit: "hour",
          authorityPricing: {
            buyingRate: 180,
            sellingRate: 300,
            itemCode: "EXCAVATOR-HOUR",
            itemName: "Excavator Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "jackhammer-hour",
          label: "Jackhammer hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 150,
            sellingRate: 250,
            itemCode: "JACKHAMMER-HOUR",
            itemName: "Jackhammer Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "concrete_surface_demolition");
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["EXCAVATOR-HOUR", "JACKHAMMER-HOUR"]
  );
  assert.equal(breakdown.commercialLines[0].quantity, 1.2467);
  assert.equal(breakdown.commercialLines[1].quantity, 1.2467);
  assert.equal(breakdown.commercialLines[0].unitPrice, 300);
  assert.equal(breakdown.commercialLines[1].unitPrice, 250);
  assert.equal(breakdown.budgetLines[0].unitPrice, 180);
  assert.equal(breakdown.budgetLines[1].unitPrice, 150);
  assert.equal(breakdown.totals.charge, 685.68);
  assert.equal(breakdown.totals.cost, 411.42);
});

test("concrete structure demolition compiles into excavator and jackhammer recipe lines", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Concrete demolition",
          code: "retaining-wall-demo",
          quoteCatalogItemCode: "concrete-structure-demolition",
          label: "Concrete retaining wall structure demolition",
          quantity: 10.65,
          unit: "m2",
          unitPrice: 78.57,
          totalPrice: 836.77,
          rationale: "Wall areas are 6.9 m2 + 1.5 m2 + 2.25 m2 = 10.65 m2. Concrete structure demolition up to 300 mm thickness at 7 m2/hour using excavator and jackhammer.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "concrete-structure-demolition-recipe",
          stage: "line_item",
          mode: "concrete_structure_demolition",
          appliesToRuleCodes: ["concrete-structure-demolition"],
          areaPerHour: 7,
          maxDepthMm: 300,
          componentRuleCodes: ["excavator-hour", "jackhammer-hour"],
        },
      ],
      rules: [
        {
          code: "concrete-structure-demolition",
          label: "Concrete structure demolition",
          unit: "m2",
          authorityPricing: {
            buyingRate: 47.14,
            sellingRate: 78.57,
            itemCode: "concrete-structure-demolition",
            itemName: "Concrete Structure Demolition",
            stockUom: "m2",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "excavator-hour",
          label: "Excavator hour (incl. operator)",
          unit: "hour",
          authorityPricing: {
            buyingRate: 180,
            sellingRate: 300,
            itemCode: "EXCAVATOR-HOUR",
            itemName: "Excavator Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "jackhammer-hour",
          label: "Jackhammer hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 150,
            sellingRate: 250,
            itemCode: "JACKHAMMER-HOUR",
            itemName: "Jackhammer Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "concrete_structure_demolition");
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["EXCAVATOR-HOUR", "JACKHAMMER-HOUR"]
  );
  assert.equal(breakdown.commercialLines[0].quantity, 1.5214);
  assert.equal(breakdown.commercialLines[1].quantity, 1.5214);
  assert.equal(breakdown.commercialLines[0].unitPrice, 300);
  assert.equal(breakdown.commercialLines[1].unitPrice, 250);
  assert.equal(breakdown.budgetLines[0].unitPrice, 180);
  assert.equal(breakdown.budgetLines[1].unitPrice, 150);
  assert.equal(breakdown.totals.charge, 836.77);
  assert.equal(breakdown.totals.cost, 502.06);
});

test("site levelling compiles into default cut/fill machine hours", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Shed area levelling",
          code: "shed-levelling",
          quoteCatalogItemCode: "site-levelling",
          label: "Site levelling and cut",
          quantity: 25.86,
          unit: "m3",
          unitPrice: 131.25,
          totalPrice: 3394.13,
          rationale: "Measured shed area cut volume.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "site-levelling-recipe",
          stage: "line_item",
          mode: "volume_excavation",
          appliesToRuleCodes: ["site-levelling"],
          cutRatio: 0.75,
          fillRatio: 0.25,
          cutVolumePerHour: 2,
          fillVolumePerHour: 2,
          cutRuleCode: "excavator-hour",
          fillRuleCode: "mini-loader-hour",
        },
      ],
      rules: [
        {
          code: "site-levelling",
          label: "Site levelling and cut",
          unit: "m3",
          authorityPricing: {
            buyingRate: 78.75,
            sellingRate: 131.25,
            itemCode: "site-levelling",
            itemName: "Site Levelling and Cut",
            stockUom: "m3",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "excavator-hour",
          label: "Excavator hour (incl. operator)",
          unit: "hour",
          authorityPricing: {
            buyingRate: 180,
            sellingRate: 300,
            itemCode: "EXCAVATOR-HOUR",
            itemName: "Excavator Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "mini-loader-hour",
          label: "Mini loader hour (incl. operator)",
          unit: "hour",
          authorityPricing: {
            buyingRate: 90,
            sellingRate: 150,
            itemCode: "KANGA-HOUR",
            itemName: "Mini Loader Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "volume_excavation");
  assert.deepEqual(breakdown.commercialLines.map((line) => line.itemCode), ["EXCAVATOR-HOUR", "KANGA-HOUR"]);
  assert.equal(breakdown.commercialLines[0].quantity, 9.6975);
  assert.equal(breakdown.commercialLines[1].quantity, 3.2325);
  assert.equal(breakdown.commercialLines[0].unitPrice, 300);
  assert.equal(breakdown.commercialLines[1].unitPrice, 150);
  assert.equal(breakdown.budgetLines[0].unitPrice, 180);
  assert.equal(breakdown.budgetLines[1].unitPrice, 90);
  assert.equal(breakdown.totals.charge, 3394.13);
  assert.equal(breakdown.totals.cost, 2036.48);
});

test("site levelling uses Moasure cut/fill override volumes when both are present", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      measurements: [
        { label: "Shed area levelling cut volume", value: 11.68, unit: "m3" },
        { label: "Shed area levelling fill volume", value: 5.95, unit: "m3" },
        { label: "Shed area levelling level", value: -384, unit: "mm" },
      ],
      lineItems: [
        {
          section: "Shed area levelling",
          code: "shed-levelling",
          quoteCatalogItemCode: "site-levelling",
          label: "Site levelling and cut",
          quantity: 17.63,
          unit: "m3",
          unitPrice: 124.69,
          totalPrice: 2198.25,
          rationale: "Moasure cut/fill volumes supplied.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "site-levelling-recipe",
          stage: "line_item",
          mode: "volume_excavation",
          appliesToRuleCodes: ["site-levelling"],
          cutRatio: 0.75,
          fillRatio: 0.25,
          cutVolumePerHour: 2,
          fillVolumePerHour: 2,
          cutRuleCode: "excavator-hour",
          fillRuleCode: "mini-loader-hour",
        },
      ],
      rules: [
        {
          code: "site-levelling",
          label: "Site levelling and cut",
          unit: "m3",
          authorityPricing: {
            buyingRate: 78.75,
            sellingRate: 131.25,
            itemCode: "site-levelling",
            itemName: "Site Levelling and Cut",
            stockUom: "m3",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "excavator-hour",
          label: "Excavator hour (incl. operator)",
          unit: "hour",
          authorityPricing: {
            buyingRate: 180,
            sellingRate: 300,
            itemCode: "EXCAVATOR-HOUR",
            itemName: "Excavator Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "mini-loader-hour",
          label: "Mini loader hour (incl. operator)",
          unit: "hour",
          authorityPricing: {
            buyingRate: 90,
            sellingRate: 150,
            itemCode: "KANGA-HOUR",
            itemName: "Mini Loader Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "volume_excavation");
  assert.deepEqual(breakdown.commercialLines.map((line) => line.itemCode), ["EXCAVATOR-HOUR", "KANGA-HOUR"]);
  assert.equal(breakdown.commercialLines[0].quantity, 5.84);
  assert.equal(breakdown.commercialLines[1].quantity, 2.975);
  assert.equal(breakdown.totals.charge, 2198.25);
  assert.equal(breakdown.totals.cost, 1318.95);
});

test("soil removal compiles into mini loader and unclean fill disposal recipe lines", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Shed area levelling",
          code: "soil-removal-line",
          quoteCatalogItemCode: "soil-removal",
          label: "Soil removal and disposal",
          quantity: 10,
          unit: "m3",
          unitPrice: 91.89,
          totalPrice: 918.9,
          rationale: "Unclean fill disposal with mini loader loading.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "soil-removal-recipe",
          stage: "line_item",
          mode: "bulk_loading_disposal",
          appliesToRuleCodes: ["soil-removal"],
          densityTonnesPerM3: 1.6,
          truckMassCapacityTonnes: 3.5,
          truckVolumeCapacityM3: 2.1875,
          loadingHoursPerLoad: 0.5,
          loaderRuleCode: "mini-loader-hour",
          disposalRuleCode: "unclean-fill-disposal",
        },
      ],
      rules: [
        {
          code: "soil-removal",
          label: "Soil removal and disposal",
          unit: "m3",
          authorityPricing: {
            buyingRate: 68.57,
            sellingRate: 91.89,
            itemCode: "soil-removal",
            itemName: "Soil Removal and Disposal",
            stockUom: "m3",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "mini-loader-hour",
          label: "Mini loader hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 90,
            sellingRate: 150,
            itemCode: "KANGA-HOUR",
            itemName: "Mini Loader Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "unclean-fill-disposal",
          label: "Unclean fill disposal",
          unit: "tonne",
          authorityPricing: {
            buyingRate: 30,
            sellingRate: 36,
            itemCode: "unclean-fill-disposal",
            itemName: "Unclean Fill Disposal",
            stockUom: "Tonne",
            itemGroup: "Site Services",
            isStockItem: false,
            pricingBasis: "per_tonne",
            pricingBasisFactor: 1.6,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "bulk_loading_disposal");
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["KANGA-HOUR", "unclean-fill-disposal"]
  );
  assert.equal(breakdown.commercialLines[0].quantity, 2.2857);
  assert.equal(breakdown.commercialLines[1].quantity, 16);
  assert.equal(breakdown.commercialLines[1].unit, "tonne");
  assert.equal(breakdown.totals.charge, 918.85);
  assert.equal(breakdown.totals.cost, 685.71);
  assert.ok(
    breakdown.commercialLines[1].trace.quantityDerivation.some(
      (entry) => /per_tonne/.test(entry.expression) && /1\.6 t\/m3/.test(entry.expression)
    ),
    "disposal trace should name the per_tonne basis and its density factor",
  );
  // Anti-regression — see the per_load test for why this matters.
  assert.equal(
    breakdown.commercialLines[1].quantity,
    resolveDisposalBilledQuantity({ pricingBasis: "per_tonne", pricingBasisFactor: 1.6, volumeM3: 10 }),
  );
});

test("disposal billable quantity bills per_m3 directly from measured volume when the item's basis is per_m3", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Shed area levelling",
          code: "soil-removal-line",
          quoteCatalogItemCode: "soil-removal",
          label: "Soil removal and disposal",
          quantity: 10,
          unit: "m3",
          unitPrice: 91.89,
          totalPrice: 918.9,
          rationale: "Volume-billed disposal with mini loader loading.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "soil-removal-recipe",
          stage: "line_item",
          mode: "bulk_loading_disposal",
          appliesToRuleCodes: ["soil-removal"],
          densityTonnesPerM3: 1.6,
          truckMassCapacityTonnes: 3.5,
          truckVolumeCapacityM3: 2.1875,
          loadingHoursPerLoad: 0.5,
          loaderRuleCode: "mini-loader-hour",
          disposalRuleCode: "volume-fill-disposal",
        },
      ],
      rules: [
        {
          code: "soil-removal",
          label: "Soil removal and disposal",
          unit: "m3",
          authorityPricing: {
            buyingRate: 68.57,
            sellingRate: 91.89,
            itemCode: "soil-removal",
            itemName: "Soil Removal and Disposal",
            stockUom: "m3",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "mini-loader-hour",
          label: "Mini loader hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 90,
            sellingRate: 150,
            itemCode: "KANGA-HOUR",
            itemName: "Mini Loader Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "volume-fill-disposal",
          label: "Volume fill disposal",
          unit: "m3",
          authorityPricing: {
            buyingRate: 20,
            sellingRate: 25,
            itemCode: "volume-fill-disposal",
            itemName: "Volume Fill Disposal",
            stockUom: "m3",
            itemGroup: "Site Services",
            isStockItem: false,
            pricingBasis: "per_m3",
            pricingBasisFactor: null,
          },
        },
      ],
    },
  });

  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["KANGA-HOUR", "volume-fill-disposal"]
  );
  assert.equal(breakdown.commercialLines[1].quantity, 10);
  assert.equal(breakdown.commercialLines[1].unit, "m3");
  assert.ok(
    breakdown.commercialLines[1].trace.quantityDerivation.some((entry) => /per_m3/.test(entry.expression)),
    "disposal trace should name the per_m3 basis",
  );
  // Anti-regression — see the per_load test for why this matters.
  assert.equal(
    breakdown.commercialLines[1].quantity,
    resolveDisposalBilledQuantity({ pricingBasis: "per_m3", pricingBasisFactor: null, volumeM3: 10 }),
  );
});

test("disposal billable quantity bills whole loads, rounded up, when the item's basis is per_load", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Shed area levelling",
          code: "soil-removal-line",
          quoteCatalogItemCode: "soil-removal",
          label: "Soil removal and disposal",
          quantity: 10,
          unit: "m3",
          unitPrice: 91.89,
          totalPrice: 918.9,
          rationale: "Load-billed disposal with mini loader loading.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "soil-removal-recipe",
          stage: "line_item",
          mode: "bulk_loading_disposal",
          appliesToRuleCodes: ["soil-removal"],
          densityTonnesPerM3: 1.6,
          truckMassCapacityTonnes: 3.5,
          truckVolumeCapacityM3: 2.1875,
          loadingHoursPerLoad: 0.5,
          loaderRuleCode: "mini-loader-hour",
          disposalRuleCode: "skip-bin-disposal",
        },
      ],
      rules: [
        {
          code: "soil-removal",
          label: "Soil removal and disposal",
          unit: "m3",
          authorityPricing: {
            buyingRate: 68.57,
            sellingRate: 91.89,
            itemCode: "soil-removal",
            itemName: "Soil Removal and Disposal",
            stockUom: "m3",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "mini-loader-hour",
          label: "Mini loader hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 90,
            sellingRate: 150,
            itemCode: "KANGA-HOUR",
            itemName: "Mini Loader Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "skip-bin-disposal",
          label: "Skip bin disposal",
          unit: "load",
          authorityPricing: {
            buyingRate: 100,
            sellingRate: 130,
            itemCode: "skip-bin-disposal",
            itemName: "Skip Bin Disposal",
            stockUom: "Load",
            itemGroup: "Site Services",
            isStockItem: false,
            pricingBasis: "per_load",
            pricingBasisFactor: 2.1875,
          },
        },
      ],
    },
  });

  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["KANGA-HOUR", "skip-bin-disposal"]
  );
  // 10 m3 / 2.1875 m3 per load = 4.5714 loads, rounded up to 5 whole loads.
  assert.equal(breakdown.commercialLines[1].quantity, 5);
  assert.equal(breakdown.commercialLines[1].unit, "load");
  assert.equal(breakdown.commercialLines[1].totalPrice, 650);
  assert.ok(
    breakdown.commercialLines[1].trace.quantityDerivation.some(
      (entry) => /per_load/.test(entry.expression) && /rounded up/.test(entry.expression)
    ),
    "disposal trace should name the per_load basis and note the rounding",
  );

  // Anti-regression: the live quote engine (server/quote-quantity-rules.js)
  // must delegate the conversion arithmetic to shared/disposal-basis.js rather
  // than re-deriving it. Pin the quote engine's output against the shared
  // module's own independently-invoked result for the identical inputs
  // (including the fractional-loads ceiling case) — if a duplicate is
  // reintroduced with different rounding, this fails even though the
  // hardcoded "5" assertion above would not catch a subtly different bug.
  assert.equal(
    breakdown.commercialLines[1].quantity,
    resolveDisposalBilledQuantity({ pricingBasis: "per_load", pricingBasisFactor: 2.1875, volumeM3: 10 }),
  );
});

test("soil removal recipe keeps loading on gross cut and disposal on net export volume", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Regrade",
          code: "soil-removal-line",
          quoteCatalogItemCode: "soil-removal",
          label: "Soil removal and disposal",
          quantity: 30,
          unit: "m3",
          unitPrice: 68.85,
          totalPrice: 2065.37,
          rationale: "30 m3 cut, 12 m3 retained as fill, 18 m3 removed from site.",
          bulkRemovalInputs: {
            grossCutVolumeM3: 30,
            fillVolumeM3: 12,
            disposalVolumeM3: 18,
            netVolumeM3: 18,
          },
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "soil-removal-recipe",
          stage: "line_item",
          mode: "bulk_loading_disposal",
          appliesToRuleCodes: ["soil-removal"],
          densityTonnesPerM3: 1.6,
          truckMassCapacityTonnes: 3.5,
          truckVolumeCapacityM3: 2.1875,
          loadingHoursPerLoad: 0.5,
          loaderRuleCode: "mini-loader-hour",
          disposalRuleCode: "unclean-fill-disposal",
        },
      ],
      rules: [
        {
          code: "soil-removal",
          label: "Soil removal and disposal",
          unit: "m3",
          authorityPricing: {
            buyingRate: 68.57,
            sellingRate: 91.89,
            itemCode: "soil-removal",
            itemName: "Soil Removal and Disposal",
            stockUom: "m3",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "mini-loader-hour",
          label: "Mini loader hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 90,
            sellingRate: 150,
            itemCode: "KANGA-HOUR",
            itemName: "Mini Loader Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "unclean-fill-disposal",
          label: "Unclean fill disposal",
          unit: "tonne",
          authorityPricing: {
            buyingRate: 30,
            sellingRate: 36,
            itemCode: "unclean-fill-disposal",
            itemName: "Unclean Fill Disposal",
            stockUom: "Tonne",
            itemGroup: "Site Services",
            isStockItem: false,
            pricingBasis: "per_tonne",
            pricingBasisFactor: 1.6,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "bulk_loading_disposal");
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["KANGA-HOUR", "unclean-fill-disposal"]
  );
  assert.equal(breakdown.commercialLines[0].quantity, 6.8571);
  assert.equal(breakdown.commercialLines[1].quantity, 28.8);
});

test("tip truck haulage compiles into vehicle hours and kilometres", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Soil haulage",
          code: "soil-haulage",
          quoteCatalogItemCode: "tip-truck",
          label: "Tip truck haulage",
          quantity: 5,
          unit: "load",
          unitPrice: 106.2,
          totalPrice: 531,
          rationale: "Five return trips to the default dump.",
        },
      ],
    },
    details: {
      soilDump: {
        name: "Adelaide Hills Recycling",
        dist: 19.5,
        drive: 30,
      },
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "tip-truck-haulage-recipe",
          stage: "line_item",
          mode: "haulage_trip",
          appliesToRuleCodes: ["tip-truck"],
          vehicleHourRuleCode: "vehicle-hour",
          vehicleKmRuleCode: "vehicle-km",
        },
      ],
      rules: [
        {
          code: "tip-truck",
          label: "Tip truck haulage",
          unit: "load",
          authorityPricing: {
            buyingRate: null,
            sellingRate: 240,
            itemCode: "tip-truck",
            itemName: "Tip Truck Haulage",
            stockUom: "Load",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "vehicle-hour",
          label: "Vehicle / truck hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 45,
            sellingRate: 75,
            itemCode: "VEHICLE-HOUR",
            itemName: "Vehicle Hour",
            stockUom: "Hour",
            itemGroup: "Site Services",
            isStockItem: false,
          },
        },
        {
          code: "vehicle-km",
          label: "Vehicle kilometre",
          unit: "km",
          authorityPricing: {
            buyingRate: 0.8,
            sellingRate: 0.8,
            itemCode: "VEHICLE-KM",
            itemName: "Vehicle Kilometre",
            stockUom: "km",
            itemGroup: "Site Services",
            isStockItem: false,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "haulage_trip");
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["VEHICLE-HOUR", "VEHICLE-KM"]
  );
  assert.equal(breakdown.commercialLines[0].quantity, 5);
  assert.equal(breakdown.commercialLines[1].quantity, 195);
  assert.equal(breakdown.totals.charge, 531);
  assert.equal(breakdown.totals.cost, 381);
});

test("concrete removal compiles into mini loader loading and concrete disposal lines", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Concrete removal",
          code: "concrete-removal-line",
          quoteCatalogItemCode: "concrete-removal",
          label: "Concrete removal and disposal",
          quantity: 5.065,
          unit: "m3",
          unitPrice: 217.79,
          totalPrice: 1103.11,
          rationale: "Load out and dispose of demolished concrete.",
        },
      ],
    },
    quoteCatalog: {
      quantityRules: [
        {
          code: "concrete-removal-recipe",
          stage: "line_item",
          mode: "bulk_loading_disposal",
          appliesToRuleCodes: ["concrete-removal"],
          densityTonnesPerM3: 2.6,
          truckMassCapacityTonnes: 3,
          truckVolumeCapacityM3: 1.15,
          loadingHoursPerLoad: 1,
          loaderRuleCode: "mini-loader-hour",
          disposalRuleCode: "concrete-waste-disposal",
        },
      ],
      rules: [
        {
          code: "concrete-removal",
          label: "Concrete removal and disposal",
          unit: "m3",
          authorityPricing: {
            buyingRate: 151.06,
            sellingRate: 217.79,
            itemCode: "concrete-removal",
            itemName: "Concrete Removal and Disposal",
            stockUom: "m3",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "mini-loader-hour",
          label: "Mini loader hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 90,
            sellingRate: 150,
            itemCode: "KANGA-HOUR",
            itemName: "Mini Loader Hour",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
        {
          code: "concrete-waste-disposal",
          label: "Concrete waste disposal",
          unit: "tonne",
          authorityPricing: {
            buyingRate: 28,
            sellingRate: 33.6,
            itemCode: "concrete-waste-disposal",
            itemName: "Concrete Waste Disposal",
            stockUom: "Tonne",
            itemGroup: "Site Services",
            isStockItem: false,
            pricingBasis: "per_tonne",
            pricingBasisFactor: 2.6,
          },
        },
      ],
    },
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "bulk_loading_disposal");
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["KANGA-HOUR", "concrete-waste-disposal"]
  );
  assert.equal(breakdown.commercialLines[0].quantity, 4.4043);
  assert.equal(breakdown.commercialLines[1].quantity, 13.169);
  assert.equal(breakdown.totals.charge, 1103.13);
  assert.equal(breakdown.totals.cost, 765.12);
});

test("accepted option selections make the quote handoff-ready and switch the active scenario", () => {
  const quote = applyQuoteCommercialBreakdownToQuote({
    quote: {
      lineItems: [
        {
          section: "Irrigation Supply & Install — Select One",
          code: "irrigation-option-1",
          label: "Option 1: Battery System",
          quantity: 1,
          unit: "lot",
          unitPrice: 1646,
          totalPrice: 1646,
          rationale: "Battery controller (~$500 cost, 20% markup = $600) + fixings & pipe (23 m² at $10/m² = $230).",
        },
        {
          section: "Irrigation Supply & Install — Select One",
          code: "irrigation-option-2",
          label: "Option 2: Mains System",
          quantity: 1,
          unit: "lot",
          unitPrice: 1896,
          totalPrice: 1896,
          rationale: "Mains controller and solenoid setup with control unit install.",
        },
      ],
      quoteCatalog: {
        gstRate: 0.1,
      },
      totals: {
        subtotal: 1896,
        gst: 189.6,
        total: 2085.6,
        currency: "AUD",
      },
    },
    acceptedOptionSelections: {
      "option-family-irrigation-supply-install-1": "irrigation-option-1",
    },
    quoteCatalog: SAMPLE,
    recipePricing,
  });

  assert.equal(quote.selectionState.handoffReady, true);
  assert.equal(quote.selectionState.invoiceReady, true);
  assert.equal(quote.selectionState.acceptedSelections.length, 1);
  assert.equal(quote.selectionState.activeSelections[0].optionCode, "irrigation-option-1");
  assert.equal(
    quote.commercialLines.some((line) => line.itemCode === "IRRIGATION-CONTROLLER-BATTERY"),
    true
  );
  assert.match(quote.totals._note, /accepted selections/i);
});

test("recipe components are priced from the price catalogue, never from built-in rates", () => {
  // Catalogue rates that differ from the fixture defaults; the mains
  // controller is not in the catalogue at all (the battery option does not
  // need it).
  const catalogueRecipePricing = buildTestRecipePricing({
    prices: {
      "LABOURER-HOUR": [50, 85],
      "ADMIN-FEE": [220, 330],
      "VEHICLE-HOUR": [55, 95],
      "IRRIGATION-CONTROLLER-BATTERY": [550, 660],
      "IRRIGATION-PIPE-FIXINGS-M2": [9, 11],
      "TURF-SUPPLY-M2": [20, 25],
      "SANDY-LOAM-M3": [70, 95],
    },
  });

  const quote = applyQuoteCommercialBreakdownToQuote({
    quote: {
      lineItems: [
        {
          section: "Irrigation Supply & Install — Select One",
          code: "irrigation-option-1",
          label: "Option 1: Battery System",
          quantity: 1,
          unit: "lot",
          unitPrice: 1800,
          totalPrice: 1800,
          rationale: "Battery controller + fixings & pipe (23 m² at $11/m²).",
        },
        {
          section: "Lawn Supply & Install — Select One Variety",
          code: "lawn-option-1",
          label: "Option 1: Prestige Buffalo",
          quantity: 1,
          unit: "lot",
          unitPrice: 1800,
          totalPrice: 1800,
          rationale: "23 m² Prestige Buffalo ($20/m² supply, charged at $25/m²).",
        },
      ],
      totals: { subtotal: 3600 },
    },
    quoteCatalog: SAMPLE,
    recipePricing: catalogueRecipePricing,
  });

  const irrigationLines = quote.internalPricing.lineItemBreakdowns[0].commercialLines;
  const lawnLines = quote.internalPricing.lineItemBreakdowns[1].commercialLines;

  // Battery controller should use price catalog rate ($660)
  const controller = irrigationLines.find((l) => l.itemCode === "IRRIGATION-CONTROLLER-BATTERY");
  assert.equal(controller.unitPrice, 660);

  // Pipe fixings should use price catalog rate ($11/m2)
  const fixings = irrigationLines.find((l) => l.itemCode === "IRRIGATION-PIPE-FIXINGS-M2");
  assert.equal(fixings.unitPrice, 11);

  // Labour should use price catalog rate ($85/hr)
  const labourLine = irrigationLines.find((l) => l.itemCode === "LABOURER-HOUR");
  assert.equal(labourLine.unitPrice, 85);

  // Admin share should use price catalog rate ($330)
  const adminLine = irrigationLines.find((l) => l.itemCode === "ADMIN-FEE");
  assert.equal(adminLine.unitPrice, 330);
  assert.equal(adminLine.unitCost, 220);

  // Turf should use price catalog rate ($25/m2)
  const turf = lawnLines.find((l) => l.itemCode === "TURF-SUPPLY-M2");
  assert.equal(turf.unitPrice, 25);
  const loamOrder = quote.internalPricing.lineItemBreakdowns[1].materialOrders.find((order) => order.itemCode === "SANDY-LOAM-M3");
  assert.equal(loamOrder.itemCode, "SANDY-LOAM-M3");
  assert.equal(loamOrder.unitCost, 70);
  assert.equal(loamOrder.unitPrice, 95);

  // Lawn admin share should also use price catalog rates
  const lawnAdmin = lawnLines.find((l) => l.itemCode === "ADMIN-FEE");
  assert.equal(lawnAdmin.unitPrice, 330);
  assert.equal(lawnAdmin.unitCost, 220);
});

// --- supply_install_bundle decomposition tests ---

function buildSupplyInstallQuoteCatalog({ quantityRules, rules }) {
  return { quantityRules, rules };
}

test("tree-supply-install decomposes into tree stock + labour + vehicle hours", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Planting",
          code: "trees-1",
          quoteCatalogItemCode: "tree-supply-install",
          label: "Trees — Supply & Install",
          quantity: 6,
          unit: "tree",
          unitPrice: 437.5,
          totalPrice: 2625,
        },
      ],
    },
    quoteCatalog: buildSupplyInstallQuoteCatalog({
      quantityRules: [
        {
          code: "tree-supply-install-recipe",
          stage: "line_item",
          mode: "supply_install_bundle",
          appliesToRuleCodes: ["tree-supply-install"],
          labourRuleCode: "labourer-hour",
          machineRuleCode: "vehicle-hour",
        },
      ],
      rules: [
        {
          code: "tree-supply-install",
          label: "Tree supply and install",
          unit: "tree",
          unitPrice: 437.5,
          execution: { labourHoursPerUnit: 0.35, machineHoursPerUnit: 0.08 },
          authorityPricing: {
            buyingRate: 437.5,
            sellingRate: 437.5,
            itemCode: "tree-supply-install",
            itemName: "Trees — Supply & Install",
            stockUom: "Tree",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "tree-supply-install__stock-materials",
          label: "Tree stock",
          unit: "tree",
          authorityPricing: {
            itemCode: "tree-supply-install__stock-materials",
            itemName: "Tree supply and install — Plant Stock",
            stockUom: "Tree",
            itemGroup: "Raw Material",
            isStockItem: true,
            buyingRate: null,
            sellingRate: null,
          },
        },
        {
          code: "labourer-hour",
          label: "General Labourer Hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 50,
            sellingRate: 80,
            itemCode: "LABOURER-HOUR",
            itemName: "General Labourer Hour",
            stockUom: "Hour",
            itemGroup: "Labour Rates",
            isStockItem: false,
          },
        },
        {
          code: "vehicle-hour",
          label: "Vehicle/Truck Hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 45,
            sellingRate: 75,
            itemCode: "VEHICLE-HOUR",
            itemName: "Vehicle/Truck Hour",
            stockUom: "Hour",
            itemGroup: "Site Services",
            isStockItem: false,
          },
        },
      ],
    }),
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "supply_install_bundle");
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["tree-supply-install__stock-materials", "LABOURER-HOUR", "VEHICLE-HOUR"]
  );

  // Material: 437.50 - (0.35*80) - (0.08*75) = 437.50 - 28 - 6 = 403.50 per tree
  const material = breakdown.commercialLines[0];
  assert.equal(material.quantity, 6);
  assert.equal(material.unitPrice, 403.5);

  // Labour: 6 * 0.35 = 2.1 hours
  const labour = breakdown.commercialLines[1];
  assert.equal(labour.quantity, 2.1);
  assert.equal(labour.unitPrice, 80);
  assert.equal(breakdown.budgetLines[1].unitPrice, 50);

  // Machine: 6 * 0.08 = 0.48 hours
  const machine = breakdown.commercialLines[2];
  assert.equal(machine.quantity, 0.48);
  assert.equal(machine.unitPrice, 75);
  assert.equal(breakdown.budgetLines[2].unitPrice, 45);

  // Total charge should equal the original totalPrice
  assert.equal(breakdown.totals.charge, 2625);

  // Material orders should include the stock materials
  assert.ok(breakdown.materialOrders.some((o) => o.itemCode === "tree-supply-install__stock-materials"));
});

test("plant-supply-install decomposes into plant stock + labour (no machine)", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Planting",
          code: "plants-1",
          quoteCatalogItemCode: "plant-supply-install",
          label: "Plants — Supply & Install",
          quantity: 12,
          unit: "plant",
          unitPrice: 72.25,
          totalPrice: 867,
        },
      ],
    },
    quoteCatalog: buildSupplyInstallQuoteCatalog({
      quantityRules: [
        {
          code: "plant-supply-install-recipe",
          stage: "line_item",
          mode: "supply_install_bundle",
          appliesToRuleCodes: ["plant-supply-install"],
          labourRuleCode: "labourer-hour",
        },
      ],
      rules: [
        {
          code: "plant-supply-install",
          label: "Plant supply and install",
          unit: "plant",
          unitPrice: 72.25,
          execution: { labourHoursPerUnit: 0.15, machineHoursPerUnit: 0 },
          authorityPricing: {
            buyingRate: 72.25,
            sellingRate: 72.25,
            itemCode: "plant-supply-install",
            stockUom: "Plant",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "plant-supply-install__stock-materials",
          label: "Plant stock",
          unit: "plant",
          authorityPricing: {
            itemCode: "plant-supply-install__stock-materials",
            itemName: "Plant supply and install — Plant Stock",
            stockUom: "Plant",
            itemGroup: "Raw Material",
            isStockItem: true,
            buyingRate: null,
            sellingRate: null,
          },
        },
        {
          code: "labourer-hour",
          label: "General Labourer Hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 50,
            sellingRate: 80,
            itemCode: "LABOURER-HOUR",
            stockUom: "Hour",
            itemGroup: "Labour Rates",
            isStockItem: false,
          },
        },
      ],
    }),
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "supply_install_bundle");
  // No machine line — plant-supply-install has no machineRuleCode and 0 machine hours
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["plant-supply-install__stock-materials", "LABOURER-HOUR"]
  );

  // Material: 72.25 - (0.15*80) = 72.25 - 12 = 60.25 per plant
  const material = breakdown.commercialLines[0];
  assert.equal(material.quantity, 12);
  assert.equal(material.unitPrice, 60.25);

  // Labour: 12 * 0.15 = 1.8 hours
  const labour = breakdown.commercialLines[1];
  assert.equal(labour.quantity, 1.8);
  assert.equal(labour.unitPrice, 80);

  assert.equal(breakdown.totals.charge, 867);
});

test("block-edging-supply-install decomposes into edging material + labour + kanga hours", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Edging",
          code: "edging-1",
          quoteCatalogItemCode: "block-edging-supply-install",
          label: "Block edging supply and install",
          quantity: 20,
          unit: "lm",
          unitPrice: 147.5,
          totalPrice: 2950,
        },
      ],
    },
    quoteCatalog: buildSupplyInstallQuoteCatalog({
      quantityRules: [
        {
          code: "block-edging-supply-install-recipe",
          stage: "line_item",
          mode: "supply_install_bundle",
          appliesToRuleCodes: ["block-edging-supply-install"],
          labourRuleCode: "labourer-hour",
          machineRuleCode: "kanga-hour",
        },
      ],
      rules: [
        {
          code: "block-edging-supply-install",
          label: "Block edging supply and install",
          unit: "lm",
          unitPrice: 147.5,
          execution: { labourHoursPerUnit: 0.08, machineHoursPerUnit: 0.02 },
          authorityPricing: {
            buyingRate: 147.5,
            sellingRate: 147.5,
            itemCode: "block-edging-supply-install",
            stockUom: "lm",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "block-edging-supply-install__stock-materials",
          label: "Edging materials",
          unit: "lm",
          authorityPricing: {
            itemCode: "block-edging-supply-install__stock-materials",
            itemName: "Block edging supply and install — Edging Materials",
            stockUom: "lm",
            itemGroup: "Raw Material",
            isStockItem: true,
            buyingRate: null,
            sellingRate: null,
          },
        },
        {
          code: "labourer-hour",
          label: "General Labourer Hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 50,
            sellingRate: 80,
            itemCode: "LABOURER-HOUR",
            stockUom: "Hour",
            itemGroup: "Labour Rates",
            isStockItem: false,
          },
        },
        {
          code: "kanga-hour",
          label: "Mini Loader Hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 90,
            sellingRate: 150,
            itemCode: "KANGA-HOUR",
            stockUom: "Hour",
            itemGroup: "Machine Rates",
            isStockItem: false,
          },
        },
      ],
    }),
  });

  assert.equal(breakdown.lineItemBreakdowns[0].recipe, "supply_install_bundle");
  assert.deepEqual(
    breakdown.commercialLines.map((line) => line.itemCode),
    ["block-edging-supply-install__stock-materials", "LABOURER-HOUR", "KANGA-HOUR"]
  );

  // Material: 147.50 - (0.08*80) - (0.02*150) = 147.50 - 6.4 - 3 = 138.10 per lm
  const material = breakdown.commercialLines[0];
  assert.equal(material.quantity, 20);
  assert.equal(material.unitPrice, 138.1);

  // Labour: 20 * 0.08 = 1.6 hours
  const labour = breakdown.commercialLines[1];
  assert.equal(labour.quantity, 1.6);
  assert.equal(labour.unitPrice, 80);

  // Machine: 20 * 0.02 = 0.4 hours
  const machine = breakdown.commercialLines[2];
  assert.equal(machine.quantity, 0.4);
  assert.equal(machine.unitPrice, 150);
  assert.equal(breakdown.budgetLines[2].unitPrice, 90);

  assert.equal(breakdown.totals.charge, 2950);
});

test("supply_install_bundle material cost uses authority buying rate when available", () => {
  const breakdown = compileQuoteCommercialBreakdown({
    quote: {
      lineItems: [
        {
          section: "Planting",
          code: "trees-authority",
          quoteCatalogItemCode: "tree-supply-install",
          label: "Trees — Supply & Install",
          quantity: 4,
          unit: "tree",
          unitPrice: 437.5,
          totalPrice: 1750,
        },
      ],
    },
    quoteCatalog: buildSupplyInstallQuoteCatalog({
      quantityRules: [
        {
          code: "tree-supply-install-recipe",
          stage: "line_item",
          mode: "supply_install_bundle",
          appliesToRuleCodes: ["tree-supply-install"],
          labourRuleCode: "labourer-hour",
          machineRuleCode: "vehicle-hour",
        },
      ],
      rules: [
        {
          code: "tree-supply-install",
          label: "Tree supply and install",
          unit: "tree",
          unitPrice: 437.5,
          execution: { labourHoursPerUnit: 0.35, machineHoursPerUnit: 0.08 },
          authorityPricing: {
            buyingRate: 437.5,
            sellingRate: 437.5,
            itemCode: "tree-supply-install",
            stockUom: "Tree",
            itemGroup: "Services",
            isStockItem: false,
          },
        },
        {
          code: "tree-supply-install__stock-materials",
          label: "Tree stock",
          unit: "tree",
          authorityPricing: {
            itemCode: "tree-supply-install__stock-materials",
            stockUom: "Tree",
            itemGroup: "Raw Material",
            isStockItem: true,
            buyingRate: 320,
            sellingRate: null,
          },
        },
        {
          code: "labourer-hour",
          label: "General Labourer Hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 50, sellingRate: 80,
            itemCode: "LABOURER-HOUR", stockUom: "Hour",
            itemGroup: "Labour Rates", isStockItem: false,
          },
        },
        {
          code: "vehicle-hour",
          label: "Vehicle/Truck Hour",
          unit: "hour",
          authorityPricing: {
            buyingRate: 45, sellingRate: 75,
            itemCode: "VEHICLE-HOUR", stockUom: "Hour",
            itemGroup: "Site Services", isStockItem: false,
          },
        },
      ],
    }),
  });

  // Material cost should use authority buyingRate (320) instead of residual estimate
  const materialBudget = breakdown.budgetLines[0];
  assert.equal(materialBudget.unitPrice, 320);
});
