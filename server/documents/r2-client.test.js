// The R2 client (#240) against a recorded fake: what it signs and sends, how
// it reads answers, and that errors carry codes, never credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { R2Error, createR2ObjectStore, objectKeyFor } from "./r2-client.js";

const ORG = "org_01M4NF6NV3HW3CCZB7NVB9B157";
const SECRET = "Zq9xW4vT7kP2mN8bR5yH3jL6dF1gC0aa"; // gitleaks:allow (synthetic test credential)
const ACCESS = "AKIDQ7ZX93M2N8P4K6W1JHV5"; // gitleaks:allow (synthetic test credential)
const bytes = Buffer.from("%PDF-1.4\nclient\n%%EOF\n");
const sha = createHash("sha256").update(bytes).digest("hex");
const key = objectKeyFor(ORG, sha);

function fake(handler) {
  const requests = [];
  const fetchImpl = async (request) => {
    const body = request.method === "PUT" ? Buffer.from(await request.arrayBuffer()) : null;
    const entry = { method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body };
    requests.push(entry);
    return handler(entry, requests.length);
  };
  return { requests, fetchImpl };
}

function store(fetchImpl, extra = {}) {
  return createR2ObjectStore({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "example-documents",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    fetchImpl,
    now: () => Date.parse("2026-10-12T00:00:00Z"),
    ...extra,
  });
}

test("object keys are <org_uid>/<sha256> and nothing else", () => {
  assert.equal(key, `${ORG}/${sha}`);
  assert.throws(() => objectKeyFor(ORG, "../etc"), TypeError);
  assert.throws(() => objectKeyFor("org/../x", sha), TypeError);
});

test("putIfAbsent: path-style URL, region auto, signed payload hash, Content-MD5, metadata, If-None-Match", async () => {
  const { requests, fetchImpl } = fake(() => new Response(null, { status: 200 }));
  assert.deepEqual(await store(fetchImpl).putIfAbsent(key, bytes, { sha256: sha }), { created: true });
  const [put] = requests;
  assert.equal(put.method, "PUT");
  assert.equal(put.url, `https://acct.r2.cloudflarestorage.com/example-documents/${key}`);
  assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDQ7ZX93M2N8P4K6W1JHV5\/20261012\/auto\/s3\/aws4_request, SignedHeaders=[^,]*if-none-match[^,]*x-amz-meta-sha256/);
  assert.ok(!put.headers.authorization.includes(SECRET));
  assert.equal(put.headers["if-none-match"], "*");
  assert.equal(put.headers["x-amz-content-sha256"], sha);
  assert.equal(put.headers["x-amz-meta-sha256"], sha);
  assert.equal(put.headers["content-md5"], createHash("md5").update(bytes).digest("base64"));
  assert.equal(put.headers["content-type"], "application/pdf");
  assert.deepEqual(put.body, bytes);
  await assert.rejects(store(fetchImpl).putIfAbsent(key, Buffer.from("other"), { sha256: sha }), TypeError);
});

test("putIfAbsent never overwrites: 412 or 409 is { created: false }", async () => {
  for (const status of [412, 409]) {
    const { fetchImpl } = fake(() => new Response("<Error><Code>PreconditionFailed</Code></Error>", { status }));
    assert.deepEqual(await store(fetchImpl).putIfAbsent(key, bytes), { created: false });
  }
});

test("head and get: 404 is null; HEAD reads size and the recorded hash", async () => {
  const { fetchImpl } = fake((request) => (request.url.endsWith(sha)
    ? new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers: { "content-length": String(bytes.length), "x-amz-meta-sha256": sha, "content-type": "application/pdf" } })
    : new Response(null, { status: 404 })));
  const s = store(fetchImpl);
  assert.deepEqual(await s.head(key), { size: bytes.length, sha256: sha, contentType: "application/pdf" });
  assert.deepEqual(await s.get(key), bytes);
  const other = objectKeyFor(ORG, "0".repeat(64));
  assert.equal(await s.head(other), null);
  assert.equal(await s.get(other), null);
});

test("checkBucket lists at most one key", async () => {
  const { requests, fetchImpl } = fake(() => new Response("<ListBucketResult/>", { status: 200 }));
  assert.deepEqual(await store(fetchImpl).checkBucket(), { ok: true });
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "https://acct.r2.cloudflarestorage.com/example-documents?list-type=2&max-keys=1");
});

test("errors are codes: S3 codes, HTTP status, unreachable, timeout; never a credential", async () => {
  const cases = [
    [() => new Response("<Error><Code>AccessDenied</Code><Message>key AKID... denied</Message></Error>", { status: 403 }), "R2_ACCESS_DENIED"],
    [() => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }), "R2_NO_SUCH_BUCKET"],
    [() => new Response("<Error><Code>Bad Code; with=junk</Code></Error>", { status: 500 }), "R2_HTTP_500"],
    [() => new Response(null, { status: 503 }), "R2_HTTP_503"],
    [() => { throw new TypeError("fetch failed"); }, "R2_UNREACHABLE"],
    [() => { throw new DOMException("timed out", "TimeoutError"); }, "R2_TIMEOUT"],
  ];
  for (const [handler, code] of cases) {
    const { fetchImpl } = fake(handler);
    await assert.rejects(store(fetchImpl).checkBucket(), (error) => {
      assert.ok(error instanceof R2Error);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(SECRET) && !error.message.includes(ACCESS), error.message);
      return true;
    });
  }
});

test("a clock more than 5 minutes off is corrected from the server's Date header, once", async () => {
  const serverDate = "Mon, 12 Oct 2026 03:00:00 GMT";
  const { requests, fetchImpl } = fake((_request, n) => (n === 1
    ? new Response(null, { status: 403, headers: { date: serverDate } })
    : new Response("<ListBucketResult/>", { status: 200, headers: { date: serverDate } })));
  const s = store(fetchImpl, { now: () => Date.parse("2026-01-15T12:00:00Z") });
  await s.checkBucket();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["x-amz-date"], "20260115T120000Z");
  assert.equal(requests[1].headers["x-amz-date"], "20261012T030000Z");
  // A 403 with a clock in step is a real refusal, not retried.
  const refused = fake(() => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403, headers: { date: serverDate } }));
  await assert.rejects(store(refused.fetchImpl, { now: () => Date.parse("2026-10-12T03:01:00Z") }).checkBucket(), { code: "R2_ACCESS_DENIED" });
  assert.equal(refused.requests.length, 1);
});

test("the client has no delete, lifecycle or retention call", () => {
  const source = readFileSync(join(import.meta.dirname, "r2-client.js"), "utf8");
  const methods = [...source.matchAll(/send\("([A-Z]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(methods)].sort(), ["GET", "HEAD", "PUT"]);
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ""), /DELETE|lifecycle|retention|\?delete|x-amz-bypass/i);
});
