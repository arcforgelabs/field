import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JOB_GENERATIONS_DIR, resolveActiveJobGeneration, runAtomicJobGeneration } from "./job-generation.js";
import { readQuoteLifecycle, recordQuoteArchived } from "./quote-lifecycle.js";

import {
  applyMilestoneInvoiceCompatFields,
  buildMilestoneInvoices,
  recordMilestoneInvoicePayment,
  updateMilestoneInvoice,
} from "./job-documents.js";
import {
  MILESTONE_INVOICE_STATE_FILE,
  readJobMeta,
  writeJobMeta,
} from "./job-meta-store.js";

function createMeta(overrides = {}) {
  return {
    id: "job-meta-store-1",
    title: "Milestone state store test",
    label: "Milestone state store test",
    outputMode: "quote",
    pipelineStage: "landed",
    deliveryStatus: "landed",
    quoteVersion: 1,
    quoteNumber: "EQ-STORE-01",
    jobNumber: "JOB-STORE-01",
    createdAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function createQuote(meta, overrides = {}) {
  return {
    kind: "quote",
    version: overrides.version || 1,
    quoteNumber: overrides.quoteNumber || meta.quoteNumber,
    jobNumber: overrides.jobNumber || meta.jobNumber,
    title: meta.title,
    summary: "Milestone state store test",
    quoteCatalog: {
      id: "embark-default",
      name: "Sample Catalogue",
      currency: "AUD",
      gstRate: 0.1,
    },
    presentation: {
      scopeText: "Milestone state store test",
      scheduleItems: [
        {
          code: "scope",
          label: "Scope item",
          quantity: 1,
          unit: "lot",
          unitPrice: 200,
          totalPrice: 200,
          sourceLineItemCodes: ["scope"],
        },
      ],
    },
    lineItems: [
      {
        code: "scope",
        label: "Scope item",
        quantity: 1,
        unit: "lot",
        unitPrice: 200,
        totalPrice: 200,
        customerVisible: true,
      },
    ],
    totals: {
      subtotal: 200,
      gst: 20,
      total: 220,
      currency: "AUD",
    },
    delivery: {
      status: overrides.deliveryStatus || "final",
    },
  };
}

test("writeJobMeta stores milestone invoices in the canonical state file instead of meta.json", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-meta-store-"));

  try {
    const paymentSchedule = {
      milestones: [
        { label: "Full payment", percentage: 100 },
      ],
    };
    const meta = createMeta({ paymentSchedule });
    const quote = createQuote(meta);
    const milestoneInvoices = buildMilestoneInvoices({
      meta,
      quote,
      paymentSchedule,
    }).milestoneInvoices;

    const hydratedMeta = await writeJobMeta(jobDir, {
      ...meta,
      milestoneInvoices,
    });

    const rawMeta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
    assert.equal("milestoneInvoices" in rawMeta, false);
    assert.equal("totalInvoicePaidAmount" in rawMeta, false);
    assert.equal(rawMeta.paymentSchedule.milestones.length, 1);

    const canonicalState = JSON.parse(await readFile(join(jobDir, MILESTONE_INVOICE_STATE_FILE), "utf8"));
    assert.equal(canonicalState.milestoneInvoices.length, 1);
    assert.equal(canonicalState.milestoneInvoices[0].invoiceNumber, "EI-STORE-01-M1");

    assert.equal(hydratedMeta.milestoneInvoices.length, 1);
    assert.equal(hydratedMeta.milestoneInvoices[0].total, 220);

    const rereadMeta = await readJobMeta(jobDir);
    assert.equal(rereadMeta.milestoneInvoices[0].invoiceNumber, "EI-STORE-01-M1");
    assert.equal(rereadMeta.invoicePaidAmount, 0);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("applyMilestoneInvoiceCompatFields freezes the legacy meta contract with a running total", () => {
  const meta = createMeta();
  const quote = createQuote(meta);
  let { milestoneInvoices } = buildMilestoneInvoices({
    meta,
    quote,
    paymentSchedule: {
      milestones: [
        { label: "Deposit", percentage: 30 },
        { label: "Progress", percentage: 30 },
        { label: "Final", percentage: 40 },
      ],
    },
  });

  // No activity yet — totalInvoicePaidAmount is zero, next-open view is m0.
  let compat = applyMilestoneInvoiceCompatFields({ ...meta, milestoneInvoices });
  assert.equal(compat.invoicePaidAmount, 0);
  assert.equal(compat.totalInvoicePaidAmount, 0);

  // Authorise and fully pay milestone 0.
  const authorised = updateMilestoneInvoice({
    milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised" },
  });
  const recorded = recordMilestoneInvoicePayment({
    milestoneInvoices: authorised.milestoneInvoices,
    milestoneIndex: 0,
    payment: { amount: authorised.milestoneInvoice.total, date: "2026-04-10" },
  });
  milestoneInvoices = recorded.milestoneInvoices;

  compat = applyMilestoneInvoiceCompatFields({ ...meta, milestoneInvoices });
  // invoicePaidAmount is the NEXT-OPEN milestone's paid amount (m1 = 0),
  // not the running total — the legacy scalar is contextual, not cumulative.
  assert.equal(compat.invoicePaidAmount, 0);
  // totalInvoicePaidAmount sums across all milestones.
  assert.equal(compat.totalInvoicePaidAmount, recorded.milestoneInvoice.total);
  // Meta's milestoneInvoices array is the single source of truth for
  // hydrated callers; raw consumers should use this field or the API.
  assert.equal(compat.milestoneInvoices[0].status, "paid");
});

test("applyMilestoneInvoiceCompatFields preserves legacy single-invoice semantics when no milestones exist", () => {
  const meta = createMeta({ invoicePaidAmount: 1234.56, invoiceSentAt: "2026-04-10T00:00:00.000Z" });
  const compat = applyMilestoneInvoiceCompatFields(meta);
  assert.equal(compat.invoicePaidAmount, 1234.56);
  assert.equal(compat.totalInvoicePaidAmount, 1234.56);
  assert.equal(compat.invoiceSentAt, "2026-04-10T00:00:00.000Z");
});

test("readJobMeta hydrates legacy milestone invoices directly from meta.json when no canonical state exists", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-meta-legacy-"));

  try {
    const paymentSchedule = {
      milestones: [
        { label: "Deposit", percentage: 50 },
        { label: "Final payment", percentage: 50 },
      ],
    };
    const meta = createMeta({ paymentSchedule });
    const quote = createQuote(meta);
    const milestoneInvoices = buildMilestoneInvoices({
      meta,
      quote,
      paymentSchedule,
    }).milestoneInvoices;
    milestoneInvoices[0] = {
      ...milestoneInvoices[0],
      status: "authorised",
      issuedAt: "2026-04-10T01:00:00.000Z",
    };

    await writeFile(join(jobDir, "meta.json"), JSON.stringify({
      ...meta,
      milestoneInvoices,
    }, null, 2));

    const hydratedMeta = await readJobMeta(jobDir);
    assert.equal(hydratedMeta.paymentSchedule.milestones.length, 2);
    assert.equal(hydratedMeta.milestoneInvoices.length, 2);
    assert.equal(hydratedMeta.milestoneInvoices[0].status, "authorised");
    assert.equal(hydratedMeta.invoiceSentAt, "2026-04-10T01:00:00.000Z");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// A committed generation is validated against its commit marker on
// every read. Writing meta into it in place made it fail validation, so it
// was quarantined and the job silently fell back to the previous generation
// (losing the newer quote/sent state and the write itself).
async function seedTwoGenerations(jobDir) {
  const meta = createMeta({ pipelineStage: "draft", deliveryStatus: "draft" });
  await runAtomicJobGeneration(jobDir, async (stage) => {
    await writeFile(join(stage, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(join(stage, "quote.json"), JSON.stringify({ version: 1, totals: { total: 100 } }, null, 2));
  });
  const sentMeta = { ...meta, pipelineStage: "sent", deliveryStatus: "sent", quoteSentAt: "2026-04-10T01:00:00.000Z" };
  await runAtomicJobGeneration(jobDir, async (stage) => {
    await writeFile(join(stage, "meta.json"), JSON.stringify(sentMeta, null, 2));
    await writeFile(join(stage, "quote.json"), JSON.stringify({ version: 1, totals: { total: 200 } }, null, 2));
  });
  return sentMeta;
}

async function generationEntries(jobDir) {
  return (await readdir(join(jobDir, JOB_GENERATIONS_DIR))).sort();
}

test("writing meta outside a staged generation is refused and the active generation survives", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-meta-store-committed-"));
  try {
    const sentMeta = await seedTwoGenerations(jobDir);
    assert.match(await resolveActiveJobGeneration(jobDir), /g-000002$/);

    await assert.rejects(
      () => writeJobMeta(jobDir, { ...sentMeta, archivedAt: "2026-10-12T00:00:00.000Z" }),
      (error) => error.code === "FIELD_COMMITTED_GENERATION_WRITE",
    );
    await assert.rejects(
      () => recordQuoteArchived({ jobDir, meta: sentMeta, archivedAt: "2026-10-12T00:00:00.000Z" }),
      (error) => error.code === "FIELD_COMMITTED_GENERATION_WRITE",
    );

    assert.deepEqual(await generationEntries(jobDir), ["g-000001", "g-000002"], "nothing quarantined");
    assert.match(await resolveActiveJobGeneration(jobDir), /g-000002$/);
    const meta = await readJobMeta(jobDir);
    assert.equal(meta.pipelineStage, "sent");
    assert.equal(meta.quoteSentAt, "2026-04-10T01:00:00.000Z");
    const quote = JSON.parse(await readFile(join(await resolveActiveJobGeneration(jobDir), "quote.json"), "utf8"));
    assert.equal(quote.totals.total, 200);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("writing meta inside a staged generation publishes it on top of the latest generation", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-meta-store-staged-"));
  try {
    const sentMeta = await seedTwoGenerations(jobDir);
    await runAtomicJobGeneration(jobDir, async (stage) => {
      await writeJobMeta(stage, { ...sentMeta, archivedAt: "2026-10-12T00:00:00.000Z" });
      await recordQuoteArchived({ jobDir: stage, meta: sentMeta, archivedAt: "2026-10-12T00:00:00.000Z" });
    });

    assert.deepEqual(await generationEntries(jobDir), ["g-000001", "g-000002", "g-000003"]);
    assert.match(await resolveActiveJobGeneration(jobDir), /g-000003$/);
    const meta = await readJobMeta(jobDir);
    assert.equal(meta.archivedAt, "2026-10-12T00:00:00.000Z");
    assert.equal(meta.pipelineStage, "sent");
    assert.equal((await readQuoteLifecycle(jobDir)).archivedAt, "2026-10-12T00:00:00.000Z");
    const quote = JSON.parse(await readFile(join(await resolveActiveJobGeneration(jobDir), "quote.json"), "utf8"));
    assert.equal(quote.totals.total, 200);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a job with no generation yet still takes meta at its root (new manual jobs)", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-job-meta-store-root-"));
  try {
    await writeJobMeta(jobDir, createMeta());
    assert.equal(JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8")).id, "job-meta-store-1");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
