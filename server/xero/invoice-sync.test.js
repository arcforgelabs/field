// Issued invoices to Xero (#93, phase 1) against a fake Xero (fake-xero.js)
// and PGlite, with invoices issued by the real issue service: a draft and an
// approved invoice with Field's number, the job and quote reference, Field's
// GST and the issued PDF attached; no duplicate when Xero's answer is lost;
// a 429 waited out or scheduled; totals checked; a refresh Xero rejects
// holds the invoices until the owner connects again; Xero's refusal shown
// with its reason; invoices issued before the connection sent only by an
// owner, after a preview; and no token in any log line.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";
import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createPostgresBlobStore } from "../documents/blob-store.js";
import { claimLineName, claimMoney } from "../invoices/from-milestones.js";
import { createInvoiceIssueService } from "../invoices/issue.js";
import { createXeroHttp } from "./client.js";
import { readXeroSecrets, xeroEndpoints } from "./config.js";
import { createXeroConnectionService } from "./connection.js";
import { startFakeXero } from "./fake-xero.js";
import { createXeroInvoiceSync, syncBackoffMs } from "./invoice-sync.js";

const REDIRECT = "https://field.example.invalid/api/integrations/xero/callback";
const CUSTOMER = { name: "Synthetic Customer Pty Ltd", email: "accounts@customer.example.invalid" };
let xero;
let testDb;
let now;
let logs;
let connection;
let sync;
let issuer;
let issued = 0;

before(async () => {
  xero = await startFakeXero();
});
after(async () => {
  await xero?.close();
});

beforeEach(async () => {
  xero.state.invoices.length = 0;
  xero.state.contacts.length = 0;
  xero.state.attachments.length = 0;
  xero.state.failures.length = 0;
  xero.state.idempotency.clear();
  xero.state.calls.length = 0;
  xero.state.ignoreTaxAmount = false;
  testDb = await createTestDb();
  now = new Date("2026-10-13T00:00:00.000Z");
  logs = [];
  const log = (...args) => logs.push(args.map(String).join(" "));
  const logger = { log, warn: log, error: log, info: log };
  const secrets = readXeroSecrets({ XERO_CLIENT_ID: xero.clientId, XERO_CLIENT_SECRET: xero.clientSecret });
  const http = (s = secrets) => createXeroHttp({ clientId: s.clientId, clientSecret: s.clientSecret, endpoints: xeroEndpoints(xero.base), sleep: async () => {} });
  connection = createXeroConnectionService({ db: testDb.db, orgUid: DEFAULT_ORG_UID, secrets, http, now: () => now, logger });
  sync = createXeroInvoiceSync({ db: testDb.db, orgUid: DEFAULT_ORG_UID, connection, http: () => http(), blobs: createPostgresBlobStore(), now: () => now, logger, kickDelayMs: 0 });
  issuer = createInvoiceIssueService({ db: testDb.db, orgUid: DEFAULT_ORG_UID, now: () => now });
  await withOrg(testDb.db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`insert into quotes (uid, job_id, number, version, status, subtotal, tax_total, total, created_at, updated_at)
    values ('qte_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'job-xero', 'EQ-2610-07', 2, 'accepted', 800, 80, 880, now(), now())`));
});

afterEach(async () => {
  await sync.stop();
  await testDb.close();
  for (const line of logs) for (const secret of xero.issuedSecrets()) assert.ok(!line.includes(secret), "no token, code or secret in any log line");
});

async function connect() {
  const { url } = await connection.startConnect({ redirectUri: REDIRECT, actor: "Owner" });
  const back = await xero.authorize(url);
  await connection.completeConnect({ code: back.searchParams.get("code"), state: back.searchParams.get("state"), redirectUri: REDIRECT });
}

function claim({ subtotal = "400.00", gst = "40.00", total = "440.00" } = {}) {
  const money = claimMoney({ subtotal, gst, total, taxRate: "10.000", milestoneKey: "0", name: claimLineName({ label: "Deposit", percent: "50.000", quoteReference: "EQ-2610-07 v2" }), description: "Milestone 1 of 2" });
  return { milestoneKey: "0", kind: "deposit", revision: 1, currency: "AUD", quoteVersion: 2, quoteVersionInferred: false, ...money.totals, taxTotalSource: money.taxTotalSource, taxTotalReason: money.taxTotalReason, lines: money.lines, dueOn: null, note: null };
}

async function issue(money = {}, { customer = CUSTOMER } = {}) {
  issued += 1;
  return issuer.issueInvoice({
    jobId: "job-xero",
    idempotencyKey: `xero-test-${issued}-${Math.random()}`,
    reference: "2610-07",
    issuedAt: now.toISOString(),
    issuedBy: "Owner",
    invoice: claim(money),
    details: { milestoneIndex: 0, customer },
    render: async (number) => Buffer.from(`%PDF-1.4\nTax invoice ${number}\n%%EOF\n`),
  });
}

async function row(invoiceUid) {
  const [found] = await withOrg(testDb.db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select s.*, i.xero_invoice_id as invoice_xero_id, i.xero_status as invoice_xero_status
    from xero_invoice_syncs s join invoices i on i.uid = s.invoice_uid where s.invoice_uid = ${invoiceUid}`, tx));
  return found || null;
}

const advance = (ms) => { now = new Date(now.getTime() + ms); };

test("a draft: Field's number, the job and quote reference, Field's GST per line, the contact, the PDF attached, and the id on the invoice row", async () => {
  await connect();
  advance(1000);
  const result = await issue();
  await sync.tick();
  assert.equal(xero.state.invoices.length, 1);
  const [created] = xero.state.invoices;
  assert.equal(created.Type, "ACCREC");
  assert.equal(created.Status, "DRAFT");
  assert.equal(created.InvoiceNumber, result.number);
  assert.equal(created.Reference, "Job 2610-07 · Quote EQ-2610-07 v2");
  assert.equal(created.LineAmountTypes, "Exclusive");
  assert.equal(created.CurrencyCode, "AUD");
  assert.equal(created.Date, "2026-10-13");
  assert.equal(created.LineItems.length, 1);
  assert.equal(created.LineItems[0].AccountCode, "200");
  assert.equal(created.LineItems[0].TaxType, "OUTPUT");
  assert.equal(created.LineItems[0].TaxAmount, 40);
  assert.equal(created.LineItems[0].Description, `${claim().lines[0].name}\nMilestone 1 of 2`, "the line as Field's invoice row has it");
  assert.deepEqual([created.SubTotal, created.TotalTax, created.Total], [400, 40, 440]);

  assert.equal(xero.state.contacts.length, 1);
  assert.equal(xero.state.contacts[0].Name, CUSTOMER.name);
  assert.equal(xero.state.contacts[0].EmailAddress, CUSTOMER.email);
  assert.equal(created.Contact.ContactID, xero.state.contacts[0].ContactID);

  assert.equal(xero.state.attachments.length, 1);
  assert.equal(xero.state.attachments[0].FileName, `${result.number}.pdf`);
  assert.equal(xero.state.attachments[0].MimeType, "application/pdf");
  assert.equal(xero.state.attachments[0].IncludeOnline, true);
  assert.deepEqual(xero.state.attachments[0].bytes, result.pdfBytes, "the issued bytes, exactly");

  const put = xero.state.calls.find((call) => call.method === "PUT" && call.path.endsWith("/Invoices"));
  assert.match(put.headers["idempotency-key"], new RegExp(`^field-${result.invoiceUid}-invoice-[0-9a-f]{16}$`), "derived from Field's invoice uid");
  assert.ok(put.headers["idempotency-key"].length <= 128);

  const stored = await row(result.invoiceUid);
  assert.equal(stored.state, "created");
  assert.equal(stored.queued_by, "auto");
  assert.equal(stored.invoice_xero_id, created.InvoiceID);
  assert.equal(stored.invoice_xero_status, "DRAFT");
  assert.ok(stored.attached_at);
  const status = await sync.jobStatus("job-xero");
  assert.equal(status.invoices[result.number].label, "Xero draft created");

  // A second invoice for the same customer finds the contact by email.
  await issue();
  await sync.tick();
  assert.equal(xero.state.contacts.length, 1);
  assert.equal(xero.state.invoices.length, 2);
});

test("an approved invoice: AUTHORISED with a due date, and nothing emailed", async () => {
  await connect();
  await connection.updateSettings({ createMode: "authorised", salesAccountCode: "4000" });
  advance(1000);
  const result = await issue();
  await sync.tick();
  const [created] = xero.state.invoices;
  assert.equal(created.Status, "AUTHORISED");
  assert.equal(created.DueDate, "2026-10-13");
  assert.equal(created.LineItems[0].AccountCode, "4000");
  assert.ok(!xero.state.calls.some((call) => call.path.endsWith("/Email")), "Xero is never asked to email it");
  assert.equal((await sync.jobStatus("job-xero")).invoices[result.number].label, "Approved in Xero");
});

test("idempotent: when Xero's answer is lost after it created the invoice, the retry finds it and creates no second one", async () => {
  await connect();
  advance(1000);
  const result = await issue();
  xero.failNext({ method: "PUT", match: /\/Invoices$/, status: 504, afterProcessing: true });
  await sync.tick();
  assert.equal(xero.state.invoices.length, 1, "Xero has it");
  const waiting = await row(result.invoiceUid);
  assert.equal(waiting.state, "pending");
  assert.equal(waiting.last_error_code, "XERO_UNAVAILABLE");
  assert.equal(waiting.attempts, 1);
  assert.equal(new Date(waiting.next_attempt_at).getTime(), now.getTime() + syncBackoffMs(1));

  // Before it is due nothing happens; once due, the retry adopts Xero's invoice.
  await sync.tick();
  assert.equal(xero.state.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/Invoices")).length, 1);
  advance(syncBackoffMs(1));
  await sync.tick();
  assert.equal(xero.state.invoices.length, 1, "no duplicate");
  const done = await row(result.invoiceUid);
  assert.equal(done.state, "created");
  assert.equal(done.invoice_xero_id, xero.state.invoices[0].InvoiceID);
  assert.equal(xero.state.attachments.length, 1);

  // The same request again with the same key is replayed by Xero, not repeated.
  const put = xero.state.calls.find((call) => call.method === "PUT" && call.path.endsWith("/Invoices"));
  const replay = await fetch(`${xero.base}/api.xro/2.0/Invoices?unitdp=4`, { method: "PUT", headers: { ...put.headers, host: undefined }, body: JSON.stringify(put.body) });
  assert.equal(replay.status, 200);
  assert.equal(xero.state.invoices.length, 1);
});

test("a 429: a short Retry-After is waited out at once; a long one is scheduled", async () => {
  await connect();
  advance(1000);
  const first = await issue();
  xero.failNext({ method: "PUT", match: /\/Invoices$/, status: 429, headers: { "retry-after": "1", "x-rate-limit-problem": "minute" } });
  await sync.tick();
  assert.equal((await row(first.invoiceUid)).state, "created", "waited one second and tried again");
  assert.equal(xero.state.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/Invoices")).length, 2);

  const second = await issue();
  xero.failNext({ method: "PUT", match: /\/Invoices$/, status: 429, headers: { "retry-after": "600", "x-rate-limit-problem": "day" }, times: 1 });
  await sync.tick();
  const waiting = await row(second.invoiceUid);
  assert.equal(waiting.state, "pending");
  assert.equal(waiting.last_error_code, "XERO_RATE_LIMITED");
  assert.equal(new Date(waiting.next_attempt_at).getTime(), now.getTime() + 600_000, "Xero's Retry-After, longer than the backoff");
  advance(600_000);
  await sync.tick();
  assert.equal((await row(second.invoiceUid)).state, "created");
});

test("totals: Field's GST to the cent, and a difference in Xero is flagged", async () => {
  await connect();
  advance(1000);
  // GST issued as a share of the quote's: 33.34 on 333.33, a cent above 10%.
  const printed = await issue({ subtotal: "333.33", gst: "33.34", total: "366.67" });
  await sync.tick();
  const exact = xero.state.invoices.at(-1);
  assert.equal(exact.LineItems[0].TaxAmount, 33.34);
  assert.equal(exact.Total, 366.67);
  assert.equal((await row(printed.invoiceUid)).state, "created");

  xero.state.ignoreTaxAmount = true;
  const differs = await issue({ subtotal: "333.33", gst: "33.34", total: "366.67" });
  await sync.tick();
  const flagged = await row(differs.invoiceUid);
  assert.equal(flagged.state, "mismatch");
  assert.equal(flagged.last_error_code, "XERO_TOTALS_DIFFER");
  assert.match(flagged.last_error_reason, /Xero \$333\.33 \+ GST \$33\.33 = \$366\.66; Field \$333\.33 \+ GST \$33\.34 = \$366\.67/);
  assert.equal((await sync.jobStatus("job-xero")).invoices[differs.number].label, "In Xero, totals differ");
  assert.ok(!logs.some((line) => line.includes("366")), "amounts stay out of the log");
});

test("a refresh Xero rejects: the connection needs the owner, the invoice waits, and goes once connected again", async () => {
  await connect();
  advance(1000);
  xero.revokeAllRefreshTokens();
  advance(40 * 60_000);
  const result = await issue();
  await sync.tick();
  const status = await connection.status();
  assert.equal(status.connection.status, "needs_reconnect");
  assert.equal(status.connection.reconnectReason, "XERO_REFRESH_REJECTED");
  const waiting = await row(result.invoiceUid);
  assert.equal(waiting.state, "pending");
  assert.equal(waiting.last_error_code, "XERO_NOT_CONNECTED");
  assert.equal(waiting.attempts, 0, "waiting for the owner is not a failed attempt");
  assert.equal((await sync.jobStatus("job-xero")).invoices[result.number].label, "Waiting for Xero");
  assert.equal(xero.state.invoices.length, 0);

  await connect();
  await sync.tick();
  assert.equal((await row(result.invoiceUid)).state, "created");
});

test("Xero refuses it: failed with Xero's reason, not retried by itself; the owner's Retry sends it again", async () => {
  await connect();
  advance(1000);
  const result = await issue();
  xero.failNext({ method: "PUT", match: /\/Invoices$/, status: 400, body: { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: "Account code '200' is not a valid code for this document." }] }] } });
  await sync.tick();
  const refused = await row(result.invoiceUid);
  assert.equal(refused.state, "failed");
  assert.equal(refused.last_error_code, "XERO_VALIDATION");
  assert.equal(refused.last_error_reason, "Xero refused it: Account code '200' is not a valid code for this document.");
  const shown = (await sync.jobStatus("job-xero")).invoices[result.number];
  assert.equal(shown.label, "Xero failed");
  assert.equal(shown.canRetry, true);
  assert.ok(!logs.some((line) => line.includes("Account code")), "Xero's message is shown to the owner, not logged");
  advance(24 * 60 * 60_000);
  await sync.tick();
  assert.equal((await row(result.invoiceUid)).state, "failed", "not retried by itself");

  await sync.retry({ invoiceUid: result.invoiceUid, actor: "Owner" });
  await sync.tick();
  assert.equal((await row(result.invoiceUid)).state, "created");
});

test("retryable failures stop after the last attempt as failed", async () => {
  await connect();
  advance(1000);
  const result = await issue();
  xero.failNext({ method: "PUT", match: /\/Invoices$/, status: 503, times: 20 });
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await sync.tick();
    advance(60 * 60_000);
  }
  const stopped = await row(result.invoiceUid);
  assert.equal(stopped.state, "failed");
  assert.equal(stopped.attempts, 8);
  assert.match(stopped.last_error_reason, /stopped after 8 tries; press Retry/);
});

test("invoices issued before the connection are not sent by themselves; an owner previews and sends them", async () => {
  const earlier = await issue();
  advance(60_000);
  await connect();
  advance(1000);
  await sync.tick();
  assert.equal(xero.state.invoices.length, 0, "not sent by itself");
  assert.equal((await sync.jobStatus("job-xero")).invoices[earlier.number].label, "Not sent to Xero");
  assert.equal((await sync.jobStatus("job-xero")).invoices[earlier.number].canSend, true);

  const preview = await sync.preview({ issuedSince: new Date("2026-10-01T00:00:00.000Z") });
  assert.equal(preview.mode, "draft");
  assert.deepEqual(preview.invoices.map((entry) => [entry.number, entry.customer, entry.total, entry.creates]), [[earlier.number, CUSTOMER.name, "440.00", "Draft invoice"]]);
  assert.equal(xero.state.invoices.length, 0, "a preview writes nothing");

  await sync.push({ invoiceUids: [earlier.invoiceUid], actor: "Owner" });
  await sync.tick();
  assert.equal(xero.state.invoices.length, 1);
  const sent = await row(earlier.invoiceUid);
  assert.equal(sent.state, "created");
  assert.equal(sent.queued_by, "owner");
  assert.equal(sent.requested_by, "Owner");
  assert.deepEqual((await sync.preview({ invoiceUids: [earlier.invoiceUid] })).invoices, [], "already in Xero");
});

test("an invoice credited in Field before it reached Xero is not sent (credit notes are phase 2)", async () => {
  await connect();
  advance(1000);
  const result = await issue();
  await withOrg(testDb.db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`update invoices set status = 'credited' where uid = ${result.invoiceUid}`));
  // Queued while it was issued, credited before the send ran.
  await withOrg(testDb.db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`insert into xero_invoice_syncs (invoice_uid, state, mode, queued_by, queued_at, created_at, updated_at)
    values (${result.invoiceUid}, 'pending', 'draft', 'auto', now(), now(), now())`));
  await sync.tick();
  const skipped = await row(result.invoiceUid);
  assert.equal(skipped.state, "skipped");
  assert.match(skipped.last_error_reason, /credited or voided in Field before it reached Xero/);
  assert.equal(xero.state.invoices.length, 0);
  const shown = (await sync.jobStatus("job-xero")).invoices[result.number];
  assert.equal(shown.label, "Not sent to Xero");
  assert.equal(shown.canRetry, false);
});

test("Create in Xero off: nothing is queued by itself", async () => {
  await connect();
  await connection.updateSettings({ createMode: "off" });
  advance(1000);
  const result = await issue();
  await sync.tick();
  assert.equal(xero.state.invoices.length, 0);
  assert.equal(await row(result.invoiceUid), null);
});

test("a contact whose name Xero already has is found, not created twice", async () => {
  await connect();
  xero.state.contacts.push({ ContactID: "00000000-0000-0000-0000-00000000c0de", Name: CUSTOMER.name, EmailAddress: "", ContactStatus: "ACTIVE" });
  advance(1000);
  await issue();
  await sync.tick();
  assert.equal(xero.state.contacts.length, 1);
  assert.equal(xero.state.invoices[0].Contact.ContactID, "00000000-0000-0000-0000-00000000c0de");
});
