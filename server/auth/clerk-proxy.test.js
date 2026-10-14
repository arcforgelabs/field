import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { clerkFrontendApiProxy } from "@clerk/backend/proxy";
import { createClerkFrontendApiProxy, resolveClerkProxyPath } from "./clerk-proxy.js";

// pk_live for clerk.field.example.com (base64 of "clerk.field.example.com$").
const PUBLISHABLE_KEY = `pk_live_${Buffer.from("clerk.field.example.com$").toString("base64").replace(/=+$/, "")}`;
const SECRET_KEY = "sk_live_test_only_not_a_real_key";

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function buildApp(proxy) {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/__clerk", createClerkFrontendApiProxy({
    proxyPath: "/api/__clerk",
    publishableKey: PUBLISHABLE_KEY,
    secretKey: SECRET_KEY,
    proxy,
  }));
  // A body parser after the proxy must not see proxied requests.
  app.use(express.json());
  app.post("/api/other", (req, res) => res.json({ parsed: req.body }));
  return app;
}

test("resolveClerkProxyPath takes the path of CLERK_PROXY_URL", () => {
  assert.equal(resolveClerkProxyPath(null), null);
  assert.equal(resolveClerkProxyPath(""), null);
  assert.equal(resolveClerkProxyPath("/"), null);
  assert.equal(resolveClerkProxyPath("/api/__clerk"), "/api/__clerk");
  assert.equal(resolveClerkProxyPath("/api/__clerk/"), "/api/__clerk");
  assert.equal(resolveClerkProxyPath("https://field.example.com/api/__clerk"), "/api/__clerk");
});

test("proxy forwards method, path, query and raw body, and streams the response back", async () => {
  let seen;
  const fakeProxy = async (request, options) => {
    seen = {
      url: request.url,
      method: request.method,
      body: await request.text(),
      xff: request.headers.get("x-forwarded-for"),
      contentType: request.headers.get("content-type"),
      options,
    };
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "__client=a; Path=/; HttpOnly");
    headers.append("set-cookie", "__session=b; Path=/");
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
  };
  const { server, base } = await listen(buildApp(fakeProxy));
  try {
    const res = await fetch(`${base}/api/__clerk/v1/client?_clerk_js_version=6`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "6.6.6.6, 9.9.9.9" },
      body: "a=1&b=2",
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(res.headers.getSetCookie(), ["__client=a; Path=/; HttpOnly", "__session=b; Path=/"]);
    assert.equal(seen.method, "POST");
    assert.equal(new URL(seen.url).pathname, "/api/__clerk/v1/client");
    assert.equal(new URL(seen.url).search, "?_clerk_js_version=6");
    assert.equal(seen.body, "a=1&b=2", "raw body reaches Clerk untouched");
    assert.equal(seen.contentType, "application/x-www-form-urlencoded");
    // With one trusted hop, Express's req.ip is the right-most address; the
    // client-supplied left-most one is dropped.
    assert.equal(seen.xff, "9.9.9.9");
    assert.deepEqual(seen.options, { proxyPath: "/api/__clerk", publishableKey: PUBLISHABLE_KEY, secretKey: SECRET_KEY });

    // Routes after the proxy still get their parsed bodies.
    const other = await fetch(`${base}/api/other`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
    });
    assert.deepEqual(await other.json(), { parsed: { x: 1 } });
  } finally {
    server.close();
  }
});

test("GET of clerk-js through the real SDK reaches Clerk's Frontend API with the proxy headers", async (t) => {
  const realFetch = globalThis.fetch;
  let upstream;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (URL.canParse(String(url)) && new URL(String(url)).origin === "https://frontend-api.clerk.dev") {
      upstream = { url: String(url), headers: new Headers(init.headers), method: init.method };
      return new Response("/* clerk-js */", { status: 200, headers: { "content-type": "application/javascript" } });
    }
    return realFetch(url, init);
  });
  const { server, base } = await listen(buildApp(clerkFrontendApiProxy));
  try {
    const res = await realFetch(`${base}/api/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "field.example.com" },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
    assert.equal(await res.text(), "/* clerk-js */");
    assert.equal(upstream.method, "GET");
    assert.equal(upstream.url, "https://frontend-api.clerk.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js");
    assert.equal(upstream.headers.get("clerk-secret-key"), SECRET_KEY);
    assert.match(upstream.headers.get("clerk-proxy-url"), /\/api\/__clerk$/);
  } finally {
    server.close();
  }
});

test("paths outside the proxy are not handled by it", async () => {
  let called = false;
  const { server, base } = await listen(buildApp(async () => { called = true; return new Response("x"); }));
  try {
    const res = await fetch(`${base}/api/__clerkish/x`);
    assert.equal(res.status, 404);
    assert.equal(called, false);
  } finally {
    server.close();
  }
});
