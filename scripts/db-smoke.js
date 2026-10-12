#!/usr/bin/env node
// Check Field's database without changing it: connect, run `select 1`, and
// report how many migrations are applied and pending. Applies nothing.
//
//   npm run db:smoke
//
// Uses the same selection as the server (server/db-runtime): FIELD_DB_URL or
// DATABASE_URL; else PGlite only if FIELD_PGLITE=1 (under the server's data
// directory: FIELD_DATA, then FIELD_CONFIG_JSON / config.json `dataDir`, then
// ./data) or FIELD_PGLITE_DIR. The connection string is never printed.
//
// Exit codes: 0 ok; 1 no database configured, unreachable, or not created yet;
// 2 migrations pending. A PGlite database that does not exist yet is reported,
// not created. PGlite allows one process per directory, so while the server
// has it open this reports "in use by process N" instead of checking it: use a
// PostgreSQL URL to check a running server's database.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadFieldConfig } from "../server/runtime-config.js";

const { checkDb, closeDb, resolveDbConfig } = await import("../server/db-runtime/index.js");

const repoRoot = join(import.meta.dirname, "..");
let exitCode = 0;
try {
  const { config: fieldConfig } = loadFieldConfig({ defaultPath: join(repoRoot, "config.json") });
  const dataDir = resolve(process.env.FIELD_DATA || fieldConfig.dataDir || join(repoRoot, "data"));
  const config = resolveDbConfig({ dataDir });
  if (config.driver === "none") {
    console.log(JSON.stringify({ ok: false, driver: "none", target: config.target, error: "no database configured: set DATABASE_URL or FIELD_DB_URL" }));
    exitCode = 1;
  } else if (config.driver === "pglite" && config.dir && !existsSync(config.dir)) {
    console.log(JSON.stringify({ ok: false, driver: "pglite", target: config.target, error: "no PGlite database here yet; the server creates it on first boot" }));
    exitCode = 1;
  } else {
    const status = await checkDb({ dataDir });
    console.log(JSON.stringify(status));
    if (status.migrations.pending > 0) exitCode = 2;
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
