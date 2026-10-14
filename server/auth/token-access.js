// Listing and revoking command-line tokens (#133), shared by the Clerk
// routes (server/auth/clerk-auth.js) and password sign-in's routes below.
//
// What leaves the server about a token is its metadata only: id, name,
// created, last used, and whether it is the token this request came in with.
// Never its value and never its hash (users.js tokenMetadata).
//
// Revoking the token the current request authenticated with would sign that
// session out, so it needs an explicit `?confirm=current`. Every revoke writes
// an access audit event (server/auth/access-audit.js). The token stops
// working at once either way: users.js drops it from memory before the
// response, so the next request with it is refused.
import { Router } from "express";

export function bearerOf(req) {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }
  return null;
}

/** A holder's tokens, metadata only, with `current` on the one this request used. */
export function tokensFor(users, holderId, req) {
  const currentId = users.tokenIdForPlaintext ? users.tokenIdForPlaintext(holderId, bearerOf(req)) : null;
  return users.listUserTokens(holderId).map((token) => ({ ...token, current: token.id === currentId }));
}

export const CURRENT_TOKEN_WARNING = "This is the token this session signed in with. Revoking it signs this session out. Confirm to revoke it anyway.";

/**
 * Revoke one of `holder`'s tokens. Returns { status, body } for the route.
 * `holder` is { id, name, email }; `audit` is the access audit store or null.
 */
export async function revokeHolderToken({ users, audit, log = console, req, holder, tokenId }) {
  const token = users.listUserTokens(holder.id).find((candidate) => candidate.id === tokenId);
  if (!token) return { status: 404, body: { error: "token not found" } };
  const current = Boolean(users.tokenIdForPlaintext) && users.tokenIdForPlaintext(holder.id, bearerOf(req)) === token.id;
  if (current && req.query?.confirm !== "current") {
    return { status: 409, body: { error: CURRENT_TOKEN_WARNING, code: "current_token" } };
  }
  if (!(await users.revokeToken(holder.id, token.id))) return { status: 404, body: { error: "token not found" } };
  log.info?.(`[auth] ${req.caller?.id ?? "unknown"} revoked token ${token.id} for ${holder.id}${current ? " (the token this request used)" : ""}`);
  let audited = false;
  if (audit) {
    try {
      await audit.record("token_revoked", {
        actor: req.caller,
        target: { id: token.id, name: token.label },
        holder: { id: holder.id, name: holder.name || holder.email || null },
      });
      audited = true;
    } catch (error) {
      // The token is revoked either way: a leaked token must be stoppable even
      // when the audit trail cannot be written.
      log.error?.(`[auth] token ${token.id} revoked, but its audit event could not be written: ${error.message}`);
    }
  } else {
    log.warn?.(`[auth] token ${token.id} revoked with no audit store (no database)`);
  }
  return { status: 200, body: { ok: true, audited, signedOut: current } };
}

/**
 * Password sign-in (FIELD_AUTH unset): an admin manages anyone's tokens, and
 * a person their own. There the browser session is itself a Field token, so
 * the current-token guard matters. Clerk sign-in replaces these routes
 * (createClerkAuthRouter answers first, owners only).
 */
export function createPasswordTokenRouter({ users, requireAuth, audit = () => null, log = console }) {
  const router = Router();
  const canManage = (req, targetId) => Boolean(req.caller) && (req.caller.id === targetId || req.caller.role === "admin");

  router.get("/api/users/:id/tokens", requireAuth, (req, res) => {
    if (!canManage(req, req.params.id)) return res.status(403).json({ error: "forbidden" });
    const target = users.findUserById(req.params.id);
    if (!target) return res.status(404).json({ error: "user not found" });
    return res.json({ ok: true, tokens: tokensFor(users, target.id, req) });
  });

  router.post("/api/users/:id/tokens", requireAuth, async (req, res) => {
    if (!canManage(req, req.params.id)) return res.status(403).json({ error: "forbidden" });
    const target = users.findUserById(req.params.id);
    if (!target) return res.status(404).json({ error: "user not found" });
    const minted = await users.addToken(target.id, req.body?.label);
    return res.status(201).json({ ok: true, token: minted.token, metadata: minted.metadata });
  });

  router.delete("/api/users/:id/tokens/:tokenId", requireAuth, async (req, res) => {
    if (!canManage(req, req.params.id)) return res.status(403).json({ error: "forbidden" });
    const target = users.findUserById(req.params.id);
    if (!target) return res.status(404).json({ error: "token not found" });
    const result = await revokeHolderToken({ users, audit: audit(), log, req, holder: target, tokenId: req.params.tokenId });
    return res.status(result.status).json(result.body);
  });

  return router;
}

/** GET /api/access/events: the latest access audit events, owners only. */
export function createAccessEventsRouter({ requireAuth, requireOwner, audit = () => null }) {
  const router = Router();
  router.get("/api/access/events", requireAuth, requireOwner, async (req, res) => {
    const store = audit();
    if (!store) return res.json({ ok: true, events: [], available: false });
    try {
      return res.json({ ok: true, events: await store.recent(req.query.limit), available: true });
    } catch (error) {
      console.error(`[auth] access audit events could not be read: ${error.message}`);
      return res.status(503).json({ error: "The access history could not be read just now.", code: "audit_unavailable" });
    }
  });
  return router;
}
