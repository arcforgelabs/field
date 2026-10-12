// Clerk sign-in for Field, switched on by FIELD_AUTH=clerk.
//
// People sign in with Clerk (Replit's managed Clerk integration provisions the
// keys). Who they are in Field, their role and whether they may use Field at
// all live in PostgreSQL (server/auth/field-users-store.js), never only in
// Clerk. Machine access stays Field-issued: CLI/API bearer tokens (users.json)
// and MCP OAuth grants keep working, but issuing or revoking them needs
// a verified owner sign-in (see ownerVerification below: a recent second factor,
// or Google Workspace sign-in on an allowed domain with no password).
//
// With FIELD_AUTH unset none of this is loaded and Field authenticates exactly
// as before (password login minting per-user bearer tokens).
//
// Secrets: CLERK_SECRET_KEY and the break-glass key (authToken) are never
// logged, returned or put in an error message. Errors name variables only.
import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import {
  FieldUserError,
  assertAsciiEmail,
  createInvitedUser,
  createPendingUser,
  deleteFieldUser,
  findFieldUserByClerkId,
  findFieldUserByEmail,
  findFieldUserById,
  importLegacyUsers,
  linkClerkUser,
  listFieldUsers,
  normaliseEmail,
  publicFieldUser,
  updateFieldUser,
} from "./field-users-store.js";
import { DEFAULT_ORG_UID, orgScope } from "../db-runtime/tenancy.js";

export const BREAK_GLASS_HEADER = "x-field-break-glass";
const BREAK_GLASS_WINDOW_MS = 15 * 60 * 1000;
const BREAK_GLASS_MAX_ATTEMPTS = 5;
// A Clerk session cookie alone authorizes only reads (PDF links, previews the
// browser opens directly). Anything that changes state must carry the session
// token in the Authorization header, which another site cannot make a browser
// send: cross-site request forgery cannot ride on the cookie.
const COOKIE_SAFE_METHODS = new Set(["GET", "HEAD"]);
// How long a second factor counts for owner actions, and how long a fetched
// Clerk user is trusted for the Google Workspace owner check.
export const DEFAULT_OWNER_MFA_MAX_AGE_MINUTES = 12 * 60;
const CLERK_USER_CACHE_MS = 60 * 1000;

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

// "clerk" or "password" (FIELD_AUTH unset: today's behaviour). Anything else
// is a configuration error, so a typo can never silently fall back to passwords.
export function resolveFieldAuthMode(env = process.env) {
  const raw = readEnv(env, "FIELD_AUTH").toLowerCase();
  if (raw === "" || raw === "password") return "password";
  if (raw === "clerk") return "clerk";
  throw new Error('FIELD_AUTH must be "clerk" or unset');
}

// Clerk keys from the environment. Replit's Clerk integration sets
// CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY (some Replit templates name the
// publishable key VITE_CLERK_PUBLISHABLE_KEY; either works). CLERK_PROXY_URL
// is passed through when set. Only variable names appear in errors.
export function resolveClerkKeys(env = process.env) {
  const secretKey = readEnv(env, "CLERK_SECRET_KEY");
  const publishableSource = readEnv(env, "CLERK_PUBLISHABLE_KEY") ? "CLERK_PUBLISHABLE_KEY"
    : readEnv(env, "VITE_CLERK_PUBLISHABLE_KEY") ? "VITE_CLERK_PUBLISHABLE_KEY" : null;
  const publishableKey = publishableSource ? readEnv(env, publishableSource) : "";
  const missing = [];
  if (!secretKey) missing.push("CLERK_SECRET_KEY");
  if (!publishableKey) missing.push("CLERK_PUBLISHABLE_KEY");
  if (missing.length) {
    throw new Error(`FIELD_AUTH=clerk needs ${missing.join(" and ")} (Replit: Tools > Users & Auth sets them)`);
  }
  if (!/^sk_(test|live)_\S+$/.test(secretKey)) {
    throw new Error("CLERK_SECRET_KEY is not a Clerk secret key (expected sk_test_... or sk_live_...)");
  }
  if (!/^pk_(test|live)_\S+$/.test(publishableKey)) {
    throw new Error(`${publishableSource} is not a Clerk publishable key (expected pk_test_... or pk_live_...)`);
  }
  const proxyUrl = readEnv(env, "CLERK_PROXY_URL") || null;
  return { secretKey, publishableKey, publishableSource, proxyUrl };
}

// FIELD_OWNER_MFA_MAX_AGE: how long a session's second factor counts for owner
// actions. Minutes, or with an m/h suffix ("90m", "12h"); default 12h.
export function parseOwnerMfaMaxAge(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return DEFAULT_OWNER_MFA_MAX_AGE_MINUTES;
  const match = /^(\d+)\s*(m|h)?$/.exec(value);
  const minutes = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : NaN;
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new Error('FIELD_OWNER_MFA_MAX_AGE must be a positive number of minutes, or hours with "h" (e.g. 12h)');
  }
  return minutes;
}

// FIELD_OWNER_GOOGLE_DOMAINS: comma-separated email domains whose Google
// Workspace sign-in counts as the owner's strong sign-in (that Workspace
// enforces 2-Step Verification). No default: unset disables that path.
export function parseOwnerGoogleDomains(raw) {
  const domains = String(raw ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  for (const domain of domains) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      throw new Error("FIELD_OWNER_GOOGLE_DOMAINS must be a comma-separated list of email domains (e.g. example.com)");
    }
  }
  return [...new Set(domains)];
}

export function resolveOwnerVerificationConfig(env = process.env) {
  return {
    ownerMfaMaxAgeMinutes: parseOwnerMfaMaxAge(readEnv(env, "FIELD_OWNER_MFA_MAX_AGE")),
    ownerGoogleDomains: parseOwnerGoogleDomains(readEnv(env, "FIELD_OWNER_GOOGLE_DOMAINS")),
  };
}

// Origins allowed to have minted a Clerk session token (Clerk's `azp` claim):
// Field's own public origin when it is configured. Unset: Clerk's default.
export function resolveAuthorizedParties({ env = process.env, config = {} } = {}) {
  const candidates = [readEnv(env, "FIELD_PUBLIC_ORIGIN"), config?.publicUrl];
  const origins = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    let url;
    try {
      url = new URL(candidate.trim());
    } catch {
      throw new Error("FIELD_PUBLIC_ORIGIN / publicUrl must be an absolute URL (e.g. https://field.example.com)");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("FIELD_PUBLIC_ORIGIN / publicUrl must be an http(s) URL");
    }
    origins.add(url.origin);
  }
  return [...origins];
}

// The real Clerk SDK, loaded only when FIELD_AUTH=clerk. Tests pass a fake
// adapter with the same three members instead.
export async function loadClerkAdapter({ secretKey, publishableKey, proxyUrl, authorizedParties = [] }) {
  const { clerkMiddleware, createClerkClient, getAuth } = await import("@clerk/express");
  const options = { secretKey, publishableKey, ...(proxyUrl ? { proxyUrl } : {}) };
  const clerkClient = createClerkClient(options);
  return {
    middleware: clerkMiddleware({
      ...options,
      clerkClient,
      ...(authorizedParties.length ? { authorizedParties } : {}),
    }),
    getAuth: (req) => getAuth(req),
    getUser: (userId) => clerkClient.users.getUser(userId),
  };
}

// The Clerk user's primary email and whether Clerk has verified it. Field links
// only on a verified primary address: an unverified one proves nothing.
export function primaryEmailOf(clerkUser) {
  const addresses = Array.isArray(clerkUser?.emailAddresses) ? clerkUser.emailAddresses : [];
  const primary = addresses.find((address) => address?.id === clerkUser?.primaryEmailAddressId) ?? null;
  if (!primary) return { email: null, verified: false };
  return {
    email: normaliseEmail(primary.emailAddress),
    verified: primary.verification?.status === "verified",
  };
}

function displayNameOf(clerkUser, email) {
  const parts = [clerkUser?.firstName, clerkUser?.lastName].map((part) => String(part || "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  const username = String(clerkUser?.username || "").trim();
  return username || String(email || "").split("@")[0];
}

// Clerk's `fva` session claim is [minutes since first factor, minutes since
// second factor]; the second is -1 when this session never passed a second
// factor. Counts only while it is at most maxAgeMinutes old.
export function secondFactorVerified(auth, maxAgeMinutes = DEFAULT_OWNER_MFA_MAX_AGE_MINUTES) {
  const fva = Array.isArray(auth?.factorVerificationAge) ? auth.factorVerificationAge
    : Array.isArray(auth?.sessionClaims?.fva) ? auth.sessionClaims.fva : null;
  if (!fva) return false;
  const secondFactorAge = fva[1];
  return typeof secondFactorAge === "number"
    && Number.isFinite(secondFactorAge)
    && secondFactorAge >= 0
    && secondFactorAge <= maxAgeMinutes;
}

function isGoogleProvider(provider) {
  const value = String(provider || "").toLowerCase();
  return value === "oauth_google" || value === "google";
}

// The Google Workspace owner path: the Clerk user signed up through a verified
// Google account whose email is the Field user's email, on an allowed domain,
// and has no password (so Google, and its enforced 2-Step Verification, is the
// only way in). Returns true or false; never throws.
export function googleWorkspaceOwner(clerkUser, fieldEmail, allowedDomains) {
  if (!clerkUser || !Array.isArray(allowedDomains) || allowedDomains.length === 0) return false;
  if (clerkUser.passwordEnabled !== false) return false;
  const email = normaliseEmail(fieldEmail);
  if (!email || !/^[\x21-\x7e]+$/.test(email)) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || !allowedDomains.includes(email.slice(at + 1))) return false;
  const accounts = Array.isArray(clerkUser.externalAccounts) ? clerkUser.externalAccounts : [];
  return accounts.some((account) => isGoogleProvider(account?.provider)
    && account?.verification?.status === "verified"
    && normaliseEmail(account?.emailAddress) === email);
}

const DENIALS = {
  signed_out: { status: 401, error: "unauthorized" },
  email_unverified: {
    status: 403,
    error: "Field links your sign-in by your verified email address. Verify your primary email in your account settings, then sign in again.",
  },
  email_not_ascii: {
    status: 403,
    error: "Field only accepts plain (ASCII) email addresses. Sign in with an account whose email has no accented or non-Latin characters.",
  },
  email_linked_elsewhere: {
    status: 403,
    error: "That email address is already linked to a different sign-in. Ask a Field owner to sort it out.",
  },
  field_access_pending: {
    status: 403,
    error: "You're signed in, but a Field owner still needs to approve your access.",
  },
  field_access_disabled: {
    status: 403,
    error: "Your Field access has been turned off. Ask a Field owner if this is a mistake.",
  },
  no_field_access: { status: 403, error: "This credential has no Field access." },
  auth_unavailable: { status: 503, error: "Sign-in is unavailable right now. Try again shortly." },
};

function deny(res, code) {
  const denial = DENIALS[code] ?? DENIALS.signed_out;
  return res.status(denial.status).json(code === "signed_out" ? { error: denial.error } : { error: denial.error, code });
}

const OWNER_DENIALS = {
  owner_required: { status: 403, error: "Only a Field owner can do this." },
  owner_session_required: {
    status: 403,
    error: "Owner actions need an owner signed in to Field. API, CLI and MCP tokens cannot do this.",
  },
  owner_check_unavailable: {
    status: 503,
    error: "Field could not confirm your owner sign-in with the sign-in provider just now. Try again shortly.",
  },
};

function hoursOrMinutes(minutes) {
  return minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`;
}

// Why an owner's sign-in is not strong enough, and the ways to fix it.
export function ownerVerificationMessage({ ownerGoogleDomains = [], ownerMfaMaxAgeMinutes = DEFAULT_OWNER_MFA_MAX_AGE_MINUTES } = {}) {
  const ways = [];
  if (ownerGoogleDomains.length) {
    ways.push(`sign in with Google using your work account (${ownerGoogleDomains.map((domain) => `@${domain}`).join(" or ")}) that matches your Field email, with no password set on your sign-in`);
  }
  ways.push(`sign in with two-step verification (it counts for ${hoursOrMinutes(ownerMfaMaxAgeMinutes)})`);
  return `Owner actions need a verified owner sign-in. Sign out, then ${ways.join(", or ")}.`;
}

function statusDenial(status) {
  if (status === "pending") return "field_access_pending";
  if (status === "disabled") return "field_access_disabled";
  return null;
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// The caller shape the rest of the server already uses (id, email, name, kind,
// role "admin" | "user", settings, permissions), plus fieldRole/status and how
// the request authenticated (`via`: clerk | token | break-glass).
function humanCaller(row, legacy, { via, mfaVerified, ownerVerifiedBy = null }) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    kind: "human",
    role: row.role === "owner" ? "admin" : "user",
    fieldRole: row.role,
    status: row.status,
    // The organisation of the membership the person signed in through.
    orgUid: row.orgUid,
    via,
    // For owners: whether owner-only actions are allowed on this sign-in
    // (ownerVerifiedBy says how: "second_factor" or "google_workspace").
    mfaVerified: Boolean(mfaVerified),
    ownerVerifiedBy: mfaVerified ? ownerVerifiedBy : null,
    settings: legacy?.settings ?? {},
    permissions: Array.isArray(legacy?.permissions) ? legacy.permissions : [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const BREAK_GLASS_CALLER = Object.freeze({
  id: "break-glass",
  email: null,
  name: "Break-glass owner",
  kind: "service",
  role: "admin",
  fieldRole: "owner",
  status: "active",
  via: "break-glass",
  mfaVerified: true,
  ownerVerifiedBy: "break_glass",
  settings: {},
  permissions: [],
});

function sha256(value) {
  return createHash("sha256").update(String(value)).digest();
}

function bearerFrom(req) {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }
  return null;
}

function queryTokenFrom(req) {
  return typeof req.query?.token === "string" && req.query.token.trim() ? req.query.token.trim() : null;
}

/**
 * @param {object} options
 * @param {object} options.db                 Drizzle instance holding the users table
 * @param {string} options.orgUid             the organisation this deployment serves (default: the default organisation);
 *                                            people are looked up by their membership of it
 * @param {object} options.clerk              { middleware, getAuth(req), getUser(id) }
 * @param {object} options.legacy             users.js functions: findUserByToken, findUserById
 * @param {string} options.breakGlassKey      authToken; the owner's emergency key
 * @param {number} options.ownerMfaMaxAgeMinutes  how long a second factor counts (FIELD_OWNER_MFA_MAX_AGE)
 * @param {string[]} options.ownerGoogleDomains   Google Workspace domains for the owner path (FIELD_OWNER_GOOGLE_DOMAINS)
 */
export function createClerkAuth({
  db: database,
  orgUid = DEFAULT_ORG_UID,
  clerk,
  legacy,
  breakGlassKey,
  log = console,
  now = Date.now,
  breakGlassMaxAttempts = BREAK_GLASS_MAX_ATTEMPTS,
  breakGlassWindowMs = BREAK_GLASS_WINDOW_MS,
  ownerMfaMaxAgeMinutes = DEFAULT_OWNER_MFA_MAX_AGE_MINUTES,
  ownerGoogleDomains = [],
  clerkUserCacheMs = CLERK_USER_CACHE_MS,
}) {
  if (!database) throw new Error("createClerkAuth: db is required");
  const db = orgScope(database, orgUid);
  if (!clerk?.middleware || !clerk?.getAuth || !clerk?.getUser) throw new Error("createClerkAuth: clerk adapter is required");
  if (!legacy?.findUserByToken) throw new Error("createClerkAuth: legacy user lookups are required");
  const breakGlassDigest = breakGlassKey ? sha256(breakGlassKey) : null;
  const breakGlassAttempts = new Map();
  const googleDomains = parseOwnerGoogleDomains(ownerGoogleDomains.join(","));
  const ownerMessage = ownerVerificationMessage({ ownerGoogleDomains: googleDomains, ownerMfaMaxAgeMinutes });
  // Clerk users fetched for the Google Workspace owner check, briefly cached so
  // an owner's burst of requests costs one Clerk API call. Failures are never cached.
  const clerkUserCache = new Map();

  function runClerkMiddleware(req, res) {
    if (req.fieldClerkDone) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      // A Clerk handshake answers the request itself (a redirect) instead of
      // calling next(); the caller must then stop.
      const onFinish = () => resolve(false);
      res.once("finish", onFinish);
      clerk.middleware(req, res, (error) => {
        res.off("finish", onFinish);
        if (error) return reject(error);
        req.fieldClerkDone = true;
        resolve(true);
      });
    });
  }

  // Map a Clerk user id to its Field row, linking or recording it on first
  // sign-in. Returns { row } or { denial }.
  async function fieldUserForClerkUser(clerkUserId) {
    const linked = await findFieldUserByClerkId(db, clerkUserId);
    if (linked) return { row: linked };

    const clerkUser = await clerk.getUser(clerkUserId);
    const { email, verified } = primaryEmailOf(clerkUser);
    if (!email || !verified) {
      log.warn?.(`[auth] Clerk user ${clerkUserId} refused: primary email is not verified`);
      return { denial: "email_unverified" };
    }
    try {
      assertAsciiEmail(email);
    } catch {
      log.warn?.(`[auth] Clerk user ${clerkUserId} refused: primary email is not ASCII`);
      return { denial: "email_not_ascii" };
    }
    const byEmail = await findFieldUserByEmail(db, email);
    if (byEmail) {
      if (byEmail.clerkUserId && byEmail.clerkUserId !== clerkUserId) {
        log.warn?.(`[auth] Clerk user ${clerkUserId} refused: Field user ${byEmail.id} is linked to another Clerk user`);
        return { denial: "email_linked_elsewhere" };
      }
      const row = await linkClerkUser(db, { id: byEmail.id, clerkUserId });
      if (!row) {
        // Linked by a concurrent request: use whatever won.
        const again = await findFieldUserByClerkId(db, clerkUserId);
        return again ? { row: again } : { denial: "email_linked_elsewhere" };
      }
      log.info?.(`[auth] linked Clerk user ${clerkUserId} to Field user ${row.id} (${row.role}, ${row.status})`);
      return { row };
    }
    const row = await createPendingUser(db, { clerkUserId, email, name: displayNameOf(clerkUser, email) });
    if (row?.clerkUserId !== clerkUserId) return { denial: "email_linked_elsewhere" };
    log.info?.(`[auth] new Clerk user ${clerkUserId} recorded as pending Field user ${row.id}; an owner must approve them`);
    return { row };
  }

  // Resolve the Clerk session on this request: { state: "ok", row, auth },
  // { state: "denied", code } or { state: "handled" } (Clerk answered itself).
  async function resolveClerkSession(req, res) {
    let continued;
    try {
      continued = await runClerkMiddleware(req, res);
    } catch (error) {
      log.error?.(`[auth] Clerk session check failed: ${error.message}`);
      return { state: "denied", code: "auth_unavailable" };
    }
    if (!continued || res.headersSent) return { state: "handled" };
    const auth = clerk.getAuth(req);
    if (!auth?.userId) return { state: "denied", code: "signed_out" };
    try {
      const resolved = await fieldUserForClerkUser(auth.userId);
      if (resolved.denial) return { state: "denied", code: resolved.denial };
      return { state: "ok", row: resolved.row, auth };
    } catch (error) {
      log.error?.(`[auth] Field user lookup failed: ${error.message}`);
      return { state: "denied", code: "auth_unavailable" };
    }
  }

  async function cachedClerkUser(clerkUserId) {
    const at = now();
    const cached = clerkUserCache.get(clerkUserId);
    if (cached && cached.expiresAt > at) return cached.user;
    const user = await clerk.getUser(clerkUserId);
    if (clerkUserCache.size > 500) clerkUserCache.clear();
    clerkUserCache.set(clerkUserId, { user, expiresAt: at + clerkUserCacheMs });
    return user;
  }

  // Is this owner's sign-in strong enough for owner-only actions?
  //   (a) the session passed a second factor within ownerMfaMaxAgeMinutes, or
  //   (b) FIELD_OWNER_GOOGLE_DOMAINS is set and the Clerk user (fetched from
  //       Clerk's backend API) has a verified Google account with the Field
  //       email, on an allowed domain, and no password.
  // Replit's managed Clerk has no MFA, so (b) is the everyday path: Google
  // Workspace enforces 2-Step Verification. Any Clerk API error fails closed.
  // Returns { verified, by } or { unavailable: true }.
  async function ownerVerification(row, auth) {
    if (secondFactorVerified(auth, ownerMfaMaxAgeMinutes)) return { verified: true, by: "second_factor" };
    if (googleDomains.length === 0 || !auth?.userId) return { verified: false, by: null };
    try {
      const clerkUser = await cachedClerkUser(auth.userId);
      if (clerkUser?.id && clerkUser.id !== auth.userId) return { verified: false, by: null };
      return googleWorkspaceOwner(clerkUser, row.email, googleDomains)
        ? { verified: true, by: "google_workspace" }
        : { verified: false, by: null };
    } catch (error) {
      log.error?.(`[auth] owner sign-in check failed (Clerk user lookup): ${error.message}`);
      return { unavailable: true };
    }
  }

  function breakGlassLimited(key) {
    const at = now();
    if (breakGlassAttempts.size > 1000) {
      for (const [client, entry] of breakGlassAttempts) {
        if (entry.resetAt <= at) breakGlassAttempts.delete(client);
      }
    }
    const entry = breakGlassAttempts.get(key);
    if (!entry || entry.resetAt <= at) {
      breakGlassAttempts.set(key, { count: 1, resetAt: at + breakGlassWindowMs });
      return null;
    }
    entry.count += 1;
    return entry.count > breakGlassMaxAttempts ? Math.ceil((entry.resetAt - at) / 1000) : null;
  }

  // Emergency owner access with the deployment's authToken in the
  // X-Field-Break-Glass header (never a query string or Bearer token). Every
  // use is logged loudly; attempts are rate-limited per client (req.ip, which
  // honours Express's `trust proxy`; see server/index.js).
  function handleBreakGlass(req, res, next, presented) {
    const where = `${req.method} ${req.path} from ${req.ip || "unknown"}`;
    const retryAfter = breakGlassLimited(req.ip || "unknown");
    if (retryAfter !== null) {
      log.warn?.(`[auth] BREAK-GLASS rate limited: ${where}`);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many break-glass attempts; wait and try again.", code: "break_glass_rate_limited" });
    }
    const ok = breakGlassDigest !== null
      && typeof presented === "string"
      && presented.length > 0
      && timingSafeEqual(sha256(presented), breakGlassDigest);
    if (!ok) {
      log.warn?.(`[auth] BREAK-GLASS refused (wrong key): ${where}`);
      return res.status(401).json({ error: "unauthorized" });
    }
    log.warn?.(`[auth] BREAK-GLASS OWNER ACCESS USED: ${where}. Sign in with Clerk instead as soon as it works again.`);
    req.caller = { ...BREAK_GLASS_CALLER };
    return next();
  }

  // Field-issued bearer token (CLI/API, or a token Field minted earlier).
  // Returns a caller, a denial code, or null when it is not a Field token.
  // A token is bound to the users.json record that holds it, and that record's
  // id is the person's PostgreSQL id (imports keep ids; Clerk-mode holders are
  // created under the row id). It is never matched by email: a removed
  // person's token must not come back to life for a new row with their email.
  async function tokenCaller(token) {
    const holder = legacy.findUserByToken(token);
    if (!holder) return null;
    const row = await findFieldUserById(db, holder.id);
    if (row) {
      const denial = statusDenial(row.status);
      if (denial) return { denial };
      return { caller: humanCaller(row, holder, { via: "token", mfaVerified: false }) };
    }
    // A person Field no longer knows keeps no access through old tokens;
    // service accounts are machine identities and live only in users.json.
    if (holder.kind !== "service") return { denial: "no_field_access" };
    return {
      caller: {
        ...holder,
        fieldRole: holder.role === "admin" ? "owner" : "staff",
        status: "active",
        via: "token",
        mfaVerified: false,
        ownerVerifiedBy: null,
      },
    };
  }

  async function requireAuth(req, res, next) {
    const presented = req.headers[BREAK_GLASS_HEADER];
    if (presented !== undefined) return handleBreakGlass(req, res, next, Array.isArray(presented) ? presented[0] : presented);

    const bearer = bearerFrom(req);
    const queryToken = bearer ? null : queryTokenFrom(req);
    const fieldToken = bearer ?? queryToken;
    if (fieldToken) {
      let resolved;
      try {
        resolved = await tokenCaller(fieldToken);
      } catch (error) {
        log.error?.(`[auth] token check failed: ${error.message}`);
        return deny(res, "auth_unavailable");
      }
      if (resolved?.denial) return deny(res, resolved.denial);
      if (resolved?.caller) {
        req.caller = resolved.caller;
        return next();
      }
      // A ?token= that is not a Field token (typically a stale one left in a
      // browser from password sign-in) is ignored, never treated as a session
      // token: a GET/HEAD falls through to the session cookie below, exactly as
      // if no token had been sent, and is refused if there is no session.
      // This cannot widen access: the cookie alone already authorizes GET/HEAD,
      // and anything else is refused below without a Bearer header. Otherwise
      // the bearer is a Clerk session token: fall through.
    }
    if (!bearer && !COOKIE_SAFE_METHODS.has(req.method)) return deny(res, "signed_out");

    const session = await resolveClerkSession(req, res);
    if (session.state === "handled") return undefined;
    if (session.state === "denied") return deny(res, session.code);
    const denial = statusDenial(session.row.status);
    if (denial) return deny(res, denial);
    const holder = legacy.findUserById?.(session.row.id) ?? null;
    const secondFactor = secondFactorVerified(session.auth, ownerMfaMaxAgeMinutes);
    req.caller = humanCaller(session.row, holder, {
      via: "clerk",
      mfaVerified: secondFactor,
      ownerVerifiedBy: secondFactor ? "second_factor" : null,
    });
    // Kept off the caller object: what requireOwner needs to check the owner path.
    Object.defineProperty(req, "fieldClerkSession", { value: { row: session.row, auth: session.auth }, enumerable: false, configurable: true });
    return next();
  }

  // Owner-only actions: a Clerk-signed-in owner with a verified owner sign-in
  // (ownerVerification), or the break-glass key. Machine tokens never qualify.
  function ownerDenial(caller) {
    if (!caller) return "signed_out";
    if (caller.via === "break-glass") return null;
    if (caller.fieldRole !== "owner") return "owner_required";
    if (caller.via !== "clerk") return "owner_session_required";
    return null;
  }

  function ownerDenialBody(code) {
    if (code === "owner_mfa_required") return { status: 403, error: ownerMessage };
    return OWNER_DENIALS[code];
  }

  // Finish the owner check for a Clerk owner: returns null when allowed, or a
  // denial code (owner_mfa_required, owner_check_unavailable).
  async function ownerSignInDenial(caller, clerkSession) {
    if (caller.via !== "clerk") return null;
    if (caller.mfaVerified) return null;
    if (!clerkSession) return "owner_mfa_required";
    const verification = await ownerVerification(clerkSession.row, clerkSession.auth);
    if (verification.unavailable) return "owner_check_unavailable";
    if (!verification.verified) return "owner_mfa_required";
    caller.mfaVerified = true;
    caller.ownerVerifiedBy = verification.by;
    return null;
  }

  async function requireOwner(req, res, next) {
    let code = ownerDenial(req.caller);
    if (!code) code = await ownerSignInDenial(req.caller, req.fieldClerkSession);
    if (!code) return next();
    if (code === "signed_out") return deny(res, code);
    const denial = ownerDenialBody(code);
    return res.status(denial.status).json({ error: denial.error, code });
  }

  // For the MCP OAuth approval page (a browser form, so the Clerk session cookie):
  // { user } for a verified owner, otherwise { error: { status, code, message } }.
  async function authenticateOwnerSession(req, res) {
    const session = await resolveClerkSession(req, res);
    if (session.state === "handled") return { handled: true };
    if (session.state === "denied") {
      const denial = DENIALS[session.code];
      return { error: { status: denial.status, code: session.code, message: session.code === "signed_out" ? "Sign in to Field as an owner first." : denial.error } };
    }
    const status = statusDenial(session.row.status);
    if (status) return { error: { status: 403, code: status, message: DENIALS[status].error } };
    const caller = humanCaller(session.row, null, { via: "clerk", mfaVerified: false });
    const code = ownerDenial(caller) ?? (await ownerSignInDenial(caller, session));
    if (code) {
      const denial = ownerDenialBody(code);
      return { error: { status: denial.status, code, message: denial.error } };
    }
    return { user: caller };
  }

  // True when the request carries machine credentials (break-glass header or a
  // Field-issued token) rather than a Clerk session.
  function isMachineRequest(req) {
    if (req.headers[BREAK_GLASS_HEADER] !== undefined) return true;
    const token = bearerFrom(req) ?? queryTokenFrom(req);
    return Boolean(token && legacy.findUserByToken(token));
  }

  // /api/auth/me in Clerk mode: also answers pending/disabled people (with their
  // status) so the client can tell them what is going on. For an active owner it
  // also reports whether owner-only actions are open to this sign-in.
  async function describeSession(req, res) {
    const session = await resolveClerkSession(req, res);
    if (session.state === "handled") return { handled: true };
    if (session.state === "denied") return { denial: session.code };
    const holder = legacy.findUserById?.(session.row.id) ?? null;
    let verification = { verified: false, by: null };
    if (session.row.role === "owner" && session.row.status === "active") {
      verification = await ownerVerification(session.row, session.auth);
    } else if (secondFactorVerified(session.auth, ownerMfaMaxAgeMinutes)) {
      verification = { verified: true, by: "second_factor" };
    }
    const caller = humanCaller(session.row, holder, {
      via: "clerk",
      mfaVerified: Boolean(verification.verified),
      ownerVerifiedBy: verification.by ?? null,
    });
    if (caller.fieldRole === "owner" && !caller.mfaVerified) caller.ownerVerificationHelp = ownerMessage;
    return { caller };
  }

  return {
    mode: "clerk",
    orgUid,
    requireAuth,
    requireOwner,
    authenticateOwnerSession,
    describeSession,
    isMachineRequest,
    deny,
    ownerGoogleDomains: googleDomains,
    ownerMfaMaxAgeMinutes,
    importLegacyUsers: (legacyUsers) => importLegacyUsers(db, legacyUsers),
  };
}

function sendUserError(res, error) {
  if (error instanceof FieldUserError) return res.status(error.status).json({ error: error.message, code: error.code });
  throw error;
}

function publicCaller(caller) {
  if (!caller) return null;
  const { settings, permissions, ...rest } = caller;
  return { ...rest, settings: settings ?? {}, permissions: permissions ?? [] };
}

/**
 * Routes that replace the password-era auth and user routes when FIELD_AUTH=clerk.
 * Mounted before the legacy routes, so these answer first.
 *
 * @param {object} options
 * @param {ReturnType<typeof createClerkAuth>} options.auth
 * @param {object} options.db
 * @param {object} options.users  users.js: listUsers, createUser, deleteUser, findUserById,
 *                                findUserByEmail, findUserByToken, ensureUser, addToken,
 *                                revokeToken, revokeAllTokens, revokeTokenByPlaintext, listUserTokens
 * @param {function} options.revokeMcpAccess  async (subjectIds) => installations revoked; the MCP
 *                                MCP grants for a person who is removed or disabled
 */
export function createClerkAuthRouter({ auth, db: database, users, revokeMcpAccess = async () => 0, log = console }) {
  const db = orgScope(database, auth?.orgUid ?? DEFAULT_ORG_UID);
  const router = Router();
  const { requireAuth, requireOwner } = auth;

  // The users.json records holding a person's machine tokens: the one under
  // their id, and any human record with their email (left by an earlier
  // version, or by password-era sign-in). Service accounts are never matched
  // by email: they are separate machine identities.
  function machineRecordsFor(row) {
    const records = new Map();
    const byId = users.findUserById(row.id);
    if (byId) records.set(byId.id, byId);
    const byEmail = row.email ? users.findUserByEmail(row.email) : null;
    if (byEmail && byEmail.kind !== "service") records.set(byEmail.id, byEmail);
    return [...records.values()];
  }

  // Someone removed or disabled keeps nothing that still works: their CLI/API
  // tokens are revoked (on removal their users.json record goes too, with any
  // old password hash) and every MCP installation they approved is revoked.
  async function cutOffMachineAccess(row, { remove }) {
    const records = machineRecordsFor(row);
    let tokens = 0;
    for (const record of records) {
      tokens += users.listUserTokens(record.id).length;
      if (remove) await users.deleteUser(record.id);
      else await users.revokeAllTokens(record.id);
    }
    const subjects = [...new Set([row.id, ...records.map((record) => record.id)])];
    const installations = await revokeMcpAccess(subjects);
    log.info?.(`[auth] cut off machine access for Field user ${row.id}: ${tokens} token(s) revoked, ${installations || 0} MCP installation(s) revoked${remove ? ", users.json record removed" : ""}`);
  }

  function cutOffFailed(res, row, error) {
    log.error?.(`[auth] Field user ${row.id} changed but revoking their machine access failed: ${error.message}`);
    return res.status(500).json({
      error: "The change was saved, but revoking their tokens or MCP connections failed. Their tokens no longer authenticate; retry to finish revoking.",
      code: "revoke_failed",
    });
  }

  router.post("/api/auth/login", (_req, res) => {
    res.status(410).json({
      error: "Password sign-in is retired. Sign in to Field with your account instead.",
      code: "password_login_retired",
    });
  });

  router.get("/api/auth/me", async (req, res) => {
    if (auth.isMachineRequest(req)) {
      return requireAuth(req, res, () => res.json({ ok: true, user: publicCaller(req.caller) }));
    }
    const result = await auth.describeSession(req, res);
    if (result.handled) return undefined;
    if (result.denial) return auth.deny(res, result.denial);
    return res.json({ ok: true, user: publicCaller(result.caller) });
  });

  // Signing out of Clerk happens in the browser. A Field bearer token sent here
  // is revoked, as before.
  router.post("/api/auth/logout", async (req, res) => {
    const bearer = bearerFrom(req);
    const holder = bearer ? users.findUserByToken(bearer) : null;
    if (holder) await users.revokeTokenByPlaintext(holder.id, bearer);
    res.json({ ok: true });
  });

  router.post("/api/users/:id/password", (_req, res) => {
    res.status(410).json({ error: "Passwords are managed by the sign-in provider now.", code: "password_login_retired" });
  });

  router.get("/api/users", requireAuth, requireOwner, async (_req, res) => {
    const rows = await listFieldUsers(db);
    const serviceAccounts = users.listUsers().filter((user) => user.kind === "service");
    res.json({ ok: true, users: rows.map(publicFieldUser), serviceAccounts });
  });

  // Add someone before their first sign-in (active, linked on first sign-in
  // by verified email), or a service account for machine tokens.
  router.post("/api/users", requireAuth, requireOwner, async (req, res) => {
    const { email, name, role, kind, permissions } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    try {
      assertAsciiEmail(email);
    } catch (error) {
      return sendUserError(res, error);
    }
    if (kind === "service") {
      // A service account must not share an email with a person: tokens and
      // records would be ambiguous between the machine and the human.
      if (await findFieldUserByEmail(db, email)) {
        return res.status(409).json({ error: "A person in Field already uses that email. Give the service account its own address.", code: "email_in_use" });
      }
      try {
        const user = await users.createUser({ email, name, kind: "service", role: role === "owner" ? "admin" : "user", permissions });
        log.info?.(`[auth] owner ${req.caller.id} created service account ${user.id}`);
        return res.status(201).json({ ok: true, user });
      } catch (error) {
        if (error.code === "EEXISTS") return res.status(409).json({ error: error.message });
        return res.status(400).json({ error: error.message });
      }
    }
    try {
      const row = await createInvitedUser(db, { email, name, role: role ?? "staff" });
      log.info?.(`[auth] owner ${req.caller.id} added Field user ${row.id} (${row.role})`);
      return res.status(201).json({ ok: true, user: publicFieldUser(row) });
    } catch (error) {
      return sendUserError(res, error);
    }
  });

  router.post("/api/users/:id/approve", requireAuth, requireOwner, async (req, res) => {
    const role = req.body?.role ?? "staff";
    try {
      const row = await updateFieldUser(db, req.params.id, { role, status: "active" });
      if (!row) return res.status(404).json({ error: "user not found" });
      log.info?.(`[auth] owner ${req.caller.id} approved Field user ${row.id} as ${row.role}`);
      return res.json({ ok: true, user: publicFieldUser(row) });
    } catch (error) {
      return sendUserError(res, error);
    }
  });

  router.patch("/api/users/:id", requireAuth, requireOwner, async (req, res) => {
    const { name, role, status } = req.body || {};
    if (req.caller.id === req.params.id && (role !== undefined || status !== undefined)) {
      return res.status(400).json({ error: "You can't change your own role or access; ask another owner.", code: "self_change" });
    }
    try {
      const row = await updateFieldUser(db, req.params.id, { name, role, status });
      if (!row) return res.status(404).json({ error: "user not found" });
      log.info?.(`[auth] owner ${req.caller.id} updated Field user ${row.id}: ${row.role}, ${row.status}`);
      if (row.status === "disabled") {
        try {
          await cutOffMachineAccess(row, { remove: false });
        } catch (error) {
          return cutOffFailed(res, row, error);
        }
      }
      return res.json({ ok: true, user: publicFieldUser(row) });
    } catch (error) {
      return sendUserError(res, error);
    }
  });

  router.delete("/api/users/:id", requireAuth, requireOwner, async (req, res) => {
    if (req.caller.id === req.params.id) return res.status(400).json({ error: "cannot delete yourself" });
    let removed;
    try {
      removed = await deleteFieldUser(db, req.params.id);
    } catch (error) {
      return sendUserError(res, error);
    }
    if (removed) {
      log.info?.(`[auth] owner ${req.caller.id} removed Field user ${removed.id}`);
      try {
        await cutOffMachineAccess(removed, { remove: true });
      } catch (error) {
        return cutOffFailed(res, removed, error);
      }
      return res.json({ ok: true });
    }
    const service = users.findUserById(req.params.id);
    if (service?.kind === "service" && (await users.deleteUser(service.id))) {
      log.info?.(`[auth] owner ${req.caller.id} removed service account ${service.id}`);
      return res.json({ ok: true });
    }
    return res.status(404).json({ error: "user not found" });
  });

  // Machine tokens are held in users.json, by the record whose id is the
  // person's PostgreSQL id (tokenCaller only ever matches on that id). A Field
  // user created through Clerk gets that record the first time a token is
  // issued. Service accounts live only in users.json.
  async function tokenHolder(id, { create = false } = {}) {
    const row = await findFieldUserById(db, id);
    const direct = users.findUserById(id);
    if (!row) return direct?.kind === "service" ? direct : null;
    if (direct) return direct;
    if (!create) return null;
    const sameEmail = users.findUserByEmail(row.email);
    if (sameEmail) {
      if (sameEmail.kind === "service" || (await findFieldUserById(db, sameEmail.id))) {
        throw new FieldUserError("email_in_use", "A service account or another person already holds tokens under this email.", 409);
      }
      // A record left behind by someone removed earlier: its tokens already
      // fail (no PostgreSQL row has its id). Remove it so nothing carries over.
      await users.deleteUser(sameEmail.id);
      log.warn?.(`[auth] removed stale users.json record ${sameEmail.id} before issuing tokens to Field user ${row.id}`);
    }
    await users.ensureUser({ id: row.id, email: row.email, name: row.name, role: row.role === "owner" ? "admin" : "user", kind: "human" });
    return users.findUserById(row.id);
  }

  router.get("/api/users/:id/tokens", requireAuth, requireOwner, async (req, res) => {
    const holder = await tokenHolder(req.params.id);
    if (!holder) {
      return (await findFieldUserById(db, req.params.id))
        ? res.json({ ok: true, tokens: [] })
        : res.status(404).json({ error: "user not found" });
    }
    return res.json({ ok: true, tokens: users.listUserTokens(holder.id) });
  });

  router.post("/api/users/:id/tokens", requireAuth, requireOwner, async (req, res) => {
    let holder;
    try {
      holder = await tokenHolder(req.params.id, { create: true });
    } catch (error) {
      return sendUserError(res, error);
    }
    if (!holder) return res.status(404).json({ error: "user not found" });
    const minted = await users.addToken(holder.id, req.body?.label);
    log.info?.(`[auth] owner ${req.caller.id} issued token ${minted.metadata.id} for ${holder.id}`);
    return res.status(201).json({ ok: true, token: minted.token, metadata: minted.metadata });
  });

  router.delete("/api/users/:id/tokens/:tokenId", requireAuth, requireOwner, async (req, res) => {
    const holder = await tokenHolder(req.params.id);
    if (!holder || !(await users.revokeToken(holder.id, req.params.tokenId))) {
      return res.status(404).json({ error: "token not found" });
    }
    log.info?.(`[auth] owner ${req.caller.id} revoked token ${req.params.tokenId} for ${holder.id}`);
    return res.json({ ok: true });
  });

  return router;
}
