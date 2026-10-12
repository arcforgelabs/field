// Guards against a server module calling a name that is never declared or
// imported (e.g. an import trimmed too far). Node only fails on these when the
// line runs, so the test suite can miss them.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const UNDEFINED_NAME_CODES = new Set([2304, 2552, 2305, 2724]);

function serverSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "db" ? [] : serverSources(path);
    return entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") ? [path] : [];
  });
}

test("server modules reference only declared or imported names", () => {
  const program = ts.createProgram(serverSources(join(ROOT, "server")), {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  });
  const problems = ts.getPreEmitDiagnostics(program)
    .filter((d) => UNDEFINED_NAME_CODES.has(d.code) && d.file && !d.file.fileName.includes("node_modules"))
    .map((d) => {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${d.file.fileName.replace(ROOT + "/", "")}:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
  assert.deepEqual(problems, []);
});
