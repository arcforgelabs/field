import assert from "node:assert/strict";
import test from "node:test";

import { ensureVerificationFixtureState } from "./start.js";

test("customer runtimes bypass verification fixture state entirely", async () => {
  const result = await ensureVerificationFixtureState({
    env: { FIELD_ENV: "production" },
    verifyState: () => { throw new Error("must not verify customer state"); },
    resetState: () => { throw new Error("must not reset customer state"); },
  });

  assert.deepEqual(result, { verificationRuntime: false, reset: false });
});

test("current verification state starts without a reset", async () => {
  let verifyCalls = 0;
  let resetCalls = 0;
  const result = await ensureVerificationFixtureState({
    env: { FIELD_ENV: "field-verification" },
    verifyState: async () => {
      verifyCalls += 1;
      return { marker: "current" };
    },
    resetState: async () => { resetCalls += 1; },
  });

  assert.deepEqual(result, { verificationRuntime: true, reset: false, marker: "current" });
  assert.equal(verifyCalls, 1);
  assert.equal(resetCalls, 0);
});

test("stale verification catalog state is rebuilt and reverified before server import", async () => {
  const env = {
    FIELD_ENV: "field-verification",
    FIELD_VERIFICATION_DETERMINISTIC: "prior-deterministic",
  };
  const warnings = [];
  let verifyCalls = 0;
  let resetCalls = 0;
  const result = await ensureVerificationFixtureState({
    env,
    logger: { warn: (message) => warnings.push(message) },
    verifyState: async () => {
      verifyCalls += 1;
      if (verifyCalls === 1) throw new Error("catalog manifest hash is stale");
      return { marker: "reseeded" };
    },
    resetState: async () => {
      resetCalls += 1;
      assert.equal(env.FIELD_VERIFICATION_DETERMINISTIC, "1");
      assert.equal(env.FIELD_RESET_PREBACKUP, "host");
    },
  });

  assert.deepEqual(result, { verificationRuntime: true, reset: true, marker: "reseeded" });
  assert.equal(verifyCalls, 2);
  assert.equal(resetCalls, 1);
  assert.match(warnings.join("\n"), /stale or invalid/i);
  assert.equal(env.FIELD_VERIFICATION_DETERMINISTIC, "prior-deterministic");
  assert.equal(env.FIELD_RESET_PREBACKUP, undefined);
});

test("failed verification reseed aborts startup and restores environment", async () => {
  const env = { FIELD_ENV: "field-verification", FIELD_RESET_PREBACKUP: "prior" };

  await assert.rejects(
    ensureVerificationFixtureState({
      env,
      logger: { warn() {} },
      verifyState: async () => { throw new Error("stale marker"); },
      resetState: async () => { throw new Error("reset failed"); },
    }),
    /reset failed/,
  );
  assert.equal(env.FIELD_VERIFICATION_DETERMINISTIC, undefined);
  assert.equal(env.FIELD_RESET_PREBACKUP, "prior");
});
