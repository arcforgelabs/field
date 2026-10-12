// The invoice row service (#27): writes one job's payment schedule, invoices,
// payments and receipts in ONE organisation transaction, from a mapping
// (from-milestones.js) whose local keys it turns into uids.
//
//   writeJob(input)    bring the job's rows in line with the mapping
//   readJob(jobId)     the job's rows (invoices with their lines)
//
// What it never does, whatever the mapping says (the database refuses it too,
// migration 0013):
//
//   - change an issued invoice's number, money, lines or issue time. A
//     mapping that disagrees is a conflict: the row is kept as issued and the
//     conflict reported. Its status, amount paid, due date, kind and note may
//     move on, and links missing when it was written are filled once.
//   - delete a payment. A payment the files no longer hold (a "mark unpaid"
//     removes them) is voided.
//   - delete a receipt. One the files no longer hold is voided.
//   - change or delete a credit note or a payment allocation (step 4b, #28).
//     A credited invoice's credit note is written once; every active payment
//     the credited invoice holds moves to its replacement, as an allocation.
//
// A draft invoice is rewritten freely and deleted when the files no longer
// have it. Totals are computed here: quoteTotals over the lines, with the GST
// as issued where the mapping says it was printed (with the reason). An
// invoice's amount paid is always the sum of its active payments.
//
// With `dryRun` the same work runs in a transaction that is rolled back, so
// the summary says exactly what a real run would do.
import { asc, eq, inArray } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { centsToText, fixed, quoteTotals, toCents } from "../quotes/totals.js";
import { compareDocumentNumbers } from "./numbers.js";
import {
  newCreditNoteLineUid,
  newCreditNoteUid,
  newInvoiceLineUid,
  newInvoiceUid,
  newPaymentAllocationUid,
  newPaymentMilestoneUid,
  newPaymentUid,
  newReceiptUid,
} from "./uid.js";

const { paymentMilestones, invoices, invoiceLines, creditNotes, creditNoteLines, payments, paymentAllocations, receipts } = schema;

class DryRunRollback extends Error {
  constructor(summary) {
    super("dry run");
    this.summary = summary;
  }
}

function invalid(message) {
  const error = new Error(message);
  error.code = "INVOICE_ROWS_INVALID";
  error.statusCode = 400;
  return error;
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function date(value) {
  return value == null ? null : new Date(value);
}

function same(a, b) {
  return (a ?? null) === (b ?? null);
}

function sameMoney(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return toCents(a) === toCents(b);
}

function sameTime(a, b) {
  return (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());
}

function sameDecimal(a, b, scale) {
  if (a == null || b == null) return a == null && b == null;
  return fixed(a, scale) === fixed(b, scale);
}

export function isIssuedInvoice(row) {
  return Boolean(row) && row.issuedAt != null;
}

function lineFromRow(row) {
  return {
    uid: row.uid,
    sortOrder: row.sortOrder,
    lineType: row.lineType,
    quoteUid: row.quoteUid,
    milestoneUid: row.milestoneUid,
    itemUid: row.itemUid,
    name: row.name,
    description: row.description,
    quantity: row.quantity,
    unitCode: row.unitCode,
    unitSell: row.unitSell,
    taxCode: row.taxCode,
    taxRate: row.taxRate,
    lineTotal: row.lineTotal,
    lineTotalSource: row.lineTotalSource,
    lineTotalReason: row.lineTotalReason,
  };
}

export function invoiceFromRow(row, lines = []) {
  return {
    uid: row.uid,
    jobId: row.jobId,
    number: row.number,
    kind: row.kind,
    status: row.status,
    quoteUid: row.quoteUid,
    quoteVersion: row.quoteVersion,
    quoteVersionInferred: row.quoteVersionInferred,
    milestoneUid: row.milestoneUid,
    revision: row.revision,
    supersedesInvoiceUid: row.supersedesInvoiceUid,
    issuedAt: iso(row.issuedAt),
    issuedOn: row.issuedOn,
    dueOn: row.dueOn,
    currency: row.currency,
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    total: row.total,
    taxTotalSource: row.taxTotalSource,
    taxTotalReason: row.taxTotalReason,
    amountPaid: row.amountPaid,
    issuedDocumentUid: row.issuedDocumentUid,
    reference: row.reference,
    supersededAt: iso(row.supersededAt),
    revisionReason: row.revisionReason,
    revisedBy: row.revisedBy,
    note: row.note,
    version: row.version,
    lines: lines.map(lineFromRow),
  };
}

function milestoneFromRow(row) {
  return {
    uid: row.uid,
    jobId: row.jobId,
    quoteUid: row.quoteUid,
    label: row.label,
    percent: row.percent,
    amount: row.amount,
    dueDays: row.dueDays,
    sortOrder: row.sortOrder,
    isDefaultSchedule: row.isDefaultSchedule,
    version: row.version,
  };
}

function paymentFromRow(row) {
  return {
    uid: row.uid,
    jobId: row.jobId,
    invoiceUid: row.invoiceUid,
    milestoneUid: row.milestoneUid,
    amount: row.amount,
    paidOn: row.paidOn,
    method: row.method,
    reference: row.reference,
    recordedAt: iso(row.recordedAt),
    voidedAt: iso(row.voidedAt),
    voidReason: row.voidReason,
    voidedBy: row.voidedBy,
    sourcePaymentId: row.sourcePaymentId,
    version: row.version,
  };
}

function creditNoteFromRow(row, lines = []) {
  return {
    uid: row.uid,
    jobId: row.jobId,
    number: row.number,
    invoiceUid: row.invoiceUid,
    replacementInvoiceUid: row.replacementInvoiceUid,
    status: row.status,
    origin: row.origin,
    reason: row.reason,
    issuedAt: iso(row.issuedAt),
    issuedOn: row.issuedOn,
    currency: row.currency,
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    total: row.total,
    taxTotalSource: row.taxTotalSource,
    taxTotalReason: row.taxTotalReason,
    issuedDocumentUid: row.issuedDocumentUid,
    reference: row.reference,
    createdBy: row.createdBy,
    lines: lines.map((line) => ({
      uid: line.uid,
      invoiceLineUid: line.invoiceLineUid,
      sortOrder: line.sortOrder,
      lineType: line.lineType,
      name: line.name,
      description: line.description,
      quantity: line.quantity,
      unitCode: line.unitCode,
      unitSell: line.unitSell,
      taxRate: line.taxRate,
      lineTotal: line.lineTotal,
      lineTotalSource: line.lineTotalSource,
      lineTotalReason: line.lineTotalReason,
    })),
  };
}

function allocationFromRow(row) {
  return {
    uid: row.uid,
    paymentUid: row.paymentUid,
    fromInvoiceUid: row.fromInvoiceUid,
    toInvoiceUid: row.toInvoiceUid,
    creditNoteUid: row.creditNoteUid,
    amount: row.amount,
    allocatedAt: iso(row.allocatedAt),
  };
}

function receiptFromRow(row) {
  return {
    uid: row.uid,
    jobId: row.jobId,
    number: row.number,
    paymentUid: row.paymentUid,
    invoiceUid: row.invoiceUid,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    issuedAt: iso(row.issuedAt),
    issuedOn: row.issuedOn,
    issuedDocumentUid: row.issuedDocumentUid,
    version: row.version,
  };
}

/**
 * quoteTotals over an invoice's lines (claim lines count as custom ones),
 * with the GST as issued where the mapping kept it as printed.
 */
export function invoiceTotals(invoice) {
  const totals = quoteTotals(invoice.lines.map((line) => ({ ...line, lineType: line.lineType === "claim" ? "custom" : line.lineType })));
  if (totals.inconsistent.length) {
    const line = invoice.lines[totals.inconsistent[0]];
    throw invalid(`invoice ${invoice.number}, line ${line.name}: total ${line.lineTotal} is not ${line.quantity} x ${line.unitSell}`);
  }
  if (invoice.taxTotalSource === "printed") {
    if (!invoice.taxTotalReason) throw invalid(`invoice ${invoice.number}: GST kept as printed needs its reason`);
    const tax = toCents(invoice.taxTotal);
    return { ...totals, taxTotal: centsToText(tax), total: centsToText(toCents(totals.subtotal) + tax), taxTotalSource: "printed", taxTotalReason: invoice.taxTotalReason };
  }
  return { ...totals, taxTotalSource: "computed", taxTotalReason: null };
}

/** What an invoice's lines say, without uids, so stored and mapped lines compare. */
function linesFingerprint(lines, milestoneUidOf) {
  return JSON.stringify([...lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((line) => [
    line.lineType,
    line.name,
    line.description ?? null,
    fixed(line.quantity, 4),
    line.unitCode,
    line.unitSell == null ? null : fixed(line.unitSell, 4),
    line.taxCode,
    fixed(line.taxRate, 3),
    fixed(line.lineTotal, 2),
    line.lineTotalSource,
    line.lineTotalReason ?? null,
    milestoneUidOf(line),
  ]));
}

async function insertLines(tx, invoiceUid, invoice, refs, actor, at) {
  if (!invoice.lines.length) return;
  await tx.insert(invoiceLines).values(invoice.lines.map((line, index) => ({
    uid: newInvoiceLineUid(at.getTime()),
    invoiceUid,
    sortOrder: line.sortOrder ?? index,
    lineType: line.lineType,
    quoteUid: line.lineType === "claim" ? (invoice.quoteUid || null) : (line.quoteUid || null),
    milestoneUid: line.milestoneKey != null ? (refs.milestoneUid(line.milestoneKey) || null) : null,
    itemUid: line.itemUid || null,
    name: line.name,
    description: line.description || null,
    quantity: fixed(line.quantity ?? 1, 4),
    unitCode: line.unitCode || "lot",
    unitSell: line.unitSell == null ? null : fixed(line.unitSell, 4),
    taxCode: line.taxCode || "GST",
    taxRate: fixed(line.taxRate ?? 10, 3),
    lineTotal: fixed(line.lineTotal, 2),
    lineTotalSource: line.lineTotalSource === "printed" ? "printed" : "computed",
    lineTotalReason: line.lineTotalSource === "printed" ? (line.lineTotalReason || null) : null,
    createdAt: at,
    createdBy: actor,
  })));
}

function headerValues(invoice, totals, refs) {
  return {
    number: invoice.number,
    kind: invoice.kind,
    revision: invoice.revision || 1,
    currency: invoice.currency || "AUD",
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    taxTotalSource: totals.taxTotalSource,
    taxTotalReason: totals.taxTotalReason,
    quoteUid: invoice.quoteUid || null,
    quoteVersion: invoice.quoteVersion || null,
    quoteVersionInferred: Boolean(invoice.quoteVersionInferred),
    milestoneUid: invoice.milestoneKey != null ? (refs.milestoneUid(invoice.milestoneKey) || null) : null,
    dueOn: invoice.dueOn || null,
    reference: invoice.reference || null,
    revisionReason: invoice.revisionReason || null,
    revisedBy: invoice.revisedBy || null,
    note: invoice.note || null,
    issuedDocumentUid: invoice.issuedDocumentUid || null,
  };
}

// The issued fields, set last so lines can be written while it is a draft.
function issueValues(invoice) {
  return {
    status: invoice.status,
    issuedAt: date(invoice.issuedAt),
    issuedOn: invoice.issuedOn || (invoice.issuedAt ? new Date(invoice.issuedAt).toISOString().slice(0, 10) : null),
    supersededAt: date(invoice.supersededAt),
  };
}

/**
 * Write one invoice that is being issued now, inside the caller's
 * organisation transaction (the invoice issue service, issue.js): its row,
 * then its lines while it is still a draft, then its issue fields, the way
 * writeJob writes a new issued invoice, so a later sync of the job's files
 * finds the row exactly as it maps it. `milestoneUid` and `quoteUid` are the
 * rows the invoice belongs to when they exist (else the next sync fills them
 * once). Returns the new invoice's uid.
 */
export async function insertIssuedInvoiceRow(tx, { jobId, invoice, issueKey, issuedDocumentUid = null, milestoneUid = null, quoteUid = null, actor = null, at = new Date() }) {
  if (!invoice.issuedAt || invoice.status === "draft") throw invalid(`invoice ${invoice.number}: only an issued invoice is written here`);
  const refs = { milestoneUid: () => milestoneUid };
  const withLinks = { ...invoice, quoteUid: quoteUid || invoice.quoteUid || null, issuedDocumentUid: issuedDocumentUid || invoice.issuedDocumentUid || null };
  const totals = invoiceTotals(withLinks);
  const uid = newInvoiceUid(at.getTime());
  await tx.insert(invoices).values({ uid, jobId, ...headerValues(withLinks, totals, refs), supersedesInvoiceUid: invoice.supersedesInvoiceUid || null, status: "draft", amountPaid: "0.00", createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor });
  await insertLines(tx, uid, withLinks, refs, actor, at);
  await tx.update(invoices).set({ ...issueValues(withLinks), issueKey, updatedAt: at, updatedBy: actor }).where(eq(invoices.uid, uid));
  return uid;
}

/**
 * Write one credit note inside the caller's organisation transaction: its
 * row as a draft, its lines (each crediting the credited invoice's line in
 * the same place), then its issue fields, so it is frozen as written (0013's
 * triggers). `creditNote` is mapped like an invoice (from-milestones.js).
 * Returns the new credit note's uid.
 */
export async function insertCreditNoteRow(tx, { jobId, creditNote, invoiceUid, replacementInvoiceUid, issueKey = null, issuedDocumentUid = null, actor = null, at = new Date() }) {
  if (!creditNote.issuedAt) throw invalid(`credit note ${creditNote.number}: only an issued credit note is written here`);
  const totals = invoiceTotals(creditNote);
  const uid = newCreditNoteUid(at.getTime());
  await tx.insert(creditNotes).values({
    uid,
    jobId,
    number: creditNote.number,
    invoiceUid,
    status: "draft",
    reason: creditNote.reason,
    currency: creditNote.currency || "AUD",
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    taxTotalSource: totals.taxTotalSource,
    taxTotalReason: totals.taxTotalReason,
    reference: creditNote.reference || null,
    replacementInvoiceUid: replacementInvoiceUid || null,
    origin: creditNote.origin || "issued",
    createdAt: at,
    createdBy: creditNote.createdBy || actor,
    updatedAt: at,
    updatedBy: actor,
  });
  const credited = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceUid, invoiceUid)).orderBy(asc(invoiceLines.sortOrder));
  if (creditNote.lines.length) {
    await tx.insert(creditNoteLines).values(creditNote.lines.map((line, index) => ({
      uid: newCreditNoteLineUid(at.getTime()),
      creditNoteUid: uid,
      invoiceLineUid: credited[index]?.uid || null,
      sortOrder: line.sortOrder ?? index,
      lineType: line.lineType,
      name: line.name,
      description: line.description || null,
      quantity: fixed(line.quantity ?? 1, 4),
      unitCode: line.unitCode || "lot",
      unitSell: line.unitSell == null ? null : fixed(line.unitSell, 4),
      taxCode: line.taxCode || "GST",
      taxRate: fixed(line.taxRate ?? 10, 3),
      lineTotal: fixed(line.lineTotal, 2),
      lineTotalSource: line.lineTotalSource === "printed" ? "printed" : "computed",
      lineTotalReason: line.lineTotalSource === "printed" ? (line.lineTotalReason || null) : null,
      createdAt: at,
      createdBy: actor,
    })));
  }
  await tx.update(creditNotes).set({
    status: "issued",
    issuedAt: date(creditNote.issuedAt),
    issuedOn: creditNote.issuedOn || new Date(creditNote.issuedAt).toISOString().slice(0, 10),
    issuedDocumentUid,
    issueKey,
    updatedAt: at,
    updatedBy: actor,
  }).where(eq(creditNotes.uid, uid));
  return uid;
}

/**
 * Move every active payment a credited invoice still holds to the invoice
 * that replaced it, as a payment allocation, for every credit note of the
 * job (inside the caller's transaction). A payment is held by the invoice of
 * its latest allocation, else the invoice it was recorded against. Never
 * moves a payment twice for one credit note. Returns the number written.
 */
export async function allocateCreditedPayments(tx, { jobId, actor = null, at = new Date() }) {
  const notes = (await tx.select().from(creditNotes).where(eq(creditNotes.jobId, jobId)).orderBy(asc(creditNotes.issuedAt), asc(creditNotes.createdAt)))
    .filter((note) => note.status === "issued" && note.replacementInvoiceUid);
  if (!notes.length) return 0;
  const jobPayments = await tx.select().from(payments).where(eq(payments.jobId, jobId));
  const allocations = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.jobId, jobId)).orderBy(asc(paymentAllocations.allocatedAt), asc(paymentAllocations.createdAt));
  const holder = new Map(jobPayments.map((payment) => [payment.uid, payment.invoiceUid]));
  const moved = new Set(allocations.map((allocation) => `${allocation.paymentUid}:${allocation.creditNoteUid}`));
  for (const allocation of allocations) holder.set(allocation.paymentUid, allocation.toInvoiceUid);
  let written = 0;
  for (const note of notes) {
    for (const payment of jobPayments) {
      if (payment.voidedAt || holder.get(payment.uid) !== note.invoiceUid || moved.has(`${payment.uid}:${note.uid}`)) continue;
      await tx.insert(paymentAllocations).values({
        uid: newPaymentAllocationUid(at.getTime()),
        jobId,
        paymentUid: payment.uid,
        fromInvoiceUid: note.invoiceUid,
        toInvoiceUid: note.replacementInvoiceUid,
        creditNoteUid: note.uid,
        amount: payment.amount,
        allocatedAt: at,
        createdAt: at,
        createdBy: actor,
      });
      holder.set(payment.uid, note.replacementInvoiceUid);
      moved.add(`${payment.uid}:${note.uid}`);
      written += 1;
    }
  }
  return written;
}

/** Each invoice's amount paid: the active payments it holds (after allocations). */
export async function refreshAmountsPaid(tx, { jobId, actor, at }) {
  const holder = new Map();
  for (const row of await tx.select().from(payments).where(eq(payments.jobId, jobId))) {
    if (!row.voidedAt) holder.set(row.uid, { invoiceUid: row.invoiceUid, amount: row.amount });
  }
  for (const allocation of await tx.select().from(paymentAllocations).where(eq(paymentAllocations.jobId, jobId)).orderBy(asc(paymentAllocations.allocatedAt), asc(paymentAllocations.createdAt))) {
    const held = holder.get(allocation.paymentUid);
    if (held) held.invoiceUid = allocation.toInvoiceUid;
  }
  const activeByInvoice = new Map();
  for (const { invoiceUid, amount } of holder.values()) activeByInvoice.set(invoiceUid, (activeByInvoice.get(invoiceUid) || 0n) + toCents(amount));
  for (const row of await tx.select().from(invoices).where(eq(invoices.jobId, jobId))) {
    const paid = centsToText(activeByInvoice.get(row.uid) || 0n);
    if (sameMoney(row.amountPaid, paid)) continue;
    await tx.update(invoices).set({ amountPaid: paid, updatedAt: at, updatedBy: actor, version: row.version + 1 }).where(eq(invoices.uid, row.uid));
  }
}

/**
 * The service for one organisation. `db` is an orgScope, or a database with
 * `orgUid`.
 */
export function createInvoiceRowService({ db, orgUid = undefined, now = () => new Date() }) {
  if (!db) throw new Error("createInvoiceRowService needs a database");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);

  async function loadJob(tx, jobId) {
    const milestoneRows = await tx.select().from(paymentMilestones).where(eq(paymentMilestones.jobId, jobId)).orderBy(asc(paymentMilestones.sortOrder));
    // Oldest first; numbers by their period and sequence, never their text.
    const invoiceRows = (await tx.select().from(invoices).where(eq(invoices.jobId, jobId)))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || compareDocumentNumbers(a.number, b.number));
    const lineRows = invoiceRows.length
      ? await tx.select().from(invoiceLines).where(inArray(invoiceLines.invoiceUid, invoiceRows.map((row) => row.uid))).orderBy(asc(invoiceLines.sortOrder))
      : [];
    const linesByInvoice = new Map(invoiceRows.map((row) => [row.uid, []]));
    for (const line of lineRows) linesByInvoice.get(line.invoiceUid).push(line);
    const paymentRows = await tx.select().from(payments).where(eq(payments.jobId, jobId)).orderBy(asc(payments.recordedAt));
    const receiptRows = await tx.select().from(receipts).where(eq(receipts.jobId, jobId)).orderBy(asc(receipts.issuedAt));
    const creditNoteRows = await tx.select().from(creditNotes).where(eq(creditNotes.jobId, jobId)).orderBy(asc(creditNotes.issuedAt), asc(creditNotes.number));
    const creditLineRows = creditNoteRows.length
      ? await tx.select().from(creditNoteLines).where(inArray(creditNoteLines.creditNoteUid, creditNoteRows.map((row) => row.uid))).orderBy(asc(creditNoteLines.sortOrder))
      : [];
    const linesByCreditNote = new Map(creditNoteRows.map((row) => [row.uid, []]));
    for (const line of creditLineRows) linesByCreditNote.get(line.creditNoteUid).push(line);
    const allocationRows = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.jobId, jobId)).orderBy(asc(paymentAllocations.allocatedAt), asc(paymentAllocations.createdAt));
    return { milestoneRows, invoiceRows, linesByInvoice, paymentRows, receiptRows, creditNoteRows, linesByCreditNote, allocationRows };
  }

  /** Fields of an issued invoice that never change, compared with the mapping. */
  function frozenDifferences(row, lines, invoice, totals, refs) {
    const differences = [];
    const check = (field, ok, stored, mapped) => { if (!ok) differences.push({ field, stored, mapped }); };
    check("subtotal", sameMoney(row.subtotal, totals.subtotal), row.subtotal, totals.subtotal);
    check("taxTotal", sameMoney(row.taxTotal, totals.taxTotal), row.taxTotal, totals.taxTotal);
    check("total", sameMoney(row.total, totals.total), row.total, totals.total);
    check("taxTotalSource", same(row.taxTotalSource, totals.taxTotalSource), row.taxTotalSource, totals.taxTotalSource);
    check("currency", same(row.currency, invoice.currency || "AUD"), row.currency, invoice.currency);
    check("issuedAt", sameTime(row.issuedAt, invoice.issuedAt), iso(row.issuedAt), invoice.issuedAt);
    check("revision", same(row.revision, invoice.revision || 1), row.revision, invoice.revision);
    check("reference", same(row.reference, invoice.reference || null), row.reference, invoice.reference || null);
    check("revisionReason", same(row.revisionReason, invoice.revisionReason || null), row.revisionReason, invoice.revisionReason || null);
    check("revisedBy", same(row.revisedBy, invoice.revisedBy || null), row.revisedBy, invoice.revisedBy || null);
    const stored = linesFingerprint(lines, (line) => line.milestoneUid ?? null);
    const mapped = linesFingerprint(invoice.lines, (line) => (line.milestoneKey != null ? refs.milestoneUid(line.milestoneKey) : null) ?? null);
    // A line's milestone may have been filled once, after the line was written.
    const storedLoose = linesFingerprint(lines, () => null);
    const mappedLoose = linesFingerprint(invoice.lines, () => null);
    check("lines", stored === mapped || storedLoose === mappedLoose, "stored lines", "mapped lines");
    return differences;
  }

  async function writeJobNow(tx, { jobId, mapped, actor }) {
    const at = now();
    const summary = {
      jobId,
      milestones: { created: 0, updated: 0, unchanged: 0, deleted: 0, kept: 0 },
      invoices: { created: 0, replaced: 0, issued: 0, updated: 0, unchanged: 0, deleted: 0 },
      creditNotes: { created: 0, unchanged: 0 },
      payments: { created: 0, voided: 0, unchanged: 0 },
      allocations: { created: 0 },
      receipts: { created: 0, voided: 0, updated: 0, unchanged: 0 },
      conflicts: [],
      kept: [],
    };
    const existing = await loadJob(tx, jobId);

    // 1. The schedule.
    const milestoneUids = new Map();
    const milestonesByOrder = new Map(existing.milestoneRows.map((row) => [row.sortOrder, row]));
    for (const milestone of mapped.milestones) {
      const values = {
        label: milestone.label,
        percent: milestone.percent == null ? null : fixed(milestone.percent, 3),
        amount: milestone.amount == null ? null : fixed(milestone.amount, 2),
        dueDays: milestone.dueDays ?? null,
        quoteUid: milestone.quoteUid || null,
        isDefaultSchedule: Boolean(milestone.isDefaultSchedule),
      };
      const row = milestonesByOrder.get(milestone.sortOrder);
      if (!row) {
        const uid = newPaymentMilestoneUid(at.getTime());
        await tx.insert(paymentMilestones).values({ uid, jobId, sortOrder: milestone.sortOrder, ...values, createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor });
        milestoneUids.set(milestone.key, uid);
        summary.milestones.created += 1;
        continue;
      }
      milestoneUids.set(milestone.key, row.uid);
      const changed = !same(row.label, values.label) || !sameDecimal(row.percent, values.percent, 3) || !sameDecimal(row.amount, values.amount, 2)
        || !same(row.dueDays, values.dueDays) || !same(row.quoteUid, values.quoteUid) || row.isDefaultSchedule !== values.isDefaultSchedule;
      if (!changed) {
        summary.milestones.unchanged += 1;
        continue;
      }
      await tx.update(paymentMilestones).set({ ...values, updatedAt: at, updatedBy: actor, version: row.version + 1 }).where(eq(paymentMilestones.uid, row.uid));
      summary.milestones.updated += 1;
    }
    const refs = { milestoneUid: (key) => milestoneUids.get(String(key)) };

    // 2. Invoices: history first, so an invoice's predecessor exists.
    const invoiceUids = new Map();
    const invoicesByNumber = new Map(existing.invoiceRows.map((row) => [row.number, row]));
    const mappedNumbers = new Set(mapped.invoices.map((invoice) => invoice.number));
    // Drafts the files no longer have go first, so a new draft may reuse a number.
    for (const row of existing.invoiceRows) {
      if (isIssuedInvoice(row) || mappedNumbers.has(row.number)) continue;
      if (existing.paymentRows.some((payment) => payment.invoiceUid === row.uid)) {
        summary.kept.push({ number: row.number, reason: "a draft invoice the files no longer have, kept because payments were recorded against it" });
        invoiceUids.set(row.number, row.uid);
        continue;
      }
      await tx.delete(invoices).where(eq(invoices.uid, row.uid));
      invoicesByNumber.delete(row.number);
      summary.invoices.deleted += 1;
    }
    const pendingLinks = [];
    for (const invoice of mapped.invoices) {
      const totals = invoiceTotals(invoice);
      const header = headerValues(invoice, totals, refs);
      const row = invoicesByNumber.get(invoice.number);
      if (invoice.supersedesKey) pendingLinks.push(invoice);
      if (!row) {
        const uid = newInvoiceUid(at.getTime());
        await tx.insert(invoices).values({ uid, jobId, ...header, status: "draft", amountPaid: "0.00", createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor });
        await insertLines(tx, uid, invoice, refs, actor, at);
        if (invoice.status !== "draft") {
          await tx.update(invoices).set({ ...issueValues(invoice), updatedAt: at, updatedBy: actor }).where(eq(invoices.uid, uid));
        }
        invoiceUids.set(invoice.number, uid);
        summary.invoices.created += 1;
        continue;
      }
      invoiceUids.set(invoice.number, row.uid);
      const lines = existing.linesByInvoice.get(row.uid) || [];
      if (isIssuedInvoice(row)) {
        const differences = frozenDifferences(row, lines, invoice, totals, refs);
        if (differences.length) {
          summary.conflicts.push({ kind: "issued-invoice-differs", number: invoice.number, differences, reason: "this issued invoice's rows were written earlier and the files now map to different values; the rows were kept as issued" });
        }
        const changes = {};
        if (invoice.status !== "draft" && !same(row.status, invoice.status)) changes.status = invoice.status;
        if (!same(row.dueOn, invoice.dueOn || null)) changes.dueOn = invoice.dueOn || null;
        if (!same(row.kind, invoice.kind)) changes.kind = invoice.kind;
        if (!same(row.note, invoice.note || null)) changes.note = invoice.note || null;
        for (const field of ["quoteUid", "milestoneUid", "issuedDocumentUid"]) {
          if (row[field] == null && header[field]) changes[field] = header[field];
        }
        if (row.quoteVersion == null && header.quoteVersion) {
          changes.quoteVersion = header.quoteVersion;
          changes.quoteVersionInferred = header.quoteVersionInferred;
        }
        if (row.supersededAt == null && invoice.supersededAt) changes.supersededAt = date(invoice.supersededAt);
        if (invoice.status === "draft") {
          summary.conflicts.push({ kind: "issued-invoice-draft", number: invoice.number, reason: "the files show this issued invoice as a draft; an issued invoice never goes back to draft" });
        }
        if (Object.keys(changes).length) {
          await tx.update(invoices).set({ ...changes, updatedAt: at, updatedBy: actor, version: row.version + 1 }).where(eq(invoices.uid, row.uid));
          summary.invoices.updated += 1;
        } else {
          summary.invoices.unchanged += 1;
        }
        continue;
      }
      // A draft: rewritten when anything about it changed.
      const sameContent = linesFingerprint(lines, (line) => line.milestoneUid ?? null)
        === linesFingerprint(invoice.lines, (line) => (line.milestoneKey != null ? refs.milestoneUid(line.milestoneKey) : null) ?? null);
      const sameHeader = Object.entries(header).every(([field, value]) => {
        if (["subtotal", "taxTotal", "total"].includes(field)) return sameMoney(row[field], value);
        return same(row[field], value);
      });
      if (sameContent && sameHeader && invoice.status === "draft") {
        summary.invoices.unchanged += 1;
        continue;
      }
      if (!sameContent) {
        await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceUid, row.uid));
        await insertLines(tx, row.uid, invoice, refs, actor, at);
      }
      await tx.update(invoices).set({
        ...header,
        ...(invoice.status !== "draft" ? issueValues(invoice) : {}),
        updatedAt: at,
        updatedBy: actor,
        version: row.version + 1,
      }).where(eq(invoices.uid, row.uid));
      if (invoice.status !== "draft") summary.invoices.issued += 1;
      else summary.invoices.replaced += 1;
    }
    for (const invoice of pendingLinks) {
      const uid = invoiceUids.get(invoice.number);
      const supersedes = invoiceUids.get(invoice.supersedesKey);
      if (!uid || !supersedes) continue;
      const [row] = await tx.select().from(invoices).where(eq(invoices.uid, uid));
      if (row.supersedesInvoiceUid) continue;
      await tx.update(invoices).set({ supersedesInvoiceUid: supersedes, updatedAt: at, updatedBy: actor, version: row.version + 1 }).where(eq(invoices.uid, uid));
    }

    // 2b. Credit notes: each credited invoice's note, written once. One
    // issued with the issue service is already here (issue.js); one for a
    // revision made in place before credit notes is recorded now.
    const creditByInvoice = new Map(existing.creditNoteRows.filter((row) => row.status === "issued").map((row) => [row.invoiceUid, row]));
    for (const note of mapped.creditNotes || []) {
      const invoiceUid = invoiceUids.get(note.invoiceKey);
      const replacementUid = invoiceUids.get(note.replacementKey);
      if (!invoiceUid || !replacementUid) throw invalid(`credit note ${note.number}: no invoice ${invoiceUid ? note.replacementKey : note.invoiceKey}`);
      const row = creditByInvoice.get(invoiceUid);
      if (!row) {
        await insertCreditNoteRow(tx, { jobId, creditNote: note, invoiceUid, replacementInvoiceUid: replacementUid, actor, at });
        summary.creditNotes.created += 1;
        continue;
      }
      const totals = invoiceTotals(note);
      const differences = [];
      const check = (field, ok, stored, mappedValue) => { if (!ok) differences.push({ field, stored, mapped: mappedValue }); };
      check("number", same(row.number, note.number), row.number, note.number);
      check("replacementInvoice", same(row.replacementInvoiceUid, replacementUid), row.replacementInvoiceUid, replacementUid);
      check("subtotal", sameMoney(row.subtotal, totals.subtotal), row.subtotal, totals.subtotal);
      check("taxTotal", sameMoney(row.taxTotal, totals.taxTotal), row.taxTotal, totals.taxTotal);
      check("total", sameMoney(row.total, totals.total), row.total, totals.total);
      if (differences.length) summary.conflicts.push({ kind: "credit-note-differs", number: row.number, differences, reason: "this credit note's row was written earlier and the files now map to different values; the row was kept as issued" });
      summary.creditNotes.unchanged += 1;
    }

    // 3. Payments: never deleted; one the files no longer hold is voided.
    const paymentUids = new Map();
    const paymentsBySource = new Map(existing.paymentRows.map((row) => [row.sourcePaymentId, row]));
    const mappedPaymentKeys = new Set(mapped.payments.map((payment) => payment.key));
    for (const payment of mapped.payments) {
      const invoiceUid = invoiceUids.get(payment.invoiceKey);
      if (!invoiceUid) throw invalid(`payment ${payment.key}: no invoice ${payment.invoiceKey}`);
      const row = paymentsBySource.get(payment.key);
      const milestoneUid = refs.milestoneUid(payment.milestoneKey) || null;
      if (!row) {
        const uid = newPaymentUid(at.getTime());
        await tx.insert(payments).values({
          uid,
          jobId,
          invoiceUid,
          milestoneUid,
          amount: fixed(payment.amount, 2),
          paidOn: payment.paidOn,
          method: payment.method || null,
          reference: payment.reference || null,
          recordedAt: date(payment.recordedAt),
          voidedAt: date(payment.voidedAt),
          voidReason: payment.voidedAt ? (payment.voidReason || null) : null,
          voidedBy: payment.voidedAt ? (payment.voidedBy || null) : null,
          sourcePaymentId: payment.key,
          createdAt: at,
          createdBy: actor,
          updatedAt: at,
          updatedBy: actor,
        });
        paymentUids.set(payment.key, uid);
        summary.payments.created += 1;
        continue;
      }
      paymentUids.set(payment.key, row.uid);
      const differences = [];
      if (row.invoiceUid !== invoiceUid) differences.push({ field: "invoice", stored: row.invoiceUid, mapped: invoiceUid });
      if (!sameMoney(row.amount, payment.amount)) differences.push({ field: "amount", stored: row.amount, mapped: payment.amount });
      if (!same(row.paidOn, payment.paidOn)) differences.push({ field: "paidOn", stored: row.paidOn, mapped: payment.paidOn });
      if (!same(row.method, payment.method || null)) differences.push({ field: "method", stored: row.method, mapped: payment.method || null });
      if (!same(row.reference, payment.reference || null)) differences.push({ field: "reference", stored: row.reference, mapped: payment.reference || null });
      if (!sameTime(row.recordedAt, payment.recordedAt)) differences.push({ field: "recordedAt", stored: iso(row.recordedAt), mapped: payment.recordedAt });
      if (row.voidedAt && !payment.voidedAt) differences.push({ field: "voidedAt", stored: iso(row.voidedAt), mapped: null });
      if (differences.length) summary.conflicts.push({ kind: "payment-differs", payment: payment.key, differences, reason: "this payment's row was written earlier and the files now say otherwise; the row was kept" });
      const changes = {};
      if (!row.voidedAt && payment.voidedAt) Object.assign(changes, { voidedAt: date(payment.voidedAt), voidReason: payment.voidReason || null, voidedBy: payment.voidedBy || null });
      if (!row.milestoneUid && milestoneUid) changes.milestoneUid = milestoneUid;
      if (Object.keys(changes).length) {
        await tx.update(payments).set({ ...changes, updatedAt: at, updatedBy: actor, version: row.version + 1 }).where(eq(payments.uid, row.uid));
        if (changes.voidedAt) summary.payments.voided += 1;
      } else {
        summary.payments.unchanged += 1;
      }
    }
    for (const row of existing.paymentRows) {
      if (mappedPaymentKeys.has(row.sourcePaymentId) || row.voidedAt) continue;
      await tx.update(payments).set({
        voidedAt: at,
        voidReason: "No longer in the job's milestone record (the invoice was marked unpaid)",
        voidedBy: actor,
        updatedAt: at,
        updatedBy: actor,
        version: row.version + 1,
      }).where(eq(payments.uid, row.uid));
      summary.payments.voided += 1;
    }

    // 3b. Payments a credited invoice holds move to its replacement.
    summary.allocations.created = await allocateCreditedPayments(tx, { jobId, actor, at });

    // 4. Each invoice's amount paid: the active payments it holds.
    await refreshAmountsPaid(tx, { jobId, actor, at });

    // 5. Receipts: one the files no longer have is voided first, so a new
    // receipt may take its number.
    const mappedPaymentUidsWithReceipt = new Set(mapped.receipts.map((receipt) => paymentUids.get(receipt.paymentKey)));
    for (const row of existing.receiptRows) {
      if (row.status !== "issued" || mappedPaymentUidsWithReceipt.has(row.paymentUid)) continue;
      await tx.update(receipts).set({ status: "void", updatedAt: at, updatedBy: actor, version: row.version + 1 }).where(eq(receipts.uid, row.uid));
      summary.receipts.voided += 1;
    }
    const receiptsByPayment = new Map(existing.receiptRows.map((row) => [row.paymentUid, row]));
    for (const receipt of mapped.receipts) {
      const paymentUid = paymentUids.get(receipt.paymentKey);
      const invoiceUid = invoiceUids.get(receipt.invoiceKey);
      if (!paymentUid || !invoiceUid) throw invalid(`receipt ${receipt.number}: no payment or invoice`);
      const row = receiptsByPayment.get(paymentUid);
      if (!row) {
        await tx.insert(receipts).values({
          uid: newReceiptUid(at.getTime()),
          jobId,
          number: receipt.number,
          paymentUid,
          invoiceUid,
          status: "issued",
          amount: fixed(receipt.amount, 2),
          currency: receipt.currency || "AUD",
          issuedAt: date(receipt.issuedAt),
          issuedOn: receipt.issuedOn,
          issuedDocumentUid: receipt.issuedDocumentUid || null,
          createdAt: at,
          createdBy: actor,
          updatedAt: at,
          updatedBy: actor,
        });
        summary.receipts.created += 1;
        continue;
      }
      const differences = [];
      if (!same(row.number, receipt.number)) differences.push({ field: "number", stored: row.number, mapped: receipt.number });
      if (!sameMoney(row.amount, receipt.amount)) differences.push({ field: "amount", stored: row.amount, mapped: receipt.amount });
      if (row.invoiceUid !== invoiceUid) differences.push({ field: "invoice", stored: row.invoiceUid, mapped: invoiceUid });
      if (!sameTime(row.issuedAt, receipt.issuedAt)) differences.push({ field: "issuedAt", stored: iso(row.issuedAt), mapped: receipt.issuedAt });
      if (row.status === "void") differences.push({ field: "status", stored: "void", mapped: "issued" });
      if (differences.length) summary.conflicts.push({ kind: "receipt-differs", number: receipt.number, differences, reason: "this receipt's row was written earlier and the files now say otherwise; the row was kept" });
      if (!row.issuedDocumentUid && receipt.issuedDocumentUid) {
        await tx.update(receipts).set({ issuedDocumentUid: receipt.issuedDocumentUid, updatedAt: at, updatedBy: actor, version: row.version + 1 }).where(eq(receipts.uid, row.uid));
        summary.receipts.updated += 1;
      } else {
        summary.receipts.unchanged += 1;
      }
    }

    // 6. Milestones the files no longer have: deleted unless something points at them.
    const mappedOrders = new Set(mapped.milestones.map((milestone) => milestone.sortOrder));
    for (const row of existing.milestoneRows) {
      if (mappedOrders.has(row.sortOrder)) continue;
      const [invoiceRef] = await tx.select({ uid: invoices.uid }).from(invoices).where(eq(invoices.milestoneUid, row.uid)).limit(1);
      const [paymentRef] = await tx.select({ uid: payments.uid }).from(payments).where(eq(payments.milestoneUid, row.uid)).limit(1);
      const [lineRef] = await tx.select({ uid: invoiceLines.uid }).from(invoiceLines).where(eq(invoiceLines.milestoneUid, row.uid)).limit(1);
      if (invoiceRef || paymentRef || lineRef) {
        summary.milestones.kept += 1;
        summary.kept.push({ milestone: row.sortOrder, reason: "a milestone the schedule no longer has, kept because issued invoices or payments point at it" });
        continue;
      }
      await tx.delete(paymentMilestones).where(eq(paymentMilestones.uid, row.uid));
      summary.milestones.deleted += 1;
    }
    return summary;
  }

  return {
    orgUid: scope.orgUid,

    /**
     * Bring one job's rows in line with `mapped` (from-milestones.js, with
     * `quoteUid` on milestones and invoices and `issuedDocumentUid` on
     * invoices and receipts filled in by the caller). Returns a summary of
     * what was (or, with `dryRun`, would be) written and any conflicts.
     */
    async writeJob({ jobId, mapped, actor = null, dryRun = false }) {
      const cleanJobId = String(jobId ?? "").trim();
      if (!cleanJobId) throw invalid("invoice rows need their job id");
      try {
        const summary = await scope.transaction(async (tx) => {
          const result = await writeJobNow(tx, { jobId: cleanJobId, mapped, actor });
          if (dryRun) throw new DryRunRollback(result);
          return result;
        });
        return { ...summary, dryRun: false };
      } catch (error) {
        if (error instanceof DryRunRollback) return { ...error.summary, dryRun: true };
        throw error;
      }
    },

    /** The job's rows: milestones, invoices with their lines, payments and receipts. */
    async readJob(jobId) {
      return scope.transaction(async (tx) => {
        const loaded = await loadJob(tx, String(jobId));
        return {
          milestones: loaded.milestoneRows.map(milestoneFromRow),
          invoices: loaded.invoiceRows.map((row) => invoiceFromRow(row, loaded.linesByInvoice.get(row.uid))),
          creditNotes: loaded.creditNoteRows.map((row) => creditNoteFromRow(row, loaded.linesByCreditNote.get(row.uid))),
          payments: loaded.paymentRows.map(paymentFromRow),
          allocations: loaded.allocationRows.map(allocationFromRow),
          receipts: loaded.receiptRows.map(receiptFromRow),
        };
      });
    },

    /** Whether the job has any invoice rows (the dual-write's shortcut for a job with no milestones). */
    async hasRows(jobId) {
      return scope.transaction(async (tx) => {
        const [milestone] = await tx.select({ uid: paymentMilestones.uid }).from(paymentMilestones).where(eq(paymentMilestones.jobId, String(jobId))).limit(1);
        const [invoice] = await tx.select({ uid: invoices.uid }).from(invoices).where(eq(invoices.jobId, String(jobId))).limit(1);
        return Boolean(milestone || invoice);
      });
    },
  };
}
