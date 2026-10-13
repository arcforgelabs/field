// Today's milestone state (milestone-invoices/state.json, read through
// job-meta-store.js) as invoice rows (#27). Pure: no I/O, no clock.
//
//   milestone              -> payment_milestones (sort_order = its index)
//   issued revision        -> an issued invoice, its number exactly as issued
//     current                 issued, or paid when the milestone is paid
//     superseded by a          credited. Since step 4b (#28) with the credit
//     revision                 note that credited it in full and names its
//                              replacement; one revised in place before
//                              credit notes keeps its status and gets no
//                              credit note (owner's decision, 2026-10-13)
//     retired by unsend or     void (re-issuing the same content restores
//     mark unpaid              that number, so the void row is it)
//   issued, from before    -> an issued invoice from the stored record
//   revisions were frozen
//   draft milestone        -> a draft invoice under its provisional number
//   payment                -> payments, against the invoice it was recorded
//                             against (sourceInvoiceNumber), voided ones with
//                             voided_at
//   paid milestone         -> a receipt under its ER-… number, for the payment
//                             that cleared it
//
// An invoice's lines are what its PDF claims: one claim line, the milestone's
// share of the quote ex GST, which is what its PDF prints since step 4b
// (earlier PDFs also printed the quote's schedule, which is the quote's
// rows). Totals are as issued and never recomputed: where the
// milestone's GST (its share of the quote's GST) differs from GST worked out
// on its own subtotal, the GST is kept as printed, with the reason.
//
// An issued invoice whose record holds no issue time takes one from the
// job's other records (`issueTimes`, issue-time-evidence.js), with a note on
// its row and a warning naming the source; with none it is refused.
//
// Returns { milestones, invoices, creditNotes, payments, receipts, failures,
// warnings }. Every `unmappable` failure carries a stable `code`
// (UNMAPPABLE_CODES): the dry run and the boot log show codes and numbers,
// never the reason's text.
//
// Rows carry local keys (milestoneKey, invoiceKey, paymentKey) that the
// invoice service turns into uids.
import { listInvoiceRevisions } from "../invoice-revisions.js";
import { isMilestoneInvoiceIssued, isMilestonePaymentVoided } from "../job-documents.js";
import { centsToText, fixed, quoteTotals, toCents } from "../quotes/totals.js";

/**
 * Where an issue time came from when the record held none
 * (issue-time-evidence.js), as a row's note names it.
 */
export const ISSUE_TIME_SOURCE_LABELS = Object.freeze({
  "older-field": "the job's invoice send time (invoiceSentAt), from before milestone invoices",
  "issued-document": "the issued document Field recorded",
  "issuance-ledger": "the issuance ledger record of its delivery",
  "sent-email": "the first archived email that sent it",
  "activity-log": "the job's activity log (invoice sent)",
  "stored-pdf-date": "the date its stored PDF prints, at midnight in the business time zone",
});

/** Why a milestone does not map, as a stable code. */
export const UNMAPPABLE_CODES = Object.freeze([
  "no-amount",
  "duplicate-number",
  "no-issue-time",
  "no-invoice-number",
  "draft-no-number",
  "successor-not-issued",
  "credited-no-time",
  "payment-no-invoice",
  "payment-no-date",
  "no-receipt-number",
]);

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function money(value) {
  return fixed(Number.isFinite(Number(value)) ? Number(value) : 0, 2);
}

function iso(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateOnly(value) {
  if (value == null || value === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const at = iso(value);
  return at ? at.slice(0, 10) : null;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function trimNumber(value) {
  return String(value).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** deposit, progress, final or variation, from the label, else the milestone's place in the schedule. */
export function invoiceKind(label, index, count) {
  const value = String(label || "");
  if (/variation/i.test(value)) return "variation";
  if (/deposit/i.test(value)) return "deposit";
  if (/\b(final|completion|complete|balance|full)\b/i.test(value)) return "final";
  if (/progress/i.test(value)) return "progress";
  if (count <= 1 || index >= count - 1) return "final";
  return index === 0 ? "deposit" : "progress";
}

/** "Deposit, 50 % of EQ-2501-01 v2", or "Deposit of EQ-2501-01 v2" for a fixed amount. */
export function claimLineName({ label, percent, quoteReference }) {
  const share = percent && Number(percent) > 0 ? `, ${trimNumber(percent)} % of` : " of";
  return `${label}${share} ${quoteReference || "the quote"}`;
}

/**
 * Money for one invoice: one claim line for its subtotal and the GST it was
 * issued with. Returns { lines, totals, taxTotalSource, taxTotalReason } or
 * { failure } when the record does not add up.
 */
export function claimMoney({ subtotal, gst, total, taxRate, name, description, milestoneKey }) {
  const line = {
    lineType: "claim",
    milestoneKey,
    name,
    description,
    quantity: "1.0000",
    unitCode: "lot",
    unitSell: fixed(money(subtotal), 4),
    taxCode: "GST",
    taxRate,
    lineTotalSource: "computed",
  };
  const computed = quoteTotals([{ ...line, lineType: "custom" }]);
  line.lineTotal = computed.lines[0].lineTotal;
  const issuedTax = money(gst);
  const issuedTotal = money(total);
  if (toCents(computed.subtotal) + toCents(issuedTax) !== toCents(issuedTotal)) {
    return { failure: { kind: "snapshot", reason: `the record does not add up: ${computed.subtotal} + GST ${issuedTax} is not ${issuedTotal}` } };
  }
  const printed = toCents(issuedTax) !== toCents(computed.taxTotal);
  return {
    lines: [line],
    totals: { subtotal: computed.subtotal, taxTotal: issuedTax, total: issuedTotal },
    computedTaxTotal: computed.taxTotal,
    taxTotalSource: printed ? "printed" : "computed",
    taxTotalReason: printed
      ? `GST as issued, ${issuedTax}: a milestone's GST is its share of the quote's GST, which here differs from ${computed.taxTotal} on its own subtotal of ${computed.subtotal}`
      : null,
  };
}

const SETTLED_FROM = {
  "sent-copy": "the copy Field emailed",
  "stored-pdf": "the stored PDF",
  "milestone-record": "the milestone record",
};

/** Why a settled invoice's amounts are what they are: the owner's decision, numbers only. */
export function settlementReason(settlement, revision = null) {
  const version = revision?.quoteVersion ? ` (quote v${revision.quoteVersion}${revision.quoteVersionInferred ? ", inferred" : ""})` : "";
  const recorded = settlement.recorded ? money(settlement.recorded.total) : null;
  const pdf = settlement.storedPdfTotal != null ? money(settlement.storedPdfTotal) : null;
  const parts = [
    `Amounts as issued, settled by the owner on ${String(settlement.decidedAt || "").slice(0, 10) || "record"} from ${SETTLED_FROM[settlement.source] || settlement.source}: ${money(settlement.total)}`,
    recorded && toCents(recorded) !== toCents(money(settlement.total)) ? `the milestone record held ${recorded}${version}` : null,
    pdf && toCents(pdf) !== toCents(money(settlement.total)) ? `the stored PDF prints ${pdf}, drawn from a different quote version` : null,
  ].filter(Boolean);
  return `${parts.join("; ")}.`;
}

/** The GST rate of the quote basis as a percent with three decimals (10.000). */
function taxRateOf(quoteTaxRate) {
  return quoteTaxRate || "10.000";
}

/**
 * Map one job's milestone state.
 *
 *   meta          the job's hydrated meta (milestoneInvoices normalized,
 *                 paymentSchedule)
 *   basis         the quote Field invoices against: { version, number,
 *                 total, taxRate } (null when the job has no quote)
 *   jobNumber     the job number, the invoices' reference
 *   issueTimes    issue times from the job's other records for invoices whose
 *                 record holds none: Map number -> { issuedAt, issuedOn,
 *                 source } (issue-time-evidence.js)
 */
export function mapMilestoneState({ meta, basis = null, jobNumber = null, issueTimes = null }) {
  const milestones = [];
  const invoices = [];
  const creditNotes = [];
  const payments = [];
  const receipts = [];
  const failures = [];
  const warnings = [];
  const states = Array.isArray(meta?.milestoneInvoices) ? [...meta.milestoneInvoices] : [];
  states.sort((a, b) => a.milestoneIndex - b.milestoneIndex);
  const scheduleMilestones = Array.isArray(meta?.paymentSchedule?.milestones) ? meta.paymentSchedule.milestones : [];
  const count = states.length;
  const taxRate = taxRateOf(basis?.taxRate);
  const reference = text(jobNumber);
  const seenNumbers = new Set();

  for (const state of states) {
    const index = state.milestoneIndex;
    const milestoneKey = String(index);
    const label = text(state.milestoneLabel) || `Milestone ${index + 1}`;
    const percent = Number(state.percentage) > 0 ? fixed(state.percentage, 3) : null;
    const amount = Number(state.fixedTotal) > 0 ? money(state.fixedTotal) : null;
    if (!percent && !amount) {
      failures.push({ kind: "unmappable", code: "no-amount", milestone: index, reason: `milestone ${index + 1} has neither a percentage nor a fixed amount` });
      continue;
    }
    milestones.push({
      key: milestoneKey,
      sortOrder: index,
      label,
      percent,
      amount,
      dueDays: positiveInt(scheduleMilestones[index]?.dueDays),
      // From the account's milestone rules (step 4c, #29) until the job
      // overrides them; a schedule from before rules was set on the job.
      isDefaultSchedule: meta?.paymentSchedule?.source?.kind === "rule",
      quoteVersion: basis?.version || null,
    });

    const kind = invoiceKind(label, index, count);
    const quoteNumber = text(state.reference) || text(basis?.number);
    const describe = (quoteVersion) => ({
      name: claimLineName({ label, percent, quoteReference: quoteNumber ? `${quoteNumber}${quoteVersion ? ` v${quoteVersion}` : ""}` : null }),
      description: `Milestone ${index + 1} of ${count}`,
    });
    const revisions = listInvoiceRevisions({ issuedRevision: state.issuedRevision, revisionHistory: state.revisionHistory });
    const numbers = new Map();
    const addInvoice = (invoice) => {
      if (seenNumbers.has(invoice.number)) {
        failures.push({ kind: "unmappable", code: "duplicate-number", milestone: index, number: invoice.number, reason: `invoice number ${invoice.number} appears twice on this job` });
        return null;
      }
      seenNumbers.add(invoice.number);
      numbers.set(invoice.number, invoice);
      invoices.push(invoice);
      return invoice;
    };
    const fromRevision = (revision, { status, note, missingTime = `issued revision ${revision.invoiceNumber} has no issue time` }) => {
      const recorded = iso(revision.issuedAt) || iso(revision.pdfIssuedAt);
      const evidence = recorded ? null : (issueTimes?.get(revision.invoiceNumber) || null);
      const issuedAt = recorded || iso(evidence?.issuedAt);
      if (!issuedAt) {
        failures.push({ kind: "unmappable", code: "no-issue-time", milestone: index, number: revision.invoiceNumber, reason: missingTime, pdfPath: text(revision.pdfPath), pdfSha256: text(revision.pdfSha256) });
        return null;
      }
      if (evidence) {
        const from = ISSUE_TIME_SOURCE_LABELS[evidence.source] || evidence.source;
        note = `${note ? `${note} ` : ""}Issue time from ${from}: Field recorded none when it was issued.`;
        warnings.push({ kind: "issue-time-from-evidence", code: evidence.source, milestone: index, number: revision.invoiceNumber, reason: `${revision.invoiceNumber} has no issue time on record; ${issuedAt} is taken from ${from}` });
      }
      const moneyResult = claimMoney({ subtotal: revision.subtotal, gst: revision.gst, total: revision.total, taxRate, milestoneKey, ...describe(revision.quoteVersion) });
      if (moneyResult.failure) {
        failures.push({ ...moneyResult.failure, milestone: index, number: revision.invoiceNumber });
        return null;
      }
      const settlement = revision.amountsSettlement || null;
      if (settlement) {
        // An owner settled which amounts this invoice was issued for: they
        // are kept as printed on the document chosen, with the decision.
        moneyResult.taxTotalSource = "printed";
        moneyResult.taxTotalReason = settlementReason(settlement, revision);
      }
      return addInvoice({
        key: revision.invoiceNumber,
        number: revision.invoiceNumber,
        milestoneKey,
        kind,
        status,
        revision: revision.revisionNumber,
        issuedAt,
        issuedOn: (evidence && evidence.issuedOn) || issuedAt.slice(0, 10),
        dueOn: null,
        currency: text(revision.currency) || "AUD",
        ...moneyResult.totals,
        taxTotalSource: moneyResult.taxTotalSource,
        taxTotalReason: moneyResult.taxTotalReason,
        computedTaxTotal: moneyResult.computedTaxTotal,
        lines: moneyResult.lines,
        quoteVersion: positiveInt(revision.quoteVersion),
        quoteVersionInferred: Boolean(revision.quoteVersionInferred),
        supersedesKey: text(revision.supersedesInvoiceNumber),
        supersededAt: iso(revision.supersededAt),
        revisionReason: text(revision.revisionReason),
        revisedBy: text(revision.revisedBy),
        // An invoice issued from the sequence (step 4b) printed the job
        // reference it was issued with.
        reference: text(revision.jobReference) || reference,
        note,
        snapshot: { subtotal: money(revision.subtotal), taxTotal: money(revision.gst), total: money(revision.total) },
        pdfPath: text(revision.pdfPath),
        pdfSha256: text(revision.pdfSha256),
        issuedRevision: true,
        settlement,
      });
    };

    // Revisions no longer current, oldest first.
    const credited = [];
    for (const revision of revisions.filter((entry) => !entry.current)) {
      const superseded = revision.supersededByRevisionNumber != null;
      const successor = revisions.find((entry) => entry.revisionNumber === revision.supersededByRevisionNumber);
      const replacedBy = successor?.invoiceNumber || `revision ${revision.supersededByRevisionNumber}`;
      const invoice = fromRevision(revision, superseded
        ? { status: "credited", note: revision.creditNote
          ? `Credited by ${revision.creditNote.number} and replaced by ${replacedBy}.`
          : `Revised in place before credit notes: superseded by ${replacedBy}. No credit note was issued.` }
        : { status: "void", note: "Returned to draft after it was issued (unsent, or marked unpaid). Re-issuing the same content restores this number." });
      // Only a credit note that was issued (step 4b on) is a row: none is
      // invented for a revision made in place before credit notes.
      if (invoice && superseded && successor && revision.creditNote) credited.push({ invoice, revision, successor, number: revision.creditNote.number });
    }

    const paid = state.status === "paid";
    let current = null;
    if (state.issuedRevision) {
      current = fromRevision(state.issuedRevision, { status: paid ? "paid" : "issued", note: null });
    } else if (isMilestoneInvoiceIssued(state)) {
      // Issued before invoice revisions froze a snapshot: the stored record
      // is what was issued (buildMilestoneInvoices freezes it from the same
      // values on its next rebuild).
      const number = text(state.invoiceNumber);
      if (!number) {
        failures.push({ kind: "unmappable", code: "no-invoice-number", milestone: index, number, reason: `milestone ${index + 1} is ${state.status} but has no invoice number` });
      } else {
        current = fromRevision({
          invoiceNumber: number,
          revisionNumber: state.revisionNumber || 1,
          issuedAt: iso(state.issuedAt),
          subtotal: state.subtotal,
          gst: state.gst,
          total: state.total,
          currency: state.currency,
          quoteVersion: null,
          pdfPath: state.pdfPath,
        }, {
          status: paid ? "paid" : "issued",
          note: "Issued before invoice revisions were recorded: mapped from the stored milestone record.",
          missingTime: `milestone ${index + 1} is ${state.status} but has no issue time`,
        });
        if (current) current.issuedRevision = false;
      }
    } else {
      const number = text(state.invoiceNumber);
      if (!number) {
        failures.push({ kind: "unmappable", code: "draft-no-number", milestone: index, reason: `draft milestone ${index + 1} has no invoice number` });
      } else if (numbers.has(number)) {
        // The draft carries the number of a revision returned to draft: the
        // void row above is that invoice.
        current = numbers.get(number);
        warnings.push({ kind: "draft-is-void-revision", milestone: index, number, reason: "the draft carries the number of a revision returned to draft; its void row stands for it until it is re-issued" });
      } else {
        const moneyResult = claimMoney({ subtotal: state.subtotal, gst: state.gst, total: state.total, taxRate, milestoneKey, ...describe(basis?.version) });
        if (moneyResult.failure) {
          failures.push({ ...moneyResult.failure, milestone: index, number });
        } else {
          current = addInvoice({
            key: number,
            number,
            milestoneKey,
            kind,
            status: "draft",
            revision: state.revisionNumber || 1,
            issuedAt: null,
            issuedOn: null,
            dueOn: dateOnly(state.dueDate),
            currency: text(state.currency) || "AUD",
            ...moneyResult.totals,
            taxTotalSource: moneyResult.taxTotalSource,
            taxTotalReason: moneyResult.taxTotalReason ? moneyResult.taxTotalReason.replace("GST as issued", "GST as Field shows it") : null,
            computedTaxTotal: moneyResult.computedTaxTotal,
            lines: moneyResult.lines,
            quoteVersion: basis?.version || null,
            quoteVersionInferred: false,
            supersedesKey: null,
            supersededAt: null,
            revisionReason: null,
            revisedBy: null,
            reference,
            note: null,
            snapshot: { subtotal: money(state.subtotal), taxTotal: money(state.gst), total: money(state.total) },
            pdfPath: null,
            pdfSha256: null,
            issuedRevision: false,
          });
        }
      }
    }
    if (current && current.status !== "draft") current.dueOn = dateOnly(state.dueDate);

    // Credit notes: each credited revision in full, naming its replacement.
    for (const { invoice, revision, successor, number } of credited) {
      if (!numbers.has(successor.invoiceNumber)) {
        failures.push({ kind: "unmappable", code: "successor-not-issued", milestone: index, number: invoice.number, reason: `${invoice.number} was replaced by ${successor.invoiceNumber}, which is not an issued invoice on this job` });
        continue;
      }
      const note = revision.creditNote || null;
      const issuedAt = iso(note?.issuedAt) || iso(successor.revisedAt) || iso(revision.supersededAt) || iso(successor.issuedAt);
      if (!issuedAt) {
        failures.push({ kind: "unmappable", code: "credited-no-time", milestone: index, number: invoice.number, reason: `${invoice.number} was credited with no time recorded` });
        continue;
      }
      creditNotes.push({
        key: number,
        number,
        invoiceKey: invoice.key,
        replacementKey: successor.invoiceNumber,
        milestoneKey,
        reason: text(note?.reason) || text(successor.revisionReason) || "Credited and reissued",
        createdBy: text(note?.issuedBy) || text(successor.revisedBy),
        issuedAt,
        issuedOn: issuedAt.slice(0, 10),
        currency: invoice.currency,
        subtotal: invoice.subtotal,
        taxTotal: invoice.taxTotal,
        total: invoice.total,
        taxTotalSource: invoice.taxTotalSource,
        taxTotalReason: invoice.taxTotalReason,
        lines: invoice.lines.map((line) => ({ ...line, name: `Credit of ${invoice.number}: ${line.name}` })),
        reference: invoice.reference,
        pdfPath: text(note?.pdfPath),
        pdfSha256: text(note?.pdfSha256),
      });
    }

    // Payments, against the invoice each was recorded against.
    let activeSum = 0n;
    let lastActive = null;
    for (const payment of state.payments || []) {
      const voided = isMilestonePaymentVoided(payment);
      const recordedAgainst = text(payment.sourceInvoiceNumber);
      const invoice = (recordedAgainst && numbers.get(recordedAgainst)) || current;
      if (!invoice) {
        failures.push({ kind: "unmappable", code: "payment-no-invoice", milestone: index, reason: `payment ${payment.id} has no invoice to be recorded against` });
        continue;
      }
      if (!(Number(payment.amount) > 0)) continue;
      const row = {
        key: `${index}:${payment.id}`,
        invoiceKey: invoice.key,
        milestoneKey,
        amount: money(payment.amount),
        paidOn: dateOnly(payment.date) || dateOnly(payment.recordedAt),
        method: text(payment.method),
        reference: text(payment.reference),
        recordedAt: iso(payment.recordedAt),
        voidedAt: voided ? iso(payment.voidedAt) : null,
        voidReason: voided ? text(payment.voidReason) : null,
        voidedBy: voided ? text(payment.voidedBy) : null,
        sourceInvoiceNumber: recordedAgainst,
      };
      if (!row.paidOn || !row.recordedAt) {
        failures.push({ kind: "unmappable", code: "payment-no-date", milestone: index, reason: `payment ${payment.id} has no date` });
        continue;
      }
      payments.push(row);
      if (!voided) {
        activeSum += toCents(row.amount);
        lastActive = row;
        // A credit note moves the payment to the replacement (payment_allocations).
        if (current && invoice !== current && !credited.some((entry) => entry.invoice === invoice)) {
          warnings.push({ kind: "payment-on-superseded", milestone: index, number: invoice.number, reason: `payment ${row.amount} was recorded against ${invoice.number}, which ${current.number} replaced without a credit note; it stays on ${invoice.number}, where it was recorded` });
        }
      }
    }
    for (const invoice of numbers.values()) {
      invoice.amountPaid = centsToText(payments
        .filter((payment) => payment.invoiceKey === invoice.key && !payment.voidedAt)
        .reduce((sum, payment) => sum + toCents(payment.amount), 0n));
    }

    // The receipt: a paid milestone's ER-… document, for the payment that cleared it.
    if ((paid || toCents(money(state.amountDue)) <= 0n) && lastActive && toCents(money(state.amountPaid)) > 0n && current) {
      const issuedAt = iso(lastActive.recordedAt) || iso(state.paidAt);
      if (!text(state.receiptNumber)) failures.push({ kind: "unmappable", code: "no-receipt-number", milestone: index, reason: `paid milestone ${index + 1} has no receipt number` });
      else receipts.push({
        key: lastActive.key,
        paymentKey: lastActive.key,
        invoiceKey: current.key,
        number: text(state.receiptNumber),
        amount: money(state.amountPaid),
        currency: current.currency,
        issuedAt,
        issuedOn: dateOnly(state.paidAt) || lastActive.paidOn,
      });
    }

    // What Field shows for the milestone, to check the rows against.
    const milestone = milestones.at(-1);
    milestone.shown = {
      total: money(state.total),
      amountPaid: money(state.amountPaid),
      activePayments: centsToText(activeSum),
      currentNumber: current?.number || null,
      currentTotal: current?.total || null,
    };
  }

  return { milestones, invoices, creditNotes, payments, receipts, failures, warnings };
}
