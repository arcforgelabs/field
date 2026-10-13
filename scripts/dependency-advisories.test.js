// Guards for the dependency advisories handled in the lockfiles, so a later
// install cannot bring them back unnoticed.
//
// GHSA-67mh-4wv8-2f99 (esbuild <= 0.24.2: its development server answers any
// website). drizzle-kit's @esbuild-kit loader pinned esbuild 0.18; the root
// package.json overrides it to ^0.25.12. Field never runs esbuild's server.
//
// GHSA-vfj7-8cjw-p6xm (braces <= 3.0.3, no fixed release yet: deeply nested
// patterns exhaust the stack). It reaches the client only through the shadcn
// command-line tool, which a developer runs with fixed patterns; the shipped
// bundle imports only shadcn/tailwind.css. shadcn is a development
// dependency, so nothing of its tree is a runtime dependency of the client.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const lock = (path) => JSON.parse(readFileSync(resolve(ROOT, path), "utf8")).packages;

function versionAtLeast(version, minimum) {
  const a = String(version).split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== b[index]) return (a[index] || 0) > b[index];
  }
  return true;
}

test("every esbuild in the server lockfile is 0.25.0 or later (GHSA-67mh-4wv8-2f99)", () => {
  const esbuilds = Object.entries(lock("package-lock.json"))
    .filter(([path]) => path === "node_modules/esbuild" || path.endsWith("/node_modules/esbuild"));
  assert.ok(esbuilds.length > 0);
  for (const [path, entry] of esbuilds) {
    assert.ok(versionAtLeast(entry.version, "0.25.0"), `${path} is esbuild ${entry.version}`);
  }
});

test("braces in the client lockfile is only a development dependency (GHSA-vfj7-8cjw-p6xm)", () => {
  const packages = lock("client/package-lock.json");
  const client = JSON.parse(readFileSync(resolve(ROOT, "client/package.json"), "utf8"));
  assert.equal(client.dependencies?.shadcn, undefined, "shadcn is a development dependency");
  assert.ok(client.devDependencies?.shadcn);
  const braces = Object.entries(packages)
    .filter(([path]) => path === "node_modules/braces" || path.endsWith("/node_modules/braces"));
  for (const [path, entry] of braces) {
    if (versionAtLeast(entry.version, "3.0.4")) continue;
    assert.equal(entry.dev, true, `${path} (braces ${entry.version}) must not be a runtime dependency`);
  }
});
