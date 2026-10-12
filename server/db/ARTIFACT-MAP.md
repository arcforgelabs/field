# Field DB Artifact Map

Current folder-backed artifact to additive DB target mapping.

| Current artifact | Target table(s) | Migration notes |
| --- | --- | --- |
| `meta.json` | `jobs`, `captures` | Preserves legacy `recordingId` as `legacy_recording_id`; full payload remains in JSONB for replay/backfill safety. |
| `job-state/details.json` | `job_details` | If absent, importer synthesizes a minimal row from `meta.json` so the DB lane always has a structured details surface. |
| `job-state/gaps.json` | `gaps` | One durable row per gap key. Resolution fields stay first-class columns; raw legacy payload is retained in JSONB. |
| `job-state/activity.jsonl` | `timeline_events`, `gap_events` | Notes/activity becomes append-only timeline state in Postgres; gap lifecycle events are split into `gap_events`. |
| `transcript.json`, `transcript-raw.json` | `captures`, `storage_objects` | Structured transcript remains queryable in JSONB; file artifacts stay referenceable through `storage_objects`. |
| `tasks.json` | `captures`, `storage_objects` | Standard-mode extraction is preserved as JSONB without forcing a larger schema yet. |
| `quote.json` | `quotes`, `quote_versions`, `storage_objects` | `quotes` keeps current summary/current payload; `quote_versions` preserves versioned snapshots. |
| `quote-inputs.json` | `quotes`, `quote_versions`, `storage_objects` | Quote-input contract is still evolving, so it remains JSONB. |
| `quote-overrides.json` | `quotes`, `quote_versions`, `storage_objects` | Imported as JSONB. No attempt is made to normalize override semantics yet. |
| `quote-versions/v*/` | `quote_versions`, `storage_objects` | Each version directory becomes one `quote_versions` row plus artifact references for PDF/Markdown/JSON. |
| `job-workspace/chat/threads/*.json` | `chat_threads`, `chat_messages`, `storage_objects` | Thread/message state becomes DB-readable while the live app can remain file-backed. |
| `job-workspace/chat/lanes.json` | `chat_lanes`, `storage_objects` | Lane metadata stays JSONB because worker-lane metadata is still moving. |
| `job-workspace/chat/events.jsonl` | `audit_events`, `storage_objects` | Chat/action audit becomes queryable operational history. |
| `moasure/raw/*`, `moasure/parsed/*` | `measurement_batches`, `storage_objects` | Parsed summary remains JSONB; raw files stay as storage-object references. |
| Any backup/export candidate file | `storage_objects`, `backup_jobs` | `backup_jobs` is outbox-only. Drive is write-only backup/export, never canonical read storage. |
