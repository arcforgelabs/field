// Quote reads from rows (#245, quotes as rows part two). The quote PDF, the
// quote email's totals, the job's cached totals and the job detail's
// customer pricing (which the client and the MCP quote tool read) take their
// schedule and totals from here:
//
//   1. the version's rows in the database, when they are current: written
//      from the same files (their source digest matches) under the current
//      mapping, which only writes rows that print exactly what the files
//      print (sync.js)
//   2. otherwise the rows the files map to (from-artifact.js), the same rows
//      the dual-write stores, when they print exactly what the files print:
//      a quote being built or sent renders before its rows are committed
//   3. otherwise today's renderer over the files
//
// FIELD_QUOTE_READS=files makes every read take 3, for rollback. Each read is
// counted by source, and a read that falls back to the files says why, under
// `quoteReads` in GET /api/storage/status.
import { getCustomerPresentationFinancials, getCustomerScheduleItems } from "../quote-presentation.js";
import { mapQuoteArtifact } from "./from-artifact.js";
import { quoteSourceDigest } from "./job-quotes.js";
import { quoteRowRecorder } from "./recorder.js";
import { financialsFromRows, scheduleFromRows } from "./schedule.js";

const counters = { database: 0, mapped: 0, files: 0, lastFallback: null };

export function quoteReadsMode(env = process.env) {
  return String(env.FIELD_QUOTE_READS || "rows").trim().toLowerCase() === "files" ? "files" : "rows";
}

export function quoteReadsStatus() {
  return { mode: quoteReadsMode(), ...counters, lastFallback: counters.lastFallback ? { ...counters.lastFallback } : null };
}

function fromFiles(quote, reason, { jobId = null, version = null, differences = null } = {}) {
  counters.files += 1;
  if (reason) counters.lastFallback = { at: new Date().toISOString(), jobId, version, reason, ...(differences ? { differences: differences.slice(0, 3) } : {}) };
  return {
    source: "files",
    reason,
    items: getCustomerScheduleItems(quote),
    financials: getCustomerPresentationFinancials(quote),
    rows: null,
  };
}

function fromMapped(quote, meta) {
  const mapped = mapQuoteArtifact({ quote, meta });
  if (!mapped.printable) return { unprintable: mapped.printDifferences || [], legacy: mapped.legacy };
  counters.mapped += 1;
  return {
    source: "mapped",
    reason: null,
    items: scheduleFromRows(mapped),
    financials: financialsFromRows(mapped),
    rows: mapped,
  };
}

/**
 * The quote's schedule and totals from its rows, without the database (for
 * callers that cannot wait on it): the mapping of the files when it prints
 * what the files print, else the files.
 */
export function quoteRowsFromArtifact({ quote, meta = null }) {
  if (!quote || typeof quote !== "object") return fromFiles(quote, null);
  if (quoteReadsMode() === "files") return fromFiles(quote, null);
  try {
    const view = fromMapped(quote, meta);
    if (!view.unprintable) return view;
    const reason = view.legacy ? "a quote with no organizer prints from its files" : "the rows would not print what the files print";
    return fromFiles(quote, reason, { jobId: meta?.id, version: quote.version, differences: view.unprintable });
  } catch (error) {
    return fromFiles(quote, `mapping failed: ${error.message}`, { jobId: meta?.id, version: quote.version });
  }
}

/** Whether stored rows were written from these files, under the current mapping. */
function isCurrent(stored, { quote, meta }) {
  const digest = stored?.quote?.sourceDigest;
  if (!digest) return false;
  if (quoteSourceDigest({ quote, meta }) === digest) return true;
  const customer = stored.quote.customer && Object.keys(stored.quote.customer).length ? stored.quote.customer : null;
  return Boolean(customer) && quoteSourceDigest({ quote, meta, customer }) === digest;
}

/**
 * The quote's schedule and totals from its rows: the database when its rows
 * are current, else as quoteRowsFromArtifact. Returns { source, items,
 * financials, rows, versionTag } where `versionTag` is the stored rows'
 * optimistic-concurrency tag (null when they did not come from the database).
 */
export async function loadQuoteRows({ quote, meta = null, service = null }) {
  if (!quote || typeof quote !== "object" || quoteReadsMode() === "files") return quoteRowsFromArtifact({ quote, meta });
  const rowsService = service || (quoteRowRecorder().enabled ? quoteRowRecorder().service : null);
  const jobId = meta?.id ? String(meta.id) : null;
  const version = Number(quote.version);
  if (rowsService && jobId && Number.isInteger(version) && version > 0) {
    try {
      const stored = await rowsService.getQuoteVersion(jobId, version);
      if (stored && isCurrent(stored, { quote, meta })) {
        counters.database += 1;
        return {
          source: "database",
          reason: null,
          items: scheduleFromRows(stored),
          financials: financialsFromRows({ totals: stored.quote, lines: stored.lines }),
          rows: stored,
          versionTag: quoteRowsVersionTag(stored.quote),
        };
      }
    } catch (error) {
      counters.lastFallback = { at: new Date().toISOString(), jobId, version, reason: `database read failed: ${error.message}` };
    }
  }
  return { ...quoteRowsFromArtifact({ quote, meta }), versionTag: null };
}

/** The tag a client sends back as If-Match: the version and its optimistic-concurrency counter. */
export function quoteRowsVersionTag(quoteRow) {
  if (!quoteRow) return null;
  return `"q${quoteRow.version}-${quoteRow.versionLock}"`;
}
