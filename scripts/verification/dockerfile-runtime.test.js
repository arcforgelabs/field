import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const importPattern = /(?:from|import)\s*\(\s*['"](\.[^'"]+)['"]\s*\)|from\s+['"](\.[^'"]+)['"]/g;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

function finalStageCopies(text) {
  const stages = text.split(/^FROM /m).slice(1);
  const finalStage = stages.at(-1) || "";
  const copies = [];
  for (const line of finalStage.split(/\n/)) {
    const match = line.match(/^COPY(?:\s+--from=\S+)?\s+(.+)$/);
    if (!match) continue;
    const parts = match[1].trim().split(/\s+/);
    copies.push(parts.at(-1).replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return copies;
}

function covers(copies, relativePath) {
  return copies.some((copy) => relativePath === copy || relativePath.startsWith(`${copy}/`) || copy.startsWith(`${relativePath}/`));
}

test("runtime image copies every extra-server module Field imports at boot", () => {
  const copies = finalStageCopies(dockerfile);
  assert.ok(copies.includes("server"), "final image must copy server/");
  const missing = [];
  for (const file of walk(join(root, "server"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] || match[2];
      const resolved = resolve(dirname(file), specifier);
      if (!resolved.startsWith(`${root}/`) || resolved.startsWith(`${root}/server/`)) continue;
      let path = resolved;
      if (!path.endsWith(".js")) {
        if (statSync(`${path}.js`, { throwIfNoEntry: false })) path = `${path}.js`;
        else if (statSync(join(path, "index.js"), { throwIfNoEntry: false })) path = join(path, "index.js");
      }
      const relativePath = relative(root, path);
      if (isAbsolute(relativePath) || relativePath.startsWith("..")) continue;
      if (!covers(copies, relativePath)) missing.push(`${relative(root, file)} -> ${relativePath}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(
    copies.some((copy) => copy === "server" || copy.startsWith("server/")),
    "the MCP pricing core (server/mcp/quoting-core.js) must be in the runtime image",
  );
});
