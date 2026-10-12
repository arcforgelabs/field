// Quote + invoice end-to-end proof harness.
//
// Boots a real Field server from <repoRoot> against a throwaway data dir and
// PGlite database with the verification catalogue, a frozen clock and deterministic ids
// (scripts/verification/deterministic-preload.cjs), and an offline Gmail
// stand-in that writes each sent message to disk. It then drives, over HTTP:
// manual quote -> quote inputs -> lock -> quote PDF -> send quote -> landed ->
// milestone invoices -> invoice PDF -> send invoice -> payment -> send receipt,
// plus a second draft quote with disposal pricing.
//
// Run it against two checkouts and compare the output directories with
// compare.mjs: PDFs and raw MIME must be byte-identical, API responses
// JSON-equal (filesystem mtimes masked).
//
//   node scripts/quote-invoice-proof/run.mjs <repoRoot> <outDir> [port]
//   node scripts/quote-invoice-proof/compare.mjs <beforeDir> <afterDir>
//
// Set PROOF_HOLD_MS to keep the seeded server up for manual inspection.
//
// On a checkout with catalogue-linked quote rows (server/quote-catalog-sync.js)
// the run then proves, after every compared step: (a) a catalogue price change
// shows on a draft as a row diff and applying it updates the row (and, where
// the apply checks each row's reviewKey, never replaces a rate the operator
// typed after the check or without review data), (b) the sent
// quotes and invoice are byte-identical after the catalogue change, and (c)
// every send wrote a quote_snapshots row naming the catalogue items and price
// ids it was priced from. Results go to sync-proof.json; compare.mjs ignores
// sync-* files, and any failed check fails the run.
//
// PROOF_STORAGE=postgres runs the same proof with durable storage on
// (FIELD_STORAGE=postgres) against PROOF_DB_URL, else
// FIELD_DB_TEST_DATABASE_URL, else a throwaway postgres:16-alpine container
// (needs Docker). After the proof it also restarts from an EMPTY data
// directory: PostgreSQL must rebuild the data tree byte-identically (paths,
// modes, contents, mtimes, SQLite contents), and the rebuilt server must
// answer the read-only steps exactly as before, each with 200 (a refusal that
// survives the restart unchanged is still a failure). The result is written to
// storage-restart.json (compare.mjs ignores storage-* files) and any
// difference fails the run. On checkouts with issued documents and
// quote rows (#6) it also checks those tables against what was sent
// (storage-documents.json, storage-backfill.json, storage-quote-rows.json),
// and on checkouts with invoice rows (#27) job A's invoices, payment and
// receipt (storage-invoice-rows.json). On checkouts that backfill those rows
// at boot (#36) the first server holds the backfills, and the restart from an
// empty disk must run them over the proof's jobs and record them
// (storage-boot-backfills.json).
//
// PROOF_R2_REPLICA=minio (with PROOF_STORAGE=postgres) also turns on the R2
// replica of issued documents (#12, FIELD_DOCUMENT_REPLICA=r2) against a
// throwaway local MinIO container with a LOCKED bucket
// (server/documents/test-minio.js; needs Docker; never R2 itself). After the
// proof every issued document must be in the bucket with its recorded hash,
// /health must report the replica ok, and `npm run documents:verify-r2` must
// pass. The result is written to storage-replica.json (compare.mjs ignores
// it); the compared artefacts must not change. Checkouts without the replica
// ignore it.
//
// Use a trust-auth PostgreSQL (the Docker container and CI are). With password
// (SCRAM) auth, postgres.js draws its client nonce from the seeded random
// source the proof installs, which shifts every later UUID and token, so the
// artefacts no longer match the SQLite baseline although nothing changed.
// Older checkouts, from before the storage-mode proof matched the disk
// baseline, also take one extra id at boot without durable
// storage (the PGlite lock's file name), so their plain runs differ from later
// checkouts in ids and tokens only; compare across that line in storage mode.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repoArg, outArg, portArg] = process.argv.slice(2);
const STORAGE_MODE = process.env.PROOF_STORAGE === "postgres";
if (process.env.PROOF_STORAGE && !STORAGE_MODE) throw new Error(`PROOF_STORAGE must be "postgres" or unset`);
const REPLICA_REQUESTED = process.env.PROOF_R2_REPLICA === "minio";
if (process.env.PROOF_R2_REPLICA && !REPLICA_REQUESTED) throw new Error(`PROOF_R2_REPLICA must be "minio" or unset`);
if (REPLICA_REQUESTED && !STORAGE_MODE) throw new Error("PROOF_R2_REPLICA=minio needs PROOF_STORAGE=postgres");
const repoRoot = resolve(repoArg);
const outDir = resolve(outArg);
// Checkouts with issued documents by uid (server/documents/).
const HAS_ISSUED_DOCUMENTS = existsSync(join(repoRoot, "server/documents/routes.js"));
// Checkouts with quote rows (#6, server/quotes/).
const HAS_QUOTE_ROWS = existsSync(join(repoRoot, "server/quotes/backfill.js"));
let quoteRowStatus = null;
// Checkouts with invoice rows (#27, server/invoices/).
const HAS_INVOICE_ROWS = existsSync(join(repoRoot, "server/invoices/backfill.js"));
// Checkouts that issue invoices from the sequence (#28, step 4b).
const HAS_INVOICE_ISSUE = existsSync(join(repoRoot, "server/invoices/issue.js"));
let invoiceRowStatus = null;
// Checkouts that backfill quote and invoice rows as boot data migrations (#36).
const HAS_BOOT_BACKFILLS = existsSync(join(repoRoot, "server/data-migrations/row-backfills.js"));
const BOOT_BACKFILL_IDS = ["2026-10-13-quote-rows-backfill", "2026-10-13-invoice-rows-backfill"];
let restartLog = "";
// Checkouts whose quote documents and totals are read from the rows (#10).
const HAS_QUOTE_READS = existsSync(join(repoRoot, "server/quotes/read-model.js"));
let quoteReadStatus = null;
// Checkouts with the R2 replica (#12).
const REPLICA_MODE = REPLICA_REQUESTED && existsSync(join(repoRoot, "server/documents/replicator.js"));
if (REPLICA_REQUESTED && !REPLICA_MODE) console.log("PROOF_R2_REPLICA: this checkout has no R2 replica; ignored");
// Filled by replicaProof and verifyR2Proof (below), written to storage-replica.json.
const replicaReport = { checks: [], documents: [], ok: true };
const port = Number(portArg || 19731);
const here = import.meta.dirname;
const root = mkdtempSync(join(tmpdir(), "field-quote-invoice-proof-"));
const dataDir = join(root, "data");
const mailDir = join(root, "mail");
mkdirSync(dataDir, { recursive: true });
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const keyPath = join(root, "fake-service-account.json");
writeFileSync(keyPath, JSON.stringify({ client_email: "proof@example.invalid", private_key: "not-a-key" }));
const configPath = join(root, "config.json");
writeFileSync(configPath, JSON.stringify({
  dataDir,
  authToken: "proof-installation-token",
  quoteCatalogId: "field-verification",
  bootstrapUsers: [{ email: "proof.sender@example.invalid", password: "proof-password-fixture", role: "admin", name: "Proof Operator" }],
  mail: { fromEmail: "proof.sender@example.invalid", fromName: "Proof Operator", gmailUser: "proof.sender@example.invalid", deliveryPolicy: { mode: "live" } },
  googleServiceAccountKey: keyPath,
}, null, 2));

const preload = join(repoRoot, "scripts/verification/deterministic-preload.cjs");
const baseEnv = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: root,
  TZ: "Australia/Adelaide",
  LANG: "en_AU.UTF-8",
  FIELD_VERIFICATION_DETERMINISTIC: "1",
  FIELD_PROOF_MAIL_DIR: mailDir,
  FIELD_PRICE_CATALOG_BACKUP_ROOT: join(root, "catalog-backups"),
  // The catalogue lives in PostgreSQL: an in-process PGlite database for the
  // run, seeded by seed.mjs and then opened by the server. (Checkouts from
  // before the move keep it in data/price-catalog and only see an extra,
  // empty database.)
  FIELD_PGLITE_DIR: join(root, "pglite"),
};

// Durable storage mode: a PostgreSQL database just for this run.
let storageDb = null;
if (STORAGE_MODE) {
  const { startTestPostgres } = await import(pathToFileURL(join(repoRoot, "server/db-runtime/test-postgres.js")).href);
  const explicit = process.env.PROOF_DB_URL;
  storageDb = await startTestPostgres(explicit
    ? { FIELD_DB_TEST_DATABASE_URL: explicit }
    : process.env.FIELD_DB_TEST_DATABASE_URL ? { FIELD_DB_TEST_DATABASE_URL: process.env.FIELD_DB_TEST_DATABASE_URL } : { FIELD_DB_TEST_DOCKER: "1" });
}
const storageEnv = storageDb ? { FIELD_STORAGE: "postgres", FIELD_DB_URL: storageDb.url } : {};

// R2 replica mode: a local MinIO with a locked bucket, just for this run.
let minio = null;
if (REPLICA_MODE) {
  const { startTestMinio } = await import(pathToFileURL(join(repoRoot, "server/documents/test-minio.js")).href);
  minio = await startTestMinio({ FIELD_R2_TEST_DOCKER: "1" });
}
const replicaEnv = minio ? {
  FIELD_DOCUMENT_REPLICA: "r2",
  FIELD_R2_ENDPOINT: minio.endpoint,
  FIELD_R2_BUCKET: minio.bucket,
  FIELD_R2_ACCESS_KEY_ID: minio.accessKeyId,
  FIELD_R2_SECRET_ACCESS_KEY: minio.secretAccessKey,
} : {};

// The PostgreSQL catalogue is seeded into the database the server will use:
// that run's PostgreSQL in durable storage mode, else the PGlite directory.
execFileSync(process.execPath, ["--require", preload, join(here, "seed.mjs"), repoRoot, dataDir], {
  cwd: repoRoot, env: { ...baseEnv, ...(storageDb ? { FIELD_DB_URL: storageDb.url } : {}) }, stdio: "inherit",
});

const serverLog = [];
function startServer(serverDataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["--require", preload, "--import", pathToFileURL(join(here, "hooks.mjs")).href, "server/index.js"], {
    cwd: repoRoot,
    env: { ...baseEnv, ...storageEnv, ...replicaEnv, ...extraEnv, FIELD_CONFIG: configPath, FIELD_DATA: serverDataDir, FIELD_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => serverLog.push(b.toString()));
  child.stderr.on("data", (b) => serverLog.push(b.toString()));
  return child;
}
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
}
// In durable storage mode the first server holds the boot backfills (#36), so
// the restart from an empty disk is the boot that backfills the proof's jobs
// (bootBackfillProof).
let server = startServer(dataDir, STORAGE_MODE && HAS_BOOT_BACKFILLS ? { FIELD_DATA_MIGRATIONS_HOLD: BOOT_BACKFILL_IDS.join(",") } : {});

const base = `http://127.0.0.1:${port}`;
async function waitHealthy() {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not become healthy:\n${serverLog.join("")}`);
}

let token = null;
let restartChecks = null;
const steps = [];
async function call(name, method, path, body, { binary = false } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  steps.push({ name, method, path, status: res.status });
  if (!res.ok) throw new Error(`${name} ${method} ${path} -> ${res.status}: ${buf.toString().slice(0, 600)}`);
  if (binary) { writeFileSync(join(outDir, name), buf); return buf; }
  const json = JSON.parse(buf.toString());
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`);
  return json;
}

try {
  await waitHealthy();
  const login = await call("00-login", "POST", "/api/auth/login", { email: "proof.sender@example.invalid", password: "proof-password-fixture" });
  token = login.token;
  const { VERIFICATION_FIXTURES } = await import(pathToFileURL(join(repoRoot, "scripts/verification/fixtures.js")).href);
  const invoiceFixture = VERIFICATION_FIXTURES[0];
  const quoteFixture = VERIFICATION_FIXTURES[3];
  const customer = "customer@example.invalid";

  // Quote + invoice + receipt path.
  const a = await call("a01-create", "POST", "/api/jobs/manual", { quoteCatalogId: "field-verification", siteAddress: invoiceFixture.siteAddress });
  const aid = a.id;
  await call("a02-quote-inputs", "PUT", `/api/jobs/${aid}/quote-inputs`, invoiceFixture.quoteInputs);
  await call("a03-lock-final", "POST", `/api/jobs/${aid}/quote-update`, { lockStatus: "final" });
  await call("a04-quote.pdf", "GET", `/api/jobs/${aid}/quote-pdf`, null, { binary: true });
  await call("a05-send-quote", "POST", `/api/jobs/${aid}/email-quote`, { to: customer });
  await call("a06-landed", "POST", `/api/jobs/${aid}/landed`);
  await call("a07-milestones", "POST", `/api/jobs/${aid}/milestones/generate`, {
    paymentSchedule: { milestones: [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }] },
  });
  await call("a08-invoice-0.pdf", "GET", `/api/jobs/${aid}/milestones/0/pdf`, null, { binary: true });
  await call("a09-send-invoice-0", "POST", `/api/jobs/${aid}/email-quote`, { to: customer, documentType: "invoice", milestoneIndex: 0 });
  const detail = await call("a10-detail-after-invoice", "GET", `/api/jobs/${aid}`);
  const amount = detail?.meta?.milestoneInvoices?.[0]?.amount ?? detail?.meta?.milestoneInvoices?.[0]?.total;
  await call("a11-payment-0", "POST", `/api/jobs/${aid}/milestones/0/payment`, { amount, date: "2026-01-15", reference: "PROOF-1", method: "bank_transfer" });
  await call("a12-send-receipt-0", "POST", `/api/jobs/${aid}/email-quote`, { to: customer, documentType: "receipt", milestoneIndex: 0 });
  await call("a14-sent-emails", "GET", `/api/jobs/${aid}/sent-emails`);
  await call("a15-detail-final", "GET", `/api/jobs/${aid}`);

  // Draft quote with disposal pricing.
  const b = await call("b01-create", "POST", "/api/jobs/manual", { quoteCatalogId: "field-verification", siteAddress: quoteFixture.siteAddress });
  const bid = b.id;
  await call("b02-quote-inputs", "PUT", `/api/jobs/${bid}/quote-inputs`, quoteFixture.quoteInputs);
  await call("b03-quote.pdf", "GET", `/api/jobs/${bid}/quote-pdf`, null, { binary: true });
  await call("b04-send-quote", "POST", `/api/jobs/${bid}/email-quote`, { to: customer });
  await call("b05-detail-final", "GET", `/api/jobs/${bid}`);
  if (existsSync(join(repoRoot, "server/quote-catalog-sync.js"))) {
    await catalogueSyncProof({ aid, bid, fixture: quoteFixture, customer, sentEmailCount: (await syncJson("GET", `/api/jobs/${aid}/sent-emails`)) });
  }
  if (STORAGE_MODE) restartChecks = await readOnlyChecks(aid, bid);
  if (STORAGE_MODE && HAS_ISSUED_DOCUMENTS) await issuedDocumentsProof(aid);
  if (STORAGE_MODE && HAS_QUOTE_ROWS) {
    const status = await syncJson("GET", "/api/storage/status");
    quoteRowStatus = status.quoteRows;
    quoteReadStatus = status.quoteReads || null;
    invoiceRowStatus = status.invoiceRows || null;
  }
  if (REPLICA_MODE) await replicaProof([aid, bid]);
} catch (error) {
  writeFileSync(join(outDir, "ERROR.txt"), `${error.stack}\n`);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (process.env.PROOF_HOLD_MS) {
    console.log(`holding server on ${base} for ${process.env.PROOF_HOLD_MS} ms`);
    await new Promise((r) => setTimeout(r, Number(process.env.PROOF_HOLD_MS)));
  }
  await stopServer(server);
  if (STORAGE_MODE) {
    try {
      if (!process.exitCode) await proveRestartFromEmptyDisk();
      if (!process.exitCode && HAS_BOOT_BACKFILLS) await bootBackfillProof();
      if (!process.exitCode && HAS_ISSUED_DOCUMENTS) await backfillProof();
      if (!process.exitCode && HAS_QUOTE_ROWS) await quoteRowsProof(restartChecks.ids);
      if (!process.exitCode && HAS_INVOICE_ROWS) await invoiceRowsProof(restartChecks.ids);
      if (!process.exitCode && REPLICA_MODE) await verifyR2Proof();
    } catch (error) {
      writeFileSync(join(outDir, "storage-ERROR.txt"), `${error.stack}\n`);
      console.error(`storage restart proof failed: ${error.message}`);
      process.exitCode = 1;
    } finally {
      await stopServer(server);
      await storageDb.stop();
      await minio?.stop();
    }
  }
  writeFileSync(join(outDir, "server.log"), serverLog.join(""));
  for (const name of (() => { try { return readdirSync(mailDir); } catch { return []; } })()) {
    copyFileSync(join(mailDir, name), join(outDir, `mail-${name}`));
  }
  writeFileSync(join(outDir, "steps.json"), `${JSON.stringify(steps, null, 2)}\n`);
  const manifest = readdirSync(outDir).filter((n) => n !== "server.log" && n !== "MANIFEST.sha256" && !n.startsWith("storage-")).sort()
    .map((n) => `${createHash("sha256").update(readFileSync(join(outDir, n))).digest("hex")}  ${n}`);
  writeFileSync(join(outDir, "MANIFEST.sha256"), `${manifest.join("\n")}\n`);
  rmSync(root, { recursive: true, force: true });
}

// Durable storage: rebuild the whole data tree from PostgreSQL into an empty
// directory and compare it with the directory the server left behind; then
// boot a server on another empty directory and repeat the read-only steps.
async function proveRestartFromEmptyDisk() {
  const load = (rel) => import(pathToFileURL(join(repoRoot, rel)).href);
  const { openStorageSession, restoreDataDir, scanTree, treeHash } = await load("server/storage/durable-store.js");
  const { resolveDbConfig } = await load("server/db-runtime/index.js");
  const Database = (await import(pathToFileURL(join(repoRoot, "node_modules/better-sqlite3/lib/index.js")).href)).default;
  const report = { originalTreeHash: null, rebuiltTreeHash: null, files: 0, sqlite: {}, steps: {}, ok: false };

  const original = scanTree(dataDir);
  report.files = original.length;
  report.originalTreeHash = treeHash(original);
  const rebuiltDir = join(root, "rebuilt");
  const session = openStorageSession(resolveDbConfig({ env: { FIELD_DB_URL: storageDb.url } }));
  try {
    await restoreDataDir({ db: session.db, dataDir: rebuiltDir, logger: { warn: () => {} } });
  } finally {
    await session.close();
  }
  report.rebuiltTreeHash = treeHash(scanTree(rebuiltDir));
  // SQLite databases: the server left WAL files behind; compare content.
  // (price-catalog/catalog.db only on checkouts from before the catalogue
  // moved into PostgreSQL tables.)
  for (const name of ["field.db", "price-catalog/catalog.db"].filter((rel) => existsSync(join(dataDir, rel)))) {
    const serialize = (path) => {
      const db = new Database(path);
      try { return createHash("sha256").update(db.serialize()).digest("hex"); } finally { db.close(); }
    };
    const restored = createHash("sha256").update(readFileSync(join(rebuiltDir, name))).digest("hex");
    report.sqlite[name] = { original: serialize(join(dataDir, name)), restored };
  }

  // Restart on an empty disk and repeat the read-only checks taken just
  // before the first server stopped.
  const emptyDir = join(root, "restart-data");
  mkdirSync(emptyDir);
  const logStart = serverLog.length;
  server = startServer(emptyDir);
  await waitHealthy();
  const after = await readOnlyChecks(restartChecks.ids.aid, restartChecks.ids.bid);
  for (const [name, check] of Object.entries(restartChecks.results)) {
    const again = after.results[name];
    report.steps[name] = { status: check.status, statusAfterRestart: again.status, same: check.status === again.status && check.sha256 === again.sha256 };
    report.steps[name].ok = report.steps[name].same && check.status === 200;
  }
  await stopServer(server);
  restartLog = serverLog.slice(logStart).join("");

  report.ok = report.originalTreeHash === report.rebuiltTreeHash
    && Object.values(report.sqlite).every((entry) => entry.original === entry.restored)
    && Object.keys(report.steps).length > 0
    && Object.values(report.steps).every((step) => step.ok);
  writeFileSync(join(outDir, "storage-restart.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`storage restart proof: ${report.ok ? "OK" : "FAILED"} (${report.files} files, tree ${report.rebuiltTreeHash.slice(0, 16)})`);
  if (!report.ok) throw new Error(`rebuild from PostgreSQL differs: ${JSON.stringify(report)}`);
}

// Read-only requests whose answers must survive a restart unchanged.
async function readOnlyChecks(aid, bid) {
  const results = {};
  for (const [name, path] of [
    ["a-detail", `/api/jobs/${aid}`],
    ["a-sent-emails", `/api/jobs/${aid}/sent-emails`],
    // Job A's sent quote, served from its issued copy.
    ["a-quote.pdf", `/api/jobs/${aid}/quote-pdf?documentType=quote`],
    ["a-quote-v1.pdf", `/api/jobs/${aid}/quote-pdf?documentType=quote&version=1`],
    // Job A is landed, so these are invoices and receipts built from that
    // sent quote: they render, never refused as an unavailable issued quote.
    ["a-document.pdf", `/api/jobs/${aid}/quote-pdf`],
    ["a-invoice-1-preview.pdf", `/api/jobs/${aid}/quote-pdf?documentType=invoice&milestoneIndex=1`],
    ["a-receipt-0.pdf", `/api/jobs/${aid}/quote-pdf?documentType=receipt&milestoneIndex=0`],
    ["a-invoice-0.pdf", `/api/jobs/${aid}/milestones/0/pdf`],
    ["b-detail", `/api/jobs/${bid}`],
    ["b-quote.pdf", `/api/jobs/${bid}/quote-pdf`],
    ["jobs", "/api/jobs"],
    // Issued documents live in PostgreSQL tables, not the data directory.
    ...(HAS_ISSUED_DOCUMENTS ? [["a-documents", `/api/jobs/${aid}/documents`]] : []),
  ]) {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const buf = Buffer.from(await res.arrayBuffer());
    results[name] = { status: res.status, sha256: createHash("sha256").update(buf).digest("hex") };
  }
  return { ids: { aid, bid }, results };
}

// The PDF attachments of every captured email, by file: { "001.eml": [Buffer] }.
function sentPdfAttachments() {
  const out = {};
  for (const name of readdirSync(mailDir).filter((entry) => entry.endsWith(".eml")).sort()) {
    const mime = readFileSync(join(mailDir, name), "latin1");
    const pattern = /Content-Type: application\/pdf[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n[^\r\n]*\r\n\r\n([A-Za-z0-9+/=]+)/g;
    out[name] = [...mime.matchAll(pattern)].map((match) => Buffer.from(match[1], "base64"));
  }
  return out;
}

// Issued documents: job A's documents, listed by the new route, are
// the exact PDFs the customer was emailed: the quote (001.eml), invoice 0
// (002.eml) and the receipt (003.eml), each fetched by uid. Results go to
// storage-documents.json (compare.mjs ignores storage-* files).
async function issuedDocumentsProof(aid) {
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const report = { checks: [], documents: [], ok: true };
  const check = (name, ok, detail = null) => {
    report.checks.push({ name, ok: Boolean(ok), ...(detail == null ? {} : { detail }) });
    if (!ok) report.ok = false;
  };
  const listed = await syncJson("GET", `/api/jobs/${aid}/documents`);
  const sent = sentPdfAttachments();
  const expected = { quote: sent["001.eml"]?.[0], invoice: sent["002.eml"]?.[0], receipt: sent["003.eml"]?.[0] };
  check("the proof captured the quote, invoice and receipt attachments", expected.quote && expected.invoice && expected.receipt);
  for (const document of listed.documents) {
    const { status, buf } = await syncRequest("GET", document.pdfUrl);
    report.documents.push({
      uid: document.uid,
      documentType: document.documentType,
      number: document.number,
      source: document.source,
      status,
      pdfSha256: document.pdfSha256,
      servedSha256: sha(buf),
      emailed: document.emailed.map((entry) => entry.messageId),
    });
    check(`${document.number}: served bytes match its recorded hash`, status === 200 && sha(buf) === document.pdfSha256);
  }
  for (const [documentType, bytes] of Object.entries(expected)) {
    const matches = listed.documents.filter((document) => document.documentType === documentType);
    const served = report.documents.find((document) => document.documentType === documentType);
    check(`one ${documentType}, recorded live, byte-identical to the attachment that was emailed`, matches.length === 1
      && matches[0].source === "live" && bytes && served?.servedSha256 === sha(bytes),
      { documents: matches.map((document) => document.number), attachmentSha256: bytes ? sha(bytes) : null, servedSha256: served?.servedSha256 || null });
    check(`the ${documentType} has an emailed event with its Gmail message id`, matches[0]?.emailed?.length === 1 && Boolean(matches[0].emailed[0].messageId));
  }
  check("an unknown uid is 404", (await syncRequest("GET", "/api/documents/doc_01ARZ3NDEKTSV4RRFFQ69G5FAV/pdf")).status === 404);
  writeFileSync(join(outDir, "storage-documents.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`issued documents proof: ${report.ok ? "OK" : "FAILED"} (${report.checks.filter((entry) => entry.ok).length}/${report.checks.length} checks)`);
  if (!report.ok) throw new Error(`issued documents proof failed: ${JSON.stringify(report.checks.filter((entry) => !entry.ok))}`);
}

// The R2 replica (#12): every issued document of both jobs is in the locked
// MinIO bucket at <org_uid>/<sha256>, byte for byte, and the replica reports
// ok with nothing pending. Written to storage-replica.json.
function replicaCheck(name, ok, detail = null) {
  replicaReport.checks.push({ name, ok: Boolean(ok), ...(detail == null ? {} : { detail }) });
  if (!ok) replicaReport.ok = false;
}
function writeReplicaReport() {
  writeFileSync(join(outDir, "storage-replica.json"), `${JSON.stringify(replicaReport, null, 2)}\n`);
}
async function replicaProof(jobIds) {
  const load = (rel) => import(pathToFileURL(join(repoRoot, rel)).href);
  const { createR2ObjectStore, objectKeyFor } = await load("server/documents/r2-client.js");
  const { DEFAULT_ORG_UID } = await load("server/db-runtime/tenancy.js");
  const store = createR2ObjectStore(minio);
  // Copies are made right after each issue commits; wait for them to land.
  let status = null;
  for (let i = 0; i < 150; i += 1) {
    status = (await syncJson("GET", "/api/storage/status")).documentReplica;
    if (status?.pending === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  replicaCheck("the replica is on, ok, with nothing pending", status?.enabled === true && status.state === "ok" && status.pending === 0, { status });
  const health = await (await fetch(`${base}/health`)).json();
  replicaCheck("/health reports storage.documentReplica ok", health?.storage?.documentReplica?.state === "ok" && health.storage.documentReplica.pending === 0, { documentReplica: health?.storage?.documentReplica ?? null });
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  for (const jobId of jobIds) {
    for (const document of (await syncJson("GET", `/api/jobs/${jobId}/documents`)).documents) {
      const key = objectKeyFor(DEFAULT_ORG_UID, document.pdfSha256);
      const bytes = await store.get(key);
      const head = await store.head(key);
      replicaReport.documents.push({ number: document.number, documentType: document.documentType, key, inBucket: Boolean(bytes), objectSha256: bytes ? sha(bytes) : null, metaSha256: head?.sha256 ?? null });
      replicaCheck(`${document.number}: in the bucket with its recorded hash`, bytes && sha(bytes) === document.pdfSha256 && head.sha256 === document.pdfSha256 && head.contentType === "application/pdf");
    }
  }
  replicaCheck("every issued document was checked (quote, invoice, receipt of job A; quote of job B)", replicaReport.documents.length >= 4, { documents: replicaReport.documents.length });
  writeReplicaReport();
  console.log(`R2 replica proof: ${replicaReport.ok ? "OK" : "FAILED"} (${replicaReport.checks.filter((entry) => entry.ok).length}/${replicaReport.checks.length} checks)`);
  if (!replicaReport.ok) throw new Error(`R2 replica proof failed: ${JSON.stringify(replicaReport.checks.filter((entry) => !entry.ok))}`);
}

// After the servers stop: the operator command finds every stored blob in the
// bucket with the right hash (read-only).
async function verifyR2Proof() {
  let output;
  let code = 0;
  try {
    output = execFileSync(process.execPath, [join(repoRoot, "scripts/documents-verify-r2.js"), "--json"], {
      cwd: repoRoot,
      env: { PATH: baseEnv.PATH, HOME: root, FIELD_DB_URL: storageDb.url, ...replicaEnv },
    }).toString();
  } catch (error) {
    code = error.status;
    output = error.stdout?.toString() || "";
  }
  let report = null;
  try { report = JSON.parse(output); } catch {}
  replicaCheck("npm run documents:verify-r2 exits 0: every blob present with the right hash", code === 0 && report?.ok === true && report.blobs > 0 && report.present === report.blobs,
    { exitCode: code, blobs: report?.blobs ?? null, present: report?.present ?? null, missing: report?.missing?.length ?? null, mismatched: report?.mismatched?.length ?? null });
  writeReplicaReport();
  console.log(`R2 verify: ${replicaReport.ok ? "OK" : "FAILED"} (${report?.present ?? "?"}/${report?.blobs ?? "?"} blobs)`);
  if (!replicaReport.ok) throw new Error(`documents:verify-r2 failed: ${JSON.stringify(replicaReport.checks.filter((entry) => !entry.ok))}`);
}

// The backfill over the proof's data directory after the run: everything the
// files say was issued is already recorded by the live dual-write, so a dry
// run and a real run record nothing new and find no mismatch.
async function backfillProof() {
  const run = (extra) => JSON.parse(execFileSync(process.execPath, [join(repoRoot, "scripts/backfill-issued-documents.js"), "--json", "--data-dir", dataDir, ...extra], {
    cwd: repoRoot,
    env: { PATH: baseEnv.PATH, HOME: root, FIELD_DB_URL: storageDb.url, FIELD_CONFIG: configPath },
  }).toString());
  const dry = run(["--dry-run"]);
  const real = run([]);
  const clean = (report) => report.mismatches.length === 0 && report.conflicts.length === 0 && report.errors.length === 0;
  const result = {
    dryRun: dry,
    run: real,
    ok: clean(dry) && clean(real) && Object.keys(dry.recorded).length === 0 && Object.keys(real.recorded).length === 0 && real.alreadyRecorded > 0,
  };
  writeFileSync(join(outDir, "storage-backfill.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`issued documents backfill: ${result.ok ? "OK" : "FAILED"} (found ${JSON.stringify(real.found)}, already recorded ${real.alreadyRecorded}, new ${JSON.stringify(real.recorded)})`);
  if (!result.ok) throw new Error(`backfill after the proof recorded or refused something: ${JSON.stringify({ dry: dry.recorded, real: real.recorded, mismatches: real.mismatches, conflicts: real.conflicts, errors: real.errors })}`);
}

// Quote rows (#6): the live dual-write left job A's and job B's quote
// versions as rows whose totals equal the totals printed on the quote PDFs
// the proof fetched (a04, b03), with A accepted (landed) and B sent, each
// linked to its issued document. The backfill over the data directory then
// verifies every version (against the renderer and the sent PDFs) and finds
// nothing to write. Results go to storage-quote-rows.json (compare.mjs ignores
// storage-* files).
async function quoteRowsProof({ aid, bid }) {
  const { extractQuotePdfTotals } = await import(pathToFileURL(join(repoRoot, "server/quotes/issued-totals.js")).href);
  const run = (extra) => {
    try {
      return { code: 0, report: JSON.parse(execFileSync(process.execPath, [join(repoRoot, "scripts/backfill-quote-rows.js"), "--json", "--data-dir", dataDir, ...extra], {
        cwd: repoRoot,
        env: { PATH: baseEnv.PATH, HOME: root, FIELD_DB_URL: storageDb.url, FIELD_CONFIG: configPath },
      }).toString()) };
    } catch (error) {
      return { code: error.status, report: JSON.parse(error.stdout?.toString() || "null"), stderr: error.stderr?.toString() || "" };
    }
  };
  const report = { checks: [], ok: true, live: quoteRowStatus, reads: quoteReadStatus };
  const check = (name, ok, detail = null) => {
    report.checks.push({ name, ok: Boolean(ok), ...(detail == null ? {} : { detail }) });
    if (!ok) report.ok = false;
  };
  check("the live dual-write recorded without failures or mismatches", quoteRowStatus?.enabled && quoteRowStatus.failures === 0
    && quoteRowStatus.mismatches === 0 && quoteRowStatus.conflicts === 0 && quoteRowStatus.created > 0, quoteRowStatus);
  if (HAS_QUOTE_READS) {
    check("quote documents and totals were read from the rows (the database's and the mapped files'), never falling back to the files",
      quoteReadStatus?.mode === "rows" && quoteReadStatus.database > 0 && quoteReadStatus.mapped > 0 && quoteReadStatus.files === 0, quoteReadStatus);
  }
  const dry = run(["--dry-run"]);
  const real = run([]);
  report.dryRun = dry.report;
  report.run = real.report;
  const clean = (result) => result.code === 0 && result.report && result.report.mismatches.length === 0
    && result.report.conflicts.length === 0 && result.report.errors.length === 0 && result.report.jobsRefused === 0;
  check("the backfill dry run verifies every version and finds nothing to write", clean(dry)
    && Object.keys(dry.report.actions).every((action) => action === "unchanged"), { code: dry.code, actions: dry.report?.actions, stderr: dry.stderr });
  check("a real backfill run writes nothing new", clean(real)
    && Object.keys(real.report.actions).every((action) => action === "unchanged"), { code: real.code, actions: real.report?.actions });
  const entries = real.report?.entries || [];
  for (const [label, jobId, pdfName, status] of [["job A", aid, "a04-quote.pdf", "accepted"], ["job B", bid, "b03-quote.pdf", "sent"]]) {
    const entry = entries.find((candidate) => candidate.jobId === jobId && candidate.version === 1);
    const printed = extractQuotePdfTotals(readFileSync(join(outDir, pdfName)));
    check(`${label}: quote v1 rows exist, ${status}, linked to its issued document`, entry && entry.status === status && entry.action === "unchanged"
      && /^doc_/.test(entry.issuedDocumentUid || ""), entry ? { status: entry.status, action: entry.action, issuedDocumentUid: entry.issuedDocumentUid } : null);
    check(`${label}: rows' totals equal the totals on ${pdfName} and on the sent PDF`, entry && printed
      && entry.rows.subtotal === printed.subtotal && entry.rows.taxTotal === printed.taxTotal && entry.rows.total === printed.total
      && entry.issued.some((copy) => copy.totals?.total === printed.total),
    { rows: entry?.rows || null, printed, sent: entry?.issued || null });
  }
  writeFileSync(join(outDir, "storage-quote-rows.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`quote rows proof: ${report.ok ? "OK" : "FAILED"} (${report.checks.filter((entry) => entry.ok).length}/${report.checks.length} checks)`);
  if (!report.ok) throw new Error(`quote rows proof failed: ${JSON.stringify(report.checks.filter((entry) => !entry.ok))}`);
}

// Boot backfills (#36): the first server held the quote and invoice row
// backfills, so the restart from an empty disk ran them over the files
// durable storage restored. Both must be recorded, with every proof job checked
// (their rows already present from the live dual-write), nothing refused and
// nothing new written, each logged in one line. Results go to
// storage-boot-backfills.json (compare.mjs ignores storage-* files).
async function bootBackfillProof() {
  const load = (rel) => import(pathToFileURL(join(repoRoot, rel)).href);
  const { getDb, closeDb, queryRows } = await load("server/db-runtime/index.js");
  const { DEFAULT_ORG_UID, withOrg } = await load("server/db-runtime/tenancy.js");
  const { sql } = await import(pathToFileURL(join(repoRoot, "node_modules/drizzle-orm/index.js")).href);
  let rows;
  try {
    rows = await withOrg(getDb({ env: { FIELD_DB_URL: storageDb.url } }), DEFAULT_ORG_UID, (tx) => queryRows(sql`select id, summary from data_migrations`, tx));
  } finally {
    await closeDb();
  }
  const ledger = Object.fromEntries(rows.map((row) => [row.id, typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary]));
  const [quoteId, invoiceId] = BOOT_BACKFILL_IDS;
  const quote = ledger[quoteId];
  const invoice = ledger[invoiceId];
  const lines = restartLog.split("\n").filter((line) => BOOT_BACKFILL_IDS.some((id) => line.includes(`[data-migrations] ${id}:`)));
  const report = { checks: [], ok: true, ledger: { [quoteId]: quote || null, [invoiceId]: invoice || null }, log: lines };
  const check = (name, ok, detail = null) => {
    report.checks.push({ name, ok: Boolean(ok), ...(detail == null ? {} : { detail }) });
    if (!ok) report.ok = false;
  };
  check("the restart's boot recorded the quote rows backfill: every proof job (A, B and the catalogue-sync job) checked, nothing refused, nothing new written", quote
    && quote.jobs >= 2 && quote.refusedJobs === 0 && quote.written === 0 && quote.alreadyPresent === quote.versions && quote.versions >= 2, quote);
  check("the restart's boot recorded the invoice rows backfill: job A checked, nothing refused, nothing new written", invoice
    && invoice.jobsWithMilestones === 1 && invoice.refusedJobs === 0 && invoice.written === 0 && invoice.alreadyPresent === 1, invoice);
  check("boot logged one line per backfill, each recorded", lines.length === 2
    && lines.every((line) => /: nothing to change \(.*0 job\(s\) refused; \d+ warning\(s\)\); recorded$/.test(line)), lines);
  writeFileSync(join(outDir, "storage-boot-backfills.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`boot backfills proof: ${report.ok ? "OK" : "FAILED"} (${report.checks.filter((entry) => entry.ok).length}/${report.checks.length} checks)`);
  if (!report.ok) throw new Error(`boot backfills proof failed: ${JSON.stringify(report.checks.filter((entry) => !entry.ok))}`);
}

// Invoice rows (#27): the live dual-write left job A's milestone invoices as
// rows. Invoice 0 is paid, with exactly the subtotal, GST and total printed on
// the invoice PDF the proof fetched (a08) and a claim line for its subtotal,
// linked to its issued document; its payment (a11) and its receipt, linked to
// the receipt that was emailed (a12), are rows too; invoice 1 is a draft. The
// backfill over the data directory then verifies every issued invoice against
// its PDF and finds nothing to write. Results go to storage-invoice-rows.json
// (compare.mjs ignores storage-* files).
async function invoiceRowsProof({ aid }) {
  const load = (rel) => import(pathToFileURL(join(repoRoot, rel)).href);
  const { extractInvoicePdfTotals } = await load("server/invoices/issued-totals.js");
  const run = (extra) => {
    try {
      const source = extra.includes("--from-storage") ? [] : ["--data-dir", dataDir];
      return { code: 0, report: JSON.parse(execFileSync(process.execPath, [join(repoRoot, "scripts/backfill-invoice-rows.js"), "--json", ...source, ...extra], {
        cwd: repoRoot,
        env: { PATH: baseEnv.PATH, HOME: root, FIELD_DB_URL: storageDb.url, FIELD_CONFIG: configPath },
      }).toString()) };
    } catch (error) {
      return { code: error.status, report: JSON.parse(error.stdout?.toString() || "null"), stderr: error.stderr?.toString() || "" };
    }
  };
  const report = { checks: [], ok: true, live: invoiceRowStatus };
  const check = (name, ok, detail = null) => {
    report.checks.push({ name, ok: Boolean(ok), ...(detail == null ? {} : { detail }) });
    if (!ok) report.ok = false;
  };
  check("the live dual-write recorded without failures, mismatches or conflicts", invoiceRowStatus?.enabled && invoiceRowStatus.failures === 0
    && invoiceRowStatus.mismatches === 0 && invoiceRowStatus.conflicts === 0 && invoiceRowStatus.written > 0, invoiceRowStatus);
  const dry = run(["--dry-run"]);
  const real = run([]);
  report.dryRun = dry.report;
  report.run = real.report;
  const clean = (result) => result.code === 0 && result.report && result.report.mismatches.length === 0
    && result.report.conflicts.length === 0 && result.report.errors.length === 0 && result.report.jobsRefused === 0;
  check("the backfill dry run verifies every invoice and finds nothing to write", clean(dry)
    && Object.keys(dry.report.actions).every((action) => action === "unchanged"), { code: dry.code, actions: dry.report?.actions, stderr: dry.stderr });
  check("a real backfill run writes nothing new", clean(real)
    && Object.keys(real.report.actions).every((action) => action === "unchanged"), { code: real.code, actions: real.report?.actions });
  // From the files restored from durable storage (--from-storage).
  const stored = run(["--from-storage", "--dry-run"]);
  report.fromStorage = stored.report;
  check("--from-storage restores the stored files, verifies the same jobs and finds nothing to write", clean(stored)
    && stored.report.jobsWithMilestones === real.report?.jobsWithMilestones && stored.report.invoices === real.report?.invoices
    && Object.keys(stored.report.actions).every((action) => action === "unchanged"), { code: stored.code, actions: stored.report?.actions, stderr: stored.stderr });

  const { getDb, closeDb } = await load("server/db-runtime/index.js");
  const { DEFAULT_ORG_UID } = await load("server/db-runtime/tenancy.js");
  const { createInvoiceRowService } = await load("server/invoices/invoice-rows.js");
  let rows;
  try {
    rows = await createInvoiceRowService({ db: getDb({ env: { FIELD_DB_URL: storageDb.url } }), orgUid: DEFAULT_ORG_UID }).readJob(aid);
  } finally {
    await closeDb();
  }
  report.rows = rows;
  const detail = JSON.parse(readFileSync(join(outDir, "a15-detail-final.json"), "utf8"));
  const [m0, m1] = detail.meta.milestoneInvoices;
  const printed = extractInvoicePdfTotals(readFileSync(join(outDir, "a08-invoice-0.pdf")));
  // By number: an invoice issued from the sequence is written when it is
  // issued, after the drafts' rows.
  const i0 = rows.invoices.find((invoice) => invoice.number === m0.invoiceNumber);
  const i1 = rows.invoices.find((invoice) => invoice.number === m1.invoiceNumber);
  check("job A: two milestones, two invoices under their numbers as issued", rows.milestones.length === 2 && rows.invoices.length === 2
    && i0 && i1, { numbers: rows.invoices.map((invoice) => invoice.number) });
  if (HAS_INVOICE_ISSUE) {
    check("job A: invoice 0 was issued from the sequence (INV-YYYY-MM-N), with the job number as its reference", /^INV-\d{4}-\d{2}-[1-9]\d*$/.test(i0?.number || "")
      && Boolean(i0?.reference) && i0.reference === detail.meta.jobNumber, { number: i0?.number, reference: i0?.reference, jobNumber: detail.meta.jobNumber });
  }
  check("job A: invoice 0 is paid, with the exact subtotal, GST and total printed on a08-invoice-0.pdf", i0 && printed
    && i0.status === "paid" && i0.subtotal === printed.subtotal && i0.taxTotal === printed.taxTotal && i0.total === printed.total && i0.amountPaid === printed.total,
  { rows: i0 ? { status: i0.status, subtotal: i0.subtotal, taxTotal: i0.taxTotal, total: i0.total, amountPaid: i0.amountPaid } : null, printed });
  check("job A: invoice 0 has one claim line for its subtotal and links its issued document", i0?.lines.length === 1 && i0.lines[0].lineType === "claim"
    && i0.lines[0].lineTotal === i0.subtotal && /^doc_/.test(i0.issuedDocumentUid || ""), { lines: i0?.lines, issuedDocumentUid: i0?.issuedDocumentUid });
  check("job A: invoice 1 is a draft", i1?.status === "draft" && i1.issuedAt === null);
  const [payment] = rows.payments;
  check("job A: the payment is a row against invoice 0, as recorded (a11)", rows.payments.length === 1 && payment.invoiceUid === i0?.uid
    && payment.amount === printed?.total && payment.paidOn === "2026-01-15" && payment.reference === "PROOF-1" && payment.method === "bank_transfer" && payment.voidedAt === null,
  { payments: rows.payments });
  const [receipt] = rows.receipts;
  check("job A: the receipt is a row for that payment, linked to the receipt that was emailed (a12)", rows.receipts.length === 1 && receipt.number === m0.receiptNumber
    && receipt.paymentUid === payment?.uid && receipt.status === "issued" && receipt.amount === printed?.total && /^doc_/.test(receipt.issuedDocumentUid || ""),
  { receipts: rows.receipts });
  writeFileSync(join(outDir, "storage-invoice-rows.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`invoice rows proof: ${report.ok ? "OK" : "FAILED"} (${report.checks.filter((entry) => entry.ok).length}/${report.checks.length} checks)`);
  if (!report.ok) throw new Error(`invoice rows proof failed: ${JSON.stringify(report.checks.filter((entry) => !entry.ok))}`);
}

// Requests for the catalogue-sync proof: not recorded in steps.json and not
// written as compared artefacts.
async function syncRequest(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}
async function syncJson(method, path, body) {
  const { status, buf } = await syncRequest(method, path, body);
  const json = JSON.parse(buf.toString() || "null");
  if (status >= 400) throw Object.assign(new Error(`${method} ${path} -> ${status}: ${buf.toString().slice(0, 400)}`), { status, json });
  return json;
}
async function syncSha(path) {
  const { status, buf } = await syncRequest("GET", path);
  return { status, sha256: createHash("sha256").update(buf).digest("hex") };
}

async function catalogueSyncProof({ aid, bid, fixture, customer, sentEmailCount }) {
  const report = { checks: [], ok: true };
  const check = (name, ok, detail = null) => {
    report.checks.push({ name, ok: Boolean(ok), ...(detail == null ? {} : { detail }) });
    if (!ok) report.ok = false;
  };
  // Job A's quote PDF route answers 410 once the job is invoiced (the same
  // before this change), so A is covered by its issued invoice PDF.
  const sentDocs = {
    "a-invoice-0.pdf": `/api/jobs/${aid}/milestones/0/pdf`,
    "b-quote.pdf": `/api/jobs/${bid}/quote-pdf`,
  };
  const before = {};
  for (const [name, path] of Object.entries(sentDocs)) before[name] = await syncSha(path);

  // (c) every send so far wrote one snapshot row, marked sent.
  const aSnapshots = (await syncJson("GET", `/api/jobs/${aid}/quote-snapshots`)).snapshots;
  const bSnapshots = (await syncJson("GET", `/api/jobs/${bid}/quote-snapshots`)).snapshots;
  const aSent = (sentEmailCount?.sentEmails || []).length;
  check("job A: one snapshot per send (quote, invoice, receipt)", aSnapshots.length === 3
    && aSnapshots.map((row) => row.documentType).join(",") === "quote,invoice,receipt"
    && aSnapshots.every((row) => row.status === "sent" && row.messageId && row.issuanceId), { rows: aSnapshots.length, archived: aSent });
  check("job B: one snapshot for its quote send", bSnapshots.length === 1 && bSnapshots[0].documentType === "quote" && bSnapshots[0].status === "sent");
  check("snapshots name the customer and the totals sent", aSnapshots[0]?.recipients?.to?.[0] === customer && aSnapshots[0]?.total > 0);
  check("as many snapshots as sent emails", aSnapshots.length === aSent, { snapshots: aSnapshots.length, sentEmails: aSent });
  const quoteLineItems = (aSnapshots[0]?.lines || []).flatMap((entry) => entry.lineItems || []);
  check("quote snapshot lines carry catalogue item uids and price ids", quoteLineItems.length > 0
    && quoteLineItems.every((item) => item.catalog?.itemUid && item.catalog?.priceId), { lineItems: quoteLineItems.length });

  // Every active, priced catalogue item goes on a quote as rows that total its
  // catalogue price to the cent (a kit row prices from its component rows, so
  // a kit whose rows drop a recipe's materials allowance would underprice).
  const listed = await syncJson("GET", "/api/price-catalog/items?status=active");
  const items = Array.isArray(listed) ? listed : (listed.items || []);
  const mismatched = [];
  let priced = 0;
  let expanded = 0;
  let withheldRecipe = 0;
  for (const listedItem of items) {
    const quoteLine = await syncJson("GET", `/api/price-catalog/items/${encodeURIComponent(listedItem.uid || listedItem.code)}/quote-line`);
    if (!quoteLine.priced || quoteLine.sellRate == null) continue;
    priced += 1;
    if (quoteLine.components.length) expanded += 1;
    if (quoteLine.componentsWithheld === "recipe") withheldRecipe += 1;
    const total = quoteLine.components.length
      ? quoteLine.components.reduce((sum, part) => (part.pricingContribution === "listed_only" ? sum : sum + part.sellRate * part.quantity), 0)
      : quoteLine.sellRate;
    if (Math.abs(total - quoteLine.sellRate) >= 0.005) mismatched.push({ code: quoteLine.code, sellRate: quoteLine.sellRate, rowsTotal: Math.round(total * 100) / 100 });
  }
  check("every priced catalogue item's quote rows total its catalogue sell price", priced > 0 && mismatched.length === 0,
    { priced, expandedKits: expanded, recipeKitsAsOneRow: withheldRecipe, mismatched: mismatched.slice(0, 10) });

  // (a) a draft with a catalogue-linked row.
  const c = await syncJson("POST", "/api/jobs/manual", { quoteCatalogId: "field-verification", siteAddress: fixture.siteAddress });
  const cid = c.id;
  await syncJson("PUT", `/api/jobs/${cid}/quote-inputs`, fixture.quoteInputs);
  const code = "site-establishment";
  const line = await syncJson("GET", `/api/price-catalog/items/${code}/quote-line`);
  check("quote line carries uid, price id and price key", Boolean(line.itemUid && line.priceId && line.priceKey), { sellRate: line.sellRate });
  const nodeId = "manual:sync-proof";
  const node = {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: "manual-catalog-sync-proof",
    labelOverride: line.name,
    amountVisible: true,
    quantity: 2,
    unit: line.unit,
    sellRate: line.sellRate,
    buyRate: line.buyRate,
    rateMode: "catalog-linked",
    catalogItemCode: line.code,
    catalogItemUid: line.itemUid,
    catalogPriceId: line.priceId,
    catalogPriceKey: line.priceKey,
    catalogSellRate: line.sellRate,
    catalogBuyRate: line.buyRate,
    catalogName: line.name,
    catalogUnit: line.unit,
  };
  await syncJson("POST", `/api/jobs/${cid}/quote-update`, { presentation: { organizer: { root: [nodeId], nodes: { [nodeId]: node } } } });
  const unchanged = await syncJson("GET", `/api/jobs/${cid}/quote/catalog-changes`);
  check("draft matches the catalogue before the change", unchanged.changedCount === 0, { changedCount: unchanged.changedCount });

  await syncJson("PATCH", `/api/price-catalog/items/${code}`, { sell_price: 275, buy_price: 220 });
  const changed = await syncJson("GET", `/api/jobs/${cid}/quote/catalog-changes`);
  const row = changed.lines?.find((entry) => entry.nodeId === nodeId);
  const sellField = row?.fields?.find((field) => field.field === "sellRate");
  check("draft shows the catalogue price change as a row diff", changed.changedCount === 1 && sellField?.from === line.sellRate && sellField?.to === 275,
    { changedCount: changed.changedCount, field: sellField || null });
  // The apply route's contract: defaultOnly is a boolean or absent.
  const badDefaultOnly = await syncRequest("POST", `/api/jobs/${cid}/quote/catalog-changes/apply`, { defaultOnly: "yes" });
  check("apply refuses a defaultOnly that is not true or false", badDefaultOnly.status === 400, { status: badDefaultOnly.status });
  // On checkouts whose apply checks the state each row was reviewed in
  // (shared/quote-catalog-review.js): an edit made after the check survives.
  if (existsSync(join(repoRoot, "shared/quote-catalog-review.js"))) {
    const negotiated = { root: [nodeId], nodes: { [nodeId]: { ...node, rateMode: "manual", sellRate: 260 } } };
    const stale = await syncJson("POST", `/api/jobs/${cid}/quote/catalog-changes/apply`, {
      organizer: negotiated,
      nodeIds: [nodeId],
      reviewed: { [nodeId]: row?.reviewKey },
      expectedCatalogVersion: changed.catalogVersion,
    });
    check("apply skips a row edited after the check that listed it", typeof row?.reviewKey === "string"
      && stale.applied.length === 0 && stale.skipped[0]?.status === "changed_since_review" && stale.organizer.nodes[nodeId].sellRate === 260,
      { applied: stale.applied, skipped: stale.skipped.map((entry) => entry.status), sellRate: stale.organizer.nodes[nodeId].sellRate });
    const unreviewed = await syncJson("POST", `/api/jobs/${cid}/quote/catalog-changes/apply`, { organizer: negotiated });
    check("apply without review data keeps a row edited on the quote", unreviewed.applied.length === 0
      && unreviewed.skipped[0]?.status === "overridden" && unreviewed.organizer.nodes[nodeId].sellRate === 260,
      { applied: unreviewed.applied, skipped: unreviewed.skipped.map((entry) => entry.status) });
  }
  const applied = await syncJson("POST", `/api/jobs/${cid}/quote/catalog-changes/apply`, { nodeIds: [nodeId], expectedCatalogVersion: changed.catalogVersion });
  // The saved organizer (quote-overrides.json). The job detail hides a
  // quote's rates while it is not sendable, which this manual-row draft is
  // not (a manual row has no compiled line-item lineage), so read the save.
  const savedNode = applied.quoteOverrides?.presentation?.organizer?.nodes?.[nodeId];
  check("apply updates and saves the row with its new price link", applied.saved === true
    && savedNode?.sellRate === 275 && savedNode?.buyRate === 220 && savedNode?.catalogPriceId && savedNode.catalogPriceId !== line.priceId,
    { sellRate: savedNode?.sellRate ?? null, priceId: savedNode?.catalogPriceId ?? null, previousPriceId: line.priceId });
  const after = await syncJson("GET", `/api/jobs/${cid}/quote/catalog-changes`);
  check("draft is current after apply", after.changedCount === 0);

  // (b) sent documents never change.
  const locked = await syncRequest("POST", `/api/jobs/${bid}/quote/catalog-changes/apply`, {});
  check("applying to a sent quote is refused", locked.status === 409 && JSON.parse(locked.buf.toString()).code === "QUOTE_LOCKED", { status: locked.status });
  for (const [name, path] of Object.entries(sentDocs)) {
    const now = await syncSha(path);
    check(`${name} is byte-identical after the catalogue change`, now.status === 200 && now.sha256 === before[name].sha256,
      { before: before[name], after: now });
  }

  writeFileSync(join(outDir, "sync-proof.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`catalogue sync proof: ${report.ok ? "OK" : "FAILED"} (${report.checks.filter((entry) => entry.ok).length}/${report.checks.length} checks)`);
  if (!report.ok) throw new Error(`catalogue sync proof failed: ${JSON.stringify(report.checks.filter((entry) => !entry.ok))}`);
}
