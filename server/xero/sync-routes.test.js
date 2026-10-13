// Issued invoices reach the owner's Xero through the real server (#93), with
// a fake Xero (fake-xero.js) and synthetic data: sending an invoice issues it
// and the sync creates the Xero draft with Field's PDF; Xero failing never
// stops an invoice being issued or emailed; the job shows each invoice's Xero
// state to everyone, and only owners may send, preview or retry.
import assert from "node:assert/strict";
import test from "node:test";
import { boot, seedJobs, sha } from "../../scripts/quote-invoice-proof/email-test-server.mjs";
import { startFakeXero } from "./fake-xero.js";

const STAFF = { email: "staff.member@example.invalid", password: "xero-sync-staff-password", role: "user", name: "Staff Member" };
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

test("issued invoices go to Xero without holding up issuing or email; owners alone send and retry", { timeout: 600_000 }, async (t) => {
  const xero = await startFakeXero();
  t.after(() => xero.close());
  const { api, signIn, output, base, mail } = await boot(t, {
    extraUsers: [STAFF],
    config: { publicUrl: "https://field.example.invalid" },
    env: { XERO_CLIENT_ID: xero.clientId, XERO_CLIENT_SECRET: xero.clientSecret, FIELD_XERO_FAKE_BASE_URL: xero.base, FIELD_XERO_SYNC_INTERVAL_MS: "1000" },
  });
  const ok = (result, label) => assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.body)}\n${output.join("").slice(-3000)}`);
  const staff = await signIn(STAFF.email, STAFF.password);
  const anonymous = async (path, { method = "GET", body } = {}) => (await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })).status;

  const ownerRoutes = [
    ["POST", "/api/integrations/xero/push/preview", { sinceDays: 30 }],
    ["POST", "/api/integrations/xero/push", { invoiceUids: ["inv_01ARZ3NDEKTSV4RRFFQ69G5FAV"] }],
    ["POST", "/api/integrations/xero/invoices/inv_01ARZ3NDEKTSV4RRFFQ69G5FAV/retry"],
    ["GET", "/api/integrations/xero/codes"],
  ];
  for (const [method, path, body] of ownerRoutes) {
    assert.equal(await anonymous(path, { method, body }), 401, `${method} ${path} without a sign-in`);
    assert.equal((await staff(path, { method, body })).status, 403, `${method} ${path} as staff`);
  }
  assert.equal((await api("/api/integrations/xero/push", { method: "POST", body: {} })).status, 400);

  // Connect, then issue: job A's deposit invoice is sent to the customer.
  const connect = await api("/api/integrations/xero/connect", { method: "POST" });
  const back = await xero.authorize(connect.body.url);
  assert.equal((await fetch(`${base}${back.pathname}${back.search}`, { redirect: "manual" })).headers.get("location"), "/#/settings?section=integrations&xero=connected");
  const codes = await api("/api/integrations/xero/codes");
  assert.equal(codes.status, 200);
  assert.equal(codes.body.available, true);
  assert.ok(codes.body.accounts.some((account) => account.code === "200"));
  assert.equal((await api("/api/integrations/xero/settings", { method: "PUT", body: { salesAccountCode: "310" } })).status, 400, "an expense account is refused");
  const { aid } = await seedJobs(api, ok);

  let status = null;
  for (const until = Date.now() + 60_000; Date.now() < until;) {
    status = await api(`/api/jobs/${aid}/xero`);
    if (Object.values(status.body.invoices).some((entry) => entry.state === "created")) break;
    await sleep(250);
  }
  const [number, deposit] = Object.entries(status.body.invoices)[0];
  assert.equal(deposit.state, "created", JSON.stringify(status.body));
  assert.equal(deposit.label, "Xero draft created");
  assert.equal(xero.state.invoices.length, 1);
  assert.equal(xero.state.invoices[0].InvoiceNumber, number);
  assert.equal(xero.state.invoices[0].Status, "DRAFT");
  assert.match(xero.state.invoices[0].Reference, /^Job .+ · Quote .+ v\d+$/);
  assert.equal(xero.state.invoices[0].Total, Number(xero.state.invoices[0].SubTotal) + Number(xero.state.invoices[0].TotalTax));
  const issued = (await api(`/api/jobs/${aid}/documents`)).body.documents.find((document) => document.number === number);
  assert.equal(issued.emailed ? true : Boolean(issued.events.find((event) => event.event === "emailed")), true, "the customer was emailed it");
  assert.equal(sha(xero.state.attachments[0].bytes), issued.pdfSha256, "the PDF in Xero is the issued one, byte for byte");

  // Staff see the state, without owner actions.
  const seen = await staff(`/api/jobs/${aid}/xero`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.invoices[number].label, "Xero draft created");

  // Xero is down: the completion invoice is still issued and emailed at once.
  xero.failNext({ method: "PUT", match: /\/Invoices$/, status: 503, times: 1000 });
  xero.failNext({ method: "GET", match: /\/Invoices$/, status: 503, times: 1000 });
  const mailBefore = (await mail()).length;
  const sent = await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: "customer@example.invalid", documentType: "invoice", milestoneIndex: 1 } });
  ok(sent, "send the completion invoice while Xero is down");
  assert.equal((await mail()).length, mailBefore + 1, "the customer's email went");
  let waiting = null;
  for (const until = Date.now() + 30_000; Date.now() < until;) {
    waiting = Object.values((await api(`/api/jobs/${aid}/xero`)).body.invoices).find((entry) => entry.state === "pending" && entry.reason);
    if (waiting) break;
    await sleep(250);
  }
  assert.ok(waiting, "the completion invoice waits to retry");
  assert.equal(waiting.label, "Sending to Xero");
  assert.match(waiting.reason, /tries again by itself/);

  // An owner's preview of the last 30 days writes nothing; the invoices already queued are not offered again.
  const preview = await api("/api/integrations/xero/push/preview", { method: "POST", body: { sinceDays: 30 } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.wroteNothing, true);
  assert.deepEqual(preview.body.invoices, []);

  const log = output.join("");
  for (const secret of xero.issuedSecrets()) assert.ok(!log.includes(secret), "no token, code or secret in the server log");
  assert.ok(!log.includes("customer@example.invalid"), "no customer in the server log");
});
