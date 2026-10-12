import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import * as Sentry from "@sentry/node";
import {
  initFieldSentry,
  reportBackgroundError,
  resolveSentryDsn,
  resolveSentryEnvironment,
  resolveSentryRelease,
  resolveTracesSampleRate,
  scrubEvent,
  sentryBrowserBootstrapScript,
  sentryErrorResponseReporter,
  sentryPublicStatus,
  setupSentryExpress,
} from "./sentry.js";

test("Field Sentry DSN stays empty without env", () => {
  assert.equal(resolveSentryDsn({}), "");
  assert.equal(resolveSentryDsn({ SENTRY_DSN: " https://example.ingest.sentry.io/1 " }), "https://example.ingest.sentry.io/1");
});

test("the environment names a Replit workspace, never production, unless told", () => {
  assert.equal(resolveSentryEnvironment({ SENTRY_ENVIRONMENT: "production", FIELD_RUNTIME: "replit" }), "production");
  assert.equal(resolveSentryEnvironment({ FIELD_RUNTIME: "replit" }), "replit-workspace");
  assert.equal(resolveSentryEnvironment({ FIELD_RUNTIME: "replit", REPLIT_DEPLOYMENT: "1" }), "production");
  assert.equal(resolveSentryEnvironment({ NODE_ENV: "development" }), "development");
});

test("the release is SENTRY_RELEASE, then the build's FIELD_REVISION", () => {
  assert.equal(resolveSentryRelease({}), "");
  assert.equal(resolveSentryRelease({ FIELD_REVISION: "abc123" }), "abc123");
  assert.equal(resolveSentryRelease({ FIELD_REVISION: "abc123", SENTRY_RELEASE: "field@1" }), "field@1");
});

test("tracing is off unless asked for", () => {
  assert.equal(resolveTracesSampleRate(undefined), 0);
  assert.equal(resolveTracesSampleRate("0.25"), 0.25);
  assert.equal(resolveTracesSampleRate("7"), 1);
  assert.equal(resolveTracesSampleRate("nope"), 0);
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
  assert.equal(event.request.url, "https://field.example.com/api/jobs?[query]");
  assert.equal(event.extra.email, "[redacted]");
  assert.equal(event.extra.status, "quoted");
  assert.equal(event.user, undefined);
});

test("while Sentry is off nothing is reported and the page gets no settings", async () => {
  assert.deepEqual(sentryPublicStatus(), { enabled: false });
  assert.equal(sentryBrowserBootstrapScript(), "");
  assert.doesNotThrow(() => reportBackgroundError(new Error("x"), { area: "test" }));
});

test("5xx answers and background failures reach Sentry once, scrubbed", async (t) => {
  // Port 9 refuses connections, so nothing leaves this machine.
  await initFieldSentry({
    SENTRY_DSN: "http://publickey@127.0.0.1:9/1",
    SENTRY_ENVIRONMENT: "test",
    FIELD_REVISION: "0123456789abcdef",
  });
  const events = [];
  Sentry.getClient().on("beforeSendEvent", (event) => events.push(event));

  assert.deepEqual(sentryPublicStatus(), { enabled: true, environment: "test", release: "0123456789abcdef" });
  const script = sentryBrowserBootstrapScript();
  assert.match(script, /^<script>window\.__FIELD_SENTRY__=\{.*\};<\/script>$/);
  assert.match(script, /"environment":"test"/);
  assert.match(script, /"release":"0123456789abcdef"/);

  const app = express();
  app.use(sentryErrorResponseReporter());
  app.get("/api/jobs/:id/send", (_req, res) => {
    res.status(500).json({ error: "Gmail refused jane@example.com" });
  });
  app.get("/api/thrown", () => {
    throw new Error("thrown once");
  });
  app.get("/api/missing", (_req, res) => res.status(404).json({ error: "not found" }));
  await setupSentryExpress(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/jobs/12-main-st/send?token=abc`)).status, 500);
  assert.equal((await fetch(`${base}/api/thrown`)).status, 500);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  reportBackgroundError(new Error("Gmail quota for jane@example.com"), { area: "scheduled-email", stage: "send" });
  await Sentry.flush(2000);

  const messages = events.map((event) => event.exception?.values?.[0]?.value).sort();
  assert.deepEqual(messages, ["Gmail quota for [email]", "Gmail refused [email]", "thrown once"]);

  const response = events.find((event) => event.exception.values[0].value === "Gmail refused [email]");
  assert.equal(response.exception.values[0].type, "HTTP 500");
  assert.equal(response.tags["http.route"], "/api/jobs/:id/send");
  assert.equal(response.environment, "test");
  assert.equal(response.release, "0123456789abcdef");
  assert.ok(!JSON.stringify(response).includes("token=abc"));
  assert.ok(!JSON.stringify(response).includes("12-main-st"));

  const background = events.find((event) => event.exception.values[0].value === "Gmail quota for [email]");
  assert.equal(background.tags["field.area"], "scheduled-email");
  assert.equal(background.tags["field.stage"], "send");
});
