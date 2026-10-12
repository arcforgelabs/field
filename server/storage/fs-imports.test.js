// Every server module reaches the filesystem through server/storage/fs.js or
// fs-promises.js, so writes under the data root can be recorded (#139). A
// direct node:fs import would bypass that silently, so this guard fails on one.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SHIM = new Set(["server/storage/fs.js", "server/storage/fs-promises.js"]);
// Build tools that never run in the server process. clean-dist.js runs in the
// Docker image's dependency stage, which copies only server/db.
const BUILD_TOOLS = new Set(["server/db/clean-dist.js"]);
const SOURCE = /\.(?:m?js|cjs|ts)$/;
const TEST_FILE = /\.test\.(?:m?js|cjs|ts)$/;
const SKIP_DIRS = new Set(["node_modules", "dist"]);

// import ... from "fs", import "fs", import("fs"), require("fs"), and the
// node: and /promises forms of each.
const DIRECT_FS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])(?:node:)?fs(?:\/promises)?\1/;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g;

const rel = (path) => relative(ROOT, path).split("\\").join("/");

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    return SOURCE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

test("the direct-fs pattern catches every import form", () => {
  for (const line of [
    'import { readFile } from "node:fs/promises";',
    "import { existsSync } from 'fs';",
    'import * as fs from "node:fs";',
    'import fs from "fs/promises";',
    'import "node:fs";',
    'const fs = await import("node:fs");',
    'const fs = require("fs");',
    'export { readFile } from "node:fs/promises";',
  ]) assert.match(line, DIRECT_FS, line);
  for (const line of [
    'import { readFile } from "./storage/fs-promises.js";',
    'import { fs } from "./fs-helpers.js";',
    'import { x } from "node:fsevents";',
  ]) assert.doesNotMatch(line, DIRECT_FS, line);
});

test("server modules import fs only through the storage shim", () => {
  const offenders = sourceFiles(join(ROOT, "server"))
    .filter((path) => !SHIM.has(rel(path)) && !BUILD_TOOLS.has(rel(path)) && DIRECT_FS.test(readFileSync(path, "utf8")))
    .map(rel);
  assert.deepEqual(offenders, []);
});

// Scripts the server loads at runtime (e.g. the verification reset) live
// outside server/, so also walk the server's import graph from its entry point.
test("nothing the server process loads imports fs directly", () => {
  const seen = new Set();
  const offenders = [];
  const pending = [join(ROOT, "server/index.js")];
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    if (!SHIM.has(rel(path)) && DIRECT_FS.test(source)) offenders.push(rel(path));
    for (const [, , specifier] of source.matchAll(RELATIVE_IMPORT)) {
      const target = resolve(dirname(path), specifier);
      if (SOURCE.test(target) && existsSync(target)) pending.push(target);
    }
  }
  assert.ok(seen.size > 50, `walked only ${seen.size} modules from server/index.js`);
  assert.deepEqual(offenders, []);
});
