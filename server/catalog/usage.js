// "Used on N quotes" for the price book (#178): which jobs' quotes have a row
// priced from each catalogue item, by uid (rows name their item by uid since
// the step 3 re-key; older rows by a legacy code, resolved through the
// aliases). Counts direct rows only: an item used inside a kit is the kit's.
//
// Built by reading every job's current quote and saved versions from the
// data directory, then cached briefly: a price book showing counts for every
// row costs one scan, not one per row.
import { join } from "node:path";
import { readFileSync } from "../storage/fs.js";
import { resolveActiveJobGeneration } from "../job-generation.js";
import { listJobDirs, organizerOf, quoteFilePaths, rowItem } from "../quote-files.js";

const CACHE_MS = 30_000;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function versionOf(rel, document) {
  const match = /quote-versions[\\/]v0*(\d+)[\\/]/.exec(rel);
  if (match) return Number(match[1]);
  return Number(document?.version) || null;
}

/**
 * Map item uid -> Map job id -> { jobId, quoteNumber, title, versions:Set, current, sent, updatedAt }.
 */
export async function buildQuoteUsageIndex({ dataDir, state }) {
  const index = new Map();
  if (!dataDir) return index;
  for (const jobDir of listJobDirs(dataDir)) {
    const activeDir = await resolveActiveJobGeneration(jobDir);
    const meta = readJson(join(activeDir, "meta.json")) || readJson(join(jobDir, "meta.json")) || {};
    const jobId = meta.id || jobDir.split(/[\\/]/).pop();
    const paths = quoteFilePaths(activeDir);
    const documents = new Map(paths.map((rel) => [rel, readJson(join(activeDir, rel))]));
    for (const [rel, document] of documents) {
      const organizer = organizerOf(document);
      if (!organizer) continue;
      const quoteRel = rel.replace(/quote-overrides\.json$/, "quote.json");
      const quote = documents.get(quoteRel) || null;
      const lines = new Map((quote?.lineItems || []).filter((line) => line?.code).map((line) => [String(line.code).trim(), line]));
      const version = versionOf(rel, quote || document);
      const current = !rel.includes("quote-versions");
      const sent = Boolean(quote?.quoteSentAt || quote?.delivery?.status === "sent" || (version && Number(meta.lastSentQuoteVersion) === version));
      for (const node of Object.values(organizer.nodes)) {
        if (!node || node.kind !== "source") continue;
        const item = rowItem(state, node, lines);
        if (!item) continue;
        if (!index.has(item.uid)) index.set(item.uid, new Map());
        const jobs = index.get(item.uid);
        if (!jobs.has(jobId)) {
          jobs.set(jobId, {
            jobId,
            quoteNumber: quote?.quoteNumber || meta.quoteNumber || null,
            title: meta.title || null,
            versions: new Set(),
            current: false,
            sent: false,
            updatedAt: meta.updatedAt || quote?.updatedAt || null,
          });
        }
        const entry = jobs.get(jobId);
        if (version) entry.versions.add(version);
        entry.current ||= current;
        entry.sent ||= sent;
      }
    }
  }
  return index;
}

function jobRow(entry) {
  const versions = [...entry.versions].sort((a, b) => a - b);
  return {
    job_id: entry.jobId,
    quote_number: entry.quoteNumber,
    title: entry.title,
    versions,
    latest_version: versions.length ? versions[versions.length - 1] : null,
    on_current_quote: entry.current,
    sent: entry.sent,
    updated_at: entry.updatedAt,
  };
}

/** A usage reader with a short cache, for one store's data directory. */
export function createQuoteUsage({ dataDir, getState, clock = () => Date.now() }) {
  let cached = null;
  let building = null;
  async function index() {
    if (cached && clock() - cached.at < CACHE_MS) return cached;
    building ??= (async () => {
      const state = await getState();
      const built = { at: clock(), scannedAt: new Date(clock()).toISOString(), index: await buildQuoteUsageIndex({ dataDir, state }) };
      cached = built;
      return built;
    })().finally(() => { building = null; });
    return building;
  }
  return {
    /** { item_uid, quote_count, version_count, jobs: latest first, at most `limit`, scanned_at }. */
    async forItem(uid, { limit = 5 } = {}) {
      const { index: byItem, scannedAt } = await index();
      const jobs = [...(byItem.get(uid)?.values() || [])].map(jobRow)
        .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || String(b.quote_number || "").localeCompare(String(a.quote_number || "")));
      return {
        item_uid: uid,
        quote_count: jobs.length,
        version_count: jobs.reduce((sum, job) => sum + job.versions.length, 0),
        jobs: jobs.slice(0, Math.max(0, Number(limit) || 0)),
        scanned_at: scannedAt,
      };
    },
    /** { items: { uid: { quote_count, version_count } }, scanned_at } for every used item. */
    async counts() {
      const { index: byItem, scannedAt } = await index();
      const items = {};
      for (const [uid, jobs] of byItem) {
        const rows = [...jobs.values()];
        items[uid] = { quote_count: rows.length, version_count: rows.reduce((sum, row) => sum + row.versions.size, 0) };
      }
      return { items, scanned_at: scannedAt };
    },
    invalidate() { cached = null; },
  };
}
