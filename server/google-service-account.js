import { createHash } from "node:crypto";
import { readFileSync } from "./storage/fs.js";

/**
 * Google service account key resolution shared by Gmail, Contacts and Drive.
 *
 * `GOOGLE_SERVICE_ACCOUNT_KEY` (env) or `googleServiceAccountKey` (config)
 * may hold either:
 *   - a path to the key JSON file (the VPS layout), or
 *   - the key JSON itself, as a string starting with `{` or as an object
 *     (hosts such as Replit deliver secrets as env values, not files).
 */
export function resolveGoogleServiceAccountKeySource(config = {}, { env = process.env } = {}) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_KEY || config?.googleServiceAccountKey;
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { kind: "inline", value: raw };
  }
  const text = String(raw).trim();
  if (!text) return null;
  if (text.startsWith("{")) return { kind: "inline", value: text };
  return { kind: "file", value: text };
}

export function hasGoogleServiceAccountKey(config = {}, options = {}) {
  return Boolean(resolveGoogleServiceAccountKeySource(config, options));
}

/**
 * Returns the parsed key ({ client_email, private_key, ... }) or null when no
 * key is configured. A missing key file throws as it always has. Invalid
 * inline JSON throws without echoing the value, so key material never reaches
 * a log line.
 */
export function loadGoogleServiceAccountCredentials(config = {}, options = {}) {
  const source = resolveGoogleServiceAccountKeySource(config, options);
  if (!source) return null;
  if (source.kind === "file") return JSON.parse(readFileSync(source.value, "utf8"));
  if (typeof source.value === "object") return source.value;
  try {
    return JSON.parse(source.value);
  } catch {
    throw new Error("Google service account key is set inline but is not valid JSON.");
  }
}

/**
 * A stable, non-secret identifier for client caches: the file path, or a
 * short hash of inline key material.
 */
export function googleServiceAccountCacheId(config = {}, options = {}) {
  const source = resolveGoogleServiceAccountKeySource(config, options);
  if (!source) return "";
  if (source.kind === "file") return source.value;
  const text = typeof source.value === "object" ? JSON.stringify(source.value) : source.value;
  return `inline:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/**
 * Options for `new google.auth.GoogleAuth(...)`: `keyFile` for a path (the
 * previous behaviour), `credentials` for inline JSON.
 */
export function googleServiceAccountAuthOptions(config = {}, options = {}) {
  const source = resolveGoogleServiceAccountKeySource(config, options);
  if (!source) return null;
  if (source.kind === "file") return { keyFile: source.value };
  return { credentials: loadGoogleServiceAccountCredentials(config, options) };
}
