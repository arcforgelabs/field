#!/usr/bin/env node
// Starts a Field server from an installed @arcforgelabs/field package, the
// way `npm start` does in a checkout: Sentry's instrumentation loads first,
// then server/index.js. Configure it with environment variables
// (docs/SELF_HOSTING.md): FIELD_CONFIG_JSON or FIELD_CONFIG,
// FIELD_DATA, DATABASE_URL and FIELD_STORAGE=postgres.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseReleaseTag } from "../server/release-channel.js";

const root = join(import.meta.dirname, "..");
// A published package's version is its release (2026.10.15 or
// 2026.10.15-beta.2); GET /health shows it as build.release.
const env = { ...process.env };
if (!env.FIELD_RELEASE) {
  const release = parseReleaseTag(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  if (release) env.FIELD_RELEASE = release.tag;
}
const child = spawn(
  process.execPath,
  ["--import", join(root, "server/observability/instrument.js"), join(root, "server/index.js"), ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
