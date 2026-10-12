import assert from "node:assert/strict";
import test from "node:test";

import { resolveDatabaseTestMode } from "./data-layer-mode.js";

test("data-layer test mode defaults to no database", () => {
  assert.deepEqual(resolveDatabaseTestMode(), { kind: "none", databaseUrl: "" });
});

test("a supplied URL selects URL-only mode without changing the URL", () => {
  assert.deepEqual(
    resolveDatabaseTestMode({
      databaseUrl: "  postgres://postgres@127.0.0.1:5432/field_db_test  ",
    }),
    { kind: "url", databaseUrl: "postgres://postgres@127.0.0.1:5432/field_db_test" },
  );
});

test("the Docker flag selects Docker-only mode without consulting a URL", () => {
  assert.deepEqual(
    resolveDatabaseTestMode({ dockerRequested: true }),
    { kind: "docker", databaseUrl: "" },
  );
  assert.deepEqual(
    resolveDatabaseTestMode({ dockerRequested: "1" }),
    { kind: "docker", databaseUrl: "" },
  );
});

test("URL plus Docker is rejected before either connection mode can start", () => {
  assert.throws(
    () =>
      resolveDatabaseTestMode({
        databaseUrl: "postgres://postgres@127.0.0.1:5432/field_db_test",
        dockerRequested: true,
      }),
    /cannot be used together/,
  );
});
