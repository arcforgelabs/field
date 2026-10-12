import { Readable } from "node:stream";

// Clerk Frontend API proxy (#149). Replit's managed Clerk publishes the app with
// CLERK_PROXY_URL (e.g. "/api/__clerk"), so the browser loads clerk-js and talks
// to Clerk through this app instead of Clerk's own host. Clerk's SDK does the
// forwarding (header rules, Clerk-Proxy-Url, redirects); this module only turns
// Express's request into a web Request and streams the Response back.
// It must be mounted before any body parser so request bodies reach Clerk intact.

// The path part of CLERK_PROXY_URL, with no trailing slash. Absolute URLs are
// accepted too; only their path is used. Empty or "/" means no proxy.
export function resolveClerkProxyPath(proxyUrl) {
  if (!proxyUrl) return null;
  let pathname;
  try {
    pathname = new URL(proxyUrl, "http://field.invalid").pathname;
  } catch {
    throw new Error("CLERK_PROXY_URL is not a valid URL or path");
  }
  const path = pathname.replace(/\/+$/, "");
  return path || null;
}

export function createClerkFrontendApiProxy({ proxyPath, publishableKey, secretKey, proxy }) {
  if (!proxyPath) throw new Error("Clerk proxy needs a path");
  if (typeof proxy !== "function") throw new Error("Clerk proxy needs the SDK proxy function");

  return async function clerkFrontendApiProxy(req, res, next) {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }
      // The client address as Express resolved it under "trust proxy", so a
      // client cannot hand Clerk a forged X-Forwarded-For.
      headers.delete("x-forwarded-for");
      if (req.ip) headers.set("x-forwarded-for", req.ip);

      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(`${req.protocol}://${req.get("host")}${req.originalUrl}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
      });

      const response = await proxy(request, { proxyPath, publishableKey, secretKey });

      res.status(response.status);
      for (const [name, value] of response.headers) {
        if (name === "set-cookie") continue;
        res.setHeader(name, value);
      }
      const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      if (cookies.length) res.setHeader("set-cookie", cookies);

      if (!response.body || req.method === "HEAD") {
        res.end();
        return;
      }
      Readable.fromWeb(response.body).on("error", next).pipe(res);
    } catch (err) {
      next(err);
    }
  };
}
