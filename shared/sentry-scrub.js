// Keeps customer details out of Sentry. The server (server/observability/sentry.js)
// and the browser (client/src/instrument.ts) run every event, transaction,
// breadcrumb and log line through these functions before anything leaves the
// process.
//
// What goes: request bodies, cookies, headers (except User-Agent), query
// strings (also the bare `http.query` and `url.query` span attributes, which
// have no `?` to find), the user, console breadcrumbs, local variables, and any value whose
// key names customer, contact, address, money or credential details. What is
// rewritten in free text (error messages, URLs, paths, breadcrumbs, log
// lines): email addresses, document numbers, money amounts, Australian phone
// numbers, BSBs, query strings, credentials (a bearer token, a JSON web token,
// an OAuth token or code after its name, as Xero's are), and job folder or
// job route segments that are
// not UUIDs, route parameters or single words (older job folders were named
// after the site address). Long strings are cut short.

const SENSITIVE_KEY =
  /email|phone|mobile|address|customer|client|contact|recipient|attention|site|title|subject|notes?$|body$|html$|pdf|attachment|abn|bsb|bank|account.?(number|name)|password|passphrase|token|secret|authorization|cookie|api.?key|dsn|query$/i;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Australian numbers: +61 or 0, then 9 digits, with optional spaces, dashes
// or brackets (04xx xxx xxx, (08) 8xxx xxxx, +61 4xx xxx xxx), and 13/1300/1800.
const PHONE = /(?<![\w-])(?:\+?61[\s-]?[2-478]|\(0[2-478]\)|0[2-478])(?:[\s-]?\d){8}(?![\w-])|(?<![\w-])1[38]00(?:[\s-]?\d){6}(?![\w-])|(?<![\w-])13(?:[\s-]?\d){4}(?![\w-])/g;
const BSB = /(?<![\w-])\d{3}-\d{3}(?![\w-])/g;
// Quote, invoice, receipt and credit-note numbers: EQ-2501-01, EI-2501-01-M1,
// EI-2501-01-M1-R2, ER-2501-01-M1, INV-2026-10-3, RCT-2026-10-3, CN-2026-1-1,
// with a version (" v2") when one follows.
const DOCUMENT_NUMBER = /(?<![A-Za-z0-9])(?:EQ|EI|ER|INV|RCT|CN)-\d+(?:-[MR]?\d+)*(?:[\s_-]?v\d+)?(?![A-Za-z0-9])/g;
// Money: anything with a currency sign ($1,234.56, A$90, AUD 925), and a
// plain number with exactly two decimals (925.50, 1,018.05, -12.00). A
// version (1.2.3, 24.10.0), a timestamp (12:30:45.12), a duration (12.34ms),
// an IP address, a UUID, a status code or a count has no currency sign and
// is not a lone two-decimal number, so it stays.
const CURRENCY_AMOUNT = /(?:-\s?)?(?:\bAUD\s?|A?\$)\s?-?\d[\d,]*(?:\.\d+)?/g;
const DECIMAL_AMOUNT = /(?<![\w.,:/-])-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?!\w|[.,]\d)/g;
const QUERY = /([\w\-./:%@#]+)\?[^\s"'<>)]+/g;
const JOB_SEGMENT = /(\/\d{4}-\d{2}-\d{2}\/|\/jobs\/)([^/\s?#"'<>]+)/gi;
// A single lowercase word (`manual`, `bulk-archive` has a hyphen and stays
// redacted) is a route, not a job named after an address.
const ROUTE_WORD = /^[a-z]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UI_ATTRIBUTE = /(\[[\w-]+=)"[^"]*"\]/g;
// Credentials in free text (#93): "Bearer <token>", a JSON web token (Xero's
// access tokens are), and an OAuth value after its name (refresh_token=...,
// "access_token": "...", client_secret, code).
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g;
const OAUTH_VALUE = /\b(access_token|refresh_token|id_token|client_secret|code_verifier|code)("?\s*[:=]\s*"?)[^\s"&,;}]{6,}/gi;

const MAX_TEXT = 1000;
const MAX_VALUE = 400;

export function scrubText(value, max = MAX_TEXT) {
  if (typeof value !== "string" || !value) return value;
  let text = value
    .replace(BEARER, "$1 [token]")
    .replace(JWT, "[token]")
    .replace(OAUTH_VALUE, "$1$2[token]")
    .replace(EMAIL, "[email]")
    .replace(QUERY, "$1?[query]")
    .replace(JOB_SEGMENT, (match, prefix, segment) => (UUID.test(segment) || segment.startsWith(":") || ROUTE_WORD.test(segment) ? match : `${prefix}[job]`))
    .replace(DOCUMENT_NUMBER, "[doc]")
    .replace(CURRENCY_AMOUNT, "[amount]")
    .replace(DECIMAL_AMOUNT, "[amount]")
    .replace(PHONE, "[phone]")
    .replace(BSB, "[bsb]");
  if (text.length > max) text = `${text.slice(0, max)}…[cut]`;
  return text;
}

export function scrubValue(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (typeof value === "string") return scrubText(value, MAX_VALUE);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => scrubValue(entry, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : scrubValue(nested, depth + 1);
  }
  return out;
}

export function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
  // Console lines are free text that can name anyone; they never leave.
  if (breadcrumb.category === "console") return null;
  const next = { ...breadcrumb };
  if (typeof next.message === "string") {
    next.message = String(next.category || "").startsWith("ui.")
      ? scrubText(next.message.replace(UI_ATTRIBUTE, '$1"…"]'))
      : scrubText(next.message);
  }
  if (next.data) next.data = scrubValue(next.data);
  return next;
}

function scrubException(exception) {
  if (!exception || !Array.isArray(exception.values)) return exception;
  return {
    ...exception,
    values: exception.values.map((entry) => {
      const value = { ...entry };
      if (typeof value.value === "string") value.value = scrubText(value.value);
      if (value.stacktrace && Array.isArray(value.stacktrace.frames)) {
        value.stacktrace = {
          ...value.stacktrace,
          frames: value.stacktrace.frames.map((frame) => {
            const { vars: _vars, ...rest } = frame;
            if (typeof rest.filename === "string") rest.filename = scrubText(rest.filename);
            if (typeof rest.abs_path === "string") rest.abs_path = scrubText(rest.abs_path);
            return rest;
          }),
        };
      }
      return value;
    }),
  };
}

export function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;
  const next = { ...event };
  if (next.request && typeof next.request === "object") {
    const request = { ...next.request };
    delete request.data;
    delete request.cookies;
    delete request.query_string;
    delete request.env;
    const headers = request.headers && typeof request.headers === "object" ? request.headers : {};
    const userAgent = headers["User-Agent"] ?? headers["user-agent"];
    if (typeof userAgent === "string") request.headers = { "User-Agent": userAgent };
    else delete request.headers;
    if (typeof request.url === "string") request.url = scrubText(request.url);
    next.request = request;
  }
  delete next.user;
  if (typeof next.message === "string") next.message = scrubText(next.message);
  if (next.logentry && typeof next.logentry === "object") {
    next.logentry = { message: scrubText(String(next.logentry.message || "")) };
  }
  if (typeof next.transaction === "string") next.transaction = scrubText(next.transaction);
  if (next.exception) next.exception = scrubException(next.exception);
  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
  }
  if (next.extra) next.extra = scrubValue(next.extra);
  if (next.contexts) next.contexts = scrubValue(next.contexts);
  if (next.tags) next.tags = scrubValue(next.tags);
  if (Array.isArray(next.spans)) {
    next.spans = next.spans.map((span) => ({
      ...span,
      description: scrubText(span.description),
      data: span.data ? scrubValue(span.data) : span.data,
    }));
  }
  return next;
}

// Sentry's free plan stores about 5,000 errors a month. One failure that
// repeats (a scheduler tick every 15 seconds, a page polling a broken route)
// would spend that in a day and hide every later problem. This sends the same
// error at most once per `windowMs`, and at most `maxPerWindow` errors in all
// per window. Digits are ignored when comparing, so ids and counts do not make
// a repeat look new. Transactions are not limited here.
export function createEventThrottle({ windowMs = 60 * 60 * 1000, maxPerWindow = 20, now = () => Date.now() } = {}) {
  const lastSent = new Map();
  let windowStart = 0;
  let sentInWindow = 0;
  return (event) => {
    if (!event || event.type === "transaction") return event;
    const at = now();
    if (at - windowStart >= windowMs) {
      windowStart = at;
      sentInWindow = 0;
      for (const [key, time] of lastSent) if (at - time >= windowMs) lastSent.delete(key);
    }
    const exception = event.exception?.values?.[0];
    const key = (Array.isArray(event.fingerprint) && event.fingerprint.length
      ? event.fingerprint.join("|")
      : `${exception?.type || ""}:${exception?.value || event.message || ""}`)
      .replace(/\d+/g, "0")
      .slice(0, 500);
    const previous = lastSent.get(key);
    if (previous !== undefined && at - previous < windowMs) return null;
    if (sentInWindow >= maxPerWindow) return null;
    lastSent.set(key, at);
    sentInWindow += 1;
    return event;
  };
}

// Console arguments after the first become `sentry.message.parameter.<n>`
// attributes. A number there with a fraction may be money; whole numbers are
// counts, ids and status codes, and stay.
const LOG_PARAMETER = /^sentry\.message\.parameter\./;

function scrubLogAttributes(attributes) {
  const out = scrubValue(attributes);
  for (const [key, value] of Object.entries(out)) {
    if (LOG_PARAMETER.test(key) && typeof value === "number" && !Number.isInteger(value)) out[key] = "[amount]";
  }
  return out;
}

// A log line (server console output sent to Sentry Logs): the same free-text
// rewriting as error messages, and the same key rules for its attributes.
export function scrubLog(log) {
  if (!log || typeof log !== "object") return log;
  return {
    ...log,
    message: scrubText(typeof log.message === "string" ? log.message : String(log.message ?? "")),
    attributes: log.attributes && typeof log.attributes === "object" ? scrubLogAttributes(log.attributes) : log.attributes,
  };
}
