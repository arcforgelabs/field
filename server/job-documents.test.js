import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInvoicePaymentSummary,
  buildMilestoneInvoices,
  coerceInvoicePaidAmount,
  findMilestoneInvoiceRevision,
  getMilestoneInvoiceRevisions,
  markMilestoneInvoiceUnsent,
  markMilestoneInvoiceUnpaid,
  normalizePaymentSchedule,
  normalizeStoredMilestoneInvoices,
  prepareRequestedJobDocument,
  recordMilestoneInvoicePayment,
  resolveJobDocumentType,
  updateMilestoneInvoice,
  validateInvoicePaidAmount,
  voidMilestoneInvoicePayment,
} from "./job-documents.js";
import { getCustomerPresentationFinancials } from "./quote-presentation.js";
import { ARTIFACT_STATE } from "./invoice-artifact-state.js";

function createQuoteFixture() {
  return {
    kind: "quote",
    version: 1,
    quoteNumber: "EQ-0041",
    title: "Milestone invoice test",
    generatedAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    summary: "Retaining wall and drainage works.",
    quoteCatalog: {
      id: "embark-default",
      currency: "AUD",
      gstRate: 0.1,
      businessProfile: {
        paymentMethods: {
          bankTransfer: {
            accountName: "Your Business Pty Ltd",
            bsb: "000-000",
            accountNumber: "0000 0000 0",
            bank: "Your bank",
          },
        },
      },
    },
    lineItems: [
      {
        code: "wall",
        label: "Retaining wall",
        quantity: 1,
        unit: "lot",
        unitPrice: 60,
        totalPrice: 60,
        customerVisible: true,
      },
      {
        code: "drainage",
        label: "Drainage",
        quantity: 1,
        unit: "lot",
        unitPrice: 40,
        totalPrice: 40,
        customerVisible: true,
      },
    ],
    presentation: {
      scopeText: "Retaining wall and drainage works.",
      scheduleItems: [
        {
          code: "wall",
          label: "Retaining wall",
          quantity: 1,
          unit: "lot",
          unitPrice: 60,
          totalPrice: 60,
          sourceLineItemCodes: ["wall"],
        },
        {
          code: "drainage",
          label: "Drainage",
          quantity: 1,
          unit: "lot",
          unitPrice: 40,
          totalPrice: 40,
          sourceLineItemCodes: ["drainage"],
        },
      ],
    },
    totals: {
      subtotal: 100,
      gst: 10,
      total: 110,
      currency: "AUD",
    },
    delivery: {
      status: "final",
    },
  };
}

test("resolveJobDocumentType defaults landed jobs to invoice", () => {
  assert.equal(resolveJobDocumentType({ meta: { pipelineStage: "landed" } }), "invoice");
  assert.equal(resolveJobDocumentType({ meta: { pipelineStage: "sent" } }), "quote");
  assert.equal(resolveJobDocumentType({ meta: { pipelineStage: "landed" }, documentType: "quote" }), "quote");
});

test("prepareRequestedJobDocument applies an invoice-prefixed reference for legacy invoice views", () => {
  const quote = createQuoteFixture();
  const prepared = prepareRequestedJobDocument({
    meta: {
      id: "job-legacy-invoice-1",
      pipelineStage: "landed",
      quoteNumber: "EQ-0041",
    },
    quote,
    documentType: "invoice",
  });

  assert.equal(prepared.quote.quoteNumber, "EI-0041");
  assert.equal(prepared.milestoneInvoice, null);
});

test("normalizePaymentSchedule rejects schedules that do not sum to 100", () => {
  assert.deepEqual(
    normalizePaymentSchedule({
      milestones: [
        { label: "Deposit", percentage: 50 },
        { label: "Final", percentage: 50 },
      ],
    }),
    {
      milestones: [
        { label: "Deposit", percentage: 50 },
        { label: "Final", percentage: 50 },
      ],
    }
  );

  assert.throws(
    () => normalizePaymentSchedule({
      milestones: [
        { label: "Deposit", percentage: 20 },
        { label: "Final", percentage: 70 },
      ],
    }),
    /sum to exactly 100/i
  );
});

test("buildMilestoneInvoices allocates totals exactly and adjusts rounding on the last milestone", () => {
  const quote = createQuoteFixture();
  const result = buildMilestoneInvoices({
    meta: { id: "job-rounding-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [
        { label: "M1", percentage: 33.33 },
        { label: "M2", percentage: 33.33 },
        { label: "M3", percentage: 33.34 },
      ],
    },
  });

  assert.deepEqual(
    result.milestoneInvoices.map((invoice) => invoice.total),
    [36.66, 36.66, 36.68]
  );
  assert.equal(
    result.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
    110
  );
});

test("30/70 milestone invoices preserve the schedule and exact document allocations", () => {
  const quote = createQuoteFixture();
  const paymentSchedule = {
    milestones: [
      { label: "Deposit", percentage: 30 },
      { label: "Completion", percentage: 70 },
    ],
  };
  const generated = buildMilestoneInvoices({
    meta: { id: "job-30-70-documents-1", pipelineStage: "landed" },
    quote,
    paymentSchedule,
  });

  assert.deepEqual(generated.paymentSchedule, paymentSchedule);
  assert.deepEqual(generated.milestoneInvoices.map((invoice) => invoice.total), [33, 77]);
  assert.equal(
    generated.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
    quote.totals.total,
  );

  const preparedDeposit = prepareRequestedJobDocument({
    meta: {
      id: "job-30-70-documents-1",
      pipelineStage: "landed",
      paymentSchedule: generated.paymentSchedule,
      milestoneInvoices: generated.milestoneInvoices,
    },
    quote,
    documentType: "invoice",
    milestoneIndex: 0,
  });
  const preparedCompletion = prepareRequestedJobDocument({
    meta: {
      id: "job-30-70-documents-1",
      pipelineStage: "landed",
      paymentSchedule: generated.paymentSchedule,
      milestoneInvoices: generated.milestoneInvoices,
    },
    quote,
    documentType: "invoice",
    milestoneIndex: 1,
  });

  assert.deepEqual(preparedDeposit.meta.paymentSchedule, paymentSchedule);
  assert.equal(preparedDeposit.meta.milestoneInvoice.milestoneLabel, "Deposit");
  assert.equal(preparedDeposit.meta.milestoneInvoice.percentage, 30);
  assert.equal(preparedDeposit.meta.milestoneInvoice.total, 33);
  assert.equal(preparedCompletion.meta.milestoneInvoice.milestoneLabel, "Completion");
  assert.equal(preparedCompletion.meta.milestoneInvoice.percentage, 70);
  assert.equal(preparedCompletion.meta.milestoneInvoice.total, 77);
});

test("buildMilestoneInvoices supports fixed total milestones for carried-forward deposits", () => {
  const quote = createQuoteFixture();
  const result = buildMilestoneInvoices({
    meta: { id: "job-fixed-milestone-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [
        { label: "Imported deposit", percentage: 25, fixedTotal: 25 },
        { label: "Progress", percentage: 25, fixedTotal: 30 },
        { label: "Final", percentage: 50, fixedTotal: 55 },
      ],
    },
  });

  assert.deepEqual(
    result.milestoneInvoices.map((invoice) => invoice.total),
    [25, 30, 55]
  );
  assert.deepEqual(
    result.milestoneInvoices.map((invoice) => invoice.subtotal),
    [22.73, 27.27, 50]
  );
  assert.equal(
    result.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
    110
  );
  assert.equal(result.paymentSchedule.milestones[0].fixedTotal, 25);
});

test("a mixed percentage/fixed schedule rebalances the open milestones correctly around a frozen invoice", () => {
  // Schedule: [50%, fixed $5000, 50%]. Milestone 1 (index 0) is already
  // issued and frozen at $2,500 — an amount unrelated to its 50% share,
  // exactly as a real frozen invoice is. An approved variation brings the
  // quote to $12,000. The bug mixed cents (fixedTotal) and raw percentage
  // numbers in one weight array; the fix reuses the fixed-then-variable
  // allocator on the open subset: the fixed milestone claims exactly
  // $5,000 and the remaining $4,500 goes to the percentage milestone.
  const quote = {
    ...createQuoteFixture(),
    lineItems: [
      {
        code: "scope",
        label: "Scope",
        quantity: 1,
        unit: "lot",
        unitPrice: 10909.09,
        totalPrice: 10909.09,
        customerVisible: true,
      },
    ],
    presentation: {
      scopeText: "Mixed schedule test.",
      scheduleItems: [
        {
          code: "scope",
          label: "Scope",
          quantity: 1,
          unit: "lot",
          unitPrice: 10909.09,
          totalPrice: 10909.09,
          sourceLineItemCodes: ["scope"],
        },
      ],
    },
    totals: { subtotal: 10909.09, gst: 1090.91, total: 12000, currency: "AUD" },
  };

  const existingMilestoneInvoices = [
    {
      milestoneIndex: 0,
      milestoneLabel: "M1",
      status: "authorised",
      issuedAt: "2026-05-01T00:00:00.000Z",
      invoiceNumber: "EI-MIX-01-M1",
      subtotal: 2272.73,
      gst: 227.27,
      total: 2500,
      currency: "AUD",
      lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 2500, totalPrice: 2500 }],
      issuedRevision: {
        revisionNumber: 1,
        invoiceNumber: "EI-MIX-01-M1",
        issuedAt: "2026-05-01T00:00:00.000Z",
        subtotal: 2272.73,
        gst: 227.27,
        total: 2500,
        currency: "AUD",
        lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 2500, totalPrice: 2500 }],
      },
    },
  ];

  const result = buildMilestoneInvoices({
    meta: { id: "job-mixed-schedule-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [
        { label: "M1", percentage: 50 },
        { label: "M2 fixed", fixedTotal: 5000 },
        { label: "M3", percentage: 50 },
      ],
    },
    existingMilestoneInvoices,
  });

  assert.deepEqual(
    result.milestoneInvoices.map((invoice) => invoice.total),
    [2500, 5000, 4500]
  );
  assert.equal(
    result.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
    12000
  );
});

test("buildMilestoneInvoices proportionally scales customer-facing line items", () => {
  const quote = createQuoteFixture();
  const result = buildMilestoneInvoices({
    meta: { id: "job-scale-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [
        { label: "Deposit", percentage: 50 },
        { label: "Final", percentage: 50 },
      ],
    },
  });

  assert.deepEqual(result.milestoneInvoices[0].lineItems, [
    {
      description: "Retaining wall",
      quantity: 1,
      unit: "lot",
      unitPrice: 30,
      totalPrice: 30,
      accountCode: null,
      sourceCode: "wall",
    },
    {
      description: "Drainage",
      quantity: 1,
      unit: "lot",
      unitPrice: 20,
      totalPrice: 20,
      accountCode: null,
      sourceCode: "drainage",
    },
  ]);
  assert.equal(result.milestoneInvoices[0].subtotal, 50);
  assert.equal(result.milestoneInvoices[0].gst, 5);
  assert.equal(result.milestoneInvoices[0].total, 55);
});

// A frozen invoice's own historical subtotal/GST
// split can drift from what the CURRENT quote's aggregate split implies —
// even while its TOTAL still fits inside the quote total — e.g. a later
// quote edit changed which lines carry GST. The remainingTotalCents<=0
// branch does not catch this (the totals genuinely still reconcile), so
// deriving the open milestone's subtotal as "quote subtotal minus frozen
// subtotal" can go negative. Clamping that to zero used to collapse the
// open milestone's subtotal to $0 and stamp its entire claim as GST — a
// wrong tax split on a customer-facing invoice even though the money total
// still reconciled.
test("the rebalance derives a coherent subtotal/GST split for the open milestone instead of collapsing it to 100% GST when a frozen invoice's historical subtotal exceeds the quote subtotal", () => {
  const quote = createQuoteFixture(); // subtotal 100, gst 10, total 110
  const existingMilestoneInvoices = [{
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    status: "authorised",
    issuedAt: "2026-05-01T00:00:00.000Z",
    invoiceNumber: "EI-GST-01-M1",
    // Frozen at issue time with almost no GST attributed to it (e.g. a
    // GST-exempt scope at the time) — its OWN subtotal (102) already
    // exceeds the CURRENT quote's whole subtotal (100), even though its
    // total (102) comfortably fits inside the quote total (110).
    subtotal: 102,
    gst: 0,
    total: 102,
    currency: "AUD",
    lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 102, totalPrice: 102 }],
    issuedRevision: {
      revisionNumber: 1,
      invoiceNumber: "EI-GST-01-M1",
      issuedAt: "2026-05-01T00:00:00.000Z",
      subtotal: 102,
      gst: 0,
      total: 102,
      currency: "AUD",
      lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 102, totalPrice: 102 }],
    },
  }];

  const result = buildMilestoneInvoices({
    meta: { id: "job-gst-drift-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [
        { label: "Deposit", percentage: 50 },
        { label: "Final", percentage: 50 },
      ],
    },
    existingMilestoneInvoices,
  });

  const [frozen, open] = result.milestoneInvoices;
  assert.equal(frozen.total, 102);
  // The $8 remainder ($110 - $102) lands entirely on the open milestone —
  // money still reconciles exactly.
  assert.equal(open.total, 8);
  assert.equal(frozen.total + open.total, 110);

  // The open milestone's subtotal must NOT collapse to zero: derived from
  // the quote's own ~9.09% subtotal:total ratio applied to its $8 claim, it
  // lands near $7.27, not $0.
  assert.ok(open.subtotal > 0, "the open milestone's subtotal must not collapse to zero");
  assert.equal(open.subtotal, 7.27);
  // GST is the coherent remainder (total - subtotal), not the fabricated
  // 100% of the claim the old clamp-to-zero produced.
  assert.equal(open.gst, 0.73);
  assert.ok(open.gst < open.total, "GST must not consume the entire open milestone total");
});

test("milestone payment recording enforces status progression and caps overpayments", () => {
  const quote = createQuoteFixture();
  const generated = buildMilestoneInvoices({
    meta: { id: "job-payment-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [{ label: "Full payment", percentage: 100 }],
    },
  });

  assert.throws(
    () => recordMilestoneInvoicePayment({
      milestoneInvoices: generated.milestoneInvoices,
      milestoneIndex: 0,
      payment: { amount: 20 },
    }),
    /must be authorised before recording payments/i
  );

  const authorised = updateMilestoneInvoice({
    milestoneInvoices: generated.milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised", dueDate: "2026-04-20" },
  });
  assert.equal(authorised.milestoneInvoice.status, "authorised");
  assert.equal(authorised.milestoneInvoice.dueDate, "2026-04-20");

  assert.throws(
    () => updateMilestoneInvoice({
      milestoneInvoices: authorised.milestoneInvoices,
      milestoneIndex: 0,
      patch: { status: "paid" },
    }),
    /cannot be marked paid until the balance is cleared/i
  );

  const firstPayment = recordMilestoneInvoicePayment({
    milestoneInvoices: authorised.milestoneInvoices,
    milestoneIndex: 0,
    payment: {
      amount: 60,
      date: "2026-04-21",
      reference: "DEP-001",
      method: "bank_transfer",
    },
  });
  assert.equal(firstPayment.milestoneInvoice.status, "authorised");
  assert.equal(firstPayment.milestoneInvoice.amountPaid, 60);
  assert.equal(firstPayment.milestoneInvoice.amountDue, 50);

  assert.throws(
    () => recordMilestoneInvoicePayment({
      milestoneInvoices: firstPayment.milestoneInvoices,
      milestoneIndex: 0,
      payment: { amount: 55, date: "2026-04-22" },
    }),
    /cannot exceed the milestone balance due/i
  );

  const finalPayment = recordMilestoneInvoicePayment({
    milestoneInvoices: firstPayment.milestoneInvoices,
    milestoneIndex: 0,
    payment: {
      amount: 50,
      date: "2026-04-22",
      reference: "BAL-001",
      method: "bank_transfer",
    },
  });
  assert.equal(finalPayment.milestoneInvoice.status, "paid");
  assert.equal(finalPayment.milestoneInvoice.amountPaid, 110);
  assert.equal(finalPayment.milestoneInvoice.amountDue, 0);
  assert.equal(finalPayment.milestoneInvoice.paidAt, "2026-04-22");
});

test("a recorded payment defaults to the invoice number and revision number it was paid against", () => {
  const quote = createQuoteFixture();
  const generated = buildMilestoneInvoices({
    meta: { id: "job-payment-source-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [{ label: "Full payment", percentage: 100 }],
    },
  });
  const authorised = updateMilestoneInvoice({
    milestoneInvoices: generated.milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised" },
  });
  assert.equal(authorised.milestoneInvoice.invoiceNumber, "EI-0041-M1");
  assert.equal(authorised.milestoneInvoice.revisionNumber, 1);

  const paid = recordMilestoneInvoicePayment({
    milestoneInvoices: authorised.milestoneInvoices,
    milestoneIndex: 0,
    payment: { amount: 110, date: "2026-04-22", reference: "BAL-001" },
  });
  assert.equal(paid.payment.sourceInvoiceNumber, "EI-0041-M1");
  assert.equal(paid.payment.sourceRevisionNumber, 1);

  // An explicitly supplied value still wins — the migration path relies on this.
  const migrated = recordMilestoneInvoicePayment({
    milestoneInvoices: authorised.milestoneInvoices,
    milestoneIndex: 0,
    payment: {
      amount: 110,
      date: "2026-04-22",
      sourceInvoiceNumber: "EI-0041-M1-R2",
      sourceRevisionNumber: 2,
    },
  });
  assert.equal(migrated.payment.sourceInvoiceNumber, "EI-0041-M1-R2");
  assert.equal(migrated.payment.sourceRevisionNumber, 2);

  // Both fields round-trip through normalization.
  const roundTripped = normalizeStoredMilestoneInvoices(paid.milestoneInvoices)[0];
  assert.equal(roundTripped.payments[0].sourceInvoiceNumber, "EI-0041-M1");
  assert.equal(roundTripped.payments[0].sourceRevisionNumber, 1);
});

test("voidMilestoneInvoicePayment excludes accidental payments without deleting audit history", () => {
  const quote = createQuoteFixture();
  const generated = buildMilestoneInvoices({
    meta: { id: "job-void-payment-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [{ label: "Full payment", percentage: 100 }],
    },
  });
  const authorised = updateMilestoneInvoice({
    milestoneInvoices: generated.milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised" },
  });
  const firstPayment = recordMilestoneInvoicePayment({
    milestoneInvoices: authorised.milestoneInvoices,
    milestoneIndex: 0,
    payment: { amount: 60, date: "2026-04-21", reference: "REAL" },
  });
  const secondPayment = recordMilestoneInvoicePayment({
    milestoneInvoices: firstPayment.milestoneInvoices,
    milestoneIndex: 0,
    payment: { amount: 50, date: "2026-04-22", reference: "ACCIDENTAL" },
  });

  const voided = voidMilestoneInvoicePayment({
    milestoneInvoices: secondPayment.milestoneInvoices,
    milestoneIndex: 0,
    paymentId: secondPayment.payment.id,
    reason: "Clicked paid by mistake",
    actor: { kind: "user", label: "Alex" },
  });

  assert.equal(voided.milestoneInvoice.amountPaid, 60);
  assert.equal(voided.milestoneInvoice.amountDue, 50);
  assert.equal(voided.milestoneInvoice.status, "authorised");
  assert.equal(voided.milestoneInvoice.payments.length, 2);
  assert.ok(voided.milestoneInvoice.payments[1].voidedAt);
  assert.equal(voided.milestoneInvoice.payments[1].voidReason, "Clicked paid by mistake");
});

test("prepareRequestedJobDocument preserves the quote pricing schedule verbatim on milestone invoices", () => {
  const quote = createQuoteFixture();
  const organizer = {
    root: ["group:works"],
    nodes: {
      "group:works": {
        kind: "group",
        label: "Works",
        amountVisible: true,
        children: ["source:wall", "source:drainage"],
      },
      "source:wall": {
        kind: "source",
        sourceCode: "wall",
        labelOverride: "Retaining wall",
        amountVisible: true,
      },
      "source:drainage": {
        kind: "source",
        sourceCode: "drainage",
        labelOverride: "Drainage",
        amountVisible: true,
      },
    },
  };
  quote.presentation.organizer = organizer;
  const meta = {
    id: "job-doc-1",
    pipelineStage: "landed",
    milestoneInvoices: buildMilestoneInvoices({
      meta: { id: "job-doc-1", pipelineStage: "landed" },
      quote,
      paymentSchedule: {
        milestones: [
          { label: "Deposit", percentage: 10 },
          { label: "Progress", percentage: 30 },
          { label: "Final", percentage: 60 },
        ],
      },
    }).milestoneInvoices,
  };

  const prepared = prepareRequestedJobDocument({
    meta,
    quote,
    documentType: "invoice",
    milestoneIndex: 1,
  });

  // Header/ref switches to the milestone invoice number.
  assert.equal(prepared.quote.quoteNumber, "EI-0041-M2");
  assert.equal(prepared.meta.milestoneInvoice.milestoneLabel, "Progress");

  // Pricing surface MUST be identical to the source quote so the customer
  // sees the same PRICING SCHEDULE they already approved. Milestone-specific
  // amounts only live in meta.milestoneInvoice + the Payment Summary box.
  assert.deepEqual(prepared.quote.lineItems, quote.lineItems);
  assert.equal(prepared.quote.presentation.organizer, organizer);
  assert.deepEqual(
    prepared.quote.presentation.scheduleItems,
    quote.presentation.scheduleItems
  );
  assert.equal(prepared.quote.totals.total, 110);
  assert.equal(prepared.quote.totals.subtotal, 100);
  assert.equal(getCustomerPresentationFinancials(prepared.quote).total, 110);

  // The milestone amount surfaces only through meta.milestoneInvoice, which
  // is what buildInvoicePaymentSummary reads to fill the Payment Summary box.
  assert.equal(prepared.meta.milestoneInvoice.total, 33);
  const paymentSummary = buildInvoicePaymentSummary({
    meta: prepared.meta,
    quote: prepared.quote,
  });
  assert.equal(paymentSummary.total, 33);
  assert.equal(paymentSummary.outstanding, 33);
});

test("prepareRequestedJobDocument turns a paid milestone into a standalone receipt document", () => {
  const quote = createQuoteFixture();
  const generated = buildMilestoneInvoices({
    meta: { id: "job-receipt-1", pipelineStage: "landed", quoteNumber: "EQ-0041" },
    quote,
    paymentSchedule: {
      milestones: [{ label: "Full payment", percentage: 100 }],
    },
  });
  const authorised = updateMilestoneInvoice({
    milestoneInvoices: generated.milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised" },
  });
  const paid = recordMilestoneInvoicePayment({
    milestoneInvoices: authorised.milestoneInvoices,
    milestoneIndex: 0,
    payment: {
      amount: 110,
      date: "2026-04-22",
      reference: "EFT-001",
      method: "bank_transfer",
    },
  });

  const prepared = prepareRequestedJobDocument({
    meta: {
      id: "job-receipt-1",
      pipelineStage: "landed",
      milestoneInvoices: paid.milestoneInvoices,
    },
    quote,
    documentType: "receipt",
    milestoneIndex: 0,
  });

  assert.equal(prepared.documentType, "receipt");
  assert.equal(prepared.quote.quoteNumber, "ER-0041-M1");
  assert.equal(prepared.meta.milestoneInvoice.receiptNumber, "ER-0041-M1");
  assert.equal(prepared.meta.milestoneInvoice.invoiceNumber, "EI-0041-M1");
  assert.equal(prepared.quote.delivery.status, "final");
  assert.equal(prepared.quote.totals.total, 110);
});

test("markMilestoneInvoiceUnpaid clears recorded payments and restores the milestone balance", () => {
  const quote = createQuoteFixture();
  const generated = buildMilestoneInvoices({
    meta: { id: "job-unpaid-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [{ label: "Full payment", percentage: 100 }],
    },
  });
  const authorised = updateMilestoneInvoice({
    milestoneInvoices: generated.milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised" },
  });
  const paid = recordMilestoneInvoicePayment({
    milestoneInvoices: authorised.milestoneInvoices,
    milestoneIndex: 0,
    payment: {
      amount: 110,
      date: "2026-04-22",
      reference: "BAL-001",
      method: "bank_transfer",
    },
  });

  const unpaid = markMilestoneInvoiceUnpaid({
    milestoneInvoices: paid.milestoneInvoices,
    milestoneIndex: 0,
  });

  assert.equal(unpaid.milestoneInvoice.status, "draft");
  assert.equal(unpaid.milestoneInvoice.amountPaid, 0);
  assert.equal(unpaid.milestoneInvoice.amountDue, 110);
  assert.equal(unpaid.milestoneInvoice.issuedAt, null);
  assert.equal(unpaid.milestoneInvoice.paidAt, null);
  assert.deepEqual(unpaid.milestoneInvoice.payments, []);
});

test("markMilestoneInvoiceUnsent clears issued state and returns the milestone to draft", () => {
  const quote = createQuoteFixture();
  const generated = buildMilestoneInvoices({
    meta: { id: "job-unsent-1", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [{ label: "Full payment", percentage: 100 }],
    },
  });
  const authorised = updateMilestoneInvoice({
    milestoneInvoices: generated.milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised" },
  });

  const unsent = markMilestoneInvoiceUnsent({
    milestoneInvoices: authorised.milestoneInvoices,
    milestoneIndex: 0,
  });

  assert.equal(unsent.milestoneInvoice.status, "draft");
  assert.equal(unsent.milestoneInvoice.issuedAt, null);
  assert.equal(unsent.milestoneInvoice.amountPaid, 0);
  assert.equal(unsent.milestoneInvoice.amountDue, 110);
});

test("buildInvoicePaymentSummary derives outstanding balance from milestone state", () => {
  const summary = buildInvoicePaymentSummary({
    meta: {
      milestoneInvoice: {
        currency: "AUD",
        total: 220,
        amountPaid: 125,
        amountDue: 95,
      },
    },
  });

  assert.deepEqual(summary, {
    currency: "AUD",
    total: 220,
    paid: 125,
    outstanding: 95,
  });
});

test("validateInvoicePaidAmount rejects overpayments", () => {
  assert.equal(
    validateInvoicePaidAmount({
      quote: { totals: { total: 220 } },
      invoicePaidAmount: 80,
    }),
    80
  );

  assert.throws(
    () => validateInvoicePaidAmount({
      quote: { totals: { total: 220 } },
      invoicePaidAmount: 300,
    }),
    /cannot exceed the invoice total/i
  );
});

test("coerceInvoicePaidAmount falls back to zero for invalid stored values", () => {
  assert.equal(coerceInvoicePaidAmount("bad-value"), 0);
  assert.equal(coerceInvoicePaidAmount(-12), 0);
  assert.equal(coerceInvoicePaidAmount("14.235"), 14.24);
});

function createVariationQuoteFixture() {
  // The same quote after an approved variation: an extra rock-clause line.
  const quote = createQuoteFixture();
  quote.version = 2;
  quote.lineItems = [
    ...quote.lineItems,
    { code: "rock", label: "Rock clause", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, customerVisible: true },
  ];
  quote.presentation.scheduleItems = [
    ...quote.presentation.scheduleItems,
    { code: "rock", label: "Rock clause", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, sourceLineItemCodes: ["rock"] },
  ];
  quote.totals = { subtotal: 200, gst: 20, total: 220, currency: "AUD" };
  return quote;
}

function issueFirstMilestone(quote, meta) {
  const built = buildMilestoneInvoices({
    meta,
    quote,
    paymentSchedule: { milestones: [{ label: "Deposit", percentage: 50 }, { label: "Final", percentage: 50 }] },
  });
  const updated = updateMilestoneInvoice({
    milestoneInvoices: built.milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised" },
    quoteVersion: quote.version,
  });
  return { paymentSchedule: built.paymentSchedule, milestoneInvoices: updated.milestoneInvoices };
}

test("an approved quote change never rewrites an already-issued invoice", () => {
  const meta = { id: "job-revision-freeze", pipelineStage: "landed", quoteNumber: "EQ-0041" };
  const issued = issueFirstMilestone(createQuoteFixture(), meta);
  const sentInvoice = issued.milestoneInvoices[0];

  assert.equal(sentInvoice.invoiceNumber, "EI-0041-M1");
  assert.equal(sentInvoice.revisionNumber, 1);
  assert.equal(sentInvoice.total, 55);
  assert.equal(sentInvoice.issuedRevision.total, 55);
  assert.equal(sentInvoice.issuedRevision.quoteVersion, 1);

  const rebuilt = buildMilestoneInvoices({
    meta,
    quote: createVariationQuoteFixture(),
    paymentSchedule: issued.paymentSchedule,
    existingMilestoneInvoices: issued.milestoneInvoices,
  });

  const stillSent = rebuilt.milestoneInvoices[0];
  assert.equal(stillSent.invoiceNumber, "EI-0041-M1");
  assert.equal(stillSent.revisionNumber, 1);
  assert.equal(stillSent.total, 55);
  assert.deepEqual(
    stillSent.lineItems.map((item) => item.description),
    sentInvoice.lineItems.map((item) => item.description),
  );
  // The unclaimed remainder moves onto the milestone that is still open, so
  // the schedule keeps reconciling to the approved quote total.
  assert.equal(rebuilt.milestoneInvoices[1].total, 165);
  assert.equal(
    rebuilt.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
    220,
  );
});

test("an authorized revision issues a new numbered invoice and keeps the superseded one", () => {
  const meta = { id: "job-revision-mint", pipelineStage: "landed", quoteNumber: "EQ-0041" };
  const issued = issueFirstMilestone(createQuoteFixture(), meta);

  const revised = buildMilestoneInvoices({
    meta,
    quote: createVariationQuoteFixture(),
    paymentSchedule: issued.paymentSchedule,
    existingMilestoneInvoices: issued.milestoneInvoices,
    revisionAuthorizations: [{
      milestoneIndex: 0,
      reason: "Approved rock clause variation",
      actor: { kind: "user", label: "Alex" },
      at: "2026-05-09T02:00:00.000Z",
    }],
  });

  const current = revised.milestoneInvoices[0];
  assert.equal(current.invoiceNumber, "EI-0041-M1-R2");
  assert.equal(current.revisionNumber, 2);
  assert.equal(current.total, 110);
  assert.equal(current.pdfPath, "milestone-invoices/EI-0041-M1-R2.pdf");
  assert.equal(current.issuedRevision.revisionReason, "Approved rock clause variation");
  assert.equal(current.issuedRevision.revisedBy, "Alex");
  assert.equal(current.issuedRevision.revisedAt, "2026-05-09T02:00:00.000Z");

  assert.equal(current.revisionHistory.length, 1);
  assert.equal(current.revisionHistory[0].invoiceNumber, "EI-0041-M1");
  assert.equal(current.revisionHistory[0].total, 55);
  assert.equal(current.revisionHistory[0].pdfPath, "milestone-invoices/EI-0041-M1.pdf");

  const revisions = getMilestoneInvoiceRevisions(current);
  assert.deepEqual(revisions.map((entry) => entry.revisionNumber), [1, 2]);
  assert.equal(findMilestoneInvoiceRevision(current, 1).invoiceNumber, "EI-0041-M1");
  assert.equal(findMilestoneInvoiceRevision(current, 9), null);
});

test("a revision authorization without a reason is refused", () => {
  const meta = { id: "job-revision-reason", pipelineStage: "landed", quoteNumber: "EQ-0041" };
  const issued = issueFirstMilestone(createQuoteFixture(), meta);

  assert.throws(
    () => buildMilestoneInvoices({
      meta,
      quote: createVariationQuoteFixture(),
      paymentSchedule: issued.paymentSchedule,
      existingMilestoneInvoices: issued.milestoneInvoices,
      revisionAuthorizations: [{ milestoneIndex: 0, reason: "   " }],
    }),
    /revision requires a reason/i,
  );
});

test("stored issued invoices normalize back to their frozen revision", () => {
  const meta = { id: "job-revision-normalize", pipelineStage: "landed", quoteNumber: "EQ-0041" };
  const issued = issueFirstMilestone(createQuoteFixture(), meta);
  // Simulate a stored record whose loose fields drifted away from the frozen
  // snapshot; the snapshot must win.
  const drifted = normalizeStoredMilestoneInvoices([{
    ...issued.milestoneInvoices[0],
    total: 999,
    subtotal: 900,
    gst: 99,
    lineItems: [{ description: "Tampered", quantity: 1, unit: "lot", unitPrice: 999, totalPrice: 999 }],
  }])[0];

  assert.equal(drifted.total, 55);
  assert.equal(drifted.subtotal, 50);
  assert.equal(drifted.gst, 5);
  assert.equal(drifted.invoiceNumber, "EI-0041-M1");
  assert.deepEqual(drifted.lineItems.map((item) => item.description), ["Retaining wall", "Drainage"]);
});

test("an authorized revision on a legacy invoice synthesizes a legacy revision to retire, instead of a dead-end", () => {
  const meta = { id: "job-legacy-revise", pipelineStage: "landed", quoteNumber: "EQ-0041" };
  // A stored record from before invoice revisions: issued, but it never froze
  // an `issuedRevision` snapshot because that mechanism did not exist yet.
  const legacyExisting = [{
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    status: "authorised",
    issuedAt: "2026-01-01T00:00:00.000Z",
    invoiceNumber: "EI-LEG-01-M1",
    revisionNumber: 1,
    subtotal: 50,
    gst: 5,
    total: 55,
    currency: "AUD",
    lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 55, totalPrice: 55 }],
    pdfPath: "milestone-invoices/EI-LEG-01-M1.pdf",
  }];

  const revised = buildMilestoneInvoices({
    meta,
    quote: createVariationQuoteFixture(),
    paymentSchedule: { milestones: [{ label: "Deposit", percentage: 50 }, { label: "Final", percentage: 50 }] },
    existingMilestoneInvoices: legacyExisting,
    revisionAuthorizations: [{
      milestoneIndex: 0,
      reason: "Approved rock clause variation",
      actor: { kind: "user", label: "Alex" },
      at: "2026-05-09T02:00:00.000Z",
    }],
  });

  const current = revised.milestoneInvoices[0];
  // Before the fix, legacy synthesis was skipped for authorized indexes, so
  // this minted revisionNumber 1 under the same customer-held number with
  // the new financials — no supersedes, no attribution, empty history — and
  // the caller's own equality guard then rejected it as "unchanged".
  assert.equal(current.revisionNumber, 2);
  assert.equal(current.invoiceNumber, "EI-LEG-01-M1-R2");
  assert.equal(current.total, 110);
  assert.equal(current.issuedRevision.revisionReason, "Approved rock clause variation");
  assert.equal(current.issuedRevision.revisedBy, "Alex");

  assert.equal(current.revisionHistory.length, 1);
  const superseded = current.revisionHistory[0];
  assert.equal(superseded.invoiceNumber, "EI-LEG-01-M1");
  assert.equal(superseded.total, 55);
  assert.equal(superseded.supersededByRevisionNumber, 2);
  // The synthesized legacy revision must carry the stored PDF path so the
  // now-retired revision stays retrievable instead of 410-ing despite the
  // file existing on disk.
  assert.equal(superseded.pdfPath, "milestone-invoices/EI-LEG-01-M1.pdf");
});

// The ADOPT_PENDING state must land on the revision
// it actually describes. Under an authorization, the synthesized legacy
// revision is RETIRED into history and a fresh revision is MINTED in its
// place — a post-hoc stamp keyed only on "did this milestone index
// synthesize legacy content this build" would land on the mint instead
// (wrong: it has no prior file and must render fresh, not be routed
// through adopt-or-reconstruct) and leave the retired copy state-less
// (wrong: it loses write-path immutability protection).
test("an authorized revision on a never-synchronized legacy invoice mints UNWRITTEN and retires ADOPT_PENDING into history", () => {
  const meta = { id: "job-legacy-revise-artifact-state", pipelineStage: "landed", quoteNumber: "EQ-0041" };
  const legacyExisting = [{
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    status: "authorised",
    issuedAt: "2026-01-01T00:00:00.000Z",
    invoiceNumber: "EI-LEG-AS-01-M1",
    revisionNumber: 1,
    subtotal: 50,
    gst: 5,
    total: 55,
    currency: "AUD",
    lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 55, totalPrice: 55 }],
    pdfPath: "milestone-invoices/EI-LEG-AS-01-M1.pdf",
  }];

  // This is the first revision-tracking touch of this invoice — the legacy
  // synthesis and the authorization both happen in this single
  // buildMilestoneInvoices call (reviseJobMilestoneInvoice does not
  // synchronize first).
  const revised = buildMilestoneInvoices({
    meta,
    quote: createVariationQuoteFixture(),
    paymentSchedule: { milestones: [{ label: "Deposit", percentage: 50 }, { label: "Final", percentage: 50 }] },
    existingMilestoneInvoices: legacyExisting,
    revisionAuthorizations: [{
      milestoneIndex: 0,
      reason: "Approved rock clause variation",
      actor: { kind: "user", label: "Alex" },
      at: "2026-05-09T02:00:00.000Z",
    }],
  });

  const current = revised.milestoneInvoices[0];
  assert.equal(current.revisionNumber, 2);
  // The mint has no prior file — it must be UNWRITTEN (an ordinary fresh
  // render), never ADOPT_PENDING (which would route it through
  // writeMilestoneInvoiceArtifact's adopt-or-reconstruct branch and let a
  // stray file at the new -R2 path be silently adopted as the issued
  // document, or fabricate a false "PDF was reconstructed" audit event).
  assert.equal(current.issuedRevision.artifactState, ARTIFACT_STATE.UNWRITTEN);

  assert.equal(current.revisionHistory.length, 1);
  const superseded = current.revisionHistory[0];
  assert.equal(superseded.invoiceNumber, "EI-LEG-AS-01-M1");
  // The retired legacy copy carries ADOPT_PENDING into history, so it stays
  // protected by the write path's path-scoped immutability guard
  // (`historicalMatch` requires a state other than UNWRITTEN) even though
  // it was never touched by a revision-tracking write before being superseded.
  assert.equal(superseded.artifactState, ARTIFACT_STATE.ADOPT_PENDING);
  assert.equal(superseded.pdfPath, "milestone-invoices/EI-LEG-AS-01-M1.pdf");
});

test("legacy synthesis threads the rebuild's quote version so an unsend immediately followed by a re-issue restores instead of minting", () => {
  const meta = { id: "job-legacy-fingerprint", pipelineStage: "landed", quoteNumber: "EQ-0041", quoteVersion: 1 };
  const quote = createQuoteFixture();
  const legacyExisting = [{
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    status: "authorised",
    issuedAt: "2026-01-01T00:00:00.000Z",
    invoiceNumber: "EI-LEG-02-M1",
    revisionNumber: 1,
    subtotal: 50,
    gst: 5,
    total: 55,
    currency: "AUD",
    lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 55, totalPrice: 55 }],
    pdfPath: "milestone-invoices/EI-LEG-02-M1.pdf",
  }];

  // First touch: any rebuild synchronizes and freezes the legacy record,
  // synthesizing an `issuedRevision` for it — this is where the quote
  // version this call is running against gets threaded in.
  const synced = buildMilestoneInvoices({
    meta,
    quote,
    paymentSchedule: { milestones: [{ label: "Deposit", percentage: 50 }, { label: "Final", percentage: 50 }] },
    existingMilestoneInvoices: legacyExisting,
  });
  assert.equal(synced.milestoneInvoices[0].issuedRevision.quoteVersion, 1);

  // Unsend retires that synthesized revision into history, carrying its
  // quoteVersion (1) along with it.
  const unsent = markMilestoneInvoiceUnsent({
    milestoneInvoices: synced.milestoneInvoices,
    milestoneIndex: 0,
  });
  assert.equal(unsent.milestoneInvoice.issuedRevision, null);
  assert.equal(unsent.milestoneInvoice.revisionHistory.length, 1);
  assert.equal(unsent.milestoneInvoice.revisionHistory[0].quoteVersion, 1);

  // Re-issuing identical content against the same quote version must
  // restore revision 1 rather than minting revision 2 for the same money
  // document. Before the fix, the synthesized legacy revision always
  // recorded `quoteVersion: null`, so this fingerprint would mismatch on
  // quoteVersion alone (null vs 1) and burn a number on identical content.
  const reissued = updateMilestoneInvoice({
    milestoneInvoices: unsent.milestoneInvoices,
    milestoneIndex: 0,
    patch: { status: "authorised" },
    quoteVersion: 1,
  });
  assert.equal(reissued.milestoneInvoice.revisionNumber, 1);
  assert.equal(reissued.milestoneInvoice.invoiceNumber, "EI-LEG-02-M1");
  assert.equal(reissued.milestoneInvoice.revisionHistory.length, 0);
});

// `getCustomerPresentationFinancials` derives the effective quote total from
// `presentation.scheduleItems` (and `lineItems`), not from `quote.totals` —
// overriding only `totals` on the fixture leaves the amount actually used by
// `buildMilestoneInvoices` unchanged. Build a fixture with a single schedule
// item whose price is the intended total.
function createReducedQuoteFixture(subtotal) {
  const total = Math.round(subtotal * 1.1 * 100) / 100;
  return {
    ...createQuoteFixture(),
    lineItems: [
      { code: "scope", label: "Scope", quantity: 1, unit: "lot", unitPrice: subtotal, totalPrice: subtotal, customerVisible: true },
    ],
    presentation: {
      scopeText: "Reduced quote test.",
      scheduleItems: [
        { code: "scope", label: "Scope", quantity: 1, unit: "lot", unitPrice: subtotal, totalPrice: subtotal, sourceLineItemCodes: ["scope"] },
      ],
    },
    totals: { subtotal, gst: Math.round((total - subtotal) * 100) / 100, total, currency: "AUD" },
  };
}

test("buildMilestoneInvoices splits a fixed-schedule shortfall proportionally instead of throwing on a rebuild path, with no frozen invoices", () => {
  const quote = createReducedQuoteFixture(500);
  // Two fixed-claim milestones summing to $1,000 — more than the reduced
  // $550 quote total. A rebuild must never throw; it is not the place to
  // validate operator input (that belongs where schedules are authored).
  const result = buildMilestoneInvoices({
    meta: { id: "job-shortfall-no-frozen", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [
        { label: "M1 fixed", fixedTotal: 700 },
        { label: "M2 fixed", fixedTotal: 300 },
      ],
    },
  });

  assert.deepEqual(
    result.milestoneInvoices.map((invoice) => invoice.total),
    [385, 165],
  );
  assert.equal(
    result.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
    550,
  );
});

test("buildMilestoneInvoices zeroes open milestones instead of throwing when a frozen invoice alone exceeds the reduced quote total", () => {
  const quote = createReducedQuoteFixture(500);
  const existingMilestoneInvoices = [{
    milestoneIndex: 0,
    milestoneLabel: "M1 fixed",
    status: "authorised",
    issuedAt: "2026-05-01T00:00:00.000Z",
    invoiceNumber: "EI-SHORT-01-M1",
    subtotal: 636.36,
    gst: 63.64,
    total: 700,
    currency: "AUD",
    lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 700, totalPrice: 700 }],
    issuedRevision: {
      revisionNumber: 1,
      invoiceNumber: "EI-SHORT-01-M1",
      issuedAt: "2026-05-01T00:00:00.000Z",
      subtotal: 636.36,
      gst: 63.64,
      total: 700,
      currency: "AUD",
      lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 700, totalPrice: 700 }],
    },
  }];

  // Frozen $700 alone already exceeds the reduced $550 quote total. The
  // schedule intentionally stops reconciling: the frozen claim stays $700,
  // the open milestone claims nothing (not a fabricated negative, not a
  // fabricated "paid" $0 document), and resolving the over-claim is left as
  // an explicit operator decision.
  const result = buildMilestoneInvoices({
    meta: { id: "job-shortfall-frozen", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [
        { label: "M1 fixed", fixedTotal: 700 },
        { label: "M2 fixed", fixedTotal: 300 },
      ],
    },
    existingMilestoneInvoices,
  });

  assert.equal(result.milestoneInvoices[0].total, 700);
  assert.equal(result.milestoneInvoices[1].total, 0);
  assert.equal(result.milestoneInvoices[1].status, "draft");
});

test("buildMilestoneInvoices proportionally splits open fixed milestones around a frozen invoice when the remainder is still positive", () => {
  const quote = createReducedQuoteFixture(500);
  const existingMilestoneInvoices = [{
    milestoneIndex: 0,
    milestoneLabel: "M1 fixed",
    status: "authorised",
    issuedAt: "2026-05-01T00:00:00.000Z",
    invoiceNumber: "EI-SHORT-02-M1",
    subtotal: 200,
    gst: 20,
    total: 220,
    currency: "AUD",
    lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 220, totalPrice: 220 }],
    issuedRevision: {
      revisionNumber: 1,
      invoiceNumber: "EI-SHORT-02-M1",
      issuedAt: "2026-05-01T00:00:00.000Z",
      subtotal: 200,
      gst: 20,
      total: 220,
      currency: "AUD",
      lineItems: [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 220, totalPrice: 220 }],
    },
  }];

  // $330 remains after the $220 frozen claim (quote total $550); the two
  // open fixed milestones (each claiming $400) split that $330
  // proportionally (1:1 here) rather than throwing.
  const result = buildMilestoneInvoices({
    meta: { id: "job-shortfall-proportional", pipelineStage: "landed" },
    quote,
    paymentSchedule: {
      milestones: [
        { label: "M1 fixed", fixedTotal: 220 },
        { label: "M2 fixed", fixedTotal: 400 },
        { label: "M3 fixed", fixedTotal: 400 },
      ],
    },
    existingMilestoneInvoices,
  });

  assert.deepEqual(
    result.milestoneInvoices.map((invoice) => invoice.total),
    [220, 165, 165],
  );
  assert.equal(
    result.milestoneInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
    550,
  );
});

test("deriveMilestoneStatus (via normalizeStoredMilestoneInvoices) preserves a stored paid status at zero total without fabricating one", () => {
  // A fully-carried migrated milestone: total dropped to zero, but it was
  // already stored as paid — that is real data, not something a rebuild is
  // inventing.
  const storedPaidAtZero = normalizeStoredMilestoneInvoices([{
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    status: "paid",
    total: 0,
    subtotal: 0,
    gst: 0,
    paidAt: "2026-01-01",
    invoiceNumber: "EI-ZERO-01-M1",
  }])[0];
  assert.equal(storedPaidAtZero.status, "paid");
  assert.equal(storedPaidAtZero.total, 0);

  // The guard against fabricating a money document must still bind: an open milestone
  // rebalanced to zero with no stored paid status of its own must stay
  // draft, never "paid".
  const rebalancedOpenAtZero = normalizeStoredMilestoneInvoices([{
    milestoneIndex: 1,
    milestoneLabel: "Final",
    status: "draft",
    total: 0,
    subtotal: 0,
    gst: 0,
    invoiceNumber: "EI-ZERO-01-M2",
  }])[0];
  assert.equal(rebalancedOpenAtZero.status, "draft");
});
