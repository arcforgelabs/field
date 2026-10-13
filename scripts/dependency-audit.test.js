import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { acceptedAdvisories, advisoriesFromAudit, judge, parseAuditReport } from "./dependency-audit.mjs";

const security = readFileSync(join(import.meta.dirname, "..", "SECURITY.md"), "utf8");

function report(...vias) {
  return {
    vulnerabilities: Object.fromEntries(vias.map(([name, via]) => [name, { name, via: [via, "some-parent"] }])),
  };
}
const advisory = (id, severity, title = "t") => ({ url: `https://github.com/advisories/${id}`, severity, title, source: 1 });

test("each accepted advisory row gives its GHSA id and recheck date; other lines are ignored", () => {
  const accepted = acceptedAdvisories([
    "| Advisory | Path | Why | Reachable | Recheck |",
    "| --- | --- | --- | --- | --- |",
    "| [GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) (high): x | a > b | none | never | 2027-01-13 |",
    "See GHSA-dddd-eeee-ffff for background.",
  ].join("\n"));
  assert.deepEqual([...accepted], [["GHSA-aaaa-bbbb-cccc", "2027-01-13"]]);
});

test("every advisory row in SECURITY.md parses, with a recheck date", () => {
  const rows = security.split("\n").filter((line) => line.startsWith("| [GHSA-"));
  assert.equal(acceptedAdvisories(security).size, rows.length);
});

test("an accepted high advisory passes until its recheck date, then fails", () => {
  const accepted = new Map([["GHSA-aaaa-bbbb-cccc", "2027-01-13"]]);
  const found = advisoriesFromAudit(report(["braces", advisory("GHSA-aaaa-bbbb-cccc", "high")]));
  assert.deepEqual(judge(found, accepted, "2027-01-13"), []);
  assert.match(judge(found, accepted, "2027-01-14")[0], /due for a recheck on 2027-01-13/);
});

test("a high or critical advisory SECURITY.md does not accept fails; moderate and low never do", () => {
  const found = advisoriesFromAudit(report(
    ["a", advisory("GHSA-1111-1111-1111", "critical", "bad")],
    ["b", advisory("GHSA-2222-2222-2222", "high")],
    ["c", advisory("GHSA-3333-3333-3333", "moderate")],
    ["d", advisory("GHSA-4444-4444-4444", "low")],
  ));
  const problems = judge(found, new Map(), "2026-10-13");
  assert.equal(problems.length, 2);
  assert.match(problems[0], /GHSA-1111-1111-1111 \(critical\) is not accepted in SECURITY.md: bad/);
  assert.match(problems[1], /GHSA-2222-2222-2222 \(high\)/);
});

test("one advisory reached through several packages is judged once and names them all", () => {
  const found = advisoriesFromAudit(report(
    ["braces", advisory("GHSA-aaaa-bbbb-cccc", "high")],
    ["micromatch", advisory("GHSA-aaaa-bbbb-cccc", "high")],
  ));
  assert.equal(found.length, 1);
  assert.deepEqual([...found[0].packages].sort(), ["braces", "micromatch"]);
});

test("an npm audit error document fails the audit instead of passing as a clean report", () => {
  // What npm 11 prints when the registry cannot be reached.
  const error = JSON.stringify({ message: "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED", error: { summary: "", detail: "" } });
  assert.throws(() => parseAuditReport(error), /npm audit did not produce a report: request to https:\/\/registry.npmjs.org/);
  assert.throws(() => parseAuditReport("npm ERR! something"), /printed no JSON report/);
  assert.throws(() => parseAuditReport("null"), /did not produce a report/);
  assert.deepEqual(parseAuditReport(JSON.stringify({ vulnerabilities: {} })).vulnerabilities, {});
});
