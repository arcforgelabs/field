import assert from "node:assert/strict";
import test from "node:test";
import { resolveSentryDsn, scrubEvent } from "./sentry.js";

test("Field Sentry DSN stays empty without env", () => {
  assert.equal(resolveSentryDsn({}), "");
  assert.equal(resolveSentryDsn({ SENTRY_DSN: " https://example.ingest.sentry.io/1 " }), "https://example.ingest.sentry.io/1");
});

test("Field Sentry events drop customer payloads", () => {
  const event = scrubEvent({
    request: {
      url: "https://field.example.com/api/jobs?email=x@y.z",
      data: { customer: "Jane" },
      cookies: { session: "abc" },
      headers: { authorization: "***" },
    },
    extra: { email: "x@y.z", status: "quoted" },
    user: { id: "u1", email: "x@y.z" },
  });
  assert.equal(event.request.data, undefined);
  assert.equal(event.request.cookies, undefined);
  assert.equal(event.request.headers, undefined);
  assert.equal(event.request.url, "https://field.example.com/api/jobs");
  assert.equal(event.extra.email, "[redacted]");
  assert.equal(event.extra.status, "quoted");
  assert.equal(event.user.email, undefined);
});
