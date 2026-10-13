import express, { Router } from "express";
import { OAuthStore } from "./oauth-store.js";
import { renderAuthorizationPage, renderAuthorizationSignInPage } from "./authorization-page.js";
import { MCP_SCOPES } from "./scopes.js";
import {
  createFieldMcpService,
  TOOL_DEFINITIONS,
  TOOL_SCOPES,
} from "./tool-service.js";

export { MCP_SCOPES } from "./scopes.js";
export { createFieldMcpService, TOOL_DEFINITIONS, TOOL_SCOPES } from "./tool-service.js";

export function resolveRemoteMcpRuntimeConfig({ config = {}, env = process.env } = {}) {
  if (config.mcp?.enabled === false) return { enabled: false, publicOrigin: null };
  if (config.mcp?.enabled === true) {
    return {
      enabled: true,
      publicOrigin: env.FIELD_PUBLIC_ORIGIN || config.mcp.publicOrigin,
    };
  }
  if (config.fieldVerification?.enabled === true) {
    return {
      enabled: true,
      publicOrigin: env.FIELD_PUBLIC_ORIGIN || config.fieldVerification.publicUrl,
    };
  }
  return { enabled: false, publicOrigin: null };
}

const MAX_CLIENT_NAME_LENGTH = 128;
const MAX_REDIRECT_URI_LENGTH = 2048;

function bearerToken(req) {
  return /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1] || null;
}

function formError(res, status, error, description) {
  return res.status(status).set("Cache-Control", "no-store").json({
    error,
    error_description: description,
  });
}

function parsePublicOrigin(value) {
  const url = new URL(value);
  const localTestOrigin = ["localhost", "127.0.0.1"].includes(url.hostname)
    && url.protocol === "http:";
  if ((!localTestOrigin && url.protocol !== "https:")
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password) {
    throw new Error("mcp.publicOrigin must be an HTTPS origin with pathname / (HTTP loopback allowed for tests)");
  }
  return url;
}

function redirectAllowed(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) {
    return false;
  }
  const url = new URL(value);
  const secure = url.protocol === "https:";
  const loopback = ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:";
  return (secure || loopback) && !url.username && !url.password && !url.hash;
}

function requestedScopes(raw) {
  const scopes = [...new Set(String(raw || "").split(/\s+/).filter(Boolean))];
  if (!scopes.length || scopes.some((scope) => !MCP_SCOPES.includes(scope))) return null;
  return scopes;
}

function registrationIsValid(metadata) {
  if (!Array.isArray(metadata.redirect_uris)
    || metadata.redirect_uris.length === 0
    || metadata.redirect_uris.length > 8
    || metadata.redirect_uris.some((uri) => {
      try { return !redirectAllowed(uri); } catch { return true; }
    })) return false;
  if (metadata.client_name !== undefined
    && (typeof metadata.client_name !== "string"
      || metadata.client_name.length === 0
      || metadata.client_name.length > MAX_CLIENT_NAME_LENGTH)) return false;
  if (metadata.token_endpoint_auth_method
    && metadata.token_endpoint_auth_method !== "none") return false;
  if (metadata.grant_types
    && (!Array.isArray(metadata.grant_types)
      || metadata.grant_types.some((grant) => !["authorization_code", "refresh_token"].includes(grant)))) return false;
  if (metadata.response_types
    && (!Array.isArray(metadata.response_types)
      || metadata.response_types.some((type) => type !== "code"))) return false;
  return true;
}

function requiredScopeChallenge({ issuer, scopes }) {
  const scope = scopes.join(" ");
  return `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`;
}

function invalidTokenChallenge(issuer) {
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`;
}

function rpcResult(res, id, result) {
  return res.json({ jsonrpc: "2.0", id, result });
}

function createInstallationRoutes({ store, authenticateInstallationRequest }) {
  const router = Router();
  const authenticate = authenticateInstallationRequest || ((_req, res) => {
    res.status(401).json({ error: "authentication required" });
  });

  router.get("/api/mcp/installations", authenticate, (req, res) => {
    const requestedSubject = typeof req.query.subject === "string" ? req.query.subject : null;
    if (requestedSubject && req.caller.role !== "admin" && requestedSubject !== req.caller.id) {
      return res.status(403).json({ error: "forbidden" });
    }
    const subject = req.caller.role === "admin" ? requestedSubject : req.caller.id;
    return res.json({ ok: true, installations: store.listInstallations({ subject }) });
  });

  router.delete("/api/mcp/installations/:id", authenticate, async (req, res) => {
    const revoked = await store.revokeInstallation({
      id: req.params.id,
      subject: req.caller.id,
      isAdmin: req.caller.role === "admin",
    });
    if (!revoked) return res.status(404).json({ error: "installation not found" });
    return res.json({ ok: true });
  });
  return router;
}

function authorizePathFor(pending) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
    state: pending.state,
    code_challenge: pending.codeChallenge,
    code_challenge_method: "S256",
    resource: pending.resource,
    scope: pending.scope.join(" "),
  });
  return `/oauth/authorize?${params.toString()}`;
}

export async function createRemoteMcpRouter({
  dataDir,
  publicOrigin,
  authenticate,
  authorizeScopes,
  authenticateInstallationRequest,
  // Clerk sign-in mode (FIELD_AUTH=clerk): approval comes from the signed-in
  // owner's session instead of an email and password. Resolves to { user },
  // { error: { status, message } } or { handled: true } (response already sent).
  approveWithSession = null,
  // async (subject) => the MCP scopes the person who approved a grant may use
  // right now, or null when they no longer may use Field at all (removed,
  // disabled, pending, or out of this organisation). Checked on every /mcp
  // call and refresh, so a grant never outlives its approver's access.
  currentScopes,
  service,
  now,
}) {
  if (typeof authenticate !== "function") throw new Error("authenticate is required");
  if (typeof authorizeScopes !== "function") throw new Error("authorizeScopes is required");
  if (typeof currentScopes !== "function") throw new Error("currentScopes is required");
  const origin = parsePublicOrigin(publicOrigin);
  const issuer = origin.origin;
  const resource = `${issuer}/mcp`;
  const store = new OAuthStore({ dataDir, now });
  await store.init();

  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // The approval page must never be framed by another site (clickjacking an
    // owner into approving a client).
    if (req.path.startsWith("/oauth/")) {
      res.set("Content-Security-Policy", "frame-ancestors 'none'");
      res.set("X-Frame-Options", "DENY");
    }
    next();
  });

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MCP_SCOPES,
  };

  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: MCP_SCOPES,
    resource_name: "Field quoting MCP",
  };
  router.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(protectedResource));
  router.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(protectedResource));
  router.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(metadata));
  // Prevent the SPA fallback from masquerading as provider metadata. Field is
  // an OAuth authorization server, not an OpenID Provider.
  router.get("/.well-known/openid-configuration", (_req, res) => res.status(404).end());

  router.post("/oauth/register", async (req, res) => {
    const metadata = req.body || {};
    if (!registrationIsValid(metadata)) {
      return formError(res, 400, "invalid_client_metadata", "public Authorization Code + PKCE clients only");
    }
    const client = await store.registerClient(metadata);
    const { createdAt, expiresAt, ...publicClient } = client;
    return res.status(201).json({
      ...publicClient,
      client_id_issued_at: Math.floor(createdAt / 1000),
      client_id_expires_at: Math.floor(expiresAt / 1000),
    });
  });

  router.get("/oauth/authorize", async (req, res) => {
    const query = req.query;
    const client = store.client(query.client_id);
    const scopes = requestedScopes(query.scope);
    const valid = query.response_type === "code"
      && client
      && client.redirect_uris.includes(query.redirect_uri)
      && query.state
      && query.code_challenge_method === "S256"
      && /^[A-Za-z0-9_-]{43}$/.test(query.code_challenge || "")
      && query.resource === resource
      && scopes;
    if (!valid) return res.status(400).send("Invalid authorization request");

    let signedInAs = null;
    if (approveWithSession) {
      const session = await approveWithSession(req, res);
      if (session.handled) return undefined;
      if (session.error) {
        const returnTo = `/oauth/authorize?${new URLSearchParams(query).toString()}`;
        return res.status(session.error.status).type("html").send(renderAuthorizationSignInPage({
          clientName: client.client_name,
          message: session.error.message,
          signInUrl: `/?return_to=${encodeURIComponent(returnTo)}`,
        }));
      }
      signedInAs = session.user.name || session.user.email || session.user.id;
    }

    const { request, csrf } = await store.createRequest({
      clientId: client.client_id,
      redirectUri: query.redirect_uri,
      state: query.state,
      scope: scopes,
      resource,
      codeChallenge: query.code_challenge,
    });
    return res.type("html").send(renderAuthorizationPage({
      clientName: client.client_name,
      scopes,
      requestId: request.id,
      csrf,
      signedInAs,
    }));
  });

  router.post("/oauth/approve", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    const pending = store.request(req.body?.request);
    if (!pending) return res.status(400).send("Authorization request expired");
    let user;
    if (approveWithSession) {
      const session = await approveWithSession(req, res);
      if (session.handled) return undefined;
      if (session.error?.code === "signed_out") {
        // Signed out between loading the page and submitting it: back to the
        // same authorization request, which offers sign-in. Rebuilt from what
        // the server stored for this request (validated when it was created),
        // never from the form body, and always a same-origin path.
        return res.redirect(303, authorizePathFor(pending));
      }
      if (session.error) return res.status(session.error.status).send(session.error.message);
      user = session.user;
    } else {
      user = await authenticate(String(req.body?.email || ""), String(req.body?.password || ""));
      if (!user) return res.status(401).send("Invalid credentials");
    }

    const permittedScopes = await authorizeScopes(user, [...pending.scope]);
    const exactPermission = Array.isArray(permittedScopes)
      && pending.scope.every((scope) => permittedScopes.includes(scope))
      && permittedScopes.every((scope) => pending.scope.includes(scope));
    if (!exactPermission) return res.status(403).send("Requested scopes are not permitted");

    const approved = await store.approve({
      id: pending.id,
      csrf: req.body?.csrf,
      subject: user.id,
      scope: permittedScopes,
    });
    if (!approved) return res.status(400).send("Authorization request expired");
    const callback = new URL(approved.request.redirectUri);
    callback.searchParams.set("code", approved.code);
    callback.searchParams.set("state", approved.request.state);
    return res.redirect(303, callback.href);
  });

  router.post("/oauth/token", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    const body = req.body || {};
    if (body.resource && body.resource !== resource) {
      return formError(res, 400, "invalid_target", "resource does not match the Field MCP audience");
    }
    const client = store.client(body.client_id);
    if (!client) return formError(res, 401, "invalid_client", "unknown or expired public client");

    if (body.grant_type === "authorization_code") {
      if (!body.code || !body.code_verifier || !client.redirect_uris.includes(body.redirect_uri)) {
        return formError(res, 400, "invalid_grant", "invalid authorization grant");
      }
      const tokens = await store.exchangeCode({
        code: body.code,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        verifier: body.code_verifier,
      });
      return tokens
        ? res.json(tokens)
        : formError(res, 400, "invalid_grant", "invalid, expired, or used authorization code");
    }
    if (body.grant_type === "refresh_token") {
      const scope = body.scope ? requestedScopes(body.scope) : [];
      if (body.scope && !scope) return formError(res, 400, "invalid_scope", "unsupported scope");
      // A refresh is issued only within what the approver may use now.
      const held = store.refreshGrant(body.refresh_token, body.client_id);
      let allowed = null;
      if (held) {
        try {
          allowed = await currentScopes(held.subject);
        } catch {
          return formError(res, 503, "temporarily_unavailable", "Field could not check this grant just now");
        }
      }
      const narrowed = (scope.length ? scope : held?.scope ?? []).filter((name) => allowed?.includes(name));
      if (held && !narrowed.length) {
        await store.revoke(body.refresh_token, body.client_id);
        return formError(res, 400, "invalid_grant", "invalid, expired, replayed, or revoked refresh token");
      }
      const tokens = await store.refresh({
        refreshToken: body.refresh_token,
        clientId: body.client_id,
        scope: held ? narrowed : scope,
      });
      return tokens
        ? res.json(tokens)
        : formError(res, 400, "invalid_grant", "invalid, expired, replayed, or revoked refresh token");
    }
    return formError(res, 400, "unsupported_grant_type", "authorization_code and refresh_token only");
  });

  router.post("/oauth/revoke", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    if (store.client(req.body?.client_id)) await store.revoke(req.body?.token, req.body?.client_id);
    return res.status(200).end();
  });

  router.use(createInstallationRoutes({ store, authenticateInstallationRequest }));

  router.all("/mcp", async (req, res) => {
    const token = bearerToken(req);
    const granted = token ? store.access(token, { resource }) : null;
    let allowed = null;
    if (granted) {
      try {
        allowed = await currentScopes(granted.subject);
      } catch {
        return res.status(503).json({ error: "temporarily_unavailable" });
      }
    }
    // The grant's scopes, cut down to what its approver may use now.
    const scope = granted ? granted.scope.filter((name) => allowed?.includes(name)) : [];
    if (!granted || !scope.length) {
      res.set("WWW-Authenticate", invalidTokenChallenge(issuer));
      return res.status(401).json({ error: "invalid_token" });
    }
    const authorization = { ...granted, scope };
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").end();

    const message = req.body || {};
    if (message.method === "initialize") {
      return rpcResult(res, message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "field-quoting", version: "1.0.0" },
      });
    }
    if (message.method === "notifications/initialized") return res.status(202).end();
    if (message.method === "ping") return rpcResult(res, message.id, {});
    if (message.method === "tools/list") {
      const tools = TOOL_DEFINITIONS.filter((tool) => (
        TOOL_SCOPES[tool.name].every((scope) => authorization.scope.includes(scope))
      ));
      return rpcResult(res, message.id, { tools });
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const requiredScopes = TOOL_SCOPES[name];
      if (!requiredScopes) {
        return res.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown tool" } });
      }
      if (requiredScopes.some((scope) => !authorization.scope.includes(scope))) {
        res.set("WWW-Authenticate", requiredScopeChallenge({ issuer, scopes: requiredScopes }));
        return res.status(403).json({
          error: "insufficient_scope",
          error_description: `Required scope: ${requiredScopes.join(" ")}`,
        });
      }
      try {
        const value = await service.call(name, message.params?.arguments || {}, {
          subject: authorization.subject,
          clientId: authorization.clientId,
          scopes: authorization.scope,
        });
        return rpcResult(res, message.id, {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
        });
      } catch (error) {
        return rpcResult(res, message.id, {
          isError: true,
          content: [{ type: "text", text: error.message }],
          structuredContent: { error: error.code || "tool_error" },
        });
      }
    }
    return res.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  });

  return { router, store, resource, issuer };
}
