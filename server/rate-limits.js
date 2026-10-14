// Rate limits for the whole server (#135).
//
// Three layers, each answering 429 with Retry-After (seconds), the RateLimit
// headers (IETF draft 8) and a plain JSON body the client and the CLI show:
//
//   1. address   every request, per client address, before anything else
//                (server/index.js mounts it straight after `trust proxy`).
//                The address is req.ip, which honours Express `trust proxy`
//                as server/auth/trust-proxy.js resolves it; IPv6 addresses
//                are grouped by /56, as express-rate-limit recommends.
//   2. caller    every authenticated request, per verified caller, after
//                sign-in (requireAuth, the Clerk router, the MCP endpoint).
//                The key is the caller's id: a person, a service account,
//                break-glass, or one MCP installation (grant). It is never
//                read from an unverified token, so a forged token cannot
//                spend someone else's budget.
//   3. classes   stricter budgets for expensive or sensitive routes, matched
//                by method and path in ROUTE_CLASSES below, so a new route
//                falls into its class without code of its own. A route of
//                an unauthenticated class counts per address before sign-in;
//                every other class counts per caller after it. A request
//                counts against every class whose rule matches it.
//
// Operators tune any budget with `rateLimits` in config (config.json.example);
// limiting cannot be switched off. Counts live in memory: each installation
// runs one server process, so one process's count is the installation's.
// A restart starts every count again.
//
// Nothing here draws random numbers: the quote and invoice proof seeds the
// random source, and a draw would shift the ids it compares.
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const SECOND = 1;
const MINUTE = 60 * SECOND;

// limit requests per windowSeconds. Why each budget is what it is:
export const DEFAULT_RATE_LIMITS = Object.freeze({
  // Several staff behind one office address, and each page load fetches the
  // client bundle's files: 20 requests a second is far above that, and far
  // below what floods a small server.
  address: Object.freeze({ limit: 1200, windowSeconds: MINUTE }),
  // One person, service key or agent: 10 requests a second for a minute is
  // more than a busy screen or a CLI loop needs.
  caller: Object.freeze({ limit: 600, windowSeconds: MINUTE }),
  // Failed password sign-ins only: a person who mistypes still gets in, and
  // guessing a password gets 20 tries in 15 minutes.
  "sign-in": Object.freeze({ limit: 20, windowSeconds: 15 * MINUTE, failedOnly: true }),
  // Minting a command-line token or changing a password happens a few times a
  // month. Revoking is not limited here: it is how a leak is stopped.
  token: Object.freeze({ limit: 30, windowSeconds: 60 * MINUTE }),
  // OAuth flows (MCP, Gmail, Xero) are a few requests per connection. An MCP
  // access token lasts 10 minutes, so a client refreshes about once in 10.
  oauth: Object.freeze({ limit: 60, windowSeconds: 15 * MINUTE }),
  // Each one sends mail through Gmail: a person sends a few in a minute at
  // most, and Gmail's own sending limits are per day.
  "email-send": Object.freeze({ limit: 30, windowSeconds: 5 * MINUTE }),
  // Rendering a PDF or a wall drawing takes the server's CPU for a moment.
  // Reviewing documents one after another stays far below this.
  "pdf-render": Object.freeze({ limit: 60, windowSeconds: 5 * MINUTE }),
  // Calls to Xero, Google Contacts and Drive, and integration settings: Xero
  // allows 60 calls a minute per organisation, so Field never asks for more.
  integration: Object.freeze({ limit: 60, windowSeconds: 5 * MINUTE }),
});

export const RATE_LIMIT_CLASSES = Object.freeze(Object.keys(DEFAULT_RATE_LIMITS));

// Which routes belong to which class. `by: "address"` is a route that has no
// Field sign-in (it counts before authentication); `by: "caller"` is one
// behind requireAuth (it counts after). Paths are Express-style: `:name`
// matches one segment, a trailing `/*` any number.
export const ROUTE_CLASSES = Object.freeze([
  { budget: "sign-in", by: "address", method: "POST", path: "/api/auth/login" },
  // Approving an MCP client checks an email and password with password sign-in.
  { budget: "sign-in", by: "address", method: "POST", path: "/oauth/approve" },

  { budget: "token", by: "caller", method: "POST", path: "/api/users/:id/tokens" },
  { budget: "token", by: "caller", method: "POST", path: "/api/users/:id/password" },
  // The demo mints a session token on every visit.
  { budget: "token", by: "address", method: "GET", path: "/demo" },
  { budget: "token", by: "address", method: "GET", path: "/demo-account-create" },

  { budget: "oauth", by: "address", method: "POST", path: "/oauth/register" },
  { budget: "oauth", by: "address", method: "GET", path: "/oauth/authorize" },
  { budget: "oauth", by: "address", method: "POST", path: "/oauth/approve" },
  { budget: "oauth", by: "address", method: "POST", path: "/oauth/token" },
  { budget: "oauth", by: "address", method: "POST", path: "/oauth/revoke" },
  { budget: "oauth", by: "address", method: "GET", path: "/api/auth/gmail/callback" },
  { budget: "oauth", by: "address", method: "GET", path: "/api/integrations/xero/callback" },
  { budget: "oauth", by: "caller", method: "GET", path: "/api/auth/gmail" },
  { budget: "oauth", by: "caller", method: "POST", path: "/api/integrations/xero/connect" },

  // Sends, test sends and scheduled sends of quotes, invoices, receipts and
  // job emails.
  { budget: "email-send", by: "caller", method: "POST", path: "/api/jobs/:id/email-quote" },
  { budget: "email-send", by: "caller", method: "POST", path: "/api/jobs/:id/email" },

  // Routes that render. Stored bytes (/api/documents/:uid/pdf) and a cached
  // preview (GET .../quote-pdf-preview/:previewId) are served, not rendered.
  { budget: "pdf-render", by: "caller", method: "GET", path: "/api/jobs/:id/quote-pdf" },
  { budget: "pdf-render", by: "caller", method: "POST", path: "/api/jobs/:id/quote-pdf-preview" },
  { budget: "pdf-render", by: "caller", method: "GET", path: "/api/jobs/:id/milestones/:index/pdf" },
  { budget: "pdf-render", by: "caller", method: "GET", path: "/api/jobs/:id/wall-zones/:zoneId/render" },

  // Xero (connect and the callback above count as OAuth too), the
  // integration secrets key, Google Contacts, and Moasure files sent to Drive.
  { budget: "integration", by: "caller", method: "*", path: "/api/integrations/*" },
  { budget: "integration", by: "caller", method: "GET", path: "/api/google/contacts" },
  { budget: "integration", by: "caller", method: "POST", path: "/api/jobs/:id/moasure-upload" },
  { budget: "integration", by: "caller", method: "POST", path: "/api/jobs/:id/moasure-scan" },
]);

const MAX_WINDOW_SECONDS = 24 * 60 * MINUTE;
const MAX_LIMIT = 1_000_000;

/**
 * The budgets in force: the defaults, with `rateLimits` from config over
 * them. Throws an Error naming the key for an unknown class or field, or a
 * value that is not a positive whole number.
 */
export function resolveRateLimitBudgets(raw) {
  const budgets = {};
  for (const name of RATE_LIMIT_CLASSES) budgets[name] = { ...DEFAULT_RATE_LIMITS[name], source: "default" };
  if (raw === undefined || raw === null) return budgets;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config rateLimits must be an object of budgets, for example { \"email-send\": { \"limit\": 60, \"windowSeconds\": 300 } }");
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_RATE_LIMITS, name)) {
      throw new Error(`config rateLimits.${name} is not a rate limit; use one of: ${RATE_LIMIT_CLASSES.join(", ")}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`config rateLimits.${name} must be an object with limit and/or windowSeconds`);
    }
    for (const [field, number] of Object.entries(value)) {
      if (field !== "limit" && field !== "windowSeconds") {
        throw new Error(`config rateLimits.${name}.${field} is not a rate limit setting; use limit and windowSeconds`);
      }
      const max = field === "limit" ? MAX_LIMIT : MAX_WINDOW_SECONDS;
      if (!Number.isInteger(number) || number <= 0 || number > max) {
        throw new Error(`config rateLimits.${name}.${field} must be a whole number from 1 to ${max}`);
      }
      budgets[name][field] = number;
      budgets[name].source = "config";
    }
  }
  return budgets;
}

/** One line for the boot log: the budgets config changed, or null. */
export function describeConfiguredBudgets(budgets) {
  const changed = RATE_LIMIT_CLASSES.filter((name) => budgets[name].source === "config");
  if (!changed.length) return null;
  return changed.map((name) => `${name} ${budgets[name].limit} per ${budgets[name].windowSeconds}s`).join(", ");
}

/** "45 seconds", "1 second", "12 minutes": how long to wait, in plain words. */
export function waitInWords(seconds) {
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}

function retryAfterSeconds(req, windowMs) {
  const reset = req.rateLimit?.resetTime;
  const resetAt = reset instanceof Date ? reset.getTime() : Date.now() + windowMs;
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

function limitedHandler(name, log) {
  return (req, res, _next, options) => {
    const seconds = retryAfterSeconds(req, options.windowMs);
    // Once per key and window: the first request over the budget.
    if (req.rateLimit?.used === req.rateLimit?.limit + 1) {
      log.warn?.(`[rate-limit] ${name} budget (${req.rateLimit.limit} per ${Math.round(options.windowMs / 1000)}s) reached by ${describeKey(req.rateLimit.key)}`);
    }
    res.set("Retry-After", String(seconds));
    res.status(429).json({
      error: `Too many requests. Try again in ${waitInWords(seconds)}.`,
      code: "rate_limited",
      retryAfter: seconds,
      budget: name,
    });
  };
}

// Keys are "address:<ip>" or "caller:<id>": an id or an address, never a token.
function describeKey(key) {
  return String(key || "unknown").replace(/^address:/, "address ").replace(/^caller:/, "caller ");
}

/** The client address key: req.ip (after `trust proxy`), IPv6 grouped by /56. */
export function addressKey(req) {
  return `address:${ipKeyGenerator(String(req.ip ?? "unknown"))}`;
}

/** The verified caller behind this request, or null before authentication. */
export function callerIdOf(req) {
  const id = req.rateLimitCaller ?? req.caller?.id;
  return typeof id === "string" && id ? id : null;
}

// express-rate-limit's own checks (an X-Forwarded-For with `trust proxy`
// off, a permissive `trust proxy`, a request counted twice) each report once
// per limiter, as one line instead of a stack trace.
function checksLogger(log) {
  const line = (error) => {
    const code = error?.code ? `${error.code}: ` : "";
    const hint = error?.code === "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR"
      ? " If Field runs behind a proxy, set FIELD_TRUST_PROXY (server/auth/trust-proxy.js)."
      : "";
    return `[rate-limit] ${code}${error?.message ?? error}${hint}`;
  };
  return { warn: (error) => log.warn?.(line(error)), error: (error) => log.error?.(line(error)) };
}

function commonOptions(name, budget, log) {
  return {
    windowMs: budget.windowSeconds * 1000,
    limit: budget.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: name,
    handler: limitedHandler(name, log),
    logger: checksLogger(log),
  };
}

/**
 * The options of the per-address limiter. server/index.js passes them to
 * rateLimit() itself, mounted before every route. It uses express-rate-limit's
 * own address key (req.ip, IPv6 by /56) and keeps its checks of the `trust
 * proxy` setting on; each reports once, never per request. /health is
 * skipped so uptime checks always get an answer.
 */
export function addressLimitOptions(budgets, { log = console } = {}) {
  return {
    ...commonOptions("address", budgets.address, log),
    ipv6Subnet: 56,
    skip: (req) => req.path === "/health",
  };
}

// "/api/jobs/:id/email" -> a test of a path's segments.
function compilePath(pattern) {
  const parts = pattern.split("/").filter(Boolean);
  const prefix = parts.at(-1) === "*";
  const fixed = prefix ? parts.slice(0, -1) : parts;
  return (path) => {
    const segments = path.split("/").filter(Boolean);
    if (prefix ? segments.length <= fixed.length : segments.length !== fixed.length) return false;
    return fixed.every((part, index) => part.startsWith(":") || part === segments[index]);
  };
}

const COMPILED_ROUTES = ROUTE_CLASSES.map((rule) => ({ ...rule, matches: compilePath(rule.path) }));

/** The request's full path, whatever router it reached this check through. */
function fullPath(req) {
  const raw = String(req.originalUrl ?? req.url ?? "/");
  const end = raw.search(/[?#]/);
  let path = end === -1 ? raw : raw.slice(0, end);
  try {
    path = decodeURI(path);
  } catch { /* keep it encoded */ }
  // Trailing slashes off by hand: a regular expression here would take
  // polynomial time on a long run of slashes in the request.
  let length = path.length;
  while (length > 1 && path[length - 1] === "/") length -= 1;
  return path.slice(0, length);
}

/** The class budgets a request counts against at one stage ("address" or "caller"). */
export function classesFor(method, path, by) {
  const verb = method === "HEAD" ? "GET" : method;
  const names = [];
  for (const rule of COMPILED_ROUTES) {
    if (rule.by !== by) continue;
    if (rule.method !== "*" && rule.method !== verb) continue;
    if (rule.matches(path) && !names.includes(rule.budget)) names.push(rule.budget);
  }
  return names;
}

function runInOrder(middlewares, req, res, next) {
  let index = 0;
  const step = (error) => {
    if (error) return next(error);
    const middleware = middlewares[index++];
    if (!middleware) return next();
    return middleware(req, res, step);
  };
  return step();
}

/**
 * The class limiters and the per-caller limiter:
 *   byAddress  app.use() straight after the address limiter: the classes of
 *              routes without a Field sign-in, per address
 *   byCaller   after authentication: the caller's own budget, then the
 *              classes of the route, per caller. Runs once per request, even
 *              when a route authenticates twice.
 */
export function createRateLimits(budgets, { log = console } = {}) {
  const classLimiters = {};
  for (const name of RATE_LIMIT_CLASSES) {
    if (name === "address" || name === "caller") continue;
    const budget = budgets[name];
    classLimiters[name] = rateLimit({
      ...commonOptions(name, budget, log),
      skipSuccessfulRequests: Boolean(budget.failedOnly),
      keyGenerator: (req) => {
        const caller = callerIdOf(req);
        return caller ? `caller:${caller}` : addressKey(req);
      },
    });
  }
  const callerLimiter = rateLimit({
    ...commonOptions("caller", budgets.caller, log),
    keyGenerator: (req) => `caller:${callerIdOf(req)}`,
  });

  function byAddress(req, res, next) {
    const names = classesFor(req.method, fullPath(req), "address");
    if (!names.length) return next();
    return runInOrder(names.map((name) => classLimiters[name]), req, res, next);
  }

  function byCaller(req, res, next) {
    if (req.fieldCallerRateLimited || !callerIdOf(req)) return next();
    req.fieldCallerRateLimited = true;
    const names = classesFor(req.method, fullPath(req), "caller");
    return runInOrder([callerLimiter, ...names.map((name) => classLimiters[name])], req, res, next);
  }

  return { byAddress, byCaller, budgets };
}
