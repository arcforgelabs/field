import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { openStandbyServer } from "./standby-server.js";

const quiet = { log() {} };

test("standby: GET / is 200 for the health check; everything else is 503 until the hand-over", async () => {
  const standby = openStandbyServer({ port: 0, host: "127.0.0.1", logger: quiet });
  await once(standby.server, "listening");
  const base = `http://127.0.0.1:${standby.server.address().port}`;
  try {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal(await root.text(), "Field is starting\n");

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { ok: false, starting: true, storage: { state: "waiting-for-lock" } });

    const api = await fetch(`${base}/api/jobs`, { method: "POST" });
    assert.equal(api.status, 503);
    assert.equal(api.headers.get("retry-after"), "5");

    const app = express();
    app.get("/health", (_req, res) => res.json({ ok: true }));
    const server = standby.handOver(app);
    assert.equal(server, standby.server);
    const after = await fetch(`${base}/health`);
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), { ok: true });
  } finally {
    await standby.close();
  }
});
