import { createHash, randomUUID, randomBytes } from "node:crypto";
import { existsSync } from "./storage/fs.js";
import { readFile, writeFile, mkdir } from "./storage/fs-promises.js";
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
 *     passwordHash?,        // humans only
 *     tokens: [{ id, hash, label, createdAt }],
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

function hashSecret(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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

function tokenMetadata(t) {
  return { id: t.id, label: t.label || null, createdAt: t.createdAt };
}

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
  }
  if (migrated) await persist();
  return _users;
}

async function persist() {
  if (!_usersPath) throw new Error("users not initialized");
  await writeFile(_usersPath, JSON.stringify(_users, null, 2), "utf8");
  await flushDurableStorageQuietly({ reason: "users" });
}

// `id` is honoured only when the email is new: Clerk sign-in (#149) creates a
// person's token-holding record under their PostgreSQL user id, so tokens stay
// bound to that id.
export async function ensureUser({ id, email, password, name, role, kind }) {
  if (!_users) throw new Error("users not initialized");
  const normalisedEmail = String(email).trim().toLowerCase();
  const existing = _users.find((u) => u.email === normalisedEmail);
  if (existing) {
    let changed = false;
    if (name && existing.name !== name) { existing.name = name; changed = true; }
    if (password && existing.passwordHash !== hashSecret(password)) {
      existing.passwordHash = hashSecret(password);
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
    user.passwordHash = hashSecret(password);
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
    user.passwordHash = hashSecret(password);
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
  user.passwordHash = hashSecret(password);
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
    hash: hashSecret(plaintext),
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
  const hash = hashSecret(plaintext);
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

/** Resolve a user by a plaintext token. Returns publicShape or null. */
export function findUserByToken(plaintext) {
  if (!_users || !plaintext) return null;
  const hash = hashSecret(plaintext);
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

/** Password-based login for human accounts. Returns publicShape or null. */
export function authenticateUser(email, password) {
  if (!_users) return null;
  const normalisedEmail = String(email).trim().toLowerCase();
  const user = _users.find((u) => u.email === normalisedEmail);
  if (!user || user.kind !== "human") return null;
  if (!user.passwordHash || user.passwordHash !== hashSecret(password)) return null;
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
