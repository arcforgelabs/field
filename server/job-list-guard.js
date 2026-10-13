// Keeps GET /api/jobs answering when one job's files cannot be read in time.
//
// The board reads every job in turn (meta, quote artifacts, issuance ledger,
// deletion checks). One read that never settles used to hang the whole list
// with no error, so the board stayed on "Loading jobs…". Each job now has its
// own time limit and the list has an overall one: a job that runs over is left
// out and reported by id and step (never by folder, which can name an
// address), and the list answers with the jobs it could read.

export const JOB_LIST_PER_JOB_MS = 5_000;
export const JOB_LIST_TOTAL_MS = 25_000;

export class JobListTimeout extends Error {
  constructor(step, ms) {
    super(`${step} did not finish within ${ms} ms`);
    this.name = "JobListTimeout";
    this.code = "FIELD_JOB_LIST_TIMEOUT";
    this.step = step;
  }
}

/** Resolves or rejects with `promise`, or rejects with JobListTimeout after `ms`. */
export function withDeadline(promise, ms, step) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new JobListTimeout(step, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Lists `rows` through `readMeta(row)` and `listJob(row, meta)`, each job
 * within `perJobMs` and all of them within `totalMs`. Returns { jobs, skipped }:
 * skipped holds { id, step, reason } for each job left out. `onSkip` is told
 * about each one as it happens.
 */
export async function listJobsWithinDeadline(rows, {
  readMeta,
  listJob,
  perJobMs = JOB_LIST_PER_JOB_MS,
  totalMs = JOB_LIST_TOTAL_MS,
  now = () => Date.now(),
  onSkip = () => {},
}) {
  const started = now();
  const jobs = [];
  const skipped = [];
  const skip = (row, step, error) => {
    const entry = { id: row?.id || null, step, reason: error?.code === "FIELD_JOB_LIST_TIMEOUT" ? "timeout" : "error" };
    skipped.push(entry);
    onSkip(entry, error);
  };
  for (const row of rows) {
    const left = totalMs - (now() - started);
    if (left <= 0) {
      skip(row, "list", new JobListTimeout("list", totalMs));
      continue;
    }
    const limit = Math.min(perJobMs, left);
    let step = "meta";
    try {
      const meta = await withDeadline(readMeta(row), limit, "meta");
      if (!meta) continue;
      step = "summary";
      jobs.push(await withDeadline(listJob(row, meta), limit, "summary"));
    } catch (error) {
      skip(row, step, error);
    }
  }
  return { jobs, skipped };
}
