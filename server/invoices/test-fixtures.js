// Milestone invoice jobs for the invoice-row tests (#27), built by the real
// milestone actions (server/job-actions.js), each run as a committed job
// generation the way the routes run them, so an installed commit listener
// (the dual-write) sees every change. Synthetic data only.
//
// They are the jobs production holds from before step 4b (#28): invoices
// numbered EI-…-M<n>, revised in place to -R<k>. Unless a test installs an
// invoice issuer of its own, the actions here issue the way Field did then
// (`PRE_4B_ISSUER`): under the milestone's provisional number, rendered once,
// with no sequence and no database.
import { mkdir, readFile, writeFile } from "../storage/fs-promises.js";
import { dirname, join } from "node:path";
import {
  generateJobMilestones,
  markJobMilestoneUnpaid,
  markJobMilestoneUnsent,
  recordJobMilestonePayment,
  reviseJobMilestoneInvoice,
  updateJobMilestone,
  voidJobMilestonePayment,
} from "../job-actions.js";
import { prepareMilestoneInvoiceDocument } from "../job-documents.js";
import { runAtomicJobGeneration } from "../job-generation.js";
import { readJobMeta } from "../job-meta-store.js";
import { generateQuotePdfBuffer } from "../quote-artifacts.js";
import { sha256Hex } from "../documents/blob-store.js";
import { installInvoiceIssuer, invoiceIssuer } from "./issue.js";

// Issues as Field did before step 4b: the invoice keeps the provisional
// number it was built under (EI-…-M<n>, -R<k>) and carries no job reference.
export const PRE_4B_ISSUER = Object.freeze({
  enabled: true,
  pre4b: true,
  async issueInvoice({ invoice, issuedAt, render }) {
    const pdfBytes = Buffer.from(await render(invoice.number));
    return { replayed: false, number: invoice.number, reference: null, invoiceUid: null, issuedDocumentUid: null, pdfSha256: sha256Hex(pdfBytes), pdfBytes, issuedAt: new Date(issuedAt).toISOString() };
  },
});

const ACTOR = { kind: "user", label: "Test Operator" };

/** A sendable quote with one schedule row per entry of `rows` ([label, amount]); GST 10 %. */
export function invoiceQuote(meta, { version = 1, rows = [["Scope item", 200]] } = {}) {
  const subtotal = rows.reduce((sum, [, amount]) => sum + amount, 0);
  const items = rows.map(([label, amount], index) => ({ code: `row-${index + 1}`, label, quantity: 1, unit: "lot", unitPrice: amount, totalPrice: amount }));
  return {
    kind: "quote",
    version,
    status: "ready",
    generatedAt: "2026-03-27T00:00:00.000Z",
    updatedAt: "2026-03-27T00:00:00.000Z",
    jobId: meta.id,
    quoteNumber: meta.quoteNumber,
    jobNumber: meta.jobNumber,
    title: meta.title,
    recordingIntent: "job-scope",
    summary: "Synthetic scope",
    quoteCatalog: { id: "sample-default", name: "Sample", currency: "AUD", gstRate: 0.1 },
    lineItems: items.map((item) => ({ ...item, unitCost: item.unitPrice * 0.7, totalCost: item.totalPrice * 0.7, section: "Works", customerVisible: true })),
    presentation: { scopeText: "Synthetic scope", scheduleItems: items.map((item) => ({ ...item, sourceLineItemCodes: [item.code] })) },
    totals: { subtotal, gst: Math.round(subtotal * 10) / 100, total: Math.round(subtotal * 110) / 100, currency: "AUD" },
    pricing: { authorityProvider: "price_catalog", ready: true, displayable: true, sendable: true, blockingReason: null, attestation: { status: "verified", requestNonce: "req-verified", verifiedNonce: "req-verified" } },
    review: { status: "ready", reasons: [] },
    delivery: { status: "final", finalizedAt: "2026-03-27T00:00:00.000Z" },
  };
}

export function landedMeta({ id, number }) {
  return {
    id,
    title: `Synthetic job ${number}`,
    label: `Synthetic job ${number}`,
    outputMode: "quote",
    pipelineStage: "landed",
    deliveryStatus: "landed",
    quoteNumber: `EQ-${number}`,
    jobNumber: `JOB-${number}`,
    quoteVersion: 1,
    landedAt: "2026-05-01T00:00:00.000Z",
    contactName: "Sam Customer",
    contactEmail: "customer@example.invalid",
  };
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
}

/** Run one milestone action as a committed job generation (as the routes do). */
export async function act(jobDir, action, input) {
  const run = () => runAtomicJobGeneration(jobDir, async (stagedJobDir) => action({ jobDir: stagedJobDir, meta: await readJobMeta(stagedJobDir), config: {}, actor: ACTOR, ...input }));
  if (invoiceIssuer().enabled) return run();
  installInvoiceIssuer(PRE_4B_ISSUER);
  try {
    return await run();
  } finally {
    installInvoiceIssuer(null);
  }
}

export const actions = {
  generate: (jobDir, milestones) => act(jobDir, generateJobMilestones, { paymentSchedule: { milestones } }),
  issue: (jobDir, milestoneIndex) => act(jobDir, updateJobMilestone, { milestoneIndex, patch: { status: "authorised" } }),
  update: (jobDir, milestoneIndex, patch) => act(jobDir, updateJobMilestone, { milestoneIndex, patch }),
  pay: (jobDir, milestoneIndex, amount, extra = {}) => act(jobDir, recordJobMilestonePayment, { milestoneIndex, payment: { amount, date: "2026-05-10", reference: "EFT-TEST", method: "bank_transfer", ...extra } }),
  voidPayment: (jobDir, milestoneIndex, paymentId) => act(jobDir, voidJobMilestonePayment, { milestoneIndex, paymentId, reason: "Entered twice" }),
  unpaid: (jobDir, milestoneIndex) => act(jobDir, markJobMilestoneUnpaid, { milestoneIndex }),
  unsent: (jobDir, milestoneIndex) => act(jobDir, markJobMilestoneUnsent, { milestoneIndex }),
  revise: (jobDir, milestoneIndex, expectedRevisionNumber = 1) => act(jobDir, reviseJobMilestoneInvoice, { milestoneIndex, reason: "Approved variation", expectedRevisionNumber }),
};

/** A landed job with its quote, ready for milestones. Returns { jobDir, meta, quote }. */
export async function createLandedJob(jobDir, { id, number, rows }) {
  const meta = landedMeta({ id, number });
  const quote = invoiceQuote(meta, { rows });
  await write(join(jobDir, "meta.json"), meta);
  await write(join(jobDir, "quote.json"), quote);
  return { jobDir, meta, quote };
}

/** The approved variation: the quote's next version, with one more row, committed as a job generation. */
export async function applyVariation(jobDir, quote, [label, amount] = ["Rock clause", 100]) {
  const rows = quote.presentation.scheduleItems.map((item) => [item.label, item.totalPrice]);
  const variation = invoiceQuote({ id: quote.jobId, quoteNumber: quote.quoteNumber, jobNumber: quote.jobNumber, title: quote.title }, { version: quote.version + 1, rows: [...rows, [label, amount]] });
  await runAtomicJobGeneration(jobDir, async (stagedJobDir) => {
    await write(join(stagedJobDir, "quote.json"), variation);
    const meta = JSON.parse(await readFile(join(stagedJobDir, "meta.json"), "utf8"));
    await write(join(stagedJobDir, "meta.json"), { ...meta, quoteVersion: variation.version });
  });
  return variation;
}

/**
 * The fixture jobs the mapping and backfill tests share, under
 * <dataDir>/2026-05-01/<id>. Each returns its job directory.
 */
export const scenarios = {
  // One invoice for the whole job, issued.
  async single(dataDir) {
    const { jobDir } = await createLandedJob(join(dataDir, "2026-05-01", "job-single"), { id: "job-single", number: "2605-01", rows: [["Driveway", 1000]] });
    await actions.generate(jobDir, [{ label: "Full payment", percentage: 100 }]);
    await actions.issue(jobDir, 0);
    return jobDir;
  },
  // Deposit issued, completion still a draft.
  async depositCompletion(dataDir) {
    const { jobDir } = await createLandedJob(join(dataDir, "2026-05-01", "job-deposit"), { id: "job-deposit", number: "2605-02", rows: [["Retaining wall", 1500], ["Drainage", 351]] });
    await actions.generate(jobDir, [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }]);
    await actions.issue(jobDir, 0);
    return jobDir;
  },
  // Deposit issued and paid in full: a receipt.
  async paid(dataDir) {
    const { jobDir } = await createLandedJob(join(dataDir, "2026-05-01", "job-paid"), { id: "job-paid", number: "2605-03", rows: [["Paving", 800]] });
    await actions.generate(jobDir, [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }]);
    const issued = await actions.issue(jobDir, 0);
    await actions.pay(jobDir, 0, issued.meta.milestoneInvoices[0].total);
    return jobDir;
  },
  // Deposit issued, then revised in place to -R2 after an approved variation.
  async revised(dataDir) {
    const { jobDir, quote } = await createLandedJob(join(dataDir, "2026-05-01", "job-revised"), { id: "job-revised", number: "2605-04", rows: [["Fencing", 200]] });
    await actions.generate(jobDir, [{ label: "Deposit", percentage: 50 }, { label: "Final", percentage: 50 }]);
    await actions.issue(jobDir, 0);
    await applyVariation(jobDir, quote);
    await actions.revise(jobDir, 0);
    return jobDir;
  },
  // A payment recorded and then voided.
  async voidedPayment(dataDir) {
    const { jobDir } = await createLandedJob(join(dataDir, "2026-05-01", "job-voided"), { id: "job-voided", number: "2605-05", rows: [["Turf", 400]] });
    await actions.generate(jobDir, [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }]);
    await actions.issue(jobDir, 0);
    const paid = await actions.pay(jobDir, 0, 100);
    await actions.voidPayment(jobDir, 0, paid.meta.milestoneInvoices[0].payments[0].id);
    return jobDir;
  },
  // Issued before invoice revisions froze a snapshot: the stored record has
  // an issue time and a PDF, and no issued revision.
  async legacy(dataDir) {
    const jobDir = join(dataDir, "2026-05-01", "job-legacy");
    const meta = landedMeta({ id: "job-legacy", number: "2605-06" });
    const quote = invoiceQuote(meta, { rows: [["Excavation", 1234.5]] });
    const milestone = {
      id: "legacy-m1",
      jobId: meta.id,
      milestoneIndex: 0,
      milestoneLabel: "Full payment",
      invoiceNumber: "EI-2605-06-M1",
      receiptNumber: "ER-2605-06-M1",
      reference: "EQ-2605-06",
      percentage: 100,
      subtotal: 1234.5,
      gst: 123.45,
      total: 1357.95,
      currency: "AUD",
      lineItems: [{ description: "Excavation", quantity: 1, unit: "lot", unitPrice: 1234.5, totalPrice: 1234.5 }],
      dueDate: "2025-11-14",
      issuedAt: "2025-10-31T02:00:00.000Z",
      status: "authorised",
      payments: [],
      pdfPath: "milestone-invoices/EI-2605-06-M1.pdf",
    };
    await write(join(jobDir, "meta.json"), meta);
    await write(join(jobDir, "quote.json"), quote);
    const prepared = prepareMilestoneInvoiceDocument({ meta: { ...meta, milestoneInvoices: [milestone] }, quote, milestoneInvoice: milestone, documentType: "invoice" });
    await write(join(jobDir, milestone.pdfPath), await generateQuotePdfBuffer({ meta: prepared.meta, quote: prepared.quote, documentType: "invoice", creationDate: new Date("2025-10-31T02:00:00.000Z") }));
    await write(join(jobDir, "milestone-invoices/state.json"), {
      version: 1,
      paymentSchedule: { milestones: [{ label: "Full payment", percentage: 100 }] },
      milestoneInvoices: [milestone],
    });
    return jobDir;
  },
};
