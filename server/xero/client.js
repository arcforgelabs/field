// Xero over HTTP (#93): the OAuth 2.0 authorization code flow and the
// accounting calls Field makes. No state of its own; the connection service
// (connection.js) keeps the tokens.
//
// Every failure is a XeroError with a short `code`, whether it is worth
// retrying (`retryable`), whether the owner must connect again
// (`reconnect`), how long Xero asked us to wait (`retryAfterMs`, from
// Retry-After on a 429) and a plain `reason` the owner can read. Messages
// never carry a token, a client secret or a response body; Xero's own
// validation messages go only into `reason`, which is stored with the
// invoice and shown to the owner, never logged.
//
// Docs (docs/XERO.md "Xero's documentation"): the authorization code flow,
// GET /connections, the accounting API's Idempotency-Key header, and its
// rate limits (HTTP 429 with Retry-After).
import { createHash, randomBytes } from "node:crypto";

export class XeroError extends Error {
  constructor(code, reason, { status = null, retryable = false, reconnect = false, retryAfterMs = null, problem = null } = {}) {
    super(`Xero: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "XeroError";
    this.code = code;
    this.reason = reason;
    this.status = status;
    this.retryable = retryable;
    this.reconnect = reconnect;
    this.retryAfterMs = retryAfterMs;
    this.problem = problem;
  }
}

/** A random OAuth state for one sign-in. */
export function newAuthorizationRequest() {
  return { state: randomBytes(32).toString("base64url") };
}

export function hashState(state) {
  return createHash("sha256").update(String(state)).digest("hex");
}

function retryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function readJson(response) {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Xero's validation messages from a 400 (Elements[].ValidationErrors[].Message), joined and cut short. */
export function validationMessages(body) {
  const messages = [];
  for (const element of Array.isArray(body?.Elements) ? body.Elements : []) {
    for (const error of Array.isArray(element?.ValidationErrors) ? element.ValidationErrors : []) {
      if (typeof error?.Message === "string" && error.Message.trim()) messages.push(error.Message.trim());
    }
  }
  if (!messages.length && typeof body?.Message === "string" && body.Message.trim()) messages.push(body.Message.trim());
  if (!messages.length && typeof body?.Detail === "string" && body.Detail.trim()) messages.push(body.Detail.trim());
  const unique = [...new Set(messages)].join(" ");
  return unique.length > 300 ? `${unique.slice(0, 300)}…` : unique;
}

/** A XeroError for an unsuccessful API response. */
async function apiError(response) {
  const status = response.status;
  if (status === 429) {
    const problem = response.headers.get("x-rate-limit-problem");
    const wait = retryAfterMs(response);
    return new XeroError("XERO_RATE_LIMITED", `Xero asked Field to slow down${problem ? ` (${problem} limit)` : ""}. Field tries again by itself.`, { status, retryable: true, retryAfterMs: wait, problem });
  }
  // A token without a scope the call needs: Xero spells it "insufficent_scope".
  if (status === 401 && /insuffic?i?ent_scope/i.test(response.headers.get("www-authenticate") || "")) {
    return new XeroError("XERO_SCOPE_MISSING", "Field's Xero sign-in lacks a permission it needs. Connect Xero again in Settings, Integrations.", { status, reconnect: true });
  }
  if (status === 401) return new XeroError("XERO_UNAUTHORISED", "Xero did not accept Field's sign-in. Field signs in again and retries.", { status, retryable: true });
  if (status === 403) return new XeroError("XERO_FORBIDDEN", "Xero refused access to this organisation. Connect Xero again in Settings, Integrations.", { status, reconnect: true });
  if (status === 404) return new XeroError("XERO_NOT_FOUND", "Xero could not find what Field asked for.", { status });
  if (status >= 500) return new XeroError("XERO_UNAVAILABLE", "Xero is not responding properly. Field tries again by itself.", { status, retryable: true, retryAfterMs: retryAfterMs(response) });
  const body = await readJson(response);
  const detail = validationMessages(body);
  return new XeroError(status === 400 ? "XERO_VALIDATION" : "XERO_REQUEST_REFUSED", detail ? `Xero refused it: ${detail}` : `Xero refused it (HTTP ${status}).`, { status });
}

/**
 * The HTTP side of one Xero app. `endpoints` from config.js; `fetch` and
 * `sleep` are injectable for tests. A 429 whose Retry-After is at most
 * `inlineRetryMaxMs` is waited out and retried here, up to
 * `inlineRetries` times; a longer one is returned to the caller to schedule.
 */
export function createXeroHttp({
  clientId,
  clientSecret,
  endpoints,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  sleep = (ms) => new Promise((wake) => setTimeout(wake, ms)),
  inlineRetryMaxMs = 5_000,
  inlineRetries = 2,
} = {}) {
  if (!endpoints) throw new Error("createXeroHttp needs Xero's endpoints");

  async function send(url, init) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new XeroError(timedOut ? "XERO_TIMEOUT" : "XERO_UNREACHABLE", "Field could not reach Xero. It tries again by itself.", { retryable: true });
    }
  }

  function basicAuth() {
    if (!clientId || !clientSecret) throw new XeroError("XERO_SECRETS_MISSING", "XERO_CLIENT_ID and XERO_CLIENT_SECRET are not both set.", { reconnect: true });
    return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
  }

  async function tokenRequest(params) {
    const response = await send(endpoints.token, {
      method: "POST",
      headers: { authorization: basicAuth(), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
    const body = await readJson(response);
    if (response.ok) {
      if (!body?.access_token || !body?.refresh_token) {
        throw new XeroError("XERO_TOKEN_INVALID", "Xero's sign-in answer had no tokens. Connect Xero again.", { status: response.status, reconnect: true });
      }
      const expiresIn = Number(body.expires_in);
      return {
        accessToken: String(body.access_token),
        refreshToken: String(body.refresh_token),
        expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1800,
      };
    }
    if (response.status === 429 || response.status >= 500) throw await apiErrorFromBody(response, body);
    const error = String(body?.error || "");
    if (error === "invalid_client" || response.status === 401) {
      throw new XeroError("XERO_CLIENT_REJECTED", "Xero did not accept XERO_CLIENT_ID and XERO_CLIENT_SECRET. Check them, then connect again.", { status: response.status, reconnect: true });
    }
    if (error === "invalid_grant") {
      throw new XeroError("XERO_REFRESH_REJECTED", "Xero no longer accepts Field's sign-in (it expired or was revoked). Connect Xero again in Settings, Integrations.", { status: response.status, reconnect: true });
    }
    throw new XeroError("XERO_TOKEN_REFUSED", "Xero refused Field's sign-in. Connect Xero again.", { status: response.status, reconnect: true });
  }

  async function apiErrorFromBody(response, _body) {
    // The body was read already; build the error from the status and headers.
    if (response.status === 429) {
      const problem = response.headers.get("x-rate-limit-problem");
      return new XeroError("XERO_RATE_LIMITED", "Xero asked Field to slow down. Field tries again by itself.", { status: 429, retryable: true, retryAfterMs: retryAfterMs(response), problem });
    }
    return new XeroError("XERO_UNAVAILABLE", "Xero is not responding properly. Field tries again by itself.", { status: response.status, retryable: true });
  }

  async function bearer(url, { accessToken, tenantId = null, method = "GET", json = undefined, body = undefined, contentType = null, idempotencyKey = null }) {
    const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
    if (tenantId) headers["xero-tenant-id"] = tenantId;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let payload = body;
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(json);
    } else if (contentType) {
      headers["content-type"] = contentType;
    }
    for (let attempt = 0; ; attempt += 1) {
      const response = await send(url, { method, headers, body: payload });
      if (response.ok) return response.status === 204 ? null : readJson(response);
      const error = await apiError(response);
      if (error.code === "XERO_RATE_LIMITED" && attempt < inlineRetries && (error.retryAfterMs ?? Infinity) <= inlineRetryMaxMs) {
        await sleep(error.retryAfterMs ?? 0);
        continue;
      }
      throw error;
    }
  }

  return {
    /** Where the owner signs in to Xero and picks the organisations to connect. */
    authorizeUrl({ redirectUri, state, scopes }) {
      const url = new URL(endpoints.authorize);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },

    /** The authorization code for tokens. */
    exchangeCode({ code, redirectUri }) {
      return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    },

    /** A refresh token for new tokens. Xero rotates the refresh token: store the new one. */
    refresh(refreshToken) {
      return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    },

    /** Revoke a refresh token (and the connections it made). Best effort. */
    async revoke(refreshToken) {
      const response = await send(endpoints.revoke, {
        method: "POST",
        headers: { authorization: basicAuth(), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
      if (!response.ok) throw await apiError(response);
    },

    /** The organisations this access token reaches: [{ id, tenantId, tenantType, tenantName }]. */
    async connections(accessToken) {
      const list = await bearer(endpoints.connections, { accessToken });
      return (Array.isArray(list) ? list : []).filter((entry) => entry && entry.tenantId);
    },

    deleteConnection(accessToken, connectionId) {
      return bearer(`${endpoints.connections}/${encodeURIComponent(connectionId)}`, { accessToken, method: "DELETE" });
    },

    /** An accounting API call: `path` under /api.xro/2.0, with the organisation's tenant id. */
    accounting({ accessToken, tenantId, method = "GET", path, query = null, json, body, contentType, idempotencyKey = null }) {
      const url = new URL(`${endpoints.accounting}${path}`);
      for (const [key, value] of Object.entries(query || {})) if (value != null) url.searchParams.set(key, String(value));
      return bearer(url.toString(), { accessToken, tenantId, method, json, body, contentType, idempotencyKey });
    },
  };
}
