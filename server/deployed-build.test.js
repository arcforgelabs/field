// GET /health names the running build, so an operator can confirm what a
// Replit publish deployed (scripts/replit-deploy.sh).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployedBuildStatus } from "./deployed-build.js";

const ROOT = resolve(import.meta.dirname, "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("the build status is the commit, the deployed ref and its source, or null", () => {
  assert.deepEqual(deployedBuildStatus({}), { revision: null, ref: null, source: null });
  assert.deepEqual(
    deployedBuildStatus({ FIELD_REVISION: ` ${COMMIT}\n`, FIELD_DEPLOYED_REF: "main", FIELD_DEPLOYED_FROM: "github" }),
    { revision: COMMIT, ref: "main", source: "github" },
  );
  assert.deepEqual(deployedBuildStatus({ FIELD_REVISION: "  " }), { revision: null, ref: null, source: null });
});

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

test("GET /health reports the deployed commit, ref and source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "field-deployed-build-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const dataDir = join(dir, "data");
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    FIELD_CONFIG: configPath,
    FIELD_DATA: dataDir,
    FIELD_PGLITE_DIR: join(dir, "pglite"),
  };
  // Field refuses to start without a catalogue: seed the synthetic one.
  execFileSync(process.execPath, ["scripts/quote-invoice-proof/seed.mjs", ROOT, dataDir], { cwd: ROOT, env, stdio: "ignore" });
  await writeFile(configPath, JSON.stringify({ authToken: "deployed-build-installation-token", quoteCatalogId: "field-verification" }));
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      ...env,
      FIELD_PORT: String(port),
      FIELD_REVISION: COMMIT,
      FIELD_DEPLOYED_REF: "v1.2.0",
      FIELD_DEPLOYED_FROM: "github",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });

  const deadline = Date.now() + 60_000;
  let health;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) { health = await response.json(); break; }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${output.join("")}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
  assert.deepEqual(health.build, { revision: COMMIT, ref: "v1.2.0", source: "github" });
});
