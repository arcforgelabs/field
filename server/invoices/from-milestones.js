// Today's milestone state (milestone-invoices/state.json, read through
// job-meta-store.js) as invoice rows (#27). Pure: no I/O, no clock.
//
//   milestone              -> payment_milestones (sort_order = its index)
//   issued revision        -> an issued invoice, its number exactly as issued
//     current                 issued, or paid when the milestone is paid
//     superseded by a          credited (step 4b, #28, adds the credit note
//     revision                 that corrects it)
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
// share of the quote ex GST. (Its PDF also prints the quote's schedule, which
// is the quote's rows.) Totals are as issued and never recomputed: where the
// milestone's GST (its share of the quote's GST) differs from GST worked out
// on its own subtotal, the GST is kept as printed, with the reason.
//
// Returns { milestones, invoices, payments, receipts, failures, warnings }.
// Rows carry local keys (milestoneKey, invoiceKey, paymentKey) that the
// invoice service turns into uids.
import { listInvoiceRevisions } from "../invoice-revisions.js";
import { isMilestoneInvoiceIssued, isMilestonePaymentVoided } from "../job-documents.js";
import { centsToText, fixed, quoteTotals, toCents } from "../quotes/totals.js";

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
 */
export function mapMilestoneState({ meta, basis = null, jobNumber = null }) {
  const milestones = [];
  const invoices = [];
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
      failures.push({ kind: "unmappable", milestone: index, reason: `milestone ${index + 1} has neither a percentage nor a fixed amount` });
      continue;
    }
    milestones.push({
      key: milestoneKey,
      sortOrder: index,
      label,
      percent,
      amount,
      dueDays: positiveInt(scheduleMilestones[index]?.dueDays),
      // Today's schedules are set on the job (or copied from config); none is
      // known to come from account rules, which arrive with step 4c (#29).
      isDefaultSchedule: false,
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
        failures.push({ kind: "unmappable", milestone: index, number: invoice.number, reason: `invoice number ${invoice.number} appears twice on this job` });
        return null;
      }
      seenNumbers.add(invoice.number);
      numbers.set(invoice.number, invoice);
      invoices.push(invoice);
      return invoice;
    };
    const fromRevision = (revision, { status, note }) => {
      const issuedAt = iso(revision.issuedAt) || iso(revision.pdfIssuedAt);
      if (!issuedAt) {
        failures.push({ kind: "unmappable", milestone: index, number: revision.invoiceNumber, reason: `issued revision ${revision.invoiceNumber} has no issue time` });
        return null;
      }
      const moneyResult = claimMoney({ subtotal: revision.subtotal, gst: revision.gst, total: revision.total, taxRate, milestoneKey, ...describe(revision.quoteVersion) });
      if (moneyResult.failure) {
        failures.push({ ...moneyResult.failure, milestone: index, number: revision.invoiceNumber });
        return null;
      }
      return addInvoice({
        key: revision.invoiceNumber,
        number: revision.invoiceNumber,
        milestoneKey,
        kind,
        status,
        revision: revision.revisionNumber,
        issuedAt,
        issuedOn: issuedAt.slice(0, 10),
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
        reference,
        note,
        snapshot: { subtotal: money(revision.subtotal), taxTotal: money(revision.gst), total: money(revision.total) },
        pdfPath: text(revision.pdfPath),
        pdfSha256: text(revision.pdfSha256),
        issuedRevision: true,
      });
    };

    // Revisions no longer current, oldest first.
    for (const revision of revisions.filter((entry) => !entry.current)) {
      const superseded = revision.supersededByRevisionNumber != null;
      const successor = revisions.find((entry) => entry.revisionNumber === revision.supersededByRevisionNumber);
      fromRevision(revision, superseded
        ? { status: "credited", note: `Revised in place: superseded by ${successor?.invoiceNumber || `revision ${revision.supersededByRevisionNumber}`}. Step 4b adds the credit note that corrects it.` }
        : { status: "void", note: "Returned to draft after it was issued (unsent, or marked unpaid). Re-issuing the same content restores this number." });
    }

    const paid = state.status === "paid";
    let current = null;
    if (state.issuedRevision) {
      current = fromRevision(state.issuedRevision, { status: paid ? "paid" : "issued", note: null });
    } else if (isMilestoneInvoiceIssued(state)) {
      // Issued before invoice revisions froze a snapshot: the stored record
      // is what was issued (buildMilestoneInvoices freezes it from the same
      // values on its next rebuild).
      const issuedAt = iso(state.issuedAt);
      const number = text(state.invoiceNumber);
      if (!issuedAt || !number) {
        failures.push({ kind: "unmappable", milestone: index, number, reason: `milestone ${index + 1} is ${state.status} but has no ${issuedAt ? "invoice number" : "issue time"}` });
      } else {
        current = fromRevision({
          invoiceNumber: number,
          revisionNumber: state.revisionNumber || 1,
          issuedAt,
          subtotal: state.subtotal,
          gst: state.gst,
          total: state.total,
          currency: state.currency,
          quoteVersion: null,
          pdfPath: state.pdfPath,
        }, { status: paid ? "paid" : "issued", note: "Issued before invoice revisions were recorded: mapped from the stored milestone record." });
        if (current) current.issuedRevision = false;
      }
    } else {
      const number = text(state.invoiceNumber);
      if (!number) {
        failures.push({ kind: "unmappable", milestone: index, reason: `draft milestone ${index + 1} has no invoice number` });
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

    // Payments, against the invoice each was recorded against.
    let activeSum = 0n;
    let lastActive = null;
    for (const payment of state.payments || []) {
      const voided = isMilestonePaymentVoided(payment);
      const recordedAgainst = text(payment.sourceInvoiceNumber);
      const invoice = (recordedAgainst && numbers.get(recordedAgainst)) || current;
      if (!invoice) {
        failures.push({ kind: "unmappable", milestone: index, reason: `payment ${payment.id} has no invoice to be recorded against` });
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
        failures.push({ kind: "unmappable", milestone: index, reason: `payment ${payment.id} has no date` });
        continue;
      }
      payments.push(row);
      if (!voided) {
        activeSum += toCents(row.amount);
        lastActive = row;
        if (current && invoice !== current) {
          warnings.push({ kind: "payment-on-superseded", milestone: index, number: invoice.number, reason: `payment ${row.amount} was recorded against ${invoice.number}, which ${current.number} replaced; it stays on ${invoice.number} until step 4b's credit note carries it across` });
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
      if (!text(state.receiptNumber)) failures.push({ kind: "unmappable", milestone: index, reason: `paid milestone ${index + 1} has no receipt number` });
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

  return { milestones, invoices, payments, receipts, failures, warnings };
}
