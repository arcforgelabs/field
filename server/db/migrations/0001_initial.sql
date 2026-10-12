BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_recording_id text UNIQUE,
  source_kind text NOT NULL DEFAULT 'recording_folder',
  source_path text,
  output_mode text NOT NULL DEFAULT 'quote' CHECK (output_mode IN ('quote', 'report')),
  title text,
  label text,
  slug text,
  capture_mode text,
  status text,
  job_number text,
  quote_catalog_id text NOT NULL,
  archived_at timestamptz,
  archived_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  job_meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_job_number_idx ON jobs (job_number);
CREATE INDEX IF NOT EXISTS jobs_archived_at_idx ON jobs (archived_at);

COMMENT ON TABLE jobs IS 'Canonical structured job state. quote_catalog_id references file-authoritative quote-catalog metadata under apps/field/quote-catalogs/.';

CREATE TABLE IF NOT EXISTS job_details (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  site_address text,
  gps jsonb,
  customer_name text,
  contact_name text,
  contact_phone text,
  contact_email text,
  quoted_by_name text,
  quoted_by_completed_at timestamptz,
  quoted_by_method text,
  soil_dump jsonb,
  details_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  legacy_recording_id text UNIQUE,
  source_kind text NOT NULL DEFAULT 'recording_folder',
  source_path text,
  legacy_slug text,
  label text,
  audio_filename text,
  mime_type text,
  output_mode text NOT NULL CHECK (output_mode IN ('quote', 'report')),
  capture_mode text,
  status text,
  duration_ms bigint,
  speaker_count integer,
  task_count integer,
  qa_dropped integer,
  recorded_at timestamptz NOT NULL,
  processed_at timestamptz,
  transcript_payload jsonb,
  transcript_raw_payload jsonb,
  tasks_payload jsonb,
  capture_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS captures_job_recorded_at_idx ON captures (job_id, recorded_at DESC);

COMMENT ON COLUMN captures.transcript_payload IS 'Evolving canonical transcript structure including segments and cleaned transcript.';
COMMENT ON COLUMN captures.transcript_raw_payload IS 'Optional raw diarization transcript payload from the legacy file-backed pipeline.';

CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  source_capture_id uuid REFERENCES captures(id) ON DELETE SET NULL,
  quote_number text UNIQUE,
  quote_catalog_id text NOT NULL,
  status text,
  review_status text,
  delivery_status text,
  current_version_number integer,
  subtotal_amount numeric(12, 2),
  gst_amount numeric(12, 2),
  total_amount numeric(12, 2),
  currency text DEFAULT 'AUD',
  summary text,
  current_payload jsonb,
  current_quote_input_payload jsonb,
  current_quote_overrides_payload jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotes_job_updated_at_idx ON quotes (job_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS quotes_quote_number_idx ON quotes (quote_number);

COMMENT ON COLUMN quotes.quote_catalog_id IS 'Reference only. Canonical pricing authority remains the Field-owned quote catalog set.';

CREATE TABLE IF NOT EXISTS quote_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  source_capture_id uuid REFERENCES captures(id) ON DELETE SET NULL,
  version_number integer NOT NULL,
  version_label text NOT NULL,
  status text,
  review_status text,
  delivery_status text,
  generated_at timestamptz,
  subtotal_amount numeric(12, 2),
  gst_amount numeric(12, 2),
  total_amount numeric(12, 2),
  currency text DEFAULT 'AUD',
  quote_payload jsonb NOT NULL,
  quote_input_payload jsonb,
  quote_overrides_payload jsonb,
  version_notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version_number)
);

CREATE INDEX IF NOT EXISTS quote_versions_quote_generated_idx ON quote_versions (quote_id, generated_at DESC);

COMMENT ON COLUMN quote_versions.quote_input_payload IS 'Evolving quote extraction payload stored as JSONB until the input contract stabilizes.';

CREATE TABLE IF NOT EXISTS gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE SET NULL,
  legacy_gap_id text,
  gap_key text NOT NULL,
  field_name text,
  title text,
  description text,
  severity text,
  status text,
  present_in_current_context boolean NOT NULL DEFAULT true,
  assumption_available boolean NOT NULL DEFAULT false,
  assumption_value jsonb,
  default_assumption_value jsonb,
  assumption_note text,
  evidence_payload jsonb,
  resolution_mode text,
  resolution_reason text,
  resolution_reason_code text,
  resolution_note text,
  resolution_by_kind text,
  resolution_by_label text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  resolved_at timestamptz,
  gap_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, gap_key)
);

CREATE INDEX IF NOT EXISTS gaps_job_status_idx ON gaps (job_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS gap_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_key text NOT NULL UNIQUE,
  gap_id uuid NOT NULL REFERENCES gaps(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE SET NULL,
  event_kind text NOT NULL,
  status text,
  reason text,
  reason_code text,
  note text,
  actor_kind text,
  actor_label text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_ts timestamptz NOT NULL,
  source_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gap_events_gap_ts_idx ON gap_events (gap_id, event_ts DESC);

CREATE TABLE IF NOT EXISTS chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE SET NULL,
  legacy_thread_id text UNIQUE,
  title text,
  context_version text,
  workspace_root text,
  status text,
  thread_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_threads_job_updated_idx ON chat_threads (job_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_lanes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES chat_threads(id) ON DELETE SET NULL,
  legacy_lane_id text UNIQUE,
  parent_thread_ref text,
  ownership text,
  managed boolean NOT NULL DEFAULT false,
  context_version text,
  runtime_adapter text,
  worker_profile text,
  lane_state text,
  lane_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_lanes_job_updated_idx ON chat_lanes (job_id, updated_at DESC);

COMMENT ON COLUMN chat_lanes.lane_metadata IS 'Evolving worker lane metadata kept in JSONB while the worker contract is still moving.';

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_message_key text NOT NULL UNIQUE,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE SET NULL,
  legacy_message_id text,
  role text NOT NULL,
  content text,
  citations jsonb,
  actions jsonb,
  message_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  message_source text,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_messages_thread_created_idx ON chat_messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS measurement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  batch_key text NOT NULL,
  batch_status text,
  scanned_at timestamptz,
  batch_sequence integer,
  location_hints jsonb,
  moasure_summary_payload jsonb,
  source_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_id, batch_key)
);

CREATE INDEX IF NOT EXISTS measurement_batches_capture_scanned_idx ON measurement_batches (capture_id, scanned_at DESC);

COMMENT ON COLUMN measurement_batches.moasure_summary_payload IS 'Evolving parsed Moasure summary payload stored as JSONB.';

CREATE TABLE IF NOT EXISTS storage_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES quotes(id) ON DELETE CASCADE,
  quote_version_id uuid REFERENCES quote_versions(id) ON DELETE CASCADE,
  measurement_batch_id uuid REFERENCES measurement_batches(id) ON DELETE CASCADE,
  object_role text NOT NULL,
  storage_backend text NOT NULL DEFAULT 'local_fs' CHECK (storage_backend IN ('local_fs', 'google_drive', 's3', 'unknown')),
  source_path text NOT NULL,
  relative_path text NOT NULL,
  mime_type text,
  size_bytes bigint,
  checksum_sha256 text,
  storage_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_objects_job_role_idx ON storage_objects (job_id, object_role, created_at DESC);
CREATE INDEX IF NOT EXISTS storage_objects_capture_role_idx ON storage_objects (capture_id, object_role, created_at DESC);
CREATE INDEX IF NOT EXISTS storage_objects_quote_version_role_idx ON storage_objects (quote_version_id, object_role, created_at DESC);

COMMENT ON TABLE storage_objects IS 'Reference layer for raw and binary artifacts. Live app can stay folder-backed while structured state moves to Postgres.';
COMMENT ON COLUMN storage_objects.storage_key IS 'Logical unique key. relative_path remains the physical file path, while storage_key can distinguish multiple logical roles over one physical file.';

CREATE TABLE IF NOT EXISTS backup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE CASCADE,
  quote_version_id uuid REFERENCES quote_versions(id) ON DELETE CASCADE,
  measurement_batch_id uuid REFERENCES measurement_batches(id) ON DELETE CASCADE,
  storage_object_id uuid REFERENCES storage_objects(id) ON DELETE CASCADE,
  target text NOT NULL DEFAULT 'google_drive' CHECK (target IN ('google_drive')),
  operation text NOT NULL DEFAULT 'backup_object',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead_letter')),
  priority smallint NOT NULL DEFAULT 100,
  attempt_count integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  next_attempt_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backup_jobs_status_schedule_idx ON backup_jobs (status, scheduled_at, priority);
CREATE INDEX IF NOT EXISTS backup_jobs_target_status_idx ON backup_jobs (target, status, scheduled_at);

COMMENT ON TABLE backup_jobs IS 'Outbox for async backup/export work. Drive is a write-only backup/export target, never canonical read storage.';

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_key text NOT NULL UNIQUE,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES chat_threads(id) ON DELETE SET NULL,
  lane_id uuid REFERENCES chat_lanes(id) ON DELETE SET NULL,
  actor_kind text,
  actor_label text,
  event_kind text NOT NULL,
  event_status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_ts timestamptz NOT NULL,
  source_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_job_ts_idx ON audit_events (job_id, event_ts DESC);

CREATE TABLE IF NOT EXISTS timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_key text NOT NULL UNIQUE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  capture_id uuid REFERENCES captures(id) ON DELETE SET NULL,
  gap_id uuid REFERENCES gaps(id) ON DELETE SET NULL,
  event_kind text NOT NULL,
  actor_kind text,
  actor_label text,
  title text,
  body text,
  field_name text,
  reason text,
  reason_code text,
  before_value jsonb,
  after_value jsonb,
  evidence_payload jsonb,
  event_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_ts timestamptz NOT NULL,
  source_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timeline_events_job_ts_idx ON timeline_events (job_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS timeline_events_gap_ts_idx ON timeline_events (gap_id, event_ts DESC);

COMMIT;
