// The account's milestone rules for one job (#29), from
// GET /api/jobs/:id/milestone-rules.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { JobMilestoneRules } from "@/lib/types";

/** The account's milestone rules for one job, read again when `refreshKey` changes. */
export function useJobMilestoneRules(jobId: string, refreshKey: string) {
  const [state, setState] = useState<JobMilestoneRules | null>(null);
  useEffect(() => {
    let live = true;
    if (!jobId) return;
    api.jobMilestoneRules(jobId)
      .then((result) => { if (live) setState(result); })
      // No database, or no access: the job shows as before rules.
      .catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, [jobId, refreshKey]);
  return state;
}
