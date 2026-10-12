import { randomUUID } from "node:crypto";
import { existsSync } from "./storage/fs.js";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "./storage/fs-promises.js";
import { basename, join } from "node:path";
import { flushDurableStorage, flushDurableStorageQuietly } from "./storage/durable-hooks.js";
import { reportBackgroundError } from "./observability/sentry.js";

const QUEUE_DIR = ".scheduled-emails";
const MAX_ATTEMPTS = 3;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

function queueDir(dataDir) {
  return join(dataDir, QUEUE_DIR);
}

function recordPath(dataDir, id) {
  return join(queueDir(dataDir), `${id}.json`);
}

function attachmentDir(dataDir, id) {
  return join(queueDir(dataDir), id);
}

function safeAttachmentName(name, index) {
  const cleaned = basename(String(name || `attachment-${index + 1}`))
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .slice(0, 180);
  return `${String(index + 1).padStart(2, "0")}-${cleaned || `attachment-${index + 1}`}`;
}

async function atomicWriteJson(path, value) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

async function readRecord(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// A claim ("sending") must be durable before Gmail is called: if Field died
// after sending but before storing the claim, a rebuilt data directory would
// show the email as still due and send it twice. If the claim cannot be
// stored, the record is put back as it was and nothing is sent.
async function storeClaimDurably(path, claimed, unclaimed) {
  try {
    await flushDurableStorage({ reason: `email ${claimed.id} claim` });
  } catch (error) {
    await atomicWriteJson(path, unclaimed);
    const refused = new Error(`email not sent: its send could not be recorded durably first (${error.message})`);
    refused.statusCode = 503;
    refused.cause = error;
    throw refused;
  }
}

function publicRecord(record) {
  return {
    id: record.id,
    jobId: record.jobId,
    status: record.status,
    lifecycleStatus: record.status === "pending" || record.status === "sending"
      ? "scheduled"
      : record.status,
    scheduledAt: record.scheduledAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sentAt: record.sentAt || null,
    cancelledAt: record.cancelledAt || null,
    unscheduledAt: record.unscheduledAt || null,
    failedAt: record.failedAt || null,
    attemptCount: record.attemptCount || 0,
    lastError: record.lastError || null,
    documentType: record.payload?.documentType || "email",
    to: record.payload?.to || [],
    cc: record.payload?.cc || [],
    bcc: record.payload?.bcc || [],
    subject: record.payload?.subject || null,
    attachmentNames: (record.attachments || []).map((attachment) => attachment.filename),
    // Field documents attached by uid: their references, never their bytes.
    documents: (record.payload?.documents || []).map((document) => ({
      uid: document.uid,
      documentType: document.documentType || null,
      number: document.number || null,
      byteLength: document.byteLength ?? null,
    })),
    quoteVersion: record.snapshot?.quoteVersion ?? null,
    milestoneIndex: record.snapshot?.milestoneIndex ?? null,
    invoiceNumber: record.snapshot?.invoiceNumber ?? null,
    createdBy: record.createdBy || null,
    previewBodyHtml: record.status === "pending" ? record.payload?.customBody || "" : null,
    previewThemeFontFamily: record.status === "pending" ? record.payload?.themeFontFamily || null : null,
    draftContent: record.status === "draft" ? {
      customBody: record.payload?.customBody || "",
      themeFontFamily: record.payload?.themeFontFamily || null,
      attachmentFilename: record.payload?.attachmentFilename || null,
      invoicePaidAmount: record.payload?.invoicePaidAmount ?? null,
    } : null,
  };
}

export function validateScheduledAt(value, { now = Date.now(), minimumLeadMs = 30_000 } = {}) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) {
    const error = new Error("choose a valid send date and time");
    error.statusCode = 400;
    throw error;
  }
  if (timestamp < now + minimumLeadMs) {
    const error = new Error("scheduled send time must be at least 30 seconds in the future");
    error.statusCode = 400;
    throw error;
  }
  return new Date(timestamp).toISOString();
}

export async function createScheduledEmail({
  dataDir,
  jobId,
  scheduledAt,
  payload,
  snapshot = null,
  attachments = [],
  createdBy = null,
  sender = null,
  now = Date.now(),
}) {
  const normalizedScheduledAt = validateScheduledAt(scheduledAt, { now });
  const id = randomUUID();
  const root = queueDir(dataDir);
  const filesDir = attachmentDir(dataDir, id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (attachments.length) await mkdir(filesDir, { recursive: true, mode: 0o700 });

  const storedAttachments = [];
  try {
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const storedName = safeAttachmentName(attachment.filename, index);
      await writeFile(join(filesDir, storedName), attachment.buffer, { mode: 0o600 });
      storedAttachments.push({
        filename: attachment.filename || `attachment-${index + 1}`,
        contentType: attachment.contentType || "application/octet-stream",
        storedName,
        size: attachment.buffer?.length || 0,
      });
    }

    const createdAt = new Date(now).toISOString();
    const record = {
      version: 1,
      id,
      jobId,
      status: "pending",
      scheduledAt: normalizedScheduledAt,
      nextAttemptAt: normalizedScheduledAt,
      createdAt,
      updatedAt: createdAt,
      createdBy,
      sender,
      payload,
      snapshot,
      attachments: storedAttachments,
      attemptCount: 0,
      lastError: null,
    };
    await atomicWriteJson(recordPath(dataDir, id), record);
    return publicRecord(record);
  } catch (error) {
    await rm(filesDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function listScheduledEmails({ dataDir, jobId = null } = {}) {
  const root = queueDir(dataDir);
  if (!existsSync(root)) return [];
  const names = await readdir(root);
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = await readRecord(join(root, name));
      if (!jobId || record.jobId === jobId) records.push(publicRecord(record));
    } catch {
      // A damaged record stays on disk for operator recovery but must not stop
      // other scheduled sends from being listed or processed.
    }
  }
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function returnScheduledEmailToDraft({ dataDir, jobId, id, updatedBy = null, now = Date.now() }) {
  const path = recordPath(dataDir, id);
  const lockPath = `${path}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      const conflict = new Error("scheduled email is already being changed");
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
  try {
    const record = await readRecord(path);
    if (record.jobId !== jobId) {
      const error = new Error("scheduled email not found");
      error.statusCode = 404;
      throw error;
    }
    if (record.status !== "pending") {
      const error = new Error(`only pending emails can be cancelled (currently ${record.status})`);
      error.statusCode = 409;
      throw error;
    }
    const unscheduledAt = new Date(now).toISOString();
    const next = {
      ...record,
      status: "draft",
      nextAttemptAt: null,
      unscheduledAt,
      unscheduledBy: updatedBy,
      cancelledAt: null,
      cancelledBy: null,
      updatedAt: unscheduledAt,
    };
    await atomicWriteJson(path, next);
    return publicRecord(next);
  } finally {
    await handle?.close();
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function storeAdditionalAttachments(dataDir, record, attachments = []) {
  if (!attachments.length) return record.attachments || [];
  const existing = record.attachments || [];
  const filesDir = attachmentDir(dataDir, record.id);
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  const stored = [...existing];
  for (let offset = 0; offset < attachments.length; offset += 1) {
    const attachment = attachments[offset];
    const index = existing.length + offset;
    const storedName = safeAttachmentName(attachment.filename, index);
    await writeFile(join(filesDir, storedName), attachment.buffer, { mode: 0o600 });
    stored.push({
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.contentType || "application/octet-stream",
      storedName,
      size: attachment.buffer?.length || 0,
    });
  }
  return stored;
}

export async function rescheduleEmailDraft({
  dataDir,
  jobId,
  id,
  scheduledAt,
  payload,
  snapshot = null,
  attachments = [],
  sender = null,
  updatedBy = null,
  now = Date.now(),
}) {
  const path = recordPath(dataDir, id);
  const lockPath = `${path}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      const conflict = new Error("email draft is already being changed");
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
  try {
    const record = await readRecord(path);
    if (record.jobId !== jobId || record.status !== "draft") {
      const error = new Error(record.jobId !== jobId ? "email draft not found" : `only drafts can be scheduled (currently ${record.status})`);
      error.statusCode = record.jobId !== jobId ? 404 : 409;
      throw error;
    }
    const normalizedScheduledAt = validateScheduledAt(scheduledAt, { now });
    const updatedAt = new Date(now).toISOString();
    const next = {
      ...record,
      status: "pending",
      scheduledAt: normalizedScheduledAt,
      nextAttemptAt: normalizedScheduledAt,
      updatedAt,
      updatedBy,
      sender: sender || record.sender || null,
      payload,
      snapshot,
      attachments: await storeAdditionalAttachments(dataDir, record, attachments),
      unscheduledAt: null,
      unscheduledBy: null,
      failedAt: null,
      lastError: null,
    };
    await atomicWriteJson(path, next);
    return publicRecord(next);
  } finally {
    await handle?.close();
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

export async function sendEmailDraftNow({
  dataDir,
  jobId,
  id,
  payload,
  snapshot = null,
  attachments = [],
  sender = null,
  updatedBy = null,
  processEmail,
  now = Date.now(),
}) {
  const path = recordPath(dataDir, id);
  const lockPath = `${path}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      const conflict = new Error("email draft is already being changed");
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
  try {
    let record = await readRecord(path);
    const unclaimed = record;
    if (record.jobId !== jobId || record.status !== "draft") {
      const error = new Error(record.jobId !== jobId ? "email draft not found" : `only drafts can be sent (currently ${record.status})`);
      error.statusCode = record.jobId !== jobId ? 404 : 409;
      throw error;
    }
    const claimedAt = new Date(now).toISOString();
    record = {
      ...record,
      status: "sending",
      scheduledAt: null,
      nextAttemptAt: null,
      claimedAt,
      updatedAt: claimedAt,
      updatedBy,
      sender: sender || record.sender || null,
      payload,
      snapshot,
      attachments: await storeAdditionalAttachments(dataDir, record, attachments),
      attemptCount: Number(record.attemptCount || 0) + 1,
      unscheduledAt: null,
      unscheduledBy: null,
      failedAt: null,
      lastError: null,
    };
    await atomicWriteJson(path, record);
    await storeClaimDurably(path, record, unclaimed);
    try {
      const result = await processEmail({
        ...record,
        loadedAttachments: await loadAttachments(dataDir, record),
      });
      const sentAt = new Date(now).toISOString();
      const sent = {
        ...record,
        status: "sent",
        sentAt,
        updatedAt: sentAt,
        result: result ? { messageId: result.id || null, threadId: result.threadId || null } : null,
      };
      await atomicWriteJson(path, sent);
      await flushDurableStorageQuietly({ reason: `email ${record.id} sent` });
      return { scheduledEmail: publicRecord(sent), result };
    } catch (error) {
      const failedAt = new Date(now).toISOString();
      const safeToRetry = error?.safeToRetry === true;
      await atomicWriteJson(path, {
        ...record,
        status: safeToRetry ? "draft" : "failed",
        failedAt: safeToRetry ? null : failedAt,
        updatedAt: failedAt,
        lastError: error?.message || "email send failed",
      });
      throw error;
    }
  } finally {
    await handle?.close();
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function loadAttachments(dataDir, record) {
  const root = attachmentDir(dataDir, record.id);
  return Promise.all((record.attachments || []).map(async (attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    buffer: await readFile(join(root, attachment.storedName)),
  })));
}

function retryDelayMs(attemptCount) {
  return Math.min(60_000 * (2 ** Math.max(0, attemptCount - 1)), 15 * 60_000);
}

export async function recoverInterruptedScheduledEmails({ dataDir, now = Date.now() } = {}) {
  const root = queueDir(dataDir);
  if (!existsSync(root)) return 0;
  let recovered = 0;
  for (const name of await readdir(root)) {
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    try {
      const record = await readRecord(path);
      if (record.status !== "sending") {
        await rm(`${path}.lock`, { force: true }).catch(() => {});
        continue;
      }
      const failedAt = new Date(now).toISOString();
      await atomicWriteJson(path, {
        ...record,
        status: "failed",
        failedAt,
        updatedAt: failedAt,
        lastError: "Field restarted while Gmail delivery was in progress. Delivery was not retried automatically to avoid sending a duplicate; verify Sent Mail before retrying.",
      });
      await rm(`${path}.lock`, { force: true }).catch(() => {});
      recovered += 1;
    } catch {
      // Leave malformed records untouched for operator recovery.
    }
  }
  return recovered;
}

export async function processDueScheduledEmails({ dataDir, processEmail, logger = console, now = Date.now() }) {
  const root = queueDir(dataDir);
  if (!existsSync(root)) return { processed: 0 };
  let processed = 0;
  for (const name of await readdir(root)) {
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    const lockPath = `${path}.lock`;
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }

    try {
      let record = await readRecord(path);
      const unclaimed = record;
      const dueAt = Date.parse(record.nextAttemptAt || record.scheduledAt || "");
      if (record.status !== "pending" || !Number.isFinite(dueAt) || dueAt > now) continue;

      const claimedAt = new Date(now).toISOString();
      record = {
        ...record,
        status: "sending",
        claimedAt,
        updatedAt: claimedAt,
        attemptCount: Number(record.attemptCount || 0) + 1,
      };
      await atomicWriteJson(path, record);
      await storeClaimDurably(path, record, unclaimed);

      try {
        const result = await processEmail({
          ...record,
          loadedAttachments: await loadAttachments(dataDir, record),
        });
        const sentAt = new Date(now).toISOString();
        await atomicWriteJson(path, {
          ...record,
          status: "sent",
          sentAt,
          updatedAt: sentAt,
          lastError: null,
          result: result ? { messageId: result.id || null, threadId: result.threadId || null } : null,
        });
        processed += 1;
      } catch (error) {
        const failedAt = new Date(now).toISOString();
        const retryable = error?.safeToRetry === true && record.attemptCount < MAX_ATTEMPTS;
        await atomicWriteJson(path, {
          ...record,
          status: retryable ? "pending" : "failed",
          failedAt: retryable ? null : failedAt,
          nextAttemptAt: retryable
            ? new Date(Date.parse(failedAt) + retryDelayMs(record.attemptCount)).toISOString()
            : record.nextAttemptAt,
          updatedAt: failedAt,
          lastError: error?.message || "scheduled email failed",
        });
        logger.error?.(`[scheduled-email] ${record.id} failed: ${error?.message || error}`);
        reportBackgroundError(error, { area: "scheduled-email", stage: "send", willRetry: retryable });
      }
    } catch (error) {
      logger.error?.(`[scheduled-email] could not read or update ${name}: ${error?.message || error}`);
      reportBackgroundError(error, { area: "scheduled-email", stage: "queue" });
    } finally {
      await handle?.close();
      await rm(lockPath, { force: true }).catch(() => {});
    }
  }
  return { processed };
}

export async function startScheduledEmailScheduler({
  dataDir,
  processEmail,
  logger = console,
  initialDelayMs = 1_000,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  await mkdir(queueDir(dataDir), { recursive: true, mode: 0o700 });
  const recovered = await recoverInterruptedScheduledEmails({ dataDir });
  if (recovered) logger.warn?.(`[scheduled-email] marked ${recovered} interrupted send(s) for manual review`);

  let stopped = false;
  let running = false;
  let initialTimer;
  let intervalTimer;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await processDueScheduledEmails({ dataDir, processEmail, logger });
    } catch (error) {
      logger.error?.(`[scheduled-email] scheduler failed: ${error.message}`);
      reportBackgroundError(error, { area: "scheduled-email", stage: "scheduler" });
    } finally {
      // Scheduler tick: store whatever background work wrote.
      await flushDurableStorageQuietly({ reason: "scheduler tick", logger });
      running = false;
    }
  };
  initialTimer = setTimeout(run, initialDelayMs);
  intervalTimer = setInterval(run, pollIntervalMs);
  initialTimer.unref?.();
  intervalTimer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    runNow: run,
  };
}
