// Where a job's quote rows live on disk, and how a row names its catalogue
// item. Shared by the uid re-key (data-migrations/quote-rows-by-uid.js) and
// the price book's "used on N quotes" (catalog/usage.js).
//
// A job is <dataDir>/<date>/<job>/ holding a meta.json (as field-db's sync
// finds them). Its current quote and every saved version keep their rows in
// the organizer of quote.json and quote-overrides.json, in the job's active
// generation (job-generation.js).
import { join } from "node:path";
import { existsSync, readdirSync } from "./storage/fs.js";
import { findItem } from "./catalog/state.js";

export const QUOTE_FILES = ["quote.json", "quote-overrides.json"];
export const QUOTE_VERSIONS_DIR = "quote-versions";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function listJobDirs(dataDir) {
  const jobs = [];
  let dateDirs = [];
  try { dateDirs = readdirSync(dataDir, { withFileTypes: true }); } catch { return jobs; }
  for (const dateEntry of dateDirs) {
    if (!dateEntry.isDirectory() || dateEntry.name.startsWith(".")) continue;
    const datePath = join(dataDir, dateEntry.name);
    let jobEntries = [];
    try { jobEntries = readdirSync(datePath, { withFileTypes: true }); } catch { continue; }
    for (const jobEntry of jobEntries) {
      if (!jobEntry.isDirectory() || jobEntry.name.startsWith(".")) continue;
      const jobDir = join(datePath, jobEntry.name);
      if (existsSync(join(jobDir, "meta.json"))) jobs.push(jobDir);
    }
  }
  return jobs.sort();
}

/** quote.json and quote-overrides.json of the current quote and every saved version, relative to `baseDir`. */
export function quoteFilePaths(baseDir) {
  const paths = QUOTE_FILES.filter((name) => existsSync(join(baseDir, name)));
  const versionsDir = join(baseDir, QUOTE_VERSIONS_DIR);
  if (existsSync(versionsDir)) {
    for (const entry of readdirSync(versionsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      for (const name of QUOTE_FILES) {
        const rel = join(QUOTE_VERSIONS_DIR, entry.name, name);
        if (existsSync(join(baseDir, rel))) paths.push(rel);
      }
    }
  }
  return paths;
}

export function organizerOf(document) {
  const organizer = document?.presentation?.organizer;
  return organizer && typeof organizer === "object" && organizer.nodes && typeof organizer.nodes === "object" ? organizer : null;
}

export function originOf(node) {
  const origin = text(node?.origin);
  if (origin) return origin;
  const sourceKind = text(node?.sourceKind);
  if (sourceKind === "manual") return "manual";
  if (sourceKind === "generated_component") return "generated";
  return "engine";
}

/** The catalogue item code an engine line was priced from. */
export function lineItemCode(line) {
  const entry = line?.quoteCatalogEntry && typeof line.quoteCatalogEntry === "object" ? line.quoteCatalogEntry : null;
  return text(entry?.authorityItemCode) || text(line?.authorityItemCode) || text(line?.quoteCatalogItemCode);
}

/**
 * The catalogue item a row is priced from, uid first: catalogItemUid, then
 * sourceUid, then the row's legacy code (catalogItemCode, or for an engine
 * row its line's item code) through the aliases. Null for a typed row.
 */
export function rowItem(state, node, lines = new Map()) {
  for (const uid of [text(node?.catalogItemUid), text(node?.sourceUid)]) {
    if (uid && state.items.has(uid)) return state.items.get(uid);
  }
  const code = text(node?.catalogItemCode) || (originOf(node) === "engine" ? lineItemCode(lines.get(text(node?.sourceCode))) : "");
  return code ? findItem(state, code) : null;
}
