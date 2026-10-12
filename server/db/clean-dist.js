import { readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 2) {
  throw new Error("server/db/clean-dist.js does not accept deletion-target arguments");
}

const dbRoot = normalize(dirname(fileURLToPath(import.meta.url)));
const tsconfigPath = resolve(dbRoot, "tsconfig.json");
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
const configuredOutDir = tsconfig.compilerOptions?.outDir;

if (typeof configuredOutDir !== "string" || configuredOutDir.trim() === "") {
  throw new Error(`Missing compilerOptions.outDir in ${tsconfigPath}`);
}
if (isAbsolute(configuredOutDir)) {
  throw new Error(`compilerOptions.outDir must be relative to ${dbRoot}`);
}

const normalizedOutDir = normalize(resolve(dbRoot, configuredOutDir));
const expectedOutDir = normalize(resolve(dbRoot, "dist"));
const relativeOutDir = relative(dbRoot, normalizedOutDir);

if (
  normalizedOutDir !== expectedOutDir ||
  relativeOutDir !== "dist" ||
  relativeOutDir.startsWith(`..${sep}`) ||
  isAbsolute(relativeOutDir)
) {
  throw new Error(
    `Refusing to clean compiler output outside the exact ${expectedOutDir} child directory`,
  );
}

rmSync(expectedOutDir, { recursive: true, force: true });
