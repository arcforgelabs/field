// A query whose connection the server closed (migration 0025 terminates idle
// pooler sessions) is run once more, on another connection. A second failure
// still throws, and any other error is not retried.
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { isClosedConnectionError, pinPgliteSearchPath, retryClosedConnections } from "./index.js";

function adminShutdown() {
  return Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
}

function outcomeQuery(outcome) {
  let promise = null;
  function settle() {
    promise ??= outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    return promise;
  }
  const query = {
    values() { return query; },
    raw() { return query; },
    simple() { return query; },
    execute() { return query; },
    describe() { return query; },
    then(onFulfilled, onRejected) { return settle().then(onFulfilled, onRejected); },
    catch(onRejected) { return settle().catch(onRejected); },
    finally(onFinally) { return settle().finally(onFinally); },
  };
  return query;
}

function scriptedClient(outcomes) {
  const calls = [];
  let index = 0;
  function take(kind) {
    calls.push(kind);
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    return outcomeQuery(outcome);
  }
  function sql() {
    return take("query");
  }
  sql.unsafe = () => take("unsafe");
  sql.options = { parsers: {}, serializers: {} };
  sql.end = function end() {
    calls.push(this === sql ? "end" : "end-unbound");
    return Promise.resolve();
  };
  sql.begin = async (options, fn) => {
    calls.push("begin");
    if (typeof options === "function") fn = options;
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    if (outcome instanceof Error) throw outcome;
    return fn({ from: "begin" });
  };
  return { sql, calls };
}

test("pinPgliteSearchPath replaces search_path=public and throws when it cannot", () => {
  assert.deepEqual(
    pinPgliteSearchPath(["listen_addresses=''", "search_path=public"]),
    ["listen_addresses=''", "search_path=field,public"],
  );
  assert.throws(() => pinPgliteSearchPath(["search_path=pg_catalog"]), /search_path=public/);
  assert.throws(() => pinPgliteSearchPath(undefined), /defaultStartParams is missing/);
  assert.ok(PGlite.defaultStartParams.includes("search_path=field,public"));
  assert.equal(PGlite.defaultStartParams.includes("search_path=public"), false);
});

test("a closed connection is recognised from the SQLSTATE and from the message", () => {
  assert.equal(isClosedConnectionError(adminShutdown()), true);
  assert.equal(isClosedConnectionError(Object.assign(new Error("write CONNECTION_CLOSED 127.0.0.1:5432"), { code: "CONNECTION_CLOSED" })), true);
  assert.equal(isClosedConnectionError(Object.assign(new Error("server conn crashed"), { code: "08P01" })), true);
  assert.equal(isClosedConnectionError(new Error("relation \"units\" does not exist")), false);
  const wrapped = new Error("Failed query");
  wrapped.cause = adminShutdown();
  assert.equal(isClosedConnectionError(wrapped), true);
});

test("a query closed by the server runs once more, and only once", async () => {
  const crashes = [];
  const onRejection = (error) => crashes.push(error);
  process.on("unhandledRejection", onRejection);
  try {
    const once = scriptedClient([adminShutdown(), [{ n: 1 }]]);
    const wrapped = retryClosedConnections(once.sql);
    assert.deepEqual(await wrapped`select 1`, [{ n: 1 }]);
    assert.deepEqual(once.calls, ["query", "query"]);

    const values = scriptedClient([adminShutdown(), [[7]]]);
    const valueWrapped = retryClosedConnections(values.sql);
    assert.deepEqual(await valueWrapped.unsafe("select 7").values(), [[7]]);
    assert.deepEqual(values.calls, ["unsafe", "unsafe"]);

    const twice = scriptedClient([adminShutdown(), adminShutdown()]);
    await assert.rejects(retryClosedConnections(twice.sql).unsafe("select 1"), { code: "57P01" });
    assert.deepEqual(twice.calls, ["unsafe", "unsafe"]);

    const other = scriptedClient([Object.assign(new Error("relation \"units\" does not exist"), { code: "42P01" })]);
    await assert.rejects(retryClosedConnections(other.sql)`select code from units`, { code: "42P01" });
    assert.deepEqual(other.calls, ["query"]);

    const begun = scriptedClient([adminShutdown(), "ok"]);
    const tx = retryClosedConnections(begun.sql);
    assert.deepEqual(await tx.begin(async (client) => client), { from: "begin" });
    assert.deepEqual(begun.calls, ["begin", "begin"]);

    const begunOnce = scriptedClient([Object.assign(new Error("duplicate key"), { code: "23505" })]);
    await assert.rejects(retryClosedConnections(begunOnce.sql).begin(async () => "nope"), { code: "23505" });
    assert.deepEqual(begunOnce.calls, ["begin"]);

    const passthrough = scriptedClient([[{ n: 1 }]]);
    const client = retryClosedConnections(passthrough.sql);
    client.options.parsers[20] = (value) => value;
    assert.equal(passthrough.sql.options.parsers[20]("x"), "x");
    await client.end();
    assert.deepEqual(passthrough.calls, ["end"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(crashes, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
