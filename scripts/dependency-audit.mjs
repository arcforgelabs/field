#!/usr/bin/env node
// CI's dependency audit (.github/workflows/ci.yml, job `audit`).
//
//   node scripts/dependency-audit.mjs [--today YYYY-MM-DD]
//
// Runs `npm audit --package-lock-only` for the server (/) and the client
// (/client) and fails on any high or critical advisory, unless SECURITY.md
// ("Dependency Advisories") accepts it and its recheck date has not passed.
// SECURITY.md stays the one list of accepted advisories: to accept one, add a
// row there with its reasons and a recheck date. Moderate and low advisories
// are listed but never fail the audit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FAILING = new Set(["high", "critical"]);
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/;

// Accepted advisories from SECURITY.md's table: each row names a GHSA id and
// ends with its recheck date.
export function acceptedAdvisories(securityMarkdown) {
  const accepted = new Map();
  for (const line of String(securityMarkdown).split("\n")) {
    if (!line.startsWith("|")) continue;
    const id = GHSA.exec(line)?.[0];
    const recheck = /\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*$/.exec(line)?.[1];
    if (id && recheck) accepted.set(id, recheck);
  }
  return accepted;
}

// Every advisory in one `npm audit --json` report, once per id.
export function advisoriesFromAudit(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || !via) continue;
      const id = GHSA.exec(String(via.url ?? ""))?.[0] ?? `npm-${via.source}`;
      const seen = found.get(id);
      if (seen) seen.packages.add(vulnerability.name);
      else found.set(id, { id, severity: via.severity, title: via.title, packages: new Set([vulnerability.name]) });
    }
  }
  return [...found.values()];
}

// Which advisories fail the audit, and why.
export function judge(advisories, accepted, today) {
  const problems = [];
  for (const advisory of advisories) {
    if (!FAILING.has(advisory.severity)) continue;
    const recheck = accepted.get(advisory.id);
    if (!recheck) problems.push(`${advisory.id} (${advisory.severity}) is not accepted in SECURITY.md: ${advisory.title}`);
    else if (recheck < today) problems.push(`${advisory.id} (${advisory.severity}) was due for a recheck on ${recheck} (SECURITY.md)`);
  }
  return problems;
}

// An `npm audit --json` report, or an error when npm could not produce one
// (an unreachable registry, a broken lockfile): then npm prints an error
// document with no `vulnerabilities`, and the audit must fail, never pass.
export function parseAuditReport(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`npm audit printed no JSON report: ${String(stdout).slice(0, 200)}`);
  }
  if (!report || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    const reason = report?.message || report?.error?.summary || report?.error?.code || JSON.stringify(report).slice(0, 200);
    throw new Error(`npm audit did not produce a report: ${reason}`);
  }
  return report;
}

function audit(directory) {
  try {
    return parseAuditReport(execFileSync("npm", ["audit", "--package-lock-only", "--json"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    // npm audit exits 1 when it finds anything; its report is still on stdout.
    if (error.stdout) return parseAuditReport(error.stdout);
    throw error;
  }
}

function main() {
  try {
    run();
  } catch (error) {
    console.error(`Dependency audit failed: ${error.message}`);
    process.exit(1);
  }
}

function run() {
  const root = resolve(import.meta.dirname, "..");
  const todayFlag = process.argv.indexOf("--today");
  const today = todayFlag > 0 ? process.argv[todayFlag + 1] : new Date().toISOString().slice(0, 10);
  const accepted = acceptedAdvisories(readFileSync(join(root, "SECURITY.md"), "utf8"));
  const problems = [];
  for (const [label, directory] of [["server", root], ["client", join(root, "client")]]) {
    const advisories = advisoriesFromAudit(audit(directory));
    for (const advisory of advisories) {
      const state = accepted.has(advisory.id) ? `accepted until ${accepted.get(advisory.id)}` : "not accepted";
      console.log(`${label}: ${advisory.id} ${advisory.severity} (${[...advisory.packages].sort().join(", ")}) ${state}`);
    }
    if (advisories.length === 0) console.log(`${label}: no advisories`);
    problems.push(...judge(advisories, accepted, today).map((problem) => `${label}: ${problem}`));
  }
  if (problems.length) {
    console.error(`\nDependency audit failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    console.error("Fix it, or accept it in SECURITY.md (\"Dependency Advisories\") with its reasons and a recheck date.");
    process.exit(1);
  }
  console.log("\nDependency audit passed: no high or critical advisory outside SECURITY.md's accepted list.");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
