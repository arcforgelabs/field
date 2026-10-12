// Quote artifacts for the quote-row tests (#241): organizer trees in the
// shapes Field writes today (quote.presentation.organizer), with the totals
// the renderer shows worked out by hand in each comment.

const manual = (overrides) => ({
  kind: "source",
  sourceKind: "manual",
  origin: "manual",
  pricingMode: "manual",
  amountVisible: true,
  ...overrides,
});

const group = (label, children, overrides = {}) => ({
  kind: "group",
  label,
  collapsed: false,
  amountVisible: true,
  children,
  ...overrides,
});

function organizerQuote({ root, nodes, version = 1, quoteNumber = "EQ-2501-01", gstRate = 0.1, extra = {} }) {
  return {
    kind: "quote",
    version,
    quoteNumber,
    generatedAt: "2026-10-12T00:30:00.000Z",
    summary: "Retaining wall and drainage",
    quoteCatalog: { id: "sample-default", gstRate },
    totals: { currency: "AUD" },
    lineItems: [],
    presentation: { organizer: { root, nodes } },
    ...extra,
  };
}

// Retaining wall section (catalogue row 12 m x $85.50 = $1,026.00; a kit of
// 2 each added as component rows: 3 x $10 + 1 x $20 = $50 a kit, $100),
// drainage section at a fixed $500 (its pipe row 10 m x $42 = $420 is shown
// under it), a nested heading with one row ($75), and a fee with no rate
// ($150). Subtotal $1,851.00, GST $185.10, total $2,036.10.
export function sectionedQuote(overrides = {}) {
  return organizerQuote({
    root: ["group:walls", "group:drainage", "manual:fee"],
    nodes: {
      "group:walls": group("Retaining wall", ["manual:sleepers", "manual:kit", "group:extras"]),
      "manual:sleepers": manual({
        sourceCode: "manual-sleepers",
        labelOverride: "Sleepers, 200 mm",
        quantity: 12,
        unit: "m",
        sellRate: 85.5,
        buyRate: 60,
        rateMode: "catalog-linked",
        catalogItemCode: "MAT-SLEEPER-200",
        catalogItemUid: "itm_SLEEPER",
        catalogPriceId: 41,
        catalogPriceKey: "pk-sleeper",
        catalogSellRate: 85.5,
        catalogBuyRate: 60,
      }),
      "manual:kit": manual({
        sourceCode: "manual-catalog-kit-n1",
        labelOverride: "Wall bay kit",
        quantity: 2,
        unit: "each",
        sellRate: 0,
        buyRate: 0,
        rateMode: "catalog-linked",
        catalogItemUid: "itm_KIT",
        catalogPriceId: null,
        catalogPriceKey: "pk-kit",
        children: ["manual:kit-post", "manual:kit-concrete"],
      }),
      "manual:kit-post": manual({
        sourceCode: "manual-catalog-kit-post-n1-0",
        labelOverride: "Steel post",
        quantity: 3,
        unit: "each",
        sellRate: 10,
        buyRate: 6,
        rateMode: "catalog-linked",
        catalogItemUid: "itm_POST",
        catalogPriceId: 7,
        catalogComponentOf: "itm_KIT",
      }),
      "manual:kit-concrete": manual({
        sourceCode: "manual-catalog-kit-concrete-n1-1",
        labelOverride: "Concrete",
        quantity: 1,
        unit: "each",
        sellRate: 20,
        buyRate: 12,
        rateMode: "catalog-linked",
        catalogItemUid: "itm_CONCRETE",
        catalogPriceId: 8,
        catalogComponentOf: "itm_KIT",
      }),
      "group:extras": group("Extras", ["manual:capping"]),
      "manual:capping": manual({ sourceCode: "manual-capping", labelOverride: "Capping", quantity: 1, unit: "lot", sellRate: 75, buyRate: 50 }),
      "group:drainage": group("Drainage", ["manual:pipe"], { priceOverride: 500 }),
      "manual:pipe": manual({ sourceCode: "manual-pipe", labelOverride: "Ag pipe", quantity: 10, unit: "m", sellRate: 42, buyRate: 30 }),
      "manual:fee": manual({ sourceCode: "manual-fee", labelOverride: "Council fee", manualPrice: 150, manualCost: 150 }),
    },
    ...overrides,
  });
}

// Engine lines only (no organizer saved): each prints as 1 lot at its total.
// $1,200.00 + $333.30 = $1,533.30, GST $153.33, total $1,686.63.
export function engineQuote(overrides = {}) {
  return {
    kind: "quote",
    version: 1,
    quoteNumber: "EQ-2501-02",
    generatedAt: "2026-10-12T00:30:00.000Z",
    quoteCatalog: { id: "sample-default", gstRate: 0.1 },
    totals: { currency: "AUD" },
    lineItems: [
      { code: "excavation", label: "Excavation", quantity: 40, unit: "m3", unitPrice: 30, totalPrice: 1200, unitCost: 20, totalCost: 800, customerVisible: true },
      { code: "haulage", label: "Haulage", quantity: 3, unit: "load", unitPrice: 111.1, totalPrice: 333.3, unitCost: 80, totalCost: 240, customerVisible: true },
    ],
    ...overrides,
  };
}

// A row listed for information ($90, not charged), a row excluded from the
// price (not printed), and a fixed price on a row (4 m at $25 = $100, fixed
// at $120, which the PDF prints beside the $25 rate; as a line, 4 m at $30).
// Shown: $120.00 + $12.00 = $132.00.
export function listedExcludedOverrideQuote() {
  return organizerQuote({
    quoteNumber: "EQ-2501-03",
    root: ["manual:listed", "manual:excluded", "manual:fixed"],
    nodes: {
      "manual:listed": manual({ sourceCode: "manual-listed", labelOverride: "Optional turf", quantity: 3, unit: "m2", sellRate: 30, buyRate: 20, pricingContribution: "listed_only" }),
      "manual:excluded": manual({ sourceCode: "manual-excluded", labelOverride: "Removed item", quantity: 1, unit: "lot", sellRate: 999, buyRate: 0, excludedFromPrice: true }),
      "manual:fixed": manual({ sourceCode: "manual-fixed", labelOverride: "Edging", quantity: 4, unit: "m", sellRate: 25, buyRate: 15, priceOverride: 120 }),
    },
  });
}

// A fixed price on a 1-lot row: the fixed price is the rate. $480 + $48.
export function fixedLotQuote() {
  return organizerQuote({
    quoteNumber: "EQ-2501-04",
    root: ["manual:lot"],
    nodes: {
      "manual:lot": manual({ sourceCode: "manual-lot", labelOverride: "Site clean", quantity: 1, unit: "lot", sellRate: 450, buyRate: 300, priceOverride: 480 }),
    },
  });
}

// A rate with more than two decimals: 3 x $33.335 prints $33.34 a unit (the
// PDF rounds the rate) but the row's amount, $100.01, is rounded from the raw
// rate. Kept to four decimals, the rate gives the printed amount.
export function subCentRateQuote() {
  return organizerQuote({
    quoteNumber: "EQ-2501-05",
    root: ["manual:odd"],
    nodes: {
      "manual:odd": manual({ sourceCode: "manual-odd", labelOverride: "Odd rate", quantity: 3, unit: "m", sellRate: 33.335, buyRate: 20 }),
    },
  });
}

// Three rows of $10.05: GST on the subtotal ($30.15 x 10 % = $3.02, which is
// what Field does) is not the sum of GST per line (3 x $1.01 = $3.03).
export function perLineGstQuote() {
  return organizerQuote({
    quoteNumber: "EQ-2501-06",
    root: ["manual:a", "manual:b", "manual:c"],
    nodes: Object.fromEntries(["a", "b", "c"].map((id) => [`manual:${id}`, manual({ sourceCode: `manual-${id}`, labelOverride: `Row ${id}`, quantity: 1, unit: "lot", sellRate: 10.05, buyRate: 5 })])),
  });
}

// A rate whose amount today's renderer rounds in binary floating point: 3 x
// $1.005 is $3.015, which the PDF printed as $3.01 (rate printed $1.00).
// Exactly, it is $3.02; at the printed rate, $3.00. Neither gives $3.01.
export function floatRoundedLineQuote() {
  return organizerQuote({
    quoteNumber: "EQ-2501-07",
    root: ["manual:float"],
    nodes: {
      "manual:float": manual({ sourceCode: "manual-float", labelOverride: "Float rate", quantity: 3, unit: "m", sellRate: 1.005, buyRate: 0.5 }),
    },
  });
}

// GST on exactly half a cent: $21.15 at 10 % is $2.115. Exact rounding gives
// $2.12; before #2 the renderer rounded in floating point and a sent PDF
// printed $2.11 (HALF_CENT_PRINTED).
export const HALF_CENT_PRINTED = Object.freeze({ subtotal: "21.15", taxTotal: "2.11", total: "23.26" });

export function halfCentGstQuote() {
  return organizerQuote({
    quoteNumber: "EQ-2501-08",
    root: ["manual:half"],
    nodes: {
      "manual:half": manual({ sourceCode: "manual-half", labelOverride: "Half-cent GST", quantity: 1, unit: "lot", sellRate: 21.15, buyRate: 10 }),
    },
  });
}

export const FIXTURE_META = Object.freeze({
  id: "job-rows",
  title: "Smith — 1 Example Road",
  quoteNumber: "EQ-2501-01",
  contactName: "Pat Smith",
  contactEmail: "pat@example.invalid",
  siteAddress: "1 Example Road, Exampleton SA",
});
