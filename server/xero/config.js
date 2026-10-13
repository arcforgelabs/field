// Xero configuration for one installation (#93).
//
// Each installation connects to its owner's own Xero organisation through a
// Xero app that the owner creates at developer.xero.com. Its client id and
// client secret are deployment secrets, XERO_CLIENT_ID and XERO_CLIENT_SECRET
// (Replit Secrets, or the environment elsewhere); they are never stored in
// the database or shown, only whether each one is set.
//
// The redirect address is built from the configured public address
// (`publicUrl`), never hard-coded, so every installation shows its own.
// Docs: docs/XERO.md.

export const XERO_CALLBACK_PATH = "/api/integrations/xero/callback";

// Xero's identity and API hosts (docs/XERO.md "Xero's documentation").
export const XERO_ENDPOINTS = Object.freeze({
  authorize: "https://login.xero.com/identity/connect/authorize",
  token: "https://identity.xero.com/connect/token",
  revoke: "https://identity.xero.com/connect/revocation",
  connections: "https://api.xero.com/connections",
  accounting: "https://api.xero.com/api.xro/2.0",
});

/**
 * The scopes Field asks for. `offline_access` gives the refresh token. Xero
 * gives apps created from 2 March 2026 the granular accounting scopes, so
 * Field asks for those rather than the broad `accounting.transactions`, which
 * new apps cannot request (docs/XERO.md "Scopes").
 */
export const XERO_SCOPES = Object.freeze([
  "offline_access",
  "accounting.invoices",
  "accounting.contacts",
  "accounting.attachments",
  "accounting.settings.read",
]);

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Tests (and the offline proofs) point Field at a fake Xero server on this
 * machine. Only a loopback http address is accepted, so the setting can never
 * send tokens to another host.
 */
export function fakeXeroBaseUrl(env = process.env) {
  const raw = text(env.FIELD_XERO_FAKE_BASE_URL);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FIELD_XERO_FAKE_BASE_URL is not a URL");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("FIELD_XERO_FAKE_BASE_URL must be a loopback http address (a fake Xero for tests)");
  }
  return url.origin;
}

/** Xero's endpoints, or a fake Xero's at `base` (same paths under it). */
export function xeroEndpoints(base = null) {
  if (!base) return XERO_ENDPOINTS;
  return Object.freeze({
    authorize: `${base}/identity/connect/authorize`,
    token: `${base}/connect/token`,
    revoke: `${base}/connect/revocation`,
    connections: `${base}/connections`,
    accounting: `${base}/api.xro/2.0`,
  });
}

/** The deployment secrets. `status()` is what the browser may see. */
export function readXeroSecrets(env = process.env) {
  const clientId = text(env.XERO_CLIENT_ID);
  const clientSecret = text(env.XERO_CLIENT_SECRET);
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
    status: () => ({ clientIdSet: Boolean(clientId), clientSecretSet: Boolean(clientSecret) }),
  };
}

/**
 * This installation's redirect address: the configured public address plus
 * the callback path. Without `publicUrl` it falls back to the address the
 * request came to, and says so (`fromRequest`), so the screen can ask the
 * owner to set it.
 */
export function xeroRedirectUri({ publicUrl = null, req = null } = {}) {
  const configured = text(publicUrl);
  if (configured) return { redirectUri: `${configured.replace(/\/+$/, "")}${XERO_CALLBACK_PATH}`, fromRequest: false };
  if (!req) return { redirectUri: null, fromRequest: true };
  const proto = String(req.headers?.["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = String(req.headers?.["x-forwarded-host"] || req.get?.("host") || "").split(",")[0].trim();
  return { redirectUri: host ? `${proto}://${host}${XERO_CALLBACK_PATH}` : null, fromRequest: true };
}
