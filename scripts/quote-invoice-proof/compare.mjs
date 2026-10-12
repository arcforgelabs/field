// Compare two quote-invoice-proof output directories (see run.mjs).
// PDFs and .eml files must be byte-identical. JSON API responses are compared
// after masking wall-clock timestamps that come from filesystem mtimes; the
// server clock itself is frozen at 2026-01-15 by the deterministic preload.
//   node scripts/quote-invoice-proof/compare.mjs <beforeDir> <afterDir>
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const [beforeArg, afterArg] = process.argv.slice(2);
if (!beforeArg || !afterArg) {
  console.error("usage: compare.mjs <beforeDir> <afterDir>");
  process.exit(2);
}
const before = resolve(beforeArg);
const after = resolve(afterArg);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mask(entry)]));
  }
  if (typeof value === "string" && ISO.test(value) && !value.startsWith("2026-01-")) return "<wallclock>";
  return value;
}

const names = [...new Set([...readdirSync(before), ...readdirSync(after)])]
  // storage-* files are PROOF_STORAGE=postgres's own restart proof and sync-*
  // the catalogue-sync proof (run.mjs); each checks itself.
  .filter((name) => name !== "server.log" && name !== "MANIFEST.sha256" && !name.startsWith("storage-") && !name.startsWith("sync-"))
  .sort();
let mismatches = 0;
for (const name of names) {
  const a = join(before, name);
  const b = join(after, name);
  if (!existsSync(a) || !existsSync(b)) {
    console.log(`MISSING          ${name} before=${existsSync(a)} after=${existsSync(b)}`);
    mismatches += 1;
    continue;
  }
  const same = name.endsWith(".json")
    ? isDeepStrictEqual(mask(JSON.parse(readFileSync(a, "utf8"))), mask(JSON.parse(readFileSync(b, "utf8"))))
    : readFileSync(a).equals(readFileSync(b));
  const kind = name.endsWith(".json") ? (same ? "json-equal" : "JSON-DIFF") : (same ? "bytes-identical" : "BYTES-DIFF");
  const digest = createHash("sha256").update(readFileSync(b)).digest("hex").slice(0, 16);
  console.log(`${kind.padEnd(16)} ${digest}  ${name}`);
  if (!same) mismatches += 1;
}
console.log(`\n${names.length - mismatches}/${names.length} artefacts match`);
process.exit(mismatches ? 1 : 0);
