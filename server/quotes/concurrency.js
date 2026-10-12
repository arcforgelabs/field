// Optimistic concurrency for quote saves (#245). The editor saves through
// POST /api/jobs/:id/quote-update; it sends back, as If-Match, the rows'
// version it last read (X-Field-Quote-Rows-Version: "q<version>-<lock>").
// A save made against rows that have moved on since is refused with 412, so
// two people (or a person and an agent) cannot overwrite each other's edits
// without seeing them. A request without If-Match (the CLI, MCP, older
// clients) is not checked, as before.
import { quoteRowsVersionTag } from "./read-model.js";
import { quoteRowRecorder } from "./recorder.js";

export class QuoteRowsChangedError extends Error {
  constructor(message, { current = null } = {}) {
    super(message);
    this.name = "QuoteRowsChangedError";
    this.code = "QUOTE_ROWS_CHANGED";
    this.statusCode = 412;
    this.current = current;
  }
}

/** The current tag of a job's quote version, or null when there are no rows (or no database). */
export async function currentQuoteRowsTag({ jobId, version, service = null }) {
  const rows = service || (quoteRowRecorder().enabled ? quoteRowRecorder().service : null);
  if (!rows || !jobId || !(Number(version) > 0)) return null;
  const stored = await rows.getQuoteVersion(String(jobId), Number(version));
  return stored ? quoteRowsVersionTag(stored.quote) : null;
}

function normalizeTag(value) {
  return String(value || "").trim().replace(/^W\//, "");
}

/**
 * Refuse a save whose If-Match is not the current tag. Run it inside the
 * job's mutation lock, so no other save can land between the check and the
 * write. Without a database nothing is checked.
 */
export async function assertQuoteRowsIfMatch({ jobId, version, ifMatch, service = null }) {
  if (!ifMatch || normalizeTag(ifMatch) === "*") return;
  const rows = service || (quoteRowRecorder().enabled ? quoteRowRecorder().service : null);
  if (!rows) return;
  const current = await currentQuoteRowsTag({ jobId, version, service: rows });
  const wanted = normalizeTag(ifMatch).split(",").map((tag) => normalizeTag(tag));
  if (!current || !wanted.includes(current)) {
    throw new QuoteRowsChangedError("This quote was changed since you opened it. Reload it to see the changes before saving.", { current });
  }
}
