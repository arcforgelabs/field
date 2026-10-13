// What every integration's routes share (#112), and the one route about
// FIELD_SECRETS_KEY itself:
//
//   POST /api/integrations/secrets-key/generated   (owners) the browser made a
//        new key for FIELD_SECRETS_KEY. Takes no body and stores nothing but an
//        audit event: who, when, "secrets key generated". The key itself never
//        reaches the server (shared/secrets-web.js makes it in the browser).

export const SECRETS_KEY_GENERATED_PATH = "/api/integrations/secrets-key/generated";
/** The audit events of the key itself (not one integration's). */
export const SECRETS_KEY_AUDIT = "secrets_key";

/** The permission that lets an API or MCP token read an integration's status (never change it). */
export const INTEGRATIONS_READ_PERMISSION = "integrations:read";

// An API or MCP token (a service account, or a person's token with Clerk
// sign-in), not a person in the browser. The break-glass key is the owner's.
export function isMachine(caller) {
  if (!caller) return false;
  if (caller.via === "break-glass") return false;
  return caller.kind === "service" || caller.via === "token";
}

// Integration settings are not for machine tokens: never their changes, and
// their status only with the integrations:read permission.
export function machineGate({ read = false } = {}) {
  return (req, res, next) => {
    const caller = req.caller;
    if (!isMachine(caller)) return next();
    if (read && Array.isArray(caller.permissions) && caller.permissions.includes(INTEGRATIONS_READ_PERMISSION)) return next();
    return res.status(403).json({ error: "API and MCP tokens cannot use integration settings.", code: "INTEGRATIONS_FORBIDDEN" });
  };
}

/** A request body with anything in it. Routes that take no body refuse it, so nothing key-like is ever accepted. */
export function hasBody(body) {
  if (body == null) return false;
  if (typeof body !== "object") return true;
  return Object.keys(body).length > 0;
}

/** `credentialStore()` returns server/secrets/credentials.js's store, or null without a database. */
export function registerSecretsKeyRoutes(app, { requireAuth, requireOwner, credentialStore, actorOf = () => null, logger = console }) {
  app.post(SECRETS_KEY_GENERATED_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (hasBody(req.body)) return res.status(400).json({ error: "This takes no body. The key stays in your browser.", code: "SECRETS_KEY_BODY_REFUSED" });
    const store = credentialStore();
    if (!store) return res.status(503).json({ error: "Recording this needs the database, which this server does not have.", code: "SECRETS_NO_DATABASE" });
    try {
      await store.audit(SECRETS_KEY_AUDIT, "secrets_key_generated", { actor: actorOf(req) });
      res.json({ ok: true });
    } catch (error) {
      logger.warn?.(`[secrets] the key's audit event could not be written (${/^[A-Z0-9_]{1,64}$/.test(String(error?.code || "")) ? error.code : "error"})`);
      res.status(500).json({ error: "Field could not record this. The key still works.", code: "SECRETS_AUDIT_FAILED" });
    }
  });
}
