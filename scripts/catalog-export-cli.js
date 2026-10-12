#!/usr/bin/env node
// Write the whole price catalogue (every catalogue table) as one JSON
// document: a manual backup to keep or diff. Restores come from PostgreSQL
// (Replit point-in-time restore).
//
//   npm run catalog:export -- [--out <file>]     (default: stdout)
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadFieldConfig } from "../server/runtime-config.js";
import { setDataRoot } from "../server/storage/write-recorder.js";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
const repoRoot = join(import.meta.dirname, "..");
const { config } = loadFieldConfig({ defaultPath: join(repoRoot, "config.json") });
setDataRoot(resolve(process.env.FIELD_DATA || config.dataDir || join(repoRoot, "data")));
const { closeDb, getDb } = await import("../server/db-runtime/index.js");
const { orgScope, resolveDeploymentOrg } = await import("../server/db-runtime/tenancy.js");
const { exportCatalog } = await import("../server/catalog/index.js");

let exitCode = 0;
try {
  // The deployment's organisation (FIELD_ORG, default embark): catalogue
  // tables are only readable inside an organisation's transaction.
  const org = await resolveDeploymentOrg(getDb());
  const payload = await exportCatalog(orgScope(getDb(), org.uid));
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outPath) {
    writeFileSync(resolve(outPath), text, { mode: 0o600 });
    console.error(`wrote catalogue version ${payload.catalogVersion} (${payload.counts.items} items) to ${resolve(outPath)}`);
  } else {
    process.stdout.write(text);
  }
} catch (error) {
  console.error(`catalogue export failed: ${error.message}`);
  exitCode = 1;
} finally {
  await closeDb().catch(() => {});
}
process.exit(exitCode);
