// API responses are per-user and change underneath the browser (a quote is
// sent, a fix is deployed). Without a Cache-Control header a browser may
// heuristically cache some of them: a 410 or 404 is cacheable by default, so a
// PDF that failed once kept failing after the server was fixed. `no-cache`
// lets the browser keep a copy but makes it revalidate every time, so ETag /
// 304 answers (the price catalogue) still work. Routes that set their own
// Cache-Control (`no-store` on previews) override this.
export function apiCachePolicy(_req, res, next) {
  res.setHeader("Cache-Control", "private, no-cache");
  next();
}
