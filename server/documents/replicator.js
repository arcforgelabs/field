// The R2 replica of issued document bytes (#240).
//
// PostgreSQL is the store of record: document_blobs is written in the issue
// transaction as before, so issuing never waits on Cloudflare. After that
// transaction commits, this copies the bytes to a locked R2 bucket at
// `<org_uid>/<sha256>`:
//
//   - inline, best effort, right after the commit (notifyStored); and
//   - on a scheduler tick (every minute, a few blobs at a time with a pause
//     between them) that retries whatever is still pending, with backoff per
//     blob. The same ticks copy every blob stored before replication was
//     turned on (the backfill), resuming after a restart from what
//     document_blob_replicas records.
//
// Each blob goes through the same steps (replicateBlob):
//
//   1. read the bytes from PostgreSQL and check their hash;
//   2. HEAD the key. If an object is there with the same size and SHA-256
//      (its x-amz-meta-sha256, else read back and hashed), it is replicated.
//      If it holds different bytes, that is an integrity alarm: logged
//      loudly, recorded as R2_OBJECT_MISMATCH, never overwritten;
//   3. otherwise PUT with If-None-Match: * (create only; never overwrite) and
//      record it. If the key was taken in between, go back to step 2.
//
// The state of each blob is in document_blob_replicas (migration 0012). An
// R2 outage marks the replica degraded; it never stops Field serving or
// issuing. Nothing here deletes anything, in R2 or in PostgreSQL.
import { sql } from "drizzle-orm";
import { queryRows } from "../db-runtime/index.js";
import { withOrg } from "../db-runtime/tenancy.js";
import { sha256Hex } from "./blob-store.js";
import { objectKeyFor } from "./r2-client.js";

export const MISMATCH = "R2_OBJECT_MISMATCH";
const LOCAL_BYTES_INVALID = "LOCAL_BYTES_INVALID";
const SHA256 = /^[0-9a-f]{64}$/;

// Gentle by default: the first production boot backfills every existing blob,
// a few per minute with a pause between objects. Progress is in
// document_blob_replicas, so a restart resumes where it stopped.
export const REPLICATOR_DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  firstDelayMs: 30_000,
  batchSize: 5,
  paceMs: 1_000,
  backoffBaseMs: 60_000,
  backoffMaxMs: 60 * 60_000,
  // Pending longer than this marks the replica degraded even without an error.
  stuckAfterMs: 60 * 60_000,
});

/** Delay before attempt n+1 after n failed attempts: 1, 2, 4 ... minutes, at most an hour. */
export function backoffDelayMs(attempts, { backoffBaseMs = REPLICATOR_DEFAULTS.backoffBaseMs, backoffMaxMs = REPLICATOR_DEFAULTS.backoffMaxMs } = {}) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(n - 1, 30));
}

function errorCode(error) {
  const code = String(error?.code || "");
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "REPLICA_ERROR";
}

function asBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

/**
 * `db` is the server's database, `orgUid` the deployment's organisation,
 * `store` the R2 object store (r2-client.js).
 */
export function createDocumentReplicator({
  db,
  orgUid,
  store,
  now = () => new Date(),
  logger = console,
  ...options
}) {
  if (!db || !orgUid || !store) throw new Error("the document replicator needs a database, an organisation and an object store");
  const settings = { ...REPLICATOR_DEFAULTS, ...options };
  const inflight = new Map();
  let timer = null;
  let firstTimer = null;
  let ticking = null;
  let stopped = false;
  // Operations are ordered by a counter, not the clock (tests and the proof
  // freeze the clock).
  let sequence = 0;
  const state = {
    replicated: 0,
    alreadyPresent: 0,
    failures: 0,
    mismatchesFound: 0,
    lastSuccess: null,
    lastError: null,
    bootCheck: null,
    pending: null,
    oldestPendingAt: null,
    mismatches: 0,
    refreshedAt: null,
    refreshError: null,
  };

  const inOrg = (fn) => withOrg(db, orgUid, fn);

  function succeeded() {
    state.lastSuccess = { seq: (sequence += 1), at: iso(now()) };
  }

  function failed(code, sha256 = null) {
    state.lastError = { seq: (sequence += 1), at: iso(now()), code, ...(sha256 ? { sha256 } : {}) };
  }

  async function readBlob(sha256) {
    const [row] = await inOrg((tx) => queryRows(sql`
      select b.bytes, b.byte_length, b.content_type, r.r2_replicated_at, r.attempts
      from document_blobs b
      left join document_blob_replicas r on r.org_uid = b.org_uid and r.sha256 = b.sha256
      where b.sha256 = ${sha256}`, tx));
    return row || null;
  }

  async function record(sha256, { replicated, code = null }) {
    const at = now();
    const atIso = iso(at);
    if (replicated) {
      await inOrg((tx) => tx.execute(sql`
        insert into document_blob_replicas (sha256, r2_replicated_at, attempts, last_attempt_at, next_attempt_at, last_error, created_at, updated_at)
        values (${sha256}, ${atIso}::timestamptz, 1, ${atIso}::timestamptz, null, null, ${atIso}::timestamptz, ${atIso}::timestamptz)
        on conflict (org_uid, sha256) do update set
          r2_replicated_at = excluded.r2_replicated_at,
          attempts = document_blob_replicas.attempts + 1,
          last_attempt_at = excluded.last_attempt_at,
          next_attempt_at = null,
          last_error = null,
          updated_at = excluded.updated_at
        where document_blob_replicas.r2_replicated_at is null`));
      return;
    }
    const [current] = await inOrg((tx) => queryRows(sql`
      select attempts from document_blob_replicas where sha256 = ${sha256}`, tx));
    const attempts = Number(current?.attempts || 0) + 1;
    const delay = code === MISMATCH ? settings.backoffMaxMs : backoffDelayMs(attempts, settings);
    const next = iso(new Date(at.getTime() + delay));
    await inOrg((tx) => tx.execute(sql`
      insert into document_blob_replicas (sha256, r2_replicated_at, attempts, last_attempt_at, next_attempt_at, last_error, created_at, updated_at)
      values (${sha256}, null, 1, ${atIso}::timestamptz, ${next}::timestamptz, ${code}, ${atIso}::timestamptz, ${atIso}::timestamptz)
      on conflict (org_uid, sha256) do update set
        attempts = document_blob_replicas.attempts + 1,
        last_attempt_at = excluded.last_attempt_at,
        next_attempt_at = excluded.next_attempt_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
      where document_blob_replicas.r2_replicated_at is null`));
  }

  // Does the object at `key` hold exactly these bytes? true, false (different
  // bytes: the alarm), or null (nothing there).
  async function holds(key, sha256, byteLength) {
    const head = await store.head(key);
    if (!head) return null;
    if (head.sha256 === sha256 && head.size === byteLength) return true;
    // No (or a different) recorded hash: the bytes decide.
    const bytes = await store.get(key);
    if (!bytes) return null;
    return bytes.length === byteLength && sha256Hex(bytes) === sha256;
  }

  async function replicateOnce(sha256) {
    const blob = await readBlob(sha256);
    if (!blob) return { sha256, outcome: "unknown" };
    if (blob.r2_replicated_at) return { sha256, outcome: "replicated-before" };
    const bytes = asBuffer(blob.bytes);
    const byteLength = Number(blob.byte_length);
    if (sha256Hex(bytes) !== sha256 || bytes.length !== byteLength) {
      // The database's CHECK makes this impossible; never upload such bytes.
      failed(LOCAL_BYTES_INVALID, sha256);
      state.failures += 1;
      logger.error(`[documents-replica] ${sha256}: the PostgreSQL bytes do not match their hash; not replicated`);
      await record(sha256, { replicated: false, code: LOCAL_BYTES_INVALID });
      return { sha256, outcome: "failed", code: LOCAL_BYTES_INVALID };
    }
    const key = objectKeyFor(orgUid, sha256);
    try {
      let present = await holds(key, sha256, byteLength);
      let created = false;
      if (present === null) {
        ({ created } = await store.putIfAbsent(key, bytes, { contentType: blob.content_type, sha256 }));
        // Someone else created it in between: compare with what is there now.
        if (!created) present = await holds(key, sha256, byteLength);
      }
      if (created || present === true) {
        await record(sha256, { replicated: true });
        succeeded();
        if (created) state.replicated += 1;
        else state.alreadyPresent += 1;
        return { sha256, outcome: created ? "replicated" : "already-present" };
      }
      // An object holds this key with other bytes. A locked bucket would
      // refuse an overwrite anyway; this never tries one.
      failed(MISMATCH, sha256);
      state.mismatchesFound += 1;
      logger.error(`[documents-replica] INTEGRITY ALARM: R2 object ${key} exists with bytes that do not match SHA-256 ${sha256}; it is not overwritten. PostgreSQL still holds the right bytes. Investigate the bucket.`);
      await record(sha256, { replicated: false, code: MISMATCH });
      return { sha256, outcome: "mismatch", code: MISMATCH };
    } catch (error) {
      const code = errorCode(error);
      failed(code, sha256);
      state.failures += 1;
      logger.warn(`[documents-replica] ${sha256} not replicated yet (${code}); it stays in PostgreSQL and is retried with backoff`);
      try {
        await record(sha256, { replicated: false, code });
      } catch (recordError) {
        logger.warn(`[documents-replica] could not record the failed attempt: ${recordError.message}`);
      }
      return { sha256, outcome: "failed", code, error };
    }
  }

  /** Replicate one blob now (one at a time per blob). Never throws for an R2 problem. */
  function replicateBlob(sha256) {
    if (!SHA256.test(String(sha256))) return Promise.reject(new TypeError("replicateBlob needs a SHA-256"));
    if (inflight.has(sha256)) return inflight.get(sha256);
    const run = replicateOnce(sha256).finally(() => inflight.delete(sha256));
    inflight.set(sha256, run);
    return run;
  }

  async function pendingBatch() {
    const due = iso(now());
    return inOrg((tx) => queryRows(sql`
      select b.sha256
      from document_blobs b
      left join document_blob_replicas r on r.org_uid = b.org_uid and r.sha256 = b.sha256
      where r.r2_replicated_at is null
        and (r.next_attempt_at is null or r.next_attempt_at <= ${due}::timestamptz)
      order by b.created_at, b.sha256
      limit ${settings.batchSize}`, tx));
  }

  async function refreshStatus() {
    try {
      const [row] = await inOrg((tx) => queryRows(sql`
        select count(*)::int as pending,
               min(b.created_at) as oldest,
               count(*) filter (where r.last_error = ${MISMATCH})::int as mismatches
        from document_blobs b
        left join document_blob_replicas r on r.org_uid = b.org_uid and r.sha256 = b.sha256
        where r.r2_replicated_at is null`, tx));
      state.pending = Number(row?.pending || 0);
      state.oldestPendingAt = row?.oldest ? iso(row.oldest) : null;
      state.mismatches = Number(row?.mismatches || 0);
      state.refreshedAt = iso(now());
      state.refreshError = null;
    } catch (error) {
      state.refreshError = errorCode(error) === "REPLICA_ERROR" ? "STATUS_QUERY_FAILED" : errorCode(error);
    }
  }

  /**
   * One pass over what is pending and due. A failure that is about R2 itself
   * (unreachable, timeout, credentials) ends the pass, so an outage costs one
   * request per tick, not one per blob.
   */
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const results = [];
      try {
        let first = true;
        for (const { sha256 } of await pendingBatch()) {
          if (stopped) break;
          if (!first && settings.paceMs > 0) await new Promise((resolve) => setTimeout(resolve, settings.paceMs));
          first = false;
          const result = await replicateBlob(sha256);
          results.push(result);
          if (result.outcome === "failed") break;
        }
      } catch (error) {
        failed(errorCode(error));
        logger.warn(`[documents-replica] tick failed: ${error.message}`);
      }
      await refreshStatus();
      return results;
    })().finally(() => { ticking = null; });
    return ticking;
  }

  function publicState() {
    const nowMs = now().getTime();
    const oldestAgeMs = state.oldestPendingAt ? Math.max(0, nowMs - Date.parse(state.oldestPendingAt)) : 0;
    const erroring = state.lastError && (!state.lastSuccess || state.lastError.seq > state.lastSuccess.seq);
    const degraded = Boolean(erroring || state.mismatches > 0 || (state.pending > 0 && oldestAgeMs > settings.stuckAfterMs) || state.refreshError);
    return {
      state: degraded ? "degraded" : "ok",
      pending: state.pending,
      oldestPendingAgeSeconds: state.pending ? Math.round(oldestAgeMs / 1000) : 0,
      lastErrorCode: erroring ? state.lastError.code : (state.mismatches > 0 ? MISMATCH : null),
    };
  }

  return {
    enabled: true,
    kind: "r2",
    replicateBlob,
    tick,
    refreshStatus,

    /** After an issue transaction commits: copy its blobs now, best effort. Never throws. */
    notifyStored(sha256s) {
      const list = [...new Set((Array.isArray(sha256s) ? sha256s : [sha256s]).filter((sha) => SHA256.test(String(sha))))];
      if (!list.length || stopped) return Promise.resolve([]);
      return Promise.all(list.map((sha) => replicateBlob(sha).catch((error) => ({ sha256: sha, outcome: "failed", code: errorCode(error) }))))
        .then(async (results) => {
          await refreshStatus();
          return results;
        });
    },

    /** Read-only boot check: can we list the bucket with these credentials? Never throws. */
    async checkBucket() {
      try {
        await store.checkBucket();
        state.bootCheck = { ok: true, at: iso(now()) };
        succeeded();
      } catch (error) {
        const code = errorCode(error);
        state.bootCheck = { ok: false, at: iso(now()), code };
        failed(code);
      }
      return { ...state.bootCheck };
    },

    /** Start the scheduler: a first pass soon, then every intervalMs. */
    start({ firstDelayMs = settings.firstDelayMs } = {}) {
      if (timer || stopped) return;
      firstTimer = setTimeout(() => { void tick(); }, firstDelayMs);
      firstTimer.unref?.();
      timer = setInterval(() => { void tick(); }, settings.intervalMs);
      timer.unref?.();
    },

    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (firstTimer) clearTimeout(firstTimer);
      timer = null;
      firstTimer = null;
      while (ticking || inflight.size) await Promise.allSettled([ticking, ...inflight.values()]);
    },

    /** Resolves when no replication or tick is running (tests). */
    async idle() {
      while (ticking || inflight.size) {
        await Promise.allSettled([ticking, ...inflight.values()]);
      }
    },

    /** For GET /health: state, pending count, oldest pending age and the last error code. */
    publicStatus: publicState,

    /** For GET /api/storage/status (admin). Codes only, never credentials or messages. */
    status() {
      return {
        enabled: true,
        kind: "r2",
        bucket: store.bucket,
        ...publicState(),
        oldestPendingAt: state.oldestPendingAt,
        mismatches: state.mismatches,
        bootCheck: state.bootCheck ? { ...state.bootCheck } : null,
        lastSuccessAt: state.lastSuccess?.at || null,
        lastError: state.lastError ? { at: state.lastError.at, code: state.lastError.code, ...(state.lastError.sha256 ? { sha256: state.lastError.sha256 } : {}) } : null,
        counts: {
          replicated: state.replicated,
          alreadyPresent: state.alreadyPresent,
          failures: state.failures,
          mismatchesFound: state.mismatchesFound,
        },
        refreshedAt: state.refreshedAt,
        ...(state.refreshError ? { refreshError: state.refreshError } : {}),
      };
    },
  };
}

/**
 * Replication off (FIELD_DOCUMENT_REPLICA unset): everything is a no-op and
 * the state is "off". With `state: "degraded"` it stands in for a replica
 * that was asked for but cannot run (no database).
 */
export function createDisabledReplicator({ state = "off", code = null } = {}) {
  const shown = { state, ...(code ? { lastErrorCode: code } : {}) };
  return {
    enabled: false,
    kind: null,
    async replicateBlob() { return null; },
    async tick() { return []; },
    async refreshStatus() {},
    notifyStored() { return Promise.resolve([]); },
    async checkBucket() { return null; },
    start() {},
    async stop() {},
    async idle() {},
    publicStatus() { return { ...shown }; },
    status() { return { enabled: false, ...shown }; },
  };
}
