import assert from "node:assert/strict";
import test from "node:test";
import {
  createJobMutationGuard,
  runExclusiveJobMutation as runExclusiveJobMutationDefault,
} from "./job-mutation-guard.js";

test("runExclusiveJobMutation rejects concurrent mutations for the same job", async () => {
  const { runExclusiveJobMutation } = createJobMutationGuard();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });

  const first = runExclusiveJobMutation("job-1", "quote refresh", async () => {
    await hold;
    return "done";
  });

  await assert.rejects(
    () => runExclusiveJobMutation("job-1", "pipeline stage update", async () => "second"),
    /another quote refresh is already running/i
  );

  release();
  assert.equal(await first, "done");
});

test("runExclusiveJobMutation releases stale locks after timeout", async () => {
  const { runExclusiveJobMutation } = createJobMutationGuard({ timeoutMs: 50 });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });

  const first = runExclusiveJobMutation("job-1", "stuck operation", async () => {
    await hold;
    return "first";
  });

  // Wait for the timeout to expire
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Should succeed because the stale lock is released
  const second = await runExclusiveJobMutation("job-1", "recovery operation", async () => "recovered");
  assert.equal(second, "recovered");

  release();
  assert.equal(await first, "first");
});

test("runExclusiveJobMutation allows independent jobs to mutate concurrently", async () => {
  const { runExclusiveJobMutation } = createJobMutationGuard();
  const results = await Promise.all([
    runExclusiveJobMutation("job-a", "quote refresh", async () => "a"),
    runExclusiveJobMutation("job-b", "quote refresh", async () => "b"),
  ]);

  assert.deepEqual(results.sort(), ["a", "b"]);
});

// `POST /api/jobs/:id/email-quote` (the route behind
// `sendJobQuote`, which mints and persists issued revisions for invoice and
// receipt sends) is now wrapped in `runExclusiveJobMutation` at the SAME
// shared default-guard instance every other milestone-mutating route uses —
// unlike the other route-level lock coverage, this cannot be exercised via
// an HTTP request in this suite (server/index.js has no route test seam,
// a pre-existing, accepted gap). This proves the mechanism the fix relies
// on: a "send quote/invoice" attempt is rejected while any other tracked
// mutation (e.g. a revise) is in flight for the same job, using the exact
// exported singleton index.js imports — not a fresh guard instance — so it
// reflects the real shared lock state a concurrent request would hit.
test("the shared default job-mutation guard blocks a send while another mutation is in flight for the same job", async () => {
  const jobId = `job-p2-4-${Date.now()}`;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });

  const revise = runExclusiveJobMutationDefault(jobId, "revise milestone invoice", async () => {
    await hold;
    return "revised";
  });

  await assert.rejects(
    () => runExclusiveJobMutationDefault(jobId, "send quote/invoice", async () => "sent"),
    /another revise milestone invoice is already running/i,
  );

  release();
  assert.equal(await revise, "revised");

  // The lock is released afterwards — a send immediately following a
  // completed revise is not blocked by a stale lock.
  const sentAfter = await runExclusiveJobMutationDefault(jobId, "send quote/invoice", async () => "sent");
  assert.equal(sentAfter, "sent");
});

test("acquireExclusiveJobMutation can hold a background lock until released", async () => {
  const {
    acquireExclusiveJobMutation,
    runExclusiveJobMutation,
  } = createJobMutationGuard();
  const release = acquireExclusiveJobMutation("job-7", "reingest");

  await assert.rejects(
    () => runExclusiveJobMutation("job-7", "quote refresh", async () => "blocked"),
    /another reingest is already running/i
  );

  release();
  const recovered = await runExclusiveJobMutation("job-7", "quote refresh", async () => "ok");
  assert.equal(recovered, "ok");
});
