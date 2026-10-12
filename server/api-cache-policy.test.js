import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { apiCachePolicy } from "./api-cache-policy.js";

test("API responses, errors included, must be revalidated; routes can override", async () => {
  const app = express();
  app.use("/api", apiCachePolicy);
  app.get("/api/gone", (_req, res) => res.status(410).json({ error: "gone" }));
  app.get("/api/preview", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });
  app.get("/asset.js", (_req, res) => res.send("x"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/gone`)).headers.get("cache-control"), "private, no-cache");
    assert.equal((await fetch(`${base}/api/preview`)).headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/asset.js`)).headers.get("cache-control"), null);
  } finally {
    server.close();
  }
});
