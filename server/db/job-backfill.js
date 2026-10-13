import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "../storage/fs.js";
import { readdir, readFile, stat } from "../storage/fs-promises.js";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_QUOTE_CATALOG_ID } from "../quote-catalog-ids.js";

const APP_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CONFIG_PATH = join(APP_ROOT, "../config.json");
const DEFAULT_DATA_DIR = join(APP_ROOT, "../data");
const NAMESPACE = "field-db-backfill";

// Legacy folder-backed artifact -> DB mapping
// meta.json -> jobs + captures
// job-state/details.json -> job_details
// job-state/gaps.json -> gaps
// job-state/activity.jsonl -> timeline_events (+ gap_events when applicable)
// transcript.json / transcript-raw.json / tasks.json -> captures JSONB + storage_objects
// quote.json / quote-inputs.json / quote-overrides.json / quote-versions/* -> quotes + quote_versions + storage_objects
// job-workspace/chat/* -> chat_threads + chat_messages + chat_lanes + audit_events
// moasure/raw/* + moasure/parsed/* -> measurement_batches + storage_objects
// storage_objects -> source artifact registry for future async backup/export via backup_jobs

export async function buildBackfillBundle({
  sourceRoot,
  recordingFilter = null,
  limit = null,
  seedBackupJobs = false,
  importedAt = new Date().toISOString(),
}) {
  const resolvedRoot = resolve(sourceRoot);
  const jobDirs = await scanRecordingDirectories(resolvedRoot);
  const filtered = recordingFilter
    ? jobDirs.filter((dir) => basename(dir) === recordingFilter || dir.includes(`${sep}${recordingFilter}${sep}`) || dir.endsWith(`${sep}${recordingFilter}`))
    : jobDirs;
  const selected = typeof limit === "number" && Number.isFinite(limit)
    ? filtered.slice(0, Math.max(0, limit))
    : filtered;

  const bundle = emptyBundle({
    sourceRoot: resolvedRoot,
    importedAt,
    seedBackupJobs,
  });

  for (const jobDir of selected) {
    const plan = await mapRecordingDirectory({
      jobDir,
      sourceRoot: resolvedRoot,
      importedAt,
      seedBackupJobs,
    });
    mergeBundle(bundle, plan);
  }

  bundle.summary.recordingCount = selected.length;
  for (const [table, rows] of Object.entries(bundle.tables)) {
    bundle.summary.tableCounts[table] = rows.length;
  }

  return bundle;
}

export async function mapRecordingDirectory({
  jobDir,
  sourceRoot,
  importedAt = new Date().toISOString(),
  seedBackupJobs = false,
}) {
  const meta = await readJson(join(jobDir, "meta.json"));
  if (!meta) {
    throw new Error(`meta.json missing in ${jobDir}`);
  }

  const transcript = await readJson(join(jobDir, "transcript.json"));
  const transcriptRaw = await readJson(join(jobDir, "transcript-raw.json"));
  const tasks = await readJson(join(jobDir, "tasks.json"));
  const quote = await readJson(join(jobDir, "quote.json"));
  const quoteInputs = await readJson(join(jobDir, "quote-inputs.json"));
  const quoteOverrides = await readJson(join(jobDir, "quote-overrides.json"));
  const jobDetails = await readJson(join(jobDir, "job-state", "details.json"));
  const gapPayloads = await readJson(join(jobDir, "job-state", "gaps.json"), []);
  const activity = await readJsonLines(join(jobDir, "job-state", "activity.jsonl"));
  const chatIndex = await readJson(join(jobDir, "job-workspace", "chat", "index.json"), []);
  const chatLanesPayload = await readJson(join(jobDir, "job-workspace", "chat", "lanes.json"), []);
  const chatAudit = await readJsonLines(join(jobDir, "job-workspace", "chat", "events.jsonl"));
  const moasureLatestSummary = await readJson(join(jobDir, "moasure", "parsed", "latest.json"));
  const quoteVersionFiles = await listQuoteVersions(jobDir);
  const chatThreadsPayload = await readThreadFiles(join(jobDir, "job-workspace", "chat", "threads"));

  const jobId = stableUuid(`job:${meta.id}`);
  const captureId = stableUuid(`capture:${meta.id}`);
  const quoteId = quote || quoteVersionFiles.length || meta.outputMode === "quote"
    ? stableUuid(`quote:${meta.id}`)
    : null;

  const details = jobDetails || synthesizeJobDetails(meta);
  const jobRow = {
    id: jobId,
    legacy_recording_id: meta.id,
    source_kind: "recording_folder",
    source_path: jobDir,
    output_mode: meta.outputMode === "quote" ? "quote" : "report",
    title: meta.title || null,
    label: meta.label || null,
    slug: meta.slug || null,
    capture_mode: meta.captureMode || ((meta.audioFiles?.length || meta.audioFile) ? "recording" : "manual"),
    status: meta.status || null,
    job_number: meta.jobNumber || quote?.jobNumber || null,
    quote_catalog_id: meta.quoteCatalogId || DEFAULT_QUOTE_CATALOG_ID,
    archived_at: details.archivedAt || meta.archivedAt || null,
    archived_reason: details.archivedReason || meta.archivedReason || null,
    created_at: meta.createdAt || importedAt,
    updated_at: chooseLatestTimestamp([
      quote?.updatedAt,
      quote?.generatedAt,
      details.quotedBy?.completedAt,
      details.archivedAt,
      meta.createdAt,
    ], importedAt),
    job_meta: meta,
  };

  const jobDetailRow = {
    job_id: jobId,
    site_address: details.siteAddress || null,
    gps: details.gps || null,
    customer_name: details.customer?.name || meta.customerName || null,
    contact_name: details.contact?.name || null,
    contact_phone: details.contact?.phone || null,
    contact_email: details.contact?.email || null,
    quoted_by_name: details.quotedBy?.name || null,
    quoted_by_completed_at: details.quotedBy?.completedAt || null,
    quoted_by_method: details.quotedBy?.method || null,
    soil_dump: details.soilDump || null,
    details_payload: details,
    created_at: meta.createdAt || importedAt,
    updated_at: chooseLatestTimestamp([
      details.quotedBy?.completedAt,
      details.archivedAt,
      meta.createdAt,
    ], importedAt),
  };

  const captureRow = {
    id: captureId,
    job_id: jobId,
    legacy_recording_id: meta.id,
    source_kind: "recording_folder",
    source_path: jobDir,
    legacy_slug: meta.slug || null,
    label: meta.label || meta.title || null,
    audio_filename: meta.audioFile || meta.audioFiles?.[0] || null,
    mime_type: meta.mimeType || null,
    output_mode: meta.outputMode === "quote" ? "quote" : "report",
    capture_mode: meta.captureMode || ((meta.audioFiles?.length || meta.audioFile) ? "recording" : "manual"),
    status: meta.status || null,
    duration_ms: toInt(meta.durationMs),
    speaker_count: toInt(meta.speakerCount),
    task_count: toInt(meta.taskCount),
    qa_dropped: toInt(meta.qaDropped),
    recorded_at: meta.createdAt || importedAt,
    processed_at: chooseLatestTimestamp([
      quote?.generatedAt,
      meta.createdAt,
    ], importedAt),
    transcript_payload: transcript,
    transcript_raw_payload: transcriptRaw,
    tasks_payload: tasks,
    capture_meta: meta,
    created_at: meta.createdAt || importedAt,
    updated_at: chooseLatestTimestamp([
      quote?.updatedAt,
      quote?.generatedAt,
      meta.createdAt,
    ], importedAt),
  };

  const tables = emptyBundle({ sourceRoot, importedAt, seedBackupJobs }).tables;
  tables.jobs.push(jobRow);
  tables.job_details.push(jobDetailRow);
  tables.captures.push(captureRow);

  const gapIdByLegacyId = new Map();
  const gapIdByKey = new Map();

  for (const rawGap of gapPayloads || []) {
    const gapKey = String(rawGap.key || normalizeKey(rawGap.field || rawGap.title || rawGap.id || "gap")).trim();
    const gapId = stableUuid(`gap:${meta.id}:${gapKey}`);
    gapIdByKey.set(gapKey, gapId);
    if (rawGap.id) gapIdByLegacyId.set(String(rawGap.id), gapId);
    tables.gaps.push({
      id: gapId,
      job_id: jobId,
      capture_id: captureId,
      legacy_gap_id: rawGap.id || null,
      gap_key: gapKey,
      field_name: rawGap.field || null,
      title: rawGap.title || rawGap.field || null,
      description: rawGap.description || null,
      severity: rawGap.severity || null,
      status: rawGap.status || null,
      present_in_current_context: rawGap.presentInCurrentContext !== false,
      assumption_available: rawGap.assumption?.available === true,
      assumption_value: normalizeJsonScalar(rawGap.assumption?.value),
      default_assumption_value: normalizeJsonScalar(rawGap.assumption?.defaultValue),
      assumption_note: rawGap.assumption?.quoteNote || null,
      evidence_payload: rawGap.evidence || null,
      resolution_mode: rawGap.resolution?.mode || null,
      resolution_reason: rawGap.resolution?.reason || null,
      resolution_reason_code: rawGap.resolution?.reasonCode || null,
      resolution_note: rawGap.resolution?.note || null,
      resolution_by_kind: rawGap.resolution?.by?.kind || null,
      resolution_by_label: rawGap.resolution?.by?.label || null,
      first_seen_at: rawGap.firstSeenAt || null,
      last_seen_at: rawGap.lastSeenAt || null,
      resolved_at: rawGap.resolution?.at || null,
      gap_payload: rawGap,
      created_at: rawGap.firstSeenAt || meta.createdAt || importedAt,
      updated_at: rawGap.lastSeenAt || rawGap.resolution?.at || meta.createdAt || importedAt,
    });
  }

  for (let index = 0; index < activity.length; index += 1) {
    const event = activity[index];
    const gapId = findGapIdForEvent(event, { gapIdByLegacyId, gapIdByKey });
    const externalEventKey = buildSourceKey(jobDir, join("job-state", "activity.jsonl"), `${event.id || index}`);
    tables.timeline_events.push({
      id: stableUuid(`timeline:${externalEventKey}`),
      external_event_key: externalEventKey,
      job_id: jobId,
      capture_id: captureId,
      gap_id: gapId,
      event_kind: event.kind || "system.event",
      actor_kind: event.actor?.kind || null,
      actor_label: event.actor?.label || null,
      title: event.title || null,
      body: event.body || null,
      field_name: event.field || null,
      reason: event.reason || null,
      reason_code: event.reasonCode || null,
      before_value: normalizeJsonScalar(event.before),
      after_value: normalizeJsonScalar(event.after),
      evidence_payload: event.evidence || null,
      event_payload: event,
      event_ts: event.ts || meta.createdAt || importedAt,
      source_path: join(jobDir, "job-state", "activity.jsonl"),
      created_at: importedAt,
    });

    if (gapId && (event.kind === "gap.detected" || event.kind === "gap.state_changed")) {
      tables.gap_events.push({
        id: stableUuid(`gap-event:${externalEventKey}`),
        external_event_key: externalEventKey,
        gap_id: gapId,
        job_id: jobId,
        capture_id: captureId,
        event_kind: event.kind,
        status: event.gapStatus || null,
        reason: event.reason || null,
        reason_code: event.reasonCode || null,
        note: event.body || null,
        actor_kind: event.actor?.kind || null,
        actor_label: event.actor?.label || null,
        payload: event,
        event_ts: event.ts || meta.createdAt || importedAt,
        source_path: join(jobDir, "job-state", "activity.jsonl"),
        created_at: importedAt,
      });
    }
  }

  const threadIdByLegacy = new Map();
  for (const thread of chatThreadsPayload) {
    const threadId = stableUuid(`thread:${meta.id}:${thread.id}`);
    threadIdByLegacy.set(String(thread.id), threadId);
    tables.chat_threads.push({
      id: threadId,
      job_id: jobId,
      capture_id: captureId,
      legacy_thread_id: thread.id || null,
      title: thread.title || "Job chat",
      context_version: thread.contextVersion || null,
      workspace_root: thread.workspaceRoot || null,
      status: thread.status || "active",
      thread_payload: {
        indexSummary: chatIndex.find((item) => item.id === thread.id) || null,
        source: thread,
      },
      created_at: thread.createdAt || meta.createdAt || importedAt,
      updated_at: thread.updatedAt || thread.createdAt || meta.createdAt || importedAt,
    });

    for (let messageIndex = 0; messageIndex < (thread.messages || []).length; messageIndex += 1) {
      const message = thread.messages[messageIndex];
      const externalMessageKey = `${thread.id}:${message.id || messageIndex}`;
      tables.chat_messages.push({
        id: stableUuid(`message:${meta.id}:${externalMessageKey}`),
        external_message_key: externalMessageKey,
        thread_id: threadId,
        job_id: jobId,
        capture_id: captureId,
        legacy_message_id: message.id || null,
        role: message.role || "assistant",
        content: coerceText(message.content),
        citations: message.citations || [],
        actions: message.actions || [],
        message_meta: message.meta || {},
        idempotency_key: message.idempotencyKey || null,
        message_source: message.source || null,
        created_at: message.createdAt || thread.createdAt || meta.createdAt || importedAt,
      });
    }
  }

  const laneIdByLegacy = new Map();
  for (const lane of chatLanesPayload || []) {
    const laneId = stableUuid(`lane:${meta.id}:${lane.id}`);
    laneIdByLegacy.set(String(lane.id), laneId);
    tables.chat_lanes.push({
      id: laneId,
      job_id: jobId,
      capture_id: captureId,
      thread_id: threadIdByLegacy.get(String(lane.threadId || "")) || null,
      legacy_lane_id: lane.id || null,
      parent_thread_ref: lane.parentThreadId || null,
      ownership: lane.ownership || null,
      managed: lane.managed === true,
      context_version: lane.contextVersion || null,
      runtime_adapter: lane.runtimeAdapter || null,
      worker_profile: lane.workerProfile || null,
      lane_state: lane.state || null,
      lane_metadata: lane,
      created_at: lane.createdAt || meta.createdAt || importedAt,
      updated_at: lane.updatedAt || lane.createdAt || meta.createdAt || importedAt,
    });
  }

  for (let index = 0; index < chatAudit.length; index += 1) {
    const event = chatAudit[index];
    const externalEventKey = buildSourceKey(jobDir, join("job-workspace", "chat", "events.jsonl"), `${event.id || index}`);
    tables.audit_events.push({
      id: stableUuid(`audit:${externalEventKey}`),
      external_event_key: externalEventKey,
      job_id: jobId,
      capture_id: captureId,
      thread_id: threadIdByLegacy.get(String(event.threadId || "")) || null,
      lane_id: laneIdByLegacy.get(String(event.laneId || "")) || null,
      actor_kind: inferAuditActorKind(event.kind),
      actor_label: inferAuditActorLabel(event.kind),
      event_kind: event.kind || "chat.event",
      event_status: event.status || null,
      payload: event,
      event_ts: event.ts || meta.createdAt || importedAt,
      source_path: join(jobDir, "job-workspace", "chat", "events.jsonl"),
      created_at: importedAt,
    });
  }

  if (quoteId) {
    const latestVersion = pickLatestQuoteVersion({ quote, quoteVersionFiles });
    tables.quotes.push({
      id: quoteId,
      job_id: jobId,
      source_capture_id: captureId,
      quote_number: quote?.quoteNumber || latestVersion?.quotePayload?.quoteNumber || meta.quoteNumber || null,
      quote_catalog_id: quote?.quoteCatalog?.id || quote?.profile?.id || meta.quoteCatalogId || DEFAULT_QUOTE_CATALOG_ID,
      status: quote?.status || latestVersion?.quotePayload?.status || null,
      review_status: quote?.review?.status || latestVersion?.quotePayload?.review?.status || meta.quoteReviewStatus || null,
      delivery_status: quote?.delivery?.status || latestVersion?.quotePayload?.delivery?.status || meta.quoteDeliveryStatus || null,
      current_version_number: latestVersion?.versionNumber || toInt(meta.quoteVersion) || null,
      subtotal_amount: toMoney(quote?.totals?.subtotal ?? latestVersion?.quotePayload?.totals?.subtotal),
      gst_amount: toMoney(quote?.totals?.gst ?? latestVersion?.quotePayload?.totals?.gst),
      total_amount: toMoney(quote?.totals?.total ?? latestVersion?.quotePayload?.totals?.total),
      currency: quote?.totals?.currency || latestVersion?.quotePayload?.totals?.currency || "AUD",
      summary: quote?.summary || latestVersion?.quotePayload?.summary || null,
      current_payload: quote || latestVersion?.quotePayload || null,
      current_quote_input_payload: quoteInputs || null,
      current_quote_overrides_payload: quoteOverrides || null,
      created_at: meta.createdAt || latestVersion?.generatedAt || importedAt,
      updated_at: chooseLatestTimestamp([
        quote?.updatedAt,
        quote?.generatedAt,
        latestVersion?.generatedAt,
        meta.createdAt,
      ], importedAt),
    });

    for (const versionFile of quoteVersionFiles) {
      const versionId = stableUuid(`quote-version:${meta.id}:${versionFile.versionNumber}`);
      tables.quote_versions.push({
        id: versionId,
        quote_id: quoteId,
        source_capture_id: captureId,
        version_number: versionFile.versionNumber,
        version_label: versionFile.versionLabel,
        status: versionFile.quotePayload?.status || null,
        review_status: versionFile.quotePayload?.review?.status || meta.quoteReviewStatus || null,
        delivery_status: versionFile.quotePayload?.delivery?.status || meta.quoteDeliveryStatus || null,
        generated_at: versionFile.generatedAt || meta.createdAt || importedAt,
        subtotal_amount: toMoney(versionFile.quotePayload?.totals?.subtotal),
        gst_amount: toMoney(versionFile.quotePayload?.totals?.gst),
        total_amount: toMoney(versionFile.quotePayload?.totals?.total),
        currency: versionFile.quotePayload?.totals?.currency || "AUD",
        quote_payload: versionFile.quotePayload || {},
        quote_input_payload: versionFile.isCurrent ? quoteInputs || null : null,
        quote_overrides_payload: versionFile.quoteOverrides || (versionFile.isCurrent ? quoteOverrides || null : null),
        version_notes: {
          importedFromCurrentFiles: versionFile.isCurrent,
          sourceFiles: versionFile.files,
        },
        source_path: versionFile.sourcePath,
        created_at: versionFile.generatedAt || meta.createdAt || importedAt,
      });
    }
  }

  const measurementBatchIdByKey = new Map();
  const moasureBatches = await collectMoasureBatches({
    jobDir,
    jobId,
    captureId,
    latestSummary: moasureLatestSummary,
    importedAt,
  });
  for (const batch of moasureBatches.rows) {
    measurementBatchIdByKey.set(batch.batch_key, batch.id);
    tables.measurement_batches.push(batch);
  }

  const storageObjects = [];
  const topLevelArtifacts = [
    ["meta.json", "legacy_meta_json"],
    ["transcript.json", "transcript_json"],
    ["transcript-raw.json", "transcript_raw_json"],
    ["tasks.json", "tasks_json"],
    ["report.md", "report_markdown"],
    ["quote-inputs.json", "quote_inputs_json"],
    ["quote-overrides.json", "quote_overrides_json"],
    ["quote.json", "quote_json_current"],
    ["quote.md", "quote_markdown_current"],
    ["quote.pdf", "quote_pdf_current"],
  ];

  const audioFileList = meta.audioFiles || (meta.audioFile ? [meta.audioFile] : []);
  for (let i = audioFileList.length - 1; i >= 0; i--) {
    topLevelArtifacts.unshift([audioFileList[i], i === 0 ? "audio_raw" : `audio_raw_${i}`]);
  }

  for (const [relativeArtifactPath, objectRole] of topLevelArtifacts) {
    const absolutePath = join(jobDir, relativeArtifactPath);
    if (!existsSync(absolutePath)) continue;
    storageObjects.push(await makeStorageObjectRow({
      absolutePath,
      sourceRoot,
      objectRole,
      jobId,
      captureId,
      quoteId,
      quoteVersionId: null,
      measurementBatchId: null,
      metadata: {
        legacyPathType: "top_level",
        jobId: meta.id,
      },
    }));
  }

  const jobStateFiles = [
    ["job-state/details.json", "legacy_job_details_json"],
    ["job-state/gaps.json", "legacy_job_gaps_json"],
    ["job-state/activity.jsonl", "legacy_job_activity_jsonl"],
    ["job-workspace/chat/index.json", "legacy_chat_index_json"],
    ["job-workspace/chat/lanes.json", "legacy_chat_lanes_json"],
    ["job-workspace/chat/events.jsonl", "legacy_chat_events_jsonl"],
  ];
  for (const [relativeArtifactPath, objectRole] of jobStateFiles) {
    const absolutePath = join(jobDir, relativeArtifactPath);
    if (!existsSync(absolutePath)) continue;
    storageObjects.push(await makeStorageObjectRow({
      absolutePath,
      sourceRoot,
      objectRole,
      jobId,
      captureId,
      quoteId,
      quoteVersionId: null,
      measurementBatchId: null,
      metadata: {
        legacyPathType: "state_or_chat",
        jobId: meta.id,
      },
    }));
  }

  for (const thread of chatThreadsPayload) {
    const absolutePath = join(jobDir, "job-workspace", "chat", "threads", `${thread.id}.json`);
    if (!existsSync(absolutePath)) continue;
    storageObjects.push(await makeStorageObjectRow({
      absolutePath,
      sourceRoot,
      objectRole: "legacy_chat_thread_json",
      jobId,
      captureId,
      quoteId,
      quoteVersionId: null,
      measurementBatchId: null,
      metadata: {
        threadId: thread.id,
      },
    }));
  }

  for (const versionFile of quoteVersionFiles) {
    const versionId = stableUuid(`quote-version:${meta.id}:${versionFile.versionNumber}`);
    for (const file of versionFile.files) {
      const absolutePath = join(versionFile.sourcePath, file.name);
      if (!existsSync(absolutePath)) continue;
      storageObjects.push(await makeStorageObjectRow({
        absolutePath,
        sourceRoot,
        objectRole: inferQuoteVersionObjectRole(file.name),
        jobId,
        captureId,
        quoteId,
        quoteVersionId: versionId,
        measurementBatchId: null,
        metadata: {
          versionNumber: versionFile.versionNumber,
          versionLabel: versionFile.versionLabel,
        },
      }));
    }
  }

  for (const object of moasureBatches.storageObjects) {
    storageObjects.push(await makeStorageObjectRow({
      absolutePath: object.absolutePath,
      sourceRoot,
      objectRole: object.objectRole,
      jobId,
      captureId,
      quoteId,
      quoteVersionId: null,
      measurementBatchId: measurementBatchIdByKey.get(object.batchKey) || null,
      metadata: object.metadata,
    }));
  }

  tables.storage_objects.push(...storageObjects);

  if (seedBackupJobs) {
    for (const object of storageObjects) {
      if (!isDriveBackupCandidate(object.object_role)) continue;
      const backupIdempotencyKey = `gdrive:${object.storage_key}`;
      tables.backup_jobs.push({
        id: stableUuid(`backup:${backupIdempotencyKey}`),
        idempotency_key: backupIdempotencyKey,
        job_id: object.job_id,
        capture_id: object.capture_id,
        quote_version_id: object.quote_version_id,
        measurement_batch_id: object.measurement_batch_id,
        storage_object_id: object.id,
        target: "google_drive",
        operation: "backup_object",
        status: "pending",
        priority: inferBackupPriority(object.object_role),
        attempt_count: 0,
        scheduled_at: importedAt,
        started_at: null,
        finished_at: null,
        next_attempt_at: null,
        payload: {
          sourceStorageKey: object.storage_key,
          sourceBackend: object.storage_backend,
          sourcePath: object.source_path,
          relativePath: object.relative_path,
          objectRole: object.object_role,
          driveExportMode: inferDriveExportMode(object.object_role),
          note: "Additive DB-lane seed only. Live runtime remains folder-backed.",
        },
        last_error: null,
        created_at: importedAt,
        updated_at: importedAt,
      });
    }
  }

  return {
    sourceRoot,
    importedAt,
    seedBackupJobs,
    tables,
    summary: {
      recordingCount: 1,
      tableCounts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    },
  };
}

// First statement of every import: stop before anything is written when the
// target is a database Field's server migrates (server/db-runtime/ records its
// Drizzle migrations in drizzle.__drizzle_migrations). Both schemas define a
// `quotes` table with different columns, so this import must never reach
// Field's own database. psql -v ON_ERROR_STOP=1 stops at the raised error.
export const REFUSE_FIELD_DATABASE_SQL = `DO $$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'backfill-db: refusing to write: this database has drizzle.__drizzle_migrations, so it is Field''s own database. Use a dedicated, empty database.';
  END IF;
END
$$;`;

export function renderImportSql(bundle, { includeSchemaSql = null } = {}) {
  const statements = [REFUSE_FIELD_DATABASE_SQL];
  if (includeSchemaSql) {
    statements.push(includeSchemaSql.trim());
  }
  statements.push("BEGIN;");

  const tableOrder = [
    ["jobs", ["legacy_recording_id"]],
    ["job_details", ["job_id"]],
    ["captures", ["legacy_recording_id"]],
    ["quotes", ["job_id"]],
    ["quote_versions", ["quote_id", "version_number"]],
    ["gaps", ["job_id", "gap_key"]],
    ["gap_events", ["external_event_key"]],
    ["chat_threads", ["legacy_thread_id"]],
    ["chat_lanes", ["legacy_lane_id"]],
    ["chat_messages", ["external_message_key"]],
    ["measurement_batches", ["capture_id", "batch_key"]],
    ["storage_objects", ["storage_key"]],
    ["backup_jobs", ["idempotency_key"]],
    ["audit_events", ["external_event_key"]],
    ["timeline_events", ["external_event_key"]],
  ];

  for (const [table, conflictColumns] of tableOrder) {
    const rows = bundle.tables[table] || [];
    if (!rows.length) continue;
    for (const row of rows) {
      statements.push(renderUpsert(table, row, conflictColumns));
    }
  }

  statements.push("COMMIT;");
  return `${statements.join("\n\n")}\n`;
}

export function summarizeBundle(bundle) {
  const lines = [
    `Source root: ${bundle.sourceRoot}`,
    `Recordings mapped: ${bundle.summary.recordingCount}`,
  ];

  for (const [table, count] of Object.entries(bundle.summary.tableCounts)) {
    lines.push(`- ${table}: ${count}`);
  }

  return lines.join("\n");
}

export function resolveFieldDataRoot({ cwd = process.cwd(), configPath = process.env.FIELD_CONFIG || DEFAULT_CONFIG_PATH } = {}) {
  const resolvedConfigPath = resolve(cwd, configPath);
  if (existsSync(resolvedConfigPath)) {
    const raw = JSON.parse(readFileSync(resolvedConfigPath, "utf8"));
    if (raw?.dataDir) {
      return resolve(dirnameSafe(resolvedConfigPath), raw.dataDir);
    }
  }

  if (process.env.FIELD_DATA) {
    return resolve(process.env.FIELD_DATA);
  }

  return resolve(DEFAULT_DATA_DIR);
}

async function scanRecordingDirectories(root) {
  const found = [];
  const stack = [root];
  const seen = new Set();

  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    const currentStat = await stat(current).catch(() => null);
    if (!currentStat?.isDirectory()) continue;

    if (existsSync(join(current, "meta.json"))) {
      found.push(current);
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      stack.push(join(current, entry.name));
    }
  }

  return found.sort();
}

async function listQuoteVersions(jobDir) {
  const versionsDir = join(jobDir, "quote-versions");
  const versions = [];
  const versionEntries = await readdir(versionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of versionEntries) {
    if (!entry.isDirectory()) continue;
    const match = /^v(\d+)$/.exec(entry.name);
    if (!match) continue;
    const sourcePath = join(versionsDir, entry.name);
    const quotePayload = await readJson(join(sourcePath, "quote.json"));
    const quoteOverrides = await readJson(join(sourcePath, "quote-overrides.json"));
    versions.push({
      versionNumber: Number(match[1]),
      versionLabel: entry.name,
      quotePayload,
      quoteOverrides,
      generatedAt: quotePayload?.generatedAt || null,
      sourcePath,
      isCurrent: false,
      files: await listFiles(sourcePath),
    });
  }

  if (!versions.length) {
    const currentQuote = await readJson(join(jobDir, "quote.json"));
    if (currentQuote) {
      versions.push({
        versionNumber: toInt(currentQuote.version) || 1,
        versionLabel: `v${String(toInt(currentQuote.version) || 1).padStart(3, "0")}`,
        quotePayload: currentQuote,
        quoteOverrides: await readJson(join(jobDir, "quote-overrides.json")),
        generatedAt: currentQuote.generatedAt || null,
        sourcePath: jobDir,
        isCurrent: true,
        files: await listCurrentQuoteFiles(jobDir),
      });
    }
  }

  versions.sort((a, b) => a.versionNumber - b.versionNumber);
  if (versions.length) {
    versions[versions.length - 1].isCurrent = true;
  }
  return versions;
}

async function collectMoasureBatches({ jobDir, jobId, captureId, latestSummary, importedAt }) {
  const rawDir = join(jobDir, "moasure", "raw");
  const parsedDir = join(jobDir, "moasure", "parsed");
  const rawEntries = await readdir(rawDir, { withFileTypes: true }).catch(() => []);
  const batchKeys = new Set(rawEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  for (const batch of latestSummary?.batches || []) {
    if (batch?.batchId) batchKeys.add(batch.batchId);
  }

  const rows = [];
  const storageObjects = [];
  const orderedBatchKeys = [...batchKeys].sort();

  for (let index = 0; index < orderedBatchKeys.length; index += 1) {
    const batchKey = orderedBatchKeys[index];
    const batchSummary = latestSummary?.batches?.find((item) => item.batchId === batchKey) || null;
    const batchDir = join(rawDir, batchKey);
    const batchId = stableUuid(`measurement-batch:${captureId}:${batchKey}`);
    rows.push({
      id: batchId,
      job_id: jobId,
      capture_id: captureId,
      batch_key: batchKey,
      batch_status: batchSummary
        ? (batchSummary.imports?.length ? "parsed" : "attached")
        : (existsSync(batchDir) ? "attached" : "parsed"),
      scanned_at: latestSummary?.scannedAt || importedAt,
      batch_sequence: index + 1,
      location_hints: latestSummary?.locationHints || null,
      moasure_summary_payload: batchSummary,
      source_path: existsSync(batchDir) ? batchDir : join(parsedDir, "latest.json"),
      created_at: importedAt,
      updated_at: latestSummary?.scannedAt || importedAt,
    });

    const files = await listFiles(batchDir);
    for (const file of files) {
      storageObjects.push({
        absolutePath: join(batchDir, file.name),
        objectRole: "moasure_raw",
        batchKey,
        metadata: {
          batchKey,
          sourceType: "raw_moasure",
        },
      });
    }
  }

  const latestJsonPath = join(parsedDir, "latest.json");
  const latestMarkdownPath = join(parsedDir, "latest.md");
  const latestBatchKey = latestSummary?.latestBatchId || orderedBatchKeys[orderedBatchKeys.length - 1] || null;
  if (existsSync(latestJsonPath)) {
    storageObjects.push({
      absolutePath: latestJsonPath,
      objectRole: "moasure_parsed_json",
      batchKey: latestBatchKey,
      metadata: {
        sourceType: "parsed_moasure_summary",
      },
    });
  }
  if (existsSync(latestMarkdownPath)) {
    storageObjects.push({
      absolutePath: latestMarkdownPath,
      objectRole: "moasure_parsed_markdown",
      batchKey: latestBatchKey,
      metadata: {
        sourceType: "parsed_moasure_summary_markdown",
      },
    });
  }

  return { rows, storageObjects };
}

async function readThreadFiles(threadsDir) {
  const entries = await readdir(threadsDir, { withFileTypes: true }).catch(() => []);
  const threads = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const payload = await readJson(join(threadsDir, entry.name));
    if (payload) threads.push(payload);
  }
  return threads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listCurrentQuoteFiles(jobDir) {
  const names = ["quote.json", "quote.md", "quote.pdf", "quote-overrides.json"];
  return names.filter((name) => existsSync(join(jobDir, name))).map((name) => ({ name }));
}

async function makeStorageObjectRow({
  absolutePath,
  sourceRoot,
  objectRole,
  jobId,
  captureId,
  quoteId = null,
  quoteVersionId = null,
  measurementBatchId = null,
  metadata = {},
}) {
  const fileStat = await stat(absolutePath);
  const relativePath = normalizePath(relative(sourceRoot, absolutePath));
  const storageKey = buildStorageKey({
    relativePath,
    objectRole,
    quoteVersionId,
    measurementBatchId,
  });
  return {
    id: stableUuid(`storage:${storageKey}`),
    storage_key: storageKey,
    job_id: jobId,
    capture_id: captureId,
    quote_id: quoteId,
    quote_version_id: quoteVersionId,
    measurement_batch_id: measurementBatchId,
    object_role: objectRole,
    storage_backend: "local_fs",
    source_path: absolutePath,
    relative_path: relativePath,
    mime_type: inferMimeType(absolutePath),
    size_bytes: fileStat.size,
    checksum_sha256: await sha256File(absolutePath),
    storage_metadata: metadata,
    created_at: fileStat.mtime.toISOString(),
    updated_at: fileStat.mtime.toISOString(),
  };
}

function buildStorageKey({ relativePath, objectRole, quoteVersionId, measurementBatchId }) {
  const suffix = [
    `role=${objectRole}`,
    quoteVersionId ? `quote_version=${quoteVersionId}` : null,
    measurementBatchId ? `measurement_batch=${measurementBatchId}` : null,
  ].filter(Boolean).join("|");
  return `${relativePath}#${suffix}`;
}

function renderUpsert(table, row, conflictColumns) {
  const columns = Object.keys(row);
  const values = columns.map((column) => sqlLiteralForColumn(table, column, row[column])).join(", ");
  const updates = columns
    .filter((column) => !conflictColumns.includes(column))
    .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
    .join(", ");

  return [
    `INSERT INTO ${quoteIdent(table)} (${columns.map((column) => quoteIdent(column)).join(", ")})`,
    `VALUES (${values})`,
    `ON CONFLICT (${conflictColumns.map((column) => quoteIdent(column)).join(", ")}) DO UPDATE SET ${updates};`,
  ].join("\n");
}

function sqlLiteralForColumn(table, column, value) {
  if (JSONB_COLUMNS[table]?.has(column)) {
    return jsonbLiteral(value);
  }
  return sqlLiteral(value);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") {
    return `${escapeSqlString(JSON.stringify(value))}::jsonb`;
  }
  return escapeSqlString(String(value));
}

function jsonbLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `${escapeSqlString(JSON.stringify(value))}::jsonb`;
}

function escapeSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

async function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function pickLatestQuoteVersion({ quote, quoteVersionFiles }) {
  if (quoteVersionFiles.length) {
    return quoteVersionFiles[quoteVersionFiles.length - 1];
  }

  if (quote) {
    return {
      versionNumber: toInt(quote.version) || 1,
      versionLabel: `v${String(toInt(quote.version) || 1).padStart(3, "0")}`,
      quotePayload: quote,
      generatedAt: quote.generatedAt || null,
    };
  }

  return null;
}

function inferQuoteVersionObjectRole(fileName) {
  switch (fileName) {
    case "quote.json":
      return "quote_version_json";
    case "quote.md":
      return "quote_version_markdown";
    case "quote.pdf":
      return "quote_version_pdf";
    case "quote-overrides.json":
      return "quote_version_overrides_json";
    default:
      return "quote_version_artifact";
  }
}

function buildSourceKey(jobDir, sourcePath, suffix) {
  return normalizePath(`${relative(jobDir, join(jobDir, sourcePath))}:${suffix}`);
}

function inferAuditActorKind(kind) {
  if (typeof kind !== "string") return null;
  if (kind.startsWith("chat.user")) return "user";
  if (kind.startsWith("chat.assistant")) return "assistant";
  return "system";
}

function inferAuditActorLabel(kind) {
  if (typeof kind !== "string") return null;
  if (kind.startsWith("chat.user")) return "User";
  if (kind.startsWith("chat.assistant")) return "Assistant";
  return "Field";
}

function findGapIdForEvent(event, { gapIdByLegacyId, gapIdByKey }) {
  if (event.gapId && gapIdByLegacyId.has(String(event.gapId))) {
    return gapIdByLegacyId.get(String(event.gapId));
  }
  const bodyKey = normalizeKey(event.body || event.title || "");
  if (gapIdByKey.has(bodyKey)) return gapIdByKey.get(bodyKey);
  if (event.body && event.body.includes("—")) {
    const field = normalizeKey(event.body.split("—")[0]);
    if (gapIdByKey.has(field)) return gapIdByKey.get(field);
  }
  return null;
}

function synthesizeJobDetails(meta) {
  return {
    siteAddress: meta.siteAddress || null,
    gps: meta.gps || null,
    customer: {
      name: meta.customerName || meta.contactName || null,
    },
    contact: {
      name: meta.contactName || null,
      phone: meta.contactPhone || null,
      email: meta.contactEmail || null,
    },
    quotedBy: {
      name: meta.quotedBy || null,
      completedAt: meta.createdAt || null,
      method: meta.captureMode === "manual" ? "manual quote" : "field recording",
    },
    soilDump: null,
    archivedAt: meta.archivedAt || null,
    archivedReason: meta.archivedReason || null,
    captureCount: Number(meta.captureCount || 1),
  };
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeJsonScalar(value) {
  if (value === undefined) return null;
  return value;
}

function coerceText(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function toMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function chooseLatestTimestamp(values, fallback = new Date().toISOString()) {
  const valid = values.filter(Boolean).map((value) => new Date(value).toISOString());
  return valid.sort().at(-1) || fallback;
}

function dirnameSafe(path) {
  const parts = path.split(sep);
  parts.pop();
  return parts.join(sep) || sep;
}

function normalizePath(value) {
  return String(value || "").split(sep).join("/");
}

function inferMimeType(path) {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".json":
    case ".jsonl":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".csv":
      return "text/csv";
    case ".mfile":
      return "application/octet-stream";
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".webm":
      return "audio/webm";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
    case ".m4a":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}

async function sha256File(path) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function stableUuid(seed) {
  const hash = createHash("sha1").update(`${NAMESPACE}:${seed}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function emptyBundle({ sourceRoot, importedAt, seedBackupJobs }) {
  return {
    sourceRoot,
    importedAt,
    seedBackupJobs,
    tables: {
      jobs: [],
      job_details: [],
      captures: [],
      quotes: [],
      quote_versions: [],
      timeline_events: [],
      gaps: [],
      gap_events: [],
      chat_threads: [],
      chat_messages: [],
      chat_lanes: [],
      measurement_batches: [],
      storage_objects: [],
      backup_jobs: [],
      audit_events: [],
    },
    summary: {
      recordingCount: 0,
      tableCounts: {},
    },
  };
}

function mergeBundle(target, incoming) {
  for (const [table, rows] of Object.entries(incoming.tables)) {
    target.tables[table].push(...rows);
  }
}

function isDriveBackupCandidate(objectRole) {
  return new Set([
    "audio_raw",
    "transcript_json",
    "transcript_raw_json",
    "report_markdown",
    "quote_inputs_json",
    "quote_json_current",
    "quote_markdown_current",
    "quote_pdf_current",
    "quote_version_json",
    "quote_version_markdown",
    "quote_version_pdf",
    "moasure_raw",
    "moasure_parsed_json",
    "moasure_parsed_markdown",
  ]).has(objectRole);
}

function inferBackupPriority(objectRole) {
  switch (objectRole) {
    case "audio_raw":
      return 10;
    case "quote_pdf_current":
    case "quote_version_pdf":
      return 20;
    case "quote_json_current":
    case "quote_version_json":
    case "quote_inputs_json":
      return 30;
    default:
      return 50;
  }
}

function inferDriveExportMode(objectRole) {
  switch (objectRole) {
    case "report_markdown":
    case "quote_markdown_current":
    case "quote_version_markdown":
    case "moasure_parsed_markdown":
      return "convert_to_google_doc";
    default:
      return "binary_or_plain_upload";
  }
}

const JSONB_COLUMNS = {
  jobs: new Set(["job_meta"]),
  job_details: new Set(["gps", "soil_dump", "details_payload"]),
  captures: new Set(["transcript_payload", "transcript_raw_payload", "tasks_payload", "capture_meta"]),
  quotes: new Set(["current_payload", "current_quote_input_payload", "current_quote_overrides_payload"]),
  quote_versions: new Set(["quote_payload", "quote_input_payload", "quote_overrides_payload", "version_notes"]),
  timeline_events: new Set(["before_value", "after_value", "evidence_payload", "event_payload"]),
  gaps: new Set([
    "assumption_value",
    "default_assumption_value",
    "evidence_payload",
    "gap_payload",
  ]),
  gap_events: new Set(["payload"]),
  chat_threads: new Set(["thread_payload"]),
  chat_messages: new Set(["citations", "actions", "message_meta"]),
  chat_lanes: new Set(["lane_metadata"]),
  measurement_batches: new Set(["location_hints", "moasure_summary_payload"]),
  storage_objects: new Set(["storage_metadata"]),
  backup_jobs: new Set(["payload"]),
  audit_events: new Set(["payload"]),
};
