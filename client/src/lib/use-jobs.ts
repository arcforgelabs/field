// The job list, shared by the shell (counts, search), the jobs board and the
// invoices ledger, so moving between them never refetches from cold.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import type { RecordingMeta } from "./types";

type JobsSnapshot = { jobs: RecordingMeta[] | null; error: string | null; loading: boolean };

let snapshot: JobsSnapshot = { jobs: null, error: null, loading: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: Partial<JobsSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

export function refreshJobs(): Promise<void> {
  if (inflight) return inflight;
  emit({ loading: true });
  inflight = api.recordings()
    .then((jobs) => emit({ jobs: Array.isArray(jobs) ? jobs : [], error: null, loading: false }))
    .catch((error: unknown) => emit({ error: error instanceof Error ? error.message : "Jobs could not be loaded.", loading: false }))
    .finally(() => { inflight = null; });
  return inflight;
}

/** Replace one job's meta in the shared list after a mutation. */
export function patchJobMeta(meta: RecordingMeta) {
  if (!snapshot.jobs) return;
  const exists = snapshot.jobs.some((job) => job.id === meta.id);
  emit({ jobs: exists ? snapshot.jobs.map((job) => (job.id === meta.id ? { ...job, ...meta } : job)) : [meta, ...snapshot.jobs] });
}

export function useJobs() {
  const state = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => snapshot,
  );
  useEffect(() => {
    if (!snapshot.jobs && !inflight) void refreshJobs();
  }, []);
  const refresh = useCallback(() => refreshJobs(), []);
  return { ...state, refresh };
}
