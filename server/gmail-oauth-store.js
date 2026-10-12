import { existsSync, readFileSync } from "./storage/fs.js";
import { chmod, mkdir, rename, rm, writeFile } from "./storage/fs-promises.js";
import { flushDurableStorageQuietly } from "./storage/durable-hooks.js";
import { dirname, join } from "node:path";

/**
 * Per-user Gmail OAuth refresh tokens granted through /api/auth/gmail.
 *
 * They live in the data directory, not config.json: on Replit there is no
 * config file to rewrite, and only the data directory is durable. Tokens
 * already in config (`googleOAuth.users`) still work; a stored token for the
 * same user takes precedence.
 */
export const GMAIL_OAUTH_USERS_FILE = "gmail-oauth-users.json";

export function gmailOAuthUsersPath(dataDir) {
  return join(dataDir, GMAIL_OAUTH_USERS_FILE);
}

export function readStoredGmailOAuthUsers(dataDir) {
  const path = gmailOAuthUsersPath(dataDir);
  if (!existsSync(path)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code) throw error;
    // The parser's message can quote token text, so it is not passed on.
    throw new Error(`${GMAIL_OAUTH_USERS_FILE} is not valid JSON`);
  }
  const users = parsed?.users;
  return users && typeof users === "object" && !Array.isArray(users) ? users : {};
}

/**
 * Overlay stored users onto `config.googleOAuth.users` in memory. Leaves the
 * config untouched when nothing is stored.
 */
export function applyStoredGmailOAuthUsers(config, dataDir) {
  const stored = readStoredGmailOAuthUsers(dataDir);
  if (Object.keys(stored).length === 0) return config;
  if (!config.googleOAuth) config.googleOAuth = {};
  config.googleOAuth.users = { ...(config.googleOAuth.users || {}), ...stored };
  return config;
}

/**
 * Record a user's refresh token (keeping the previous one when Google did not
 * return a new one) and return the stored entry. Written atomically, mode 0600.
 */
export async function saveGmailOAuthUser(dataDir, consentEmail, {
  refreshToken,
  fallbackRefreshToken,
  now = new Date(),
} = {}) {
  const path = gmailOAuthUsersPath(dataDir);
  const users = readStoredGmailOAuthUsers(dataDir);
  const entry = {
    refreshToken: refreshToken || users[consentEmail]?.refreshToken || fallbackRefreshToken,
    consentEmail,
    updatedAt: now.toISOString(),
  };
  users[consentEmail] = entry;

  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ users }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await chmod(path, 0o600);
  await flushDurableStorageQuietly({ reason: "gmail oauth token" });
  return entry;
}
