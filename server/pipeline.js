/**
 * Canonical pipeline stage definitions.
 *
 * Pipeline stage tracks where a quote sits in the sales funnel:
 *   draft → sent → landed / lost
 *
 * This is separate from the PDF lock status (draft/final) which lives
 * in quote-overrides.json under `lockStatus`.
 */

export const PIPELINE_STAGES = ["draft", "sent", "landed", "lost"];
const ALLOWED_TRANSITIONS = Object.freeze({
  draft: new Set(["sent", "lost"]),
  sent: new Set(["draft", "landed", "lost"]),
  landed: new Set(["sent", "lost"]),
  lost: new Set(["draft", "sent"]),
});

/** Stages that mean "has been sent to the customer" */
const SENT_STAGES = new Set(["sent", "landed", "lost"]);

/** Legacy values that map to canonical stages */
const LEGACY_MAP = {
  delivered: "landed",
  final: "sent",     // "final" was the PDF lock status leaked into pipeline context
};

/**
 * Normalize any raw pipeline stage value to a canonical stage.
 * Handles legacy "delivered" → "landed" and unknown values → "draft".
 */
export function normalizePipelineStage(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (LEGACY_MAP[v]) return LEGACY_MAP[v];
  if (PIPELINE_STAGES.includes(v)) return v;
  return "draft";
}

/**
 * Returns true if the pipeline stage indicates the quote has left draft and
 * therefore has customer-visible history (sent, landed, or lost).
 * Accepts raw/legacy values.
 */
export function isPipelineSent(raw) {
  return SENT_STAGES.has(normalizePipelineStage(raw));
}

export function canTransitionPipelineStage(fromStage, toStage) {
  const from = normalizePipelineStage(fromStage);
  const to = normalizePipelineStage(toStage);
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.has(to) === true;
}

/**
 * DEL-67: fields that record where a quote sits in the delivery lifecycle,
 * and must survive a quote rebuild regardless of whether that particular
 * rebuild call forked a new version. "Does this call need a new version" is
 * a different question from "has this job already left draft" — two
 * separate quote-rebuild call sites (buildAndPersistQuote in
 * quote-workflow.js, and the wall-build handler in index.js) each keyed
 * these fields off the former ("did THIS call fork?") when they needed the
 * latter, which silently reverted landed/sent/lost jobs back to draft
 * whenever a rebuild happened to land on a call that didn't need to fork
 * (e.g. the second of two rebuild calls in the same request, once the first
 * had already forked).
 *
 * Preserving unconditionally from the incoming meta is a no-op for a
 * genuine draft rebuild, since a never-sent job's meta already carries
 * pipelineStage "draft" (or undefined, which normalizePipelineStage also
 * maps to "draft") and null/zero delivery fields. No caller in this
 * codebase relies on a rebuild to intentionally revert a sent/landed/lost
 * job to draft, or to zero out invoice progress — that would need an
 * explicit, named reset path, and none exists today.
 */
export function preserveQuoteDeliveryState(meta) {
  const pipelineStage = normalizePipelineStage(meta?.pipelineStage || meta?.deliveryStatus);
  return {
    pipelineStage,
    deliveryStatus: pipelineStage,
    quoteSentAt: meta?.quoteSentAt || null,
    landedAt: meta?.landedAt || null,
    lostAt: meta?.lostAt || null,
    invoiceSentAt: meta?.invoiceSentAt || null,
    invoicePaidAmount: Number.isFinite(Number(meta?.invoicePaidAmount)) ? Number(meta.invoicePaidAmount) : 0,
  };
}
