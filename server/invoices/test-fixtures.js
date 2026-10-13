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
  creditAndReissueJobMilestoneInvoice,
  updateJobMilestone,
  voidJobMilestonePayment,
} from "../job-actions.js";
import { ARTIFACT_STATE } from "../invoice-artifact-state.js";
import { normalizeInvoiceRevision } from "../invoice-revisions.js";
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
  // Before credit notes, an approved change revised the invoice in place:
  // the new revision took the next -R<k> number and nothing was credited.
  async creditAndReissue({ invoice, issuedAt, render }) {
    const pdfBytes = Buffer.from(await render(invoice.number, { creditNoteNumber: null }));
    return {
      replayed: false,
      creditNote: null,
      invoice: { number: invoice.number, reference: null, invoiceUid: null, issuedDocumentUid: null, pdfSha256: sha256Hex(pdfBytes), pdfBytes, issuedAt: new Date(issuedAt).toISOString() },
    };
  },
  // Before the RCT series nothing issued a receipt: it kept the milestone's
  // ER-… number and was drawn when it was written or sent.
  async issueReceipt() {
    return null;
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
  revise: (jobDir, milestoneIndex, expectedRevisionNumber = 1) => act(jobDir, creditAndReissueJobMilestoneInvoice, { milestoneIndex, reason: "Approved variation", expectedRevisionNumber }),
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

/** A milestone's claim on a quote: `percent` of its subtotal, with GST at 10 %. */
export function claimOf(quote, percent) {
  const subtotal = Math.round(quote.totals.subtotal * percent) / 100;
  const gst = Math.round(subtotal * 10) / 100;
  return { subtotal, gst, total: Math.round((subtotal + gst) * 100) / 100 };
}

/** An invoice PDF for a milestone claiming `amounts`, drawn from `quote` (how Field rendered one before revisions were frozen). */
export async function renderLegacyInvoicePdf({ meta, quote, milestone, amounts, milestones = [milestone] }) {
  const drawn = { ...milestone, ...amounts };
  const prepared = prepareMilestoneInvoiceDocument({ meta: { ...meta, milestoneInvoices: milestones.map((entry) => (entry.milestoneIndex === drawn.milestoneIndex ? drawn : entry)) }, quote, milestoneInvoice: drawn, documentType: "invoice" });
  return generateQuotePdfBuffer({ meta: prepared.meta, quote: prepared.quote, documentType: "invoice", creationDate: new Date(milestone.issuedAt) });
}

/**
 * A job shaped like the production jobs of the invoice-version bug: a 30 %
 * deposit invoiced and emailed in July 2026, before invoice revisions were
 * frozen, against quote v1; quote v2 (a variation) accepted since. Before the
 * freeze every milestone action re-allocated the deposit's record from the
 * quote then current, and re-rendered its PDF only when the action targeted
 * it, so the record and the PDF can each come from a different version:
 *
 *   recordVersion   the version the milestone record's amounts come from
 *   pdfVersion      the version the stored PDF's claim comes from
 *   sentVersion     the version the archived invoice email says it was
 *                   built against (sent-emails.jsonl)
 *
 * Nothing is frozen yet: the next milestone action, through today's code,
 * adopts the record as the issued snapshot and the file as its PDF.
 * Returns { jobDir, meta, quotes, claims, pdf, number }.
 */
export async function createLegacyVersionMismatchJob(dataDir, { id, number, recordVersion, pdfVersion, sentVersion = pdfVersion }) {
  const jobDir = join(dataDir, "2026-07-01", id);
  const meta = { ...landedMeta({ id, number }), quoteVersion: 2, landedAt: "2026-07-01T00:00:00.000Z" };
  const quotes = {
    1: invoiceQuote(meta, { version: 1, rows: [["Earthworks", 12000]] }),
    2: invoiceQuote(meta, { version: 2, rows: [["Earthworks", 12000], ["Variation", 3500]] }),
  };
  const claims = { 1: claimOf(quotes[1], 30), 2: claimOf(quotes[2], 30) };
  const invoiceNumber = `EI-${number}-M1`;
  const deposit = {
    id: `${id}-m1`,
    jobId: id,
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    invoiceNumber,
    receiptNumber: `ER-${number}-M1`,
    reference: `EQ-${number}`,
    percentage: 30,
    ...claims[recordVersion],
    currency: "AUD",
    lineItems: [{ description: "Earthworks", quantity: 1, unit: "lot", unitPrice: claims[recordVersion].subtotal, totalPrice: claims[recordVersion].subtotal }],
    dueDate: "2026-07-24",
    issuedAt: "2026-07-10T01:00:00.000Z",
    status: "authorised",
    payments: [],
    pdfPath: `milestone-invoices/${invoiceNumber}.pdf`,
  };
  const completion = {
    id: `${id}-m2`,
    jobId: id,
    milestoneIndex: 1,
    milestoneLabel: "Completion",
    invoiceNumber: `EI-${number}-M2`,
    receiptNumber: `ER-${number}-M2`,
    reference: `EQ-${number}`,
    percentage: 70,
    subtotal: 0,
    gst: 0,
    total: 0,
    currency: "AUD",
    lineItems: [],
    status: "draft",
    payments: [],
    pdfPath: `milestone-invoices/EI-${number}-M2.pdf`,
  };
  await write(join(jobDir, "meta.json"), meta);
  await write(join(jobDir, "quote-versions/v001/quote.json"), quotes[1]);
  await write(join(jobDir, "quote.json"), quotes[2]);
  const pdf = await renderLegacyInvoicePdf({ meta, quote: quotes[pdfVersion], milestone: deposit, amounts: claims[pdfVersion], milestones: [deposit, completion] });
  await write(join(jobDir, deposit.pdfPath), pdf);
  await write(join(jobDir, "milestone-invoices/state.json"), {
    version: 1,
    paymentSchedule: { milestones: [{ label: "Deposit", percentage: 30 }, { label: "Completion", percentage: 70 }] },
    milestoneInvoices: [deposit, completion],
  });
  await write(join(jobDir, "sent-emails.jsonl"), `${JSON.stringify({
    id: `sent-${id}`,
    ts: deposit.issuedAt,
    kind: "invoice.sent",
    documentType: "invoice",
    messageId: `msg-${id}`,
    to: ["customer@example.invalid"],
    subject: `Invoice ${invoiceNumber}`,
    attachments: [{ filename: `${invoiceNumber} — Sam Customer — Synthetic scope — Invoice.pdf`, contentType: "application/pdf" }],
    quoteVersion: sentVersion,
    milestoneIndex: 0,
  })}\n`);
  return { jobDir, meta, quotes, claims, pdf, number: invoiceNumber, deposit, completion };
}

/**
 * A job shaped like the oldest milestone invoices in production (April 2026):
 * every milestone "authorised" with no issue time, no payments and nothing
 * paid. From 2026-04-10 to 2026-08-05 Field derived a milestone's status from
 * its amounts: a $0 milestone (milestones built while the quote total was 0)
 * was "paid", and a later rebuild against the priced quote turned that stored
 * "paid" into "authorised" with the amount due. No issue event ran, so no
 * `issuedAt` was written, and sending an "authorised" invoice never set one.
 * The stored PDF prints the date it was drawn ("Issued: 14 April 2026").
 *
 *   frozen     today's legacy freeze has run: each milestone carries the
 *              issued revision it synthesized, with no issue time either
 *   evidence   extra records the job holds: { invoiceSentAt, sentEmail,
 *              activity } (times by milestone index), written as Field wrote
 *              them then
 *   withPdf    false: the stored PDFs are gone
 *
 * Returns { jobDir, meta, quote, milestones, pdfs, printedOn }.
 */
export async function createAprilMilestoneJob(dataDir, { id = "job-april", number = "2604-92", schedule = [["Deposit", 30], ["Progress", 40], ["Final", 30]], frozen = false, evidence = {}, withPdf = true } = {}) {
  const jobDir = join(dataDir, "2026-04-02", id);
  const meta = { ...landedMeta({ id, number }), landedAt: "2026-04-11T00:00:00.000Z", ...(evidence.invoiceSentAt ? { invoiceSentAt: evidence.invoiceSentAt } : {}) };
  const quote = invoiceQuote(meta, { rows: [["Excavation", 10000]] });
  const printedAt = "2026-04-14T02:00:00.000Z";
  const milestones = schedule.map(([label, percentage], index) => {
    const claim = claimOf(quote, percentage);
    const invoiceNumber = `EI-${number}-M${index + 1}`;
    return {
      id: `${id}-m${index + 1}`,
      jobId: id,
      quoteId: `EQ-${number}`,
      milestoneIndex: index,
      milestoneLabel: label,
      invoiceNumber,
      receiptNumber: `ER-${number}-M${index + 1}`,
      reference: `EQ-${number}`,
      percentage,
      ...claim,
      currency: "AUD",
      amountPaid: 0,
      amountDue: claim.total,
      lineItems: [{ description: "Excavation", quantity: 1, unit: "lot", unitPrice: claim.subtotal, totalPrice: claim.subtotal }],
      dueDate: null,
      issuedAt: null,
      paidAt: null,
      status: "authorised",
      payments: [],
      pdfPath: `milestone-invoices/${invoiceNumber}.pdf`,
      receiptPdfPath: `milestone-receipts/ER-${number}-M${index + 1}.pdf`,
    };
  });
  const pdfs = [];
  for (const milestone of milestones) {
    // Drawn the way Field drew it: the date printed is when it was drawn.
    const pdf = await renderLegacyInvoicePdf({ meta, quote, milestone: { ...milestone, issuedAt: printedAt }, amounts: {}, milestones });
    pdfs.push(pdf);
    if (withPdf) await write(join(jobDir, milestone.pdfPath), pdf);
  }
  const stored = frozen
    ? milestones.map((milestone) => ({
      ...milestone,
      issuedRevision: normalizeInvoiceRevision({
        revisionNumber: 1,
        invoiceNumber: milestone.invoiceNumber,
        issuedAt: null,
        subtotal: milestone.subtotal,
        gst: milestone.gst,
        total: milestone.total,
        currency: milestone.currency,
        lineItems: milestone.lineItems,
        pdfPath: milestone.pdfPath,
        quoteVersion: 1,
        quoteVersionInferred: true,
        artifactState: ARTIFACT_STATE.ADOPT_PENDING,
      }),
    }))
    : milestones;
  await write(join(jobDir, "meta.json"), meta);
  await write(join(jobDir, "quote.json"), quote);
  await write(join(jobDir, "milestone-invoices/state.json"), {
    version: 1,
    paymentSchedule: { milestones: schedule.map(([label, percentage]) => ({ label, percentage })) },
    milestoneInvoices: stored,
  });
  const sentEmails = Object.entries(evidence.sentEmail || {}).map(([index, ts]) => JSON.stringify({
    id: `sent-${id}-${index}`,
    ts,
    kind: "invoice.sent",
    documentType: "invoice",
    messageId: `msg-${id}-${index}`,
    to: ["customer@example.invalid"],
    subject: `Invoice ${milestones[index].invoiceNumber}`,
    attachments: [{ filename: `${milestones[index].invoiceNumber} — Sam Customer — Synthetic scope — Invoice.pdf`, contentType: "application/pdf" }],
    quoteVersion: 1,
    milestoneIndex: Number(index),
  }));
  if (sentEmails.length) await write(join(jobDir, "sent-emails.jsonl"), `${sentEmails.join("\n")}\n`);
  const activity = [
    { id: `act-${id}-generated`, kind: "invoice.milestones_generated", ts: "2026-04-11T00:00:00.000Z", actor: { kind: "system", label: "Field" }, title: "Milestone invoices generated", body: `${milestones.length} milestone invoice(s) generated.` },
    ...Object.entries(evidence.activity || {}).map(([index, ts]) => ({
      id: `act-${id}-sent-${index}`,
      kind: "invoice.sent",
      ts,
      actor: { kind: "system", label: "Field" },
      title: "Invoice sent",
      body: `${milestones[index].invoiceNumber} (${milestones[index].milestoneLabel}) emailed to customer@example.invalid.`,
    })),
  ];
  await write(join(jobDir, "job-state/activity.jsonl"), `${activity.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { jobDir, meta, quote, milestones, pdfs, printedOn: "2026-04-14" };
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
  // Deposit issued and paid, then revised in place to -R2: the payment was
  // recorded against the original number.
  async revisedPaid(dataDir) {
    const { jobDir, quote } = await createLandedJob(join(dataDir, "2026-05-01", "job-revised-paid"), { id: "job-revised-paid", number: "2605-07", rows: [["Fencing", 200]] });
    await actions.generate(jobDir, [{ label: "Deposit", percentage: 50 }, { label: "Final", percentage: 50 }]);
    await actions.issue(jobDir, 0);
    await actions.pay(jobDir, 0, 50);
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
