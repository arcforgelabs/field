import { createHash } from "node:crypto";
import { DEMO_FIXTURES } from "../demo-fixtures.js";

const FIXED_DATES = [
  "2026-01-15T09:00:00.000Z",
  "2026-01-15T09:05:00.000Z",
  "2026-01-15T09:10:00.000Z",
  "2026-01-15T09:15:00.000Z",
];

// DEL-46: sanitized, fictional price-catalog items seeded via the same
// supported path any catalogue item uses (createItem(), see
// scripts/verification/reset.js) so the price catalogue is the authority for
// field-verification.json5's rules — including the three disposal rules,
// which are quoteable only when their basis and factor are set here rather
// than failing closed.
//
// Once the price-catalog database has ANY active item, Field's quote engine
// switches every rule's pricing from json5 `unitPrice` to the matching
// catalogue item (server/generate-evidence-quote.js: `erpAuthorityActive`
// gates `authorityUnitPrice` on `rule.priceCatalog`/`authorityPricing`, not
// `rule.unitPrice`, once authorityProvider !== "catalog"). Seeding only the
// three new disposal items would therefore silently strand every other
// field-verification rule as not-quoteable and change the three existing
// reviewed fixture totals. So every field-verification.json5 rule gets a
// matching item here — the ten pre-existing rules at buy/sell prices that
// reproduce their current unitPrice exactly (20% margin, matching this
// repo's existing markup convention), so fixtures 1-3's reviewed totals do
// not move, and the seven new verification-* rules (loader, three disposal
// targets, three disposal items) at fictional demo values. No client
// pricing anywhere in this list.
export const VERIFICATION_CATALOG_ITEMS = Object.freeze([
  { code: "concrete-surface-demolition", name: "Concrete surface demolition (demo)", unit: "m2", buy_price: 100, sell_price: 120, catalog_type: "goods_service", category: "Site Services" },
  { code: "tip-truck", name: "Tip-truck haulage (demo)", unit: "load", buy_price: 150, sell_price: 180, catalog_type: "goods_service", category: "Site Services" },
  { code: "imported-fill", name: "Imported fill (demo)", unit: "m3", buy_price: 70.83, sell_price: 85, catalog_type: "goods_service", category: "Site Services" },
  { code: "block-edging-supply-install", name: "Block edging supply and install (demo)", unit: "m", buy_price: 79.17, sell_price: 95, catalog_type: "goods_service", category: "Site Services" },
  { code: "plant-supply-install", name: "Plant supply and install (demo)", unit: "plant", buy_price: 37.5, sell_price: 45, catalog_type: "goods_service", category: "Site Services" },
  { code: "irrigation-system-install", name: "Irrigation system install (demo)", unit: "job", buy_price: 541.67, sell_price: 650, catalog_type: "goods_service", category: "Site Services" },
  { code: "retaining-wall", name: "Retaining wall construction (demo)", unit: "m", buy_price: 375, sell_price: 450, catalog_type: "goods_service", category: "Site Services" },
  { code: "drainage", name: "Drainage installation (demo)", unit: "m", buy_price: 62.5, sell_price: 75, catalog_type: "goods_service", category: "Site Services" },
  { code: "site-establishment", name: "Site establishment (demo)", unit: "job", buy_price: 208.33, sell_price: 250, catalog_type: "goods_service", category: "Site Services" },
  { code: "cleanup", name: "Site cleanup (demo)", unit: "job", buy_price: 150, sell_price: 180, catalog_type: "goods_service", category: "Site Services" },
  { code: "verification-loader-hour", name: "Verification loader hour (demo)", unit: "hour", buy_price: 54.17, sell_price: 65, catalog_type: "goods_service", category: "Machine Rates" },
  { code: "verification-spoil-removal-tonne", name: "Spoil removal and disposal — weight basis (demo)", unit: "m3", buy_price: 91.67, sell_price: 110, catalog_type: "goods_service", category: "Site Services" },
  { code: "verification-spoil-removal-load", name: "Spoil removal and disposal — load basis (demo)", unit: "m3", buy_price: 95.83, sell_price: 115, catalog_type: "goods_service", category: "Site Services" },
  { code: "verification-spoil-removal-volume", name: "Spoil removal and disposal — volume basis (demo)", unit: "m3", buy_price: 83.33, sell_price: 100, catalog_type: "goods_service", category: "Site Services" },
  {
    code: "verification-fill-disposal-tonne",
    name: "Fictional fill disposal — per tonne (demo)",
    unit: "tonne",
    buy_price: 26,
    sell_price: 32,
    catalog_type: "goods_service",
    category: "Site Services",
    pricing_basis: "per_tonne",
    pricing_basis_factor: 1.5,
  },
  {
    code: "verification-waste-disposal-load",
    name: "Fictional waste disposal — per load (demo)",
    unit: "load",
    buy_price: 120,
    sell_price: 150,
    catalog_type: "goods_service",
    category: "Site Services",
    pricing_basis: "per_load",
    pricing_basis_factor: 2,
  },
  {
    code: "verification-material-disposal-m3",
    name: "Fictional material disposal — per m3 (demo)",
    unit: "m3",
    buy_price: 22,
    sell_price: 28,
    catalog_type: "goods_service",
    category: "Site Services",
    pricing_basis: "per_m3",
    pricing_basis_factor: null,
  },
  // Internal recipe dependencies are explicit catalogue rows as well. The
  // verification lane exercises the same transitive closure as runtime while
  // keeping the reviewed customer-facing fixture totals unchanged.
  { code: "LABOURER-HOUR", name: "Labourer hour (demo)", unit: "hour", buy_price: 50, sell_price: 80, catalog_type: "goods_service", category: "Machine Rates" },
  { code: "WELDER-HOUR", name: "Welder hour (demo)", unit: "hour", buy_price: 75, sell_price: 100, catalog_type: "goods_service", category: "Machine Rates" },
  { code: "EXCAVATOR-HOUR", name: "Excavator hour (demo)", unit: "hour", buy_price: 180, sell_price: 300, catalog_type: "goods_service", category: "Machine Rates" },
  { code: "KANGA-HOUR", name: "Kanga hour (demo)", unit: "hour", buy_price: 90, sell_price: 150, catalog_type: "goods_service", category: "Machine Rates" },
  { code: "JACKHAMMER-HOUR", name: "Jackhammer hour (demo)", unit: "hour", buy_price: 150, sell_price: 250, catalog_type: "goods_service", category: "Machine Rates" },
  { code: "VEHICLE-HOUR", name: "Vehicle hour (demo)", unit: "hour", buy_price: 45, sell_price: 75, catalog_type: "goods_service", category: "Machine Rates" },
  { code: "VEHICLE-KM", name: "Vehicle kilometre (demo)", unit: "km", buy_price: 0.8, sell_price: 1.2, catalog_type: "goods_service", category: "Machine Rates" },
  { code: "ADMIN-FEE", name: "Administration fee (demo)", unit: "each", buy_price: 200, sell_price: 300, catalog_type: "goods_service", category: "Site Services" },
  { code: "DRAIN-PIPE-M", name: "Drainage pipe (demo)", unit: "m", buy_price: 14, sell_price: 22, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "DRAIN-PIT", name: "Stormwater pit (demo)", unit: "each", buy_price: 95, sell_price: 145, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "DRAIN-GRAVEL-M", name: "Drainage gravel (demo)", unit: "m", buy_price: 11, sell_price: 18, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "clean-fill-disposal", name: "Clean fill disposal (demo)", unit: "tonne", buy_price: 9, sell_price: 14, catalog_type: "goods_service", category: "Site Services", pricing_basis: "per_tonne", pricing_basis_factor: 1 },
  { code: "IRRIGATION-CONTROLLER-BATTERY", name: "Battery irrigation controller (demo)", unit: "each", buy_price: 500, sell_price: 600, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "IRRIGATION-CONTROLLER-MAINS", name: "Mains irrigation controller (demo)", unit: "each", buy_price: 600, sell_price: 720, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "IRRIGATION-PIPE-FIXINGS-M2", name: "Irrigation pipe and fixings (demo)", unit: "m2", buy_price: 8.5, sell_price: 10, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "TURF-SUPPLY-M2", name: "Turf supply (demo)", unit: "m2", buy_price: 18, sell_price: 22.5, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "SANDY-LOAM-M3", name: "Sandy loam (demo)", unit: "m3", buy_price: 66.75, sell_price: 90, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "SLEEPER-KENSINGTON", name: "Kensington sleeper (demo)", unit: "each", buy_price: 38.18, sell_price: 50, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "STEEL-IBEAM-125-GALV", name: "Galvanised I-beam (demo)", unit: "m", buy_price: 36.36, sell_price: 55, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "STEEL-CCHANNEL-125-GALV", name: "Galvanised C-channel (demo)", unit: "m", buy_price: 40.91, sell_price: 62, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "CONCRETE-20KG-BAG", name: "Concrete bag (demo)", unit: "bag", buy_price: 8.6, sell_price: 12, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "AGPIPE-BAY", name: "Ag pipe bay (demo)", unit: "bay", buy_price: 8, sell_price: 12, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "FORTACON-BAY", name: "Fortacon bay (demo)", unit: "bay", buy_price: 8, sell_price: 12, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "GRAVEL-20MM", name: "20mm gravel (demo)", unit: "tonne", buy_price: 83, sell_price: 110, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "BLUESTONE-LARGE", name: "Large bluestone (demo)", unit: "tonne", buy_price: 132, sell_price: 175, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "BLUESTONE-SMALL", name: "Small bluestone (demo)", unit: "tonne", buy_price: 162, sell_price: 210, catalog_type: "goods_service", category: "Construction Materials" },
  { code: "SITE-ALLOWANCE-DAY", name: "Site allowance day (demo)", unit: "day", buy_price: 50, sell_price: 75, catalog_type: "goods_service", category: "Site Services" },
  { code: "APC-DELIVERY-MINIMUM", name: "APC delivery minimum (demo)", unit: "job", buy_price: 140, sell_price: 170, catalog_type: "goods_service", category: "Delivery" },
]);

// DEL-46: a fourth, verification-only fixture that exercises all three
// disposal costing bases in one quote. Kept separate from DEMO_FIXTURES
// (shared with scripts/reset-staging-baseline.js's "demo" fixture set,
// which quotes against embark-default and does not have these rule codes)
// rather than added there.
const DISPOSAL_FIXTURE = {
  id: "5e2a1c7d-8b40-4f6e-9a3c-6f0d2b9c1404",
  title: "Disposal Basis Demo — Verification Lane",
  siteAddress: "5 Verification Lane, Demo Bay SA 5000",
  contactName: "Casey Verification",
  createdAt: FIXED_DATES[3],
  quoteCatalogId: "field-verification",
  verificationRole: "quote-fixture",
  transcriptTurns: [
    {
      speaker: "A",
      text: "This demo job removes spoil from three separate areas, each disposed of under a different costing basis so the disposal pricing model is easy to check.",
    },
    {
      speaker: "A",
      text: "Area one is billed by weight, area two by the load, and area three by volume — keep the three disposal lines visible and separate.",
    },
  ],
  quoteInputs: {
    recordingIntent: "job-scope",
    reviewStatus: "ready",
    summary: "Fictional demo job removing spoil from three areas, each disposed of under a different pricing basis.",
    jobScope: {
      customerGoal: "Show how disposal pricing changes with the costing basis for a synthetic demo audience.",
      workSummary: "Spoil removal and disposal from three demo areas, billed per tonne, per load, and per m3.",
      siteContext: "Fictional verification-only site used only for the public field-verification demo.",
    },
    lineItemCandidates: [
      {
        quoteCatalogItemCode: "verification-spoil-removal-tonne",
        label: "Spoil removal — weight basis",
        description: "Remove spoil from demo area one, disposed of by weight.",
        quantity: 8,
        unit: "m3",
        confidence: 0.95,
        rationale: "Area one spoil is disposed of under the per_tonne costing basis.",
        section: "Area One — Weight Basis",
        evidence: [],
        evidenceSummary: ["Demo area one measured at 8 cubic metres of spoil."],
      },
      {
        quoteCatalogItemCode: "verification-spoil-removal-load",
        label: "Spoil removal — load basis",
        description: "Remove spoil from demo area two, disposed of by load.",
        quantity: 5,
        unit: "m3",
        confidence: 0.95,
        rationale: "Area two spoil is disposed of under the per_load costing basis.",
        section: "Area Two — Load Basis",
        evidence: [],
        evidenceSummary: ["Demo area two measured at 5 cubic metres of spoil."],
      },
      {
        quoteCatalogItemCode: "verification-spoil-removal-volume",
        label: "Spoil removal — volume basis",
        description: "Remove spoil from demo area three, disposed of by volume.",
        quantity: 4,
        unit: "m3",
        confidence: 0.95,
        rationale: "Area three spoil is disposed of under the per_m3 costing basis.",
        section: "Area Three — Volume Basis",
        evidence: [],
        evidenceSummary: ["Demo area three measured at 4 cubic metres of spoil."],
      },
    ],
    processReferences: [],
    measurements: [],
    siteConstraints: [],
    missingInputs: [],
    assumptions: [
      {
        statement: "Demo assumes each area is independently accessible with no shared haulage constraint.",
        evidence: [],
        evidenceSummary: ["The demo scope treats each disposal area separately."],
      },
    ],
  },
};

export const VERIFICATION_FIXTURES = [
  ...DEMO_FIXTURES.map((fixture, index) => {
    const { createdAtOffsetMinutes: _createdAtOffsetMinutes, ...stableFixture } = fixture;
    return {
      ...stableFixture,
      createdAt: FIXED_DATES[index],
      quoteCatalogId: "field-verification",
      verificationRole: index === 0 ? "invoice-fixture" : "quote-fixture",
    };
  }),
  DISPOSAL_FIXTURE,
];

export const FIXTURE_MANIFEST_SHA256 = createHash("sha256")
  .update(JSON.stringify(VERIFICATION_FIXTURES))
  .digest("hex");
export const CATALOG_MANIFEST_SHA256 = createHash("sha256")
  .update(JSON.stringify(VERIFICATION_CATALOG_ITEMS))
  .digest("hex");

// Reviewed semantic values are intentionally independent of the generated
// state tree. A reset must reproduce these exact fixture IDs, catalog rules,
// customer-facing lock, invoice schedule, and totals before it can be marked
// known-good.
export const REVIEWED_SEMANTIC_MANIFEST = Object.freeze({
  schemaVersion: 1,
  catalogId: "field-verification",
  fixtureIds: VERIFICATION_FIXTURES.map((fixture) => fixture.id),
  fixtureTotals: Object.freeze({
    // 4004 is the quoted-and-locked total for this fixture: it holds from the
    // moment the customer-facing revision is built through lock, send, land,
    // and milestone generation (DEL-30). Locking is a delivery-state change,
    // never a re-price, so this value must not drift across that sequence.
    // reset.js asserts it twice — once from the pre-lock in-memory build, and
    // again by reading the persisted quote.json back off disk after the lock
    // step — so a rebuild-on-lock regression fails the seed immediately
    // instead of surviving to production.
    "0f8b7f41-9912-4dd8-b761-2b6152b3d101": 4004,
    "ddf09c7b-7117-48ce-8dfb-e08d22d70202": 4972,
    "906dba0e-b069-4bd1-9bd2-51c29bd80303": 7799,
    "5e2a1c7d-8b40-4f6e-9a3c-6f0d2b9c1404": 1756.7,
  }),
  ruleCodes: Object.freeze([
    "concrete-surface-demolition", "tip-truck", "imported-fill",
    "block-edging-supply-install", "plant-supply-install", "irrigation-system-install",
    "verification-loader-hour", "verification-spoil-removal-tonne", "verification-spoil-removal-load",
    "verification-spoil-removal-volume", "verification-fill-disposal-tonne", "verification-waste-disposal-load",
    "verification-material-disposal-m3",
    "retaining-wall", "drainage", "site-establishment", "cleanup",
  ]),
  invoiceMilestonePercentages: Object.freeze([50, 50]),
  customerFacingRevision: Object.freeze({ version: 1, lockStatus: "final", immutable: true }),
});
export const REVIEWED_SEMANTIC_MANIFEST_SHA256 = createHash("sha256")
  .update(JSON.stringify(REVIEWED_SEMANTIC_MANIFEST))
  .digest("hex");

// The host data-boundary contract requires the marker suffix to equal the job
// fixture manifest hash. Catalog drift is carried and asserted separately in
// catalogManifestSha256 so server startup can reseed it without changing that
// cross-repository marker contract.
export const FIXTURE_MARKER = `field-verification-fixtures-v1:${FIXTURE_MANIFEST_SHA256}`;

export function buildFixtureMarker({ stateTreeSha256 = null } = {}) {
  return {
    marker: FIXTURE_MARKER,
    installationId: "field-verification",
    fixtureSet: "verification",
    fixtureManifestSha256: FIXTURE_MANIFEST_SHA256,
    catalogManifestSha256: CATALOG_MANIFEST_SHA256,
    semanticManifestSha256: REVIEWED_SEMANTIC_MANIFEST_SHA256,
    semanticManifest: REVIEWED_SEMANTIC_MANIFEST,
    fixtureIds: VERIFICATION_FIXTURES.map((fixture) => fixture.id),
    invoiceFixtureId: VERIFICATION_FIXTURES.find((fixture) => fixture.verificationRole === "invoice-fixture")?.id || null,
    customerFacingRevision: {
      fixtureId: VERIFICATION_FIXTURES.find((fixture) => fixture.verificationRole === "invoice-fixture")?.id || null,
      version: 1,
      locked: true,
    },
    ...(stateTreeSha256 ? { stateTreeSha256 } : {}),
  };
}

export function assertFixtureMarker(marker) {
  if (!marker || marker.marker !== FIXTURE_MARKER) throw new Error("verification fixture marker is missing or does not match the reviewed fixture manifest");
  if (marker.installationId !== "field-verification" || marker.fixtureSet !== "verification") throw new Error("verification fixture marker identity is invalid");
  if (marker.fixtureManifestSha256 !== FIXTURE_MANIFEST_SHA256
    || marker.catalogManifestSha256 !== CATALOG_MANIFEST_SHA256) {
    throw new Error("verification fixture marker does not match the fixture and catalog manifests");
  }
  const expectedIds = VERIFICATION_FIXTURES.map((fixture) => fixture.id);
  if (JSON.stringify(marker.fixtureIds) !== JSON.stringify(expectedIds)) throw new Error("verification fixture marker IDs do not match the reviewed fixture manifest");
  if (marker.customerFacingRevision?.fixtureId !== marker.invoiceFixtureId || marker.customerFacingRevision?.version !== 1 || marker.customerFacingRevision?.locked !== true) {
    throw new Error("verification fixture marker does not prove the immutable customer-facing revision fixture");
  }
  if (marker.semanticManifestSha256 !== REVIEWED_SEMANTIC_MANIFEST_SHA256
    || JSON.stringify(marker.semanticManifest) !== JSON.stringify(REVIEWED_SEMANTIC_MANIFEST)) {
    throw new Error("verification fixture marker semantic manifest is not the reviewed exact fixture contract");
  }
  if (marker.stateTreeSha256 !== undefined && !/^[0-9a-f]{64}$/.test(marker.stateTreeSha256)) {
    throw new Error("verification fixture marker state tree hash is invalid");
  }
  return marker;
}
