#!/usr/bin/env node
// Mirrors this repo's docs/ into the docs publish repo (arcforgelabs/docs),
// under docs/<product>/. The publish repo renders and hosts the site.
// Copied from openclaw/openclaw scripts/docs-sync-publish.mjs (MIT).
//
//   node scripts/docs-sync-publish.mjs --check
//   node scripts/docs-sync-publish.mjs --target ../docs --source-repo arcforgelabs/field --source-sha <sha>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DOCS = path.join(ROOT, "docs");
const PRODUCT = "field";

// Kept out of the mirror: agent notes and pull request screenshots.
const IGNORED_DIRS = new Set(["review", "node_modules"]);
const IGNORED_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

export function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) out.push(...walk(full, base));
    } else if (!IGNORED_FILES.has(entry.name)) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

// Same rule as the renderer: DATA_MODEL.md -> data-model, a/index.md -> a.
export function routeForFile(rel) {
  const route = rel
    .replace(/\.(md|mdx)$/i, "")
    .split("/")
    .map((part) => part.toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-"))
    .join("/");
  return route === "index" ? "" : route.replace(/\/index$/, "");
}

function navEntries(entries, out = []) {
  for (const entry of entries || []) {
    if (typeof entry === "string") out.push(entry === "index" ? "" : entry.replace(/^\/+|\/+$/g, "").replace(/\/index$/, ""));
    else if (entry?.pages) navEntries(entry.pages, out);
    else if (entry?.groups) navEntries(entry.groups, out);
  }
  return out;
}

// docs.json must parse, name only pages that exist, and list every page once.
export function checkDocs(docsDir = SOURCE_DOCS) {
  const errors = [];
  const files = walk(docsDir);
  const pages = new Set(files.filter((f) => /\.(md|mdx)$/i.test(f)).map(routeForFile));
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(docsDir, "docs.json"), "utf8"));
  } catch (error) {
    return { errors: [`docs/docs.json: ${error.message}`], files };
  }
  const listed = navEntries(config.navigation?.tabs);
  const seen = new Set();
  for (const route of listed) {
    if (!pages.has(route)) errors.push(`docs/docs.json names "${route}", but no page has that route`);
    if (seen.has(route)) errors.push(`docs/docs.json lists "${route}" twice`);
    seen.add(route);
  }
  for (const route of pages) {
    if (!seen.has(route) && !route.startsWith("releases/")) errors.push(`page "${route}" is not in docs/docs.json navigation`);
  }
  return { errors, files };
}

export function syncDocs({ target, sourceRepo, sourceSha, docsDir = SOURCE_DOCS, product = PRODUCT }) {
  const { errors, files } = checkDocs(docsDir);
  if (errors.length) throw new Error(errors.join("\n"));
  const dest = path.join(target, "docs", product);
  // Prune: the mirror holds exactly the source tree.
  fs.rmSync(dest, { recursive: true, force: true });
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(docsDir, rel), path.join(dest, rel));
  }
  const syncDir = path.join(target, ".arcforge-sync");
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, `${product}.json`), `${JSON.stringify({ repository: sourceRepo, sha: sourceSha }, null, 2)}\n`);
  return { product, files: files.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean" },
      target: { type: "string" },
      "source-repo": { type: "string", default: `arcforgelabs/${PRODUCT}` },
      "source-sha": { type: "string", default: "" },
    },
  });
  if (values.check) {
    const { errors, files } = checkDocs();
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log(`docs/ ok: ${files.length} files.`);
  } else {
    if (!values.target) throw new Error("pass --target <publish repo checkout>");
    const result = syncDocs({ target: values.target, sourceRepo: values["source-repo"], sourceSha: values["source-sha"] });
    console.log(`Mirrored ${result.files} files into docs/${result.product}/.`);
  }
}
