// The job's Notes tab (what the team writes down: access, gate codes, what the
// customer asked for) and Activity tab (what happened to the job, newest
// first). Engine output never appears in either; it's in the job log.
import { useEffect, useState } from "react";
import type { RecordingDetail } from "@/lib/types";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { relativeDay } from "@/lib/job-status";
import { jobTimeline } from "@/lib/job-timeline";

type Note = { id: string; text: string; title: string | null; author: string; createdAt: string };

export function JobNotes({ detail, onDetail }: { detail: RecordingDetail; onDetail: (next: RecordingDetail) => void }) {
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const jobId = detail.meta.id;

  useEffect(() => {
    let cancelled = false;
    api.getNotes(jobId).then((res) => { if (!cancelled) setNotes(res.notes || []); }).catch(() => { if (!cancelled) setNotes([]); });
    return () => { cancelled = true; };
  }, [jobId]);

  async function addNote() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const added = await api.addNote(jobId, text, user?.name);
      setDraft("");
      if (added.detail) onDetail(added.detail);
      const res = await api.getNotes(jobId);
      setNotes(res.notes || []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="fx-block" style={{ paddingBottom: 16 }}>
        <textarea
          id="job-note"
          className="fx-textarea"
          style={{ minHeight: 72 }}
          placeholder="Add a note for the team: access, gate codes, what the customer asked for…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void addNote(); }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8, alignItems: "center" }}>
          <span className="fx-mute" style={{ fontSize: 11.5 }}>⌘↵ to add</span>
          <button type="button" className="fx-btn fx-btn--sm" disabled={!draft.trim() || busy} onClick={addNote}>Add note</button>
        </div>
      </div>
      {notes && notes.length === 0 && <div className="fx-block fx-mute">No notes yet.</div>}
      {(notes || []).map((note) => (
        <div key={note.id} className="fx-act">
          <div>
            <div className="fx-num fx-mute" style={{ fontSize: 12 }}>{relativeDay(note.createdAt)}</div>
            <div className="fx-act__who">{note.author || "Team"}</div>
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{note.title ? <strong>{note.title}. </strong> : null}{note.text}</div>
        </div>
      ))}
    </div>
  );
}

export function JobActivity({ detail }: { detail: RecordingDetail }) {
  const events = jobTimeline(detail.jobState?.activity, { at: detail.meta.createdAt });
  return (
    <div>
      {events.length === 0 && <div className="fx-block fx-mute">Nothing has happened yet.</div>}
      {events.map((event) => (
        <div key={event.id} className="fx-act">
          <div>
            <div className="fx-num fx-mute" style={{ fontSize: 12 }}>{relativeDay(event.at)}</div>
            {event.who && <div className="fx-act__who">{event.who}</div>}
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>{event.title}</div>
            {event.detail && <div className="fx-dim" style={{ whiteSpace: "pre-wrap" }}>{event.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
