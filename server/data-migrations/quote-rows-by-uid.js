// Code retirement step 3: quote rows keyed by uid.
//
// Organizer rows name their catalogue item two ways: catalogue-linked rows by
// `catalogItemUid` with `catalogItemCode` beside it (rows linked before uids
// existed have only the code), and engine rows by `sourceCode`, the quote
// line they show (whose catalogue item is the line's authorityItemCode). This
// migration records the uid next to the code on every row of every job's
// current quote and saved versions:
//
//   catalogItemUid   on a catalogue-linked row that has only a code;
//   sourceUid        on every row whose catalogue item can be resolved: the
//                    linked item for a catalogue row, the line's item for an
//                    engine row.
//
// Codes stay on the rows as history. Nothing else in any file changes, and
// nothing is recomputed: a value already on a row is never touched.
//
// Verified before anything is written, per changed file:
//   - removing the added keys gives back the file exactly as it was;
//   - each added uid is the item the row's code resolves to today (codes are
//     permanent aliases, migration 0006);
//   - the quote renders to the same PDF bytes, and its pricing output digest
//     and commercial checks are unchanged.
// After writing, the job's new generation is read back: changed files hold
// exactly the planned content and every other file (issued PDFs among them)
// is byte-identical to the generation before.
//
// Each job is written as a new commercial generation (job-generation.js), so
// the previous generation keeps the files as they were. With durable storage
// the generations are stored in one flush after the last job: all of the
// migration reaches PostgreSQL, or none of it.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join, relative } from "node:path";
import { readdirSync, readFileSync } from "../storage/fs.js";
import { writeFile } from "../storage/fs-promises.js";
import { findItem } from "../catalog/state.js";
import { resolveActiveJobGeneration, runAtomicJobGeneration } from "../job-generation.js";
import { generateQuotePdfBuffer } from "../quote-artifacts.js";
import { buildQuotePricingOutputDigest, validateQuoteCommercialArtifact } from "../quote-pricing-attestation.js";
import { lineItemCode, listJobDirs, organizerOf, originOf, quoteFilePaths } from "../quote-files.js";
import { DataMigrationError } from "./errors.js";

const ID = "2026-10-12-quote-rows-by-uid";
// Fixed so two renderings of one quote can be compared byte for byte.
const PDF_COMPARE_DATE = new Date("2026-01-01T00:00:00.000Z");

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The uids to add to one quote document's organizer rows. Pure: returns
 * { document (a copy, or the same object when nothing changes), changes, unresolved }.
 * `lineItems` are the sibling quote.json's lines (an overrides file has none of its own).
 */
export function rekeyQuoteDocument(state, document, { lineItems = null } = {}) {
  const organizer = organizerOf(document);
  if (!organizer) return { document, changes: [], unresolved: [] };
  const lines = new Map((lineItems || document?.lineItems || []).filter((line) => text(line?.code)).map((line) => [text(line.code), line]));
  const changes = [];
  const unresolved = [];
  let next = null;
  for (const [nodeId, node] of Object.entries(organizer.nodes)) {
    if (!node || node.kind !== "source") continue;
    const added = {};
    let catalogUid = text(node.catalogItemUid);
    const linkedCode = text(node.catalogItemCode);
    if (!catalogUid && linkedCode) {
      const item = findItem(state, linkedCode);
      if (item) {
        added.catalogItemUid = item.uid;
        catalogUid = item.uid;
        changes.push({ nodeId, field: "catalogItemUid", code: linkedCode, uid: item.uid, name: item.name });
      } else {
        unresolved.push({ nodeId, field: "catalogItemUid", code: linkedCode });
      }
    }
    if (!text(node.sourceUid)) {
      let uid = catalogUid || null;
      let code = linkedCode || null;
      if (!uid && originOf(node) === "engine") {
        code = lineItemCode(lines.get(text(node.sourceCode))) || null;
        const item = code ? findItem(state, code) : null;
        if (item) uid = item.uid;
        else if (code) unresolved.push({ nodeId, field: "sourceUid", code });
      }
      if (uid) {
        added.sourceUid = uid;
        changes.push({ nodeId, field: "sourceUid", code, uid, name: state.items.get(uid)?.name || null });
      }
    }
    if (Object.keys(added).length) {
      next = next || structuredClone(document);
      Object.assign(next.presentation.organizer.nodes[nodeId], added);
    }
  }
  return { document: next || document, changes, unresolved };
}

/** `after` with the keys a plan added removed: must equal `before` exactly. */
function withoutAdded(after, changes) {
  const copy = structuredClone(after);
  for (const change of changes) delete copy.presentation.organizer.nodes[change.nodeId][change.field];
  return copy;
}

function serialize(document, beforeText) {
  return `${JSON.stringify(document, null, 2)}${beforeText.endsWith("\n") ? "\n" : ""}`;
}

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  return { raw, json: JSON.parse(raw) };
}

/** Every file of a generation (or legacy job root) with its SHA-256, relative paths. */
function fileHashes(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      out.set(relative(dir, abs), sha256(readFileSync(abs)));
    }
  };
  walk(dir);
  return out;
}

async function renderPdf(meta, quote) {
  try {
    return { bytes: await generateQuotePdfBuffer({ meta, quote, documentType: "quote", creationDate: PDF_COMPARE_DATE }) };
  } catch (error) {
    return { error: error.message };
  }
}

async function plan(context) {
  const state = await context.getState();
  const jobs = [];
  const unresolved = [];
  let filesScanned = 0;
  let rowsScanned = 0;
  for (const jobDir of listJobDirs(context.dataDir)) {
    context.signal?.throwIfAborted();
    const activeDir = await resolveActiveJobGeneration(jobDir);
    const files = [];
    const paths = quoteFilePaths(activeDir);
    const quoteLines = new Map();
    for (const rel of paths.filter((path) => path.endsWith("quote.json"))) {
      try { quoteLines.set(join(rel, ".."), readJson(join(activeDir, rel)).json?.lineItems || []); } catch { /* reported below */ }
    }
    for (const rel of paths) {
      filesScanned += 1;
      let before;
      try {
        before = readJson(join(activeDir, rel));
      } catch (error) {
        throw new Error(`${relative(context.dataDir, join(activeDir, rel))} is not readable JSON: ${error.message}`);
      }
      rowsScanned += Object.values(organizerOf(before.json)?.nodes || {}).filter((node) => node?.kind === "source").length;
      const result = rekeyQuoteDocument(state, before.json, { lineItems: rel.endsWith("quote.json") ? null : quoteLines.get(join(rel, "..")) });
      for (const row of result.unresolved) unresolved.push({ job: relative(context.dataDir, jobDir), file: rel, ...row });
      if (!result.changes.length) continue;
      files.push({ rel, beforeText: before.raw, before: before.json, after: result.document, changes: result.changes });
    }
    if (files.length) jobs.push({ jobDir, activeDir, files });
  }
  const changes = jobs.flatMap((job) => job.files.flatMap((file) => file.changes.map((change) => ({
    job: relative(context.dataDir, job.jobDir),
    file: file.rel,
    ...change,
  }))));
  return { catalogVersion: state.version, jobs, changes, unresolved, filesScanned, rowsScanned, verification: null };
}

async function verify(context, planned) {
  const state = await context.getState();
  const failures = [];
  let pdfsCompared = 0;
  let pdfsUnrenderable = 0;
  for (const job of planned.jobs) {
    context.signal?.throwIfAborted();
    const meta = (() => {
      for (const dir of [job.activeDir, job.jobDir]) {
        try { return readJson(join(dir, "meta.json")).json; } catch { /* next */ }
      }
      return {};
    })();
    for (const file of job.files) {
      const where = `${relative(context.dataDir, job.jobDir)}/${file.rel}`;
      if (!isDeepStrictEqual(withoutAdded(file.after, file.changes), file.before)) {
        failures.push(`${where}: something other than the added uids would change`);
      }
      for (const change of file.changes) {
        const item = state.items.get(change.uid);
        if (!item) failures.push(`${where} ${change.nodeId}: ${change.uid} is not a catalogue item`);
        else if (change.code && findItem(state, change.code)?.uid !== change.uid) {
          failures.push(`${where} ${change.nodeId}: ${change.code} does not resolve to ${change.uid}`);
        }
      }
      if (!file.rel.endsWith("quote.json")) continue;
      if (buildQuotePricingOutputDigest(file.before) !== buildQuotePricingOutputDigest(file.after)) {
        failures.push(`${where}: the pricing output digest would change`);
      }
      const issuesBefore = validateQuoteCommercialArtifact(file.before).map((issue) => issue.code).sort();
      const issuesAfter = validateQuoteCommercialArtifact(file.after).map((issue) => issue.code).sort();
      if (!isDeepStrictEqual(issuesBefore, issuesAfter)) failures.push(`${where}: the commercial checks would change`);
      const [pdfBefore, pdfAfter] = [await renderPdf(meta, file.before), await renderPdf(meta, file.after)];
      if (pdfBefore.error || pdfAfter.error) {
        if (pdfBefore.error !== pdfAfter.error) failures.push(`${where}: rendering differs (${pdfBefore.error || "renders"} vs ${pdfAfter.error || "renders"})`);
        else pdfsUnrenderable += 1;
      } else if (!pdfBefore.bytes.equals(pdfAfter.bytes)) {
        failures.push(`${where}: the quote PDF would not be byte-identical`);
      } else {
        pdfsCompared += 1;
      }
    }
  }
  planned.verification = { ok: failures.length === 0, failures, pdfsCompared, pdfsUnrenderable };
  if (failures.length) {
    throw new DataMigrationError(`${ID}: verification failed, nothing written: ${failures.slice(0, 5).join("; ")}${failures.length > 5 ? ` (+${failures.length - 5} more)` : ""}`, { details: { failures } });
  }
  return planned.verification;
}

async function apply(context, planned) {
  for (const job of planned.jobs) {
    const previous = fileHashes(job.activeDir);
    await runAtomicJobGeneration(job.jobDir, async (stagedDir) => {
      for (const file of job.files) {
        const path = join(stagedDir, file.rel);
        if (readFileSync(path, "utf8") !== file.beforeText) {
          throw new DataMigrationError(`${ID}: ${relative(context.dataDir, job.jobDir)}/${file.rel} changed after it was planned; nothing written for this job`);
        }
        await writeFile(path, serialize(file.after, file.beforeText));
      }
    }, { flush: false });
    // Read back what was published.
    const activeDir = await resolveActiveJobGeneration(job.jobDir);
    const now = fileHashes(activeDir);
    const changed = new Set(job.files.map((file) => file.rel));
    for (const file of job.files) {
      const written = readJson(join(activeDir, file.rel)).json;
      if (!isDeepStrictEqual(written, file.after)) throw new DataMigrationError(`${ID}: ${relative(context.dataDir, job.jobDir)}/${file.rel} does not hold what was planned after writing`);
    }
    // A job still in the legacy layout (no generations) gets its first
    // generation, which holds only the commercial files of its root.
    const legacyRoot = job.activeDir === job.jobDir;
    for (const [rel, hash] of previous) {
      if (changed.has(rel) || rel === ".field-generation-commit.json") continue;
      if (legacyRoot && !now.has(rel)) continue;
      if (now.get(rel) !== hash) throw new DataMigrationError(`${ID}: ${relative(context.dataDir, job.jobDir)}/${rel} changed although it was not part of the migration`);
    }
  }
  return { recorded: false };
}

function summarize(planned) {
  const count = (field) => planned.changes.filter((change) => change.field === field).length;
  return {
    changed: planned.changes.length,
    jobs: planned.jobs.length,
    files: planned.jobs.reduce((sum, job) => sum + job.files.length, 0),
    catalogItemUid: count("catalogItemUid"),
    sourceUid: count("sourceUid"),
    unresolved: planned.unresolved.length,
    filesScanned: planned.filesScanned,
    rowsScanned: planned.rowsScanned,
    catalogVersion: planned.catalogVersion,
    pdfsCompared: planned.verification?.pdfsCompared ?? null,
    pdfsUnrenderable: planned.verification?.pdfsUnrenderable ?? null,
  };
}

function describe(summary) {
  return `${summary.catalogItemUid} catalogItemUid and ${summary.sourceUid} sourceUid added on ${summary.files} file(s) in ${summary.jobs} job(s); ${summary.pdfsCompared} PDF(s) byte-identical; ${summary.unresolved} row(s) left as they were (code not in the catalogue)`;
}

export const quoteRowsByUid = Object.freeze({
  id: ID,
  title: "Quote rows keyed by uid (code retirement step 3)",
  plan,
  verify,
  apply,
  summarize,
  describe,
});

// Exposed for tests.
export { listJobDirs, quoteFilePaths, withoutAdded };
