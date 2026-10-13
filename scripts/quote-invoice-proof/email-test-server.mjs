// The real server for email route tests: PGlite, the synthetic verification
// catalogue and the proof harness's offline Gmail (each sent message is
// written to disk, never sent). Not a test file itself.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VERIFICATION_FIXTURES } from "../verification/fixtures.js";

const ROOT = resolve(import.meta.dirname, "../..");
const PROOF = import.meta.dirname;
export const CUSTOMER = "customer@example.invalid";
export const MB = 1024 * 1024;

export function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

// Every attachment of a captured message: { filename, contentType, bytes }.
export function attachmentsOf(mime) {
  const pattern = /Content-Type: ([^;\r\n]+); name="([^"]*)"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="[^"]*"\r\n\r\n([A-Za-z0-9+/=]*)/g;
  return [...mime.matchAll(pattern)].map((match) => ({ contentType: match[1], filename: match[2], bytes: Buffer.from(match[3], "base64") }));
}

export async function boot(t, { extraUsers = [], env: extraEnv = {}, config: extraConfig = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "field-email-documents-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "data");
  const mailDir = join(dir, "mail");
  await mkdir(dataDir, { recursive: true });
  const keyPath = join(dir, "fake-service-account.json");
  await writeFile(keyPath, JSON.stringify({ client_email: "proof@example.invalid", private_key: "not-a-key" }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    dataDir,
    authToken: "email-documents-test-service-key-0001",
    quoteCatalogId: "field-verification",
    bootstrapUsers: [{ email: "proof.sender@example.invalid", password: "email-documents-test-password", role: "admin", name: "Proof Operator" }, ...extraUsers],
    mail: { fromEmail: "proof.sender@example.invalid", fromName: "Proof Operator", gmailUser: "proof.sender@example.invalid", deliveryPolicy: { mode: "live" } },
    googleServiceAccountKey: keyPath,
    ...extraConfig,
  }));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    TZ: "Australia/Adelaide",
    FIELD_PROOF_MAIL_DIR: mailDir,
    FIELD_PRICE_CATALOG_BACKUP_ROOT: join(dir, "catalog-backups"),
    FIELD_PGLITE_DIR: join(dir, "pglite"),
  };
  execFileSync(process.execPath, [join(PROOF, "seed.mjs"), ROOT, dataDir], { cwd: ROOT, env, stdio: "ignore" });
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(PROOF, "hooks.mjs")).href, "server/index.js"], {
    cwd: ROOT,
    env: { ...env, ...extraEnv, FIELD_CONFIG: configPath, FIELD_DATA: dataDir, FIELD_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exited = new Promise((done) => child.once("exit", done));
  // The server never outlives the test file, even when a test times out: its
  // pipes do not hold the file open, and it is killed when the file exits.
  child.stdout.unref?.();
  child.stderr.unref?.();
  child.unref();
  const killOnExit = () => { if (child.exitCode === null) child.kill("SIGKILL"); };
  process.once("exit", killOnExit);
  t.after(async () => {
    process.removeListener("exit", killOnExit);
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output.join("")}`);
    try {
      if ((await fetch(`${base}/health`)).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${output.join("")}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
  // An api function signed in as one of the bootstrap users.
  const signIn = async (email, password) => {
    const login = await (await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })).json();
    assert.ok(login.token, `sign-in failed for ${email}:\n${output.join("")}`);
    const auth = { authorization: `Bearer ${login.token}` };
    return async (path, { method = "GET", body, form } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
        body: form || (body ? JSON.stringify(body) : undefined),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
  };
  const api = await signIn("proof.sender@example.invalid", "email-documents-test-password");
  const mail = async () => (await readdir(mailDir).catch(() => [])).filter((name) => name.endsWith(".eml")).sort();
  const lastMail = async () => readFile(join(mailDir, (await mail()).at(-1)), "latin1");
  // The next Gmail send fails as given (fake-googleapis.mjs).
  const failNextSend = (failure) => writeFile(join(mailDir, "next-send-failure.json"), JSON.stringify(failure));
  return { api, mail, lastMail, output, failNextSend, signIn, dataDir, base };
}

export function multipart(payload, files = []) {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const file of files) form.append("attachments", new Blob([file.bytes], { type: file.type || "application/octet-stream" }), file.name);
  return form;
}

/** The decoded Subject and the HTML part of a captured message. */
export function mimeParts(mime) {
  const encoded = mime.match(/\r\nSubject: =\?UTF-8\?B\?([^?]*)\?=\r\n/);
  const html = mime.match(/Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n([\s\S]*?)\r\n\r\n--field-alt-/);
  return {
    subject: encoded ? Buffer.from(encoded[1], "base64").toString("utf8") : null,
    // The message was read as latin1 (for its base64 parts); the HTML is UTF-8.
    html: html ? Buffer.from(html[1], "latin1").toString("utf8") : null,
  };
}

/**
 * Job A (fixture 0): its quote sent, landed, two milestones and the deposit
 * invoice sent. Job B (fixture 3): its quote sent. Returns their ids.
 */
export async function seedJobs(api, ok, customer = CUSTOMER) {
  const a = await api("/api/jobs/manual", { method: "POST", body: { quoteCatalogId: "field-verification", siteAddress: VERIFICATION_FIXTURES[0].siteAddress } });
  ok(a, "create A");
  const aid = a.body.id;
  ok(await api(`/api/jobs/${aid}/quote-inputs`, { method: "PUT", body: VERIFICATION_FIXTURES[0].quoteInputs }), "inputs A");
  ok(await api(`/api/jobs/${aid}/quote-update`, { method: "POST", body: { lockStatus: "final" } }), "lock A");
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: customer } }), "send quote A");
  ok(await api(`/api/jobs/${aid}/landed`, { method: "POST" }), "land A");
  ok(await api(`/api/jobs/${aid}/milestones/generate`, { method: "POST", body: { paymentSchedule: { milestones: [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }] } } }), "milestones A");
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: customer, documentType: "invoice", milestoneIndex: 0 } }), "send invoice A");
  const b = await api("/api/jobs/manual", { method: "POST", body: { quoteCatalogId: "field-verification", siteAddress: VERIFICATION_FIXTURES[3].siteAddress } });
  ok(b, "create B");
  ok(await api(`/api/jobs/${b.body.id}/quote-inputs`, { method: "PUT", body: VERIFICATION_FIXTURES[3].quoteInputs }), "inputs B");
  ok(await api(`/api/jobs/${b.body.id}/email-quote`, { method: "POST", body: { to: customer } }), "send quote B");
  return { aid, bid: b.body.id };
}
