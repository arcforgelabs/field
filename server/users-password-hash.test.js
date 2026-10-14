// Passwords are stored as salted scrypt, never as a fast hash. A users.json
// written before scrypt (bare SHA-256 hex) is wrapped in scrypt when Field
// boots, and the next good sign-in replaces it with scrypt of the password.
// Synthetic users and passwords only.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as users from "./users.js";

const SCRYPT_HASH = /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /\b[0-9a-f]{64}\b/;

async function dataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "field-users-password-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function stored(dir) {
  await users.usersSaved();
  return JSON.parse(await readFile(join(dir, "users.json"), "utf8"));
}

test("a new password is stored as salted scrypt and checked against it", async (t) => {
  const dir = await dataDir(t);
  await users.initUsers(dir);
  const created = await users.createUser({ email: "pat@example.test", name: "Pat", password: "correct horse battery" });
  await users.createUser({ email: "sam@example.test", name: "Sam", password: "correct horse battery" });

  const [pat, sam] = await stored(dir);
  assert.match(pat.passwordHash, SCRYPT_HASH);
  assert.notEqual(pat.passwordHash, sam.passwordHash, "each hash has its own salt");
  assert.doesNotMatch(JSON.stringify([pat, sam]), SHA256_HEX);

  assert.equal((await users.authenticateUser("PAT@example.test ", "correct horse battery"))?.id, created.id);
  assert.equal(await users.authenticateUser("pat@example.test", "correct horse batterY"), null);
  assert.equal(await users.authenticateUser("pat@example.test", ""), null);
  assert.equal(await users.authenticateUser("nobody@example.test", "correct horse battery"), null);

  await users.updatePassword(created.id, "a new passphrase");
  assert.match((await stored(dir))[0].passwordHash, SCRYPT_HASH);
  assert.equal(await users.authenticateUser("pat@example.test", "correct horse battery"), null);
  assert.equal((await users.authenticateUser("pat@example.test", "a new passphrase"))?.id, created.id);
});

test("a SHA-256 hash from before scrypt is wrapped at boot and upgraded at the next sign-in", async (t) => {
  const dir = await dataDir(t);
  const legacy = createHash("sha256").update("old passphrase").digest("hex");
  await writeFile(join(dir, "users.json"), JSON.stringify([{
    id: "legacy-user",
    email: "legacy@example.test",
    name: "Legacy",
    kind: "human",
    role: "admin",
    passwordHash: legacy,
    tokens: [],
    settings: {},
    permissions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  }]));

  await users.initUsers(dir);
  const [wrapped] = await stored(dir);
  assert.match(wrapped.passwordHash, /^scrypt-sha256\$32768\$8\$3\$/);
  assert.ok(!(await readFile(join(dir, "users.json"), "utf8")).includes(legacy), "the fast hash is gone from disk");

  assert.equal(await users.authenticateUser("legacy@example.test", "wrong"), null);
  assert.equal((await stored(dir))[0].passwordHash, wrapped.passwordHash, "a failed sign-in changes nothing");

  assert.equal((await users.authenticateUser("legacy@example.test", "old passphrase"))?.id, "legacy-user");
  const [upgraded] = await stored(dir);
  assert.match(upgraded.passwordHash, SCRYPT_HASH);
  assert.equal((await users.authenticateUser("legacy@example.test", "old passphrase"))?.id, "legacy-user");
  assert.equal((await stored(dir))[0].passwordHash, upgraded.passwordHash, "a current hash is kept");
});

test("a bootstrap user's password is rehashed only when it changes", async (t) => {
  const dir = await dataDir(t);
  await users.initUsers(dir);
  await users.ensureUser({ email: "owner@example.test", name: "Owner", password: "bootstrap passphrase", role: "admin" });
  const first = (await stored(dir))[0].passwordHash;
  assert.match(first, SCRYPT_HASH);

  await users.ensureUser({ email: "owner@example.test", name: "Owner", password: "bootstrap passphrase", role: "admin" });
  assert.equal((await stored(dir))[0].passwordHash, first, "the same password keeps its hash");

  await users.ensureUser({ email: "owner@example.test", name: "Owner", password: "rotated passphrase", role: "admin" });
  assert.notEqual((await stored(dir))[0].passwordHash, first);
  assert.ok(await users.authenticateUser("owner@example.test", "rotated passphrase"));
  assert.equal(await users.authenticateUser("owner@example.test", "bootstrap passphrase"), null);
});
