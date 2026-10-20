// Security headers on every response (#179).
//
// - X-Content-Type-Options: nosniff, so a browser never runs an upload or a
//   JSON answer as a script or a page.
// - X-Frame-Options: DENY and frame-ancestors 'none': Field never frames its
//   own pages (its only frames are sandboxed srcdoc email previews), so no
//   site may frame Field (clickjacking).
// - Referrer-Policy: strict-origin-when-cross-origin: a link out of Field
//   sends only the origin, never a job path.
// - A Content-Security-Policy. The page's two inline scripts (the theme script
//   in client/index.html and Sentry's settings) carry a nonce made for each
//   response, so the policy needs no 'unsafe-inline' for scripts. Clerk loads
//   its script through Field's own origin (/api/__clerk) or from its hosts;
//   no 'strict-dynamic', so a script Clerk adds is checked against the hosts.
//   Styles keep 'unsafe-inline': Clerk, Sentry's feedback widget and React
//   style attributes write inline styles, and the email previews (srcdoc
//   frames, which take this page's policy) are styled inline.
//
// FIELD_CSP picks the mode: `report-only` (the default) sends the policy as
// Content-Security-Policy-Report-Only, so the browser reports a violation in
// its console and blocks nothing; `enforce` sends Content-Security-Policy;
// `off` sends neither. A wrong policy breaks sign-in, so enforce only after a
// sign-in, a Google sign-in, a PDF and a problem report run clean in
// report-only. Browsers ignore frame-ancestors in a report-only policy (and
// warn about it), so it is sent only when enforced; X-Frame-Options refuses
// framing in every mode.

import { randomBytes } from "node:crypto";

export const CSP_MODES = ["report-only", "enforce", "off"];

export function resolveCspMode(env = process.env) {
  const raw = String(env.FIELD_CSP ?? "").trim().toLowerCase();
  if (!raw) return "report-only";
  if (!CSP_MODES.includes(raw)) {
    throw new Error(`FIELD_CSP must be one of ${CSP_MODES.join(", ")}; got "${env.FIELD_CSP}"`);
  }
  return raw;
}

// Clerk: its Frontend API, the bot-protection loader (*.client.protect.clerk.com),
// development instances, its telemetry, and Cloudflare Turnstile for sign-up
// bot checks. https://clerk.com/docs/security/clerk-csp
const CLERK_SCRIPT = ["https://*.clerk.com", "https://*.clerk.accounts.dev", "https://challenges.cloudflare.com"];
const CLERK_CONNECT = ["https://*.clerk.com", "https://*.clerk.accounts.dev", "https://clerk-telemetry.com"];
// Sentry's ingest hosts (o<n>.ingest.us.sentry.io and others).
const SENTRY_CONNECT = ["https://*.sentry.io"];
// Address search and reverse geocoding (client/src/lib/geo.ts).
const GEOCODER_CONNECT = ["https://nominatim.openstreetmap.org"];

export function buildContentSecurityPolicy({ nonce, enforce = true }) {
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, ...CLERK_SCRIPT],
    "style-src": ["'self'", "'unsafe-inline'"],
    // https: because a sent email (shown in a preview frame) may show the
    // business's logo or a signature image from anywhere.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...CLERK_CONNECT, ...SENTRY_CONNECT, ...GEOCODER_CONNECT],
    // Sentry's session replay compresses in a blob: worker; Clerk may too.
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'self'", "https://challenges.cloudflare.com"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    ...(enforce ? { "frame-ancestors": ["'none'"] } : {}),
  };
  return Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

export function createCspNonce() {
  return randomBytes(16).toString("base64");
}

// Adds the response's nonce to every <script> tag in a page Field writes.
export function addScriptNonce(html, nonce) {
  if (!nonce) return html;
  return html.replace(/<script(?![^>]*\snonce=)(?=[\s>])/gi, `<script nonce="${nonce}"`);
}

export function securityHeaders({ cspMode = "report-only" } = {}) {
  if (!CSP_MODES.includes(cspMode)) throw new Error(`unknown CSP mode: ${cspMode}`);
  const cspHeader = cspMode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
  return function setSecurityHeaders(_req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (cspMode !== "off") {
      const nonce = createCspNonce();
      res.locals.cspNonce = nonce;
      res.setHeader(cspHeader, buildContentSecurityPolicy({ nonce, enforce: cspMode === "enforce" }));
    }
    next();
  };
}
