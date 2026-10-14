// The update status for owners (GET /api/updates), shared by the Settings
// page and the dot on the Settings link. The server caches the check for six
// hours; this asks the server once per page load, and again after an owner
// changes the setting.
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import type { UpdateStatus } from "@/lib/types";

let shared: Promise<UpdateStatus | null> | null = null;
const listeners = new Set<(status: UpdateStatus | null) => void>();

function load(force = false): Promise<UpdateStatus | null> {
  if (!shared || force) {
    shared = api.updates().catch(() => null);
    void shared.then((status) => listeners.forEach((listener) => listener(status)));
  }
  return shared;
}

/** Forgets the shared answer (tests). */
export function resetUpdateStatus() {
  shared = null;
}

export function useUpdateStatus() {
  const { isOwner } = useAuth();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!isOwner) return;
    let live = true;
    const listener = (next: UpdateStatus | null) => { if (live) setStatus(next); };
    listeners.add(listener);
    void load().then(listener);
    return () => { live = false; listeners.delete(listener); };
  }, [isOwner]);
  const refresh = useCallback(() => load(true), []);
  return { status: isOwner ? status : null, refresh };
}
