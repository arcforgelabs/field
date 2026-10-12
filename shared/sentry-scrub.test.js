import assert from "node:assert/strict";
import test from "node:test";
import { scrubBreadcrumb, scrubEvent, scrubText, scrubValue } from "./sentry-scrub.js";

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

test("job segments are kept when they are UUIDs and redacted when they could be an address", () => {
  assert.equal(scrubText(`/api/jobs/${JOB_UUID}/quote`), `/api/jobs/${JOB_UUID}/quote`);
  assert.equal(scrubText("/api/jobs/12-main-st-exampleton/quote"), "/api/jobs/[job]/quote");
  assert.equal(
    scrubText("ENOENT: open '/app/data/2026-01-04/12-main-st-exampleton/quote.json'"),
    "ENOENT: open '/app/data/2026-01-04/[job]/quote.json'",
  );
  assert.equal(scrubText(`/app/data/2026-10-12/${JOB_UUID}/job.json`), `/app/data/2026-10-12/${JOB_UUID}/job.json`);
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
    spans: [{ description: "GET https://example.com/a?token=abc", data: { "url.full": "https://example.com/a?token=abc" } }],
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
});

test("console breadcrumbs never leave", () => {
  assert.equal(scrubBreadcrumb({ category: "console", level: "error", message: "Jane" }), null);
  assert.deepEqual(scrubBreadcrumb({ category: "navigation", data: { from: "/#/jobs", to: "/#/jobs/12-main-st" } }), {
    category: "navigation",
    data: { from: "/#/jobs", to: "/#/jobs/[job]" },
  });
});
