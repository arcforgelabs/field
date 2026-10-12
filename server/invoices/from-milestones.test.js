// Today's milestone state mapped to invoice rows (#27), on jobs built by the
// real milestone actions: a single invoice; deposit and completion; one paid
// with a receipt; one revised to -R2 with its superseded revision; a voided
// payment; a legacy invoice from before revisions were frozen; and an invoice
// returned to draft. Plus the claim line, the kind and GST kept as issued.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { claimLineName, claimMoney, invoiceKind, mapMilestoneState } from "./from-milestones.js";
import { collectJobInvoices } from "./sync.js";
import { actions, createLandedJob, scenarios } from "./test-fixtures.js";

const pick = (invoice) => [invoice.number, invoice.status, invoice.subtotal, invoice.taxTotal, invoice.total, invoice.amountPaid];

describe("milestone state to invoice rows", () => {
  let dataDir;
  const jobs = {};

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "field-invoice-map-"));
    for (const name of Object.keys(scenarios)) jobs[name] = await collectJobInvoices(await scenarios[name](dataDir));
  });
  after(() => rmSync(dataDir, { recursive: true, force: true }));

  test("a single invoice: one milestone, one issued final invoice with one claim line", () => {
    const { mapped, basis } = jobs.single;
    assert.deepEqual(mapped.failures, []);
    assert.deepEqual(basis, { version: 1, number: "EQ-2605-01", jobNumber: "JOB-2605-01", total: "1100.00", taxRate: "10.000" });
    assert.deepEqual(mapped.milestones.map((m) => [m.sortOrder, m.label, m.percent, m.amount, m.isDefaultSchedule]), [[0, "Full payment", "100.000", null, false]]);
    assert.deepEqual(mapped.invoices.map(pick), [["EI-2605-01-M1", "issued", "1000.00", "100.00", "1100.00", "0.00"]]);
    const [invoice] = mapped.invoices;
    assert.equal(invoice.kind, "final");
    assert.equal(invoice.revision, 1);
    assert.equal(invoice.reference, "JOB-2605-01");
    assert.equal(invoice.quoteVersion, 1);
    assert.ok(invoice.issuedAt && invoice.issuedOn === invoice.issuedAt.slice(0, 10));
    assert.equal(invoice.pdfPath, "milestone-invoices/EI-2605-01-M1.pdf");
    assert.match(invoice.pdfSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(invoice.lines.map((line) => [line.lineType, line.name, line.description, line.quantity, line.unitSell, line.lineTotal]), [
      ["claim", "Full payment, 100 % of EQ-2605-01 v1", "Milestone 1 of 1", "1.0000", "1000.0000", "1000.00"],
    ]);
    assert.deepEqual([mapped.payments, mapped.receipts], [[], []]);
  });

  test("deposit and completion: the deposit issued, the completion a draft under its provisional number", () => {
    const { mapped } = jobs.depositCompletion;
    assert.deepEqual(mapped.failures, []);
    assert.deepEqual(mapped.invoices.map(pick), [
      ["EI-2605-02-M1", "issued", "925.50", "92.55", "1018.05", "0.00"],
      ["EI-2605-02-M2", "draft", "925.50", "92.55", "1018.05", "0.00"],
    ]);
    assert.deepEqual(mapped.invoices.map((invoice) => invoice.kind), ["deposit", "final"]);
    assert.equal(mapped.invoices[1].issuedAt, null);
    assert.deepEqual(mapped.milestones.map((m) => m.shown.total), ["1018.05", "1018.05"]);
  });

  test("one paid with a receipt: the payment against its invoice, the receipt for the payment that cleared it", () => {
    const { mapped } = jobs.paid;
    assert.deepEqual(mapped.failures, []);
    assert.deepEqual(mapped.invoices.map(pick)[0], ["EI-2605-03-M1", "paid", "400.00", "40.00", "440.00", "440.00"]);
    assert.deepEqual(mapped.payments.map((p) => [p.invoiceKey, p.amount, p.paidOn, p.method, p.reference, p.voidedAt, p.sourceInvoiceNumber]), [
      ["EI-2605-03-M1", "440.00", "2026-05-10", "bank_transfer", "EFT-TEST", null, "EI-2605-03-M1"],
    ]);
    assert.deepEqual(mapped.receipts.map((r) => [r.number, r.amount, r.paymentKey === mapped.payments[0].key, r.invoiceKey, r.issuedOn]), [
      ["ER-2605-03-M1", "440.00", true, "EI-2605-03-M1", "2026-05-10"],
    ]);
  });

  test("revised to -R2: the superseded revision is its own credited invoice; numbers stay as issued", () => {
    const { mapped, basis } = jobs.revised;
    assert.deepEqual(mapped.failures, []);
    assert.equal(basis.version, 2);
    assert.deepEqual(mapped.invoices.map(pick), [
      ["EI-2605-04-M1", "credited", "100.00", "10.00", "110.00", "0.00"],
      ["EI-2605-04-M1-R2", "issued", "150.00", "15.00", "165.00", "0.00"],
      ["EI-2605-04-M2", "draft", "150.00", "15.00", "165.00", "0.00"],
    ]);
    const [r1, r2] = mapped.invoices;
    assert.deepEqual([r1.revision, r2.revision, r2.supersedesKey, r2.revisionReason, r2.revisedBy], [1, 2, "EI-2605-04-M1", "Approved variation", "Test Operator"]);
    assert.match(r1.note, /Revised in place before credit notes: superseded by EI-2605-04-M1-R2\. No credit note was issued\./);
    assert.equal(r1.lines[0].name, "Deposit, 50 % of EQ-2605-04 v1", "the credited invoice claimed against the quote it was issued from");
    assert.equal(r2.lines[0].name, "Deposit, 50 % of EQ-2605-04 v2");
    assert.ok(r1.supersededAt);
    // Revised in place before credit notes: no credit note is invented for it
    // (owner's decision, 2026-10-13).
    assert.deepEqual(mapped.creditNotes, []);
  });

  test("a voided payment keeps voided_at and pays nothing; no receipt", () => {
    const { mapped } = jobs.voidedPayment;
    assert.deepEqual(mapped.failures, []);
    assert.deepEqual(mapped.payments.map((p) => [p.amount, Boolean(p.voidedAt), p.voidReason, p.voidedBy]), [["100.00", true, "Entered twice", "Test Operator"]]);
    assert.deepEqual(mapped.invoices.map(pick)[0], ["EI-2605-05-M1", "issued", "200.00", "20.00", "220.00", "0.00"]);
    assert.deepEqual(mapped.receipts, []);
    assert.deepEqual(mapped.milestones[0].shown, { total: "220.00", amountPaid: "0.00", activePayments: "0.00", currentNumber: "EI-2605-05-M1", currentTotal: "220.00" });
  });

  test("a legacy invoice from before revisions were frozen maps from its stored record", () => {
    const { mapped } = jobs.legacy;
    assert.deepEqual(mapped.failures, []);
    assert.deepEqual(mapped.invoices.map(pick), [["EI-2605-06-M1", "issued", "1234.50", "123.45", "1357.95", "0.00"]]);
    const [invoice] = mapped.invoices;
    assert.deepEqual([invoice.issuedAt, invoice.dueOn, invoice.quoteVersion, invoice.issuedRevision, invoice.pdfPath], ["2025-10-31T02:00:00.000Z", "2025-11-14", null, false, "milestone-invoices/EI-2605-06-M1.pdf"]);
    assert.match(invoice.note, /before invoice revisions were recorded/);
  });

  test("returned to draft (unsent, or marked unpaid): the void revision stands for the draft that carries its number", async () => {
    const { jobDir } = await createLandedJob(join(dataDir, "2026-05-02", "job-unsent"), { id: "job-unsent", number: "2605-07", rows: [["Steps", 300]] });
    await actions.generate(jobDir, [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }]);
    await actions.issue(jobDir, 1);
    await actions.unsent(jobDir, 1);
    let { mapped } = await collectJobInvoices(jobDir);
    assert.deepEqual(mapped.failures, []);
    assert.deepEqual(mapped.invoices.map(pick), [
      ["EI-2605-07-M1", "draft", "150.00", "15.00", "165.00", "0.00"],
      ["EI-2605-07-M2", "void", "150.00", "15.00", "165.00", "0.00"],
    ]);
    assert.match(mapped.invoices[1].note, /Returned to draft/);
    assert.deepEqual(mapped.warnings.map((warning) => warning.kind), ["draft-is-void-revision"]);

    // Issued, paid, then marked unpaid: the payment leaves the files.
    const issued = await actions.issue(jobDir, 0);
    await actions.pay(jobDir, 0, issued.meta.milestoneInvoices[0].total);
    await actions.unpaid(jobDir, 0);
    ({ mapped } = await collectJobInvoices(jobDir));
    assert.deepEqual(mapped.failures, []);
    assert.deepEqual(mapped.invoices.map(pick).map((row) => row.slice(0, 2)), [["EI-2605-07-M1", "void"], ["EI-2605-07-M2", "void"]]);
    assert.deepEqual([mapped.payments, mapped.receipts], [[], []]);
  });

  test("a milestone's GST, its share of the quote's, is kept as issued where it differs from GST on its subtotal", () => {
    const money = claimMoney({ subtotal: 100.05, gst: 10, total: 110.05, taxRate: "10.000", name: "Deposit", description: null, milestoneKey: "0" });
    assert.deepEqual(money.totals, { subtotal: "100.05", taxTotal: "10.00", total: "110.05" });
    assert.equal(money.computedTaxTotal, "10.01");
    assert.equal(money.taxTotalSource, "printed");
    assert.match(money.taxTotalReason, /GST as issued, 10\.00.*differs from 10\.01/);
    assert.equal(claimMoney({ subtotal: 100, gst: 10, total: 110, taxRate: "10.000", name: "x", milestoneKey: "0" }).taxTotalSource, "computed");
    assert.deepEqual(claimMoney({ subtotal: 100, gst: 10, total: 111, taxRate: "10.000", name: "x", milestoneKey: "0" }).failure.kind, "snapshot");
  });

  test("an issued milestone with no issue time is refused, never invented", () => {
    const meta = { milestoneInvoices: [{ milestoneIndex: 0, milestoneLabel: "Deposit", percentage: 100, invoiceNumber: "EI-X-M1", status: "authorised", issuedAt: null, payments: [], subtotal: 10, gst: 1, total: 11 }] };
    const mapped = mapMilestoneState({ meta, basis: null });
    assert.equal(mapped.invoices.length, 0);
    assert.match(mapped.failures[0].reason, /no issue time/);
  });

  test("the kind and the claim line's name", () => {
    assert.deepEqual([invoiceKind("Deposit", 2, 3), invoiceKind("Variation 1", 0, 1), invoiceKind("On completion", 0, 2), invoiceKind("Stage 2", 1, 3), invoiceKind("Stage 1", 0, 3), invoiceKind("Stage 3", 2, 3), invoiceKind("Only", 0, 1)],
      ["deposit", "variation", "final", "progress", "deposit", "final", "final"]);
    assert.equal(claimLineName({ label: "Deposit", percent: "33.330", quoteReference: "EQ-2501-01 v2" }), "Deposit, 33.33 % of EQ-2501-01 v2");
    assert.equal(claimLineName({ label: "Deposit", percent: null, quoteReference: "EQ-2501-01 v2" }), "Deposit of EQ-2501-01 v2");
  });
});
