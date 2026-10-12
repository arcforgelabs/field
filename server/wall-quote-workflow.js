import { quoteRowsFromArtifact } from "./quotes/read-model.js";
import { preserveQuoteDeliveryState } from "./pipeline.js";

/**
 * Builds the persisted meta for a retaining-wall quote rebuild
 * (`POST /api/jobs/:id/wall-build`).
 *
 * This is the wall-model sibling of buildAndPersistQuote's `updatedMeta` in
 * quote-workflow.js — same shape of problem (a quote rebuild that needs to
 * report its new totals/version while not disturbing the job's delivery
 * lifecycle), same fix: delivery state (pipeline stage, timestamps,
 * invoice progress) is preserved unconditionally from the incoming job meta
 * via preserveQuoteDeliveryState, rather than keyed on whether this
 * particular rebuild call forked a new quote version. See
 * preserveQuoteDeliveryState in pipeline.js for the full rationale.
 *
 * Pulled out of the route handler (rather than left inline in
 * server/index.js) so it can be unit tested directly — server/index.js has
 * no exports and boots a live server as a side effect of being imported, so
 * logic left inline there is untestable without a running process.
 */
export function buildWallQuoteMeta({
  metaWithQuoteIdentity,
  quoteFromModel,
  jobMeta,
}) {
  return {
    ...metaWithQuoteIdentity,
    status: "complete",
    quoteReviewStatus: quoteFromModel.review?.status || quoteFromModel.status,
    quoteStatus: "complete",
    quoteLineItemCount: quoteFromModel.lineItems?.length || 0,
    quoteSubtotal: quoteRowsFromArtifact({ quote: quoteFromModel, meta: jobMeta }).financials.subtotal || 0,
    quoteTotal: quoteRowsFromArtifact({ quote: quoteFromModel, meta: jobMeta }).financials.total || quoteFromModel.totals?.total || 0,
    quoteVersion: quoteFromModel.version,
    ...preserveQuoteDeliveryState(jobMeta),
    jobNumber: quoteFromModel.jobNumber || jobMeta?.jobNumber || null,
    quoteNumber: quoteFromModel.quoteNumber || jobMeta?.quoteNumber || null,
    moasureStatus: "parsed",
    moasureBatchCount: jobMeta?.moasureBatchCount || 0,
    moasureLatestBatchId: jobMeta?.moasureLatestBatchId || null,
    quoteIdentity: metaWithQuoteIdentity.quoteIdentity,
  };
}
