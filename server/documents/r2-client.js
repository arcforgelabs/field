// A small S3 client for the R2 replica of issued document bytes (#240),
// signed with aws4fetch (SigV4, region "auto", path-style URLs).
//
// It can only do four things, and none of them removes or replaces data:
//
//   head(key)                    the object's size and recorded SHA-256, or null
//   get(key)                     the object's bytes, or null
//   putIfAbsent(key, bytes, ..)  create the object; never overwrite (If-None-Match: *)
//   checkBucket()                list at most one key: are the bucket and credentials usable?
//
// There is no delete, no lifecycle and no overwrite here, on purpose: the
// bucket is meant to carry a bucket lock.
//
// Errors are R2Error with a short code (R2_UNREACHABLE, R2_TIMEOUT,
// R2_ACCESS_DENIED, R2_HTTP_503, ...). Messages name the operation and the
// key, never the credentials or a signed header.
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";

export class R2Error extends Error {
  constructor(message, { code, status = null } = {}) {
    super(message);
    this.name = "R2Error";
    this.code = code || "R2_ERROR";
    this.status = status;
  }
}

// The organisation uid as tenancy.js accepts it (org_ + letters and digits).
const KEY = /^org_[0-9A-Za-z]{1,64}\/[0-9a-f]{64}$/;
const SKEW_LIMIT_MS = 5 * 60 * 1000;

/** The object key of a document's bytes: `<org_uid>/<sha256>`. */
export function objectKeyFor(orgUid, sha256) {
  const key = `${orgUid}/${sha256}`;
  if (!KEY.test(key)) throw new TypeError("an object key is <org_uid>/<sha256>");
  return key;
}

// AccessDenied -> R2_ACCESS_DENIED. Only letters survive, so nothing else
// from a response body reaches a log, a status page or the database.
function codeFromS3(s3Code, status) {
  const name = String(s3Code || "").match(/^[A-Za-z]{1,48}$/)?.[0];
  if (!name) return `R2_HTTP_${status}`;
  return `R2_${name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

async function errorCodeOf(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {}
  return codeFromS3(text.match(/<Code>([^<]*)<\/Code>/)?.[1], res.status);
}

function amzDate(ms) {
  return new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function createR2ObjectStore({
  endpoint,
  bucket,
  accessKeyId,
  secretAccessKey,
  region = "auto",
  fetchImpl = (request, init) => fetch(request, init),
  timeoutMs = 20_000,
  now = () => Date.now(),
}) {
  if (!endpoint || !bucket) throw new TypeError("the R2 object store needs an endpoint and a bucket");
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region, retries: 0 });
  const base = `${String(endpoint).replace(/\/+$/, "")}/${bucket}`;
  // Requests are signed with the time; a clock more than 5 minutes from the
  // server's is corrected from the server's Date header, the way the AWS SDKs do.
  let clockOffsetMs = 0;

  async function send(method, path, { headers = {}, body = undefined, what }) {
    for (let attempt = 0; ; attempt += 1) {
      const signed = await aws.sign(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        aws: { datetime: amzDate(now() + clockOffsetMs) },
      });
      let res;
      try {
        res = await fetchImpl(signed, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        throw new R2Error(`R2 ${what}: ${timedOut ? `no answer within ${timeoutMs} ms` : "unreachable"}`, { code: timedOut ? "R2_TIMEOUT" : "R2_UNREACHABLE" });
      }
      if (res.status === 403 && attempt === 0) {
        const serverMs = Date.parse(res.headers.get("date") || "");
        const ours = now() + clockOffsetMs;
        if (Number.isFinite(serverMs) && Math.abs(serverMs - ours) > SKEW_LIMIT_MS) {
          clockOffsetMs = serverMs - now();
          await res.arrayBuffer().catch(() => {});
          continue;
        }
      }
      return res;
    }
  }

  async function fail(res, what) {
    const code = await errorCodeOf(res);
    return new R2Error(`R2 ${what} answered ${res.status} (${code})`, { code, status: res.status });
  }

  function checkKey(key) {
    if (!KEY.test(String(key))) throw new TypeError("an object key is <org_uid>/<sha256>");
    return `/${key}`;
  }

  return {
    kind: "r2",
    bucket,

    async head(key) {
      const what = `HEAD ${key}`;
      const res = await send("HEAD", checkKey(key), { what });
      if (res.status === 404) return null;
      if (!res.ok) throw await fail(res, what);
      return {
        size: Number(res.headers.get("content-length")),
        sha256: (res.headers.get("x-amz-meta-sha256") || "").toLowerCase() || null,
        contentType: res.headers.get("content-type") || null,
      };
    },

    async get(key) {
      const what = `GET ${key}`;
      const res = await send("GET", checkKey(key), { what });
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => {});
        return null;
      }
      if (!res.ok) throw await fail(res, what);
      return Buffer.from(await res.arrayBuffer());
    },

    /**
     * Create the object only if the key is free. Returns { created: true },
     * or { created: false } when something already holds the key (the caller
     * then compares it). The payload hash is signed, so R2 refuses bytes
     * that changed on the way; Content-MD5 is what a locked bucket asks for.
     */
    async putIfAbsent(key, bytes, { contentType = "application/pdf", sha256 } = {}) {
      const what = `PUT ${key}`;
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const digest = createHash("sha256").update(body).digest("hex");
      if (sha256 && sha256 !== digest) throw new TypeError("putIfAbsent: the bytes do not match the hash given");
      const res = await send("PUT", checkKey(key), {
        what,
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        headers: {
          "Content-Type": contentType,
          "Content-MD5": createHash("md5").update(body).digest("base64"),
          "X-Amz-Content-Sha256": digest,
          "x-amz-meta-sha256": digest,
          "If-None-Match": "*",
        },
      });
      // 412: the key exists. 409: a concurrent conditional write to it.
      if (res.status === 412 || res.status === 409) {
        await res.arrayBuffer().catch(() => {});
        return { created: false };
      }
      if (!res.ok) throw await fail(res, what);
      await res.arrayBuffer().catch(() => {});
      return { created: true };
    },

    /** Read-only: list at most one key. Throws R2Error when the bucket or the credentials do not work. */
    async checkBucket() {
      const what = "LIST (max-keys=1)";
      const res = await send("GET", "?list-type=2&max-keys=1", { what });
      if (!res.ok) throw await fail(res, what);
      await res.arrayBuffer().catch(() => {});
      return { ok: true };
    },
  };
}
