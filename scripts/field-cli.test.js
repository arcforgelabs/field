import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "scripts", "field-cli.js");
const TEST_TOKEN = `field_${"a".repeat(43)}`;

test("Field CLI stores credentials outside chat and manages email templates", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "field-cli-auth-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/auth/me") {
      response.end(JSON.stringify({ ok: true, user: { id: "service-1", name: "Alex Email Agent", kind: "service" } }));
      return;
    }
    if (request.url === "/api/email-templates" && request.method === "GET") {
      response.end(JSON.stringify({
        ok: true,
        documentTypes: ["invoice"],
        allowedPlaceholders: ["greeting"],
        templates: { invoice: [{ id: "standard", name: "Standard invoice", description: "Default", subject: "Invoice", html: "<p>{{greeting}}</p>" }] },
      }));
      return;
    }
    if (request.url === "/api/email-templates/invoice/standard" && request.method === "PUT") {
      response.end(JSON.stringify({ ok: true, template: { id: "standard", ...body } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, FIELD_CONFIG_DIR: configDir };

  const login = await runCli(["auth", "login", "--token-stdin", "--url", url], { env, input: `${TEST_TOKEN}\n` });
  assert.match(login.stdout, /Authenticated as Alex Email Agent/);
  assert.equal((await readFile(join(configDir, "token"), "utf8")).trim(), TEST_TOKEN);
  assert.equal((await stat(join(configDir, "token"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(configDir, "config.json"), "utf8")), { url });

  const status = await runCli(["auth", "status"], { env });
  assert.match(status.stdout, /Field authentication: ready/);
  assert.doesNotMatch(status.stdout, new RegExp(TEST_TOKEN));

  const listed = await runCli(["email-templates", "list", "invoice"], { env });
  assert.match(listed.stdout, /Standard invoice/);

  const bodyPath = join(configDir, "invoice.html");
  await writeFile(bodyPath, "<p>Updated invoice</p>");
  const updated = await runCli(["email-templates", "update", "invoice", "standard", "--body-file", bodyPath], { env });
  assert.match(updated.stdout, /Updated invoice/);
  assert.equal(requests.at(-1).authorization, `Bearer ${TEST_TOKEN}`);
  assert.deepEqual(requests.at(-1).body, { html: "<p>Updated invoice</p>" });
});

test("Field CLI reads, sets and checks milestone rules", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "field-cli-rules-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const requests = [];
  const rule = {
    uid: "mrl_01JAAAAAAAAAAAAAAAAAAAAAAA", name: "SA domestic, under $20,000", country: "AU", region: "SA", minValue: 0, maxValue: 20000, valueBasis: "inc-gst", note: null,
    milestones: [{ label: "Deposit", percentage: 5 }, { label: "Final payment", percentage: 95 }],
    caps: [{ kind: "deposit", mode: "hard", maxPercent: null, maxAmount: 1000 }],
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/auth/me") return response.end(JSON.stringify({ ok: true, user: { id: "owner-1", name: "Owner", kind: "service" } }));
    if (request.url === "/api/settings/milestone-rules") {
      return response.end(JSON.stringify({ ok: true, rules: [rule], version: "1:2026-10-13T00:00:00.000Z", businessRegion: { country: "AU", region: "SA", from: "settings" } }));
    }
    if (request.url === "/api/settings/invoicing") return response.end(JSON.stringify({ ok: true, ...body }));
    if (request.url === "/api/jobs/job-1/milestone-rules") {
      return response.end(JSON.stringify({
        ok: true, hasRules: true, region: { country: "AU", region: "SA", from: "site-address" }, rule, contractValue: 16500,
        scheduleSource: { kind: "override", ruleName: rule.name, by: "Sam" },
        milestones: [{ milestoneIndex: 0, label: "Deposit", kind: "deposit", total: 1650, blocked: true, findings: [{ mode: "hard", message: "Deposit is $1,650.00 with GST." }] }],
      }));
    }
    if (request.url === "/api/jobs/job-1/milestones/generate") {
      return response.end(JSON.stringify({ ok: true, milestones: [], paymentSchedule: { milestones: [], source: { kind: "rule", ruleName: rule.name } } }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, FIELD_CONFIG_DIR: configDir };
  await runCli(["auth", "login", "--token-stdin", "--url", `http://127.0.0.1:${server.address().port}`], { env, input: `${TEST_TOKEN}\n` });

  const listed = await runCli(["milestone-rules", "list"], { env });
  assert.match(listed.stdout, /Business region: SA, AU \(from settings\)/);
  assert.match(listed.stdout, /SA domestic, under \$20,000 \[SA, AU, under \$20,000\.00, inc-gst\]: Deposit 5%, Final payment 95%; caps: deposit <= \$1,000\.00 \(hard\)/);

  const rulesPath = join(configDir, "rules.json");
  await writeFile(rulesPath, JSON.stringify({ rules: [rule] }));
  await runCli(["milestone-rules", "set", "--file", rulesPath, "--expect-version", "none"], { env });
  const put = requests.find((entry) => entry.method === "PUT" && entry.url === "/api/settings/milestone-rules");
  assert.deepEqual(put.body, { rules: [rule], expectedVersion: "none" });

  await runCli(["milestone-rules", "business-region", "AU", "SA"], { env });
  assert.deepEqual(requests.find((entry) => entry.url === "/api/settings/invoicing").body, { country: "AU", region: "SA" });

  const checked = await runCli(["milestone-rules", "check", "job-1"], { env });
  assert.match(checked.stdout, /Schedule: override, set on this job by Sam \(account rule "SA domestic, under \$20,000"\)/);
  assert.match(checked.stdout, /M1 Deposit \(deposit\) \$1,650\.00 BLOCKED\n {4}hard cap: Deposit is \$1,650\.00 with GST\./);

  const restored = await runCli(["generate-milestones", "job-1", "--account-rule"], { env });
  assert.deepEqual(requests.find((entry) => entry.url === "/api/jobs/job-1/milestones/generate").body, { applyAccountRule: true });
  assert.match(restored.stdout, /schedule: account rule "SA domestic, under \$20,000"/);
});

function runCli(args, { env, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: repoRoot, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`field ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
    child.stdin.end(input);
  });
}
