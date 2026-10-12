import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "./storage/fs-promises.js";
import { join } from "node:path";
import { assertWritableJobDir, resolveActiveJobGeneration, runAtomicJobGeneration } from "./job-generation.js";
import { flushDurableStorage } from "./storage/durable-hooks.js";

export const QUOTE_DELIVERY_OUTBOX_FILE = "quote-delivery-outbox.json";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encodeBytes(value) {
  return Buffer.isBuffer(value) ? value.toString("base64") : Buffer.from(String(value || "")).toString("base64");
}

function decodeBytes(value) {
  return Buffer.from(String(value || ""), "base64");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function readPendingQuoteDelivery(jobDir) {
  const activeDir = await resolveActiveJobGeneration(jobDir);
  const payload = await readJson(join(activeDir, QUOTE_DELIVERY_OUTBOX_FILE));
  return payload?.status === "completed" ? null : payload;
}

export function buildQuoteDeliveryAttempt({
  quoteVersion,
  documentType = "quote",
  to,
  cc = [],
  subject = null,
  quoteMarkdown,
  reportMarkdown,
  quotePdf,
  preparedQuote = null,
  preparedMeta = null,
} = {}) {
  const quotePdfBytes = Buffer.isBuffer(quotePdf) ? quotePdf : Buffer.from(quotePdf || "");
  const quoteMarkdownBytes = Buffer.from(String(quoteMarkdown || ""));
  const reportMarkdownBytes = Buffer.from(String(reportMarkdown || ""));
  const attemptId = randomUUID();
  return {
    version: 1,
    revision: 0,
    attemptId,
    messageId: `<field-${attemptId}@arcforge.local>`,
    status: "pending",
    claim: null,
    createdAt: new Date().toISOString(),
    quoteVersion: Number(quoteVersion) || null,
    documentType,
    to: Array.isArray(to) ? to : [to].filter(Boolean),
    cc: Array.isArray(cc) ? cc : [],
    subject: subject || null,
    preparedQuote,
    preparedMeta,
    artifacts: {
      quoteMarkdown: { encoding: "base64", bytes: encodeBytes(quoteMarkdownBytes), sha256: hash(quoteMarkdownBytes), byteLength: quoteMarkdownBytes.length },
      reportMarkdown: { encoding: "base64", bytes: encodeBytes(reportMarkdownBytes), sha256: hash(reportMarkdownBytes), byteLength: reportMarkdownBytes.length },
      quotePdf: { encoding: "base64", bytes: encodeBytes(quotePdfBytes), sha256: hash(quotePdfBytes), byteLength: quotePdfBytes.length },
    },
  };
}

export function decodeQuoteDeliveryArtifacts(attempt) {
  const artifacts = attempt?.artifacts || {};
  const decode = (key) => {
    const item = artifacts[key];
    if (!item?.bytes) return null;
    const bytes = decodeBytes(item.bytes);
    if (item.byteLength !== bytes.length || item.sha256 !== hash(bytes)) {
      throw new Error(`pending delivery ${key} bytes failed integrity validation`);
    }
    return bytes;
  };
  return {
    quoteMarkdown: decode("quoteMarkdown")?.toString("utf8") || "",
    reportMarkdown: decode("reportMarkdown")?.toString("utf8") || "",
    quotePdf: decode("quotePdf") || Buffer.alloc(0),
  };
}

export async function persistPendingQuoteDelivery(jobDir, attempt, { inExistingGeneration = false } = {}) {
  const persist = async (stagedDir) => {
    assertWritableJobDir(stagedDir);
    const path = join(stagedDir, QUOTE_DELIVERY_OUTBOX_FILE);
    const existing = await readJson(path);
    if (existing && !["completed", "failed"].includes(existing.status)) return existing;
    await writeFile(path, JSON.stringify(attempt, null, 2));
    return attempt;
  };
  return inExistingGeneration ? persist(jobDir) : runAtomicJobGeneration(jobDir, persist);
}

export async function updatePendingQuoteDelivery(jobDir, attemptId, patch, {
  inExistingGeneration = false,
  expectedRevision = null,
  expectedStatus = null,
} = {}) {
  const update = async (stagedDir) => {
    assertWritableJobDir(stagedDir);
    const path = join(stagedDir, QUOTE_DELIVERY_OUTBOX_FILE);
    const current = await readJson(path);
    if (!current || current.attemptId !== attemptId) return current;
    if (expectedRevision != null && Number(current.revision || 0) !== Number(expectedRevision)) return current;
    if (expectedStatus && current.status !== expectedStatus) return current;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    next.revision = Number(current.revision || 0) + 1;
    await writeFile(path, JSON.stringify(next, null, 2));
    return next;
  };
  return inExistingGeneration ? update(jobDir) : runAtomicJobGeneration(jobDir, update);
}

/**
 * Claim a pending attempt with a durable compare-and-swap revision.
 *
 * With durable storage (#139) the claim must be stored in PostgreSQL before
 * Gmail is called: otherwise a restart could rebuild the attempt as "pending"
 * and the next send would email the customer twice (Gmail does not dedupe on
 * Message-ID). If it cannot be stored, the claim is undone and the send is
 * refused with a 503. Without durable storage the flush is a no-op.
 */
export async function claimPendingQuoteDelivery(jobDir, options = {}) {
  const claimerId = String(options.claimerId ?? randomUUID());
  let unclaimed = null;
  const result = await claimInGeneration(jobDir, { ...options, claimerId }, (previous) => {
    unclaimed = previous;
  });
  if (!result.claimed) return result;
  try {
    await flushDurableStorage({ reason: `quote delivery ${options.attemptId} claim` });
  } catch (error) {
    await runAtomicJobGeneration(jobDir, async (stagedDir) => {
      const path = join(stagedDir, QUOTE_DELIVERY_OUTBOX_FILE);
      const current = await readJson(path);
      if (current?.attemptId === options.attemptId && current.status === "claimed" && current.claim?.claimerId === claimerId) {
        await writeFile(path, JSON.stringify(unclaimed, null, 2));
      }
    });
    const refused = new Error(`not sent: the send could not be recorded durably first (${error.message}). Nothing was emailed; try again.`);
    refused.statusCode = 503;
    refused.code = "FIELD_STORAGE_UNAVAILABLE";
    refused.cause = error;
    throw refused;
  }
  return result;
}

async function claimInGeneration(jobDir, {
  attemptId,
  expectedRevision = null,
  claimerId,
}, onClaim) {
  return runAtomicJobGeneration(jobDir, async (stagedDir) => {
    const path = join(stagedDir, QUOTE_DELIVERY_OUTBOX_FILE);
    const current = await readJson(path);
    if (!current || current.attemptId !== attemptId) return { claimed: false, attempt: current };
    if (current.status !== "pending") return { claimed: false, attempt: current };
    if (expectedRevision != null && Number(current.revision || 0) !== Number(expectedRevision)) {
      return { claimed: false, attempt: current };
    }
    const attempt = {
      ...current,
      status: "claimed",
      revision: Number(current.revision || 0) + 1,
      claim: {
        claimerId: String(claimerId),
        claimedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    await writeFile(path, JSON.stringify(attempt, null, 2));
    onClaim(current);
    return { claimed: true, attempt };
  });
}
