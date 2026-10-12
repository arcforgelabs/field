import test from "node:test";
import assert from "node:assert/strict";
import { resolveBootstrapUsers } from "./users.js";

test("resolveBootstrapUsers creates no accounts when config names none", () => {
  assert.deepEqual(resolveBootstrapUsers({
    config: {},
    authToken: "staging-secret",
  }), []);
});

test("resolveBootstrapUsers honors configured staging account and falls back to auth token for password", () => {
  assert.deepEqual(resolveBootstrapUsers({
    config: {
      bootstrapUsers: [
        {
          email: " Admin@Example.com ",
          name: "Sam Admin",
        },
      ],
    },
    authToken: "shared-staging-secret",
  }), [
    {
      email: "admin@example.com",
      name: "Sam Admin",
      password: "shared-staging-secret",
      role: "admin",
      kind: "human",
    },
  ]);
});

test("resolveBootstrapUsers supports multiple managed staging accounts with explicit passwords", () => {
  assert.deepEqual(resolveBootstrapUsers({
    config: {
      bootstrapUsers: [
        {
          email: "admin@example.com",
          name: "Sam Admin",
        },
        {
          email: "ark@example.com",
          name: "Robin",
          password: "custom-password",
        },
        {
          email: "ARK@EXAMPLE.COM",
          name: "Robin Duplicate",
          password: "custom-password",
        },
      ],
    },
    authToken: "shared-staging-secret",
  }), [
    {
      email: "admin@example.com",
      name: "Sam Admin",
      password: "shared-staging-secret",
      role: "admin",
      kind: "human",
    },
    {
      email: "ark@example.com",
      name: "Robin Duplicate",
      password: "custom-password",
      role: "admin",
      kind: "human",
    },
  ]);
});

test("resolveBootstrapUsers rejects malformed configured users", () => {
  assert.throws(() => resolveBootstrapUsers({
    config: {
      bootstrapUsers: [{ name: "Broken User" }],
    },
    authToken: "shared-staging-secret",
  }), /bootstrap user email required/i);
});
