import { resolve } from "node:path";

export const VERIFICATION_CONTRACT = Object.freeze({
  environmentId: "field-verification",
  hostAlias: "verification-host",
  publicUrl: "https://field-verification.example.invalid",
  runtimeWorkdir: "/opt/field-verification",
  composePath: "/opt/field-verification/compose.yaml",
  serviceName: "field-verification",
  containerName: "field-verification",
  networkName: "field_verification_ingress",
  candidateNetworkName: "field_verification_candidate",
  hostPort: 19220,
  candidateHostPort: 19221,
  containerPort: 19200,
  embeddedGatewayPort: 19201,
  memoryLimitMiB: 256,
  appUid: 10001,
  appGid: 10001,
  caddyNetworkName: "field_verification_ingress",
  caddyUpstream: "field-verification:19200",
  nativeSecretDir: "/etc/field-verification/secrets",
  dataRoot: "/srv/field-verification/data",
  backupRoot: "/srv/field-verification/backups",
  containerNativeSecretDir: "/run/field-verification-secrets",
  containerDataRoot: "/var/lib/field-verification/data",
  containerBackupRoot: "/var/lib/field-verification/backups",
  stableStateFile: "/srv/field-verification/state/stable.json",
  transactionFile: "/srv/field-verification/state/transaction.json",
  routeDirectory: "/srv/field-verification/state/route",
  routeSelector: "/srv/field-verification/state/route/selector.caddy",
  operationLock: "/srv/field-verification/state/operation.lock",
  imageRepository: "ghcr.io/<owner>/field",
  fixtureMarkerPrefix: "field-verification-fixtures-v1:",
});

export const FORBIDDEN_BOUNDARY_MARKERS = Object.freeze([
  "/opt/apps/field",
  "/opt/field/",
  "oauth",
  "serviceaccount",
  "service_account",
  "google",
  "client_secret",
  "refresh_token",
  "access_token",
  "api_key",
  "private_key",
  "smtp",
  "gmail",
  "quotes@example.com",
]);

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

export function assertDigest(value, label = "image digest") {
  const digest = String(value || "").trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`${label} must be a complete lowercase sha256 digest; mutable tags are rejected`);
  }
  return digest;
}

export function assertCommit(value, label = "commit") {
  const commit = String(value || "").trim();
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`${label} must be the complete 40-character reviewed hexadecimal commit`);
  return commit;
}

export function imageReference(digest) {
  return `${VERIFICATION_CONTRACT.imageRepository}@${assertDigest(digest)}`;
}

export function rejectForbiddenBoundary(value, label = "verification input") {
  const text = JSON.stringify(value, (_key, child) => child, 0).toLowerCase();
  const found = FORBIDDEN_BOUNDARY_MARKERS.filter((marker) => text.includes(marker));
  if (found.length) throw new Error(`${label} contains forbidden boundary value(s): ${[...new Set(found)].join(", ")}`);
}

export function assertVerificationHost(value) {
  const host = String(value || "").trim();
  if (host !== VERIFICATION_CONTRACT.hostAlias) {
    throw new Error(`verification deployment host must be ${VERIFICATION_CONTRACT.hostAlias}`);
  }
  rejectForbiddenBoundary(host, "verification host");
  return host;
}

export function assertVerificationPaths({ dataRoot, backupRoot, nativeSecretDir, allowTestRoots = false, scope = "host" } = {}) {
  const values = { dataRoot, backupRoot, nativeSecretDir };
  for (const [name, value] of Object.entries(values)) {
    if (!String(value || "").startsWith("/")) throw new Error(`${name} must be an absolute path`);
    rejectForbiddenBoundary(value, name);
  }
  const data = resolve(dataRoot);
  const backup = resolve(backupRoot);
  const secret = resolve(nativeSecretDir);
  const nested = (a, b) => a === b || a.startsWith(`${b}/`);
  if (nested(data, backup) || nested(backup, data) || nested(data, secret) || nested(secret, data) || nested(backup, secret) || nested(secret, backup)) {
    throw new Error("verification data, backup, and native secret roots must be independent");
  }
  if (!new Set(["host", "container"]).has(scope)) throw new Error("verification path scope must be host or container");
  const expected = scope === "container"
    ? {
        dataRoot: VERIFICATION_CONTRACT.containerDataRoot,
        backupRoot: VERIFICATION_CONTRACT.containerBackupRoot,
        nativeSecretDir: VERIFICATION_CONTRACT.containerNativeSecretDir,
      }
    : VERIFICATION_CONTRACT;
  if (!allowTestRoots && (
    data !== expected.dataRoot
    || backup !== expected.backupRoot
    || secret !== expected.nativeSecretDir
  )) {
    throw new Error("verification paths do not match the locked runtime contract");
  }
  return { dataRoot: data, backupRoot: backup, nativeSecretDir: secret };
}

export function assertVerificationUrl(value, { allowLocalTest = false } = {}) {
  const raw = String(value || "").trim();
  const url = new URL(raw);
  rejectForbiddenBoundary(raw, "verification endpoint");
  if (url.origin === VERIFICATION_CONTRACT.publicUrl) return raw;
  if (allowLocalTest && ["127.0.0.1", "localhost"].includes(url.hostname)) return raw;
  throw new Error("verification endpoint is outside the approved public or local test route");
}

export function assertVerificationConfig(config, { dataDir, allowTestRoots = false } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("verification config must be an object");
  rejectForbiddenBoundary(config, "verification config");
  const expectedKeys = new Set(["dataDir", "authToken", "fieldVerification", "deploymentTheme", "workerDisplayName", "quoteCatalogId", "bootstrapUsers", "syntheticCredentialProvenance"]);
  if (Object.keys(config).some((key) => !expectedKeys.has(key)) || Object.keys(config).length !== expectedKeys.size) {
    throw new Error("verification config contains unknown or missing fields");
  }
  const expectedIdentity = {
    enabled: true,
    installationId: VERIFICATION_CONTRACT.environmentId,
    publicUrl: VERIFICATION_CONTRACT.publicUrl,
    catalogId: "field-verification",
    deploymentTheme: "field-verification",
    nativeSecretLookup: "disabled",
  };
  if (!config.fieldVerification || Object.keys(config.fieldVerification).length !== Object.keys(expectedIdentity).length
    || Object.entries(expectedIdentity).some(([key, value]) => config.fieldVerification[key] !== value)) {
    throw new Error("verification config is missing the exact installation identity");
  }
  if (config.dataDir !== dataDir && !allowTestRoots) throw new Error("verification config dataDir does not match the container data root");
  if (typeof config.authToken !== "string" || !config.authToken.trim()) throw new Error("verification config must receive an independent auth token");
  if (config.deploymentTheme !== "field-verification" || config.quoteCatalogId !== "field-verification") {
    throw new Error("verification config must select the synthetic catalog and theme");
  }
  const expectedProvenance = {
    schemaVersion: 1,
    kind: "generated-synthetic-credential",
    installationId: "field-verification",
    domain: "example.invalid",
    identityEmail: "field-verification@example.invalid",
    generated: true,
  };
  if (!config.syntheticCredentialProvenance
    || Object.keys(config.syntheticCredentialProvenance).length !== Object.keys(expectedProvenance).length
    || Object.entries(expectedProvenance).some(([key, value]) => config.syntheticCredentialProvenance[key] !== value)) {
    throw new Error("verification config lacks the exact generated synthetic credential provenance");
  }
  if (typeof config.workerDisplayName !== "string" || !config.workerDisplayName.trim()) throw new Error("verification config must define a synthetic worker identity");
  if (!Array.isArray(config.bootstrapUsers) || config.bootstrapUsers.length === 0) throw new Error("verification config must define an independent test identity");
  for (const user of config.bootstrapUsers) {
    if (!user || typeof user !== "object" || Object.keys(user).some((key) => !["email", "password", "name", "role"].includes(key))) {
      throw new Error("verification bootstrap identity contains unknown fields");
    }
    if (typeof user.email !== "string" || user.email.toLowerCase() !== "field-verification@example.invalid") {
      throw new Error("verification bootstrap identity must use the dedicated synthetic identity");
    }
    if (typeof user.password !== "string" || !user.password.trim()) throw new Error("verification bootstrap identity password is required");
    if (user.role !== undefined && !["admin", "user"].includes(user.role)) throw new Error("verification bootstrap identity role is invalid");
  }
  return true;
}
