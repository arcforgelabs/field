import test from "node:test";
import assert from "node:assert/strict";
import { authorizeFieldMcpScopes } from "./scope-authority.js";

const requested = ["catalog.read", "catalog.write", "quote.read", "quote.draft"];

test("administrators may authorize every requested MCP scope", () => {
  assert.deepEqual(authorizeFieldMcpScopes({ role: "admin", permissions: [] }, requested), requested);
});

test("non-admin scope authority maps exact Field permission strings only", () => {
  const user = {
    role: "user",
    permissions: ["catalog.read", "quote.draft", "mcp:quote.read", "catalog.*"],
  };
  assert.deepEqual(authorizeFieldMcpScopes(user, requested), ["catalog.read", "quote.draft"]);
});
