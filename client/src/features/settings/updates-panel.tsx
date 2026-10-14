// Field releases, for owners: a notice when a newer release is out on this
// installation's channel, and the switch that turns the check off. The check
// itself runs on the server (server/update-check.js): an anonymous GET of
// public release data, at most every six hours.
import { useState } from "react";
import { useShell } from "@/components/shell/shell-context";
import { api } from "@/lib/api";
import type { UpdateStatus } from "@/lib/types";
import { useUpdateStatus } from "./use-update-status";

const releaseName = (tag: string | null) => (tag ? `field ${tag.replace(/^v/, "")}` : "");

/** "Update available: field X → see what's new", or nothing. */
export function UpdateNotice({ status }: { status: UpdateStatus | null }) {
  if (!status?.updateAvailable || !status.latest) return null;
  return (
    <div className="fx-notice" role="status" style={{ margin: "0 0 16px" }}>
      <span>
        Update available: <strong>{releaseName(status.latest)}</strong>
        {status.current && <> (you run {releaseName(status.current)})</>}.{" "}
        <a href={status.releaseUrl ?? undefined} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>See what's new</a>
        {" · "}
        <a href={status.upgradeUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>How to update</a>
      </span>
    </div>
  );
}

export function UpdatesPanel() {
  const { status, refresh } = useUpdateStatus();
  const { toast } = useShell();
  const [busy, setBusy] = useState(false);
  if (!status) return null;

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await api.updateInvoicingSettings({ updateCheck: enabled });
      await refresh();
      toast(enabled ? "Field will check for new releases" : "Field will not check for new releases");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save the setting");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fx-set__section" aria-label="Field releases">
      <div>
        <h2 className="fx-set__h">Field releases</h2>
        <p className="fx-set__p">
          {status.current
            ? <>This installation runs {releaseName(status.current)} on the {status.channel} channel.</>
            : <>This installation is not running a published release, so Field cannot tell whether a newer one is out.</>}
        </p>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={status.enabled} disabled={busy} onChange={(event) => void toggle(event.target.checked)} />
        <span>
          Check for new Field releases
          <span className="fx-dim" style={{ display: "block", fontSize: 12.5 }}>
            At most every six hours, Field asks GitHub (or npm) which release is newest. It sends nothing about this installation.
          </span>
        </span>
      </label>
      {status.enabled && status.error && <p className="fx-dim" style={{ fontSize: 12.5 }}>The last check could not reach GitHub or npm; Field tries again later.</p>}
    </section>
  );
}
