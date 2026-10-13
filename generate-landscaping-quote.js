/**
 * Generate landscaping quote PDF for job CD18E516.
 * Produces: quote.json, quote.pdf, meta.json, cost-vs-price report.
 *
 * Usage:  node generate-landscaping-quote.js
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateQuotePdfBuffer } from "./server/quote-artifacts.js";

const DATA_DIR = join(import.meta.dirname, "data");
const TODAY = "2026-03-12";
const JOB_SHORT = "CD18E516";
const RECORDING_ID = `cd18e516-0000-4000-8000-000000000001`;
const JOB_NUMBER = `JOB-${TODAY.replace(/-/g, "")}-${JOB_SHORT}`;
const QUOTE_NUMBER = "EQ-2501-01";

// ══════════════════════════════════════════════════════════════
// LINE ITEMS — grouped at customer-meaningful level
// ══════════════════════════════════════════════════════════════

const lineItems = [
  // ── Irrigation ──
  {
    section: "Irrigation",
    code: "irrigation-all", label: "Irrigation System — Supply & Install",
    quantity: 1, unit: "lot", unitPrice: 6820, totalPrice: 6820,
    rationale: "Controller, piping (front 77m² + back 220m²), installation, and delivery.",
  },

  // ── Front Yard ──
  {
    section: "Front Yard",
    code: "front-lawn", label: "Lawn — Supply, Preparation & Install",
    quantity: 1, unit: "lot", unitPrice: 4385.50, totalPrice: 4385.50,
    rationale: "Sandy loam, turf, delivery, prep/spread/lay labour, loader, mulch install.",
  },
  {
    section: "Front Yard",
    code: "front-garden", label: "Feature Trees — Supply & Install (2x)",
    quantity: 1, unit: "lot", unitPrice: 1510, totalPrice: 1510,
    rationale: "2x weeping cherry trees, excavation, backfill, mulch, pick-up and delivery.",
  },
  {
    section: "Front Yard",
    code: "front-gardens", label: "Plants — Supply & Install (12 plants + curbside mulch)",
    quantity: 1, unit: "lot", unitPrice: 867, totalPrice: 867,
    rationale: "12 plants (4x screening, 8x step-framing), installation, curbside mulch supply and install.",
  },

  // ── Back Yard ──
  {
    section: "Back Yard",
    code: "back-lawn", label: "Lawn — Supply, Preparation & Install",
    quantity: 1, unit: "lot", unitPrice: 11142.50, totalPrice: 11142.50,
    rationale: "Sandy loam, turf, delivery, prep/spread/lay labour, loader, mulch install.",
  },
  {
    section: "Back Yard",
    code: "back-trees", label: "Trees — Supply & Install (17x)",
    quantity: 1, unit: "lot", unitPrice: 7437.50, totalPrice: 7437.50,
    rationale: "13x pencil pines + 4x fruit trees, excavation, install, mulch.",
  },
  {
    section: "Back Yard",
    code: "back-edging", label: "Block Edging — Supply & Install",
    quantity: 1, unit: "lot", unitPrice: 6637.58, totalPrice: 6637.58,
    rationale: "Blocks, caps, base materials, excavation, lay, capping, delivery, mulch install.",
  },
];

// Labour cost = $45/hr (raw); machine + material costs carry through as-is.
const LABOUR_COST = 45;

// Cost breakdown — keyed by line-item code so the internal cost panel and
// jobs-landed / jobs-lost margin stats stay honest. Sell prices are untouched.
const COST_BY_CODE = {
  "irrigation-all": 800 + 654.50 + 1870 + 100 + (12 * LABOUR_COST) + (24 * LABOUR_COST),
  "front-lawn":     (6 + 5 + 4 + 0.5) * LABOUR_COST + 825 + 513.98 + 924 + 180 + 240,
  "front-garden":   450 + 100 + 275 + 100 + 150 + (1.5 + 0.5) * LABOUR_COST,
  "front-gardens":  300 + 57.60 + (4 + 0.5 + 0.5) * LABOUR_COST,
  "back-lawn":      2100 + (16 + 12 + 8 + 3.5) * LABOUR_COST + 1468.50 + 2640 + 250 + 350,
  "back-trees":     13 * 240 + 650 + (6.5 * LABOUR_COST) + 1000 + 600 + (1 * LABOUR_COST),
  "back-edging":    2240 + 1035 + 98 + 93.15 + 86 + 100 + 600 + 75 + 37.50 + 75
                    + (4.5 + 6 + 6 + 1.5) * LABOUR_COST + 75,
};

// Enrich with common fields + attach actual costs
for (const item of lineItems) {
  item.confidence = 0.9;
  item.evidence = [];
  item.evidenceSummary = [];
  item.requiredInputs = [];
  item.assumptions = [];
  item.usedDefaultQuantity = false;
  item.manualOverride = null;
  const rawCost = COST_BY_CODE[item.code];
  if (rawCost == null) throw new Error(`Missing cost for line item ${item.code}`);
  const totalCost = Math.round(rawCost * 100) / 100;
  item.unitCost = totalCost;
  item.totalCost = totalCost;
}

const subtotal = Math.round(lineItems.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100;
const gst = Math.round(subtotal * 0.1 * 100) / 100;
const total = Math.round((subtotal + gst) * 100) / 100;

// ══════════════════════════════════════════════════════════════
// META + QUOTE JSON
// ══════════════════════════════════════════════════════════════

const meta = {
  id: RECORDING_ID,
  createdAt: `${TODAY}T09:00:00.000Z`,
  title: "Test Customer — 12 Sample Street, Exampleton",
  label: "Test Customer — 12 Sample Street, Exampleton",
  outputMode: "quote",
  quoteCatalogId: "default",
  status: "complete",
  captureMode: "manual",
  audioFile: null, mimeType: null, sizeBytes: 0, durationMs: null, speakerCount: 0,
  siteAddress: "12 Sample Street, Exampleton 5000",
  contactName: "Test Customer",
  contactPhone: "0400 000 000",
  contactEmail: "test@example.com",
  jobNumber: JOB_NUMBER,
  quoteNumber: QUOTE_NUMBER,
  quoteTotal: total,
  quoteVersion: 1,
  pipelineStage: "draft",
  moasureStatus: "not_attached",
  moasureBatchCount: 0,
  moasureLatestBatchId: null,
};

const quote = {
  kind: "quote",
  version: 1,
  status: "final",
  generatedAt: `${TODAY}T09:00:00.000Z`,
  updatedAt: `${TODAY}T09:00:00.000Z`,
  recordingId: RECORDING_ID,
  jobNumber: JOB_NUMBER,
  quoteNumber: QUOTE_NUMBER,
  title: "Test Customer — 12 Sample Street, Exampleton",
  recordingIntent: "job-scope",
  delivery: {
    status: "final",
    finalizedAt: `${TODAY}T09:00:00.000Z`,
    label: "Quote Final",
    versionLabel: "v001",
  },
  quoteCatalog: {
    id: "default",
    name: "Sample Catalogue",
    currency: "AUD",
    gstRate: 0.1,
    businessProfile: {
      tradingName: "Your Business",
      legalName: "Your Business Pty Ltd",
      abn: "",
      address: "Your business address",
      phone: "",
      email: "quotes@example.com",
      paymentMethods: {
        bankTransfer: {
          accountName: "Your Business Pty Ltd",
          bsb: "000-000",
          accountNumber: "0000 0000 0",
          bank: "Your bank",
        },
      },
    },
    deliveryDefaults: {
      issuerName: "Your Business",
      validityDays: 14,
      paymentTerms: "10% deposit due upon acceptance of this quote to secure booking. 30% progress payment due upon commencement of works. Remaining balance due within 7 days of project completion.",
      footerNote: "This quote is based on the listed scope, rate card, and assumptions current at issue time.",
    },
  },
  summary: [
    "• Irrigation system — shared controller, underground piping and sprinklers (front and back)",
    "• Front lawn — preparation, sandy loam, and turf",
    "• 2x feature trees with mulch surround",
    "• 12 plants supplied and installed across 2 planter beds, including curbside mulching",
    "• Back lawn — preparation, sandy loam, and turf",
    "• 17x trees supplied and installed",
    "• Versastone block edging with caps",
    "• Garden bed and border mulching throughout",
  ].join("\n"),
  lineItems,
  assumptionInputs: [
    {
      field: "Site access",
      value: "Standard site access assumed — no unusual machinery or haulage constraints.",
      source: "default",
      quoteNote: "Standard access assumed. Additional costs may apply if access is restricted.",
      affectsPricing: true,
      evidence: [],
    },
  ],
  missingInputs: [],
  moasure: null,
  review: {
    status: "approved",
    reasons: [],
  },
  totals: { subtotal, gst, total, currency: "AUD" },
};

// ══════════════════════════════════════════════════════════════
// WRITE FILES + GENERATE PDF
// ══════════════════════════════════════════════════════════════

const dateDir = join(DATA_DIR, TODAY);
const recordingDir = join(dateDir, RECORDING_ID);
const jobStateDir = join(recordingDir, "job-state");
await mkdir(jobStateDir, { recursive: true });

await Promise.all([
  writeFile(join(recordingDir, "meta.json"), JSON.stringify(meta, null, 2)),
  writeFile(join(recordingDir, "quote.json"), JSON.stringify(quote, null, 2)),
  writeFile(join(jobStateDir, "details.json"), JSON.stringify({
    siteAddress: "12 Sample Street, Exampleton 5000",
    contact: { name: "Test Customer", phone: "0400 000 000", email: "test@example.com" },
    captureCount: 0,
  }, null, 2)),
  writeFile(join(jobStateDir, "gaps.json"), "[]"),
  writeFile(join(jobStateDir, "activity.jsonl"), ""),
  writeFile(join(recordingDir, "transcript.json"), JSON.stringify({ segments: [], speakerCount: 0, durationMs: 0 }, null, 2)),
]);

console.log("Generating PDF...");
const pdfBuffer = await generateQuotePdfBuffer({ meta, quote });
const pdfPath = join(recordingDir, "quote.pdf");
await writeFile(pdfPath, pdfBuffer);

const rootPdfPath = join(import.meta.dirname, "..", "..", `quote-${QUOTE_NUMBER}.pdf`);
await writeFile(rootPdfPath, pdfBuffer);
console.log(`PDF → ${pdfPath}`);
console.log(`PDF → ${rootPdfPath}`);

// ══════════════════════════════════════════════════════════════
// COST vs PRICE COMPARISON
// ══════════════════════════════════════════════════════════════

const sections = [
  { name: "Irrigation",              code: "irrigation-all" },
  { name: "Front Yard — Lawn",       code: "front-lawn" },
  { name: "Front Yard — Garden",     code: "front-garden" },
  { name: "Front Yard — Garden Beds", code: "front-gardens" },
  { name: "Back Yard — Lawn",        code: "back-lawn" },
  { name: "Back Yard — Trees (17x)", code: "back-trees" },
  { name: "Back Yard — Edging",      code: "back-edging" },
].map(({ name, code }) => {
  const item = lineItems.find((li) => li.code === code);
  return { name, cost: item.totalCost, price: item.totalPrice };
});

// Also add irrigation labour to price (it's bundled in the line items above)
// Correction: irrigation price line items already include labour
// Let's verify totals match

const fmt = (v) => `$${v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const pad = (s, n) => s.padEnd(n);

console.log("\n══════════════════════════════════════════════════════════════════════════════════════");
console.log("  COST vs PRICE — SECTION BREAKDOWN");
console.log("══════════════════════════════════════════════════════════════════════════════════════\n");
console.log(`${pad("Section", 32)} ${pad("Cost", 14)} ${pad("Price", 14)} ${pad("Margin $", 14)} Margin %`);
console.log("─".repeat(90));

let totalCost = 0, totalPrice = 0;
for (const s of sections) {
  totalCost += s.cost;
  totalPrice += s.price;
  const margin = s.price - s.cost;
  const pct = s.price > 0 ? ((margin / s.price) * 100).toFixed(1) : "—";
  console.log(`${pad(s.name, 32)} ${pad(fmt(s.cost), 14)} ${pad(fmt(s.price), 14)} ${pad(fmt(margin), 14)} ${pct}%`);
}

console.log("─".repeat(90));
const totalMargin = totalPrice - totalCost;
const totalPct = ((totalMargin / totalPrice) * 100).toFixed(1);
console.log(`${pad("SUBTOTAL (ex GST)", 32)} ${pad(fmt(totalCost), 14)} ${pad(fmt(totalPrice), 14)} ${pad(fmt(totalMargin), 14)} ${totalPct}%`);
console.log(`${pad("GST (10%)", 32)} ${pad(fmt(totalCost * 0.1), 14)} ${pad(fmt(totalPrice * 0.1), 14)}`);
console.log(`${pad("TOTAL (inc GST)", 32)} ${pad(fmt(totalCost * 1.1), 14)} ${pad(fmt(totalPrice * 1.1), 14)} ${pad(fmt(totalMargin * 1.1), 14)} ${totalPct}%`);

// ══════════════════════════════════════════════════════════════
// WORK SCHEDULE — 3 people, 8hr days, critical path
// ══════════════════════════════════════════════════════════════

console.log("\n══════════════════════════════════════════════════════════════════════════════════════");
console.log("  WORK SCHEDULE — 3 persons, 8hr working day");
console.log("══════════════════════════════════════════════════════════════════════════════════════\n");

const schedule = [
  { day: 1, tasks: [
    "Back yard irrigation install (3pp x 8hrs)",
  ], hours: 8 },
  { day: 2, tasks: [
    "Front yard irrigation install (3pp x 4hrs)",
    "Front garden — excavate tree holes + install weeping cherries (1.5hrs)",
    "Small gardens — plant 12 plants (1pp x 4hrs, others prep curbside mulch)",
  ], hours: 8 },
  { day: 3, tasks: [
    "Back lawn — mini loader starts (14hrs total), 2pp prep (8hrs clock)",
    "Loader + prep run in parallel all day",
  ], hours: 8 },
  { day: 4, tasks: [
    "Back lawn — mini loader continues (6hrs remaining), 2pp spread (6hrs)",
    "Remaining crew member starts edging trench excavation (2hrs excavator)",
  ], hours: 8 },
  { day: 5, tasks: [
    "Back lawn — turf lay (2pp x 4hrs)",
    "Edging — compact base, haul/spread sand, begin block lay",
    "Back yard fruit trees — excavator install (2hrs)",
  ], hours: 8 },
  { day: 6, tasks: [
    "Edging — finish block lay (first level) + second level + capping (3pp x 4hrs)",
    "Front lawn — mini loader + prep + spread (2pp x 5.5hrs loader, 3hrs prep, 2.5hrs spread)",
  ], hours: 8 },
  { day: 7, tasks: [
    "Front lawn — turf lay (2pp x 2hrs)",
    "Remaining prep and finishing tasks",
  ], hours: 8 },
  { day: 8, tasks: [
    "Mulch install across all sections (done last — machinery clear)",
    "Front: lawn borders (0.5hr), garden trees (0.5hr), curbside (0.5hr), small gardens (0.5hr)",
    "Back: lawn borders (3.5hrs), fruit trees (1hr), edging borders (1.5hr)",
    "Final cleanup and inspection",
  ], hours: 8 },
];

let totalWorkHours = 0;
for (const day of schedule) {
  totalWorkHours += day.hours;
  console.log(`Day ${day.day} (${day.hours}hrs):`);
  for (const task of day.tasks) {
    console.log(`  • ${task}`);
  }
  console.log();
}

console.log("─".repeat(90));
console.log(`Total: ${schedule.length} working days (${totalWorkHours} crew-hours on critical path)`);
console.log(`Crew size: 3 persons + machines as scheduled`);
console.log(`Total person-hours across all tasks: ~147 pp-hrs`);
console.log();

console.log("Done.");
