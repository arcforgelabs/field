#!/usr/bin/env node
// The price-equality gate (pricing engine phase 1, server/catalog/price.js): record
// every catalogue item's price, then check after a change that nothing moved.
// Read-only: it never writes to the database.
//
//   npm run catalog:price-gate -- --capture <file>    write every item's cost and sell
//   npm run catalog:price-gate -- --compare <file>    exit 1 if any item prices differently
//
// The target is the server's database (DATABASE_URL / FIELD_DB_URL) and the
// deployment's organisation (FIELD_ORG, default embark).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadFieldConfig } from "../server/runtime-config.js";
import { setDataRoot } from "../server/storage/write-recorder.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const capturePath = flag("--capture");
const comparePath = flag("--compare");
if (!capturePath === !comparePath) {
  console.error("usage: catalog-price-gate-cli.js --capture <file> | --compare <file>");
  process.exit(2);
}
const repoRoot = join(import.meta.dirname, "..");
const { config } = loadFieldConfig({ defaultPath: join(repoRoot, "config.json") });
setDataRoot(resolve(process.env.FIELD_DATA || config.dataDir || join(repoRoot, "data")));
const { closeDb, getDb } = await import("../server/db-runtime/index.js");
const { orgScope, resolveDeploymentOrg } = await import("../server/db-runtime/tenancy.js");
const { loadCatalogState } = await import("../server/catalog/state.js");
const { capturePrices, comparePrices } = await import("../server/catalog/price.js");

let exitCode = 0;
try {
  const org = await resolveDeploymentOrg(getDb());
  const state = await loadCatalogState(orgScope(getDb(), org.uid));
  const now = capturePrices(state);
  if (capturePath) {
    writeFileSync(resolve(capturePath), `${JSON.stringify(now, null, 2)}\n`, { mode: 0o600 });
    console.error(`recorded ${Object.keys(now.items).length} item prices at catalogue version ${now.catalogVersion} to ${resolve(capturePath)}`);
  } else {
    const before = JSON.parse(readFileSync(resolve(comparePath), "utf8"));
    const result = comparePrices(before, now);
    for (const row of result.changed) console.log(JSON.stringify(row));
    console.error(result.ok
      ? `price gate OK: ${result.compared} items price the same (catalogue version ${before.catalogVersion} -> ${now.catalogVersion})`
      : `price gate FAILED: ${result.changed.length} of ${result.compared} items changed`);
    if (!result.ok) exitCode = 1;
  }
} catch (error) {
  console.error(`price gate failed: ${error.message}`);
  exitCode = 2;
} finally {
  await closeDb().catch(() => {});
}
process.exit(exitCode);
