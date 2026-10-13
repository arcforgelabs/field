import test from "node:test";
import assert from "node:assert/strict";
import { JobListTimeout, listJobsWithinDeadline, withDeadline } from "./job-list-guard.js";

const never = () => new Promise(() => {});

test("a read that never settles becomes a timeout naming its step", async () => {
  await assert.rejects(withDeadline(never(), 20, "meta"), (error) => error instanceof JobListTimeout && error.step === "meta" && error.code === "FIELD_JOB_LIST_TIMEOUT");
  assert.equal(await withDeadline(Promise.resolve(7), 20, "meta"), 7);
});

test("one stuck job is left out and reported; the others are listed", async () => {
  const rows = [{ id: "job-a" }, { id: "job-stuck" }, { id: "job-c" }, { id: "job-broken" }, { id: "job-gone" }];
  const told = [];
  const { jobs, skipped } = await listJobsWithinDeadline(rows, {
    readMeta: (row) => (row.id === "job-gone" ? null : { id: row.id }),
    listJob: (row, meta) => {
      if (row.id === "job-stuck") return never();
      if (row.id === "job-broken") throw new Error("unreadable quote");
      return { ...meta, listed: true };
    },
    perJobMs: 20,
    onSkip: (entry) => told.push(entry),
  });
  assert.deepEqual(jobs.map((job) => job.id), ["job-a", "job-c"]);
  assert.deepEqual(skipped, [
    { id: "job-stuck", step: "summary", reason: "timeout" },
    { id: "job-broken", step: "summary", reason: "error" },
  ]);
  assert.deepEqual(told, skipped);
});

test("the list as a whole stops at its overall limit", async () => {
  let clock = 0;
  const rows = [{ id: "job-1" }, { id: "job-2" }, { id: "job-3" }];
  const { jobs, skipped } = await listJobsWithinDeadline(rows, {
    readMeta: (row) => { clock += 60; return { id: row.id }; },
    listJob: (_row, meta) => meta,
    perJobMs: 1_000,
    totalMs: 100,
    now: () => clock,
  });
  assert.deepEqual(jobs.map((job) => job.id), ["job-1", "job-2"]);
  assert.deepEqual(skipped, [{ id: "job-3", step: "list", reason: "timeout" }]);
});
