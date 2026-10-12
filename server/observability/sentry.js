import { execSync } from "node:child_process";

const PHI_KEY = /email|phone|address|customer|password|token|secret|authorization/i;

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveSentryEnvironment(env = process.env) {
  return readString(env.SENTRY_ENVIRONMENT) || readString(env.FIELD_ENV) || readString(env.NODE_ENV) || "production";
}

function resolveSentryRelease(env = process.env) {
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

function scrubValue(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (typeof value === "string") {
    if (value.length > 400) return `${value.slice(0, 120)}…[redacted]`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => scrubValue(entry, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = PHI_KEY.test(key) ? "[redacted]" : scrubValue(nested, depth + 1);
  }
  return out;
}

export function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;
  const next = { ...event };
  if (next.request && typeof next.request === "object") {
    const request = { ...next.request };
    delete request.data;
    delete request.cookies;
    delete request.headers;
    if (request.url && typeof request.url === "string") {
      request.url = request.url.split("?")[0];
    }
    next.request = request;
  }
  if (next.user) next.user = { id: next.user.id ? "hashed" : undefined };
  if (next.extra) next.extra = scrubValue(next.extra);
  if (next.contexts) next.contexts = scrubValue(next.contexts);
  return next;
}

let initialized = false;
let enabled = false;
let cachedDsn = "";

export async function initFieldSentry(env = process.env) {
  if (initialized) return { enabled };
  initialized = true;
  const dsn = resolveSentryDsn(env);
  if (!dsn) {
    enabled = false;
    cachedDsn = "";
    return { enabled };
  }
  cachedDsn = dsn;
  const Sentry = await import("@sentry/node");
  const tracesSampleRate = Number.parseFloat(String(env.SENTRY_TRACES_SAMPLE_RATE ?? "0.2"));
  Sentry.init({
    dsn,
    environment: resolveSentryEnvironment(env),
    release: resolveSentryRelease(env) || undefined,
    sendDefaultPii: false,
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? Math.min(1, Math.max(0, tracesSampleRate)) : 0.2,
    beforeSend: scrubEvent,
  });
  enabled = true;
  if (readString(env.SENTRY_VERIFY) === "1") {
    Sentry.captureException(new Error("Field Sentry verification"));
    await Sentry.flush(5000);
  }
  return { enabled };
}

export function isSentryEnabled() {
  return enabled;
}

export function sentryDsnBootstrapScript() {
  if (!enabled || !cachedDsn) return "";
  return `<script>window.__FIELD_SENTRY_DSN__=${JSON.stringify(cachedDsn)};</script>`;
}

export async function setupSentryExpress(app) {
  if (!enabled) return;
  const Sentry = await import("@sentry/node");
  if (typeof Sentry.setupExpressErrorHandler === "function") {
    Sentry.setupExpressErrorHandler(app);
  }
}
