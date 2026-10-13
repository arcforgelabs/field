// What a server log line may say about a quote or invoice row that did not
// verify. Log lines reach Sentry Logs (server/observability/sentry.js), a
// third-party service, so they name the job and the issued document by uid
// and say what kind of mismatch it is: never a document number, an amount or
// a reason (reasons quote both). The owner sees the numbers inside Field: the
// data-migrations dry run (GET /api/admin/data-migrations/dry-run) and the
// invoice amount disagreements report.

const FIELD_NAMES = Object.freeze({ subtotal: "subtotal", taxTotal: "tax", total: "total", amountPaid: "amount paid" });

/**
 * One failure: "document <uid> milestone 1 totals: tax against revision-pdf".
 * `documentUid` is the issued document's uid; a numbered document Field holds
 * no issued record for (an older invoice) is "document (no uid)".
 */
export function describeRowFailure(failure, { documentUid = failure.issuedDocumentUid || null } = {}) {
  const where = [
    documentUid ? `document ${documentUid}` : failure.number ? "document (no uid)" : null,
    failure.version != null ? `v${failure.version}` : null,
    failure.milestone != null ? `milestone ${Number(failure.milestone) + 1}` : null,
  ].filter(Boolean).join(" ");
  const field = failure.field ? `: ${FIELD_NAMES[failure.field] || "other"}` : "";
  const against = failure.against ? ` against ${failure.against}` : "";
  // A code is from a fixed list (an unmappable milestone's, from-milestones.js).
  const code = failure.code ? ` (${failure.code})` : "";
  return `${where ? `${where} ` : ""}${failure.conflict || failure.kind || "mismatch"}${code}${field}${against}`;
}
