// users.json saves: one queue, and an atomic rename (#146 review). A
// background "last used" save and a revoke used to write users.json at the
// same time; a shorter file written over a longer one left a stale tail that
// no longer parsed, and Field could not boot. Synthetic users and tokens only.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import * as users from "./users.js";
import { createTestDb, queryRows } from "./db-runtime/index.js";
import { DurableStore } from "./storage/durable-store.js";
import { installDurableStore } from "./storage/durable-hooks.js";
import { setDataRoot, setWriteRecorder } from "./storage/write-recorder.js";

async function freshUsers(t, tokenCount = 6) {
  const dataDir = await mkdtemp(join(tmpdir(), "field-users-save-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await users.initUsers(dataDir);
  const holder = await users.createUser({ email: "save-race@example.test", name: "Save Race", kind: "service", role: "user" });
  const tokens = [];
  for (let index = 0; index < tokenCount; index += 1) tokens.push(await users.addToken(holder.id, `synthetic token ${index}`));
  await users.usersSaved();
  return { dataDir, holder, tokens };
}

async function readUsersFile(dataDir) {
  return JSON.parse(await readFile(join(dataDir, "users.json"), "utf8"));
}

test("a background save and a revoke at the same moment: users.json always parses and keeps the revoke (60 runs)", async (t) => {
  for (let run = 0; run < 60; run += 1) {
    const { dataDir, holder, tokens } = await freshUsers(t);
    // Every token was used, so the background save writes a longer file than the revoke.
    for (const token of tokens) users.recordTokenUse(token.token);
    const revoked = tokens[run % tokens.length].metadata.id;
    await Promise.all([users.saveTokenUse(), users.revokeToken(holder.id, revoked), users.saveTokenUse()]);
    await users.usersSaved();
    const record = (await readUsersFile(dataDir)).find((user) => user.id === holder.id);
    assert.equal(record.tokens.some((token) => token.id === revoked), false, `run ${run}: the revoke was lost`);
    assert.equal(record.tokens.length, tokens.length - 1);
    assert.ok(record.tokens.every((token) => token.lastUsedAt), `run ${run}: a last use was lost`);
    assert.deepEqual((await readdir(dataDir)).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");
    // And Field boots again from what is on disk.
    await users.initUsers(dataDir);
    assert.equal(users.listUserTokens(holder.id).some((token) => token.id === revoked), false);
  }
});

test("concurrent revokes all land, with background saves between them, and users.json parses", async (t) => {
  const { dataDir, holder, tokens } = await freshUsers(t, 24);
  for (const token of tokens) users.recordTokenUse(token.token);
  await Promise.all([
    users.saveTokenUse(),
    ...tokens.slice(0, 20).map((token) => users.revokeToken(holder.id, token.metadata.id)),
    users.saveTokenUse(),
  ]);
  await users.usersSaved();
  const record = (await readUsersFile(dataDir)).find((user) => user.id === holder.id);
  assert.deepEqual(record.tokens.map((token) => token.label), ["synthetic token 20", "synthetic token 21", "synthetic token 22", "synthetic token 23"]);
  for (const token of tokens.slice(0, 20)) assert.equal(users.findUserByToken(token.token), null);
});

test("users.json is written with mode 0600", async (t) => {
  const { dataDir } = await freshUsers(t, 1);
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(join(dataDir, "users.json"))).mode & 0o777, 0o600);
});

test("durable storage stores only users.json after the rename, never the temporary file", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-users-durable-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const testDb = await createTestDb();
  setDataRoot(dataDir);
  const quiet = { warn() {}, error() {}, info() {}, log() {} };
  const store = new DurableStore({ dataDir, db: testDb.db, logger: quiet, reconcileIntervalMs: 0 });
  await store.start();
  installDurableStore(store);
  t.after(async () => {
    installDurableStore(null);
    await store.close({ flush: false }).catch(() => {});
    setWriteRecorder(null);
    setDataRoot(null);
    await testDb.close();
  });

  await users.initUsers(dataDir);
  const holder = await users.createUser({ email: "durable@example.test", name: "Durable Holder", kind: "service", role: "user" });
  const first = await users.addToken(holder.id, "first");
  const second = await users.addToken(holder.id, "second");
  users.recordTokenUse(first.token);
  await Promise.all([users.saveTokenUse(), users.revokeToken(holder.id, second.metadata.id)]);
  await users.usersSaved();

  const rows = await queryRows(sql`select f.path, b.bytes from field_files f join field_blobs b on b.sha256 = f.sha256 order by f.path`, testDb.db);
  assert.deepEqual(rows.map((row) => row.path), ["users.json"], "only the final file is stored");
  const onDisk = await readFile(join(dataDir, "users.json"));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest(Buffer.from(rows[0].bytes)), digest(onDisk), "the stored users.json is the file on disk");
  const record = JSON.parse(onDisk.toString("utf8")).find((user) => user.id === holder.id);
  assert.deepEqual(record.tokens.map((token) => token.label), ["first"]);
  assert.ok(record.tokens[0].lastUsedAt);
});
