import { randomUUID } from "node:crypto";
import { existsSync } from "./storage/fs.js";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "./storage/fs-promises.js";
import { basename, join } from "node:path";
import { flushDurableStorage, flushDurableStorageQuietly } from "./storage/durable-hooks.js";
import { reportBackgroundError } from "./observability/sentry.js";

const QUEUE_DIR = ".scheduled-emails";
const MAX_ATTEMPTS = 3;
// Undo send (owner's decision 3, 2026-10-13): Send holds the email in this
// queue for a few seconds, and Undo is Cancel send. The hold is the only
// schedule allowed sooner than the 30 second minimum.
export const MAX_HOLD_SECONDS = 30;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

function queueDir(dataDir) {
  return join(dataDir, QUEUE_DIR);
}

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Record ids come from randomUUID; anything else (a draftId from a request)
// is refused before it becomes part of a path.
function recordPath(dataDir, id) {
  if (!RECORD_ID.test(String(id || ""))) {
    const error = new Error("email not found");
    error.statusCode = 404;
    throw error;
  }
  return join(queueDir(dataDir), `${id}.json`);
}

// What a failed send did. "rejected": provably before Gmail took the message
// (Field refused it first, or Gmail answered with a 4xx), so it can be sent
// again. "unknown": a time-out, a network reset, a 5xx, a restart while
// sending, or anything else; Gmail may have sent it, so it is not sent again
// until Sent Mail is checked for its Message-ID.
export function classifyDeliveryFailure(error) {
  if (error?.code === "DELIVERY_OUTCOME_UNKNOWN") return "unknown";
  if (error?.deliveryOutcome === "rejected_before_dispatch") return "rejected";
  const status = Number(error?.response?.status ?? error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) return "rejected";
  return "unknown";
}

/** A failed record's outcome; a record failed before outcomes were kept is unknown. */
function failureOutcome(record) {
  if (record.status !== "failed") return null;
  return record.deliveryOutcome === "rejected" ? "rejected" : "unknown";
}

/**
 * Can a failed record be sent again? "allowed" after a rejection.
 * "checks-sent-mail" when the outcome is unknown and Field can check Sent
 * Mail first: a document send (its delivery outbox reconciles by Message-ID)
 * or a job email with a stored delivery attempt id. "blocked" otherwise.
 */
function resendPolicy(record) {
  const outcome = failureOutcome(record);
  if (!outcome) return null;
  if (outcome === "rejected") return "allowed";
  if (record.payload?.kind === "document" || record.deliveryAttemptId) return "checks-sent-mail";
  return "blocked";
}

// Gmail's Sent Mail search can lag behind a message it accepted moments ago,
// so "not found" counts only this long after the failed attempt.
export const RESEND_SETTLE_MS = 5 * 60_000;

/** When a job email whose earlier attempt is unknown may go again, or null. */
function resendAllowedAt(record) {
  if (record.reconcileBeforeSend !== true || record.payload?.kind === "document") return null;
  const failed = Date.parse(record.unknownFailureAt || "");
  return Number.isFinite(failed) ? failed + RESEND_SETTLE_MS : null;
}

function assertResendSettled(record, dueAtMs) {
  const allowedAt = resendAllowedAt(record);
  if (allowedAt != null && dueAtMs < allowedAt) {
    const error = new Error("Gmail may still be delivering this email. Try again in a few minutes.");
    error.statusCode = 409;
    error.code = "DELIVERY_STILL_SETTLING";
    error.retryAfter = new Date(allowedAt).toISOString();
    throw error;
  }
}

/**
 * The delivery identity a claim carries. While an earlier attempt's outcome
 * is unknown, the attempt keeps the mailbox it first went from (the person
 * who sent it, not whoever edits it later), its full Message-ID and what it
 * sent; Sent Mail is searched there, and a resend goes only from there.
 */
function claimIdentity(record, sender) {
  const reconciling = record.reconcileBeforeSend === true;
  return {
    deliveryAttemptId: record.deliveryAttemptId || randomUUID(),
    deliverySender: reconciling ? record.deliverySender || record.sender || null : sender || record.sender || null,
    deliveryMailbox: reconciling ? record.deliveryMailbox || null : null,
    deliveryMessageId: reconciling ? record.deliveryMessageId || null : null,
    firstSent: reconciling ? record.firstSent || null : null,
  };
}

/**
 * What a failure leaves on the record. A failure while an earlier attempt is
 * still unknown stays unknown (a refusal, or a 4xx from the Sent Mail search,
 * says nothing about whether the first one went).
 */
function failureState(record, error, failedAt) {
  const reconciling = record.reconcileBeforeSend === true;
  const classified = classifyDeliveryFailure(error);
  const outcome = reconciling ? "unknown" : classified;
  return {
    deliveryOutcome: outcome,
    reconcileBeforeSend: reconciling || outcome === "unknown",
    // The last time Gmail may have taken it; a refusal before dispatch keeps the earlier time.
    unknownFailureAt: outcome !== "unknown"
      ? null
      : classified === "rejected" && record.unknownFailureAt ? record.unknownFailureAt : failedAt,
  };
}

function sentResult(result) {
  if (!result) return null;
  return { messageId: result.id || null, threadId: result.threadId || null, ...(result.reconciled ? { reconciled: true } : {}) };
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
    // A held send (Undo send): due in seconds, shown as Sending, not Scheduled.
    held: record.held === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sentAt: record.sentAt || null,
    cancelledAt: record.cancelledAt || null,
    unscheduledAt: record.unscheduledAt || null,
    failedAt: record.failedAt || null,
    attemptCount: record.attemptCount || 0,
    lastError: record.lastError || null,
    deliveryOutcome: failureOutcome(record),
    resend: resendPolicy(record),
    // A job email whose earlier attempt is unknown: not before this time.
    resendAfter: resendAllowedAt(record) ? new Date(resendAllowedAt(record)).toISOString() : null,
    // The mailbox an unknown earlier attempt went from; a resend goes only from it.
    deliveryMailbox: record.reconcileBeforeSend === true ? record.deliveryMailbox || null : null,
    // Found in Sent Mail: the first attempt had gone, so nothing (no edit) was sent again.
    reconciled: record.result?.reconciled === true,
    // Sent Mail is checked for an earlier attempt before this one goes.
    checksSentMail: record.reconcileBeforeSend === true,
    documentType: record.payload?.documentType || "email",
    to: record.payload?.to || [],
    cc: record.payload?.cc || [],
    bcc: record.payload?.bcc || [],
    subject: record.payload?.subject || null,
    attachmentNames: (record.attachments || []).map((attachment) => attachment.filename),
    attachments: (record.attachments || []).map((attachment) => ({ filename: attachment.filename, size: attachment.size || 0, contentType: attachment.contentType || null })),
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
    draftContent: record.status === "draft" || record.status === "failed" ? {
      customBody: record.payload?.customBody || "",
      themeFontFamily: record.payload?.themeFontFamily || null,
      attachmentFilename: record.payload?.attachmentFilename || null,
      invoicePaidAmount: record.payload?.invoicePaidAmount ?? null,
      attachCreditNote: record.payload?.attachCreditNote === true,
      inReplyTo: record.payload?.inReplyTo || null,
      adjustmentNote: record.payload?.adjustmentNote || null,
    } : null,
  };
}

/** A hold (Undo send) in seconds, or null. 0 to MAX_HOLD_SECONDS. */
export function normalizeHoldSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_HOLD_SECONDS) {
    const error = new Error(`holdSeconds must be between 0 and ${MAX_HOLD_SECONDS}`);
    error.statusCode = 400;
    throw error;
  }
  return Math.round(seconds);
}

/** When a send is due: a hold from now, else a validated schedule time. */
function dueAt({ scheduledAt, holdSeconds = null, now }) {
  const hold = normalizeHoldSeconds(holdSeconds);
  if (hold != null) return { at: new Date(now + hold * 1000).toISOString(), held: true };
  return { at: validateScheduledAt(scheduledAt, { now }), held: false };
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
  holdSeconds = null,
}) {
  const due = dueAt({ scheduledAt, holdSeconds, now });
  const normalizedScheduledAt = due.at;
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
      held: due.held,
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

/**
 * Save an email as a draft on the server (new, or an existing draft
 * updated), with its uploads, so nothing is lost when the page is left or
 * Gmail sign-in redirects away. `keepAttachments` names the stored uploads
 * to keep (all when not given); `attachments` are new uploads.
 */
export async function saveEmailDraft({
  dataDir,
  jobId,
  id = null,
  payload,
  snapshot = null,
  attachments = [],
  keepAttachments = null,
  sender = null,
  updatedBy = null,
  now = Date.now(),
}) {
  const root = queueDir(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const savedAt = new Date(now).toISOString();
  if (!id) {
    const created = {
      version: 1,
      id: randomUUID(),
      jobId,
      status: "draft",
      scheduledAt: null,
      nextAttemptAt: null,
      createdAt: savedAt,
      updatedAt: savedAt,
      createdBy: updatedBy,
      sender,
      payload,
      snapshot,
      attachments: [],
      attemptCount: 0,
      lastError: null,
    };
    created.attachments = await storeAdditionalAttachments(dataDir, created, attachments);
    await atomicWriteJson(recordPath(dataDir, created.id), created);
    return publicRecord(created);
  }
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
    if (record.jobId !== jobId || !["draft", "failed"].includes(record.status)) {
      const error = new Error(record.jobId !== jobId ? "email draft not found" : `only drafts can be saved (currently ${record.status})`);
      error.statusCode = record.jobId !== jobId ? 404 : 409;
      throw error;
    }
    // A failed send whose outcome is unknown stays guarded as a draft: it is
    // sent again only after Field checks Sent Mail, or not at all.
    const resend = resendPolicy(record);
    if (resend === "blocked") {
      const error = new Error("Field could not tell whether Gmail sent this email. Check Sent Mail; if it is not there, write it again as a new email.");
      error.statusCode = 409;
      error.code = "DELIVERY_OUTCOME_UNKNOWN";
      throw error;
    }
    const kept = Array.isArray(keepAttachments)
      ? (record.attachments || []).filter((attachment) => keepAttachments.includes(attachment.storedName) || keepAttachments.includes(attachment.filename))
      : record.attachments || [];
    for (const dropped of (record.attachments || []).filter((attachment) => !kept.includes(attachment))) {
      await rm(join(attachmentDir(dataDir, id), dropped.storedName), { force: true }).catch(() => {});
    }
    const next = {
      ...record,
      status: "draft",
      updatedAt: savedAt,
      updatedBy,
      sender: sender || record.sender || null,
      payload,
      snapshot,
      attachments: kept,
      failedAt: null,
      reconcileBeforeSend: resend === "checks-sent-mail" || record.reconcileBeforeSend === true,
    };
    next.attachments = await storeAdditionalAttachments(dataDir, next, attachments);
    await atomicWriteJson(path, next);
    return publicRecord(next);
  } finally {
    await handle?.close();
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/** Discard a draft: it is marked cancelled and its uploads are deleted. */
export async function discardEmailDraft({ dataDir, jobId, id, updatedBy = null, now = Date.now() }) {
  const path = recordPath(dataDir, id);
  const record = await readRecord(path);
  if (record.jobId !== jobId || !["draft", "failed"].includes(record.status)) {
    const error = new Error(record.jobId !== jobId ? "email draft not found" : `only drafts can be discarded (currently ${record.status})`);
    error.statusCode = record.jobId !== jobId ? 404 : 409;
    throw error;
  }
  const at = new Date(now).toISOString();
  const next = { ...record, status: "cancelled", cancelledAt: at, cancelledBy: updatedBy, updatedAt: at, attachments: [] };
  await rm(attachmentDir(dataDir, id), { recursive: true, force: true }).catch(() => {});
  await atomicWriteJson(path, next);
  return publicRecord(next);
}

export async function returnScheduledEmailToDraft({ dataDir, jobId, id, updatedBy = null, now = Date.now(), lockWaitMs = 3_000 }) {
  const path = recordPath(dataDir, id);
  const lockPath = `${path}.lock`;
  let handle;
  // Undo send: the scheduler locks every record for a moment while it scans
  // the queue. Wait that out while the email is still pending; give up at
  // once when it is already sending.
  const giveUpAt = Date.now() + lockWaitMs;
  for (;;) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const current = await readRecord(path).catch(() => null);
      if (current && current.status !== "pending") {
        const tooLate = new Error(`only pending emails can be cancelled (currently ${current.status})`);
        tooLate.statusCode = 409;
        throw tooLate;
      }
      if (Date.now() >= giveUpAt) {
        const conflict = new Error("scheduled email is already being changed");
        conflict.statusCode = 409;
        throw conflict;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
      held: false,
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
  // Stored names are numbered; after a removal, keep counting past the highest.
  const start = Math.max(existing.length, ...existing.map((attachment) => Number.parseInt(attachment.storedName, 10) || 0));
  for (let offset = 0; offset < attachments.length; offset += 1) {
    const attachment = attachments[offset];
    const index = start + offset;
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
  holdSeconds = null,
  keepAttachments = null,
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
    if (record.jobId !== jobId || !["draft", "failed"].includes(record.status)) {
      const error = new Error(record.jobId !== jobId ? "email draft not found" : `only drafts can be scheduled (currently ${record.status})`);
      error.statusCode = record.jobId !== jobId ? 404 : 409;
      throw error;
    }
    // A send whose outcome is unknown goes again only when Field checks
    // Sent Mail for it first (its stored Message-ID); never blindly.
    const resend = resendPolicy(record);
    if (resend === "blocked") {
      const error = new Error("Field could not tell whether Gmail sent this email. Check Sent Mail; if it is not there, write it again as a new email.");
      error.statusCode = 409;
      error.code = "DELIVERY_OUTCOME_UNKNOWN";
      throw error;
    }
    const due = dueAt({ scheduledAt, holdSeconds, now });
    const normalizedScheduledAt = due.at;
    if (resend === "checks-sent-mail" || record.reconcileBeforeSend === true) {
      assertResendSettled({ ...record, reconcileBeforeSend: true, payload }, Date.parse(normalizedScheduledAt));
    }
    const kept = Array.isArray(keepAttachments)
      ? (record.attachments || []).filter((attachment) => keepAttachments.includes(attachment.storedName) || keepAttachments.includes(attachment.filename))
      : record.attachments || [];
    const updatedAt = new Date(now).toISOString();
    const next = {
      ...record,
      status: "pending",
      scheduledAt: normalizedScheduledAt,
      nextAttemptAt: normalizedScheduledAt,
      held: due.held,
      updatedAt,
      updatedBy,
      sender: sender || record.sender || null,
      payload,
      snapshot,
      attachments: await storeAdditionalAttachments(dataDir, { ...record, attachments: kept }, attachments),
      unscheduledAt: null,
      unscheduledBy: null,
      failedAt: null,
      lastError: null,
      deliveryOutcome: null,
      // The earlier attempt may have gone: look for it in Sent Mail first.
      reconcileBeforeSend: resend === "checks-sent-mail" || record.reconcileBeforeSend === true,
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
    assertResendSettled({ ...record, payload }, now);
    const claimedAt = new Date(now).toISOString();
    record = {
      ...record,
      ...claimIdentity(record, sender),
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
      deliveryOutcome: null,
    };
    await atomicWriteJson(path, record);
    await storeClaimDurably(path, record, unclaimed);
    const claim = openClaim(path, record);
    try {
      let result;
      try {
        result = await processEmail({
          ...record,
          loadedAttachments: await loadAttachments(dataDir, record),
          stampDelivery: claim.stampDelivery,
        });
      } finally {
        record = await claim.close();
      }
      const sentAt = new Date(now).toISOString();
      const sent = {
        ...record,
        status: "sent",
        sentAt,
        updatedAt: sentAt,
        result: sentResult(result),
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
        ...(safeToRetry ? { deliveryOutcome: null } : failureState(record, error, failedAt)),
      });
      throw error;
    }
  } finally {
    await handle?.close();
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

function staleAttemptError() {
  const error = new Error("email not sent: this send attempt was already given up (it passed the Gmail send ceiling), so it cannot go now");
  error.code = "DELIVERY_ATTEMPT_STALE";
  error.deliveryOutcome = "rejected_before_dispatch";
  return error;
}

/**
 * One claimed attempt. Its record lock is held while the send runs; when the
 * send settles (or the Gmail send ceiling gives up on it), close() ends the
 * claim, waits for a stamp in progress and returns the record as stored.
 * A stamp after that (a send the ceiling stopped waiting for, carrying on
 * after a slow profile lookup or token refresh) is refused, so that stale
 * send never reaches Gmail and never rewrites a record that has since
 * failed, been edited or been claimed again.
 */
function openClaim(path, record) {
  const claim = { open: true, record, stamping: null };
  return {
    stampDelivery: async (identity) => {
      const run = storeDeliveryIdentity(path, claim, identity);
      claim.stamping = run;
      return run;
    },
    close: async () => {
      claim.open = false;
      await claim.stamping?.catch(() => {});
      return claim.record;
    },
  };
}

/**
 * Called by the send just before Gmail, once per attempt that has no identity
 * yet: the mailbox it goes from, its full Message-ID and what it sends (To,
 * Cc, Bcc, subject, body). Stored durably first, so a later Sent Mail check
 * searches that mailbox for that Message-ID, and a match archives what was
 * actually sent, not a later edit. Refused (before Gmail) unless this claim
 * is still open and the stored record is still this claim's send.
 */
async function storeDeliveryIdentity(path, claim, { mailbox = null, messageId = null, sent = null } = {}) {
  if (!claim.open) throw staleAttemptError();
  const current = await readRecord(path).catch(() => null);
  if (!claim.open || current?.status !== "sending" || current.claimedAt !== claim.record.claimedAt) throw staleAttemptError();
  if (claim.record.deliveryMessageId) return claim.record;
  const stamped = { ...claim.record, deliveryMailbox: mailbox || null, deliveryMessageId: messageId || null, firstSent: sent || null };
  await atomicWriteJson(path, stamped);
  claim.record = stamped;
  try {
    await flushDurableStorage({ reason: `email ${stamped.id} delivery identity` });
  } catch (error) {
    const refused = new Error(`email not sent: its Message-ID could not be recorded durably first (${error.message})`);
    refused.statusCode = 503;
    refused.deliveryOutcome = "rejected_before_dispatch";
    throw refused;
  }
  // The ceiling may have given up while the identity was being stored.
  if (!claim.open) throw staleAttemptError();
  return stamped;
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
        deliveryOutcome: "unknown",
        reconcileBeforeSend: true,
        unknownFailureAt: record.claimedAt || failedAt,
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
        ...claimIdentity(record, record.sender),
      };
      await atomicWriteJson(path, record);
      await storeClaimDurably(path, record, unclaimed);

      const claim = openClaim(path, record);
      try {
        let result;
        try {
          result = await processEmail({
            ...record,
            loadedAttachments: await loadAttachments(dataDir, record),
            stampDelivery: claim.stampDelivery,
          });
        } finally {
          record = await claim.close();
        }
        const sentAt = new Date(now).toISOString();
        await atomicWriteJson(path, {
          ...record,
          status: "sent",
          sentAt,
          updatedAt: sentAt,
          lastError: null,
          result: sentResult(result),
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
          ...(retryable ? { deliveryOutcome: null } : failureState(record, error, failedAt)),
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
