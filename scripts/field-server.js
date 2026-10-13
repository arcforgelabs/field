#!/usr/bin/env node
// Starts a Field server from an installed @arcforgelabs/field package, the
// way `npm start` does in a checkout: Sentry's instrumentation loads first,
// then server/index.js. Configure it with environment variables
// (docs/RELEASING.md, "Run a release"): FIELD_CONFIG_JSON or FIELD_CONFIG,
// FIELD_DATA, DATABASE_URL and FIELD_STORAGE=postgres.
import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const child = spawn(
  process.execPath,
  ["--import", join(root, "server/observability/instrument.js"), join(root, "server/index.js"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
