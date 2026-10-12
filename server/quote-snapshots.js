// Quote snapshots (#151): the record of exactly what each customer was sent.
//
// Every quote, invoice and receipt delivery writes one `quote_snapshots` row
// (server/db/src/schema.ts), keyed by its delivery attempt:
//
//   prepared  written before the email is dispatched. If it cannot be written
//             the send is refused and nothing goes out (job-actions.js).
//   sent      the same row, marked once the delivery is recorded, with the
//             Gmail message id and the issuance-ledger id.
//
// A row holds the customer-facing lines (what the PDF lists) with, for each
// catalogue-linked row, the catalogue item uid, the price id and price key it
// was priced from and its frozen values; engine rows carry their compiled
// line items with the catalogue item they resolve to. Totals, the catalogue
// version and the pricing-attestation digest go with them. The quote
// artifacts and the issuance ledger stay the authority for the document
// bytes; this table is the queryable record of what was sent, to whom and
// at which prices.
import { asc, eq, sql } from "drizzle-orm";
import { currentPrice } from "./catalog/rollup.js";
import { findItem } from "./catalog/state.js";
import { schema } from "./db-runtime/index.js";
import { DEFAULT_ORG_UID, orgScope } from "./db-runtime/tenancy.js";
import { getCustomerPresentationFinancials, getCustomerScheduleView } from "./quote-presentation.js";
import { isCatalogLinkedNode } from "./quote-catalog-sync.js";
import { normalizeCatalogUnit } from "../shared/catalog-units.js";

const { quoteSnapshots } = schema;

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function round6(value) {
  return Math.round(Number(value || 0) * 1e6) / 1e6;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function addresses(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function catalogRefOfNode(node) {
  return {
    itemUid: text(node.catalogItemUid),
    code: text(node.catalogItemCode),
    priceId: numberOrNull(node.catalogPriceId),
    priceKey: text(node.catalogPriceKey),
    assemblyVersion: numberOrNull(node.catalogAssemblyVersion),
    componentOf: text(node.catalogComponentOf),
    priceSource: node.catalogPriceSource === "unknown" ? "unknown" : "line",
    overridden: node.rateMode !== "catalog-linked"
      || typeof node.priceOverride === "number"
      || typeof node.costOverride === "number",
    frozen: {
      name: text(node.catalogName),
      unit: text(node.catalogUnit),
      sellRate: numberOrNull(node.catalogSellRate),
      buyRate: numberOrNull(node.catalogBuyRate),
      quantity: numberOrNull(node.catalogQuantity),
    },
  };
}

// An engine line is compiled from the catalogue on every build. Record the
// item it resolves to; its price id only when the line's rate is the item's
// current price (otherwise the price it came from is not known any more).
function catalogRefOfLineItem(lineItem, catalogState) {
  if (text(lineItem?.catalogItemUid)) {
    return {
      itemUid: text(lineItem.catalogItemUid),
      code: text(lineItem.catalogItemCode) || text(lineItem.authorityItemCode) || text(lineItem.code),
      priceId: numberOrNull(lineItem.catalogPriceId),
      priceKey: text(lineItem.catalogPriceKey),
      priceSource: "line",
    };
  }
  const code = text(lineItem?.authorityItemCode)
    || text(lineItem?.quoteCatalogEntry?.authorityItemCode)
    || text(lineItem?.quoteCatalogItemCode)
    || text(lineItem?.code);
  if (!code || !catalogState) return code ? { itemUid: null, code, priceId: null, priceKey: null, priceSource: "unknown" } : null;
  const item = findItem(catalogState, code);
  if (!item) return { itemUid: null, code, priceId: null, priceKey: null, priceSource: "missing" };
  const price = currentPrice(catalogState, item.uid);
  const sameUnit = normalizeCatalogUnit(lineItem?.unit, price.unitCode) === normalizeCatalogUnit(price.unit, price.unitCode)
    || normalizeCatalogUnit(lineItem?.unit, price.unitCode) === normalizeCatalogUnit(price.unitCode);
  const matches = sameUnit && price.sell != null && lineItem?.unitPrice != null
    && Math.abs(round6(price.sell) - round6(lineItem.unitPrice)) < 0.005;
  return {
    itemUid: item.uid,
    code: item.code,
    priceId: matches ? price.priceId : null,
    priceKey: matches ? price.priceKey : null,
    priceSource: matches ? "catalogue_at_send" : "unknown",
  };
}

function compactLineItem(lineItem, catalogState) {
  return {
    code: text(lineItem?.code),
    label: text(lineItem?.label) || text(lineItem?.description),
    quantity: numberOrNull(lineItem?.quantity),
    unit: text(lineItem?.unit),
    unitPrice: numberOrNull(lineItem?.unitPrice),
    totalPrice: numberOrNull(lineItem?.totalPrice),
    unitCost: numberOrNull(lineItem?.unitCost),
    totalCost: numberOrNull(lineItem?.totalCost),
    catalog: catalogRefOfLineItem(lineItem, catalogState),
  };
}

/**
 * The customer-facing schedule of a quote (every row, collapsed kit
 * components included), each with its catalogue reference.
 */
export function buildQuoteSnapshotLines(quote, { catalogState = null } = {}) {
  const lineItemsByCode = new Map((quote?.lineItems || []).map((item) => [String(item?.code || ""), item]));
  const { organizer, items: rows } = getCustomerScheduleView(quote, { includeCollapsedChildren: true });
  return rows.map((row) => {
    const node = organizer?.nodes?.[row.nodeId] || null;
    const line = {
      nodeId: text(row.nodeId),
      kind: row.kind || "source",
      depth: Number(row.depth || 0),
      origin: text(row.origin),
      label: text(row.label),
      quantity: numberOrNull(row.quantity),
      unit: text(row.unit),
      unitPrice: numberOrNull(row.unitPrice),
      totalPrice: numberOrNull(row.totalPrice),
      unitCost: numberOrNull(row.unitCost),
      totalCost: numberOrNull(row.totalCost),
      amountVisible: row.amountVisible !== false,
      excludedFromPrice: row.excludedFromPrice === true,
      pricingContribution: row.pricingContribution || "included",
    };
    if (node && isCatalogLinkedNode(node)) {
      line.catalog = catalogRefOfNode(node);
    } else if (row.kind === "source" && row.origin === "engine") {
      line.lineItems = (row.sourceLineItemCodes || [row.code])
        .map((code) => lineItemsByCode.get(String(code)))
        .filter(Boolean)
        .map((lineItem) => compactLineItem(lineItem, catalogState));
    }
    return line;
  });
}

function invoiceLines(milestoneInvoice) {
  const revision = milestoneInvoice?.issuedRevision || null;
  const lineItems = revision?.lineItems || milestoneInvoice?.lineItems || [];
  return lineItems.map((item) => ({
    kind: "invoice_line",
    label: text(item?.description) || text(item?.label),
    quantity: numberOrNull(item?.quantity),
    unit: text(item?.unit),
    unitPrice: numberOrNull(item?.unitPrice),
    totalPrice: numberOrNull(item?.totalPrice),
    sourceCode: text(item?.sourceCode),
  }));
}

/**
 * The snapshot row for one delivery attempt (pure; no I/O). `documentType`
 * is quote, invoice or receipt. Invoice and receipt rows list the milestone
 * document's own lines and carry the quote's lines (with their catalogue
 * references) under `pricing.quote`.
 */
export function buildQuoteSnapshotRecord({
  attemptId,
  documentType = "quote",
  quoteVersion = null,
  quote,
  meta,
  milestoneInvoice = null,
  to,
  cc = [],
  bcc = [],
  sentBy = null,
  pdfSha256 = null,
  preparedAt,
  catalogState = null,
}) {
  if (!attemptId) throw new Error("a quote snapshot needs its delivery attempt id");
  const type = ["quote", "invoice", "receipt"].includes(documentType) ? documentType : "quote";
  const financials = getCustomerPresentationFinancials(quote);
  const quoteLines = buildQuoteSnapshotLines(quote, { catalogState });
  const pricing = {
    quoteTotals: { subtotal: financials.subtotal, gst: financials.gst, total: financials.total, cost: financials.cost },
    gstRate: Number(quote?.quoteCatalog?.gstRate || 0.1),
    pricingSnapshotDigest: quote?.pricing?.attestation?.snapshotDigest || null,
    catalogVersion: catalogState?.version ?? null,
    catalogEtag: catalogState?.etag ?? null,
  };
  let lines = quoteLines;
  let subtotal = financials.subtotal;
  let tax = financials.gst;
  let total = financials.total;
  let currency = text(quote?.currency) || text(quote?.quoteCatalog?.currency) || "AUD";
  let documentNumber = text(quote?.quoteNumber) || text(meta?.quoteNumber) || null;
  if (type !== "quote" && milestoneInvoice) {
    const revision = milestoneInvoice.issuedRevision || null;
    lines = invoiceLines(milestoneInvoice);
    subtotal = roundMoney(revision?.subtotal ?? milestoneInvoice.subtotal ?? milestoneInvoice.amount);
    tax = roundMoney(revision?.gst ?? milestoneInvoice.gst ?? 0);
    total = roundMoney(revision?.total ?? milestoneInvoice.total ?? milestoneInvoice.amount);
    currency = text(revision?.currency) || currency;
    documentNumber = type === "receipt"
      ? (text(milestoneInvoice.receiptNumber) || text(milestoneInvoice.invoiceNumber))
      : (text(revision?.invoiceNumber) || text(milestoneInvoice.invoiceNumber));
    pricing.invoice = {
      revisionNumber: revision?.revisionNumber ?? null,
      amountPaid: numberOrNull(milestoneInvoice.amountPaid),
      label: text(milestoneInvoice.label),
    };
    pricing.quote = { version: numberOrNull(quote?.version), lines: quoteLines };
  }
  return {
    attemptId: String(attemptId),
    jobId: String(meta?.id || ""),
    documentType: type,
    quoteVersion: numberOrNull(quoteVersion ?? quote?.version),
    documentNumber,
    milestoneIndex: numberOrNull(milestoneInvoice?.milestoneIndex),
    currency,
    subtotal: roundMoney(subtotal),
    tax: roundMoney(tax),
    total: roundMoney(total),
    lines,
    pricing,
    recipients: { to: addresses(to), cc: addresses(cc), bcc: addresses(bcc) },
    sentBy: sentBy ? { id: sentBy.id || null, email: sentBy.email || null, name: sentBy.name || null } : null,
    pdfSha256: text(pdfSha256),
    preparedAt: preparedAt || new Date().toISOString(),
  };
}

function toRow(record, sent = null) {
  return {
    attemptId: record.attemptId,
    jobId: record.jobId,
    documentType: record.documentType,
    status: sent ? "sent" : "prepared",
    quoteVersion: record.quoteVersion,
    documentNumber: record.documentNumber,
    milestoneIndex: record.milestoneIndex,
    currency: record.currency,
    subtotal: String(record.subtotal),
    tax: String(record.tax),
    total: String(record.total),
    lines: record.lines,
    pricing: record.pricing,
    recipients: record.recipients,
    sentBy: record.sentBy,
    pdfSha256: record.pdfSha256,
    preparedAt: new Date(record.preparedAt),
    sentAt: sent ? new Date(sent.sentAt) : null,
    messageId: sent?.messageId || null,
    threadId: sent?.threadId || null,
    issuanceId: sent?.issuanceId || null,
  };
}

function fromRow(row) {
  const iso = (value) => (value == null ? null : new Date(value).toISOString());
  return {
    id: Number(row.id),
    attemptId: row.attemptId,
    jobId: row.jobId,
    documentType: row.documentType,
    status: row.status,
    quoteVersion: row.quoteVersion,
    documentNumber: row.documentNumber,
    milestoneIndex: row.milestoneIndex,
    currency: row.currency,
    subtotal: numberOrNull(row.subtotal),
    tax: numberOrNull(row.tax),
    total: numberOrNull(row.total),
    lines: row.lines,
    pricing: row.pricing,
    recipients: row.recipients,
    sentBy: row.sentBy,
    pdfSha256: row.pdfSha256,
    preparedAt: iso(row.preparedAt),
    sentAt: iso(row.sentAt),
    messageId: row.messageId,
    threadId: row.threadId,
    issuanceId: row.issuanceId,
  };
}

/**
 * The snapshot store of organisation `orgUid` (default: the default organisation) on a
 * Drizzle database; every call runs in that organisation's transaction.
 *   recordPrepared(record)       insert; an attempt already recorded is kept
 *   recordSent(record, sent)     insert or mark the attempt's row sent with
 *                                { sentAt, messageId, threadId, issuanceId }
 *   listForJob(jobId)            every row for a job, oldest first
 */
export function createQuoteSnapshotStore({ db: database, orgUid = DEFAULT_ORG_UID }) {
  if (!database) throw new Error("createQuoteSnapshotStore needs a database");
  const db = orgScope(database, orgUid);
  return {
    async recordPrepared(record) {
      await db.transaction((tx) => tx.insert(quoteSnapshots).values(toRow(record))
        .onConflictDoNothing({ target: [quoteSnapshots.orgUid, quoteSnapshots.attemptId] }));
    },
    async recordSent(record, sent) {
      const row = toRow(record, sent);
      await db.transaction((tx) => tx.insert(quoteSnapshots).values(row).onConflictDoUpdate({
        target: [quoteSnapshots.orgUid, quoteSnapshots.attemptId],
        set: {
          status: sql`'sent'`,
          sentAt: row.sentAt,
          messageId: row.messageId,
          threadId: row.threadId,
          issuanceId: row.issuanceId,
        },
      }));
    },
    async listForJob(jobId) {
      const rows = await db.transaction((tx) => tx.select().from(quoteSnapshots)
        .where(eq(quoteSnapshots.jobId, String(jobId)))
        .orderBy(asc(quoteSnapshots.preparedAt), asc(quoteSnapshots.id)));
      return rows.map(fromRow);
    },
  };
}

/**
 * A recorder for a server with no database: every send is refused, because
 * Field must not send what it cannot record.
 */
export function createUnavailableQuoteSnapshotStore(reason) {
  const fail = async () => {
    const error = new Error(`quote snapshots cannot be recorded (${reason}); nothing was sent`);
    error.statusCode = 503;
    error.code = "QUOTE_SNAPSHOT_UNAVAILABLE";
    throw error;
  };
  return { recordPrepared: fail, recordSent: fail, listForJob: async () => [] };
}
