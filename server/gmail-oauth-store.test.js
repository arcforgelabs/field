import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyStoredGmailOAuthUsers,
  gmailOAuthUsersPath,
  readStoredGmailOAuthUsers,
  saveGmailOAuthUser,
} from "./gmail-oauth-store.js";

async function withDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "field-gmail-oauth-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveGmailOAuthUser writes a 0600 file in the data directory", async () => {
  await withDataDir(async (dataDir) => {
    const now = new Date("2026-10-10T00:00:00.000Z");
    const entry = await saveGmailOAuthUser(dataDir, "operator@example.com", { refreshToken: "token-1", now });
    assert.deepEqual(entry, { refreshToken: "token-1", consentEmail: "operator@example.com", updatedAt: now.toISOString() });

    const path = gmailOAuthUsersPath(dataDir);
    assert.equal(path, join(dataDir, "gmail-oauth-users.json"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { users: { "operator@example.com": entry } });
  });
});

test("saveGmailOAuthUser keeps the previous token when Google returns none", async () => {
  await withDataDir(async (dataDir) => {
    await saveGmailOAuthUser(dataDir, "operator@example.com", { refreshToken: "stored-token" });
    await saveGmailOAuthUser(dataDir, "sam@example.com", { refreshToken: undefined, fallbackRefreshToken: "config-token" });
    const again = await saveGmailOAuthUser(dataDir, "operator@example.com", { refreshToken: undefined, fallbackRefreshToken: "config-token" });

    assert.equal(again.refreshToken, "stored-token");
    const users = readStoredGmailOAuthUsers(dataDir);
    assert.equal(users["sam@example.com"].refreshToken, "config-token");
    assert.equal(users["operator@example.com"].refreshToken, "stored-token");
  });
});

test("applyStoredGmailOAuthUsers overlays stored tokens and leaves config tokens otherwise", async () => {
  await withDataDir(async (dataDir) => {
    const untouched = { googleOAuth: { clientId: "id" } };
    applyStoredGmailOAuthUsers(untouched, dataDir);
    assert.deepEqual(untouched, { googleOAuth: { clientId: "id" } });

    await saveGmailOAuthUser(dataDir, "operator@example.com", { refreshToken: "new-token" });
    const config = {
      googleOAuth: {
        clientId: "id",
        users: {
          "operator@example.com": { refreshToken: "old-token", consentEmail: "operator@example.com" },
          "sam@example.com": { refreshToken: "sam-token", consentEmail: "sam@example.com" },
        },
      },
    };
    applyStoredGmailOAuthUsers(config, dataDir);
    assert.equal(config.googleOAuth.clientId, "id");
    assert.equal(config.googleOAuth.users["operator@example.com"].refreshToken, "new-token");
    assert.equal(config.googleOAuth.users["sam@example.com"].refreshToken, "sam-token");

    const empty = {};
    applyStoredGmailOAuthUsers(empty, dataDir);
    assert.equal(empty.googleOAuth.users["operator@example.com"].refreshToken, "new-token");
  });
});

test("a corrupt token file errors without quoting its contents", async () => {
  await withDataDir(async (dataDir) => {
    await writeFile(gmailOAuthUsersPath(dataDir), '{"users": {"a": "do-not-log-token"');
    assert.throws(() => readStoredGmailOAuthUsers(dataDir), (err) => {
      assert.match(err.message, /gmail-oauth-users\.json is not valid JSON/);
      assert.ok(!err.message.includes("do-not-log-token"));
      return true;
    });
  });
});
