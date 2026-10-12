// Test fixture for durable-store.test.js (not part of the server): a process
// that stores one request's writes, starts a second request, writes half of
// it, reports the stored tree hash, then waits to be SIGKILLed mid-request.
//   node durable-store.kill-fixture.mjs <dataDir> <postgresUrl>
import { join } from "node:path";
import { mkdirSync, rmSync, setDataRoot, writeFileSync } from "./fs.js";
import { resolveDbConfig } from "../db-runtime/index.js";
import { DurableStore, openStorageSession, scanTree, treeHash } from "./durable-store.js";

const [dataDir, url] = process.argv.slice(2);
setDataRoot(dataDir);
const session = openStorageSession(resolveDbConfig({ env: { FIELD_DB_URL: url } }));
const store = new DurableStore({ dataDir, db: session.db, close: session.close, reconcileIntervalMs: 0, logger: { warn() {}, error() {} } });
await store.start();

const first = store.createContext("POST /first");
await store.runInContext(first, async () => {
  mkdirSync(join(dataDir, "2026-01-15", "job-a"), { recursive: true });
  writeFileSync(join(dataDir, "2026-01-15", "job-a", "meta.json"), JSON.stringify({ status: "draft" }));
  writeFileSync(join(dataDir, "2026-01-15", "job-a", "quote.json"), JSON.stringify({ total: 100 }));
});
store.closeContext(first);
await store.flushContext(first);
const stored = treeHash(scanTree(dataDir));

const second = store.createContext("POST /second");
await store.runInContext(second, async () => {
  writeFileSync(join(dataDir, "2026-01-15", "job-a", "meta.json"), JSON.stringify({ status: "sent" }));
  rmSync(join(dataDir, "2026-01-15", "job-a", "quote.json"));
  writeFileSync(join(dataDir, "2026-01-15", "job-a", "invoice.json"), JSON.stringify({ total: 100 }));
});
// The second request never finishes: report and wait for SIGKILL.
process.stdout.write(`${JSON.stringify({ stored, dirty: treeHash(scanTree(dataDir)) })}\n`);
setInterval(() => {}, 1_000);
