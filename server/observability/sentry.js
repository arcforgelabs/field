import { execSync } from "node:child_process";
import { scrubBreadcrumb, scrubEvent, scrubText } from "../../shared/sentry-scrub.js";
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

// Tracing is off unless SENTRY_TRACES_SAMPLE_RATE asks for it: Field reports
// errors, and every span is one more place a URL could carry customer data.
export function resolveTracesSampleRate(value) {
  const rate = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0;
}

let initialized = false;
let enabled = false;
let Sentry = null;
let browserConfig = null;

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
  const tracesSampleRate = resolveTracesSampleRate(env.SENTRY_TRACES_SAMPLE_RATE);
  Sentry.init({
    dsn,
    environment,
    release,
    sendDefaultPii: false,
    includeLocalVariables: false,
    tracesSampleRate,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  enabled = true;
  browserConfig = { dsn, environment, release: release || "", tracesSampleRate };
  if (readString(env.SENTRY_VERIFY) === "1") {
    Sentry.captureException(new Error("Field Sentry verification (server)"));
    await Sentry.flush(5000);
  }
  return { enabled };
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
