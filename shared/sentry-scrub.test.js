import assert from "node:assert/strict";
import test from "node:test";
import { createEventThrottle, scrubBreadcrumb, scrubEvent, scrubLog, scrubText, scrubValue } from "./sentry-scrub.js";
import { generateSecretsKey } from "./secrets-web.js";

test("anything shaped like a FIELD_SECRETS_KEY is cut from free text, breadcrumbs and values", () => {
  const key = generateSecretsKey().text;
  const hex = Buffer.from(generateSecretsKey().bytes).toString("hex");
  assert.equal(scrubText(`pasted ${key} here`), "pasted [key] here");
  assert.equal(scrubText(`hex ${hex}`), "hex [key]");
  const click = scrubBreadcrumb({ category: "ui.click", message: `div.xwiz__key.sentry-block > input.fx-input[value="${key}"]` });
  assert.ok(!click.message.includes(key));
  const crumb = scrubBreadcrumb({ category: "fetch", data: { url: `/api/x?k=${key}`, key, keyText: key, note: key } });
  assert.ok(!JSON.stringify(crumb).includes(key));
  assert.ok(!JSON.stringify(scrubEvent({ message: key, extra: { generated: key } })).includes(key));
  // A release or a UUID is not a key.
  assert.equal(scrubText("release 2026.10.13 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b"), "release 2026.10.13 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b");
});

const JOB_UUID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

test("free text loses emails, phone numbers, BSBs and query strings", () => {
  assert.equal(
    scrubText("Send to jane.citizen@example.com.au failed"),
    "Send to [email] failed",
  );
  for (const phone of ["0412 345 678", "0412345678", "(08) 8123 4567", "+61 412 345 678", "1300 123 456"]) {
    assert.equal(scrubText(`call ${phone} now`), "call [phone] now", phone);
  }
  assert.equal(scrubText("BSB 065-000 account"), "BSB [bsb] account");
  assert.equal(
    scrubText("GET https://field.example.com/api/jobs?token=abc123&q=smith"),
    "GET https://field.example.com/api/jobs?[query]",
  );
  assert.equal(scrubText("/#/pricing?health=1&status=all"), "/#/pricing?[query]");
});

test("free text loses document numbers and money amounts", () => {
  for (const number of ["EQ-2501-01", "EQ-2501-01 v2", "EI-2501-01-M1", "EI-2501-01-M1-R2", "ER-2501-01-M1", "INV-2026-10-3", "RCT-2026-1-12", "CN-2026-1-1"]) {
    assert.equal(scrubText(`issued ${number} today`), "issued [doc] today", number);
  }
  assert.equal(scrubText("attach invoices/EI-2501-01-M1.pdf"), "attach invoices/[doc].pdf");
  for (const amount of ["$1,234.56", "$90", "A$90.00", "AUD 925", "-$12.00", "925.50", "1,018.05", "-12.50"]) {
    assert.equal(scrubText(`claims ${amount} in all`), "claims [amount] in all", amount);
  }
  assert.equal(
    scrubText("refused job 00000000-0000-4000-8000-000000000001: EI-2501-01-M1 totals: subtotal rows 900.00 vs revision-pdf 925.50"),
    "refused job 00000000-0000-4000-8000-000000000001: [doc] totals: subtotal rows [amount] vs revision-pdf [amount]",
  );
});

test("uuids, versions, timestamps, durations, status codes and counts stay", () => {
  for (const text of [
    `job ${JOB_UUID} v3`,
    "node 24.10.0, release 1.2.3",
    "at 2026-10-13T01:02:03.456Z, 12:30:45.12",
    "took 12.34ms (450 ms)",
    "GET /api/jobs 500 from 203.0.113.10",
    "7 job(s), 14 invoice(s): 6 written, 1 refused",
    "migration 2026-10-13-invoice-rows-backfill",
    "sha256 0a1b2c3d4e5f",
  ]) {
    assert.equal(scrubText(text), text);
  }
});

test("job segments are kept when they are UUIDs and redacted when they could be an address", () => {
  assert.equal(scrubText(`/api/jobs/${JOB_UUID}/quote`), `/api/jobs/${JOB_UUID}/quote`);
  assert.equal(scrubText("/api/jobs/12-main-st-exampleton/quote"), "/api/jobs/[job]/quote");
  assert.equal(scrubText("POST /api/jobs/manual"), "POST /api/jobs/manual");
  assert.equal(
    scrubText("ENOENT: open '/app/data/2026-01-04/12-main-st-exampleton/quote.json'"),
    "ENOENT: open '/app/data/2026-01-04/[job]/quote.json'",
  );
  assert.equal(scrubText(`/app/data/2026-10-12/${JOB_UUID}/job.json`), `/app/data/2026-10-12/${JOB_UUID}/job.json`);
});

test("free text loses credentials: bearer tokens, JSON web tokens and OAuth values (#93)", () => {
  // A fake JSON web token, joined here so secret scanners do not take the test for a leak.
  const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJmYWtlIn0", "c2lnbmF0dXJlLWZha2U"].join(".");
  assert.equal(scrubText(`fetch failed: Authorization: Bearer ${jwt}`), "fetch failed: Authorization: Bearer [token]");
  assert.equal(scrubText(`token ${jwt} expired`), "token [token] expired");
  assert.equal(scrubText("grant_type=refresh_token&refresh_token=fake-refresh-0123456789abcdef"), "grant_type=refresh_token&refresh_token=[token]");
  assert.equal(scrubText('{"access_token": "fake-access-0123456789", "expires_in": 1800}'), '{"access_token": "[token]", "expires_in": 1800}');
  assert.equal(scrubText("client_secret=fake-secret-value-123 code=fake-code-abcdef"), "client_secret=[token] code=[token]");
  assert.equal(scrubText("Basic ZmFrZS1jbGllbnQ6ZmFrZS1zZWNyZXQ="), "Basic [token]");
  // Codes and ordinary words stay.
  assert.equal(scrubText("[xero] refresh failed (XERO_REFRESH_REJECTED)"), "[xero] refresh failed (XERO_REFRESH_REJECTED)");
  assert.equal(scrubText("status code 429"), "status code 429");
});

test("long text is cut short", () => {
  const text = scrubText("x".repeat(5000));
  assert.ok(text.length < 1100);
  assert.ok(text.endsWith("…[cut]"));
});

test("values under customer, contact, money and credential keys are redacted", () => {
  const out = scrubValue({
    customerName: "Jane Citizen",
    siteAddress: "12 Main St",
    contact: { phone: "0412 345 678" },
    jobTitle: "Retaining wall, 12 Main St",
    bank: { bsb: "065-000", accountNumber: "12345678" },
    notes: "gate code 1234",
    authToken: "secret",
    status: "quoted",
    total: 1234.5,
  });
  assert.deepEqual(out, {
    customerName: "[redacted]",
    siteAddress: "[redacted]",
    contact: "[redacted]",
    jobTitle: "[redacted]",
    bank: "[redacted]",
    notes: "[redacted]",
    authToken: "[redacted]",
    status: "quoted",
    total: 1234.5,
  });
});

test("events drop request payloads, the user and local variables, and scrub messages", () => {
  const event = scrubEvent({
    message: "Quote for jane@example.com",
    request: {
      url: "https://field.example.com/api/jobs/12-main-st?token=abc",
      query_string: "token=abc",
      data: { customer: "Jane" },
      cookies: { session: "abc" },
      headers: { authorization: "Bearer abc", cookie: "a=b", "User-Agent": "Mozilla/5.0" },
      env: { REMOTE_ADDR: "203.0.113.1" },
    },
    user: { id: "u1", email: "x@y.z", ip_address: "203.0.113.1" },
    exception: {
      values: [{
        type: "Error",
        value: "Gmail refused jane@example.com (0412 345 678)",
        stacktrace: { frames: [{ filename: "/app/data/2026-01-04/12-main-st/x.js", vars: { customer: "Jane" } }] },
      }],
    },
    breadcrumbs: [
      { category: "console", message: "Saved quote for Jane Citizen" },
      { category: "fetch", data: { url: "/api/jobs?search=smith", method: "GET", status_code: 500 } },
      { category: "ui.click", message: 'div.job-card > button[aria-label="Open Jane Citizen, 12 Main St"]' },
    ],
    extra: { email: "x@y.z", status: "quoted" },
    tags: { customer: "Jane", area: "scheduled-email" },
    transaction: "GET /api/jobs?token=abc",
    contexts: { trace: { data: { "http.query": "token=abc", "url.query": "token=abc", "http.target": "/api/jobs?token=abc" } } },
    spans: [{ description: "GET https://example.com/a?token=abc", data: { "url.full": "https://example.com/a?token=abc", "http.query": "token=abc" } }],
  });
  assert.equal(event.message, "Quote for [email]");
  assert.deepEqual(event.request, {
    url: "https://field.example.com/api/jobs/[job]?[query]",
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  assert.equal(event.user, undefined);
  const [exception] = event.exception.values;
  assert.equal(exception.value, "Gmail refused [email] ([phone])");
  assert.deepEqual(exception.stacktrace.frames, [{ filename: "/app/data/2026-01-04/[job]/x.js" }]);
  assert.equal(event.breadcrumbs.length, 2);
  assert.equal(event.breadcrumbs[0].data.url, "/api/jobs?[query]");
  assert.equal(event.breadcrumbs[0].data.status_code, 500);
  assert.equal(event.breadcrumbs[1].message, 'div.job-card > button[aria-label="…"]');
  assert.deepEqual(event.extra, { email: "[redacted]", status: "quoted" });
  assert.deepEqual(event.tags, { customer: "[redacted]", area: "scheduled-email" });
  assert.equal(event.transaction, "GET /api/jobs?[query]");
  assert.equal(event.spans[0].description, "GET https://example.com/a?[query]");
  assert.equal(event.spans[0].data["url.full"], "https://example.com/a?[query]");
  assert.equal(event.spans[0].data["http.query"], "[redacted]");
  assert.deepEqual(event.contexts.trace.data, { "http.query": "[redacted]", "url.query": "[redacted]", "http.target": "/api/jobs?[query]" });
});

test("console breadcrumbs never leave", () => {
  assert.equal(scrubBreadcrumb({ category: "console", level: "error", message: "Jane" }), null);
  assert.deepEqual(scrubBreadcrumb({ category: "navigation", data: { from: "/#/jobs", to: "/#/jobs/12-main-st" } }), {
    category: "navigation",
    data: { from: "/#/jobs", to: "/#/jobs/[job]" },
  });
});

test("log lines get the same scrubbing as error messages", () => {
  assert.deepEqual(
    scrubLog({ level: "error", message: "[email-quote] failed for jane@example.com", attributes: { recipient: "jane@example.com", "sentry.origin": "auto.console.logging" } }),
    { level: "error", message: "[email-quote] failed for [email]", attributes: { recipient: "[redacted]", "sentry.origin": "auto.console.logging" } },
  );
});

test("log lines lose document numbers and amounts, in the message and in console parameters", () => {
  assert.deepEqual(
    scrubLog({
      level: "warn",
      message: "[invoice-rows] EI-2501-01-M1 total 990.00 vs 1018.05",
      attributes: {
        "sentry.message.template": "[invoice-rows] {} {} {}",
        "sentry.message.parameter.0": "EI-2501-01-M1",
        "sentry.message.parameter.1": 1018.05,
        "sentry.message.parameter.2": 14,
      },
    }),
    {
      level: "warn",
      message: "[invoice-rows] [doc] total [amount] vs [amount]",
      attributes: {
        "sentry.message.template": "[invoice-rows] {} {} {}",
        "sentry.message.parameter.0": "[doc]",
        "sentry.message.parameter.1": "[amount]",
        "sentry.message.parameter.2": 14,
      },
    },
  );
});

test("a repeating error is sent once an hour, and at most 20 errors an hour in all", () => {
  let now = 0;
  const throttle = createEventThrottle({ now: () => now });
  const error = (value) => ({ exception: { values: [{ type: "Error", value }] } });
  assert.ok(throttle(error("queue tick failed after 3 tries")));
  assert.equal(throttle(error("queue tick failed after 4 tries")), null, "digits do not make a repeat new");
  assert.ok(throttle({ type: "transaction" }), "transactions are not limited");
  for (let i = 0; i < 19; i += 1) assert.ok(throttle(error(`distinct ${String.fromCharCode(97 + i)}`)));
  assert.equal(throttle(error("one more distinct")), null, "the hourly cap holds");
  now = 60 * 60 * 1000;
  assert.ok(throttle(error("queue tick failed after 9 tries")), "an hour later it is sent again");
});
