import { existsSync, readFileSync } from "./storage/fs.js";

export const FIELD_CONFIG_JSON_SOURCE = "FIELD_CONFIG_JSON";

/**
 * Load Field's runtime config.
 *
 * `FIELD_CONFIG_JSON` (a Replit Secret on Replit) holds the whole config
 * object and wins when set. Otherwise the config file at `FIELD_CONFIG` or
 * `defaultPath` is read when it exists, as before.
 *
 * Returns `{ config, source }`, where `source` is `FIELD_CONFIG_JSON` or the
 * config file path, for error messages only.
 */
export function loadFieldConfig({ env = process.env, defaultPath } = {}) {
  const inline = env.FIELD_CONFIG_JSON;
  if (inline !== undefined && String(inline).trim() !== "") {
    return { config: parseInlineConfig(inline), source: FIELD_CONFIG_JSON_SOURCE };
  }
  const path = env.FIELD_CONFIG || defaultPath;
  const config = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return { config, source: path };
}

function parseInlineConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message can quote part of the input, and this value holds
    // secrets, so it is deliberately not included.
    throw new Error("FIELD_CONFIG_JSON is set but is not valid JSON. Fix the secret value; Field will not start without it.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("FIELD_CONFIG_JSON must be a JSON object.");
  }
  return parsed;
}

/** FIELD_PORT, then the host-provided PORT (Replit), then config.port, then 19200. */
export function resolveFieldPort({ env = process.env, config = {} } = {}) {
  return Number(env.FIELD_PORT || env.PORT || config.port || 19200);
}

export function isReplitRuntime(env = process.env) {
  return String(env.FIELD_RUNTIME || "").trim().toLowerCase() === "replit";
}
