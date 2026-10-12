// Configuration for the R2 replica of issued document bytes (#12).
//
//   FIELD_DOCUMENT_REPLICA=r2     turns replication on. Unset: off, and Field
//                                 behaves exactly as without this module.
//   FIELD_R2_ENDPOINT             https://<account-id>.r2.cloudflarestorage.com (config)
//   FIELD_R2_BUCKET               example-documents (config)
//   FIELD_R2_ACCESS_KEY_ID        secret
//   FIELD_R2_SECRET_ACCESS_KEY    secret
//   FIELD_R2_ALLOW_WORKSPACE=1    lets a Replit workspace replicate (off by default)
//
// The bucket is meant to carry a bucket lock: anything written there cannot
// be removed until its retention ends. So on Replit only the published deployment replicates. In the
// workspace FIELD_DOCUMENT_REPLICA=r2 is ignored with one warning (a shared
// configuration value can reach the workspace, and the workspace must keep
// starting) unless FIELD_R2_ALLOW_WORKSPACE=1 says otherwise. Anywhere else,
// replication on with a missing or malformed setting stops boot.
//
// Every error names the variable and never its value, not even part of it.
import { replitPlacement } from "../runtime-config.js";

export const REPLICA_ENV = Object.freeze({
  mode: "FIELD_DOCUMENT_REPLICA",
  endpoint: "FIELD_R2_ENDPOINT",
  bucket: "FIELD_R2_BUCKET",
  accessKeyId: "FIELD_R2_ACCESS_KEY_ID",
  secretAccessKey: "FIELD_R2_SECRET_ACCESS_KEY",
  allowWorkspace: "FIELD_R2_ALLOW_WORKSPACE",
});

export class ReplicaConfigError extends Error {
  constructor(message, { variable = null } = {}) {
    super(message);
    this.name = "ReplicaConfigError";
    this.code = "FIELD_DOCUMENT_REPLICA_CONFIG";
    this.variable = variable;
  }
}

function read(env, name) {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function endpointFrom(env) {
  const name = REPLICA_ENV.endpoint;
  const raw = read(env, name);
  if (!raw) throw new ReplicaConfigError(`${name} is not set`, { variable: name });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ReplicaConfigError(`${name} is not a URL`, { variable: name });
  }
  // Plain http only to this machine (a local test server); R2 is always https.
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ReplicaConfigError(`${name} must be an https:// URL`, { variable: name });
  }
  if (url.username || url.password) {
    throw new ReplicaConfigError(`${name} must not carry credentials; use ${REPLICA_ENV.accessKeyId} and ${REPLICA_ENV.secretAccessKey}`, { variable: name });
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new ReplicaConfigError(`${name} must be the account endpoint only, with no path or query (the bucket goes in ${REPLICA_ENV.bucket})`, { variable: name });
  }
  return url.origin;
}

// R2 bucket names: 3-63 lowercase letters, digits and hyphens, starting and
// ending with a letter or digit.
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function bucketFrom(env) {
  const name = REPLICA_ENV.bucket;
  const raw = read(env, name);
  if (!raw) throw new ReplicaConfigError(`${name} is not set`, { variable: name });
  if (!BUCKET.test(raw)) {
    throw new ReplicaConfigError(`${name} is not a valid bucket name (3-63 lowercase letters, digits and hyphens)`, { variable: name });
  }
  return raw;
}

// Credentials: printable ASCII with no spaces. The value is never echoed.
const CREDENTIAL = /^[\x21-\x7e]{8,256}$/;

function credentialFrom(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) throw new ReplicaConfigError(`${name} is not set`, { variable: name });
  if (!CREDENTIAL.test(value)) {
    throw new ReplicaConfigError(`${name} is malformed (expected 8 to 256 printable characters with no spaces or line breaks)`, { variable: name });
  }
  return value;
}

/**
 * The R2 connection settings from the four FIELD_R2_* variables, or a
 * ReplicaConfigError naming the first one that is missing or malformed.
 */
export function resolveR2Connection(env = process.env) {
  return {
    endpoint: endpointFrom(env),
    bucket: bucketFrom(env),
    accessKeyId: credentialFrom(env, REPLICA_ENV.accessKeyId),
    secretAccessKey: credentialFrom(env, REPLICA_ENV.secretAccessKey),
    region: "auto",
  };
}

/**
 * Whether this process replicates issued document bytes to R2, decided once
 * at boot. Returns { enabled: false } when FIELD_DOCUMENT_REPLICA is unset;
 * { enabled: false, warning } in a Replit workspace without
 * FIELD_R2_ALLOW_WORKSPACE=1 (the replica stays off and nothing is written to
 * R2; no FIELD_R2_* value is read); otherwise { enabled: true, kind: "r2",
 * connection, placement }. Throws ReplicaConfigError (boot refuses) for an
 * unknown mode or a missing or malformed FIELD_R2_* variable.
 */
export function resolveDocumentReplicaConfig(env = process.env) {
  const mode = read(env, REPLICA_ENV.mode).toLowerCase();
  if (!mode) return { enabled: false };
  if (mode !== "r2") {
    throw new ReplicaConfigError(`${REPLICA_ENV.mode} must be "r2" or unset`, { variable: REPLICA_ENV.mode });
  }
  const placement = replitPlacement(env);
  if (placement === "workspace" && read(env, REPLICA_ENV.allowWorkspace) !== "1") {
    return {
      enabled: false,
      placement,
      warning: `${REPLICA_ENV.mode}=r2 is ignored in the Replit workspace: the R2 bucket is locked, so anything written there stays until its retention ends. The replica is off here and nothing is written to R2; it runs only in the published app (set ${REPLICA_ENV.allowWorkspace}=1 to override)`,
    };
  }
  return { enabled: true, kind: "r2", connection: resolveR2Connection(env), placement };
}
