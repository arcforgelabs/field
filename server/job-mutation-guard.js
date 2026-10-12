export function createJobMutationGuard({ timeoutMs = 120_000 } = {}) {
  const inFlight = new Map();

  function acquireExclusiveJobMutation(jobId, operationLabel) {
    const normalizedJobId = String(jobId || "").trim();
    if (!normalizedJobId) {
      return () => {};
    }
    const existing = inFlight.get(normalizedJobId);
    if (existing) {
      if (Date.now() - existing.startedAt > timeoutMs) {
        console.warn(`[mutation-guard] stale lock for ${normalizedJobId} (${existing.label}) expired after ${timeoutMs}ms — releasing`);
        inFlight.delete(normalizedJobId);
      } else {
        const err = new Error(
          `another ${existing.label || "job update"} is already running for this job; retry after it finishes`
        );
        err.statusCode = 409;
        throw err;
      }
    }

    const token = { label: operationLabel || "job update", startedAt: Date.now() };
    inFlight.set(normalizedJobId, token);
    return () => {
      const current = inFlight.get(normalizedJobId);
      if (current === token) {
        inFlight.delete(normalizedJobId);
      }
    };
  }

  async function runExclusiveJobMutation(jobId, operationLabel, task) {
    const release = acquireExclusiveJobMutation(jobId, operationLabel);
    try {
      return await task();
    } finally {
      release();
    }
  }

  return {
    acquireExclusiveJobMutation,
    runExclusiveJobMutation,
  };
}

const defaultGuard = createJobMutationGuard();

export const acquireExclusiveJobMutation = defaultGuard.acquireExclusiveJobMutation;
export const runExclusiveJobMutation = defaultGuard.runExclusiveJobMutation;
