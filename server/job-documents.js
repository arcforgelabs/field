import { randomUUID } from "node:crypto";
import {
  getCustomerPresentationFinancials,
  getCustomerScheduleItems,
} from "./quote-presentation.js";
import { normalizePipelineStage } from "./pipeline.js";
import {
  buildInvoiceRevisionNumber,
  findInvoiceRevision,
  listInvoiceRevisions,
  normalizeActorLabel,
  normalizeInvoiceRevision,
  normalizeInvoiceRevisionHistory,
  normalizeRevisionNumber,
  resolveMilestoneRevisionState,
  stripInvoiceRevisionSuffix,
} from "./invoice-revisions.js";
import { ARTIFACT_STATE } from "./invoice-artifact-state.js";
import { isSequenceInvoiceNumber } from "./invoices/numbers.js";

export const JOB_DOCUMENT_TYPES = ["quote", "invoice", "receipt"];
export const MILESTONE_INVOICE_STATUSES = ["draft", "authorised", "paid"];
export const MILESTONE_INVOICE_DIR = "milestone-invoices";
export const MILESTONE_RECEIPT_DIR = "milestone-receipts";

export const DEFAULT_PAYMENT_SCHEDULE = Object.freeze({
  milestones: [
    { label: "Deposit", percentage: 10 },
    { label: "Progress payment", percentage: 30 },
    { label: "Final payment", percentage: 60 },
  ],
});

export const SINGLE_PAYMENT_SCHEDULE = Object.freeze({
  milestones: [
    { label: "Full payment", percentage: 100 },
  ],
});

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function fromCents(value) {
  return roundMoney(Number(value || 0) / 100);
}

function cleanText(value) {
  const trimmed = String(value || "").trim();
  return trimmed || null;
}

function createError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeIsoTimestamp(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeDateOnly(value) {
  if (value == null || value === "") return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function assertDateOnly(value, fieldName = "date") {
  if (value == null || value === "") return null;
  const normalized = normalizeDateOnly(value);
  if (!normalized) {
    throw createError(`${fieldName} must be a valid ISO date`, 400);
  }
  return normalized;
}

function dateOnlyToIsoTimestamp(value) {
  const normalized = normalizeDateOnly(value);
  return normalized ? `${normalized}T00:00:00.000Z` : null;
}

function addDays(dateOnly, days) {
  const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

function allocateCents(totalAmount, weights = []) {
  if (!Array.isArray(weights) || !weights.length) return [];

  const totalCents = toCents(totalAmount);
  const normalizedWeights = weights.map((value) => Math.max(Number(value || 0), 0));
  const totalWeight = normalizedWeights.reduce((sum, value) => sum + value, 0);

  if (totalCents === 0) {
    return normalizedWeights.map(() => 0);
  }
  if (totalWeight <= 0) {
    const zeroes = normalizedWeights.map(() => 0);
    zeroes[zeroes.length - 1] = totalCents;
    return zeroes;
  }

  const raw = normalizedWeights.map((weight) => (totalCents * weight) / totalWeight);
  const cents = raw.map((value) => Math.floor(value));
  let remainder = totalCents - cents.reduce((sum, value) => sum + value, 0);

  const byRemainder = raw
    .map((value, index) => ({
      index,
      remainder: value - cents[index],
      weight: normalizedWeights[index],
    }))
    .sort((a, b) => (
      b.remainder - a.remainder
      || b.weight - a.weight
      || a.index - b.index
    ));

  for (let i = 0; i < byRemainder.length && remainder > 0; i += 1) {
    cents[byRemainder[i].index] += 1;
    remainder -= 1;
  }

  return cents;
}

function buildPercentAllocations(totalAmount, percentages = []) {
  return allocateCents(totalAmount, percentages).map(fromCents);
}

// Fixed-claim milestones take exactly their contracted amount; whatever
// remains is shared by the percentage milestones. This is the one place
// that understands how to mix cents-denominated fixed claims with
// percentage weights — callers must never blend the two into one weight
// array themselves (that silently misallocates money).
//
// `allowShortfall` governs what happens when the fixed claims exceed
// `totalAmount`: the strict (default) caller gets a 400, because that is a
// genuine input error when building a schedule from scratch. A rebuild that
// is re-spreading an already-reduced remainder around frozen invoices must
// not throw — it runs on read-ish paths — so it instead splits whatever is
// left across the fixed claims proportionally and leaves any percentage
// milestones at zero, keeping the shortfall visible rather than inventing
// money that is not there.
function allocateFixedThenVariableTotals(totalAmount, milestones = [], { allowShortfall = false } = {}) {
  const totalCents = toCents(totalAmount);
  const fixedCents = milestones.map((milestone) => (
    Number.isFinite(Number(milestone?.fixedTotal)) && Number(milestone.fixedTotal) > 0
      ? toCents(milestone.fixedTotal)
      : null
  ));
  const fixedSum = fixedCents.reduce((sum, value) => sum + (value || 0), 0);

  if (fixedSum > totalCents) {
    if (!allowShortfall) {
      throw createError("fixed milestone amounts cannot exceed the quote total", 400);
    }
    const fixedIndexes = fixedCents
      .map((value, index) => (value != null ? index : null))
      .filter((index) => index != null);
    const distributed = allocateCents(totalAmount, fixedIndexes.map((index) => fixedCents[index]));
    const allocations = milestones.map(() => 0);
    fixedIndexes.forEach((index, position) => {
      allocations[index] = distributed[position];
    });
    return allocations.map(fromCents);
  }

  const variableIndexes = fixedCents
    .map((value, index) => (value == null ? index : null))
    .filter((index) => index != null);
  const allocations = fixedCents.map((value) => value || 0);
  const remainingCents = totalCents - fixedSum;

  if (variableIndexes.length) {
    const variableWeights = variableIndexes.map((index) => milestones[index]?.percentage || 0);
    const variableAllocations = allocateCents(fromCents(remainingCents), variableWeights);
    variableIndexes.forEach((index, allocationIndex) => {
      allocations[index] = variableAllocations[allocationIndex] || 0;
    });
  } else if (fixedSum !== totalCents) {
    allocations[allocations.length - 1] += totalCents - fixedSum;
  }

  return allocations.map(fromCents);
}

function buildFixedTotalAllocations(totalAmount, milestones = [], { allowShortfall = false } = {}) {
  return allocateFixedThenVariableTotals(totalAmount, milestones, { allowShortfall });
}

// `buildMilestoneInvoices` is the sole caller of this function and it is
// always a rebuild — never the place schedules are authored (see the
// `allowShortfall` note above `allocateFixedThenVariableTotals`) — so it
// always allows a shortfall rather than throwing on read-ish paths like
// record payment, void payment, mark unsent/unpaid, update milestone, send
// and revise. A future authoring-time validator (schedule
// creation, `assertMilestoneScheduleMutationAllowed`) should call
// `buildFixedTotalAllocations` / `allocateFixedThenVariableTotals` with the
// strict default instead.
function buildMilestoneTotalAllocations(totalAmount, milestones = [], { allowShortfall = false } = {}) {
  const hasFixedTotals = milestones.some((milestone) => (
    Number.isFinite(Number(milestone?.fixedTotal)) && Number(milestone.fixedTotal) > 0
  ));
  if (hasFixedTotals) return buildFixedTotalAllocations(totalAmount, milestones, { allowShortfall });
  return buildPercentAllocations(
    totalAmount,
    milestones.map((milestone) => milestone.percentage)
  );
}

function normalizeMilestoneLabel(label, index) {
  return cleanText(label) || `Milestone ${index + 1}`;
}

function hasLegacySingleInvoiceState(meta = null) {
  return !hasMilestoneInvoices(meta)
    && Boolean(meta?.invoiceSentAt || coerceInvoicePaidAmount(meta?.invoicePaidAmount) > 0);
}

function resolvePaymentScheduleCandidate({
  meta = null,
  quote = null,
  paymentSchedule = null,
  config = null,
} = {}) {
  if (paymentSchedule) return paymentSchedule;
  if (meta?.paymentSchedule) return meta.paymentSchedule;
  if (quote?.quoteCatalog?.businessProfile?.paymentSchedule) {
    return quote.quoteCatalog.businessProfile.paymentSchedule;
  }
  if (config?.paymentSchedule) return config.paymentSchedule;
  if (hasLegacySingleInvoiceState(meta)) return SINGLE_PAYMENT_SCHEDULE;
  return DEFAULT_PAYMENT_SCHEDULE;
}

function normalizePaymentScheduleInput(schedule) {
  if (Array.isArray(schedule)) {
    return { milestones: schedule };
  }
  return schedule;
}

function normalizeMilestoneLineItems(lineItems = []) {
  return (Array.isArray(lineItems) ? lineItems : [])
    .map((item, index) => {
      const description = cleanText(item?.description || item?.label) || `Line item ${index + 1}`;
      const quantity = Number.isFinite(Number(item?.quantity)) && Number(item.quantity) > 0
        ? Number(item.quantity)
        : 1;
      const totalPrice = roundMoney(item?.totalPrice ?? item?.total ?? 0);
      const unitPrice = roundMoney(
        item?.unitPrice != null
          ? item.unitPrice
          : (quantity > 0 ? totalPrice / quantity : totalPrice)
      );
      return {
        description,
        quantity,
        unit: cleanText(item?.unit) || "lot",
        unitPrice,
        totalPrice,
        accountCode: cleanText(item?.accountCode) || null,
        sourceCode: cleanText(item?.sourceCode || item?.code) || null,
      };
    })
    .filter(Boolean);
}

function normalizeMilestonePayments(payments = []) {
  return (Array.isArray(payments) ? payments : [])
    .map((payment, index) => {
      const amount = roundMoney(payment?.amount);
      if (!(amount > 0)) return null;
      const voidedAt = normalizeIsoTimestamp(payment?.voidedAt);
      const sourceQuoteVersion = Number.isFinite(Number(payment?.sourceQuoteVersion)) && Number(payment.sourceQuoteVersion) > 0
        ? Number(payment.sourceQuoteVersion)
        : null;
      const sourceRevisionNumber = Number.isFinite(Number(payment?.sourceRevisionNumber)) && Number(payment.sourceRevisionNumber) > 0
        ? Number(payment.sourceRevisionNumber)
        : null;
      return {
        id: cleanText(payment?.id) || `payment-${index + 1}`,
        date: normalizeDateOnly(payment?.date || payment?.recordedAt) || new Date().toISOString().slice(0, 10),
        amount,
        reference: cleanText(payment?.reference) || null,
        method: cleanText(payment?.method) || null,
        recordedAt: normalizeIsoTimestamp(payment?.recordedAt) || new Date().toISOString(),
        ...(sourceQuoteVersion ? { sourceQuoteVersion } : {}),
        ...(cleanText(payment?.sourceInvoiceNumber) ? { sourceInvoiceNumber: cleanText(payment.sourceInvoiceNumber) } : {}),
        ...(sourceRevisionNumber ? { sourceRevisionNumber } : {}),
        ...(cleanText(payment?.migrationId) ? { migrationId: cleanText(payment.migrationId) } : {}),
        ...(cleanText(payment?.note) ? { note: cleanText(payment.note) } : {}),
        ...(voidedAt ? { voidedAt } : {}),
        ...(cleanText(payment?.voidReason || payment?.voidedReason) ? { voidReason: cleanText(payment.voidReason || payment.voidedReason) } : {}),
        ...(cleanText(payment?.voidedBy) ? { voidedBy: cleanText(payment.voidedBy) } : {}),
      };
    })
    .filter(Boolean);
}

export function isMilestonePaymentVoided(payment = null) {
  return Boolean(normalizeIsoTimestamp(payment?.voidedAt));
}

export function sumActiveMilestonePayments(payments = []) {
  return roundMoney(
    normalizeMilestonePayments(payments)
      .filter((payment) => !isMilestonePaymentVoided(payment))
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  );
}

function deriveMilestoneStatus({
  requestedStatus = null,
  total = 0,
  amountPaid = 0,
  amountDue = 0,
  issuedAt = null,
}) {
  // A zero total with nothing actually paid is not a paid invoice — it is
  // an open milestone that currently has no claim (e.g. a quote reduced
  // below what earlier milestones already invoice). Requiring a positive
  // total or a recorded payment keeps a rebuild from fabricating a "paid"
  // $0 money document out of thin air.
  if (roundMoney(amountDue) <= 0 && (roundMoney(total) > 0 || roundMoney(amountPaid) > 0)) {
    return "paid";
  }
  // A stored "paid" status at zero total (e.g. a fully-carried migrated
  // milestone) is data that already existed, not something this rebuild is
  // inventing — honour it. The fabrication guard above still binds when
  // there is no stored paid status to honour: only an explicit stored
  // `requestedStatus === "paid"` reaches this branch, never a status
  // derived from amounts alone.
  if (requestedStatus === "paid" && roundMoney(amountDue) <= 0) {
    return "paid";
  }
  if (requestedStatus === "paid") {
    return "authorised";
  }
  if (
    requestedStatus === "authorised"
    || roundMoney(amountPaid) > 0
    || issuedAt
  ) {
    return "authorised";
  }
  return "draft";
}

function buildMilestoneSourceItems(quote = null) {
  const renderedItems = Array.isArray(getCustomerScheduleItems(quote))
    ? getCustomerScheduleItems(quote)
    : [];
  const sourceItems = renderedItems.filter((item) => (
    (item?.kind === "source" || !item?.kind)
    && item?.excludedFromPrice !== true
  ));
  if (sourceItems.length) return sourceItems;

  return [{
    code: "summary",
    label: cleanText(quote?.summary) || cleanText(quote?.title) || "Quoted works",
    quantity: 1,
    unit: "lot",
    unitPrice: roundMoney(quote?.totals?.subtotal || quote?.totals?.total || 0),
    totalPrice: roundMoney(quote?.totals?.subtotal || quote?.totals?.total || 0),
    amountVisible: true,
  }];
}

function buildMilestoneReference({ meta = null, quote = null } = {}) {
  return cleanText(quote?.quoteNumber)
    || cleanText(meta?.quoteNumber)
    || cleanText(meta?.jobNumber)
    || cleanText(meta?.id)
    || "job";
}

function buildMilestoneQuoteId({ meta = null, quote = null } = {}) {
  return cleanText(quote?.identity?.quoteThreadUid)
    || cleanText(quote?.quoteNumber)
    || cleanText(meta?.quoteNumber)
    || cleanText(meta?.id)
    || null;
}

function buildInvoiceReferenceCandidate({
  meta = null,
  quote = null,
  milestoneInvoice = null,
} = {}) {
  return cleanText(milestoneInvoice?.reference)
    || cleanText(quote?.quoteNumber)
    || cleanText(meta?.quoteNumber)
    || cleanText(meta?.reference)
    || cleanText(meta?.jobNumber)
    || cleanText(meta?.id)
    || "invoice";
}

function normalizeInvoiceReferencePrefix(reference = null) {
  const cleaned = cleanText(reference) || "invoice";
  if (/^EI-/i.test(cleaned)) return cleaned;
  if (/^[A-Za-z]{1,8}(?=-)/.test(cleaned)) {
    return cleaned.replace(/^[A-Za-z]{1,8}(?=-)/, "EI");
  }
  return `EI-${cleaned}`;
}

function normalizeReceiptReferencePrefix(reference = null) {
  const cleaned = cleanText(reference) || "receipt";
  if (/^ER-/i.test(cleaned)) return cleaned;
  if (/^EI-/i.test(cleaned)) return cleaned.replace(/^EI-/i, "ER-");
  if (/^[A-Za-z]{1,8}(?=-)/.test(cleaned)) {
    return cleaned.replace(/^[A-Za-z]{1,8}(?=-)/, "ER");
  }
  return `ER-${cleaned}`;
}

function buildInvoiceBaseNumber({
  meta = null,
  quote = null,
  milestoneInvoice = null,
} = {}) {
  return normalizeInvoiceReferencePrefix(buildInvoiceReferenceCandidate({
    meta,
    quote,
    milestoneInvoice,
  }));
}

function buildReceiptBaseNumber({
  meta = null,
  quote = null,
  milestoneInvoice = null,
} = {}) {
  return normalizeReceiptReferencePrefix(buildInvoiceReferenceCandidate({
    meta,
    quote,
    milestoneInvoice,
  }));
}

export function buildInvoiceDocumentNumber({
  meta = null,
  quote = null,
  milestoneInvoice = null,
} = {}) {
  const explicit = cleanText(milestoneInvoice?.invoiceNumber);
  if (explicit) return explicit;

  const base = buildInvoiceBaseNumber({
    meta,
    quote,
    milestoneInvoice,
  });
  const milestoneIndex = Number.isFinite(Number(milestoneInvoice?.milestoneIndex))
    ? Number(milestoneInvoice.milestoneIndex)
    : null;
  if (milestoneIndex == null || milestoneIndex < 0) return base;
  return `${base}-M${milestoneIndex + 1}`;
}

export function buildReceiptDocumentNumber({
  meta = null,
  quote = null,
  milestoneInvoice = null,
} = {}) {
  const explicit = cleanText(milestoneInvoice?.receiptNumber);
  if (explicit) return explicit;

  const base = buildReceiptBaseNumber({
    meta,
    quote,
    milestoneInvoice,
  });
  const milestoneIndex = Number.isFinite(Number(milestoneInvoice?.milestoneIndex))
    ? Number(milestoneInvoice.milestoneIndex)
    : null;
  if (milestoneIndex == null || milestoneIndex < 0) return base;
  return `${base}-M${milestoneIndex + 1}`;
}

function maybeSeedLegacyMilestonePayments({
  meta = null,
  existingMilestone = null,
  milestoneIndex = 0,
  milestoneTotal = 0,
  milestoneCount = 1,
}) {
  if (existingMilestone?.payments?.length) {
    return normalizeMilestonePayments(existingMilestone.payments);
  }
  if (!hasLegacySingleInvoiceState(meta) || milestoneIndex !== 0 || milestoneCount !== 1) {
    return [];
  }

  const desiredPaid = Math.min(milestoneTotal, coerceInvoicePaidAmount(meta?.invoicePaidAmount));
  if (!(desiredPaid > 0)) return [];

  const issuedAt = normalizeIsoTimestamp(meta?.invoiceSentAt || meta?.landedAt) || new Date().toISOString();
  return [{
    id: randomUUID(),
    date: normalizeDateOnly(meta?.invoiceSentAt || meta?.landedAt) || issuedAt.slice(0, 10),
    amount: desiredPaid,
    reference: null,
    method: null,
    recordedAt: issuedAt,
  }];
}

function findMilestonePosition(milestoneInvoices, milestoneIndex) {
  const parsed = Number.parseInt(String(milestoneIndex ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createError("valid milestone index required", 400);
  }
  const position = milestoneInvoices.findIndex((invoice) => invoice.milestoneIndex === parsed);
  if (position === -1) {
    throw createError("milestone invoice not found", 404);
  }
  return position;
}

function replaceMilestoneInvoice(milestoneInvoices, nextMilestoneInvoice) {
  return milestoneInvoices.map((invoice) => (
    invoice.milestoneIndex === nextMilestoneInvoice.milestoneIndex
      ? nextMilestoneInvoice
      : invoice
  ));
}

function validateMilestoneStatusTransition({
  currentStatus,
  requestedStatus,
  amountDue,
}) {
  if (!MILESTONE_INVOICE_STATUSES.includes(requestedStatus)) {
    throw createError("valid milestone status required", 400);
  }
  if (requestedStatus === currentStatus) return;

  if (currentStatus === "draft" && requestedStatus !== "authorised") {
    throw createError("milestone invoices must move from draft to authorised before payment", 409);
  }
  if (currentStatus === "authorised" && requestedStatus !== "paid") {
    throw createError("milestone invoices cannot move backwards once authorised", 409);
  }
  if (currentStatus === "paid" && requestedStatus !== "paid") {
    throw createError("paid milestone invoices cannot move backwards", 409);
  }
  if (requestedStatus === "paid" && roundMoney(amountDue) > 0) {
    throw createError("milestone invoice cannot be marked paid until the balance is cleared", 409);
  }
}

export function coerceInvoicePaidAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return roundMoney(numeric);
}

export function resolveJobDocumentType({
  meta = null,
  documentType = null,
} = {}) {
  const normalizedDocumentType = String(documentType || "").trim().toLowerCase();
  if (JOB_DOCUMENT_TYPES.includes(normalizedDocumentType)) {
    return normalizedDocumentType;
  }
  const pipelineStage = normalizePipelineStage(meta?.pipelineStage || meta?.deliveryStatus);
  return pipelineStage === "landed" ? "invoice" : "quote";
}

export function getJobDocumentLabel(documentType) {
  const resolvedDocumentType = resolveJobDocumentType({ documentType });
  if (resolvedDocumentType === "invoice") return "Invoice";
  if (resolvedDocumentType === "receipt") return "Receipt";
  return "Quote";
}

export function getJobDocumentLabelLower(documentType) {
  return getJobDocumentLabel(documentType).toLowerCase();
}

export function validateInvoicePaidAmount({
  quote = null,
  invoicePaidAmount = null,
} = {}) {
  if (invoicePaidAmount == null || invoicePaidAmount === "") return 0;
  const numeric = Number(invoicePaidAmount);
  if (!Number.isFinite(numeric)) {
    throw createError("invoice paid amount must be a valid number", 400);
  }
  if (numeric < 0) {
    throw createError("invoice paid amount cannot be negative", 400);
  }
  const paid = roundMoney(numeric);
  const total = roundMoney(quote?.totals?.total || 0);
  if (paid > total) {
    throw createError("invoice paid amount cannot exceed the invoice total", 400);
  }
  return paid;
}

export function normalizePaymentSchedule(schedule, { allowNull = false } = {}) {
  const normalizedInput = normalizePaymentScheduleInput(schedule);
  if (!normalizedInput) {
    if (allowNull) return null;
    throw createError("payment schedule is required", 400);
  }

  if (!Array.isArray(normalizedInput.milestones) || !normalizedInput.milestones.length) {
    throw createError("payment schedule must include at least one milestone", 400);
  }

  const milestones = normalizedInput.milestones.map((milestone, index) => {
    const percentage = roundMoney(milestone?.percentage);
    const fixedTotal = roundMoney(milestone?.fixedTotal ?? milestone?.amount ?? milestone?.total);
    const hasFixedTotal = Number.isFinite(Number(fixedTotal)) && fixedTotal > 0;
    if (!(percentage > 0) && !hasFixedTotal) {
      throw createError(`milestone ${index + 1} must have a percentage or fixed amount greater than zero`, 400);
    }
    const dueDays = Number.isFinite(Number(milestone?.dueDays)) && Number(milestone.dueDays) > 0
      ? Math.round(Number(milestone.dueDays))
      : null;
    return {
      label: normalizeMilestoneLabel(milestone?.label, index),
      percentage: percentage > 0 ? percentage : 0,
      ...(hasFixedTotal ? { fixedTotal } : {}),
      ...(dueDays ? { dueDays } : {}),
    };
  });

  const hasFixedTotals = milestones.some((milestone) => Number(milestone.fixedTotal || 0) > 0);
  const percentageTotal = roundMoney(milestones.reduce((sum, milestone) => sum + Number(milestone.percentage || 0), 0));
  if (!hasFixedTotals && percentageTotal !== 100) {
    throw createError("payment schedule percentages must sum to exactly 100", 400);
  }
  if (hasFixedTotals && percentageTotal > 100) {
    throw createError("payment schedule percentages cannot exceed 100 when fixed milestone amounts are used", 400);
  }

  return { milestones };
}

// Authoring-time guard: `buildMilestoneInvoices` is always a
// rebuild (see the `allowShortfall` note above `allocateFixedThenVariableTotals`)
// and now always allows a shortfall rather than throwing, because a rebuild
// is never the place to validate operator input. That left NO seam that
// actually rejects a payment schedule whose fixed dollar amounts already
// exceed the quote total — the strict allocator throw became dead outside
// tests, and `generateJobMilestones` / `updateJobQuote`'s schedule-patch
// path would silently pro-rate the operator's typed amounts and zero the
// percentage milestones instead. Call this where `paymentSchedule` arrives
// as operator INPUT, before it is ever persisted.
export function assertMilestoneScheduleWithinQuoteTotal({
  paymentSchedule = null,
  quoteTotal = 0,
} = {}) {
  const milestones = Array.isArray(paymentSchedule?.milestones) ? paymentSchedule.milestones : [];
  const fixedSum = roundMoney(
    milestones.reduce((sum, milestone) => (
      Number(milestone?.fixedTotal) > 0 ? sum + Number(milestone.fixedTotal) : sum
    ), 0)
  );
  const total = roundMoney(quoteTotal);
  if (fixedSum > total) {
    throw createError(
      `fixed milestone amounts (${fixedSum}) cannot exceed the quote total (${total})`,
      400,
    );
  }
}

export function resolvePaymentSchedule({
  meta = null,
  quote = null,
  paymentSchedule = null,
  config = null,
} = {}) {
  return normalizePaymentSchedule(resolvePaymentScheduleCandidate({
    meta,
    quote,
    paymentSchedule,
    config,
  }));
}

export function buildMilestoneInvoiceNumber({
  meta = null,
  quote = null,
  milestoneIndex = 0,
  milestoneInvoice = null,
} = {}) {
  const base = buildInvoiceBaseNumber({
    meta,
    quote,
    milestoneInvoice,
  });
  return `${base}-M${Number(milestoneIndex) + 1}`;
}

export function buildMilestoneReceiptNumber({
  meta = null,
  quote = null,
  milestoneIndex = 0,
  milestoneInvoice = null,
} = {}) {
  const base = buildReceiptBaseNumber({
    meta,
    quote,
    milestoneInvoice,
  });
  return `${base}-M${Number(milestoneIndex) + 1}`;
}

function buildLegacyMilestoneInvoiceNumber({
  meta = null,
  quote = null,
  milestoneIndex = 0,
  milestoneInvoice = null,
} = {}) {
  const base = buildInvoiceReferenceCandidate({
    meta,
    quote,
    milestoneInvoice,
  });
  return `${base}-M${Number(milestoneIndex) + 1}`;
}

export function isMilestoneInvoiceIssued(milestoneInvoice = null) {
  const status = cleanText(milestoneInvoice?.status)?.toLowerCase() || "";
  return status === "authorised"
    || status === "paid"
    || Boolean(normalizeIsoTimestamp(milestoneInvoice?.issuedAt));
}

function normalizeQuoteVersionNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

// Approved changes arrive as an explicit authorization per milestone index.
// Anything without one leaves issued invoices frozen.
export function normalizeRevisionAuthorizations(authorizations = null) {
  const entries = Array.isArray(authorizations)
    ? authorizations
    : (authorizations instanceof Map ? [...authorizations.entries()].map(([milestoneIndex, value]) => ({ milestoneIndex, ...(value || {}) })) : []);
  const byIndex = new Map();
  for (const entry of entries) {
    const milestoneIndex = Number.parseInt(String(entry?.milestoneIndex ?? ""), 10);
    if (!Number.isFinite(milestoneIndex) || milestoneIndex < 0) continue;
    const reason = cleanText(entry?.reason);
    if (!reason) {
      throw createError("an invoice revision requires a reason", 400);
    }
    byIndex.set(milestoneIndex, {
      milestoneIndex,
      reason,
      actor: normalizeActorLabel(entry?.actor),
      at: normalizeIsoTimestamp(entry?.at) || new Date().toISOString(),
    });
  }
  return byIndex;
}

function isMilestoneInvoiceIdentityLocked(milestoneInvoice = null) {
  const status = cleanText(milestoneInvoice?.status)?.toLowerCase() || "";
  if (status === "authorised" || status === "paid") return true;
  if (normalizeIsoTimestamp(milestoneInvoice?.issuedAt) || normalizeDateOnly(milestoneInvoice?.paidAt)) return true;
  if (normalizeMilestonePayments(milestoneInvoice?.payments || []).length) return true;
  return roundMoney(milestoneInvoice?.amountPaid || 0) > 0;
}

function resolveMilestoneInvoiceNumber({
  milestoneInvoice = null,
  meta = null,
  quote = null,
  milestoneIndex = 0,
} = {}) {
  const existing = cleanText(milestoneInvoice?.invoiceNumber);
  const next = buildMilestoneInvoiceNumber({
    meta,
    quote,
    milestoneIndex,
    milestoneInvoice,
  });
  if (!existing) return next;
  if (isMilestoneInvoiceIdentityLocked(milestoneInvoice)) return existing;

  const legacy = buildLegacyMilestoneInvoiceNumber({
    meta,
    quote,
    milestoneIndex,
    milestoneInvoice,
  });
  return existing === legacy ? next : existing;
}

// The base a milestone's provisional numbers are built from. A draft, or a
// revision about to be issued, carries a provisional number (EI-…-M<n>, with
// -R<k> for a later revision) until the issue service gives it its number
// from the sequence (server/invoices/issue.js). Once a milestone has been
// issued with an INV-… number, that number is the issued document's and never
// a base: a draft after an unsend, or the next revision, goes back to the
// provisional EI-…-M<n>.
function provisionalInvoiceBaseNumber({
  invoiceNumber = null,
  meta = null,
  quote = null,
  milestoneIndex = 0,
  milestoneInvoice = null,
} = {}) {
  if (!isSequenceInvoiceNumber(stripInvoiceRevisionSuffix(invoiceNumber))) {
    return stripInvoiceRevisionSuffix(invoiceNumber);
  }
  return buildMilestoneInvoiceNumber({
    meta,
    quote,
    milestoneIndex,
    milestoneInvoice: { ...(milestoneInvoice || {}), invoiceNumber: null },
  });
}

export function buildMilestoneInvoicePdfPath(milestoneInvoice = null) {
  const fallback = `milestone-${Number(milestoneInvoice?.milestoneIndex || 0) + 1}`;
  const safeInvoiceNumber = String(milestoneInvoice?.invoiceNumber || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
  return `${MILESTONE_INVOICE_DIR}/${safeInvoiceNumber}.pdf`;
}

export function buildMilestoneReceiptPdfPath(milestoneInvoice = null) {
  const fallback = `receipt-${Number(milestoneInvoice?.milestoneIndex || 0) + 1}`;
  const safeReceiptNumber = String(milestoneInvoice?.receiptNumber || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
  return `${MILESTONE_RECEIPT_DIR}/${safeReceiptNumber}.pdf`;
}

export function normalizeStoredMilestoneInvoices(milestoneInvoices = []) {
  return (Array.isArray(milestoneInvoices) ? milestoneInvoices : [])
    .map((milestoneInvoice, index) => {
      const milestoneIndex = Number.isFinite(Number(milestoneInvoice?.milestoneIndex))
        ? Number(milestoneInvoice.milestoneIndex)
        : index;
      const issuedRevision = normalizeInvoiceRevision(milestoneInvoice?.issuedRevision);
      const revisionHistory = normalizeInvoiceRevisionHistory(milestoneInvoice?.revisionHistory);
      const invoiceNumber = issuedRevision?.invoiceNumber || resolveMilestoneInvoiceNumber({
        milestoneInvoice,
        meta: milestoneInvoice,
        milestoneIndex,
      });
      const revisionNumber = issuedRevision?.revisionNumber
        || normalizeRevisionNumber(milestoneInvoice?.revisionNumber, 1);
      // A receipt follows the milestone, not the invoice revision, so it keeps
      // the un-suffixed reference.
      const receiptNumber = cleanText(milestoneInvoice?.receiptNumber) || buildReceiptDocumentNumber({
        meta: milestoneInvoice,
        milestoneInvoice: {
          ...milestoneInvoice,
          invoiceNumber: stripInvoiceRevisionSuffix(invoiceNumber),
          milestoneIndex,
        },
      });
      // An issued revision is the frozen money document: its financial content
      // is authoritative over whatever the live record happens to carry.
      const lineItems = issuedRevision
        ? normalizeMilestoneLineItems(issuedRevision.lineItems)
        : normalizeMilestoneLineItems(milestoneInvoice?.lineItems || []);
      const subtotal = issuedRevision ? issuedRevision.subtotal : roundMoney(
        milestoneInvoice?.subtotal != null
          ? milestoneInvoice.subtotal
          : lineItems.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0)
      );
      const total = issuedRevision
        ? issuedRevision.total
        : roundMoney(milestoneInvoice?.total ?? subtotal);
      const gst = issuedRevision ? issuedRevision.gst : roundMoney(
        milestoneInvoice?.gst != null
          ? milestoneInvoice.gst
          : Math.max(total - subtotal, 0)
      );
      const payments = normalizeMilestonePayments(milestoneInvoice?.payments || []);
      const paidFromPayments = sumActiveMilestonePayments(payments);
      const amountPaid = Math.min(
        total,
        roundMoney(payments.length ? paidFromPayments : (milestoneInvoice?.amountPaid != null ? milestoneInvoice.amountPaid : 0))
      );
      const amountDue = roundMoney(Math.max(total - amountPaid, 0));
      const issuedAt = normalizeIsoTimestamp(milestoneInvoice?.issuedAt);
      const status = deriveMilestoneStatus({
        requestedStatus: cleanText(milestoneInvoice?.status) || null,
        total,
        amountPaid,
        amountDue,
        issuedAt,
      });
      return {
        id: cleanText(milestoneInvoice?.id) || `milestone-${milestoneIndex + 1}`,
        jobId: cleanText(milestoneInvoice?.jobId) || null,
        quoteId: cleanText(milestoneInvoice?.quoteId) || null,
        milestoneIndex,
        milestoneLabel: normalizeMilestoneLabel(milestoneInvoice?.milestoneLabel, milestoneIndex),
        invoiceNumber,
        revisionNumber,
        issuedRevision,
        revisionHistory,
        receiptNumber,
        reference: cleanText(milestoneInvoice?.reference) || null,
        percentage: roundMoney(milestoneInvoice?.percentage),
        ...(Number(milestoneInvoice?.fixedTotal || 0) > 0 ? { fixedTotal: roundMoney(milestoneInvoice.fixedTotal) } : {}),
        subtotal,
        gst,
        total,
        currency: issuedRevision
          ? issuedRevision.currency
          : (cleanText(milestoneInvoice?.currency) || "AUD"),
        amountPaid,
        amountDue,
        lineItems,
        dueDate: normalizeDateOnly(milestoneInvoice?.dueDate),
        issuedAt,
        paidAt: amountDue <= 0
          ? (normalizeDateOnly(milestoneInvoice?.paidAt) || payments[payments.length - 1]?.date || normalizeDateOnly(issuedAt))
          : null,
        status,
        payments,
        // The PDF path always follows the current invoice number so a new
        // revision can never land on a superseded revision's stored file.
        pdfPath: issuedRevision?.pdfPath || buildMilestoneInvoicePdfPath({
          ...milestoneInvoice,
          invoiceNumber,
          milestoneIndex,
        }),
        receiptPdfPath: cleanText(milestoneInvoice?.receiptPdfPath) || buildMilestoneReceiptPdfPath({
          ...milestoneInvoice,
          receiptNumber,
          milestoneIndex,
        }),
      };
    })
    .sort((a, b) => a.milestoneIndex - b.milestoneIndex);
}

export function hasMilestoneInvoices(meta = null) {
  return normalizeStoredMilestoneInvoices(meta?.milestoneInvoices || []).length > 0;
}

export function findMilestoneInvoice(milestoneInvoices = [], milestoneIndex = null) {
  const normalized = normalizeStoredMilestoneInvoices(milestoneInvoices);
  const position = findMilestonePosition(normalized, milestoneIndex);
  return normalized[position];
}

export function findNextOpenMilestoneInvoice(milestoneInvoices = []) {
  const normalized = normalizeStoredMilestoneInvoices(milestoneInvoices);
  return normalized.find((invoice) => invoice.status !== "paid" && invoice.amountDue > 0)
    || normalized[0]
    || null;
}

export function findLatestPaidMilestoneInvoice(milestoneInvoices = []) {
  const normalized = normalizeStoredMilestoneInvoices(milestoneInvoices);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const invoice = normalized[index];
    if (invoice?.status === "paid" || roundMoney(invoice?.amountDue) <= 0) {
      return invoice;
    }
  }
  return null;
}

export function resolveRequestedMilestoneInvoice({
  meta = null,
  milestoneIndex = null,
} = {}) {
  const milestoneInvoices = normalizeStoredMilestoneInvoices(meta?.milestoneInvoices || []);
  if (!milestoneInvoices.length) return null;
  if (milestoneIndex == null || milestoneIndex === "") {
    return findNextOpenMilestoneInvoice(milestoneInvoices);
  }
  return findMilestoneInvoice(milestoneInvoices, milestoneIndex);
}

export function resolveRequestedReceiptMilestoneInvoice({
  meta = null,
  milestoneIndex = null,
} = {}) {
  const milestoneInvoices = normalizeStoredMilestoneInvoices(meta?.milestoneInvoices || []);
  if (!milestoneInvoices.length) return null;

  if (milestoneIndex == null || milestoneIndex === "") {
    return findLatestPaidMilestoneInvoice(milestoneInvoices);
  }

  const milestoneInvoice = findMilestoneInvoice(milestoneInvoices, milestoneIndex);
  if (milestoneInvoice.status !== "paid" && roundMoney(milestoneInvoice.amountDue) > 0) {
    throw createError("milestone receipt is only available for paid milestones", 409);
  }
  return milestoneInvoice;
}

export function buildMilestoneContextNote(milestoneInvoice = null, milestoneCount = null) {
  if (!milestoneInvoice) return null;
  const count = Number.isFinite(Number(milestoneCount)) && Number(milestoneCount) > 0
    ? Number(milestoneCount)
    : Number(milestoneInvoice?.milestoneIndex || 0) + 1;
  return `Milestone ${Number(milestoneInvoice.milestoneIndex || 0) + 1} of ${count} for Quote ${milestoneInvoice.reference || milestoneInvoice.invoiceNumber}.`;
}

// Issued invoices hold their frozen totals. The quote value that is not
// already claimed by a frozen invoice is re-spread across the milestones that
// are still open, so the schedule keeps reconciling to the quote total instead
// of silently drifting.
function rebalanceAllocationsAroundFrozenInvoices({
  milestones = [],
  frozenByIndex = new Map(),
  financials = null,
  totalAllocations = [],
  subtotalAllocations = [],
}) {
  if (!frozenByIndex.size) {
    return { totalAllocations, subtotalAllocations };
  }

  const frozenIndexes = [...frozenByIndex.keys()].filter((index) => index < milestones.length);
  const frozenTotalCents = frozenIndexes.reduce(
    (sum, index) => sum + toCents(frozenByIndex.get(index).total),
    0,
  );
  const baselineFrozenCents = frozenIndexes.reduce(
    (sum, index) => sum + toCents(totalAllocations[index]),
    0,
  );

  const nextTotals = totalAllocations.map((value, index) => (
    frozenByIndex.has(index) ? frozenByIndex.get(index).total : value
  ));
  const nextSubtotals = subtotalAllocations.map((value, index) => (
    frozenByIndex.has(index) ? frozenByIndex.get(index).subtotal : value
  ));

  // Nothing to re-spread while the frozen invoices still match what the
  // schedule would have produced, which is the common case.
  if (frozenTotalCents === baselineFrozenCents) {
    return { totalAllocations: nextTotals, subtotalAllocations: nextSubtotals };
  }

  const openIndexes = milestones
    .map((_, index) => index)
    .filter((index) => !frozenByIndex.has(index));
  if (!openIndexes.length) {
    return { totalAllocations: nextTotals, subtotalAllocations: nextSubtotals };
  }

  const remainingTotalCents = toCents(financials.total) - frozenTotalCents;
  if (remainingTotalCents <= 0) {
    // The quote no longer covers what has already been invoiced. Open
    // milestones claim nothing; resolving the over-claim is an operator
    // decision, not something to invent here.
    openIndexes.forEach((index) => {
      nextTotals[index] = 0;
      nextSubtotals[index] = 0;
    });
    return { totalAllocations: nextTotals, subtotalAllocations: nextSubtotals };
  }

  const openMilestones = openIndexes.map((index) => milestones[index] || {});
  const openTotals = allocateFixedThenVariableTotals(
    fromCents(remainingTotalCents),
    openMilestones,
    { allowShortfall: true },
  );
  openIndexes.forEach((index, position) => {
    nextTotals[index] = openTotals[position];
  });

  const frozenSubtotalCents = frozenIndexes.reduce(
    (sum, index) => sum + toCents(frozenByIndex.get(index).subtotal),
    0,
  );
  const trueRemainingSubtotalCents = toCents(financials.subtotal) - frozenSubtotalCents;
  let openSubtotals;
  if (trueRemainingSubtotalCents >= 0) {
    // Common case: the frozen invoices' historical subtotals still fit
    // within the current quote's subtotal — split the genuine remainder
    // proportionally by total, same as before.
    openSubtotals = allocateCents(fromCents(trueRemainingSubtotalCents), openTotals).map(fromCents);
  } else {
    // A frozen invoice's own subtotal/GST split (frozen at issue time) can
    // drift from what the CURRENT quote's aggregate split implies even while
    // its TOTAL still fits (e.g. a later quote edit changed which lines
    // carry GST) — the earlier remainingTotalCents<=0 branch does not catch
    // this, because the totals genuinely still reconcile. Clamping the
    // negative remainder to zero used to collapse every open milestone's
    // subtotal to $0 and its GST to 100% of its total: the money total
    // still reconciled, but the tax split on a customer-facing invoice was
    // wrong. There is no genuine non-negative
    // remainder left to split in cents here, so fall back to the quote's
    // own subtotal:total ratio applied to each open milestone's own total —
    // an approximation, but an internally coherent one, instead of a
    // fabricated 100%-GST line.
    const quoteSubtotalRatio = toCents(financials.total) > 0
      ? toCents(financials.subtotal) / toCents(financials.total)
      : 0;
    openSubtotals = openIndexes.map((index) => roundMoney(nextTotals[index] * quoteSubtotalRatio));
  }
  openIndexes.forEach((index, position) => {
    nextSubtotals[index] = openSubtotals[position];
  });

  return { totalAllocations: nextTotals, subtotalAllocations: nextSubtotals };
}

export function buildMilestoneInvoices({
  meta = null,
  quote = null,
  paymentSchedule = null,
  config = null,
  existingMilestoneInvoices = null,
  revisionAuthorizations = null,
  now = null,
} = {}) {
  if (!quote || typeof quote !== "object") {
    throw createError("quote is required to build milestone invoices", 400);
  }

  const schedule = resolvePaymentSchedule({
    meta,
    quote,
    paymentSchedule,
    config,
  });
  const financials = getCustomerPresentationFinancials(quote);
  const sourceItems = buildMilestoneSourceItems(quote);
  const existingByIndex = new Map(
    normalizeStoredMilestoneInvoices(existingMilestoneInvoices || meta?.milestoneInvoices || [])
      .map((milestoneInvoice) => [milestoneInvoice.milestoneIndex, milestoneInvoice])
  );
  const authorizationsByIndex = normalizeRevisionAuthorizations(revisionAuthorizations);
  const quoteVersion = normalizeQuoteVersionNumber(quote?.version)
    || normalizeQuoteVersionNumber(meta?.quoteVersion);
  const frozenByIndex = new Map();
  // Stored records from before invoice revisions never froze a snapshot on issue, so
  // `existing.issuedRevision` is null for the entire population of invoices
  // sent before this change. First touch must still freeze from what was
  // actually stored and sent, never from a fresh reallocation against a
  // quote that may have moved on since — so this map tracks the
  // revision synthesized from that legacy record, to be threaded into the
  // revision-state resolution below instead of `null`.
  const legacyIssuedRevisionByIndex = new Map();
  schedule.milestones.forEach((_, milestoneIndex) => {
    const existing = existingByIndex.get(milestoneIndex) || null;
    // Only an invoice that is still issued is frozen. One that has been
    // returned to draft retires its revision instead.
    if (!existing || !isMilestoneInvoiceIssued(existing)) return;
    const isAuthorizedIndex = authorizationsByIndex.has(milestoneIndex);
    if (existing.issuedRevision) {
      // Not a legacy record: `existing.issuedRevision` is read directly by
      // the revision-state resolution below regardless of this map, so it
      // never needed synthesis. Only gate the allocation freeze here — an
      // authorized index must stay free to reallocate.
      if (!isAuthorizedIndex) frozenByIndex.set(milestoneIndex, existing.issuedRevision);
      return;
    }
    // Stored records from before invoice revisions never froze a snapshot on issue, so
    // `existing.issuedRevision` is null for the entire population of invoices
    // sent before this change. First touch must still freeze from what was
    // actually stored and sent, never from a fresh reallocation against a
    // quote that may have moved on since — so this map tracks the
    // revision synthesized from that legacy record, to be threaded into the
    // revision-state resolution below instead of `null`. This synthesis must
    // run for authorized indexes too: authorization is exactly the moment
    // `reviseJobMilestoneInvoice` needs a legacy revision to retire into
    // history. Only the allocation freeze (`frozenByIndex`) may skip an
    // authorized index so the rebalance can move its claim.
    const legacyRevision = normalizeInvoiceRevision({
      revisionNumber: existing.revisionNumber || 1,
      invoiceNumber: existing.invoiceNumber,
      issuedAt: existing.issuedAt,
      subtotal: existing.subtotal,
      gst: existing.gst,
      total: existing.total,
      currency: existing.currency,
      lineItems: existing.lineItems,
      // Without the stored PDF path, the authorization below would retire
      // this revision into history with `pdfPath: null` and 410 despite the
      // file existing on disk.
      pdfPath: existing.pdfPath || null,
      // The legacy record predates per-revision quote-version tracking, so
      // there is no historically-accurate value to recover. Threading the
      // quote version this rebuild is already running against keeps the
      // fingerprint stable across calls made against the same live quote
      // (e.g. an unsend immediately followed by a re-issue), instead of
      // comparing a synthesized `null` against a real version and burning a
      // revision number on identical content. This value is
      // NOT what the customer's document was actually rendered from — mark
      // it inferred so downstream audit text never overstates what is known.
      quoteVersion,
      quoteVersionInferred: true,
      // Set directly on the synthesized revision itself, not stamped on
      // afterward: under an authorization this revision gets RETIRED into
      // history (resolveMilestoneRevisionState mints a fresh replacement),
      // and only a state set here travels with it through that retirement
      // (retireRevision spreads the revision object as-is). Stamping it
      // post-hoc on `revisionState.issuedRevision` instead would land on
      // the freshly minted revision — which has no prior file and is
      // correctly UNWRITTEN, not ADOPT_PENDING — while leaving the retired
      // legacy copy in history without any state at all.
      artifactState: ARTIFACT_STATE.ADOPT_PENDING,
    });
    if (legacyRevision) {
      legacyIssuedRevisionByIndex.set(milestoneIndex, legacyRevision);
      if (!isAuthorizedIndex) frozenByIndex.set(milestoneIndex, legacyRevision);
    }
  });

  const baseTotalAllocations = buildMilestoneTotalAllocations(financials.total, schedule.milestones, { allowShortfall: true });
  const baseSubtotalAllocations = allocateCents(
    financials.subtotal,
    baseTotalAllocations
  ).map(fromCents);
  const {
    totalAllocations,
    subtotalAllocations,
  } = rebalanceAllocationsAroundFrozenInvoices({
    milestones: schedule.milestones,
    frozenByIndex,
    financials,
    totalAllocations: baseTotalAllocations,
    subtotalAllocations: baseSubtotalAllocations,
  });
  const reference = buildMilestoneReference({ meta, quote });
  const quoteId = buildMilestoneQuoteId({ meta, quote });

  const milestoneInvoices = schedule.milestones.map((milestone, milestoneIndex) => {
    const existingMilestone = existingByIndex.get(milestoneIndex) || null;
    const frozenRevision = frozenByIndex.get(milestoneIndex) || null;
    const subtotal = subtotalAllocations[milestoneIndex];
    const total = totalAllocations[milestoneIndex];
    const gst = frozenRevision ? frozenRevision.gst : roundMoney(total - subtotal);
    const baseInvoiceNumber = provisionalInvoiceBaseNumber({
      invoiceNumber: resolveMilestoneInvoiceNumber({
        milestoneInvoice: existingMilestone,
        meta,
        quote,
        milestoneIndex,
      }),
      meta,
      quote,
      milestoneIndex,
      milestoneInvoice: existingMilestone,
    });
    const receiptNumber = cleanText(existingMilestone?.receiptNumber) || buildMilestoneReceiptNumber({
      meta,
      quote,
      milestoneIndex,
      milestoneInvoice: existingMilestone,
    });
    const lineItemAllocations = allocateCents(
      subtotal,
      sourceItems.map((item) => Number(item?.totalPrice || 0))
    ).map(fromCents);
    const lineItems = frozenRevision ? normalizeMilestoneLineItems(frozenRevision.lineItems) : sourceItems
      .map((item, index) => {
        const totalPrice = lineItemAllocations[index];
        if (!(totalPrice > 0) && sourceItems.length > 1) return null;
        const quantity = Number.isFinite(Number(item?.quantity)) && Number(item.quantity) > 0
          ? Number(item.quantity)
          : 1;
        return {
          description: cleanText(item?.label) || `Line item ${index + 1}`,
          quantity,
          unit: cleanText(item?.unit) || "lot",
          unitPrice: roundMoney(quantity > 0 ? totalPrice / quantity : totalPrice),
          totalPrice,
          accountCode: null,
          sourceCode: cleanText(item?.sourceCode || item?.code) || null,
        };
      })
      .filter(Boolean);

    const payments = existingMilestone
      ? normalizeMilestonePayments(existingMilestone.payments)
      : maybeSeedLegacyMilestonePayments({
          meta,
          existingMilestone,
          milestoneIndex,
          milestoneTotal: total,
          milestoneCount: schedule.milestones.length,
        });
    const amountPaid = Math.min(total, sumActiveMilestonePayments(payments));
    const amountDue = roundMoney(Math.max(total - amountPaid, 0));
    const issuedAt = normalizeIsoTimestamp(existingMilestone?.issuedAt)
      || (hasLegacySingleInvoiceState(meta) && schedule.milestones.length === 1
        ? normalizeIsoTimestamp(meta?.invoiceSentAt)
        : null);
    const dueDate = assertDateOnly(
      existingMilestone?.dueDate
      || (issuedAt && milestone?.dueDays ? addDays(issuedAt.slice(0, 10), milestone.dueDays) : null),
      "due date"
    );
    const status = deriveMilestoneStatus({
      requestedStatus: cleanText(existingMilestone?.status) || null,
      total,
      amountPaid,
      amountDue,
      issuedAt,
    });
    const currency = frozenRevision
      ? frozenRevision.currency
      : (cleanText(existingMilestone?.currency) || cleanText(quote?.totals?.currency) || "AUD");

    const revisionState = resolveMilestoneRevisionState({
      issuedRevision: legacyIssuedRevisionByIndex.get(milestoneIndex) || existingMilestone?.issuedRevision || null,
      revisionHistory: existingMilestone?.revisionHistory || [],
      storedRevisionNumber: existingMilestone?.revisionNumber || null,
      baseInvoiceNumber,
      isIssued: status === "authorised" || status === "paid" || Boolean(issuedAt),
      issuedAt,
      quoteVersion,
      financials: { subtotal, gst, total, currency, lineItems },
      authorization: authorizationsByIndex.get(milestoneIndex) || null,
      now,
    });
    const invoiceNumber = revisionState.invoiceNumber;
    const pdfPath = buildMilestoneInvoicePdfPath({ invoiceNumber, milestoneIndex });
    // `artifactState` travels on the revision object itself now — set once, at
    // legacy synthesis above, on the exact revision it describes. It must never
    // be re-stamped here based on whether THIS milestone index happened to
    // synthesize a legacy revision this build: under an authorization,
    // `revisionState.issuedRevision` is a freshly MINTED revision (the legacy
    // copy was retired into history), and stamping ADOPT_PENDING onto that mint
    // — which has no prior file — would wrongly route it through the
    // adopt-or-reconstruct branch in `writeMilestoneInvoiceArtifact` instead of
    // a plain first render.
    const issuedRevision = revisionState.issuedRevision
      ? {
          ...revisionState.issuedRevision,
          pdfPath: revisionState.issuedRevision.pdfPath || pdfPath,
        }
      : null;

    return {
      id: cleanText(existingMilestone?.id) || randomUUID(),
      jobId: cleanText(existingMilestone?.jobId) || cleanText(meta?.id) || null,
      quoteId: cleanText(existingMilestone?.quoteId) || quoteId,
      milestoneIndex,
      milestoneLabel: milestone.label,
      invoiceNumber,
      revisionNumber: revisionState.revisionNumber,
      issuedRevision,
      revisionHistory: revisionState.revisionHistory,
      receiptNumber,
      reference: cleanText(existingMilestone?.reference) || reference,
      percentage: milestone.percentage,
      ...(Number(milestone.fixedTotal || 0) > 0 ? { fixedTotal: milestone.fixedTotal } : {}),
      subtotal,
      gst,
      total,
      currency,
      amountPaid,
      amountDue,
      lineItems,
      dueDate,
      issuedAt: issuedRevision?.issuedAt || issuedAt,
      paidAt: amountDue <= 0
        ? (normalizeDateOnly(existingMilestone?.paidAt) || payments[payments.length - 1]?.date || normalizeDateOnly(issuedAt))
        : null,
      status,
      payments,
      pdfPath: issuedRevision?.pdfPath || pdfPath,
      receiptPdfPath: cleanText(existingMilestone?.receiptPdfPath) || buildMilestoneReceiptPdfPath({ receiptNumber, milestoneIndex }),
    };
  });

  return {
    paymentSchedule: schedule,
    milestoneInvoices,
  };
}

// Freeze the milestone's current financial content as the issued revision, or
// retire it when the milestone drops back out of issued state. Both are pure
// transforms of one milestone record.
export function applyMilestoneInvoiceRevisionState(milestoneInvoice = null, {
  isIssued = false,
  issuedAt = null,
  quoteVersion = null,
  authorization = null,
  actor = null,
  defaultRevisionReason = null,
  now = null,
} = {}) {
  if (!milestoneInvoice) return milestoneInvoice;
  const revisionState = resolveMilestoneRevisionState({
    issuedRevision: milestoneInvoice.issuedRevision || null,
    revisionHistory: milestoneInvoice.revisionHistory || [],
    storedRevisionNumber: milestoneInvoice.revisionNumber || null,
    baseInvoiceNumber: provisionalInvoiceBaseNumber({
      invoiceNumber: milestoneInvoice.invoiceNumber,
      meta: milestoneInvoice,
      milestoneIndex: milestoneInvoice.milestoneIndex,
      milestoneInvoice,
    }),
    isIssued,
    issuedAt: issuedAt || milestoneInvoice.issuedAt || null,
    quoteVersion,
    financials: {
      subtotal: milestoneInvoice.subtotal,
      gst: milestoneInvoice.gst,
      total: milestoneInvoice.total,
      currency: milestoneInvoice.currency,
      lineItems: milestoneInvoice.lineItems,
    },
    authorization,
    actor,
    defaultRevisionReason,
    now,
  });
  const invoiceNumber = revisionState.invoiceNumber || milestoneInvoice.invoiceNumber;
  const pdfPath = buildMilestoneInvoicePdfPath({
    invoiceNumber,
    milestoneIndex: milestoneInvoice.milestoneIndex,
  });
  const issuedRevision = revisionState.issuedRevision
    ? { ...revisionState.issuedRevision, pdfPath: revisionState.issuedRevision.pdfPath || pdfPath }
    : null;
  return {
    ...milestoneInvoice,
    invoiceNumber,
    revisionNumber: revisionState.revisionNumber,
    issuedRevision,
    revisionHistory: revisionState.revisionHistory,
    issuedAt: issuedRevision?.issuedAt || (isIssued ? (issuedAt || milestoneInvoice.issuedAt || null) : null),
    pdfPath: issuedRevision?.pdfPath || pdfPath,
  };
}

export function updateMilestoneInvoice({
  milestoneInvoices = [],
  milestoneIndex = null,
  patch = {},
  quoteVersion = null,
  actor = null,
} = {}) {
  const normalized = normalizeStoredMilestoneInvoices(milestoneInvoices);
  const position = findMilestonePosition(normalized, milestoneIndex);
  const current = normalized[position];

  const nextDueDate = Object.prototype.hasOwnProperty.call(patch, "dueDate")
    ? assertDateOnly(patch?.dueDate, "due date")
    : current.dueDate;
  const requestedStatus = Object.prototype.hasOwnProperty.call(patch, "status")
    ? cleanText(patch?.status)?.toLowerCase()
    : current.status;

  validateMilestoneStatusTransition({
    currentStatus: current.status,
    requestedStatus,
    amountDue: current.amountDue,
  });

  const issuedAt = requestedStatus === "authorised"
    ? (current.issuedAt || new Date().toISOString())
    : current.issuedAt;
  const nextMilestoneInvoice = applyMilestoneInvoiceRevisionState({
    ...current,
    dueDate: nextDueDate,
    status: requestedStatus,
    issuedAt,
    paidAt: requestedStatus === "paid"
      ? (current.paidAt || new Date().toISOString().slice(0, 10))
      : current.paidAt,
  }, {
    isIssued: requestedStatus === "authorised" || requestedStatus === "paid" || Boolean(issuedAt),
    issuedAt,
    quoteVersion,
    actor,
    // Only ever used when this authorise transition happens to mint a
    // revision above 1 — i.e. the invoice was previously issued, then
    // returned to draft, and is now being reissued with changed content.
    // No operator-typed reason is required on this path.
    defaultRevisionReason: "Reissued after the invoice was returned to draft",
  });

  return {
    milestoneInvoices: replaceMilestoneInvoice(normalized, nextMilestoneInvoice),
    milestoneInvoice: nextMilestoneInvoice,
  };
}

export function recordMilestoneInvoicePayment({
  milestoneInvoices = [],
  milestoneIndex = null,
  payment = {},
} = {}) {
  const normalized = normalizeStoredMilestoneInvoices(milestoneInvoices);
  const position = findMilestonePosition(normalized, milestoneIndex);
  const current = normalized[position];

  if (current.status === "draft") {
    throw createError("milestone invoice must be authorised before recording payments", 409);
  }

  const amount = roundMoney(payment?.amount);
  if (!(amount > 0)) {
    throw createError("payment amount must be greater than zero", 400);
  }
  if (amount > current.amountDue) {
    throw createError("payment amount cannot exceed the milestone balance due", 400);
  }

  // Payments attribute to the invoice revision actually paid, not just the
  // milestone: if the caller doesn't supply one (only the migration path
  // does), default to the milestone's current invoice/revision number so
  // paid state stays traceable to the right numbered document even after a
  // later revision supersedes it.
  const sourceInvoiceNumber = cleanText(payment?.sourceInvoiceNumber) || cleanText(current.invoiceNumber) || null;
  const sourceRevisionNumber = Number.isFinite(Number(payment?.sourceRevisionNumber)) && Number(payment.sourceRevisionNumber) > 0
    ? Number(payment.sourceRevisionNumber)
    : (Number.isFinite(Number(current.revisionNumber)) && Number(current.revisionNumber) > 0
      ? Number(current.revisionNumber)
      : null);

  const nextPayment = {
    id: randomUUID(),
    date: assertDateOnly(payment?.date, "payment date") || new Date().toISOString().slice(0, 10),
    amount,
    reference: cleanText(payment?.reference) || null,
    method: cleanText(payment?.method) || null,
    recordedAt: new Date().toISOString(),
    ...(Number.isFinite(Number(payment?.sourceQuoteVersion)) && Number(payment.sourceQuoteVersion) > 0
      ? { sourceQuoteVersion: Number(payment.sourceQuoteVersion) }
      : {}),
    ...(sourceInvoiceNumber ? { sourceInvoiceNumber } : {}),
    ...(sourceRevisionNumber ? { sourceRevisionNumber } : {}),
    ...(cleanText(payment?.migrationId) ? { migrationId: cleanText(payment.migrationId) } : {}),
    ...(cleanText(payment?.note) ? { note: cleanText(payment.note) } : {}),
  };
  const payments = [...current.payments, nextPayment];
  const amountPaid = sumActiveMilestonePayments(payments);
  const amountDue = roundMoney(Math.max(current.total - amountPaid, 0));
  const nextMilestoneInvoice = {
    ...current,
    payments,
    amountPaid,
    amountDue,
    status: amountDue <= 0 ? "paid" : "authorised",
    paidAt: amountDue <= 0 ? nextPayment.date : null,
  };

  return {
    milestoneInvoices: replaceMilestoneInvoice(normalized, nextMilestoneInvoice),
    milestoneInvoice: nextMilestoneInvoice,
    payment: nextPayment,
  };
}

export function voidMilestoneInvoicePayment({
  milestoneInvoices = [],
  milestoneIndex = null,
  paymentId = null,
  reason = null,
  actor = null,
} = {}) {
  const normalized = normalizeStoredMilestoneInvoices(milestoneInvoices);
  const position = findMilestonePosition(normalized, milestoneIndex);
  const current = normalized[position];
  const targetPaymentId = cleanText(paymentId);
  if (!targetPaymentId) {
    throw createError("payment id is required", 400);
  }
  const paymentIndex = current.payments.findIndex((payment) => payment.id === targetPaymentId);
  if (paymentIndex === -1) {
    throw createError("payment not found", 404);
  }
  const currentPayment = current.payments[paymentIndex];
  if (isMilestonePaymentVoided(currentPayment)) {
    throw createError("payment is already voided", 409);
  }

  const voidedPayment = {
    ...currentPayment,
    voidedAt: new Date().toISOString(),
    voidReason: cleanText(reason) || "Voided payment",
    voidedBy: cleanText(actor?.label || actor?.name || actor) || null,
  };
  const payments = current.payments.map((payment, index) => (
    index === paymentIndex ? voidedPayment : payment
  ));
  const amountPaid = sumActiveMilestonePayments(payments);
  const amountDue = roundMoney(Math.max(current.total - amountPaid, 0));
  const nextMilestoneInvoice = {
    ...current,
    payments,
    amountPaid,
    amountDue,
    status: amountDue <= 0 ? "paid" : (current.issuedAt ? "authorised" : "draft"),
    paidAt: amountDue <= 0
      ? (payments.filter((payment) => !isMilestonePaymentVoided(payment)).at(-1)?.date || current.paidAt || null)
      : null,
  };

  return {
    milestoneInvoices: replaceMilestoneInvoice(normalized, nextMilestoneInvoice),
    milestoneInvoice: nextMilestoneInvoice,
    payment: voidedPayment,
  };
}

export function markMilestoneInvoiceUnpaid({
  milestoneInvoices = [],
  milestoneIndex = null,
} = {}) {
  const normalized = normalizeStoredMilestoneInvoices(milestoneInvoices);
  const position = findMilestonePosition(normalized, milestoneIndex);
  const current = normalized[position];

  if (!(Number(current.amountPaid || 0) > 0) && current.status !== "paid") {
    throw createError("milestone invoice is not currently paid", 409);
  }

  const nextMilestoneInvoice = applyMilestoneInvoiceRevisionState({
    ...current,
    payments: [],
    amountPaid: 0,
    amountDue: current.total,
    status: "draft",
    issuedAt: null,
    paidAt: null,
  }, {
    isIssued: false,
    // The content is not changing here, only the issue state — carry the
    // quote version the retiring revision was issued against so a
    // subsequent identical re-issue still fingerprint-matches and restores
    // it instead of burning a number.
    quoteVersion: current.issuedRevision?.quoteVersion ?? null,
  });

  return {
    milestoneInvoices: replaceMilestoneInvoice(normalized, nextMilestoneInvoice),
    milestoneInvoice: nextMilestoneInvoice,
  };
}

export function markMilestoneInvoiceUnsent({
  milestoneInvoices = [],
  milestoneIndex = null,
} = {}) {
  const normalized = normalizeStoredMilestoneInvoices(milestoneInvoices);
  const position = findMilestonePosition(normalized, milestoneIndex);
  const current = normalized[position];

  if (current.status !== "authorised" && !current.issuedAt) {
    throw createError("milestone invoice is not currently sent", 409);
  }
  if (Number(current.amountPaid || 0) > 0 || current.status === "paid") {
    throw createError("paid milestone invoices must be reset with mark unpaid", 409);
  }
  if (Array.isArray(current.payments) && current.payments.length) {
    throw createError("milestone invoice cannot be unsent while payments are recorded", 409);
  }

  const nextMilestoneInvoice = applyMilestoneInvoiceRevisionState({
    ...current,
    status: "draft",
    issuedAt: null,
    paidAt: null,
  }, {
    isIssued: false,
    // Same rationale as markMilestoneInvoiceUnpaid above.
    quoteVersion: current.issuedRevision?.quoteVersion ?? null,
  });

  return {
    milestoneInvoices: replaceMilestoneInvoice(normalized, nextMilestoneInvoice),
    milestoneInvoice: nextMilestoneInvoice,
  };
}

export function getMilestoneInvoiceRevisions(milestoneInvoice = null) {
  return listInvoiceRevisions({
    issuedRevision: milestoneInvoice?.issuedRevision || null,
    revisionHistory: milestoneInvoice?.revisionHistory || [],
  });
}

export function findMilestoneInvoiceRevision(milestoneInvoice = null, revisionNumber = null) {
  return findInvoiceRevision({
    issuedRevision: milestoneInvoice?.issuedRevision || null,
    revisionHistory: milestoneInvoice?.revisionHistory || [],
    revisionNumber,
  });
}

export function buildInvoicePaymentSummary({
  meta = null,
  quote = null,
  invoicePaidAmount = null,
  milestoneInvoice = null,
} = {}) {
  const activeMilestone = milestoneInvoice || meta?.milestoneInvoice || null;
  if (activeMilestone) {
    return {
      currency: activeMilestone.currency || quote?.totals?.currency || "AUD",
      total: roundMoney(activeMilestone.total || 0),
      paid: roundMoney(activeMilestone.amountPaid || 0),
      outstanding: roundMoney(activeMilestone.amountDue || 0),
    };
  }

  const total = roundMoney(quote?.totals?.total || 0);
  const paid = Math.min(
    total,
    coerceInvoicePaidAmount(
      invoicePaidAmount != null ? invoicePaidAmount : meta?.invoicePaidAmount
    )
  );
  const outstanding = roundMoney(Math.max(total - paid, 0));
  return {
    currency: quote?.totals?.currency || "AUD",
    total,
    paid,
    outstanding,
  };
}

export function prepareMilestoneInvoiceDocument({
  meta = null,
  quote = null,
  milestoneInvoice = null,
  documentType = "invoice",
} = {}) {
  const normalizedMilestone = milestoneInvoice
    ? normalizeStoredMilestoneInvoices([milestoneInvoice])[0]
    : null;
  if (!normalizedMilestone || !quote) {
    return { meta, quote };
  }

  const resolvedDocumentType = resolveJobDocumentType({ meta, documentType });
  const isReceipt = resolvedDocumentType === "receipt";
  const activePayments = normalizedMilestone.payments.filter((payment) => !isMilestonePaymentVoided(payment));
  const latestPayment = activePayments[activePayments.length - 1] || null;
  const receiptIssuedAt = normalizeIsoTimestamp(latestPayment?.recordedAt)
    || dateOnlyToIsoTimestamp(normalizedMilestone.paidAt);
  const documentNumber = isReceipt
    ? normalizedMilestone.receiptNumber
    : normalizedMilestone.invoiceNumber;
  const finalizedAt = isReceipt
    ? (receiptIssuedAt || normalizedMilestone.issuedAt || quote?.delivery?.finalizedAt || null)
    : (normalizedMilestone.issuedAt || quote?.delivery?.finalizedAt || null);

  const allMilestones = normalizeStoredMilestoneInvoices(meta?.milestoneInvoices || []);
  const milestoneCount = allMilestones.length || Number(normalizedMilestone.milestoneIndex || 0) + 1;

  // The milestone invoice is a claim for X% of the quote. Its pricing schedule
  // must mirror the quote's exactly — same items, same prices, same totals —
  // so the customer sees the document that backs the invoice they are paying
  // against. The milestone-specific amount lives in the Payment Summary box,
  // which reads from `meta.milestoneInvoice` below, not from `quote.totals`.
  // Do NOT rewrite `lineItems`, `presentation`, or `totals` here.
  return {
    meta: {
      ...meta,
      invoiceSentAt: normalizedMilestone.issuedAt || meta?.invoiceSentAt || null,
      invoicePaidAmount: normalizedMilestone.amountPaid,
      receiptIssuedAt: isReceipt ? finalizedAt : meta?.receiptIssuedAt || null,
      milestoneInvoice: {
        ...normalizedMilestone,
        milestoneCount,
        contextNote: buildMilestoneContextNote(normalizedMilestone, milestoneCount),
      },
    },
    quote: {
      ...quote,
      quoteNumber: documentNumber,
      delivery: {
        ...(quote?.delivery || {}),
        status: isReceipt ? "final" : (normalizedMilestone.status === "draft" ? "draft" : "final"),
        finalizedAt,
      },
    },
  };
}

export function prepareRequestedJobDocument({
  meta = null,
  quote = null,
  documentType = null,
  milestoneIndex = null,
} = {}) {
  const resolvedDocumentType = resolveJobDocumentType({ meta, documentType });
  if (resolvedDocumentType === "quote") {
    return {
      meta,
      quote,
      documentType: resolvedDocumentType,
      milestoneInvoice: null,
    };
  }

  if (resolvedDocumentType === "receipt") {
    const milestoneInvoice = resolveRequestedReceiptMilestoneInvoice({
      meta,
      milestoneIndex,
    });
    if (!milestoneInvoice) {
      throw createError("paid milestone receipt not found", 404);
    }

    const prepared = prepareMilestoneInvoiceDocument({
      meta,
      quote,
      milestoneInvoice,
      documentType: resolvedDocumentType,
    });
    return {
      ...prepared,
      documentType: resolvedDocumentType,
      milestoneInvoice,
    };
  }

  const milestoneInvoice = resolveRequestedMilestoneInvoice({
    meta,
    milestoneIndex,
  });
  if (!milestoneInvoice) {
    return {
      meta: {
        ...meta,
        milestoneInvoice: null,
      },
      quote: quote
        ? {
            ...quote,
            quoteNumber: buildInvoiceDocumentNumber({ meta, quote }),
          }
        : quote,
      documentType: resolvedDocumentType,
      milestoneInvoice: null,
    };
  }

  const prepared = prepareMilestoneInvoiceDocument({
    meta,
    quote,
    milestoneInvoice,
    documentType: resolvedDocumentType,
  });
  return {
    ...prepared,
    documentType: resolvedDocumentType,
    milestoneInvoice,
  };
}

// Compat contract for meta fields synthesized from milestone state:
//
//   meta.invoicePaidAmount     — amount paid on the NEXT-OPEN milestone
//                                (or the legacy scalar when no milestones).
//                                Legacy clients that render a single "paid"
//                                figure in-context get the milestone they're
//                                about to act on, not a running total.
//   meta.totalInvoicePaidAmount — running sum across ALL milestones (new).
//                                External integrations and exports should
//                                prefer this field when they want a job-
//                                level paid total.
//   meta.invoiceSentAt         — issued-at of the next-open milestone, or
//                                the latest issued-at across milestones,
//                                or the legacy scalar when no milestones.
//
// These fields are derived from milestone-invoices/state.json and are NOT
// persisted to raw meta.json. Callers must go through hydrateJobMeta or the
// public APIs rather than reading meta.json directly.
export function applyMilestoneInvoiceCompatFields(meta = null) {
  if (!meta || typeof meta !== "object") return meta;

  const milestoneInvoices = normalizeStoredMilestoneInvoices(meta?.milestoneInvoices || []);
  let paymentSchedule = null;
  try {
    paymentSchedule = normalizePaymentSchedule(meta?.paymentSchedule, { allowNull: true });
  } catch {
    paymentSchedule = null;
  }

  if (!milestoneInvoices.length) {
    const legacyPaid = coerceInvoicePaidAmount(meta?.invoicePaidAmount);
    return {
      ...meta,
      ...(paymentSchedule ? { paymentSchedule } : {}),
      invoiceSentAt: meta?.invoiceSentAt || null,
      invoicePaidAmount: legacyPaid,
      totalInvoicePaidAmount: legacyPaid,
    };
  }

  const nextMilestone = findNextOpenMilestoneInvoice(milestoneInvoices)
    || milestoneInvoices[milestoneInvoices.length - 1]
    || null;
  const latestIssuedAt = milestoneInvoices
    .map((milestoneInvoice) => milestoneInvoice.issuedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const totalInvoicePaidAmount = roundMoney(
    milestoneInvoices.reduce((sum, invoice) => sum + Number(invoice.amountPaid || 0), 0)
  );

  return {
    ...meta,
    ...(paymentSchedule ? { paymentSchedule } : {}),
    milestoneInvoices,
    invoiceSentAt: nextMilestone?.issuedAt || latestIssuedAt || meta?.invoiceSentAt || null,
    invoicePaidAmount: nextMilestone
      ? nextMilestone.amountPaid
      : coerceInvoicePaidAmount(meta?.invoicePaidAmount),
    totalInvoicePaidAmount,
  };
}
