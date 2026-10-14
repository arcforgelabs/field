import { createHash, randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual, webcrypto } from "node:crypto";
import { promisify } from "node:util";
import { existsSync } from "./storage/fs.js";
import { readFile, writeFile, mkdir, rename, rm } from "./storage/fs-promises.js";
import { flushDurableStorageQuietly } from "./storage/durable-hooks.js";
import { join, dirname } from "node:path";

/**
 * File-based user store.
 *
 * Shape in {dataDir}/users.json:
 *   {
 *     id, email, name,
 *     kind: "human" | "service",
 *     role: "admin" | "user",
 *     passwordHash?,        // humans only: "scrypt$N$r$p$salt$hash" (see hashPassword)
 *     tokens: [{ id, hash, label, createdAt, lastUsedAt? }],
 *     settings: {}, permissions: [],
 *     createdAt, updatedAt?
 *   }
 */

let _users = null;
let _usersPath = null;

// No implicit accounts: an installation names its bootstrap users in config
// (`bootstrapUsers`), so no placeholder admin is ever created.
const DEFAULT_BOOTSTRAP_USERS = [];

const VALID_ROLES = new Set(["admin", "user"]);
const VALID_KINDS = new Set(["human", "service"]);
const TOKEN_PREFIX = "field_";

// Tokens are 256 random bits (mintTokenString), so a fast hash is enough to
// keep them out of users.json: there is nothing to guess.
function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

// Passwords are chosen by people, so they get a slow, salted, memory-hard
// hash: scrypt with OWASP's N=2^15, r=8, p=3 (32 MiB, about 0.1 s).
// Stored as "scrypt$N$r$p$<salt>$<hash>" (base64url), so the cost can rise
// later without breaking older hashes.
const scrypt = promisify(scryptCallback);
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 3 };
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const LEGACY_SHA256_HASH = /^[0-9a-f]{64}$/;

// Salts come from Web Crypto, not randomBytes: the verification runtime makes
// randomBytes deterministic, and a salt drawn from it would shift every id
// after it (scripts/verification/deterministic-preload.cjs).
function newSalt() {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)));
}

async function scryptHash(prefix, secret, { N, r, p } = SCRYPT_PARAMS, salt = newSalt()) {
  const key = await scrypt(String(secret), salt, SCRYPT_KEY_LENGTH, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return [prefix, N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function hashPassword(password) {
  return await scryptHash("scrypt", password);
}

// Before scrypt, a password was stored as its bare SHA-256 hex. initUsers
// wraps each such hash in scrypt at once ("scrypt-sha256$..."), so no fast
// hash stays on disk; the next successful sign-in replaces it with a plain
// scrypt hash of the password (see authenticateUser).
async function verifyPasswordHash(stored, password) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || (parts[0] !== "scrypt" && parts[0] !== "scrypt-sha256")) return false;
  const [prefix, N, r, p, salt, expected] = parts;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (!Object.values(params).every((n) => Number.isSafeInteger(n) && n > 0)) return false;
  const input = prefix === "scrypt" ? password : legacySha256(password);
  const actual = (await scryptHash(prefix, input, params, Buffer.from(salt, "base64url"))).split("$")[5];
  const a = Buffer.from(actual, "base64url");
  const b = Buffer.from(expected, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

function legacySha256(password) {
  return createHash("sha256").update(String(password)).digest("hex");
}

let unknownAccountHashPromise = null;
function unknownAccountHash() {
  unknownAccountHashPromise ??= hashPassword(newSalt().toString("hex"));
  return unknownAccountHashPromise;
}

function needsRehash(stored) {
  const [prefix, N, r, p] = String(stored || "").split("$");
  return prefix !== "scrypt"
    || Number(N) !== SCRYPT_PARAMS.N || Number(r) !== SCRYPT_PARAMS.r || Number(p) !== SCRYPT_PARAMS.p;
}

function normaliseRole(role) {
  if (typeof role !== "string") return "admin";
  const lower = role.trim().toLowerCase();
  return VALID_ROLES.has(lower) ? lower : "admin";
}

function normaliseKind(kind) {
  if (typeof kind !== "string") return "human";
  const lower = kind.trim().toLowerCase();
  return VALID_KINDS.has(lower) ? lower : "human";
}

function publicShape(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    kind: u.kind || "human",
    role: u.role || "admin",
    settings: u.settings || {},
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
  };
}

// What may leave this module about a token: never its value or its hash.
function tokenMetadata(t) {
  return { id: t.id, label: t.label || null, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null };
}

// "Last used" is recorded at most once a minute per token, and written to
// users.json in the background, so a busy CLI does not rewrite the file on
// every request.
const TOKEN_USE_RESOLUTION_MS = 60 * 1000;
let _usePersistTimer = null;

function mintTokenString() {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export async function initUsers(dataDir) {
  _usersPath = join(dataDir, "users.json");
  await mkdir(dirname(_usersPath), { recursive: true });
  if (existsSync(_usersPath)) {
    _users = JSON.parse(await readFile(_usersPath, "utf8"));
  } else {
    _users = [];
    await persist();
  }
  let migrated = false;
  for (const u of _users) {
    if (!u.role) { u.role = "admin"; migrated = true; }
    if (!u.kind) { u.kind = "human"; migrated = true; }
    if (!u.settings) { u.settings = {}; migrated = true; }
    if (!Array.isArray(u.permissions)) { u.permissions = []; migrated = true; }
    if (!Array.isArray(u.tokens)) { u.tokens = []; migrated = true; }
    if (typeof u.passwordHash === "string" && LEGACY_SHA256_HASH.test(u.passwordHash)) {
      u.passwordHash = await scryptHash("scrypt-sha256", u.passwordHash);
      migrated = true;
    }
  }
  if (migrated) await persist();
  return _users;
}

// Every save goes through one queue, and each writes the whole current state
// to a temporary file in the same directory, then renames it over users.json.
// Two saves never interleave (a shorter file written over a longer one used
// to leave a stale tail that no longer parsed), and a crash mid-write leaves
// the previous file whole. The temporary name ends in .tmp, which durable
// storage never mirrors; it records the rename, so only users.json is stored.
let _persistQueue = Promise.resolve();
// Saves run one at a time, so a counter names each temporary file uniquely.
// No randomUUID(): a token-use save runs on a timer, and a draw from it would
// shift every later id the verification runtime makes deterministic.
let _persistSequence = 0;

function persist() {
  if (!_usersPath) return Promise.reject(new Error("users not initialized"));
  const run = async () => {
    const path = _usersPath;
    const temporary = `${path}.${process.pid}.${(_persistSequence += 1)}.tmp`;
    // The state as it is when this save runs, so a queued save never writes
    // anything older than the one before it.
    await writeFile(temporary, JSON.stringify(_users, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await flushDurableStorageQuietly({ reason: "users" });
  };
  const saved = _persistQueue.then(run, run);
  _persistQueue = saved.catch(() => {});
  return saved;
}

/** Resolves once every save queued so far has finished (tests, shutdown). */
export function usersSaved() {
  return _persistQueue;
}

// `id` is honoured only when the email is new: Clerk sign-in creates a
// person's token-holding record under their PostgreSQL user id, so tokens stay
// bound to that id.
export async function ensureUser({ id, email, password, name, role, kind }) {
  if (!_users) throw new Error("users not initialized");
  const normalisedEmail = String(email).trim().toLowerCase();
  const existing = _users.find((u) => u.email === normalisedEmail);
  if (existing) {
    let changed = false;
    if (name && existing.name !== name) { existing.name = name; changed = true; }
    if (password && (needsRehash(existing.passwordHash) || !(await verifyPasswordHash(existing.passwordHash, password)))) {
      existing.passwordHash = await hashPassword(password);
      changed = true;
    }
    if (role && normaliseRole(role) !== existing.role) {
      existing.role = normaliseRole(role); changed = true;
    }
    if (kind && normaliseKind(kind) !== existing.kind) {
      existing.kind = normaliseKind(kind); changed = true;
    }
    if (changed) {
      existing.updatedAt = new Date().toISOString();
      await persist();
    }
    return existing;
  }

  const resolvedKind = normaliseKind(kind);
  const requestedId = typeof id === "string" && id.trim() ? id.trim() : null;
  if (requestedId && _users.some((u) => u.id === requestedId)) {
    const err = new Error("user with that id already exists");
    err.code = "EEXISTS";
    throw err;
  }
  const user = {
    id: requestedId || randomUUID(),
    email: normalisedEmail,
    name: name || normalisedEmail.split("@")[0],
    kind: resolvedKind,
    role: normaliseRole(role),
    settings: {},
    permissions: [],
    tokens: [],
    createdAt: new Date().toISOString(),
  };
  if (resolvedKind === "human" && password) {
    user.passwordHash = await hashPassword(password);
  }
  _users.push(user);
  await persist();
  return user;
}

export async function createUser({ email, password, name, role, kind, settings, permissions }) {
  if (!_users) throw new Error("users not initialized");
  if (!email) throw new Error("email required");
  const resolvedKind = normaliseKind(kind);
  if (resolvedKind === "human" && !password) {
    throw new Error("password required for human accounts");
  }
  const normalisedEmail = String(email).trim().toLowerCase();
  if (_users.some((u) => u.email === normalisedEmail)) {
    const err = new Error("user with that email already exists");
    err.code = "EEXISTS";
    throw err;
  }
  const user = {
    id: randomUUID(),
    email: normalisedEmail,
    name: (name && String(name).trim()) || normalisedEmail.split("@")[0],
    kind: resolvedKind,
    role: normaliseRole(role),
    settings: settings && typeof settings === "object" ? settings : {},
    permissions: Array.isArray(permissions) ? permissions : [],
    tokens: [],
    createdAt: new Date().toISOString(),
  };
  if (resolvedKind === "human") {
    user.passwordHash = await hashPassword(password);
  }
  _users.push(user);
  await persist();
  return publicShape(user);
}

export async function updateUser(id, patch) {
  if (!_users) throw new Error("users not initialized");
  const user = _users.find((u) => u.id === id);
  if (!user) return null;
  if (patch.name !== undefined) user.name = String(patch.name).trim() || user.name;
  if (patch.role !== undefined) user.role = normaliseRole(patch.role);
  if (patch.kind !== undefined) user.kind = normaliseKind(patch.kind);
  if (patch.settings !== undefined && patch.settings && typeof patch.settings === "object") {
    user.settings = patch.settings;
  }
  if (patch.permissions !== undefined && Array.isArray(patch.permissions)) {
    user.permissions = patch.permissions;
  }
  user.updatedAt = new Date().toISOString();
  await persist();
  return publicShape(user);
}

export async function updatePassword(id, password) {
  if (!_users) throw new Error("users not initialized");
  if (!password) throw new Error("password required");
  const user = _users.find((u) => u.id === id);
  if (!user) return null;
  if (user.kind === "service") {
    throw new Error("service accounts cannot have a password — use tokens");
  }
  user.passwordHash = await hashPassword(password);
  user.updatedAt = new Date().toISOString();
  await persist();
  return publicShape(user);
}

export async function deleteUser(id) {
  if (!_users) throw new Error("users not initialized");
  const idx = _users.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  _users.splice(idx, 1);
  await persist();
  return true;
}

/** Mint a new token for the user. Returns { token (plaintext, shown once), metadata }. */
export async function addToken(userId, label) {
  if (!_users) throw new Error("users not initialized");
  const user = _users.find((u) => u.id === userId);
  if (!user) return null;
  const plaintext = mintTokenString();
  const record = {
    id: randomUUID(),
    hash: hashToken(plaintext),
    label: label ? String(label).trim() || null : null,
    createdAt: new Date().toISOString(),
  };
  if (!Array.isArray(user.tokens)) user.tokens = [];
  user.tokens.push(record);
  user.updatedAt = record.createdAt;
  await persist();
  return { token: plaintext, metadata: tokenMetadata(record) };
}

export async function revokeTokenByPlaintext(userId, plaintext) {
  if (!_users || !plaintext) return false;
  const user = _users.find((u) => u.id === userId);
  if (!user || !Array.isArray(user.tokens)) return false;
  const hash = hashToken(plaintext);
  const before = user.tokens.length;
  user.tokens = user.tokens.filter((t) => t.hash !== hash);
  if (user.tokens.length === before) return false;
  user.updatedAt = new Date().toISOString();
  await persist();
  return true;
}

export async function revokeToken(userId, tokenId) {
  if (!_users) throw new Error("users not initialized");
  const user = _users.find((u) => u.id === userId);
  if (!user || !Array.isArray(user.tokens)) return false;
  const before = user.tokens.length;
  user.tokens = user.tokens.filter((t) => t.id !== tokenId);
  if (user.tokens.length === before) return false;
  user.updatedAt = new Date().toISOString();
  await persist();
  return true;
}

/** Revoke every token the user holds. Returns how many were revoked. */
export async function revokeAllTokens(userId) {
  if (!_users) throw new Error("users not initialized");
  const user = _users.find((u) => u.id === userId);
  if (!user || !Array.isArray(user.tokens) || user.tokens.length === 0) return 0;
  const count = user.tokens.length;
  user.tokens = [];
  user.updatedAt = new Date().toISOString();
  await persist();
  return count;
}

export function listUserTokens(userId) {
  if (!_users) return [];
  const user = _users.find((u) => u.id === userId);
  if (!user || !Array.isArray(user.tokens)) return [];
  return user.tokens.map(tokenMetadata);
}

/**
 * Note that a token was just used (after it authenticated a request). Cheap:
 * it updates memory at most once a minute per token and persists later.
 */
export function recordTokenUse(plaintext, { now = Date.now } = {}) {
  if (!_users || !plaintext) return;
  const hash = hashToken(plaintext);
  for (const u of _users) {
    const token = Array.isArray(u.tokens) ? u.tokens.find((t) => t.hash === hash) : null;
    if (!token) continue;
    const at = now();
    const last = token.lastUsedAt ? Date.parse(token.lastUsedAt) : 0;
    if (Number.isFinite(last) && at - last < TOKEN_USE_RESOLUTION_MS) return;
    token.lastUsedAt = new Date(at).toISOString();
    // One pending background save serves every touch until it runs.
    if (!_usePersistTimer) {
      _usePersistTimer = setTimeout(saveTokenUse, 1000);
      _usePersistTimer.unref?.();
    }
    return;
  }
}

/**
 * The background save of "last used" times, run now. It goes through the
 * same queue as every other save. Exported for tests.
 */
export function saveTokenUse() {
  if (_usePersistTimer) clearTimeout(_usePersistTimer);
  _usePersistTimer = null;
  if (!_usersPath) return Promise.resolve();
  return persist().catch((error) => console.warn(`[users] could not record token use: ${error.message}`));
}

/**
 * Which of a user's tokens a plaintext is, by id, without revealing anything
 * else: so a list can mark the token the current request came in with.
 */
export function tokenIdForPlaintext(userId, plaintext) {
  if (!_users || !plaintext) return null;
  const user = _users.find((u) => u.id === userId);
  if (!user || !Array.isArray(user.tokens)) return null;
  const hash = hashToken(plaintext);
  return user.tokens.find((t) => t.hash === hash)?.id ?? null;
}

/** Resolve a user by a plaintext token. Returns publicShape or null. */
export function findUserByToken(plaintext) {
  if (!_users || !plaintext) return null;
  const hash = hashToken(plaintext);
  for (const u of _users) {
    if (Array.isArray(u.tokens) && u.tokens.some((t) => t.hash === hash)) {
      return publicShape(u);
    }
  }
  return null;
}

export function resolveBootstrapUsers({ config = {}, authToken }) {
  const configuredUsers = Array.isArray(config.bootstrapUsers) && config.bootstrapUsers.length > 0
    ? config.bootstrapUsers
    : DEFAULT_BOOTSTRAP_USERS;

  const normalizedUsers = new Map();
  for (const rawUser of configuredUsers) {
    const email = String(rawUser?.email || "").trim().toLowerCase();
    const kind = normaliseKind(rawUser?.kind);
    const password = rawUser?.password ?? (kind === "human" ? authToken : undefined);
    const name = String(rawUser?.name || email.split("@")[0] || "").trim();
    const role = rawUser?.role;

    if (!email) throw new Error("bootstrap user email required");
    if (kind === "human" && !password) {
      throw new Error(`bootstrap user password required for ${email}`);
    }

    normalizedUsers.set(email, {
      email,
      name: name || email.split("@")[0],
      password,
      role: normaliseRole(role),
      kind,
    });
  }

  return Array.from(normalizedUsers.values());
}

/** Password-based login for human accounts. Resolves to publicShape or null. */
export async function authenticateUser(email, password) {
  if (!_users) return null;
  const normalisedEmail = String(email).trim().toLowerCase();
  const user = _users.find((u) => u.email === normalisedEmail);
  if (!password) return null;
  if (!user || user.kind !== "human" || !user.passwordHash) {
    // As slow as a real check, so the answer's timing does not tell which
    // emails have an account.
    await verifyPasswordHash(await unknownAccountHash(), password);
    return null;
  }
  const stored = user.passwordHash;
  if (!(await verifyPasswordHash(stored, password))) return null;
  // Upgrade an older hash now that the password is known. Skipped if the
  // hash changed meanwhile (a concurrent password change wins).
  if (needsRehash(stored)) {
    const upgraded = await hashPassword(password);
    if (user.passwordHash === stored) {
      user.passwordHash = upgraded;
      await persist();
    }
  }
  return publicShape(user);
}

/** Internal helper — returns the raw user record by id (for token minting). */
export function _getRawUser(id) {
  if (!_users) return null;
  return _users.find((u) => u.id === id) || null;
}

export function findUserByEmail(email) {
  if (!_users) return null;
  const normalisedEmail = String(email).trim().toLowerCase();
  const user = _users.find((u) => u.email === normalisedEmail);
  return user ? publicShape(user) : null;
}

export function findUserById(id) {
  if (!_users) return null;
  const user = _users.find((u) => u.id === id);
  return user ? publicShape(user) : null;
}

export function listUsers() {
  if (!_users) return [];
  return _users.map(publicShape);
}
