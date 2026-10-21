import { execSync } from "node:child_process";
import { createEventThrottle, scrubBreadcrumb, scrubEvent, scrubLog, scrubText, scrubValue } from "../../shared/sentry-scrub.js";
import { replitPlacement } from "../runtime-config.js";

export { scrubEvent };

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

// SENTRY_ENVIRONMENT, then FIELD_ENV; a Replit workspace (not the published
// app) reports "replit-workspace" so its errors never read as production.
export function resolveSentryEnvironment(env = process.env) {
  return readString(env.SENTRY_ENVIRONMENT)
    || readString(env.FIELD_ENV)
    || (replitPlacement(env) === "workspace" ? "replit-workspace" : "")
    || readString(env.NODE_ENV)
    || "production";
}

// SENTRY_RELEASE, then FIELD_REVISION (the build's git commit: the Dockerfile
// sets it, and scripts/replit-start.sh reads it from the build).
export function resolveSentryRelease(env = process.env) {
  return readString(env.SENTRY_RELEASE) || readString(env.FIELD_REVISION) || "";
}

// Tags on every server and browser event, so one Sentry organisation can
// serve many deployments: product=field, and client=SENTRY_CLIENT when set
// (a short name such as "embark"; letters, digits, "-" and "_", lowercased,
// at most 32 characters). The repository names no client.
export function resolveSentryTags(env = process.env) {
  const tags = { product: "field" };
  const client = readString(env.SENTRY_CLIENT).toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,31}$/.test(client)) tags.client = client;
  return tags;
}

export function withRoutingTags(event, tags) {
  return event && { ...event, tags: { ...event.tags, ...tags } };
}

export function resolveSentryDsn(env = process.env) {
  const direct = readString(env.SENTRY_DSN);
  if (direct) return direct;
  const command = readString(env.SENTRY_DSN_CMD);
  if (!command) return "";
  try {
    return readString(execSync(command, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch {
    return "";
  }
}

// A sample rate from a setting: a number from 0 to 1, else the default.
export function resolveSampleRate(value, fallback) {
  const text = readString(value);
  if (!text) return fallback;
  const rate = Number.parseFloat(text);
  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : fallback;
}

// Defaults sized for Sentry's free Developer plan with a handful of users:
// 5M spans, 50 replays and 5 GB of logs a month. Each is a setting, so a
// trial or a paid plan can raise it without a code change (docs/REPLIT.md).
export const SENTRY_DEFAULTS = Object.freeze({
  tracesSampleRate: 0.2,
  replaysSessionSampleRate: 0.05,
  replaysOnErrorSampleRate: 1,
});

function settingOn(value, fallback = true) {
  const text = readString(value).toLowerCase();
  if (!text) return fallback;
  return !["0", "false", "off", "no"].includes(text);
}

// Health checks and static files would spend the span quota and say nothing.
export function ignoreIncomingRequest(url) {
  const path = String(url || "").split("?")[0];
  return path === "/health" || path.startsWith("/assets/") || /\.(?:js|css|map|png|svg|ico|woff2?|webmanifest)$/.test(path);
}

let initialized = false;
let enabled = false;
let Sentry = null;
let browserConfig = null;

// Runs from server/observability/instrument.js (node --import) before Express
// loads, so Express routes are traced; server/index.js calls it again, which
// is a no-op, and starts it late when the preload was not used.
export async function initFieldSentry(env = process.env) {
  if (initialized) return { enabled };
  initialized = true;
  const dsn = resolveSentryDsn(env);
  if (!dsn) {
    enabled = false;
    browserConfig = null;
    return { enabled };
  }
  Sentry = await import("@sentry/node");
  const environment = resolveSentryEnvironment(env);
  const release = resolveSentryRelease(env) || undefined;
  const tracesSampleRate = resolveSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, SENTRY_DEFAULTS.tracesSampleRate);
  const logs = settingOn(env.SENTRY_LOGS);
  const tags = resolveSentryTags(env);
  if (readString(env.SENTRY_CLIENT) && !tags.client) {
    console.warn("[sentry] SENTRY_CLIENT is not a short name (letters, digits, - and _, at most 32); events carry no client tag");
  }
  Sentry.init({
    dsn,
    environment,
    release,
    initialScope: { tags },
    sendDefaultPii: false,
    includeLocalVariables: false,
    tracesSampleRate,
    enableLogs: logs,
    enableMetrics: settingOn(env.SENTRY_METRICS),
    integrations: [
      Sentry.httpIntegration({ ignoreIncomingRequests: ignoreIncomingRequest }),
      ...(logs ? [Sentry.consoleLoggingIntegration({ levels: ["log", "info", "warn", "error"] })] : []),
    ],
    // Same error at most once an hour, at most 20 errors an hour in all
    // (shared/sentry-scrub.js), so a repeating failure cannot use up the plan.
    // The scrub redacts any key that names a client; the routing tags are
    // this deployment's own settings, so they are put back after it.
    beforeSend: (() => {
      const throttle = createEventThrottle();
      return (event) => {
        const allowed = throttle(event);
        return allowed && withRoutingTags(scrubEvent(allowed), tags);
      };
    })(),
    beforeSendTransaction: (event) => withRoutingTags(scrubEvent(event), tags),
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendLog: scrubLog,
    beforeSendMetric: (metric) => ({ ...metric, attributes: scrubValue(metric.attributes) }),
  });
  enabled = true;
  browserConfig = {
    dsn,
    environment,
    release: release || "",
    tags,
    tracesSampleRate,
    replaysSessionSampleRate: resolveSampleRate(env.SENTRY_REPLAYS_SESSION_SAMPLE_RATE, SENTRY_DEFAULTS.replaysSessionSampleRate),
    replaysOnErrorSampleRate: resolveSampleRate(env.SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE, SENTRY_DEFAULTS.replaysOnErrorSampleRate),
    feedback: settingOn(env.SENTRY_FEEDBACK),
  };
  if (readString(env.SENTRY_VERIFY) === "1") {
    Sentry.captureException(new Error("Field Sentry verification (server)"));
    await Sentry.flush(5000);
  }
  return { enabled };
}

// A product counter (for example a document issued). Attributes name kinds,
// never customers; a no-op while Sentry is off.
export function countFieldMetric(name, attributes = {}) {
  if (!enabled || typeof Sentry?.metrics?.count !== "function") return;
  try {
    Sentry.metrics.count(name, 1, { attributes });
  } catch {
    // A metric must never break the work it counts.
  }
}

export function isSentryEnabled() {
  return enabled;
}

// What GET /health shows: whether reporting is on, and the environment and
// release events carry. The repository is public, so neither is a secret.
export function sentryPublicStatus() {
  if (!enabled || !browserConfig) return { enabled: false };
  return { enabled: true, environment: browserConfig.environment, release: browserConfig.release || null };
}

// The browser reads its settings from the page, so one deployment secret
// configures both halves and the bundle needs no build-time values. A DSN only
// lets a client send events; it is designed to be public.
export function sentryBrowserBootstrapScript() {
  if (!enabled || !browserConfig) return "";
  const json = JSON.stringify(browserConfig).replace(/</g, "\\u003c");
  return `<script>window.__FIELD_SENTRY__=${json};</script>`;
}

// A background job (for example a scheduled email) failed with no request to
// answer. Reported with its area as a tag; a no-op while Sentry is off.
export function reportBackgroundError(error, { area, ...tags } = {}) {
  if (!enabled || !Sentry) return;
  Sentry.withScope((scope) => {
    if (area) scope.setTag("field.area", area);
    for (const [key, value] of Object.entries(tags)) {
      if (value !== undefined) scope.setTag(`field.${key}`, String(value));
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error?.message || error)));
  });
}

function routeTemplate(req) {
  const path = req.route?.path;
  if (typeof path === "string") return `${req.baseUrl || ""}${path}`;
  return scrubText(String(req.baseUrl || "") + String(req.path || "")) || "unknown";
}

// Most of Field's routes catch their own errors and answer 5xx with
// `{ error: message }`, so those errors never reach Sentry's Express handler.
// This middleware reports every 5xx answer that handler did not, grouped by
// method, route and status, with the (scrubbed) error message.
export function sentryErrorResponseReporter() {
  return (req, res, next) => {
    if (!enabled) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 500 && body && typeof body === "object") {
        // Express clears req.route once the handler returns; read it now.
        res.locals.fieldRoute = routeTemplate(req);
        const message = typeof body.error === "string" ? body.error : body.error?.message ?? body.message;
        if (typeof message === "string") res.locals.fieldErrorMessage = message;
      }
      return json(body);
    };
    res.on("finish", () => {
      if (res.statusCode < 500 || res.locals.fieldSentryCaptured) return;
      const route = res.locals.fieldRoute || routeTemplate(req);
      const message = scrubText(res.locals.fieldErrorMessage || `HTTP ${res.statusCode}`, 300);
      const error = new Error(message);
      error.name = `HTTP ${res.statusCode}`;
      Sentry.withScope((scope) => {
        scope.setTag("http.method", req.method);
        scope.setTag("http.route", route);
        scope.setTag("http.status_code", String(res.statusCode));
        scope.setFingerprint([
          "field-error-response",
          req.method,
          route,
          String(res.statusCode),
          message.replace(/\d+/g, "0"),
        ]);
        Sentry.captureException(error, { mechanism: { type: "field.error_response", handled: true } });
      });
    });
    next();
  };
}

export async function setupSentryExpress(app) {
  if (!enabled) return;
  if (typeof Sentry.setupExpressErrorHandler === "function") {
    Sentry.setupExpressErrorHandler(app);
  }
  // Whatever reached the error handler above was reported there (it reports
  // every 5xx); the response reporter must not report it twice.
  app.use((err, _req, res, next) => {
    res.locals.fieldSentryCaptured = true;
    next(err);
  });
}
