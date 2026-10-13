// How invoices and credit notes describe a claim to the customer (#28; the
// owner's wording of 2026-10-13). Plain words, never Field's internal names:
//
//   claim        "Deposit: 50% of the quoted price"
//   quote line   "Quote EQ-2601-01, accepted 14 September 2026" ("sent …"
//                when not accepted), with "revision 2" only when the customer
//                was sent more than one version of that quote. Never "v1".
//
// The invoice rows keep their own line names (from-milestones.js); this is
// only what a document prints.
import { readQuoteIssuanceLedger } from "../quote-issuance.js";
import { readQuoteLifecycle } from "../quote-lifecycle.js";

function trimNumber(value) {
  return String(Number(value).toFixed(3)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function longDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" });
}

/** "Deposit: 50% of the quoted price", or "Deposit: fixed amount" for a milestone set as an amount. */
export function claimDescription(milestone) {
  const label = String(milestone?.milestoneLabel || milestone?.label || "").trim() || `Milestone ${Number(milestone?.milestoneIndex || 0) + 1}`;
  const fixed = Number(milestone?.fixedTotal) > 0;
  const percent = Number(milestone?.percentage);
  if (!fixed && percent > 0) return `${label}: ${trimNumber(percent)}% of the quoted price`;
  return `${label}: fixed amount`;
}

/**
 * The reference that links an invoice to its job and the quote it bills (#93,
 * owner's decision 2026-10-13): "Job 2610-07 · Quote EQ-2610-07 v2". Printed
 * on Field's invoice and sent as the Xero invoice's Reference, the same
 * whichever system numbers the invoice. The version shows from v2 on: a
 * document never prints "v1" (the wording above). Null when neither is known.
 */
export function jobQuoteReference({ jobReference = null, quoteNumber = null, quoteVersion = null } = {}) {
  const job = String(jobReference ?? "").trim();
  const quote = String(quoteNumber ?? "").trim();
  const parts = [];
  if (job) parts.push(`Job ${job}`);
  if (quote) parts.push(`Quote ${quote}${Number(quoteVersion) > 1 ? ` v${Number(quoteVersion)}` : ""}`);
  return parts.length ? parts.join(" · ") : null;
}

/** "Quote EQ-2601-01, revision 2, accepted 14 September 2026". */
export function quoteReferenceLine(reference) {
  if (!reference?.number) return null;
  const parts = [`Quote ${reference.number}`];
  if (Number(reference.revision) > 1) parts.push(`revision ${Number(reference.revision)}`);
  const when = longDate(reference.at);
  if (reference.status && when) parts.push(`${reference.status} ${when}`);
  return parts.join(", ");
}

/**
 * What a document says about the quote it claims against, from what the job
 * holds without reading files: accepted when the job was landed (its
 * `landedAt`), else sent (`quoteSentAt`). No revision: that needs the job's
 * send history (customerQuoteReference).
 */
export function quoteReferenceFromMeta({ meta = null, milestone = null, quote = null } = {}) {
  const number = String(milestone?.reference || quote?.quoteNumber || meta?.quoteNumber || "").trim() || null;
  const landed = String(meta?.pipelineStage || meta?.deliveryStatus || "").toLowerCase() === "landed" && meta?.landedAt;
  return {
    number,
    revision: null,
    status: landed ? "accepted" : (meta?.quoteSentAt ? "sent" : null),
    at: landed ? meta.landedAt : (meta?.quoteSentAt || null),
  };
}

/**
 * The same, with the revision when the customer was sent more than one
 * version of the quote (the issuance ledger's quote sends, and the version
 * last sent before the ledger). Never throws: without the job's history it
 * is quoteReferenceFromMeta.
 */
export async function customerQuoteReference({ jobDir, meta = null, milestone = null, quote = null, quoteVersion = null }) {
  const reference = quoteReferenceFromMeta({ meta, milestone, quote });
  try {
    const sent = new Set();
    const ledger = await readQuoteIssuanceLedger(jobDir);
    for (const record of ledger?.records || []) {
      if ((record?.documentType || "quote") === "quote" && Number(record?.quoteVersion) > 0) sent.add(Number(record.quoteVersion));
    }
    const lifecycle = await readQuoteLifecycle(jobDir).catch(() => null);
    if (Number(lifecycle?.lastSentQuoteVersion) > 0) sent.add(Number(lifecycle.lastSentQuoteVersion));
    if (sent.size > 1 && Number(quoteVersion) > 0) reference.revision = Number(quoteVersion);
  } catch {}
  return reference;
}
