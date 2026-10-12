// Prefixed ULIDs for invoice rows (docs/PRICING_ENGINE.md "Identity"):
// `pms_` a payment milestone, `inv_` an invoice, `iln_` an invoice line,
// `crn_` a credit note, `cnl_` a credit note line, `pay_` a payment, `pal_` a
// payment allocation and `rct_` a receipt. Drawn from Web Crypto like server/documents/uid.js, so the
// quote/invoice proof's seeded random source is never touched.
import { ulid } from "../documents/uid.js";

export const PAYMENT_MILESTONE_UID_PREFIX = "pms_";
export const INVOICE_UID_PREFIX = "inv_";
export const INVOICE_LINE_UID_PREFIX = "iln_";
export const CREDIT_NOTE_UID_PREFIX = "crn_";
export const CREDIT_NOTE_LINE_UID_PREFIX = "cnl_";
export const PAYMENT_UID_PREFIX = "pay_";
export const PAYMENT_ALLOCATION_UID_PREFIX = "pal_";
export const RECEIPT_UID_PREFIX = "rct_";

export const newPaymentMilestoneUid = (now) => `${PAYMENT_MILESTONE_UID_PREFIX}${ulid(now)}`;
export const newInvoiceUid = (now) => `${INVOICE_UID_PREFIX}${ulid(now)}`;
export const newInvoiceLineUid = (now) => `${INVOICE_LINE_UID_PREFIX}${ulid(now)}`;
export const newCreditNoteUid = (now) => `${CREDIT_NOTE_UID_PREFIX}${ulid(now)}`;
export const newCreditNoteLineUid = (now) => `${CREDIT_NOTE_LINE_UID_PREFIX}${ulid(now)}`;
export const newPaymentUid = (now) => `${PAYMENT_UID_PREFIX}${ulid(now)}`;
export const newPaymentAllocationUid = (now) => `${PAYMENT_ALLOCATION_UID_PREFIX}${ulid(now)}`;
export const newReceiptUid = (now) => `${RECEIPT_UID_PREFIX}${ulid(now)}`;
