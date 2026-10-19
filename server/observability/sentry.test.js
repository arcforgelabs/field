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
  resolveSentryTags,
  resolveSampleRate,
  ignoreIncomingRequest,
  SENTRY_DEFAULTS,
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

test("every event is tagged product=field, and client=SENTRY_CLIENT when it is a short name", () => {
  assert.deepEqual(resolveSentryTags({}), { product: "field" });
  assert.deepEqual(resolveSentryTags({ SENTRY_CLIENT: " Embark " }), { product: "field", client: "embark" });
  assert.deepEqual(resolveSentryTags({ SENTRY_CLIENT: "acme_co-2" }), { product: "field", client: "acme_co-2" });
  assert.deepEqual(resolveSentryTags({ SENTRY_CLIENT: "two words" }), { product: "field" });
  assert.deepEqual(resolveSentryTags({ SENTRY_CLIENT: "x".repeat(33) }), { product: "field" });
});

test("sample rates come from settings, within 0 to 1, else the free-plan defaults", () => {
  assert.equal(resolveSampleRate(undefined, SENTRY_DEFAULTS.tracesSampleRate), 0.2);
  assert.equal(resolveSampleRate("", 0.05), 0.05);
  assert.equal(resolveSampleRate("0", 0.05), 0);
  assert.equal(resolveSampleRate("0.25", 0.2), 0.25);
  assert.equal(resolveSampleRate("7", 0.2), 1);
  assert.equal(resolveSampleRate("nope", 0.2), 0.2);
  assert.deepEqual({ ...SENTRY_DEFAULTS }, { tracesSampleRate: 0.2, replaysSessionSampleRate: 0.05, replaysOnErrorSampleRate: 1 });
});

test("health checks and static files are never traced", () => {
  assert.equal(ignoreIncomingRequest("/health"), true);
  assert.equal(ignoreIncomingRequest("/assets/index-abc.js"), true);
  assert.equal(ignoreIncomingRequest("/favicon.svg"), true);
  assert.equal(ignoreIncomingRequest("/api/jobs"), false);
  assert.equal(ignoreIncomingRequest("/"), false);
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
    SENTRY_REPLAYS_SESSION_SAMPLE_RATE: "1",
    // Every request is traced, so the transaction checks below always run.
    SENTRY_TRACES_SAMPLE_RATE: "1",
    SENTRY_CLIENT: "acme",
  });
  const events = [];
  Sentry.getClient().on("beforeSendEvent", (event) => events.push(event));

  assert.deepEqual(sentryPublicStatus(), { enabled: true, environment: "test", release: "0123456789abcdef" });
  const script = sentryBrowserBootstrapScript();
  assert.match(script, /^<script>window\.__FIELD_SENTRY__=\{.*\};<\/script>$/);
  assert.match(script, /"environment":"test"/);
  assert.match(script, /"release":"0123456789abcdef"/);
  assert.match(script, /"tracesSampleRate":1/);
  assert.match(script, /"replaysSessionSampleRate":1/);
  assert.match(script, /"replaysOnErrorSampleRate":1/);
  assert.match(script, /"feedback":true/);
  assert.match(script, /"tags":\{"product":"field","client":"acme"\}/);

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

  const transactions = events.filter((event) => event.type === "transaction");
  assert.ok(transactions.length > 0, "the traced requests reached Sentry");
  for (const transaction of transactions) {
    assert.ok(!JSON.stringify(transaction).includes("token=abc"), "no query string in a transaction");
    assert.ok(!JSON.stringify(transaction).includes("12-main-st"), "no address-like job id in a transaction");
  }
  const errors = events.filter((event) => !event.type);
  const messages = errors.map((event) => event.exception?.values?.[0]?.value).sort();
  assert.deepEqual(messages, ["Gmail quota for [email]", "Gmail refused [email]", "thrown once"]);

  const response = errors.find((event) => event.exception.values[0].value === "Gmail refused [email]");
  assert.equal(response.exception.values[0].type, "HTTP 500");
  assert.equal(response.tags["http.route"], "/api/jobs/:id/send");
  assert.equal(response.environment, "test");
  assert.equal(response.release, "0123456789abcdef");
  assert.ok(!JSON.stringify(response).includes("token=abc"));
  assert.ok(!JSON.stringify(response).includes("12-main-st"));

  const background = errors.find((event) => event.exception.values[0].value === "Gmail quota for [email]");
  assert.equal(background.tags["field.area"], "scheduled-email");
  assert.equal(background.tags["field.stage"], "send");
  for (const event of [...errors, ...transactions]) {
    assert.equal(event.tags.product, "field");
    assert.equal(event.tags.client, "acme");
  }
});
