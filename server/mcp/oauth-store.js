import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "../storage/fs-promises.js";
import { flushDurableStorageQuietly } from "../storage/durable-hooks.js";
import { dirname, join } from "node:path";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function secret(prefix) {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function hashesEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OAuthStore {
  constructor({
    dataDir,
    now = () => Date.now(),
    accessTtlMs = 10 * 60_000,
    codeTtlMs = 5 * 60_000,
    clientTtlMs = 365 * 24 * 60 * 60_000,
  }) {
    this.path = join(dataDir, "mcp", "as-state.json");
    this.now = now;
    this.accessTtlMs = accessTtlMs;
    this.codeTtlMs = codeTtlMs;
    this.clientTtlMs = clientTtlMs;
    this.data = { clients: [], requests: [], codes: [], tokens: [], grants: [] };
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
    this.cleanup();
  }

  async persist() {
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.data, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
    await flushDurableStorageQuietly({ reason: "mcp oauth state" });
  }

  transaction(operation) {
    const run = async () => {
      const result = await operation(this.data);
      this.cleanup();
      await this.persist();
      return result;
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  cleanup() {
    const now = this.now();
    this.data.requests = this.data.requests
      .filter((record) => record.expiresAt > now && !record.usedAt)
      .slice(-1000);
    this.data.codes = this.data.codes
      .filter((record) => record.expiresAt > now && !record.usedAt)
      .slice(-1000);
    this.data.tokens = this.data.tokens
      .filter((record) => (record.expiresAt > now || record.kind === "refresh") && !record.revokedAt)
      .slice(-2000);
    this.data.clients = this.data.clients
      .filter((record) => record.expiresAt > now)
      .slice(-500);
    this.data.grants = this.data.grants.slice(-1000);
  }

  async registerClient(metadata) {
    return this.transaction((data) => {
      const client = {
        client_id: `field_client_${randomUUID()}`,
        client_name: metadata.client_name || "OAuth client",
        redirect_uris: metadata.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        createdAt: this.now(),
        expiresAt: this.now() + this.clientTtlMs,
      };
      data.clients.push(client);
      return client;
    });
  }

  client(id) {
    return this.data.clients.find(
      (record) => record.client_id === id && record.expiresAt > this.now(),
    ) || null;
  }

  async createRequest(input) {
    return this.transaction((data) => {
      const csrf = secret("csrf_");
      const request = {
        id: randomUUID(),
        csrfHash: hash(csrf),
        ...input,
        createdAt: this.now(),
        expiresAt: this.now() + this.codeTtlMs,
      };
      data.requests.push(request);
      return { request, csrf };
    });
  }

  request(id) {
    return this.data.requests.find(
      (record) => record.id === id && !record.usedAt && record.expiresAt > this.now(),
    ) || null;
  }

  async approve({ id, csrf, subject, scope }) {
    return this.transaction((data) => {
      const request = data.requests.find(
        (record) => record.id === id && !record.usedAt && record.expiresAt > this.now(),
      );
      if (!request || !hashesEqual(request.csrfHash, hash(csrf))) return null;

      request.usedAt = this.now();
      const plaintext = secret("field_code_");
      data.codes.push({
        hash: hash(plaintext),
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        scope: scope || request.scope,
        resource: request.resource,
        subject,
        codeChallenge: request.codeChallenge,
        createdAt: this.now(),
        expiresAt: this.now() + this.codeTtlMs,
      });
      return { code: plaintext, request };
    });
  }

  async exchangeCode({ code, clientId, redirectUri, verifier }) {
    return this.transaction((data) => {
      const record = data.codes.find(
        (candidate) => hashesEqual(candidate.hash, hash(code))
          && !candidate.usedAt
          && candidate.expiresAt > this.now(),
      );
      if (!record || record.clientId !== clientId || record.redirectUri !== redirectUri) return null;

      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!hashesEqual(challenge, record.codeChallenge)) return null;
      record.usedAt = this.now();
      return this.issue(data, record);
    });
  }

  issue(data, claims) {
    const access = secret("field_at_");
    const refresh = secret("field_rt_");
    const familyId = claims.familyId || randomUUID();
    const grantId = claims.grantId || randomUUID();
    const common = {
      clientId: claims.clientId,
      subject: claims.subject,
      scope: claims.scope,
      resource: claims.resource,
      familyId,
      grantId,
      createdAt: this.now(),
    };

    data.tokens.push(
      { ...common, kind: "access", hash: hash(access), expiresAt: this.now() + this.accessTtlMs },
      { ...common, kind: "refresh", hash: hash(refresh), expiresAt: this.now() + THIRTY_DAYS_MS },
    );
    if (!claims.grantId) data.grants.push({ id: grantId, ...common });

    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(this.accessTtlMs / 1000),
      refresh_token: refresh,
      scope: claims.scope.join(" "),
    };
  }

  async refresh({ refreshToken, clientId, scope }) {
    return this.transaction((data) => {
      const record = data.tokens.find(
        (candidate) => candidate.kind === "refresh" && hashesEqual(candidate.hash, hash(refreshToken)),
      );
      if (!record || record.clientId !== clientId || record.revokedAt || record.expiresAt <= this.now()) {
        if (record?.rotatedAt) this.revokeFamily(data, record.familyId);
        return null;
      }
      if (record.rotatedAt) {
        this.revokeFamily(data, record.familyId);
        return null;
      }

      const requested = scope?.length ? scope : record.scope;
      if (requested.some((requestedScope) => !record.scope.includes(requestedScope))) return null;
      record.rotatedAt = this.now();
      return this.issue(data, { ...record, scope: requested });
    });
  }

  // The subject and scope behind a refresh token that could still be used,
  // without using it; null otherwise.
  refreshGrant(refreshToken, clientId) {
    const record = this.data.tokens.find(
      (candidate) => candidate.kind === "refresh" && hashesEqual(candidate.hash, hash(String(refreshToken || ""))),
    );
    if (!record || record.clientId !== clientId || record.revokedAt || record.rotatedAt || record.expiresAt <= this.now()) {
      return null;
    }
    return { subject: record.subject, scope: [...record.scope] };
  }

  access(token, { resource, requiredScopes = [] }) {
    const record = this.data.tokens.find(
      (candidate) => candidate.kind === "access" && hashesEqual(candidate.hash, hash(token)),
    );
    if (!record
      || record.revokedAt
      || record.expiresAt <= this.now()
      || record.resource !== resource
      || requiredScopes.some((scope) => !record.scope.includes(scope))) {
      return null;
    }
    return record;
  }

  revokeFamily(data, familyId) {
    for (const token of data.tokens) {
      if (token.familyId === familyId) token.revokedAt = this.now();
    }
    for (const grant of data.grants) {
      if (grant.familyId === familyId && !grant.revokedAt) grant.revokedAt = this.now();
    }
  }

  async revoke(token, clientId) {
    return this.transaction((data) => {
      const record = data.tokens.find(
        (candidate) => hashesEqual(candidate.hash, hash(token)) && candidate.clientId === clientId,
      );
      if (!record) return false;
      this.revokeFamily(data, record.familyId);
      return true;
    });
  }

  listInstallations({ subject, includeRevoked = false } = {}) {
    const now = this.now();
    return this.data.grants
      .filter((grant) => !subject || grant.subject === subject)
      .filter((grant) => includeRevoked || (
        !grant.revokedAt
        && this.data.tokens.some((token) => (
          token.familyId === grant.familyId
          && token.kind === "refresh"
          && !token.revokedAt
          && token.expiresAt > now
        ))
      ))
      .map((grant) => ({
        id: grant.id,
        subject: grant.subject,
        clientId: grant.clientId,
        clientName: this.client(grant.clientId)?.client_name || null,
        scopes: [...grant.scope],
        createdAt: new Date(grant.createdAt).toISOString(),
        revokedAt: grant.revokedAt ? new Date(grant.revokedAt).toISOString() : null,
      }));
  }

  // Cut a person off (removed or disabled in Field): every installation, token
  // family and not-yet-exchanged authorization code they approved. Returns the
  // number of installations revoked.
  async revokeSubjects(subjects) {
    const targets = new Set((Array.isArray(subjects) ? subjects : [subjects]).filter(Boolean).map(String));
    if (targets.size === 0) return 0;
    return this.transaction((data) => {
      let revoked = 0;
      const families = new Set();
      for (const grant of data.grants) {
        if (!targets.has(String(grant.subject))) continue;
        if (!grant.revokedAt) revoked += 1;
        families.add(grant.familyId);
      }
      for (const token of data.tokens) {
        if (targets.has(String(token.subject))) families.add(token.familyId);
      }
      for (const familyId of families) this.revokeFamily(data, familyId);
      for (const code of data.codes) {
        if (targets.has(String(code.subject)) && !code.usedAt) code.usedAt = this.now();
      }
      return revoked;
    });
  }

  async revokeInstallation({ id, subject, isAdmin = false }) {
    return this.transaction((data) => {
      const grant = data.grants.find((candidate) => candidate.id === id);
      if (!grant || (!isAdmin && grant.subject !== subject)) return false;
      this.revokeFamily(data, grant.familyId);
      return true;
    });
  }
}
