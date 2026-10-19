// A republish starts the new copy while the old copy still holds the storage
// lock. The new copy must answer GET / (the host's health check) while it
// waits, then take over when the old copy stops (server/standby-server.js).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { startTestPostgres } from "../db-runtime/test-postgres.js";

const ROOT = resolve(import.meta.dirname, "../..");
const pg = await startTestPostgres();
after(() => pg?.stop());
const needsPostgres = pg ? {} : { skip: "set FIELD_DB_TEST_DATABASE_URL or FIELD_DB_TEST_DOCKER=1" };

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function startField(t, env, name) {
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...env, FIELD_PORT: String(port), FIELD_DATA: join(env.HOME, `data-${name}`) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exited = new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  });
  return { child, exited, base: `http://127.0.0.1:${port}`, log: () => output.join("") };
}

async function waitFor(field, check, label) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (field.child.exitCode !== null) throw new Error(`server exited early (${field.child.exitCode}) waiting for ${label}:\n${field.log()}`);
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}:\n${field.log()}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
}

const healthOf = async (field) => {
  const res = await fetch(`${field.base}/health`);
  return { status: res.status, body: await res.json() };
};

test("republish: the new copy answers GET / while the old one holds the lock, then takes over", needsPostgres, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "field-handover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    FIELD_CONFIG: configPath,
    FIELD_DB_URL: pg.url,
    FIELD_STORAGE: "postgres",
  };
  await writeFile(configPath, JSON.stringify({ authToken: "handover-installation-token", quoteCatalogId: "field-verification" }));
  execFileSync(process.execPath, ["scripts/quote-invoice-proof/seed.mjs", ROOT, join(dir, "data-old")], { cwd: ROOT, env, stdio: "ignore" });

  const old = await startField(t, env, "old");
  await waitFor(old, async () => (await healthOf(old)).body.storage?.lockHeld, "the old copy to hold the lock");

  const next = await startField(t, env, "new");
  const root = await waitFor(next, async () => {
    const res = await fetch(`${next.base}/`);
    return res.status === 200 ? res : null;
  }, "the new copy's standby");
  assert.equal(await root.text(), "Field is starting\n");
  const standby = await healthOf(next);
  assert.equal(standby.status, 503);
  assert.equal(standby.body.storage.state, "waiting-for-lock");
  assert.match(next.log(), /another Field process holds the storage lock; waiting for it to stop/);

  old.child.kill("SIGTERM");
  assert.equal(await old.exited, 0);

  const live = await waitFor(next, async () => {
    const health = await healthOf(next);
    return health.status === 200 && health.body.storage?.lockHeld ? health : null;
  }, "the new copy to take over");
  assert.equal(live.body.ok, true);
  assert.equal(live.body.storage.state, "ok");
  assert.equal(next.child.exitCode, null);

  next.child.kill("SIGTERM");
  assert.equal(await next.exited, 0);
});
