// Gmail OAuth re-authorization (docs/GMAIL_SENDING.md, "Per-user OAuth").
//
//   GET /api/auth/gmail           signed in: the Google consent URL to open
//   GET /api/auth/gmail/callback  Google sends the browser back here
//
// The callback has no Field sign-in: it is a top-level navigation from
// Google, and the browser's bearer token lives in localStorage. So the OAuth
// `state` is a random, single-use value that Field issued to a signed-in
// person in the last ten minutes; Field keeps what it stands for (who asked,
// and where to return) in memory. The callback refuses any other state before
// it exchanges the code, and its answers are plain text that never repeats a
// value from the request or an error.
import { randomBytes } from "node:crypto";

export const GMAIL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 1000;

export function createGmailOAuthStateStore({ now = Date.now, ttlMs = GMAIL_OAUTH_STATE_TTL_MS } = {}) {
  const pending = new Map();
  const prune = (at) => {
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= at) pending.delete(state);
    }
  };
  return {
    issue({ returnTo, user }) {
      const at = now();
      prune(at);
      // Oldest first: a flood of abandoned consents cannot grow it without bound.
      while (pending.size >= MAX_PENDING_STATES) pending.delete(pending.keys().next().value);
      const state = randomBytes(32).toString("base64url");
      pending.set(state, {
        returnTo: String(returnTo || ""),
        userId: user?.id || null,
        userEmail: user?.email ? String(user.email).trim().toLowerCase() : null,
        expiresAt: at + ttlMs,
      });
      return state;
    },
    // The entry for a state Field issued and nobody has used yet, else null.
    take(state) {
      const key = typeof state === "string" ? state : "";
      const entry = key ? pending.get(key) : undefined;
      if (!entry) return null;
      pending.delete(key);
      return entry.expiresAt > now() ? entry : null;
    },
    get size() {
      return pending.size;
    },
  };
}

// Same-origin only: the return path always lands inside the app's hash route.
export function buildGmailOAuthReturnUrl(returnPath) {
  const cleanPath = String(returnPath || "/").trim() || "/";
  const hashPath = cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
  const joiner = hashPath.includes("?") ? "&" : "?";
  return `/#${hashPath}${joiner}gmailReauthorized=1`;
}

function withoutTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function gmailOAuthRedirectUri(config, req) {
  const baseUrl = config.publicUrl
    || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}`;
  return `${withoutTrailingSlashes(String(baseUrl))}/api/auth/gmail/callback`;
}

function sendPlain(res, status, message) {
  res.status(status)
    .set("Content-Type", "text/plain; charset=utf-8")
    .set("X-Content-Type-Options", "nosniff")
    .set("Cache-Control", "no-store")
    .send(message);
}

async function defaultResolveTokenEmail(oauth2Client) {
  const token = await oauth2Client.getAccessToken();
  const accessToken = typeof token === "string" ? token : token?.token;
  if (!accessToken) return "";
  const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
  if (!response.ok) return "";
  const info = await response.json();
  return String(info.email || "").trim().toLowerCase();
}

export function registerGmailOAuthRoutes(app, {
  config,
  requireAuth,
  OAuth2,
  scopes,
  hasServiceAccountKey,
  resolveDelegatedUser,
  resolveLoginHint,
  saveOAuthUser,
  onAuthorized = () => {},
  resolveTokenEmail = defaultResolveTokenEmail,
  states = createGmailOAuthStateStore(),
  log = console,
}) {
  const clientCredentials = () => {
    const oauth = config.googleOAuth || {};
    return {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || oauth.clientId,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || oauth.clientSecret,
    };
  };

  app.get("/api/auth/gmail", requireAuth, (req, res) => {
    const delegatedUser = resolveDelegatedUser(config, { user: req.caller });
    const explicitlyDelegated = Boolean(process.env.FIELD_MAIL_GMAIL_USER || config.mail?.gmailUser);
    if (hasServiceAccountKey(config) && delegatedUser && explicitlyDelegated) {
      return res.status(409).json({ error: `Gmail is configured for server-side sending as ${delegatedUser}; OAuth re-authorization is not required.` });
    }

    const { clientId, clientSecret } = clientCredentials();
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "Gmail OAuth client credentials are not configured" });
    }

    const oauth2Client = new OAuth2(clientId, clientSecret, gmailOAuthRedirectUri(config, req));
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopes,
      state: states.issue({ returnTo: req.query.returnTo || "", user: req.caller }),
      login_hint: req.query.loginHint || resolveLoginHint(config, { user: req.caller }),
    });
    res.json({ url });
  });

  app.get("/api/auth/gmail/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) return sendPlain(res, 400, "Missing authorization code.");
    // Before the code is exchanged: only a consent Field started, once.
    const state = states.take(req.query.state);
    if (!state) {
      return sendPlain(res, 400, "This Gmail authorization was not started from Field, was already used, or has expired. Start it again from Field.");
    }

    const { clientId, clientSecret } = clientCredentials();
    try {
      const oauth2Client = new OAuth2(clientId, clientSecret, gmailOAuthRedirectUri(config, req));
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      const consentEmail = await resolveTokenEmail(oauth2Client);
      if (!consentEmail) {
        return sendPlain(res, 400, "Gmail consent did not return an account email. Re-authorize Gmail with the updated scopes.");
      }
      if (state.userEmail && consentEmail !== state.userEmail) {
        return sendPlain(res, 400, "Gmail consent was completed for a different Google account than the Field user who started it. Start again from Field and choose your own account.");
      }

      // Store a user-scoped refresh token in the data directory. This keeps each
      // Field user mapped to their own Gmail Sent Mail instead of a global token.
      // config is never rewritten at runtime.
      const entry = await saveOAuthUser(consentEmail, {
        refreshToken: tokens.refresh_token,
        fallbackRefreshToken: config.googleOAuth?.users?.[consentEmail]?.refreshToken,
      });

      // Update in-memory config
      if (!config.googleOAuth) config.googleOAuth = {};
      config.googleOAuth.users = { ...(config.googleOAuth.users || {}), [consentEmail]: entry };
      onAuthorized(consentEmail);

      res.redirect(buildGmailOAuthReturnUrl(state.returnTo));
    } catch (err) {
      // The detail goes to the log only: an error can carry text from the request.
      log.error("[gmail-oauth-callback] token exchange failed:", err?.message);
      sendPlain(res, 500, "Gmail re-authorization failed. Try again from Field; if it keeps failing, the server log has the reason.");
    }
  });
}
